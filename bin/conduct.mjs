#!/usr/bin/env node
// Thin launcher: run the TS entrypoint through tsx without a build step.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "..", "src", "index.tsx");
const tsx = path.join(here, "..", "node_modules", ".bin", "tsx");

const res = spawnSync(tsx, [entry, ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(res.status ?? 1);
