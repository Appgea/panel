
import type { LiveAgent, LiveWorld } from "./live_types";

export type Pt = { x: number; y: number };
export type Box = { x: number; y: number; w: number; h: number };
export type District = { key: string; name: string; x: number; y: number; w: number; h: number; r: number; agents: string[]; waiting: number; stuck: boolean; planet: Pt };
export type DotSpot = { x: number; y: number; r: number; room: string; swarm: number; on?: string };
export type Landmarks = { tower: Box; web: Box; sky: Box };
export type World = {
  hub: Box & { bays: Box[] };
  landmarks: Landmarks;
  districts: District[];
  dots: Map<string, DotSpot>;
  bounds: { x0: number; y0: number; x1: number; y1: number };
  plotW: number;
};
export type Slots = { cols: number; col: Map<string, number>; size: string };

export const HUB = { w: 320, h: 118 };
export const CARD = { w: 200, h: 64, gap: 30 };
const card = (side: number): Box => ({ x: side * (HUB.w / 2 + CARD.gap + CARD.w / 2), y: -HUB.h / 2 + CARD.h / 2, w: CARD.w, h: CARD.h });
const LANDMARKS: Landmarks = { tower: card(-1), sky: card(-1), web: card(1) };
const BAND = { x0: -(HUB.w / 2 + CARD.gap + CARD.w + 10), x1: HUB.w / 2 + CARD.gap + CARD.w + 10, y0: -HUB.h / 2 - 12 };
export const PLOT = { w: 300, head: 64, row: 52, pad: 8, gap: 20, top: 116, dotX: 26 };
export const PLANET = { x: 38, y: 32, r: 17 };
export const STATION = { x: 36, y: 34 };
export const MARK_DX = 28;
export const markAt = (c: Box): Pt => ({ x: c.x - c.w / 2 + MARK_DX, y: c.y });
export const stationAt = (hub: Box): Pt => ({ x: hub.x - hub.w / 2 + STATION.x, y: hub.y - hub.h / 2 + STATION.y });
export const BUBBLE_DX = 24;
export const bubbleW = (plotW: number) => plotW - PLOT.dotX - BUBBLE_DX - 6;
const PLOT_MAX_W = 440;
const MAX_COLS = 6;
const RECOLUMN = 1.15;

export function radius(a: LiveAgent): number {
  const m = (a.model ?? "").toLowerCase();
  if (a.harness === "grok" || /opus|fable|grok/.test(m)) return 4.6;
  if (/haiku|flash|mini|nano|lite/.test(m)) return 3;
  return 3.8;
}

export type WorldInput = {
  world: LiveWorld;
  roomOf(a: LiveAgent): string;
  roomName(key: string): string;
  slots: Slots;
  stage: { w: number; h: number };
};

type Plot = { key: string; agents: LiveAgent[]; rows: LiveAgent[]; riders: Map<string, LiveAgent[]>; h: number };

