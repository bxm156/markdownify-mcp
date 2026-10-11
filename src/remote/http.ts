/**
 * HTTP front end of the remote server: health probes, the binary upload endpoint and the stateless MCP endpoint.
 *
 * Every response carries `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`, and every failure body is an
 * errorResponse with a catalog code (errors.ts); anything that is not a ServiceError is answered as INTERNAL_ERROR.
 *
 * Request checks, in order; the first failure answers:
 *  1. The target is origin-form ("/path") or "*" and resolves to the public origin (400).
 *  2. Except on the probes (/livez, /healthz, /readyz): Host is in the allowlist (403), and an Origin header, when
 *     present, equals the public origin (403).
 *  3. No query string, on every route (400).
 *  4. Probes: GET or HEAD only (405), then answer. They never authenticate; only /readyz consults readiness (503 when
 *     not ready).
 *  5. Only /mcp and /uploads/<uuid> exist (404).
 *  6. Authentication (401 with `WWW-Authenticate: Bearer`): an upload in JWT mode presents the scoped upload credential
 *     from create_upload, everything else the configured authenticator's token. Only a JWT-mode /mcp request without
 *     an Authorization header may continue unauthenticated.
 *  7. Uploads: PUT only (405), `Content-Type: application/octet-stream` (415); JobService.upload then checks the
 *     X-Upload-Token, the job state and the declared size.
 *  8. MCP: POST only (405), `application/json` (415), a body of at most MAX_JSON_BYTES by Content-Length and while
 *     reading (413), valid JSON (400). An unauthenticated request may only be initialize, notifications/initialized or
 *     ping (401), and only while the service is ready (503).
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { JobService, ServiceError } from "./jobs.js";
import { createRemoteServer, SERVER_INFO } from "./mcp.js";
import type { Authenticator } from "./auth.js";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { errorResponse } from "./errors.js";
import { publicHostForms } from "./config.js";

/**
 * createHttpServer options. publicBaseUrl must be a bare origin: the only accepted Origin and the base of upload URLs.
 * allowedHosts defaults to the public host, bare and with its default port (publicHostForms, as in loadConfig), and is
 * compared case-insensitively.
 */
export interface HttpOptions { authenticator: Authenticator; publicBaseUrl: string; allowedHosts?: string[] }
/** Largest accepted MCP request body (1 MiB). Tool arguments are small: files never pass through MCP. */
const MAX_JSON_BYTES = 1024 * 1024;
/**
 * Deadline for a client to send a whole request, headers and body (5 min). It must cover the slowest accepted upload PUT
 * (MD_MAX_UPLOAD_BYTES at the client's bandwidth); a request past it is answered 408 and its socket closed.
 */
export const REQUEST_TIMEOUT_MS = 300_000;
/** Deadline for a client to send the complete request headers (30 s), which bounds slow-header connections. */
export const HEADERS_TIMEOUT_MS = 30_000;

/**
 * Sends a JSON error body. Without `error`, 401 maps to AUTH_REQUIRED, 503 (an anonymous probe while not ready) to the
 * retryable SERVICE_UNAVAILABLE, and every other status to REQUEST_REJECTED.
 * Once headers have been sent the response can no longer carry an error, so the socket is destroyed instead.
 */
function reply(response: ServerResponse, status: number, message: string, error?: unknown): void {
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(errorResponse(error ?? new ServiceError(status, message, status === 401 ? "AUTH_REQUIRED" : status === 503 ? "SERVICE_UNAVAILABLE" : "REQUEST_REJECTED"))));
}
/** The Bearer credential, or undefined when the header is absent or uses another scheme. The scheme is case-insensitive (RFC 7235 section 2.1). */
function token(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization;
  return value && /^bearer /i.test(value) ? value.slice(7) : undefined;
}

/**
 * Builds the HTTP server without listening; the checks it applies are listed in the module comment. Throws when the
 * authenticator is missing or publicBaseUrl is not a bare HTTP(S) origin.
 */
