import { describe, it, expect } from "vitest";
import { cloneTitle, sumUsage } from "../core/manager.js";
import type { TokenUsage, Workspace } from "../core/types.js";

describe("cloneTitle", () => {
  it("appends (copy) to a plain title", () => {
    expect(cloneTitle("Fix login")).toBe("Fix login (copy)");
  });

  it("increments (copy) → (copy 2)", () => {
    expect(cloneTitle("Fix login (copy)")).toBe("Fix login (copy 2)");
  });

  it("increments (copy 2) → (copy 3)", () => {
    expect(cloneTitle("Fix login (copy 2)")).toBe("Fix login (copy 3)");
  });

  it("increments (copy 9) → (copy 10)", () => {
    expect(cloneTitle("Fix login (copy 9)")).toBe("Fix login (copy 10)");
  });

  it("handles empty title", () => {
    expect(cloneTitle("")).toBe("Workspace (copy)");
  });

  it("handles titles with parentheses", () => {
    expect(cloneTitle("Task (urgent)")).toBe("Task (urgent) (copy)");
  });

  it("increments a previously cloned title with high number", () => {
    expect(cloneTitle("Task (copy 42)")).toBe("Task (copy 43)");
  });
});

describe("sumUsage", () => {
  it("returns undefined for empty list", () => {
    expect(sumUsage([])).toBeUndefined();
  });

  it("returns undefined when no workspace has usage", () => {
    const ws: Workspace[] = [
      { id: "1", usage: undefined } as Workspace,
    ];
    expect(sumUsage(ws)).toBeUndefined();
  });

  it("sums usage across multiple workspaces", () => {
    const ws: Workspace[] = [
      {
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 10,
          cacheCreationTokens: 5,
          costUsd: 0.01,
        },
      } as Workspace,
      {
        usage: {
          inputTokens: 200,
          outputTokens: 40,
          cacheReadTokens: 20,
          cacheCreationTokens: 10,
          costUsd: 0.02,
        },
      } as Workspace,
    ];
    const total = sumUsage(ws);
    expect(total?.inputTokens).toBe(300);
    expect(total?.outputTokens).toBe(60);
    expect(total?.cacheReadTokens).toBe(30);
    expect(total?.cacheCreationTokens).toBe(15);
    expect(total?.costUsd).toBe(0.03);
  });

  it("handles mix of workspaces with and without usage", () => {
    const ws: Workspace[] = [
      { id: "1", usage: undefined } as Workspace,
      {
        usage: {
          inputTokens: 50,
          outputTokens: 10,
          cacheReadTokens: 5,
          cacheCreationTokens: 0,
          costUsd: 0.005,
        },
      } as Workspace,
    ];
    const total = sumUsage(ws);
    expect(total?.inputTokens).toBe(50);
    expect(total?.costUsd).toBe(0.005);
  });

  it("sums all-zero usage to zero entries", () => {
    const ws: Workspace[] = [
      {
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0,
        },
      } as Workspace,
    ];
    const total = sumUsage(ws);
    expect(total).toBeDefined();
    expect(total!.inputTokens).toBe(0);
    expect(total!.costUsd).toBe(0);
  });
});
