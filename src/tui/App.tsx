import React, { useEffect, useMemo, useState, useCallback } from "react";
import { Box, useApp, useInput, useStdout } from "ink";
import { sumUsage, type WorkspaceManager } from "../core/manager.js";
import type { AttentionReason, Workspace } from "../core/types.js";
import { WorkspaceList, sortWorkspaces } from "./components/WorkspaceList.js";
import {
  DetailPane,
  detailBodyHeight,
  detailTextWidth,
  wrappedRowCount,
} from "./components/DetailPane.js";
import { StatusBar } from "./components/StatusBar.js";
import { HelpOverlay } from "./components/HelpOverlay.js";
import {
  NewWorkspaceForm,
  type AgentInfo,
} from "./components/NewWorkspaceForm.js";

type Mode = "list" | "detail" | "new";
type View = "output" | "diff";

// Canned prompt sent to the workspace's agent when the user presses `S`. It
// asks the agent to turn whatever feature it just built into a reusable skill,
// grounded in the actual changes on the worktree's branch.
const SKILL_PROMPT =
  "Create a Claude Code skill that captures the feature you just built in this " +
  "workspace. Review the changes on this worktree (diff against the base branch) " +
  "to ground it, then write .claude/skills/<skill-name>/SKILL.md with YAML " +
  "frontmatter (a kebab-case `name` and a one-line `description` of when to use " +
  "it) plus concise instructions covering what the feature does, how to use it, " +
  "and when to apply it.";

// One-line note shown (and bell rung) when a workspace newly needs attention.
const ATTENTION_LABEL: Record<AttentionReason, string> = {
  "awaiting-input": "asked a question — press i to reply",
  permission: "wants permission — y/n",
  done: "finished — ready to review",
  error: "exited with an error",
};

interface Props {
  manager: WorkspaceManager;
  agents: AgentInfo[];
  // Requests that the host (index.tsx) open an interactive shell in this
  // workspace's worktree. Inside tmux the host opens a new window and we stay
  // running — it returns a confirmation string to flash. Otherwise the host
  // unmounts Ink, runs the shell in this terminal, and re-renders on exit
  // (returning nothing, since the TUI is being torn down).
  onShell: (ws: Workspace) => string | void;
  // Workspace to pre-select on mount, so returning from a shell lands the
  // cursor back on the same workspace the user jumped into.
  initialSelectedId?: string;
}

