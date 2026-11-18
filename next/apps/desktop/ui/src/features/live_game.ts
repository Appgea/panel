/**
 * Live's game layer: the fleet as a squad on the map, a score for the day, and a feed of what just
 * happened. Owner, 2026-11-18: "I want it usable and nice. Gamified." The Board stays plain
 * (2026-11-04, "no XP, streaks, quests"). The game lives here, on the broadcast.
 *
 * Every number is something that already happened: the fleet's ledger (`fleet view`, today) and
 * the board's issues closed and filed since yesterday's midnight (the scout module's overview).
 * Nothing is stored, so a reload scores the same day the same way. A closed issue is worth 10 XP
 * and a filed one 3: the fleet's job is to close work, and a find only counts once someone can
 * build it. A find names the scout run that filed it ("Scout: legal@VideoKit" in its body), so a
 * scout unit earns its finds as a builder earns its closes. Yesterday up to this hour is the
 * pace to beat.
 *
 * `update` turns each read into feed items. The first read of a session only primes the feed, so
 * opening Live replays no banners. Later items are `fresh`: live.ts plays their effects and the
 * banner (live_hud.ts) shows the biggest one.
 */

import type { OverviewCard, OverviewData } from "./board";
import type { FleetView } from "./fleet";
import { appName, cap, lensName, millions, unitName } from "./live_text";

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

/** The day so far: today's and yesterday's up to the same hour. */
export type Tally = { closed: number; found: number; xp: number };

export type Score = Tally & {
  rank: Rank;
  /** Issues closed today by the fleet. */
  fleetClosed: number;
  /** Fleet runs that ended today. */
  runs: number;
  /** Millions of input tokens the fleet used today, ended runs and running units. */
  tokens: number;
  units: number;
  /** Closes in the last half hour. Three or more is a streak. */
  streak: number;
  /** Finds today by unit id, for the squad's table. */
  foundBy: Map<string, number>;
  /** Yesterday up to this hour. Unknown when the read does not reach back or was cut short. */
  yesterday: Tally | null;
  /** The board read stopped at its limit, so today's counts may be low. */
  partial: boolean;
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
/** A scout's ledger line is written as it ends. What it filed in its run, give or take this, is its. */
const SLACK_MS = 2 * 60_000;

export function newGame(): Game {
  return { items: [], fresh: [], score: emptyScore(), primed: false, dayPrimed: false, seen: new Set(), units: new Set(), flags: new Set(), level: 1 };
}

function emptyScore(): Score {
  return { xp: 0, rank: rank(0), closed: 0, fleetClosed: 0, found: 0, runs: 0, tokens: 0, units: 0, streak: 0, foundBy: new Map(), yesterday: null, partial: false };
}

/** Hours back to a midnight, today's (0) or yesterday's (1): the window the day's board read asks for. */
export function hoursBack(now: number, days: 0 | 1 = 1): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return Math.max(1, Math.ceil((now - d.getTime()) / 3_600_000));
}

type Issue = { title: string; url?: string; room?: string };
type Scout = { unit: string; kind: string; since: number };

/** One read of what Live knows. */
export type Read = {
  fleet: FleetView | null;
  day: OverviewData | null;
  now: number;
  /** Names an issue from the board Live already holds, for ledger rows that carry only numbers. */
  issue?: (n: number) => Issue | undefined;
  /** Names an app key the way the map does: "solitaire_games" reads "Solitaire Games". */
  place?: (key: string) => string;
  /** Running scout units by lens, lower case: "legal@videokit". */
  scouts?: Map<string, Scout>;
};

