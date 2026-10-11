import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { closedPort, waitFor } from "./test-helpers.js";

// These tests run the real entry point (src/remote/index.ts) as a child process, so startup failure handling,
// listen-error cleanup and signal-driven shutdown are exercised exactly as an orchestrator would see them.
const entry = path.resolve(import.meta.dir, "index.ts");
const API_KEY = "test-api-key-0123456789-abcdefghijklmnop";
const TEST_TIMEOUT = 25_000;

type Server = { child: ChildProcess; port: number; dataDir: string; output: () => { stdout: string; stderr: string }; exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> };

// Every scenario owns its processes, directories and listeners through a Scope that is disposed in a finally, so no
// scenario can kill or delete another's resources and independent scenarios may run concurrently (test.concurrent).
const reservedPorts = new Set<number>();
/** A closed port no other scenario in this file was handed, so concurrent scenarios cannot race for the same one. */
async function freePort() {
  for (;;) { const port = await closedPort(); if (!reservedPorts.has(port)) { reservedPorts.add(port); return port; } }
}
const until = <T>(predicate: () => T | Promise<T>, label: string) => waitFor(predicate, { timeoutMs: 10_000, intervalMs: 10, label });
class Scope {
  private children: ChildProcess[] = []; private directories: string[] = []; private pidFiles: string[] = []; private listeners: net.Server[] = [];
  async tempDir(prefix: string) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix)); this.directories.push(dir); return dir; }
  /** A converter stub that records its pid, then blocks until it is killed. */
  async hangingConverter(dir: string) {
    const pidFile = path.join(dir, "converter.pid"), script = path.join(dir, "hang-converter.sh");
    await fs.writeFile(script, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 600\n`, { mode: 0o755 });
    this.pidFiles.push(pidFile);
    return { script, pidFile };
  }
  /** A listening socket on an ephemeral port, closed when the scope is disposed. */
  async occupiedPort() {
    const holder = net.createServer();
    this.listeners.push(holder);
    await new Promise<void>((resolve, reject) => { holder.once("error", reject); holder.listen(0, "127.0.0.1", resolve); });
    const port = (holder.address() as net.AddressInfo).port;
    reservedPorts.add(port);
    return port;
  }
  start(options: StartOptions): Server { const server = launch(options); this.children.push(server.child); return server; }
  async dispose() {
    for (const child of this.children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    for (const file of this.pidFiles.splice(0)) {
      // A SIGKILLed server cannot reap its converter, so the orphan is stopped explicitly.
      try { process.kill(Number((await fs.readFile(file, "utf8")).trim()), "SIGKILL"); } catch { /* already gone */ }
    }
    await Promise.all(this.listeners.splice(0).map(listener => new Promise<void>(resolve => listener.close(() => resolve()))));
    await Promise.all(this.directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
  }
}
/** Wraps a scenario so its Scope is always disposed, whether it passes, fails or times out inside the body. */
const withScope = (body: (scope: Scope) => Promise<void>) => async () => { const scope = new Scope(); try { await body(scope); } finally { await scope.dispose(); } };
type StartOptions = { port: number; dataDir: string; env?: Record<string, string | undefined>; converter?: string };
/** Spawns the entry point. Callers own the returned child: scenarios use `scope.start`, which kills it on dispose. */
function launch(options: StartOptions): Server {
  // Inherit only what the runtime needs so ambient MD_* / MARKITDOWN_PATH values can never leak into a test.
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) if (!name.startsWith("MD_") && name !== "MARKITDOWN_PATH") env[name] = value;
  Object.assign(env, { MD_API_KEY: API_KEY, MD_HOST: "127.0.0.1", MD_PORT: String(options.port), MD_PUBLIC_BASE_URL: `http://127.0.0.1:${options.port}`, MD_DATA_DIR: options.dataDir, MARKITDOWN_PATH: options.converter ?? "/bin/true" }, options.env);
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name];
  const child = spawn(process.execPath, [entry], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "", stderr = "";
  child.stdout!.on("data", chunk => { stdout += chunk.toString(); });
  child.stderr!.on("data", chunk => { stderr += chunk.toString(); });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  return { child, port: options.port, dataDir: options.dataDir, output: () => ({ stdout, stderr }), exit };
}
const readyz = (server: Server) => fetch(`http://127.0.0.1:${server.port}/readyz`, { signal: AbortSignal.timeout(2000) });
async function ready(server: Server) {
  const response = await until(async () => { const value = await readyz(server); return value.status === 200 && value; }, "readiness")
    .catch(error => { throw new Error(`${error.message} (stderr: ${server.output().stderr})`); });
  expect(await response.json()).toMatchObject({ ready: true });
}
async function terminated(server: Server, timeoutMs = 8000) {
  return Promise.race([server.exit, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`Process did not exit: ${server.output().stderr}`)), timeoutMs).unref())]);
}
const jobFile = (server: Server, id: string) => path.join(server.dataDir, id, "job.json");
const readJob = async (server: Server, id: string) => JSON.parse(await fs.readFile(jobFile(server, id), "utf8"));

