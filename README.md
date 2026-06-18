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

While an agent is actively working its row (and the detail header) also shows a
live **elapsed-time** badge, so you can see how long the current turn has been
running. The clock starts when a turn begins (launch, a reply, or a restart) and
stops the moment the turn ends.

## Fanning out a prompt

The payoff of isolated worktrees is racing the same task several ways at once.
When you create a workspace (`n`), the last step asks how many parallel
workspaces to spin up. Leave it at `1` for a single agent, or bump it (up to 8)
to launch that many independent attempts from the same prompt and agent in one
step. Each gets its own worktree, branch, and agent process, and a numbered
title (`Fix login (1/3)`, `(2/3)`, …) so the attempts stay tellable apart in the
list. They run in parallel; review their diffs side by side and merge whichever
came out best, then archive the rest. (You can still re-roll a single workspace
after the fact with `C` — fan-out just does it up front.)

## Attention alerts

Running several agents at once only pays off if you can look away and get pinged
when one needs you. conduct rings the terminal bell and shows a one-line note
whenever a workspace crosses into a state that wants your attention: it finished
a turn and is ready to review, asked a question, paused for a tool-permission
request, or exited with an error. The bell fires once on the transition, not
repeatedly while the workspace waits.

## Filtering the list

With many workspaces in flight, press `/` to filter the list by title. Type to
narrow it incrementally, `↵` to apply the filter and return to navigation (it
stays active), and `esc` to clear it. The active filter is shown in the list
header and the status bar; selection falls back to the first match while
filtered and is restored when you clear it.

## Batch operations

With several workspaces in flight, press `Space` to mark workspaces for batch
operations. Each marked workspace shows a `●` indicator in the list. With marks
active:

- `m` merges every marked workspace that is ready to review (status `done` or `stopped`)
- `x` archives every marked workspace (stops the agent, removes the worktree and branch)
- `R` restarts every marked workspace
- `i` broadcasts a follow-up message to every marked agent at once

Marks survive navigation and mode switches. Press `Esc` to clear all marks.
The status bar shows the mark count and available commands while marks exist.

## Broadcasting to several agents

Fanning a prompt out to N workspaces is only half the story; sometimes you want
to steer the whole fleet with one follow-up ("also add tests", "use the existing
logger"). Mark the workspaces you want with `Space`, then press `i` in the list
to open a broadcast box. The message is sent to every marked workspace that is
running an interactive agent and waiting; any that aren't are skipped, and the
status bar reports how many received it. (In the detail view, `i` still replies
to just the selected agent.)

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

## Install

Prebuilt standalone binaries (no Node or pnpm needed) are attached to every
[GitHub Release](https://github.com/ldlac/conduct/releases). Download the one
for your platform, then mark it executable and put it on your `PATH`.

Linux / macOS:

```bash
# pick the asset matching your OS/arch: linux-x64, linux-arm64, darwin-x64, darwin-arm64
curl -L -o conduct https://github.com/ldlac/conduct/releases/latest/download/conduct-darwin-arm64
chmod +x conduct
./conduct            # or move it onto your PATH, e.g. /usr/local/bin
```

On macOS, the binary is unsigned, so clear the quarantine flag the first time:
`xattr -d com.apple.quarantine conduct`.

Windows: download `conduct-windows-x64.exe` from the release and run it from a
terminal.

Each release also publishes `SHA256SUMS.txt` so you can verify a download with
`sha256sum -c SHA256SUMS.txt`.

To build the binaries yourself you need [Bun](https://bun.sh): run
`pnpm build` (or `bun run scripts/build.ts <target>` for a single platform).
Output lands in `dist/`.

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
| `n`                | new workspace(s) (agent, prompt, title, fan-out count) |
| `↑`/`↓` or `k`/`j` | move selection                                 |
| `↵`                | open workspace (live output)                   |
| `d`                | open workspace on the diff view                |
| `/`                | filter the list by title (↵ apply · esc clear) |
| `Tab`              | cycle sort mode (group / A–Z / newest / oldest) |
| `Space`            | toggle mark on the selected workspace          |
| `i`                | broadcast a message to all marked agents        |
| `e`                | rename the workspace title (↵ save · esc cancel) |
| `C`                | clone — re-run this prompt in a fresh worktree |
| `c`                | jump into a shell in the workspace's worktree  |
| `m`                | merge (selected, or all marked when marks exist) |
| `s`                | stop the running agent                         |
| `S`                | ask the agent to turn its work into a skill    |
| `R`                | restart (selected, or all marked when marks exist) |
| `x`                | archive (selected, or all marked when marks exist) |
| `y` / `n`          | allow / deny a pending permission request      |
| `?`                | toggle the keybinding help overlay             |
| `q`                | quit                                           |

**Detail**

| key                | action                            |
| ------------------ | --------------------------------- |
| `o` / `↵`          | output view (tails live)          |
| `d`                | diff view                         |
| `/`                | search the output or diff text    |
| `n` / `N` (`p`)    | next / previous search match      |
| `i`                | reply to the agent; opens an option picker for a multiple-choice question |
| `c`                | shell in the worktree             |
| `e`                | rename the workspace title        |
| `C`                | clone — re-run this prompt fresh  |
| `y` / `n`          | allow / deny a permission request |
| `S`                | ask the agent to build a skill    |
| `↑`/`↓`, PgUp/PgDn | scroll the diff                   |
| `R`                | restart the agent                 |
| `r`                | refresh the diff                  |
| `?`                | toggle the keybinding help overlay |
| `esc`              | back to the list                  |

## Answering the agent

Every agent here is conversational, so you can talk back to them — open the
workspace and press `i` to reply (type a message, `↵` sends it, `esc` cancels).
There are two ways an agent stays in the conversation:

- **Persistent session** (Claude Code, and the `mock` test runner): the process
  stays alive between turns and your reply is streamed to its stdin. When such
  an agent ends a turn by asking a question the detail header shows
  `awaiting input (i to reply)`; a turn that just finishes the work doesn't flag
  this, but the session stays alive so you can still press `i` to steer it.
- **Resume by re-running** (opencode): the CLI runs one turn and exits, and each
  reply re-runs it with `opencode run --continue` to pick the conversation back
  up. There's no live process between turns, so opencode doesn't flag
  `awaiting input` — once a turn finishes the workspace is idle and you can press
  `i` to reply (which starts the next turn) or merge it as-is. Each workspace is
  its own worktree, so the resumed session stays scoped to that workspace and
  never crosses into another, and a session even survives quitting and reopening
  conduct.

When Claude asks a structured multiple-choice question (its `AskUserQuestion`
tool), the workspace shows a `❓` marker and the header reads
`❓ asked a question (i to answer)`. Press `i` to open an option picker instead
of the plain reply box: move with `↑`/`↓`, pick with `↵` (or a number key), and
your choice is sent back to the agent as the next turn. For a multi-select
question, `Space` toggles options and `↵` confirms. Press `t` in the picker to
type a free-text answer instead, or `esc` to back out. (Headless Claude Code
can't pop its own question dialog, so without this the question would simply be
dismissed and the turn would end unanswered — conduct re-asks it for you.)

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
    components/  list, detail pane, question picker, new-workspace form, status bar
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
