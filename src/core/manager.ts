import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import { Git, type MergeResult } from "./git.js";
import { getAgent } from "./agents.js";
import { loadState, saveState, saveStateSync } from "./store.js";
import type {
  AgentQuestion,
  AttentionReason,
  TokenUsage,
  Workspace,
} from "./types.js";
import { loadConfig, type ConductConfig } from "./config.js";

const MAX_OUTPUT_LINES = 2000;
/** Debounce window for background state saves during normal operation. */
const SAVE_DEBOUNCE_MS = 500;
/**
 * Upper bound on a single fan-out (see {@link WorkspaceManager.createWorkspaces}).
 * Each workspace is a real worktree plus a live agent process, so spinning up an
 * unbounded number from one keystroke would thrash the disk and the machine;
 * this caps a deliberate "try the same prompt N ways" into a sane range. The
 * form clamps to the same value, so the user never picks more than this.
 */
export const MAX_FANOUT = 8;

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "workspace"
  );
}

let seq = 0;
function genId(): string {
  seq += 1;
  return `${Date.now().toString(36)}-${seq}`;
}

export interface CreateOptions {
  title: string;
  prompt: string;
  agentId: string;
}

/**
 * Owns all workspaces for a single repository: creates worktrees, spawns and
 * streams agent processes, and handles diff/merge/archive. Emits `update`
 * whenever any workspace changes so the UI can re-render from a snapshot.
 */
export class WorkspaceManager extends EventEmitter {
  private workspaces = new Map<string, Workspace>();
  private procs = new Map<string, ChildProcess>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Serializes concurrent save calls so at most one write is in flight. */
  private savePromise: Promise<void> | null = null;
  readonly workspacesRoot: string;

  readonly config: ConductConfig;

  private constructor(
    readonly git: Git,
    readonly baseBranch: string,
    config: ConductConfig,
  ) {
    super();
    this.config = config;
    const repoName = path.basename(git.root);
    this.workspacesRoot = path.join(
      os.homedir(),
      ".conduct",
      "worktrees",
      repoName,
    );
  }

  static async open(cwd: string): Promise<WorkspaceManager> {
    const git = await Git.discover(cwd);
    if (!git) {
      throw new Error(
        `Not a git repository: ${cwd}\nRun conduct from inside a repo, or pass a path: conduct <repo>`,
      );
    }
    if (!(await git.hasCommits())) {
      throw new Error(
        `Repository has no commits yet: ${git.root}\n` +
          `conduct branches each workspace off your current commit, so make an ` +
          `initial commit first — or point it at a repo with history: conduct <repo>`,
      );
    }
    const baseBranch = await git.currentBranch();
    const cfg = await loadConfig(git.root);
    const mgr = new WorkspaceManager(git, baseBranch, cfg);
    await fs.mkdir(mgr.workspacesRoot, { recursive: true });
    await mgr.restore();
    return mgr;
  }

  /**
   * Reload workspaces persisted by a previous session. Agent processes don't
   * survive a restart, so anything that was mid-run is marked `stopped`; any
   * workspace whose worktree has since been removed on disk is dropped.
   */
  private async restore(): Promise<void> {
    const saved = await loadState(this.workspacesRoot);
    for (const ws of saved) {
      if (ws.status === "archived") continue;
      if (ws.path && ws.status !== "merged" && !(await pathExists(ws.path))) {
        continue;
      }
      if (ws.status === "creating" || ws.status === "running") {
        ws.status = "stopped";
      }
      ws.awaitingInput = false;
      // The agent process didn't survive the restart, so any permission or
      // question it was blocked on is stale — there's no live session to answer.
      ws.pendingPermission = undefined;
      ws.pendingQuestion = undefined;
      // Nothing is running, so a stale "started running at" would make the UI
      // tick an elapsed timer for a process that no longer exists.
      ws.runStartedAt = undefined;
      this.workspaces.set(ws.id, ws);
    }
    if (this.workspaces.size > 0) this.touch();
  }

  snapshot(): Workspace[] {
    return [...this.workspaces.values()].sort(
      (a, b) => a.createdAt - b.createdAt,
    );
  }

  get(id: string): Workspace | undefined {
    return this.workspaces.get(id);
  }

