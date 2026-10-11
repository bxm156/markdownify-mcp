import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { accessSync, constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createConverter } from "./converter.js";
import { ServiceError } from "./errors.js";
import { DEFAULT_PATH, checkRuntime, converterAccessMode, converterCandidates, resolveConverterExecutable } from "./health.js";

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
    // Unset PATH searches DEFAULT_PATH, so the verdict depends only on whether this host has markitdown there.
    delete process.env.PATH;
    const inDefaultPath = DEFAULT_PATH.split(":").some(dir => { try { accessSync(path.join(dir, "markitdown"), constants.X_OK); return true; } catch { return false; } });
    expect((await checkRuntime(data, false)).converter).toEqual({ available: inDefaultPath, check: "executable" });
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
    // Unset PATH falls back to the default list; an explicitly empty PATH has no entries at all.
    expect(DEFAULT_PATH).toBe("/usr/local/bin:/usr/bin:/bin");
    expect(converterCandidates("markitdown", {}, "linux")).toEqual(["/usr/local/bin/markitdown", "/usr/bin/markitdown", "/bin/markitdown"]);
    expect(converterCandidates("markitdown", {}, "linux", "/x:/y")).toEqual(["/x/markitdown", "/y/markitdown"]);
    expect(converterCandidates("markitdown", { PATH: "" }, "linux")).toEqual([]);
    expect(converterCandidates("markitdown", { PATH: "::" }, "linux")).toEqual([]);
    expect(converterCandidates("/srv/.venv/bin/markitdown", { PATH: "/usr/bin" }, "linux")).toEqual(["/srv/.venv/bin/markitdown"]);
    expect(converterCandidates("bin/markitdown", { PATH: "/usr/bin" }, "linux")).toEqual(["bin/markitdown"]);
  });

  test("win32: each PATH entry is tried with each runnable PATHEXT suffix, in order", () => {
    expect(converterCandidates("markitdown", { PATH: "C:\\Python\\Scripts;;D:\\tools", PATHEXT: ".COM;.EXE" }, "win32"))
      .toEqual(["C:\\Python\\Scripts\\markitdown.COM", "C:\\Python\\Scripts\\markitdown.EXE", "D:\\tools\\markitdown.COM", "D:\\tools\\markitdown.EXE"]);
    // Without PATHEXT the directly runnable defaults apply, in Windows' order.
    expect(converterCandidates("markitdown", { PATH: "C:\\bin" }, "win32")).toEqual(["C:\\bin\\markitdown.COM", "C:\\bin\\markitdown.EXE"]);
    // A name that already has a runnable extension is not suffixed.
    expect(converterCandidates("markitdown.exe", { PATH: "C:\\bin", PATHEXT: ".EXE;.CMD" }, "win32")).toEqual(["C:\\bin\\markitdown.exe"]);
    // Absolute paths and either separator bypass the search.
    for (const exe of ["C:\\venv\\Scripts\\markitdown.exe", ".venv\\Scripts\\markitdown.exe", ".venv/Scripts/markitdown.exe"]) expect(converterCandidates(exe, { PATH: "C:\\bin" }, "win32")).toEqual([exe]);
    // A path without an extension gets the runnable suffixes, as spawn would try them.
    expect(converterCandidates("C:\\venv\\Scripts\\markitdown", { PATHEXT: ".CMD;.EXE" }, "win32")).toEqual(["C:\\venv\\Scripts\\markitdown.EXE"]);
    // ";" separates PATH on Windows but not on POSIX, where ":" does.
    expect(converterCandidates("markitdown", { PATH: "a;b" }, "linux")).toEqual(["a;b/markitdown"]);
  });

  test("win32: an empty PATHEXT entry (trailing or doubled ';') never makes an extensionless file a candidate", () => {
    expect(converterCandidates("markitdown", { PATH: "C:\\bin", PATHEXT: ".EXE;" }, "win32")).toEqual(["C:\\bin\\markitdown.EXE"]);
    expect(converterCandidates("markitdown", { PATH: "C:\\bin", PATHEXT: ";;.COM;;" }, "win32")).toEqual(["C:\\bin\\markitdown.COM"]);
    expect(converterCandidates("markitdown", { PATH: "C:\\bin", PATHEXT: ";" }, "win32")).toEqual([]);
    expect(converterCandidates("C:\\venv\\markitdown", { PATHEXT: ".EXE;" }, "win32")).toEqual(["C:\\venv\\markitdown.EXE"]);
  });

  test("win32: .CMD/.BAT and other extensions spawn cannot run without a shell are rejected, .exe/.com in any case accepted", () => {
    expect(converterCandidates("markitdown", { PATH: "C:\\bin", PATHEXT: ".CMD;.BAT;.Exe;.VBS;.com" }, "win32")).toEqual(["C:\\bin\\markitdown.Exe", "C:\\bin\\markitdown.com"]);
    for (const exe of ["markitdown.CMD", "markitdown.bat", "markitdown.py", "C:\\bin\\markitdown.cmd", ".venv\\Scripts\\markitdown.BAT"]) expect(converterCandidates(exe, { PATH: "C:\\bin", PATHEXT: ".CMD;.BAT;.EXE" }, "win32")).toEqual([]);
    for (const exe of ["markitdown.EXE", "markitdown.Com"]) expect(converterCandidates(exe, { PATH: "C:\\bin" }, "win32")).toEqual([`C:\\bin\\${exe}`]);
    // POSIX has no extension rules: a .cmd name is searched like any other.
    expect(converterCandidates("markitdown.cmd", { PATH: "/usr/bin" }, "linux")).toEqual(["/usr/bin/markitdown.cmd"]);
  });

  test("the access mode is X_OK on POSIX and F_OK on win32, which has no execute bit", () => {
    expect(converterAccessMode("linux")).toBe(constants.X_OK);
    expect(converterAccessMode("darwin")).toBe(constants.X_OK);
    expect(converterAccessMode("win32")).toBe(constants.F_OK);
  });
});

