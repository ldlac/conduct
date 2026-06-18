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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate and normalize a parsed `conduct.json` into a {@link ConductConfig},
 * dropping anything malformed rather than letting a bad value reach an agent
 * spawn. Each field is checked independently, so one bad entry (say a numeric
 * `defaultAgent`) doesn't discard the rest of the file. `warn` reports each
 * problem so a typo'd setting fails loudly instead of silently doing nothing.
 */
function normalizeConfig(
  parsed: unknown,
  warn: (msg: string) => void,
): ConductConfig {
  if (!isRecord(parsed)) {
    warn(`expected a JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`);
    return {};
  }
  const cfg: ConductConfig = {};

  if (parsed.defaultAgent !== undefined) {
    if (typeof parsed.defaultAgent === "string") cfg.defaultAgent = parsed.defaultAgent;
    else warn("defaultAgent must be a string");
  }

  if (parsed.defaultFanout !== undefined) {
    const n = parsed.defaultFanout;
    if (typeof n === "number" && Number.isFinite(n) && n >= 1) {
      cfg.defaultFanout = Math.floor(n);
    } else {
      warn("defaultFanout must be a number >= 1");
    }
  }

  if (parsed.env !== undefined) {
    if (isRecord(parsed.env)) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed.env)) {
        if (typeof v === "string") env[k] = v;
        else warn(`env.${k} must be a string`);
      }
      cfg.env = env;
    } else {
      warn("env must be an object of strings");
    }
  }

  if (parsed.agents !== undefined) {
    if (isRecord(parsed.agents)) {
      const agents: Record<string, AgentConfig> = {};
      for (const [id, raw] of Object.entries(parsed.agents)) {
        if (!isRecord(raw)) {
          warn(`agents.${id} must be an object`);
          continue;
        }
        const entry: AgentConfig = {};
        if (raw.args !== undefined) {
          if (typeof raw.args === "string") entry.args = raw.args;
          else warn(`agents.${id}.args must be a string`);
        }
        agents[id] = entry;
      }
      cfg.agents = agents;
    } else {
      warn("agents must be an object");
    }
  }

  return cfg;
}

export async function loadConfig(repoRoot: string): Promise<ConductConfig> {
  const configPath = path.join(repoRoot, CONFIG_FILENAME);
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch {
    // No config file is the common case — stay silent and use defaults.
    return {};
  }
  // The file exists, so a parse/shape problem is a real misconfiguration the
  // user should hear about (otherwise their settings silently do nothing),
  // mirroring how store.ts surfaces a corrupt state file. This runs before the
  // TUI mounts, so a console warning won't corrupt the rendered frame.
  const warn = (msg: string) =>
    console.error(`conduct: ignoring invalid ${CONFIG_FILENAME}: ${msg}`);
  try {
    return normalizeConfig(JSON.parse(raw), warn);
  } catch (err) {
    warn(err instanceof Error ? err.message : String(err));
    return {};
  }
}