export function lay(input: WorldInput): World {
  const { world, slots } = input;
  const agentsIn = new Map<string, LiveAgent[]>();
  for (const a of world.agents) push(agentsIn, input.roomOf(a), a);
  const plots = new Map([...agentsIn].map(([key, list]) => [key, plot(key, list)]));

  for (const k of [...slots.col.keys()]) if (!plots.has(k)) slots.col.delete(k);
  const order = [...slots.col.keys(), ...[...plots.keys()].filter((k) => !slots.col.has(k)).sort()];
  const heights = new Map([...plots].map(([k, p]) => [k, p.h]));
  const stage = { w: Math.max(200, input.stage.w || 1000), h: Math.max(200, input.stage.h || 700) };
  const zoomOf = (cols: number, kept: Map<string, number>) => {
    const { tall } = pack(order, heights, cols, kept);
    return Math.min(1, (stage.w - 40) / Math.max(BAND.x1 - BAND.x0, gridWidth(cols)), (stage.h - 40) / (PLOT.top + tall - BAND.y0));
  };
  const most = Math.max(1, Math.min(order.length, MAX_COLS));
  let best = 1;
  for (let c = 2; c <= most; c++) if (zoomOf(c, new Map()) >= zoomOf(best, new Map()) - 1e-6) best = c;
  const size = `${Math.round(stage.w / 40)}x${Math.round(stage.h / 40)}`;
  if (slots.size !== size || slots.cols < 1 || slots.cols > most || zoomOf(best, new Map()) > zoomOf(slots.cols, slots.col) * RECOLUMN) {
    slots.size = size;
    slots.cols = best;
    slots.col.clear();
  }
  const { col, tops } = pack(order, heights, slots.cols, slots.col);
  for (const k of order) slots.col.set(k, col.get(k)!);
  const z = zoomOf(slots.cols, slots.col);
  const roomy = ((stage.w - 40) / z - 24 - (slots.cols - 1) * PLOT.gap) / slots.cols;
  const plotW = Math.max(PLOT.w, Math.min(PLOT_MAX_W, Math.floor(roomy / 20) * 20));

  const hub = { x: 0, y: 0, ...HUB, bays: [0, 1].map((i) => ({ x: -72 + i * 144, y: 26, w: 128, h: 38 })) };
  const dots = new Map<string, DotSpot>();
  const left = -gridWidth(slots.cols, plotW) / 2;
  const districts: District[] = order.map((key) => {
    const p = plots.get(key)!;
    const x0 = left + col.get(key)! * (plotW + PLOT.gap);
    const y0 = PLOT.top + tops.get(key)!;
    p.rows.forEach((a, i) => {
      const spot = { x: x0 + PLOT.dotX, y: y0 + PLOT.head + PLOT.row * i + PLOT.row / 2, r: radius(a), room: key, swarm: p.riders.get(a.id)?.length ?? 0 };
      dots.set(a.id, spot);
      for (const k of p.riders.get(a.id) ?? []) dots.set(k.id, { ...spot, swarm: -1, on: a.id });
    });
    const waiting = p.agents.filter((a) => a.state === "turn").length;
    return { key, name: input.roomName(key), x: x0 + plotW / 2, y: y0 + p.h / 2, w: plotW, h: p.h, r: Math.max(plotW, p.h) / 2, agents: p.agents.map((a) => a.id), waiting, stuck: p.agents.some((a) => a.state === "stuck"), planet: { x: x0 + PLANET.x, y: y0 + PLANET.y } };
  });

  const half = Math.max(BAND.x1, gridWidth(slots.cols, plotW) / 2 + 10);
  const tall = Math.max(0, ...districts.map((d) => d.y + d.h / 2));
  return { hub, landmarks: LANDMARKS, districts, dots, bounds: { x0: -half, y0: BAND.y0, x1: half, y1: Math.max(PLOT.top, tall + 10) }, plotW };
}

function plot(key: string, list: LiveAgent[]): Plot {
  const agents = [...list].sort((a, b) => (a.startedMs ?? 0) - (b.startedMs ?? 0) || a.id.localeCompare(b.id));
  const byId = new Map(agents.map((a) => [a.id, a]));
  const top = (a: LiveAgent): LiveAgent => {
    const seen = new Set([a.id]);
    let at = a;
    while (at.parent && byId.has(at.parent)) {
      if (seen.has(at.parent)) return a;
      at = byId.get(at.parent)!;
      seen.add(at.id);
    }
    return at;
  };
  const riders = new Map<string, LiveAgent[]>();
  const rows: LiveAgent[] = [];
  for (const a of agents) {
    const t = top(a);
    if (t === a || a.state === "turn" || a.state === "stuck") rows.push(a);
    else push(riders, t.id, a);
  }
  const h = PLOT.head + rows.length * PLOT.row + PLOT.pad;
  return { key, agents, rows, riders, h };
}

export const LANE_Y = PLOT.top - 12;

