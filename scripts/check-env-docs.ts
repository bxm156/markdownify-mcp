// Fails when a MD_* variable named in src/remote/*.ts (tests excluded) is missing from the
// variable table in docs/REMOTE.md. Run from the repo root: bun scripts/check-env-docs.ts
import { readdirSync, readFileSync } from "node:fs";

// A full variable name: not followed by "_" or "*", so prefixes in prose such as MD_JWT_ and MD_MAX_AGENT_* are skipped.
const NAME = /\bMD_[A-Z0-9]+(?:_[A-Z0-9]+)*(?![A-Z0-9_*])/g;

const sources = readdirSync("src/remote")
  .filter(file => file.endsWith(".ts") && !file.includes(".test.") && !file.includes("test-helpers"))
  .sort();

const used = new Map<string, string[]>();
for (const file of sources) {
  for (const name of new Set(readFileSync(`src/remote/${file}`, "utf8").match(NAME) ?? [])) {
    used.set(name, [...(used.get(name) ?? []), file]);
  }
}

const tableLines = readFileSync("docs/REMOTE.md", "utf8").split(/\r?\n/).filter(line => line.startsWith("|"));
const documented = new Set(tableLines.join("\n").match(NAME) ?? []);

const missing = [...used.keys()].filter(name => !documented.has(name)).sort();
if (missing.length > 0) {
  console.error("MD_* variables read in src/remote but missing from the docs/REMOTE.md variable table:");
  for (const name of missing) console.error(`  ${name} (${used.get(name)!.join(", ")})`);
  process.exit(1);
}
console.log(`docs/REMOTE.md documents all ${used.size} MD_* variables found in ${sources.length} src/remote files.`);
