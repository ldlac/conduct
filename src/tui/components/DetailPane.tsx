import React from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type { Workspace } from "../../core/types.js";
import {
  DiffStatBadge,
  formatCost,
  formatTokens,
  runtimeText,
  totalTokens,
} from "./WorkspaceList.js";

interface Props {
  ws: Workspace | undefined;
  view: "output" | "diff";
  diff: string;
  scroll: number;
  width: number;
  height: number;
  /** Whether the output view is auto-scrolling to follow the latest output. */
  followTail?: boolean;
  /** Current wall-clock time, so the header's live runtime advances on tick. */
  now: number;
  /** Whether the reply box is open (feeds the running agent's stdin). */
  composing: boolean;
  /** When > 0, the open reply box is composing a broadcast to this many marked
   * workspaces rather than a reply to the selected one; the box relabels itself
   * so it's clear the message goes to the whole fleet. */
  broadcastCount?: number;
  reply: string;
  onReplyChange: (v: string) => void;
  onReplySubmit: () => void;
  onReplyCancel: () => void;
  /** Current diff file path for file-by-file navigation. */
  diffFilePath?: string;
  /** Total number of files in the diff (for "file X/Y" display). */
  diffFileCount?: number;
  /** Zero-based index of the current file being displayed. */
  diffFileIndex?: number;
  /** Active search query; when set, matching lines are highlighted. */
  searchQuery?: string;
  /** Display-row indices of every search match, in order. */
  searchResults?: number[];
  /** Display-row index of the current (active) match, or -1. */
  searchCurrentRow?: number;
}

function diffColor(line: string): string | undefined {
  if (line.startsWith("+") && !line.startsWith("+++")) return "green";
  if (line.startsWith("-") && !line.startsWith("---")) return "red";
  if (line.startsWith("@@")) return "cyan";
  if (line.startsWith("diff ") || line.startsWith("index ")) return "yellow";
  return undefined;
}

/**
 * Number of body rows the pane can show, given its total height and whether
 * the reply box is open. Exported so the App can compute scroll bounds with
 * the exact same arithmetic the pane renders with.
 */
export function detailBodyHeight(height: number, composing: boolean): number {
  return Math.max(3, height - 4 - (composing ? 1 : 0));
}

/**
 * Width available for body text inside the pane, once the round border (1 col
 * each side) and horizontal padding (1 col each side) are subtracted.
 */
export function detailTextWidth(width: number): number {
  return Math.max(1, width - 4);
}

/**
 * Hard-wrap one logical line into display rows no wider than `width`. Unlike
 * `wrap="truncate-end"`, this keeps every character — long lines spill onto
 * extra rows instead of being cut off with an ellipsis.
 */
export function wrapLine(line: string, width: number): string[] {
  if (width <= 0 || line.length <= width) return [line];
  const rows: string[] = [];
  for (let i = 0; i < line.length; i += width) {
    rows.push(line.slice(i, i + width));
  }
  return rows;
}

export interface DiffFileInfo {
  path: string;
  content: string;
}

export function parseDiffFiles(diff: string): DiffFileInfo[] {
  if (!diff) return [];
  const parts = diff.split("\ndiff --git ");
  const files: DiffFileInfo[] = [];
  for (let i = 0; i < parts.length; i++) {
    let content = parts[i];
    if (i > 0) content = "diff --git " + content;
    const firstLine = content.split("\n")[0];
    const m = firstLine.match(/ b\/(.+)/);
    const path = m ? m[1] : firstLine;
    files.push({ path, content });
  }
  return files;
}

/** Total number of display rows `lines` occupy once wrapped to `width`. */
export function wrappedRowCount(lines: string[], width: number): number {
  let n = 0;
  for (const l of lines) n += wrapLine(l, width).length;
  return n;
}

/**
 * Split `text` into segments around case-insensitive matches of `query` and
 * wrap each segment in a `<Text>` element with the appropriate highlight
 * styling. The current (active) match uses a cyan background; other matches
 * use yellow. Non-matching segments are returned as plain strings that can be
 * slotted into a parent `<Text>` with the row's base color (e.g. green for
 * diff additions).
 */