export function App({ manager, agents, onShell, initialSelectedId }: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [items, setItems] = useState<Workspace[]>(manager.snapshot());
  // Selection is tracked by workspace id, not list position, so a workspace
  // changing status (and thus moving between groups) keeps the same one
  // highlighted instead of the cursor sticking to a row index.
  const [selectedId, setSelectedId] = useState<string | undefined>(
    initialSelectedId,
  );
  const [mode, setMode] = useState<Mode>("list");
  const [view, setView] = useState<View>("output");
  const [diff, setDiff] = useState("");
  const [scroll, setScroll] = useState(0);
  // Output streams live, so by default the pane follows the tail. Scrolling up
  // pins the view; scrolling back to the bottom re-enables following.
  const [followTail, setFollowTail] = useState(true);
  const [message, setMessage] = useState<string | undefined>();
  // When set, the detail pane shows a reply box that feeds the agent's stdin.
  const [composing, setComposing] = useState(false);
  const [reply, setReply] = useState("");
  // Incremental title filter for the list. `filtering` is the text-entry mode
  // (typing the query); `filter` is the applied query, which keeps narrowing
  // the list even after the user stops typing, until cleared with esc.
  const [filtering, setFiltering] = useState(false);
  const [filter, setFilter] = useState("");
  // Inline rename of the selected workspace's title. Like the filter box, the
  // rename box owns the keyboard while open so letters edit the title instead of
  // triggering commands; `renameText` is the in-progress edit.
  const [renaming, setRenaming] = useState(false);
  const [renameText, setRenameText] = useState("");
  // When true, the keybinding cheat-sheet takes over the screen until any key is
  // pressed. Toggled with `?`.
  const [showHelp, setShowHelp] = useState(false);
  // Ticks once a second while an agent is running so live runtime badges
  // advance; `now` is read by the list/detail components for elapsed time.
  const [now, setNow] = useState(() => Date.now());
  const [size, setSize] = useState({
    cols: stdout.columns || 100,
    rows: stdout.rows || 30,
  });

  // Re-render whenever the manager reports a change.
  useEffect(() => {
    const onUpdate = () => setItems(manager.snapshot());
    manager.on("update", onUpdate);
    return () => {
      manager.off("update", onUpdate);
    };
  }, [manager]);

  // Ring the terminal bell and surface a one-line note whenever a workspace
  // newly needs attention (turn ended, question asked, permission requested,
  // or it errored). This is the payoff of running agents in parallel: you can
  // look away and get pinged when one of them actually needs you.
  useEffect(() => {
    const onAttention = (ws: Workspace, reason: AttentionReason) => {
      // BEL (ASCII 7) — the terminal's audible/visual bell.
      stdout.write(String.fromCharCode(7));
      setMessage(`🔔 ${ws.title}: ${ATTENTION_LABEL[reason]}`);
    };
    manager.on("attention", onAttention);
    return () => {
      manager.off("attention", onAttention);
    };
  }, [manager, stdout]);

  // Drive the runtime clock only while something is actually running, so an
  // idle session doesn't re-render every second for nothing. Snap `now` to the
  // current time as soon as a run begins so the first badge isn't a tick stale.
  const anyRunning = useMemo(
    () => items.some((w) => w.runStartedAt),
    [items],
  );
  useEffect(() => {
    if (!anyRunning) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [anyRunning]);

  // Track terminal resizes.
  useEffect(() => {
    const onResize = () =>
      setSize({ cols: stdout.columns || 100, rows: stdout.rows || 30 });
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  // Grouped/ordered view that the list renders and selection indexes into.
  // The title filter narrows the set first; an out-of-view selection simply
  // falls back to the first visible row (see selectedIndex below) and is
  // restored when the filter is cleared.
  const ordered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const matched = q
      ? items.filter((w) => w.title.toLowerCase().includes(q))
      : items;
    return sortWorkspaces(matched);
  }, [items, filter]);
  // Session-wide token/cost tally for the status bar.
  const sessionUsage = useMemo(() => sumUsage(items), [items]);
  const selectedIndex = Math.max(
    0,
    ordered.findIndex((w) => w.id === selectedId),
  );
  const current = ordered[selectedIndex];

  // Layout widths, needed up front so the scroll geometry can account for line
  // wrapping at the pane's exact text width.
  const listWidth = Math.min(40, Math.floor(size.cols * 0.35));
  const detailWidth = size.cols - listWidth - 2;

  // Scroll geometry, shared by the key handler and the render so they agree on
  // the bounds. `bodyHeight` mirrors the value handed to the panes below.
  const bodyHeight = Math.max(8, size.rows - 4);
  const viewportRows = detailBodyHeight(bodyHeight, composing);
  // Count wrapped display rows (not logical lines) so scrolling reaches every
  // row of a long, wrapped line and the tail lands on the real bottom.
  const sourceLines =
    view === "diff"
      ? diff
        ? diff.split("\n")
        : ["(no changes yet)"]
      : current?.output.length
        ? current.output
        : ["(no output yet)"];
  const totalLines = wrappedRowCount(sourceLines, detailTextWidth(detailWidth));
  const maxScroll = Math.max(0, totalLines - viewportRows);
  // While following, the conceptual top is the bottom of the buffer.
  const topNow = view === "output" && followTail ? maxScroll : Math.min(scroll, maxScroll);

  const flash = useCallback((msg: string) => {
    setMessage(msg);
  }, []);

  const loadDiff = useCallback(
    async (ws: Workspace | undefined) => {
      if (!ws) return;
      try {
        setDiff(await manager.getDiff(ws.id));
        setScroll(0);
      } catch (err) {
        flash(`diff failed: ${err instanceof Error ? err.message : err}`);
      }
    },
    [manager, flash],
  );

  const doMerge = useCallback(
    async (ws: Workspace | undefined) => {
      if (!ws) return;
      flash(`merging ${ws.title}…`);
      try {
        const result = await manager.merge(ws.id);
        if (result.ok) {
          flash(`merged ${ws.title} into ${manager.baseBranch}`);
        } else {
          const files = result.conflicts ?? [];
          const shown = files.slice(0, 3).join(", ");
          const more = files.length > 3 ? ` +${files.length - 3} more` : "";
          flash(
            `merge conflict in ${files.length} file${files.length === 1 ? "" : "s"} (${shown}${more}) — ${manager.baseBranch} left untouched; resolve in the worktree (c) and retry`,
          );
        }
      } catch (err) {
        flash(`merge failed: ${err instanceof Error ? err.message : err}`);
      }
    },
    [manager, flash],
  );

  const doRestart = useCallback(
    async (ws: Workspace | undefined) => {
      if (!ws) return;
      try {
        await manager.restart(ws.id);
        flash(`restarted ${ws.title}`);
      } catch (err) {
        flash(`restart failed: ${err instanceof Error ? err.message : err}`);
      }
    },
    [manager, flash],
  );

  const sendReply = useCallback(
    (ws: Workspace | undefined, text: string) => {
      setComposing(false);
      setReply("");
      const trimmed = text.trim();
      if (!ws || !trimmed) return;
      if (!manager.sendInput(ws.id, trimmed)) {
        flash("agent is not accepting input");
      }
    },
    [manager, flash],
  );

  const doClone = useCallback(
    async (ws: Workspace | undefined) => {
      if (!ws) return;
      flash(`cloning ${ws.title}…`);
      try {
        const clone = await manager.cloneWorkspace(ws.id);
        if (clone) {
          setSelectedId(clone.id);
          flash(`cloned ${ws.title} → ${clone.title}`);
        }
      } catch (err) {
        flash(`clone failed: ${err instanceof Error ? err.message : err}`);
      }
    },
    [manager, flash],
  );

  const doArchive = useCallback(
    async (ws: Workspace | undefined) => {
      if (!ws) return;
      // Move selection to a neighbour before the archived row leaves the list.
      const neighbour =
        ordered[selectedIndex + 1] ?? ordered[selectedIndex - 1];
      await manager.archive(ws.id);
      flash(`archived ${ws.title}`);
      setSelectedId(neighbour?.id);
      if (mode === "detail") setMode("list");
    },
    [manager, flash, mode, ordered, selectedIndex],
  );

  useInput(
    (input, key) => {
      setMessage(undefined);

      // The help cheat-sheet is a modal: while it's up, any key dismisses it and
      // nothing else fires.
      if (showHelp) {
        setShowHelp(false);
        return;
      }

      // While the rename box is open it owns the keyboard, same as the filter
      // box: type to edit the title, Enter to commit, Esc to abandon the edit.
      if (renaming) {
        if (key.escape) {
          setRenaming(false);
          setRenameText("");
        } else if (key.return) {
          if (current && manager.renameWorkspace(current.id, renameText)) {
            flash(`renamed to ${renameText.trim()}`);
          }
          setRenaming(false);
          setRenameText("");
        } else if (key.backspace || key.delete) {
          setRenameText((t) => t.slice(0, -1));
        } else if (input && !key.ctrl && !key.meta) {
          setRenameText((t) => t + input);
        }
        return;
      }

      // While the filter box is open it owns the keyboard: type to narrow the
      // list, Enter to apply and return to navigation (the query stays active),
      // Esc to clear it. This sits above every other binding so letters like
      // n/d/q build the query instead of triggering their commands.
      if (filtering) {
        if (key.escape) {
          setFiltering(false);
          setFilter("");
        } else if (key.return) {
          setFiltering(false);
        } else if (key.backspace || key.delete) {
          setFilter((f) => f.slice(0, -1));
        } else if (input && !key.ctrl && !key.meta) {
          setFilter((f) => f + input);
        }
        return;
      }

      if (mode === "list" || mode === "detail") {
        // A pending permission request blocks the selected agent, so answering
        // it takes precedence over the normal bindings: y allows, n denies.
        // (n is otherwise "new workspace"; while a prompt is up it means deny,
        // matching the y/n hint shown on the workspace.)
        if (current?.pendingPermission) {
          if (input === "y" || input === "n") {
            const allow = input === "y";
            const tool = current.pendingPermission.toolName;
            if (manager.respondPermission(current.id, allow)) {
              flash(`${allow ? "allowed" : "denied"} ${tool}`);
            }
            return;
          }
        }
        if (input === "q" || (key.ctrl && input === "c")) {
          manager.shutdown();
          exit();
          return;
        }
        if (input === "n") {
          setMode("new");
          return;
        }
        if (input === "m") {
          void doMerge(current);
          return;
        }
        if (input === "s") {
          if (current) {
            manager.stop(current.id);
            flash(`stopping ${current.title}`);
          }
          return;
        }
        if (input === "x") {
          void doArchive(current);
          return;
        }
        if (input === "S") {
          if (!current) return;
          if (manager.sendInput(current.id, SKILL_PROMPT)) {
            flash(`asked ${current.title} to build a skill`);
          } else {
            flash("agent is not running / not interactive");
          }
          return;
        }
        if (input === "R") {
          void doRestart(current);
          return;
        }
        if (input === "c") {
          if (!current?.path) {
            flash("no worktree to jump into yet");
          } else if (current.status === "archived") {
            flash("worktree was removed (archived)");
          } else {
            const msg = onShell(current);
            if (msg) flash(msg);
          }
          return;
        }
        if (input === "e") {
          if (current) {
            setRenameText(current.title);
            setRenaming(true);
          } else {
            flash("no workspace to rename");
          }
          return;
        }
        if (input === "C") {
          void doClone(current);
          return;
        }
        if (input === "?") {
          setShowHelp(true);
          return;
        }
      }

      if (mode === "list") {
        if (key.upArrow || input === "k")
          setSelectedId(ordered[Math.max(0, selectedIndex - 1)]?.id);
        else if (key.downArrow || input === "j")
          setSelectedId(
            ordered[Math.min(ordered.length - 1, selectedIndex + 1)]?.id,
          );
        else if (key.return) {
          setMode("detail");
          setView("output");
          setFollowTail(true);
        } else if (input === "d") {
          setMode("detail");
          setView("diff");
          void loadDiff(current);
        } else if (input === "/") {
          setFiltering(true);
        }
        return;
      }

      if (mode === "detail") {
        if (key.escape) {
          setMode("list");
          return;
        }
        if (input === "i") {
          if (manager.acceptsInput(current?.id ?? "")) {
            setView("output");
            setReply("");
            setComposing(true);
          } else {
            flash("agent is not running / not interactive");
          }
          return;
        }
        if (input === "o" || key.return) {
          setView("output");
          setFollowTail(true);
          return;
        }
        if (input === "d") {
          setView("diff");
          void loadDiff(current);
          return;
        }
        if (input === "r" && view === "diff") {
          void loadDiff(current);
          return;
        }
        // Both views scroll; the output view additionally re-follows the tail
        // once the user scrolls back to the bottom.
        let next: number | undefined;
        if (key.upArrow || input === "k") next = topNow - 1;
        else if (key.downArrow || input === "j") next = topNow + 1;
        else if (key.pageUp) next = topNow - 10;
        else if (key.pageDown) next = topNow + 10;
        if (next !== undefined) {
          const clamped = Math.max(0, Math.min(maxScroll, next));
          setScroll(clamped);
          if (view === "output") setFollowTail(clamped >= maxScroll);
        }
        return;
      }
    },
    { isActive: mode !== "new" && !composing },
  );

  if (showHelp) {
    return <HelpOverlay height={size.rows} />;
  }

  if (mode === "new") {
    return (
      <NewWorkspaceForm
        agents={agents}
        onCancel={() => setMode("list")}
        onSubmit={async ({ title, prompt, agentId }) => {
          setMode("list");
          flash(`launching ${agentId}…`);
          const ws = await manager.createWorkspace({ title, prompt, agentId });
          setSelectedId(ws.id);
        }}
      />
    );
  }

  return (
    <Box flexDirection="column" height={size.rows}>
      <Box flexDirection="row" height={bodyHeight}>
        <WorkspaceList
          items={ordered}
          selectedIndex={selectedIndex}
          width={listWidth}
          now={now}
          filter={filter}
        />
        <DetailPane
          ws={current}
          view={view}
          diff={diff}
          scroll={topNow}
          width={detailWidth}
          height={bodyHeight}
          now={now}
          composing={composing}
          reply={reply}
          onReplyChange={setReply}
          onReplySubmit={() => sendReply(current, reply)}
          onReplyCancel={() => {
            setComposing(false);
            setReply("");
          }}
        />
      </Box>
      <StatusBar
        mode={mode}
        view={view}
        message={message}
        repo={manager.git.root}
        baseBranch={manager.baseBranch}
        usage={sessionUsage}
        filtering={filtering}
        filter={filter}
        renaming={renaming}
        renameText={renameText}
      />
    </Box>
  );
}
