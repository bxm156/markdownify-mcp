#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { createHttpServer } from "./http.js";
import { JobService } from "./jobs.js";
import { createAuditLogger } from "./audit.js";

export type RemoteConfig = ReturnType<typeof loadConfig>;
/** The process facilities the entry point touches, injectable so shutdown and signals can be tested without killing the test runner. */
export interface ProcessHandle {
  once(signal: "SIGINT" | "SIGTERM" | "SIGHUP", listener: () => void): unknown;
  exit(code: number): unknown;
}
export interface RemoteServerOptions {
  config: RemoteConfig;
  /** Builds the job service; `init()` is called by `startRemoteServer`. Defaults to a JobService with the audit logger from `config.jobs.dataDir`. */
  createJobs?: (config: RemoteConfig) => JobService | Promise<JobService>;
  createServer?: (jobs: JobService, config: RemoteConfig) => Server;
  processHandle?: ProcessHandle;
  log?: (message: string) => void;
}
export interface RemoteServer { server: Server; jobs: JobService; shutdown: () => Promise<void> }

/** Headers and request body deadlines applied to every remote server. */
export const REQUEST_TIMEOUT_MS = 5 * 60_000;
export const HEADERS_TIMEOUT_MS = 30_000;

const defaultProcessHandle: ProcessHandle = { once: (signal, listener) => process.once(signal, listener), exit: code => process.exit(code) };
async function defaultCreateJobs(config: RemoteConfig) {
  const audit = await createAuditLogger(config.jobs.dataDir);
  return new JobService({ ...config.jobs, audit });
}

export async function startRemoteServer(options: RemoteServerOptions): Promise<RemoteServer> {
  const { config } = options;
  const createJobs = options.createJobs ?? defaultCreateJobs;
  const createServer = options.createServer ?? ((service: JobService, settings: RemoteConfig) => createHttpServer(service, settings));
  const processHandle = options.processHandle ?? defaultProcessHandle;
  const log = options.log ?? ((message: string) => { console.error(message); });
  const jobs = await createJobs(config);
  await jobs.init();
  const server = createServer(jobs, config);
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, resolve);
    });
  } catch (error) { await jobs.close(); throw error; }
  log(`Markdownify remote listening on ${config.host}:${config.port}`);
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const deadline = setTimeout(() => { server.closeAllConnections(); processHandle.exit(1); }, config.shutdownTimeoutMs);
    deadline.unref();
    const stopped = new Promise<void>(resolve => server.close(() => resolve()));
    await jobs.close();
    server.closeAllConnections();
    await stopped;
    clearTimeout(deadline);
  };
  processHandle.once("SIGINT", () => { void shutdown(); });
  processHandle.once("SIGTERM", () => { void shutdown(); });
  // A closed terminal or supervisor hang-up would otherwise terminate without releasing the volume lock.
  processHandle.once("SIGHUP", () => { void shutdown(); });
  return { server, jobs, shutdown };
}

/**
 * True only when this module is the program being run, so importing it (for example from a test) never starts a server.
 * Bun and Node 24+ provide `import.meta.main`; older Node compares the resolved script path with this module's file.
 */
function isEntryPoint(): boolean {
  const flag = (import.meta as { main?: boolean }).main;
  if (typeof flag === "boolean") return flag;
  const script = process.argv[1];
  if (!script) return false;
  try { return fs.realpathSync(path.resolve(script)) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

async function main() {
  process.env.PYTHONUTF8 = "1";
  await startRemoteServer({ config: loadConfig() });
}

if (isEntryPoint()) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : "Remote server startup failed");
    process.exitCode = 1;
  });
}
