import path from "node:path";
import fs from "node:fs/promises";
import { writeFileSync, renameSync } from "node:fs";
import type { Workspace } from "./types.js";

/**
 * On-disk persistence for a repo's workspaces. conduct creates real git
 * worktrees and branches that outlive the process, so without this they would
 * be orphaned on quit — invisible on the next launch, with no way to review,
 * merge, or clean them up. We snapshot the workspace list (with a trimmed
 * output buffer) next to the worktrees themselves and reload it on `open`.
 */

const STATE_FILE = ".conduct-state.json";
const STATE_VERSION = 1;
/** Keep the tail of each output buffer so restored workspaces stay readable. */
const PERSIST_OUTPUT_LINES = 200;

interface PersistedState {
  version: number;
  baseBranch: string;
  savedAt: number;
  workspaces: Workspace[];
}

function statePath(workspacesRoot: string): string {
  return path.join(workspacesRoot, STATE_FILE);
}

/** Load the persisted workspaces for a repo, or `[]` if none/unreadable. */
export async function loadState(workspacesRoot: string): Promise<Workspace[]> {
  let raw: string;
  try {
    raw = await fs.readFile(statePath(workspacesRoot), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as PersistedState;
    if (parsed?.version !== STATE_VERSION || !Array.isArray(parsed.workspaces)) {
      return [];
    }
    return parsed.workspaces;
  } catch (err) {
    console.error(
      `conduct: corrupt state file (${statePath(workspacesRoot)}), starting clean:`,
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

function serialize(
  baseBranch: string,
  workspaces: Workspace[],
  savedAt: number,
): string {
  const trimmed = workspaces.map((ws) => ({
    ...ws,
    output: ws.output.slice(-PERSIST_OUTPUT_LINES),
  }));
  const state: PersistedState = {
    version: STATE_VERSION,
    baseBranch,
    savedAt,
    workspaces: trimmed,
  };
  return JSON.stringify(state, null, 2);
}

/**
 * Atomically persist the workspace list (write to a temp file, then rename).
 * Used for debounced background saves during normal operation.
 */
export async function saveState(
  workspacesRoot: string,
  baseBranch: string,
  workspaces: Workspace[],
): Promise<void> {
  const file = statePath(workspacesRoot);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, serialize(baseBranch, workspaces, Date.now()), "utf8");
  await fs.rename(tmp, file);
}

/**
 * Synchronous variant for the quit path, where the process exits before an
 * async write would flush.
 */
export function saveStateSync(
  workspacesRoot: string,
  baseBranch: string,
  workspaces: Workspace[],
): void {
  const file = statePath(workspacesRoot);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, serialize(baseBranch, workspaces, Date.now()), "utf8");
  renameSync(tmp, file);
}
