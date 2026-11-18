/**
 * Live's game layer: the fleet as a squad on the map, a score for the day, and a feed of what just
 * happened. Owner, 2026-11-18: "I want it usable and nice. Gamified." The Board stays plain
 * (2026-11-04, "no XP, streaks, quests"). The game lives here, on the broadcast.
 *
 * Every number is something that already happened: the fleet's ledger (`fleet view`, today) and
 * the board's issues closed and filed today (the scout module's overview). Nothing is stored, so
 * a reload scores the same day the same way. A closed issue is worth 10 XP and a filed one 3: the
 * fleet's job is to close work, and a find only counts once someone can build it.
 *
 * `update` turns each read into feed items. The first read of a session only primes the feed, so
 * opening Live replays no banners. Later items are `fresh`: live.ts plays their effects and the
 * banner (live_hud.ts) shows the biggest one.
 */

import type { OverviewData } from "./board";
import type { FleetView } from "./fleet";
import { cap, lensName, millions, unitName } from "./live_text";

export const XP = { close: 10, found: 3 } as const;

/**
 * The day's ranks, by XP. The fleet's wave day of 2026-11-18, 90 closes and 148 finds, ended a
 * Captain, so a General is a day that beats it by half again.
 */
const RANKS: [number, string][] = [
  [0, "Recruit"],
  [50, "Private"],
  [150, "Corporal"],
  [300, "Sergeant"],
  [500, "Staff Sergeant"],
  [750, "Lieutenant"],
  [1050, "Captain"],
  [1400, "Major"],
  [1800, "Colonel"],
  [2300, "Brigadier"],
  [3000, "General"],
];

export type Rank = { level: number; name: string; floor: number; next: number | null };

export function rank(xp: number): Rank {
  let i = 0;
  while (i + 1 < RANKS.length && xp >= RANKS[i + 1][0]) i++;
  return { level: i + 1, name: RANKS[i][1], floor: RANKS[i][0], next: RANKS[i + 1]?.[0] ?? null };
}

export type FeedKind = "close" | "found" | "deploy" | "scout" | "end" | "alert" | "rank";
export type FeedItem = {
  id: string;
  at: number;
  kind: FeedKind;
  /** Who did it, as the feed names them: "Flash 8ae149", "Hacivat". */
  who: string;
  /** What happened, after the name. */
  text: string;
  /** The issue it is about, to open. */
  number?: number;
  url?: string;
  /** The unit, to find its dot. */
  unit?: string;
  /** The project, to ring its plot when no dot is left. */
  room?: string;
  xp?: number;
  /** The banner's headline and its small line, where they differ from the feed's words. */
  head?: string;
  by?: string;
};

export type Score = {
  xp: number;
  rank: Rank;
  /** Issues closed today on the whole board, and by the fleet. */
  closed: number;
  fleetClosed: number;
  /** Issues filed today. */
  found: number;
  /** Fleet runs that ended today. */
  runs: number;
  /** Millions of input tokens the fleet used today, ended runs and running units. */
  tokens: number;
  units: number;
  /** Closes in the last half hour. Three or more is a streak. */
  streak: number;
};

export type Game = {
  /** Today's feed, newest first. */
  items: FeedItem[];
  /** New since the last read: their effects play once. */
  fresh: FeedItem[];
  score: Score;
  /** The fleet, and the board's day, were read once. */
  primed: boolean;
  dayPrimed: boolean;
  seen: Set<string>;
  /** Units seen running, so one that appears later is a deployment. */
  units: Set<string>;
  flags: Set<string>;
  level: number;
};

const STREAK_MS = 30 * 60_000;
export const STREAK = 3;
/** The feed keeps a day, which is a few hundred lines on a wave day. */
const KEEP = 400;

export function newGame(): Game {
  return { items: [], fresh: [], score: emptyScore(), primed: false, dayPrimed: false, seen: new Set(), units: new Set(), flags: new Set(), level: 1 };
}

