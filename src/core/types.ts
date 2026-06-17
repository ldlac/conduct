export type WorkspaceStatus =
  | "creating"
  | "running"
  | "done"
  | "error"
  | "merged"
  | "archived"
  // Agent was still running when a previous session ended; the process is
  // gone, but the worktree and its work survive and remain reviewable.
  | "stopped";

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
  /**
   * For interactive agents (see {@link AgentBackend.encodeInput}): the agent
   * has finished a turn and is idle, waiting for the user to reply. Transient —
   * never true for a workspace whose process isn't running.
   */
  awaitingInput?: boolean;
  exitCode?: number;
  error?: string;
  createdAt: number;
}

export interface AgentBackend {
  id: string;
  displayName: string;
  /** Resolve whether the underlying CLI is installed and runnable. */
  isAvailable(): Promise<boolean>;
  /**
   * Build the child-process invocation. For interactive agents (those that
   * define {@link encodeInput}) the prompt is delivered over stdin instead, so
   * `prompt` need not be baked into the args.
   */
  buildCommand(prompt: string): {
    cmd: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
  };
  /** Optionally turn one raw stdout line into a human-readable line. */
  parseLine?(line: string): string | null;
  /**
   * If defined, the agent runs as a persistent interactive session: its stdin
   * is kept open and this turns a user's reply (and the initial prompt) into
   * the bytes to write to stdin. Returning the message lets the user answer
   * questions the agent asks and keep the conversation going.
   */
  encodeInput?(text: string): string;
  /**
   * For interactive agents: does this raw stdout line mark the end of a turn,
   * i.e. the agent is now idle and awaiting the user's next message?
   */
  turnEnded?(line: string): boolean;
}
