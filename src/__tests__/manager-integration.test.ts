import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { WorkspaceManager } from "../core/manager.js";
import type { WorkspaceStatus } from "../core/types.js";

let tmpDir: string;
let repoDir: string;
let manager: WorkspaceManager;

async function exec(cmd: string, args: string[], cwd: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: "pipe" });
    child.on("close", (code: number) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`)),
    );
    child.on("error", reject);
  });
}

async function captureGit(args: string[], cwd: string): Promise<string> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: "pipe" });
    let stdout = "";
    child.stdout!.on("data", (d: Buffer) => (stdout += d.toString()));
    child.on("close", (code: number) =>
      code === 0 ? resolve(stdout) : reject(new Error(`git ${args.join(" ")} exited ${code}`)),
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conduct-manager-test-"));
  repoDir = path.join(tmpDir, "repo");
  await initRepo(repoDir);
  process.env.HOME = tmpDir;
  manager = await WorkspaceManager.open(repoDir);
}, 30000);

afterAll(async () => {
  if (manager) manager.shutdown();
  await new Promise((r) => setTimeout(r, 200));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function waitForStatus(
  id: string,
  predicate: (status: WorkspaceStatus) => boolean,
  timeoutMs = 10000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      manager.off("update", onUpdate);
      reject(new Error(`Timeout waiting for workspace ${id}`));
    }, timeoutMs);
    const onUpdate = () => {
      const ws = manager.get(id);
      if (ws && predicate(ws.status)) {
        clearTimeout(timer);
        manager.off("update", onUpdate);
        resolve();
      }
    };
    manager.on("update", onUpdate);
    onUpdate();
  });
}

function waitForNotRunning(id: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      manager.off("update", onUpdate);
      reject(new Error(`Timeout waiting for workspace ${id} to stop running`));
    }, timeoutMs);
    const onUpdate = () => {
      if (!manager.isRunning(id)) {
        clearTimeout(timer);
        manager.off("update", onUpdate);
        resolve();
      }
    };
    manager.on("update", onUpdate);
    onUpdate();
  });
}

// Resolve once the in-app runner command for `id` has finished. Unlike the
// agent waiters, this is NOT primed with an immediate check: a command is only
// considered done once it has both started and stopped, and runCommand marks it
// running synchronously, so the caller invokes this right after a `true` return.
function waitForCommandDone(id: string, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      manager.off("update", onUpdate);
      reject(new Error(`Timeout waiting for command in ${id}`));
    }, timeoutMs);
    const onUpdate = () => {
      if (!manager.isCommandRunning(id)) {
        clearTimeout(timer);
        manager.off("update", onUpdate);
        resolve();
      }
    };
    manager.on("update", onUpdate);
  });
}

describe("WorkspaceManager integration", () => {
  it("creates a workspace with mock agent and it completes", async () => {
    const ws = await manager.createWorkspace({
      title: "Test integration",
      prompt: "Add a simple test file",
      agentId: "mock",
    });

    expect(ws.id).toBeDefined();
    expect(ws.title).toBe("Test integration");
    expect(ws.branch).toContain("conduct/test-integration");

    // Wait for the mock agent to finish its turn
    await waitForStatus(ws.id, (s) => s === "done" || s === "error");

    // The diff stat refresh (refreshStat) is async and may fire after the
    // status update, so wait a tick for it to settle.
    await new Promise((r) => setTimeout(r, 200));

    const updated = manager.get(ws.id);
    expect(updated).toBeDefined();
    expect(updated!.status).toBe("done");
    expect(updated!.output.length).toBeGreaterThan(0);
    // Should have written a file (the mock agent writes CONDUCT_NOTES.md)
    expect(updated!.stat).toBeDefined();
    expect(updated!.stat!.files).toBeGreaterThanOrEqual(1);
  }, 15000);

  it("stops a running workspace", async () => {
    const ws = await manager.createWorkspace({
      title: "Stop test",
      prompt: "Do something slowly",
      agentId: "mock",
    });

    // Give the agent a moment to start
    await waitForStatus(ws.id, (s) => s === "running" || s === "done" || s === "error");

    const mid = manager.get(ws.id);
    if (mid?.status === "running") {
      manager.stop(ws.id);
      // Wait for the process to fully exit and update status
      await new Promise((r) => setTimeout(r, 500));
      const stopped = manager.get(ws.id);
      // SIGTERM to bash while blocked on read gives non-zero exit → "error".
      expect(stopped).toBeDefined();
      // The agent stops; status after kill may be "error" (bash exits
      // non-zero on SIGTERM) or "done" if it had already finished.
      expect(["done", "stopped", "error"]).toContain(stopped!.status);
    } else {
      // Agent finished before we could stop it — that's fine.
      expect(["done", "error"]).toContain(mid!.status);
    }
  }, 15000);

  it("sends input to a running interactive agent", async () => {
    const ws = await manager.createWorkspace({
      title: "Input test",
      prompt: "Hello, how are you?",
      agentId: "mock",
    });

    // Wait for the agent to finish its turn
    await waitForStatus(ws.id, (s) => s === "done" || s === "error");

    const updated = manager.get(ws.id);
    expect(updated).toBeDefined();

    // Send a reply
    const result = manager.sendInput(ws.id, "I'm good, thanks!");
    expect(result).toBe(true);

    // Wait for the next turn to complete
    await waitForStatus(ws.id, (s) => s === "done" || s === "error");

    const afterReply = manager.get(ws.id);
    expect(afterReply!.output.some((l) => l.includes("I'm good, thanks!"))).toBe(true);
  }, 15000);

  it("broadcasts input to several marked workspaces, skipping ineligible ones", async () => {
    const targets = await manager.createWorkspaces({
      title: "Broadcast test",
      prompt: "Standing by",
      agentId: "mock",
      count: 2,
    });

    for (const ws of targets) {
      await waitForStatus(ws.id, (s) => s === "done" || s === "error");
    }

    // Include a bogus id that can't take input — it must be counted as skipped,
    // not sent, so the caller can broadcast to a marked set without pre-filtering.
    const ids = [...targets.map((w) => w.id), "does-not-exist"];
    const { sent, skipped } = manager.broadcastInput(ids, "carry on, please");
    expect(sent).toBe(2);
    expect(skipped).toBe(1);

    for (const ws of targets) {
      await waitForStatus(ws.id, (s) => s === "done" || s === "error");
      const after = manager.get(ws.id);
      expect(after!.output.some((l) => l.includes("carry on, please"))).toBe(true);
    }
  }, 30000);

  it("restarts a completed workspace", async () => {
    const ws = await manager.createWorkspace({
      title: "Restart test",
      prompt: "Write a poem",
      agentId: "mock",
    });

    await waitForStatus(ws.id, (s) => s === "done" || s === "error");

    // The mock agent process stays alive between turns (blocked on read).
    // Wait for it to actually exit before we can restart.
    if (manager.isRunning(ws.id)) {
      manager.stop(ws.id);
      await waitForNotRunning(ws.id);
    }

    await manager.restart(ws.id);
    expect(manager.isRunning(ws.id)).toBe(true);

    await waitForStatus(ws.id, (s) => s === "done" || s === "error");
    const restarted = manager.get(ws.id);
    expect(restarted!.status).toBe("done");
    expect(restarted!.output.some((l) => l.includes("restart"))).toBe(true);
  }, 15000);

  it("renames a workspace", () => {
    const created = manager.snapshot();
    const ws = created.find((w) => w.status !== "archived" && w.status !== "merged");
    if (!ws) return;

    const result = manager.renameWorkspace(ws.id, "New Name");
    expect(result).toBe(true);
    expect(manager.get(ws.id)!.title).toBe("New Name");
  });

  it("archives a workspace and removes it from the list", async () => {
    const ws = await manager.createWorkspace({
      title: "Archive test",
      prompt: "Will be archived",
      agentId: "mock",
    });

    await waitForStatus(ws.id, (s) => s === "done" || s === "error");
    await manager.archive(ws.id);

    const gone = manager.get(ws.id);
    expect(gone).toBeUndefined();
  }, 15000);

  it("merges a workspace that has changes", async () => {
    const ws = await manager.createWorkspace({
      title: "Merge test",
      prompt: "Add a merge test file",
      agentId: "mock",
    });

    await waitForStatus(ws.id, (s) => s === "done" || s === "error");

    const result = await manager.merge(ws.id);
    expect(result.ok).toBe(true);

    const merged = manager.get(ws.id);
    expect(merged!.status).toBe("merged");
  }, 15000);

  it("creates multiple workspaces with fan-out", async () => {
    const workspaces = await manager.createWorkspaces({
      title: "Fan-out test",
      prompt: "Do something",
      agentId: "mock",
      count: 3,
    });

    expect(workspaces.length).toBe(3);
    expect(workspaces[0].title).toBe("Fan-out test (1/3)");
    expect(workspaces[1].title).toBe("Fan-out test (2/3)");
    expect(workspaces[2].title).toBe("Fan-out test (3/3)");

    const ids = workspaces.map((w) => w.id);
    expect(new Set(ids).size).toBe(3);

    for (const ws of workspaces) {
      await waitForStatus(ws.id, (s) => s === "done" || s === "error");
      const updated = manager.get(ws.id);
      expect(updated).toBeDefined();
    }
  }, 30000);

  it("clones a workspace", async () => {
    const existing = manager.snapshot().find((w) => w.status === "done" && w.prompt);
    if (!existing) return;

    const clone = await manager.cloneWorkspace(existing.id);
    expect(clone).toBeDefined();
    expect(clone!.id).not.toBe(existing.id);
    expect(clone!.agentId).toBe(existing.agentId);
    expect(clone!.prompt).toBe(existing.prompt);
  }, 15000);

  it("handles sendInput and permission flow", async () => {
    const ws = await manager.createWorkspace({
      title: "Permission test",
      prompt: "Do you need permission?",
      agentId: "mock",
    });

    await waitForStatus(ws.id, (s) => s === "done" || s === "error");

    // The mock agent can accept replies
    expect(manager.acceptsInput(ws.id)).toBe(true);

    // Send a follow-up
    const ok = manager.sendInput(ws.id, "Yes, proceed");
    expect(ok).toBe(true);

    await waitForStatus(ws.id, (s) => s === "done" || s === "error");

    const after = manager.get(ws.id);
    expect(after!.output.some((l) => l.includes("Yes, proceed"))).toBe(true);
  }, 15000);

  it("checkpoints snapshot stays consistent", () => {
    const snap = manager.snapshot();
    expect(Array.isArray(snap)).toBe(true);
    for (const ws of snap) {
      expect(ws.id).toBeDefined();
      expect(ws.status).toBeDefined();
      expect(ws.output).toBeInstanceOf(Array);
    }
  });

  it("isRunning returns false for unknown id", () => {
    expect(manager.isRunning("does-not-exist")).toBe(false);
  });

  it("acceptsInput returns false for unknown id", () => {
    expect(manager.acceptsInput("does-not-exist")).toBe(false);
  });

  it("sendInput returns false for unknown id", () => {
    expect(manager.sendInput("does-not-exist", "hello")).toBe(false);
  });

  it("get returns undefined for unknown id", () => {
    expect(manager.get("does-not-exist")).toBeUndefined();
  });

  it("renameWorkspace returns false for blank title", async () => {
    const ws = await manager.createWorkspace({
      title: "Rename blank test",
      prompt: "test",
      agentId: "mock",
    });
    expect(manager.renameWorkspace(ws.id, "")).toBe(false);
    expect(manager.renameWorkspace(ws.id, "   ")).toBe(false);
  }, 15000);

  it("runs a one-off command in the worktree and captures its output", async () => {
    const ws = await manager.createWorkspace({
      title: "Run command test",
      prompt: "standby",
      agentId: "mock",
    });
    await waitForStatus(ws.id, (s) => s === "done" || s === "error");

    expect(manager.runCommand(ws.id, "echo hello-from-runner")).toBe(true);
    await waitForCommandDone(ws.id);

    const after = manager.get(ws.id)!;
    const text = (after.shellOutput ?? []).join("\n");
    // The command line is echoed, its stdout captured, and the exit recorded —
    // all in the separate shell buffer, never in the agent transcript.
    expect(text).toContain("$ echo hello-from-runner");
    expect(text).toContain("hello-from-runner");
    expect(text).toContain("[exited 0]");
    expect(after.shellRunning).toBe(false);
    expect(manager.isCommandRunning(ws.id)).toBe(false);
    expect(after.output.join("\n")).not.toContain("hello-from-runner");
  }, 15000);

  it("records a non-zero exit code from a runner command", async () => {
    const ws = await manager.createWorkspace({
      title: "Failing command test",
      prompt: "standby",
      agentId: "mock",
    });
    await waitForStatus(ws.id, (s) => s === "done" || s === "error");

    expect(manager.runCommand(ws.id, "exit 3")).toBe(true);
    await waitForCommandDone(ws.id);
    expect((manager.get(ws.id)!.shellOutput ?? []).join("\n")).toContain("[exited 3]");
  }, 15000);

  it("refuses a blank command and an unknown workspace", async () => {
    const ws = await manager.createWorkspace({
      title: "Blank command test",
      prompt: "standby",
      agentId: "mock",
    });
    await waitForStatus(ws.id, (s) => s === "done" || s === "error");
    expect(manager.runCommand(ws.id, "   ")).toBe(false);
    expect(manager.runCommand("does-not-exist", "echo hi")).toBe(false);
  }, 15000);

  it("runs only one command per workspace at a time, and stops it on request", async () => {
    const ws = await manager.createWorkspace({
      title: "One at a time test",
      prompt: "standby",
      agentId: "mock",
    });
    await waitForStatus(ws.id, (s) => s === "done" || s === "error");

    expect(manager.runCommand(ws.id, "sleep 5")).toBe(true);
    expect(manager.isCommandRunning(ws.id)).toBe(true);
    // A second command is rejected while the first is still live.
    expect(manager.runCommand(ws.id, "echo nope")).toBe(false);

    manager.stopCommand(ws.id);
    await waitForCommandDone(ws.id);
    expect(manager.isCommandRunning(ws.id)).toBe(false);
    // With the worktree free again, a fresh command runs.
    expect(manager.runCommand(ws.id, "echo after-stop")).toBe(true);
    await waitForCommandDone(ws.id);
    expect((manager.get(ws.id)!.shellOutput ?? []).join("\n")).toContain("after-stop");
  }, 20000);

  it("shutdown kills processes and does not throw", async () => {
    const ws = await manager.createWorkspace({
      title: "Shutdown test",
      prompt: "Running for shutdown",
      agentId: "mock",
    });

    await new Promise((r) => setTimeout(r, 300));
    expect(manager.isRunning(ws.id)).toBe(true);
    expect(() => manager.shutdown()).not.toThrow();
  }, 15000);
});

/**
 * Exercises pushing a finished workspace's branch to a remote end to end,
 * using a bare repo on disk as "origin" so no network is involved. PR creation
 * needs the `gh` CLI plus a real GitHub remote, neither of which is available
 * here, so we assert the part we control: the branch reaches the remote and the
 * PR step reports `pushed: true` even when it can't finish.
 */
describe("WorkspaceManager — push & pull request", () => {
  let pTmp: string;
  let pRepo: string;
  let pBare: string;
  let pManager: WorkspaceManager;
  let savedHome: string | undefined;

  function waitDone(id: string, timeoutMs = 10000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pManager.off("update", onUpdate);
        reject(new Error(`timeout waiting for ${id}`));
      }, timeoutMs);
      const onUpdate = () => {
        const ws = pManager.get(id);
        if (ws && (ws.status === "done" || ws.status === "error")) {
          clearTimeout(timer);
          pManager.off("update", onUpdate);
          resolve();
        }
      };
      pManager.on("update", onUpdate);
      onUpdate();
    });
  }

  beforeAll(async () => {
    pTmp = fs.mkdtempSync(path.join(os.tmpdir(), "conduct-push-test-"));
    pRepo = path.join(pTmp, "repo");
    await initRepo(pRepo);
    // A bare repo standing in for the GitHub remote.
    pBare = path.join(pTmp, "origin.git");
    await exec("git", ["init", "--bare", pBare], pTmp);
    await exec("git", ["remote", "add", "origin", pBare], pRepo);

    savedHome = process.env.HOME;
    process.env.HOME = pTmp;
    pManager = await WorkspaceManager.open(pRepo);
  }, 30000);

  afterAll(async () => {
    if (pManager) pManager.shutdown();
    await new Promise((r) => setTimeout(r, 200));
    if (savedHome !== undefined) process.env.HOME = savedHome;
    try { fs.rmSync(pTmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("pushes a finished workspace's branch to origin", async () => {
    const ws = await pManager.createWorkspace({
      title: "Push me",
      prompt: "Write something to push",
      agentId: "mock",
    });
    await waitDone(ws.id);

    const result = await pManager.push(ws.id);
    expect(result.ok).toBe(true);
    expect(result.remote).toBe("origin");
    expect(result.branch).toBe(ws.branch);
    expect(pManager.get(ws.id)!.pushedRemote).toBe("origin");

    // The branch must now exist in the bare "remote".
    const refs = await captureGit(["branch", "--list"], pBare);
    expect(refs).toContain(ws.branch);
  }, 20000);

  it("reports a missing remote rather than throwing", async () => {
    const ws = await pManager.createWorkspace({
      title: "No remote here",
      prompt: "Write something",
      agentId: "mock",
    });
    await waitDone(ws.id);

    const result = await pManager.push(ws.id, "nonexistent-remote");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("nonexistent-remote");
  }, 20000);

  it("openPullRequest pushes even when the PR step can't complete", async () => {
    const ws = await pManager.createWorkspace({
      title: "PR me",
      prompt: "Write something for a PR",
      agentId: "mock",
    });
    await waitDone(ws.id);

    const pr = await pManager.openPullRequest(ws.id);
    // The branch reached the remote regardless of whether gh + GitHub are set up.
    expect(pr.pushed).toBe(true);
    expect(pManager.get(ws.id)!.pushedRemote).toBe("origin");
    const refs = await captureGit(["branch", "--list"], pBare);
    expect(refs).toContain(ws.branch);
  }, 20000);
});

/**
 * Exercises the resumable (re-run-per-turn) agent path end to end against the
 * real `opencode` backend, using a fake `opencode` on PATH so no model is
 * needed. The fake records every invocation to a session log in the worktree,
 * so we can assert the reply re-ran the CLI with `--continue` and the
 * conversation accumulated across turns — the whole point of making opencode
 * interactive.
 */
describe("WorkspaceManager — resumable agent (opencode)", () => {
  let rTmp: string;
  let rRepo: string;
  let rManager: WorkspaceManager;
  let savedHome: string | undefined;
  let savedPath: string | undefined;

  function waitDone(id: string, timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        rManager.off("update", onUpdate);
        reject(new Error(`timeout waiting for ${id} to finish`));
      }, timeoutMs);
      const onUpdate = () => {
        const ws = rManager.get(id);
        if (ws && (ws.status === "done" || ws.status === "error") && !rManager.isRunning(id)) {
          clearTimeout(timer);
          rManager.off("update", onUpdate);
          resolve();
        }
      };
      rManager.on("update", onUpdate);
      onUpdate();
    });
  }

  beforeAll(async () => {
    rTmp = fs.mkdtempSync(path.join(os.tmpdir(), "conduct-resume-test-"));
    rRepo = path.join(rTmp, "repo");
    await initRepo(rRepo);

    // A stand-in `opencode` that needs no model: it appends each turn's message
    // to a session log in the cwd (the worktree), tagging whether the turn was a
    // resume (`--continue`) so the test can prove the conversation continued.
    const binDir = path.join(rTmp, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const fake = path.join(binDir, "opencode");
    fs.writeFileSync(
      fake,
      [
        "#!/usr/bin/env bash",
        "shift # drop the leading 'run'",
        "cont=0; msg=''",
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in --continue) cont=1 ;; *) msg="$1" ;; esac; shift',
        "done",
        'if [ "$cont" -eq 1 ]; then echo "continue: $msg" >> conduct-session.log; echo "resumed: $msg";',
        'else echo "session: $msg" >> conduct-session.log; echo "started: $msg"; fi',
        "exit 0",
        "",
      ].join("\n"),
    );
    fs.chmodSync(fake, 0o755);

    savedHome = process.env.HOME;
    savedPath = process.env.PATH;
    process.env.HOME = rTmp;
    // Child processes inherit the parent's PATH (the manager spreads
    // process.env), so prepending the fake's dir makes `opencode` resolve to it.
    process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;

    rManager = await WorkspaceManager.open(rRepo);
  }, 30000);

  afterAll(async () => {
    if (rManager) rManager.shutdown();
    await new Promise((r) => setTimeout(r, 200));
    if (savedHome !== undefined) process.env.HOME = savedHome;
    if (savedPath !== undefined) process.env.PATH = savedPath;
    try { fs.rmSync(rTmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("runs an initial turn, then continues the session on reply", async () => {
    const ws = await rManager.createWorkspace({
      title: "Resume flow",
      prompt: "kick things off",
      agentId: "opencode",
    });

    await waitDone(ws.id);

    // The one-shot exited, so the workspace is idle and reviewable — and because
    // it's a resumable agent, it can take a reply even though no process is live.
    const after = rManager.get(ws.id)!;
    expect(after.status).toBe("done");
    expect(rManager.isRunning(ws.id)).toBe(false);
    expect(rManager.acceptsInput(ws.id)).toBe(true);

    // Reply: this must re-spawn `opencode run --continue <reply>`.
    expect(rManager.sendInput(ws.id, "now go further")).toBe(true);
    await waitDone(ws.id);

    const log = fs.readFileSync(
      path.join(after.path, "conduct-session.log"),
      "utf8",
    );
    // Both turns landed, and the second came in over --continue (the resume).
    expect(log).toContain("session: kick things off");
    expect(log).toContain("continue: now go further");
  }, 20000);

  it("refuses a reply while a turn is in flight, accepts it once idle", async () => {
    const ws = await rManager.createWorkspace({
      title: "Idle gating",
      prompt: "first",
      agentId: "opencode",
    });
    await waitDone(ws.id);
    // Idle now → replyable.
    expect(rManager.acceptsInput(ws.id)).toBe(true);
    expect(rManager.sendInput(ws.id, "second")).toBe(true);
    // A turn is now in flight (process re-spawned); a further reply is refused
    // until it finishes, so we don't interleave two turns on one session.
    if (rManager.isRunning(ws.id)) {
      expect(rManager.acceptsInput(ws.id)).toBe(false);
      expect(rManager.sendInput(ws.id, "too soon")).toBe(false);
    }
    await waitDone(ws.id);
    expect(rManager.acceptsInput(ws.id)).toBe(true);
  }, 20000);
});

/**
 * Exercises the per-worktree `setup` commands (conduct.json) that run before the
 * agent starts. Each test points the manager at its own repo carrying a specific
 * `setup` config so the success and failure paths can be asserted independently.
 */
describe("WorkspaceManager — worktree setup commands", () => {
  let sTmp: string;
  let savedHome: string | undefined;

  async function openWith(setup: unknown): Promise<{ repo: string; mgr: WorkspaceManager }> {
    const repo = path.join(sTmp, `repo-${Math.abs(JSON.stringify(setup).length)}-${Date.now()}`);
    await initRepo(repo);
    fs.writeFileSync(path.join(repo, "conduct.json"), JSON.stringify({ setup }));
    const mgr = await WorkspaceManager.open(repo);
    return { repo, mgr };
  }

  function waitFor(
    mgr: WorkspaceManager,
    id: string,
    predicate: (s: WorkspaceStatus) => boolean,
    timeoutMs = 10000,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        mgr.off("update", onUpdate);
        reject(new Error(`timeout waiting for ${id}`));
      }, timeoutMs);
      const onUpdate = () => {
        const ws = mgr.get(id);
        if (ws && predicate(ws.status)) {
          clearTimeout(timer);
          mgr.off("update", onUpdate);
          resolve();
        }
      };
      mgr.on("update", onUpdate);
      onUpdate();
    });
  }

  beforeAll(() => {
    sTmp = fs.mkdtempSync(path.join(os.tmpdir(), "conduct-setup-test-"));
    savedHome = process.env.HOME;
    process.env.HOME = sTmp;
  });

  afterAll(() => {
    if (savedHome !== undefined) process.env.HOME = savedHome;
    try { fs.rmSync(sTmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("runs setup in the worktree before the agent starts", async () => {
    const { mgr } = await openWith([
      "echo SETUP_LINE",
      "printf 'ready\\n' > setup-marker.txt",
    ]);
    try {
      const ws = await mgr.createWorkspace({
        title: "Setup ok",
        prompt: "standby",
        agentId: "mock",
      });
      await waitFor(mgr, ws.id, (s) => s === "done" || s === "error");
      const after = mgr.get(ws.id)!;
      expect(after.status).toBe("done");

      // The setup marker file the command wrote must exist in the worktree.
      expect(fs.existsSync(path.join(after.path, "setup-marker.txt"))).toBe(true);

      const transcript = after.output.join("\n");
      // Setup output is in the transcript, prefixed and bracketing the agent run.
      expect(transcript).toContain("⚙ setup — running 2 commands");
      expect(transcript).toContain("⚙ SETUP_LINE");
      expect(transcript).toContain("⚙ ✓ setup complete");
      // And the agent did run afterwards (the mock writes this line).
      expect(transcript).toContain("writing CONDUCT_NOTES.md");
      // Setup finished, so the transient flag is cleared.
      expect(after.setupRunning).toBeFalsy();
    } finally {
      mgr.shutdown();
    }
  }, 20000);

  it("aborts and does not start the agent when a setup command fails", async () => {
    const { mgr } = await openWith(["exit 7", "echo SHOULD_NOT_RUN"]);
    try {
      const ws = await mgr.createWorkspace({
        title: "Setup fails",
        prompt: "standby",
        agentId: "mock",
      });
      await waitFor(mgr, ws.id, (s) => s === "error");
      const after = mgr.get(ws.id)!;
      expect(after.status).toBe("error");
      expect(after.error).toBe("setup failed");

      const transcript = after.output.join("\n");
      expect(transcript).toContain("⚙ ✗ setup failed (exit 7)");
      // The second setup command and the agent must never have run.
      expect(transcript).not.toContain("SHOULD_NOT_RUN");
      expect(transcript).not.toContain("writing CONDUCT_NOTES.md");
      expect(after.setupRunning).toBeFalsy();
    } finally {
      mgr.shutdown();
    }
  }, 20000);
});
