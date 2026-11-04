/**
 * Live's playbook: every motion on the stage, and what it tells the owner.
 *
 * An entry names its trigger, what moves, what it tells you, how long it lasts and how often it
 * may play. An entry that cannot say what it tells you does not ship. The director compares two
 * scans and plays the entries whose triggers fired. Plain rules, no AI: an unknown kind of event
 * plays nothing until it has an entry.
 *
 * Blinks, glow and station moves are states, not entries: Bevy and the layout draw them from
 * each scan. This file holds only the one-shot effects.
 */

export type FxKind = "pulse" | "beam" | "done" | "cut" | "ship" | "card";

export type Entry = {
  id: string;
  trigger: string;
  moves: string;
  tells: string;
  fx: FxKind;
  ms: number;
  /** At most once per this many ms for the same agent or room. */
  everyMs: number;
};

export const PLAYBOOK: Entry[] = [
  { id: "arrive", trigger: "a new agent appears with a parent", moves: "a light runs from the parent to the new dot", tells: "who started whom", fx: "beam", ms: 1000, everyMs: 0 },
  { id: "appear", trigger: "a new agent appears on its own", moves: "one ring opens around the new dot", tells: "someone started an agent here", fx: "pulse", ms: 700, everyMs: 0 },
  { id: "step", trigger: "an agent starts a new step", moves: "one soft ring around its dot", tells: "it is moving, not stuck", fx: "pulse", ms: 700, everyMs: 6000 },
  { id: "ship", trigger: "an agent starts a commit, push, release or publish", moves: "a wide green ring around its dot", tells: "work is going out", fx: "ship", ms: 1400, everyMs: 30_000 },
  { id: "done", trigger: "an agent ends after its last word", moves: "a green flash, then an ember on the shelf", tells: "it finished, and its report waits on the shelf", fx: "done", ms: 1000, everyMs: 0 },
  { id: "cut", trigger: "an agent ends in the middle of a step", moves: "a red flicker, then a red ember", tells: "it was killed or crashed; read its report", fx: "cut", ms: 1000, everyMs: 0 },
  { id: "card", trigger: "a new card for you comes from a room", moves: "an amber ring at the room's sign", tells: "something new waits for you here", fx: "card", ms: 700, everyMs: 60_000 },
];

const BY_ID = new Map(PLAYBOOK.map((e) => [e.id, e]));
/** More than this at once is noise: the oldest triggers wait for the next scan. */
const MAX_PER_SCAN = 10;

export type Spot = { x: number; y: number; r: number };
export type Seen = {
  dots: Map<string, Spot & { steps: number; station: string; parent: string | null; nowLabel: string | null }>;
  embers: Set<string>;
  cards: Map<string, string>;
  rooms: Map<string, Spot>;
};
export type EmberEnd = { id: string; agentId: string; cut: boolean };
export type Play = { entry: string; kind: FxKind; x: number; y: number; x2?: number; y2?: number; r?: number };

/**
 * The effects that the change from `before` to `after` calls for. `played` remembers when each
 * entry last played per agent or room, for the caps. A first scan plays nothing: a world that
 * was already running did not just begin.
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
    out.push(end.cut ? { entry: "cut", kind: "cut", x: last.x, y: last.y, r: last.r } : { entry: "done", kind: "done", x: last.x, y: last.y, r: last.r });
  }
  for (const [id, room] of after.cards) {
    if (before.cards.has(id)) continue;
    const spot = after.rooms.get(room);
    if (spot && may("card", room)) out.push({ entry: "card", kind: "card", x: spot.x, y: spot.y, r: 6 });
  }
  return out.slice(0, MAX_PER_SCAN);
}
