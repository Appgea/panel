/**
 * The scene Bevy draws: the map from live_world.ts in world pixels, the camera, what running
 * scripts changed, and the effects starting now. The contract is in apps/live/src/lib.rs.
 * Change both together.
 */

import type { LiveCtx } from "./live_types";

/** A file tile glows for this long after an agent last touched it. */
const FRESH_MS = 120_000;

export function scene(ctx: LiveCtx, width: number, height: number): object {
  const s = ctx.s;
  const w = s.layout!;
  const world = s.world!;
  const now = Date.now();
  const sel = s.selection;

  const touched = new Map<string, { at: number; edited: boolean }>();
  for (const a of world.agents)
    for (const st of a.steps) {
      if (!st.file) continue;
      const t = touched.get(st.file);
      const edited = st.verb === "edit" || st.station === "build";
      if (!t || st.atMs > t.at) touched.set(st.file, { at: st.atMs, edited: edited || !!t?.edited });
    }
  const tiles = w.districts.flatMap((d) =>
    d.tiles.map((t) => {
      const lit = s.lights.get(t.path);
      const fresh = touched.get(t.path);
      const glow = Math.max(lit && lit.until > now ? 1 : 0, fresh ? Math.max(0, 1 - (now - fresh.at) / FRESH_MS) : 0);
      return { x: t.x, y: t.y, lit: glow, edited: !!fresh?.edited };
    }),
  );

  const at = (id: string) => s.walks.get(id) ?? w.dots.get(id);
  const focus = s.hover ?? (sel?.kind === "agent" ? sel.id : null);
  const links: object[] = [];
  const f = focus ? world.agents.find((a) => a.id === focus) : undefined;
  const fp = f ? at(f.id) : undefined;
  if (f && fp) {
    const family = world.agents.filter((a) => a.id === f.parent || a.parent === f.id);
    for (const o of family) {
      const op = at(o.id);
      if (op && (op.x !== fp.x || op.y !== fp.y)) links.push({ x1: fp.x, y1: fp.y, x2: op.x, y2: op.y });
    }
  }

  const dots = world.agents.flatMap((a) => {
    const spot = w.dots.get(a.id);
    if (!spot || spot.swarm < 0) return [];
    const p = at(a.id)!;
    return [{ id: a.id, x: p.x, y: p.y, r: spot.r, state: a.state, helpers: a.helpers + spot.swarm, selected: sel?.kind === "agent" && sel.id === a.id, hovered: s.hover === a.id, carry: s.carries.get(a.id) ?? null }];
  });

  return {
    w: width,
    h: height,
    reduced: s.reduced,
    camera: s.camera,
    // The amber `card` edge: an agent in this district waits for the owner.
    districts: w.districts.map((d) => ({ x: d.x, y: d.y, r: d.r, edge: d.stuck ? "stuck" : d.waiting ? "card" : "quiet", selected: sel?.kind === "room" && sel.id === d.key })),
    tiles,
    hub: { ...w.hub, hot: world.mac.hot, bays: w.hub.bays.map((b, i) => ({ ...b, held: !!world.mac.bays[i]?.holder })) },
    landmarks: [
      { kind: "tower", ...w.landmarks.tower },
      { kind: "web", ...w.landmarks.web },
    ],
    links,
    dots,
    fx: s.pendingFx,
  };
}
