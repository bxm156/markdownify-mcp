#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { createHttpServer } from "./http.js";
import { JobService } from "./jobs.js";

async function main() {
  process.env.PYTHONUTF8 = "1";
  const config = loadConfig();
  const jobs = new JobService(config.jobs);
  await jobs.init();
  const server = createHttpServer(jobs, config);
  server.requestTimeout = 5 * 60_000;
  server.headersTimeout = 30_000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, resolve);
    });
  } catch (error) { await jobs.close(); throw error; }
  console.error(`Markdownify remote listening on ${config.host}:${config.port}`);
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const deadline = setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 10_000);
    deadline.unref();
    const stopped = new Promise<void>(resolve => server.close(() => resolve()));
    await jobs.close();
    server.closeAllConnections();
    await stopped;
    clearTimeout(deadline);
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "Remote server startup failed");
  process.exitCode = 1;
});