async function connect(server: Server) {
  const client = new Client({ name: "index-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } } }), { timeout: 5000 });
  const call = async <T>(name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 5000 });
    return JSON.parse((result.content as { text: string }[]).map(item => item.text).join("")) as T;
  };
  return { client, call };
}
async function startRunningJob(server: Server, pidFile: string) {
  const { client, call } = await connect(server);
  try {
    const upload = await call<{ upload_id: string; upload_url: string; required_headers: Record<string, string> }>("create_upload", { filename: "note.txt", size_bytes: 5 });
    const put = await fetch(upload.upload_url, { method: "PUT", body: "hello", headers: { ...upload.required_headers, Authorization: `Bearer ${API_KEY}` }, signal: AbortSignal.timeout(5000) });
    expect(put.status).toBe(204);
    await call("start_conversion", { upload_id: upload.upload_id });
    // The converter has been spawned only once the job is running; its pid file proves the stub is really blocking.
    await until(async () => (await readJob(server, upload.upload_id)).status === "running", "job to be running");
    await until(async () => Number(await fs.readFile(pidFile, "utf8")) > 0, "converter process to start");
    return upload.upload_id;
  } finally { await client.close(); }
}

describe("remote entry point", () => {
  test.concurrent("serves /readyz and exits 0 after SIGTERM, releasing the data directory lock", withScope(async scope => {
    const server = scope.start({ port: await freePort(), dataDir: await scope.tempDir("markdownify-index-") });
    await ready(server);
    expect(server.output().stderr).toContain(`listening on 127.0.0.1:${server.port}`);
    expect((await fetch(`http://127.0.0.1:${server.port}/livez`)).status).toBe(200);
    expect(await fs.stat(path.join(server.dataDir, ".lock"))).toBeTruthy();
    server.child.kill("SIGTERM");
    expect(await terminated(server)).toEqual({ code: 0, signal: null });
    await expect(fs.stat(path.join(server.dataDir, ".lock"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(server.output().stderr).not.toContain(API_KEY);
  }), TEST_TIMEOUT);

  test.concurrent.each(["SIGINT", "SIGHUP"] as const)("%s also shuts down gracefully with exit code 0, even if SIGTERM follows", signal => withScope(async scope => {
    const server = scope.start({ port: await freePort(), dataDir: await scope.tempDir("markdownify-index-") });
    await ready(server);
    server.child.kill(signal);
    // A second signal while shutting down is ignored: the exit must stay clean.
    server.child.kill("SIGTERM");
    expect(await terminated(server)).toEqual({ code: 0, signal: null });
    await expect(fs.stat(path.join(server.dataDir, ".lock"))).rejects.toMatchObject({ code: "ENOENT" });
  })(), TEST_TIMEOUT);

  test.concurrent("a busy port fails startup with exit 1 and a one-line message, and releases the data directory lock", withScope(async scope => {
    const port = await scope.occupiedPort();
    const dataDir = await scope.tempDir("markdownify-index-");
    const server = scope.start({ port, dataDir });
    expect((await terminated(server)).code).toBe(1);
    const { stderr, stdout } = server.output();
    expect(stderr).toMatch(/EADDRINUSE|port \d+ in use/);
    expect(stderr.trim().split("\n")).toHaveLength(1);
    expect(stderr).not.toContain(API_KEY);
    expect(stderr + stdout).not.toMatch(/\n\s+at /);
    // jobs.close() on the listen error must have released the volume lock, so a retry on a free port with the same data dir works.
    await expect(fs.stat(path.join(dataDir, ".lock"))).rejects.toMatchObject({ code: "ENOENT" });
    const retry = scope.start({ port: await freePort(), dataDir });
    await ready(retry);
    retry.child.kill("SIGTERM");
    expect((await terminated(retry)).code).toBe(0);
  }), TEST_TIMEOUT);

  // The two scenarios below only read from a running instance, so they share one server spawned for the group and may run concurrently.
  // It is launched outside any per-test Scope (no scenario may kill it) and shut down gracefully in afterAll.
  describe("a second instance next to a running one", () => {
    let first: Server;
    beforeAll(async () => {
      first = launch({ port: await freePort(), dataDir: await fs.mkdtemp(path.join(os.tmpdir(), "markdownify-index-shared-")) });
      await ready(first);
    }, TEST_TIMEOUT);
    afterAll(async () => {
      if (first.child.exitCode === null && first.child.signalCode === null) { first.child.kill("SIGTERM"); await terminated(first).catch(() => first.child.kill("SIGKILL")); }
      await fs.rm(first.dataDir, { recursive: true, force: true });
    });

    test.concurrent("on the same port exits nonzero while the first keeps serving", withScope(async scope => {
      const second = scope.start({ port: first.port, dataDir: await scope.tempDir("markdownify-index-") });
      const { code } = await terminated(second);
      expect(code).toBe(1);
      expect(second.output().stderr).toMatch(/EADDRINUSE|port \d+ in use/);
      expect(second.output().stderr).not.toContain(API_KEY);
      expect((await readyz(first)).status).toBe(200);
      expect(first.child.exitCode).toBeNull();
    }), TEST_TIMEOUT);

    test.concurrent("on the same data directory is refused and leaves the first instance's lock alone", withScope(async scope => {
      const second = scope.start({ port: await freePort(), dataDir: first.dataDir });
      expect((await terminated(second)).code).toBe(1);
      expect(second.output().stderr).toContain("Data directory is in use");
      expect((await readyz(first)).status).toBe(200);
      expect(await fs.stat(path.join(first.dataDir, ".lock"))).toBeTruthy();
      expect(first.child.exitCode).toBeNull();
    }), TEST_TIMEOUT);
  });

  describe("invalid configuration", () => {
    const secret = "short-but-secret-value";
    test.concurrent.each([
      ["MD_API_KEY is missing", { MD_API_KEY: undefined }, "MD_API_KEY"],
      ["MD_API_KEY is too short", { MD_API_KEY: secret }, "MD_API_KEY"],
      ["MD_PORT is not a number", { MD_PORT: "not-a-port" }, "MD_PORT"],
      ["MD_SHUTDOWN_TIMEOUT_MS is not a number", { MD_SHUTDOWN_TIMEOUT_MS: "abc" }, "MD_SHUTDOWN_TIMEOUT_MS"],
    ] as const)("exits 1 naming the variable, without echoing secrets, when %s", (_label, env, variable) => withScope(async scope => {
      const dataDir = await scope.tempDir("markdownify-index-");
      const server = scope.start({ port: await freePort(), dataDir, env });
      expect((await terminated(server)).code).toBe(1);
      const { stderr, stdout } = server.output();
      expect(stderr).toContain(variable);
      expect(stderr.trim().split("\n")).toHaveLength(1);
      for (const value of [secret, API_KEY]) expect(stderr + stdout).not.toContain(value);
      expect(stderr + stdout).not.toMatch(/\n\s+at /);
      // Configuration is validated before any storage is touched.
      expect(await fs.readdir(dataDir)).toEqual([]);
    })(), TEST_TIMEOUT);

    test.concurrent("MD_API_KEY and MD_AUTH_FILE together are rejected without printing the key", withScope(async scope => {
      const server = scope.start({ port: await freePort(), dataDir: await scope.tempDir("markdownify-index-"), env: { MD_AUTH_FILE: "/nonexistent/registry.json" } });
      expect((await terminated(server)).code).toBe(1);
      expect(server.output().stderr).toContain("MD_AUTH_FILE");
      expect(server.output().stderr).not.toContain(API_KEY);
    }), TEST_TIMEOUT);
  });

  test.concurrent("SIGTERM during an in-flight conversion fails the job as CONVERSION_INTERRUPTED, exits 0, and the next start serves that state", withScope(async scope => {
    const scratch = await scope.tempDir("markdownify-index-scratch-"), dataDir = await scope.tempDir("markdownify-index-");
    const { script, pidFile } = await scope.hangingConverter(scratch);
    const first = scope.start({ port: await freePort(), dataDir, converter: script });
    await ready(first);
    const id = await startRunningJob(first, pidFile);
    first.child.kill("SIGTERM");
    expect(await terminated(first)).toEqual({ code: 0, signal: null });
    // The in-flight worker is aborted by jobs.close(); its converter is killed and the outcome is persisted before exit.
    // A graceful restart leaves the same retryable code as crash recovery.
    const persisted = await readJob(first, id);
    expect(persisted).toMatchObject({ status: "failed", error_code: "CONVERSION_INTERRUPTED" });
    await expect(fs.stat(path.join(dataDir, id, "output.part"))).rejects.toMatchObject({ code: "ENOENT" });
    await until(() => { try { process.kill(Number(readFileSync(pidFile, "utf8")), 0); return false; } catch { return true; } }, "converter to be killed");

    const second = scope.start({ port: await freePort(), dataDir, converter: script });
    await ready(second);
    const { client, call } = await connect(second);
    try {
      const status = await call<{ status: string; error_info: { code: string; retryable: boolean } }>("get_conversion_status", { job_id: id });
      expect(status).toMatchObject({ status: "failed", error_info: { code: "CONVERSION_INTERRUPTED", retryable: true } });
    } finally { await client.close(); }
    second.child.kill("SIGTERM");
    expect((await terminated(second)).code).toBe(0);
  }), TEST_TIMEOUT);

  test.concurrent("a SIGKILLed server leaves a running job that the next start recovers as CONVERSION_INTERRUPTED", withScope(async scope => {
    const scratch = await scope.tempDir("markdownify-index-scratch-"), dataDir = await scope.tempDir("markdownify-index-");
    const { script, pidFile } = await scope.hangingConverter(scratch);
    const first = scope.start({ port: await freePort(), dataDir, converter: script });
    await ready(first);
    const id = await startRunningJob(first, pidFile);
    first.child.kill("SIGKILL");
    expect((await terminated(first)).signal).toBe("SIGKILL");
    expect((await readJob(first, id)).status).toBe("running");
    // A crash cannot run the exit hook, so the documented operator step is to remove the stale lock.
    const refused = scope.start({ port: await freePort(), dataDir, converter: script });
    expect((await terminated(refused)).code).toBe(1);
    expect(refused.output().stderr).toContain("MD_DATA_DIR/.lock");
    await fs.rm(path.join(dataDir, ".lock"));

    const second = scope.start({ port: await freePort(), dataDir, converter: script });
    await ready(second);
    expect(await readJob(second, id)).toMatchObject({ status: "failed", error_code: "CONVERSION_INTERRUPTED" });
    const { client, call } = await connect(second);
    try {
      const status = await call<{ status: string; error_info: { code: string; retryable: boolean } }>("get_conversion_status", { job_id: id });
      expect(status).toMatchObject({ status: "failed", error_info: { code: "CONVERSION_INTERRUPTED", retryable: true } });
    } finally { await client.close(); }
    second.child.kill("SIGTERM");
    expect((await terminated(second)).code).toBe(0);
  }), TEST_TIMEOUT);
});