function highlightText(
  text: string,
  query: string,
  isCurrentMatch: boolean,
): React.ReactNode {
  if (!query) return text;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const parts: React.ReactNode[] = [];
  let last = 0;
  let idx = lower.indexOf(q);
  const bg = isCurrentMatch ? "cyan" : "yellow";
  const fg = "black";
  while (idx !== -1) {
    if (idx > last) parts.push(text.slice(last, idx));
    parts.push(
      <Text key={idx} backgroundColor={bg} color={fg}>
        {text.slice(idx, idx + query.length)}
      </Text>,
    );
    last = idx + query.length;
    idx = lower.indexOf(q, last);
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length === 1 ? parts[0] : <>{parts}</>;
}

export function DetailPane({
  ws,
  view,
  diff,
  scroll,
  width,
  height,
  now,
  followTail,
  composing,
  broadcastCount,
  reply,
  onReplyChange,
  onReplySubmit,
  onReplyCancel,
  diffFilePath,
  diffFileCount,
  diffFileIndex,
  searchQuery,
  searchResults,
  searchCurrentRow,
}: Props) {
  // While the reply box is open it owns key input; catch Esc to cancel.
  useInput(
    (_input, key) => {
      if (key.escape) onReplyCancel();
    },
    { isActive: composing },
  );

  if (!ws) {
    return (
      <Box width={width} borderStyle="round" borderColor="gray" paddingX={1}>
        <Text dimColor>Select a workspace and press Enter.</Text>
      </Box>
    );
  }

  // Reserve a row for the reply box when it's open.
  const bodyHeight = detailBodyHeight(height, composing);
  const all =
    view === "diff"
      ? diff
        ? diff.split("\n")
        : ["(no changes yet)"]
      : ws.output.length
        ? ws.output
        : ["(no output yet)"];
  // Wrap each logical line into display rows so nothing is lost to truncation.
  // Scroll, slicing and the position indicator all work in display rows, and
  // the App computes its scroll bounds against the same wrapped count.
  const textWidth = detailTextWidth(width);
  const rows = all.flatMap((l) => {
    const color = view === "diff" ? diffColor(l) : undefined;
    return wrapLine(l, textWidth).map((text) => ({ text, color }));
  });

  // `scroll` is a top offset clamped by the App; for the output view the App
  // pins it to the bottom (tail) until the user scrolls up.
  const top = Math.min(Math.max(0, scroll), Math.max(0, rows.length - bodyHeight));
  const lines = rows.slice(top, top + bodyHeight);

  // Position indicator, shown only when the content is taller than the pane.
  const last = Math.min(top + bodyHeight, rows.length);
  const scrollable = rows.length > bodyHeight;
  const position = scrollable
    ? `  ${top + 1}-${last}/${rows.length}${last < rows.length ? " ↓" : ""}`
    : "";

  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
    >
      {ws.prompt && (
        <Text dimColor>
          {ws.prompt.length > 120 ? ws.prompt.slice(0, 120) + "…" : ws.prompt}
        </Text>
      )}
      <Text>
        <Text bold>{ws.title}</Text>
        <Text dimColor>
          {"  "}
          {ws.agentId} · {ws.branch} · {ws.status}
          {runtimeText(ws, now) && ` · ${runtimeText(ws, now)}`}
        </Text>
        {ws.stat && ws.stat.files > 0 && (
          <Text>
            <Text dimColor>
              {" · "}
              {ws.stat.files} file{ws.stat.files === 1 ? "" : "s"}{" "}
            </Text>
            <DiffStatBadge stat={ws.stat} />
          </Text>
        )}
        {ws.usage && totalTokens(ws.usage) > 0 && (
          <Text dimColor>
            {" · "}
            {formatTokens(totalTokens(ws.usage))} tok (
            {formatTokens(ws.usage.inputTokens)}↑{" "}
            {formatTokens(ws.usage.outputTokens)}↓{" "}
            {formatTokens(
              ws.usage.cacheReadTokens + ws.usage.cacheCreationTokens,
            )}
            ⚡) · {formatCost(ws.usage.costUsd)}
          </Text>
        )}
        {ws.pendingPermission ? (
          <Text color="yellow" bold>
            {" · "}⏸ allow {ws.pendingPermission.toolName}? (y/n)
          </Text>
        ) : ws.pendingQuestion ? (
          <Text color="yellow" bold>
            {" · "}❓ asked a question (i to answer)
          </Text>
        ) : (
          ws.awaitingInput &&
          !composing && (
            <Text color="yellow"> · awaiting input (i to reply)</Text>
          )
        )}
        {ws.conflicts && ws.conflicts.length > 0 && (
          <Text color="red" bold>
            {" · "}⚠ merge conflict ({ws.conflicts.length} file
            {ws.conflicts.length === 1 ? "" : "s"})
          </Text>
        )}
      </Text>
      <Text dimColor>
        {view === "diff" ? "— diff —" : followTail ? "— output —" : "— output (paused) —"}
        {diffFilePath && diffFileCount && diffFileCount > 1 ? (
          <Text>
            {" "}[{diffFileIndex != null ? diffFileIndex + 1 : 1}/{diffFileCount}]{" "}
            <Text color="cyan">{diffFilePath}</Text>
          </Text>
        ) : diffFilePath ? (
          <Text>
            {" "}<Text color="cyan">{diffFilePath}</Text>
          </Text>
        ) : null}
        {position}
        {searchQuery ? (
          <Text>
            {" "}/<Text color="cyan">{searchQuery}</Text>/
            {searchResults && searchResults.length > 0
              ? ` ${searchCurrentRow !== undefined && searchCurrentRow !== -1 ? searchResults.indexOf(searchCurrentRow) + 1 : 0}/${searchResults.length}`
              : " 0 matches"}
          </Text>
        ) : null}
      </Text>
      <Box flexDirection="column" height={bodyHeight} overflow="hidden">
        {lines.map((row, i) => {
          const displayRow = top + i;
          const isMatch = searchQuery && searchResults?.includes(displayRow);
          const isCurrent =
            searchCurrentRow !== undefined && displayRow === searchCurrentRow;
          return (
            <Text key={i} color={row.color} wrap="truncate-end">
              {isMatch && searchQuery
                ? highlightText(row.text, searchQuery, isCurrent)
                : row.text || " "}
            </Text>
          );
        })}
      </Box>
      {composing && (
        <Box>
          <Text color={broadcastCount ? "magenta" : "green"}>
            {broadcastCount ? "📣 " : "❯ "}
          </Text>
          <TextInput
            value={reply}
            onChange={onReplyChange}
            onSubmit={onReplySubmit}
            placeholder={
              broadcastCount
                ? `broadcast to ${broadcastCount} marked agent${broadcastCount === 1 ? "" : "s"} (Enter send · Esc cancel)`
                : "reply to the agent (Enter send · Esc cancel)"
            }
          />
        </Box>
      )}
      {ws.error && <Text color="red">error: {ws.error}</Text>}
      {ws.conflicts && ws.conflicts.length > 0 && (
        <Text color="red" wrap="truncate-end">
          merge conflict — resolve in the worktree (c) and retry: {ws.conflicts.join(", ")}
        </Text>
      )}
    </Box>
  );
}
