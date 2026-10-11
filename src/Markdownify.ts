/**
 * Conversion back end of the stdio tools: fetches URLs, stages local files
 * and runs the external `markitdown` (Python) and `repomix` executables.
 *
 * Invariants:
 * - URL fetches connect only to addresses vetted by resolvePublicAddresses,
 *   re-validated on every redirect hop (SSRF), via download.fetch.
 * - Every input markitdown sees is bounded by one 50 MiB budget: URL bodies
 *   by readBodyWithLimit, local files by openLocalFile / readOpenedFile.
 * - A local file is read only through the handle that was opened and
 *   checked, never reopened by path; markitdown gets a private copy.
 * - Temporary files live in a per-call mkdtemp directory that is removed
 *   when the call settles, whether it succeeds or fails.
 * - External tools run through runTool (spawn, no shell), so arguments are
 *   never shell-interpreted. On POSIX each run gets its own process group,
 *   and the whole group (git processes repomix starts included) is killed
 *   with SIGKILL after converterTimeoutMs().
 * - repomix runs with TMPDIR/TEMP/TMP pointing at a private directory that
 *   is removed when the run settles, so a killed clone leaves nothing behind.
 * - git-repo-to-markdown arguments reach repomix only after validateGitRef
 *   (branch) and validateRepoUrl (host allowlist + address pre-check).
 * Must run under Node and Bun.
 */
import { spawn, type ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import { fileURLToPath } from "url";
import { download } from "./download.js";
import {
  expandHome,
  redactUrl,
  resolvePublicAddresses,
  validateRepoUrl,
  validateGitRef,
  isUnconvertedHtml,
  inferExtensionFromUrl,
  isMarkdownFile,
  resolveMarkitdownPath,
  resolveRepomixPath,
  openLocalFile,
  readOpenedFile,
  MAX_LOCAL_FILE_BYTES,
  type OpenedLocalFile,
} from "./utils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** One deadline for a URL fetch: every redirect hop, DNS lookup, connect and the body read. */
const FETCH_TIMEOUT_MS = 30_000;
// URL downloads and local files share one input budget (50 MiB).
const MAX_DOWNLOAD_BYTES = MAX_LOCAL_FILE_BYTES;

/** Default limit on one markitdown or repomix run (5 minutes). */
export const CONVERTER_TIMEOUT_MS = 5 * 60_000;

/**
 * Deadline for the DNS pre-check of a git-repo-to-markdown host
 * (validateRepoUrl), separate from the repomix run itself.
 */
const REPO_HOST_CHECK_TIMEOUT_MS = 30_000;

/**
 * The limit on one markitdown or repomix run: MD_CONVERTER_TIMEOUT_MS when it
 * is a positive number of milliseconds, else CONVERTER_TIMEOUT_MS. Read on
 * every call.
 */
export function converterTimeoutMs(): number {
  const configured = Number(process.env.MD_CONVERTER_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : CONVERTER_TIMEOUT_MS;
}

/**
 * Whether external tools get their own process group. Windows has no POSIX
 * process groups (and `detached` would open a console window there).
 */
const USE_PROCESS_GROUPS = process.platform !== "win32";

/** What runTool resolves with: the tool's decoded stdout and stderr. */
type ToolOutput = { stdout: string; stderr: string };

/**
 * A runTool failure. Like execFile's errors it carries `code` (the spawn
 * errno such as "ENOENT", the exit status, or
 * "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"), `signal`, `stdout` and `stderr`;
 * `timedOut` is set only when the run was killed for exceeding its limit.
 */
type ToolError = Error & {
  code?: string | number | null;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
  stdout?: string;
  stderr?: string;
};

/**
 * SIGKILLs `child` and, on POSIX, every process in its group (it was spawned
 * as a group leader), so grandchildren such as the `git` processes repomix
 * starts die with it. Falls back to killing only the child on Windows or
 * when the group kill fails (for example, the group is already gone).
 * The group id cannot have been reused here: Linux and the BSDs do not hand
 * out a pid while it is still some live process's group id.
 */
function killProcessTree(child: ChildProcess): void {
  if (USE_PROCESS_GROUPS && child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Fall back to the direct child below.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Already exited.
  }
}

/**
 * Runs `file` with `args` (no shell; bare names are looked up on PATH),
 * stdin from /dev/null, and collects stdout and stderr as UTF-8.
 *
 * Resolves on exit status 0 (stderr alone is not an error). Rejects with a
 * ToolError: the spawn error (e.g. ENOENT), "Command failed: <cmd>\n<stderr>"
 * for a non-zero exit or a signal, or Node's maxBuffer error once stdout or
 * stderr exceeds `maxBuffer` bytes. After `timeoutMs` the process tree is
 * killed (killProcessTree) and the error has `timedOut: true`. On a timeout
 * or an overflow the pipes are also destroyed, so the promise settles once
 * the direct child is gone even if something escaped the group.
 */
function runTool(
  file: string,
  args: string[],
  {
    maxBuffer,
    timeoutMs,
    env,
  }: { maxBuffer: number; timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<ToolOutput> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        detached: USE_PROCESS_GROUPS,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e: unknown) {
      reject(e);
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let overflow: ToolError | undefined;
    let settled = false;

    const stopTree = () => {
      killProcessTree(child);
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stopTree();
    }, timeoutMs);

    const collect = (name: "stdout" | "stderr", chunks: Buffer[]) => (chunk: Buffer) => {
      if (overflow || timedOut) return;
      const total = (name === "stdout" ? (stdoutBytes += chunk.length) : (stderrBytes += chunk.length));
      if (total > maxBuffer) {
        overflow = Object.assign(new RangeError(`${name} maxBuffer length exceeded`), {
          code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        });
        stopTree();
        return;
      }
      chunks.push(chunk);
    };
    child.stdout?.on("data", collect("stdout", stdout));
    child.stderr?.on("data", collect("stderr", stderr));

    const finish = (error: ToolError | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (error) reject(Object.assign(error, { stdout: out, stderr: err }));
      else resolve({ stdout: out, stderr: err });
    };

    // A failed spawn (ENOENT, EACCES) emits "error"; "close" may follow.
    child.on("error", (e: ToolError) => finish(e));
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (timedOut) {
        finish(Object.assign(new Error(`${file} timed out after ${timeoutMs} ms`), {
          code,
          signal,
          timedOut: true,
        }));
      } else if (overflow) {
        finish(overflow);
      } else if (code === 0) {
        finish(undefined);
      } else {
        const stderrText = Buffer.concat(stderr).toString("utf8");
        finish(Object.assign(
          new Error(`Command failed: ${[file, ...args].join(" ")}\n${stderrText}`),
          { code, signal },
        ));
      }
    });
  });
}

