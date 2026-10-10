import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareMarkdownIndex, readMarkdownPage } from "./markdown.js";
const dirs: string[] = [];
async function output(value: string | Buffer) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "markdown-pages-")); dirs.push(dir);
  const filename = path.join(dir, "output.md"); await fs.writeFile(filename, value); return filename;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });

test("Unicode pagination preserves BOM and characters split across UTF-8 stream chunks", async () => {
  const text = "\uFEFF" + "a".repeat(65531) + "😀é中\n" + "𐍈".repeat(5000);
  const file = await output(text);
  const expected = Array.from(text);
  expect(await prepareMarkdownIndex(file)).toBe(expected.length);
  for (const offset of [0, 4095, 4096, 65531, 65532, expected.length - 4]) {
    const result = await readMarkdownPage(file, { offset, max_chars: 9 });
    expect(result.markdown).toBe(expected.slice(offset, offset + 9).join(""));
    expect(result.total_chars).toBe(expected.length);
    expect(result.next_offset).toBe(offset + 9 < expected.length ? offset + 9 : null);
  }
  expect(await readMarkdownPage(file, { offset: expected.length })).toEqual({ markdown: "", next_offset: null, total_chars: expected.length });
  await expect(readMarkdownPage(file, { offset: expected.length + 1 })).rejects.toThrow("Offset exceeds");
});

test("large late pages use persisted byte checkpoints and reuse index across callers", async () => {
  const block = "😀é中x".repeat(1024);
  const file = await output(block.repeat(1024)); // 10 MiB / over 4 million code points.
  expect(await prepareMarkdownIndex(file)).toBe(4 * 1024 * 1024);
  const indexFile = `${file}.index.json`;
  const before = await fs.stat(indexFile);
  const index = JSON.parse(await fs.readFile(indexFile, "utf8"));
  const offset = index.total_chars - 5017;
  const checkpoint = index.checkpoints[Math.floor(offset / 4096)];
  expect(offset - checkpoint.chars).toBeLessThan(4096);
  expect(index.size - checkpoint.bytes).toBeLessThan(25000);
  expect((await readMarkdownPage(file, { offset, max_chars: 17 })).markdown).toBe(Array.from(block).slice(offset % 4096, offset % 4096 + 17).join(""));
  const after = await fs.stat(indexFile);
  expect(after.mtimeMs).toBe(before.mtimeMs);
  expect(after.size).toBeLessThan(100000);
});

test("empty output, invalid pagination and malformed UTF-8", async () => {
  const empty = await output("");
  expect(await readMarkdownPage(empty)).toEqual({ markdown: "", next_offset: null, total_chars: 0 });
  await expect(readMarkdownPage(empty, { offset: -1 })).rejects.toMatchObject({ name: "RangeError", message: "Invalid pagination parameters" });
  await expect(readMarkdownPage(empty, { max_chars: 100001 })).rejects.toMatchObject({ name: "RangeError", message: "Invalid pagination parameters" });
  const invalid = await output(Buffer.from([0xf0, 0x9f]));
  await expect(prepareMarkdownIndex(invalid)).rejects.toMatchObject({ name: "TypeError", code: "ERR_ENCODING_INVALID_ENCODED_DATA" });
  await expect(fs.stat(`${invalid}.index.json`)).rejects.toMatchObject({ code: "ENOENT" });
});

test("changed output invalidates cached index", async () => {
  const file = await output("first");
  expect(await prepareMarkdownIndex(file)).toBe(5);
  await fs.writeFile(file, "😀 updated output");
  expect((await readMarkdownPage(file)).markdown).toBe("😀 updated output");
});
