#!/usr/bin/env node

/**
 * Entry point of the stdio MCP server (the `mcp-markdownify-server` bin).
 *
 * Builds the server from server.ts and serves it over stdin/stdout. stdout is
 * reserved for the MCP protocol, so every diagnostic goes to stderr. Must run
 * under both Node (the published bin) and Bun (`bun dist/index.js`), so it
 * uses no Bun-only APIs. A failure before the transport is connected is fatal:
 * it is logged to stderr and the process exits with status 1.
 */

import { createServer } from "./server.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { warnIfProxyConfigured } from "./proxyWarning.js";

/**
 * Starts the server. PYTHONUTF8=1 is set first because markitdown, a Python
 * child process, inherits this environment: it makes Python read and write
 * UTF-8 whatever the system locale (chiefly for Windows code pages).
 */
async function main() {
  process.env.PYTHONUTF8 = '1';
  warnIfProxyConfigured();
  const transport = new StdioServerTransport();
  const server = createServer();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
