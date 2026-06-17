export type WorkspaceStatus =
  | "creating"
  | "running"
  | "done"
  | "error"
  | "merged"
  | "archived";

export interface Workspace {
  id: string;
  title: string;
  prompt: string;
  agentId: string;
  branch: string;
  /** Absolute path to the worktree checkout. Empty until created. */
  path: string;
  status: WorkspaceStatus;
  /** Rolling buffer of agent output lines (most recent last). */
  output: string[];
  exitCode?: number;
  error?: string;
  createdAt: number;
}

export interface AgentBackend {
  id: string;
  displayName: string;
  /** Resolve whether the underlying CLI is installed and runnable. */
  isAvailable(): Promise<boolean>;
  /** Build the child-process invocation for a given prompt. */
  buildCommand(prompt: string): {
    cmd: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
  };
  /** Optionally turn one raw stdout line into a human-readable line. */
  parseLine?(line: string): string | null;
}
