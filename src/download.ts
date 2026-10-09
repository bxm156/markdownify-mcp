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
]);

const NO_BODY_STATUSES = [204, 205, 304];

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

/** One request whose DNS lookup is pinned to `selected`. The URL still supplies Host and TLS SNI. */
function requestVia(
  url: string,
  selected: ResolvedAddress,
  signal: AbortSignal,
): Promise<Response> {
  return new Promise((resolve, reject) => {
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
    request.on("error", reject);
    request.end();
  });
}

export const download = {
  /**
   * Direct connection with DNS pinned to the validated addresses, tried in
   * order until one accepts the connection. All attempts share `signal`.
   * HTTP(S)_PROXY is deliberately not used: a proxy would resolve the
   * hostname itself and undo the pinning.
   */
  async fetch(url: string, addresses: ResolvedAddress[], signal: AbortSignal): Promise<Response> {
    signal.throwIfAborted();
    if (addresses.length === 0) throw new Error("No validated address");
    let lastError: unknown;
    for (const address of addresses) {
      try {
        return await requestVia(url, address, signal);
      } catch (error) {
        lastError = error;
        const code = (error as NodeJS.ErrnoException)?.code;
        if (signal.aborted || !code || !TRY_NEXT_ADDRESS_ERRORS.has(code)) throw error;
      }
    }
    throw lastError;
  },
};
