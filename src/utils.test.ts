import {
  expect,
  test,
  describe,
  beforeEach,
  afterEach,
  spyOn,
} from "bun:test";
import {
  expandHome,
  validateUrl,
  validateRepoUrl,
  isUnconvertedHtml,
  inferExtensionFromUrl,
  isMarkdownFile,
  isWithinDirectory,
  resolveMarkitdownPath,
  resolveRepomixPath,
  getAllowedPaths,
  assertPathAllowed,
  assertRealPathAllowed,
  openLocalFile,
  resolveOpenedFile,
  redactUrl,
} from "./utils";
import dns from "node:dns";
import fs from "fs";
import os from "os";
import path from "path";

describe("expandHome", () => {
  test("expands ~/path to home directory", () => {
    const result = expandHome("~/documents");
    expect(result).toBe(path.join(os.homedir(), "documents"));
  });

  test("expands lone ~ to home directory", () => {
    const result = expandHome("~");
    expect(result).toBe(os.homedir());
  });

  test("does not expand paths without tilde", () => {
    expect(expandHome("/usr/local")).toBe("/usr/local");
  });

  test("does not expand tilde in the middle of a path", () => {
    expect(expandHome("/usr/~/local")).toBe("/usr/~/local");
  });
});

describe("validateUrl", () => {
  let lookupSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Keep these tests offline: every hostname resolves to a public address
    // unless a test says otherwise.
    lookupSpy = spyOn(dns.promises, "lookup").mockResolvedValue([
      { address: "93.184.215.14", family: 4 },
    ] as any);
  });

  afterEach(() => {
    lookupSpy.mockRestore();
  });

  test("accepts http URLs", async () => {
    await expect(validateUrl("http://example.com")).resolves.toBeUndefined();
  });

  test("accepts https URLs", async () => {
    await expect(validateUrl("https://example.com/")).resolves.toBeUndefined();
    expect(lookupSpy).toHaveBeenCalledWith("example.com", {
      all: true,
      verbatim: true,
    });
  });

  test("accepts public IP literals without a DNS lookup", async () => {
    await expect(validateUrl("http://8.8.8.8/")).resolves.toBeUndefined();
    await expect(
      validateUrl("http://[2606:4700::1111]/"),
    ).resolves.toBeUndefined();
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  test("rejects ftp URLs", async () => {
    await expect(validateUrl("ftp://example.com")).rejects.toThrow(
      "Only http: and https: schemes are allowed.",
    );
  });

  test("rejects file URLs", async () => {
    await expect(validateUrl("file:///etc/passwd")).rejects.toThrow(
      "Only http: and https: schemes are allowed.",
    );
  });

  test("rejects private IP addresses", async () => {
    await expect(validateUrl("http://192.168.1.1")).rejects.toThrow(
      "potentially dangerous",
    );
  });

  test("rejects the IPv4 loopback address", async () => {
    await expect(validateUrl("http://127.0.0.1")).rejects.toThrow(
      "potentially dangerous",
    );
  });

  test("rejects link-local addresses", async () => {
    await expect(validateUrl("http://169.254.169.254")).rejects.toThrow(
      "potentially dangerous",
    );
  });

  test.each([
    "http://localhost/",
    "http://LOCALHOST./",
    "http://app.localhost/",
    "http://metadata/",
    "http://metadata.google.internal/",
    "http://[::1]/",
    "http://[::]/",
    "http://0.0.0.0/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:169.254.169.254]/",
    "http://[fd00::1]/",
    "http://[fc00::1]/",
    "http://[fe80::1]/",
    "http://2130706433/", // 127.0.0.1 in decimal
    "http://[::127.0.0.1]/", // IPv4-compatible
    "http://[::7f00:1]/",
    "http://[::a9fe:a9fe]/", // 169.254.169.254
    "http://[fec0::1]/", // site-local
    "http://[64:ff9b::7f00:1]/", // NAT64 of 127.0.0.1
    "http://[64:ff9b::169.254.169.254]/",
    "http://[::ffff:0:7f00:1]/", // IPv4-translated (SIIT) 127.0.0.1
    "http://[::ffff:0:a9fe:a9fe]/",
    // Local-use NAT64 64:ff9b:1::/48 is rejected outright (RFC 8215 section 5):
    "http://[64:ff9b:1::7f00:1]/", // /96 placement of 127.0.0.1
    "http://[64:ff9b:1::a9fe:a9fe]/",
    "http://[64:ff9b:1::808:808]/", // /96 placement of public 8.8.8.8
    "http://[64:ff9b:1:808:8:800:0:0]/", // /48 placement of 8.8.8.8
    "http://[64:ff9b:1:7f00:0:100:808:808]/", // /48 placement of 127.0.0.1, nonzero suffix
    "http://[64:ff9b:1:7f00:0:100::]/", // /48 placement of 127.0.0.1
    "http://[64:ff9b:1:0:7f:0:100:0]/", // /64 placement of 127.0.0.1
  ])("rejects %s", async (url) => {
    await expect(validateUrl(url)).rejects.toThrow("potentially dangerous");
  });

  test("accepts NAT64, IPv4-translated and IPv4-mapped forms of public addresses", async () => {
    await expect(validateUrl("http://[64:ff9b::808:808]/")).resolves.toBeUndefined();
    await expect(validateUrl("http://[::ffff:0:808:808]/")).resolves.toBeUndefined();
    await expect(validateUrl("http://[::ffff:8.8.8.8]/")).resolves.toBeUndefined();
  });

  test("rejects URLs with embedded credentials without echoing them", async () => {
    for (const url of [
      "http://admin:s3cret@127.0.0.1/?token=abc",
      "https://user@example.com/",
      "https://:pw@example.com/",
    ]) {
      const error = await validateUrl(url).catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "URLs with embedded credentials are not allowed.",
      );
    }
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  test("names only origin and path in the rejection message", async () => {
    const error = await validateUrl(
      "http://127.0.0.1/admin/reset?token=abc#frag",
    ).catch((e: Error) => e);
    expect((error as Error).message).toBe(
      "Fetching http://127.0.0.1/admin/reset is potentially dangerous, aborting.",
    );
  });

  test("rejects hostnames that resolve to a private address", async () => {
    lookupSpy.mockResolvedValue([{ address: "127.0.0.1", family: 4 }] as any);
    await expect(validateUrl("http://127.0.0.1.nip.io/")).rejects.toThrow(
      "potentially dangerous",
    );
  });

  test("rejects hostnames where any resolved address is private", async () => {
    lookupSpy.mockResolvedValue([
      { address: "93.184.215.14", family: 4 },
      { address: "::ffff:10.0.0.1", family: 6 },
    ] as any);
    await expect(validateUrl("https://example.com/")).rejects.toThrow(
      "potentially dangerous",
    );
  });

  test("rejects hostnames that fail to resolve", async () => {
    lookupSpy.mockRejectedValue(
      Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }),
    );
    await expect(validateUrl("https://does-not-exist.example/")).rejects.toThrow(
      "potentially dangerous",
    );
  });

  test("throws on invalid URLs", async () => {
    await expect(validateUrl("not-a-url")).rejects.toThrow();
  });
});

