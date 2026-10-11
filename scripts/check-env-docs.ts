// Fails when an environment variable the code reads is missing from its documentation table:
// - remote: every MD_* name in src/remote/*.ts must be in the variable table of docs/REMOTE.md;
// - stdio: every MD_* name and every `process.env.NAME` read in src/*.ts must be in the
//   "Stdio environment variables" table of README.md.
// Test files and test helpers are excluded. Run from the repo root: bun scripts/check-env-docs.ts
import { readdirSync, readFileSync } from "node:fs";

// A full variable name: not followed by "_" or "*", so prefixes in prose such as MD_JWT_ and MD_MAX_AGENT_* are skipped.
const NAME = /\bMD_[A-Z0-9]+(?:_[A-Z0-9]+)*(?![A-Z0-9_*])/g;
// process.env.NAME or process.env["NAME"], unless it is being assigned (index.ts sets PYTHONUTF8 for the child).
const ENV_READ = /\bprocess\.env(?:\.([A-Z][A-Z0-9_]*)\b|\[["']([A-Z][A-Z0-9_]*)["']\])(?!\s*=[^=])/g;
// A variable name in backticks, as table cells write it.
const DOCUMENTED_NAME = /`([A-Z][A-Z0-9_]*)`/g;

const STDIO_TABLE_HEADING = "### Stdio environment variables";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter(file => file.endsWith(".ts") && !file.includes(".test.") && !file.includes("test-helpers"))
    .sort();
}

/** Each variable name found by `names` in the files of `dir`, with the files it appears in. */
function collect(dir: string, files: string[], names: (text: string) => string[]): Map<string, string[]> {
  const used = new Map<string, string[]>();
  for (const file of files) {
    for (const name of new Set(names(readFileSync(`${dir}/${file}`, "utf8")))) {
      used.set(name, [...(used.get(name) ?? []), file]);
    }
  }
  return used;
}

/** Prints the names in `used` that are not in `documented`; returns whether any were missing. */
function reportMissing(used: Map<string, string[]>, documented: Set<string>, what: string): boolean {
  const missing = [...used.keys()].filter(name => !documented.has(name)).sort();
  if (missing.length === 0) return false;
  console.error(what);
  for (const name of missing) console.error(`  ${name} (${used.get(name)!.join(", ")})`);
  return true;
}

// Remote service: MD_* names in src/remote against the docs/REMOTE.md table.
const remoteSources = sourceFiles("src/remote");
const remoteUsed = collect("src/remote", remoteSources, text => text.match(NAME) ?? []);
const remoteTable = readFileSync("docs/REMOTE.md", "utf8").split(/\r?\n/).filter(line => line.startsWith("|"));
const remoteDocumented = new Set(remoteTable.join("\n").match(NAME) ?? []);

// Stdio server: MD_* names and process.env reads in src/*.ts against README.md's stdio table,
// the run of table lines that follows its heading.
const stdioSources = sourceFiles("src");
const stdioUsed = collect("src", stdioSources, text => [
  ...(text.match(NAME) ?? []),
  ...[...text.matchAll(ENV_READ)].map(match => match[1] ?? match[2]),
]);
const readme = readFileSync("README.md", "utf8").split(/\r?\n/);
const headingAt = readme.findIndex(line => line.trim() === STDIO_TABLE_HEADING);
if (headingAt < 0) {
  console.error(`README.md has no "${STDIO_TABLE_HEADING}" heading with the stdio variable table.`);
  process.exit(1);
}
const tableStart = readme.findIndex((line, i) => i > headingAt && line.startsWith("|"));
const stdioTable: string[] = [];
for (let i = tableStart; i >= 0 && i < readme.length && readme[i].startsWith("|"); i++) stdioTable.push(readme[i]);
const stdioDocumented = new Set([...stdioTable.join("\n").matchAll(DOCUMENTED_NAME)].map(match => match[1]));

const remoteMissing = reportMissing(
  remoteUsed, remoteDocumented,
  "MD_* variables read in src/remote but missing from the docs/REMOTE.md variable table:",
);
const stdioMissing = reportMissing(
  stdioUsed, stdioDocumented,
  `Variables read in src/*.ts but missing from the README.md "${STDIO_TABLE_HEADING.replace(/^#+ /, "")}" table:`,
);
if (remoteMissing || stdioMissing) process.exit(1);
console.log(
  `docs/REMOTE.md documents all ${remoteUsed.size} MD_* variables found in ${remoteSources.length} src/remote files; ` +
    `README.md documents all ${stdioUsed.size} variables read in ${stdioSources.length} src files.`,
);
