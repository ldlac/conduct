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

/**
 * A tool-permission request surfaced by an interactive agent. The agent wants
 * to use a tool that isn't auto-approved (e.g. run a shell command or fetch a
 * URL) and has paused, waiting for the user to allow or deny it. Produced by
 * {@link AgentBackend.parseControl} and answered via
 * {@link AgentBackend.encodePermission}.
 */
export interface PermissionRequest {
  /**
   * Opaque id that correlates the user's decision back to the agent's request
   * (the control protocol's `request_id`). Echoed in the response so the agent
   * knows which paused tool call it answers.
   */
  id: string;
  /** The tool the agent wants to use, e.g. "Bash" or "WebFetch". */
  toolName: string;
  /** One-line, human-readable summary of the request (e.g. the shell command). */
  summary: string;
  /**
   * The tool's raw input. Echoed back verbatim when the request is allowed, so
   * the agent runs exactly what it asked to (the protocol lets a host rewrite
   * this, but conduct approves as-is).
   */
  input?: unknown;
}

/**
 * Result of classifying one raw stdout line through
 * {@link AgentBackend.parseControl}. A `permission` event parks the workspace
 * on a request the user must answer; an `ack` event is a protocol message the
 * host should reply to automatically — its `reply` is written straight to the
 * agent's stdin so the session isn't left blocked on a response we never send.
 */
export type ControlEvent =
  | { kind: "permission"; request: PermissionRequest }
  | { kind: "ack"; reply: string };

/** Size of a worktree's changes against the base branch. */
export interface DiffStat {
  /** Number of files touched (added, modified, or deleted). */
  files: number;
  /** Total lines added across those files. */
  insertions: number;
  /** Total lines removed across those files. */
  deletions: number;
}

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
   * Last-known size of the worktree's diff against the base branch. Refreshed
   * when a turn ends and when the diff is viewed (not while the agent is
   * actively working), so it reflects the most recent settled state. Undefined
   * until first computed.
   */
  stat?: DiffStat;
  /**
   * For interactive agents (see {@link AgentBackend.encodeInput}): the agent
   * finished a turn by asking the user something and is now idle, waiting for a
   * reply. A turn that simply completed the work (no question) does not set
   * this — the session stays alive and can still be replied to, but the UI
   * won't nag for input. Transient — never true for a workspace whose process
   * isn't running.
   */
  awaitingInput?: boolean;
  /**
   * For interactive agents that can ask before using a tool: the agent has
   * paused on a permission request and is blocked until the user allows or
   * denies it (see {@link manager.WorkspaceManager.respondPermission}).
   * Transient — cleared when answered, when the agent exits, and on restore
   * (a request from a dead process can never be answered).
   */
  pendingPermission?: PermissionRequest;
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
   * For interactive agents that multiplex an out-of-band control protocol over
   * the same stdout/stdin streams as their normal messages (Claude Code does
   * this): classify one raw stdout line. Returns null for ordinary output that
   * should flow through {@link parseLine} as usual; otherwise returns a
   * {@link ControlEvent} the manager acts on instead of rendering the line —
   * either parking the workspace on a {@link PermissionRequest} or
   * acknowledging a protocol message. Control lines handled here are not also
   * passed to {@link turnEnded}/{@link parseLine}.
   */
  parseControl?(line: string): ControlEvent | null;
  /**
   * Encode the user's allow/deny decision for a pending
   * {@link PermissionRequest} into the bytes to write to the agent's stdin so
   * it can run (or skip) the tool and continue.
   */
  encodePermission?(req: PermissionRequest, allow: boolean): string;
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
