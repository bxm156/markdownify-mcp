/** Real compiled Node service + PDF converter; optional actual LiteLLM signer fixture. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const issuer = "https://litellm-smoke.test", audience = "markdownify";
const upstream = process.env.MD_TEST_LITELLM_SIGNER_FIXTURE ? JSON.parse(await fs.readFile(process.env.MD_TEST_LITELLM_SIGNER_FIXTURE, "utf8")) : undefined;
const signingKey = await generateKeyPair("RS256", { extractable: true });
const jwks = upstream?.jwks ?? { keys: [{ ...await exportJWK(signingKey.publicKey), kid: "smoke", alg: "RS256", use: "sig" }] };
if (upstream) { assert.equal(upstream.issuer, issuer); assert.equal(upstream.audience, audience); }
async function bearer(subject: string, body: any) {
  const tool = body?.method === "tools/call" ? body.params.name : "list";
  if (upstream) return upstream.tokens[subject][tool];
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: issuer, aud: audience, sub: subject, iat: now, exp: now + 300, scope: tool === "list" ? "mcp:tools/list" : `mcp:tools/call mcp:tools/${tool}:call` }).setProtectedHeader({ alg: "RS256", kid: "smoke" }).sign(signingKey.privateKey);
}
async function listen(server: ReturnType<typeof createServer>) { await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); return (server.address() as { port: number }).port; }
async function stop(server: ReturnType<typeof createServer>) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "markdownify-jwt-http-"));
const provider = createServer((_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(jwks)); });
const jwksPort = await listen(provider);
const probe = createServer(); const port = await listen(probe); await stop(probe); const base = `http://127.0.0.1:${port}`;
const env = { ...process.env }; for (const name of Object.keys(env)) if (name.startsWith("MD_JWT_") || ["MD_API_KEY", "MD_AUTH_FILE"].includes(name)) delete env[name];
Object.assign(env, { MD_JWT_ISSUER: issuer, MD_JWT_AUDIENCE: audience, MD_JWT_JWKS_URL: `http://127.0.0.1:${jwksPort}/jwks`, MD_JWT_ALLOW_HTTP_LOCALHOST: "1", MD_PUBLIC_BASE_URL: base, MD_HOST: "127.0.0.1", MD_PORT: String(port), MD_DATA_DIR: path.join(directory, "data") });
const child = spawn(process.env.MD_TEST_NODE ?? "node", ["dist/remote/index.js"], { env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
let startupFailure = false; child.on("error", () => { startupFailure = true; }); child.stderr!.resume();
const clients: Client[] = []; let gateway: ReturnType<typeof createServer> | undefined;
try {
  let ready = false; for (let i = 0; i < 100; i++) { if (startupFailure || child.exitCode !== null) throw new Error("Compiled JWT service failed to start"); try { if ((await fetch(`${base}/healthz`)).ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 100)); } assert(ready, "JWT service readiness timeout");
  async function client(subject: string) {
    const c = new Client({ name: "jwt-smoke", version: "1" }); clients.push(c);
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { fetch: async (input, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      const headers = new Headers(init?.headers); headers.set("Authorization", `Bearer ${await bearer(subject, body)}`); return fetch(input, { ...init, headers });
    } })); return c;
  }
  async function call(c: Client, name: string, args: Record<string, unknown>) { const result = await c.callTool({ name, arguments: args }); assert(!result.isError, `${name} failed`); return JSON.parse((result.content as Array<{ text: string }>)[0].text); }
  const agents = await Promise.all(["machine-a", "machine-b", "machine-c"].map(client));
  const pdf = await fs.readFile("src/sample-data/test.pdf");
  const uploads: Array<{ upload_id: string; upload_url: string; required_headers: Record<string, string> }> = [];
  for (const c of agents) { const u = await call(c, "create_upload", { filename: "test.pdf", size_bytes: pdf.length }); uploads.push(u); }
  assert.equal((await fetch(uploads[0].upload_url, { method: "PUT", headers: { ...uploads[0].required_headers, Authorization: uploads[1].required_headers.Authorization }, body: pdf })).status, 401);
  assert.equal((await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: uploads[0].required_headers.Authorization }, body: '{}' })).status, 401);
  for (let i = 0; i < agents.length; i++) {
    const u = uploads[i]; assert(u.required_headers.Authorization);
    assert.equal((await fetch(u.upload_url, { method: "PUT", headers: u.required_headers, body: pdf })).status, 204);
    assert.equal((await fetch(u.upload_url, { method: "PUT", headers: u.required_headers, body: pdf })).status, 401);
    await call(agents[i], "start_conversion", { upload_id: u.upload_id });
    let done = false; for (let n = 0; n < 100; n++) { const state = await call(agents[i], "get_conversion_status", { job_id: u.upload_id }); assert.notEqual(state.status, "failed"); if (state.status === "completed") { done = true; break; } await new Promise(r => setTimeout(r, 100)); } assert(done);
    assert.match((await call(agents[i], "get_markdown", { job_id: u.upload_id })).markdown, /Test PDF content/);
    for (const peer of agents.filter(c => c !== agents[i])) { const result = await peer.callTool({ name: "get_markdown", arguments: { job_id: u.upload_id } }); assert(result.isError); assert.equal(JSON.parse((result.content as Array<{ text: string }>)[0].text).error_info.code, "JOB_NOT_FOUND"); }
  }
  // Local bridge exercises the helper with only a gateway key, signing each RPC
  // like LiteLLM. It is a test harness, not a production authentication proxy.
  const gatewayKey = randomBytes(32).toString("hex");
  gateway = createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }); res.end(); return; }
    if (req.headers["x-litellm-api-key"] !== `Bearer ${gatewayKey}`) { res.writeHead(401); res.end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const body = Buffer.concat(chunks).toString();
    const response = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${await bearer("machine-a", JSON.parse(body))}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body });
    res.writeHead(response.status, { "Content-Type": response.headers.get("content-type") ?? "application/json" }); res.end(Buffer.from(await response.arrayBuffer()));
  });
  const gatewayPort = await listen(gateway);
  const output = path.join(directory, "helper.md");
  await promisify(execFile)(process.execPath, ["examples/upload-and-convert.ts", "src/sample-data/test.pdf", output], { env: { ...process.env, MCP_URL: `http://127.0.0.1:${gatewayPort}/markdownify/mcp`, LITELLM_API_KEY: gatewayKey, MARKDOWNIFY_AGENT_TOKEN: "", MARKDOWNIFY_BASE_URL: base }, timeout: 30000, windowsHide: true, maxBuffer: 10000 });
  assert.match(await fs.readFile(output, "utf8"), /Test PDF content/);
  for (let i = 0; i < agents.length; i++) await call(agents[i], "delete_job", { job_id: uploads[i].upload_id });
  console.log(`Compiled Node JWT smoke passed: ${upstream ? "actual LiteLLM signer" : "RS256 fixture"}, real three-agent PDF isolation, scoped upload grants and gateway-only helper.`);
} finally {
  await Promise.allSettled(clients.map(c => c.close())); if (gateway) await stop(gateway); await stop(provider);
  if (child.exitCode === null && !startupFailure) { const exited = new Promise<void>(r => child.once("exit", () => r())); child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 5000); await exited; clearTimeout(timer); }
  await fs.rm(directory, { recursive: true, force: true });
}
