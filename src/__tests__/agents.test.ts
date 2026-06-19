import { describe, it, expect } from "vitest";
import { getAgent, listAgents, parseClaudeEvent, splitArgs } from "../core/agents.js";
import type { AgentBackend, PermissionRequest } from "../core/types.js";

describe("parseClaudeEvent", () => {
  it("returns null for empty strings", () => {
    expect(parseClaudeEvent("")).toBeNull();
    expect(parseClaudeEvent("   ")).toBeNull();
  });

  it("returns null for non-JSON", () => {
    expect(parseClaudeEvent("not json")).toBeNull();
    expect(parseClaudeEvent("{broken")).toBeNull();
  });

  it("parses a valid event", () => {
    const evt = parseClaudeEvent('{"type":"result","result":"done"}');
    expect(evt?.type).toBe("result");
    expect(evt?.result).toBe("done");
  });

  it("parses a control event", () => {
    const evt = parseClaudeEvent('{"type":"control_request","request_id":"abc"}');
    expect(evt?.type).toBe("control_request");
    expect(evt?.request_id).toBe("abc");
  });

  it("trims whitespace before parsing", () => {
    const evt = parseClaudeEvent('  {"type":"result"}  ');
    expect(evt?.type).toBe("result");
  });
});

describe("splitArgs", () => {
  it("splits simple space-separated args", () => {
    expect(splitArgs("--verbose --debug")).toEqual(["--verbose", "--debug"]);
  });

  it("handles double-quoted strings as single arguments", () => {
    expect(splitArgs('--model "claude opus 4"')).toEqual(["--model", "claude opus 4"]);
  });

  it("returns empty array for undefined", () => {
    expect(splitArgs(undefined)).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(splitArgs("")).toEqual([]);
  });

  it("ignores leading/trailing whitespace", () => {
    expect(splitArgs("  --flag  ")).toEqual(["--flag"]);
  });

  it("handles mixed quoted and unquoted args", () => {
    expect(splitArgs('-m "commit message" --no-verify')).toEqual(["-m", "commit message", "--no-verify"]);
  });

  it("handles multiple quoted groups", () => {
    expect(splitArgs('--name "John Doe" --path "/some/path with spaces"')).toEqual(["--name", "John Doe", "--path", "/some/path with spaces"]);
  });
});

describe("getAgent", () => {
  it("returns known agents by id", () => {
    expect(getAgent("mock").id).toBe("mock");
    expect(getAgent("claude").id).toBe("claude");
    expect(getAgent("claude-all").id).toBe("claude-all");
    expect(getAgent("codex").id).toBe("codex");
    expect(getAgent("opencode").id).toBe("opencode");
    expect(getAgent("opencode-all").id).toBe("opencode-all");
  });

  it("throws for unknown agent ids", () => {
    expect(() => getAgent("nonexistent")).toThrow("Unknown agent");
  });
});

describe("listAgents", () => {
  it("returns all registered agents", () => {
    const agents = listAgents();
    expect(agents.length).toBe(6);
    expect(agents.map((a) => a.id).sort()).toEqual([
      "claude", "claude-all", "codex", "mock", "opencode", "opencode-all",
    ]);
  });
});

