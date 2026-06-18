import React from "react";
import { Box, Text } from "ink";
import { keybindingsByCategory } from "../../core/keybindings.js";

function Section({ title, bindings }: { title: string; bindings: Array<{ keys: string; description: string }> }) {
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
          {b.description}
        </Text>
      ))}
    </Box>
  );
}

export function HelpOverlay({ height }: { height: number }) {
  const sections = keybindingsByCategory();
  return (
    <Box flexDirection="column" height={height} paddingX={2} paddingY={1}>
      <Text bold color="cyan">
        conduct — keybindings
      </Text>
      {sections.map(([title, bindings]) => (
        <Section key={title} title={title} bindings={bindings} />
      ))}
      <Box marginTop={1}>
        <Text dimColor>press any key to close</Text>
      </Box>
    </Box>
  );
}
