import React, { useEffect, useState, useCallback } from "react";
import { Box, useApp, useInput, useStdout } from "ink";
import type { WorkspaceManager } from "../core/manager.js";
import type { Workspace } from "../core/types.js";
import { WorkspaceList } from "./components/WorkspaceList.js";
import { DetailPane, detailBodyHeight } from "./components/DetailPane.js";
import { StatusBar } from "./components/StatusBar.js";
import {
  NewWorkspaceForm,
  type AgentInfo,
} from "./components/NewWorkspaceForm.js";

type Mode = "list" | "detail" | "new";
type View = "output" | "diff";

interface Props {
  manager: WorkspaceManager;
  agents: AgentInfo[];
}

export function App({ manager, agents }: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [items, setItems] = useState<Workspace[]>(manager.snapshot());
  const [selected, setSelected] = useState(0);
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

  const current = items[selected];

  // Scroll geometry, shared by the key handler and the render so they agree on
  // the bounds. `bodyHeight` mirrors the value handed to the panes below.
  const bodyHeight = Math.max(8, size.rows - 4);
  const viewportRows = detailBodyHeight(bodyHeight, composing);
  const totalLines =
    view === "diff"
      ? diff
        ? diff.split("\n").length
        : 1
      : (current?.output.length ?? 1);
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
      await manager.archive(ws.id);
      flash(`archived ${ws.title}`);
      setSelected((s) => Math.max(0, s - 1));
      if (mode === "detail") setMode("list");
    },
    [manager, flash, mode],
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
        if (input === "R") {
          void doRestart(current);
          return;
        }
      }

      if (mode === "list") {
        if (key.upArrow || input === "k")
          setSelected((s) => Math.max(0, s - 1));
        else if (key.downArrow || input === "j")
          setSelected((s) => Math.min(items.length - 1, s + 1));
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
          setSelected(manager.snapshot().findIndex((w) => w.id === ws.id));
        }}
      />
    );
  }

  const listWidth = Math.min(40, Math.floor(size.cols * 0.35));
  const detailWidth = size.cols - listWidth - 2;

  return (
    <Box flexDirection="column" height={size.rows}>
      <Box flexDirection="row" height={bodyHeight}>
        <WorkspaceList
          items={items}
          selectedIndex={selected}
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
