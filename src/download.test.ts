import { expect, spyOn, test } from "bun:test";
import http, { createServer, type IncomingHttpHeaders, type RequestListener } from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { EventEmitter } from "node:events";
import { gzipSync } from "node:zlib";
import { ConnectFailedError, download, interleaveFamilies, USER_AGENT } from "./download";
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
/** The unspied net.connect, for test servers' own connections. */
const directConnect = net.connect.bind(net);
const downloadModule = JSON.stringify(new URL("./download.ts", import.meta.url).href);

/** Runs an ES module script under Node, which strips the TypeScript of download.ts. */
async function runUnderNode(script: string, timeout = 10_000): Promise<void> {
  await promisify(execFile)("node", ["--experimental-strip-types", "--input-type=module", "-e", script], { timeout });
}

/** Self-signed certificate for tls.invalid (valid until 2126); tests trust it explicitly. */
const TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgFiOLpid7TvDb0IQ/
WV3k3c5GYbNc2NEhCiRKKHMQixOhRANCAATRhlJA4hIKiPXXQzGB8rb3xvWYOD0x
p9uZtrYdOsNWb+4RiTcjBbu7MyC8ZeepnRkxgGLZU27SE4gT8nOT5CZw
-----END PRIVATE KEY-----
`;
const TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIBmzCCAUGgAwIBAgIUOEIWn7lKz9R6W+azyIeUznRQ7RMwCgYIKoZIzj0EAwIw
FjEUMBIGA1UEAwwLdGxzLmludmFsaWQwIBcNMjYxMDExMDM0NjU1WhgPMjEyNjA5
MTcwMzQ2NTVaMBYxFDASBgNVBAMMC3Rscy5pbnZhbGlkMFkwEwYHKoZIzj0CAQYI
KoZIzj0DAQcDQgAE0YZSQOISCoj110MxgfK298b1mDg9Mafbmba2HTrDVm/uEYk3
IwW7uzMgvGXnqZ0ZMYBi2VNu0hOIE/Jzk+QmcKNrMGkwHQYDVR0OBBYEFKY4Bt1u
35gbwevFpE02Fn6j2uPJMB8GA1UdIwQYMBaAFKY4Bt1u35gbwevFpE02Fn6j2uPJ
MA8GA1UdEwEB/wQFMAMBAf8wFgYDVR0RBA8wDYILdGxzLmludmFsaWQwCgYIKoZI
zj0EAwIDSAAwRQIgYINauoDIYKQ6Zw0iFK0TfOWH+HvQNE4t97Gd54yB4r8CIQDv
IX5GtFz9bBbcIxlnfk2v2tXKpmqy6INp54/nZpECsQ==
-----END CERTIFICATE-----
`;

/**
 * Serves HTTPS for tls.invalid on a front port whose FIRST connection is
 * accepted at the TCP level but never answered, so its TLS handshake stalls;
 * later connections are proxied byte for byte to a real HTTPS server. Works
 * the same under Bun and Node.
 */
