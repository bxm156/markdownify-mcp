import { afterEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareMarkdownIndex, readMarkdownPage } from "./markdown.js";

const dirs: string[] = [], restores: (() => void)[] = [];
async function output(value: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "markdown-corruption-")); dirs.push(dir);
  const filename = path.join(dir, "output.md"); await fs.writeFile(filename, value); return filename;
}
const indexOf = (file: string) => `${file}.index.json`;
const readIndex = async (file: string) => JSON.parse(await fs.readFile(indexOf(file), "utf8"));
afterEach(async () => {
  for (const restore of restores.splice(0)) restore();
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("cached index that disagrees with the file", () => {
  test("an index claiming more characters than the file holds fails closed instead of returning a short page", async () => {
    const file = await output("abcd");
    expect(await prepareMarkdownIndex(file)).toBe(4);
    // Same byte size, fewer code points; model a filesystem whose coarse mtime did not change.
    await fs.writeFile(file, "😀");
    const index = await readIndex(file);
    index.mtimeMs = (await fs.stat(file)).mtimeMs;
    await fs.writeFile(indexOf(file), JSON.stringify(index));
    for (const offset of [0, 2]) await expect(readMarkdownPage(file, { offset, max_chars: 10 })).rejects.toThrow("Markdown output changed while reading");
  });

  test("a checkpoint pointing inside a multi-byte character fails closed on strict UTF-8 decoding", async () => {
    const file = await output("é".repeat(4096 + 10));
    await prepareMarkdownIndex(file);
    const index = await readIndex(file);
    index.checkpoints[1].bytes += 1; // Still increasing and within the file, so it passes shape validation.
    await fs.writeFile(indexOf(file), JSON.stringify(index));
    await expect(readMarkdownPage(file, { offset: 4096, max_chars: 3 })).rejects.toMatchObject({ name: "TypeError", code: "ERR_ENCODING_INVALID_ENCODED_DATA" });
  });
});

describe("cached index with valid JSON but the wrong shape is rebuilt", () => {
  const text = "😀é中x".repeat(1100); // 4400 code points: two checkpoints.
  const expected = Array.from(text);
  const corruptions: [string, (valid: any) => unknown][] = [
    ["null", () => null],
    ["a number", () => 42],
    ["a string", () => "index"],
    ["an array", () => []],
    ["an empty object", () => ({})],
    ["an unknown version", valid => ({ ...valid, version: 2 })],
    ["a negative total", valid => ({ ...valid, total_chars: -1 })],
    ["a fractional total", valid => ({ ...valid, total_chars: 4400.5 })],
    ["a string total", valid => ({ ...valid, total_chars: "4400" })],
    ["non-array checkpoints", valid => ({ ...valid, checkpoints: "0" })],
    ["too few checkpoints", valid => ({ ...valid, checkpoints: valid.checkpoints.slice(0, 1) })],
    ["too many checkpoints", valid => ({ ...valid, checkpoints: [...valid.checkpoints, { chars: 8192, bytes: valid.size }] })],
    ["a null checkpoint", valid => ({ ...valid, checkpoints: [valid.checkpoints[0], null] })],
    ["a non-object checkpoint", valid => ({ ...valid, checkpoints: [valid.checkpoints[0], 7] })],
    ["a nonzero first checkpoint", valid => ({ ...valid, checkpoints: [{ chars: 0, bytes: 1 }, valid.checkpoints[1]] })],
    ["a misplaced checkpoint", valid => ({ ...valid, checkpoints: [valid.checkpoints[0], { ...valid.checkpoints[1], chars: 4095 }] })],
    ["non-increasing checkpoint bytes", valid => ({ ...valid, checkpoints: [valid.checkpoints[0], { chars: 4096, bytes: 0 }] })],
    ["checkpoint bytes beyond the file", valid => ({ ...valid, checkpoints: [valid.checkpoints[0], { chars: 4096, bytes: valid.size + 1 }] })],
  ];
  for (const [name, corrupt] of corruptions) test(name, async () => {
    const file = await output(text);
    expect(await prepareMarkdownIndex(file)).toBe(expected.length);
    const valid = await readIndex(file);
    await fs.writeFile(indexOf(file), JSON.stringify(corrupt(valid)));
    const page = await readMarkdownPage(file, { offset: 4097, max_chars: 5 });
    expect(page).toEqual({ markdown: expected.slice(4097, 4102).join(""), next_offset: 4102, total_chars: expected.length });
    expect(await readIndex(file)).toEqual(valid);
    expect((await fs.readdir(path.dirname(file))).sort()).toEqual(["output.md", "output.md.index.json"]);
  });
});

describe("index read failures other than missing or unparsable", () => {
  test("EACCES reading the index propagates and leaves the cached index untouched", async () => {
    const file = await output("hello");
    await prepareMarkdownIndex(file);
    const before = await fs.readFile(indexOf(file), "utf8");
    const original = fs.readFile;
    const spy = spyOn(fs, "readFile").mockImplementation(((target: any, ...rest: any[]) => String(target) === indexOf(file)
      ? Promise.reject(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }))
      : (original as any)(target, ...rest)) as typeof fs.readFile);
    restores.push(() => spy.mockRestore());
    await expect(readMarkdownPage(file)).rejects.toMatchObject({ code: "EACCES" });
    await expect(prepareMarkdownIndex(file)).rejects.toMatchObject({ code: "EACCES" });
    spy.mockRestore();
    expect(await fs.readFile(indexOf(file), "utf8")).toBe(before);
    expect((await readMarkdownPage(file)).markdown).toBe("hello");
  });

  test("a directory at the index path (EISDIR) propagates without rebuilding", async () => {
    const file = await output("hello");
    await fs.mkdir(indexOf(file));
    await expect(readMarkdownPage(file)).rejects.toMatchObject({ code: "EISDIR" });
    expect((await fs.readdir(path.dirname(file))).sort()).toEqual(["output.md", "output.md.index.json"]);
  });
});

