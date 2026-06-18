import fs from "node:fs/promises";
import path from "node:path";

export interface ConductConfig {
  /**
   * Default agent to pre-select when creating workspaces or auto-improve.
   * Must match an AgentBackend id (e.g. "claude", "codex", "opencode", "mock").
   */
  defaultAgent?: string;
  /**
   * Default number of parallel workspaces for fan-out (1-8).
   */
  defaultFanout?: number;
  /**
   * Maximum runtime in minutes per workspace. When set, the agent will be
   * gracefully stopped once its current turn exceeds this duration. Prevents
   * runaway agents and unexpected API costs. Undefined means no limit.
   */
  maxRuntime?: number;
  /**
   * Extra environment variables to inject into every agent process.
   */
  env?: Record<string, string>;
  /**
   * Per-agent overrides. The key is the AgentBackend id.
   */
  agents?: Record<string, AgentConfig>;
}

export interface AgentConfig {
  /**
   * Extra CLI arguments appended to the agent's command.
   */
  args?: string;
}

const CONFIG_FILENAME = "conduct.json";

export async function loadConfig(repoRoot: string): Promise<ConductConfig> {
  const configPath = path.join(repoRoot, CONFIG_FILENAME);
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as ConductConfig;
    return parsed;
  } catch {
    return {};
  }
}
