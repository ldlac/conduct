import React, { useEffect, useMemo, useState, useCallback } from "react";
import { Box, useStdout } from "ink";
import { sumUsage, type WorkspaceManager } from "../core/manager.js";
import type { AttentionReason, SortMode, Workspace } from "../core/types.js";
import { SORT_LABELS, WorkspaceList, sortWorkspaces } from "./components/WorkspaceList.js";
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
import { AutoImproveForm } from "./components/AutoImproveForm.js";
import { useConductKeys } from "./useConductKeys.js";

type Mode = "list" | "detail" | "new" | "auto-improve";
type View = "output" | "diff";

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
  // Search within the current detail view (output or diff). Typing `/` in detail
  // mode opens a search box; Enter commits, Esc clears. `n`/`N` cycle matches.
  const [searching, setSearching] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState(0);
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
  // Sort mode for the workspace list. Toggled with Tab from the list view;
  // group (lifecycle stage then creation time) is the default.
  const [sortMode, setSortMode] = useState<SortMode>("group");
  // Marked workspace ids for batch operations. Toggled with Space; when marks
  // exist, merge/archive/restart operate on every marked workspace instead of
  // the single selected one. Cleared explicitly (Esc) or after a batch action.
  const [markedIds, setMarkedIds] = useState<string[]>([]);
  const marks = useMemo(() => new Set(markedIds), [markedIds]);
  const toggleMark = useCallback((id: string) => {
    setMarkedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }, []);
  const hasMarks = markedIds.length > 0;
  const clearMarks = useCallback(() => setMarkedIds([]), []);
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
    return sortWorkspaces(matched, sortMode);
  }, [items, filter, sortMode]);
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

  // Search results for the current detail view: display-row indices of every
  // line that contains the query. Computed from the raw (logical) lines using
  // the same wrapping arithmetic as the detail pane, so scrolling lands on the
  // correct visual row.
  const searchResults: number[] = (() => {
    if (!searchQuery || !current) return [];
    const q = searchQuery.toLowerCase();
    const lines = view === "diff" ? diff.split("\n") : current.output;
    const textWidth = detailTextWidth(detailWidth);
    const matches: number[] = [];
    let row = 0;
    for (const l of lines) {
      if (l.toLowerCase().includes(q)) matches.push(row);
      row += Math.max(1, Math.ceil(l.length / textWidth));
    }
    return matches;
  })();
  const searchCurrentRow =
    searchResults.length > 0 ? searchResults[searchIndex] : -1;

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

  const doAutoImprove = useCallback(async (agentId?: string) => {
    const id = agentId ?? agents[0]?.id;
    if (!id) {
      flash("no agents available");
      return;
    }
    const agent = agents.find((a) => a.id === id);
    flash("analyzing repo…");
    try {
      const prompt = await manager.buildAutoImprovePrompt();
      const created = await manager.createWorkspaces({
        title: "Auto-improve",
        prompt,
        agentId: id,
        count: 1,
      });
      if (created[0]) {
        setSelectedId(created[0].id);
        flash(`auto-improve launched with ${agent?.displayName ?? id}`);
      }
    } catch (err) {
      flash(
        `auto-improve failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [manager, flash, agents]);

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

  const doMergeMany = useCallback(async () => {
    const targets = ordered.filter((w) => markedIds.includes(w.id));
    if (targets.length === 0) {
      flash("no marked workspaces");
      return;
    }
    let merged = 0;
    let failed = 0;
    for (const ws of targets) {
      if (ws.status !== "done" && ws.status !== "stopped") continue;
      try {
        const result = await manager.merge(ws.id);
        if (result.ok) merged++;
        else failed++;
      } catch {
        failed++;
      }
    }
    clearMarks();
    flash(`merged ${merged}, failed ${failed} of ${targets.length} marked`);
  }, [manager, flash, ordered, markedIds, clearMarks]);

  const doArchiveMany = useCallback(async () => {
    const targets = ordered.filter((w) => markedIds.includes(w.id));
    if (targets.length === 0) {
      flash("no marked workspaces");
      return;
    }
    let count = 0;
    for (const ws of targets) {
      await manager.archive(ws.id);
      count++;
    }
    clearMarks();
    // Selection may have been on an archived workspace; move to first remaining.
    const remaining = manager.snapshot();
    setSelectedId(remaining[0]?.id);
    setMode("list");
    flash(`archived ${count} workspace${count === 1 ? "" : "s"}`);
  }, [manager, flash, ordered, markedIds, clearMarks]);

  const doRestartMany = useCallback(async () => {
    const targets = ordered.filter((w) => markedIds.includes(w.id));
    if (targets.length === 0) {
      flash("no marked workspaces");
      return;
    }
    let count = 0;
    for (const ws of targets) {
      if (ws.status === "merged" || ws.status === "archived") continue;
      try {
        await manager.restart(ws.id);
        count++;
      } catch {
        /* skip workspaces that can't be restarted */
      }
    }
    clearMarks();
    flash(`restarted ${count} of ${targets.length} marked`);
  }, [manager, flash, ordered, markedIds, clearMarks]);

  useConductKeys({
    manager, agents, onShell,
    mode, setMode,
    view, setView,
    scroll, setScroll,
    followTail, setFollowTail,
    composing, setComposing,
    reply, setReply,
    searching, setSearching,
    searchQuery, setSearchQuery,
    searchIndex, setSearchIndex,
    filtering, setFiltering,
    filter, setFilter,
    renaming, setRenaming,
    renameText, setRenameText,
    showHelp, setShowHelp,
    sortMode, setSortMode,
    hasMarks, clearMarks, toggleMark,
    current, ordered, selectedIndex,
    searchResults, maxScroll, topNow,
    doMerge, doRestart, doArchive, doClone, doAutoImprove,
    doMergeMany, doArchiveMany, doRestartMany,
    sendReply, loadDiff,
    flash, setMessage, setSelectedId,
  });

  if (showHelp) {
    return <HelpOverlay height={size.rows} />;
  }

  if (mode === "auto-improve") {
    return (
      <AutoImproveForm
        agents={agents}
        onCancel={() => setMode("list")}
        onSelect={(agentId) => {
          setMode("list");
          void doAutoImprove(agentId);
        }}
      />
    );
  }

  if (mode === "new") {
    return (
      <NewWorkspaceForm
        agents={agents}
        onCancel={() => setMode("list")}
        onSubmit={async ({ title, prompt, agentId, count }) => {
          setMode("list");
          flash(
            count > 1
              ? `launching ${count} × ${agentId}…`
              : `launching ${agentId}…`,
          );
          const created = await manager.createWorkspaces({
            title,
            prompt,
            agentId,
            count,
          });
          // Land the cursor on the first of the batch so the user sees the
          // fan-out start streaming right away.
          if (created[0]) setSelectedId(created[0].id);
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
          sortLabel={SORT_LABELS[sortMode]}
          marks={marks}
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
          searchQuery={searchQuery}
          searchResults={searchResults}
          searchCurrentRow={searchCurrentRow}
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
        markedCount={markedIds.length}
        searching={searching}
        searchQuery={searchQuery}
      />
    </Box>
  );
}
