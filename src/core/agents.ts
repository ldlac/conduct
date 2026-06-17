import { run } from "./git.js";
import type { AgentBackend } from "./types.js";

/** Cache of `which <bin>` lookups. */
const availability = new Map<string, boolean>();

async function onPath(bin: string): Promise<boolean> {
  if (availability.has(bin)) return availability.get(bin)!;
  const res = await run("which", [bin]);
  const ok = res.code === 0 && res.stdout.trim().length > 0;
  availability.set(bin, ok);
  return ok;
}

/**
 * Claude Code, headless. Emits stream-json events which we flatten into
 * readable lines. Runs with acceptEdits so it can modify files in the
 * isolated worktree without blocking on permission prompts.
 */
const claude: AgentBackend = {
  id: "claude",
  displayName: "Claude Code",
  isAvailable: () => onPath("claude"),
  buildCommand(prompt) {
    const extra = (process.env.CONDUCT_CLAUDE_ARGS ?? "")
      .split(" ")
      .filter(Boolean);
    return {
      cmd: "claude",
      args: [
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "acceptEdits",
        ...extra,
      ],
    };
  },
  parseLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return null;
    let evt: any;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
    switch (evt.type) {
      case "system":
        return evt.subtype ? `· system: ${evt.subtype}` : null;
      case "assistant":
      case "user": {
        const parts = evt.message?.content ?? [];
        const out: string[] = [];
        for (const p of parts) {
          if (p.type === "text" && p.text?.trim()) out.push(p.text.trim());
          else if (p.type === "tool_use") out.push(`⚙ ${p.name}`);
          else if (p.type === "tool_result") out.push("↳ tool result");
        }
        return out.length ? out.join("\n") : null;
      }
      case "result":
        return evt.result ? `\n✓ ${evt.result}` : "✓ done";
      default:
        return null;
    }
  },
};

/** OpenAI Codex CLI, non-interactive. Output is already human-readable. */
const codex: AgentBackend = {
  id: "codex",
  displayName: "Codex CLI",
  isAvailable: () => onPath("codex"),
  buildCommand(prompt) {
    const extra = (process.env.CONDUCT_CODEX_ARGS ?? "")
      .split(" ")
      .filter(Boolean);
    return { cmd: "codex", args: ["exec", ...extra, prompt] };
  },
};

/**
 * A scripted fake agent. Useful for building/testing the UI without spending
 * API tokens: it streams a few lines then writes a file so there is a diff to
 * review and merge.
 */
const mock: AgentBackend = {
  id: "mock",
  displayName: "Mock (test runner)",
  isAvailable: async () => true,
  buildCommand(prompt) {
    const script = [
      `echo "thinking about: ${prompt.replace(/"/g, "'")}"`,
      "sleep 1",
      'echo "writing CONDUCT_NOTES.md"',
      `printf '# Conduct\\n\\nPrompt was: %s\\n' "${prompt.replace(/"/g, "'")}" > CONDUCT_NOTES.md`,
      "sleep 1",
      'echo "done"',
    ].join(" && ");
    return { cmd: "bash", args: ["-c", script] };
  },
};

const REGISTRY: AgentBackend[] = [claude, codex, mock];

export function listAgents(): AgentBackend[] {
  return REGISTRY;
}

export function getAgent(id: string): AgentBackend {
  const a = REGISTRY.find((x) => x.id === id);
  if (!a) throw new Error(`Unknown agent: ${id}`);
  return a;
}

/** Agents whose CLI is actually installed (mock is always available). */
export async function availableAgents(): Promise<AgentBackend[]> {
  const flags = await Promise.all(REGISTRY.map((a) => a.isAvailable()));
  return REGISTRY.filter((_, i) => flags[i]);
}
