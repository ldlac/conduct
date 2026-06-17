import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { DiffStat, Workspace, WorkspaceStatus } from "../../core/types.js";

/** Plain-text form of a diff stat (`+120 -8`), or "" when there's nothing to
 * show. Used both to size list rows and as the basis for the colored badge. */
export function statText(stat: DiffStat | undefined): string {
  if (!stat || stat.files === 0) return "";
  return `+${stat.insertions} -${stat.deletions}`;
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

/**
 * Order workspaces by lifecycle group (see {@link GROUPS}), then by creation
 * time within each group. Stable and pure, so callers can rely on the same
 * ordering for both rendering and selection bookkeeping.
 */
export function sortWorkspaces(items: Workspace[]): Workspace[] {
  return [...items].sort((a, b) => {
    const ga = groupIndex(a.status);
    const gb = groupIndex(b.status);
    if (ga !== gb) return ga - gb;
    return a.createdAt - b.createdAt;
  });
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
}

export function WorkspaceList({ items, selectedIndex, width }: Props) {
  let prevGroup: string | undefined;
  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
    >
      <Text bold>Workspaces ({items.length})</Text>
      {items.length === 0 && (
        <Text dimColor>none yet — press n to create one</Text>
      )}
      {items.map((ws, i) => {
        const selected = i === selectedIndex;
        const group = groupLabel(ws.status);
        const header = group !== prevGroup ? group : undefined;
        prevGroup = group;
        // Reserve room for the diff-stat badge so the title doesn't crowd it
        // out; both share the row's text budget (cursor + icon take ~4 cols).
        const badge = statText(ws.stat);
        const titleBudget = Math.max(
          4,
          width - 8 - (badge ? badge.length + 1 : 0),
        );
        return (
          <React.Fragment key={ws.id}>
            {header && (
              <Text dimColor bold>
                {header}
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
            </Box>
          </React.Fragment>
        );
      })}
    </Box>
  );
}
