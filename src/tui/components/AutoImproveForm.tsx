import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import type { AgentInfo } from "./NewWorkspaceForm.js";
import {
  AUTO_IMPROVE_FOCUS_LABELS,
  type AutoImproveFocus,
} from "../../core/prompt.js";

interface Props {
  agents: AgentInfo[];
  onSubmit: (focus: AutoImproveFocus, agentId: string) => void;
  onCancel: () => void;
}

export function AutoImproveForm({ agents, onSubmit, onCancel }: Props) {
  const [step, setStep] = useState<"focus" | "agent">("focus");
  const [focus, setFocus] = useState<AutoImproveFocus>("general");

  useInput((_input, key) => {
    if (key.escape) onCancel();
  });

  if (step === "focus") {
    const focusItems = (
      Object.entries(AUTO_IMPROVE_FOCUS_LABELS) as [AutoImproveFocus, string][]
    ).map(([value, label]) => ({ label, value }));

    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Text bold color="cyan">
          Auto-improve
        </Text>
        <Box marginTop={1} />
        <Box flexDirection="column">
          <Text dimColor>Pick a focus area (↑/↓, Enter):</Text>
          <SelectInput
            items={focusItems}
            onSelect={(item) => {
              setFocus(String(item.value) as AutoImproveFocus);
              setStep("agent");
            }}
          />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Esc to cancel</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text bold color="cyan">
        Auto-improve — {AUTO_IMPROVE_FOCUS_LABELS[focus]}
      </Text>
      <Box marginTop={1} />
      <Box flexDirection="column">
        <Text dimColor>Pick an agent (↑/↓, Enter):</Text>
        <SelectInput
          items={agents.map((a) => ({ label: a.displayName, value: a.id }))}
          onSelect={(item) => onSubmit(focus, String(item.value))}
        />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Esc to cancel</Text>
      </Box>
    </Box>
  );
}
