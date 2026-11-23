
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
  lanes: number[];
};
export type Slots = { cols: number; col: Map<string, number>; size: string };

export const HUB = { w: 320, h: 118 };
export const CARD = { w: 200, h: 64, gap: 30 };
const BAND = { x0: -(HUB.w / 2 + CARD.gap + CARD.w + 10), x1: HUB.w / 2 + CARD.gap + CARD.w + 10, y0: -HUB.h / 2 - 12 };
export const PLOT = { w: 300, head: 64, row: 52, pad: 8, gap: 28, top: 120, dotX: 34 };
export const PLANET = { x: 38, y: 32, r: 17 };
export const STATION = { x: 36, y: 34 };
export const MARK_DX = 28;
export const markAt = (c: Box): Pt => ({ x: c.x - c.w / 2 + MARK_DX, y: c.y });
export const stationAt = (hub: Box): Pt => ({ x: hub.x - hub.w / 2 + STATION.x, y: hub.y - hub.h / 2 + STATION.y });
export const BUBBLE_DX = 24;
export const bubbleW = (plotW: number) => plotW - PLOT.dotX - BUBBLE_DX - 10;
const PLOT_MAX_W = 440;
const MAX_COLS = 6;
const RECOLUMN = 1.15;
const BAY = { pad: 24, gap: 16, y: 26, h: 38 };
const TURN = 12;

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
  const zoomOf = (cols: number) => Math.min(1, (stage.w - 40) / Math.max(BAND.x1 - BAND.x0, gridWidth(cols)), (stage.h - 40) / (PLOT.top + grid(order, heights, cols).tall - BAND.y0));
  const most = Math.max(1, Math.min(order.length, MAX_COLS));
  let best = 1;
  const spare = (c: number) => Math.ceil(order.length / c) * c - order.length;
  for (let c = 2; c <= most; c++) {
    const gain = zoomOf(c) - zoomOf(best);
    if (gain > 1e-6 || (gain >= -1e-6 && spare(c) <= spare(best))) best = c;
  }
  const size = `${Math.round(stage.w / 40)}x${Math.round(stage.h / 40)}`;
  if (slots.size !== size || slots.cols < 1 || slots.cols > most || zoomOf(best) > zoomOf(slots.cols) * RECOLUMN || (spare(best) < spare(slots.cols) && zoomOf(best) >= zoomOf(slots.cols) - 1e-6)) {
    slots.size = size;
    slots.cols = best;
  }
  const cols = slots.cols;
  const { col, tops, rowH, tall, lanes } = grid(order, heights, cols);
  for (const k of order) slots.col.set(k, col.get(k)!);
  const z = zoomOf(cols);
  const roomy = ((stage.w - 40) / z - 24 - (cols - 1) * PLOT.gap) / cols;
  const plotW = Math.max(PLOT.w, Math.min(PLOT_MAX_W, Math.floor(roomy / 20) * 20));

  const snug = cols >= 3;
  const odd = cols % 2 === 1;
  const hubW = snug && odd ? plotW : HUB.w;
  const cardW = snug ? plotW : CARD.w;
  const cardX = snug ? (plotW + PLOT.gap) * (odd ? 1 : 1.5) : HUB.w / 2 + CARD.gap + CARD.w / 2;
  const card = (side: number): Box => ({ x: side * cardX, y: -HUB.h / 2 + CARD.h / 2, w: cardW, h: CARD.h });
  const bayW = (hubW - 2 * BAY.pad - BAY.gap) / 2;
  const hub = { x: 0, y: 0, w: hubW, h: HUB.h, bays: [-1, 1].map((side) => ({ x: (side * (bayW + BAY.gap)) / 2, y: BAY.y, w: bayW, h: BAY.h })) };
  const landmarks: Landmarks = { tower: card(-1), sky: card(-1), web: card(1) };

  const dots = new Map<string, DotSpot>();
  const left = -gridWidth(cols, plotW) / 2;
  const districts: District[] = order.map((key) => {
    const p = plots.get(key)!;
    const h = rowH.get(key)!;
    const x0 = left + col.get(key)! * (plotW + PLOT.gap);
    const y0 = PLOT.top + tops.get(key)!;
    p.rows.forEach((a, i) => {
      const spot = { x: x0 + PLOT.dotX, y: y0 + PLOT.head + PLOT.row * i + PLOT.row / 2, r: radius(a), room: key, swarm: p.riders.get(a.id)?.length ?? 0 };
      dots.set(a.id, spot);
      for (const k of p.riders.get(a.id) ?? []) dots.set(k.id, { ...spot, swarm: -1, on: a.id });
    });
    const waiting = p.agents.filter((a) => a.state === "turn").length;
    return { key, name: input.roomName(key), x: x0 + plotW / 2, y: y0 + h / 2, w: plotW, h, r: Math.max(plotW, h) / 2, agents: p.agents.map((a) => a.id), waiting, stuck: p.agents.some((a) => a.state === "stuck"), planet: { x: x0 + PLANET.x, y: y0 + PLANET.y } };
  });

  const half = Math.max(BAND.x1, gridWidth(cols, plotW) / 2 + 10);
  return { hub, landmarks, districts, dots, bounds: { x0: -half, y0: BAND.y0, x1: half, y1: PLOT.top + Math.max(0, tall) + 10 }, plotW, lanes: lanes.map((y) => PLOT.top + y) };
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

