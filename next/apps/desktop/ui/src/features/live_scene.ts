
import { LANDMARK_QUIET_MS, landmarkNews, type News } from "./live_playbook";
import { XP, type FeedItem } from "./live_game";
import { unitClass } from "./live_text";
import type { LiveAgent, LiveCtx, State } from "./live_types";

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
    const family = world.agents.filter((a) => a.id === f.parent || a.parent === f.id || (f.commander && a.fleet) || (f.fleet && a.commander));
    for (const o of family) {
      const op = at(o.id);
      if (op && (op.x !== fp.x || op.y !== fp.y)) links.push({ x1: fp.x, y1: fp.y, x2: op.x, y2: op.y });
    }
  }

  const crew = new Map<string, State[]>();
  for (const a of world.agents) {
    const on = w.dots.get(a.id)?.on;
    if (on) crew.set(on, [...(crew.get(on) ?? []), a.state]);
  }
  const dots = world.agents.flatMap((a) => {
    const spot = w.dots.get(a.id);
    if (!spot || spot.swarm < 0) return [];
    return [{
      id: a.id, x: spot.x, y: spot.y, r: spot.r, state: a.state, helpers: a.helpers + spot.swarm,
      selected: sel?.kind === "agent" && sel.id === a.id, hovered: s.hover === a.id, carry: s.carries.get(a.id) ?? null,
      act: act(a), crew: crew.get(a.id) ?? [], pings: s.pings.get(a.id) ?? 0, calls: s.calls.get(a.id) ?? 0,
      ship: shipOf(a), tint: tintOf(a, ctx.stage),
    }];
  });

  return {
    w: width,
    h: height,
    reduced: s.reduced,
    camera: s.camera,
    districts: w.districts.map((d) => ({ x: d.x, y: d.y, w: d.w, h: d.h, edge: d.stuck ? "stuck" : d.waiting ? "card" : "quiet", selected: sel?.kind === "room" && sel.id === d.key, px: d.planet.x, py: d.planet.y, ...planetLook(d.key), trophies: closedToday(s.game.items, d.key) })),
    hub: { ...w.hub, hot: world.mac.hot, bays: w.hub.bays.map((b, i) => ({ ...b, held: !!world.mac.bays[i]?.holder })) },
    landmarks: [
      { kind: "tower", ...w.landmarks.tower, quiet: quiet(news.tower) },
      { kind: "web", ...w.landmarks.web, quiet: quiet(news.web) },
    ],
    links,
    dots,
    fx: s.pendingFx,
  };
}

const ACTS: Record<string, string> = {
  edit: "make", build: "make", render: "make", "git.commit": "make",
  read: "look", search: "look", web: "look", review: "look", skill: "look",
  test: "check", typecheck: "check", shot: "check",
  message: "say", spawn: "say", ask: "say", board: "say",
};

export type ShipKind = "flag" | "cruiser" | "builder" | "scout" | "drone";

export function shipOf(a: LiveAgent): ShipKind {
  if (a.commander) return "flag";
  if (a.fleet) return a.fleet.scout ? "scout" : "builder";
  return a.parent || a.headless ? "drone" : "cruiser";
}

const PLANET_HUES = ["#4fb3ff", "#7ce0a3", "#ffb86b", "#c79bff", "#ff8fa3", "#5fe0d0", "#e8d27a", "#9fb4ff"];

function hashOf(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function planetLook(key: string): { hue: string; ringed: boolean; bands: number } {
  const h = hashOf(key);
  return { hue: PLANET_HUES[h % PLANET_HUES.length], ringed: (h >>> 8) % 3 === 0, bands: (h >>> 12) % 4 };
}

const flat = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");

export function closedToday(items: FeedItem[], room: string): number {
  const key = flat(room);
  const seen = new Map<string, number>();
  for (const it of items) {
    if (it.kind !== "close" || !it.room || flat(it.room) !== key) continue;
    const id = it.number != null ? `#${it.number}` : it.id;
    seen.set(id, Math.max(seen.get(id) ?? 0, Math.max(1, Math.round((it.xp ?? XP.close) / XP.close))));
  }
  let n = 0;
  for (const c of seen.values()) n += c;
  return n;
}

const tints = new Map<string, string>();

function tintOf(a: LiveAgent, stage: HTMLElement): string {
  const token = a.commander ? "--l-gold" : a.fleet ? (/var\((--[\w-]+)\)/.exec(unitClass(a.fleet.kind).colour)?.[1] ?? "--l-ink-2") : a.parent || a.headless ? "--l-ink-3" : "--l-think";
  let hex = tints.get(token);
  if (!hex) {
    hex = getComputedStyle(stage).getPropertyValue(token).trim() || "#9aa4b6";
    tints.set(token, hex);
  }
  return hex;
}

function act(a: LiveAgent): string | null {
  if (a.state === "think") return "think";
  if (a.state !== "work") return null;
  const v = a.now?.verb ?? "";
  return ACTS[v] ?? (v.startsWith("mcp.") ? "look" : "make");
}
