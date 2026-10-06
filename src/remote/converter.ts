import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolveMarkitdownPath } from "../utils.js";
import { ServiceError } from "./errors.js";

export type Converter = (inputPath: string, outputPath: string, signal: AbortSignal) => Promise<void>;

/** No shell is involved; stdout is streamed and bounded, including during conversion. */
export function createConverter(options: { maxOutputBytes: number; projectRoot?: string; executable?: string }): Converter {
  return async (inputPath, outputPath, signal) => {
    signal.throwIfAborted();
    const executable = options.executable ?? resolveMarkitdownPath(options.projectRoot ?? process.cwd());
    const child = spawn(executable, [inputPath], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let bytes = 0;
    // Drain stderr without retaining document contents or exposing server paths to clients.
    child.stderr.resume();
    const stop = () => child.kill("SIGKILL");
    signal.addEventListener("abort", stop, { once: true });
    const exited = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve() : reject(new Error("Document conversion failed")));
    });
    const limit = new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > options.maxOutputBytes ? new ServiceError(413, "Converted Markdown exceeds output limit", "OUTPUT_LIMIT_EXCEEDED", { limit_bytes: options.maxOutputBytes }) : null, chunk);
    } });
    const streamed = pipeline(child.stdout, limit, createWriteStream(outputPath, { flags: "wx", mode: 0o600 }));
    try {
      await Promise.all([exited, streamed]);
      signal.throwIfAborted();
    } catch (error) {
      stop();
      // A nonzero exit can arrive before the output stream has closed. Wait
      // for both before the caller removes its partial output (also on Windows).
      await Promise.allSettled([exited, streamed]);
      throw error;
    } finally {
      signal.removeEventListener("abort", stop);
    }
  };
}