export function createHttpServer(service: JobService, options: HttpOptions): Server {
  const publicUrl = new URL(options.publicBaseUrl);
  if (!options.authenticator || !["http:", "https:"].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || publicUrl.pathname !== "/") throw new Error("Invalid HTTP server configuration");
  const hosts = new Set((options.allowedHosts ?? publicHostForms(publicUrl)).map(host => host.toLowerCase()));
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    try {
      // Route only origin-form targets ("/path", or "*"). "//host/x", "/\host/x" and absolute-form "http://host/x" would let
      // new URL() swap in a foreign authority and serve the path (and the probe Host exemption) as if it were local.
      const target = request.url ?? "";
      if (target !== "*" && !/^\/(?![/\\])/.test(target)) { reply(response, 400, "Invalid request target"); return; }
      let url: URL;
      try { url = new URL(target, publicUrl); } catch { reply(response, 400, "Invalid request target"); return; }
      if (url.origin !== publicUrl.origin) { reply(response, 400, "Invalid request target"); return; }
      // Probes skip Host/Origin checks: orchestrators send Host: <podIP>:port and bodies hold only public booleans.
      const probe = ["/livez", "/healthz", "/readyz"].includes(url.pathname);
      if (!probe && (!request.headers.host || !hosts.has(request.headers.host.toLowerCase()))) { reply(response, 403, "Host not allowed"); return; }
      if (!probe && request.headers.origin && request.headers.origin !== publicUrl.origin) { reply(response, 403, "Origin not allowed"); return; }
      if (url.search) { reply(response, 400, "Query parameters are not supported"); return; }
      // /livez (and legacy /healthz) is liveness only; /readyz gates traffic on storage/converter/audit/lifecycle.
      if (probe) {
        if (request.method !== "GET" && request.method !== "HEAD") { response.setHeader("Allow", "GET, HEAD"); reply(response, 405, "Method not allowed"); return; }
        const health = url.pathname === "/readyz" ? await service.publicHealth() : undefined;
        const body = JSON.stringify(health ?? { status: "ok" });
        response.writeHead(health?.ready === false ? 503 : 200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
        response.end(request.method === "HEAD" ? undefined : body); return;
      }
      const upload = /^\/uploads\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(url.pathname);
      if (!upload && url.pathname !== "/mcp") { reply(response, 404, "Not found"); return; }
      const principal = upload && options.authenticator.mode === "jwt"
        ? await service.authenticateUpload(upload[1], token(request))
        : await options.authenticator.authenticate(token(request));
      // Only header-less requests may take the JWT anonymous probe path; any presented credential must verify.
      if (!principal && (upload || options.authenticator.mode !== "jwt" || request.headers.authorization !== undefined)) { response.setHeader("WWW-Authenticate", "Bearer"); reply(response, 401, "Authorization required"); return; }
      if (upload) {
        if (request.method !== "PUT") { response.setHeader("Allow", "PUT"); reply(response, 405, "Method not allowed"); return; }
        const header = request.headers["x-upload-token"];
        const uploadToken = typeof header === "string" ? header : "";
        if (request.headers["content-type"] !== "application/octet-stream") { reply(response, 415, "Use application/octet-stream"); return; }
        // Decouple the worker pipeline from the socket so size-limit failures can
        // return a useful HTTP response before closing the rejected connection.
        const source = new PassThrough();
        const aborted = () => source.destroy(new Error("Upload disconnected"));
        const failed = (error: Error) => source.destroy(error);
        request.once("aborted", aborted); request.once("error", failed);
        request.pipe(source);
        try { await service.upload(principal!, upload[1], uploadToken, source); }
        catch (error) {
          request.pause();
          response.setHeader("Connection", "close");
          response.once("finish", () => request.destroy());
          throw error;
        } finally {
          request.unpipe(source); source.destroy();
          request.removeListener("aborted", aborted); request.removeListener("error", failed);
        }
        response.writeHead(204); response.end(); return;
      }
      if (request.method !== "POST") { response.setHeader("Allow", "POST"); reply(response, 405, "Method not allowed"); return; }
      // The media type must be exactly lowercase: the SDK transport re-reads the raw header and matches it case-sensitively.
      if (request.headers["content-type"]?.split(";", 1)[0].trim() !== "application/json") { reply(response, 415, "Use application/json"); return; }
      const length = Number(request.headers["content-length"] ?? 0);
      if (length > MAX_JSON_BYTES) { reply(response, 413, "Request body too large"); return; }
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk); size += buffer.length;
        if (size > MAX_JSON_BYTES) { reply(response, 413, "Request body too large"); return; }
        chunks.push(buffer);
      }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { reply(response, 400, "Invalid JSON"); return; }
      if (!principal) {
        const method = body && typeof body === "object" && !Array.isArray(body) ? (body as { method?: unknown }).method : undefined;
        if (!["initialize", "notifications/initialized", "ping"].includes(method as string)) {
          response.setHeader("WWW-Authenticate", "Bearer"); reply(response, 401, "Authorization required"); return;
        }
        const health = await service.health();
        if (!health.ready) { reply(response, 503, "Service unavailable"); return; }
      }
      // Stateless: no MCP session IDs and plain JSON responses (no SSE), with a fresh server and transport per request. An
      // anonymous request gets a server without tools, so it can only initialize and ping.
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const mcp = principal ? createRemoteServer(service, options.publicBaseUrl, principal) : new McpServer(SERVER_INFO, { capabilities: {} });
      response.on("close", () => { void transport.close(); void mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch (error) {
      reply(response, error instanceof ServiceError ? error.statusCode : 500, "Operation failed", error);
    }
  });
  // The only place these are set: startRemoteServer and direct callers (tests) get the same deadlines.
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  return server;
}
