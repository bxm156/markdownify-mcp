import { expect, spyOn, test } from "bun:test";
import http, { createServer, type IncomingHttpHeaders, type RequestListener } from "node:http";
import { EventEmitter } from "node:events";
import { gzipSync } from "node:zlib";
import { download, USER_AGENT } from "./download";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import packageJson from "../package.json";

/** Runs `body` against a throwaway HTTP server on 127.0.0.1 and always closes it. */
async function withServer(
  handler: RequestListener,
  body: (port: number) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await body((server.address() as any).port);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const loopback = [{ address: "127.0.0.1", family: 4 }];

/** Emit a controlled error after requestVia attaches its listener. */
function refusedRequest(error: NodeJS.ErrnoException): http.ClientRequest {
  const request = new EventEmitter() as EventEmitter & { end: () => void };
  request.end = () => { process.nextTick(() => request.emit("error", error)); };
  return request as unknown as http.ClientRequest;
}

test("pinned connection uses the selected address and preserves the original Host", async () => {
  let host: string | undefined;
  const server = createServer((request, response) => {
    host = request.headers.host;
    response.writeHead(200, { "Content-Encoding": "gzip" });
    response.end(gzipSync("pinned body"));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as any).port;
    // This hostname cannot resolve; the transport must use only the supplied address.
    const result = await download.fetch(`http://rebind.invalid:${port}/`, [{ address: "127.0.0.1", family: 4 }], AbortSignal.timeout(1000));
    expect(await result.text()).toBe("pinned body");
    expect(host).toBe(`rebind.invalid:${port}`);
    expect(result.headers.has("content-encoding")).toBe(false);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("the exchange deadline also terminates a stalled response body", async () => {
  // Run under Node (the server supports both Node and Bun); Bun 1.4.2 on Windows crashes in its HTTP abort bridge.
  const script = `
    import assert from 'node:assert/strict';
    import {createServer} from 'node:http';
    import {download} from ${JSON.stringify(new URL("./download.ts", import.meta.url).href)};
    const server = createServer((req, res) => {res.writeHead(200); res.write('partial');});
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    try {
      const response = await download.fetch('http://rebind.invalid:' + server.address().port, [{address:'127.0.0.1',family:4}], AbortSignal.timeout(100));
      await assert.rejects(response.text());
    } finally {server.closeAllConnections(); await new Promise(r => server.close(r));}
  `;
  await promisify(execFile)("node", ["--experimental-strip-types", "--input-type=module", "-e", script], { timeout: 5000 });
});

test("sends a User-Agent and Accept header", async () => {
  let headers: IncomingHttpHeaders = {};
  await withServer(
    (request, response) => {
      headers = request.headers;
      response.end("ok");
    },
    async (port) => {
      const response = await download.fetch(`http://ua.invalid:${port}/`, loopback, AbortSignal.timeout(1000));
      expect(await response.text()).toBe("ok");
    },
  );
  expect(USER_AGENT).toBe(`markdownify-mcp/${packageJson.version}`);
  expect(headers["user-agent"]).toBe(USER_AGENT);
  expect(headers["accept"]).toBe("*/*");
  expect(headers["accept-encoding"]).toBe("identity");
});

test("falls through to the next validated address when a connection is refused", async () => {
  let requests = 0;
  await withServer(
    (_request, response) => {
      requests++;
      response.end("second address");
    },
    async (port) => {
      // An unused loopback address can stall instead of refusing on Windows.
      // Inject only the first error; the second attempt uses the real transport.
      const realRequest = http.request.bind(http);
      const refusal = Object.assign(new Error("controlled refusal"), { code: "ECONNREFUSED" });
      const requestSpy = spyOn(http, "request")
        .mockImplementationOnce(() => refusedRequest(refusal))
        .mockImplementation(realRequest);
      try {
        const response = await download.fetch(
          `http://dual.invalid:${port}/`,
          [{ address: "192.0.2.1", family: 4 }, ...loopback],
          AbortSignal.timeout(2000),
        );
        expect(await response.text()).toBe("second address");
        expect(requestSpy).toHaveBeenCalledTimes(2);
      } finally {
        requestSpy.mockRestore();
      }
    },
  );
  expect(requests).toBe(1);
});

test("reports the last connection error when every address is refused", async () => {
  const first = Object.assign(new Error("first refusal"), { code: "ECONNREFUSED" });
  const last = Object.assign(new Error("last refusal"), { code: "ECONNREFUSED" });
  const requestSpy = spyOn(http, "request")
    .mockImplementationOnce(() => refusedRequest(first))
    .mockImplementationOnce(() => refusedRequest(last));
  try {
    await expect(
      download.fetch(
        "http://down.invalid/",
        [{ address: "192.0.2.1", family: 4 }, { address: "192.0.2.2", family: 4 }],
        AbortSignal.timeout(2000),
      ),
    ).rejects.toBe(last);
    expect(requestSpy).toHaveBeenCalledTimes(2);
  } finally {
    requestSpy.mockRestore();
  }
});

test.each(["x-gzip", "GZIP"])("decodes Content-Encoding %p", async (encoding) => {
  await withServer(
    (_request, response) => {
      response.writeHead(200, { "Content-Encoding": encoding });
      response.end(gzipSync("decoded"));
    },
    async (port) => {
      const response = await download.fetch(`http://enc.invalid:${port}/`, loopback, AbortSignal.timeout(1000));
      expect(await response.text()).toBe("decoded");
    },
  );
});

test.each([
  ["gzip, br", "multiple encodings are not supported"],
  ["zstd", 'Unsupported Content-Encoding "zstd"'],
])("rejects Content-Encoding %p instead of passing compressed bytes on", async (encoding, message) => {
  await withServer(
    (_request, response) => {
      response.writeHead(200, { "Content-Encoding": encoding });
      response.end("still compressed");
    },
    async (port) => {
      await expect(
        download.fetch(`http://enc.invalid:${port}/`, loopback, AbortSignal.timeout(1000)),
      ).rejects.toThrow(message);
    },
  );
});
