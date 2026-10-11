import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";
import tls from "node:tls";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

export type ResolvedAddress = { address: string; family: number };

function readPackageVersion(): string {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
    );
    return typeof packageJson.version === "string" ? packageJson.version : "unknown";
  } catch {
    return "unknown";
  }
}

/** Sent on every download; some servers (e.g. api.github.com) reject requests without one. */
export const USER_AGENT = `markdownify-mcp/${readPackageVersion()}`;

/** Connection failures after which the next validated address is tried. */
const TRY_NEXT_ADDRESS_ERRORS = new Set([
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "EADDRNOTAVAIL",
  "EAFNOSUPPORT", // e.g. an IPv6 address on a host without IPv6
  "EINVAL", // Node: the address does not match the socket family it was given
]);

const NO_BODY_STATUSES = [204, 205, 304];

/**
 * How long one validated address may take to become usable (TCP connect,
 * plus the TLS handshake for https:) before it counts as failed and the next
 * address is started immediately. A route that silently drops packets (e.g.
 * a black-holed IPv6 path on a dual-stack host), or a server that accepts TCP
 * but never completes TLS, would otherwise stall until the caller's overall
 * deadline. Only attempts that have another address after them get this
 * budget; the last address may use whatever remains of the caller's
 * deadline, so a slow but reachable single-address host behaves as before.
 */
export const CONNECT_TIMEOUT_MS = 5_000;

/**
 * RFC 8305 "Connection Attempt Delay": how long an attempt runs on its own
 * before the next address is started alongside it. The first attempt to
 * become usable wins; the others are destroyed.
 */
export const ATTEMPT_DELAY_MS = 250;

export type DownloadOptions = {
  /** Per-address budget; see CONNECT_TIMEOUT_MS. */
  connectTimeoutMs?: number;
  /** Stagger between parallel attempts; see ATTEMPT_DELAY_MS. */
  attemptDelayMs?: number;
};

/** How one address attempt ended, as listed in ConnectFailedError. */
export type AttemptFailure = { address: string; family: number; code: string };

/**
 * Raised when no validated address became usable: every attempt failed, or
 * the caller's deadline passed first. Lists each address tried with its
 * failure code; the URL is redacted to origin + path.
 */
export class ConnectFailedError extends Error {
  readonly code = "ERR_ALL_ADDRESSES_FAILED";
  /** Every address attempted, in order, with how it failed. */
  readonly attempts: AttemptFailure[];
  /** Validated addresses never attempted because the deadline came first. */
  readonly untried: number;
  constructor(url: string, attempts: AttemptFailure[], untried: number, options?: { cause?: unknown }) {
    const tried = attempts.map(({ address, code }) => `${address} (${code})`).join(", ");
    super(
      `Could not connect to ${redactUrl(url)}: tried ${tried}` +
        (untried > 0 ? `; ${untried} more address${untried === 1 ? "" : "es"} not tried` : ""),
      options,
    );
    this.name = "ConnectFailedError";
    this.attempts = attempts;
    this.untried = untried;
  }
}

/**
 * Origin + path only, so credentials, query-string tokens and presigned-URL
 * signatures are never echoed. Mirrors utils.redactUrl; this module imports
 * nothing local so tests can load it directly under Node.
 */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "<invalid URL>";
  }
}

/**
 * Orders addresses so the two families alternate (RFC 8305 section 4),
 * starting with the family of the first address and keeping the resolver's
 * order within each family.
 */
export function interleaveFamilies(addresses: ResolvedAddress[]): ResolvedAddress[] {
  const first = addresses[0]?.family;
  const primary = addresses.filter((entry) => entry.family === first);
  const secondary = addresses.filter((entry) => entry.family !== first);
  const ordered: ResolvedAddress[] = [];
  for (let i = 0; i < Math.max(primary.length, secondary.length); i++) {
    if (i < primary.length) ordered.push(primary[i]);
    if (i < secondary.length) ordered.push(secondary[i]);
  }
  return ordered;
}

function createDecoder(contentEncoding: string | null) {
  const encoding = (contentEncoding ?? "").trim().toLowerCase();
  if (encoding === "" || encoding === "identity") return undefined;
  if (encoding.includes(",")) {
    throw new Error(
      `Unsupported Content-Encoding "${contentEncoding}": multiple encodings are not supported.`,
    );
  }
  switch (encoding) {
    case "gzip":
    case "x-gzip":
      return createGunzip();
    case "br":
      return createBrotliDecompress();
    case "deflate":
      return createInflate();
    default:
      throw new Error(`Unsupported Content-Encoding "${contentEncoding}".`);
  }
}

type Target = { secure: boolean; hostname: string; port: number };