  private touch(): void {
    this.emit("update");
    this.scheduleSave();
  }

  /** Persist the workspace list at most once per debounce window. */
  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flushSave();
    }, SAVE_DEBOUNCE_MS);
  }

  /**
   * Persist state immediately, canceling any pending debounced save. Used
   * before critical operations where losing state would orphan workspaces.
   * Serializes via an internal promise chain so at most one write is in flight.
   */
  async flushSave(): Promise<void> {
    this.cancelSave();
    // Chain onto any in-flight save to serialize writes and prevent races.
    const prev = this.savePromise;
    this.savePromise = (async () => {
      try {
        await prev;
      } catch {
        /* ignore errors from prior saves */
      }
      await saveState(this.workspacesRoot, this.baseBranch, this.snapshot());
    })();
    await this.savePromise;
  }

  /**
   * Announce that a workspace just transitioned into a state that wants the
   * user's attention (see {@link AttentionReason}). Emitted as a discrete
   * `attention` event — separate from `update` — so the UI can react once (ring
   * the bell, surface a note) on the edge rather than every render. Fired only
   * on the transition, never repeatedly while the workspace waits.
   */
  private notifyAttention(ws: Workspace, reason: AttentionReason): void {
    this.emit("attention", ws, reason);
  }

  private append(ws: Workspace, text: string): void {
    for (const line of text.split("\n")) ws.output.push(line);
    if (ws.output.length > MAX_OUTPUT_LINES) {
      ws.output.splice(0, ws.output.length - MAX_OUTPUT_LINES);
    }
    this.touch();
  }

  async createWorkspace(opts: CreateOptions): Promise<Workspace> {
    const id = genId();
    const slug = slugify(opts.title || opts.prompt);
    const branch = `conduct/${slug}-${id}`;
    const wtPath = path.join(this.workspacesRoot, `${slug}-${id}`);

    const ws: Workspace = {
      id,
      title: opts.title || opts.prompt.slice(0, 40),
      prompt: opts.prompt,
      agentId: opts.agentId,
      branch,
      path: wtPath,
      status: "creating",
      output: [],
      createdAt: Date.now(),
    };
    this.workspaces.set(id, ws);
    this.touch();

    try {
      await this.git.addWorktree(wtPath, branch, this.baseBranch);
    } catch (err) {
      ws.status = "error";
      ws.error = String(err instanceof Error ? err.message : err);
      this.touch();
      return ws;
    }

    this.startAgent(ws);
    return ws;
  }

  /**
   * Fan one prompt out into `count` independent workspaces — the app's core
   * "race the same task N ways" move, done in a single step instead of cloning
   * after the fact. Each gets its own worktree, branch, and agent process (every
   * worktree/branch already carries a unique id, so they never collide), and a
   * disambiguated title (`Fix login (1/3)`, `(2/3)`, …) so identical attempts
   * stay tellable apart in the list. `count` is clamped to [1, {@link MAX_FANOUT}].
   *
   * Worktrees are created sequentially because `git worktree add` locks the
   * repo's worktree metadata — racing several `add`s off the same repo can fail
   * — but the agents themselves run in parallel once spawned, which is the whole
   * point. Returns the created workspaces in order; with `count` of 1 it's just
   * a one-element fan-out, identical to {@link createWorkspace}.
   */
  async createWorkspaces(
    opts: CreateOptions & { count?: number },
  ): Promise<Workspace[]> {
    const count = Math.max(1, Math.min(MAX_FANOUT, Math.floor(opts.count ?? 1)));
    if (count === 1) return [await this.createWorkspace(opts)];
    const base = opts.title || opts.prompt.slice(0, 40);
    const created: Workspace[] = [];
    for (let i = 0; i < count; i++) {
      created.push(
        await this.createWorkspace({
          ...opts,
          title: `${base} (${i + 1}/${count})`,
        }),
      );
    }
    return created;
  }

  /**
   * Spawn the agent process for a workspace and wire up its streams. `command`
   * overrides what's run: omitted, it's the initial `buildCommand(prompt)`;
   * passed, it's a resumed turn for a {@link AgentBackend.resumeCommand} agent
   * (opencode), which re-runs the CLI per turn rather than holding a session
   * open. Either way the workspace flips to `running`, the turn clock restarts,
   * and stale conflicts are cleared.
   */
  private startAgent(
    ws: Workspace,
    command?: { cmd: string; args: string[]; env?: NodeJS.ProcessEnv },
  ): void {
    const agent = getAgent(ws.agentId);
    const { cmd, args, env } = command ?? agent.buildCommand(ws.prompt);
    // Persistent stdin session (Claude, mock): keep stdin open and stream the
    // prompt/replies in. Resumable agents (opencode) get no stdin — each turn is
    // a fresh process, so replies re-spawn via resumeCommand instead.
    const usesStdin = typeof agent.encodeInput === "function";
    ws.status = "running";
    ws.awaitingInput = false;
    ws.pendingPermission = undefined;
    ws.pendingQuestion = undefined;
    // Start the turn clock so the UI can show how long this run has been going.
    ws.runStartedAt = Date.now();
    // The agent is about to change the worktree, so any conflict list from an
    // earlier merge attempt is now stale — drop it.
    ws.conflicts = undefined;
    this.append(
      ws,
      `$ ${cmd} ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`,
    );

    // Apply extra env vars from conduct.json config (overridable by agent-level env).
    const cfgEnv: NodeJS.ProcessEnv = {};
    if (this.config.env) Object.assign(cfgEnv, this.config.env);
    // Apply per-agent extra CLI args from config via the existing env-var convention.
    const agentCfg = this.config.agents?.[ws.agentId];
    if (agentCfg?.args) {
      const varName = `CONDUCT_${ws.agentId.replace(/-/g, "_").toUpperCase()}_ARGS`;
      const existing = process.env[varName];
      cfgEnv[varName] = existing
        ? `${existing} ${agentCfg.args}`
        : agentCfg.args;
    }

    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        cwd: ws.path,
        env: { ...process.env, ...cfgEnv, ...env },
        // Stdin-session agents keep stdin open so we can stream the prompt and
        // later replies in; one-shot and resumable agents get no stdin at all.
        stdio: [usesStdin ? "pipe" : "ignore", "pipe", "pipe"],
      });
    } catch (err) {
      ws.status = "error";
      ws.error = String(err);
      this.touch();
      return;
    }

    this.procs.set(ws.id, child);

    // Deliver the initial prompt as the session's first message. Only for
    // stdin-session agents and only on the initial launch (no command override);
    // resumed turns carry their message as a CLI argument instead.
    if (usesStdin && !command && child.stdin) {
      child.stdin.write(agent.encodeInput!(ws.prompt));
    }

    const onLine = (raw: string) => {
      // Out-of-band control messages (permission requests, protocol acks) are
      // interleaved with normal output on the same stdout stream. Classify and
      // handle them first; they are not turn boundaries or displayable output.
      const control = agent.parseControl?.(raw);
      if (control) {
        if (control.kind === "ack") {
          child.stdin?.write(control.reply);
        } else {
          // The agent paused to ask permission for a tool. Park the workspace
          // on the request so the UI can prompt; the agent stays alive but
          // blocked until we answer (see respondPermission). Record it in the
          // transcript too, so the request — and the command it wants to run —
          // is visible in the output view, not just the header.
          ws.pendingPermission = control.request;
          this.append(ws, `⏸ permission requested — ${control.request.summary}`);
          // The agent is now blocked until the user answers, so flag it for
          // attention (rings the bell even if the user is looking elsewhere).
          this.notifyAttention(ws, "permission");
        }
        return;
      }
      // A structured multiple-choice question (Claude Code's AskUserQuestion)
      // arrives mid-turn as an ordinary tool_use the CLI then auto-denies — so
      // capture it here and hold it on the workspace until the turn ends, when
      // we surface it as a pending question for the user to answer.
      let changed = false;
      const question = agent.parseQuestion?.(raw);
      if (question) {
        ws.pendingQuestion = question;
        changed = true;
      }
      // An interactive session stays alive between turns, so the process being
      // up no longer means the agent is busy. When a turn ends, flip the idle
      // workspace to `done` (it lands in "Ready to review" and can be merged
      // without a manual stop); a later reply flips it back to `running` (see
      // sendInput). Only flag "awaiting input" when that turn ended on a
      // question — a free-text "…?" (awaitsReply) or a captured structured
      // question — since a turn that merely finished the job shouldn't nag.
      if (usesStdin && agent.turnEnded?.(raw)) {
        ws.awaitingInput = (agent.awaitsReply?.(raw) ?? false) || !!ws.pendingQuestion;
        if (ws.status === "running") ws.status = "done";
        // The turn is over: the agent is idle, so stop its elapsed-time clock.
        ws.runStartedAt = undefined;
        // The agent just went idle, so the worktree has settled: refresh the
        // diff size badge to reflect what this turn produced.
        void this.refreshStat(ws);
        // The agent needs the user now — either to answer its question or to
        // review the finished work. Alert on the transition into idle.
        this.notifyAttention(ws, ws.awaitingInput ? "awaiting-input" : "done");
        changed = true;
      }
      // Token usage rides on the same line that ends a turn; accumulate it into
      // the running session total so the badge reflects the whole conversation,
      // not just the last turn.
      const usage = agent.parseUsage?.(raw);
      if (usage) {
        ws.usage = addUsage(ws.usage, usage);
        changed = true;
      }
      const pretty = agent.parseLine ? agent.parseLine(raw) : raw;
      if (pretty != null) this.append(ws, pretty);
      else if (changed) this.touch();
    };
    const rls: readline.Interface[] = [];
    if (child.stdout) {
      const rl = readline.createInterface({ input: child.stdout });
      rl.on("line", onLine);
      rls.push(rl);
    }
    if (child.stderr) {
      const rl = readline.createInterface({ input: child.stderr });
      rl.on("line", (l) => {
        if (l.trim()) this.append(ws, `⚠ ${l}`);
      });
      rls.push(rl);
    }

    const closeRl = () => { for (const rl of rls) rl.close(); };
    child.on("error", (err) => {
      closeRl();
      ws.status = "error";
      ws.error = String(err);
      this.procs.delete(ws.id);
      this.touch();
    });
    child.on("close", (code) => {
      closeRl();
      ws.exitCode = code ?? 0;
      ws.awaitingInput = false;
      // A request or question from a process that's now gone can't be answered.
      ws.pendingPermission = undefined;
      ws.pendingQuestion = undefined;
      // The process is gone, so the turn clock stops regardless of outcome.
      ws.runStartedAt = undefined;
      if (ws.status === "running") {
        ws.status = code === 0 ? "done" : "error";
        // A one-shot agent (or any process that exits on its own) reaches its
        // terminal state here rather than via a turn boundary; alert the same
        // way an interactive turn end does.
        this.notifyAttention(ws, code === 0 ? "done" : "error");
      }
      this.procs.delete(ws.id);
      void this.refreshStat(ws);
      this.append(ws, `\n[agent exited with code ${code}]`);
    });
  }

  /**
   * Recompute the workspace's diff-size badge from its worktree and emit an
   * update if it changed. Called when the agent goes idle (turn end / exit) and
   * when the diff is viewed — never while the agent is actively working, to
   * avoid racing `git add -N` against in-flight edits. Best-effort: a transient
   * git failure leaves the last-known stat in place.
   */
  private async refreshStat(ws: Workspace): Promise<void> {
    if (!ws.path) return;
    try {
      const stat = await this.git.diffNumstat(ws.path, this.baseBranch);
      const prev = ws.stat;
      if (
        !prev ||
        prev.files !== stat.files ||
        prev.insertions !== stat.insertions ||
        prev.deletions !== stat.deletions
      ) {
        ws.stat = stat;
        this.touch();
      }
    } catch {
      /* worktree may be mid-write; keep the last-known stat */
    }
  }

  isRunning(id: string): boolean {
    return this.procs.has(id);
  }

  /** Whether `id` is an interactive agent that can take a typed reply right now. */
  acceptsInput(id: string): boolean {
    const ws = this.workspaces.get(id);
    if (!ws) return false;
    const agent = getAgent(ws.agentId);
    const child = this.procs.get(id);
    // Stdin-session agents (Claude, mock): a live process with writable stdin.
    if (typeof agent.encodeInput === "function") {
      return !!child?.stdin?.writable;
    }
    // Resumable agents (opencode): no process lives between turns — a reply
    // re-spawns the CLI to continue the session (see sendInput). So it can take
    // input whenever it isn't already mid-turn and the worktree is on disk to
    // resume in. `stopped` is included so a session left by a previous conduct
    // run can be continued: opencode persists sessions on disk, so `--continue`
    // still finds it.
    if (typeof agent.resumeCommand === "function") {
      return (
        !child && !!ws.path && (ws.status === "done" || ws.status === "stopped")
      );
    }
    return false;
  }

  /**
   * Send a user's reply to a running interactive agent — the way to answer a
   * question it asked or steer it further. The message is echoed into the
   * output buffer so the transcript reflects the exchange. Returns false if the
   * workspace can't currently take input.
   */
  sendInput(id: string, text: string): boolean {
    const ws = this.workspaces.get(id);
    if (!ws) return false;
    const agent = getAgent(ws.agentId);

    // Stdin-session agents (Claude, mock): write the reply to the live process.
    if (typeof agent.encodeInput === "function") {
      const child = this.procs.get(id);
      if (!child?.stdin?.writable) return false;
      child.stdin.write(agent.encodeInput(text));
      ws.awaitingInput = false;
      // Whatever the reply was, it answers (or supersedes) any pending question.
      ws.pendingQuestion = undefined;
      // A reply starts a new turn that may rewrite the worktree, so a conflict
      // list from a prior merge attempt no longer reflects reality.
      ws.conflicts = undefined;
      // A reply kicks off a new turn: the agent is working again until it ends
      // the turn (see onLine), so reflect that unless it's already terminal, and
      // restart the elapsed-time clock for the fresh turn.
      if (ws.status === "done" || ws.status === "stopped") {
        ws.status = "running";
        ws.runStartedAt = Date.now();
      }
      this.append(ws, `❯ ${text}`);
      return true;
    }

    // Resumable agents (opencode): there's no live process to write to, so a
    // reply re-spawns the CLI to continue the session with this message.
    // startAgent flips status→running, restarts the turn clock, clears stale
    // conflicts, and logs the invocation; record the reply line first so it
    // reads before that turn's output.
    if (typeof agent.resumeCommand === "function") {
      if (!this.acceptsInput(id)) return false;
      this.append(ws, `❯ ${text}`);
      this.startAgent(ws, agent.resumeCommand(text));
      return true;
    }

    return false;
  }

  /**
   * Answer a workspace's pending structured question (see
   * {@link Workspace.pendingQuestion}). `selections` holds the chosen option
   * labels per question, in the same order as `pendingQuestion.questions`. The
   * picks are formatted into one readable message and sent as the next turn —
   * the agent's question tool was auto-denied, so the answer simply continues
   * the conversation. Returns false if there's nothing pending or the agent
   * can't take input.
   */
  answerQuestion(id: string, selections: string[][]): boolean {
    const ws = this.workspaces.get(id);
    if (!ws?.pendingQuestion) return false;
    const text = formatQuestionAnswer(ws.pendingQuestion, selections);
    if (!text) return false;
    return this.sendInput(id, text);
  }

  /**
   * Send the same reply to every workspace in `ids` that can currently take it —
   * the fleet-level counterpart to {@link sendInput}. This is the payoff of
   * running agents in parallel: steer several of them at once with a single
   * follow-up (e.g. "also add tests") instead of replying to each by hand.
   * Workspaces that aren't running an interactive agent are silently skipped
   * (they can't receive input), so the caller can broadcast to a marked set
   * without first filtering it. Returns how many received the message and how
   * many were skipped, for a user-facing summary.
   */
  broadcastInput(ids: string[], text: string): { sent: number; skipped: number } {
    let sent = 0;
    let skipped = 0;
    for (const id of ids) {
      if (this.sendInput(id, text)) sent++;
      else skipped++;
    }
    return { sent, skipped };
  }

  /**
   * Answer a pending tool-permission request (see
   * {@link Workspace.pendingPermission}): write the user's allow/deny decision
   * to the agent's stdin so it can run — or skip — the tool and continue the
   * turn. Returns false if there's nothing to answer or the agent can't take
   * the response.
   */
  respondPermission(id: string, allow: boolean): boolean {
    const child = this.procs.get(id);
    const ws = this.workspaces.get(id);
    if (!ws?.pendingPermission || !child?.stdin?.writable) return false;
    const agent = getAgent(ws.agentId);
    if (!agent.encodePermission) return false;
    const req = ws.pendingPermission;
    child.stdin.write(agent.encodePermission(req, allow));
    // Clear before appending so the single resulting update carries both the
    // resolved state and the transcript line.
    ws.pendingPermission = undefined;
    this.append(ws, allow ? `✓ allowed ${req.toolName}` : `✗ denied ${req.toolName}`);
    return true;
  }

  stop(id: string): void {
    const child = this.procs.get(id);
    if (child) child.kill("SIGTERM");
  }

  /**
   * Re-run the agent in an existing workspace's worktree. Useful for resuming a
   * workspace left `stopped` by a previous session, or retrying one that ended
   * `done`/`error`. The worktree is reused as-is (any prior changes remain), so
   * this continues on top of earlier work rather than starting from a clean tree.
   */
  async restart(id: string): Promise<void> {
    const ws = this.workspaces.get(id);
    if (!ws) throw new Error("No such workspace");
    if (this.isRunning(id)) throw new Error("Agent is already running");
    if (ws.status === "merged" || ws.status === "archived") {
      throw new Error(`Cannot restart a ${ws.status} workspace`);
    }
    if (!ws.path || !(await pathExists(ws.path))) {
      throw new Error("Worktree is missing — archive and recreate this workspace");
    }
    ws.error = undefined;
    ws.exitCode = undefined;
    this.append(ws, "\n— restart —");
    this.startAgent(ws);
  }

  /**
   * Rename a workspace's display title in place. Only the title changes — the
   * branch, worktree path, and slug were derived from the original title at
   * creation and renaming them would orphan the on-disk worktree, so this is
   * purely cosmetic and safe at any point in the lifecycle. A blank title is
   * ignored. Persisted like any other change. Returns false if there's nothing
   * to rename.
   */
  renameWorkspace(id: string, title: string): boolean {
    const ws = this.workspaces.get(id);
    const trimmed = title.trim();
    if (!ws || !trimmed || trimmed === ws.title) return false;
    ws.title = trimmed;
    this.touch();
    return true;
  }

  /**
   * Create a fresh workspace from an existing one's prompt and agent — a brand
   * new worktree off the current base branch, exactly as if the user had retyped
   * the same thing into the new-workspace form. Useful for re-rolling a prompt
   * (run it again from a clean tree) or fanning a good prompt across attempts.
   * The clone is fully independent: it shares no worktree, branch, or history
   * with the original. Returns the new workspace, or undefined if the source is
   * gone.
   */
  async cloneWorkspace(id: string): Promise<Workspace | undefined> {
    const src = this.workspaces.get(id);
    if (!src) return undefined;
    return this.createWorkspace({
      title: cloneTitle(src.title),
      prompt: src.prompt,
      agentId: src.agentId,
    });
  }

  /**
   * Gather repo context and build a prompt that asks the agent to analyze and
   * improve the codebase autonomously. Delegates to {@link buildAutoImprovePrompt}
   * in `prompt.ts`.
   */
  async buildAutoImprovePrompt(
    focus: "general" | "new-features" = "general",
  ): Promise<string> {
    const {
      buildAutoImprovePrompt: build,
    } = await import("./prompt.js");
    return build(this.git.root, this.git, focus);
  }

  async getDiff(id: string): Promise<string> {
    const ws = this.workspaces.get(id);
    if (!ws || !ws.path) return "";
    const diff = await this.git.diff(ws.path, this.baseBranch);
    // Viewing the diff is a natural moment to refresh the size badge, and the
    // worktree is already settled enough to have produced a diff.
    void this.refreshStat(ws);
    return diff;
  }

  /**
   * Commit any pending work in the worktree, then merge the branch into base.
   *
   * Returns the {@link MergeResult}: on a clean merge the workspace flips to
   * `merged`; on conflict the merge has already been rolled back (base is
   * untouched), the workspace stays reviewable, and the conflicting files are
   * recorded on {@link Workspace.conflicts} so the UI can show them and the
   * user can resolve in the worktree (press `c`) and retry.
   */
  async merge(id: string): Promise<MergeResult> {
    const ws = this.workspaces.get(id);
    if (!ws) throw new Error("No such workspace");
    if (ws.status === "running")
      throw new Error("Agent is still working — wait for it to finish or stop it");
    // An interactive session can still be alive but idle (status `done`): the
    // turn is over and the worktree has settled, so it's safe to merge. Shut
    // the lingering process down first so no agent keeps running against a
    // workspace that's now merged.
    if (this.isRunning(id)) this.stop(id);

    await this.git.commitAll(ws.path, `conduct: ${ws.title}`);
    const result = await this.git.merge(
      ws.branch,
      `Merge conduct workspace: ${ws.title}`,
    );
    if (!result.ok) {
      ws.conflicts = result.conflicts;
      this.touch();
      return result;
    }
    ws.conflicts = undefined;
    ws.status = "merged";
    this.touch();
    return result;
  }

  /** Stop the agent, tear down the worktree and branch, and forget the workspace. */
  async archive(id: string): Promise<void> {
    const ws = this.workspaces.get(id);
    if (!ws) return;
    this.stop(id);
    try {
      if (ws.path) await this.git.removeWorktree(ws.path);
    } catch {
      /* worktree may already be gone */
    }
    try {
      await this.git.deleteBranch(ws.branch);
    } catch {
      /* branch may be merged/gone */
    }
    this.workspaces.delete(id);
    this.procs.delete(id);
    this.touch();
  }

  /** Kill every running agent and flush state synchronously (used on quit). */
  shutdown(): void {
    for (const child of this.procs.values()) child.kill("SIGTERM");
    this.cancelSave();
    try {
      saveStateSync(this.workspacesRoot, this.baseBranch, this.snapshot());
    } catch (err) {
      console.error("conduct: failed to save state on exit:", err);
    }
  }

  private cancelSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }
}

