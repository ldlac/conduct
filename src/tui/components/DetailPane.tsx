import React from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type { Workspace } from "../../core/types.js";

interface Props {
  ws: Workspace | undefined;
  view: "output" | "diff";
  diff: string;
  scroll: number;
  width: number;
  height: number;
  /** Whether the reply box is open (feeds the running agent's stdin). */
  composing: boolean;
  reply: string;
  onReplyChange: (v: string) => void;
  onReplySubmit: () => void;
  onReplyCancel: () => void;
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

/** Total number of display rows `lines` occupy once wrapped to `width`. */
export function wrappedRowCount(lines: string[], width: number): number {
  let n = 0;
  for (const l of lines) n += wrapLine(l, width).length;
  return n;
}

export function DetailPane({
  ws,
  view,
  diff,
  scroll,
  width,
  height,
  composing,
  reply,
  onReplyChange,
  onReplySubmit,
  onReplyCancel,
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
      <Text>
        <Text bold>{ws.title}</Text>
        <Text dimColor>
          {"  "}
          {ws.agentId} · {ws.branch} · {ws.status}
        </Text>
        {ws.awaitingInput && !composing && (
          <Text color="yellow"> · awaiting input (i to reply)</Text>
        )}
      </Text>
      <Text dimColor>
        {view === "diff" ? "— diff —" : "— output —"}
        {position}
      </Text>
      <Box flexDirection="column" height={bodyHeight} overflow="hidden">
        {lines.map((row, i) => (
          <Text key={i} color={row.color} wrap="truncate-end">
            {row.text || " "}
          </Text>
        ))}
      </Box>
      {composing && (
        <Box>
          <Text color="green">❯ </Text>
          <TextInput
            value={reply}
            onChange={onReplyChange}
            onSubmit={onReplySubmit}
            placeholder="reply to the agent (Enter send · Esc cancel)"
          />
        </Box>
      )}
      {ws.error && <Text color="red">error: {ws.error}</Text>}
    </Box>
  );
}
