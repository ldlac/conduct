import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import SelectInput from "ink-select-input";

export interface AgentInfo {
  id: string;
  displayName: string;
}

interface Props {
  agents: AgentInfo[];
  onSubmit: (v: { title: string; prompt: string; agentId: string }) => void;
  onCancel: () => void;
}

type Step = "agent" | "prompt" | "title";

export function NewWorkspaceForm({ agents, onSubmit, onCancel }: Props) {
  const [step, setStep] = useState<Step>("agent");
  const [agentId, setAgentId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");

  useInput((_input, key) => {
    if (key.escape) onCancel();
  });

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text bold color="cyan">
        New workspace
      </Text>
      <Box marginTop={1} />

      {step === "agent" && (
        <Box flexDirection="column">
          <Text dimColor>Pick an agent (↑/↓, Enter):</Text>
          <SelectInput
            items={agents.map((a) => ({ label: a.displayName, value: a.id }))}
            onSelect={(item) => {
              setAgentId(String(item.value));
              setStep("prompt");
            }}
          />
        </Box>
      )}

      {step === "prompt" && (
        <Box flexDirection="column">
          <Text dimColor>What should the agent do? (Enter to continue)</Text>
          <Box>
            <Text color="green">❯ </Text>
            <TextInput
              value={prompt}
              onChange={setPrompt}
              onSubmit={() => prompt.trim() && setStep("title")}
            />
          </Box>
        </Box>
      )}

      {step === "title" && (
        <Box flexDirection="column">
          <Text dimColor>Short title (optional, Enter to launch):</Text>
          <Box>
            <Text color="green">❯ </Text>
            <TextInput
              value={title}
              onChange={setTitle}
              onSubmit={() =>
                onSubmit({
                  title: title.trim(),
                  prompt: prompt.trim(),
                  agentId,
                })
              }
            />
          </Box>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>Esc to cancel</Text>
      </Box>
    </Box>
  );
}
