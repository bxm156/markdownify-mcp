import path from "path";
import os from "os";
import fs from "fs";
import dns from "node:dns";
import net from "node:net";
import { URL } from "node:url";
import is_ip_private from "private-ip";
import { isValidRemoteValue } from "repomix";

export function expandHome(filepath: string): string {
  if (filepath.startsWith("~/") || filepath === "~") {
    return path.join(os.homedir(), filepath.slice(1));
  }
  return filepath;
}

export function resolveMarkitdownPath(projectRoot: string): string {
  if (process.env.MARKITDOWN_PATH) return process.env.MARKITDOWN_PATH;
  const isWin = process.platform === "win32";
  const venvBin = path.join(
    projectRoot,
    ".venv",
    isWin ? "Scripts" : "bin",
    `markitdown${isWin ? ".exe" : ""}`,
  );
  if (fs.existsSync(venvBin)) return venvBin;
  return "markitdown";
}

export function resolveRepomixPath(projectRoot: string): string {
  if (process.env.REPOMIX_PATH) return process.env.REPOMIX_PATH;
  const local = path.join(projectRoot, "node_modules", ".bin", "repomix");
  if (fs.existsSync(local)) return local;
  return "repomix";
}

export function getAllowedPaths(): string[] | null {
  const raw = process.env.MD_ALLOWED_PATHS ?? process.env.MD_SHARE_DIR;
  if (!raw) return null;
  const dirs = raw
    .split(path.delimiter)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => path.normalize(path.resolve(expandHome(p))));
  return dirs.length > 0 ? dirs : null;
}

/**
 * Resolves symlinks in `target` via the deepest ancestor that exists, then
 * re-joins the not-yet-existing remainder. This lets paths that do not exist
 * yet still be checked against the real location of their parent directory.
 */
function realpathOfDeepestExisting(target: string): string {
  let current = path.resolve(target);
  const remainder: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...remainder);
    } catch (e: unknown) {
      const parent = path.dirname(current);
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT" || parent === current) {
        throw e;
      }
      remainder.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Checks an already-resolved real path against the allowlist. `displayPath`
 * is the path the caller asked for, used only in the error message.
 */
export function assertRealPathAllowed(
  realPath: string,
  displayPath: string,
  allowed: string[] | null = getAllowedPaths(),
): void {
  if (!allowed) return;
  const allowedReal = allowed.map(realpathOfDeepestExisting);
  if (!allowedReal.some((dir) => isWithinDirectory(realPath, dir))) {
    throw new Error(
      `Path "${displayPath}" is outside the allowed directories. ` +
        `Set MD_ALLOWED_PATHS to a ${path.delimiter}-separated list that includes a parent directory ` +
        `(currently allowed: ${allowed.join(path.delimiter)}).`,
    );
  }
}

/**
 * Path-based allowlist check. It only says where `filePath` points *now*; a
 * caller that goes on to read the file must use openLocalFile, which repeats
 * the decision against the file it actually opened.
 */
export function assertPathAllowed(filePath: string): void {
  const allowed = getAllowedPaths();
  if (!allowed) return;
  assertRealPathAllowed(
    realpathOfDeepestExisting(expandHome(filePath)),
    filePath,
    allowed,
  );
}

/**
 * Test-only gates. They let tests change the filesystem at exact points in
 * openLocalFile instead of racing it with sleeps. Production code never sets them.
 */
export const _fileAccessTestHooks: {
  /** After the path-based allowlist check, before the file is opened. */
  afterValidate?: (realPath: string) => void | Promise<void>;
  /** After the opened file has been validated, before any byte is read. */
  afterOpen?: (realPath: string) => void | Promise<void>;
} = {};

// O_NOFOLLOW (POSIX) makes open fail if the final component is a symlink.
// O_NONBLOCK keeps open from hanging on a FIFO with no writer, so fstat can
// reject it; it does not change reads from regular files. Neither exists on
// Windows, where the constants are undefined and contribute nothing.
const OPEN_FLAGS_FOLLOW =
  fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);
const OPEN_FLAGS_NOFOLLOW = OPEN_FLAGS_FOLLOW | (fs.constants.O_NOFOLLOW ?? 0);

export type OpenedLocalFile = {
  handle: fs.promises.FileHandle;
  /** Size in bytes at open time (fstat). */
  size: number;
};

