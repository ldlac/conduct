import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { AgentQuestion } from "../../core/types.js";

interface Props {
  /** The structured question(s) the agent is waiting on. */
  question: AgentQuestion;
  /** Workspace title, shown in the box header for context. */
  title: string;
  width: number;
  height: number;
  /** Called with the chosen labels per question once every question is answered. */
  onSubmit: (selections: string[][]) => void;
  /** Called when the user backs out without answering (Esc). */
  onCancel: () => void;
  /** Called when the user would rather type a free-text reply (t). */
  onFreeText: () => void;
}

/** Add or remove `label` from `set`, preserving order. */
function toggle(set: string[], label: string): string[] {
  return set.includes(label)
    ? set.filter((l) => l !== label)
    : [...set, label];
}

/**
 * Interactive picker for a Claude `AskUserQuestion`. Walks the user through each
 * question in turn — arrows/digits to move, Enter to choose (single-select) or
 * Space to toggle then Enter to confirm (multi-select) — and on the last one
 * hands the accumulated choices back to {@link Props.onSubmit}, which sends them
 * to the agent as the next turn. Esc cancels; `t` switches to a free-text reply.
 */
export function QuestionPrompt({
  question,
  title,
  width,
  height,
  onSubmit,
  onCancel,
  onFreeText,
}: Props) {
  const items = question.questions;
  const [qIndex, setQIndex] = useState(0);
  const [highlight, setHighlight] = useState(0);
  // One chosen-label list per question, accumulated as the user advances.
  const [selections, setSelections] = useState<string[][]>(() =>
    items.map(() => []),
  );

  const item = items[qIndex];
  const multi = item.multiSelect;

  // Move to the next question, or submit when the last one is answered. Takes
  // the next selections explicitly so a just-made single-select choice is
  // included without waiting for the async state update.
  const advance = (next: string[][]) => {
    if (qIndex + 1 >= items.length) {
      onSubmit(next);
    } else {
      setSelections(next);
      setQIndex(qIndex + 1);
      setHighlight(0);
    }
  };

  const choose = (optionIndex: number) => {
    const opt = item.options[optionIndex];
    if (!opt) return;
    if (multi) {
      setSelections((prev) =>
        prev.map((s, i) => (i === qIndex ? toggle(s, opt.label) : s)),
      );
    } else {
      // Single-select: the choice is the answer; record it and advance.
      advance(selections.map((s, i) => (i === qIndex ? [opt.label] : s)));
    }
  };

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (input === "t") {
      onFreeText();
      return;
    }
    if (key.upArrow || input === "k") {
      setHighlight((h) => Math.max(0, h - 1));
      return;
    }
    if (key.downArrow || input === "j") {
      setHighlight((h) => Math.min(item.options.length - 1, h + 1));
      return;
    }
    // Digit keys jump straight to (single-select) or toggle (multi-select) an
    // option by its 1-based number.
    if (/^[1-9]$/.test(input)) {
      const idx = Number(input) - 1;
      if (idx < item.options.length) {
        setHighlight(idx);
        choose(idx);
      }
      return;
    }
    if (multi && input === " ") {
      choose(highlight);
      return;
    }
    if (key.return) {
      if (multi) {
        // Confirm the current set; require at least one pick before advancing.
        if (selections[qIndex].length > 0) advance(selections);
      } else {
        choose(highlight);
      }
      return;
    }
  });

  const hint = multi
    ? "↑/↓ move · Space toggle · 1-9 pick · ↵ confirm · t type · Esc cancel"
    : "↑/↓ move · 1-9 / ↵ pick · t type · Esc cancel";

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
    >
      <Text>
        <Text bold>{title}</Text>
        <Text dimColor>
          {"  "}question{items.length > 1 ? ` ${qIndex + 1}/${items.length}` : ""}
        </Text>
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text color="yellow" bold wrap="truncate-end">
          ❓ {item.question || item.header}
        </Text>
        {multi && <Text dimColor>(select one or more)</Text>}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {item.options.map((opt, i) => {
          const active = i === highlight;
          const picked = selections[qIndex].includes(opt.label);
          const marker = multi ? (picked ? "[x]" : "[ ]") : picked ? "(•)" : "( )";
          return (
            <Box key={i} flexDirection="column">
              <Text color={active ? "cyan" : undefined} wrap="truncate-end">
                {active ? "❯ " : "  "}
                {marker} {i + 1}. {opt.label}
              </Text>
              {opt.description && (
                <Text dimColor wrap="truncate-end">
                  {"        "}
                  {opt.description}
                </Text>
              )}
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor wrap="truncate-end">
          {hint}
        </Text>
      </Box>
    </Box>
  );
}
