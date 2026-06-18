import React from "react";
import { useInput, useApp } from "ink";
import type { WorkspaceManager } from "../core/manager.js";
import type { SortMode, Workspace } from "../core/types.js";
import type { AutoImproveFocus } from "../core/prompt.js";
import { SORT_LABELS } from "./components/WorkspaceList.js";

const SKILL_PROMPT =
  "Create a skill that captures the feature you just built in this " +
  "workspace. Review the changes on this worktree (diff against the base branch) " +
  "to ground it, then write a skill definition with the appropriate format for " +
  "your runtime: YAML frontmatter (a kebab-case `name` and a one-line " +
  "`description` of when to use it) plus concise instructions covering what " +
  "the feature does, how to use it, and when to apply it.";

export interface HandlerState {
  manager: WorkspaceManager;
  agents: Array<{ id: string; displayName: string }>;
  onShell: (ws: Workspace) => string | void;

  mode: "list" | "detail" | "new" | "auto-improve";
  setMode: (m: "list" | "detail" | "new" | "auto-improve") => void;
  view: "output" | "diff";
  setView: (v: "output" | "diff") => void;
  scroll: number;
  setScroll: (s: number) => void;
  followTail: boolean;
  setFollowTail: (f: boolean) => void;
  composing: boolean;
  setComposing: (c: boolean) => void;
  answering: boolean;
  setAnswering: (a: boolean) => void;
  broadcasting: boolean;
  setBroadcasting: (b: boolean) => void;
  reply: string;
  setReply: (r: string) => void;
  searching: boolean;
  setSearching: (s: boolean) => void;
  searchQuery: string;
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
  searchIndex: number;
  setSearchIndex: (i: number) => void;
  filtering: boolean;
  setFiltering: (f: boolean) => void;
  filter: string;
  setFilter: React.Dispatch<React.SetStateAction<string>>;
  renaming: boolean;
  setRenaming: (r: boolean) => void;
  renameText: string;
  setRenameText: React.Dispatch<React.SetStateAction<string>>;
  showHelp: boolean;
  setShowHelp: (s: boolean) => void;
  confirming: { label: string; action: () => void } | null;
  setConfirming: (c: { label: string; action: () => void } | null) => void;
  sortMode: SortMode;
  setSortMode: (m: SortMode) => void;
  hasMarks: boolean;
  markedIds: string[];
  setMarkedIds: (ids: string[]) => void;
  clearMarks: () => void;
  toggleMark: (id: string) => void;

  current: Workspace | undefined;
  ordered: Workspace[];
  selectedIndex: number;
  searchResults: number[];
  maxScroll: number;
  topNow: number;
  diffFileIndex: number;
  setDiffFileIndex: (i: number) => void;
  diffFiles: Array<{ path: string; content: string }>;

  switchWorkspace: (direction: 1 | -1) => void;
  doMerge: (ws: Workspace | undefined) => void;
  doPushPr: (ws: Workspace | undefined) => void;
  doRestart: (ws: Workspace | undefined) => void;
  doArchive: (ws: Workspace | undefined) => void;
  doClone: (ws: Workspace | undefined) => void;
  doAutoImprove: (agentId?: string, focus?: AutoImproveFocus, count?: number) => void;
  doMergeMany: () => void;
  doArchiveMany: () => void;
  doRestartMany: () => void;
  doStopAllRunning: () => void;
  doArchiveAllMerged: () => void;
  doRestartAllStopped: () => void;
  doBroadcast: (text: string) => void;
  sendReply: (ws: Workspace | undefined, text: string) => void;
  loadDiff: (ws: Workspace | undefined) => void;
  flash: (msg: string) => void;
  setMessage: (m: string | undefined) => void;
  setSelectedId: (id: string | undefined) => void;
}

