import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import SelectInput from "ink-select-input";
import { MAX_FANOUT } from "../../core/manager.js";
import type { PromptPreset } from "../../core/config.js";

export interface AgentInfo {
  id: string;
  displayName: string;
}

/**
 * Index of the agent to highlight first in the picker. Honors a configured
 * {@link ConductConfig.defaultAgent} when it names an available agent, and
 * falls back to the first agent (index 0) otherwise — so a default that isn't
 * installed, or no default at all, simply starts the cursor at the top.
 */
export function initialAgentIndex(
  agents: AgentInfo[],
  defaultAgentId?: string,
): number {
  if (!defaultAgentId) return 0;
  const i = agents.findIndex((a) => a.id === defaultAgentId);
  return i >= 0 ? i : 0;
}

interface Props {
  agents: AgentInfo[];
  defaultCount?: number;
  /** Agent id to pre-select in the picker (from conduct.json's defaultAgent). */
  defaultAgentId?: string;
  /** Saved prompt presets from conduct.json, shown before the manual prompt entry. */
  prompts?: PromptPreset[];
  onSubmit: (v: {
    title: string;
    prompt: string;
    agentId: string;
    count: number;
  }) => void;
  onCancel: () => void;
}

type Step = "agent" | "preset" | "prompt" | "title" | "count";

/**
 * Label assigned to the synthetic "type a custom prompt" entry appended to the
 * presets list so the picker has a way to reach the manual prompt field.
 */
const CUSTOM_PROMPT_LABEL = "Custom prompt…";

/**
 * Parse the fan-out count field into a sane integer. Anything non-numeric or
 * below one falls back to a single workspace (the common case); the manager
 * clamps the upper bound, but we mirror {@link MAX_FANOUT} here too so the
 * confirmation the user sees matches what actually launches.
 */
export function parseCount(text: string): number {
  const n = Math.floor(Number(text.trim()));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(MAX_FANOUT, n);
}

export function NewWorkspaceForm({ agents, defaultCount, defaultAgentId, prompts, onSubmit, onCancel }: Props) {
  const [step, setStep] = useState<Step>(prompts && prompts.length > 0 ? "agent" : "agent");
  const [agentId, setAgentId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  // When a preset is selected, the prompt is pre-filled and the manual prompt
  // step is skipped, so the user lands straight on the title field.
  const [presetChosen, setPresetChosen] = useState(false);
  // How many parallel workspaces to spin up from this one prompt. Kept as the
  // raw text the user typed; coerced through parseCount on launch.
  const [count, setCount] = useState(String(defaultCount && defaultCount >= 1 ? Math.min(defaultCount, MAX_FANOUT) : 1));

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
            initialIndex={initialAgentIndex(agents, defaultAgentId)}
            onSelect={(item) => {
              setAgentId(String(item.value));
              setStep(prompts && prompts.length > 0 ? "preset" : "prompt");
            }}
          />
        </Box>
      )}

      {step === "preset" && prompts && (
        <Box flexDirection="column">
          <Text dimColor>Pick a saved prompt or type a custom one (↑/↓, Enter):</Text>
          <SelectInput
            items={[
              ...prompts.map((p) => ({ label: p.label, value: p.prompt })),
              { label: CUSTOM_PROMPT_LABEL, value: "" },
            ]}
            onSelect={(item) => {
              const val = String(item.value);
              if (val) {
                setPrompt(val);
                setPresetChosen(true);
                setStep("title");
              } else {
                setStep("prompt");
              }
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
          <Text dimColor>Short title (optional, Enter to continue):</Text>
          <Box>
            <Text color="green">❯ </Text>
            <TextInput
              value={title}
              onChange={setTitle}
              onSubmit={() => setStep("count")}
            />
          </Box>
        </Box>
      )}

      {step === "count" && (
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
              onSubmit={() =>
                onSubmit({
                  title: title.trim(),
                  prompt: prompt.trim(),
                  agentId,
                  count: parseCount(count),
                })
              }
            />
          </Box>
          <Box marginTop={1}>
            <Text dimColor>
              {parseCount(count) > 1
                ? `Runs the same prompt in ${parseCount(count)} independent worktrees so you can pick the best.`
                : "One workspace — bump this to race the same prompt several ways."}
            </Text>
          </Box>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>Esc to cancel</Text>
      </Box>
    </Box>
  );
}
