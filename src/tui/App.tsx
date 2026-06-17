import React, { useEffect, useMemo, useState, useCallback } from "react";
import { Box, useApp, useInput, useStdout } from "ink";
import type { WorkspaceManager } from "../core/manager.js";
import type { Workspace } from "../core/types.js";
import { WorkspaceList, sortWorkspaces } from "./components/WorkspaceList.js";
import {
  DetailPane,
  detailBodyHeight,
  detailTextWidth,
  wrappedRowCount,
} from "./components/DetailPane.js";
import { StatusBar } from "./components/StatusBar.js";
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

interface Props {
  manager: WorkspaceManager;
  agents: AgentInfo[];
  // Requests that the host (index.tsx) drop into an interactive shell in this
  // workspace's worktree. The host unmounts Ink first so the terminal is fully
  // released to the child shell, then re-renders the app when the shell exits.
  onShell: (ws: Workspace) => void;
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
  const ordered = useMemo(() => sortWorkspaces(items), [items]);
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
        await manager.merge(ws.id);
        flash(`merged ${ws.title} into ${manager.baseBranch}`);
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

      if (mode === "list" || mode === "detail") {
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
            onShell(current);
          }
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
        />
        <DetailPane
          ws={current}
          view={view}
          diff={diff}
          scroll={topNow}
          width={detailWidth}
          height={bodyHeight}
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
      />
    </Box>
  );
}
