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

test("an immediate connect error from the pinned lookup falls through instead of crashing Node", async () => {
  // Runs under Node, where a synchronous lookup answer emitted this error
  // before ClientRequest listened for it and crashed the process. The
  // family-6 entry for an IPv4 address fails deterministically (EINVAL)
  // without needing IPv6 on the host. Bun ignores the family, so it cannot
  // show the crash.
  const script = `
    import assert from 'node:assert/strict';
    import http from 'node:http';
    import {download} from ${JSON.stringify(new URL("./download.ts", import.meta.url).href)};
    const realRequest = http.request;
    let attempts = 0;
    http.request = (...args) => { attempts++; return realRequest(...args); };
    const server = http.createServer((req, res) => res.end('fallback'));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    try {
      const response = await download.fetch('http://mismatch.invalid:' + server.address().port,
        [{address: '127.0.0.1', family: 6}, {address: '127.0.0.1', family: 4}], AbortSignal.timeout(2000));
      assert.equal(await response.text(), 'fallback');
      assert.equal(attempts, 2);
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

/**
 * Wraps the real http.request so that connections to `stalled` addresses never
 * complete: the pinned lookup simply never answers, leaving the socket in its
 * connecting state exactly like a route that drops SYN packets, without
 * depending on how any real IP behaves. Other addresses connect normally.
 * `onStall` runs when an attempt to a stalled address has started.
 */
function stallConnectsTo(stalled: string[], onStall: () => void = () => {}) {
  const realRequest = http.request.bind(http);
  const attempts: string[] = [];
  const requests: http.ClientRequest[] = [];
  const spy = spyOn(http, "request").mockImplementation(((url: any, options: any, callback: any) => {
    const lookup = options.lookup;
    const request = realRequest(url, {
      ...options,
      lookup: (host: string, lookupOptions: any, answer: (...args: any[]) => void) => {
        lookup(host, lookupOptions, (...args: any[]) => {
          const address = Array.isArray(args[1]) ? args[1][0].address : args[1];
          attempts.push(address);
          if (stalled.includes(address)) onStall();
          else answer(...args);
        });
      },
    }, callback);
    requests.push(request);
    return request;
  }) as any);
  return { attempts, requests, restore: () => spy.mockRestore() };
}

test("a stalled connect falls through to the next validated address within the connect budget", async () => {
  let host: string | undefined;
  await withServer(
    (request, response) => {
      host = request.headers.host;
      response.end("reachable address");
    },
    async (port) => {
      const stall = stallConnectsTo(["2001:db8::1"]);
      try {
        const response = await download.fetch(
          `http://dual.invalid:${port}/`,
          [{ address: "2001:db8::1", family: 6 }, ...loopback],
          // Far beyond the connect budget: success proves the budget, not the deadline, moved on.
          AbortSignal.timeout(10_000),
          { connectTimeoutMs: 20 },
        );
        expect(await response.text()).toBe("reachable address");
        expect(stall.attempts).toEqual(["2001:db8::1", "127.0.0.1"]);
        expect(stall.requests[0].destroyed).toBe(true);
      } finally {
        stall.restore();
      }
    },
  );
  expect(host).toMatch(/^dual\.invalid:\d+$/);
});

test("the last validated address has no connect budget and stalls until the overall deadline", async () => {
  const stall = stallConnectsTo(["192.0.2.1", "192.0.2.2"]);
  const signal = AbortSignal.timeout(300);
  try {
    const error = await download.fetch(
      "http://blackhole.invalid/",
      [{ address: "192.0.2.1", family: 4 }, { address: "192.0.2.2", family: 4 }],
      signal,
      { connectTimeoutMs: 20 },
    ).then(() => undefined, (error) => error);
    // Ended by the caller's deadline, not by a second connect timeout.
    expect(signal.aborted).toBe(true);
    expect(["AbortError", "TimeoutError"]).toContain(error?.name);
    expect(error?.code).not.toBe("ETIMEDOUT");
    expect(stall.attempts).toEqual(["192.0.2.1", "192.0.2.2"]);
    expect(stall.requests.every((request) => request.destroyed)).toBe(true);
  } finally {
    stall.restore();
  }
});