describe("offsets on 4096-character checkpoint boundaries", () => {
  // Mixed widths (1-4 UTF-8 bytes) so each checkpoint's byte offset differs from its character offset.
  const unit = ["a", "é", "中", "😀"];
  const chars = Array.from({ length: 3 * 4096 }, (_, i) => unit[i % unit.length]);
  const text = chars.join("");
  const slice = (start: number, end: number) => chars.slice(start, end).join("");

  test("checkpoints record exact byte offsets, including one at the very end", async () => {
    const file = await output(text);
    expect(await prepareMarkdownIndex(file)).toBe(chars.length);
    const index = await readIndex(file);
    expect(index.checkpoints).toEqual([0, 4096, 8192, 12288].map(at => ({ chars: at, bytes: Buffer.byteLength(slice(0, at)) })));
  });

  test("pages starting, ending and crossing exactly on boundaries", async () => {
    const file = await output(text);
    await prepareMarkdownIndex(file);
    const cases: [number, number, string, number | null][] = [
      [0, 4096, slice(0, 4096), 4096],
      [4096, 1, slice(4096, 4097), 4097],
      [4096, 4096, slice(4096, 8192), 8192],
      [4095, 2, slice(4095, 4097), 4097],
      [8191, 1, slice(8191, 8192), 8192],
      [8192, 4096, slice(8192, 12288), null],
      [8192, 100_000, slice(8192, 12288), null],
      [12287, 5, slice(12287, 12288), null],
      [12288, 5, "", null],
    ];
    for (const [offset, max_chars, markdown, next_offset] of cases) {
      expect([offset, max_chars, await readMarkdownPage(file, { offset, max_chars })]).toEqual([offset, max_chars, { markdown, next_offset, total_chars: chars.length }]);
    }
    await expect(readMarkdownPage(file, { offset: 12289 })).rejects.toThrow("Offset exceeds");
  });
});
