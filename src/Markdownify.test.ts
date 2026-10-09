import {
  expect,
  test,
  mock,
  spyOn,
  beforeAll,
  afterAll,
} from "bun:test";
import { Markdownify, MarkdownResult } from "./Markdownify";
import fs from "fs";
import path from "path";
import os from "os";

const sampleDataDir = path.join(__dirname, "sample-data");

// Markdownify writes its output under os.tmpdir(). Point TMPDIR at a private
// directory for this file so tests never see or delete files from other
// processes, then remove only that directory afterwards.
const tempVariables = ["TMPDIR", "TEMP", "TMP"] as const;
const originalTemp = Object.fromEntries(tempVariables.map(key => [key, process.env[key]]));
let tempDir: string;

// Network-dependent tests (git clones) only run when MD_TEST_NETWORK=1.
const networkTest = test.skipIf(process.env.MD_TEST_NETWORK !== "1");

beforeAll(() => {
  // Ensure the sample data directory exists
  if (!fs.existsSync(sampleDataDir)) {
    throw new Error("Sample data directory not found");
  }
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "markdownify-test-"));
  for (const key of tempVariables) process.env[key] = tempDir;
});

afterAll(() => {
  for (const key of tempVariables) {
    if (originalTemp[key] === undefined) delete process.env[key];
    else process.env[key] = originalTemp[key];
  }
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("converter temporary files use the private suite directory", () => {
  expect(path.resolve(os.tmpdir())).toBe(path.resolve(tempDir));
  for (const key of tempVariables) expect(process.env[key]).toBe(tempDir);
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
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    (() =>
      Promise.resolve({
        arrayBuffer: () =>
          Promise.resolve(new TextEncoder().encode(html).buffer),
      })) as any,
  );

  try {
    const result = await Markdownify.toMarkdown({ url: testUrl });

    expect(result).toBeDefined();
    expect(result.text).toContain("# Example Domain");
  } finally {
    fetchSpy.mockRestore();
  }
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

networkTest("Markdownify.fromRepo converts a git repo to markdown via shorthand", async () => {
  const result = await Markdownify.fromRepo({
    repoUrl: "octocat/Hello-World",
  });

  expect(result).toBeDefined();
  expect(result.text).toContain("File: README");
  expect(result.text).toContain("Hello World!");
}, 60_000);

networkTest("Markdownify.fromRepo works with full GitHub URL", async () => {
  const result = await Markdownify.fromRepo({
    repoUrl: "https://github.com/octocat/Hello-World",
  });

  expect(result).toBeDefined();
  expect(result.text).toContain("README");
}, 60_000);

networkTest("Markdownify.fromRepo supports branch parameter", async () => {
  const result = await Markdownify.fromRepo({
    repoUrl: "octocat/Hello-World",
    branch: "master",
  });

  expect(result).toBeDefined();
  expect(result.text).toContain("README");
}, 60_000);

networkTest("Markdownify.fromRepo supports compress parameter", async () => {
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

networkTest("Markdownify.fromRepo throws error for invalid repo", async () => {
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
networkTest("Markdownify.fromRepo handles a TypeScript repo (sindresorhus/is)", async () => {
  const result = await Markdownify.fromRepo({
    repoUrl: "sindresorhus/is",
  });

  expect(result).toBeDefined();
  expect(result.text.length).toBeGreaterThan(1000);
  expect(result.text).toContain("package.json");
  expect(result.text).toContain("tsconfig");
}, 120_000);

networkTest("Markdownify.fromRepo handles a Python repo (pallets/click)", async () => {
  const result = await Markdownify.fromRepo({
    repoUrl: "pallets/click",
  });

  expect(result).toBeDefined();
  expect(result.text.length).toBeGreaterThan(1000);
  expect(result.text).toContain(".py");
}, 120_000);

networkTest("Markdownify.fromRepo handles a Rust repo (BurntSushi/ripgrep)", async () => {
  const result = await Markdownify.fromRepo({
    repoUrl: "BurntSushi/ripgrep",
  });

  expect(result).toBeDefined();
  expect(result.text.length).toBeGreaterThan(5000);
  expect(result.text).toContain("Cargo.toml");
}, 120_000);

networkTest("Markdownify.fromRepo handles a Go repo (junegunn/fzf)", async () => {
  const result = await Markdownify.fromRepo({
    repoUrl: "junegunn/fzf",
  });

  expect(result).toBeDefined();
  expect(result.text.length).toBeGreaterThan(5000);
  expect(result.text).toContain("go.mod");
}, 120_000);

networkTest("Markdownify.fromRepo handles full GitLab-style HTTPS URL", async () => {
  const result = await Markdownify.fromRepo({
    repoUrl: "https://github.com/kelseyhightower/nocode",
  });

  expect(result).toBeDefined();
  expect(result.text).toContain("README");
}, 60_000);

networkTest("Markdownify.fromRepo handles a specific tag via branch param", async () => {
  const result = await Markdownify.fromRepo({
    repoUrl: "sindresorhus/is",
    branch: "v6.0.0",
  });

  expect(result).toBeDefined();
  expect(result.text).toContain("package.json");
}, 120_000);

networkTest("Markdownify.fromRepo compress works on a multi-file repo", async () => {
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
