import { describe, it, expect } from "vitest";
import {
  initialAgentIndex,
  type AgentInfo,
} from "../tui/components/NewWorkspaceForm.js";

const agents: AgentInfo[] = [
  { id: "claude", displayName: "Claude Code" },
  { id: "codex", displayName: "Codex CLI" },
  { id: "opencode", displayName: "opencode" },
];

describe("initialAgentIndex", () => {
  it("defaults to the first agent when no default is configured", () => {
    expect(initialAgentIndex(agents, undefined)).toBe(0);
  });

  it("selects the configured default agent by id", () => {
    expect(initialAgentIndex(agents, "codex")).toBe(1);
    expect(initialAgentIndex(agents, "opencode")).toBe(2);
  });

  it("falls back to the first agent when the default isn't available", () => {
    // e.g. conduct.json names an agent whose CLI isn't installed, so it never
    // made it into the available list.
    expect(initialAgentIndex(agents, "not-installed")).toBe(0);
  });

  it("falls back to zero on an empty agent list", () => {
    expect(initialAgentIndex([], "claude")).toBe(0);
  });
});
