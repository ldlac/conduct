import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig } from "../core/config.js";

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conduct-config-test-"));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("returns empty config when no conduct.json exists", async () => {
    const cfg = await loadConfig(tmpDir);
    expect(cfg).toEqual({});
  });

  it("loads valid conduct.json", async () => {
    const config = {
      defaultAgent: "claude",
      defaultFanout: 3,
      env: { FOO: "bar" },
      agents: { claude: { args: "--verbose" } },
    };
    fs.writeFileSync(path.join(tmpDir, "conduct.json"), JSON.stringify(config));
    const cfg = await loadConfig(tmpDir);
    expect(cfg.defaultAgent).toBe("claude");
    expect(cfg.defaultFanout).toBe(3);
    expect(cfg.env).toEqual({ FOO: "bar" });
    expect(cfg.agents?.claude?.args).toBe("--verbose");
  });

  it("handles partial config gracefully", async () => {
    fs.writeFileSync(path.join(tmpDir, "conduct.json"), JSON.stringify({ defaultAgent: "codex" }));
    const cfg = await loadConfig(tmpDir);
    expect(cfg.defaultAgent).toBe("codex");
    expect(cfg.defaultFanout).toBeUndefined();
    expect(cfg.env).toBeUndefined();
  });

  it("returns empty config for malformed JSON", async () => {
    fs.writeFileSync(path.join(tmpDir, "conduct.json"), "not json");
    const cfg = await loadConfig(tmpDir);
    expect(cfg).toEqual({});
  });
});
