import React from "react";
import { Box, Text } from "ink";
import type { TokenUsage } from "../../core/types.js";
import { usageText } from "./WorkspaceList.js";

interface Props {
  mode: "list" | "detail" | "new";
  view: "output" | "diff";
  message?: string;
  repo: string;
  baseBranch: string;
  /** Combined token usage across all workspaces, for the session tally. */
  usage?: TokenUsage;
  /** When true, the user is typing a list filter; show the live query instead
   * of the repo/message line. */
  filtering?: boolean;
  /** The current filter query (applied even when not actively typing). */
  filter?: string;
  /** When true, the user is editing the selected workspace's title; show the
   * live edit instead of the repo/message line. */
  renaming?: boolean;
  /** The in-progress title edit (while renaming). */
  renameText?: string;
  /** Number of workspaces marked for batch operations. */
  markedCount?: number;
}

const HINTS: Record<string, string> = {
  list: "n new · Space mark · ↑/↓ select · ↵ open · d diff · / filter · e rename · C clone · c shell · m merge · s stop · x archive · ? help · q quit",
  detail:
    "↵/o output · d diff · c shell · i reply · ↑/↓ scroll · e rename · C clone · m merge · s stop · R restart · ? help · esc back",
  new: "fill the form · esc cancel",
};

export function StatusBar({
  mode,
  view,
  message,
  repo,
  baseBranch,
  usage,
  filtering,
  filter,
  renaming,
  renameText,
  markedCount,
}: Props) {
  const tally = usageText(usage);
  return (
    <Box flexDirection="column">
      {renaming ? (
        <Text>
          <Text color="cyan">rename: </Text>
          {renameText}
          <Text color="cyan">▏</Text>
          <Text dimColor> (↵ save · esc cancel)</Text>
        </Text>
      ) : filtering ? (
        <Text>
          <Text color="cyan">filter: </Text>
          {filter}
          <Text color="cyan">▏</Text>
          <Text dimColor> (↵ apply · esc clear)</Text>
        </Text>
      ) : message ? (
        <Text color="yellow">{message}</Text>
      ) : markedCount ? (
        <Text color="yellow">
          {markedCount} marked · Space to toggle · Esc to clear · m/x/R on marked
        </Text>
      ) : (
        <Text dimColor>
          {repo} @ {baseBranch}
          {filter && <Text color="cyan"> · /{filter}</Text>}
          {tally && ` · session: ${tally}`}
        </Text>
      )}
      <Text inverse>
        {" "}
        {mode === "detail" ? `[${view}] ` : ""}
        {HINTS[mode]}{" "}
      </Text>
    </Box>
  );
}
