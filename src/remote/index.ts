#!/usr/bin/env node
/**
 * Entry point of the remote (Streamable HTTP) Markdownify server.
 *
 * Linux-only: startup is refused on Windows before configuration is read or the data directory is touched. The remote
 * tree is compiled by tsc and run under Node 24.2+ (`node dist/remote/index.js`), so it must not use Bun-only APIs; Bun
 * only builds and tests it. Importing this module never starts a server (see isEntryPoint), so tests drive
 * startRemoteServer with injected dependencies instead.
 */
import type { Server } from "node:http";
import { loadConfig, SHUTDOWN_TIMEOUT_WARN_MS, WINDOWS_UNSUPPORTED_MESSAGE } from "./config.js";
import { createHttpServer } from "./http.js";
import { JobService } from "./jobs.js";
import { createAuditLogger } from "./audit.js";

/** The validated configuration produced by loadConfig. */
export type RemoteConfig = ReturnType<typeof loadConfig>;
/** The process facilities the entry point touches, injectable so shutdown and signals can be tested without killing the test runner. */
export interface ProcessHandle {
  once(signal: "SIGINT" | "SIGTERM" | "SIGHUP", listener: () => void): unknown;
  exit(code: number): unknown;
}
/** Inputs to startRemoteServer. Everything except `config` is injectable for tests and defaults to the production implementation. */
export interface RemoteServerOptions {
  config: RemoteConfig;
  /** Builds the job service; `init()` is called by `startRemoteServer`. Defaults to a JobService with the audit logger from `config.jobs.dataDir`. */
  createJobs?: (config: RemoteConfig) => JobService | Promise<JobService>;
  /** Builds the HTTP server (default: createHttpServer, which sets the request and header timeouts). */
  createServer?: (jobs: JobService, config: RemoteConfig) => Server;
  /** Signal registration and exit; defaults to the real process. */
  processHandle?: ProcessHandle;
  /** Operator log sink; defaults to stderr. */
  log?: (message: string) => void;
  /** The host platform; defaults to `process.platform`. Startup is refused on "win32". */
  platform?: NodeJS.Platform;
}
/** A listening server. `shutdown` is idempotent and is what SIGINT, SIGTERM and SIGHUP invoke. */
export interface RemoteServer { server: Server; jobs: JobService; shutdown: () => Promise<void> }

const defaultProcessHandle: ProcessHandle = { once: (signal, listener) => process.once(signal, listener), exit: code => process.exit(code) };
const defaultLog = (message: string) => { console.error(message); };
/**
 * Refuses to run on Windows: logs WINDOWS_UNSUPPORTED_MESSAGE once and exits with status 1, before the data directory is
 * touched. The throw is reached only when an injected `exit` returns, so nothing after this call runs.
 */
export function refuseUnsupportedPlatform(platform: NodeJS.Platform, log: (message: string) => void = defaultLog, processHandle: ProcessHandle = defaultProcessHandle): void {
  if (platform !== "win32") return;
  log(WINDOWS_UNSUPPORTED_MESSAGE);
  processHandle.exit(1);
  throw new Error(WINDOWS_UNSUPPORTED_MESSAGE);
}
/** The production job service. The audit log lives in the data directory, next to the job directories. */
async function defaultCreateJobs(config: RemoteConfig) {
  const audit = await createAuditLogger(config.jobs.dataDir);
  return new JobService({ ...config.jobs, audit });
}

/**
 * Starts the remote server and installs the shutdown handlers.
 *
 * Startup: refuse Windows; warn (but continue) when the shutdown deadline exceeds SHUTDOWN_TIMEOUT_WARN_MS; build the
 * job service and init() it, which takes the data-directory lock, loads and recovers manifests and runs a first
 * cleanup sweep; build the HTTP server (createHttpServer sets its timeouts, see http.ts); listen. If listening fails
 * the job service is closed, releasing the lock, and the error is rethrown.
 *
 * Shutdown (the first call acts; later calls return at once without waiting): arm a `shutdownTimeoutMs` deadline that
 * drops every connection and exits with status 1; stop accepting connections; close the job service (aborts uploads,
 * persists running conversions as CONVERSION_INTERRUPTED, waits for workers, the sweep and pending job operations, then
 * releases the lock); drop the remaining keep-alive and in-flight connections; wait for the server to close; disarm the
 * deadline. A clean shutdown never calls exit: the process ends once nothing else holds the event loop.
 *
 * Lock loss: init() passes `config.lockStaleAfterMs` and an onLost callback to the data-directory lock. If another
 * process reclaims the lock (lock.ts fencing), the same shutdown runs and then exits with status 1.
 */