describe("redactUrl", () => {
  test("keeps origin and path, drops userinfo, query and fragment", () => {
    expect(
      redactUrl("https://u:p@bucket.example.com:8443/a/b.pdf?X-Amz-Signature=x#f"),
    ).toBe("https://bucket.example.com:8443/a/b.pdf");
  });

  test("does not echo unparseable input", () => {
    expect(redactUrl("not a url?token=abc")).toBe("<invalid URL>");
  });
});

describe("isUnconvertedHtml", () => {
  test("detects DOCTYPE html", () => {
    expect(isUnconvertedHtml("<!DOCTYPE html><html>...</html>")).toBe(true);
  });

  test("detects html tag", () => {
    expect(isUnconvertedHtml("<html lang='en'>...</html>")).toBe(true);
  });

  test("detects html with leading whitespace", () => {
    expect(isUnconvertedHtml("  \n<!DOCTYPE html>")).toBe(true);
  });

  test("returns false for markdown content", () => {
    expect(isUnconvertedHtml("# Hello World\n\nSome text")).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(isUnconvertedHtml("")).toBe(false);
  });

  test("returns false for plain text", () => {
    expect(isUnconvertedHtml("Just some plain text")).toBe(false);
  });
});

describe("inferExtensionFromUrl", () => {
  test("returns pdf for .pdf URLs", () => {
    expect(inferExtensionFromUrl("https://example.com/doc.pdf")).toBe("pdf");
  });

  test("returns html for non-pdf URLs", () => {
    expect(inferExtensionFromUrl("https://example.com/page")).toBe("html");
  });

  test("returns html for .html URLs", () => {
    expect(inferExtensionFromUrl("https://example.com/page.html")).toBe("html");
  });
});