export function route(w: World, a: Pt, b: Pt): Pt[] {
  const A = leg(w, a);
  const B = leg(w, b);
  const path: Pt[] = A.inner ? [A.inner, A.at] : [A.at];
  const free = (x: typeof A) => x.gutter === null && !x.band;
  const column = A.gutter !== null && (A.gutter === B.gutter || free(B)) ? A.gutter : B.gutter !== null && free(A) ? B.gutter : null;
  if (A.dots && B.dots && A.room === B.room) {
  } else if (column !== null) {
    path.push({ x: column, y: A.at.y }, { x: column, y: B.at.y });
  } else if (A.band && B.band && Math.abs(A.at.x - B.at.x) < 1) {
  } else if (!free(A) || !free(B)) {
    if (A.gutter !== null) path.push({ x: A.gutter, y: A.at.y }, { x: A.gutter, y: LANE_Y });
    else if (A.band) path.push({ x: A.at.x, y: LANE_Y });
    if (B.gutter !== null) path.push({ x: B.gutter, y: LANE_Y }, { x: B.gutter, y: B.at.y });
    else if (B.band) path.push({ x: B.at.x, y: LANE_Y });
  }
  path.push(B.at);
  if (B.inner) path.push(B.inner);
  return tidy(path);
}

function leg(w: World, p: Pt): { at: Pt; inner?: Pt; gutter: number | null; band: boolean; dots?: boolean; room?: string } {
  const d = w.districts.find((x) => Math.abs(p.x - x.x) <= x.w / 2 + 2 && Math.abs(p.y - x.y) <= x.h / 2 + 2);
  if (d) {
    const left = d.x - d.w / 2;
    const dots = p.x <= left + PLOT.dotX + 12;
    return { at: dots ? p : { x: left + 2, y: p.y }, gutter: left - PLOT.gap / 2, band: false, dots, room: d.key };
  }
  const h = w.hub;
  if (Math.abs(p.x - h.x) <= h.w / 2 && Math.abs(p.y - h.y) <= h.h / 2) {
    const bay = h.bays.find((b) => Math.abs(p.x - b.x) <= b.w / 2 && Math.abs(p.y - b.y) <= b.h / 2);
    const x = bay ? bay.x + bay.w / 2 - 16 : p.x;
    return { at: { x, y: h.y + h.h / 2 }, inner: bay ? { x, y: bay.y } : undefined, gutter: null, band: true };
  }
  const L = w.landmarks;
  for (const c of [L.tower, L.web])
    if (Math.abs(p.x - c.x) <= c.w / 2 && p.y <= c.y + c.h / 2 + 2) return { at: { x: markAt(c).x, y: c.y + 22 }, gutter: null, band: true };
  return { at: p, gutter: null, band: p.y < LANE_Y };
}

function tidy(path: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of path) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.5 && Math.abs(last.y - p.y) < 0.5) continue;
    const prev = out[out.length - 2];
    if (prev && last && ((Math.abs(prev.x - last.x) < 0.5 && Math.abs(last.x - p.x) < 0.5) || (Math.abs(prev.y - last.y) < 0.5 && Math.abs(last.y - p.y) < 0.5))) out.pop();
    out.push(p);
  }
  return out;
}

export function along(path: Pt[], k: number): Pt {
  const lens = path.slice(1).map((p, i) => Math.hypot(p.x - path[i].x, p.y - path[i].y));
  let left = Math.max(0, Math.min(1, k)) * lens.reduce((s, l) => s + l, 0);
  for (let i = 0; i < lens.length; i++) {
    if (left <= lens[i] || i === lens.length - 1) {
      const t = lens[i] ? Math.min(1, left / lens[i]) : 1;
      return { x: path[i].x + (path[i + 1].x - path[i].x) * t, y: path[i].y + (path[i + 1].y - path[i].y) * t };
    }
    left -= lens[i];
  }
  return path[path.length - 1];
}

function pack(order: string[], heights: Map<string, number>, cols: number, kept: Map<string, number>): { col: Map<string, number>; tops: Map<string, number>; tall: number } {
  const ends = new Array<number>(cols).fill(0);
  const col = new Map<string, number>();
  const tops = new Map<string, number>();
  for (const k of order) {
    const have = kept.get(k);
    const c = have !== undefined && have < cols ? have : ends.indexOf(Math.min(...ends));
    col.set(k, c);
    tops.set(k, ends[c]);
    ends[c] += heights.get(k)! + PLOT.gap;
  }
  return { col, tops, tall: Math.max(0, ...ends.map((e) => e - PLOT.gap)) };
}

function gridWidth(cols: number, plotW = PLOT.w): number {
  return cols * plotW + (cols - 1) * PLOT.gap;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const l = m.get(k);
  if (l) l.push(v);
  else m.set(k, [v]);
}
