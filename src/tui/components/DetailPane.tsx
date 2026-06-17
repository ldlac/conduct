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
  // `scroll` is a top offset clamped by the App; for the output view the App
  // pins it to the bottom (tail) until the user scrolls up.
  const top = Math.min(Math.max(0, scroll), Math.max(0, all.length - bodyHeight));
  const lines = all.slice(top, top + bodyHeight);

  // Position indicator, shown only when the content is taller than the pane.
  const last = Math.min(top + bodyHeight, all.length);
  const scrollable = all.length > bodyHeight;
  const position = scrollable
    ? `  ${top + 1}-${last}/${all.length}${last < all.length ? " ↓" : ""}`
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
        {lines.map((l, i) => (
          <Text
            key={i}
            color={view === "diff" ? diffColor(l) : undefined}
            wrap="truncate-end"
          >
            {l || " "}
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
