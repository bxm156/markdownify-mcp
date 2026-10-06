import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = new URL(process.env.MCP_URL ?? "http://localhost:8000/mcp");
const key = process.env.MCP_TOKEN ?? process.env.MD_API_KEY;
if (!key) throw new Error("Set MCP_TOKEN or MD_API_KEY before running the HTTP smoke test");
const temporary = await mkdtemp(path.join(os.tmpdir(), "markdownify-http-smoke-"));
const client = new Client({ name: "markdownify-http-smoke", version: "0.1.0" });
const transport = new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${key}` } } });
let jobId: string | undefined;
async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 30000 });
  if (result.isError) throw new Error(`${name} failed`);
  const text = (result.content as Array<{ type: string; text?: string }>).filter(item => item.type === "text").map(item => item.text ?? "").join("");
  return JSON.parse(text) as T;
}
try {
  await client.connect(transport, { timeout: 30000 });
  const listed = await client.listTools();
  for (const name of ["create_upload", "start_conversion", "get_conversion_status", "get_markdown", "delete_job"]) assert(listed.tools.some(tool => tool.name === name), `Missing ${name}`);
  const fixture = path.resolve("src/sample-data/test.pdf");
  const upload = await call<{ upload_id: string; upload_url: string; required_headers: Record<string, string> }>("create_upload", { filename: "test.pdf", size_bytes: (await stat(fixture)).size });
  jobId = upload.upload_id;
  const uploadUrl = new URL(upload.upload_url);
  assert.equal(uploadUrl.origin, endpoint.origin, "Unexpected upload origin");
  assert.equal(uploadUrl.search, "", "Upload URL must not carry credentials in query parameters");
  const input = createReadStream(fixture);
  try {
    const response = await fetch(uploadUrl, { method: "PUT", body: input as unknown as BodyInit, duplex: "half", headers: { ...upload.required_headers, Authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(30000) } as RequestInit & { duplex: "half" });
    assert.equal(response.status, 204, "Binary upload failed");
  } finally { input.destroy(); }
  const queued = await call<{ job_id: string }>("start_conversion", { upload_id: jobId });
  assert.equal(queued.job_id, jobId);
  const deadline = Date.now() + 130000;
  let completed = false;
  while (Date.now() < deadline) {
    const status = await call<{ status: string }>("get_conversion_status", { job_id: jobId });
    if (status.status === "completed") { completed = true; break; }
    assert(!["failed", "expired"].includes(status.status), `Conversion ${status.status}`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert(completed, "Conversion deadline exceeded");
  let offset = 0, markdown = "";
  for (;;) {
    const page = await call<{ markdown: string; next_offset: number | null }>("get_markdown", { job_id: jobId, offset, max_chars: 7 });
    markdown += page.markdown;
    if (page.next_offset === null) break;
    assert(page.next_offset > offset, "Pagination did not advance");
    offset = page.next_offset;
  }
  assert(markdown.includes("Test PDF content"), "Real PDF fixture content missing");
  const output = path.join(temporary, "result.md");
  await writeFile(output, markdown, { mode: 0o600 });
  assert.equal(await readFile(output, "utf8"), markdown);
  const deleted = await call<{ deleted: boolean }>("delete_job", { job_id: jobId });
  assert.equal(deleted.deleted, true);
  const missing = await client.callTool({ name: "get_conversion_status", arguments: { job_id: jobId } });
  assert.equal(missing.isError, true, "Deleted job still accessible");
  jobId = undefined;
  console.log("HTTP MCP smoke passed: initialize/list, binary PDF upload, conversion, paginated retrieval, and deletion.");
} finally {
  if (jobId) await call("delete_job", { job_id: jobId }).catch(() => undefined);
  await client.close();
  await rm(temporary, { recursive: true, force: true });
}
