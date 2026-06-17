import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import { Git } from "./git.js";
import { getAgent } from "./agents.js";
import { loadState, saveState, saveStateSync } from "./store.js";
import type { Workspace } from "./types.js";

const MAX_OUTPUT_LINES = 2000;
/** Debounce window for background state saves during normal operation. */
const SAVE_DEBOUNCE_MS = 500;

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
  readonly workspacesRoot: string;

  private constructor(
    readonly git: Git,
    readonly baseBranch: string,
  ) {
    super();
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
    const mgr = new WorkspaceManager(git, baseBranch);
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
      void saveState(this.workspacesRoot, this.baseBranch, this.snapshot()).catch(
        () => {
          /* best-effort: a failed background save is retried on the next change */
        },
      );
    }, SAVE_DEBOUNCE_MS);
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

  private startAgent(ws: Workspace): void {
    const agent = getAgent(ws.agentId);
    const { cmd, args, env } = agent.buildCommand(ws.prompt);
    ws.status = "running";
    this.append(
      ws,
      `$ ${cmd} ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`,
    );

    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        cwd: ws.path,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      ws.status = "error";
      ws.error = String(err);
      this.touch();
      return;
    }

    this.procs.set(ws.id, child);

    const onLine = (raw: string) => {
      const pretty = agent.parseLine ? agent.parseLine(raw) : raw;
      if (pretty != null) this.append(ws, pretty);
    };
    if (child.stdout)
      readline.createInterface({ input: child.stdout }).on("line", onLine);
    if (child.stderr) {
      readline.createInterface({ input: child.stderr }).on("line", (l) => {
        if (l.trim()) this.append(ws, `⚠ ${l}`);
      });
    }

    child.on("error", (err) => {
      ws.status = "error";
      ws.error = String(err);
      this.procs.delete(ws.id);
      this.touch();
    });
    child.on("close", (code) => {
      ws.exitCode = code ?? 0;
      if (ws.status === "running") ws.status = code === 0 ? "done" : "error";
      this.procs.delete(ws.id);
      this.append(ws, `\n[agent exited with code ${code}]`);
    });
  }

  isRunning(id: string): boolean {
    return this.procs.has(id);
  }

  stop(id: string): void {
    const child = this.procs.get(id);
    if (child) child.kill("SIGTERM");
  }

  async getDiff(id: string): Promise<string> {
    const ws = this.workspaces.get(id);
    if (!ws || !ws.path) return "";
    return this.git.diff(ws.path, this.baseBranch);
  }

  /** Commit any pending work in the worktree, then merge the branch into base. */
  async merge(id: string): Promise<void> {
    const ws = this.workspaces.get(id);
    if (!ws) throw new Error("No such workspace");
    if (this.isRunning(id))
      throw new Error("Agent is still running — stop it first");

    await this.git.commitAll(ws.path, `conduct: ${ws.title}`);
    await this.git.merge(ws.branch, `Merge conduct workspace: ${ws.title}`);
    ws.status = "merged";
    this.touch();
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
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      saveStateSync(this.workspacesRoot, this.baseBranch, this.snapshot());
    } catch {
      /* nothing useful to do as the process is exiting */
    }
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
