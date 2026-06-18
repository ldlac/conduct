import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildAutoImprovePrompt } from "../core/prompt.js";
import { Git } from "../core/git.js";

let tmpDir: string;
let git: Git;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conduct-prompt-test-"));
  git = new Git(tmpDir);
  // Initialize a git repo with an initial commit
  await exec("git", ["init"], tmpDir);
  await exec("git", ["config", "user.email", "test@test.com"], tmpDir);
  await exec("git", ["config", "user.name", "Test"], tmpDir);
  fs.writeFileSync(path.join(tmpDir, ".gitkeep"), "");
  await exec("git", ["add", "-A"], tmpDir);
  await exec("git", ["commit", "-m", "initial commit"], tmpDir);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function exec(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const { spawn } = require("node:child_process");
    const child = spawn(cmd, args, { cwd, stdio: "pipe" });
    child.on("close", (code: number) =>
      code === 0 ? resolve() : reject(new Error(`exit ${code}`)),
    );
    child.on("error", reject);
  });
}

describe("buildAutoImprovePrompt", () => {
  it("includes the repo path in the prompt", async () => {
    const prompt = await buildAutoImprovePrompt(tmpDir, git);
    expect(prompt).toContain(tmpDir);
  });

  it("includes top-level directory listing", async () => {
    const prompt = await buildAutoImprovePrompt(tmpDir, git);
    expect(prompt).toContain("Top-level contents:");
    // dotfiles and node_modules should be excluded
    expect(prompt).not.toContain(".git");
    expect(prompt).not.toContain(".gitkeep");
  });

  it("includes README content when present", async () => {
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# Test Repo\nA test.");
    const prompt = await buildAutoImprovePrompt(tmpDir, git);
    expect(prompt).toContain("README.md:");
    expect(prompt).toContain("# Test Repo");
  });

  it("includes package.json content when present", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test-pkg", version: "1.0.0" }),
    );
    const prompt = await buildAutoImprovePrompt(tmpDir, git);
    expect(prompt).toContain("package.json:");
    expect(prompt).toContain("test-pkg");
  });

  it("includes recent git commits", async () => {
    fs.writeFileSync(path.join(tmpDir, "new-file.txt"), "content");
    await exec("git", ["add", "-A"], tmpDir);
    await exec("git", ["commit", "-m", "second commit"], tmpDir);
    const prompt = await buildAutoImprovePrompt(tmpDir, git);
    expect(prompt).toContain("Recent commits:");
    expect(prompt).toContain("second commit");
    expect(prompt).toContain("initial commit");
  });

  it("truncates README content to 2000 characters", async () => {
    const longContent = "x".repeat(3000);
    fs.writeFileSync(path.join(tmpDir, "README.md"), longContent);
    const prompt = await buildAutoImprovePrompt(tmpDir, git);
    // The function does readme.slice(0, 2000), so verify the prompt
    // does NOT contain 3000 consecutive 'x' characters.
    expect(prompt).not.toContain("x".repeat(3000));
    // But it should contain the first 2000 'x' characters.
    expect(prompt).toContain("x".repeat(2000));
  });

  it("skips node_modules and dotfiles in listing", async () => {
    fs.mkdirSync(path.join(tmpDir, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "node_modules/foo.js"), "x");
    fs.writeFileSync(path.join(tmpDir, ".secret"), "hidden");
    const prompt = await buildAutoImprovePrompt(tmpDir, git);
    expect(prompt).not.toContain("node_modules");
    expect(prompt).not.toContain(".secret");
  });

  it("handles missing README and package.json gracefully", async () => {
    const cleanDir = fs.mkdtempSync(path.join(os.tmpdir(), "conduct-clean-"));
    const cleanGit = new Git(cleanDir);
    await exec("git", ["init"], cleanDir);
    await exec("git", ["config", "user.email", "test@test.com"], cleanDir);
    await exec("git", ["config", "user.name", "Test"], cleanDir);
    fs.writeFileSync(path.join(cleanDir, "file.txt"), "hello");
    await exec("git", ["add", "-A"], cleanDir);
    await exec("git", ["commit", "-m", "init"], cleanDir);
    const prompt = await buildAutoImprovePrompt(cleanDir, cleanGit);
    expect(prompt).toContain("improve this codebase");
    expect(prompt).toContain("Top-level contents:");
    fs.rmSync(cleanDir, { recursive: true, force: true });
  });
});