function targetOf(url: string): Target {
  const parsed = new URL(url);
  const secure = parsed.protocol === "https:";
  return {
    secure,
    // URL.hostname keeps IPv6 brackets ("[::1]"); sockets and SNI want them stripped.
    hostname: parsed.hostname.replace(/^\[(.*)\]$/, "$1"),
    port: Number(parsed.port) || (secure ? 443 : 80),
  };
}

/** Keeps late 'error' events on a discarded socket from becoming uncaught exceptions. */
const ignoreError = () => {};

/**
 * Opens a socket to `target` whose DNS lookup is pinned to `selected`, so no
 * second resolution can happen. For https: the hostname still supplies SNI
 * and the certificate identity check, exactly as https.request would.
 */
function openSocket(target: Target, selected: ResolvedAddress): net.Socket {
  const lookup = ((_host: string, options: { all?: boolean }, callback: (...args: any[]) => void) => {
    // Answer asynchronously like dns.lookup does. A synchronous answer lets
    // an immediate connect error (EAFNOSUPPORT) fire on the socket before
    // its error listener is attached, which crashes the process.
    process.nextTick(() => {
      if (options.all) callback(null, [selected]);
      else callback(null, selected.address, selected.family);
    });
  }) as any;
  // autoSelectFamily off: this module does the address racing itself.
  const options = { host: target.hostname, port: target.port, lookup, autoSelectFamily: false };
  if (!target.secure) return net.connect(options);
  return tls.connect({
    ...options,
    // As https.request does: no SNI for an IP literal (RFC 6066).
    ...(net.isIP(target.hostname) ? {} : { servername: target.hostname }),
  });
}

type Attempt = {
  selected: ResolvedAddress;
  socket: net.Socket;
  budget?: ReturnType<typeof setTimeout>;
  failure?: string;
  released?: boolean;
  onReady: () => void;
  onError: (error: Error) => void;
};

/**
 * Races the validated addresses RFC 8305-style and calls `onWinner`
 * synchronously with the first socket that becomes usable ('connect', or
 * 'secureConnect' for https:). Attempts start `attemptDelayMs` apart, or
 * immediately when the previous one fails. Every other attempt is destroyed
 * and its timer and listeners removed before `onWinner` runs, so exactly one
 * socket ever carries a request. No attempt starts once a winner is chosen,
 * the race has failed, or `signal` has aborted.
 */
function connectFirst(
  url: string,
  target: Target,
  addresses: ResolvedAddress[],
  signal: AbortSignal,
  connectTimeoutMs: number,
  attemptDelayMs: number,
  onWinner: (socket: net.Socket) => void,
  onFailure: (error: unknown) => void,
): void {
  const readyEvent = target.secure ? "secureConnect" : "connect";
  const attempts: Attempt[] = [];
  let staggerTimer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;

  const release = (attempt: Attempt, destroy: boolean) => {
    if (attempt.released) return;
    attempt.released = true;
    if (attempt.budget !== undefined) clearTimeout(attempt.budget);
    attempt.budget = undefined;
    attempt.socket.off(readyEvent, attempt.onReady);
    attempt.socket.off("error", attempt.onError);
    if (destroy) {
      attempt.socket.on("error", ignoreError);
      attempt.socket.destroy();
    }
  };

  /** Ends the race; every attempt except `winner` is destroyed. */
  const settle = (winner?: Attempt) => {
    settled = true;
    if (staggerTimer !== undefined) clearTimeout(staggerTimer);
    staggerTimer = undefined;
    signal.removeEventListener("abort", onAbort);
    for (const attempt of attempts) release(attempt, attempt !== winner);
  };

  const combinedError = (pendingCode: string, cause?: unknown) =>
    new ConnectFailedError(
      url,
      attempts.map(({ selected, failure }) => ({
        address: selected.address,
        family: selected.family,
        code: failure ?? pendingCode,
      })),
      addresses.length - attempts.length,
      cause === undefined ? undefined : { cause },
    );

  function onAbort() {
    if (settled) return;
    const reason = signal.reason;
    // The deadline passing is one more way for every address to fail; a
    // caller's cancellation is not a connection failure and stays as is.
    const error = (reason as Error)?.name === "TimeoutError" && attempts.length > 0
      ? combinedError((reason as Error).name, reason)
      : reason;
    settle();
    onFailure(error);
  }

  const startNext = () => {
    if (staggerTimer !== undefined) clearTimeout(staggerTimer);
    staggerTimer = undefined;
    if (settled || signal.aborted || attempts.length >= addresses.length) return;
    const index = attempts.length;
    const isLast = index === addresses.length - 1;
    const selected = addresses[index];
    let socket: net.Socket;
    try {
      socket = openSocket(target, selected);
    } catch (error) {
      settle();
      onFailure(error);
      return;
    }
    const attempt: Attempt = {
      selected,
      socket,
      onReady: () => {
        if (settled) return;
        settle(attempt);
        onWinner(socket);
      },
      onError: (error: Error) => {
        if (settled) return;
        const code = (error as NodeJS.ErrnoException)?.code;
        attempt.failure = code ?? error?.name ?? "Error";
        release(attempt, true);
        if (!code || !TRY_NEXT_ADDRESS_ERRORS.has(code)) {
          // Not a reachability problem (e.g. a certificate error): stop.
          settle();
          onFailure(error);
        } else if (attempts.length < addresses.length) {
          startNext();
        } else if (attempts.every((entry) => entry.failure !== undefined)) {
          settle();
          onFailure(combinedError("unknown"));
        }
      },
    };
    attempts.push(attempt);
    socket.once(readyEvent, attempt.onReady);
    socket.on("error", attempt.onError);
    if (!isLast) {
      attempt.budget = setTimeout(() => {
        attempt.budget = undefined;
        attempt.onError(Object.assign(
          new Error(`Connecting to ${selected.address} timed out after ${connectTimeoutMs} ms`),
          { code: "ETIMEDOUT" },
        ));
      }, connectTimeoutMs);
      staggerTimer = setTimeout(startNext, attemptDelayMs);
    }
  };

  signal.addEventListener("abort", onAbort, { once: true });
  startNext();
}

