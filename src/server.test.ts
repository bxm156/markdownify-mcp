import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Markdownify } from "./Markdownify.js";
import { createServer, readPackageVersion } from "./server.js";
import * as tools from "./tools.js";

const allTools = Object.values(tools);

let client: Client;
let closeAll: () => Promise<void>;

beforeEach(async () => {
  const server = createServer();
  client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  closeAll = async () => {
    await client.close();
    await server.close();
  };
});

afterEach(async () => {
  await closeAll();
});

type TextResult = { isError?: boolean; content: { type: string; text: string }[] };

async function call(name: string, args?: Record<string, unknown>) {
  return (await client.callTool({ name, arguments: args })) as TextResult;
}

describe("server info", () => {
  test("reports the version from package.json", async () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
    );
    expect(typeof pkg.version).toBe("string");
    expect(client.getServerVersion()).toEqual({
      name: "mcp-markdownify-server",
      version: pkg.version,
    });
    expect(readPackageVersion()).toBe(pkg.version);
  });
});

describe("listTools", () => {
  test("returns the declared tools with names, descriptions, schemas and annotations", async () => {
    const { tools: listed } = await client.listTools();
    expect(listed).toHaveLength(11);
    expect(listed.map((t) => t.name).sort()).toEqual(
      allTools.map((t) => t.name).sort(),
    );
    for (const declared of allTools) {
      const t = listed.find((l) => l.name === declared.name)!;
      expect(t.description?.length).toBeGreaterThan(0);
      expect(t.description).toBe(declared.description);
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema).toEqual(declared.inputSchema as any);
      expect(t.annotations?.readOnlyHint).toBe(declared.annotations?.readOnlyHint);
      expect(t.annotations?.readOnlyHint).toBe(true);
    }
  });
});

