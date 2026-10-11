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
  validateGitRef,
  gitRefProblem,
  getAllowedGitHosts,
  DEFAULT_GIT_HOSTS,
  MAX_GIT_REF_LENGTH,
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
  readOpenedFile,
  resolveOpenedFile,
  redactUrl,
  MAX_LOCAL_FILE_BYTES,
} from "./utils";
import dns from "node:dns";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// Symlink, FIFO and device-node tests need POSIX semantics. On Windows
// creating a symlink needs a privilege, there is no O_NOFOLLOW, and a
// directory that holds an open file cannot be renamed.
const posixOnly = test.skipIf(process.platform === "win32");

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
  test("matches doctype and html tags in any letter case", () => {
    expect(isUnconvertedHtml("<!doctype html><html></html>")).toBe(true);
    expect(isUnconvertedHtml("<!DocType html>")).toBe(true);
    expect(isUnconvertedHtml("<HTML><BODY>x</BODY></HTML>")).toBe(true);
    expect(isUnconvertedHtml("\n  <Html lang='en'>")).toBe(true);
  });

  test("does not match Markdown that merely mentions html", () => {
    expect(isUnconvertedHtml("html is a markup language")).toBe(false);
    expect(isUnconvertedHtml("`<html>` starts a document")).toBe(false);
  });
});

describe("inferExtensionFromUrl", () => {
  test("returns pdf for .pdf URLs", () => {
    expect(inferExtensionFromUrl("https://example.com/doc.pdf")).toBe("pdf");
  });

  test("returns html for non-pdf URLs", () => {
    expect(inferExtensionFromUrl("https://example.com/page")).toBe("html");
  });

  test("ignores the query string and fragment", () => {
    expect(inferExtensionFromUrl("https://example.com/doc.pdf?dl=1")).toBe("pdf");
    expect(inferExtensionFromUrl("https://example.com/doc.pdf#page=2")).toBe("pdf");
    expect(inferExtensionFromUrl("https://example.com/page?file=x.pdf")).toBe("html");
    expect(inferExtensionFromUrl("https://example.com/page#x.pdf")).toBe("html");
  });

  test("matches .pdf in any letter case", () => {
    expect(inferExtensionFromUrl("https://example.com/DOC.PDF")).toBe("pdf");
    expect(inferExtensionFromUrl("https://example.com/doc.Pdf")).toBe("pdf");
  });

  test("returns html for a string that is not a URL", () => {
    expect(inferExtensionFromUrl("not a url.pdf")).toBe("html");
  });

  test("returns html for .html URLs", () => {
    expect(inferExtensionFromUrl("https://example.com/page.html")).toBe("html");
  });
});

