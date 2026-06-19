import { spawn } from "node:child_process";
import type { DiffStat } from "./types.js";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Outcome of attempting to merge a workspace branch into the base branch. */
export interface MergeResult {
  /** True when the branch merged cleanly into base. */
  ok: boolean;
  /**
   * Paths that conflicted, set only when `ok` is false. The partial merge has
   * already been rolled back by the time this is returned, so these name the
   * files that need manual resolution in the worktree before a retry can land.
   */
  conflicts?: string[];
}

/**
 * Grace period after a timeout's SIGTERM before escalating to SIGKILL. A wedged
 * process (e.g. a network `git push`/`gh pr create` stuck on a dead socket) can
 * ignore SIGTERM; without a follow-up kill it would linger after `run` resolves.
 */
const KILL_GRACE_MS = 2_000;

/** Run a command, capturing output. Never rejects on non-zero exit. */
export function run(
  cmd: string,
  args: string[],
  cwd?: string,
  timeoutMs?: number,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer =
      timeoutMs && timeoutMs > 0
        ? setTimeout(() => {
            child.kill("SIGTERM");
            // Escalate to SIGKILL if SIGTERM didn't take, so a hung subprocess
            // doesn't outlive the resolved promise. `unref` keeps this grace
            // timer from holding the event loop open on its own.
            killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
            killTimer.unref?.();
            resolve({ code: 124, stdout, stderr: `${stderr}\n[timed out after ${timeoutMs}ms]`.trim() });
          }, timeoutMs)
        : undefined;
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ code: 127, stdout, stderr: stderr + String(err) });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      // The process exited (possibly because SIGTERM worked), so the pending
      // SIGKILL is moot — clear it.
      if (killTimer) clearTimeout(killTimer);
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

/** Default timeout for git operations (30s). Diff and merge can take longer. */
const GIT_TIMEOUT = 30_000;
/** Longer timeout for slow operations like merge. */
const GIT_LONG_TIMEOUT = 120_000;

/**
 * Whether `bin` resolves on the current PATH. Uncached (unlike the agent
 * registry's own lookup) and dependency-free, so callers like the
 * push/pull-request flow can probe for an optional CLI (`gh`) at the moment they
 * need it without coupling to the agents module.
 *
 * Cross-platform: POSIX has `which`, but Windows ships `where` instead (and no
 * `which`), so on `win32` we probe with `where`. Without this, every agent and
 * the `gh`/PR flow would report "not installed" on the published Windows build,
 * leaving the app with no usable agents.
 */
export async function commandExists(bin: string): Promise<boolean> {
  const finder = process.platform === "win32" ? "where" : "which";
  const res = await run(finder, [bin]);
  return res.code === 0 && res.stdout.trim().length > 0;
}

