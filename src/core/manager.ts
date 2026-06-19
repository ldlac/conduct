import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import { Git, commandExists, run, type MergeResult } from "./git.js";
import { shellInvocation } from "./platform.js";
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
 * Minimum gap between `update` emissions. A running agent prints many lines
 * per second, and each line used to emit `update` synchronously, so the UI
 * re-rendered (and Ink repainted the whole frame) on every line. That made the
 * terminal flicker, kept resetting the cursor, and cleared any in-progress text
 * selection so output couldn't be copy-pasted. Coalescing emissions to ~20fps
 * keeps streaming smooth while staying well below the perception threshold for
 * interactive changes.
 */
const UPDATE_THROTTLE_MS = 50;
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
  /**
   * Fan-out group this workspace belongs to (see {@link Workspace.groupId}). Set
   * by {@link WorkspaceManager.createWorkspaces} for a multi-attempt fan-out so
   * the siblings can later be told apart from unrelated workspaces; omitted for a
   * standalone workspace.
   */
  groupId?: string;
}

/** Outcome of pushing a workspace's branch to a remote (see {@link WorkspaceManager.push}). */
export interface PushResult {
  /** True when the branch reached the remote. */
  ok: boolean;
  /** Remote the branch was pushed to (e.g. "origin"), set when `ok`. */
  remote?: string;
  /** The branch that was pushed, set when `ok`. */
  branch?: string;
  /** Human-readable failure reason, set when not `ok`. */
  error?: string;
}

/**
 * Outcome of opening a pull request for a workspace (see
 * {@link WorkspaceManager.openPullRequest}). The push and the PR creation are
 * distinct steps, so `pushed` is reported separately from `ok`: a branch can
 * reach the remote (`pushed`) even when the `gh` step then fails or is
 * unavailable, in which case the user can open the PR by hand.
 */
export interface PrResult {
  /** True when a pull request was created (or already existed) and we have its URL. */
  ok: boolean;
  /** Whether the branch reached the remote, regardless of the PR step's outcome. */
  pushed: boolean;
  /** URL of the created (or pre-existing) pull request, set when `ok`. */
  url?: string;
  /** Human-readable failure reason, set when not `ok`. */
  error?: string;
}

/** Timeout for the `gh pr create` invocation, which talks to GitHub over the network. */
const GH_TIMEOUT_MS = 120_000;

/** First http(s) URL found in `text`, or undefined. Used to pull a PR link out of `gh` output. */
function firstUrl(text: string): string | undefined {
  return text.match(/https?:\/\/\S+/)?.[0];
}

/**
 * Owns all workspaces for a single repository: creates worktrees, spawns and
 * streams agent processes, and handles diff/merge/archive. Emits `update`
 * whenever any workspace changes so the UI can re-render from a snapshot.
 */