describe("mock agent", () => {
  const mock = getAgent("mock");

  describe("isAvailable", () => {
    it("is always available", async () => {
      await expect(mock.isAvailable()).resolves.toBe(true);
    });
  });

  describe("buildCommand", () => {
    it("runs a Node script so it's cross-platform", () => {
      const cmd = mock.buildCommand("test prompt");
      // Uses the same Node binary running conduct (no bash dependency, so it
      // works on Windows too) with an inline `-e` script.
      expect(cmd.cmd).toBe(process.execPath);
      expect(cmd.args[0]).toBe("-e");
      expect(cmd.args[1]).toContain("CONDUCT_NOTES.md");
    });
  });

  describe("encodeInput", () => {
    it("collapses newlines into spaces and appends newline", () => {
      expect(mock.encodeInput!("hello world")).toBe("hello world\n");
    });

    it("replaces actual newlines with spaces", () => {
      expect(mock.encodeInput!("line1\nline2\nline3")).toBe("line1 line2 line3\n");
    });
  });

  describe("awaitsReply", () => {
    it("returns true for @@await@@ sentinel", () => {
      expect(mock.awaitsReply!("@@await@@")).toBe(true);
    });

    it("returns false for @@done@@ sentinel", () => {
      expect(mock.awaitsReply!("@@done@@")).toBe(false);
    });

    it("returns false for normal output", () => {
      expect(mock.awaitsReply!("hello world")).toBe(false);
    });
  });

  describe("turnEnded", () => {
    it("returns true for @@await@@", () => {
      expect(mock.turnEnded!("@@await@@")).toBe(true);
    });

    it("returns true for @@done@@", () => {
      expect(mock.turnEnded!("@@done@@")).toBe(true);
    });

    it("returns false for normal output", () => {
      expect(mock.turnEnded!("hello world")).toBe(false);
    });
  });

  describe("parseLine", () => {
    it("hides @@await@@ sentinel", () => {
      expect(mock.parseLine!("@@await@@")).toBeNull();
    });

    it("hides @@done@@ sentinel", () => {
      expect(mock.parseLine!("@@done@@")).toBeNull();
    });

    it("passes through normal output", () => {
      expect(mock.parseLine!("hello world")).toBe("hello world");
    });
  });

  describe("parseUsage", () => {
    it("returns usage delta on @@await@@", () => {
      const u = mock.parseUsage!("@@await@@");
      expect(u).not.toBeNull();
      expect(u!.inputTokens).toBeGreaterThan(0);
      expect(u!.outputTokens).toBeGreaterThan(0);
      expect(u!.costUsd).toBeGreaterThan(0);
    });

    it("returns usage delta on @@done@@", () => {
      const u = mock.parseUsage!("@@done@@");
      expect(u).not.toBeNull();
      expect(u!.costUsd).toBe(0.012);
    });

    it("returns null for normal output", () => {
      expect(mock.parseUsage!("hello world")).toBeNull();
    });
  });
});

