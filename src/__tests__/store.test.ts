import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadState, saveState, saveStateSync } from "../core/store.js";
import type { Workspace } from "../core/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conduct-store-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeWs(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "test-1",
    title: "Test workspace",
    prompt: "do something",
    agentId: "mock",
    branch: "conduct/test-1",
    path: `${tmpDir}/wt-test-1`,
    status: "done",
    output: ["line1", "line2", "line3"],
    createdAt: 1000,
    ...overrides,
  };
}

describe("loadState", () => {
  it("returns [] when no state file exists", async () => {
    const result = await loadState(tmpDir);
    expect(result).toEqual([]);
  });

  it("returns [] for corrupt JSON", async () => {
    fs.writeFileSync(path.join(tmpDir, ".conduct-state.json"), "not json", "utf8");
    const result = await loadState(tmpDir);
    expect(result).toEqual([]);
  });

  it("returns [] for wrong version", async () => {
    const state = JSON.stringify({ version: 99, baseBranch: "main", savedAt: 0, workspaces: [] });
    fs.writeFileSync(path.join(tmpDir, ".conduct-state.json"), state, "utf8");
    const result = await loadState(tmpDir);
    expect(result).toEqual([]);
  });
});

describe("saveState and loadState round-trip", () => {
  it("persists and reloads workspaces", async () => {
    const ws = [makeWs(), makeWs({ id: "test-2", title: "Second" })];
    await saveState(tmpDir, "main", ws);

    const loaded = await loadState(tmpDir);
    expect(loaded.length).toBe(2);
    expect(loaded[0].id).toBe("test-1");
    expect(loaded[0].title).toBe("Test workspace");
    expect(loaded[1].title).toBe("Second");
  });

  it("drops transient runner state (shellOutput / shellRunning)", async () => {
    const ws = makeWs({
      shellOutput: ["$ pnpm test", "ok", "[exited 0]"],
      shellRunning: true,
    });
    await saveState(tmpDir, "main", [ws]);

    const loaded = await loadState(tmpDir);
    // Command output and the live-process flag are session-only — neither
    // should survive to the next launch (see store.ts / runCommand).
    expect(loaded[0].shellOutput).toBeUndefined();
    expect(loaded[0].shellRunning).toBeUndefined();
    // The agent transcript is unaffected.
    expect(loaded[0].output).toEqual(["line1", "line2", "line3"]);
  });

  it("trims output to the most recent lines", async () => {
    const long = makeWs({
      output: Array.from({ length: 500 }, (_, i) => `line ${i}`),
    });
    await saveState(tmpDir, "main", [long]);

    const loaded = await loadState(tmpDir);
    expect(loaded[0].output.length).toBeLessThan(500);
    // Should keep the tail: last line should be "line 499"
    expect(loaded[0].output[loaded[0].output.length - 1]).toBe("line 499");
  });

  it("preserves persisted fields across save/load", async () => {
    const ws = makeWs({
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheCreationTokens: 5,
        costUsd: 0.012,
      },
      stat: { files: 3, insertions: 120, deletions: 8 },
    });
    await saveState(tmpDir, "develop", [ws]);
    const loaded = await loadState(tmpDir);
    expect(loaded[0].usage?.inputTokens).toBe(100);
    expect(loaded[0].usage?.costUsd).toBe(0.012);
    expect(loaded[0].stat?.files).toBe(3);
    expect(loaded[0].stat?.insertions).toBe(120);
  });

  it("saves baseBranch and restores it", async () => {
    await saveState(tmpDir, "feature-branch", [makeWs()]);
    // We can't read back baseBranch from loadState (API only returns workspaces),
    // but this verifies the file is written without error.
    const loaded = await loadState(tmpDir);
    expect(loaded.length).toBe(1);
  });
});

describe("saveStateSync", () => {
  it("writes synchronously", () => {
    const ws = [makeWs({ title: "Sync test" })];
    saveStateSync(tmpDir, "main", ws);
    const filePath = path.join(tmpDir, ".conduct-state.json");
    expect(fs.existsSync(filePath)).toBe(true);
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.workspaces[0].title).toBe("Sync test");
    expect(parsed.version).toBe(1);
  });
});
