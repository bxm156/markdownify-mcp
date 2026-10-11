import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolveMarkitdownPath } from "../utils.js";
import { ServiceError } from "./errors.js";

export type Converter = (inputPath: string, outputPath: string, signal: AbortSignal) => Promise<void>;

/** Abort reasons for a running conversion. Each carries the error code that the failed job keeps. */
export const conversionAbort = {
  /** An explicit cancellation, such as delete_job during a running conversion. */
  cancelled: () => new ServiceError(409, "Conversion cancelled", "CONVERSION_CANCELLED"),
  /** A graceful shutdown (SIGTERM, SIGINT or SIGHUP). From the agent's view this is a server restart. */
  interrupted: () => new ServiceError(503, "Conversion interrupted by server restart", "CONVERSION_INTERRUPTED"),
  /** The MD_CONVERSION_TIMEOUT_MS deadline. */
  timedOut: (timeoutMs: number) => new ServiceError(504, "Conversion timed out", "CONVERSION_TIMEOUT", { timeout_ms: timeoutMs }),
};
const abortCodes = new Set<string>(["CONVERSION_CANCELLED", "CONVERSION_INTERRUPTED", "CONVERSION_TIMEOUT"]);
/** The error for an aborted signal: its reason when that is a conversion abort reason, otherwise a cancellation. */
export function abortError(signal: AbortSignal): ServiceError {
  const reason: unknown = signal.reason;
  return reason instanceof ServiceError && abortCodes.has(reason.code) ? reason : conversionAbort.cancelled();
}

/** No shell is involved; stdout is streamed and bounded, including during conversion. */
export function createConverter(options: { maxOutputBytes: number; projectRoot?: string; executable?: string }): Converter {
  return async (inputPath, outputPath, signal) => {
    if (signal.aborted) throw abortError(signal);
    const executable = options.executable ?? resolveMarkitdownPath(options.projectRoot ?? process.cwd());
    const child = spawn(executable, [inputPath], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let bytes = 0;
    // Drain stderr without retaining document contents or exposing server paths to clients.
    child.stderr.resume();
    const stop = () => child.kill("SIGKILL");
    signal.addEventListener("abort", stop, { once: true });
    const exited = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve() : reject(new ServiceError(422, "Document conversion failed", "CONVERSION_FAILED")));
    });
    const limit = new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > options.maxOutputBytes ? new ServiceError(413, "Converted Markdown exceeds output limit", "OUTPUT_LIMIT_EXCEEDED", { limit_bytes: options.maxOutputBytes }) : null, chunk);
    } });
    const streamed = pipeline(child.stdout, limit, createWriteStream(outputPath, { flags: "wx", mode: 0o600 }));
    try {
      await Promise.all([exited, streamed]);
      if (signal.aborted) throw abortError(signal);
    } catch (error) {
      stop();
      // A nonzero exit can arrive before the output stream has closed. Wait
      // for both before the caller removes its partial output (also on Windows).
      await Promise.allSettled([exited, streamed]);
      // A killed child exits nonzero; report why it was killed, not a document failure.
      throw signal.aborted ? abortError(signal) : error;
    } finally {
      signal.removeEventListener("abort", stop);
    }
  };
}