describe("claude agent", () => {
  const claude = getAgent("claude");

  describe("encodeInput", () => {
    it("wraps text in stream-json user message", () => {
      const result = claude.encodeInput!("Do the thing");
      const parsed = JSON.parse(result);
      expect(parsed.type).toBe("user");
      expect(parsed.message.role).toBe("user");
      expect(parsed.message.content[0].text).toBe("Do the thing");
    });
  });

  describe("parseControl", () => {
    it("returns null for non-control events", () => {
      const line = '{"type":"result","result":"done"}';
      expect(claude.parseControl!(line)).toBeNull();
    });

    it("acks non-tool control requests", () => {
      const line = '{"type":"control_request","request_id":"42","request":{"subtype":"init"}}';
      const result = claude.parseControl!(line);
      expect(result?.kind).toBe("ack");
      expect(result).toBeDefined();
      if (result?.kind !== "ack") return;
      const reply = JSON.parse(result.reply);
      expect(reply.type).toBe("control_response");
      expect(reply.response.subtype).toBe("success");
    });

    it("returns permission event for tool-use requests", () => {
      const line = JSON.stringify({
        type: "control_request",
        request_id: "99",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "ls -la" },
        },
      });
      const result = claude.parseControl!(line);
      expect(result?.kind).toBe("permission");
      expect((result as { kind: "permission"; request: PermissionRequest }).request.toolName).toBe("Bash");
      expect((result as { kind: "permission"; request: PermissionRequest }).request.summary).toContain("ls -la");
    });
  });

  describe("encodePermission", () => {
    it("encodes allow with updatedInput", () => {
      const req: PermissionRequest = { id: "1", toolName: "Bash", summary: "ls" };
      const result = claude.encodePermission!(req, true);
      const parsed = JSON.parse(result);
      expect(parsed.response.subtype).toBe("success");
      expect(parsed.response.response.behavior).toBe("allow");
    });

    it("encodes deny with message", () => {
      const req: PermissionRequest = { id: "2", toolName: "Bash", summary: "rm -rf" };
      const result = claude.encodePermission!(req, false);
      const parsed = JSON.parse(result);
      expect(parsed.response.response.behavior).toBe("deny");
      expect(parsed.response.response.message).toContain("Denied");
    });
  });

  describe("awaitsReply", () => {
    it("returns false for non-result events", () => {
      expect(claude.awaitsReply!('{"type":"system"}')).toBe(false);
    });

    it("returns true when result ends with '?'", () => {
      expect(claude.awaitsReply!('{"type":"result","result":"Should I proceed?"}')).toBe(true);
    });

    it("returns false when result does not end with '?'", () => {
      expect(claude.awaitsReply!('{"type":"result","result":"Done."}')).toBe(false);
    });

    it("handles question with trailing punctuation", () => {
      expect(claude.awaitsReply!('{"type":"result","result":"Continue?**"}')).toBe(true);
    });
  });

  describe("turnEnded", () => {
    it("returns true for result events", () => {
      expect(claude.turnEnded!('{"type":"result","result":"done"}')).toBe(true);
    });

    it("returns false for non-result events", () => {
      expect(claude.turnEnded!('{"type":"system","subtype":"thinking"}')).toBe(false);
    });
  });

  describe("parseUsage", () => {
    it("returns null for non-result events", () => {
      expect(claude.parseUsage!('{"type":"system"}')).toBeNull();
    });

    it("parses usage from result event", () => {
      const line = JSON.stringify({
        type: "result",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 20,
        },
        total_cost_usd: 0.015,
      });
      const u = claude.parseUsage!(line);
      expect(u).not.toBeNull();
      expect(u!.inputTokens).toBe(100);
      expect(u!.outputTokens).toBe(50);
      expect(u!.cacheReadTokens).toBe(30);
      expect(u!.cacheCreationTokens).toBe(20);
      expect(u!.costUsd).toBe(0.015);
    });

    it("handles missing usage fields gracefully", () => {
      const line = '{"type":"result"}';
      const u = claude.parseUsage!(line);
      expect(u).not.toBeNull();
      expect(u!.inputTokens).toBe(0);
      expect(u!.costUsd).toBe(0);
    });
  });

  describe("parseLine", () => {
    it("passes through non-JSON lines", () => {
      expect(claude.parseLine!("Hello from Claude")).toBe("Hello from Claude");
    });

    it("renders system events with subtype", () => {
      expect(claude.parseLine!('{"type":"system","subtype":"thinking"}')).toBe("· system: thinking");
    });

    it("extracts text from user messages", () => {
      const line = JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
      });
      expect(claude.parseLine!(line)).toBe("hello");
    });

    it("extracts text from assistant messages", () => {
      const line = JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "Here is my plan." }] },
      });
      expect(claude.parseLine!(line)).toBe("Here is my plan.");
    });

    it("renders result events with checkmark", () => {
      const line = '{"type":"result","result":"Task complete."}';
      expect(claude.parseLine!(line)).toBe("\n✓ Task complete.");
    });

    it("renders an AskUserQuestion tool_use as the question and its options", () => {
      const out = claude.parseLine!(askQuestionLine());
      expect(out).toContain("❓ Tabs or spaces?");
      expect(out).toContain("1. Spaces — Use spaces.");
      expect(out).toContain("2. Tabs — Use tabs.");
    });
  });

  describe("parseQuestion", () => {
    it("returns null for non-assistant events", () => {
      expect(claude.parseQuestion!('{"type":"result","result":"done"}')).toBeNull();
    });

    it("returns null for assistant messages without AskUserQuestion", () => {
      const line = JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      });
      expect(claude.parseQuestion!(line)).toBeNull();
    });

    it("extracts the structured question and options", () => {
      const q = claude.parseQuestion!(askQuestionLine());
      expect(q).not.toBeNull();
      expect(q!.toolUseId).toBe("toolu_1");
      expect(q!.questions).toHaveLength(1);
      const item = q!.questions[0];
      expect(item.question).toBe("Tabs or spaces?");
      expect(item.header).toBe("Indentation");
      expect(item.multiSelect).toBe(false);
      expect(item.options.map((o) => o.label)).toEqual(["Spaces", "Tabs"]);
    });

    it("drops options with no label and questions with no options", () => {
      const line = JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_2",
              name: "AskUserQuestion",
              input: {
                questions: [
                  { question: "empty", header: "x", options: [{ description: "no label" }] },
                  { question: "real", header: "y", options: [{ label: "Yes" }] },
                ],
              },
            },
          ],
        },
      });
      const q = claude.parseQuestion!(line);
      expect(q!.questions).toHaveLength(1);
      expect(q!.questions[0].question).toBe("real");
    });
  });
});

