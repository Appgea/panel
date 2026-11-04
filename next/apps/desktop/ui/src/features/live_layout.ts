/**
 * Live's building, in stage CSS pixels. Copied from `layout()` in the concept page
 * (~/.appgeapanel/state/panel-live/concept.html, line 799).
 *
 * Eight rooms in portfolio order, four to a row on a wide stage. Below them the Quiet row, then
 * This Mac as the base with its two test bays, then the owner's ring with the card beside it.
 * Rooms keep their places: a room only changes when a quiet project gets an agent and takes the
 * place of a calmer one. Dots stand on one of four station pads and glide between them (Bevy).
 */

import type { Card } from "./live_cards";
import type { LiveAgent, LiveEmber, LiveWorld, Station } from "./live_types";

export type Pt = { x: number; y: number };
export type Box = Pt & { w: number; h: number };

export type RoomSpot = Box & {
  key: string;
  name: string;
  /** Plan, Build, Check and Ship, in that order. */
  pads: Pt[];
  /** The line the embers stand on. */
  shelfY: number;
  agents: LiveAgent[];
  embers: LiveEmber[];
  /** Embers that fit on the shelf, newest at the left. */
  emberSpots: (Pt & { ember: LiveEmber })[];
};

/** A quiet project, or the "+N more" pill when `key` is null. */
export type QuietPill = Box & { key: string | null; name: string };

export type DotSpot = Pt & { r: number; room: string; station: Station };

export type Layout = {
  w: number;
  h: number;
  phone: boolean;
  wide: boolean;
  pad: number;
  /** Pads and the spread of dots around them shrink on narrow rooms. */
  offScale: number;
  rooms: RoomSpot[];
  quietY: number;
  quiet: QuietPill[];
  base: Box;
  bays: Box[];
  ring: Pt & { r: number };
  card: Pt & { w: number };
  /** Where each agent's dot should stand. Bevy glides it there. */
  dots: Map<string, DotSpot>;
  embers: Map<string, Pt>;
};

export const STATIONS: Station[] = ["plan", "build", "check", "ship"];
export const ROOM_SLOTS = 8;
/** Dots sharing a pad spread around it in this order. */
const OFF: [number, number][] = [[0, 0], [19, -13], [-19, -13], [19, 13], [-19, 13], [0, -25], [0, 25], [36, 0], [-36, 0]];
const QUIET_FONT = '500 11px "IBM Plex Sans", system-ui, sans-serif';

export type LayoutInput = {
  width: number;
  world: LiveWorld;
  cards: Card[];
  roomOf(a: LiveAgent): string;
  roomName(key: string): string;
  stationOf(a: LiveAgent): Station;
};

/** Core size by model tier: the bigger the model, the bigger the dot. */
export function radius(a: LiveAgent): number {
  const m = (a.model ?? "").toLowerCase();
  if (a.harness === "grok" || /opus|fable|grok/.test(m)) return 9.5;
  if (/haiku|flash|mini|nano|lite/.test(m)) return 5.8;
  return 7.5;
}