export function useConductKeys(s: HandlerState): void {
  const { exit } = useApp();
  // While the question picker is open it owns the keyboard (see QuestionPrompt),
  // just like the reply box does while composing. Only yield the keyboard when
  // there's actually a question mounted, so a stale `answering` flag (its
  // question vanished) can't leave the main handler dead until the effect that
  // resets it runs.
  const pickerOpen = s.answering && !!s.current?.pendingQuestion;
  const isActive =
    s.mode !== "new" &&
    s.mode !== "auto-improve" &&
    !s.composing &&
    !pickerOpen;

  useInput(
    (input, key) => {
      s.setMessage(undefined);

      if (s.confirming) {
        if (input === "y" || input === "Y") {
          const action = s.confirming.action;
          s.setConfirming(null);
          action();
        } else if (input === "n" || input === "N" || key.escape) {
          s.setConfirming(null);
        }
        return;
      }

      if (s.showHelp) {
        s.setShowHelp(false);
        return;
      }

      if (s.renaming) {
        handleRename(input, key, s);
        return;
      }

      if (s.filtering) {
        handleFilter(input, key, s);
        return;
      }

      if (s.searching) {
        handleSearch(input, key, s);
        return;
      }

      if (s.mode === "list" || s.mode === "detail") {
        if (s.current?.pendingPermission) {
          if (input === "y" || input === "n") {
            const allow = input === "y";
            const tool = s.current.pendingPermission.toolName;
            if (s.manager.respondPermission(s.current.id, allow)) {
              s.flash(`${allow ? "allowed" : "denied"} ${tool}`);
            }
            return;
          }
        }
        // A structured question takes priority over the plain reply box: `i`
        // opens the option picker (in detail view) instead of the text field.
        if (input === "i" && s.current?.pendingQuestion) {
          if (!s.manager.acceptsInput(s.current.id)) {
            s.flash("agent is not running / not interactive");
            return;
          }
          s.setMode("detail");
          s.setView("output");
          s.setAnswering(true);
          return;
        }
        if (key.ctrl && input === "a") {
          s.setMarkedIds(s.ordered.map((w) => w.id));
          s.flash(`marked all ${s.ordered.length} workspace${s.ordered.length === 1 ? "" : "s"}`);
          return;
        }
        if (key.escape && s.hasMarks) {
          s.clearMarks();
          return;
        }
        if (input === "q" || (key.ctrl && input === "c")) {
          s.manager.shutdown();
          exit();
          return;
        }
        if (input === "n") {
          s.setMode("new");
          return;
        }
        if (input === " " && s.current) {
          s.toggleMark(s.current.id);
          return;
        }
        if (input === "m") {
          if (s.hasMarks) s.doMergeMany();
          else s.doMerge(s.current);
          return;
        }
        // Capital P (lowercase `p` is "previous match" in detail search) pushes
        // the selected workspace's branch and opens a pull request. Single
        // workspace only — a PR is inherently per-branch.
        if (input === "P") {
          s.doPushPr(s.current);
          return;
        }
        if (input === "s") {
          if (s.current) {
            s.manager.stop(s.current.id);
            s.flash(`stopping ${s.current.title}`);
          }
          return;
        }
        if (key.meta && input === "a") {
          s.doArchiveAllMerged();
          return;
        }
        if (key.meta && input === "s") {
          s.doStopAllRunning();
          return;
        }
        if (key.meta && input === "r") {
          s.doRestartAllStopped();
          return;
        }
        if (input === "x") {
          if (s.hasMarks) s.doArchiveMany();
          else s.doArchive(s.current);
          return;
        }
        if (input === "S") {
          if (!s.current) return;
          if (s.manager.sendInput(s.current.id, SKILL_PROMPT)) {
            s.flash(`asked ${s.current.title} to build a skill`);
          } else {
            s.flash("agent is not running / not interactive");
          }
          return;
        }
        if (input === "R") {
          if (s.hasMarks) s.doRestartMany();
          else s.doRestart(s.current);
          return;
        }
        if (input === "c") {
          if (!s.current?.path) {
            s.flash("no worktree to jump into yet");
          } else if (s.current.status === "archived") {
            s.flash("worktree was removed (archived)");
          } else {
            const msg = s.onShell(s.current);
            if (msg) s.flash(msg);
          }
          return;
        }
        if (input === "e") {
          if (s.current) {
            s.setRenameText(s.current.title);
            s.setRenaming(true);
          } else {
            s.flash("no workspace to rename");
          }
          return;
        }
        if (input === "C") {
          s.doClone(s.current);
          return;
        }
        if (input === "A") {
          s.setMode("auto-improve");
          return;
        }
        if (input === "?") {
          s.setShowHelp(true);
          return;
        }
      }

      if (s.mode === "list") {
        handleListMode(input, key, s);
        return;
      }

      if (s.mode === "detail") {
        handleDetailMode(input, key, s);
        return;
      }
    },
    { isActive },
  );
}