export const LANE_Y = PLOT.top - PLOT.gap / 2;

type Ways = Pick<World, "hub" | "landmarks" | "districts" | "lanes">;

export function route(w: Ways, a: Pt, b: Pt): Pt[] {
  return round(elbows(w, a, b));
}

export function elbows(w: Ways, a: Pt, b: Pt): Pt[] {
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
    const lane = A.band || B.band ? LANE_Y : [LANE_Y, ...w.lanes].reduce((best, y) => (Math.abs(A.at.y - y) + Math.abs(B.at.y - y) < Math.abs(A.at.y - best) + Math.abs(B.at.y - best) ? y : best));
    if (A.gutter !== null) path.push({ x: A.gutter, y: A.at.y }, { x: A.gutter, y: lane });
    else if (A.band) path.push({ x: A.at.x, y: lane });
    if (B.gutter !== null) path.push({ x: B.gutter, y: lane }, { x: B.gutter, y: B.at.y });
    else if (B.band) path.push({ x: B.at.x, y: lane });
  }
  path.push(B.at);
  if (B.inner) path.push(B.inner);
  return tidy(path);
}

function leg(w: Ways, p: Pt): { at: Pt; inner?: Pt; gutter: number | null; band: boolean; dots?: boolean; room?: string } {
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

function round(path: Pt[]): Pt[] {
  if (path.length < 3) return path;
  const out: Pt[] = [path[0]];
  for (let i = 1; i < path.length - 1; i++) {
    const [p, c, n] = [path[i - 1], path[i], path[i + 1]];
    const lin = Math.hypot(c.x - p.x, c.y - p.y);
    const lout = Math.hypot(n.x - c.x, n.y - c.y);
    const k = Math.min(TURN, lin / 2, lout / 2);
    if (k < 1) {
      out.push(c);
      continue;
    }
    const a = { x: c.x + ((p.x - c.x) * k) / lin, y: c.y + ((p.y - c.y) * k) / lin };
    const b = { x: c.x + ((n.x - c.x) * k) / lout, y: c.y + ((n.y - c.y) * k) / lout };
    for (const t of [0, 1 / 3, 2 / 3, 1]) {
      const u = 1 - t;
      out.push({ x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y });
    }
  }
  out.push(path[path.length - 1]);
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

function grid(order: string[], heights: Map<string, number>, cols: number): { col: Map<string, number>; tops: Map<string, number>; rowH: Map<string, number>; tall: number; lanes: number[] } {
  const col = new Map<string, number>();
  const tops = new Map<string, number>();
  const rowH = new Map<string, number>();
  const lanes: number[] = [];
  let y = 0;
  for (let i = 0; i < order.length; i += cols) {
    const row = order.slice(i, i + cols);
    const h = Math.max(...row.map((k) => heights.get(k)!));
    row.forEach((k, c) => {
      col.set(k, c);
      tops.set(k, y);
      rowH.set(k, h);
    });
    y += h + PLOT.gap;
    lanes.push(y - PLOT.gap / 2);
  }
  return { col, tops, rowH, tall: Math.max(0, y - PLOT.gap), lanes };
}

function gridWidth(cols: number, plotW = PLOT.w): number {
  return cols * plotW + (cols - 1) * PLOT.gap;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const l = m.get(k);
  if (l) l.push(v);
  else m.set(k, [v]);
}