describe("dispatch", () => {
  let toMarkdown: ReturnType<typeof spyOn>;
  let fromRepo: ReturnType<typeof spyOn>;
  let get: ReturnType<typeof spyOn>;

  beforeEach(() => {
    toMarkdown = spyOn(Markdownify, "toMarkdown").mockResolvedValue({
      path: "/out/result.md",
      text: "converted",
    });
    fromRepo = spyOn(Markdownify, "fromRepo").mockResolvedValue({
      path: "/out/repo.md",
      text: "repo text",
    });
    get = spyOn(Markdownify, "get").mockResolvedValue({
      path: "/in/file.md",
      text: "file text",
    });
  });

  afterEach(() => {
    toMarkdown.mockRestore();
    fromRepo.mockRestore();
    get.mockRestore();
  });

  const urlTools = [
    tools.YouTubeToMarkdownTool,
    tools.BingSearchResultToMarkdownTool,
    tools.WebpageToMarkdownTool,
  ];
  const fileTools = [
    tools.PDFToMarkdownTool,
    tools.ImageToMarkdownTool,
    tools.AudioToMarkdownTool,
    tools.DocxToMarkdownTool,
    tools.XlsxToMarkdownTool,
    tools.PptxToMarkdownTool,
  ];

  for (const tool of urlTools) {
    test(`${tool.name} calls toMarkdown with url`, async () => {
      const res = await call(tool.name, { url: "https://example.com/x" });
      expect(res.isError).toBe(false);
      expect(toMarkdown).toHaveBeenCalledTimes(1);
      expect(toMarkdown).toHaveBeenCalledWith({ url: "https://example.com/x" });
      expect(fromRepo).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
    });

    test(`${tool.name} without url is an error and does not convert`, async () => {
      const res = await call(tool.name, {});
      expect(res.isError).toBe(true);
      expect(res.content).toEqual([
        { type: "text", text: "Error: URL is required for this tool" },
      ]);
      expect(toMarkdown).not.toHaveBeenCalled();
    });
  }

  for (const tool of fileTools) {
    test(`${tool.name} calls toMarkdown with filePath`, async () => {
      const res = await call(tool.name, { filepath: "/tmp/in.bin" });
      expect(res.isError).toBe(false);
      expect(toMarkdown).toHaveBeenCalledTimes(1);
      expect(toMarkdown).toHaveBeenCalledWith({ filePath: "/tmp/in.bin" });
      expect(fromRepo).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
    });

    test(`${tool.name} without filepath is an error and does not convert`, async () => {
      const res = await call(tool.name, {});
      expect(res.isError).toBe(true);
      expect(res.content).toEqual([
        { type: "text", text: "Error: File path is required for this tool" },
      ]);
      expect(toMarkdown).not.toHaveBeenCalled();
    });
  }

  test("git-repo-to-markdown passes repoUrl, branch and compress to fromRepo", async () => {
    const res = await call(tools.GitRepoToMarkdownTool.name, {
      url: "owner/repo",
      branch: "dev",
      compress: true,
    });
    expect(res.isError).toBe(false);
    expect(fromRepo).toHaveBeenCalledTimes(1);
    expect(fromRepo).toHaveBeenCalledWith({
      repoUrl: "owner/repo",
      branch: "dev",
      compress: true,
    });
    expect(toMarkdown).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  test("git-repo-to-markdown leaves branch and compress undefined when omitted", async () => {
    await call(tools.GitRepoToMarkdownTool.name, { url: "owner/repo" });
    expect(fromRepo).toHaveBeenCalledWith({
      repoUrl: "owner/repo",
      branch: undefined,
      compress: undefined,
    });
  });

  test("git-repo-to-markdown without url is an error", async () => {
    const res = await call(tools.GitRepoToMarkdownTool.name, { branch: "dev" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe("Error: URL is required for this tool");
    expect(fromRepo).not.toHaveBeenCalled();
  });

  test("get-markdown-file calls get with filePath", async () => {
    const res = await call(tools.GetMarkdownFileTool.name, {
      filepath: "/in/file.md",
    });
    expect(res.isError).toBe(false);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith({ filePath: "/in/file.md" });
    expect(toMarkdown).not.toHaveBeenCalled();
    expect(fromRepo).not.toHaveBeenCalled();
  });

  test("get-markdown-file without filepath is an error", async () => {
    const res = await call(tools.GetMarkdownFileTool.name, {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe("Error: File path is required for this tool");
    expect(get).not.toHaveBeenCalled();
  });

  test("a call with no arguments object is an isError result, not a protocol error", async () => {
    const res = await call(tools.WebpageToMarkdownTool.name);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe("Error: URL is required for this tool");
  });

  test("unknown tool returns Tool not found", async () => {
    const res = await call("no-such-tool", { url: "https://example.com" });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual([{ type: "text", text: "Error: Tool not found" }]);
    expect(toMarkdown).not.toHaveBeenCalled();
    expect(fromRepo).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  describe("argument type errors", () => {
    test("url: 5 is an isError result rather than a protocol error", async () => {
      const res = await call(tools.WebpageToMarkdownTool.name, { url: 5 });
      expect(res.isError).toBe(true);
      expect(res.content).toHaveLength(1);
      expect(res.content[0].type).toBe("text");
      expect(res.content[0].text).toMatch(/^Error: Invalid arguments: url: /);
      expect(toMarkdown).not.toHaveBeenCalled();
    });

    test("compress as a string is rejected", async () => {
      const res = await call(tools.GitRepoToMarkdownTool.name, {
        url: "owner/repo",
        compress: "yes",
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/^Error: Invalid arguments: compress: /);
      expect(fromRepo).not.toHaveBeenCalled();
    });

    test("filepath as a number is rejected", async () => {
      const res = await call(tools.PDFToMarkdownTool.name, { filepath: 42 });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/^Error: Invalid arguments: filepath: /);
      expect(toMarkdown).not.toHaveBeenCalled();
    });
  });

  describe("strict per-tool schemas", () => {
    test("unknown keys are rejected", async () => {
      const res = await call(tools.WebpageToMarkdownTool.name, {
        url: "https://example.com",
        filepath: "/etc/passwd",
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/^Error: Invalid arguments: .*filepath/);
      expect(toMarkdown).not.toHaveBeenCalled();
    });

    test("fields that belong to another tool are rejected", async () => {
      const res = await call(tools.PDFToMarkdownTool.name, {
        filepath: "/tmp/a.pdf",
        branch: "main",
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/^Error: Invalid arguments: .*branch/);
      const res2 = await call(tools.GetMarkdownFileTool.name, {
        filepath: "/tmp/a.md",
        compress: true,
      });
      expect(res2.isError).toBe(true);
      expect(toMarkdown).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
    });

    test("a url tool given only filepath reports the missing url", async () => {
      const res = await call(tools.YouTubeToMarkdownTool.name, { filepath: "/x" });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/^Error: (URL is required|Invalid arguments: )/);
      expect(toMarkdown).not.toHaveBeenCalled();
    });

    test("an empty url or filepath counts as missing", async () => {
      const a = await call(tools.WebpageToMarkdownTool.name, { url: "" });
      expect(a.content[0].text).toBe("Error: URL is required for this tool");
      const b = await call(tools.PDFToMarkdownTool.name, { filepath: "" });
      expect(b.content[0].text).toBe("Error: File path is required for this tool");
      expect(toMarkdown).not.toHaveBeenCalled();
    });

    test("an unknown tool is reported as such even with invalid arguments", async () => {
      const res = await call("no-such-tool", { whatever: 1 });
      expect(res.content[0].text).toBe("Error: Tool not found");
    });

    test("names inherited from Object.prototype are not tools", async () => {
      for (const name of ["constructor", "toString", "__proto__"]) {
        const res = await call(name, {});
        expect(res.isError).toBe(true);
        expect(res.content[0].text).toBe("Error: Tool not found");
      }
    });
  });

  describe("result shape", () => {
    test("includes an Output file entry before the text when result has a path", async () => {
      const res = await call(tools.WebpageToMarkdownTool.name, {
        url: "https://example.com",
      });
      expect(res.isError).toBe(false);
      expect(res.content).toEqual([
        { type: "text", text: "Output file: /out/result.md" },
        { type: "text", text: "converted" },
      ]);
    });

    test("omits the Output file entry when result has no path", async () => {
      toMarkdown.mockResolvedValue({ path: "", text: "just text" });
      const res = await call(tools.WebpageToMarkdownTool.name, {
        url: "https://example.com",
      });
      expect(res.isError).toBe(false);
      expect(res.content).toEqual([{ type: "text", text: "just text" }]);
    });
  });

  describe("failures", () => {
    test("an Error rejection becomes Error: <message>", async () => {
      toMarkdown.mockRejectedValue(new Error("boom"));
      const res = await call(tools.WebpageToMarkdownTool.name, {
        url: "https://example.com",
      });
      expect(res.isError).toBe(true);
      expect(res.content).toEqual([{ type: "text", text: "Error: boom" }]);
    });

    test("a non-Error throw becomes Error: Unknown error occurred", async () => {
      const logged = spyOn(console, "error").mockImplementation(() => {});
      try {
        get.mockRejectedValue("a plain string");
        const res = await call(tools.GetMarkdownFileTool.name, {
          filepath: "/in/file.md",
        });
        expect(res.isError).toBe(true);
        expect(res.content).toEqual([
          { type: "text", text: "Error: Unknown error occurred" },
        ]);
        expect(logged).toHaveBeenCalledWith("a plain string");
      } finally {
        logged.mockRestore();
      }
    });
  });
});
