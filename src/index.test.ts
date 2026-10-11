import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as tools from "./tools.js";

const ENTRY = fileURLToPath(new URL("./index.ts", import.meta.url));
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
);

type JsonRpcMessage = { id?: number; result?: any; error?: any };

/** Drives the stdio server with newline-delimited JSON-RPC. */
class StdioSession {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<number | null>;
  stderr = "";
  private buffer = "";
  private waiters = new Map<number, (m: JsonRpcMessage) => void>();
  private received = new Map<number, JsonRpcMessage>();

  constructor() {
    this.child = spawn(process.execPath, [ENTRY], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HTTP_PROXY: "", HTTPS_PROXY: "", http_proxy: "", https_proxy: "" },
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
});
