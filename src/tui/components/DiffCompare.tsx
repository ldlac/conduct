import React, { useMemo } from "react";
import { Box, Text } from "ink";
import type { DiffFileInfo } from "./DetailPane.js";
import type { Workspace } from "../../core/types.js";

interface Props {
  left: { ws: Workspace; diff: string; files: DiffFileInfo[] };
  right: { ws: Workspace; diff: string; files: DiffFileInfo[] };
  leftFileIndex: number;
  rightFileIndex: number;
  leftScroll: number;
  rightScroll: number;
  focus: "left" | "right";
  width: number;
  height: number;
}

const PANEL_MIN = 30;

function diffColor(line: string): string | undefined {
  if (line.startsWith("+") && !line.startsWith("+++")) return "green";
  if (line.startsWith("-") && !line.startsWith("---")) return "red";
  if (line.startsWith("@@")) return "cyan";
  if (line.startsWith("diff ") || line.startsWith("index ")) return "yellow";
  return undefined;
}

function wrapLine(line: string, width: number): string[] {
  if (width <= 0 || line.length <= width) return [line];
  const rows: string[] = [];
  for (let i = 0; i < line.length; i += width) {
    rows.push(line.slice(i, i + width));
  }
  return rows;
}

export function DiffCompare({
  left,
  right,
  leftFileIndex,
  rightFileIndex,
  leftScroll,
  rightScroll,
  focus,
  width,
  height,
}: Props) {
  const halfWidth = Math.max(PANEL_MIN, Math.floor((width - 3) / 2));

  const leftContent = useMemo(
    () => renderPanel(left, leftFileIndex, leftScroll, halfWidth, height, focus === "left"),
    [left, leftFileIndex, leftScroll, halfWidth, height, focus],
  );
  const rightContent = useMemo(
    () => renderPanel(right, rightFileIndex, rightScroll, halfWidth, height, focus === "right"),
    [right, rightFileIndex, rightScroll, halfWidth, height, focus],
  );

  return (
    <Box
      flexDirection="row"
      width={width}
      height={height}
      overflow="hidden"
    >
      {leftContent}
      <Box width={1} />
      {rightContent}
    </Box>
  );
}

function renderPanel(
  data: { ws: Workspace; diff: string; files: DiffFileInfo[] },
  fileIndex: number,
  scroll: number,
  panelWidth: number,
  panelHeight: number,
  isFocused: boolean,
) {
  const { ws, diff, files } = data;
  const file = files[fileIndex];
  const content = file?.content ?? diff;

  const rawLines = content ? content.split("\n") : ["(no changes)"];
  const textWidth = Math.max(1, panelWidth - 4);
  const rows = rawLines.flatMap((l) => {
    const color = diffColor(l);
    return wrapLine(l, textWidth).map((text) => ({ text, color }));
  });

  // Header: title + agent + file path
  const headerLines: string[] = [];
  const fileLabel = file
    ? fileIndex < files.length
      ? `${fileIndex + 1}/${files.length} ${file.path}`
      : ""
    : "";
  headerLines.push(`${ws.title} (${ws.agentId})`);
  if (fileLabel) headerLines.push(fileLabel);

  // Reserve: 2 border + header lines
  const bodyHeight = Math.max(3, panelHeight - (2 + headerLines.length));
  const maxScroll = Math.max(0, rows.length - bodyHeight);
  const top = Math.min(Math.max(0, scroll), maxScroll);
  const visibleRows = rows.slice(top, top + bodyHeight);

  const borderColor = isFocused ? "cyan" : "gray";

  return (
    <Box
      flexDirection="column"
      width={panelWidth}
      height={panelHeight}
      overflow="hidden"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
    >
      {headerLines.map((h, i) => (
        <Text key={i} bold={i === 0} wrap="truncate-end">
          {h}
        </Text>
      ))}
      <Box flexDirection="column" height={bodyHeight} overflow="hidden">
        {visibleRows.length === 0 ? (
          <Text dimColor> </Text>
        ) : (
          visibleRows.map((row, i) => (
            <Text key={i} color={row.color} wrap="truncate-end">
              {row.text || " "}
            </Text>
          ))
        )}
      </Box>
    </Box>
  );
}
