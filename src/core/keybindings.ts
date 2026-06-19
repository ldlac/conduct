export interface Keybinding {
  keys: string;
  description: string;
  category: "global" | "list" | "actions" | "detail";
}

export const KEYBINDINGS: Keybinding[] = [
  // Global
  { keys: "?", description: "toggle this help", category: "global" },
  { keys: "q / ^c", description: "quit", category: "global" },

  // List navigation
  { keys: "n", description: "new workspace(s) (agent, prompt, title, fan-out count)", category: "list" },
  { keys: "↑/↓ · k/j", description: "move selection", category: "list" },
  { keys: "g/G", description: "go to top / bottom of the list", category: "list" },
  { keys: "↵", description: "open workspace (live output)", category: "list" },
  { keys: "d", description: "open workspace on the diff view", category: "list" },
  { keys: "/", description: "filter the list by title", category: "list" },
  { keys: "Tab", description: "cycle sort mode (group / A–Z / newest / oldest)", category: "list" },
  { keys: "Space", description: "toggle mark for batch operations", category: "list" },
  { keys: "i", description: "broadcast a message to all marked agents", category: "list" },
  { keys: "Esc", description: "clear all marks (when any are set)", category: "list" },
  { keys: "Ctrl+a", description: "mark all workspaces", category: "list" },

  // Actions on selected workspace
  { keys: "e", description: "rename the workspace title", category: "actions" },
  { keys: "C", description: "clone — re-run this prompt in a fresh worktree", category: "actions" },
  { keys: "A", description: "auto-improve — analyze repo and improve it autonomously", category: "actions" },
  { keys: "c", description: "jump into a shell in the worktree", category: "actions" },
  { keys: "!", description: "run a one-off command in the worktree (output streams in the shell view)", category: "actions" },
  { keys: "m", description: "merge (selected or all marked)", category: "actions" },
  { keys: "P", description: "push branch & open a pull request (needs gh)", category: "actions" },
  { keys: "s", description: "stop the running agent", category: "actions" },
  { keys: "S", description: "ask the agent to turn its work into a skill", category: "actions" },
  { keys: "R", description: "restart the agent (selected or all marked)", category: "actions" },
  { keys: "x", description: "archive (selected or all marked)", category: "actions" },
  { keys: "y / n", description: "allow / deny a pending permission request", category: "actions" },
  { keys: "Alt+a", description: "archive all merged workspaces", category: "actions" },
  { keys: "Alt+s", description: "stop all running agents", category: "actions" },
  { keys: "Alt+r", description: "restart all stopped / failed agents", category: "actions" },

  // Detail view
  { keys: "o / ↵", description: "output view (tails live)", category: "detail" },
  { keys: "d", description: "diff view", category: "detail" },
  { keys: "[ / ]", description: "previous / next file in diff", category: "detail" },
  { keys: "f", description: "changed-files overview (jump to a file in the diff)", category: "detail" },
  { keys: "Tab / ⇧Tab", description: "switch to next / previous workspace", category: "detail" },
  { keys: "/", description: "search the output or diff text", category: "detail" },
  { keys: "n / N (p)", description: "next / previous search match", category: "detail" },
  { keys: "i", description: "reply to the agent; opens an option picker when it asked a multiple-choice question", category: "detail" },
  { keys: "↑/↓ · PgUp/PgDn", description: "scroll", category: "detail" },
  { keys: "g/G", description: "scroll to top / bottom", category: "detail" },
  { keys: "r", description: "refresh the diff", category: "detail" },
  { keys: "!", description: "run a command in the worktree; output shows in the shell view", category: "detail" },
  { keys: "s", description: "in the shell view: stop the running command", category: "detail" },
  { keys: "esc", description: "back to the list", category: "detail" },
];

export const CATEGORY_TITLES: Record<Keybinding["category"], string> = {
  global: "Global",
  list: "List",
  actions: "On the selected workspace (list or detail)",
  detail: "Detail",
};

const CATEGORY_ORDER: Keybinding["category"][] = ["global", "list", "actions", "detail"];

export function keybindingsByCategory(): [string, Keybinding[]][] {
  return CATEGORY_ORDER.map((cat) => [
    CATEGORY_TITLES[cat],
    KEYBINDINGS.filter((k) => k.category === cat),
  ]);
}

export const MODE_HINTS: Record<string, string> = {
  list: "n new · Space mark · Ctrl+a mark all · ↑/↓ select · ↵ open · d diff · / filter · e rename · A auto · C clone · c shell · ! run cmd · m merge · P push/PR · s stop · x archive · ? help · q quit",
  detail:
    "↵/o output · d diff · ! run cmd · [/] files · f file list · Tab next ws · / search · i reply · ↑/↓ scroll · n/N matches · ? help · esc back",
  new: "fill the form · esc cancel",
  "auto-improve": "pick focus · pick agent · set count · esc cancel",
};
