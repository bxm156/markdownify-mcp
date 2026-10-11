/**
 * MCP tool definitions advertised by the stdio server.
 *
 * Every export of this module must be a tool: server.ts lists
 * `Object.values(tools)` as the catalogue. Each definition is parsed with the
 * SDK's ToolSchema at import time, so a malformed one fails at startup. The
 * `inputSchema` here is what clients see; schemas.ts holds the schemas that
 * are enforced, and their required keys must match. Tool names are public
 * interface. URL tools take an http(s) `url` that must resolve to public
 * addresses; file tools take an absolute `filepath` (a leading `~` is
 * expanded), limited to 50 MiB and to MD_ALLOWED_PATHS when that is set.
 */
import { ToolSchema } from "@modelcontextprotocol/sdk/types.js";

/**
 * Converts a YouTube video page (metadata, plus the transcript when
 * available). Takes `url`.
 */
export const YouTubeToMarkdownTool = ToolSchema.parse({
  name: "youtube-to-markdown",
  description:
    "Convert a YouTube video to markdown, including transcript if available",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "URL of the YouTube video",
      },
    },
    required: ["url"],
  },
  annotations: {
    title: "YouTube to Markdown",
    readOnlyHint: true,
    openWorldHint: true,
  },
});

/** Converts a local PDF file. Takes `filepath`. */
export const PDFToMarkdownTool = ToolSchema.parse({
  name: "pdf-to-markdown",
  description: "Convert a PDF file to markdown",
  inputSchema: {
    type: "object",
    properties: {
      filepath: {
        type: "string",
        description: "Absolute path of the PDF file to convert",
      },
    },
    required: ["filepath"],
  },
  annotations: {
    title: "PDF to Markdown",
    readOnlyHint: true,
  },
});

/** Converts a Bing search results page. Takes `url`. */
export const BingSearchResultToMarkdownTool = ToolSchema.parse({
  name: "bing-search-to-markdown",
  description: "Convert a Bing search results page to markdown",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "URL of the Bing search results page",
      },
    },
    required: ["url"],
  },
  annotations: {
    title: "Bing Search to Markdown",
    readOnlyHint: true,
    openWorldHint: true,
  },
});

/**
 * Converts a web page; pages that need JavaScript to render may fail. Takes
 * `url`.
 */
export const WebpageToMarkdownTool = ToolSchema.parse({
  name: "webpage-to-markdown",
  description: "Convert a webpage to markdown",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "URL of the webpage to convert",
      },
    },
    required: ["url"],
  },
  annotations: {
    title: "Webpage to Markdown",
    readOnlyHint: true,
    openWorldHint: true,
  },
});

/**
 * Converts a local image (metadata, and a description where markitdown can
 * produce one). Takes `filepath`.
 */
export const ImageToMarkdownTool = ToolSchema.parse({
  name: "image-to-markdown",
  description:
    "Convert an image to markdown, including metadata and description",
  inputSchema: {
    type: "object",
    properties: {
      filepath: {
        type: "string",
        description: "Absolute path of the image file to convert",
      },
    },
    required: ["filepath"],
  },
  annotations: {
    title: "Image to Markdown",
    readOnlyHint: true,
  },
});

/**
 * Converts a local audio file (metadata, and a transcript where markitdown can
 * produce one). Takes `filepath`.
 */
export const AudioToMarkdownTool = ToolSchema.parse({
  name: "audio-to-markdown",
  description:
    "Convert an audio file to markdown, including transcription if possible",
  inputSchema: {
    type: "object",
    properties: {
      filepath: {
        type: "string",
        description: "Absolute path of the audio file to convert",
      },
    },
    required: ["filepath"],
  },
  annotations: {
    title: "Audio to Markdown",
    readOnlyHint: true,
  },
});

/** Converts a local Word (.docx) document. Takes `filepath`. */
export const DocxToMarkdownTool = ToolSchema.parse({
  name: "docx-to-markdown",
  description: "Convert a DOCX file to markdown",
  inputSchema: {
    type: "object",
    properties: {
      filepath: {
        type: "string",
        description: "Absolute path of the DOCX file to convert",
      },
    },
    required: ["filepath"],
  },
  annotations: {
    title: "DOCX to Markdown",
    readOnlyHint: true,
  },
});

/** Converts a local Excel (.xlsx) workbook. Takes `filepath`. */
export const XlsxToMarkdownTool = ToolSchema.parse({
  name: "xlsx-to-markdown",
  description: "Convert an XLSX file to markdown",
  inputSchema: {
    type: "object",
    properties: {
      filepath: {
        type: "string",
        description: "Absolute path of the XLSX file to convert",
      },
    },
    required: ["filepath"],
  },
  annotations: {
    title: "XLSX to Markdown",
    readOnlyHint: true,
  },
});

/** Converts a local PowerPoint (.pptx) presentation. Takes `filepath`. */
export const PptxToMarkdownTool = ToolSchema.parse({
  name: "pptx-to-markdown",
  description: "Convert a PPTX file to markdown",
  inputSchema: {
    type: "object",
    properties: {
      filepath: {
        type: "string",
        description: "Absolute path of the PPTX file to convert",
      },
    },
    required: ["filepath"],
  },
  annotations: {
    title: "PPTX to Markdown",
    readOnlyHint: true,
  },
});

/**
 * Packs a remote git repository into one Markdown document with repomix. Takes
 * `url` (URL or GitHub `owner/repo`), optional `branch` and `compress`. The
 * host must be in MD_GIT_HOSTS (default github.com, gitlab.com, bitbucket.org)
 * and `branch` a valid git ref; see validateRepoUrl and validateGitRef.
 */
export const GitRepoToMarkdownTool = ToolSchema.parse({
  name: "git-repo-to-markdown",
  description:
    "Convert a git repository into a single markdown document containing the file tree and source code. Supports GitHub URLs and shorthand (e.g. 'owner/repo'). Only hosts allowed by the server (by default github.com, gitlab.com and bitbucket.org) that resolve to public addresses are cloned.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description:
          "Git repository URL or GitHub shorthand (e.g. 'https://github.com/owner/repo' or 'owner/repo')",
      },
      branch: {
        type: "string",
        description:
          "Branch, tag, or commit to use (default: repo default branch). Must be a valid git ref name, e.g. 'main', 'v1.2.3' or 'feature/x'; values starting with '-' are rejected.",
      },
      compress: {
        type: "boolean",
        description:
          "Use Tree-sitter compression to reduce output size (~70% reduction). Default: false",
      },
    },
    required: ["url"],
  },
  annotations: {
    title: "Git Repo to Markdown",
    readOnlyHint: true,
    openWorldHint: true,
  },
});

/**
 * Returns a local `.md` / `.markdown` file's contents unchanged. Takes
 * `filepath`.
 */
export const GetMarkdownFileTool = ToolSchema.parse({
  name: "get-markdown-file",
  description: "Get a markdown file by absolute file path",
  inputSchema: {
    type: "object",
    properties: {
      filepath: {
        type: "string",
        description: "Absolute path to file of markdown'd text",
      },
    },
    required: ["filepath"],
  },
  annotations: {
    title: "Get Markdown File",
    readOnlyHint: true,
  },
});