/** The markitdown that setup.sh, setup.bat and the Dockerfile install. */
const MARKITDOWN_REQUIREMENT = "markitdown[all]==0.1.5";

/** The command that installs the pinned markitdown into the project's .venv. */
function markitdownSetupCommand(): string {
  return process.platform === "win32"
    ? `python -m venv .venv && .venv\\Scripts\\pip install "${MARKITDOWN_REQUIREMENT}"`
    : `python3 -m venv .venv && .venv/bin/pip install "${MARKITDOWN_REQUIREMENT}"`;
}

/**
 * Result of a tool call: the Markdown text and, for get-markdown-file only,
 * the path as the caller gave it (server.ts reports it as "Output file: ...").
 */
export type MarkdownResult = {
  path?: string;
  text: string;
};

/** Static entry points used by server.ts; the class holds no state. */
export class Markdownify {
  /**
   * Runs markitdown on `filePath` and returns its stdout.
   *
   * The 50 MB maxBuffer bounds the Markdown kept in memory; larger output
   * rejects with Node's maxBuffer error. A run longer than `timeoutMs` is
   * killed with SIGKILL, together with any processes it started (see
   * runTool), and reported as "markitdown timed out". A missing executable becomes an
   * actionable "markitdown executable not found" error, and output that is
   * still an HTML document (see isUnconvertedHtml) becomes a "Conversion
   * failed" error instead of being returned as Markdown.
   */
  private static async _markitdown(
    filePath: string,
    projectRoot: string,
    timeoutMs = converterTimeoutMs(),
  ): Promise<string> {
    const markitdownPath = resolveMarkitdownPath(projectRoot);

    let stdout: string;
    try {
      // Bare command names are resolved against PATH (POSIX execvp / Windows search).
      // Non-zero exit codes reject; stderr alone does not (markitdown emits non-fatal
      // warnings from onnxruntime/pydub/etc. on a successful run).
      ({ stdout } = await runTool(markitdownPath, [filePath], {
        maxBuffer: 50 * 1024 * 1024, // 50 MB
        timeoutMs,
      }));
    } catch (e: unknown) {
      const err = e as ToolError;
      if (err?.code === "ENOENT") {
        throw new Error(
          `markitdown executable not found (looked up "${markitdownPath}"). ` +
            `Set MARKITDOWN_PATH to its absolute location, install it on PATH (e.g. \`pipx install "${MARKITDOWN_REQUIREMENT}"\`), ` +
            `or run setup in the project root (${projectRoot}): ` +
            `${markitdownSetupCommand()}.`,
        );
      }
      if (err?.timedOut === true) {
        throw new Error(
          `markitdown timed out after ${timeoutMs} ms and was stopped (MD_CONVERTER_TIMEOUT_MS sets the limit).`,
        );
      }
      throw e;
    }

    if (isUnconvertedHtml(stdout)) {
      throw new Error(
        "Conversion failed: the page returned raw HTML that could not be converted to Markdown. " +
          "This typically happens with JavaScript-rendered pages (SPAs) that require a browser to load content.",
      );
    }

    return stdout;
  }

