import {
  expect,
  test,
  describe,
  mock,
  spyOn,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "bun:test";
import { Markdownify, MarkdownResult } from "./Markdownify";
import { download } from "./download";
import dns from "node:dns";
import fs from "fs";
import path from "path";
import os from "os";

const sampleDataDir = path.join(__dirname, "sample-data");
const tempDir = os.tmpdir();

beforeAll(() => {
  // Ensure the sample data directory exists
  if (!fs.existsSync(sampleDataDir)) {
    throw new Error("Sample data directory not found");
  }
});

afterAll(() => {
  // Clean up any temporary files created during tests
  const tempFiles = fs.readdirSync(tempDir);
  tempFiles.forEach((file) => {
    if (file.startsWith("markdown_output_")) {
      fs.unlinkSync(path.join(tempDir, file));
    }
  });
});

test("Markdownify.toMarkdown converts PDF file to Markdown", async () => {
  const pdfPath = path.join(sampleDataDir, "test.pdf");
  const result = await Markdownify.toMarkdown({ filePath: pdfPath });

  expect(result).toBeDefined();
  expect(result.text).toContain("Test PDF content");
});

test("Markdownify.toMarkdown converts DOCX file to Markdown", async () => {
  const docxPath = path.join(sampleDataDir, "test.docx");
  const result = await Markdownify.toMarkdown({ filePath: docxPath });

  expect(result).toBeDefined();
  expect(result.text).toContain("Test DOCX content");
});

test("Markdownify.toMarkdown converts XLSX file to Markdown", async () => {
  const xlsxPath = path.join(sampleDataDir, "test.xlsx");
  const result = await Markdownify.toMarkdown({ filePath: xlsxPath });

  expect(result).toBeDefined();
  expect(result.text).toContain("Test XLSX content");
});

test("Markdownify.toMarkdown converts PPTX file to Markdown", async () => {
  const pptxPath = path.join(sampleDataDir, "test.pptx");
  const result = await Markdownify.toMarkdown({ filePath: pptxPath });

  expect(result).toBeDefined();
  expect(result.text).toContain("Test PPTX content");
});

test("Markdownify.toMarkdown converts image file to Markdown", async () => {
  const imagePath = path.join(sampleDataDir, "test.jpg");
  const result = await Markdownify.toMarkdown({ filePath: imagePath });

  expect(result).toBeDefined();
  // markitdown returns only whitespace for images without LLM vision config
  expect(result.text.trim()).toBe("");
});

test("Markdownify.toMarkdown converts URL content to Markdown", async () => {
  const testUrl = "https://example.com";
  const html = "<h1>Example Domain</h1>";
  const mockFetch = mock(() => Promise.resolve(new Response(html)));
  const original = download.fetch;
  download.fetch = mockFetch as any;
  const lookupSpy = spyOn(dns.promises, "lookup").mockResolvedValue([
    { address: "93.184.215.14", family: 4 },
  ] as any);

  try {
    const result = await Markdownify.toMarkdown({ url: testUrl });

    expect(result).toBeDefined();
    expect(result.text).toContain("# Example Domain");
  } finally {
    download.fetch = original;
    lookupSpy.mockRestore();
  }
});

describe("Markdownify.safeFetch", () => {
  const safeFetch = (url: string) => Markdownify["safeFetch"](url);
  let lookupSpy: ReturnType<typeof spyOn>;
  let originalFetch: typeof download.fetch;

  // Install a fresh fetch stub per test (rather than spying on whatever an
  // earlier test left in global.fetch) and put the previous one back after.
  const stubFetch = (impl: (url: string) => Promise<Response>) => {
    const stub = mock(impl);
    download.fetch = stub as unknown as typeof download.fetch;
    return stub;
  };

  beforeEach(() => {
    originalFetch = download.fetch;
    lookupSpy = spyOn(dns.promises, "lookup").mockResolvedValue([
      { address: "93.184.215.14", family: 4 },
    ] as any);
  });

  afterEach(() => {
    download.fetch = originalFetch;
    lookupSpy.mockRestore();
  });

  const redirect = (location?: string) =>
    new Response(null, {
      status: 302,
      headers: location ? { location } : {},
    });

  test("rejects a redirect to the cloud metadata address", async () => {
    const fetchStub = stubFetch(async () =>
      redirect("http://169.254.169.254/latest/meta-data/"),
    );
    await expect(safeFetch("https://example.com/")).rejects.toThrow(
      "potentially dangerous",
    );
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  test("follows up to 10 redirects", async () => {
    let calls = 0;
    const fetchStub = stubFetch(async () =>
      ++calls <= 10 ? redirect(`/hop-${calls}`) : new Response("ok"),
    );
    const response = await safeFetch("https://example.com/");
    expect(await response.text()).toBe("ok");
    expect(fetchStub).toHaveBeenCalledTimes(11);
  });

  test("gives up after too many redirects", async () => {
    const fetchStub = stubFetch(async () => redirect("/again"));
    await expect(safeFetch("https://example.com/")).rejects.toThrow(
      "Too many redirects",
    );
    expect(fetchStub).toHaveBeenCalledTimes(11);
  });

  test("resolves a relative Location against the current URL", async () => {
    const fetchStub = stubFetch(async (url) =>
      url === "https://example.com/a/b"
        ? redirect("../c?x=1")
        : new Response("done"),
    );
    await safeFetch("https://example.com/a/b");
    expect(fetchStub.mock.calls.map((call) => call[0])).toEqual([
      "https://example.com/a/b",
      "https://example.com/c?x=1",
    ]);
  });

  test("returns a 3xx response without a Location header as-is", async () => {
    stubFetch(async () => redirect());
    const response = await safeFetch("https://example.com/");
    expect(response.status).toBe(302);
  });

  test("throws on an HTTP error status", async () => {
    stubFetch(
      async () =>
        new Response("boom", {
          status: 500,
          statusText: "Internal Server Error",
        }),
    );
    await expect(safeFetch("https://example.com/")).rejects.toThrow(
      "failed with HTTP 500 Internal Server Error",
    );
  });

  test("does not echo a redirect target's query string in HTTP errors", async () => {
    stubFetch(async (url) =>
      url === "https://example.com/file"
        ? redirect("https://bucket.example.com/f.pdf?X-Amz-Signature=secret")
        : new Response("denied", { status: 403, statusText: "Forbidden" }),
    );
    const error = await safeFetch("https://example.com/file").catch(
      (e: Error) => e,
    );
    expect((error as Error).message).toBe(
      "Fetching https://bucket.example.com/f.pdf failed with HTTP 403 Forbidden",
    );
  });

  test("rejects a redirect to a URL with embedded credentials", async () => {
    stubFetch(async () => redirect("https://admin:pw@example.com/"));
    await expect(safeFetch("https://example.com/")).rejects.toThrow(
      "URLs with embedded credentials are not allowed.",
    );
  });

  test("passes validated addresses and a deadline to the pinned transport", async () => {
    const fetchStub = stubFetch(async () => new Response("ok"));
    await safeFetch("https://example.com/");
    const args = fetchStub.mock.calls[0] as unknown[];
    expect(args[1]).toEqual([{ address: "93.184.215.14", family: 4 }]);
    expect(args[2]).toBeInstanceOf(AbortSignal);
    expect(lookupSpy).toHaveBeenCalledTimes(1);
  });
  test("hung DNS lookup stops at the whole-exchange deadline without connecting", async () => {
    lookupSpy.mockImplementation(() => new Promise(() => {}));
    const fetchStub = stubFetch(async () => new Response("unexpected"));
    const start = performance.now();
    await expect(Markdownify["safeFetch"]("https://example.com", 10, 20)).rejects.toThrow();
    expect(performance.now() - start).toBeLessThan(1000);
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe("Markdownify.readBodyWithLimit", () => {
  const readBodyWithLimit = (response: Response, maxBytes?: number) =>
    Markdownify["readBodyWithLimit"](response, maxBytes);

  test("returns the body when it fits", async () => {
    const body = await readBodyWithLimit(new Response("hello"), 5);
    expect(body.toString()).toBe("hello");
  });

  test("rejects a declared Content-Length over the limit", async () => {
    const response = new Response("x", {
      headers: { "content-length": String(51 * 1024 * 1024) },
    });
    await expect(readBodyWithLimit(response)).rejects.toThrow(
      "download limit",
    );
  });

  test("aborts a streamed body once it passes the limit", async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(4));
      },
    });
    await expect(readBodyWithLimit(new Response(stream), 10)).rejects.toThrow(
      "download limit",
    );
    expect(pulls).toBeLessThan(10);
  });
});

test("Markdownify.get retrieves existing Markdown file", async () => {
  const mdContent = "# Test Markdown\nThis is a test.";
  const tempFilePath = path.join(tempDir, "test_get.md");
  fs.writeFileSync(tempFilePath, mdContent);

  const result = await Markdownify.get({ filePath: tempFilePath });

  expect(result).toBeDefined();
  expect(result.path).toBe(tempFilePath);
  expect(result.text).toBe(mdContent);

  fs.unlinkSync(tempFilePath);
});

test("Markdownify.toMarkdown throws error for non-existent file", async () => {
  const nonExistentPath = path.join(sampleDataDir, "non_existent.pdf");
  await expect(
    Markdownify.toMarkdown({ filePath: nonExistentPath }),
  ).rejects.toThrow();
});

test("Markdownify.toMarkdown throws error when neither filePath nor url is provided", async () => {
  await expect(Markdownify.toMarkdown({})).rejects.toThrow(
    "Either filePath or url must be provided",
  );
});

test("Markdownify.get throws error for non-existent file", async () => {
  const nonExistentPath = path.join(sampleDataDir, "non_existent.md");
  await expect(Markdownify.get({ filePath: nonExistentPath })).rejects.toThrow(
    "File does not exist",
  );
});

describe("Markdownify.get with a ~ path", () => {
  let home: string;
  let homedirSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "mdfy-home-"));
    // Bun caches os.homedir() at startup, so stub it rather than setting HOME.
    homedirSpy = spyOn(os, "homedir").mockReturnValue(home);
  });

  afterEach(() => {
    homedirSpy.mockRestore();
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("reads a Markdown file under the home directory", async () => {
    fs.writeFileSync(path.join(home, "n.md"), "# Notes");
    const result = await Markdownify.get({ filePath: "~/n.md" });
    expect(result.text).toBe("# Notes");
    expect(result.path).toBe("~/n.md");
  });

  test("rejects a non-Markdown file before touching the filesystem", async () => {
    const existsSpy = spyOn(fs, "existsSync");
    try {
      await expect(Markdownify.get({ filePath: "~/x.txt" })).rejects.toThrow(
        "Required file is not a Markdown file.",
      );
      expect(existsSpy).not.toHaveBeenCalled();
    } finally {
      existsSpy.mockRestore();
    }
  });

  test("reports a missing file", async () => {
    await expect(Markdownify.get({ filePath: "~/missing.md" })).rejects.toThrow(
      "File does not exist",
    );
  });
});

