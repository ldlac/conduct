import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
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

function writeConfig(value: unknown): void {
  fs.writeFileSync(
    path.join(tmpDir, "conduct.json"),
    typeof value === "string" ? value : JSON.stringify(value),
  );
}

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
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    writeConfig("not json");
    const cfg = await loadConfig(tmpDir);
    expect(cfg).toEqual({});
    // A file that exists but doesn't parse is a real misconfiguration; warn.
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("ignores a top-level JSON value that isn't an object", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    writeConfig(42);
    expect(await loadConfig(tmpDir)).toEqual({});
    writeConfig(["a", "b"]);
    expect(await loadConfig(tmpDir)).toEqual({});
    warn.mockRestore();
  });

  it("drops fields with the wrong type but keeps the valid ones", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    writeConfig({
      defaultAgent: 123, // invalid
      defaultFanout: 4, // valid
      env: { OK: "yes", BAD: 5 }, // BAD dropped
      agents: { claude: { args: "--verbose" }, codex: "nope" }, // codex dropped
    });
    const cfg = await loadConfig(tmpDir);
    expect(cfg.defaultAgent).toBeUndefined();
    expect(cfg.defaultFanout).toBe(4);
    expect(cfg.env).toEqual({ OK: "yes" });
    expect(cfg.agents).toEqual({ claude: { args: "--verbose" } });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("rejects a non-positive or non-numeric defaultFanout", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    writeConfig({ defaultFanout: 0 });
    expect((await loadConfig(tmpDir)).defaultFanout).toBeUndefined();
    writeConfig({ defaultFanout: "3" });
    expect((await loadConfig(tmpDir)).defaultFanout).toBeUndefined();
    warn.mockRestore();
  });

  it("floors a fractional defaultFanout to an integer", async () => {
    writeConfig({ defaultFanout: 3.9 });
    expect((await loadConfig(tmpDir)).defaultFanout).toBe(3);
  });

  it("normalizes a single-string setup into a one-command list", async () => {
    writeConfig({ setup: "pnpm install" });
    expect((await loadConfig(tmpDir)).setup).toEqual(["pnpm install"]);
  });

  it("keeps a setup array in order, trimming and dropping blank entries", async () => {
    writeConfig({ setup: ["  pnpm install  ", "", "   ", "cp .env.example .env"] });
    expect((await loadConfig(tmpDir)).setup).toEqual([
      "pnpm install",
      "cp .env.example .env",
    ]);
  });

  it("leaves setup unset when nothing valid survives, warning on bad entries", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    writeConfig({ setup: ["", "   "] });
    expect((await loadConfig(tmpDir)).setup).toBeUndefined();
    writeConfig({ setup: [5, true] });
    expect((await loadConfig(tmpDir)).setup).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
