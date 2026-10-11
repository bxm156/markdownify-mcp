import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Markdownify } from "./Markdownify.js";
import {
  formatArgumentError,
  getToolArgumentSchema,
  type FilepathArgs,
  type GitRepoArgs,
  type UrlArgs,
} from "./schemas.js";
import * as tools from "./tools.js";
import { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";

/**
 * The package version, read from the package.json one level above this file
 * (the same location from src/ and from the compiled dist/).
 */
export function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
    );
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

type Result = { path?: string; text: string };

/** Adapts a runner for one argument shape to the schema-validated `unknown` it receives. */
const run =
  <A>(fn: (args: A) => Promise<Result>) =>
  (args: unknown) =>
    fn(args as A);

const runUrl = run(({ url }: UrlArgs) => Markdownify.toMarkdown({ url }));
const runFile = run(({ filepath }: FilepathArgs) =>
  Markdownify.toMarkdown({ filePath: filepath }),
);

/** Runs a tool with arguments already validated against its schema in schemas.ts. */
const runners: Record<string, (args: unknown) => Promise<Result>> = {
  [tools.YouTubeToMarkdownTool.name]: runUrl,
  [tools.BingSearchResultToMarkdownTool.name]: runUrl,
  [tools.WebpageToMarkdownTool.name]: runUrl,
  [tools.PDFToMarkdownTool.name]: runFile,
  [tools.ImageToMarkdownTool.name]: runFile,
  [tools.AudioToMarkdownTool.name]: runFile,
  [tools.DocxToMarkdownTool.name]: runFile,
  [tools.XlsxToMarkdownTool.name]: runFile,
  [tools.PptxToMarkdownTool.name]: runFile,
  [tools.GitRepoToMarkdownTool.name]: run(
    ({ url, branch, compress }: GitRepoArgs) =>
      Markdownify.fromRepo({ repoUrl: url, branch, compress }),
  ),
  [tools.GetMarkdownFileTool.name]: run(({ filepath }: FilepathArgs) =>
    Markdownify.get({ filePath: filepath }),
  ),
};

export function createServer() {
  const server = new Server(
    {
      name: "mcp-markdownify-server",
      version: readPackageVersion(),
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: Object.values(tools),
    };
  });

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request: CallToolRequest) => {
      const { name, arguments: args } = request.params;

      try {
        const schema = getToolArgumentSchema(name);
        const runner = Object.hasOwn(runners, name) ? runners[name] : undefined;
        if (!schema || !runner) {
          throw new Error("Tool not found");
        }
        const rawArgs = args ?? {};
        const parsed = schema.safeParse(rawArgs);
        if (!parsed.success) {
          throw new Error(formatArgumentError(parsed.error, rawArgs));
        }
        const result = await runner(parsed.data);

        return {
          content: [
            ...(result.path
              ? [{ type: "text" as const, text: `Output file: ${result.path}` }]
              : []),
            { type: "text", text: result.text },
          ],
          isError: false,
        };
      } catch (e) {
        if (e instanceof Error) {
          return {
            content: [{ type: "text", text: `Error: ${e.message}` }],
            isError: true,
          };
        } else {
          console.error(e);
          return {
            content: [{ type: "text", text: `Error: Unknown error occurred` }],
            isError: true,
          };
        }
      }
    },
  );

  return server;
}
