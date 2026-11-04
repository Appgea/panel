/**
 * Live's playbook: every motion on the stage, and what it tells the owner.
 *
 * An entry names its trigger, what moves, what it tells you, how long it lasts and how often it
 * may play. An entry that cannot say what it tells you does not ship. The director compares two
 * scans and plays the entries whose triggers fired. Plain rules, no AI: an unknown kind of event
 * plays nothing until it has an entry.
 *
 * Blinks, glow, glides and the Hot Mac wash are states, not one-shot effects: Bevy draws them
 * from each scene. Flights along a card's thread start in live_queue.ts, where cards arrive and
 * answers leave. Their entries are here so the whole list reads in one place.
 */

import type { EmberOutcome } from "./live_types";

/** What Bevy plays (apps/live/src/fx.rs). `flight` and `state` entries send no effect. */
export type FxKind = "pulse" | "beam" | "done" | "cut" | "ship" | "shipped" | "clash" | "flight" | "state";

export type Entry = {
  id: string;
  trigger: string;
  moves: string;
  tells: string;
  fx: FxKind;
  ms: number;
  /** At most once per this many ms for the same agent, room or pair. */
  everyMs: number;
};

export const PLAYBOOK: Entry[] = [
  { id: "arrive", trigger: "a new agent appears with a parent", moves: "a beam from the parent to the new dot, with a light along it", tells: "who started whom", fx: "beam", ms: 2400, everyMs: 0 },
  { id: "appear", trigger: "a new agent appears on its own", moves: "one soft pulse around the new dot", tells: "someone started an agent here", fx: "pulse", ms: 900, everyMs: 0 },
  { id: "step", trigger: "an agent starts a new step", moves: "one soft pulse around its dot", tells: "it is moving, not stuck", fx: "pulse", ms: 900, everyMs: 6000 },
  { id: "ship", trigger: "an agent starts a commit, push, release or publish", moves: "one green pulse around its dot", tells: "work is going out", fx: "ship", ms: 900, everyMs: 30_000 },
  { id: "shipped", trigger: "an issue of this room closes on the board", moves: "a green ring of light opens around the room", tells: "work for this project went out", fx: "shipped", ms: 1600, everyMs: 60_000 },
  { id: "done", trigger: "an agent ends done", moves: "green sparks burst, then an ember on the shelf", tells: "it finished, and its report waits on the shelf", fx: "done", ms: 1100, everyMs: 0 },
  { id: "failed", trigger: "an agent ends failed, crashed or stuck", moves: "red sparks and a red flicker, then a red ember", tells: "it did not finish; read its report", fx: "cut", ms: 1100, everyMs: 0 },
  { id: "clash", trigger: "two running agents have written the same file", moves: "a red line between their dots", tells: "they may overwrite each other's work", fx: "clash", ms: 1500, everyMs: 60_000 },
  { id: "card", trigger: "a new card for you comes from a room", moves: "an amber light flies down the thread into your ring", tells: "something new waits for you", fx: "flight", ms: 1100, everyMs: 0 },
  { id: "answer", trigger: "you answer a card or talk about it", moves: "a light flies from your ring back up the thread to the room", tells: "your answer reached them", fx: "flight", ms: 1100, everyMs: 0 },
  { id: "hot", trigger: "macOS slows the CPU for heat", moves: "This Mac's base warms to amber until it cools", tells: "the Mac is too busy; fewer builds at once", fx: "state", ms: 0, everyMs: 0 },
];

const BY_ID = new Map(PLAYBOOK.map((e) => [e.id, e]));
/** More than this at once is noise: the oldest triggers wait for the next scan. */
const MAX_PER_SCAN = 10;

export type Spot = { x: number; y: number; r: number };
export type RoomBox = { x: number; y: number; w: number; h: number };
export type Seen = {
  dots: Map<string, Spot & { steps: number; station: string; parent: string | null; nowLabel: string | null; files: string[] }>;
  embers: Set<string>;
  cards: Map<string, string>;
  rooms: Map<string, RoomBox>;
  /** Closed board issues, by number, with their room. */
  closed: Map<number, string>;
};
export type EmberEnd = { id: string; agentId: string; outcome: EmberOutcome };
export type Play = { entry: string; kind: Exclude<FxKind, "flight" | "state">; x: number; y: number; x2?: number; y2?: number; r?: number };

/**
 * The effects that the change from `before` to `after` calls for. `played` remembers when each
 * entry last played per agent, room or pair, for the caps. A first scan plays nothing: a world
 * that was already running did not just begin.
 */
export function direct(before: Seen | null, after: Seen, endings: EmberEnd[], played: Map<string, number>, now: number): Play[] {
  if (!before) return [];
  const out: Play[] = [];
  const may = (entry: string, who: string): boolean => {
    const e = BY_ID.get(entry)!;
    const key = `${entry}:${who}`;
    if (e.everyMs && now - (played.get(key) ?? -Infinity) < e.everyMs) return false;
    played.set(key, now);
    return true;
  };
  for (const [id, d] of after.dots) {
    const was = before.dots.get(id);
    if (!was) {
      const parent = d.parent ? after.dots.get(d.parent) : undefined;
      if (parent) out.push({ entry: "arrive", kind: "beam", x: parent.x, y: parent.y, x2: d.x, y2: d.y });
      else out.push({ entry: "appear", kind: "pulse", x: d.x, y: d.y, r: d.r });
      continue;
    }
    if (d.steps > was.steps) {
      if (d.station === "ship" && may("ship", id)) out.push({ entry: "ship", kind: "ship", x: d.x, y: d.y, r: d.r });
      else if (may("step", id)) out.push({ entry: "step", kind: "pulse", x: d.x, y: d.y, r: d.r });
    }
  }
  for (const end of endings) {
    const last = before.dots.get(end.agentId);
    if (!last || after.dots.has(end.agentId)) continue;
    if (end.outcome === "done") out.push({ entry: "done", kind: "done", x: last.x, y: last.y, r: last.r });
    else if (end.outcome !== "stopped") out.push({ entry: "failed", kind: "cut", x: last.x, y: last.y, r: last.r });
  }
  // The first board read lists every recent close at once. Only closes after it are news.
  for (const [number, room] of before.closed.size ? after.closed : []) {
    if (before.closed.has(number)) continue;
    const box = after.rooms.get(room);
    if (box && may("shipped", room)) out.push({ entry: "shipped", kind: "shipped", x: box.x, y: box.y, x2: box.x + box.w, y2: box.y + box.h });
  }
  // Clash: any file two running agents both wrote. One line per pair, at most once a minute.
  const ids = [...after.dots.keys()].sort();
  for (let i = 0; i < ids.length; i++) {
    const a = after.dots.get(ids[i])!;
    if (!a.files.length) continue;
    const mine = new Set(a.files);
    for (let j = i + 1; j < ids.length; j++) {
      const b = after.dots.get(ids[j])!;
      if (b.files.some((f) => mine.has(f)) && may("clash", `${ids[i]}|${ids[j]}`)) out.push({ entry: "clash", kind: "clash", x: a.x, y: a.y, x2: b.x, y2: b.y });
    }
  }
  return out.slice(0, MAX_PER_SCAN);
}