export function layout(input: LayoutInput): Layout {
  const { width: W, world, cards } = input;
  const phone = W < 640;
  const wide = W >= 900;
  const pad = phone ? 10 : 18;
  const gap = phone ? 8 : 12;
  const cols = wide ? 4 : 2;
  const rw = (W - pad * 2 - gap * (cols - 1)) / cols;
  const rh = wide ? 206 : phone ? 190 : 200;
  const floorMid = (84 + rh - 34) / 2 - 2;
  const offScale = clamp((rw - 28) / 4 / 50, 0.62, 1);

  const agentsIn = new Map<string, LiveAgent[]>();
  for (const a of world.agents) push(agentsIn, input.roomOf(a), a);
  const embersIn = new Map<string, LiveEmber[]>();
  for (const e of [...world.embers].sort((a, b) => b.endedMs - a.endedMs)) push(embersIn, e.room, e);
  const cardsIn = new Map<string, number>();
  for (const c of cards) cardsIn.set(c.room, (cardsIn.get(c.room) ?? 0) + 1);

  const meta = new Map(world.rooms.map((r) => [r.key, r]));
  const keys = new Set([...world.rooms.map((r) => r.key), ...agentsIn.keys()]);
  // A room with agents always shows. Then rooms with a card, then rooms whose embers still glow,
  // then the apps that earn. Ties keep portfolio order.
  const stake = (k: string) => (agentsIn.get(k)?.length ? 1e6 : 0) + (cardsIn.get(k) ?? 0) * 1e4 + (embersIn.get(k)?.length ? 1e3 : 0) + (meta.get(k)?.weight ?? 1);
  const order = (k: string) => meta.get(k)?.order ?? 5000;
  const byOrder = (a: string, b: string) => order(a) - order(b) || a.localeCompare(b);
  // More busy rooms than slots: the building grows a row. A pill cannot show a stuck agent.
  const slots = Math.max(ROOM_SLOTS, [...keys].filter((k) => agentsIn.get(k)?.length).length);
  const picked = [...keys].sort((a, b) => stake(b) - stake(a) || byOrder(a, b)).slice(0, slots).sort(byOrder);
  const quietKeys = [...keys].filter((k) => !picked.includes(k)).sort(byOrder);

  const dots: Layout["dots"] = new Map();
  const emberAt: Layout["embers"] = new Map();
  const rooms: RoomSpot[] = picked.map((key, i) => {
    const x = pad + (i % cols) * (rw + gap);
    const y = pad + Math.floor(i / cols) * (rh + gap);
    const pads = STATIONS.map((_, si) => ({ x: x + 14 + ((rw - 28) * (si + 0.5)) / 4, y: y + floorMid }));
    const shelfY = y + rh - 14;
    const agents = [...(agentsIn.get(key) ?? [])].sort((a, b) => (a.startedMs ?? 0) - (b.startedMs ?? 0) || a.id.localeCompare(b.id));
    const onPad = new Map<Station, number>();
    for (const a of agents) {
      const station = input.stationOf(a);
      const n = onPad.get(station) ?? 0;
      onPad.set(station, n + 1);
      const p = pads[STATIONS.indexOf(station)];
      const o = OFF[n % OFF.length];
      dots.set(a.id, { x: p.x + o[0] * offScale, y: p.y + o[1] * offScale, r: radius(a), room: key, station });
    }
    const embers = embersIn.get(key) ?? [];
    const fit = Math.max(1, Math.floor((rw - 28) / 14));
    const emberSpots = embers.slice(0, fit).map((ember, n) => ({ x: x + 17 + n * 14, y: shelfY, ember }));
    for (const s of emberSpots) emberAt.set(s.ember.id, { x: s.x, y: s.y });
    return { key, name: input.roomName(key), x, y, w: rw, h: rh, pads, shelfY, agents, embers, emberSpots };
  });

  let y = pad + Math.ceil(Math.max(1, rooms.length) / cols) * (rh + gap) + 4;
  const quietY = y;
  const quiet = placeQuiet(quietKeys.map((k) => ({ key: k, name: input.roomName(k) })), pad + 52, y, W - pad);
  const lines = quiet.length ? Math.round((quiet[quiet.length - 1].y - y) / 26) + 1 : 0;
  y += lines * 26 + 6;

  const bh = wide ? 58 : 88;
  const base = { x: pad, y, w: W - pad * 2, h: bh };
  const bayCount = Math.max(2, world.mac.bays.length);
  let bays: Box[];
  if (wide) {
    bays = Array.from({ length: bayCount }, (_, i) => ({ x: pad + 270 + i * 160, y: y + 12, w: 150, h: 34 }));
  } else {
    const bw = (W - pad * 2 - 28 - 10 * (bayCount - 1)) / bayCount;
    bays = Array.from({ length: bayCount }, (_, i) => ({ x: pad + 14 + i * (bw + 10), y: y + 44, w: bw, h: 32 }));
  }
  y += bh + 14;

  let ring: Layout["ring"];
  let card: Layout["card"];
  let h: number;
  if (!phone) {
    const cardW = Math.min(500, W - pad * 2 - 150);
    const sx = (W - 130 - cardW) / 2;
    ring = { x: sx + 50, y: y + 86, r: 36 };
    card = { x: sx + 130, y, w: cardW };
    h = y + 290 + pad;
  } else {
    ring = { x: W / 2, y: y + 36, r: 30 };
    card = { x: pad, y: y + 92, w: W - pad * 2 };
    h = y + 92 + 300 + pad;
  }
  return { w: W, h, phone, wide, pad, offScale, rooms, quietY, quiet, base, bays, ring, card, dots, embers: emberAt };
}

/** At most two lines of pills. What does not fit becomes "+N more". */
function placeQuiet(items: { key: string; name: string }[], x0: number, y: number, right: number): QuietPill[] {
  const measure = textWidth(QUIET_FONT);
  const place = (n: number) => {
    const out: QuietPill[] = [];
    let x = x0;
    let ln = 0;
    const shown: { key: string | null; name: string }[] = items.slice(0, n);
    if (n < items.length) shown.push({ key: null, name: `+${items.length - n} more` });
    for (const it of shown) {
      const w = Math.ceil(measure(it.name)) + 18;
      if (x + w > right && x > x0) {
        ln++;
        x = x0;
      }
      out.push({ ...it, x, y: y + ln * 26, w, h: 20 });
      x += w + 6;
    }
    return { out, ln };
  };
  let shown = items.length;
  let res = place(shown);
  while (res.ln >= 2 && shown > 1) res = place(--shown);
  return res.out;
}

let measurer: CanvasRenderingContext2D | null = null;
function textWidth(font: string): (text: string) => number {
  measurer ??= document.createElement("canvas").getContext("2d");
  if (!measurer) return (t) => t.length * 6.5;
  measurer.font = font;
  return (t) => measurer!.measureText(t).width;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v));
}
