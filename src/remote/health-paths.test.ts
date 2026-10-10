import { afterEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkRuntime, converterCandidates } from "./health.js";

const directories: string[] = [], restores: (() => void)[] = [];
async function tempDir(prefix: string) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix)); directories.push(dir); return dir; }
/** Set (or with `undefined`, unset) environment variables until the end of the test. */
function setEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    restores.push(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
afterEach(async () => {
  for (const restore of restores.splice(0).reverse()) restore();
  await Promise.all(directories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

/** PATH directories that each hold something named `markitdown` that must not count as the converter. */
async function decoys() {
  const nonExecutable = await tempDir("markdownify-path-noexec-"), directory = await tempDir("markdownify-path-dir-"), empty = await tempDir("markdownify-path-empty-");
  await fs.writeFile(path.join(nonExecutable, "markitdown"), "#!/bin/sh\n", { mode: 0o644 }); // Not X_OK even for root: no execute bit.
  await fs.mkdir(path.join(directory, "markitdown"));
  return [empty, nonExecutable, directory];
}
async function stub() {
  const dir = await tempDir("markdownify-path-bin-");
  await fs.writeFile(path.join(dir, "markitdown"), "#!/bin/sh\n", { mode: 0o755 });
  return dir;
}

describe.skipIf(process.platform === "win32")("converter search on PATH", () => {
  test("default deployment: no MARKITDOWN_PATH and no project venv searches PATH for bare markitdown", async () => {
    const data = await tempDir("markdownify-path-data-"), cwd = await tempDir("markdownify-path-cwd-"), [empty, nonExecutable, directory] = await decoys(), bin = await stub();
    const previousCwd = process.cwd();
    // resolveMarkitdownPath() prefers <cwd>/.venv; run from a directory without one so the bare name is used.
    process.chdir(cwd); restores.push(() => process.chdir(previousCwd));
    setEnv({ MARKITDOWN_PATH: undefined, PATH: ["", empty, nonExecutable, "", directory, bin].join(path.delimiter) });
    expect((await checkRuntime(data, false)).converter).toEqual({ available: true, check: "executable" });
    process.env.PATH = [empty, nonExecutable, directory].join(path.delimiter);
    expect((await checkRuntime(data, false)).converter).toEqual({ available: false, check: "executable" });
    delete process.env.PATH;
    expect((await checkRuntime(data, false)).converter).toEqual({ available: false, check: "executable" });
  });

  test("a bare MARKITDOWN_PATH name is searched in PATH order and the result never names a directory", async () => {
    const data = await tempDir("markdownify-path-data-"), [empty, nonExecutable, directory] = await decoys(), bin = await stub();
    setEnv({ MARKITDOWN_PATH: "markitdown", PATH: [nonExecutable, directory, empty, bin].join(path.delimiter) });
    const found = await checkRuntime(data, false);
    expect(found.converter.available).toBe(true);
    for (const dir of [data, nonExecutable, directory, empty, bin]) expect(JSON.stringify(found)).not.toContain(dir);
    // A path containing a separator is never searched on PATH.
    process.env.MARKITDOWN_PATH = `.${path.sep}markitdown`;
    expect((await checkRuntime(data, false)).converter.available).toBe(false);
  });
});

describe("converter candidate list", () => {
  test("POSIX: PATH entries in order, empty entries skipped, PATHEXT ignored", () => {
    expect(converterCandidates("markitdown", { PATH: "/usr/local/bin::/opt/md/bin:", PATHEXT: ".EXE" }, "linux")).toEqual(["/usr/local/bin/markitdown", "/opt/md/bin/markitdown"]);
    expect(converterCandidates("markitdown", {}, "linux")).toEqual([]);
    expect(converterCandidates("/srv/.venv/bin/markitdown", { PATH: "/usr/bin" }, "linux")).toEqual(["/srv/.venv/bin/markitdown"]);
    expect(converterCandidates("bin/markitdown", { PATH: "/usr/bin" }, "linux")).toEqual(["bin/markitdown"]);
  });

  test("win32: each PATH entry is tried with each PATHEXT suffix, in order", () => {
    expect(converterCandidates("markitdown", { PATH: "C:\\Python\\Scripts;;D:\\tools", PATHEXT: ".COM;.EXE" }, "win32"))
      .toEqual(["C:\\Python\\Scripts\\markitdown.COM", "C:\\Python\\Scripts\\markitdown.EXE", "D:\\tools\\markitdown.COM", "D:\\tools\\markitdown.EXE"]);
    // Without PATHEXT the default suffixes apply.
    expect(converterCandidates("markitdown", { PATH: "C:\\bin" }, "win32")).toEqual(["C:\\bin\\markitdown.EXE", "C:\\bin\\markitdown.CMD", "C:\\bin\\markitdown.BAT"]);
    // A name that already has an extension is not suffixed.
    expect(converterCandidates("markitdown.exe", { PATH: "C:\\bin", PATHEXT: ".EXE;.CMD" }, "win32")).toEqual(["C:\\bin\\markitdown.exe"]);
    // Absolute paths and either separator bypass the search.
    for (const exe of ["C:\\venv\\Scripts\\markitdown.exe", ".venv\\Scripts\\markitdown.exe", ".venv/Scripts/markitdown.exe"]) expect(converterCandidates(exe, { PATH: "C:\\bin" }, "win32")).toEqual([exe]);
    // ";" separates PATH on Windows but not on POSIX, where ":" does.
    expect(converterCandidates("markitdown", { PATH: "a;b" }, "linux")).toEqual(["a;b/markitdown"]);
  });
});

describe("storage probe edge cases", () => {
  test("statfs rejecting reports unwritable storage with unknown free space and writes no probe file", async () => {
    const data = await tempDir("markdownify-statfs-");
    const original = fs.writeFile;
    let probes = 0;
    const writes = spyOn(fs, "writeFile").mockImplementation(((target: any, ...rest: any[]) => { if (String(target).startsWith(data)) probes++; return (original as any)(target, ...rest); }) as typeof fs.writeFile);
    const statfs = spyOn(fs, "statfs").mockRejectedValue(Object.assign(new Error(`EIO: i/o error, statfs '${data}'`), { code: "EIO" }));
    restores.push(() => { writes.mockRestore(); statfs.mockRestore(); });
    const result = await checkRuntime(data, true);
    expect(result.storage).toEqual({ writable: false, free_bytes: null });
    expect(JSON.stringify(result)).not.toContain(data);
    expect(probes).toBe(0);
    expect(await fs.readdir(data)).toEqual([]);
  });

  test("bavail === 0 reports zero free bytes and unwritable even though the probe write succeeds", async () => {
    const data = await tempDir("markdownify-statfs-");
    const original = fs.writeFile;
    let probes = 0;
    const writes = spyOn(fs, "writeFile").mockImplementation(((target: any, ...rest: any[]) => { if (String(target).startsWith(data)) probes++; return (original as any)(target, ...rest); }) as typeof fs.writeFile);
    const statfs = spyOn(fs, "statfs").mockResolvedValue({ type: 0, bsize: 4096, blocks: 1000, bfree: 0, bavail: 0, files: 100, ffree: 10 } as Awaited<ReturnType<typeof fs.statfs>>);
    restores.push(() => { writes.mockRestore(); statfs.mockRestore(); });
    const result = await checkRuntime(data, true);
    expect(result.storage).toEqual({ writable: false, free_bytes: 0 });
    expect(probes).toBe(1);
    expect(await fs.readdir(data)).toEqual([]);
  });
});