function handleRename(
  input: string,
  key: { escape?: boolean; return?: boolean; backspace?: boolean; delete?: boolean; ctrl?: boolean; meta?: boolean },
  s: HandlerState,
): void {
  if (key.escape) {
    s.setRenaming(false);
    s.setRenameText("");
  } else if (key.return) {
    if (s.current && s.manager.renameWorkspace(s.current.id, s.renameText)) {
      s.flash(`renamed to ${s.renameText.trim()}`);
    }
    s.setRenaming(false);
    s.setRenameText("");
  } else if (key.backspace || key.delete) {
    s.setRenameText((t) => t.slice(0, -1));
  } else if (input && !key.ctrl && !key.meta) {
    s.setRenameText((t) => t + input);
  }
}

function handleFilter(
  input: string,
  key: { escape?: boolean; return?: boolean; backspace?: boolean; delete?: boolean; ctrl?: boolean; meta?: boolean },
  s: HandlerState,
): void {
  if (key.escape) {
    s.setFiltering(false);
    s.setFilter("");
  } else if (key.return) {
    s.setFiltering(false);
  } else if (key.backspace || key.delete) {
    s.setFilter((f) => f.slice(0, -1));
  } else if (input && !key.ctrl && !key.meta) {
    s.setFilter((f) => f + input);
  }
}

function handleSearch(
  input: string,
  key: { escape?: boolean; return?: boolean; backspace?: boolean; delete?: boolean; ctrl?: boolean; meta?: boolean },
  s: HandlerState,
): void {
  if (key.escape) {
    s.setSearching(false);
    s.setSearchQuery("");
  } else if (key.return) {
    s.setSearching(false);
    if (s.searchResults.length > 0) {
      s.setSearchIndex(0);
      s.setScroll(s.searchResults[0]);
    }
  } else if (key.backspace || key.delete) {
    s.setSearchQuery((q) => q.slice(0, -1));
  } else if (input && !key.ctrl && !key.meta) {
    s.setSearchQuery((q) => q + input);
  }
}