test("the overall abort during a stalled connect rejects promptly and clears the connect timer", async () => {
  const controller = new AbortController();
  const stall = stallConnectsTo(["192.0.2.1"], () => controller.abort());
  const realSetTimeout = globalThis.setTimeout;
  const connectTimers: unknown[] = [];
  const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
    handler: (...args: any[]) => void, delay?: number, ...args: any[]
  ) => {
    const timer = realSetTimeout(handler, delay, ...args);
    if (delay === 60_000) connectTimers.push(timer);
    return timer;
  }) as any);
  const clearTimeoutSpy = spyOn(globalThis, "clearTimeout");
  try {
    await expect(download.fetch(
      "http://blackhole.invalid/",
      [{ address: "192.0.2.1", family: 4 }, ...loopback],
      controller.signal,
      { connectTimeoutMs: 60_000 },
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(stall.attempts).toEqual(["192.0.2.1"]);
    expect(connectTimers).toHaveLength(1);
    expect(clearTimeoutSpy).toHaveBeenCalledWith(connectTimers[0] as any);
  } finally {
    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
    stall.restore();
  }
});

test("a listed error after the connection is established is not retried on another address", async () => {
  const late = Object.assign(new Error("timed out after connecting"), { code: "ETIMEDOUT" });
  await withServer(
    () => { /* never respond */ },
    async (port) => {
      const realRequest = http.request.bind(http);
      const requestSpy = spyOn(http, "request").mockImplementation(((...args: any[]) => {
        const request = (realRequest as any)(...args) as http.ClientRequest;
        request.once("socket", (socket) => socket.once("connect", () => request.destroy(late)));
        return request;
      }) as any);
      try {
        await expect(download.fetch(
          `http://late.invalid:${port}/`,
          [...loopback, ...loopback],
          AbortSignal.timeout(2000),
          { connectTimeoutMs: 1000 },
        )).rejects.toBe(late);
        expect(requestSpy).toHaveBeenCalledTimes(1);
      } finally {
        requestSpy.mockRestore();
      }
    },
  );
});

test("under Node, a stalled connect falls through and every timer is released", async () => {
  const script = `
    import assert from 'node:assert/strict';
    import http from 'node:http';
    import {download} from ${JSON.stringify(new URL("./download.ts", import.meta.url).href)};
    const realRequest = http.request;
    let onStall = () => {};
    const attempts = [];
    // Connections to 192.0.2.x never complete: the pinned lookup never answers.
    http.request = (url, options, callback) => realRequest(url, {...options, lookup: (host, o, answer) =>
      options.lookup(host, o, (...args) => {
        const address = Array.isArray(args[1]) ? args[1][0].address : args[1];
        attempts.push(address);
        if (address.startsWith('192.0.2.')) onStall(); else answer(...args);
      })}, callback);
    const timers = () => process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;
    const server = http.createServer((req, res) => res.end('host=' + req.headers.host));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
      // First address stalls, second succeeds with the original Host.
      const controller = new AbortController();
      const response = await download.fetch('http://dual.invalid:' + port + '/',
        [{address: '192.0.2.1', family: 4}, {address: '127.0.0.1', family: 4}], controller.signal, {connectTimeoutMs: 20});
      assert.equal(await response.text(), 'host=dual.invalid:' + port);
      assert.deepEqual(attempts.splice(0), ['192.0.2.1', '127.0.0.1']);

      // Every address stalls; the overall abort ends the last attempt.
      const all = new AbortController();
      onStall = () => { if (attempts.length === 2) all.abort(); };
      await assert.rejects(download.fetch('http://blackhole.invalid/',
        [{address: '192.0.2.1', family: 4}, {address: '192.0.2.2', family: 4}], all.signal, {connectTimeoutMs: 20}),
        {name: 'AbortError'});
      assert.deepEqual(attempts.splice(0), ['192.0.2.1', '192.0.2.2']);

      // Abort during a stall with a long connect budget: no fall-through, no timer left behind.
      const early = new AbortController();
      onStall = () => early.abort();
      await assert.rejects(download.fetch('http://blackhole.invalid/',
        [{address: '192.0.2.1', family: 4}, {address: '127.0.0.1', family: 4}], early.signal, {connectTimeoutMs: 60000}),
        {name: 'AbortError'});
      assert.deepEqual(attempts.splice(0), ['192.0.2.1']);
      await new Promise(r => setImmediate(r));
      assert.equal(timers(), 0);
    } finally {server.closeAllConnections(); await new Promise(r => server.close(r));}
  `;
  await promisify(execFile)("node", ["--experimental-strip-types", "--input-type=module", "-e", script], { timeout: 10_000 });
});
