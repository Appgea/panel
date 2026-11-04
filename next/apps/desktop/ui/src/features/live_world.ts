/**
 * Live's map, in world pixels with y growing down. This Mac, the hub, sits at the origin. The
 * GitHub tower stands above it, the owner's desk below, the board left and the web gate right.
 * Each project with an agent or a card is a round district in a fixed slot around the hub, so a
 * district keeps its place while it stays busy. Silent projects are not on the map.
 *
 * An agent stands in its district, spread like seeds in a sunflower. One that waits for the
 * owner walks to the desk. A parent with more than SWARM helpers in its district carries them
 * as a swarm of electrons instead of single dots.
 */

import type { Card } from "./live_cards";
import type { LiveAgent, LiveWorld } from "./live_types";

export type Pt = { x: number; y: number };
export type Box = { x: number; y: number; w: number; h: number };
export type Tile = { x: number; y: number; path: string; agents: string[] };
export type District = { key: string; name: string; x: number; y: number; r: number; agents: string[]; cards: number; stuck: boolean; tiles: Tile[] };
export type DotSpot = { x: number; y: number; r: number; room: string; swarm: number };
export type Landmarks = { tower: Pt; desk: Pt; board: Pt; web: Pt; sky: Pt };
export type World = {
  hub: Box & { bays: Box[] };
  landmarks: Landmarks;
  districts: District[];
  dots: Map<string, DotSpot>;
  /** The map's extent, for fitting the camera. */
  bounds: { x0: number; y0: number; x1: number; y1: number };
};

export const HUB = { w: 320, h: 118 };
/** Tight around the hub, one cluster in the middle, so the districts ring it and never sit on one. */
const LANDMARKS: Landmarks = { tower: { x: 0, y: -170 }, sky: { x: 0, y: -400 }, desk: { x: 0, y: 190 }, board: { x: -330, y: 0 }, web: { x: 330, y: 0 } };
/** Helpers beyond this many in one district become a swarm around their parent. */
export const SWARM = 6;
const TILES_PER_DISTRICT = 22;

/**
 * Slot centres around the middle cluster, nearest first: a ring of eight, then two rings of
 * twelve. Left and right fill before top and bottom, because the stage is wider than tall.
 */
const SLOTS: Pt[] = (() => {
  const ring = (rx: number, ry: number, degs: number[]) => degs.map((d) => ({ x: Math.cos((d * Math.PI) / 180) * rx, y: Math.sin((d * Math.PI) / 180) * ry }));
  const twelve = [-15, -165, 15, 165, -45, -135, 45, 135, -75, -105, 75, 105];
  return [...ring(720, 520, [-22, -158, 22, 158, -68, -112, 68, 112]), ...ring(1200, 880, twelve), ...ring(1700, 1250, twelve)];
})();

/** Core size by model tier: small electrons, a little bigger for the bigger models. */
export function radius(a: LiveAgent): number {
  const m = (a.model ?? "").toLowerCase();
  if (a.harness === "grok" || /opus|fable|grok/.test(m)) return 4.6;
  if (/haiku|flash|mini|nano|lite/.test(m)) return 3;
  return 3.8;
}

export type WorldInput = {
  world: LiveWorld;
  cards: Card[];
  roomOf(a: LiveAgent): string;
  roomName(key: string): string;
  /** Slot by district, kept by live.ts across polls so a district never jumps. */
  slots: Map<string, number>;
};

