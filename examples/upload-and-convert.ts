/** Run with Bun: bun examples/upload-and-convert.ts input.docx output.md */
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("Usage: bun examples/upload-and-convert.ts input.docx output.md");
const endpoint = new URL(process.env.MCP_URL ?? "http://localhost:8000/mcp");
const gatewayKey = process.env.LITELLM_API_KEY;
const token = process.env.MCP_TOKEN;
if (!gatewayKey && !token) throw new Error("Set MCP_TOKEN for direct access or LITELLM_API_KEY for gateway access");
if (gatewayKey && !process.env.MARKDOWNIFY_BASE_URL) throw new Error("Gateway mode requires MARKDOWNIFY_BASE_URL for the direct binary upload origin");
const uploadOrigin = new URL(process.env.MARKDOWNIFY_BASE_URL ?? endpoint.origin).origin;
function permitLocalHttp(url: URL): void {
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Use HTTPS for remote endpoints");
}
permitLocalHttp(endpoint);
permitLocalHttp(new URL(uploadOrigin));
const timeoutMs = Number(process.env.CONVERSION_DEADLINE_MS ?? 300000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000) throw new Error("Invalid CONVERSION_DEADLINE_MS");
const deadline = Date.now() + timeoutMs;
const remaining = () => {
  const ms = deadline - Date.now();
  if (ms <= 0) throw new Error("Conversion deadline exceeded; the server job will expire automatically");
  return ms;
};
const headers: Record<string, string> = gatewayKey ? { "x-litellm-api-key": `Bearer ${gatewayKey}` } : { Authorization: `Bearer ${token}` };
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
    if (result.isError) throw new Error(`${name} failed`);
    const text = (result.content as Array<{ type: string; text?: string }>).filter(c => c.type === "text").map(c => c.text ?? "").join("");
    return JSON.parse(text) as T;
  }
  const upload = await call<{ upload_id: string; upload_url: string; required_headers: Record<string, string> }>("create_upload", { filename: path.basename(input), size_bytes: info.size });
  const uploadUrl = new URL(upload.upload_url);
  if (uploadUrl.origin !== uploadOrigin || uploadUrl.username || uploadUrl.password || uploadUrl.search || uploadUrl.hash || !uploadUrl.pathname.startsWith("/uploads/")) throw new Error("Unexpected upload endpoint");
  const bytes = createReadStream(input);
  try {
    const response = await fetch(uploadUrl, {
      method: "PUT", headers: { ...upload.required_headers, "Content-Length": String(info.size) },
      body: bytes as unknown as BodyInit, duplex: "half", redirect: "error", signal: AbortSignal.timeout(remaining()),
    } as RequestInit & { duplex: "half" });
    if (!response.ok) throw new Error(`Upload failed (${response.status})`);
    await response.arrayBuffer();
  } finally { bytes.destroy(); }
  const { job_id } = await call<{ job_id: string }>("start_conversion", { upload_id: upload.upload_id });
  console.log(`Conversion queued: ${job_id}`);
  let delay = 500;
  for (;;) {
    const status = await call<{ status: string }>("get_conversion_status", { job_id });
    if (status.status === "completed") break;
    if (["failed", "expired"].includes(status.status)) throw new Error(`Conversion ${status.status}`);
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
