import fs from "node:fs/promises";
import path from "node:path";
import { Git } from "./git.js";

/**
 * Gather repo context and build a prompt that asks the agent to analyze and
 * improve the codebase autonomously — no manual prompt typing needed. Reads
 * the top-level directory listing, README, package.json (if they exist), and
 * recent git history to ground the agent before it starts work.
 */
export async function buildAutoImprovePrompt(repoRoot: string, git: Git): Promise<string> {
  const ctx: string[] = [];

  try {
    const entries = await fs.readdir(repoRoot, { withFileTypes: true });
    const listing = entries
      .filter((e) => !e.name.startsWith(".") && !e.name.startsWith("node_modules"))
      .map((e) => `${e.isDirectory() ? "dir" : "file"}  ${e.name}`)
      .join("\n");
    ctx.push(`Top-level contents:\n${listing}`);
  } catch { /* best-effort */ }

  try {
    const readme = await fs.readFile(path.join(repoRoot, "README.md"), "utf-8");
    ctx.push(`README.md:\n${readme.slice(0, 2000)}`);
  } catch { /* no README */ }

  try {
    const pkgRaw = await fs.readFile(path.join(repoRoot, "package.json"), "utf-8");
    const pkg = JSON.parse(pkgRaw);
    ctx.push(`package.json:\n${JSON.stringify(pkg, null, 2).slice(0, 2000)}`);
  } catch { /* no package.json */ }

  try {
    const log = await git.recentLog(10);
    if (log.trim()) ctx.push(`Recent commits:\n${log}`);
  } catch { /* best-effort */ }

  return [
    // Deliberately do NOT pin the agent to an absolute path. The agent process
    // is spawned with its cwd set to the workspace's own git worktree; naming
    // the main checkout's path here would make the agent `cd` out of its
    // worktree and edit/commit directly on the base branch — exactly the
    // isolation conduct exists to provide. Refer to the working directory so it
    // operates wherever it was launched (its worktree).
    `Analyze and improve this codebase (your current working directory).`,
    "",
    ...ctx,
    "",
    "First explore the codebase to understand its purpose and architecture.",
    "Then make concrete improvements: code quality, architecture, performance,",
    "testing, documentation, and features. Prioritize changes that provide the",
    "most value for this project. Work iteratively, making improvements one at a time.",
  ].join("\n");
}
