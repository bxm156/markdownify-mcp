import { z } from "zod";
import * as tools from "./tools.js";

/**
 * Per-tool argument schemas. They are strict (unknown keys are rejected) and
 * must match the `inputSchema` declared for the same tool in tools.ts; the
 * test suite checks that the required keys agree.
 */
const urlArgs = z.strictObject({ url: z.string().min(1) });
const filepathArgs = z.strictObject({ filepath: z.string().min(1) });
const gitRepoArgs = z.strictObject({
  url: z.string().min(1),
  branch: z.string().optional(),
  compress: z.boolean().optional(),
});

export const toolArgumentSchemas = {
  [tools.YouTubeToMarkdownTool.name]: urlArgs,
  [tools.BingSearchResultToMarkdownTool.name]: urlArgs,
  [tools.WebpageToMarkdownTool.name]: urlArgs,
  [tools.PDFToMarkdownTool.name]: filepathArgs,
  [tools.ImageToMarkdownTool.name]: filepathArgs,
  [tools.AudioToMarkdownTool.name]: filepathArgs,
  [tools.DocxToMarkdownTool.name]: filepathArgs,
  [tools.XlsxToMarkdownTool.name]: filepathArgs,
  [tools.PptxToMarkdownTool.name]: filepathArgs,
  [tools.GitRepoToMarkdownTool.name]: gitRepoArgs,
  [tools.GetMarkdownFileTool.name]: filepathArgs,
} satisfies Record<string, z.ZodObject>;

export type UrlArgs = z.infer<typeof urlArgs>;
export type FilepathArgs = z.infer<typeof filepathArgs>;
export type GitRepoArgs = z.infer<typeof gitRepoArgs>;

/** The argument schema for a tool, or undefined for an unknown tool name. */
export function getToolArgumentSchema(name: string): z.ZodObject | undefined {
  return Object.hasOwn(toolArgumentSchemas, name)
    ? toolArgumentSchemas[name]
    : undefined;
}

const REQUIRED_MESSAGES: Record<string, string> = {
  url: "URL is required for this tool",
  filepath: "File path is required for this tool",
};

/**
 * Short, readable summary of the first schema issue, e.g.
 * "Invalid arguments: url: expected string, received number". A missing or
 * empty `url`/`filepath` keeps its historical "... is required for this tool"
 * message.
 */
export function formatArgumentError(
  error: z.ZodError,
  args: Record<string, unknown>,
): string {
  const issue = error.issues[0];
  const key = issue.path.length === 1 ? String(issue.path[0]) : undefined;
  if (key !== undefined && key in REQUIRED_MESSAGES) {
    const value = args[key];
    if (value === undefined || value === "") return REQUIRED_MESSAGES[key];
  }
  const path = issue.path.join(".");
  return `Invalid arguments: ${path ? `${path}: ` : ""}${issue.message}`;
}
