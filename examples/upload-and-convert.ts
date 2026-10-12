/**
 * Run with Node 24.2+ or Bun: node examples/upload-and-convert.ts input.docx output.md
 * (the image ships it compiled: node examples/upload-and-convert.js ...).
 *
 * Example client for the remote server: uploads a local file, converts it and
 * writes the Markdown to a new file. Two modes:
 * - direct: MCP_TOKEN is the bearer token for MCP_URL;
 * - gateway: LITELLM_API_KEY authenticates to a LiteLLM MCP gateway at
 *   MCP_URL (e.g. .../markdownify/mcp), and MARKDOWNIFY_BASE_URL is the
 *   server's own origin for the binary upload, which bypasses the gateway.
 *   MARKDOWNIFY_AGENT_TOKEN optionally forwards a per-agent token as
 *   `x-mcp-<MARKDOWNIFY_SERVER_ALIAS>-authorization` (alias default
 *   "markdownify").
 * CONVERSION_DEADLINE_MS bounds the whole run (default 300000).
 *
 * Safety: plain http is refused except to loopback; the upload URL must be on
 * the expected origin with no credentials, query or fragment; the output file
 * must not exist yet; and raw tool output and server error text are never
 * printed (create_upload returns a scoped credential), only local guidance.
 *
 * Self-contained on purpose: it imports only @modelcontextprotocol/sdk and
 * Node built-ins, never src/, so it runs from a copy outside this repository.
 */
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** Local guidance for one error code, matching error_info in the server's catalogue (src/remote/errors.ts, docs/ERRORS.md). */
type Guidance = { message: string; next_steps: string[] };
/**
 * Condensed guidance for the codes this flow can meet. Server text is never
 * echoed: error_info.code selects an entry here. Call the server's lookup_error
 * tool or read docs/ERRORS.md for the full recovery steps of any code.
 */
const guidance: Record<string, Guidance> = {
  AUTH_REQUIRED: { message: "Authorization required", next_steps: ["Supply this agent's active credential or gateway-issued JWT. Never substitute another agent's identity."] },
  AUTH_SCOPE_REQUIRED: { message: "Scope not granted", next_steps: ["Ask the gateway/operator to grant this tool's scope to your agent."] },
  FILE_TOO_LARGE: { message: "File exceeds upload limit", next_steps: ["Reduce or split the document to fit limit_bytes, or ask the operator to raise MD_MAX_UPLOAD_BYTES."] },
  JOB_LIMIT_EXCEEDED: { message: "Temporary job capacity exhausted", next_steps: ["Wait for retention expiry or delete your own unneeded jobs, then retry; ask the operator if the scope stays full."] },
  STORAGE_LIMIT_EXCEEDED: { message: "Temporary storage capacity exhausted", next_steps: ["Wait for expiry or delete your own unneeded jobs, then retry; ask the operator to adjust the storage budget."] },
  OUTPUT_LIMIT_EXCEEDED: { message: "Converted Markdown exceeds output limit", next_steps: ["Reduce or split the source, or ask the operator to raise MD_MAX_OUTPUT_BYTES."] },
  CONVERSION_TIMEOUT: { message: "Conversion timed out", next_steps: ["Reduce or split the source, or ask the operator to raise MD_CONVERSION_TIMEOUT_MS."] },
  CONVERSION_CANCELLED: { message: "Conversion cancelled", next_steps: ["If conversion is still needed, create a new upload after confirming the service is available."] },
  CONVERSION_INTERRUPTED: { message: "Conversion interrupted by server restart", next_steps: ["After the service recovers, run the upload again with bounded retries."] },
  CONVERSION_FAILED: { message: "Document conversion failed", next_steps: ["Check that the file is valid and supported; do not repeatedly submit the unchanged document."] },
  JOB_NOT_FOUND: { message: "Job not found", next_steps: ["Check your own agent credential; if the job was removed, upload the original file again."] },
  JOB_EXPIRED: { message: "Job expired", next_steps: ["The result is no longer available; upload the original file again if needed."] },
  UPLOAD_SIZE_MISMATCH: { message: "Upload size does not match declared size", next_steps: ["Recheck the file's actual byte count and upload it again."] },
  UPLOAD_INTERRUPTED: { message: "Upload cancelled or timed out", next_steps: ["Run the upload again with bounded retries."] },
  UPLOAD_IN_PROGRESS: { message: "Upload already in progress", next_steps: ["Wait for the existing upload; do not upload concurrently to the same reservation."] },
  UPLOAD_ALREADY_COMPLETED: { message: "Upload already consumed", next_steps: ["Do not upload again; start a new run."] },
  UPLOAD_INCOMPLETE: { message: "File upload is incomplete", next_steps: ["Finish the binary upload before starting the conversion."] },
  MARKDOWN_NOT_READY: { message: "Markdown is not ready", next_steps: ["Poll the job status with backoff and a finite deadline."] },
  INVALID_ARGUMENTS: { message: "Invalid tool arguments", next_steps: ["Check the file name and size and the tool input schema before retrying."] },
  UNSUPPORTED_FORMAT: { message: "Unsupported file format", next_steps: ["Use PDF, DOCX, XLSX, PPTX, TXT, MD, CSV, HTML or JSON."] },
  INVALID_PAGINATION: { message: "Invalid pagination parameters", next_steps: ["Follow the returned next_offset; max_chars must be 1 to 100000."] },
  AUDIT_UNAVAILABLE: { message: "Audit unavailable", next_steps: ["Notify the operator to restore audit storage; retry only after recovery."] },
  SERVICE_UNAVAILABLE: { message: "Service closing", next_steps: ["Wait for service recovery, then retry with bounded backoff."] },
  UNKNOWN_TOOL: { message: "Unknown tool", next_steps: ["Discover available tools with listTools; gateways may prefix names."] },
  REQUEST_REJECTED: { message: "Request rejected", next_steps: ["Check the endpoint, method, host/origin and body size, or ask the operator."] },
  UNKNOWN_ERROR_CODE: { message: "Unknown error code", next_steps: ["Report the sanitized error and job ID to the operator; the lookup_error tool explains known codes."] },
  INTERNAL_ERROR: { message: "Operation failed", next_steps: ["Preserve the job ID and report the error to the operator; avoid blind retries."] },
};

