import { describe, it, expect } from "vitest";
import {
  sortWorkspaces,
  groupLabel,
} from "../tui/components/WorkspaceList.js";
import type { Workspace } from "../core/types.js";

function make(id: string, status: Workspace["status"], title: string, createdAt: number): Workspace {
  return {
    id,
    title,
    prompt: "",
    agentId: "mock",
    branch: `conduct/${id}`,
    path: `/tmp/${id}`,
    status,
    output: [],
    createdAt,
  };
}

describe("groupLabel", () => {
  it("returns appropriate group for each status", () => {
    expect(groupLabel("running")).toBe("In progress");
    expect(groupLabel("creating")).toBe("In progress");
    expect(groupLabel("done")).toBe("Ready to review");
    expect(groupLabel("stopped")).toBe("Ready to review");
    expect(groupLabel("merged")).toBe("Merged");
    expect(groupLabel("error")).toBe("Failed");
    expect(groupLabel("archived")).toBe("Archived");
  });
});

describe("sortWorkspaces", () => {
  const a = make("1", "done", "B task", 100);
  const b = make("2", "running", "A task", 200);
  const c = make("3", "done", "C task", 150);
  const d = make("4", "error", "D task", 50);
  const items = [a, b, c, d];

  it("groups by lifecycle stage then creation time", () => {
    const sorted = sortWorkspaces(items, "group");
    // running (b) before done (a, c) before error (d)
    expect(sorted.map((w) => w.id)).toEqual(["2", "1", "3", "4"]);
  });

  it("sorts alphabetically by title", () => {
    const sorted = sortWorkspaces(items, "alpha");
    expect(sorted.map((w) => w.title)).toEqual(["A task", "B task", "C task", "D task"]);
  });

  it("sorts newest first", () => {
    const sorted = sortWorkspaces(items, "newest");
    expect(sorted.map((w) => w.id)).toEqual(["2", "3", "1", "4"]);
  });

  it("sorts oldest first", () => {
    const sorted = sortWorkspaces(items, "oldest");
    expect(sorted.map((w) => w.id)).toEqual(["4", "1", "3", "2"]);
  });

  it("defaults to group sort when mode is undefined", () => {
    const sorted = sortWorkspaces(items);
    expect(sorted.map((w) => w.id)).toEqual(["2", "1", "3", "4"]);
  });
});
