#!/usr/bin/env node

import { createServer } from "./server.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { warnIfProxyConfigured } from "./proxyWarning.js";

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
