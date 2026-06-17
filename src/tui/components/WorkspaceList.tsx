import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { Workspace } from "../../core/types.js";

const COLORS: Record<Workspace["status"], string> = {
  creating: "yellow",
  running: "cyan",
  done: "green",
  error: "red",
  merged: "magenta",
  archived: "gray",
  stopped: "yellow",
};

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
  items: Workspace[];
  selectedIndex: number;
  width: number;
}

export function WorkspaceList({ items, selectedIndex, width }: Props) {
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
        return (
          <Box key={ws.id}>
            <Text color={selected ? "cyan" : undefined}>
              {selected ? "❯ " : "  "}
            </Text>
            <StatusIcon status={ws.status} />
            <Text color={selected ? "cyan" : undefined} bold={selected}>
              {" "}
              {ws.title.slice(0, width - 8)}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