describe("isMarkdownFile", () => {
  test("accepts .md files", () => {
    expect(isMarkdownFile("/path/to/file.md")).toBe(true);
  });

  test("accepts .markdown files", () => {
    expect(isMarkdownFile("/path/to/file.markdown")).toBe(true);
  });

  test("rejects .txt files", () => {
    expect(isMarkdownFile("/path/to/file.txt")).toBe(false);
  });

  test("rejects .pdf files", () => {
    expect(isMarkdownFile("/path/to/file.pdf")).toBe(false);
  });

  test("rejects files without extension", () => {
    expect(isMarkdownFile("/path/to/file")).toBe(false);
  });
});

describe("isWithinDirectory", () => {
  test("returns true for file inside directory", () => {
    expect(isWithinDirectory("/home/user/docs/file.md", "/home/user/docs")).toBe(
      true,
    );
  });

  test("returns true for file in subdirectory", () => {
    expect(
      isWithinDirectory("/home/user/docs/sub/file.md", "/home/user/docs"),
    ).toBe(true);
  });

  test("returns false for file outside directory", () => {
    expect(isWithinDirectory("/home/user/other/file.md", "/home/user/docs")).toBe(
      false,
    );
  });

  test("returns false for path traversal attempt", () => {
    expect(
      isWithinDirectory("/home/user/docs/../other/file.md", "/home/user/docs"),
    ).toBe(false);
  });

  test("returns false for a sibling sharing the directory name as a prefix", () => {
    expect(isWithinDirectory("/tmp/a/share-evil/f.pdf", "/tmp/a/share")).toBe(
      false,
    );
    expect(isWithinDirectory("/tmp/a/sharex", "/tmp/a/share")).toBe(false);
  });

  test("returns true for the directory itself", () => {
    expect(isWithinDirectory("/tmp/a/share", "/tmp/a/share")).toBe(true);
  });

  test("returns true for a child whose name starts with two dots", () => {
    expect(isWithinDirectory("/tmp/a/share/..f", "/tmp/a/share")).toBe(true);
  });

  test("accepts a directory given with a trailing separator", () => {
    expect(isWithinDirectory("/tmp/a/share/f.pdf", "/tmp/a/share/")).toBe(
      true,
    );
    expect(isWithinDirectory("/tmp/a/share-evil/f.pdf", "/tmp/a/share/")).toBe(
      false,
    );
  });

  test("treats / as containing every absolute path", () => {
    expect(isWithinDirectory("/etc/passwd", "/")).toBe(true);
  });
});

describe("validateRepoUrl", () => {
  test("accepts GitHub shorthand", () => {
    expect(() => validateRepoUrl("octocat/Hello-World")).not.toThrow();
  });

  test("accepts full GitHub URL", () => {
    expect(() =>
      validateRepoUrl("https://github.com/octocat/Hello-World"),
    ).not.toThrow();
  });

  test("rejects empty string", () => {
    expect(() => validateRepoUrl("")).toThrow("Repository URL is required");
  });

  test("rejects whitespace-only string", () => {
    expect(() => validateRepoUrl("   ")).toThrow("Repository URL is required");
  });

  test("rejects shell metacharacters", () => {
    expect(() => validateRepoUrl("owner/repo; rm -rf /")).toThrow(
      "Invalid repository URL or shorthand",
    );
  });

  test("rejects flag injection", () => {
    expect(() => validateRepoUrl("--help")).toThrow(
      "Invalid repository URL or shorthand",
    );
  });

  test("rejects file:// URLs", () => {
    expect(() => validateRepoUrl("file:///etc/passwd")).toThrow(
      "Only http: and https: repository URLs are allowed",
    );
  });

  test("rejects ssh:// URLs", () => {
    expect(() => validateRepoUrl("ssh://git@github.com/owner/repo")).toThrow(
      "Only http: and https: repository URLs are allowed",
    );
  });
});

