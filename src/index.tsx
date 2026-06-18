import React from "react";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { render } from "ink";
import { WorkspaceManager } from "./core/manager.js";
import { availableAgents } from "./core/agents.js";
import type { Workspace } from "./core/types.js";
import { App } from "./tui/App.js";
import { flickerFreeStdout } from "./tui/flicker-free-stdout.js";

// Shell env handed to a worktree shell, so the user (and their prompt) can tell
// they're inside a conduct worktree and which workspace it belongs to.
function shellEnv(ws: Workspace): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CONDUCT_WORKSPACE: ws.title,
    CONDUCT_WORKTREE: ws.path,
  };
}

// Preferred path when we're already running inside tmux: open the worktree
// shell in a brand-new tmux window instead of seizing our own terminal. conduct
// keeps running untouched in its original window (agents keep streaming), and
// the shell — and any dev server the user starts in it — lives in a separate
// pty, which sidesteps the raw-mode / job-control fight of an in-terminal
// handoff entirely. Returns false (so the caller can fall back) when we're not
// in tmux or the command fails.
function openInTmux(ws: Workspace): boolean {
  if (!process.env.TMUX) return false;
  // Sanitize the title into a tmux-friendly window name.
  const name = (ws.title || "worktree").replace(/[^\w.-]/g, "-").slice(0, 40);
  const res = spawnSync(
    "tmux",
    ["new-window", "-c", ws.path, "-n", name, process.env.SHELL || "/bin/bash"],
    { stdio: "ignore" },
  );
  return res.status === 0;
}

// In-terminal fallback: run an interactive shell in the worktree, returning once
// the user exits it. This is invoked only while Ink is unmounted, because an
// interactive shell (fish/zsh/bash) makes itself the terminal's foreground
// process group on startup; if Ink were still mounted it would keep writing to
// the tty and get hit with SIGTTOU — stopping our whole process (e.g.
// `fish: Job 2, 'pnpm dev' has stopped`).
//
// Unmounting Ink is necessary but not sufficient: Ink does not reliably take the
// tty out of raw mode or detach its stdin listeners on unmount, so the child
// shell would inherit a raw-mode tty while node keeps consuming keystrokes —
// the shell then sees no usable input and dies the instant it opens. We
// explicitly hand the terminal back to a sane cooked state and stop reading
// stdin before spawning; the fresh render() in main() re-arms everything after.
function runShell(ws: Workspace): Promise<void> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || "/bin/bash";
    const stdin = process.stdin;
    try {
      if (stdin.isTTY) stdin.setRawMode(false);
    } catch {
      // Best-effort: a non-tty or already-cooked stdin is fine to leave as-is.
    }
    stdin.removeAllListeners("data");
    stdin.removeAllListeners("readable");
    stdin.pause();

    process.stdout.write(
      `\nconduct: shell in ${ws.path}\n(exit or Ctrl-D to return)\n\n`,
    );
    const child = spawn(shell, [], {
      stdio: "inherit",
      cwd: ws.path,
      env: shellEnv(ws),
    });
    child.on("exit", () => resolve());
    child.on("error", (err) => {
      process.stderr.write(`conduct: shell failed: ${err.message}\n`);
      resolve();
    });
  });
}

async function main() {
  const arg = process.argv[2];
  const cwd = arg ? path.resolve(arg) : process.cwd();

  let manager: WorkspaceManager;
  try {
    manager = await WorkspaceManager.open(cwd);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const agents = (await availableAgents()).map((a) => ({
    id: a.id,
    displayName: a.displayName,
  }));

  // A configured defaultAgent that isn't installed would silently fall back to
  // the first available agent in the picker. Surface it here (before the TUI
  // mounts, so the warning isn't swallowed by the rendered frame) so the
  // misconfiguration is visible rather than mysterious.
  const wanted = manager.config.defaultAgent;
  if (wanted && !agents.some((a) => a.id === wanted)) {
    console.error(
      `conduct: defaultAgent "${wanted}" isn't available${
        agents.length ? ` (have: ${agents.map((a) => a.id).join(", ")})` : ""
      } — the picker will start on the first agent.`,
    );
  }

  // Render the TUI, but allow it to hand control back to us to run a shell:
  // pressing `c` calls onShell, which unmounts Ink so the terminal is fully
  // released, we run the shell to completion, then loop and re-render. A normal
  // quit leaves shellRequest unset and breaks the loop.
  // Route Ink's frames through the in-place writer so streaming output repaints
  // without the erase-then-redraw flash (see flickerFreeStdout). Only a real
  // TTY gets wrapped; piped/redirected output keeps the plain stream.
  const stdout = process.stdout.isTTY
    ? flickerFreeStdout(process.stdout)
    : process.stdout;

  let selectedId: string | undefined;
  for (;;) {
    let shellRequest: Workspace | undefined;
    const instance = render(
      <App
        manager={manager}
        agents={agents}
        initialSelectedId={selectedId}
        onShell={(ws) => {
          // When we can open a separate tmux window, do that and stay mounted —
          // no handoff, no teardown. Report back so the TUI can confirm it.
          if (openInTmux(ws)) return `opened ${ws.title} in a tmux window`;
          // Otherwise fall back to the in-terminal handoff: unmount Ink, let the
          // loop below run the shell to completion, then re-render.
          shellRequest = ws;
          selectedId = ws.id;
          instance.unmount();
          return undefined;
        }}
      />,
      { stdout },
    );
    await instance.waitUntilExit();
    if (!shellRequest) break;
    // Ink caches one instance per stdout stream; unmount() doesn't reliably
    // evict it, so without this the next render() would reuse the dead instance
    // and the TUI would never come back. cleanup() drops the cache entry so the
    // loop below builds a fresh instance. Wrapped in try-catch in case Ink ever
    // removes or renames the method.
    try { (instance as { cleanup?: () => void }).cleanup?.(); } catch { /* best-effort */ }
    await runShell(shellRequest);
  }

  manager.shutdown();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
