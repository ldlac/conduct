import { run } from "./git.js";
import type {
  AgentBackend,
  AgentQuestion,
  PermissionRequest,
  QuestionItem,
  TokenUsage,
} from "./types.js";

/**
 * Known shapes of Claude Code's stream-json protocol events that conduct parses.
 * These are the fields we reach into across parseControl, awaitsReply,
 * turnEnded, parseUsage, and parseLine — anything beyond them is ignored.
 */
export interface ClaudeEvent {
  type?: string;
  subtype?: string;
  request_id?: string | number;
  request?: {
    subtype?: string;
    tool_name?: string;
    input?: unknown;
  };
  result?: string;
  message?: {
    role?: string;
    content?: Array<Record<string, unknown>>;
  };
  usage?: Record<string, number>;
  total_cost_usd?: number;
}

/** Parse a line as a Claude Code protocol event, or null if it isn't JSON. */
export function parseClaudeEvent(line: string): ClaudeEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as ClaudeEvent;
  } catch {
    return null;
  }
}

/**
 * Heuristic for "the agent's final message asked the user something". Looks at
 * the tail of the text, ignoring trailing whitespace and the closing
 * punctuation/markdown a question might end with (quotes, parens, emphasis), so
 * e.g. `Should I proceed?"` or `...continue?**` still count.
 * Also handles the full-width question mark (`？`) used in CJK text.
 */
