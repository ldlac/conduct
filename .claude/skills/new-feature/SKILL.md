---
name: new-feature
description: Read this first before building a new feature in conduct. Gives a fast, accurate orientation to the app — what it is, how the pieces fit, where to make changes, and the conventions to follow.
---

# Building a new feature in conduct

Read this before touching code. It is a map of the app so you can land a change
in the right place and match the existing style, rather than rediscovering the
architecture each time.

## What conduct is

A terminal orchestrator (a TUI) for running several coding agents in parallel,
each isolated in its own **git worktree**. You point it at a git repo, spin up N
**workspaces** from a prompt each, watch the agents work live, then review each
one's diff and merge the ones you want.

The defining idea: every workspace is a real git worktree + branch
(`conduct/<slug>-<id>`) created off your current branch and checked out under
`~/.conduct/worktrees/<repo>/`. Agents never collide on the working tree, and
nothing touches the main checkout until you merge (`git merge --no-ff`, after
auto-committing pending work).

Stack: TypeScript (ESM, NodeNext), React + [Ink](https://github.com/vadimdemedes/ink)
for the terminal UI, Node 22+, run with `tsx`. No build step for dev.

## The shape of the code

```
src/
  core/                 no UI — pure orchestration, testable in isolation
    types.ts            Workspace, WorkspaceStatus, DiffStat, AgentBackend
    git.ts              Git class: worktree / diff / merge / commit helpers
    agents.ts           agent registry (claude, codex, opencode, mock) + availability
    manager.ts          WorkspaceManager: the orchestrator (spawn/stream/merge)
    store.ts            JSON persistence of workspaces across restarts
  tui/                  all UI — React/Ink
    App.tsx             top-level app, keybindings, view/scroll state
    components/         WorkspaceList, DetailPane, NewWorkspaceForm, StatusBar
  __tests__/            vitest test suite (6 files, 104+ tests)
    agents.test.ts, format.test.ts, detail.test.ts, manager.test.ts, sort.test.ts, store.test.ts
  index.tsx             entrypoint (opens the manager, mounts Ink, shell handoff)
```

Keep the `core` / `tui` split. Orchestration logic belongs in `core` (no React,
no Ink); anything visual belongs in `tui`. The UI is a pure function of manager
state.

## How it works at runtime

- **`WorkspaceManager`** (`core/manager.ts`) owns every workspace for one repo.
  It creates worktrees, spawns agent child processes, streams their stdout/stderr
  line by line into a rolling output buffer, and handles diff/merge/archive. It
  extends `EventEmitter` and emits `"update"` on every state change.
- **`App.tsx`** subscribes to `"update"` and re-renders from `manager.snapshot()`.
  This is the core/UI contract: mutate state in the manager, emit `"update"`,
  and the UI follows. The UI never mutates workspace state directly.
- **Agents** are described by the `AgentBackend` interface (`core/types.ts`) and
  registered in `core/agents.ts`. Interactive agents (those defining
  `encodeInput`) run as a persistent session: stdin stays open so the user can
  reply and keep the conversation going, and the process lives across turns.
  `turnEnded`/`awaitsReply` let the manager tell "idle, ready to review" from
  "idle, waiting on a question."
- **Status lifecycle:** `creating → running → done` (turn ended) → `merged`, with
  `error`, `archived`, and `stopped` (process gone after a restart, work intact)
  as the other states. A reply flips `done` back to `running`.
- **Persistence** (`core/store.ts`): the workspace list (with a trimmed output
  tail) is written atomically to `~/.conduct/worktrees/<repo>/.conduct-state.json`
  on every change (debounced) and synchronously on quit, then reloaded on open so
  worktrees and branches are never orphaned.

## Where a change usually goes

- New agent backend → add a `AgentBackend` to the `REGISTRY` in `core/agents.ts`.
- New keybinding / view / interaction → `tui/App.tsx` (`useInput`) and the
  relevant component under `tui/components/`.
- New git operation → a method on the `Git` class in `core/git.ts` (always go
  through it; never shell out to git from the UI).
- New per-workspace state → extend the `Workspace` interface in `core/types.ts`,
  populate it in the manager, and render it in the UI. Check `store.ts`
  serialization if it should survive a restart.
- New orchestration behavior (merge, archive, restart, input) → a method on
  `WorkspaceManager`, then wire a key to it in `App.tsx`.

## Conventions to match

- **TypeScript ESM:** relative imports use the `.js` extension (e.g.
  `from "./git.js"`) even though the source is `.ts` — required by NodeNext.
- **Comments explain *why*.** The codebase favors thorough doc comments on
  interfaces and non-obvious logic (see `types.ts`, `agents.ts`). Match that
  density and tone; document the reasoning behind a behavior, not just what it is.
- **Errors don't crash the TUI.** Best-effort operations swallow failures and
  keep the last-known good state (see `refreshStat`, the save path, archive).
  Surface user-facing failures via `flash(...)` in the UI, not by throwing into
  the render.
- **Git diffs include untracked files** — `Git.diff`/`diffNumstat` call
  `git add -A -N` (intent-to-add) first. Don't refresh the diff while an agent is
  actively writing; do it when a turn ends or the diff is opened (see the comments
  on `refreshStat`).
- **Selection is tracked by workspace id, not row index**, so a workspace can
  change status/group without the cursor jumping. Preserve that if you touch list
  navigation.

## Before you finish

- Run `pnpm test` (`vitest run`) and `pnpm typecheck` (`tsc --noEmit`) — the
  test suite and type checker are your safety net.
- Try it against a throwaway repo with `pnpm start <repo>`; the built-in `mock`
  agent needs no API tokens and exercises the full create / stream / reply / diff
  / merge flow.
- Keep the README's "Layout" and "Keys" sections honest if your change alters
  either.
