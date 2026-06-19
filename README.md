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

## Browsing a diff

Reviewing the result of a fan-out means reading several diffs fast. In the diff
view, `[` and `]` step through the changed files one at a time, but with many
files that's slow and blind. Press `f` to open a **changed-files overview**: a
list of every file the workspace touched, each with its own `+x -y` line delta
and the running total in the header. Move with `↑`/`↓` (or `j`/`k`), press `↵` to
jump the diff straight to that file, and `Esc` (or `f` again) to close without
moving. It opens on whichever file you're currently viewing, so you can see the
shape of an attempt at a glance and dive into the file that matters instead of
scrolling for it.

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
| `!`                | run a one-off command in the worktree (output streams in the shell view) |
| `m`                | merge (selected, or all marked when marks exist) |
| `P`                | push the branch and open a pull request (`gh`) |
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
| `[` / `]`          | previous / next file in the diff  |
| `f`                | changed-files overview (jump to a file in the diff) |
| `/`                | search the output or diff text    |
| `n` / `N` (`p`)    | next / previous search match      |
| `i`                | reply to the agent; opens an option picker for a multiple-choice question |
| `c`                | shell in the worktree             |
| `!`                | run a command in the worktree (shell view) · `s` stops it |
| `e`                | rename the workspace title        |
| `C`                | clone — re-run this prompt fresh  |
| `P`                | push the branch and open a pull request (`gh`) |
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
  shell (`$SHELL`, falling back to the first of `/bin/bash`, `/bin/zsh`,
  `fish`, `/bin/sh` that exists) in this terminal. It clears the screen so the
  shell starts clean, and clears it again on the way back, so you return to
  exactly where you were rather than to the shell stacked under the old frame.
  Type `exit` (or Ctrl-D) to return.

Archived workspaces have no worktree to enter, so `c` is a no-op there.

### Running one-off commands without leaving conduct

For a quick command against a worktree — `pnpm test`, `git status`, `ls` — you
don't need a full shell. Press `!` (from the list or detail) to open a command
box; type the command and press `↵`. conduct runs it in the worktree (through
your `$SHELL` with `-c`, so pipes, globs, and `&&` work, with `CONDUCT_WORKSPACE`
and `CONDUCT_WORKTREE` exported), and its output streams live into the **shell
view** of the detail pane — kept separate from the agent's transcript so the two
never tangle. The TUI keeps running the whole time; your agents keep streaming.

One command runs per workspace at a time. While it runs, the header reads
`— shell (running…) —`; press `s` to stop it. Scroll/search the output like any
other view (`↑`/`↓`, `g`/`G`, `/`). Command output is session-only — it isn't
persisted across restarts. For an interactive program (a REPL, `vim`, a dev
server you want to keep), use `c` to open a real shell instead.

## Agent flags

Pass extra CLI flags via env vars:

```bash
CONDUCT_CLAUDE_ARGS="--model claude-opus-4-8" pnpm start
CONDUCT_CODEX_ARGS="--full-auto" pnpm start
CONDUCT_OPENCODE_ARGS="--model anthropic/claude-opus-4-8" pnpm start
```

Claude Code runs headless with `--permission-mode acceptEdits` so it can edit
files in the isolated worktree without blocking on prompts.

## Configuration

Drop a `conduct.json` at the root of the repo you point conduct at to set
per-repo defaults. Every field is optional, and an invalid value is ignored
(with a warning printed at startup) rather than failing the launch:

```json
{
  "defaultAgent": "claude",
  "defaultFanout": 3,
  "setup": ["pnpm install", "cp .env.example .env"],
  "env": { "CONDUCT_CLAUDE_ARGS": "--model claude-opus-4-8" },
  "agents": {
    "opencode": { "args": "--model anthropic/claude-opus-4-8" }
  }
}
```

- `defaultAgent` preselects that agent in the new-workspace and auto-improve
  pickers (it must match an agent id: `claude`, `claude-all`, `codex`,
  `opencode`, `opencode-all`, or `mock`). If the named agent isn't installed,
  the picker just starts on the first available one.
- `defaultFanout` (1 to 8) prefills the "how many parallel workspaces" prompt.
- `setup` runs in each new worktree before the agent starts (see "Setup
  commands" below). A single string or an array of commands.
- `env` injects extra environment variables into every agent process.
- `agents.<id>.args` appends extra CLI flags for a specific agent, the file
  equivalent of the `CONDUCT_<AGENT>_ARGS` env vars above.

### Setup commands

Each workspace is a clean git worktree, so anything git doesn't track —
`node_modules`, a local `.env`, generated code, a primed build — is missing from
it. An agent that can run commands (the all-perms variants, or one you've
allowlisted) then lands in a half-broken tree: `pnpm test` fails because nothing
is installed.

Set `setup` in `conduct.json` to ready the worktree first. conduct runs the
command(s) in the new worktree before spawning the agent, through your `$SHELL`
with `-c` (so pipes, globs, and `&&` work) and with `CONDUCT_WORKSPACE` /
`CONDUCT_WORKTREE` plus any `env` you configured exported. A single string runs
one command; an array runs several in order. Setup output streams into the
workspace transcript prefixed with `⚙`, and while it runs the workspace sits in
`creating` and shows a `⚙` badge (the detail header reads `⚙ setting up…`).

If a setup command exits non-zero, the rest are skipped and the agent is *not*
started: the workspace lands in `error` with the setup output in its transcript,
so a broken environment is loud rather than silently handed to an agent. Setup
runs once, when the worktree is created — `R` (restart) reuses the worktree as-is
and does not re-run it, since its effects are already there.

## Layout

```
src/
  core/
    types.ts     workspace + agent-backend types
    git.ts       worktree / diff / merge helpers
    agents.ts    agent registry (claude, codex, opencode, mock)
    store.ts     workspace persistence (load/save state across restarts)
    config.ts    per-repo conduct.json (default agent, fan-out, setup, env, agent args)
    prompt.ts    builds the auto-improve prompt from repo context
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

## Pushing and pull requests

Merging lands an attempt straight into your base branch. When you'd rather ship
it through review — or just get a finished attempt off your machine — press `P`
to push the selected workspace's branch and open a pull request. conduct:

1. auto-commits any pending work (exactly as `m` does),
2. pushes the branch to `origin` (`git push -u`), recording the push on the
   workspace — the list shows a dim `⇡` and the detail header reads
   `⇡ pushed → origin`,
3. opens a pull request against the base branch with the [GitHub CLI](https://cli.github.com/)
   (`gh pr create --fill`, which derives the title and body from the commits).
   On success the workspace shows a magenta `⇡PR` and the detail header carries
   the PR URL; the status bar flashes the link.

The push and the PR are independent steps, so the result is honest about what
happened: if the branch reaches the remote but `gh` isn't installed (or there's
no GitHub remote), conduct tells you it pushed and leaves you to open the PR
yourself, rather than pretending the whole thing failed. If a PR for the branch
already exists, its URL is surfaced instead of erroring. Unlike `m`, pushing is
non-destructive and leaves any idle agent session alive, so you can keep
steering the workspace and push again later. `P` acts on the single selected
workspace (a PR is inherently per-branch); it needs a configured `origin`
remote, and the PR step needs `gh` on your `PATH`.

## Not yet (possible next steps)

Multi-repo orchestration. The diff browser now has a changed-files overview (see
"Browsing a diff"); side-by-side comparison of two attempts' diffs would build on
it. The core is structured so these slot in around `WorkspaceManager`.