test("Markdownify.toMarkdown explains a missing markitdown executable", async () => {
  const saved = process.env.MARKITDOWN_PATH;
  process.env.MARKITDOWN_PATH = path.join(tempDir, "no-such-markitdown");
  try {
    await expect(
      Markdownify.toMarkdown({ filePath: path.join(sampleDataDir, "test.pdf") }),
    ).rejects.toThrow("markitdown executable not found");
  } finally {
    if (saved === undefined) delete process.env.MARKITDOWN_PATH;
    else process.env.MARKITDOWN_PATH = saved;
  }
});

test.skipIf(process.platform === "win32")(
  "Markdownify.fromRepo reports empty repomix output",
  async () => {
    const saved = process.env.REPOMIX_PATH;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfy-repomix-"));
    const stub = path.join(dir, "repomix");
    fs.writeFileSync(stub, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.REPOMIX_PATH = stub;
    try {
      await expect(
        Markdownify.fromRepo({ repoUrl: "octocat/Hello-World" }),
      ).rejects.toThrow("repomix produced no output");
    } finally {
      if (saved === undefined) delete process.env.REPOMIX_PATH;
      else process.env.REPOMIX_PATH = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("Markdownify.fromRepo converts a git repo to markdown via shorthand", async () => {
  const result = await Markdownify.fromRepo({
    repoUrl: "octocat/Hello-World",
  });

  expect(result).toBeDefined();
  expect(result.text).toContain("File: README");
  expect(result.text).toContain("Hello World!");
}, 60_000);

test("Markdownify.fromRepo works with full GitHub URL", async () => {
  const result = await Markdownify.fromRepo({
    repoUrl: "https://github.com/octocat/Hello-World",
  });

  expect(result).toBeDefined();
  expect(result.text).toContain("README");
}, 60_000);

test("Markdownify.fromRepo supports branch parameter", async () => {
  const result = await Markdownify.fromRepo({
    repoUrl: "octocat/Hello-World",
    branch: "master",
  });

  expect(result).toBeDefined();
  expect(result.text).toContain("README");
}, 60_000);

test("Markdownify.fromRepo supports compress parameter", async () => {
  const normal = await Markdownify.fromRepo({
    repoUrl: "octocat/Hello-World",
  });
  const compressed = await Markdownify.fromRepo({
    repoUrl: "octocat/Hello-World",
    compress: true,
  });

  expect(compressed).toBeDefined();
  expect(compressed.text).toBeTruthy();
  // Compressed output should differ from normal (may be shorter or structured differently)
  expect(compressed.text).not.toEqual(normal.text);
}, 120_000);

test("Markdownify.fromRepo throws error for invalid repo", async () => {
  await expect(
    Markdownify.fromRepo({ repoUrl: "not-a-real-owner/not-a-real-repo-xyz" }),
  ).rejects.toThrow();
}, 30_000);

test("Markdownify.fromRepo rejects empty URL", async () => {
  await expect(
    Markdownify.fromRepo({ repoUrl: "" }),
  ).rejects.toThrow("Repository URL is required");
});

test("Markdownify.fromRepo rejects file:// URLs", async () => {
  await expect(
    Markdownify.fromRepo({ repoUrl: "file:///etc/passwd" }),
  ).rejects.toThrow("Only http: and https: repository URLs are allowed");
});

test("Markdownify.fromRepo rejects shell metacharacters in URL", async () => {
  await expect(
    Markdownify.fromRepo({ repoUrl: "owner/repo; rm -rf /" }),
  ).rejects.toThrow("Invalid repository URL or shorthand");
});

// Integration tests against diverse real repositories
test("Markdownify.fromRepo handles a TypeScript repo (sindresorhus/is)", async () => {
  const result = await Markdownify.fromRepo({
    repoUrl: "sindresorhus/is",
  });

  expect(result).toBeDefined();
  expect(result.text.length).toBeGreaterThan(1000);
  expect(result.text).toContain("package.json");
  expect(result.text).toContain("tsconfig");
}, 120_000);

test("Markdownify.fromRepo handles a Python repo (pallets/click)", async () => {
  const result = await Markdownify.fromRepo({
    repoUrl: "pallets/click",
  });

  expect(result).toBeDefined();
  expect(result.text.length).toBeGreaterThan(1000);
  expect(result.text).toContain(".py");
}, 120_000);

test("Markdownify.fromRepo handles a Rust repo (BurntSushi/ripgrep)", async () => {
  const result = await Markdownify.fromRepo({
    repoUrl: "BurntSushi/ripgrep",
  });

  expect(result).toBeDefined();
  expect(result.text.length).toBeGreaterThan(5000);
  expect(result.text).toContain("Cargo.toml");
}, 120_000);

test("Markdownify.fromRepo handles a Go repo (junegunn/fzf)", async () => {
  const result = await Markdownify.fromRepo({
    repoUrl: "junegunn/fzf",
  });

  expect(result).toBeDefined();
  expect(result.text.length).toBeGreaterThan(5000);
  expect(result.text).toContain("go.mod");
}, 120_000);

test("Markdownify.fromRepo handles full GitLab-style HTTPS URL", async () => {
  const result = await Markdownify.fromRepo({
    repoUrl: "https://github.com/kelseyhightower/nocode",
  });

  expect(result).toBeDefined();
  expect(result.text).toContain("README");
}, 60_000);

test("Markdownify.fromRepo handles a specific tag via branch param", async () => {
  const result = await Markdownify.fromRepo({
    repoUrl: "sindresorhus/is",
    branch: "v6.0.0",
  });

  expect(result).toBeDefined();
  expect(result.text).toContain("package.json");
}, 120_000);

test("Markdownify.fromRepo compress works on a multi-file repo", async () => {
  const result = await Markdownify.fromRepo({
    repoUrl: "sindresorhus/is",
    compress: true,
  });

  expect(result).toBeDefined();
  expect(result.text.length).toBeGreaterThan(500);
}, 120_000);

test("Markdownify.toMarkdown handles error from _markitdown method", async () => {
  const originalMarkitdown = Markdownify["_markitdown"];
  Markdownify["_markitdown"] = mock(() => {
    throw new Error("Mocked _markitdown error");
  });

  const pdfPath = path.join(sampleDataDir, "test.pdf");
  await expect(Markdownify.toMarkdown({ filePath: pdfPath })).rejects.toThrow(
    "Error processing to Markdown: Mocked _markitdown error",
  );

  Markdownify["_markitdown"] = originalMarkitdown;
});
