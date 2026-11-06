/**
 * Live's playbook: the motions that come from an agent's life rather than its steps. What a
 * step looks like is its verb's script in the catalog (live_script.ts). What an arrival, an
 * ending, a release or a clash looks like is here.
 *
 * An entry names its trigger, what moves, what it tells you, and how often it may play. The
 * director compares two scans and plays the entries whose triggers fired.
 *
 * Blinks, glow, glides and the Hot Mac wash are states, not one-shot effects: Bevy draws them
 * from each scene. Cards for the owner are not on the map: they live in For you.
 */

import { COLOR, type FxOut } from "./live_script";
import type { EmberOutcome, LiveAgent, LiveEmber, LiveWorld, Step } from "./live_types";

export type Entry = { id: string; trigger: string; moves: string; tells: string; everyMs: number };

export const PLAYBOOK: Entry[] = [
  { id: "arrive", trigger: "a new agent appears with a parent", moves: "a beam from the parent to the new dot, or a small ring on the parent when the helper rides on it", tells: "who started whom", everyMs: 0 },
  { id: "appear", trigger: "a new agent appears on its own", moves: "a ring opens around the new dot", tells: "someone started an agent here", everyMs: 0 },
  { id: "done", trigger: "an agent ends done", moves: "green sparks and a green ring where it stood", tells: "it finished; its report is under Ended", everyMs: 0 },
  { id: "failed", trigger: "an agent ends failed, crashed or stuck", moves: "red sparks where it stood", tells: "it did not finish; read its report", everyMs: 0 },
  { id: "shipped", trigger: "an issue of this district closes on the board", moves: "a wide green ring opens around the district", tells: "work for this project went out", everyMs: 60_000 },
  { id: "clash", trigger: "two running agents have written the same file", moves: "a red beam between their dots", tells: "they may overwrite each other's work", everyMs: 60_000 },
  { id: "hot", trigger: "macOS slows the CPU for heat", moves: "This Mac warms to amber until it cools", tells: "the Mac is too busy; fewer builds at once", everyMs: 0 },
  { id: "result", trigger: "a test, build, push or other checked step ends", moves: "✓ and a green ring, or ✗ and red sparks, with the result in the agent's bubble", tells: "whether it worked, which no script can know while the step runs", everyMs: 0 },
];

/**
 * The steps whose ending is news, and how to say it: [passed, failed]. A failed `grep` or `ls`
 * is how agents look around, so only these get a ✓ or ✗.
 */
export const RESULTS: Record<string, [string, string]> = {
  test: ["Tests passed", "Tests failed"],
  typecheck: ["Typecheck passed", "Typecheck failed"],
  build: ["Built", "Build failed"],
  "git.commit": ["Committed", "Commit failed"],
  "git.push": ["Pushed", "Push failed"],
  "git.pull": ["Pulled", "Pull failed"],
  release: ["Released", "Release failed"],
  review: ["Review passed", "Review found problems"],
  render: ["Rendered", "Render failed"],
  shot: ["Screenshots taken", "Screenshots failed"],
};
/** A pass is news for a short while. A failure stays until the owner has had time to see it. */
export const RESULT_MS = { ok: 12_000, failed: 60_000 };

/** The verbs each landmark stands for: what makes GitHub or the web light up and name its news. */
export const LANDMARK_VERBS = {
  tower: new Set(["git.push", "git.pull", "release", "board"]),
  web: new Set(["web", "mcp.claude-in-chrome", "mcp.playwright", "mcp.slack"]),
};
/** A landmark with no news for this long dims, so the map's light goes where work is. */
export const LANDMARK_QUIET_MS = 10 * 60_000;

export type News = { at: number; label: string; agent?: LiveAgent; ember?: LiveEmber };

/** The newest step at each landmark, from running and ended agents. Null when there is none. */
export function landmarkNews(world: LiveWorld): { tower: News | null; web: News | null } {
  const newest = (verbs: Set<string>): News | null => {
    let best: News | null = null;
    const look = (steps: Step[], who: Pick<News, "agent" | "ember">) => {
      for (const st of steps) if (st.verb && verbs.has(st.verb) && (!best || st.atMs > best.at)) best = { at: st.atMs, label: st.label, ...who };
    };
    for (const a of world.agents) look(a.steps, { agent: a });
    for (const e of world.embers) look(e.steps, { ember: e });
    return best;
  };
  return { tower: newest(LANDMARK_VERBS.tower), web: newest(LANDMARK_VERBS.web) };
}

