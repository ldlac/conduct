import { run } from "./git.js";
import type { AgentBackend, PermissionRequest } from "./types.js";

/**
 * Heuristic for "the agent's final message asked the user something". Looks at
 * the tail of the text, ignoring trailing whitespace and the closing
 * punctuation/markdown a question might end with (quotes, parens, emphasis), so
 * e.g. `Should I proceed?"` or `...continue?**` still count.
 */
function endsWithQuestion(text: unknown): boolean {
  if (typeof text !== "string") return false;
  const tail = text.trimEnd().replace(/[)\]"'`*_>]+$/, "").trimEnd();
  return tail.endsWith("?");
}

/**
 * Condense a tool-use request into one human line for the permission prompt.
 * Pulls the field that carries the gist of common tools (the command for Bash,
 * the URL for a fetch, the path for a file op) and falls back to just the tool
 * name when the input shape is unfamiliar.
 */
function summarizeToolUse(tool: string, input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    for (const key of ["command", "url", "file_path", "path", "pattern"]) {
      const v = o[key];
      if (typeof v === "string" && v) return `${tool}: ${v}`;
    }
  }
  return tool;
}

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
 * Claude Code, headless, as a persistent interactive session. We use
 * stream-json on *both* sides: events stream out and get flattened into
 * readable lines, while the initial prompt and any later replies stream in over
 * stdin as JSON user messages. Keeping stdin open is what lets you answer
 * questions the agent asks and continue the conversation; the process stays
 * alive between turns rather than exiting after one.
 *
 * Permissions: runs in acceptEdits mode, so edits to files in the isolated
 * worktree are auto-approved (the whole point of the worktree is that they're
 * safe to make), but any other tool — running a shell command, fetching a URL —
 * still needs approval. Rather than silently failing in this headless mode,
 * the CLI emits those requests over the same stdout stream as `control_request`
 * messages; we surface them to the user (see {@link AgentBackend.parseControl})
 * and write the decision back over stdin (see {@link encodePermission}). This
 * is the SDK "control protocol"; the request/response field names below are the
 * one Claude-specific detail to re-check if a CLI upgrade changes the wire
 * format and prompts stop appearing.
 */
