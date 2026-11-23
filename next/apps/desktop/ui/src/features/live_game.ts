
import type { OverviewCard, OverviewData } from "./board";
import type { FleetView } from "./fleet";
import { appName, cap, lensName, millions, unitName } from "./live_text";

export const XP = { close: 10, found: 3 } as const;

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
  who: string;
  text: string;
  number?: number;
  url?: string;
  unit?: string;
  room?: string;
  xp?: number;
  head?: string;
  by?: string;
};

export type Tally = { closed: number; found: number; xp: number };

export type Score = Tally & {
  rank: Rank;
  fleetClosed: number;
  runs: number;
  tokens: number;
  units: number;
  streak: number;
  foundBy: Map<string, number>;
  yesterday: Tally | null;
  partial: boolean;
};

export type Game = {
  items: FeedItem[];
  fresh: FeedItem[];
  score: Score;
  primed: boolean;
  dayPrimed: boolean;
  seen: Set<string>;
  units: Set<string>;
  flags: Set<string>;
  level: number;
};

const STREAK_MS = 30 * 60_000;
export const STREAK = 3;
const KEEP = 400;
const SLACK_MS = 2 * 60_000;

export function newGame(): Game {
  return { items: [], fresh: [], score: emptyScore(), primed: false, dayPrimed: false, seen: new Set(), units: new Set(), flags: new Set(), level: 1 };
}

function emptyScore(): Score {
  return { xp: 0, rank: rank(0), closed: 0, fleetClosed: 0, found: 0, runs: 0, tokens: 0, units: 0, streak: 0, foundBy: new Map(), yesterday: null, partial: false };
}

export function hoursBack(now: number, days: 0 | 1 = 1): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return Math.max(1, Math.ceil((now - d.getTime()) / 3_600_000));
}

type Issue = { title: string; url?: string; room?: string };
type Scout = { unit: string; kind: string; since: number };

export type Read = {
  fleet: FleetView | null;
  day: OverviewData | null;
  now: number;
  issue?: (n: number) => Issue | undefined;
  place?: (key: string) => string;
  scouts?: Map<string, Scout>;
};

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
  const byFleet = new Map<number, string>();
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
      all.push({ id, at, kind: "scout", who, text: `${lensName(lens)} scout finished${app ? ` in ${place(app)}` : ""}, ${r.minutes} min`, unit: r.unit, room: app });
    } else {
      const why = r.result.replace(/^build [\d,]+,?\s*/, "").replace(/,?\s*said bye$/, "").trim();
      all.push({ id, at, kind: "end", who, text: why ? `ended: ${why}` : `ended with nothing closed, ${r.minutes} min`, unit: r.unit });
    }
  }
  const credit = (c: OverviewCard, filed: number): Scout | undefined => {
    const lens = c.scout?.toLowerCase();
    if (!lens) return undefined;
    const live = read.scouts?.get(lens);
    return scoutRuns.find((s) => s.lens === lens && filed >= s.since && filed <= s.until) ?? (live && filed >= live.since - SLACK_MS ? live : undefined);
  };
  const fleetClosed = byFleet.size;
  const foundBy = new Map<string, number>();
  const today: Tally = { closed: 0, found: 0, xp: 0 };
  const before: Tally = { closed: 0, found: 0, xp: 0 };
  for (const c of cards) {
    const at = c.at ? Date.parse(c.at) : now;
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
      if (!byFleet.has(c.number)) all.push({ id: `done:${c.number}`, at, kind: "close", who: closer(c.who), text: `closed #${c.number} ${c.title}`, head: `#${c.number} ${c.title}`, number: c.number, url: c.url, room: c.apps[0], xp: XP.close });
    }
  }
  if (!day?.cards) today.closed = fleetClosed;
  today.xp = today.closed * XP.close + today.found * XP.found;
  before.xp = before.closed * XP.close + before.found * XP.found;
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

  const had = new Map(g.items.map((i) => [i.id, i]));
  const merged = new Map(g.items.filter((i) => i.at >= midnight).map((i) => [i.id, i]));
  for (const [n, run] of byFleet) {
    merged.delete(`done:${n}`);
    if (g.seen.has(`done:${n}`)) g.seen.add(run);
  }
  for (const i of all) {
    const old = had.get(i.id);
    merged.set(i.id, old ? { ...i, at: old.at } : i);
  }
  const list = [...merged.values()];
  const ready = (i: FeedItem) => (/^(done|new):/.test(i.id) ? g.dayPrimed : g.primed);
  g.fresh = list.filter((i) => !g.seen.has(i.id) && ready(i));
  for (const i of list) g.seen.add(i.id);
  g.items = list.sort((a, b) => b.at - a.at).slice(0, KEEP);
  g.primed = g.primed || !!fleet;
  g.dayPrimed = g.dayPrimed || !!day?.cards;
}

function closer(who: string): string {
  if (!who) return "Someone";
  const m = /^(codex|opencode|claude|grok)-/i.exec(who);
  if (!m) return who;
  return m[1].toLowerCase() === "opencode" ? "OpenCode" : cap(m[1].toLowerCase());
}

export const FEED_COLOUR: Record<FeedKind, string> = {
  close: "var(--l-done)",
  found: "var(--l-think)",
  deploy: "var(--l-work)",
  scout: "var(--l-ink-2)",
  end: "var(--l-idle)",
  alert: "var(--l-stuck)",
  rank: "var(--l-gold)",
};
