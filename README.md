# conduct

A terminal orchestrator for running multiple coding agents in parallel, each in
its own isolated **git worktree**. A small, local, open clone of
[Conductor](https://www.conductor.build/) as a TUI.

Point it at a git repo, spin up N **workspaces** from a single prompt each, watch
the agents work live, then review each one's diff and merge the ones you like.

## How it works

Each workspace is:

1. a fresh **git worktree** + branch (`conduct/<slug>-<id>`) created from your
   current branch, checked out under `~/.conduct/worktrees/<repo>/`,
2. a coding-agent process spawned in that worktree, with output streamed live,
3. reviewable as a unified **diff** against the base branch (untracked files
   included), and mergeable back with one keystroke (it auto-commits any pending
   work, then `git merge --no-ff`).

Because every workspace is a separate worktree, agents never collide on the
working tree, and nothing touches your main checkout until you merge.

Each workspace also carries a **diff-size badge** (`+120 -8`, green insertions
and red deletions) shown next to its title in the list and in the detail header,
so you can see at a glance how much each agent changed (and which made no changes
at all). It refreshes whenever an agent finishes a turn and whenever you open the
diff, so it tracks the worktree's settled state without polling a running agent.

## Session persistence

Workspaces are remembered across restarts. Their metadata (and a tail of each
agent's output) is saved to `~/.conduct/worktrees/<repo>/.conduct-state.json`
on every change and reloaded when you reopen the repo, so the worktrees and
branches `conduct` creates are never orphaned. On reload:

- a workspace whose agent was still running is shown as `stopped` (the process
  does not survive a restart, but its worktree and work are intact and still
  reviewable / mergeable, and the agent can be resumed with `R`),
- a workspace whose worktree has since been removed on disk is dropped from the
  list.

## Requirements

- Node 22+ and pnpm (provided by the devenv shell here)
- git
- At least one agent CLI on your `PATH`:
  - [`claude`](https://docs.claude.com/en/docs/claude-code) (Claude Code)
  - [`codex`](https://github.com/openai/codex) (Codex CLI)
  - [`opencode`](https://opencode.ai) (opencode)
  - a built-in `mock` agent is always available for testing without API tokens

## Run

```bash
pnpm install        # first time (approve the esbuild build script if prompted)
pnpm start          # orchestrate the current directory's repo
pnpm start ../my-repo   # or point at another repo
# or, after `pnpm link --global`:  conduct [repo]
```

## Keys

**List**

| key                | action                                         |
| ------------------ | ---------------------------------------------- |
| `n`                | new workspace (pick agent, prompt, title)      |
| `↑`/`↓` or `k`/`j` | move selection                                 |
| `↵`                | open workspace (live output)                   |
| `d`                | open workspace on the diff view                |
| `c`                | jump into a shell in the workspace's worktree  |
| `m`                | merge selected workspace into the base branch  |
| `s`                | stop the running agent                         |
| `S`                | ask the agent to turn its work into a skill    |
| `R`                | restart the agent in the existing worktree     |
| `x`                | archive (stop agent, remove worktree + branch) |
| `y` / `n`          | allow / deny a pending permission request      |
| `q`                | quit                                           |

**Detail**

| key                | action                            |
| ------------------ | --------------------------------- |
| `o` / `↵`          | output view (tails live)          |
| `d`                | diff view                         |
| `c`                | shell in the worktree             |
| `i`                | reply to the agent (answer a Q)   |
| `y` / `n`          | allow / deny a permission request |
| `S`                | ask the agent to build a skill    |
| `↑`/`↓`, PgUp/PgDn | scroll the diff                   |
| `R`                | restart the agent                 |
| `r`                | refresh the diff                  |
| `esc`              | back to the list                  |

## Answering the agent

Interactive agents (Claude Code, and the `mock` test runner) run as a
persistent session rather than one-shot, so you can talk back to them. When an
agent asks a question or you want to steer it, open the workspace and press `i`
to reply: type a message and `↵` sends it to the agent's stdin (`esc` cancels).
When an agent ends a turn by asking a question the detail header shows
`awaiting input (i to reply)`. A turn that just finishes the work does not flag
this (the agent isn't waiting on you), but the session stays alive so you can
still press `i` to steer it further.

The session stays alive across turns so you can keep steering it, but the
workspace no longer shows `running` the whole time: when a turn ends the agent
goes idle and the workspace flips to `done` (it moves to "Ready to review"), and
your next reply flips it back to `running`. You can merge straight from `done`;
merging shuts the idle session down for you, so there's no need to stop it first.

## Approving tool use

Each workspace edits files freely inside its own isolated worktree (those are
auto-approved), but anything with effects beyond it — running a shell command,
fetching a URL — pauses for your OK. When the agent asks, the workspace shows a
`⏸` marker in the list and the detail header reads `⏸ allow Bash? (y/n)`; the
exact request (e.g. the command it wants to run) is logged in the output view.
Press `y` to allow it or `n` to deny, and the agent continues. A denied tool
isn't fatal: the agent is told you declined and can take another approach. If
the agent exits while a request is pending, the request is dropped.

## Jumping into a worktree

To poke at what an agent built by hand (run it, run its tests, `git log`), press
`c` on a workspace (from the list or the detail view). The shell opens already
`cd`'d into that workspace's worktree, with `CONDUCT_WORKSPACE` and
`CONDUCT_WORKTREE` exported so you can tell where you are.

How it opens depends on your environment:

- **Inside tmux** (recommended): `conduct` opens a new tmux window running your
  shell in the worktree, and keeps running untouched in its own window. Your
  agents keep streaming and a dev server you start in the worktree can run
  alongside the TUI. Switch back with your normal tmux keys.
- **Otherwise**: `conduct` suspends the TUI and drops you into an interactive
  shell (`$SHELL`, falling back to `/bin/bash`) in this terminal. Type `exit`
  (or Ctrl-D) to return to exactly where you were.

Archived workspaces have no worktree to enter, so `c` is a no-op there.

## Agent flags

Pass extra CLI flags via env vars:

```bash
CONDUCT_CLAUDE_ARGS="--model claude-opus-4-8" pnpm start
CONDUCT_CODEX_ARGS="--full-auto" pnpm start
CONDUCT_OPENCODE_ARGS="--model anthropic/claude-opus-4-8" pnpm start
```

Claude Code runs headless with `--permission-mode acceptEdits` so it can edit
files in the isolated worktree without blocking on prompts.

## Layout

```
src/
  core/
    types.ts     workspace + agent-backend types
    git.ts       worktree / diff / merge helpers
    agents.ts    agent registry (claude, codex, opencode, mock)
    store.ts     workspace persistence (load/save state across restarts)
    manager.ts   orchestrator: spawns agents, streams output, merges
  tui/
    App.tsx      Ink app + keybindings
    components/  list, detail pane, new-workspace form, status bar
  index.tsx      entrypoint
```

## Merging and conflicts

`m` auto-commits any pending work and runs `git merge --no-ff` into the base
branch. If the merge conflicts, conduct rolls it straight back (`git merge
--abort`) so your base checkout is never left stranded mid-merge, flags the
workspace with a red `⚠`, and lists the conflicting files in the detail pane.
Resolve them by jumping into the worktree (`c`), then press `m` again to retry.

## Not yet (possible next steps)

Multi-repo and a richer diff browser. The core is structured so these slot in
around `WorkspaceManager`.
