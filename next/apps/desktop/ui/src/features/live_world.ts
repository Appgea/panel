/**
 * Live's map, in world pixels with y growing down. This Mac, the hub, sits at the origin, with
 * the GitHub tower on its left and the web gate on its right: a band across the top. Under it
 * each project with a running agent is a plot, a rounded box with one row per agent, packed in
 * columns that fill the stage. A project with no agent is not on the map, whatever waits for the
 * owner there: Live shows activity. Cards, the board and tasks have their own sections.
 * Owner, 2026-11-05: "No need to see ALL projects there. I want to see the activity."
 *
 * Every agent keeps its row, and its bubble sits beside it, so the owner finds it in the same
 * place on every look. Helpers ride as electrons on the agent that started them instead of
 * taking rows. A plot keeps its column while it stays busy and grows downward as agents join,
 * so nothing jumps sideways. Owner, 2026-11-05: "not space efficient. Hard for me to track. I
 * like the bubbles that we show what they are doing."
 */

import type { LiveAgent, LiveWorld } from "./live_types";

export type Pt = { x: number; y: number };
export type Box = { x: number; y: number; w: number; h: number };
export type Tile = { x: number; y: number; path: string; agents: string[] };
/** `x`, `y` is the centre. `r` is half the longer side, for effects that ring the whole plot. */
export type District = { key: string; name: string; x: number; y: number; w: number; h: number; r: number; agents: string[]; waiting: number; stuck: boolean; tiles: Tile[] };
/** `swarm` is how many helpers ride on this agent, or -1 for a helper riding on its parent. */
export type DotSpot = { x: number; y: number; r: number; room: string; swarm: number };
export type Landmarks = { tower: Pt; web: Pt; sky: Pt };
export type World = {
  hub: Box & { bays: Box[] };
  landmarks: Landmarks;
  districts: District[];
  dots: Map<string, DotSpot>;
  /** The map's extent, for fitting the camera. */
  bounds: { x0: number; y0: number; x1: number; y1: number };
};
/**
 * Which column each plot sits in, kept by live.ts across polls so a plot never jumps, and the
 * column count and stage size they were chosen for.
 */
export type Slots = { cols: number; col: Map<string, number>; size: string };

export const HUB = { w: 320, h: 118 };
const LANDMARKS: Landmarks = { tower: { x: -HUB.w / 2 - 120, y: 46 }, sky: { x: -HUB.w / 2 - 120, y: -320 }, web: { x: HUB.w / 2 + 120, y: 0 } };
/** The band's extent, with room for the tower's glow and the landmarks' words. */
const BAND = { x0: -350, x1: 350, y0: -100 };
/**
 * A plot's parts. `head` holds the project's name, `row` one agent and its bubble, `foot` the
 * file tiles. A two-line bubble is 39 px and the labels keep 3 px clear around each word, so a
 * row of 46 keeps two of them apart at zoom 1, and a head of 34 keeps one clear of the sign.
 */
export const PLOT = { w: 300, head: 34, row: 46, foot: 20, pad: 8, gap: 20, top: 116, dotX: 20 };
/** A bubble starts this far right of its dot, past the orbits of the helpers riding on it. */
export const BUBBLE_DX = 18;
/** The width a bubble may take in its row, in world pixels. */
export const BUBBLE_W = PLOT.w - PLOT.dotX - BUBBLE_DX - 10;
const TILES_PER_DISTRICT = 22;
const TILE_STEP = 11;
/** More columns than this make plots too small to read at the zoom it takes. */
const MAX_COLS = 6;
/** A new column count must fit this much better before every plot moves for it. */
const RECOLUMN = 1.15;

/** Core size by model tier: small electrons, a little bigger for the bigger models. */
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
  /** The stage in CSS pixels, so the columns match its shape. */
  stage: { w: number; h: number };
};

type Plot = { key: string; agents: LiveAgent[]; rows: LiveAgent[]; riders: Map<string, LiveAgent[]>; files: { path: string; agents: string[] }[]; h: number };