function handleListMode(
  input: string,
  key: { upArrow?: boolean; downArrow?: boolean; return?: boolean; tab?: boolean },
  s: HandlerState,
): void {
  if (input === "g")
    s.setSelectedId(s.ordered[0]?.id);
  else if (input === "G")
    s.setSelectedId(s.ordered[s.ordered.length - 1]?.id);
  else if (key.upArrow || input === "k")
    s.setSelectedId(s.ordered[Math.max(0, s.selectedIndex - 1)]?.id);
  else if (key.downArrow || input === "j")
    s.setSelectedId(
      s.ordered[Math.min(s.ordered.length - 1, s.selectedIndex + 1)]?.id,
    );
  else if (key.return) {
    s.setMode("detail");
    s.setView("output");
    s.setFollowTail(true);
  } else if (input === "d") {
    s.setMode("detail");
    s.setView("diff");
    s.loadDiff(s.current);
  } else if (input === "/") {
    s.setFiltering(true);
  } else if (input === "i") {
    // Broadcast a follow-up to the whole marked set at once. Only meaningful
    // with marks (single-workspace replies happen with `i` in detail view), and
    // only worth opening the box if at least one marked agent can take input.
    if (!s.hasMarks) {
      s.flash("mark workspaces with Space, then i to broadcast a message");
      return;
    }
    const ready = s.markedIds.filter((id) => s.manager.acceptsInput(id)).length;
    if (ready === 0) {
      s.flash("no marked agents are running / interactive");
      return;
    }
    s.setView("output");
    s.setReply("");
    s.setBroadcasting(true);
    s.setComposing(true);
  } else if (key.tab) {
    const cycle: SortMode[] = ["group", "alpha", "newest", "oldest"];
    const idx = cycle.indexOf(s.sortMode);
    const next = cycle[(idx + 1) % cycle.length];
    s.setSortMode(next);
    s.flash(`sort: ${SORT_LABELS[next]}`);
    return;
  }
}

function handleDetailMode(
  input: string,
  key: {
    escape?: boolean;
    upArrow?: boolean;
    downArrow?: boolean;
    pageUp?: boolean;
    pageDown?: boolean;
    return?: boolean;
    tab?: boolean;
    shift?: boolean;
  },
  s: HandlerState,
): void {
  if (s.searchResults.length > 0) {
    if (input === "n") {
      const next = (s.searchIndex + 1) % s.searchResults.length;
      s.setSearchIndex(next);
      s.setScroll(s.searchResults[next]);
      return;
    }
    if (input === "N" || input === "p") {
      const prev =
        (s.searchIndex - 1 + s.searchResults.length) % s.searchResults.length;
      s.setSearchIndex(prev);
      s.setScroll(s.searchResults[prev]);
      return;
    }
  }
  if (key.escape) {
    s.setMode("list");
    return;
  }
  if (key.tab) {
    s.switchWorkspace(key.shift ? -1 : 1);
    return;
  }
  if (input === "/") {
    s.setSearchQuery("");
    s.setSearching(true);
    return;
  }
  if (input === "i") {
    if (s.manager.acceptsInput(s.current?.id ?? "")) {
      s.setView("output");
      s.setReply("");
      s.setComposing(true);
    } else {
      s.flash("agent is not running / not interactive");
    }
    return;
  }
  if (input === "o" || key.return) {
    s.setView("output");
    s.setFollowTail(true);
    return;
  }
  if (input === "d") {
    s.setView("diff");
    s.loadDiff(s.current);
    return;
  }
  if (input === "r" && s.view === "diff") {
    s.loadDiff(s.current);
    return;
  }
  if (s.view === "diff" && s.diffFiles.length > 1) {
    if (input === "[" || input === "{") {
      s.setDiffFileIndex(Math.max(0, s.diffFileIndex - 1));
      s.setScroll(0);
      return;
    }
    if (input === "]" || input === "}") {
      s.setDiffFileIndex(
        Math.min(s.diffFiles.length - 1, s.diffFileIndex + 1),
      );
      s.setScroll(0);
      return;
    }
  }
  if (input === "g") {
    s.setScroll(0);
    s.setFollowTail(false);
    return;
  }
  if (input === "G") {
    s.setScroll(s.maxScroll);
    if (s.view === "output") s.setFollowTail(true);
    return;
  }
  let next: number | undefined;
  if (key.upArrow || input === "k") next = s.topNow - 1;
  else if (key.downArrow || input === "j") next = s.topNow + 1;
  else if (key.pageUp) next = s.topNow - 10;
  else if (key.pageDown) next = s.topNow + 10;
  if (next !== undefined) {
    const clamped = Math.max(0, Math.min(s.maxScroll, next));
    s.setScroll(clamped);
    if (s.view === "output") s.setFollowTail(clamped >= s.maxScroll);
  }
}