describe("shared converter resolution", () => {
  /** A simulated Windows filesystem: `files` are regular files, every other path is missing. Records each access mode. */
  function windowsFs(files: string[]) {
    const accesses: [string, number | undefined][] = [];
    const missing = (file: string) => Object.assign(new Error("ENOENT"), { code: "ENOENT", path: file });
    const stat = spyOn(fs, "stat").mockImplementation((async (file: any) => { if (!files.includes(String(file))) throw missing(String(file)); return { isFile: () => true }; }) as unknown as typeof fs.stat);
    const access = spyOn(fs, "access").mockImplementation((async (file: any, mode?: number) => { accesses.push([String(file), mode]); if (!files.includes(String(file))) throw missing(String(file)); }) as typeof fs.access);
    restores.push(() => { stat.mockRestore(); access.mockRestore(); });
    return accesses;
  }

  test("win32: shell-only and extensionless files are skipped and the first .exe is checked with F_OK", async () => {
    const accesses = windowsFs(["C:\\a\\markitdown", "C:\\a\\markitdown.CMD", "C:\\a\\markitdown.BAT", "C:\\b\\markitdown.EXE", "C:\\c\\markitdown.EXE"]);
    const env = { PATH: "C:\\a;C:\\b;C:\\c", PATHEXT: ".CMD;.BAT;;.EXE;" };
    expect(await resolveConverterExecutable("markitdown", env, "win32")).toBe("C:\\b\\markitdown.EXE");
    expect(accesses).toEqual([["C:\\b\\markitdown.EXE", constants.F_OK]]);
  });

  test("win32: only .CMD/.BAT or extensionless files present means no converter", async () => {
    const accesses = windowsFs(["C:\\a\\markitdown", "C:\\a\\markitdown.CMD", "C:\\b\\markitdown.bat"]);
    expect(await resolveConverterExecutable("markitdown", { PATH: "C:\\a;C:\\b", PATHEXT: ".CMD;.BAT;.EXE;" }, "win32")).toBeUndefined();
    expect(await resolveConverterExecutable("C:\\a\\markitdown.CMD", {}, "win32")).toBeUndefined();
    expect(accesses).toEqual([]);
  });

  test("a stop request ends the search before the next candidate", async () => {
    windowsFs(["C:\\b\\markitdown.EXE"]);
    let checks = 0;
    expect(await resolveConverterExecutable("markitdown", { PATH: "C:\\a;C:\\b" }, "win32", () => ++checks > 1)).toBeUndefined();
    expect(checks).toBe(2);
  });

  test.skipIf(process.platform === "win32")("POSIX: an unset PATH searches the default list, in order", async () => {
    const root = await tempDir("markdownify-defpath-"), local = path.join(root, "usr-local-bin"), usr = path.join(root, "usr-bin");
    await fs.mkdir(local); await fs.mkdir(usr);
    const defaults = [local, usr].join(path.delimiter);
    expect(await resolveConverterExecutable("markitdown", {}, "linux", () => false, defaults)).toBeUndefined();
    await fs.writeFile(path.join(usr, "markitdown"), "#!/bin/sh\n", { mode: 0o755 });
    expect(await resolveConverterExecutable("markitdown", {}, "linux", () => false, defaults)).toBe(path.join(usr, "markitdown"));
    await fs.writeFile(path.join(local, "markitdown"), "#!/bin/sh\n", { mode: 0o755 });
    expect(await resolveConverterExecutable("markitdown", {}, "linux", () => false, defaults)).toBe(path.join(local, "markitdown"));
    // A set PATH, even an empty one, never falls back to the defaults.
    expect(await resolveConverterExecutable("markitdown", { PATH: "" }, "linux", () => false, defaults)).toBeUndefined();
  });

  test.skipIf(process.platform === "win32")("POSIX: the converter spawns the resolved path, not a bare name", async () => {
    const cwd = await tempDir("markdownify-path-cwd-"), bin = await tempDir("markdownify-path-bin-"), output = path.join(cwd, "out.part"), self = path.join(bin, "markitdown");
    await fs.writeFile(self, '#!/bin/sh\nprintf "%s\\n" "$0"\n', { mode: 0o755 });
    const previousCwd = process.cwd();
    process.chdir(cwd); restores.push(() => process.chdir(previousCwd));
    setEnv({ MARKITDOWN_PATH: undefined, PATH: bin });
    await createConverter({ maxOutputBytes: 1000, projectRoot: cwd })(path.join(cwd, "input.txt"), output, new AbortController().signal);
    expect(await fs.readFile(output, "utf8")).toBe(self + "\n");
  });

  test.skipIf(process.platform === "win32")("POSIX: a miss fails closed with ENOENT; an empty PATH entry never runs a stub in the working directory", async () => {
    const cwd = await tempDir("markdownify-path-cwd-"), [empty] = await decoys(), marker = path.join(cwd, "ran");
    await fs.writeFile(path.join(cwd, "markitdown"), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nprintf '# from cwd\\n'\n`, { mode: 0o755 });
    const previousCwd = process.cwd();
    process.chdir(cwd); restores.push(() => process.chdir(previousCwd));
    for (const PATH of [["", empty].join(path.delimiter), "", [empty, ""].join(path.delimiter)]) {
      setEnv({ MARKITDOWN_PATH: undefined, PATH });
      expect(await resolveConverterExecutable("markitdown")).toBeUndefined();
      expect((await checkRuntime(cwd, false)).converter.available).toBe(false);
      const error = await createConverter({ maxOutputBytes: 1000, projectRoot: cwd })(path.join(cwd, "input.txt"), path.join(cwd, "out.part"), new AbortController().signal).catch(value => value);
      expect(error).not.toBeInstanceOf(ServiceError);
      expect(error).toMatchObject({ code: "ENOENT", message: "Converter executable not found" });
    }
    expect(await fs.stat(marker).then(() => true, () => false)).toBe(false);
    expect(await fs.stat(path.join(cwd, "out.part")).then(() => true, () => false)).toBe(false);
  });

  test.skipIf(process.platform === "win32")("POSIX: health and the converter pick the same file on PATH", async () => {
    const data = await tempDir("markdownify-path-data-"), cwd = await tempDir("markdownify-path-cwd-"), [empty, nonExecutable, directory] = await decoys();
    const bin = await tempDir("markdownify-path-bin-"), output = path.join(bin, "out.part");
    await fs.writeFile(path.join(bin, "markitdown"), "#!/bin/sh\nprintf '# converted\\n'\n", { mode: 0o755 });
    const previousCwd = process.cwd();
    process.chdir(cwd); restores.push(() => process.chdir(previousCwd));
    setEnv({ MARKITDOWN_PATH: undefined, PATH: [empty, nonExecutable, directory, bin, "/usr/bin", "/bin"].join(path.delimiter) });
    expect(await resolveConverterExecutable("markitdown")).toBe(path.join(bin, "markitdown"));
    expect((await checkRuntime(data, false)).converter.available).toBe(true);
    await createConverter({ maxOutputBytes: 1000, projectRoot: cwd })(path.join(cwd, "input.txt"), output, new AbortController().signal);
    expect(await fs.readFile(output, "utf8")).toBe("# converted\n");
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
