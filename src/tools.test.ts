import { z } from "zod";
import { describe, expect, test } from "bun:test";
import { toolArgumentSchemas } from "./schemas.js";
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

  describe("argument schemas match the advertised inputSchema", () => {
    test("every tool has a schema and there are no extras", () => {
      expect(Object.keys(toolArgumentSchemas).sort()).toEqual(
        allTools.map((t) => t.name).sort(),
      );
    });

    for (const tool of allTools) {
      test(`${tool.name}: required and property keys agree`, () => {
        const schema = toolArgumentSchemas[tool.name];
        const generated = z.toJSONSchema(schema) as {
          properties: Record<string, { type: string }>;
          required?: string[];
          additionalProperties?: boolean;
        };
        expect([...(generated.required ?? [])].sort()).toEqual(
          [...(tool.inputSchema.required ?? [])].sort(),
        );
        expect(Object.keys(generated.properties).sort()).toEqual(
          Object.keys(tool.inputSchema.properties ?? {}).sort(),
        );
        for (const [key, prop] of Object.entries(generated.properties)) {
          const advertised = tool.inputSchema.properties?.[key] as { type: string };
          expect(advertised.type).toBe(prop.type);
        }
        // Strict: unknown keys are rejected.
        expect(generated.additionalProperties).toBe(false);
      });
    }
  });
});