export function lay(input: WorldInput): World {
  const { world, cards, slots } = input;
  const agentsIn = new Map<string, LiveAgent[]>();
  for (const a of world.agents) push(agentsIn, input.roomOf(a), a);
  const cardsIn = new Map<string, number>();
  for (const c of cards) cardsIn.set(c.room, (cardsIn.get(c.room) ?? 0) + 1);
  const keys = [...new Set([...agentsIn.keys(), ...cardsIn.keys()])];

  // A district keeps its slot while it is on the map. A new one takes the nearest free slot.
  for (const k of [...slots.keys()]) if (!keys.includes(k)) slots.delete(k);
  const taken = new Set(slots.values());
  for (const k of keys.sort()) {
    if (slots.has(k)) continue;
    const free = SLOTS.findIndex((_, i) => !taken.has(i));
    const i = free < 0 ? SLOTS.length + slots.size : free;
    slots.set(k, i);
    taken.add(i);
  }

  const hub = { x: 0, y: 0, ...HUB, bays: [0, 1].map((i) => ({ x: -72 + i * 144, y: 26, w: 128, h: 38 })) };
  const dots = new Map<string, DotSpot>();
  const deskQueue: LiveAgent[] = [];
  const districts: District[] = keys.map((key) => {
    const slot = slots.get(key)!;
    const c = SLOTS[slot] ?? { x: Math.cos(slot) * 1800, y: Math.sin(slot) * 1200 };
    const agents = [...(agentsIn.get(key) ?? [])].sort((a, b) => (a.startedMs ?? 0) - (b.startedMs ?? 0) || a.id.localeCompare(b.id));
    // Children of one parent beyond SWARM ride with it as electrons.
    const kids = new Map<string, LiveAgent[]>();
    for (const a of agents) if (a.parent && agents.some((p) => p.id === a.parent)) push(kids, a.parent, a);
    const swarmed = new Set<string>();
    for (const list of kids.values()) if (list.length > SWARM) list.forEach((k) => swarmed.add(k.id));
    const shown = agents.filter((a) => !swarmed.has(a.id));
    const r = Math.min(130, 90 + 8 * shown.length);
    shown.forEach((a, i) => {
      const swarm = (kids.get(a.id) ?? []).filter((k) => swarmed.has(k.id)).length;
      const dr = radius(a);
      if (a.state === "turn") deskQueue.push(a);
      // A sunflower spread: even, and stable as agents come and go at the end.
      const ang = i * 2.39996;
      const rad = i === 0 && shown.length === 1 ? 0 : 26 * Math.sqrt(i + 0.6);
      dots.set(a.id, { x: c.x + Math.cos(ang) * Math.min(rad, r - 34), y: c.y - 8 + Math.sin(ang) * Math.min(rad, r - 34) * 0.8, r: dr, room: key, swarm });
    });
    for (const a of agents) {
      const p = swarmed.has(a.id) ? dots.get(a.parent!) : undefined;
      if (p) dots.set(a.id, { ...p, swarm: -1 });
    }
    // Files on the lower rim, newest first, shared tiles once.
    const files: { path: string; agents: string[] }[] = [];
    for (const a of agents)
      for (const f of [...a.steps.map((s) => s.file).filter((f): f is string => !!f), ...a.files]) {
        const have = files.find((x) => x.path === f);
        if (have) {
          if (!have.agents.includes(a.id)) have.agents.push(a.id);
        } else if (files.length < TILES_PER_DISTRICT) files.push({ path: f, agents: [a.id] });
      }
    const tiles: Tile[] = files.map((f, i) => {
      const n = Math.max(files.length, 6);
      const ang = Math.PI * (0.18 + (0.64 * (i + 0.5)) / n);
      return { x: c.x + Math.cos(ang) * (r - 14), y: c.y + Math.sin(ang) * (r - 14), ...f };
    });
    return { key, name: input.roomName(key), x: c.x, y: c.y, r, agents: agents.map((a) => a.id), cards: cardsIn.get(key) ?? 0, stuck: agents.some((a) => a.state === "stuck"), tiles };
  });
  // Agents that wait for the owner line up at the top edge of the desk.
  deskQueue.forEach((a, i) => {
    const d = dots.get(a.id)!;
    const n = deskQueue.length;
    d.x = LANDMARKS.desk.x + (i - (n - 1) / 2) * Math.min(30, 160 / n);
    d.y = LANDMARKS.desk.y - 52;
  });

  // Signs are wider than their districts: room for them at the sides and on top.
  const xs = [LANDMARKS.board.x - 110, LANDMARKS.web.x + 110, ...districts.flatMap((d) => [d.x - d.r - 70, d.x + d.r + 70])];
  const ys = [LANDMARKS.tower.y - 160, LANDMARKS.desk.y + 90, ...districts.flatMap((d) => [d.y - d.r - 60, d.y + d.r + 10])];
  return { hub, landmarks: LANDMARKS, districts, dots, bounds: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) } };
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const l = m.get(k);
  if (l) l.push(v);
  else m.set(k, [v]);
}
