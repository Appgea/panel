/**
 * The scene Bevy draws: the map from live_world.ts in world pixels, the camera, what running
 * scripts changed, and the effects starting now. The contract is in apps/live/src/lib.rs.
 * Change both together.
 */

import { LANDMARK_QUIET_MS, landmarkNews, type News } from "./live_playbook";
import type { LiveCtx } from "./live_types";

export function scene(ctx: LiveCtx, width: number, height: number): object {
  const s = ctx.s;
  const w = s.layout!;
  const world = s.world!;
  const now = Date.now();
  const sel = s.selection;

  const news = landmarkNews(world);
  const quiet = (n: News | null) => !n || now - n.at > LANDMARK_QUIET_MS;
  const at = (id: string) => w.dots.get(id);
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
    return [{ id: a.id, x: spot.x, y: spot.y, r: spot.r, state: a.state, helpers: a.helpers + spot.swarm, selected: sel?.kind === "agent" && sel.id === a.id, hovered: s.hover === a.id, carry: s.carries.get(a.id) ?? null }];
  });

  return {
    w: width,
    h: height,
    reduced: s.reduced,
    camera: s.camera,
    // The amber `card` edge: an agent in this district waits for the owner.
    districts: w.districts.map((d) => ({ x: d.x, y: d.y, w: d.w, h: d.h, edge: d.stuck ? "stuck" : d.waiting ? "card" : "quiet", selected: sel?.kind === "room" && sel.id === d.key })),
    hub: { ...w.hub, hot: world.mac.hot, bays: w.hub.bays.map((b, i) => ({ ...b, held: !!world.mac.bays[i]?.holder })) },
    // A card with news lately is lit at its edge, so the light on the map is where work happens.
    landmarks: [
      { kind: "tower", ...w.landmarks.tower, quiet: quiet(news.tower) },
      { kind: "web", ...w.landmarks.web, quiet: quiet(news.web) },
    ],
    links,
    dots,
    fx: s.pendingFx,
  };
}
