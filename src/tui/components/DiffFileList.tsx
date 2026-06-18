import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { DiffFileInfo } from "./DetailPane.js";

interface Props {
  /** The changed files, in the same order the diff view steps through them. */
  files: DiffFileInfo[];
  /** Index of the file currently shown in the diff, so the list opens on it. */
  currentIndex: number;
  /** Workspace title, shown in the box header for context. */
  title: string;
  width: number;
  height: number;
  /** Called with the chosen file index to jump the diff view to it. */
  onSelect: (index: number) => void;
  /** Called when the user backs out without jumping (Esc / f / q). */
  onCancel: () => void;
}

/**
 * Window a long file list around the cursor so the selected row is always
 * visible. Returns the slice's start index given how many rows fit. Keeps a
 * little context above the cursor rather than snapping it to the top edge.
 */
export function windowStart(
  cursor: number,
  count: number,
  rows: number,
): number {
  if (count <= rows) return 0;
  // Center-ish: keep the cursor off the very top/bottom where possible.
  const half = Math.floor(rows / 2);
  return Math.max(0, Math.min(cursor - half, count - rows));
}

/**
 * An at-a-glance overview of every file a workspace changed, opened with `f`
 * from the diff view. Each row shows the path and its own `+x -y` line delta;
 * arrows/`j`/`k` move, `↵` jumps the diff view straight to that file, and Esc
 * (or `f`) closes without moving. This turns the blind `[`/`]` file stepping
 * into real navigation — see the scope of a fan-out attempt and jump to the
 * file you actually care about. Owns the keyboard while open, like the question
 * picker, so letters scroll the list instead of firing list commands.
 */
export function DiffFileList({
  files,
  currentIndex,
  title,
  width,
  height,
  onSelect,
  onCancel,
}: Props) {
  const [cursor, setCursor] = useState(() =>
    Math.max(0, Math.min(files.length - 1, currentIndex)),
  );

  useInput((input, key) => {
    if (key.escape || input === "f" || input === "q") {
      onCancel();
      return;
    }
    if (key.upArrow || input === "k") {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow || input === "j") {
      setCursor((c) => Math.min(files.length - 1, c + 1));
      return;
    }
    if (input === "g") {
      setCursor(0);
      return;
    }
    if (input === "G") {
      setCursor(files.length - 1);
      return;
    }
    if (key.return || input === " ") {
      onSelect(cursor);
      return;
    }
  });

  const totals = files.reduce(
    (acc, f) => {
      acc.insertions += f.insertions;
      acc.deletions += f.deletions;
      return acc;
    },
    { insertions: 0, deletions: 0 },
  );

  // Reserve the round border (2 rows), the header line, and the hint line.
  const bodyRows = Math.max(1, height - 4);
  const start = windowStart(cursor, files.length, bodyRows);
  const visible = files.slice(start, start + bodyRows);
  // Right-align the stat column so the deltas line up regardless of path length;
  // size it to the widest delta on screen, capped so a huge change can't crowd
  // the path out entirely.
  const statWidth = Math.min(
    18,
    visible.reduce(
      (w, f) => Math.max(w, `+${f.insertions} -${f.deletions}`.length),
      0,
    ),
  );
  // Path budget: width minus border+padding (4), cursor (2), and the stat column
  // plus the gap before it.
  const pathBudget = Math.max(4, width - 4 - 2 - statWidth - 1);

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
    >
      <Text wrap="truncate-end">
        <Text bold>{title}</Text>
        <Text dimColor>
          {"  "}
          {files.length} file{files.length === 1 ? "" : "s"}
          {" · "}
        </Text>
        <Text color="green">+{totals.insertions}</Text>
        <Text> </Text>
        <Text color="red">-{totals.deletions}</Text>
        {start > 0 ? <Text dimColor> ↑</Text> : null}
        {start + bodyRows < files.length ? <Text dimColor> ↓</Text> : null}
      </Text>
      <Box flexDirection="column">
        {visible.map((f, i) => {
          const idx = start + i;
          const active = idx === cursor;
          const stat = `+${f.insertions} -${f.deletions}`;
          const pad = " ".repeat(Math.max(0, statWidth - stat.length));
          // A trailing "/" reads as a path; keep the basename visible by
          // truncating from the left when a path overflows the budget.
          const shown =
            f.path.length > pathBudget
              ? "…" + f.path.slice(f.path.length - pathBudget + 1)
              : f.path;
          return (
            <Box key={idx}>
              <Text color={active ? "cyan" : undefined} bold={active}>
                {active ? "❯ " : "  "}
                {shown}
              </Text>
              <Text> </Text>
              <Text>{pad}</Text>
              <Text color="green">+{f.insertions}</Text>
              <Text> </Text>
              <Text color="red">-{f.deletions}</Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor wrap="truncate-end">
          ↑/↓ move · ↵ jump to file · Esc close
        </Text>
      </Box>
    </Box>
  );
}
