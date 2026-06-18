import React from "react";
import { Box, Text } from "ink";

/**
 * Full-screen keybinding cheat-sheet, toggled with `?` from the list or detail
 * view and dismissed with any key. It's the in-app counterpart to the README's
 * "Keys" tables, so the two should stay in sync when bindings change. Rendered
 * in place of the main layout (rather than as a true overlay) because Ink has no
 * z-index — taking over the screen is the simplest faithful "modal".
 */

interface Binding {
  keys: string;
  action: string;
}

const GLOBAL: Binding[] = [
  { keys: "?", action: "toggle this help" },
  { keys: "q / ^c", action: "quit" },
];

const LIST: Binding[] = [
  { keys: "n", action: "new workspace(s) (agent, prompt, title, fan-out count)" },
  { keys: "↑/↓ · k/j", action: "move selection" },
  { keys: "↵", action: "open workspace (live output)" },
  { keys: "d", action: "open workspace on the diff view" },
  { keys: "/", action: "filter the list by title" },
  { keys: "Tab", action: "cycle sort mode (group / A–Z / newest / oldest)" },
  { keys: "Space", action: "toggle mark for batch operations" },
  { keys: "Esc", action: "clear all marks (when any are set)" },
];

const ACTIONS: Binding[] = [
  { keys: "e", action: "rename the workspace title" },
  { keys: "C", action: "clone — re-run this prompt in a fresh worktree" },
  { keys: "c", action: "jump into a shell in the worktree" },
  { keys: "m", action: "merge (selected or all marked)" },
  { keys: "s", action: "stop the running agent" },
  { keys: "S", action: "ask the agent to turn its work into a skill" },
  { keys: "R", action: "restart the agent (selected or all marked)" },
  { keys: "x", action: "archive (selected or all marked)" },
  { keys: "y / n", action: "allow / deny a pending permission request" },
];

const DETAIL: Binding[] = [
  { keys: "o / ↵", action: "output view (tails live)" },
  { keys: "d", action: "diff view" },
  { keys: "/", action: "search the output or diff text" },
  { keys: "n / N (p)", action: "next / previous search match" },
  { keys: "i", action: "reply to the agent (answer a question)" },
  { keys: "↑/↓ · PgUp/PgDn", action: "scroll" },
  { keys: "r", action: "refresh the diff" },
  { keys: "esc", action: "back to the list" },
];

function Section({ title, bindings }: { title: string; bindings: Binding[] }) {
  // Align the action column across rows by padding the key column to the widest
  // key in this section.
  const keyWidth = Math.max(...bindings.map((b) => b.keys.length));
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="cyan">
        {title}
      </Text>
      {bindings.map((b) => (
        <Text key={b.keys}>
          <Text color="green">{b.keys.padEnd(keyWidth)}</Text>
          <Text dimColor>{"  "}</Text>
          {b.action}
        </Text>
      ))}
    </Box>
  );
}

export function HelpOverlay({ height }: { height: number }) {
  return (
    <Box flexDirection="column" height={height} paddingX={2} paddingY={1}>
      <Text bold color="cyan">
        conduct — keybindings
      </Text>
      <Section title="Global" bindings={GLOBAL} />
      <Section title="List" bindings={LIST} />
      <Section title="On the selected workspace (list or detail)" bindings={ACTIONS} />
      <Section title="Detail" bindings={DETAIL} />
      <Box marginTop={1}>
        <Text dimColor>press any key to close</Text>
      </Box>
    </Box>
  );
}