describe("isMarkdownFile", () => {
  test("accepts upper- and mixed-case extensions", () => {
    expect(isMarkdownFile("/path/to/README.MD")).toBe(true);
    expect(isMarkdownFile("/path/to/notes.Markdown")).toBe(true);
    expect(isMarkdownFile("/path/to/notes.mD")).toBe(true);
  });

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

describe("validateGitRef", () => {
  const valid = [
    "main",
    "refs/heads/ok",
    "feature/x-1",
    "v1.2.3",
    "release-2024.01",
    "a1b2c3d",
    "0123456789abcdef0123456789abcdef01234567",
    "x".repeat(MAX_GIT_REF_LENGTH),
  ];
  for (const ref of valid) {
    test(`accepts ${JSON.stringify(ref.length > 40 ? `${ref.slice(0, 20)}...` : ref)}`, () => {
      expect(gitRefProblem(ref)).toBeNull();
      expect(() => validateGitRef(ref)).not.toThrow();
    });
  }

  const invalid: [string, string][] = [
    ["--upload-pack=x", 'must not start with "-"'],
    ["--upload-pack=touch /tmp/pwned", 'must not start with "-"'],
    ["-x", 'must not start with "-"'],
    ["a b", "spaces or control characters"],
    ["a\tb", "spaces or control characters"],
    ["a\nb", "spaces or control characters"],
    ["a\x7fb", "spaces or control characters"],
    ["a..b", '".."'],
    ["a@{1}", '"@{"'],
    ["@", 'must not be "@"'],
    ["a\\b", '"\\"'],
    ["a~1", '"~"'],
    ["a^", '"^"'],
    ["a:b", '":"'],
    ["a?", '"?"'],
    ["a*", '"*"'],
    ["a[b", '"["'],
    [".hidden", 'starting with "."'],
    ["refs/.hidden", 'starting with "."'],
    ["topic.lock", '".lock"'],
    ["refs/x.lock/y", '".lock"'],
    ["trailing/", 'must not end with "/"'],
    ["trailing.", 'must not end with "."'],
    ["a//b", '"//"'],
    ["/abs", '"//" or start with "/"'],
    ["", "must not be empty"],
    ["x".repeat(MAX_GIT_REF_LENGTH + 1), `at most ${MAX_GIT_REF_LENGTH} characters`],
  ];
  for (const [ref, reason] of invalid) {
    test(`rejects ${JSON.stringify(ref.length > 40 ? `${ref.slice(0, 20)}... (${ref.length} chars)` : ref)}`, () => {
      expect(gitRefProblem(ref)).toContain(reason);
      expect(() => validateGitRef(ref)).toThrow(`Invalid git ref: Branch ${gitRefProblem(ref)}`);
    });
  }
});

describe("validateRepoUrl", () => {
  const savedHosts = process.env.MD_GIT_HOSTS;
  let lookupSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    delete process.env.MD_GIT_HOSTS;
    // Offline: every name resolves to a public address unless a test says otherwise.
    lookupSpy = spyOn(dns.promises, "lookup").mockResolvedValue([
      { address: "140.82.112.3", family: 4 },
    ] as any);
  });

  afterEach(() => {
    lookupSpy.mockRestore();
    if (savedHosts === undefined) delete process.env.MD_GIT_HOSTS;
    else process.env.MD_GIT_HOSTS = savedHosts;
  });

  test("accepts GitHub shorthand and checks github.com's addresses", async () => {
    await expect(validateRepoUrl("octocat/Hello-World")).resolves.toBeUndefined();
    expect(lookupSpy).toHaveBeenCalledWith("github.com", {
      all: true,
      verbatim: true,
    });
  });

  test("accepts full GitHub URL", async () => {
    await expect(
      validateRepoUrl("https://github.com/octocat/Hello-World"),
    ).resolves.toBeUndefined();
  });

  test("accepts the other default hosts and their www. forms", async () => {
    for (const url of [
      "https://gitlab.com/group/sub/project",
      "https://www.gitlab.com/group/project",
      "https://bitbucket.org/team/repo",
      "https://www.github.com/octocat/Hello-World",
      "https://GitHub.com/octocat/Hello-World",
    ]) {
      await expect(validateRepoUrl(url)).resolves.toBeUndefined();
    }
  });

  test("accepts an SSH address on an allowlisted host", async () => {
    await expect(
      validateRepoUrl("git@github.com:octocat/Hello-World.git"),
    ).resolves.toBeUndefined();
    expect(lookupSpy).toHaveBeenCalledWith("github.com", expect.anything());
  });

  test("rejects empty string", async () => {
    await expect(validateRepoUrl("")).rejects.toThrow("Repository URL is required");
  });

  test("rejects whitespace-only string", async () => {
    await expect(validateRepoUrl("   ")).rejects.toThrow("Repository URL is required");
  });

  test("rejects shell metacharacters", async () => {
    await expect(validateRepoUrl("owner/repo; rm -rf /")).rejects.toThrow(
      "Invalid repository URL or shorthand",
    );
  });

  test("rejects flag injection", async () => {
    await expect(validateRepoUrl("--help")).rejects.toThrow(
      "Invalid repository URL or shorthand",
    );
  });

  test("rejects file:// URLs", async () => {
    await expect(validateRepoUrl("file:///etc/passwd")).rejects.toThrow(
      "Only http: and https: repository URLs are allowed",
    );
  });

  test("rejects ssh:// and git:// URLs", async () => {
    await expect(validateRepoUrl("ssh://git@github.com/owner/repo")).rejects.toThrow(
      "Only http: and https: repository URLs are allowed",
    );
    await expect(validateRepoUrl("git://github.com/owner/repo")).rejects.toThrow(
      "Only http: and https: repository URLs are allowed",
    );
  });

  test("rejects an option smuggled in as the URL's branch", async () => {
    for (const url of [
      "https://github.com/a/b/tree/--upload-pack=x",
      "https://github.com/a/b/tree/--upload-pack=touch%20x",
      "https://github.com/a/b/blob/-x/README.md",
    ]) {
      await expect(validateRepoUrl(url)).rejects.toThrow(
        'Invalid git ref: The ref in the repository URL must not start with "-"',
      );
    }
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  test("accepts a valid branch embedded in the URL", async () => {
    await expect(
      validateRepoUrl("https://github.com/a/b/tree/main/src"),
    ).resolves.toBeUndefined();
  });

  test("rejects the cloud metadata address", async () => {
    await expect(
      validateRepoUrl("https://169.254.169.254/latest/meta-data"),
    ).rejects.toThrow('Repository host "169.254.169.254" is not allowed');
    process.env.MD_GIT_HOSTS = "*";
    await expect(
      validateRepoUrl("https://169.254.169.254/latest/meta-data"),
    ).rejects.toThrow('Repository host "169.254.169.254" resolves to a loopback, private');
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  test("rejects loopback addresses", async () => {
    await expect(validateRepoUrl("http://127.0.0.1/a/b")).rejects.toThrow(
      'Repository host "127.0.0.1" is not allowed',
    );
    process.env.MD_GIT_HOSTS = "*";
    for (const url of ["http://127.0.0.1/a/b", "https://[::1]/a/b", "http://localhost/a/b"]) {
      await expect(validateRepoUrl(url)).rejects.toThrow("resolves to a loopback, private");
    }
  });

  test("rejects a host that is not on the allowlist", async () => {
    await expect(validateRepoUrl("https://git.example.com/a/b")).rejects.toThrow(
      'Repository host "git.example.com" is not allowed. Allowed hosts: github.com, www.github.com',
    );
    await expect(validateRepoUrl("git@10.0.0.1:a/b.git")).rejects.toThrow(
      'Repository host "10.0.0.1" is not allowed',
    );
    // A subdomain of an allowed host is a different host.
    await expect(validateRepoUrl("https://evil.github.com/a/b")).rejects.toThrow(
      'Repository host "evil.github.com" is not allowed',
    );
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  test("checks the host a URL really names, not text before an @", async () => {
    await expect(
      validateRepoUrl("https://github.com@git.example.com/a/b"),
    ).rejects.toThrow('Repository host "git.example.com" is not allowed');
  });

  test("rejects an allowlisted host that resolves to a private address", async () => {
    lookupSpy.mockResolvedValue([
      { address: "140.82.112.3", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ] as any);
    await expect(validateRepoUrl("octocat/Hello-World")).rejects.toThrow(
      'Repository host "github.com" resolves to a loopback, private, link-local or metadata address',
    );
  });

  test("rejects an allowlisted host whose lookup fails", async () => {
    lookupSpy.mockRejectedValue(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
    await expect(validateRepoUrl("octocat/Hello-World")).rejects.toThrow(
      "could not be resolved",
    );
  });

  test("MD_GIT_HOSTS replaces the default allowlist", async () => {
    process.env.MD_GIT_HOSTS = " git.example.com , Code.Example.org. ";
    expect(getAllowedGitHosts()).toEqual(["git.example.com", "code.example.org"]);
    await expect(
      validateRepoUrl("https://git.example.com/team/repo"),
    ).resolves.toBeUndefined();
    await expect(
      validateRepoUrl("https://CODE.example.org/team/repo"),
    ).resolves.toBeUndefined();
    await expect(validateRepoUrl("git@git.example.com:team/repo.git")).resolves.toBeUndefined();
    await expect(validateRepoUrl("octocat/Hello-World")).rejects.toThrow(
      'Repository host "github.com" is not allowed. Allowed hosts: git.example.com, code.example.org',
    );
  });

  test("an empty MD_GIT_HOSTS means the defaults", () => {
    process.env.MD_GIT_HOSTS = "  , ";
    expect(getAllowedGitHosts()).toEqual(DEFAULT_GIT_HOSTS);
  });

  test('"*" allows any public http(s) host but no SSH addresses', async () => {
    process.env.MD_GIT_HOSTS = "*";
    expect(getAllowedGitHosts()).toBe("*");
    await expect(
      validateRepoUrl("https://git.example.com/team/repo"),
    ).resolves.toBeUndefined();
    await expect(validateRepoUrl("https://8.8.8.8/team/repo")).resolves.toBeUndefined();
    await expect(validateRepoUrl("git@git.example.com:team/repo.git")).rejects.toThrow(
      "SSH repository addresses (git@host:path) are allowed only for hosts listed in MD_GIT_HOSTS",
    );
    lookupSpy.mockResolvedValue([{ address: "192.168.1.10", family: 4 }] as any);
    await expect(
      validateRepoUrl("https://git.internal.example/team/repo"),
    ).rejects.toThrow('Repository host "git.internal.example" resolves to a loopback, private');
  });

  test("stops waiting for DNS when the signal aborts", async () => {
    lookupSpy.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = validateRepoUrl("octocat/Hello-World", controller.signal);
    controller.abort(new Error("deadline"));
    await expect(pending).rejects.toThrow("deadline");
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

  test("an empty MD_ALLOWED_PATHS counts as unset and falls back to MD_SHARE_DIR", () => {
    process.env.MD_SHARE_DIR = "/tmp/legacy";
    for (const value of ["", "  ", path.delimiter, ` ${path.delimiter} `]) {
      process.env.MD_ALLOWED_PATHS = value;
      expect(getAllowedPaths()).toEqual([path.resolve("/tmp/legacy")]);
    }
  });

  test("an empty MD_ALLOWED_PATHS without MD_SHARE_DIR means no allowlist", () => {
    for (const value of ["", "  "]) {
      process.env.MD_ALLOWED_PATHS = value;
      expect(getAllowedPaths()).toBeNull();
    }
  });

  test("an empty MD_ALLOWED_PATHS does not let a path escape MD_SHARE_DIR", () => {
    process.env.MD_SHARE_DIR = "/tmp/legacy";
    process.env.MD_ALLOWED_PATHS = "";
    expect(() => assertPathAllowed("/etc/passwd")).toThrow(
      "outside the allowed directories",
    );
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

  describe.skipIf(process.platform === "win32")("with symlinks", () => {
    let tmp: string;
    let allowedDir: string;
    let outsideDir: string;

    beforeEach(() => {
      tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "mdfy-")));
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
    // .native matches the realpath the code under test uses (on Windows it
    // also expands 8.3 short names such as RUNNER~1 in the temp directory).
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "mdfy-open-")));
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
    const runPosix = useProcFd ? run : posixOnly;
    const label = useProcFd ? "/proc/self/fd" : "dev/ino fallback";

    run(`${label}: returns the real path of an unchanged file`, async () => {
      const real = await withOpened((h, st) => resolveOpenedFile(h, target, st, { useProcFd }));
      expect(real).toBe(target);
    });

    runPosix(`${label}: an ancestor moved out of the allowed tree after open is caught`, async () => {
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

  test("dev/ino fallback: a path that names a different file is refused", async () => {
    // Platform-neutral form of a swap: the handle is one file, the path now
    // names another. Runs on Windows too, where the swap tests are skipped.
    const other = path.join(outsideDir, "sub", "doc.txt");
    await expect(
      withOpened((h, st) => resolveOpenedFile(h, other, st, { useProcFd: false })),
    ).rejects.toThrow("changed while it was being opened");
  });

  posixOnly("dev/ino fallback: an ancestor swapped for a symlink outside is caught", async () => {
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

  for (const mode of ["with", "without"] as const) {
    const setMode = () => {
      if (mode === "without") delete process.env.MD_ALLOWED_PATHS;
    };

    test(`openLocalFile ${mode} an allowlist enforces maxBytes on the fstat size`, async () => {
      setMode();
      const { handle, size } = await openLocalFile(target, { maxBytes: 6 });
      await handle.close();
      expect(size).toBe(6);
      await expect(openLocalFile(target, { maxBytes: 5 })).rejects.toThrow(
        `File "${target}" exceeds the 5-byte limit for local files.`,
      );
    });

    test(`openLocalFile ${mode} an allowlist refuses a file over MAX_LOCAL_FILE_BYTES`, async () => {
      setMode();
      // Sparse: no 50 MiB of data is written.
      fs.truncateSync(target, MAX_LOCAL_FILE_BYTES + 1);
      await expect(openLocalFile(target)).rejects.toThrow(
        "exceeds the 52428800-byte (50 MiB) limit for local files",
      );
    });

    posixOnly(`openLocalFile ${mode} an allowlist never opens a FIFO or device node`, async () => {
      setMode();
      const fifo = path.join(allowedDir, "pipe.txt");
      execFileSync("mkfifo", [fifo]);
      // /dev/null stands in for a device node inside an allowed directory.
      if (mode === "with") {
        process.env.MD_ALLOWED_PATHS = [allowedDir, "/dev"].join(path.delimiter);
      }
      const devLink = path.join(allowedDir, "null.txt");
      fs.symlinkSync("/dev/null", devLink);
      const openSpy = spyOn(fs.promises, "open");
      try {
        for (const p of [fifo, "/dev/null"]) {
          await expect(openLocalFile(p)).rejects.toThrow("is not a regular file");
        }
        // A symlink to a device is followed by the pre-filter (with an
        // allowlist the realpath, /dev/null, is what gets checked).
        await expect(openLocalFile(devLink)).rejects.toThrow("is not a regular file");
        expect(openSpy).not.toHaveBeenCalled();
      } finally {
        openSpy.mockRestore();
      }
    });
  }

  test("readOpenedFile stops once more than maxBytes have been read", async () => {
    const read = (maxBytes: number) =>
      withOpened(async (h) => {
        const chunks: Buffer[] = [];
        for await (const chunk of readOpenedFile(h, "shown.txt", maxBytes)) chunks.push(chunk);
        return Buffer.concat(chunks).toString();
      });
    expect(await read(6)).toBe("inside");
    // fstat said 6 bytes; the file then grew. The limit applies to what is read.
    await expect(read(5)).rejects.toThrow('File "shown.txt" exceeds the 5-byte limit');
  });
});
