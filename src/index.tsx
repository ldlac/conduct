import React from "react";
import path from "node:path";
import { render } from "ink";
import { WorkspaceManager } from "./core/manager.js";
import { availableAgents } from "./core/agents.js";
import { App } from "./tui/App.js";

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

  const { waitUntilExit } = render(<App manager={manager} agents={agents} />);
  await waitUntilExit();
  manager.shutdown();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
