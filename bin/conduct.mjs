#!/usr/bin/env node
// Thin launcher: run the TS entrypoint through tsx without a build step.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync } from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));

const arg = process.argv[2];
const pkg = JSON.parse(
  readFileSync(path.join(here, "..", "package.json"), "utf8"),
);
const version = pkg.version ?? "unknown";

if (arg === "-v" || arg === "--version") {
  console.log(version);
  process.exit(0);
}

if (arg === "-h" || arg === "--help") {
  console.log(`conduct ${version}

A terminal orchestrator for running multiple coding agents in parallel,
each in its own isolated git worktree.

USAGE
  conduct [repo-path]

  If no path is given, the current working directory is used.

FLAGS
  -h, --help      Show this help message
  -v, --version   Print the version number

KEYS
  n          New workspace(s)
  m          Merge (selected, or all marked)
  P          Push branch and open pull request
  x          Archive (selected, or all marked)
  Space      Toggle mark for batch operations
  /          Filter the workspace list
  ?          Show the full keybinding reference
  q          Quit

See the README for the complete keybinding reference.
`);
  process.exit(0);
}

const entry = path.join(here, "..", "src", "index.tsx");
const tsx = path.join(here, "..", "node_modules", ".bin", "tsx");

const res = spawnSync(tsx, [entry, ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(res.status ?? 1);
