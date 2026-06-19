import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type {
  DiffStat,
  SortMode,
  TokenUsage,
  Workspace,
  WorkspaceStatus,
} from "../../core/types.js";

/** Plain-text form of a diff stat (`+120 -8`), or "" when there's nothing to
 * show. Used both to size list rows and as the basis for the colored badge. */
export function statText(stat: DiffStat | undefined): string {
  if (!stat || stat.files === 0) return "";
  return `+${stat.insertions} -${stat.deletions}`;
}

/** Every token the session touched — input, output, and both cache flavours. */
export function totalTokens(usage: TokenUsage): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheReadTokens +
    usage.cacheCreationTokens
  );
}

/** Compact a token count: 1530 → "1.5k", 2_300_000 → "2.3M". */
export function formatTokens(n: number): string {
  if (n >= 999_500) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Compact elapsed time: 8s → "8s", 95s → "1m35s", 3725s → "1h2m". Seconds are
 * dropped past an hour, where they no longer carry useful signal. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

/** Live elapsed-time string for an actively-running workspace, or "" when it
 * isn't running. `now` is supplied by the caller so the value advances as the
 * caller re-renders on a timer rather than the badge reading the clock itself. */
export function runtimeText(ws: Workspace, now: number): string {
  return ws.runStartedAt ? formatDuration(now - ws.runStartedAt) : "";
}

/** Dim elapsed-time badge for a running workspace. Renders nothing when idle. */
export function RuntimeBadge({ ws, now }: { ws: Workspace; now: number }) {
  const text = runtimeText(ws, now);
  return text ? <Text dimColor>{text}</Text> : null;
}

/** Dollar cost with enough precision to stay meaningful for cheap sessions. */
export function formatCost(usd: number): string {
  if (usd <= 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/** Compact one-line usage summary (`1.5k $0.27`), or "" when there's nothing
 * to show. Used to size list rows and render the dim usage badge. */
export function usageText(usage: TokenUsage | undefined): string {
  if (!usage) return "";
  const tokens = totalTokens(usage);
  if (tokens === 0 && usage.costUsd === 0) return "";
  return `${formatTokens(tokens)} ${formatCost(usage.costUsd)}`;
}

/** Dim token/cost badge for a workspace row. Renders nothing without usage. */
export function UsageBadge({ usage }: { usage: TokenUsage | undefined }) {
  const text = usageText(usage);
  return text ? <Text dimColor>{text}</Text> : null;
}

/** GitHub-style colored diff stat: green insertions, red deletions. Renders
 * nothing when there are no changes yet. */
export function DiffStatBadge({ stat }: { stat: DiffStat | undefined }) {
  if (!stat || stat.files === 0) return null;
  return (
    <Text>
      <Text color="green">+{stat.insertions}</Text>{" "}
      <Text color="red">-{stat.deletions}</Text>
    </Text>
  );
}

const COLORS: Record<Workspace["status"], string> = {
  creating: "yellow",
  running: "cyan",
  done: "green",
  error: "red",
  merged: "magenta",
  archived: "gray",
  stopped: "yellow",
};

// The list is grouped by lifecycle stage so related workspaces sit together:
// the ones still working, the ones ready for you to review/merge, the merged
// ones, failures, and archived. Order here is also the top-to-bottom order.
const GROUPS: { label: string; statuses: WorkspaceStatus[] }[] = [
  { label: "In progress", statuses: ["creating", "running"] },
  { label: "Ready to review", statuses: ["done", "stopped"] },
  { label: "Merged", statuses: ["merged"] },
  { label: "Failed", statuses: ["error"] },
  { label: "Archived", statuses: ["archived"] },
];

function groupIndex(status: WorkspaceStatus): number {
  const i = GROUPS.findIndex((g) => g.statuses.includes(status));
  return i === -1 ? GROUPS.length : i;
}

export function groupLabel(status: WorkspaceStatus): string {
  return GROUPS[groupIndex(status)]?.label ?? "Other";
}

/** Human-readable label for each sort mode, shown in the list header. */
export const SORT_LABELS: Record<SortMode, string> = {
  group: "group",
  alpha: "A–Z",
  newest: "newest",
  oldest: "oldest",
};

/**
 * Order workspaces by lifecycle group (see {@link GROUPS}), then by creation
 * time within each group. Stable and pure, so callers can rely on the same
 * ordering for both rendering and selection bookkeeping.
 */
export function sortWorkspaces(items: Workspace[], sortMode?: SortMode): Workspace[] {
  const sorted = [...items];
  switch (sortMode) {
    case "alpha":
      return sorted.sort((a, b) => a.title.localeCompare(b.title));
    case "newest":
      return sorted.sort((a, b) => b.createdAt - a.createdAt);
    case "oldest":
      return sorted.sort((a, b) => a.createdAt - b.createdAt);
    case "group":
    default:
      return sorted.sort((a, b) => {
        const ga = groupIndex(a.status);
        const gb = groupIndex(b.status);
        if (ga !== gb) return ga - gb;
        return a.createdAt - b.createdAt;
      });
  }
}

function StatusIcon({ status }: { status: Workspace["status"] }) {
  if (status === "creating" || status === "running") {
    return (
      <Text color={COLORS[status]}>
        <Spinner type="dots" />
      </Text>
    );
  }
  const glyph =
    { done: "✓", error: "✗", merged: "⇄", archived: "·", stopped: "◼" }[
      status
    ] ?? "?";
  return <Text color={COLORS[status]}>{glyph}</Text>;
}

interface Props {
  /** Already ordered by {@link sortWorkspaces} (the caller owns selection). */
  items: Workspace[];
  selectedIndex: number;
  width: number;
  /** Total height of the list box; clipped to this so it never overflows its
   * row and corrupts the frame below it. */
  height: number;
  /** Current wall-clock time, threaded in so live runtime badges advance with
   * the caller's render timer. */
  now: number;
  /** Active title filter, shown in the header so a narrowed list is obvious. */
  filter?: string;
  /** Sort mode label to show in the header. */
  sortLabel?: string;
  /** Set of workspace ids marked for batch operations. */
  marks?: Set<string>;
}

export function WorkspaceList({
  items,
  selectedIndex,
  width,
  height,
  now,
  filter,
  sortLabel,
  marks,
}: Props) {
  // Precompute group counts for display in group headers.
  const groupCounts = new Map<string, number>();
  for (const ws of items) {
    const g = groupLabel(ws.status);
    groupCounts.set(g, (groupCounts.get(g) ?? 0) + 1);
  }
  let prevGroup: string | undefined;
  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      overflow="hidden"
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
    >
      <Text bold wrap="truncate-end">
        Workspaces ({items.length})
        {sortLabel && sortLabel !== "group" ? (
          <Text color="magenta"> [{sortLabel}]</Text>
        ) : null}
        {marks && marks.size > 0 ? (
          <Text color="yellow"> · {marks.size} marked</Text>
        ) : null}
        {filter ? <Text color="cyan"> /{filter}</Text> : null}
      </Text>
      {items.length === 0 && (
        <Text dimColor>
          {filter ? "no matches — esc to clear" : "none yet — press n to create one"}
        </Text>
      )}
      {items.map((ws, i) => {
        const selected = i === selectedIndex;
        const group = groupLabel(ws.status);
        const header = group !== prevGroup ? group : undefined;
        prevGroup = group;
        // Reserve room for the diff-stat and usage badges so the title doesn't
        // crowd them out; all three share the row's text budget (cursor + icon
        // take ~4 cols).
        const badge = statText(ws.stat);
        const usage = usageText(ws.usage);
        const runtime = runtimeText(ws, now);
        const titleBudget = Math.max(
          4,
          width -
            8 -
            (badge ? badge.length + 1 : 0) -
            (usage ? usage.length + 1 : 0) -
            (runtime ? runtime.length + 1 : 0),
        );
        return (
          <React.Fragment key={ws.id}>
            {header && (
              <Text dimColor bold wrap="truncate-end">
                {header}{groupCounts.get(header) != null ? ` (${groupCounts.get(header)})` : ""}
              </Text>
            )}
            <Box>
              <Text color={selected ? "cyan" : undefined}>
                {selected ? "❯ " : "  "}
              </Text>
              <StatusIcon status={ws.status} />
              <Text color={selected ? "cyan" : undefined} bold={selected}>
                {" "}
                {ws.title.slice(0, titleBudget)}
              </Text>
              {badge && (
                <Text>
                  {" "}
                  <DiffStatBadge stat={ws.stat} />
                </Text>
              )}
              {usage && (
                <Text>
                  {" "}
                  <UsageBadge usage={ws.usage} />
                </Text>
              )}
              {runtime && (
                <Text>
                  {" "}
                  <RuntimeBadge ws={ws} now={now} />
                </Text>
              )}
              {ws.setupRunning && (
                <Text color="yellow">
                  {" "}
                  ⚙
                </Text>
              )}
              {ws.pendingPermission && (
                <Text color="yellow" bold>
                  {" "}
                  ⏸
                </Text>
              )}
              {ws.pendingQuestion && (
                <Text color="yellow" bold>
                  {" "}
                  ❓
                </Text>
              )}
              {ws.conflicts && ws.conflicts.length > 0 && (
                <Text color="red" bold>
                  {" "}
                  ⚠
                </Text>
              )}
              {ws.prUrl ? (
                <Text color="magenta" bold>
                  {" "}
                  ⇡PR
                </Text>
              ) : ws.pushedRemote ? (
                <Text dimColor>
                  {" "}
                  ⇡
                </Text>
              ) : null}
              {marks?.has(ws.id) && (
                <Text color="yellow" bold>
                  {" "}
                  ●
                </Text>
              )}
            </Box>
          </React.Fragment>
        );
      })}
    </Box>
  );
}
