import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
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
 * How long one validated address may take to accept a TCP connection before
 * the next validated address is tried. A route that silently drops packets
 * (e.g. a black-holed IPv6 path on a dual-stack host) would otherwise stall
 * until the caller's overall deadline. Only attempts that have another
 * address after them get this budget; the last address may use whatever
 * remains of the caller's deadline, so a slow but reachable single-address
 * host behaves as before.
 */
export const CONNECT_TIMEOUT_MS = 5_000;

export type DownloadOptions = {
  /** Per-address connect budget; see CONNECT_TIMEOUT_MS. */
  connectTimeoutMs?: number;
};

/** Progress of one attempt, read by `download.fetch` after a failure. */
type AttemptState = { connected: boolean };

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

/**
 * One request whose DNS lookup is pinned to `selected`. The URL still supplies
 * Host and TLS SNI. With `connectTimeoutMs`, the request is destroyed with an
 * ETIMEDOUT error if its socket has not connected in time.
 */
function requestVia(
  url: string,
  selected: ResolvedAddress,
  signal: AbortSignal,
  connectTimeoutMs: number | undefined,
  state: AttemptState,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    const stopConnectTimer = () => {
      if (connectTimer !== undefined) clearTimeout(connectTimer);
      connectTimer = undefined;
    };
    const onConnect = () => {
      state.connected = true;
      stopConnectTimer();
    };
    const parsed = new URL(url);
    const request = (parsed.protocol === "https:" ? https : http).request(parsed, {
      agent: false,
      signal,
      headers: {
        Accept: "*/*",
        "Accept-Encoding": "identity",
        "User-Agent": USER_AGENT,
      },
      lookup: ((_host: string, options: { all?: boolean }, callback: (...args: any[]) => void) => {
        // Answer asynchronously like dns.lookup does. A synchronous answer lets
        // an immediate connect error (EAFNOSUPPORT) fire on the socket before
        // Node's ClientRequest listens for it, which crashes the process.
        process.nextTick(() => {
          if (options.all) callback(null, [selected]);
          else callback(null, selected.address, selected.family);
        });
      }) as any,
    }, (response) => {
      onConnect();
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
      resolve(new Response(hasBody ? (Readable.toWeb(body) as ReadableStream<Uint8Array>) : null, {
        status,
        statusText: response.statusMessage,
        headers,
      }));
      if (!hasBody) response.resume();
    });
    request.on("error", (error) => {
      stopConnectTimer();
      reject(error);
    });
    request.on("close", stopConnectTimer);
    request.on("socket", (socket) => {
      // An immediate connect error can already have destroyed the socket
      // (connecting is then false too); that attempt never connected.
      if (socket.connecting) socket.once("connect", onConnect);
      else if (!socket.destroyed) onConnect();
    });
    if (connectTimeoutMs !== undefined) {
      connectTimer = setTimeout(() => {
        connectTimer = undefined;
        request.destroy(Object.assign(
          new Error(`Connecting to ${selected.address} timed out after ${connectTimeoutMs} ms`),
          { code: "ETIMEDOUT" },
        ));
      }, connectTimeoutMs);
    }
    request.end();
  });
}

export const download = {
  /**
   * Direct connection with DNS pinned to the validated addresses, tried in
   * order until one accepts the connection. Every address but the last gets
   * `connectTimeoutMs` (default CONNECT_TIMEOUT_MS) to connect; all attempts
   * share `signal`, which stays the single overall deadline. Only failures
   * before the connection is established move on to the next address; once a
   * socket has connected the request is never retried.
   * HTTP(S)_PROXY is deliberately not used: a proxy would resolve the
   * hostname itself and undo the pinning.
   */
  async fetch(
    url: string,
    addresses: ResolvedAddress[],
    signal: AbortSignal,
    { connectTimeoutMs = CONNECT_TIMEOUT_MS }: DownloadOptions = {},
  ): Promise<Response> {
    signal.throwIfAborted();
    if (addresses.length === 0) throw new Error("No validated address");
    let lastError: unknown;
    for (const [index, address] of addresses.entries()) {
      const isLast = index === addresses.length - 1;
      const state: AttemptState = { connected: false };
      try {
        return await requestVia(url, address, signal, isLast ? undefined : connectTimeoutMs, state);
      } catch (error) {
        lastError = error;
        const code = (error as NodeJS.ErrnoException)?.code;
        if (signal.aborted || state.connected || !code || !TRY_NEXT_ADDRESS_ERRORS.has(code)) throw error;
      }
    }
    throw lastError;
  },
};