async function withHandshakeStallServer(
  handler: RequestListener,
  body: (port: number, held: net.Socket[]) => Promise<void>,
): Promise<void> {
  const backend = https.createServer({ key: TLS_KEY, cert: TLS_CERT }, handler);
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const held: net.Socket[] = [];
  const front = net.createServer((client) => {
    client.on("error", () => {});
    if (held.length === 0) {
      held.push(client);
      client.resume(); // read and discard the ClientHello so the client's close is observed
      return;
    }
    const upstream = directConnect((backend.address() as any).port, "127.0.0.1");
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", resolve));
  try {
    await body((front.address() as any).port, held);
  } finally {
    for (const socket of held) socket.destroy();
    backend.closeAllConnections();
    await new Promise<void>((resolve) => front.close(() => resolve()));
    await new Promise<void>((resolve) => backend.close(() => resolve()));
  }
}

/** A stand-in socket that fails with `error` once download.ts listens for it. */
function refusedSocket(error: NodeJS.ErrnoException): net.Socket {
  const socket = new EventEmitter() as EventEmitter & { destroy: () => void; destroyed: boolean };
  socket.destroyed = false;
  socket.destroy = () => { socket.destroyed = true; };
  process.nextTick(() => socket.emit("error", error));
  return socket as unknown as net.Socket;
}

/**
 * Wraps the real net.connect and tls.connect so that connections to `stalled`
 * addresses never complete: the pinned lookup simply never answers, leaving
 * the socket in its connecting state exactly like a route that drops SYN
 * packets, without depending on how any real IP behaves. Other addresses
 * connect normally. `onStall` runs when an attempt to a stalled address has
 * started; `ca` is added to TLS connections so the test certificate is trusted.
 */
function interceptConnects(
  stalled: string[] = [],
  { onStall = () => {}, ca }: { onStall?: () => void; ca?: string } = {},
) {
  const attempts: string[] = [];
  const sockets: net.Socket[] = [];
  const options: any[] = [];
  const wrap = (connectOptions: any) => {
    options.push(connectOptions);
    return {
      ...connectOptions,
      ...(ca ? { ca } : {}),
      lookup: (host: string, lookupOptions: any, answer: (...args: any[]) => void) => {
        connectOptions.lookup(host, lookupOptions, (...args: any[]) => {
          const address = Array.isArray(args[1]) ? args[1][0].address : args[1];
          attempts.push(address);
          if (stalled.includes(address)) onStall();
          else answer(...args);
        });
      },
    };
  };
  const realNetConnect = net.connect.bind(net);
  const realTlsConnect = tls.connect.bind(tls);
  const netSpy = spyOn(net, "connect").mockImplementation(((connectOptions: any) => {
    const socket = realNetConnect(wrap(connectOptions));
    sockets.push(socket);
    return socket;
  }) as any);
  const tlsSpy = spyOn(tls, "connect").mockImplementation(((connectOptions: any) => {
    const socket = realTlsConnect(wrap(connectOptions));
    sockets.push(socket);
    return socket;
  }) as any);
  return {
    attempts,
    sockets,
    options,
    restore: () => {
      netSpy.mockRestore();
      tlsSpy.mockRestore();
    },
  };
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
  // before the socket's error listener was attached and crashed the process.
  // The family-6 entry for an IPv4 address fails deterministically (EINVAL)
  // without needing IPv6 on the host. Bun ignores the family, so it cannot
  // show the crash.
  await runUnderNode(`
    import assert from 'node:assert/strict';
    import http from 'node:http';
    import net from 'node:net';
    import {download} from ${downloadModule};
    const realConnect = net.connect;
    let attempts = 0;
    net.connect = (...args) => { attempts++; return realConnect(...args); };
    const server = http.createServer((req, res) => res.end('fallback'));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    try {
      const response = await download.fetch('http://mismatch.invalid:' + server.address().port,
        [{address: '127.0.0.1', family: 6}, {address: '127.0.0.1', family: 4}], AbortSignal.timeout(2000),
        {attemptDelayMs: 60000});
      assert.equal(await response.text(), 'fallback');
      assert.equal(attempts, 2);
    } finally {server.closeAllConnections(); await new Promise(r => server.close(r));}
  `, 5000);
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
  expect(headers["connection"]).toBe("close");
});

test("a refused connection starts the next validated address at once, not after the stagger delay", async () => {
  let requests = 0;
  await withServer(
    (_request, response) => {
      requests++;
      response.end("second address");
    },
    async (port) => {
      // An unused address can stall instead of refusing on Windows.
      // Inject only the first error; the second attempt uses the real transport.
      const realConnect = net.connect.bind(net);
      const refusal = Object.assign(new Error("controlled refusal"), { code: "ECONNREFUSED" });
      const connectSpy = spyOn(net, "connect")
        .mockImplementationOnce(() => refusedSocket(refusal))
        .mockImplementation(realConnect as any);
      try {
        const response = await download.fetch(
          `http://dual.invalid:${port}/`,
          [{ address: "192.0.2.1", family: 4 }, ...loopback],
          AbortSignal.timeout(2000),
          { attemptDelayMs: 60_000 },
        );
        expect(await response.text()).toBe("second address");
        expect(connectSpy).toHaveBeenCalledTimes(2);
      } finally {
        connectSpy.mockRestore();
      }
    },
  );
  expect(requests).toBe(1);
});

test("one error lists every address and its failure code when all are refused", async () => {
  const first = Object.assign(new Error("first refusal"), { code: "ECONNREFUSED" });
  const last = Object.assign(new Error("last refusal"), { code: "EHOSTUNREACH" });
  const connectSpy = spyOn(net, "connect")
    .mockImplementationOnce(() => refusedSocket(first))
    .mockImplementationOnce(() => refusedSocket(last));
  try {
    const error = await download.fetch(
      "http://down.invalid/path?token=secret",
      [{ address: "192.0.2.1", family: 4 }, { address: "2001:db8::2", family: 6 }],
      AbortSignal.timeout(2000),
    ).then(() => undefined, (error) => error);
    expect(error).toBeInstanceOf(ConnectFailedError);
    expect(error.code).toBe("ERR_ALL_ADDRESSES_FAILED");
    expect(error.attempts).toEqual([
      { address: "192.0.2.1", family: 4, code: "ECONNREFUSED" },
      { address: "2001:db8::2", family: 6, code: "EHOSTUNREACH" },
    ]);
    expect(error.message).toBe(
      "Could not connect to http://down.invalid/path: tried 192.0.2.1 (ECONNREFUSED), 2001:db8::2 (EHOSTUNREACH)",
    );
    expect(error.message).not.toContain("secret");
    expect(connectSpy).toHaveBeenCalledTimes(2);
  } finally {
    connectSpy.mockRestore();
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

test("families alternate, starting with the first address's family and keeping order within each", () => {
  const v6a = { address: "2001:db8::1", family: 6 };
  const v6b = { address: "2001:db8::2", family: 6 };
  const v6c = { address: "2001:db8::3", family: 6 };
  const v4a = { address: "192.0.2.1", family: 4 };
  const v4b = { address: "192.0.2.2", family: 4 };
  expect(interleaveFamilies([v6a, v6b, v6c, v4a, v4b])).toEqual([v6a, v4a, v6b, v4b, v6c]);
  expect(interleaveFamilies([v4a, v4b, v6a])).toEqual([v4a, v6a, v4b]);
  expect(interleaveFamilies([v4a, v4b])).toEqual([v4a, v4b]);
  expect(interleaveFamilies([])).toEqual([]);
});

test("a stalled address is overtaken by the next one after the stagger delay, well within its budget", async () => {
  let host: string | undefined;
  await withServer(
    (request, response) => {
      host = request.headers.host;
      response.end("reachable address");
    },
    async (port) => {
      const connects = interceptConnects(["2001:db8::1"]);
      try {
        const response = await download.fetch(
          `http://dual.invalid:${port}/`,
          [{ address: "2001:db8::1", family: 6 }, ...loopback],
          // Budget and deadline far beyond the stagger: success proves the stagger moved on.
          AbortSignal.timeout(10_000),
          { connectTimeoutMs: 60_000, attemptDelayMs: 20 },
        );
        expect(await response.text()).toBe("reachable address");
        expect(connects.attempts).toEqual(["2001:db8::1", "127.0.0.1"]);
        expect(connects.sockets[0].destroyed).toBe(true);
      } finally {
        connects.restore();
      }
    },
  );
  expect(host).toMatch(/^dual\.invalid:\d+$/);
});

test("mixed-family addresses are attempted in interleaved order and every loser is destroyed", async () => {
  await withServer(
    (_request, response) => response.end("ipv4 loopback"),
    async (port) => {
      const connects = interceptConnects(["2001:db8::1", "2001:db8::2", "192.0.2.1"]);
      try {
        const response = await download.fetch(
          `http://mixed.invalid:${port}/`,
          [
            { address: "2001:db8::1", family: 6 },
            { address: "2001:db8::2", family: 6 },
            { address: "192.0.2.1", family: 4 },
            ...loopback,
          ],
          AbortSignal.timeout(10_000),
          { connectTimeoutMs: 60_000, attemptDelayMs: 5 },
        );
        expect(await response.text()).toBe("ipv4 loopback");
        expect(connects.attempts).toEqual(["2001:db8::1", "192.0.2.1", "2001:db8::2", "127.0.0.1"]);
        expect(connects.sockets.slice(0, 3).every((socket) => socket.destroyed)).toBe(true);
      } finally {
        connects.restore();
      }
    },
  );
});

test("when every address stalls, the deadline rejects with one error listing each address", async () => {
  const connects = interceptConnects(["192.0.2.1", "192.0.2.2"]);
  const signal = AbortSignal.timeout(300);
  try {
    const error = await download.fetch(
      "http://blackhole.invalid/",
      [{ address: "192.0.2.1", family: 4 }, { address: "192.0.2.2", family: 4 }],
      signal,
      { connectTimeoutMs: 20, attemptDelayMs: 10 },
    ).then(() => undefined, (error) => error);
    // The first address spent its budget; the last one has none and ran into the deadline.
    expect(signal.aborted).toBe(true);
    expect(error).toBeInstanceOf(ConnectFailedError);
    expect(error.cause).toBe(signal.reason);
    expect(error.attempts).toEqual([
      { address: "192.0.2.1", family: 4, code: "ETIMEDOUT" },
      { address: "192.0.2.2", family: 4, code: "TimeoutError" },
    ]);
    expect(error.message).toContain("http://blackhole.invalid/: tried 192.0.2.1 (ETIMEDOUT), 192.0.2.2 (TimeoutError)");
    expect(connects.attempts).toEqual(["192.0.2.1", "192.0.2.2"]);
    expect(connects.sockets.every((socket) => socket.destroyed)).toBe(true);
  } finally {
    connects.restore();
  }
});

test("cancelling mid-stagger rejects with the abort reason, starts nothing more and clears every timer", async () => {
  const controller = new AbortController();
  const connects = interceptConnects(["192.0.2.1"], { onStall: () => controller.abort() });
  const realSetTimeout = globalThis.setTimeout;
  const raceTimers: unknown[] = [];
  const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
    handler: (...args: any[]) => void, delay?: number, ...args: any[]
  ) => {
    const timer = realSetTimeout(handler, delay, ...args);
    if (delay === 60_000 || delay === 50_000) raceTimers.push(timer);
    return timer;
  }) as any);
  const clearTimeoutSpy = spyOn(globalThis, "clearTimeout");
  try {
    await expect(download.fetch(
      "http://blackhole.invalid/",
      [{ address: "192.0.2.1", family: 4 }, ...loopback],
      controller.signal,
      { connectTimeoutMs: 60_000, attemptDelayMs: 50_000 },
    )).rejects.toMatchObject({ name: "AbortError" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(connects.attempts).toEqual(["192.0.2.1"]);
    expect(connects.sockets).toHaveLength(1);
    expect(connects.sockets[0].destroyed).toBe(true);
    // The first attempt's budget and the stagger timer for the second.
    expect(raceTimers).toHaveLength(2);
    for (const timer of raceTimers) expect(clearTimeoutSpy).toHaveBeenCalledWith(timer as any);
  } finally {
    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
    connects.restore();
  }
});

test("an error after a socket has won is not retried on another address", async () => {
  const late = Object.assign(new Error("timed out after connecting"), { code: "ETIMEDOUT" });
  await withServer(
    () => { /* never respond */ },
    async (port) => {
      const realRequest = http.request.bind(http);
      const requestSpy = spyOn(http, "request").mockImplementation(((...args: any[]) => {
        const request = (realRequest as any)(...args) as http.ClientRequest;
        request.once("socket", () => request.destroy(late));
        return request;
      }) as any);
      const connects = interceptConnects();
      try {
        await expect(download.fetch(
          `http://late.invalid:${port}/`,
          [...loopback, ...loopback],
          AbortSignal.timeout(2000),
          { connectTimeoutMs: 1000, attemptDelayMs: 1000 },
        )).rejects.toBe(late);
        expect(requestSpy).toHaveBeenCalledTimes(1);
        expect(connects.sockets).toHaveLength(1);
      } finally {
        connects.restore();
        requestSpy.mockRestore();
      }
    },
  );
});

test("a TLS handshake that stalls after TCP connects falls through within the budget, keeping SNI and Host", async () => {
  let host: string | undefined;
  await withHandshakeStallServer(
    (request, response) => {
      host = request.headers.host;
      response.end("secure second address");
    },
    async (port, held) => {
      const connects = interceptConnects([], { ca: TLS_CERT });
      try {
        const response = await download.fetch(
          `https://tls.invalid:${port}/`,
          [...loopback, ...loopback],
          AbortSignal.timeout(10_000),
          // A stagger far beyond the budget: only the handshake budget can move on.
          { connectTimeoutMs: 100, attemptDelayMs: 60_000 },
        );
        expect(await response.text()).toBe("secure second address");
        expect(held).toHaveLength(1);
        expect(connects.sockets).toHaveLength(2);
        expect(connects.sockets[0].destroyed).toBe(true);
        expect(connects.options.map((options) => options.servername)).toEqual(["tls.invalid", "tls.invalid"]);
        // The stalled attempt's connection is really closed, not just abandoned.
        await new Promise((resolve) => held[0].destroyed ? resolve(undefined) : held[0].once("close", resolve));
      } finally {
        connects.restore();
      }
    },
  );
  expect(host).toMatch(/^tls\.invalid:\d+$/);
});

test("a certificate that does not match the hostname is rejected, not retried on another address", async () => {
  await withHandshakeStallServer(
    (_request, response) => response.end("must not be read"),
    async (port, held) => {
      held.push(new net.Socket()); // let the first connection through to the TLS server
      const connects = interceptConnects([], { ca: TLS_CERT });
      try {
        await expect(download.fetch(
          `https://other.invalid:${port}/`,
          [...loopback, ...loopback],
          AbortSignal.timeout(5000),
          { connectTimeoutMs: 5000, attemptDelayMs: 60_000 },
        )).rejects.toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
        expect(connects.sockets).toHaveLength(1);
      } finally {
        connects.restore();
      }
    },
  );
});

test("under Node, staggered attempts, TLS stalls and the combined error release every timer", async () => {
  await runUnderNode(`
    import assert from 'node:assert/strict';
    import http from 'node:http';
    import https from 'node:https';
    import net from 'node:net';
    import tls from 'node:tls';
    import {download} from ${downloadModule};
    const realNetConnect = net.connect, realTlsConnect = tls.connect;
    let onStall = () => {};
    const attempts = [];
    // Connections to 192.0.2.x never complete: the pinned lookup never answers.
    const wrap = (options) => ({...options, ca: ${JSON.stringify(TLS_CERT)}, lookup: (host, o, answer) =>
      options.lookup(host, o, (...args) => {
        const address = Array.isArray(args[1]) ? args[1][0].address : args[1];
        attempts.push(address);
        if (address.startsWith('192.0.2.')) onStall(); else answer(...args);
      })});
    net.connect = (options) => realNetConnect(wrap(options));
    tls.connect = (options) => realTlsConnect(wrap(options));
    const timers = () => process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;
    const server = http.createServer((req, res) => res.end('host=' + req.headers.host));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    // HTTPS: the first TCP connection is held without a handshake, later ones reach the TLS server.
    let sni;
    const secure = https.createServer({key: ${JSON.stringify(TLS_KEY)}, cert: ${JSON.stringify(TLS_CERT)}},
      (req, res) => { sni = req.socket.servername; res.end('secure host=' + req.headers.host); });
    await new Promise(r => secure.listen(0, '127.0.0.1', r));
    const held = [];
    const front = net.createServer(client => {
      // Read and discard the ClientHello so the client's close is observed.
      if (held.length === 0) { held.push(client); client.resume(); return; }
      const upstream = realNetConnect(secure.address().port, '127.0.0.1');
      client.pipe(upstream).pipe(client);
      client.on('close', () => upstream.destroy()); upstream.on('close', () => client.destroy());
      client.on('error', () => {}); upstream.on('error', () => {});
    });
    await new Promise(r => front.listen(0, '127.0.0.1', r));
    try {
      // First address stalls, second wins after the stagger delay with the original Host.
      const response = await download.fetch('http://dual.invalid:' + port + '/',
        [{address: '192.0.2.1', family: 4}, {address: '127.0.0.1', family: 4}], new AbortController().signal,
        {connectTimeoutMs: 60000, attemptDelayMs: 20});
      assert.equal(await response.text(), 'host=dual.invalid:' + port);
      assert.deepEqual(attempts.splice(0), ['192.0.2.1', '127.0.0.1']);

      // Every address stalls; the deadline yields one combined error.
      const deadline = AbortSignal.timeout(200);
      await assert.rejects(download.fetch('http://blackhole.invalid/',
        [{address: '192.0.2.1', family: 4}, {address: '192.0.2.2', family: 4}], deadline, {connectTimeoutMs: 20, attemptDelayMs: 5}),
        (error) => {
          assert.equal(error.code, 'ERR_ALL_ADDRESSES_FAILED');
          assert.deepEqual(error.attempts.map(a => a.code), ['ETIMEDOUT', 'TimeoutError']);
          assert.equal(error.cause, deadline.reason);
          return true;
        });
      assert.deepEqual(attempts.splice(0), ['192.0.2.1', '192.0.2.2']);

      // Cancelled during the stagger with long budgets: nothing else starts, no timer left behind.
      const early = new AbortController();
      onStall = () => early.abort();
      await assert.rejects(download.fetch('http://blackhole.invalid/',
        [{address: '192.0.2.1', family: 4}, {address: '127.0.0.1', family: 4}], early.signal,
        {connectTimeoutMs: 60000, attemptDelayMs: 60000}),
        {name: 'AbortError'});
      assert.deepEqual(attempts.splice(0), ['192.0.2.1']);
      onStall = () => {};

      // HTTPS: TCP connects but TLS never completes; the budget moves on, SNI and Host are kept.
      const secureResponse = await download.fetch('https://tls.invalid:' + front.address().port + '/',
        [{address: '127.0.0.1', family: 4}, {address: '127.0.0.1', family: 4}], AbortSignal.timeout(5000),
        {connectTimeoutMs: 100, attemptDelayMs: 60000});
      assert.equal(await secureResponse.text(), 'secure host=tls.invalid:' + front.address().port);
      assert.equal(sni, 'tls.invalid');
      assert.equal(held.length, 1);
      await new Promise(r => held[0].destroyed ? r() : held[0].once('close', r));

      // Every socket closes (losers destroyed, winners not kept alive) and no timer is left behind.
      const sockets = () => process.getActiveResourcesInfo().filter(r => r === 'TCPSocketWrap').length;
      for (let i = 0; i < 200 && sockets() > 0; i++) await new Promise(r => setTimeout(r, 10));
      assert.equal(sockets(), 0);
      await new Promise(r => setImmediate(r));
      assert.equal(timers(), 0);
    } finally {
      for (const s of held) s.destroy();
      server.closeAllConnections(); secure.closeAllConnections();
      await new Promise(r => server.close(r)); await new Promise(r => front.close(r)); await new Promise(r => secure.close(r));
    }
  `);
}, 15_000);
