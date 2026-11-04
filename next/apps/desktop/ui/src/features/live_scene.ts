/**
 * The scene Live hands Bevy, built from the layout. The contract is written once, at the top of
 * apps/live/src/lib.rs, and `Scene` there must read exactly what this file writes.
 * Everything is in stage CSS pixels from the top left.
 */

import type { Pt } from "./live_layout";
import type { Flight, LiveCtx } from "./live_types";

type Xy = [number, number];

/** A card's thread: from its agent, or its room's bottom middle, down to the top of the ring. */
export function threadPath(ctx: LiveCtx, room: string, agent: string | null): Xy[] | null {
  const l = ctx.s.layout;
  if (!l) return null;
  const dot = agent ? l.dots.get(agent) : undefined;
  const r = l.rooms.find((x) => x.key === room);
  let p0: Pt;
  if (dot) p0 = { x: dot.x, y: dot.y + dot.r };
  else if (r) p0 = { x: r.x + r.w / 2, y: r.y + r.h };
  else {
    // A quiet room has no box: its pill is the start.
    const q = l.quiet.find((x) => x.key === room);
    if (!q) return null;
    p0 = { x: q.x + q.w / 2, y: q.y + q.h };
  }
  const ring = l.ring;
  return [
    [p0.x, p0.y],
    [p0.x, p0.y + 90],
    [ring.x, ring.y - ring.r - 110],
    [ring.x, ring.y - ring.r],
  ];
}

export function scene(ctx: LiveCtx, flights: Flight[], tether: { x1: number; y1: number; x2: number; y2: number } | null) {
  const l = ctx.s.layout!;
  const w = ctx.s.world!;
  const sel = ctx.s.selection;
  const cards = ctx.s.cards;
  const cardRooms = new Set(cards.map((c) => c.room));
  const front = cards[0]?.id ?? null;

  const focus = ctx.s.hover ?? (sel?.kind === "agent" ? sel.id : null);
  const links: object[] = [];
  if (focus) {
    const me = w.agents.find((a) => a.id === focus);
    const at = l.dots.get(focus);
    const family = w.agents.filter((a) => a.id === me?.parent || a.parent === focus);
    for (const o of family) {
      const to = l.dots.get(o.id);
      if (at && to) links.push({ x1: at.x, y1: at.y, x2: to.x, y2: to.y, kind: "family" });
    }
  }
  const held = w.mac.bays.map((b) => b.agent);
  held.forEach((agent, i) => {
    const at = agent ? l.dots.get(agent) : undefined;
    const bay = l.bays[i];
    if (at && bay) links.push({ x1: at.x, y1: at.y + at.r + 2, x2: bay.x + bay.w / 2, y2: bay.y, kind: "bay" });
  });

  const threads = cards.flatMap((c) => {
    const p = threadPath(ctx, c.room, c.agent ?? null);
    return p ? [{ p, front: c.id === front }] : [];
  });

  return {
    w: l.w,
    h: Math.max(l.h, ctx.stage.clientHeight),
    reduced: ctx.s.reduced,
    rooms: l.rooms.map((r) => ({
      x: r.x,
      y: r.y,
      w: r.w,
      h: r.h,
      edge: r.agents.some((a) => a.state === "stuck") ? "stuck" : cardRooms.has(r.key) ? "card" : "quiet",
      selected: sel?.kind === "room" && sel.id === r.key,
      pads: r.pads.map((p) => [p.x, p.y]),
      pad_rx: 22 * l.offScale + 4,
      pad_ry: 14 * l.offScale + 3,
      divider_y: r.y + 82.5,
      shelf_y: r.shelfY,
      embers: r.emberSpots.map((s) => ({ x: s.x, y: s.y, outcome: s.ember.outcome })),
    })),
    base: { ...l.base, hot: w.mac.hot },
    bays: l.bays.map((b, i) => ({ ...b, held: !!w.mac.bays[i]?.holder })),
    ring: { x: l.ring.x, y: l.ring.y, r: l.ring.r, waiting: cards.length > 0 },
    threads,
    flights: flights.flatMap((f) => {
      const p = threadPath(ctx, f.room, f.agent);
      return p ? [{ dir: f.dir, p }] : [];
    }),
    links,
    dots: w.agents.flatMap((a) => {
      const d = l.dots.get(a.id);
      if (!d) return [];
      return [{ id: a.id, x: d.x, y: d.y, r: d.r, state: a.state, helpers: a.helpers, selected: sel?.kind === "agent" && sel.id === a.id, hovered: ctx.s.hover === a.id }];
    }),
    fx: ctx.s.pendingFx.map((f) => ({ kind: f.kind, x: f.x, y: f.y, x2: f.x2 ?? 0, y2: f.y2 ?? 0, r: f.r ?? 6 })),
    tether,
  };
}
