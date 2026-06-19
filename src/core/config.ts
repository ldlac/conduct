import fs from "node:fs/promises";
import path from "node:path";

export interface ConductConfig {
  /**
   * Default agent to pre-select when creating workspaces.
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
   * Shell command(s) to run in each freshly created worktree *before* the agent
   * starts — the way to ready an environment the agent needs but git doesn't
   * track: `pnpm install`, copying a `.env`, generating code, priming a build.
   * Each conduct worktree is a clean checkout with no `node_modules`, secrets,
   * or build artifacts, so without this an agent (especially an all-perms one
   * that runs tests/builds) lands in a half-broken tree.
   *
   * Accepts a single string or an array; the loader normalizes either into a
   * list of commands run sequentially, each through `$SHELL -c` in the worktree
   * (so pipes, globs, and `&&` work). The first command to exit non-zero aborts
   * the rest and the agent is not started — the workspace lands in `error` with
   * the setup output in its transcript. Not re-run on {@link
   * manager.WorkspaceManager.restart} (the worktree, and thus setup's effects,
   * are reused as-is).
   */
  setup?: string[];
  /**
   * Per-agent overrides. The key is the AgentBackend id.
   */
  agents?: Record<string, AgentConfig>;
  /**
   * Named prompt presets shown as quick-select options in the new-workspace
   * form. Each preset needs a `label` (displayed in the picker) and a `prompt`
   * (sent to the agent). Define them so common tasks ("add tests", "fix lint")
   * are a keystroke away instead of typed from scratch every time.
   *
   * Accepts an array of `{ label, prompt }` objects, or a shorthand object
   * mapping label → prompt (e.g. `{ "Add tests": "Write comprehensive tests" }`).
   * Both forms are normalized into `PromptPreset[]` on load.
   */
  prompts?: PromptPreset[];
}

export interface AgentConfig {
  /**
   * Extra CLI arguments appended to the agent's command.
   */
  args?: string;
}

/**
 * A named prompt preset that appears as a quick-select option in the
 * new-workspace form. Defined in conduct.json under the `prompts` key,
 * these let users store reusable prompt templates (e.g. "add-tests",
 * "fix-lint") and pick them without retyping.
 */
export interface PromptPreset {
  /** A short name/label shown in the picker. */
  label: string;
  /** The prompt text to send to the agent. */
  prompt: string;
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

  if (parsed.setup !== undefined) {
    // Accept a bare string (one command) or an array of strings (several, run
    // in order). Trim and drop blanks so a stray empty entry never spawns an
    // empty shell; if nothing valid survives, leave `setup` unset entirely.
    const raw = Array.isArray(parsed.setup) ? parsed.setup : [parsed.setup];
    const cmds: string[] = [];
    for (const entry of raw) {
      if (typeof entry === "string") {
        const trimmed = entry.trim();
        if (trimmed) cmds.push(trimmed);
      } else {
        warn("setup entries must be strings");
      }
    }
    if (cmds.length > 0) cfg.setup = cmds;
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

  if (parsed.prompts !== undefined) {
    // Accept an array of { label, prompt } objects or a shorthand
    // { label -> prompt } mapping.
    if (Array.isArray(parsed.prompts)) {
      const presets: PromptPreset[] = [];
      for (const entry of parsed.prompts) {
        if (isRecord(entry) && typeof entry.label === "string" && typeof entry.prompt === "string") {
          const label = entry.label.trim();
          const prompt = entry.prompt.trim();
          if (label && prompt) presets.push({ label, prompt });
        } else {
          warn("prompts array entries must be objects with string label and prompt");
        }
      }
      if (presets.length > 0) cfg.prompts = presets;
    } else if (isRecord(parsed.prompts)) {
      const presets: PromptPreset[] = [];
      for (const [label, prompt] of Object.entries(parsed.prompts)) {
        if (typeof prompt === "string" && label.trim() && prompt.trim()) {
          presets.push({ label: label.trim(), prompt: prompt.trim() });
        } else {
          warn(`prompts.${label} must be a string`);
        }
      }
      if (presets.length > 0) cfg.prompts = presets;
    } else {
      warn("prompts must be an array of { label, prompt } objects or an object mapping label -> prompt");
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