export class WorkspaceManager extends EventEmitter {
  private workspaces = new Map<string, Workspace>();
  private procs = new Map<string, ChildProcess>();
  /**
   * Live processes for one-off commands launched via the in-app runner (see
   * {@link runCommand}), keyed by workspace id. Kept separate from {@link procs}
   * (the agent processes) so a runner command and the agent can be alive at once
   * without either clobbering the other's lifecycle.
   */
  private shellProcs = new Map<string, ChildProcess>();
  /**
   * Live processes for the per-worktree setup commands (see {@link startWithSetup}),
   * keyed by workspace id. Tracked separately from the agent ({@link procs}) and
   * runner ({@link shellProcs}) processes so a setup that's still running can be
   * killed on archive/quit without disturbing the others.
   */
  private setupProcs = new Map<string, ChildProcess>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Pending coalesced `update` emission; see {@link UPDATE_THROTTLE_MS}. */
  private updateTimer: ReturnType<typeof setTimeout> | null = null;
  /** Timestamp of the last `update` emission, for the leading-edge throttle. */
  private lastUpdateAt = 0;
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
    this.scheduleUpdate();
    this.scheduleSave();
  }

  /**
   * Emit `update` at most once per {@link UPDATE_THROTTLE_MS}. The first touch
   * after an idle period fires on the next tick (leading edge, so interactive
   * changes feel instant); touches that arrive during the window are coalesced
   * into a single trailing emission. Listeners read fresh state via
   * {@link snapshot}, so a delayed emit is always up to date.
   */
  private scheduleUpdate(): void {
    if (this.updateTimer) return;
    const wait = Math.max(0, UPDATE_THROTTLE_MS - (Date.now() - this.lastUpdateAt));
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null;
      this.lastUpdateAt = Date.now();
      this.emit("update");
    }, wait);
  }

  /** Persist the workspace list at most once per debounce window. */
  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      // A debounced background save is best-effort: if it fails (e.g. the
      // workspaces dir was removed out from under us), keep the last-known good
      // state rather than letting the rejection escape as an unhandled
      // rejection and crash the process. The next change reschedules a save.
      this.flushSave().catch(() => {});
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
    // Split on both LF and CRLF: child processes on Windows can emit `\r\n`, and
    // a stray trailing `\r` would render as a control glyph in the output pane.
    for (const line of text.split(/\r?\n/)) ws.output.push(line);
    if (ws.output.length > MAX_OUTPUT_LINES) {
      ws.output.splice(0, ws.output.length - MAX_OUTPUT_LINES);
    }
    this.touch();
  }

  /**
   * Append to the workspace's separate command-output buffer (see
   * {@link Workspace.shellOutput}). Mirrors {@link append} but writes the
   * in-app runner's stream instead of the agent transcript, so command output
   * and agent output never interleave in the UI.
   */
  private appendShell(ws: Workspace, text: string): void {
    if (!ws.shellOutput) ws.shellOutput = [];
    for (const line of text.split(/\r?\n/)) ws.shellOutput.push(line);
    if (ws.shellOutput.length > MAX_OUTPUT_LINES) {
      ws.shellOutput.splice(0, ws.shellOutput.length - MAX_OUTPUT_LINES);
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
      groupId: opts.groupId,
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

    // Ready the worktree (config `setup`) and then spawn the agent. Deliberately
    // not awaited: the worktree exists, so the workspace can be returned (and the
    // next fan-out worktree created) right away while setup + the agent run in the
    // background. The workspace stays `creating` until the agent actually starts.
    void this.startWithSetup(ws);
    return ws;
  }

  /**
   * Run the configured setup command(s) in a freshly created worktree, then
   * spawn the agent — the bridge between {@link createWorkspace} and
   * {@link startAgent} that readies an environment git doesn't track (deps, a
   * `.env`, generated code) before the agent works in it. With no `setup`
   * configured this is a thin pass-through to {@link startAgent}. If any setup
   * command fails the agent is *not* started: the workspace lands in `error`
   * with the setup output in its transcript, so a broken environment surfaces
   * loudly instead of an agent flailing in it. Tolerant of the workspace being
   * archived mid-setup (its removal from the map ends the flow quietly).
   */
  private async startWithSetup(ws: Workspace): Promise<void> {
    const ok = await this.runSetup(ws);
    // The workspace may have been archived while setup ran (which kills the
    // setup process and drops it from the map); if so, there's nothing to start.
    if (!this.workspaces.has(ws.id)) return;
    if (!ok) {
      ws.status = "error";
      ws.error = "setup failed";
      ws.setupRunning = false;
      ws.runStartedAt = undefined;
      this.notifyAttention(ws, "error");
      this.touch();
      return;
    }
    this.startAgent(ws);
  }

  /**
   * Run each configured setup command (see {@link config.ConductConfig.setup})
   * in order, streaming its output into the workspace transcript (prefixed `⚙`
   * to set it apart from agent output). Stops at the first non-zero exit and
   * returns false; returns true when all commands succeed or none are
   * configured. Sets {@link Workspace.setupRunning} for the duration so the UI
   * can explain the `creating` state.
   */
  private async runSetup(ws: Workspace): Promise<boolean> {
    const cmds = this.config.setup ?? [];
    if (cmds.length === 0) return true;
    ws.setupRunning = true;
    this.append(
      ws,
      `⚙ setup — running ${cmds.length} command${cmds.length === 1 ? "" : "s"} in the worktree`,
    );
    for (const cmd of cmds) {
      // Bail if the workspace was archived between commands.
      if (!this.workspaces.has(ws.id)) return false;
      this.append(ws, `⚙ $ ${cmd}`);
      const code = await this.runSetupCommand(ws, cmd);
      if (code !== 0) {
        ws.setupRunning = false;
        this.append(ws, `⚙ ✗ setup failed (exit ${code}) — agent not started`);
        this.touch();
        return false;
      }
    }
    ws.setupRunning = false;
    this.append(ws, "⚙ ✓ setup complete");
    this.touch();
    return true;
  }

  /**
   * Spawn one setup command in the worktree and stream its output, resolving
   * with the exit code (non-zero on spawn failure, so the caller treats an
   * un-launchable command as a failed step). Mirrors {@link runCommand}'s shell
   * invocation — the OS shell via {@link shellInvocation} with
   * `CONDUCT_WORKSPACE`/`CONDUCT_WORKTREE` and the config `env` exported — so
   * setup sees the same environment as both the in-app runner and the agent.
   */
  private runSetupCommand(ws: Workspace, command: string): Promise<number> {
    return new Promise((resolve) => {
      const { cmd, args } = shellInvocation(command);
      const cfgEnv: NodeJS.ProcessEnv = {};
      if (this.config.env) Object.assign(cfgEnv, this.config.env);
      let child: ChildProcess;
      try {
        child = spawn(cmd, args, {
          cwd: ws.path,
          env: {
            ...process.env,
            ...cfgEnv,
            CONDUCT_WORKSPACE: ws.title,
            CONDUCT_WORKTREE: ws.path,
          },
          // No stdin: setup commands are non-interactive, exactly like the
          // in-app runner. One that reads stdin sees EOF rather than hanging.
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        this.append(
          ws,
          `⚙ ⚠ ${err instanceof Error ? err.message : String(err)}`,
        );
        resolve(1);
        return;
      }
      this.setupProcs.set(ws.id, child);
      const rls: readline.Interface[] = [];
      if (child.stdout) {
        const rl = readline.createInterface({ input: child.stdout });
        rl.on("line", (l) => this.append(ws, `⚙ ${l}`));
        rls.push(rl);
      }
      if (child.stderr) {
        const rl = readline.createInterface({ input: child.stderr });
        rl.on("line", (l) => this.append(ws, `⚙ ${l}`));
        rls.push(rl);
      }
      const closeRl = () => {
        for (const rl of rls) rl.close();
      };
      child.on("error", (err) => {
        closeRl();
        this.append(ws, `⚙ ⚠ ${err.message}`);
        this.setupProcs.delete(ws.id);
        resolve(1);
      });
      child.on("close", (code) => {
        closeRl();
        this.setupProcs.delete(ws.id);
        resolve(code ?? 0);
      });
    });
  }

  /** Stop a running setup command (see {@link startWithSetup}); a no-op if none is live. */
  private stopSetup(id: string): void {
    const child = this.setupProcs.get(id);
    if (child) child.kill("SIGTERM");
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
    // Tag every attempt of this fan-out with one shared id so they can later be
    // recognized as siblings — the basis for "keep the winner, archive the rest
    // of this race" (see groupSiblings). A standalone workspace (count of 1
    // above) gets none.
    const groupId = `group-${genId()}`;
    const created: Workspace[] = [];
    for (let i = 0; i < count; i++) {
      created.push(
        await this.createWorkspace({
          ...opts,
          title: `${base} (${i + 1}/${count})`,
          groupId,
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
      // The agent's closing message for this turn becomes the basis for the
      // commit/merge message (see buildCommitMessage). Keep the latest one; a
      // new turn's summary overwrites the previous so it always describes the
      // most recent work.
      const summary = agent.parseSummary?.(raw);
      if (summary) {
        ws.summary = summary;
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
   * Run a one-off shell command in a workspace's worktree and stream its output
   * into the workspace's separate command buffer (see {@link Workspace.shellOutput}).
   * This is the in-app counterpart to jumping into a full interactive shell with
   * `c`: a quick `pnpm test` / `git status` / `ls` against the worktree without
   * leaving conduct or tearing down the TUI. The command runs through the OS
   * shell (see {@link shellInvocation}, so pipes, globs, and `&&` work and the
   * inherited PATH/env apply) with the worktree as its cwd and
   * `CONDUCT_WORKSPACE`/`CONDUCT_WORKTREE` exported, exactly like the
   * interactive shell.
   *
   * Only one runner command runs per workspace at a time, so its output stays
   * legible and isn't interleaved with another's; a second call while one is
   * live is rejected. Returns false when the worktree is missing, the command is
   * blank, or one is already running here. The agent process (if any) is
   * untouched — the two run side by side.
   */
  runCommand(id: string, command: string): boolean {
    const ws = this.workspaces.get(id);
    const trimmed = command.trim();
    if (!ws?.path || !trimmed) return false;
    if (this.shellProcs.has(id)) return false;

    const { cmd, args } = shellInvocation(trimmed);
    this.appendShell(ws, `$ ${trimmed}`);
    ws.shellRunning = true;
    this.touch();

    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        cwd: ws.path,
        env: {
          ...process.env,
          CONDUCT_WORKSPACE: ws.title,
          CONDUCT_WORKTREE: ws.path,
        },
        // No stdin: the runner is for non-interactive one-shot commands. A
        // command that blocks waiting on stdin (e.g. a bare `cat`) sees EOF and
        // returns rather than hanging the buffer forever.
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      this.appendShell(
        ws,
        `⚠ failed to start: ${err instanceof Error ? err.message : String(err)}`,
      );
      ws.shellRunning = false;
      this.touch();
      return false;
    }

    this.shellProcs.set(id, child);

    const rls: readline.Interface[] = [];
    if (child.stdout) {
      const rl = readline.createInterface({ input: child.stdout });
      rl.on("line", (l) => this.appendShell(ws, l));
      rls.push(rl);
    }
    if (child.stderr) {
      const rl = readline.createInterface({ input: child.stderr });
      rl.on("line", (l) => this.appendShell(ws, l));
      rls.push(rl);
    }
    const closeRl = () => {
      for (const rl of rls) rl.close();
    };
    child.on("error", (err) => {
      closeRl();
      this.appendShell(ws, `⚠ ${err.message}`);
      ws.shellRunning = false;
      this.shellProcs.delete(id);
      this.touch();
    });
    child.on("close", (code) => {
      closeRl();
      this.appendShell(ws, `[exited ${code ?? 0}]`);
      ws.shellRunning = false;
      this.shellProcs.delete(id);
      // A command can change the worktree (build artifacts, a `git` op), so the
      // diff badge may now be stale — refresh it the same way an agent turn end
      // does. Best-effort; never blocks the command's completion.
      void this.refreshStat(ws);
    });
    return true;
  }

  /** Whether a runner command (see {@link runCommand}) is live in this workspace. */
  isCommandRunning(id: string): boolean {
    return this.shellProcs.has(id);
  }

  /** Stop a running runner command (see {@link runCommand}); a no-op if none is live. */
  stopCommand(id: string): void {
    const child = this.shellProcs.get(id);
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
   * The *other* workspaces created in the same fan-out as `id` — its sibling
   * attempts at the same prompt (see {@link Workspace.groupId}) — excluding the
   * workspace itself. Returns an empty array for a workspace that belongs to no
   * race (created on its own or cloned), which is the cue for the UI to say
   * there's nothing to prune. This is the query behind "keep the winner, archive
   * the rest": pick the attempt you want, and these are the ones to discard.
   */
  groupSiblings(id: string): Workspace[] {
    const ws = this.workspaces.get(id);
    if (!ws?.groupId) return [];
    return [...this.workspaces.values()].filter(
      (w) => w.id !== id && w.groupId === ws.groupId,
    );
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

    await this.git.commitAll(ws.path, buildCommitMessage(ws.title, ws.summary));
    const result = await this.git.merge(
      ws.branch,
      `Merge conduct workspace: ${commitSubject(ws.title, ws.summary)}`,
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

  /**
   * Commit any pending work, then push the workspace's branch to `remote` — the
   * way to get a finished attempt off the local machine without merging it into
   * your base branch. Unlike {@link merge}, pushing is non-destructive to base
   * and leaves any idle interactive session alive (so you can keep steering it),
   * committing the worktree just as merge does so the pushed branch reflects the
   * full diff. Refuses while the agent is mid-turn (the tree isn't settled).
   * Returns a {@link PushResult}; a missing remote or a failed push is reported
   * rather than thrown, so the UI can flash it.
   */
  async push(id: string, remote = "origin"): Promise<PushResult> {
    const ws = this.workspaces.get(id);
    if (!ws) throw new Error("No such workspace");
    if (ws.status === "running")
      throw new Error("Agent is still working — wait for it to finish or stop it");
    if (!ws.path) return { ok: false, error: "workspace has no worktree to push" };
    if (!(await this.git.hasRemote(remote))) {
      return { ok: false, error: `no '${remote}' remote configured for this repo` };
    }
    try {
      await this.git.commitAll(ws.path, buildCommitMessage(ws.title, ws.summary));
      await this.git.push(ws.branch, { remote });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    ws.pushedRemote = remote;
    this.touch();
    return { ok: true, remote, branch: ws.branch };
  }

  /**
   * Push the workspace's branch (via {@link push}) and then open a GitHub pull
   * request against the base branch using the `gh` CLI — the remote counterpart
   * to merging, for when an attempt should land through review rather than
   * straight into base. The two steps are reported independently in the
   * {@link PrResult}: if the push succeeds but `gh` is missing or errors, the
   * branch is still on the remote (`pushed: true`) and the user can open the PR
   * by hand. `gh pr create --fill` derives the title/body from the commits; an
   * already-open PR is treated as success (its URL is captured from `gh`'s
   * stderr). The PR URL is recorded on the workspace and persisted.
   */
  async openPullRequest(id: string, remote = "origin"): Promise<PrResult> {
    const pushed = await this.push(id, remote);
    if (!pushed.ok) return { ok: false, pushed: false, error: pushed.error };
    if (!(await commandExists("gh"))) {
      return {
        ok: false,
        pushed: true,
        error: "pushed, but the GitHub CLI (gh) isn't installed — open the PR yourself",
      };
    }
    const ws = this.workspaces.get(id);
    if (!ws) return { ok: false, pushed: true, error: "workspace vanished" };
    const res = await run(
      "gh",
      ["pr", "create", "--head", ws.branch, "--base", this.baseBranch, "--fill"],
      this.git.root,
      GH_TIMEOUT_MS,
    );
    // gh prints the new PR URL on stdout; when a PR already exists it exits
    // non-zero but names the existing one on stderr. Either URL is a success.
    const url = firstUrl(res.stdout) ?? firstUrl(res.stderr);
    if (!url) {
      return {
        ok: false,
        pushed: true,
        error: res.stderr.trim() || res.stdout.trim() || "gh pr create failed",
      };
    }
    ws.prUrl = url;
    this.touch();
    return { ok: true, pushed: true, url };
  }

  /** Stop the agent, tear down the worktree and branch, and forget the workspace. */
  async archive(id: string): Promise<void> {
    const ws = this.workspaces.get(id);
    if (!ws) return;
    this.stop(id);
    // A runner command or a still-running setup holds the worktree open too;
    // kill both before the worktree is removed out from under them.
    this.stopCommand(id);
    this.stopSetup(id);
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
    this.shellProcs.delete(id);
    this.setupProcs.delete(id);
    this.touch();
  }

  /** Kill every running agent and flush state synchronously (used on quit). */
  shutdown(): void {
    for (const child of this.procs.values()) child.kill("SIGTERM");
    // Runner commands (see runCommand) and setup commands (see startWithSetup)
    // are children too; don't leave a stray `pnpm test` / `pnpm install` running
    // after the TUI quits.
    for (const child of this.shellProcs.values()) child.kill("SIGTERM");
    for (const child of this.setupProcs.values()) child.kill("SIGTERM");
    this.cancelSave();
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }
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

/**
 * Conventional-commit soft limit for the subject line. 72 keeps the subject
 * readable in `git log --oneline` and on GitHub without truncation.
 */
const COMMIT_SUBJECT_MAX = 72;

/**
 * Conventional-commit types we infer from a summary, paired with the words that
 * signal each. Order is the tie-breaker only: when two types' keywords appear,
 * the one whose keyword occurs *earliest* in the text wins (the summary usually
 * leads with the main action — "Added …", "Fixed …"), and ties fall back to
 * this order. `chore` carries no keywords; it's the fallback when none match.
 */
const COMMIT_TYPES: Array<{ type: string; re: RegExp }> = [
  { type: "fix", re: /\b(fix(?:e[sd])?|bug(?:s|fix)?|resolve[sd]?|patch(?:e[sd])?|correct(?:s|ed)?|repair(?:s|ed)?)\b/i },
  { type: "feat", re: /\b(add(?:s|ed)?|implement(?:s|ed)?|introduce[sd]?|support(?:s|ed)?|create[sd]?|new feature|feature)\b/i },
  { type: "docs", re: /\b(document(?:s|ation|ed)?|readme|docstring|comment(?:s|ed)?)\b/i },
  { type: "test", re: /\b(test(?:s|ing|ed)?|spec(?:s)?|coverage)\b/i },
  { type: "perf", re: /\b(optimi[sz]e[sd]?|performance|speed(?: ?up)?|faster|perf)\b/i },
  { type: "refactor", re: /\b(refactor(?:s|ed|ing)?|restructure[sd]?|simplif(?:y|ies|ied)|reorganize[sd]?|extract(?:s|ed)?|rename[sd]?|clean(?:ed)? ?up|consolidat\w*)\b/i },
];

/** A summary that already starts with a conventional-commit subject. */
const CONVENTIONAL_PREFIX =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]*\))?!?:\s/i;

/** Conversational lead-ins the agent tends to open with; stripped before use. */
const SUMMARY_LEADIN =
  /^(?:i(?:'ve| have)?|we(?:'ve| have)?|this (?:commit|change|pr|update)|successfully|just)\s+/i;

/**
 * Replace em/en dashes (and any spaces hugging them) with a comma so generated
 * messages don't carry dash punctuation. A trailing dash becomes a bare comma,
 * cleaned up by the trim that follows.
 */
function sanitizeDashes(text: string): string {
  return text.replace(/\s*[—–]\s*/g, ", ");
}

/**
 * Infer a conventional-commit type from summary text by whichever type's
 * keyword appears earliest (see {@link COMMIT_TYPES}); falls back to `chore`.
 */
export function classifyCommitType(text: string): string {
  let best = "chore";
  let bestIndex = Infinity;
  for (const { type, re } of COMMIT_TYPES) {
    const m = re.exec(text);
    if (m && m.index < bestIndex) {
      bestIndex = m.index;
      best = type;
    }
  }
  return best;
}

/** Trim a description to fit `budget`, cutting at a word boundary when possible. */
function fitSubject(desc: string, budget: number): string {
  if (desc.length <= budget) return desc;
  const cut = desc.slice(0, budget);
  const lastSpace = cut.lastIndexOf(" ");
  // Only break on a space if it leaves a meaningful chunk; otherwise hard-cut.
  return (lastSpace > budget / 2 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

/**
 * Compose a commit message from a workspace's title and the agent's final
 * summary (see {@link Workspace.summary}). When a summary is present it drives
 * the message: its first line, normalized into a conventional-commit subject
 * (`type: description`, lower-cased, no trailing period, capped to a readable
 * length), with the rest of the summary as the body — so the commit says what
 * the agent actually did. With no summary it falls back to the workspace title,
 * still as a conventional `chore:`-style subject. A summary that already opens
 * with a conventional subject is kept as-is (just length-capped).
 */
export function buildCommitMessage(title: string, summary?: string): string {
  const clean = summary ? sanitizeDashes(summary).trim() : "";
  const source = clean || sanitizeDashes(title).trim() || "update";
  const lines = source.split("\n");
  const firstLine = lines[0].trim();
  const rest = clean ? lines.slice(1).join("\n").trim() : "";

  // Already a conventional subject (e.g. the agent wrote "feat: …")? Respect it.
  if (CONVENTIONAL_PREFIX.test(firstLine)) {
    const subject = fitSubject(firstLine, COMMIT_SUBJECT_MAX);
    const body = subject === firstLine ? rest : clean;
    return body ? `${subject}\n\n${body}` : subject;
  }

  const type = classifyCommitType(source);
  // Strip a conversational lead-in and trailing punctuation.
  let desc = firstLine.replace(SUMMARY_LEADIN, "").replace(/[.\s]+$/, "");
  // Drop a leading verb of the chosen type so the subject doesn't repeat it
  // ("fix: fix the race" → "fix: the race"); keep it only if that empties desc.
  const typeRe = COMMIT_TYPES.find((t) => t.type === type)?.re;
  if (typeRe) {
    const stripped = desc.replace(
      new RegExp(`^\\s*${typeRe.source}[:\\s]+`, "i"),
      "",
    );
    if (stripped.trim()) desc = stripped;
  }
  desc = desc.trim();
  // Lower-case the first letter so the description reads as a conventional summary.
  if (desc) desc = desc[0].toLowerCase() + desc.slice(1);
  else desc = "update";

  const budget = COMMIT_SUBJECT_MAX - (type.length + 2);
  const subject = `${type}: ${fitSubject(desc, budget)}`;
  // If the first line had to be shortened, keep the whole summary in the body so
  // no detail is lost; otherwise the body is just the remaining lines.
  const body = clean ? (desc.length > budget ? clean : rest) : "";
  return body ? `${subject}\n\n${body}` : subject;
}

/** First line (subject) of the commit message, for the merge-commit summary. */
export function commitSubject(title: string, summary?: string): string {
  return buildCommitMessage(title, summary).split("\n", 1)[0];
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
