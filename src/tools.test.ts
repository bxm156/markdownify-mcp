import { describe, expect, test } from "bun:test";
import * as tools from "./tools.js";

const allTools = Object.values(tools);

describe("tools", () => {
  test("declares exactly eleven tools", () => {
    expect(allTools).toHaveLength(11);
  });

  test("tool names are unique", () => {
    const names = allTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("tool names are the documented set", () => {
    expect(allTools.map((t) => t.name).sort()).toEqual([
      "audio-to-markdown",
      "bing-search-to-markdown",
      "docx-to-markdown",
      "get-markdown-file",
      "git-repo-to-markdown",
      "image-to-markdown",
      "pdf-to-markdown",
      "pptx-to-markdown",
      "webpage-to-markdown",
      "xlsx-to-markdown",
      "youtube-to-markdown",
    ]);
  });

  for (const tool of allTools) {
    describe(tool.name, () => {
      test("has a description and an object input schema", () => {
        expect(tool.description?.length).toBeGreaterThan(0);
        expect(tool.inputSchema.type).toBe("object");
        expect(Array.isArray(tool.inputSchema.required)).toBe(true);
      });

      test("is read-only", () => {
        expect(tool.annotations?.readOnlyHint).toBe(true);
      });

      test("required properties are declared in properties", () => {
        for (const key of tool.inputSchema.required ?? []) {
          expect(tool.inputSchema.properties).toHaveProperty(key);
        }
      });
    });
  }
});