/**
 * Sends the request over an already connected socket. The URL still supplies
 * Host. The request is created synchronously, so the caller's socket is never
 * left without an owner.
 */
function requestOver(url: string, socket: net.Socket, signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    // No `agent`: with agent: false Node would ignore createConnection and dial
    // (and resolve) on its own.
    const request = (parsed.protocol === "https:" ? https : http).request(parsed, {
      createConnection: () => socket,
      signal,
      headers: {
        // The socket is never reused; state it rather than rely on each
        // runtime's no-agent default.
        Connection: "close",
        Accept: "*/*",
        "Accept-Encoding": "identity",
        "User-Agent": USER_AGENT,
      },
    }, (response) => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(response.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      let decoder: ReturnType<typeof createDecoder>;
      try {
        decoder = createDecoder(headers.get("content-encoding"));
      } catch (error) {
        response.destroy();
        reject(error);
        return;
      }
      let body: Readable = response;
      if (decoder) {
        const activeDecoder = decoder;
        response.on("error", (error) => activeDecoder.destroy(error));
        activeDecoder.on("close", () => response.destroy());
        body = response.pipe(activeDecoder);
        headers.delete("content-encoding");
        headers.delete("content-length");
      }
      const status = response.statusCode ?? 500;
      const hasBody = !NO_BODY_STATUSES.includes(status);
      resolve(new Response(hasBody ? (Readable.toWeb(body) as unknown as ReadableStream<Uint8Array>) : null, {
        status,
        statusText: response.statusMessage,
        headers,
      }));
      if (!hasBody) response.resume();
    });
    // Until the request attaches its own socket listeners (it announces that
    // with 'socket'), forward socket errors so none goes unhandled.
    const forwardError = (error: Error) => request.destroy(error);
    socket.on("error", forwardError);
    request.once("socket", () => socket.off("error", forwardError));
    request.on("close", () => socket.off("error", forwardError));
    request.on("error", reject);
    request.end();
  });
}

export const download = {
  /**
   * Direct connection with DNS pinned to the validated addresses, raced
   * RFC 8305-style: families are interleaved, attempts start
   * `attemptDelayMs` (default ATTEMPT_DELAY_MS) apart, and the first socket
   * to connect (and finish TLS, for https:) carries the request while the
   * others are destroyed. Every attempt but the last gets `connectTimeoutMs`
   * (default CONNECT_TIMEOUT_MS). All attempts share `signal`, which stays
   * the single overall deadline. Once a socket has won, the request is never
   * retried. When no address becomes usable the promise rejects with a
   * ConnectFailedError listing every address tried, including when the
   * deadline (an AbortSignal.timeout) passes first; any other abort rejects
   * with the signal's reason, and a non-network failure (e.g. a TLS
   * certificate error) rejects with that error.
   * HTTP(S)_PROXY is deliberately not used: a proxy would resolve the
   * hostname itself and undo the pinning.
   */
  async fetch(
    url: string,
    addresses: ResolvedAddress[],
    signal: AbortSignal,
    { connectTimeoutMs = CONNECT_TIMEOUT_MS, attemptDelayMs = ATTEMPT_DELAY_MS }: DownloadOptions = {},
  ): Promise<Response> {
    signal.throwIfAborted();
    if (addresses.length === 0) throw new Error("No validated address");
    const target = targetOf(url);
    return new Promise((resolve, reject) => {
      connectFirst(
        url,
        target,
        interleaveFamilies(addresses),
        signal,
        connectTimeoutMs,
        attemptDelayMs,
        (socket) => resolve(requestOver(url, socket, signal)),
        reject,
      );
    });
  },
};