/**
 * Returns the real path of the file behind `handle` and proves it is the same
 * file that was opened.
 *
 * On Linux the kernel reports the opened file's current location through
 * /proc/self/fd. readlink (not realpath) is used deliberately: realpath would
 * walk the returned path through the filesystem again and reintroduce a
 * path-based race. The answer is about the open file itself, so no later
 * rename or symlink swap of the final component or any ancestor can change
 * which bytes the caller reads.
 *
 * Elsewhere (macOS, BSD, Windows), or when /proc is unavailable, the path is
 * resolved again after the open and its device/inode must match the handle's.
 * That rejects any swap that is still in place after the open, but an attacker
 * able to modify directories on the path could in principle swap twice within
 * the gap between those two calls.
 */
export async function resolveOpenedFile(
  handle: fs.promises.FileHandle,
  openedPath: string,
  stats: fs.BigIntStats,
  { useProcFd = process.platform === "linux" }: { useProcFd?: boolean } = {},
): Promise<string> {
  if (useProcFd) {
    try {
      const linked = await fs.promises.readlink(`/proc/self/fd/${handle.fd}`);
      if (path.isAbsolute(linked)) return linked;
    } catch {
      // /proc is not mounted (some sandboxes): fall through.
    }
  }
  const realPath = await fs.promises.realpath(openedPath);
  const current = await fs.promises.stat(realPath, { bigint: true });
  if (current.dev !== stats.dev || current.ino !== stats.ino) {
    throw new Error(
      `Path "${openedPath}" changed while it was being opened; refusing to read it.`,
    );
  }
  return realPath;
}

/**
 * Opens a local regular file for reading.
 *
 * Without an allowlist (MD_ALLOWED_PATHS / MD_SHARE_DIR unset) any readable
 * file is permitted, so this only checks that the opened file is a regular
 * file. With an allowlist the decision is tied to the opened file, not to a
 * path that could be swapped afterwards: the path is resolved and checked,
 * opened with O_NOFOLLOW, and the opened file's own location is checked again
 * (see resolveOpenedFile). The caller must read only through the returned
 * handle and must close it.
 */
export async function openLocalFile(filePath: string): Promise<OpenedLocalFile> {
  const allowed = getAllowedPaths();
  let target = filePath;
  if (allowed) {
    assertPathAllowed(filePath); // early, friendly rejection
    // Resolve legitimate symlinks first, so O_NOFOLLOW only refuses a final
    // component that was swapped for a symlink after this point.
    target = await fs.promises.realpath(filePath);
    assertRealPathAllowed(target, filePath, allowed);
    await _fileAccessTestHooks.afterValidate?.(target);
  }

  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(
      target,
      allowed ? OPEN_FLAGS_NOFOLLOW : OPEN_FLAGS_FOLLOW,
    );
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException)?.code;
    // ELOOP (Linux, macOS) or EMLINK (FreeBSD): the final component became a symlink.
    if (allowed && (code === "ELOOP" || code === "EMLINK")) {
      throw new Error(
        `Path "${filePath}" changed while it was being opened; refusing to read it.`,
      );
    }
    throw e;
  }

  try {
    const stats = await handle.stat({ bigint: true });
    if (!stats.isFile()) {
      throw new Error(`Path "${filePath}" is not a regular file.`);
    }
    if (allowed) {
      const openedReal = await resolveOpenedFile(handle, target, stats);
      assertRealPathAllowed(openedReal, filePath, allowed);
      await _fileAccessTestHooks.afterOpen?.(target);
    }
    return { handle, size: Number(stats.size) };
  } catch (e) {
    await handle.close();
    throw e;
  }
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
]);