export function lay(input: WorldInput): World {
  const { world, slots } = input;
  const agentsIn = new Map<string, LiveAgent[]>();
  for (const a of world.agents) push(agentsIn, input.roomOf(a), a);
  const plots = new Map([...agentsIn].map(([key, list]) => [key, plot(key, list)]));

  // Plots in the order they first appeared, so a column stacks the same way on every poll.
  for (const k of [...slots.col.keys()]) if (!plots.has(k)) slots.col.delete(k);
  const order = [...slots.col.keys(), ...[...plots.keys()].filter((k) => !slots.col.has(k)).sort()];
  const heights = new Map([...plots].map(([k, p]) => [k, p.h]));
  const stage = { w: Math.max(200, input.stage.w || 1000), h: Math.max(200, input.stage.h || 700) };
  // The zoom a column count fits at, capped at 1 because the camera never zooms past it. At the
  // same zoom more columns win: a wide stage then fills sideways instead of growing a tall tail.
  const zoomOf = (cols: number, kept: Map<string, number>) => {
    const { tall } = pack(order, heights, cols, kept);
    return Math.min(1, (stage.w - 40) / Math.max(BAND.x1 - BAND.x0, gridWidth(cols)), (stage.h - 40) / (PLOT.top + tall - BAND.y0));
  };
  const most = Math.max(1, Math.min(order.length, MAX_COLS));
  let best = 1;
  for (let c = 2; c <= most; c++) if (zoomOf(c, new Map()) >= zoomOf(best, new Map()) - 1e-6) best = c;
  // A new stage size chooses afresh. Otherwise plots move only for a clearly better fit.
  const size = `${Math.round(stage.w / 40)}x${Math.round(stage.h / 40)}`;
  if (slots.size !== size || slots.cols < 1 || slots.cols > most || zoomOf(best, new Map()) > zoomOf(slots.cols, slots.col) * RECOLUMN) {
    slots.size = size;
    slots.cols = best;
    slots.col.clear();
  }
  const { col, tops } = pack(order, heights, slots.cols, slots.col);
  for (const k of order) slots.col.set(k, col.get(k)!);

  const hub = { x: 0, y: 0, ...HUB, bays: [0, 1].map((i) => ({ x: -72 + i * 144, y: 26, w: 128, h: 38 })) };
  const dots = new Map<string, DotSpot>();
  const left = -gridWidth(slots.cols) / 2;
  const districts: District[] = order.map((key) => {
    const p = plots.get(key)!;
    const x0 = left + col.get(key)! * (PLOT.w + PLOT.gap);
    const y0 = PLOT.top + tops.get(key)!;
    p.rows.forEach((a, i) => {
      const spot = { x: x0 + PLOT.dotX, y: y0 + PLOT.head + PLOT.row * i + PLOT.row / 2, r: radius(a), room: key, swarm: p.riders.get(a.id)?.length ?? 0 };
      dots.set(a.id, spot);
      for (const k of p.riders.get(a.id) ?? []) dots.set(k.id, { ...spot, swarm: -1 });
    });
    const tiles: Tile[] = p.files.map((f, i) => ({ x: x0 + PLOT.dotX + i * TILE_STEP, y: y0 + p.h - PLOT.foot / 2 - 1, ...f }));
    const waiting = p.agents.filter((a) => a.state === "turn").length;
    return { key, name: input.roomName(key), x: x0 + PLOT.w / 2, y: y0 + p.h / 2, w: PLOT.w, h: p.h, r: Math.max(PLOT.w, p.h) / 2, agents: p.agents.map((a) => a.id), waiting, stuck: p.agents.some((a) => a.state === "stuck"), tiles };
  });

  const half = Math.max(BAND.x1, gridWidth(slots.cols) / 2 + 10);
  const tall = Math.max(0, ...districts.map((d) => d.y + d.h / 2));
  return { hub, landmarks: LANDMARKS, districts, dots, bounds: { x0: -half, y0: BAND.y0, x1: half, y1: Math.max(PLOT.top, tall + 10) } };
}

/**
 * One project's plot: a row for each agent whose parent is not here, and the files they touched.
 * A helper rides on its parent's row, and a chain of helpers on the top one. A helper that needs
 * the owner gets its own row, so its bubble can say so, as it gets its own row in the side list.
 */
function plot(key: string, list: LiveAgent[]): Plot {
  const agents = [...list].sort((a, b) => (a.startedMs ?? 0) - (b.startedMs ?? 0) || a.id.localeCompare(b.id));
  const byId = new Map(agents.map((a) => [a.id, a]));
  /** The agent at the top of this one's chain, or itself when the chain loops. */
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
  const files: Plot["files"] = [];
  for (const a of agents)
    for (const f of [...a.steps.map((s) => s.file).filter((f): f is string => !!f), ...a.files]) {
      const have = files.find((x) => x.path === f);
      if (have) {
        if (!have.agents.includes(a.id)) have.agents.push(a.id);
      } else if (files.length < TILES_PER_DISTRICT) files.push({ path: f, agents: [a.id] });
    }
  const h = PLOT.head + rows.length * PLOT.row + (files.length ? PLOT.foot : PLOT.pad);
  return { key, agents, rows, riders, files, h };
}

/** Puts each plot in its kept column, else the shortest one, and stacks every column downward. */
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

function gridWidth(cols: number): number {
  return cols * PLOT.w + (cols - 1) * PLOT.gap;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const l = m.get(k);
  if (l) l.push(v);
  else m.set(k, [v]);
}
