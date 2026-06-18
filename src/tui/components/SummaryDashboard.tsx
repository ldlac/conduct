import React from "react";
import { Box, Text } from "ink";
import type { TokenUsage, Workspace } from "../../core/types.js";
import {
  DiffStatBadge,
  RuntimeBadge,
  UsageBadge,
  formatCost,
  formatDuration,
  formatTokens,
  runtimeText,
  totalTokens,
} from "./WorkspaceList.js";

interface Props {
  items: Workspace[];
  now: number;
  height: number;
  width: number;
}

function divide(a: number, b: number): number {
  return b === 0 ? 0 : a / b;
}

export function SummaryDashboard({ items, now, height, width }: Props) {
  const statusCounts = new Map<string, number>();
  for (const ws of items) {
    statusCounts.set(ws.status, (statusCounts.get(ws.status) ?? 0) + 1);
  }

  let totalTokensCount = 0;
  let totalCost = 0;
  for (const ws of items) {
    if (ws.usage) {
      totalTokensCount += totalTokens(ws.usage);
      totalCost += ws.usage.costUsd;
    }
  }

  const summaryParts: string[] = [`${items.length} workspace${items.length === 1 ? "" : "s"}`];
  for (const [status, count] of statusCounts) {
    summaryParts.push(`${count} ${status}`);
  }

  const bodyHeight = Math.max(3, height - 5);
  const headerWidth = width - 4;

  const columns = [
    { label: "#", min: 3, get: (_: Workspace, i: number) => String(i + 1), grow: 0 },
    { label: "Title", min: 10, get: (w: Workspace) => w.title, grow: 1 },
    { label: "Agent", min: 6, get: (w: Workspace) => w.agentId, grow: 0 },
    { label: "Status", min: 6, get: (w: Workspace) => w.status, grow: 0 },
    { label: "Diff", min: 8, get: (w: Workspace) => {
      if (!w.stat || w.stat.files === 0) return "";
      return `+${w.stat.insertions} -${w.stat.deletions}`;
    }, grow: 0 },
    { label: "Cost", min: 7, get: (w: Workspace) => w.usage ? formatCost(w.usage.costUsd) : "", grow: 0 },
    { label: "Time", min: 7, get: (w: Workspace) => runtimeText(w, now) || (w.runStartedAt ? "" : "-"), grow: 0 },
  ] as const;

  const colWidths = columns.map((col) => {
    let max = col.label.length;
    for (let i = 0; i < items.length; i++) {
      const val = col.get(items[i], i);
      max = Math.max(max, val.length, col.min);
    }
    return max;
  });

  const fixedWidth = colWidths.reduce((s, w, i) => s + w + (i > 0 ? 1 : 0), 0) + 1;
  const growCols = columns.map((c, i) => ({ index: i, grow: c.grow }));
  const totalGrow = growCols.reduce((s, c) => s + c.grow, 0);
  let remaining = Math.max(0, headerWidth - fixedWidth);
  for (const { index, grow } of growCols) {
    if (totalGrow > 0) {
      const extra = Math.floor(remaining * (grow / totalGrow));
      colWidths[index] += extra;
      remaining -= extra;
    }
  }

  function renderRow(ws: Workspace, i: number): React.ReactNode {
    const parts: React.ReactNode[] = [];
    for (let c = 0; c < columns.length; c++) {
      const val = columns[c].get(ws, i);
      const w = colWidths[c];
      const padded = val.slice(0, w).padEnd(w);
      if (c === 1) {
        parts.push(<Text key={c} bold>{padded}</Text>);
      } else if (c === 3) {
        const statusColor: Record<string, string> = {
          creating: "yellow",
          running: "cyan",
          done: "green",
          error: "red",
          merged: "magenta",
          archived: "gray",
          stopped: "yellow",
        };
        parts.push(
          <Text key={c} color={statusColor[ws.status] || "white"}>
            {padded}
          </Text>,
        );
      } else {
        parts.push(<Text key={c}>{padded}</Text>);
      }
      if (c < columns.length - 1) parts.push(" ");
    }
    return parts;
  }

  const visibleCount = Math.min(items.length, bodyHeight);
  const visible = items.slice(0, visibleCount);
  const overflow = items.length - visibleCount;

  // Separator line
  const sep = "─".repeat(headerWidth);

  return (
    <Box flexDirection="column" width={width} paddingX={1}>
      <Text bold>
        Summary Dashboard
        <Text dimColor> — {summaryParts.join(" · ")}</Text>
      </Text>
      <Text dimColor>
        {totalTokensCount > 0
          ? `Session: ${formatTokens(totalTokensCount)} tok · ${formatCost(totalCost)}`
          : ""}
      </Text>
      <Text dimColor>{sep}</Text>
      <Box flexDirection="column" height={bodyHeight} overflow="hidden">
        <Text dimColor bold>
          {columns.map((c, i) => {
            const w = colWidths[i];
            const label = c.label.padEnd(w);
            return <Text key={i}>{label}{i < columns.length - 1 ? " " : ""}</Text>;
          })}
        </Text>
        <Text dimColor>{sep}</Text>
        {visible.map((ws, i) => (
          <Text key={ws.id}>{renderRow(ws, i)}</Text>
        ))}
        {overflow > 0 && (
          <Text dimColor>… and {overflow} more (scroll not yet supported)</Text>
        )}
      </Box>
      <Text dimColor>
        ^o toggle · esc back to list · {summaryParts.join(" · ")}
      </Text>
    </Box>
  );
}