/** A realistic AskUserQuestion assistant event line, as emitted in headless mode. */
function askQuestionLine(): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "AskUserQuestion",
          input: {
            questions: [
              {
                question: "Tabs or spaces?",
                header: "Indentation",
                multiSelect: false,
                options: [
                  { label: "Spaces", description: "Use spaces." },
                  { label: "Tabs", description: "Use tabs." },
                ],
              },
            ],
          },
        },
      ],
    },
  });
}

describe("claude-all agent", () => {
  const claudeAll = getAgent("claude-all");

  describe("buildCommand", () => {
    it("includes --dangerously-skip-permissions", () => {
      const cmd = claudeAll.buildCommand("test");
      expect(cmd.cmd).toBe("claude");
      expect(cmd.args).toContain("--dangerously-skip-permissions");
    });
  });

  describe("encodeInput", () => {
    it("delegates to base claude", () => {
      const result = claudeAll.encodeInput!("test");
      const parsed = JSON.parse(result);
      expect(parsed.type).toBe("user");
    });
  });
});

describe("codex agent", () => {
  const codex = getAgent("codex");

  describe("buildCommand", () => {
    it("includes exec and prompt", () => {
      const cmd = codex.buildCommand("fix the bug");
      expect(cmd.cmd).toBe("codex");
      expect(cmd.args[0]).toBe("exec");
      expect(cmd.args[cmd.args.length - 1]).toBe("fix the bug");
    });
  });

  describe("isAvailable", () => {
    it("checks for codex on PATH", async () => {
      // Should not throw; codex may or may not be installed
      await expect(codex.isAvailable()).resolves.not.toThrow();
    });
  });
});

describe("opencode agent", () => {
  const opencode = getAgent("opencode");

  describe("buildCommand", () => {
    it("includes run and prompt", () => {
      const cmd = opencode.buildCommand("refactor this");
      expect(cmd.cmd).toBe("opencode");
      expect(cmd.args[0]).toBe("run");
      expect(cmd.args[cmd.args.length - 1]).toBe("refactor this");
    });
  });

  describe("resumeCommand", () => {
    it("is conversational by re-running, not by stdin", () => {
      // It continues across turns, but via resumeCommand (re-run) rather than a
      // persistent stdin session — so it must NOT define encodeInput, or the
      // manager would try to write replies to a process that has already exited.
      expect(opencode.encodeInput).toBeUndefined();
      expect(typeof opencode.resumeCommand).toBe("function");
    });

    it("continues the most recent session with the reply as the message", () => {
      const cmd = opencode.resumeCommand!("and now add tests");
      expect(cmd.cmd).toBe("opencode");
      expect(cmd.args[0]).toBe("run");
      expect(cmd.args).toContain("--continue");
      expect(cmd.args[cmd.args.length - 1]).toBe("and now add tests");
    });
  });
});

describe("opencode-all agent", () => {
  const opencodeAll = getAgent("opencode-all");

  describe("buildCommand", () => {
    it("injects OPENCODE_CONFIG_CONTENT env var", () => {
      const cmd = opencodeAll.buildCommand("test");
      expect(cmd.env).toBeDefined();
      expect(cmd.env!.OPENCODE_CONFIG_CONTENT).toBe('{"permission":"allow"}');
    });
  });

  describe("resumeCommand", () => {
    it("re-runs with --continue and keeps the permission bypass on resume", () => {
      const cmd = opencodeAll.resumeCommand!("keep going");
      expect(cmd.args[0]).toBe("run");
      expect(cmd.args).toContain("--continue");
      expect(cmd.args[cmd.args.length - 1]).toBe("keep going");
      // The bypass must hold on every turn, not just the first.
      expect(cmd.env!.OPENCODE_CONFIG_CONTENT).toBe('{"permission":"allow"}');
    });
  });
});
