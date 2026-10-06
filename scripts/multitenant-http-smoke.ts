import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = new URL(process.env.MCP_URL ?? "http://localhost:8000/mcp");
const keys: Record<string, string> = JSON.parse(process.env.MD_TEST_AGENT_KEYS ?? "{}");
for (const name of ["a", "b", "c"]) assert(typeof keys[name] === "string" && keys[name].length >= 32, "MD_TEST_AGENT_KEYS requires a, b and c credentials");
const fixture = await readFile("src/sample-data/test.pdf");
type Upload = { upload_id: string; upload_url: string; required_headers: Record<string, string> };
type Agent = { name: string; key: string; client: Client; jobs: Set<string> };
const agents: Agent[] = [];
async function connect(agent: Agent) {
  agent.client = new Client({ name: `markdownify-isolation-${agent.name}`, version: "0.1.0" });
  await agent.client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${agent.key}` } } }), { timeout: 30000 });
}
async function call<T>(agent: Agent, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await agent.client.callTool({ name, arguments: args }, undefined, { timeout: 30000 });
  assert(!result.isError, `${agent.name}: ${name} failed`);
  const text = (result.content as Array<{ type: string; text?: string }>).filter(item => item.type === "text").map(item => item.text ?? "").join("");
  return JSON.parse(text) as T;
}
async function denied(agent: Agent, name: string, args: Record<string, unknown>) {
  const result = await agent.client.callTool({ name, arguments: args }, undefined, { timeout: 30000 });
  assert.equal(result.isError, true, `${agent.name}: foreign ${name} succeeded`);
  assert.deepEqual(result.content, [{ type: "text", text: "Job not found" }], "Foreign access must not disclose state");
}
try {
  for (const name of ["a", "b", "c"]) {
    const agent: Agent = { name, key: keys[name], client: undefined as unknown as Client, jobs: new Set() };
    agents.push(agent); await connect(agent);
  }
  const uploads: Upload[] = [];
  for (const agent of agents) {
    const upload = await call<Upload>(agent, "create_upload", { filename: "isolation.pdf", size_bytes: fixture.length });
    agent.jobs.add(upload.upload_id); uploads.push(upload);
    assert.equal(new URL(upload.upload_url).origin, endpoint.origin, "Unexpected upload origin");
    assert.equal(new URL(upload.upload_url).search, "", "Upload URL must not contain credentials");
  }
  for (let owner = 0; owner < agents.length; owner++) {
    for (let foreign = 0; foreign < agents.length; foreign++) {
      if (foreign === owner) continue;
      const upload = uploads[owner], agent = agents[foreign];
      const response = await fetch(upload.upload_url, { method: "PUT", body: fixture, headers: { ...upload.required_headers, Authorization: `Bearer ${agent.key}` }, redirect: "error", signal: AbortSignal.timeout(30000) });
      assert.equal(response.status, 404, "Foreign credential with correct upload token must be denied");
      for (const name of ["start_conversion", "get_conversion_status", "get_markdown", "delete_job"]) await denied(agent, name, name === "start_conversion" ? { upload_id: upload.upload_id } : { job_id: upload.upload_id });
    }
    assert.equal((await call<{ status: string }>(agents[owner], "get_conversion_status", { job_id: uploads[owner].upload_id })).status, "awaiting_upload", "Foreign operations changed owner job");
  }
  await Promise.all(agents.map(async (agent, i) => {
    const upload = uploads[i];
    const response = await fetch(upload.upload_url, { method: "PUT", body: fixture, headers: { ...upload.required_headers, Authorization: `Bearer ${agent.key}` }, redirect: "error", signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 204, "Owner upload failed");
    await call(agent, "start_conversion", { upload_id: upload.upload_id });
    await agent.client.close(); await connect(agent);
  }));
  const deadline = Date.now() + 180000;
  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i], id = uploads[i].upload_id;
    let completed = false;
    while (Date.now() < deadline) {
      const status = await call<{ status: string }>(agent, "get_conversion_status", { job_id: id });
      if (status.status === "completed") { completed = true; break; }
      assert(!["failed", "expired"].includes(status.status), `Owner conversion ${status.status}`);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert(completed, "Conversion deadline exceeded");
    let offset = 0, markdown = "";
    for (let pageCount = 0; ; pageCount++) {
      assert(pageCount < 10000, "Pagination limit exceeded");
      const page = await call<{ markdown: string; next_offset: number | null }>(agent, "get_markdown", { job_id: id, offset, max_chars: 7 });
      markdown += page.markdown;
      if (page.next_offset === null) break;
      assert(page.next_offset > offset, "Pagination did not advance"); offset = page.next_offset;
    }
    assert(markdown.includes("Test PDF content"), "Real PDF conversion content missing");
    for (const foreign of agents.filter(value => value !== agent)) {
      await denied(foreign, "get_markdown", { job_id: id });
      await denied(foreign, "delete_job", { job_id: id });
    }
    assert.equal((await call<{ status: string }>(agent, "get_conversion_status", { job_id: id })).status, "completed");
  }
  console.log("Multi-agent MCP smoke passed: three credentials, same/cross-tenant isolation, scoped uploads, real PDF conversion, reconnect and private retrieval.");
} finally {
  for (const agent of agents) {
    if (!agent.client) continue;
    for (const job_id of agent.jobs) await call(agent, "delete_job", { job_id }).catch(() => undefined);
    await agent.client.close().catch(() => undefined);
  }
}