export async function startRemoteServer(options: RemoteServerOptions): Promise<RemoteServer> {
  const { config } = options;
  const createJobs = options.createJobs ?? defaultCreateJobs;
  const createServer = options.createServer ?? ((service: JobService, settings: RemoteConfig) => createHttpServer(service, settings));
  const processHandle = options.processHandle ?? defaultProcessHandle;
  const log = options.log ?? defaultLog;
  refuseUnsupportedPlatform(options.platform ?? process.platform, log, processHandle);
  // A deadline longer than the container's stop grace period means SIGKILL arrives first (see SHUTDOWN_TIMEOUT_WARN_MS).
  // Warn once, as a single-line JSON operator event, but still start: other runtimes may allow longer.
  if (config.shutdownTimeoutMs > SHUTDOWN_TIMEOUT_WARN_MS) log(JSON.stringify({ event: "shutdown_timeout_warning", shutdown_timeout_ms: config.shutdownTimeoutMs, ceiling_ms: SHUTDOWN_TIMEOUT_WARN_MS }));
  const jobs = await createJobs(config);
  // Fencing (lock.ts): if another process takes the volume lock over, shut down and exit 1 (wired below, once shutdown exists).
  let lockLost = false, onLockLost = () => { lockLost = true; };
  await jobs.init({ staleAfterMs: config.lockStaleAfterMs, log, onLost: () => onLockLost() });
  const server = createServer(jobs, config);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, resolve);
    });
  } catch (error) { await jobs.close(); throw error; }
  log(`Markdownify remote listening on ${config.host}:${config.port}`);
  let stopping: Promise<void> | undefined;
  const stop = async () => {
    const deadline = setTimeout(() => { server.closeAllConnections(); processHandle.exit(1); }, config.shutdownTimeoutMs);
    deadline.unref();
    const stopped = new Promise<void>(resolve => server.close(() => resolve()));
    await jobs.close();
    server.closeAllConnections();
    await stopped;
    clearTimeout(deadline);
  };
  const shutdown = async () => { if (stopping) return; stopping = stop(); await stopping; };
  // The lock now belongs to another process: drain as on SIGTERM (jobs.close() interrupts running conversions), then exit 1.
  // Nothing is released: lock.ts has already forgotten the lock, so neither releaseLock nor the exit hook touches the file.
  onLockLost = () => { shutdown().catch(() => undefined); void stopping!.then(() => processHandle.exit(1), () => processHandle.exit(1)); };
  if (lockLost) onLockLost();
  processHandle.once("SIGINT", () => { void shutdown(); });
  processHandle.once("SIGTERM", () => { void shutdown(); });
  // A closed terminal or supervisor hang-up would otherwise terminate without releasing the volume lock.
  processHandle.once("SIGHUP", () => { void shutdown(); });
  return { server, jobs, shutdown };
}

/**
 * True only when this module is the program being run, so importing it (for example from a test) never starts a server.
 * Requires `import.meta.main`, which Node 24.2+ (engines.node) and Bun provide.
 */
function isEntryPoint(): boolean {
  return import.meta.main;
}

/**
 * CLI startup from the environment. PYTHONUTF8=1 is inherited by every markitdown child, so the converter reads and
 * writes UTF-8 whatever the container locale.
 */
async function main() {
  // Before loadConfig, so a Windows host gets this message rather than a configuration error.
  refuseUnsupportedPlatform(process.platform);
  process.env.PYTHONUTF8 = "1";
  await startRemoteServer({ config: loadConfig() });
}

// Startup failures print only the error message, never a stack, and set a nonzero exit status.
if (isEntryPoint()) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : "Remote server startup failed");
    process.exitCode = 1;
  });
}
