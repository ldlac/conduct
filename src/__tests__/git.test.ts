import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { Git, run, commandExists } from "../core/git.js";

let tmpDir: string;
let repoDir: string;
let git: Git;

function exec(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: "pipe" });
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`)),
    );
    child.on("error", reject);
  });
}

async function initRepo(dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  await exec("git", ["init"], dir);
  await exec("git", ["config", "user.email", "test@test.com"], dir);
  await exec("git", ["config", "user.name", "Test"], dir);
  fs.writeFileSync(path.join(dir, "README.md"), "# Test\n");
  await exec("git", ["add", "-A"], dir);
  await exec("git", ["commit", "-m", "initial commit"], dir);
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conduct-git-test-"));
  repoDir = path.join(tmpDir, "repo");
  await initRepo(repoDir);
  git = (await Git.discover(repoDir))!;
  expect(git).toBeInstanceOf(Git);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("run()", () => {
  it("captures stdout on success", async () => {
    const res = await run("echo", ["hello world"]);
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toBe("hello world");
  });

  it("captures non-zero exit", async () => {
    const res = await run("sh", ["-c", "exit 42"]);
    expect(res.code).toBe(42);
  });

  it("handles command not found", async () => {
    const res = await run("nonexistent-command-12345", []);
    expect(res.code).toBe(127);
    expect(res.stderr).toContain("nonexistent-command-12345");
  });

  it("times out and returns code 124", async () => {
    const res = await run("sleep", ["10"], undefined, 100);
    expect(res.code).toBe(124);
    expect(res.stderr).toContain("timed out");
  });

  it("respects custom cwd", async () => {
    const res = await run("pwd", [], repoDir);
    expect(res.stdout.trim()).toBe(repoDir);
  });
});

describe("Git.discover", () => {
  it("finds repo root from a subdirectory", async () => {
    const sub = path.join(repoDir, "sub");
    fs.mkdirSync(sub, { recursive: true });
    const g = await Git.discover(sub);
    expect(g).toBeInstanceOf(Git);
    expect(g!.root).toBe(repoDir);
  });

  it("returns null for a non-repo directory", async () => {
    const notRepo = path.join(tmpDir, "not-a-repo");
    fs.mkdirSync(notRepo, { recursive: true });
    const g = await Git.discover(notRepo);
    expect(g).toBeNull();
  });
});

describe("Git instance methods", () => {
  it("currentBranch returns a branch name", async () => {
    const branch = await git.currentBranch();
    expect(branch).toBeTruthy();
    expect(typeof branch).toBe("string");
  });

  it("hasCommits returns true", async () => {
    expect(await git.hasCommits()).toBe(true);
  });

  it("hasCommits returns false on empty repo", async () => {
    const emptyDir = path.join(tmpDir, "empty-repo");
    fs.mkdirSync(emptyDir, { recursive: true });
    await exec("git", ["init"], emptyDir);
    const emptyGit = (await Git.discover(emptyDir))!;
    expect(await emptyGit.hasCommits()).toBe(false);
  });

  it("headSha returns a 40-char hex string", async () => {
    const sha = await git.headSha();
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("recentLog returns the last N commits", async () => {
    const log = await git.recentLog(5);
    expect(log).toContain("initial commit");
    const lines = log.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines.length).toBeLessThanOrEqual(5);
  });

  it("hasChanges returns false on a clean tree", async () => {
    expect(await git.hasChanges(repoDir)).toBe(false);
  });

  it("hasChanges returns true with uncommitted changes", async () => {
    fs.writeFileSync(path.join(repoDir, "dirty.txt"), "dirty");
    expect(await git.hasChanges(repoDir)).toBe(true);
    fs.unlinkSync(path.join(repoDir, "dirty.txt"));
  });

  it("hasChanges returns true with staged changes", async () => {
    fs.writeFileSync(path.join(repoDir, "staged.txt"), "staged");
    await exec("git", ["add", "staged.txt"], repoDir);
    expect(await git.hasChanges(repoDir)).toBe(true);
    await exec("git", ["reset", "HEAD", "staged.txt"], repoDir);
    fs.unlinkSync(path.join(repoDir, "staged.txt"));
  });

  it("diff returns empty for a clean tree", async () => {
    const d = await git.diff(repoDir, await git.headSha());
    expect(d.trim()).toBe("");
  });

  it("diff returns content for modified files", async () => {
    const sha = await git.headSha();
    fs.writeFileSync(path.join(repoDir, "diff-me.txt"), "content");
    await exec("git", ["add", "-N", "diff-me.txt"], repoDir);
    const d = await git.diff(repoDir, sha);
    expect(d).toContain("diff --git");
    expect(d).toContain("+content");
    await exec("git", ["checkout", "--", "diff-me.txt"], repoDir);
    fs.unlinkSync(path.join(repoDir, "diff-me.txt"));
  });

  it("diffNumstat returns zeroes for a clean tree", async () => {
    const stat = await git.diffNumstat(repoDir, await git.headSha());
    expect(stat.files).toBe(0);
    expect(stat.insertions).toBe(0);
    expect(stat.deletions).toBe(0);
  });

  it("diffNumstat parses output correctly", async () => {
    const sha = await git.headSha();
    fs.writeFileSync(path.join(repoDir, "stat-me.txt"), "line1\nline2\n");
    await exec("git", ["add", "-N", "stat-me.txt"], repoDir);
    const stat = await git.diffNumstat(repoDir, sha);
    expect(stat.files).toBe(1);
    expect(stat.insertions).toBeGreaterThanOrEqual(2);
    await exec("git", ["checkout", "--", "stat-me.txt"], repoDir);
    fs.unlinkSync(path.join(repoDir, "stat-me.txt"));
  });

  it("diffStat returns a non-empty string for changes", async () => {
    const sha = await git.headSha();
    fs.writeFileSync(path.join(repoDir, "stat-str.txt"), "data");
    await exec("git", ["add", "-N", "stat-str.txt"], repoDir);
    const ds = await git.diffStat(repoDir, sha);
    expect(ds).toContain("1 file changed");
    await exec("git", ["checkout", "--", "stat-str.txt"], repoDir);
    fs.unlinkSync(path.join(repoDir, "stat-str.txt"));
  });

  it("intentToAdd makes untracked file show in diff", async () => {
    const sha = await git.headSha();
    fs.writeFileSync(path.join(repoDir, "intent.txt"), "intent data");
    await git.intentToAdd(repoDir);
    const d = await git.diff(repoDir, sha);
    expect(d).toContain("intent.txt");
    expect(d).toContain("+intent data");
    await exec("git", ["checkout", "--", "intent.txt"], repoDir);
    fs.unlinkSync(path.join(repoDir, "intent.txt"));
  });

  it("commitAll commits changes and returns true", async () => {
    fs.writeFileSync(path.join(repoDir, "to-commit.txt"), "to commit");
    const committed = await git.commitAll(repoDir, "test commit");
    expect(committed).toBe(true);
    const log = await git.recentLog(1);
    expect(log).toContain("test commit");
  });

  it("commitAll returns false when tree is clean", async () => {
    const committed = await git.commitAll(repoDir, "nothing to see");
    expect(committed).toBe(false);
  });

  it("addWorktree creates a worktree and removeWorktree removes it", async () => {
    const wtPath = path.join(tmpDir, "wt-test");
    const branch = "conduct/wt-test";
    await git.addWorktree(wtPath, branch, await git.headSha());
    expect(fs.existsSync(wtPath)).toBe(true);
    expect(fs.existsSync(path.join(wtPath, "README.md"))).toBe(true);

    const branches = await execAndCapture("git", ["branch", "-l"], repoDir);
    expect(branches).toContain(branch);

    await git.removeWorktree(wtPath);
    expect(fs.existsSync(wtPath)).toBe(false);
    await git.deleteBranch(branch);
  }, 15000);

  it("deleteBranch removes a branch", async () => {
    const branch = "conduct/to-delete";
    await exec("git", ["branch", branch, await git.headSha()], repoDir);
    await git.deleteBranch(branch);
    const branches = await execAndCapture("git", ["branch", "-l"], repoDir);
    expect(branches).not.toContain(branch);
  });

  it("merge cleanly merges a branch", async () => {
    const branch = "conduct/merge-clean";
    await exec("git", ["branch", branch, await git.headSha()], repoDir);
    const result = await git.merge(branch, `Merge branch ${branch}`);
    expect(result.ok).toBe(true);
    await exec("git", ["branch", "-D", branch], repoDir);
  });

  it("merge detects conflicts", async () => {
    const baseBranch = await git.currentBranch();
    const branch = "conduct/merge-conflict";
    const sha = await git.headSha();
    await exec("git", ["branch", branch, sha], repoDir);

    fs.writeFileSync(path.join(repoDir, "conflict-file.txt"), "main content\n");
    await exec("git", ["add", "conflict-file.txt"], repoDir);
    await exec("git", ["commit", "-m", "base change", "--no-verify"], repoDir);

    await exec("git", ["checkout", branch], repoDir);
    fs.writeFileSync(path.join(repoDir, "conflict-file.txt"), "branch content\n");
    await exec("git", ["add", "conflict-file.txt"], repoDir);
    await exec("git", ["commit", "-m", "branch change", "--no-verify"], repoDir);

    await exec("git", ["checkout", baseBranch], repoDir);

    const result = await git.merge(branch, `Merge ${branch}`);
    expect(result.ok).toBe(false);
    expect(result.conflicts).toBeDefined();
    expect(result.conflicts!.length).toBeGreaterThanOrEqual(1);
    expect(result.conflicts).toContain("conflict-file.txt");

    // Base branch should be untouched after rollback
    const status = await execAndCapture("git", ["status", "--porcelain"], repoDir);
    expect(status.trim()).toBe("");

    await exec("git", ["branch", "-D", branch], repoDir);
  }, 15000);

  it("merge throws on non-conflict failures", async () => {
    await expect(
      git.merge("nonexistent-branch", "bad merge"),
    ).rejects.toThrow("git merge");
  });

  it("isAncestor reflects whether a ref already contains another", async () => {
    const base = await git.currentBranch();
    const startSha = await git.headSha();
    const branch = "conduct/anc-test";
    await exec("git", ["branch", branch, startSha], repoDir);
    // Same commit: base is (trivially) an ancestor of the fresh branch.
    expect(await git.isAncestor(base, branch, repoDir)).toBe(true);

    // Advance base; now base is no longer contained in the un-moved branch.
    fs.writeFileSync(path.join(repoDir, "anc.txt"), "anc\n");
    await exec("git", ["add", "anc.txt"], repoDir);
    await exec("git", ["commit", "-m", "anc advance", "--no-verify"], repoDir);
    expect(await git.isAncestor(base, branch, repoDir)).toBe(false);
    // …but the branch is still an ancestor of the advanced base.
    expect(await git.isAncestor(branch, base, repoDir)).toBe(true);

    expect(await git.isAncestor("no-such-ref", branch, repoDir)).toBe(false);

    await exec("git", ["branch", "-D", branch], repoDir);
    await exec("git", ["reset", "--hard", startSha], repoDir);
  }, 15000);

  it("mergeInto brings base commits into a worktree branch (clean)", async () => {
    const base = await git.currentBranch();
    const startSha = await git.headSha();
    const branch = "conduct/merge-into-clean";
    const wt = path.join(tmpDir, "wt-merge-into-clean");
    await git.addWorktree(wt, branch, startSha);

    // Advance base with a file the worktree branch doesn't have yet.
    fs.writeFileSync(path.join(repoDir, "base-new.txt"), "from base\n");
    await exec("git", ["add", "base-new.txt"], repoDir);
    await exec("git", ["commit", "-m", "base advance", "--no-verify"], repoDir);
    expect(fs.existsSync(path.join(wt, "base-new.txt"))).toBe(false);

    const result = await git.mergeInto(wt, base, `Merge ${base}`);
    expect(result.ok).toBe(true);
    // The base file is now present in the worktree (fast-forwarded in).
    expect(fs.existsSync(path.join(wt, "base-new.txt"))).toBe(true);

    await git.removeWorktree(wt);
    await git.deleteBranch(branch);
    await exec("git", ["reset", "--hard", startSha], repoDir);
  }, 15000);

  it("mergeInto rolls back and reports conflicts", async () => {
    const base = await git.currentBranch();
    const startSha = await git.headSha();
    const branch = "conduct/merge-into-conflict";
    const wt = path.join(tmpDir, "wt-merge-into-conflict");
    await git.addWorktree(wt, branch, startSha);

    // Base and the worktree branch change the same file in different ways.
    fs.writeFileSync(path.join(repoDir, "shared.txt"), "base side\n");
    await exec("git", ["add", "shared.txt"], repoDir);
    await exec("git", ["commit", "-m", "base shared", "--no-verify"], repoDir);
    fs.writeFileSync(path.join(wt, "shared.txt"), "branch side\n");
    await exec("git", ["add", "shared.txt"], wt);
    await exec("git", ["commit", "-m", "branch shared", "--no-verify"], wt);

    const result = await git.mergeInto(wt, base, `Merge ${base}`);
    expect(result.ok).toBe(false);
    expect(result.conflicts).toContain("shared.txt");
    // Rolled back: the worktree carries no in-progress merge.
    const status = await execAndCapture("git", ["status", "--porcelain"], wt);
    expect(status.trim()).toBe("");

    await git.removeWorktree(wt);
    await git.deleteBranch(branch);
    await exec("git", ["reset", "--hard", startSha], repoDir);
  }, 15000);
});

describe("commandExists", () => {
  it("resolves true for a binary on PATH", async () => {
    expect(await commandExists("git")).toBe(true);
  });

  it("resolves false for a bogus binary", async () => {
    expect(await commandExists("definitely-not-a-real-binary-zzz-12345")).toBe(false);
  });

  it("uses the platform's PATH finder (where on win32, which elsewhere)", async () => {
    // The finder is selected from process.platform; assert it resolves a known
    // binary on whatever platform the test runs on, so the win32 `where` branch
    // doesn't silently regress to an unconditional `which` (absent on Windows).
    const known = process.platform === "win32" ? "cmd" : "git";
    expect(await commandExists(known)).toBe(true);
  });
});

describe("Git remote and push", () => {
  // Use a bare repo on disk as the "remote", so push is exercised end to end
  // with no network. Each test wires up and tears down its own origin so the
  // shared `repoDir` stays remote-free for the other suites in this file.
  it("hasRemote / remoteUrl reflect the configured origin", async () => {
    expect(await git.hasRemote("origin")).toBe(false);
    expect(await git.remoteUrl("origin")).toBeNull();

    const bare = path.join(tmpDir, "remote-meta.git");
    await exec("git", ["init", "--bare", bare], tmpDir);
    await exec("git", ["remote", "add", "origin", bare], repoDir);

    expect(await git.hasRemote("origin")).toBe(true);
    expect(await git.remoteUrl("origin")).toBe(bare);

    await exec("git", ["remote", "remove", "origin"], repoDir);
  });

  it("push sends a branch to the remote", async () => {
    const bare = path.join(tmpDir, "remote-push.git");
    await exec("git", ["init", "--bare", bare], tmpDir);
    await exec("git", ["remote", "add", "origin", bare], repoDir);

    const branch = "conduct/push-test";
    await exec("git", ["branch", branch, await git.headSha()], repoDir);
    await git.push(branch, { remote: "origin" });

    const refs = await execAndCapture("git", ["branch", "--list"], bare);
    expect(refs).toContain(branch);

    await exec("git", ["remote", "remove", "origin"], repoDir);
    await exec("git", ["branch", "-D", branch], repoDir);
  }, 15000);

  it("push throws when the remote is missing", async () => {
    await expect(
      git.push("conduct/no-remote", { remote: "definitely-no-such-remote" }),
    ).rejects.toThrow();
  });
});

function execAndCapture(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: "pipe" });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.on("close", (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`exited ${code}`)),
    );
    child.on("error", reject);
  });
}