/** A safe one-line description of a failed call, from the local guidance table. */
function failureMessage(payload: any): string {
  // Render only locally known guidance and whitelisted numeric limits. Never
  // echo arbitrary upstream messages, filenames, credentials or raw payloads.
  const rawCode = typeof payload?.error_info?.code === "string" ? payload.error_info.code : "INTERNAL_ERROR";
  const code = Object.hasOwn(guidance, rawCode) ? rawCode : "UNKNOWN_ERROR_CODE";
  const info = guidance[code];
  const limits = ["limit_bytes", "requested_bytes", "reserved_bytes", "limit_jobs", "timeout_ms"]
    .filter(key => Number.isSafeInteger(payload?.error_info?.details?.[key]) && payload.error_info.details[key] >= 0)
    .map(key => `${key}=${payload.error_info.details[key]}`);
  return `${code}: ${info.message}${limits.length ? ` (${limits.join(", ")})` : ""}. ${info.next_steps.join(" ")}`;
}

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("Usage: bun examples/upload-and-convert.ts input.docx output.md");
const endpoint = new URL(process.env.MCP_URL ?? "http://localhost:8000/mcp");
const gatewayKey = process.env.LITELLM_API_KEY;
const token = process.env.MCP_TOKEN;
const agentToken = gatewayKey ? process.env.MARKDOWNIFY_AGENT_TOKEN : token;
if (!gatewayKey && !token) throw new Error("Set MCP_TOKEN for direct access or LITELLM_API_KEY for gateway access");
if (gatewayKey && !process.env.MARKDOWNIFY_BASE_URL) throw new Error("Gateway mode requires MARKDOWNIFY_BASE_URL for the direct binary upload origin");
const uploadOrigin = new URL(process.env.MARKDOWNIFY_BASE_URL ?? endpoint.origin).origin;
/** Throws unless `url` is https:, or http: to a loopback host. */
function permitLocalHttp(url: URL): void {
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Use HTTPS for remote endpoints");
}
permitLocalHttp(endpoint);
permitLocalHttp(new URL(uploadOrigin));
const timeoutMs = Number(process.env.CONVERSION_DEADLINE_MS ?? 300000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000) throw new Error("Invalid CONVERSION_DEADLINE_MS");
const deadline = Date.now() + timeoutMs;
/** Milliseconds left before the overall deadline; throws once it has passed. */
const remaining = () => {
  const ms = deadline - Date.now();
  if (ms <= 0) throw new Error("Conversion deadline exceeded; the server job will expire automatically");
  return ms;
};
const alias = process.env.MARKDOWNIFY_SERVER_ALIAS ?? "markdownify";
if (!/^[A-Za-z0-9_-]{1,64}$/.test(alias)) throw new Error("Invalid MARKDOWNIFY_SERVER_ALIAS");
const headers: Record<string, string> = gatewayKey ? { "x-litellm-api-key": `Bearer ${gatewayKey}`, ...(agentToken ? { [`x-mcp-${alias}-authorization`]: `Bearer ${agentToken}` } : {}) } : { Authorization: `Bearer ${agentToken}` };
const client = new Client({ name: "markdownify-upload-example", version: "0.1.0" });
const transport = new StreamableHTTPClientTransport(endpoint, { requestInit: { headers } });
let destination: Awaited<ReturnType<typeof open>> | undefined;
let completed = false;
try {
  const info = await stat(input);
  if (!info.isFile() || !info.size) throw new Error("Input must be a nonempty local file");
  // Reserve output first so an existing file is never overwritten.
  destination = await open(output, "wx", 0o600);
  await client.connect(transport, { timeout: Math.min(30000, remaining()) });
  const listed = await client.listTools({}, { timeout: Math.min(30000, remaining()) });
  const names = new Map<string, string>();
  for (const name of ["create_upload", "start_conversion", "get_conversion_status", "get_markdown"]) {
    const matches = listed.tools.filter(tool => tool.name === name || tool.name.endsWith(`-${name}`));
    if (matches.length !== 1) throw new Error(`Expected one ${name} tool; use LiteLLM's /markdownify/mcp endpoint to avoid ambiguity`);
    names.set(name, matches[0].name);
  }
  async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = await client.callTool({ name: names.get(name)!, arguments: args }, undefined, { timeout: Math.min(30000, remaining()) });
    // Do not log raw tool output: create_upload contains a scoped credential.
    const text = (result.content as Array<{ type: string; text?: string }>).filter(c => c.type === "text").map(c => c.text ?? "").join("");
    if (result.isError) { let payload; try { payload = JSON.parse(text); } catch {} throw new Error(`${name}: ${failureMessage(payload)}`); }
    return JSON.parse(text) as T;
  }
  const upload = await call<{ upload_id: string; upload_url: string; required_headers: Record<string, string> }>("create_upload", { filename: path.basename(input), size_bytes: info.size });
  const uploadUrl = new URL(upload.upload_url);
  if (uploadUrl.origin !== uploadOrigin || uploadUrl.username || uploadUrl.password || uploadUrl.search || uploadUrl.hash || !uploadUrl.pathname.startsWith("/uploads/")) throw new Error("Unexpected upload endpoint");
  const bytes = createReadStream(input);
  const uploadAuthorization = upload.required_headers.Authorization ?? (agentToken ? `Bearer ${agentToken}` : undefined);
  if (!uploadAuthorization) throw new Error("Server did not issue a scoped upload credential; legacy mode requires MARKDOWNIFY_AGENT_TOKEN");
  try {
    const response = await fetch(uploadUrl, {
      method: "PUT", headers: { ...upload.required_headers, Authorization: uploadAuthorization, "Content-Length": String(info.size) },
      body: bytes as unknown as BodyInit, duplex: "half", redirect: "error", signal: AbortSignal.timeout(remaining()),
    } as RequestInit & { duplex: "half" });
    if (!response.ok) { const payload = await response.json().catch(() => undefined); throw new Error(`Upload failed (${response.status}): ${failureMessage(payload)}`); }
    await response.arrayBuffer();
  } finally { bytes.destroy(); }
  const { job_id } = await call<{ job_id: string }>("start_conversion", { upload_id: upload.upload_id });
  console.log(`Conversion queued: ${job_id}`);
  // Poll with backoff: 500 ms, growing 1.5x per round up to 5 s.
  let delay = 500;
  for (;;) {
    const status = await call<{ status: string; error_info?: unknown }>("get_conversion_status", { job_id });
    if (status.status === "completed") break;
    if (["failed", "expired"].includes(status.status)) throw new Error(`Conversion ${status.status}: ${failureMessage(status)}`);
    await new Promise(resolve => setTimeout(resolve, Math.min(delay, remaining())));
    delay = Math.min(delay * 1.5, 5000);
  }
  let offset = 0;
  for (;;) {
    const page = await call<{ markdown: string; next_offset: number | null }>("get_markdown", { job_id, offset, max_chars: 50000 });
    await destination.writeFile(page.markdown, "utf8");
    if (page.next_offset === null) break;
    if (page.next_offset <= offset) throw new Error("Invalid Markdown pagination");
    offset = page.next_offset;
  }
  completed = true;
  console.log(`Markdown saved to ${output}; remote job expires under the configured retention policy.`);
} finally {
  await destination?.close();
  await client.close();
  if (destination && !completed) console.error(`Incomplete output at ${output}; remove it before retrying.`);
}