const BY_ID = new Map(PLAYBOOK.map((e) => [e.id, e]));
/** More than this at once is noise: the rest waits for the next scan. */
const MAX_PER_SCAN = 10;

export type Spot = { x: number; y: number; r: number };
export type Seen = {
  dots: Map<string, Spot & { parent: string | null; files: string[] }>;
  districts: Map<string, Spot>;
  /** Closed board issues, by number, with their district. */
  closed: Map<number, string>;
};
export type EmberEnd = { id: string; agentId: string; outcome: EmberOutcome };

/**
 * The effects that the change from `before` to `after` calls for. `played` remembers when each
 * entry last played per agent, district or pair, for the caps. A first scan plays nothing: a
 * world that was already running did not just begin.
 */
export function direct(before: Seen | null, after: Seen, endings: EmberEnd[], results: { agentId: string; ok: boolean }[], played: Map<string, number>, now: number): FxOut[] {
  if (!before) return [];
  const out: FxOut[] = [];
  const may = (entry: string, who: string): boolean => {
    const e = BY_ID.get(entry)!;
    const key = `${entry}:${who}`;
    if (e.everyMs && now - (played.get(key) ?? -Infinity) < e.everyMs) return false;
    played.set(key, now);
    return true;
  };
  for (const [id, d] of after.dots) {
    if (before.dots.has(id)) continue;
    const parent = d.parent ? after.dots.get(d.parent) : undefined;
    if (parent && parent.x === d.x && parent.y === d.y) out.push({ kind: "ring", x: d.x, y: d.y, color: COLOR.ink, size: 30, ms: 900 });
    else if (parent) out.push({ kind: "beam", x: parent.x, y: parent.y, x2: d.x, y2: d.y, color: COLOR.ink, ms: 1400 });
    else out.push({ kind: "ring", x: d.x, y: d.y, color: COLOR.work, size: 40, ms: 1100 });
  }
  for (const end of endings) {
    const last = before.dots.get(end.agentId);
    if (!last || after.dots.has(end.agentId) || end.outcome === "stopped") continue;
    const color = end.outcome === "done" ? COLOR.done : COLOR.stuck;
    out.push({ kind: "burst", x: last.x, y: last.y, color, count: 16, size: 30 });
    if (end.outcome === "done") out.push({ kind: "ring", x: last.x, y: last.y, color, size: 46, ms: 1100 });
  }
  // The first board read lists every recent close at once. Only closes after it are news.
  for (const [number, key] of before.closed.size ? after.closed : []) {
    if (before.closed.has(number)) continue;
    const d = after.districts.get(key);
    if (d && may("shipped", key)) out.push({ kind: "ring", x: d.x, y: d.y, color: COLOR.done, size: d.r * 2.6, ms: 1700 });
  }
  for (const r of results) {
    const d = after.dots.get(r.agentId);
    if (!d) continue;
    if (r.ok) out.push({ kind: "ring", x: d.x, y: d.y, color: COLOR.done, size: 34, ms: 1000 });
    else out.push({ kind: "burst", x: d.x, y: d.y, color: COLOR.stuck, count: 12, size: 24 });
  }
  // Clash: any file two running agents both wrote. One beam per pair, at most once a minute.
  const ids = [...after.dots.keys()].sort();
  for (let i = 0; i < ids.length; i++) {
    const a = after.dots.get(ids[i])!;
    if (!a.files.length) continue;
    const mine = new Set(a.files);
    for (let j = i + 1; j < ids.length; j++) {
      const b = after.dots.get(ids[j])!;
      if (b.files.some((f) => mine.has(f)) && may("clash", `${ids[i]}|${ids[j]}`)) out.push({ kind: "beam", x: a.x, y: a.y, x2: b.x, y2: b.y, color: COLOR.stuck, ms: 1500 });
    }
  }
  return out.slice(0, MAX_PER_SCAN);
}
