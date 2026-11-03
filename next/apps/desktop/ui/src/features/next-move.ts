/**
 * The next move for one project: the dashboard's first sentence and the sidebar row's second line.
 *
 * One rule, two surfaces. The dashboard prints the long form under NEXT MOVE. The rail prints
 * `short`, so a row and the screen it opens never disagree about what is waiting.
 */

import type { GitState } from "../types";
import type { Door } from "./dashboard";

export type Tone = "mute" | "ok" | "warn" | "risk" | "live";

export type MoveInput = {
  exists: boolean;
  /** Handoff files waiting for a decision, and the first one's reason. */
  work: number;
  why?: string | null;
  running: boolean;
  /** Null while the snapshot has not arrived. Treated as nothing to say. */
  git: GitState | null;
};

export type NextMove = {
  title: string;
  detail: string;
  /** A few words for the sidebar row. Empty when nothing is waiting. */
  short: string;
  action: string;
  door: Door | null;
  mood: Tone;
  verdict: string;
  verdictMood: Tone;
};

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function nextMove({ exists, work, why, running, git }: MoveInput): NextMove {
  const repo = Boolean(git?.is_repo);
  const move: NextMove = {
    title: "Ready for the next task",
    detail: repo
      ? "No human decisions or repository drift are waiting."
      : "No human decision is waiting in this folder.",
    short: "",
    action: "",
    door: null,
    mood: "ok",
    verdict: "at rest",
    verdictMood: "ok",
  };
  if (!exists) {
    return {
      ...move,
      title: "Restore this project folder",
      detail: "The saved path no longer exists, so Panel cannot open tools or start an agent.",
      short: "folder missing",
      mood: "risk",
      verdict: "missing",
      verdictMood: "risk",
    };
  }
  if (work > 0) {
    return {
      ...move,
      title: `${plural(work, "decision", "decisions")} waiting for you`,
      detail: why?.trim() || "Review the agent's handoff before continuing.",
      short: plural(work, "decision", "decisions") + " waiting",
      action: "Review work",
      door: "files",
      mood: "warn",
      verdict: "needs you",
      verdictMood: "warn",
    };
  }
  if (running) {
    return {
      ...move,
      title: "The agent is working",
      detail: "Follow the live workshop below; anything needing a decision will appear here.",
      short: "agent working",
      mood: "live",
      verdict: "agent live",
      verdictMood: "live",
    };
  }
  if (git && repo && git.behind > 0) {
    return {
      ...move,
      title: "Sync before starting new work",
      detail: `${plural(git.behind, "remote commit", "remote commits")} waiting to be pulled.`,
      short: `pull ${plural(git.behind, "commit", "commits")}`,
      action: "Open Git",
      door: "git",
      mood: "warn",
      verdict: "needs you",
      verdictMood: "warn",
    };
  }
  if (git && repo && git.dirty > 0) {
    // Sessions share one checkout and the lead model commits in batches (ops `wip`, `land`), so a full
    // tree is the normal state, never a call for the owner. Owner, 2026-11-03.
    return {
      ...move,
      title: "Work in progress",
      detail: `${plural(git.dirty, "changed file", "changed files")}. Sessions commit them in batches.`,
      short: `${plural(git.dirty, "file", "files")} in progress`,
      action: "Review changes",
      door: "git",
      mood: "mute",
      verdict: "in progress",
      verdictMood: "mute",
    };
  }
  if (git && repo && git.ahead > 0) {
    return {
      ...move,
      title: "Changes are ready to push",
      detail: `${plural(git.ahead, "local commit", "local commits")} ahead of the remote.`,
      short: `push ${plural(git.ahead, "commit", "commits")}`,
      action: "Open Git",
      door: "git",
      mood: "mute",
      verdict: "ready",
      verdictMood: "mute",
    };
  }
  if (git && !repo) return { ...move, verdict: "idle", verdictMood: "mute" };
  return move;
}
