import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as tools from "./tools.js";
import { isRunning, killQuietly, waitUntil } from "./test-helpers.js";

const ENTRY = fileURLToPath(new URL("./index.ts", import.meta.url));
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
);

type JsonRpcMessage = { id?: number; result?: any; error?: any };

/** Drives the stdio server with newline-delimited JSON-RPC. */
class StdioSession {
  readonly child: ChildProcessWithoutNullStreams;
  /** Resolves with the exit status (null when a signal killed the process). */
  readonly exited: Promise<number | null>;
  stderr = "";
  private buffer = "";
  private waiters = new Map<number, (m: JsonRpcMessage) => void>();
  private received = new Map<number, JsonRpcMessage>();

  constructor(env: NodeJS.ProcessEnv = {}) {
    this.child = spawn(process.execPath, [ENTRY], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HTTP_PROXY: "", HTTPS_PROXY: "", http_proxy: "", https_proxy: "", ...env },
    });
    this.exited = new Promise((resolve) =>
      this.child.once("exit", (code) => resolve(code)),
    );
    this.child.stderr.setEncoding("utf-8");
    this.child.stderr.on("data", (chunk: string) => (this.stderr += chunk));
    this.child.stdout.setEncoding("utf-8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line) as JsonRpcMessage;
        if (message.id === undefined) continue;
        const waiter = this.waiters.get(message.id);
        if (waiter) {
          this.waiters.delete(message.id);
          waiter(message);
        } else {
          this.received.set(message.id, message);
        }
      }
    });
  }

  send(message: object) {
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  /** Sends initialize and notifications/initialized. */
  async initialize() {
    this.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "smoke-test", version: "0.0.0" },
      },
    });
    const init = await this.response(1);
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return init;
  }

  /** Resolves with the response to request `id`; the test timeout is the deadline. */
  response(id: number): Promise<JsonRpcMessage> {
    const early = this.received.get(id);
    if (early) return Promise.resolve(early);
    return new Promise((resolve) => this.waiters.set(id, resolve));
  }
}

let session: StdioSession | undefined;

afterEach(async () => {
  if (session && session.child.exitCode === null && session.child.signalCode === null) {
    session.child.kill("SIGKILL");
    await session.exited;
  }
  session = undefined;
});

describe("stdio bootstrap (src/index.ts)", () => {
  test("serves initialize and tools/list, then exits 0 when stdin closes", async () => {
    session = new StdioSession();

    session.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "smoke-test", version: "0.0.0" },
      },
    });
    const init = await session.response(1);
    expect(init.error).toBeUndefined();
    expect(init.result.serverInfo).toEqual({
      name: "mcp-markdownify-server",
      version: pkg.version,
    });
    expect(init.result.capabilities.tools).toBeDefined();

    session.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    session.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const list = await session.response(2);
    expect(list.error).toBeUndefined();
    const names = list.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toHaveLength(11);
    expect(names).toEqual(Object.values(tools).map((t) => t.name).sort());

    session.child.stdin.end();
    expect(await session.exited).toBe(0);
    expect(session.stderr).not.toContain("Fatal error");
  }, 30_000);

  test("invalid tool arguments come back as an isError result over the wire", async () => {
    session = new StdioSession();
    session.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "smoke-test", version: "0.0.0" },
      },
    });
    await session.response(1);
    session.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    session.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "webpage-to-markdown", arguments: {} },
    });
    const res = await session.response(2);
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toBe("Error: URL is required for this tool");
    session.child.stdin.end();
    expect(await session.exited).toBe(0);
  }, 30_000);

  // markitdown runs in its own process group (so a timeout can kill its
  // tree), out of reach of signals sent to the server; the entry point must
  // kill it on the way out. The stub stands in for markitdown and starts a
  // grandchild, like a converter's own helpers.
  for (const [signal, expectedCode] of [
    ["SIGTERM", 143],
    ["SIGINT", 130],
    ["SIGHUP", 129],
  ] as const) {
    test.skipIf(process.platform === "win32")(
      `${signal} stops the server with status ${expectedCode} and kills a running converter tree`,
      async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfy-index-"));
        const pidFile = (name: string) => path.join(dir, `${name}.pid`);
        const stub = path.join(dir, "markitdown");
        fs.writeFileSync(
          stub,
          "#!/bin/sh\n" +
            `sleep 30 &\necho $! > "${pidFile("grandchild")}"\n` +
            // Written last and renamed into place: once it exists both files are complete.
            `echo $$ > "${pidFile("child")}.tmp" && mv "${pidFile("child")}.tmp" "${pidFile("child")}"\n` +
            "wait\n",
          { mode: 0o755 },
        );
        let pids: number[] = [];
        try {
          session = new StdioSession({
            MARKITDOWN_PATH: stub,
            MD_CONVERTER_TIMEOUT_MS: "60000",
            // process.exit skips the staging directory's cleanup: keep it in `dir`.
            TMPDIR: dir,
            TEMP: dir,
            TMP: dir,
          });
          await session.initialize();
          session.send({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {
              name: "pdf-to-markdown",
              arguments: { filepath: fileURLToPath(new URL("./sample-data/test.pdf", import.meta.url)) },
            },
          });
          await waitUntil(() => fs.existsSync(pidFile("child")), "the converter stub to start", 10_000);
          const readPid = (name: string) => Number(fs.readFileSync(pidFile(name), "utf-8").trim());
          pids = [readPid("child"), readPid("grandchild")];
          expect(pids.every(isRunning)).toBe(true);

          session.child.kill(signal);
          let timer: ReturnType<typeof setTimeout> | undefined;
          const code = await Promise.race([
            session.exited,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error(`server still running 5 s after ${signal}`)), 5000);
            }),
          ]).finally(() => clearTimeout(timer));
          expect(code).toBe(expectedCode);
          expect(session.child.signalCode).toBeNull();
          for (const pid of pids) {
            await waitUntil(() => !isRunning(pid), `process ${pid} to exit`);
          }
        } finally {
          killQuietly(pids);
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
      30_000,
    );
  }
});
