import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { JobService, ServiceError } from "./jobs.js";
import { createRemoteServer } from "./mcp.js";
import type { Authenticator } from "./auth.js";
import { errorResponse } from "./errors.js";

export interface HttpOptions { authenticator: Authenticator; publicBaseUrl: string; allowedHosts?: string[] }
const MAX_JSON_BYTES = 1024 * 1024;

function reply(response: ServerResponse, status: number, message: string, error?: unknown): void {
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(errorResponse(error ?? new ServiceError(status, message, status === 401 ? "AUTH_REQUIRED" : "REQUEST_REJECTED"))));
}
function token(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice(7) : undefined;
}

export function createHttpServer(service: JobService, options: HttpOptions): Server {
  const publicUrl = new URL(options.publicBaseUrl);
  if (!options.authenticator || !["http:", "https:"].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || publicUrl.pathname !== "/") throw new Error("Invalid HTTP server configuration");
  const hosts = new Set((options.allowedHosts ?? [publicUrl.host]).map(host => host.toLowerCase()));
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    try {
      if (!request.headers.host || !hosts.has(request.headers.host.toLowerCase())) { reply(response, 403, "Host not allowed"); return; }
      if (request.headers.origin && request.headers.origin !== publicUrl.origin) { reply(response, 403, "Origin not allowed"); return; }
      const url = new URL(request.url ?? "/", publicUrl);
      if (url.search) { reply(response, 400, "Query parameters are not supported"); return; }
      if (url.pathname === "/healthz") {
        if (request.method !== "GET") { response.setHeader("Allow", "GET"); reply(response, 405, "Method not allowed"); return; }
        response.writeHead(200, { "Content-Type": "application/json" }); response.end('{"status":"ok"}'); return;
      }
      const upload = /^\/uploads\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(url.pathname);
      if (!upload && url.pathname !== "/mcp") { reply(response, 404, "Not found"); return; }
      const principal = options.authenticator.authenticate(token(request));
      if (!principal) { response.setHeader("WWW-Authenticate", "Bearer"); reply(response, 401, "Authorization required"); return; }
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
        try { await service.upload(principal, upload[1], uploadToken, source); }
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
      if (request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") { reply(response, 415, "Use application/json"); return; }
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
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const mcp = createRemoteServer(service, options.publicBaseUrl, principal);
      response.on("close", () => { void transport.close(); void mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch (error) {
      reply(response, error instanceof ServiceError ? error.statusCode : 500, "Operation failed", error);
    }
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  return server;
}
