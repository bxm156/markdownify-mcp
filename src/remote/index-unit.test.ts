import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import net from "node:net";
import type { JobService } from "./jobs.js";
import { loadConfig } from "./config.js";
import { startRemoteServer, type ProcessHandle, type RemoteConfig, type RemoteServer } from "./index.js";

// Unit tests for startRemoteServer: every process-level side effect (exit, signal registration, logging) and the job
// service are injected, so shutdown deadlines, server timeouts and listen-error cleanup run in-process.
const API_KEY = "test-api-key-0123456789-abcdefghijklmnop";
type Signal = "SIGINT" | "SIGTERM" | "SIGHUP";

function makeConfig(env: Record<string, string> = {}): RemoteConfig {
  return loadConfig({ MD_API_KEY: API_KEY, MD_HOST: "127.0.0.1", MD_DATA_DIR: "/nonexistent/markdownify-unit", ...env });
}
async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}
function stubJobs(close: () => Promise<void> = async () => {}) {
  const calls = { init: 0, close: 0 };
  const jobs = { init: async () => { calls.init++; }, close: async () => { calls.close++; await close(); } } as unknown as JobService;
  return { jobs, calls };
}
function fakeProcess() {
  const listeners = new Map<Signal, () => void>(), exits: number[] = [];
  const handle: ProcessHandle = { once: (signal, listener) => { listeners.set(signal, listener); }, exit: code => { exits.push(code); } };
  return { handle, listeners, exits, send: (signal: Signal) => listeners.get(signal)!() };
}
const running: RemoteServer[] = [];
async function start(config: RemoteConfig, jobsStub = stubJobs(), extra: { createServer?: () => Server } = {}) {
  const proc = fakeProcess(), logs: string[] = [];
  const started = await startRemoteServer({ config, createJobs: () => jobsStub.jobs, processHandle: proc.handle, log: message => logs.push(message), ...extra });
  running.push(started);
  return { ...started, ...jobsStub, proc, logs };
}
afterEach(async () => {
  for (const started of running.splice(0)) { started.server.closeAllConnections(); if (started.server.listening) await new Promise<void>(resolve => started.server.close(() => resolve())); }
});

describe("startRemoteServer", () => {
  test("initialises jobs, listens, logs and applies the request and header timeouts", async () => {
    const port = await freePort();
    const started = await start(makeConfig({ MD_PORT: String(port) }));
    expect(started.calls).toEqual({ init: 1, close: 0 });
    expect(started.server.listening).toBe(true);
    expect(started.logs).toEqual([`Markdownify remote listening on 127.0.0.1:${port}`]);
    expect(started.server.requestTimeout).toBe(300000);
    expect(started.server.headersTimeout).toBe(30000);
    expect([...started.proc.listeners.keys()].sort()).toEqual(["SIGHUP", "SIGINT", "SIGTERM"]);
    expect(started.proc.exits).toEqual([]);
  });

  test("a clean shutdown closes jobs and the server, never forces an exit, and leaves no pending deadline", async () => {
    const started = await start(makeConfig({ MD_PORT: String(await freePort()), MD_SHUTDOWN_TIMEOUT_MS: "50" }));
    await started.shutdown();
    expect(started.calls.close).toBe(1);
    expect(started.server.listening).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(started.proc.exits).toEqual([]);
  });

  test("the forced-exit deadline closes all connections and exits 1 when jobs.close() never resolves", async () => {
    const config = makeConfig({ MD_PORT: String(await freePort()), MD_SHUTDOWN_TIMEOUT_MS: "40" });
    expect(config.shutdownTimeoutMs).toBe(40);
    const server = createServer();
    let closeAll = 0;
    const real = server.closeAllConnections.bind(server);
    server.closeAllConnections = () => { closeAll++; real(); };
    const started = await start(config, stubJobs(() => new Promise<void>(() => {})), { createServer: () => server });
    const begun = Date.now();
    void started.shutdown();
    // The deadline is the only thing that can fire: jobs.close() is pending forever and the exit stub does not kill the process.
    expect(closeAll).toBe(0);
    expect(started.proc.exits).toEqual([]);
    const exits = await new Promise<number[]>(resolve => {
      const check = setInterval(() => { if (started.proc.exits.length) { clearInterval(check); resolve(started.proc.exits); } }, 5);
    });
    expect(exits).toEqual([1]);
    expect(closeAll).toBe(1);
    expect(Date.now() - begun).toBeGreaterThanOrEqual(35);
    expect(started.calls.close).toBe(1);
  });

  test("a second signal, of the same or another kind, does not run shutdown again", async () => {
    const started = await start(makeConfig({ MD_PORT: String(await freePort()) }));
    started.proc.send("SIGINT");
    started.proc.send("SIGTERM");
    started.proc.send("SIGHUP");
    await started.shutdown();
    await started.shutdown();
    // Let the first shutdown finish, then confirm nothing re-entered.
    await new Promise<void>(resolve => { const check = setInterval(() => { if (!started.server.listening) { clearInterval(check); resolve(); } }, 5); });
    expect(started.calls.close).toBe(1);
    expect(started.proc.exits).toEqual([]);
  });

  describe("when listen fails", () => {
    test("on an occupied port, jobs.close() is awaited exactly once, the error propagates, and no handlers are registered", async () => {
      const holder = net.createServer();
      await new Promise<void>((resolve, reject) => { holder.once("error", reject); holder.listen(0, "127.0.0.1", resolve); });
      try {
        const port = (holder.address() as net.AddressInfo).port;
        let closed = false;
        const jobsStub = stubJobs(async () => { await new Promise(resolve => setTimeout(resolve, 20)); closed = true; });
        const proc = fakeProcess();
        const failure = await startRemoteServer({ config: makeConfig({ MD_PORT: String(port) }), createJobs: () => jobsStub.jobs, processHandle: proc.handle, log: () => {} }).then(() => undefined, error => error);
        expect(failure).toMatchObject({ code: "EADDRINUSE" });
        // close() was awaited before the rejection surfaced, not fired and forgotten.
        expect(closed).toBe(true);
        expect(jobsStub.calls).toEqual({ init: 1, close: 1 });
        expect(proc.listeners.size).toBe(0);
        expect(proc.exits).toEqual([]);
      } finally { await new Promise<void>(resolve => holder.close(() => resolve())); }
    });

    test("an 'error' event from the server rejects with that error after one jobs.close()", async () => {
      const boom = new Error("listen exploded");
      const server = createServer();
      server.listen = (() => { queueMicrotask(() => server.emit("error", boom)); return server; }) as unknown as Server["listen"];
      const jobsStub = stubJobs();
      const proc = fakeProcess(), logs: string[] = [];
      await expect(startRemoteServer({ config: makeConfig(), createJobs: () => jobsStub.jobs, createServer: () => server, processHandle: proc.handle, log: message => logs.push(message) })).rejects.toBe(boom);
      expect(jobsStub.calls).toEqual({ init: 1, close: 1 });
      expect(logs).toEqual([]);
      expect(proc.listeners.size).toBe(0);
    });
  });

  test("importing the module does not start a server or touch process signal handlers", async () => {
    const before = process.listenerCount("SIGTERM");
    await import("./index.js");
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});
