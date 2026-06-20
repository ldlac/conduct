import { describe, it, expect } from "vitest";
import {
  buildCommitMessage,
  classifyCommitType,
  cloneTitle,
  commitSubject,
  formatQuestionAnswer,
  sumUsage,
} from "../core/manager.js";
import type { AgentQuestion, TokenUsage, Workspace } from "../core/types.js";

describe("formatQuestionAnswer", () => {
  const single: AgentQuestion = {
    questions: [
      {
        question: "Tabs or spaces?",
        header: "Indentation",
        multiSelect: false,
        options: [{ label: "Spaces" }, { label: "Tabs" }],
      },
    ],
  };

  it("returns just the picks for a single question", () => {
    expect(formatQuestionAnswer(single, [["Spaces"]])).toBe("Spaces");
  });

  it("joins multiple picks with commas", () => {
    expect(formatQuestionAnswer(single, [["Spaces", "Tabs"]])).toBe("Spaces, Tabs");
  });

  it("returns an empty string when nothing is selected", () => {
    expect(formatQuestionAnswer(single, [[]])).toBe("");
  });

  it("labels each answer by header when there are several questions", () => {
    const multi: AgentQuestion = {
      questions: [
        { question: "q1", header: "Indentation", multiSelect: false, options: [{ label: "Spaces" }] },
        { question: "q2", header: "Quotes", multiSelect: false, options: [{ label: "Single" }] },
      ],
    };
    expect(formatQuestionAnswer(multi, [["Spaces"], ["Single"]])).toBe(
      "Indentation: Spaces\nQuotes: Single",
    );
  });

  it("omits unanswered questions", () => {
    const multi: AgentQuestion = {
      questions: [
        { question: "q1", header: "Indentation", multiSelect: false, options: [{ label: "Spaces" }] },
        { question: "q2", header: "Quotes", multiSelect: false, options: [{ label: "Single" }] },
      ],
    };
    expect(formatQuestionAnswer(multi, [["Spaces"], []])).toBe("Indentation: Spaces");
  });
});

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

describe("classifyCommitType", () => {
  it("detects each type from its keywords", () => {
    expect(classifyCommitType("Fixed a crash on startup")).toBe("fix");
    expect(classifyCommitType("Added a dark mode toggle")).toBe("feat");
    expect(classifyCommitType("Updated the README")).toBe("docs");
    expect(classifyCommitType("Tested the parser edge cases")).toBe("test");
    expect(classifyCommitType("Optimized the hot loop")).toBe("perf");
    expect(classifyCommitType("Refactored the auth module")).toBe("refactor");
  });

  it("falls back to chore when nothing matches", () => {
    expect(classifyCommitType("Bumped the dependency lockfile")).toBe("chore");
  });

  it("picks the type whose keyword appears earliest", () => {
    // "Added" leads, so it's a feature even though it also fixes something.
    expect(classifyCommitType("Added a guard that fixes the overflow")).toBe(
      "feat",
    );
    // "Fixed" leads here.
    expect(classifyCommitType("Fixed the overflow by adding a guard")).toBe(
      "fix",
    );
  });
});

describe("buildCommitMessage", () => {
  it("falls back to a chore subject from the title when there is no summary", () => {
    expect(buildCommitMessage("Tweak config")).toBe("chore: tweak config");
    expect(buildCommitMessage("Fix login bug")).toBe("fix: login bug");
  });

  it("builds a conventional subject from a one-line summary", () => {
    expect(buildCommitMessage("anything", "Added a commit message feature")).toBe(
      "feat: a commit message feature",
    );
  });

  it("strips conversational lead-ins and trailing punctuation", () => {
    expect(
      buildCommitMessage("t", "I've added a retry to the uploader."),
    ).toBe("feat: a retry to the uploader");
  });

  it("collapses a multi-line summary into a one-line subject", () => {
    const msg = buildCommitMessage(
      "t",
      "Fixed the race in the scheduler\n\nThe lock was released too early.",
    );
    expect(msg).toBe("fix: the race in the scheduler");
  });

  it("respects a summary that already starts with a conventional subject", () => {
    expect(buildCommitMessage("t", "feat(api): add pagination")).toBe(
      "feat(api): add pagination",
    );
  });

  it("caps a long subject to a single conventional-commit line", () => {
    const long =
      "Added an extremely long and exhaustively detailed description of the change that runs well past the conventional subject length limit";
    const msg = buildCommitMessage("t", long);
    // Should be a single-line subject, 72 chars or less.
    expect(msg.split("\n").length).toBe(1);
    expect(msg.length).toBeLessThanOrEqual(72);
    expect(msg.startsWith("feat: ")).toBe(true);
  });

  it("replaces dashes so no em/en dash reaches the message", () => {
    const msg = buildCommitMessage("t", "Added retries — with backoff");
    expect(msg).not.toMatch(/[—–]/);
    expect(msg).toBe("feat: retries, with backoff");
  });

  it("commitSubject returns just the first line", () => {
    expect(
      commitSubject("t", "Fixed the race\n\nlong body here"),
    ).toBe("fix: the race");
  });
});