  /**
   * Run `fn` with a fresh, private staging directory under os.tmpdir().
   *
   * Every call gets its own directory (fs.mkdtemp picks a unique name), so
   * concurrent conversions can never overwrite each other's files. The
   * directory and everything in it is removed when `fn` settles, whether it
   * resolves or throws, so nothing leaks in long-running stdio sessions.
   */
  private static async withStagingDir<T>(
    fn: (stagingDir: string) => Promise<T>,
    prefix = "markdown_output_",
  ): Promise<T> {
    const stagingDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
    try {
      return await fn(stagingDir);
    } finally {
      // Retries cover a killed tool whose last writes land during removal.
      await fs.promises.rm(stagingDir, { recursive: true, force: true, maxRetries: 3 });
    }
  }

  /**
   * Fetches `url`, following up to `maxRedirects` redirects itself.
   *
   * Each hop's URL is re-validated and re-resolved by resolvePublicAddresses
   * and the connection is pinned to those addresses, so neither a redirect
   * nor a DNS answer that changes between check and connect can reach an
   * internal address. Bodies of redirect and error responses are cancelled to
   * release their sockets. Throws "Fetching <redacted URL> failed with HTTP
   * <status>" for 4xx/5xx and "Too many redirects" past the limit; validation,
   * connection and timeout errors propagate as raised. A 3xx without a
   * Location header is returned as the response.
   */
  private static async safeFetch(
    url: string,
    maxRedirects = 10,
    timeoutMs = FETCH_TIMEOUT_MS,
  ): Promise<Response> {
    // One deadline for the whole exchange, including reading the final body.
    const signal = AbortSignal.timeout(timeoutMs);
    let currentUrl = url;
    for (let i = 0; i <= maxRedirects; i++) {
      // Re-validate (and re-resolve) every hop so a redirect cannot reach
      // an internal address.
      const addresses = await resolvePublicAddresses(currentUrl, signal);
      const response = await download.fetch(currentUrl, addresses, signal);
      if (
        response.status >= 300 &&
        response.status < 400 &&
        response.headers.get("location")
      ) {
        await response.body?.cancel();
        currentUrl = new URL(
          response.headers.get("location")!,
          currentUrl,
        ).toString();
        continue;
      }
      if (response.status >= 400) {
        await response.body?.cancel();
        throw new Error(
          `Fetching ${redactUrl(currentUrl)} failed with HTTP ${response.status}` +
            (response.statusText ? ` ${response.statusText}` : ""),
        );
      }
      return response;
    }
    throw new Error("Too many redirects");
  }

  /**
   * Reads the whole response body, refusing more than `maxBytes`: a declared
   * Content-Length over the limit is rejected before reading, and the stream
   * is counted as it arrives. Throws "Response body exceeds the <n>-byte
   * download limit." A response without a body yields an empty buffer.
   */
  private static async readBodyWithLimit(
    response: Response,
    maxBytes = MAX_DOWNLOAD_BYTES,
  ): Promise<Buffer> {
    const tooLarge = new Error(
      `Response body exceeds the ${maxBytes}-byte download limit.`,
    );
    const declaredLength = Number(response.headers.get("content-length"));
    if (declaredLength > maxBytes) {
      throw tooLarge;
    }
    if (!response.body) {
      return Buffer.alloc(0);
    }
    // Stream even when Content-Length is present: it can be absent or wrong,
    // and download.fetch decodes gzip/deflate/br bodies (dropping the header),
    // so the decoded size is what counts.
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        throw tooLarge;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }

  /**
   * Copies the bytes behind an already-validated handle into `stagingDir`,
   * keeping the original extension (markitdown picks its converter from it).
   * Reads go through the handle with explicit offsets, never through a path,
   * so the copy is exactly the file that was opened and checked.
   */
  private static async stageOpenedFile(
    handle: fs.promises.FileHandle,
    originalPath: string,
    stagingDir: string,
    maxBytes = MAX_LOCAL_FILE_BYTES,
  ): Promise<string> {
    const stagedPath = path.join(
      stagingDir,
      `input${path.extname(originalPath)}`,
    );
    const out = await fs.promises.open(stagedPath, "wx", 0o600);
    try {
      // The file may grow after fstat; readOpenedFile enforces the limit on
      // what is actually read.
      for await (const chunk of readOpenedFile(handle, originalPath, maxBytes)) {
        await out.write(chunk);
      }
    } finally {
      await out.close();
    }
    return stagedPath;
  }

  /** Reads an opened Markdown file as UTF-8, refusing more than `maxBytes`. */
  private static async readOpenedText(
    handle: fs.promises.FileHandle,
    displayPath: string,
    maxBytes = MAX_LOCAL_FILE_BYTES,
  ): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of readOpenedFile(handle, displayPath, maxBytes)) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf-8");
  }

  /**
   * Converts a URL or a local file to Markdown with markitdown; `url` wins
   * when both are given.
   *
   * A URL is fetched with safeFetch and readBodyWithLimit and staged as
   * `input.pdf` or `input.html` (see inferExtensionFromUrl). A local file is
   * opened and checked by openLocalFile (allowlist, regular file, size cap)
   * and copied through its handle; the comment in the body explains why.
   * Every failure is rethrown as an Error whose message starts with
   * "Processing to Markdown failed: " (server.ts then adds "Error: ").
   * `projectRoot`, the package root by default, is where a bundled `.venv`
   * markitdown is looked for; `timeoutMs` limits the markitdown run (default
   * converterTimeoutMs()).
   */
  static async toMarkdown({
    filePath,
    url,
    projectRoot = path.resolve(__dirname, ".."),
    timeoutMs = converterTimeoutMs(),
  }: {
    filePath?: string;
    url?: string;
    projectRoot?: string;
    timeoutMs?: number;
  }): Promise<MarkdownResult> {
    try {
      if (url) {
        const response = await this.safeFetch(url);
        const extension = inferExtensionFromUrl(url);

        const content = await this.readBodyWithLimit(response);

        // markitdown picks its converter from the extension, so keep it.
        const text = await this.withStagingDir(async (stagingDir) => {
          const inputPath = path.join(stagingDir, `input.${extension}`);
          await fs.promises.writeFile(inputPath, content);
          return this._markitdown(inputPath, projectRoot, timeoutMs);
        });
        return { text };
      }

      if (filePath) {
        const expanded = expandHome(filePath);

        // markitdown is a separate process that would reopen the path, so
        // whatever the path names by then (a swapped symlink or ancestor, a
        // FIFO, a file that grew past the cap) is what it would read. In both
        // modes, with or without MD_ALLOWED_PATHS, open and check the file
        // here (regular file, size cap, allowlist if set) and hand markitdown
        // a private copy of exactly those bytes, at the cost of copying up
        // to MAX_LOCAL_FILE_BYTES.
        //
        // Passing the open descriptor instead (/proc/self/fd/N, or the fd as
        // markitdown's stdin with an --extension hint) would avoid the copy,
        // but /proc/self/fd/N drops the extension markitdown uses to pick a
        // converter, is Linux-only, and neither form bounds a file that grows
        // after fstat: markitdown reads stdin to the end. One copy path keeps
        // both modes identical and the cap exact on every platform.
        const { handle } = await openLocalFile(expanded);
        try {
          const text = await this.withStagingDir(async (stagingDir) => {
            const stagedPath = await this.stageOpenedFile(
              handle,
              expanded,
              stagingDir,
            );
            return this._markitdown(stagedPath, projectRoot, timeoutMs);
          });
          return { text };
        } finally {
          await handle.close();
        }
      }

      throw new Error("Either filePath or url must be provided");
    } catch (e: unknown) {
      if (e instanceof Error) {
        throw new Error(`Processing to Markdown failed: ${e.message}`);
      } else {
        throw new Error("Processing to Markdown failed: Unknown error occurred");
      }
    }
  }

  /**
   * Packs a remote repository into one Markdown document with
   * `repomix --remote`.
   *
   * Before repomix starts, a non-empty `branch` must pass validateGitRef
   * (repomix hands it to `git fetch` without `--`, so a value such as
   * `--upload-pack=<cmd>` would otherwise run a command), and `repoUrl` must
   * pass validateRepoUrl: host allowlist (MD_GIT_HOSTS) plus a DNS pre-check
   * that the host has only public addresses. repomix and git then do the
   * network access themselves, resolving again and following redirects, so
   * the address check is a pre-check, not the pinning used for URL
   * conversions. An empty `branch` means the default branch.
   *
   * The 100 MB maxBuffer bounds the output kept in memory, and a run longer
   * than `timeoutMs` is killed with SIGKILL together with the git processes
   * it started ("repomix timed out"; see runTool). repomix clones into
   * os.tmpdir(), so it runs with TMPDIR/TEMP/TMP set to a private staging
   * directory (`markdownify_repomix_*`) that is removed when the run
   * settles, killed or not. Errors are not wrapped as in toMarkdown: a
   * missing executable becomes "repomix executable not found", empty output
   * "repomix produced no output", and anything else propagates from runTool.
   */
  static async fromRepo({
    repoUrl,
    branch,
    compress,
    timeoutMs = converterTimeoutMs(),
  }: {
    repoUrl: string;
    branch?: string;
    compress?: boolean;
    timeoutMs?: number;
  }): Promise<MarkdownResult> {
    // Defensive: server.ts already validated the branch in its schema.
    if (branch) validateGitRef(branch);
    await validateRepoUrl(
      repoUrl,
      AbortSignal.timeout(REPO_HOST_CHECK_TIMEOUT_MS),
    );

    const projectRoot = path.resolve(__dirname, "..");
    const repomixPath = resolveRepomixPath(projectRoot);

    const args = [
      "--remote",
      repoUrl,
      "--style",
      "markdown",
      "--stdout",
      "--quiet",
    ];

    if (branch) {
      args.push("--remote-branch", branch);
    }

    if (compress) {
      args.push("--compress");
    }

    let stdout: string;
    let stderr: string;
    try {
      ({ stdout, stderr } = await this.withStagingDir(
        (tempDir) =>
          runTool(repomixPath, args, {
            maxBuffer: 100 * 1024 * 1024, // 100 MB
            timeoutMs,
            // repomix (and git) put the clone under os.tmpdir().
            env: { ...process.env, TMPDIR: tempDir, TEMP: tempDir, TMP: tempDir },
          }),
        "markdownify_repomix_",
      ));
    } catch (e: unknown) {
      const err = e as ToolError;
      if (err?.code === "ENOENT") {
        throw new Error(
          `repomix executable not found (looked up "${repomixPath}"). ` +
            `Set REPOMIX_PATH or install it on PATH (\`bun add -g repomix\`).`,
        );
      }
      if (err?.timedOut === true) {
        throw new Error(
          `repomix timed out after ${timeoutMs} ms and was stopped (MD_CONVERTER_TIMEOUT_MS sets the limit).`,
        );
      }
      throw e;
    }

    if (!stdout) {
      throw new Error(
        `repomix produced no output${stderr ? `: ${stderr}` : ""}`,
      );
    }

    return { text: stdout };
  }

  /**
   * Returns a local Markdown file's contents verbatim (invalid UTF-8 is
   * replaced, not rejected), with `path` set to the path as given. Only
   * `.md` and `.markdown` are accepted, in any letter case ("Required file is
   * not a Markdown file."); a missing file is reported as "File does not
   * exist". The read honours MD_ALLOWED_PATHS and MAX_LOCAL_FILE_BYTES.
   */
  static async get({
    filePath,
  }: {
    filePath: string;
  }): Promise<MarkdownResult> {
    const resolvedPath = path.resolve(expandHome(filePath));
    if (!isMarkdownFile(resolvedPath)) {
      throw new Error("Required file is not a Markdown file.");
    }

    // Read through a handle validated by openLocalFile, so the allowlist
    // decision and the MAX_LOCAL_FILE_BYTES cap apply to the bytes returned
    // (see toMarkdown); a file over the cap is refused before any byte is
    // read. It checks the path before opening, so an outside path is
    // reported as such, not as missing.
    let opened: OpenedLocalFile;
    try {
      opened = await openLocalFile(resolvedPath);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
        throw new Error("File does not exist");
      }
      throw e;
    }

    let text: string;
    try {
      text = await this.readOpenedText(opened.handle, filePath);
    } finally {
      await opened.handle.close();
    }

    return {
      path: filePath,
      text: text,
    };
  }
}