describe("resolveMarkitdownPath", () => {
  const savedEnv = process.env.MARKITDOWN_PATH;

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.MARKITDOWN_PATH;
    else process.env.MARKITDOWN_PATH = savedEnv;
  });

  test("honors MARKITDOWN_PATH env var", () => {
    process.env.MARKITDOWN_PATH = "/opt/markitdown/bin/markitdown";
    expect(resolveMarkitdownPath("/anywhere")).toBe(
      "/opt/markitdown/bin/markitdown",
    );
  });

  test("falls back to PATH lookup when no venv exists", () => {
    delete process.env.MARKITDOWN_PATH;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mdfy-"));
    try {
      expect(resolveMarkitdownPath(tmp)).toBe("markitdown");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("uses project venv when present", () => {
    delete process.env.MARKITDOWN_PATH;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mdfy-"));
    const isWin = process.platform === "win32";
    const binDir = path.join(tmp, ".venv", isWin ? "Scripts" : "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const expected = path.join(
      binDir,
      `markitdown${isWin ? ".exe" : ""}`,
    );
    fs.writeFileSync(expected, "");
    try {
      expect(resolveMarkitdownPath(tmp)).toBe(expected);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("resolveRepomixPath", () => {
  const savedEnv = process.env.REPOMIX_PATH;

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.REPOMIX_PATH;
    else process.env.REPOMIX_PATH = savedEnv;
  });

  test("honors REPOMIX_PATH env var", () => {
    process.env.REPOMIX_PATH = "/opt/repomix/bin/repomix";
    expect(resolveRepomixPath("/anywhere")).toBe("/opt/repomix/bin/repomix");
  });

  test("falls back to PATH lookup when bundled not present", () => {
    delete process.env.REPOMIX_PATH;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mdfy-"));
    try {
      expect(resolveRepomixPath(tmp)).toBe("repomix");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("getAllowedPaths / assertPathAllowed", () => {
  const savedAllowed = process.env.MD_ALLOWED_PATHS;
  const savedShare = process.env.MD_SHARE_DIR;

  beforeEach(() => {
    delete process.env.MD_ALLOWED_PATHS;
    delete process.env.MD_SHARE_DIR;
  });

  afterEach(() => {
    if (savedAllowed === undefined) delete process.env.MD_ALLOWED_PATHS;
    else process.env.MD_ALLOWED_PATHS = savedAllowed;
    if (savedShare === undefined) delete process.env.MD_SHARE_DIR;
    else process.env.MD_SHARE_DIR = savedShare;
  });

  test("returns null when no env var set (unrestricted)", () => {
    expect(getAllowedPaths()).toBeNull();
  });

  test("parses MD_ALLOWED_PATHS as delimiter-separated list", () => {
    process.env.MD_ALLOWED_PATHS = ["/tmp/a", "/tmp/b"].join(path.delimiter);
    const allowed = getAllowedPaths();
    expect(allowed).toEqual(["/tmp/a", "/tmp/b"].map((p) => path.resolve(p)));
  });

  test("falls back to MD_SHARE_DIR for backward compatibility", () => {
    process.env.MD_SHARE_DIR = "/tmp/legacy";
    expect(getAllowedPaths()).toEqual([path.resolve("/tmp/legacy")]);
  });

  test("MD_ALLOWED_PATHS takes precedence over MD_SHARE_DIR", () => {
    process.env.MD_ALLOWED_PATHS = "/tmp/new";
    process.env.MD_SHARE_DIR = "/tmp/legacy";
    expect(getAllowedPaths()).toEqual([path.resolve("/tmp/new")]);
  });

  test("expands ~ in allowed paths", () => {
    process.env.MD_ALLOWED_PATHS = "~/docs";
    expect(getAllowedPaths()).toEqual([path.join(os.homedir(), "docs")]);
  });

  test("ignores empty entries", () => {
    process.env.MD_ALLOWED_PATHS = `/tmp/a${path.delimiter}${path.delimiter}/tmp/b`;
    expect(getAllowedPaths()?.length).toBe(2);
  });

  test("assertPathAllowed is no-op when unrestricted", () => {
    expect(() => assertPathAllowed("/etc/passwd")).not.toThrow();
  });

  test("assertPathAllowed permits files inside an allowed dir", () => {
    process.env.MD_ALLOWED_PATHS = "/tmp/allowed";
    expect(() =>
      assertPathAllowed("/tmp/allowed/sub/file.pdf"),
    ).not.toThrow();
  });

  test("assertPathAllowed rejects files outside allowed dirs", () => {
    process.env.MD_ALLOWED_PATHS = "/tmp/allowed";
    expect(() => assertPathAllowed("/etc/passwd")).toThrow(
      "outside the allowed directories",
    );
  });

  test("assertPathAllowed rejects path traversal escapes", () => {
    process.env.MD_ALLOWED_PATHS = "/tmp/allowed";
    expect(() =>
      assertPathAllowed("/tmp/allowed/../etc/passwd"),
    ).toThrow("outside the allowed directories");
  });

  test("assertPathAllowed rejects siblings that share the allowed prefix", () => {
    process.env.MD_ALLOWED_PATHS = "/tmp/a/share";
    expect(() => assertPathAllowed("/tmp/a/share-evil/f.pdf")).toThrow(
      "outside the allowed directories",
    );
    expect(() => assertPathAllowed("/tmp/a/sharex")).toThrow(
      "outside the allowed directories",
    );
  });

  test("assertPathAllowed permits the allowed dir and its descendants", () => {
    process.env.MD_ALLOWED_PATHS = "/tmp/a/share";
    expect(() => assertPathAllowed("/tmp/a/share")).not.toThrow();
    expect(() => assertPathAllowed("/tmp/a/share/sub/f")).not.toThrow();
  });

  test("assertPathAllowed accepts an allowed dir with a trailing separator", () => {
    process.env.MD_ALLOWED_PATHS = `/tmp/a/share${path.sep}`;
    expect(() => assertPathAllowed("/tmp/a/share/f.pdf")).not.toThrow();
    expect(() => assertPathAllowed("/tmp/a/share-evil/f.pdf")).toThrow(
      "outside the allowed directories",
    );
  });

  test("assertPathAllowed treats / as an allow-everything root", () => {
    process.env.MD_ALLOWED_PATHS = "/";
    expect(() => assertPathAllowed("/etc/passwd")).not.toThrow();
  });

  describe("with symlinks", () => {
    let tmp: string;
    let allowedDir: string;
    let outsideDir: string;

    beforeEach(() => {
      tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mdfy-")));
      allowedDir = path.join(tmp, "allowed");
      outsideDir = path.join(tmp, "outside");
      fs.mkdirSync(allowedDir);
      fs.mkdirSync(outsideDir);
      fs.writeFileSync(path.join(allowedDir, "inside.pdf"), "");
      fs.writeFileSync(path.join(outsideDir, "secret.pdf"), "");
      process.env.MD_ALLOWED_PATHS = allowedDir;
    });

    afterEach(() => {
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    test("rejects a symlink inside the allowed dir pointing outside it", () => {
      const link = path.join(allowedDir, "link.pdf");
      fs.symlinkSync(path.join(outsideDir, "secret.pdf"), link);
      expect(() => assertPathAllowed(link)).toThrow(
        "outside the allowed directories",
      );
    });

    test("rejects a not-yet-existing file under a symlinked dir pointing outside", () => {
      const dirLink = path.join(allowedDir, "escape");
      fs.symlinkSync(outsideDir, dirLink);
      expect(() => assertPathAllowed(path.join(dirLink, "new.pdf"))).toThrow(
        "outside the allowed directories",
      );
    });

    test("accepts a symlink pointing to a file inside the allowed dir", () => {
      const link = path.join(allowedDir, "alias.pdf");
      fs.symlinkSync(path.join(allowedDir, "inside.pdf"), link);
      expect(() => assertPathAllowed(link)).not.toThrow();
    });

    test("accepts files when the allowed dir itself is reached via a symlink", () => {
      const allowedLink = path.join(tmp, "allowed-link");
      fs.symlinkSync(allowedDir, allowedLink);
      process.env.MD_ALLOWED_PATHS = allowedLink;
      expect(() =>
        assertPathAllowed(path.join(allowedDir, "inside.pdf")),
      ).not.toThrow();
    });
  });
});

describe("opened-file validation", () => {
  const savedAllowed = process.env.MD_ALLOWED_PATHS;
  const savedShare = process.env.MD_SHARE_DIR;
  let tmp: string;
  let allowedDir: string;
  let outsideDir: string;
  let target: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mdfy-open-")));
    allowedDir = path.join(tmp, "allowed");
    outsideDir = path.join(tmp, "outside");
    fs.mkdirSync(path.join(allowedDir, "sub"), { recursive: true });
    fs.mkdirSync(path.join(outsideDir, "sub"), { recursive: true });
    target = path.join(allowedDir, "sub", "doc.txt");
    fs.writeFileSync(target, "inside");
    fs.writeFileSync(path.join(outsideDir, "sub", "doc.txt"), "outside");
    delete process.env.MD_SHARE_DIR;
    process.env.MD_ALLOWED_PATHS = allowedDir;
  });

  afterEach(() => {
    if (savedAllowed === undefined) delete process.env.MD_ALLOWED_PATHS;
    else process.env.MD_ALLOWED_PATHS = savedAllowed;
    if (savedShare === undefined) delete process.env.MD_SHARE_DIR;
    else process.env.MD_SHARE_DIR = savedShare;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const withOpened = async <T>(fn: (h: fs.promises.FileHandle, st: fs.BigIntStats) => Promise<T>) => {
    const handle = await fs.promises.open(target, "r");
    try {
      return await fn(handle, await handle.stat({ bigint: true }));
    } finally {
      await handle.close();
    }
  };

  test("assertRealPathAllowed uses the same message as assertPathAllowed", () => {
    expect(() => assertRealPathAllowed(path.join(outsideDir, "x"), "shown.pdf")).toThrow(
      'Path "shown.pdf" is outside the allowed directories.',
    );
    expect(() => assertRealPathAllowed(target, "shown.pdf")).not.toThrow();
  });

  for (const useProcFd of [false, true]) {
    const run = useProcFd ? test.skipIf(process.platform !== "linux") : test;
    const label = useProcFd ? "/proc/self/fd" : "dev/ino fallback";

    run(`${label}: returns the real path of an unchanged file`, async () => {
      const real = await withOpened((h, st) => resolveOpenedFile(h, target, st, { useProcFd }));
      expect(real).toBe(target);
    });

    run(`${label}: an ancestor moved out of the allowed tree after open is caught`, async () => {
      const result = await withOpened(async (h, st) => {
        // Move the opened file's directory outside, and plant an innocent
        // replacement at the old path.
        fs.renameSync(path.join(allowedDir, "sub"), path.join(outsideDir, "moved"));
        fs.mkdirSync(path.join(allowedDir, "sub"));
        fs.writeFileSync(target, "replacement");
        try {
          const real = await resolveOpenedFile(h, target, st, { useProcFd });
          assertRealPathAllowed(real, target);
          return "accepted";
        } catch (e) {
          return (e as Error).message;
        }
      });
      expect(result).toMatch(
        useProcFd ? /outside the allowed directories/ : /changed while it was being opened/,
      );
    });
  }

  test("dev/ino fallback: an ancestor swapped for a symlink outside is caught", async () => {
    const handle = await fs.promises.open(path.join(outsideDir, "sub", "doc.txt"), "r");
    try {
      // The handle points outside; the path now resolves outside too, so the
      // re-resolved real path is outside and fails the allowlist.
      fs.rmSync(path.join(allowedDir, "sub"), { recursive: true });
      fs.symlinkSync(path.join(outsideDir, "sub"), path.join(allowedDir, "sub"));
      const st = await handle.stat({ bigint: true });
      const real = await resolveOpenedFile(handle, target, st, { useProcFd: false });
      expect(() => assertRealPathAllowed(real, target)).toThrow(
        "outside the allowed directories",
      );
    } finally {
      await handle.close();
    }
  });

  test("openLocalFile returns a handle and size for an allowed file", async () => {
    const { handle, size } = await openLocalFile(target);
    try {
      expect(size).toBe(6);
      expect(await handle.readFile("utf-8")).toBe("inside");
    } finally {
      await handle.close();
    }
  });

  test("openLocalFile reports a missing file with ENOENT", async () => {
    await expect(openLocalFile(path.join(allowedDir, "missing.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("openLocalFile without an allowlist opens any regular file but not a directory", async () => {
    delete process.env.MD_ALLOWED_PATHS;
    const { handle } = await openLocalFile(path.join(outsideDir, "sub", "doc.txt"));
    await handle.close();
    await expect(openLocalFile(outsideDir)).rejects.toThrow("is not a regular file");
  });
});
