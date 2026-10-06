import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";

const stride = 4096;
type Checkpoint = { chars: number; bytes: number };
type Index = { version: 1; size: number; mtimeMs: number; total_chars: number; checkpoints: Checkpoint[] };
const indexPath = (output: string) => `${output}.index.json`;

/** Strict UTF-8 decoding preserves BOM and code points split across read chunks. */
async function* textChunks(output: string, start = 0) {
  const stream = createReadStream(output, { start, highWaterMark: 64 * 1024 });
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  try {
    for await (const chunk of stream) yield decoder.decode(chunk as Buffer, { stream: true });
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally { stream.destroy(); }
}

async function getIndex(output: string): Promise<Index> {
  const stat = await fs.stat(output);
  try {
    const cached: Index = JSON.parse(await fs.readFile(indexPath(output), "utf8"));
    if (cached.version === 1 && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && Number.isSafeInteger(cached.total_chars) && cached.total_chars >= 0 && Array.isArray(cached.checkpoints) && cached.checkpoints.length === Math.floor(cached.total_chars / stride) + 1 && cached.checkpoints.every((point, i) => point.chars === i * stride && Number.isSafeInteger(point.bytes) && point.bytes >= 0 && point.bytes <= stat.size && (i === 0 ? point.bytes === 0 : point.bytes > cached.checkpoints[i - 1].bytes))) return cached;
  } catch (error) {
    if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let chars = 0, bytes = 0;
  const checkpoints: Checkpoint[] = [{ chars: 0, bytes: 0 }];
  for await (const chunk of textChunks(output)) {
    for (const char of chunk) {
      chars++; bytes += Buffer.byteLength(char, "utf8");
      if (chars % stride === 0) checkpoints.push({ chars, bytes });
    }
  }
  const index: Index = { version: 1, size: stat.size, mtimeMs: stat.mtimeMs, total_chars: chars, checkpoints };
  const target = indexPath(output), temporary = `${target}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, JSON.stringify(index), { mode: 0o600 }); await fs.rename(temporary, target); }
  finally { await fs.rm(temporary, { force: true }); }
  return index;
}

/** Build once at conversion completion; older completed jobs are indexed lazily. */
export async function prepareMarkdownIndex(output: string): Promise<number> {
  return (await getIndex(output)).total_chars;
}

/** Seek near the requested code-point offset; allocations depend on page size. */
export async function readMarkdownPage(output: string, { offset = 0, max_chars = 16_000 }: { offset?: number; max_chars?: number } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(max_chars) || max_chars < 1 || max_chars > 100_000) throw new RangeError("Invalid pagination parameters");
  const index = await getIndex(output);
  if (offset > index.total_chars) throw new RangeError("Offset exceeds Markdown length");
  const end = Math.min(offset + max_chars, index.total_chars);
  if (offset === end) return { markdown: "", next_offset: null, total_chars: index.total_chars };
  const point = index.checkpoints[Math.floor(offset / stride)];
  let position = point.chars;
  const chars: string[] = [];
  outer: for await (const chunk of textChunks(output, point.bytes)) {
    for (const char of chunk) {
      if (position >= offset) chars.push(char);
      position++;
      if (position === end) break outer;
    }
  }
  if (position !== end) throw new Error("Markdown output changed while reading");
  return { markdown: chars.join(""), next_offset: end < index.total_chars ? end : null, total_chars: index.total_chars };
}