function endsWithQuestion(text: unknown): boolean {
  if (typeof text !== "string") return false;
  // Strip trailing punctuation/markdown characters that might wrap a question
  // mark, then re-check. The `.` handles cases like `"Really?."` and `!`
  // handles `"Stop!*"` (which is not a question, but we only check for `?`
  // so it won't false-positive).
  const tail = text.trimEnd().replace(/[)\]"'`*_>.!]+$/, "").trimEnd();
  return tail.endsWith("?") || tail.endsWith("？");
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

/** The tool Claude Code uses to ask the user a structured, multiple-choice question. */
const ASK_QUESTION_TOOL = "AskUserQuestion";

/**
 * Pull a structured {@link AgentQuestion} out of an assistant message that
 * called the question tool, or null if this event isn't one. Coerces the tool's
 * raw `input.questions` into our shape, dropping anything malformed; returns
 * null if no well-formed question with options survives. In headless mode the
 * CLI auto-denies this tool, so capturing it here is what lets conduct re-ask
 * the user and feed the answer back as the next turn (see parseQuestion).
 */
function extractAskUserQuestion(evt: ClaudeEvent): AgentQuestion | null {
  if (evt.type !== "assistant") return null;
  for (const part of evt.message?.content ?? []) {
    if (part.type !== "tool_use" || part.name !== ASK_QUESTION_TOOL) continue;
    const input = part.input as { questions?: unknown } | undefined;
    const raw = Array.isArray(input?.questions) ? input!.questions : [];
    const questions: QuestionItem[] = [];
    for (const q of raw) {
      if (!q || typeof q !== "object") continue;
      const o = q as Record<string, unknown>;
      const options = Array.isArray(o.options)
        ? o.options
            .map((opt) => {
              const oo = (opt ?? {}) as Record<string, unknown>;
              return {
                label: typeof oo.label === "string" ? oo.label : "",
                description:
                  typeof oo.description === "string" ? oo.description : undefined,
              };
            })
            .filter((opt) => opt.label)
        : [];
      if (options.length === 0) continue;
      questions.push({
        question: typeof o.question === "string" ? o.question : "",
        header: typeof o.header === "string" ? o.header : "",
        multiSelect: o.multiSelect === true,
        options,
      });
    }
    if (questions.length === 0) return null;
    return { questions, toolUseId: typeof part.id === "string" ? part.id : undefined };
  }
  return null;
}

/**
 * Render a captured {@link AgentQuestion} as readable transcript lines: the
 * prompt followed by its numbered options. Falls back to the bare tool label if
 * the question couldn't be parsed, so a malformed call still leaves a trace.
 */
function renderQuestion(q: AgentQuestion | null): string {
  if (!q) return `⚙ ${ASK_QUESTION_TOOL}`;
  const lines: string[] = [];
  for (const item of q.questions) {
    lines.push(`❓ ${item.question || item.header}`);
    item.options.forEach((opt, i) => {
      lines.push(
        `   ${i + 1}. ${opt.label}${opt.description ? ` — ${opt.description}` : ""}`,
      );
    });
  }
  return lines.join("\n");
}

/**
 * Split a string into CLI arguments, respecting double-quoted groups.
 * "foo bar" becomes one argument "foo bar"; bare words are split on whitespace.
 * Returns an empty array for falsy or whitespace-only input.
 */
export function splitArgs(s: string | undefined): string[] {
  if (!s) return [];
  const args: string[] = [];
  let current = "";
  let inQuote = false;
  for (const ch of s.trim()) {
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (ch === " " && !inQuote) {
      if (current) { args.push(current); current = ""; }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
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
 * safe to make). Other tools — running a shell command, fetching a URL — would
 * need approval, but in this headless (`-p`) mode the CLI can't actually prompt:
 * with no terminal attached it just denies the tool ("requires approval"), and
 * no `can_use_tool` request reaches us to surface as a y/n prompt. So if you
 * need the agent to run arbitrary commands, use the {@link claudeAllPerms}
 * backend below ("Claude Code (all perms)"), which bypasses permission checks
 * entirely and trusts the worktree + merge review as the safety boundary.
 *
 * Override the mode with CONDUCT_CLAUDE_PERMISSION_MODE (`acceptEdits`,
 * `default`, `plan`, `dontAsk`, `auto`, `bypassPermissions`). Pair `acceptEdits`
 * with an `--allowedTools` allowlist via CONDUCT_CLAUDE_ARGS to whitelist the
 * specific commands the agent may run without a prompt. CONDUCT_CLAUDE_ARGS
 * appends extra flags either way.
 *
 * The control-protocol plumbing below (parseControl / encodePermission and the
 * y/n UI it feeds) is kept: if a CLI version does route `can_use_tool` requests
 * to us over stdout, we still surface them. It's just not relied upon today,
 * because this CLI version doesn't emit them in headless mode.
 */
const claude: AgentBackend = {
  id: "claude",
  displayName: "Claude Code",
  isAvailable: () => onPath("claude"),
  buildCommand() {
    const extra = splitArgs(process.env.CONDUCT_CLAUDE_ARGS);
    const permissionMode =
      process.env.CONDUCT_CLAUDE_PERMISSION_MODE?.trim() || "acceptEdits";
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
        permissionMode,
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
    const evt = parseClaudeEvent(line);
    if (!evt || evt.type !== "control_request") return null;
    const id = String(evt.request_id ?? "");
    const req = evt.request;
    // Some other control request the CLI may open mid-session (an init or
    // capability handshake). The user has nothing to decide here, so reply with
    // a bare success to keep the session moving rather than leaving the CLI
    // blocked waiting on a response we'd otherwise never send.
    if (!req || req.subtype !== "can_use_tool") {
      return {
        kind: "ack",
        reply:
          JSON.stringify({
            type: "control_response",
            response: { subtype: "success", request_id: id, response: {} },
          }) + "\n",
      };
    }
    const toolName = String(req.tool_name ?? "tool");
    const input = req.input;
    return {
      kind: "permission",
      request: { id, toolName, input, summary: summarizeToolUse(toolName, input) },
    };
  },
  encodePermission(req: PermissionRequest, allow: boolean) {
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
  parseQuestion(line) {
    const evt = parseClaudeEvent(line);
    return evt ? extractAskUserQuestion(evt) : null;
  },
  awaitsReply(line) {
    const evt = parseClaudeEvent(line);
    // Every turn ends on a `result` event whose `result` field holds the
    // agent's final message. Because the session stays alive between turns, it
    // only genuinely needs the user when that final message asked a question —
    // otherwise the job is simply done and we don't prompt for a reply.
    if (!evt || evt.type !== "result") return false;
    return endsWithQuestion(evt.result);
  },
  turnEnded(line) {
    // Every turn — question or not — ends on a `result` event.
    const evt = parseClaudeEvent(line);
    return evt?.type === "result";
  },
  parseUsage(line): TokenUsage | null {
    // Usage rides on the same `result` event that ends a turn: the CLI reports
    // the turn's token counts under `usage` and its dollar cost under
    // `total_cost_usd`. Field names mirror the API's usage block; this and the
    // control-protocol fields above are the Claude-specific bits to re-check if
    // a CLI upgrade changes the wire format.
    const evt = parseClaudeEvent(line);
    if (!evt || evt.type !== "result") return null;
    const u = evt.usage;
    const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : 0);
    return {
      inputTokens: u ? num(u.input_tokens) : 0,
      outputTokens: u ? num(u.output_tokens) : 0,
      cacheReadTokens: u ? num(u.cache_read_input_tokens) : 0,
      cacheCreationTokens: u ? num(u.cache_creation_input_tokens) : 0,
      costUsd: num(evt.total_cost_usd),
    };
  },
  parseLine(line) {
    const evt = parseClaudeEvent(line);
    if (!evt) return line.trim() || null;
    switch (evt.type) {
      case "system":
        return evt.subtype ? `· system: ${evt.subtype}` : null;
      case "assistant":
      case "user": {
        const parts = evt.message?.content ?? [];
        const out: string[] = [];
        for (const p of parts) {
          const text = p.text as string | undefined;
          const ptype = p.type as string | undefined;
          if (ptype === "text" && text?.trim()) out.push(text.trim());
          else if (ptype === "tool_use") {
            const name = p.name as string | undefined;
            // Spell out a structured question with its options so the
            // transcript stays self-explanatory; the header also surfaces it as
            // a pending question to answer (see manager / parseQuestion).
            if (name === ASK_QUESTION_TOOL) {
              out.push(renderQuestion(extractAskUserQuestion(evt)));
            } else {
              out.push(`⚙ ${name ?? "tool"}`);
            }
          } else if (ptype === "tool_result") out.push("↳ tool result");
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

/**
 * Claude Code with all permission checks bypassed. Identical to {@link claude}
 * in every respect (same stream-json session, control-protocol plumbing, output
 * parsing) except the spawn flags: it adds `--dangerously-skip-permissions`, so
 * the agent can run shell commands, fetch URLs, etc. without any approval. This
 * is the option to pick when a task needs real command execution (installing
 * deps, running builds/tests) — the plain "Claude Code" backend can't prompt for
 * those in headless mode and will just deny them.
 *
 * The safety model is the worktree: the agent is confined to its own isolated
 * git worktree and nothing reaches your real branch until you review the diff
 * and merge. Note this isolates the git tree, not the whole machine — a bypassed
 * agent can still touch the network and files outside the worktree, so choose it
 * deliberately. CONDUCT_CLAUDE_ARGS still appends extra flags here too.
 */
const claudeAllPerms: AgentBackend = {
  ...claude,
  id: "claude-all",
  displayName: "Claude Code (all perms)",
  buildCommand() {
    const extra = splitArgs(process.env.CONDUCT_CLAUDE_ARGS);
    return {
      cmd: "claude",
      args: [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
        ...extra,
      ],
    };
  },
};

/** OpenAI Codex CLI, non-interactive. Output is already human-readable. */
const codex: AgentBackend = {
  id: "codex",
  displayName: "Codex CLI",
  isAvailable: () => onPath("codex"),
  buildCommand(prompt) {
    const extra = splitArgs(process.env.CONDUCT_CODEX_ARGS);
    return { cmd: "codex", args: ["exec", ...extra, prompt] };
  },
};

/**
 * opencode CLI, conversational across turns. `opencode run <message>` executes
 * one turn in print mode and exits; its stdout is already human-readable, so no
 * stream-json parsing is needed (unlike Claude). Unlike a persistent stdin
 * session, opencode resumes by *re-running*: each follow-up is a fresh
 * `opencode run --continue <message>` that picks up the most recent session in
 * the worktree's directory (see {@link AgentBackend.resumeCommand}). Because
 * every conduct workspace is its own worktree directory, `--continue` is scoped
 * to that workspace and never crosses into another — even though all worktrees
 * share one git repository. The process exiting marks the turn's end, so the
 * workspace becomes reviewable and can be replied to. CONDUCT_OPENCODE_ARGS
 * injects extra flags (e.g. `--model provider/model`) on every turn.
 */
const opencode: AgentBackend = {
  id: "opencode",
  displayName: "opencode",
  isAvailable: () => onPath("opencode"),
  buildCommand(prompt) {
    const extra = splitArgs(process.env.CONDUCT_OPENCODE_ARGS);
    return { cmd: "opencode", args: ["run", ...extra, prompt] };
  },
  resumeCommand(text) {
    const extra = splitArgs(process.env.CONDUCT_OPENCODE_ARGS);
    return { cmd: "opencode", args: ["run", "--continue", ...extra, text] };
  },
};

/**
 * opencode with all permission checks bypassed. Same conversational re-run model
 * as {@link opencode} but injects `permission: "allow"` into opencode's config
 * via the OPENCODE_CONFIG_CONTENT escape hatch so every tool (Bash, edit,
 * fetch, etc.) is automatically approved. The env is set on both the initial and
 * the resumed invocation so the bypass holds across every turn. Use this variant
 * when a task needs unrestricted tool access — the worktree + merge review
 * remains the safety boundary. CONDUCT_OPENCODE_ARGS still appends extra flags
 * here too.
 */
const opencodeAllPerms: AgentBackend = {
  ...opencode,
  id: "opencode-all",
  displayName: "opencode (all perms)",
  buildCommand(prompt) {
    const extra = splitArgs(process.env.CONDUCT_OPENCODE_ARGS);
    return {
      cmd: "opencode",
      args: ["run", ...extra, prompt],
      env: { OPENCODE_CONFIG_CONTENT: '{"permission":"allow"}' },
    };
  },
  resumeCommand(text) {
    const extra = splitArgs(process.env.CONDUCT_OPENCODE_ARGS);
    return {
      cmd: "opencode",
      args: ["run", "--continue", ...extra, text],
      env: { OPENCODE_CONFIG_CONTENT: '{"permission":"allow"}' },
    };
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
  parseUsage(line): TokenUsage | null {
    // Synthesize a small per-turn usage delta on each turn-end sentinel so the
    // token/cost badges can be exercised end to end without spending tokens.
    const t = line.trim();
    if (t !== "@@await@@" && t !== "@@done@@") return null;
    return {
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 800,
      cacheCreationTokens: 0,
      costUsd: 0.012,
    };
  },
  parseLine(line) {
    // Hide the internal turn-end sentinels from the output view.
    const t = line.trim();
    return t === "@@await@@" || t === "@@done@@" ? null : line;
  },
};

const REGISTRY: AgentBackend[] = [claude, claudeAllPerms, codex, opencode, opencodeAllPerms, mock];

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