const claude: AgentBackend = {
  id: "claude",
  displayName: "Claude Code",
  isAvailable: () => onPath("claude"),
  buildCommand() {
    const extra = (process.env.CONDUCT_CLAUDE_ARGS ?? "")
      .split(" ")
      .filter(Boolean);
    return {
      cmd: "claude",
      // No positional prompt: in stream-json input mode the prompt (and every
      // follow-up) arrives over stdin via encodeInput below.
      args: [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "acceptEdits",
        ...extra,
      ],
    };
  },
  encodeInput(text) {
    return (
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text }] },
      }) + "\n"
    );
  },
  parseControl(line) {
    const trimmed = line.trim();
    if (!trimmed) return null;
    let evt: any;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      return null;
    }
    // Only control_request messages are out-of-band; everything else (assistant
    // text, tool_use, result, …) is normal output handled by parseLine.
    if (evt.type !== "control_request") return null;
    const id = String(evt.request_id ?? evt.requestId ?? "");
    const req = evt.request ?? {};
    if (req.subtype === "can_use_tool") {
      const toolName = String(req.tool_name ?? req.toolName ?? "tool");
      const input = req.input;
      return {
        kind: "permission",
        request: { id, toolName, input, summary: summarizeToolUse(toolName, input) },
      };
    }
    // Some other control request the CLI may open mid-session (an init or
    // capability handshake). The user has nothing to decide here, so reply with
    // a bare success to keep the session moving rather than leaving the CLI
    // blocked waiting on a response we'd otherwise never send.
    return {
      kind: "ack",
      reply:
        JSON.stringify({
          type: "control_response",
          response: { subtype: "success", request_id: id, response: {} },
        }) + "\n",
    };
  },
  encodePermission(req: PermissionRequest, allow) {
    // Echo the original input back on allow so the agent runs exactly what it
    // asked to; on deny, a short reason the agent can relay or work around.
    const response = allow
      ? { behavior: "allow", updatedInput: req.input ?? {} }
      : { behavior: "deny", message: "Denied by the user in conduct." };
    return (
      JSON.stringify({
        type: "control_response",
        response: { subtype: "success", request_id: req.id, response },
      }) + "\n"
    );
  },
  awaitsReply(line) {
    const trimmed = line.trim();
    if (!trimmed) return false;
    let evt: any;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      return false;
    }
    // Every turn ends on a `result` event whose `result` field holds the
    // agent's final message. Because the session stays alive between turns, it
    // only genuinely needs the user when that final message asked a question —
    // otherwise the job is simply done and we don't prompt for a reply.
    if (evt.type !== "result") return false;
    return endsWithQuestion(evt.result);
  },
  turnEnded(line) {
    // Every turn — question or not — ends on a `result` event.
    const trimmed = line.trim();
    if (!trimmed) return false;
    try {
      return JSON.parse(trimmed).type === "result";
    } catch {
      return false;
    }
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
 * opencode CLI, non-interactive. `opencode run <message>` executes a single
 * turn in print mode and exits; its stdout is already human-readable, so no
 * stream-json parsing is needed (unlike Claude). It runs as a one-shot like
 * Codex rather than a persistent stdin session: the prompt is passed as the
 * positional message, and when the process exits the turn is done and the
 * workspace becomes reviewable. CONDUCT_OPENCODE_ARGS injects extra flags
 * (e.g. `--model provider/model`).
 */
const opencode: AgentBackend = {
  id: "opencode",
  displayName: "opencode",
  isAvailable: () => onPath("opencode"),
  buildCommand(prompt) {
    const extra = (process.env.CONDUCT_OPENCODE_ARGS ?? "")
      .split(" ")
      .filter(Boolean);
    return { cmd: "opencode", args: ["run", ...extra, prompt] };
  },
};

/**
 * A scripted fake agent. Useful for building/testing the UI without spending
 * API tokens: it writes a file so there is a diff to review and merge, then —
 * like the real interactive agents — keeps reading stdin and echoes each reply
 * back, so the answer-a-question flow can be exercised end to end. Each line we
 * write to its stdin is a bare line of text (see encodeInput). It only signals
 * "awaiting input" when the message it just echoed ended in a question mark,
 * mirroring the real agents: a plain instruction finishes the turn quietly,
 * while a question parks the workspace waiting for a reply.
 */
const mock: AgentBackend = {
  id: "mock",
  displayName: "Mock (test runner)",
  isAvailable: async () => true,
  buildCommand() {
    const script = [
      'echo "writing CONDUCT_NOTES.md"',
      "printf '# Conduct\\n' > CONDUCT_NOTES.md",
      // Read the initial prompt, then loop on follow-up replies. End each turn
      // with a sentinel that records whether the message was a question, so the
      // manager only marks the workspace as awaiting input when it was.
      'while IFS= read -r line; do echo "you said: $line"; printf "%s\\n" "$line" >> CONDUCT_NOTES.md; case "$line" in *\\?) echo "@@await@@";; *) echo "@@done@@";; esac; done',
    ].join(" && ");
    return { cmd: "bash", args: ["-c", script] };
  },
  encodeInput(text) {
    // Bash `read` is line-oriented, so collapse newlines into spaces.
    return text.replace(/\r?\n/g, " ") + "\n";
  },
  awaitsReply(line) {
    return line.trim() === "@@await@@";
  },
  turnEnded(line) {
    // Both sentinels close a turn; only @@await@@ also awaits a reply.
    const t = line.trim();
    return t === "@@await@@" || t === "@@done@@";
  },
  parseLine(line) {
    // Hide the internal turn-end sentinels from the output view.
    const t = line.trim();
    return t === "@@await@@" || t === "@@done@@" ? null : line;
  },
};

const REGISTRY: AgentBackend[] = [claude, codex, opencode, mock];

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
