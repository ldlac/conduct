import React from "react";
import { Box, Text } from "ink";

interface Props {
  mode: "list" | "detail" | "new";
  view: "output" | "diff";
  message?: string;
  repo: string;
  baseBranch: string;
}

const HINTS: Record<string, string> = {
  list: "n new · ↑/↓ select · ↵ open · d diff · c shell · m merge · s stop · S skill · R restart · x archive · q quit",
  detail:
    "↵/o output · d diff · c shell · i reply · ↑/↓ scroll · m merge · s stop · S skill · R restart · r refresh · esc back",
  new: "fill the form · esc cancel",
};

export function StatusBar({ mode, view, message, repo, baseBranch }: Props) {
  return (
    <Box flexDirection="column">
      {message ? (
        <Text color="yellow">{message}</Text>
      ) : (
        <Text dimColor>
          {repo} @ {baseBranch}
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
