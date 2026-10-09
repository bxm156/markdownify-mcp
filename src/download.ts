import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

/** Direct connection with DNS pinned to the validated address. The URL retains Host and TLS SNI. */
export const download = {
  fetch(url: string, addresses: { address: string; family: number }[], signal: AbortSignal): Promise<Response> {
    signal.throwIfAborted();
    const selected = addresses[0];
    if (!selected) return Promise.reject(new Error("No validated address"));
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const request = (parsed.protocol === "https:" ? https : http).request(parsed, {
        agent: false, signal, headers: { "Accept-Encoding": "identity" },
        lookup: ((_host: string, options: { all?: boolean }, callback: (...args: any[]) => void) => {
          if (options.all) callback(null, [selected]);
          else callback(null, selected.address, selected.family);
        }) as any,
      }, response => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
        }
        let body: Readable = response;
        const encoding = headers.get("content-encoding");
        const decoder = encoding === "gzip" ? createGunzip() : encoding === "br" ? createBrotliDecompress() : encoding === "deflate" ? createInflate() : undefined;
        if (decoder) {
          response.on("error", error => decoder.destroy(error));
          decoder.on("close", () => response.destroy());
          body = response.pipe(decoder);
          headers.delete("content-encoding"); headers.delete("content-length");
        }
        const status = response.statusCode ?? 500;
        resolve(new Response([204, 205, 304].includes(status) ? null : Readable.toWeb(body) as ReadableStream<Uint8Array>, {
          status, statusText: response.statusMessage, headers,
        }));
        if ([204, 205, 304].includes(status)) response.resume();
      });
      request.on("error", reject);
      request.end();
    });
  },
};