/** Run git, throwing a useful error on failure. */
async function git(
  args: string[],
  cwd: string,
  timeoutMs: number = GIT_TIMEOUT,
): Promise<string> {
  const res = await run("git", args, cwd, timeoutMs);
  if (res.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${res.code}): ${res.stderr.trim() || res.stdout.trim()}`,
    );
  }
  return res.stdout;
}

export class Git {
  constructor(public readonly root: string) {}

  /** Find the repository root for a directory, or null if not a repo. */
  static async discover(cwd: string): Promise<Git | null> {
    const res = await run("git", ["rev-parse", "--show-toplevel"], cwd);
    if (res.code !== 0) return null;
    return new Git(res.stdout.trim());
  }

  async currentBranch(): Promise<string> {
    // `--show-current` works even on an unborn branch (no commits yet),
    // unlike `rev-parse --abbrev-ref HEAD` which errors there.
    const res = await run("git", ["branch", "--show-current"], this.root);
    const name = res.stdout.trim();
    if (name) return name;
    // Detached HEAD: fall back to the abbreviated ref.
    const r2 = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], this.root);
    return r2.stdout.trim() || "HEAD";
  }

  /** True once the repo has at least one commit (HEAD resolves to an object). */
  async hasCommits(): Promise<boolean> {
    const res = await run("git", ["rev-parse", "--verify", "HEAD"], this.root);
    return res.code === 0;
  }

  async headSha(): Promise<string> {
    return (await git(["rev-parse", "HEAD"], this.root)).trim();
  }

  /** Create a worktree at `path` on a new `branch` starting from `baseRef`. */
  async addWorktree(
    path: string,
    branch: string,
    baseRef: string,
  ): Promise<void> {
    await git(["worktree", "add", "-b", branch, path, baseRef], this.root);
  }

  /** Remove a worktree checkout (force, since the agent may have left changes). */
  async removeWorktree(path: string): Promise<void> {
    await git(["worktree", "remove", "--force", path], this.root);
  }

  async deleteBranch(branch: string): Promise<void> {
    await run("git", ["branch", "-D", branch], this.root);
  }

  /** Recent `n` commits in oneline format (e.g. for repo context). */
  async recentLog(n: number): Promise<string> {
    return git(["log", `-${n}`, "--oneline"], this.root);
  }

  /** Mark untracked files as intent-to-add so they show up in `git diff`. */
  async intentToAdd(worktree: string): Promise<void> {
    await run("git", ["add", "-A", "-N"], worktree);
  }

  /** Full unified diff of a worktree against a base ref (includes untracked). */
  async diff(worktree: string, baseRef: string): Promise<string> {
    await this.intentToAdd(worktree);
    return git(["diff", baseRef], worktree);
  }

  /** Short stat summary of changes against base. */
  async diffStat(worktree: string, baseRef: string): Promise<string> {
    await this.intentToAdd(worktree);
    return git(["diff", "--stat", baseRef], worktree);
  }

  /**
   * Change totals of a worktree against base, parsed from `git diff --numstat`:
   * one `<added>\t<deleted>\t<path>` row per file. Binary files report `-` for
   * the counts, which we treat as zero lines while still counting the file.
   */
  async diffNumstat(worktree: string, baseRef: string): Promise<DiffStat> {
    await this.intentToAdd(worktree);
    const out = await git(["diff", "--numstat", baseRef], worktree);
    let files = 0;
    let insertions = 0;
    let deletions = 0;
    for (const line of out.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [added, deleted] = line.split("\t");
      files += 1;
      if (added !== "-") insertions += Number(added) || 0;
      if (deleted !== "-") deletions += Number(deleted) || 0;
    }
    return { files, insertions, deletions };
  }

  /** True if the worktree has any staged, unstaged, or untracked changes. */
  async hasChanges(worktree: string): Promise<boolean> {
    const res = await run("git", ["status", "--porcelain"], worktree);
    return res.stdout.trim().length > 0;
  }

  /** Commit everything in the worktree. No-op if there is nothing to commit. */
  async commitAll(worktree: string, message: string): Promise<boolean> {
    if (!(await this.hasChanges(worktree))) return false;
    await git(["add", "-A"], worktree);
    await git(["commit", "-m", message, "--no-verify"], worktree);
    return true;
  }

  /**
   * Merge `branch` into the repo's current branch (no fast-forward).
   *
   * Returns `{ ok: true }` on a clean merge. When the merge conflicts, the
   * half-finished merge is rolled back with `git merge --abort` so the base
   * checkout is left exactly as it was — never stranded mid-merge with conflict
   * markers and `MERGE_HEAD` set — and `{ ok: false, conflicts }` lists the
   * unmerged paths for the caller to surface. Any other failure (a bad ref, or
   * git refusing to start because the base tree is dirty) still throws, since
   * those aren't conflicts the user resolves in the workspace.
   */
  async merge(branch: string, message: string): Promise<MergeResult> {
    const res = await run(
      "git",
      ["merge", "--no-ff", "-m", message, branch],
      this.root,
      GIT_LONG_TIMEOUT,
    );
    if (res.code === 0) return { ok: true };
    // A non-zero exit is either a conflict or a refusal to even start the merge.
    // Only a conflict leaves unmerged paths behind, so use their presence to
    // tell the two apart.
    const unmerged = await run(
      "git",
      ["diff", "--name-only", "--diff-filter=U"],
      this.root,
    );
    const conflicts = unmerged.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (conflicts.length === 0) {
      throw new Error(
        `git merge ${branch} failed (${res.code}): ${res.stderr.trim() || res.stdout.trim()}`,
      );
    }
    // Roll the conflicted merge back so the base checkout is untouched. Best
    // effort: if the abort itself somehow fails there's nothing more we can do
    // here, and the returned conflicts still tell the user what happened.
    await run("git", ["merge", "--abort"], this.root);
    return { ok: false, conflicts };
  }

  /**
   * Whether `ancestor` is contained in `ref`'s history — i.e. `ref` already has
   * every commit of `ancestor`. Run in `cwd` so it can be asked of a worktree's
   * checked-out branch (pass `"HEAD"` as `ref`). The sync flow uses it to tell
   * "already up to date with base" from "base has moved on" without parsing
   * merge output. A non-zero exit (not an ancestor, or an unknown ref) is just
   * `false`.
   */
  async isAncestor(ancestor: string, ref: string, cwd: string): Promise<boolean> {
    const res = await run(
      "git",
      ["merge-base", "--is-ancestor", ancestor, ref],
      cwd,
    );
    return res.code === 0;
  }

  /**
   * Merge `baseRef` *into* a worktree's currently checked-out branch — the
   * inverse direction of {@link merge}. Used to bring base-branch progress into
   * an in-flight workspace so its diff reflects only its own changes and a later
   * merge-back stays clean. Runs inside the worktree (`worktree` is its cwd), so
   * the merge lands on the workspace branch rather than the base checkout, and a
   * pure catch-up (the branch has no commits of its own past base) fast-forwards
   * with no empty merge commit.
   *
   * Mirrors {@link merge}'s conflict handling: a clean merge returns
   * `{ ok: true }`; on conflict the half-finished merge is rolled back with
   * `git merge --abort` so the worktree is restored exactly as it was — never
   * stranded with conflict markers and `MERGE_HEAD` set — and the unmerged paths
   * are returned for the caller to surface. Any other failure (e.g. a tree git
   * refuses to merge over) throws, since it isn't a conflict to resolve.
   */
  async mergeInto(
    worktree: string,
    baseRef: string,
    message: string,
  ): Promise<MergeResult> {
    const res = await run(
      "git",
      ["merge", "-m", message, baseRef],
      worktree,
      GIT_LONG_TIMEOUT,
    );
    if (res.code === 0) return { ok: true };
    const unmerged = await run(
      "git",
      ["diff", "--name-only", "--diff-filter=U"],
      worktree,
    );
    const conflicts = unmerged.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (conflicts.length === 0) {
      throw new Error(
        `git merge ${baseRef} failed (${res.code}): ${res.stderr.trim() || res.stdout.trim()}`,
      );
    }
    // Roll the conflicted merge back so the worktree is left untouched. Best
    // effort: if the abort itself fails there's nothing more to do here, and the
    // returned conflicts still tell the user what happened.
    await run("git", ["merge", "--abort"], worktree);
    return { ok: false, conflicts };
  }

  /** True if `remote` is configured for this repo (i.e. has a URL). */
  async hasRemote(remote = "origin"): Promise<boolean> {
    const res = await run("git", ["remote", "get-url", remote], this.root);
    return res.code === 0 && res.stdout.trim().length > 0;
  }

  /** The fetch/push URL of `remote`, or null when it isn't configured. */
  async remoteUrl(remote = "origin"): Promise<string | null> {
    const res = await run("git", ["remote", "get-url", remote], this.root);
    if (res.code !== 0) return null;
    return res.stdout.trim() || null;
  }

  /**
   * Push `branch` to `remote`, setting it as the upstream (`-u`) so a later
   * `git pull`/`gh pr` in the worktree tracks it. Run from the repo root rather
   * than a worktree: every conduct branch is an ordinary ref in the shared
   * repository, so the root can push it whether or not its worktree is checked
   * out. `force` uses `--force-with-lease` (safe-ish force: refuses to clobber
   * remote work the local ref hasn't seen). Throws on failure so the caller can
   * surface the git error verbatim.
   */
  async push(
    branch: string,
    opts: { remote?: string; force?: boolean } = {},
  ): Promise<void> {
    const remote = opts.remote ?? "origin";
    const args = ["push"];
    if (opts.force) args.push("--force-with-lease");
    args.push("-u", remote, branch);
    await git(args, this.root, GIT_LONG_TIMEOUT);
  }
}
