import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { JobService } from "../src/remote/jobs.js";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "markdownify-real-converter-"));
const jobs = new JobService({ dataDir, maxUploadBytes: 25 * 1024 * 1024, maxStorageBytes: 256 * 1024 * 1024, maxJobs: 10, retentionMs: 60_000, uploadTtlMs: 60_000, conversionTimeoutMs: 120_000, maxOutputBytes: 25 * 1024 * 1024, concurrency: 2 });
try {
  const fixtures = path.join(dataDir, "fixtures");
  const venvPython = path.resolve(process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
  const python = process.env.PYTHON_PATH ?? (existsSync(venvPython) ? venvPython : "python");
  const generated = await promisify(execFile)(python, ["scripts/create-remote-fixtures.py", fixtures], { timeout: 30_000 });
  console.log(generated.stdout.trim());
  await jobs.init();
  for (const extension of ["pdf", "docx", "xlsx", "pptx"]) {
    const fixture = extension === "pdf" ? path.resolve("src/sample-data/test.pdf") : path.join(fixtures, `test.${extension}`);
    if (extension !== "pdf" && (await readFile(fixture)).subarray(0, 2).toString() !== "PK") throw new Error("Office fixture must be a ZIP package");
    const upload = await jobs.createUpload({ filename: `test.${extension}`, size_bytes: (await stat(fixture)).size });
    await jobs.upload(upload.upload_id, upload.upload_token, createReadStream(fixture));
    await jobs.startConversion(upload.upload_id);
    const deadline = Date.now() + 130_000;
    let status;
    do {
      status = await jobs.getStatus(upload.upload_id);
      if (["completed", "failed"].includes(status.status)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    if (status.status !== "completed") throw new Error(`${extension}: ${status.status} ${status.error ?? "deadline exceeded"}`);
    const result = await jobs.getMarkdown(upload.upload_id, { max_chars: 100_000 });
    if (!result.markdown.includes(`Test ${extension.toUpperCase()} content`)) throw new Error(`${extension}: expected fixture text missing`);
    if (extension !== "pdf" && !result.markdown.includes("Office parser verification")) throw new Error(`${extension}: Office content missing`);
    const stored = await readFile(path.join(dataDir, upload.upload_id, "output.md"), "utf8");
    if (stored !== result.markdown) throw new Error(`${extension}: stored result differs`);
    console.log(`${extension}: real upload / conversion / retrieval passed (${result.total_chars} characters)`);
    await jobs.deleteJob(upload.upload_id);
  }
} finally { await jobs.close(); await rm(dataDir, { recursive: true, force: true }); }
