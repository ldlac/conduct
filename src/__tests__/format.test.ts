import { describe, it, expect } from "vitest";
import {
  formatDuration,
  formatTokens,
  formatCost,
  statText,
  usageText,
  totalTokens,
} from "../tui/components/WorkspaceList.js";
import type { TokenUsage } from "../core/types.js";

describe("formatDuration", () => {
  it("returns seconds for sub-minute durations", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(1000)).toBe("1s");
    expect(formatDuration(8000)).toBe("8s");
    expect(formatDuration(59000)).toBe("59s");
  });

  it("returns minutes and seconds for sub-hour durations", () => {
    expect(formatDuration(60000)).toBe("1m0s");
    expect(formatDuration(95000)).toBe("1m35s");
    expect(formatDuration(3599000)).toBe("59m59s");
  });

  it("returns hours and minutes for hour+ durations", () => {
    expect(formatDuration(3600000)).toBe("1h0m");
    expect(formatDuration(3725000)).toBe("1h2m");
    expect(formatDuration(7200000)).toBe("2h0m");
  });

  it("handles negative values gracefully", () => {
    expect(formatDuration(-1000)).toBe("0s");
  });
});

describe("formatTokens", () => {
  it("returns plain number below 1000", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(500)).toBe("500");
    expect(formatTokens(999)).toBe("999");
  });

  it("formats thousands as k", () => {
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(1530)).toBe("1.5k");
    expect(formatTokens(999499)).toBe("999.5k");
  });

  it("formats millions as M", () => {
    expect(formatTokens(999500)).toBe("1.0M");
    expect(formatTokens(1000000)).toBe("1.0M");
    expect(formatTokens(2300000)).toBe("2.3M");
  });
});

describe("formatCost", () => {
  it("returns $0 for zero or negative", () => {
    expect(formatCost(0)).toBe("$0");
    expect(formatCost(-1)).toBe("$0");
  });

  it("uses 3 decimal places for sub-cent amounts", () => {
    expect(formatCost(0.001)).toBe("$0.001");
    expect(formatCost(0.0099)).toBe("$0.010");
  });

  it("uses 2 decimal places for cent+ amounts", () => {
    expect(formatCost(0.01)).toBe("$0.01");
    expect(formatCost(0.27)).toBe("$0.27");
    expect(formatCost(1.5)).toBe("$1.50");
  });
});

describe("statText", () => {
  it("returns empty string when stat is undefined", () => {
    expect(statText(undefined)).toBe("");
  });

  it("returns empty string when no files changed", () => {
    expect(statText({ files: 0, insertions: 0, deletions: 0 })).toBe("");
  });

  it("formats insertions and deletions", () => {
    expect(statText({ files: 3, insertions: 120, deletions: 8 })).toBe("+120 -8");
  });
});

describe("totalTokens", () => {
  it("sums all token categories", () => {
    const usage: TokenUsage = {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 30,
      cacheCreationTokens: 20,
      costUsd: 0,
    };
    expect(totalTokens(usage)).toBe(200);
  });
});

describe("usageText", () => {
  it("returns empty string for undefined usage", () => {
    expect(usageText(undefined)).toBe("");
  });

  it("returns empty string when all values are zero", () => {
    expect(
      usageText({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 }),
    ).toBe("");
  });

  it("formats non-zero usage", () => {
    expect(
      usageText({ inputTokens: 1200, outputTokens: 340, cacheReadTokens: 800, cacheCreationTokens: 0, costUsd: 0.27 }),
    ).toBe("2.3k $0.27");
  });
});
