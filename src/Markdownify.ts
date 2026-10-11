import { execFile } from "child_process";
import { promisify } from "util";
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
const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FETCH_TIMEOUT_MS = 30_000;
// URL downloads and local files share one input budget (50 MiB).
const MAX_DOWNLOAD_BYTES = MAX_LOCAL_FILE_BYTES;

export type MarkdownResult = {
  path?: string;
  text: string;
};

export class Markdownify {
  private static async _markitdown(
    filePath: string,
    projectRoot: string,
  ): Promise<string> {
    const markitdownPath = resolveMarkitdownPath(projectRoot);

    let stdout: string;
    try {
      // execFile resolves bare command names against PATH (POSIX execvp / Windows search).
      // Non-zero exit codes reject; stderr alone does not (markitdown emits non-fatal
      // warnings from onnxruntime/pydub/etc. on a successful run).
      ({ stdout } = await execFileAsync(markitdownPath, [filePath], {
        maxBuffer: 50 * 1024 * 1024, // 50 MB
      }));
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err?.code === "ENOENT") {
        throw new Error(
          `markitdown executable not found (looked up "${markitdownPath}"). ` +
            `Set MARKITDOWN_PATH to its absolute location, install it on PATH (e.g. \`pipx install "markitdown[pdf]"\`), ` +
            `or run setup in the project root (${projectRoot}): ` +
            `python3 -m venv .venv && .venv/bin/pip install "markitdown[pdf]>=0.1.5".`,
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
  ): Promise<T> {
    const stagingDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "markdown_output_"),
    );
    try {
      return await fn(stagingDir);
    } finally {
      await fs.promises.rm(stagingDir, { recursive: true, force: true });
    }
  }

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
    // and fetch transparently decompresses gzip/br bodies.
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

  static async toMarkdown({
    filePath,
    url,
    projectRoot = path.resolve(__dirname, ".."),
  }: {
    filePath?: string;
    url?: string;
    projectRoot?: string;
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
          return this._markitdown(inputPath, projectRoot);
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
            return this._markitdown(stagedPath, projectRoot);
          });
          return { text };
        } finally {
          await handle.close();
        }
      }

      throw new Error("Either filePath or url must be provided");
    } catch (e: unknown) {
      if (e instanceof Error) {
        throw new Error(`Error processing to Markdown: ${e.message}`);
      } else {
        throw new Error("Error processing to Markdown: Unknown error occurred");
      }
    }
  }

  static async fromRepo({
    repoUrl,
    branch,
    compress,
  }: {
    repoUrl: string;
    branch?: string;
    compress?: boolean;
  }): Promise<MarkdownResult> {
    validateRepoUrl(repoUrl);

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
      ({ stdout, stderr } = await execFileAsync(repomixPath, args, {
        maxBuffer: 100 * 1024 * 1024, // 100 MB
      }));
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err?.code === "ENOENT") {
        throw new Error(
          `repomix executable not found (looked up "${repomixPath}"). ` +
            `Set REPOMIX_PATH or install it on PATH (\`bun add -g repomix\`).`,
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