/** Expands an IPv6 address into its eight 16-bit groups. */
function ipv6Groups(address: string): number[] {
  let text = address;
  // Rewrite a trailing dotted IPv4 part (::ffff:127.0.0.1) as two hex groups.
  const ipv4Tail = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4Tail) {
    const [a, b, c, d] = ipv4Tail.slice(1).map(Number);
    text =
      text.slice(0, -ipv4Tail[0].length) +
      `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  return [...headGroups, ...new Array(missing).fill("0"), ...tailGroups].map(
    (group) => parseInt(group, 16),
  );
}

/**
 * True for loopback, private, link-local, unique-local, site-local and
 * unspecified addresses, including IPv4 addresses embedded in IPv6.
 */
function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    return is_ip_private(address) === true;
  }
  if (!net.isIPv6(address)) {
    return false;
  }
  const groups = ipv6Groups(address);
  const allZero = (from: number, to: number) =>
    groups.slice(from, to).every((group) => group === 0);
  if (allZero(0, 7) && groups[7] <= 1) {
    return true; // :: (unspecified) and ::1 (loopback)
  }
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups[2] === 1) {
    // 64:ff9b:1::/48 local-use NAT64: RFC 8215 section 5 lets operators use
    // any RFC 6052 section 2.2 prefix length (/32 to /96) inside it, so the
    // embedded IPv4 cannot be located reliably. Reject the whole range.
    return true;
  }
  const embedsIPv4 =
    (allZero(0, 5) && groups[5] === 0xffff) || // ::ffff:0:0/96 IPv4-mapped
    (allZero(0, 4) && groups[4] === 0xffff && groups[5] === 0) || // ::ffff:0:0:0/96 IPv4-translated (SIIT)
    allZero(0, 6) || // ::/96 IPv4-compatible (deprecated)
    (groups[0] === 0x64 && groups[1] === 0xff9b && allZero(2, 6)); // 64:ff9b::/96 well-known NAT64 (always /96)
  if (embedsIPv4) {
    const [high, low] = [groups[6], groups[7]];
    return isPrivateAddress(
      [high >> 8, high & 0xff, low >> 8, low & 0xff].join("."),
    );
  }
  if ((groups[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((groups[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  return is_ip_private(address) === true;
}

/**
 * Describes a URL for error messages as origin + path only, so credentials,
 * query-string tokens and presigned-URL signatures are never echoed.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "<invalid URL>";
  }
}

/**
 * Checks that a URL is safe to fetch from this host: http(s) only, and the
 * hostname must not be (or resolve to) a loopback, private, link-local or
 * cloud-metadata address. Resolution failures are treated as unsafe.
 */
export async function validateUrl(url: string): Promise<void> {
  await resolvePublicAddresses(url);
}

/** Like validateUrl, but returns the vetted addresses so the caller can pin to them. */
export async function resolvePublicAddresses(
  url: string,
  signal?: AbortSignal,
): Promise<{ address: string; family: number }[]> {
  signal?.throwIfAborted();
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http: and https: schemes are allowed.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("URLs with embedded credentials are not allowed.");
  }

  const dangerous = new Error(
    `Fetching ${redactUrl(url)} is potentially dangerous, aborting.`,
  );
  // URL.hostname keeps IPv6 brackets ("[::1]"); a trailing dot is a valid FQDN.
  const hostname = parsed.hostname
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "");

  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost")) {
    throw dangerous;
  }

  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw dangerous;
    return [{ address: hostname, family: net.isIP(hostname) }];
  }

  let addresses: { address: string; family: number }[];
  try {
    addresses = await withAbort(dns.promises.lookup(hostname, { all: true, verbatim: true }), signal);
  } catch {
    signal?.throwIfAborted();
    throw dangerous;
  }
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => isPrivateAddress(address))
  ) {
    throw dangerous;
  }
  return addresses;
}

/** DNS lookup cannot be cancelled, but callers must stop waiting at their deadline. */
function withAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

export function validateRepoUrl(repoUrl: string): void {
  if (!repoUrl || !repoUrl.trim()) {
    throw new Error("Repository URL is required");
  }
  if (!isValidRemoteValue(repoUrl)) {
    throw new Error(
      `Invalid repository URL or shorthand: ${repoUrl}. Use a GitHub URL (https://github.com/owner/repo) or shorthand (owner/repo).`,
    );
  }
  // Block non-http(s) explicit URLs (e.g. file://, ssh:// for SSRF prevention)
  if (repoUrl.includes("://")) {
    const parsed = new URL(repoUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Only http: and https: repository URLs are allowed.");
    }
  }
}

export function isUnconvertedHtml(output: string): boolean {
  const trimmed = output.trimStart();
  return trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html");
}

export function inferExtensionFromUrl(url: string): string {
  if (url.endsWith(".pdf")) {
    return "pdf";
  }
  return "html";
}

export function isMarkdownFile(filePath: string): boolean {
  const markdownExt = [".md", ".markdown"];
  return markdownExt.includes(path.extname(filePath));
}

export function isWithinDirectory(filePath: string, directory: string): boolean {
  // path.relative is case-insensitive on win32 and returns an absolute path
  // when the two are on different drives.
  const relative = path.relative(path.resolve(directory), path.resolve(filePath));
  if (relative === "") return true;
  if (path.isAbsolute(relative)) return false;
  return relative !== ".." && !relative.startsWith(".." + path.sep);
}