/**
 * Format a user's answer to a structured {@link AgentQuestion} into the message
 * sent back to the agent. `selections[i]` is the chosen labels for question `i`.
 * A single question becomes just its picks ("Spaces"); several become one
 * `header: picks` line each, so the agent can tell which answer goes with which
 * question. Questions left unanswered (no picks) are omitted. Returns "" when
 * nothing was selected, so the caller can decline to send an empty turn.
 */
export function formatQuestionAnswer(
  q: AgentQuestion,
  selections: string[][],
): string {
  const lines: string[] = [];
  q.questions.forEach((item, i) => {
    const picks = selections[i] ?? [];
    if (picks.length === 0) return;
    const joined = picks.join(", ");
    lines.push(
      q.questions.length === 1
        ? joined
        : `${item.header || item.question}: ${joined}`,
    );
  });
  return lines.join("\n");
}

/** Add a per-turn usage delta onto a running total, starting from zero. */
function addUsage(prev: TokenUsage | undefined, delta: TokenUsage): TokenUsage {
  return {
    inputTokens: (prev?.inputTokens ?? 0) + delta.inputTokens,
    outputTokens: (prev?.outputTokens ?? 0) + delta.outputTokens,
    cacheReadTokens: (prev?.cacheReadTokens ?? 0) + delta.cacheReadTokens,
    cacheCreationTokens:
      (prev?.cacheCreationTokens ?? 0) + delta.cacheCreationTokens,
    costUsd: (prev?.costUsd ?? 0) + delta.costUsd,
  };
}

/**
 * Sum the usage across many workspaces into one session total, or undefined if
 * none of them reported any usage. Used by the UI for the status-bar tally.
 */
export function sumUsage(workspaces: Workspace[]): TokenUsage | undefined {
  let total: TokenUsage | undefined;
  for (const ws of workspaces) {
    if (ws.usage) total = addUsage(total, ws.usage);
  }
  return total;
}

/**
 * Derive a title for a cloned workspace. The first clone of "Fix login" becomes
 * "Fix login (copy)"; cloning that again yields "(copy 2)", "(copy 3)", … so
 * repeatedly re-rolling a prompt produces readable, distinct titles rather than
 * a pile of identical "(copy)" names.
 */
export function cloneTitle(title: string): string {
  const base = title || "Workspace";
  const m = base.match(/^(.*?) \(copy(?: (\d+))?\)$/);
  if (m) {
    const n = m[2] ? parseInt(m[2], 10) + 1 : 2;
    return `${m[1]} (copy ${n})`;
  }
  return `${base} (copy)`;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
