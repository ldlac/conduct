import React from "react";
import path from "node:path";
import { spawn } from "node:child_process";
import { render } from "ink";
import { WorkspaceManager } from "./core/manager.js";
import { availableAgents } from "./core/agents.js";
import type { Workspace } from "./core/types.js";
import { App } from "./tui/App.js";

// Run an interactive shell in a worktree, returning once the user exits it.
// This is deliberately invoked only while Ink is unmounted: an interactive
// shell (fish/zsh/bash) makes itself the terminal's foreground process group on
// startup, which demotes us to the background. If Ink were still mounted it
// would keep writing to the tty and get hit with SIGTTOU — stopping our whole
// process (e.g. `fish: Job 2, 'pnpm dev' has stopped`). With Ink torn down we
// touch the terminal only to print the banner before handing it over.
function runShell(ws: Workspace): Promise<void> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || "/bin/bash";
    process.stdout.write(
      `\nconduct: shell in ${ws.path}\n(exit or Ctrl-D to return)\n\n`,
    );
    const child = spawn(shell, [], {
      stdio: "inherit",
      cwd: ws.path,
      env: process.env,
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

  // Render the TUI, but allow it to hand control back to us to run a shell:
  // pressing `c` calls onShell, which unmounts Ink so the terminal is fully
  // released, we run the shell to completion, then loop and re-render. A normal
  // quit leaves shellRequest unset and breaks the loop.
  let selectedId: string | undefined;
  for (;;) {
    let shellRequest: Workspace | undefined;
    const instance = render(
      <App
        manager={manager}
        agents={agents}
        initialSelectedId={selectedId}
        onShell={(ws) => {
          shellRequest = ws;
          selectedId = ws.id;
          instance.unmount();
        }}
      />,
    );
    await instance.waitUntilExit();
    if (!shellRequest) break;
    // Ink caches one instance per stdout stream; unmount() doesn't reliably
    // evict it, so without this the next render() would reuse the dead instance
    // and the TUI would never come back. cleanup() drops the cache entry so the
    // loop below builds a fresh instance. Guarded in case the method is absent.
    (instance as { cleanup?: () => void }).cleanup?.();
    await runShell(shellRequest);
  }

  manager.shutdown();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
