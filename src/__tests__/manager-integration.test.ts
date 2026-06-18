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
});
