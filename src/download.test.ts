import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { download } from "./download";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
  // Exercise the production Node runtime; Bun 1.4.2 on Windows crashes in its HTTP abort bridge.
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
