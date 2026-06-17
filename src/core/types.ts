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

/**
 * How to order workspaces in the list. `group` is the default: lifecycle stage
 * (running, done, merged, …) then creation time. The others are flat sorts
 * that ignore lifecycle grouping entirely.
 */
export type SortMode = "group" | "alpha" | "newest" | "oldest";

/** Size of a worktree's changes against the base branch. */
export interface DiffStat {
  /** Number of files touched (added, modified, or deleted). */
  files: number;
  /** Total lines added across those files. */
  insertions: number;
  /** Total lines removed across those files. */
  deletions: number;
}

/**
 * Token usage and cost for a workspace's agent session, summed across every
 * turn. Cache-read and cache-creation input tokens are tracked separately from
 * plain input because they bill at very different rates, so keeping them apart
 * lets the UI show an honest breakdown. Only agents that report usage in their
 * output populate this (Claude Code emits it on every `result` event); others
 * leave {@link Workspace.usage} undefined and the UI shows no usage badge.
 */
export interface TokenUsage {
  /** Non-cached input (prompt) tokens, billed at the full input rate. */
  inputTokens: number;
  /** Generated output (completion) tokens. */
  outputTokens: number;
  /** Input tokens served from the prompt cache, billed at the cheaper read rate. */
  cacheReadTokens: number;
  /** Input tokens written into the prompt cache, billed at the write rate. */
  cacheCreationTokens: number;
  /** Cost in USD, as reported by the agent, summed across turns. */
  costUsd: number;
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
  /**
   * Cumulative token usage and cost for this workspace's agent session, summed
   * across every turn the agent reported usage for (see
   * {@link AgentBackend.parseUsage}). Undefined for agents that don't surface
   * usage, in which case the UI shows no usage badge. Persisted, so the totals
   * survive a restart even though the live process does not.
   */
  usage?: TokenUsage;
  /**
   * Paths that conflicted the last time a merge of this workspace was attempted
   * (see {@link manager.WorkspaceManager.merge}). The merge is rolled back on
   * conflict, so the base branch is untouched and the workspace stays
   * reviewable; this just records what blocked it so the UI can flag the
   * conflicting files and prompt the user to resolve them in the worktree and
   * retry. Cleared when the agent starts a new turn (the worktree changes, so a
   * stale list would mislead) and on a clean merge.
   */
  conflicts?: string[];
  /**
   * Wall-clock timestamp the agent's current turn started running, used to show
   * a live elapsed-time badge while it works. Set when a turn begins (initial
   * launch, a reply, or a restart) and cleared the moment the turn ends, the
   * process exits, or the workspace is restored from a previous session (the
   * process didn't survive, so it isn't running). Undefined whenever the agent
   * isn't actively working.
   */
  runStartedAt?: number;
  exitCode?: number;
  error?: string;
  createdAt: number;
}

/**
 * Why a workspace newly needs the user's attention, carried on the manager's
 * `attention` event so the UI can both alert (ring the terminal bell) and say
 * which workspace and why. Emitted only on the transition into an
 * attention-worthy state, never repeatedly while it sits there.
 */
export type AttentionReason =
  /** A turn ended with the agent asking a question; it's waiting on a reply. */
  | "awaiting-input"
  /** The agent paused on a tool-permission request that must be answered. */
  | "permission"
  /** A turn finished the work (no question); the workspace is ready to review. */
  | "done"
  /** The agent process exited non-zero. */
  | "error";

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
   * For agents that report token usage in their output: extract the usage for
   * the turn this raw stdout line represents (Claude Code carries it on each
   * `result` event). Returns the per-turn delta — the manager sums these into
   * {@link Workspace.usage} across the session — or null for lines that carry
   * no usage. We treat each reported figure as one turn's contribution and add
   * them up, so this is the place to adjust if a CLI change ever makes the
   * numbers cumulative rather than per-turn.
   */
  parseUsage?(line: string): TokenUsage | null;
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
