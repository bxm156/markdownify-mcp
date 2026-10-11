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
import { killActiveTools } from "./Markdownify.js";

/** The signals that stop the server, with the exit status each one gives (128 + signal number). */
const STOP_SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;

/**
 * Makes stopping the server stop its converters too. markitdown and repomix
 * run in their own process group (so a timeout can kill their whole tree),
 * which also means a signal sent to the server, or to the terminal's
 * foreground group on Ctrl+C, no longer reaches them. So on SIGHUP, SIGINT
 * or SIGTERM the server kills every run in progress (killActiveTools) and
 * exits with the shell convention 128 + signal number (129, 130, 143),
 * the same status a shell reports for a process the signal killed. The
 * "exit" handler kills anything still registered when the process exits
 * for another reason (stdin closed, process.exit, a fatal error); it runs
 * synchronously, which killActiveTools is. SIGKILL cannot be caught: a
 * server killed that way leaves its converters running until they finish
 * or hit their timeout.
 */
function installShutdownHandlers(): void {
  for (const [signal, code] of Object.entries(STOP_SIGNAL_EXIT_CODES)) {
    process.once(signal, () => {
      killActiveTools();
      process.exit(code);
    });
  }
  process.once("exit", () => {
    killActiveTools();
  });
}

/**
 * Starts the server. PYTHONUTF8=1 is set first because markitdown, a Python
 * child process, inherits this environment: it makes Python read and write
 * UTF-8 whatever the system locale (chiefly for Windows code pages).
 */
async function main() {
  process.env.PYTHONUTF8 = '1';
  installShutdownHandlers();
  warnIfProxyConfigured();
  const transport = new StdioServerTransport();
  const server = createServer();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
