import React from "react";
import { Box, Text } from "ink";
import type { Workspace } from "../../core/types.js";

interface Props {
  ws: Workspace | undefined;
  view: "output" | "diff";
  diff: string;
  scroll: number;
  width: number;
  height: number;
}

function diffColor(line: string): string | undefined {
  if (line.startsWith("+") && !line.startsWith("+++")) return "green";
  if (line.startsWith("-") && !line.startsWith("---")) return "red";
  if (line.startsWith("@@")) return "cyan";
  if (line.startsWith("diff ") || line.startsWith("index ")) return "yellow";
  return undefined;
}

export function DetailPane({ ws, view, diff, scroll, width, height }: Props) {
  if (!ws) {
    return (
      <Box width={width} borderStyle="round" borderColor="gray" paddingX={1}>
        <Text dimColor>Select a workspace and press Enter.</Text>
      </Box>
    );
  }

  const bodyHeight = Math.max(3, height - 4);
  let lines: string[];
  if (view === "diff") {
    const all = diff ? diff.split("\n") : ["(no changes yet)"];
    lines = all.slice(scroll, scroll + bodyHeight);
  } else {
    // Tail the output so the latest activity is always visible.
    lines = ws.output.slice(-bodyHeight);
  }

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
      </Text>
      <Text dimColor>{view === "diff" ? "— diff —" : "— output —"}</Text>
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
      {ws.error && <Text color="red">error: {ws.error}</Text>}
    </Box>
  );
}
