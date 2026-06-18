import React from "react";
import { Box, Text } from "ink";
import type { TokenUsage } from "../../core/types.js";
import { usageText } from "./WorkspaceList.js";
import { MODE_HINTS } from "../../core/keybindings.js";

interface Props {
  mode: "list" | "detail" | "new" | "auto-improve";
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
  /** When true, the user is typing a detail-pane search query. */
  searching?: boolean;
  /** The live search query text. */
  searchQuery?: string;
}

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
  searching,
  searchQuery,
}: Props) {
  const tally = usageText(usage);
  // Every branch below is a single logical line, but some carry variable-length
  // content (flash messages, the repo path, user-typed queries). Without a wrap
  // cap a long string would wrap onto extra rows, growing the whole frame to the
  // terminal's height — which flips Ink into its full-screen-clear repaint and
  // brings the flicker back. `wrap="truncate"` keeps this box a fixed 2 rows.
  return (
    <Box flexDirection="column">
      {searching ? (
        <Text wrap="truncate">
          <Text color="cyan">search: </Text>
          {searchQuery}
          <Text color="cyan">▏</Text>
          <Text dimColor> (↵ find · esc cancel)</Text>
        </Text>
      ) : renaming ? (
        <Text wrap="truncate">
          <Text color="cyan">rename: </Text>
          {renameText}
          <Text color="cyan">▏</Text>
          <Text dimColor> (↵ save · esc cancel)</Text>
        </Text>
      ) : filtering ? (
        <Text wrap="truncate">
          <Text color="cyan">filter: </Text>
          {filter}
          <Text color="cyan">▏</Text>
          <Text dimColor> (↵ apply · esc clear)</Text>
        </Text>
      ) : message ? (
        <Text color="yellow" wrap="truncate">{message}</Text>
      ) : markedCount ? (
        <Text color="yellow" wrap="truncate">
          {markedCount} marked · Space toggle · Esc clear · m/x/R · i broadcast
        </Text>
      ) : (
        <Text dimColor wrap="truncate">
          {repo} @ {baseBranch}
          {filter && <Text color="cyan"> · /{filter}</Text>}
          {tally && ` · session: ${tally}`}
        </Text>
      )}
      <Text inverse wrap="truncate">
        {" "}
        {mode === "detail" ? `[${view}] ` : ""}
        {MODE_HINTS[mode]}{" "}
      </Text>
    </Box>
  );
}
