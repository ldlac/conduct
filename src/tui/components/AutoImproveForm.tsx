import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import SelectInput from "ink-select-input";
import type { AgentInfo } from "./NewWorkspaceForm.js";
import { MAX_FANOUT } from "../../core/manager.js";
import {
  AUTO_IMPROVE_FOCUS_LABELS,
  type AutoImproveFocus,
} from "../../core/prompt.js";

interface Props {
  agents: AgentInfo[];
  defaultCount?: number;
  onSubmit: (focus: AutoImproveFocus, agentId: string, count: number) => void;
  onCancel: () => void;
}

function parseCount(text: string): number {
  const n = Math.floor(Number(text.trim()));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(MAX_FANOUT, n);
}

export function AutoImproveForm({ agents, defaultCount, onSubmit, onCancel }: Props) {
  const [step, setStep] = useState<"focus" | "agent" | "count">("focus");
  const [focus, setFocus] = useState<AutoImproveFocus>("general");
  const [agentId, setAgentId] = useState("");
  const [count, setCount] = useState(String(defaultCount && defaultCount >= 1 ? Math.min(defaultCount, MAX_FANOUT) : 1));

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

  if (step === "agent") {
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
            onSelect={(item) => {
              setAgentId(String(item.value));
              setStep("count");
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
        <Text dimColor>
          How many parallel workspaces? (1-{MAX_FANOUT}, Enter to launch
          {parseCount(count) > 1 ? ` ${parseCount(count)}` : ""}):
        </Text>
        <Box>
          <Text color="green">❯ </Text>
          <TextInput
            value={count}
            onChange={setCount}
            onSubmit={() => onSubmit(focus, agentId, parseCount(count))}
          />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            {parseCount(count) > 1
              ? `Runs the same auto-improve in ${parseCount(count)} independent worktrees.`
              : "One workspace — bump this to race the same auto-improve several ways."}
          </Text>
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Esc to cancel</Text>
      </Box>
    </Box>
  );
}