/** Reads the fleet and the day into the feed and the score. */
export function update(g: Game, read: Read): void {
  const { fleet, day, now } = read;
  const place = read.place ?? appName;
  const all: FeedItem[] = [];
  const midnight = new Date(new Date(now).setHours(0, 0, 0, 0)).getTime();
  const yDay = new Date(midnight);
  yDay.setDate(yDay.getDate() - 1);
  const yMid = yDay.getTime();
  const yNow = now - (midnight - yMid);
  const cards = day?.cards ?? [];
  const card = new Map(cards.map((c) => [c.number, c]));
  const name = (n: number): Issue | undefined => {
    const c = card.get(n);
    return c ? { title: c.title, url: c.url, room: c.apps[0] } : read.issue?.(n);
  };
  /** Each issue the fleet closed today, with the ledger line that says so. */
  const byFleet = new Map<number, string>();
  /** Scout runs that ended today, with the time they ran, to credit what they filed. */
  const scoutRuns: (Scout & { lens: string; until: number })[] = [];
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
      const lens = r.result.replace(/^scout /, "").split(",")[0].trim();
      const app = lens.split("@")[1];
      scoutRuns.push({ lens: lens.toLowerCase(), unit: r.unit, kind: r.kind, since: at - r.minutes * 60_000 - SLACK_MS, until: at + SLACK_MS });
      all.push({ id, at, kind: "scout", who, text: `came back from ${lensName(lens)}${app ? ` in ${place(app)}` : ""}, ${r.minutes} min`, unit: r.unit, room: app });
    } else {
      // "build 1924,1926, said bye" with nothing closed: it gave its issues back.
      const why = r.result.replace(/^build [\d,]+,?\s*/, "").replace(/,?\s*said bye$/, "").trim();
      all.push({ id, at, kind: "end", who, text: why ? `ended: ${why}` : `came back with nothing closed, ${r.minutes} min`, unit: r.unit });
    }
  }
  /** The unit that filed a find: the scout run of its lens that ran then, ended or running. */
  const credit = (c: OverviewCard, filed: number): Scout | undefined => {
    const lens = c.scout?.toLowerCase();
    if (!lens) return undefined;
    const live = read.scouts?.get(lens);
    return scoutRuns.find((s) => s.lens === lens && filed >= s.since && filed <= s.until) ?? (live && filed >= live.since - SLACK_MS ? live : undefined);
  };
  // Two runs can list the same close: the ledger counts what closed while each ran.
  const fleetClosed = byFleet.size;
  const foundBy = new Map<string, number>();
  const today: Tally = { closed: 0, found: 0, xp: 0 };
  const before: Tally = { closed: 0, found: 0, xp: 0 };
  for (const c of cards) {
    const at = c.at ? Date.parse(c.at) : now;
    // A find closed since is still a find: it shows as done, with `created`. A dropped one is not.
    const filed = c.kind === "dropped" ? NaN : c.created ? Date.parse(c.created) : c.kind === "new" ? at : NaN;
    if (filed >= yMid && filed < yNow) before.found++;
    if (c.kind === "done" && at >= yMid && at < yNow) before.closed++;
    if (filed >= midnight) {
      today.found++;
      const by = credit(c, filed);
      if (by) foundBy.set(by.unit, (foundBy.get(by.unit) ?? 0) + 1);
      const who = by ? unitName(by.kind, by.unit) : c.scout ? `${lensName(c.scout)} scout` : "Found";
      all.push({ id: `new:${c.number}`, at: filed, kind: "found", who, text: who === "Found" ? `#${c.number} ${c.title}` : `found #${c.number} ${c.title}`, number: c.number, url: c.url, unit: by?.unit, room: c.apps[0], xp: XP.found });
    }
    if (c.kind === "done" && at >= midnight) {
      today.closed++;
      // A close the fleet ledger already told is one line, not two.
      if (!byFleet.has(c.number)) all.push({ id: `done:${c.number}`, at, kind: "close", who: closer(c.who), text: `closed #${c.number} ${c.title}`, head: `#${c.number} ${c.title}`, number: c.number, url: c.url, room: c.apps[0], xp: XP.close });
    }
  }
  // Without the board's day, the fleet's own closes still score.
  if (!day?.cards) today.closed = fleetClosed;
  today.xp = today.closed * XP.close + today.found * XP.found;
  before.xp = before.closed * XP.close + before.found * XP.found;
  // Each of the read's two lists stops at `limit`, cut by when the issue was filed, not closed: a
  // full one may have lost any of the window's issues, today's included.
  const cut = day?.limit !== undefined && (cards.filter((c) => c.kind === "new").length >= day.limit || cards.filter((c) => c.kind !== "new").length >= day.limit);
  const reaches = !!day?.since && Date.parse(day.since) <= yMid + 60_000;

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

  const r = rank(today.xp);
  if (g.primed && g.dayPrimed && r.level > g.level) all.push({ id: `rank:${r.level}`, at: now, kind: "rank", who: "Promoted", text: `to ${r.name}. Level ${r.level}`, xp: today.xp });
  g.level = r.level;
  const streak = all.filter((i) => i.kind === "close" && now - i.at < STREAK_MS).length;
  g.score = { ...today, rank: r, fleetClosed, runs: runs.length, tokens, units: units.length, streak, foundBy, yesterday: day?.cards && reaches && !cut ? before : null, partial: cut };

  // A line keeps its first time across reads: a deployment or a flag is stamped when first seen.
  // Its words follow the latest read, so a find names its scout once the ledger does.
  const had = new Map(g.items.map((i) => [i.id, i]));
  const merged = new Map(g.items.filter((i) => i.at >= midnight).map((i) => [i.id, i]));
  // The board can tell a close before the unit's ledger line does. Then the ledger's line wins.
  for (const [n, run] of byFleet) {
    merged.delete(`done:${n}`);
    // Its banner already played.
    if (g.seen.has(`done:${n}`)) g.seen.add(run);
  }
  for (const i of all) {
    const old = had.get(i.id);
    merged.set(i.id, old ? { ...i, at: old.at } : i);
  }
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