function emptyScore(): Score {
  return { xp: 0, rank: rank(0), closed: 0, fleetClosed: 0, found: 0, runs: 0, tokens: 0, units: 0, streak: 0 };
}

/** Hours since midnight, at least one: the window today's board read asks for. */
export function hoursToday(now: number): number {
  const d = new Date(now);
  return Math.max(1, Math.ceil((now - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 3_600_000));
}

type Issue = { title: string; url?: string; room?: string };

/**
 * Reads the fleet and the day into the feed and the score. `issue` names an issue from the board
 * Live already holds, for ledger rows that carry only numbers. `place` names an app key the way
 * the map does: "solitaire_games" reads "Solitaire".
 */
export function update(g: Game, fleet: FleetView | null, day: OverviewData | null, now: number, issue: (n: number) => Issue | undefined, place: (key: string) => string = (k) => k): void {
  const all: FeedItem[] = [];
  const midnight = new Date(new Date(now).setHours(0, 0, 0, 0)).getTime();
  const cards = day?.cards ?? [];
  const card = new Map(cards.map((c) => [c.number, c]));
  const name = (n: number): Issue | undefined => {
    const c = card.get(n);
    return c ? { title: c.title, url: c.url, room: c.apps[0] } : issue(n);
  };
  /** Each issue the fleet closed today, with the ledger line that says so. */
  const byFleet = new Map<number, string>();
  let tokens = 0;
  const runs = fleet?.today ?? [];
  for (const r of runs) {
    const [h, m] = r.time.split(":").map(Number);
    const at = midnight + ((h || 0) * 60 + (m || 0)) * 60_000;
    const who = unitName(r.kind, r.unit);
    tokens += millions(r.tokens);
    const id = `run:${r.time}:${r.unit}:${r.result}`;
    if (r.closed.length) {
      for (const n of r.closed) byFleet.set(n, id);
      const first = name(r.closed[0]);
      const more = r.closed.length > 1 ? ` and ${r.closed.length - 1} more` : "";
      const head = `#${r.closed[0]}${first ? ` ${first.title}` : ""}${more}`;
      all.push({ id, at, kind: "close", who, text: `closed ${head} in ${r.minutes} min`, head, by: `${who} · ${r.minutes} min`, number: r.closed[0], url: first?.url, unit: r.unit, room: first?.room ?? (r.app && r.app !== "-" ? r.app : undefined), xp: XP.close * r.closed.length });
    } else if (/^scout /.test(r.result)) {
      const lens = r.result.replace(/^scout /, "").split(",")[0];
      const app = lens.split("@")[1];
      all.push({ id, at, kind: "scout", who, text: `came back from ${lensName(lens)}${app ? ` in ${place(app)}` : ""}, ${r.minutes} min`, unit: r.unit });
    } else {
      // "build 1924,1926, said bye" with nothing closed: it gave its issues back.
      const why = r.result.replace(/^build [\d,]+,?\s*/, "").replace(/,?\s*said bye$/, "").trim();
      all.push({ id, at, kind: "end", who, text: why ? `ended: ${why}` : `came back with nothing closed, ${r.minutes} min`, unit: r.unit });
    }
  }
  // Two runs can list the same close: the ledger counts what closed while each ran.
  const fleetClosed = byFleet.size;
  let closed = 0;
  let found = 0;
  for (const c of cards) {
    const at = c.at ? Date.parse(c.at) : now;
    if (at < midnight) continue;
    // A find filed today and closed today is still today's find: it shows as done, with `created`.
    const filed = c.kind === "new" ? (c.created ? Date.parse(c.created) : at) : c.kind === "done" && c.created ? Date.parse(c.created) : NaN;
    if (filed >= midnight) {
      found++;
      all.push({ id: `new:${c.number}`, at: filed, kind: "found", who: "Found", text: `#${c.number} ${c.title}`, number: c.number, url: c.url, room: c.apps[0], xp: XP.found });
    }
    if (c.kind === "done") {
      closed++;
      // A close the fleet ledger already told is one line, not two.
      if (!byFleet.has(c.number)) all.push({ id: `done:${c.number}`, at, kind: "close", who: closer(c.who), text: `closed #${c.number} ${c.title}`, head: `#${c.number} ${c.title}`, number: c.number, url: c.url, room: c.apps[0], xp: XP.close });
    }
  }
  // Without the board's day, the fleet's own closes still score.
  if (!day?.cards) closed = fleetClosed;

  const units = fleet?.units ?? [];
  for (const u of units) {
    tokens += millions(u.tokens);
    if (g.primed && !g.units.has(u.id)) {
      const what = u.issues[0] ? `#${u.issues[0].number} ${u.issues[0].title}` : "a scout run";
      all.push({ id: `deploy:${u.id}`, at: now, kind: "deploy", who: unitName(u.kind, u.id), text: `deployed on ${what}`, unit: u.id, number: u.issues[0]?.number });
    }
    for (const f of u.flags) {
      const key = `${u.id}:${f}`;
      if (g.primed && !g.flags.has(key)) all.push({ id: `alert:${key}`, at: now, kind: "alert", who: unitName(u.kind, u.id), text: f === "STUCK" ? "is stuck. Its screen has not moved" : f === "OVER" ? "ran past its time budget" : `is flagged ${f}`, unit: u.id });
      g.flags.add(key);
    }
  }
  if (fleet?.units) g.units = new Set(units.map((u) => u.id));

  const xp = closed * XP.close + found * XP.found;
  const r = rank(xp);
  if (g.primed && g.dayPrimed && r.level > g.level) all.push({ id: `rank:${r.level}`, at: now, kind: "rank", who: "Promoted", text: `to ${r.name}. Level ${r.level}`, xp });
  g.level = r.level;
  const streak = all.filter((i) => i.kind === "close" && now - i.at < STREAK_MS).length;
  g.score = { xp, rank: r, closed, fleetClosed, found, runs: runs.length, tokens, units: units.length, streak };

  // Items made at `now`, a deployment or a flag, keep their first time across reads.
  const had = new Map(g.items.map((i) => [i.id, i]));
  const merged = new Map(g.items.filter((i) => i.at >= midnight).map((i) => [i.id, i]));
  // The board can tell a close before the unit's ledger line does. Then the ledger's line wins.
  for (const [n, run] of byFleet) {
    merged.delete(`done:${n}`);
    // Its banner already played.
    if (g.seen.has(`done:${n}`)) g.seen.add(run);
  }
  for (const i of all) merged.set(i.id, had.get(i.id) ?? i);
  const list = [...merged.values()];
  // The fleet and the day are read apart, so each primes its own items: the day's first read must
  // not replay this morning's closes as news.
  const ready = (i: FeedItem) => (/^(done|new):/.test(i.id) ? g.dayPrimed : g.primed);
  g.fresh = list.filter((i) => !g.seen.has(i.id) && ready(i));
  for (const i of list) g.seen.add(i.id);
  g.items = list.sort((a, b) => b.at - a.at).slice(0, KEEP);
  g.primed = g.primed || !!fleet;
  g.dayPrimed = g.dayPrimed || !!day?.cards;
}

/** The board names a closer by its session: `codex-14135a7c` was a Codex session. A folk name stays. */
function closer(who: string): string {
  if (!who) return "Someone";
  const m = /^(codex|opencode|claude|grok)-/i.exec(who);
  if (!m) return who;
  return m[1].toLowerCase() === "opencode" ? "OpenCode" : cap(m[1].toLowerCase());
}

/** The feed's colour for a kind of news. */
export const FEED_COLOUR: Record<FeedKind, string> = {
  close: "var(--l-done)",
  found: "var(--l-think)",
  deploy: "var(--l-work)",
  scout: "var(--l-ink-2)",
  end: "var(--l-idle)",
  alert: "var(--l-stuck)",
  rank: "var(--l-gold)",
};
