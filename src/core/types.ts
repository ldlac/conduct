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
   * finished a turn by asking the user something and is now idle, waiting for a
   * reply. A turn that simply completed the work (no question) does not set
   * this — the session stays alive and can still be replied to, but the UI
   * won't nag for input. Transient — never true for a workspace whose process
   * isn't running.
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
   * For interactive agents: does this raw stdout line end a turn with the agent
   * waiting on the user — i.e. it asked a question and now needs a reply to
   * continue? A turn that just finished the job (no question) should return
   * false: the session stays alive, but the UI should not prompt for input.
   */
  awaitsReply?(line: string): boolean;
  /**
   * For interactive agents: does this raw stdout line mark the end of a turn —
   * the agent going idle, whether it asked a question or simply finished the
   * job? The session process stays alive between turns, so this is how the
   * manager knows the agent is no longer actively working and can flip the
   * workspace to `done` (ready to review/merge). A superset of
   * {@link awaitsReply}: every reply-awaiting line also ends a turn.
   */
  turnEnded?(line: string): boolean;
}
