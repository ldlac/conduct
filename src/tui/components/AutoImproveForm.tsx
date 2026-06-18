import React from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import type { AgentInfo } from "./NewWorkspaceForm.js";

interface Props {
  agents: AgentInfo[];
  onSelect: (agentId: string) => void;
  onCancel: () => void;
}

export function AutoImproveForm({ agents, onSelect, onCancel }: Props) {
  useInput((_input, key) => {
    if (key.escape) onCancel();
  });

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text bold color="cyan">
        Auto-improve
      </Text>
      <Box marginTop={1} />
      <Box flexDirection="column">
        <Text dimColor>Pick an agent (↑/↓, Enter):</Text>
        <SelectInput
          items={agents.map((a) => ({ label: a.displayName, value: a.id }))}
          onSelect={(item) => onSelect(String(item.value))}
        />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Esc to cancel</Text>
      </Box>
    </Box>
  );
}
