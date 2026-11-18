/**
 * The game's words over the map: the day's rank and score in the bar, the feed of what the fleet
 * just did at the stage's lower left, and the banner when a mission completes. The numbers come
 * from live_game.ts. Owner, 2026-11-18: "I want it usable and nice. Gamified."
 *
 * Usable first: every feed line opens its issue or finds its unit, and the banner never takes a
 * click from the map. The feed shows the newest five, so it reads at a glance and leaves the map.
 */

import { FEED_COLOUR, STREAK, type FeedItem, type FeedKind } from "./live_game";
import { ago, button, div, plural, span } from "./live_text";
import type { LiveCtx } from "./live_types";
import "./live_hud.css";

/** Feed lines on the stage. The rest of today is one hover away, in each line's tooltip. */
const FEED_ROWS = 5;
const BANNER_MS = 3800;
/** A line older than this is dimmed: the feed's eye goes to what just happened. */
const FRESH_MS = 15 * 60_000;

const BANNER: Partial<Record<FeedKind, string>> = { close: "Mission complete", rank: "Promoted", alert: "Unit needs a look", deploy: "Unit deployed" };
/** Which news a banner shows first, when one read brings several. */
const WEIGHT: Partial<Record<FeedKind, number>> = { rank: 4, alert: 3, close: 2, deploy: 1 };

export type Hud = { paint(): void; play(fresh: FeedItem[]): void; height(): number };

export function mountHud(ctx: LiveCtx, bar: HTMLElement, feedEl: HTMLElement, bannerEl: HTMLElement): Hud {
  const lv = span("hud-lv");
  const rk = span("hud-rk-name");
  const fill = document.createElement("i");
  const meter = span("hud-xp");
  meter.append(fill);
  const xpText = span("hud-xp-text");
  const rankEl = div("hud-rank");
  const rkCol = span("hud-rk");
  rkCol.append(rk, meter, xpText);
  rankEl.append(lv, rkCol);
  const stat = (label: string) => {
    const el = span("hud-stat");
    el.append(document.createElement("b"), span("", label));
    return el;
  };
  const closedEl = stat("closed");
  const foundEl = stat("found");
  const unitsEl = stat("units out");
  const tokensEl = stat("tokens");
  const streakEl = span("hud-streak");
  const fleetEl = span("hud-fleet");
  const stats = span("hud-stats");
  stats.append(closedEl, foundEl, unitsEl, tokensEl, streakEl);
  bar.append(rankEl, stats, fleetEl);

  const rows = new Map<string, HTMLButtonElement>();
  const queue: FeedItem[] = [];
  let bannerUntil = 0;
  let bannerTimer = 0;

  function paint(): void {
    const g = ctx.s.game;
    const sc = g.score;
    const f = ctx.s.fleet;
    const known = g.primed || g.dayPrimed;
    bar.hidden = !known;
    if (!known) return;
    set(lv, String(sc.rank.level));
    set(rk, sc.rank.name);
    const span_ = sc.rank.next ? sc.rank.next - sc.rank.floor : 1;
    fill.style.width = `${sc.rank.next ? Math.round(((sc.xp - sc.rank.floor) / span_) * 100) : 100}%`;
    set(xpText, sc.rank.next ? `${sc.xp} / ${sc.rank.next} XP` : `${sc.xp} XP`);
    rankEl.title = `Today's rank. A closed issue is 10 XP, a filed one 3.\n${sc.closed} closed, ${sc.found} filed since midnight.`;
    num(closedEl, String(sc.closed), sc.fleetClosed ? `${sc.closed} issues closed today, ${sc.fleetClosed} of them by the fleet` : `${sc.closed} issues closed today`);
    num(foundEl, String(sc.found), `${sc.found} issues filed today`);
    num(unitsEl, String(sc.units), `${sc.units} fleet ${plural(sc.units, "unit")} running, ${sc.runs} ${plural(sc.runs, "run")} ended today`);
    num(tokensEl, tokens(sc.tokens), "Input tokens the fleet read today, ended runs and running units");
    streakEl.hidden = sc.streak < STREAK;
    set(streakEl, `×${sc.streak} streak`);
    streakEl.title = `${sc.streak} closes in the last half hour`;
    const state = !f || f.error ? "off" : f.hold ? "hold" : f.supervisor ? "on" : "off";
    set(fleetEl, state === "on" ? "Fleet on" : state === "hold" ? "Fleet on hold" : "Fleet off");
    fleetEl.className = `hud-fleet is-${state}`;
    fleetEl.title = state === "on" ? `The supervisor runs${f?.spec ? `: ${f.spec}` : ""}` : state === "hold" ? "No new starts. Running units finish." : "No supervisor runs";
    paintFeed();
  }

  function paintFeed(): void {
    const items = ctx.s.game.items.slice(0, FEED_ROWS);
    const now = Date.now();
    feedEl.hidden = !items.length;
    const want: HTMLButtonElement[] = [];
    for (const it of items) {
      let r = rows.get(it.id);
      if (!r) {
        r = button(`feed-row k-${it.kind}`, "", () => open(it));
        const tick = document.createElement("i");
        tick.style.setProperty("--c", FEED_COLOUR[it.kind]);
        r.append(tick, span("feed-who", it.who), span("feed-text", it.text));
        if (it.xp) r.append(span("feed-xp", `+${it.xp}`));
        r.append(span("feed-at"));
        rows.set(it.id, r);
        if (ctx.s.game.primed && !ctx.s.reduced) r.classList.add("is-in");
      }
      set(r.lastElementChild as HTMLElement, ago(it.at, now).replace(" ago", ""));
      r.classList.toggle("is-old", now - it.at > FRESH_MS);
      r.title = `${it.who} ${it.text}${it.url ? "\nClick to open the issue." : it.unit ? "\nClick to find the unit." : ""}`;
      want.push(r);
    }
    for (const id of [...rows.keys()]) if (!items.some((i) => i.id === id)) rows.delete(id);
    const have = [...feedEl.children];
    if (have.length !== want.length || have.some((c, i) => c !== want[i])) feedEl.replaceChildren(...want);
  }

  /** A feed line finds its unit on the map, else opens its issue. */
  function open(it: FeedItem): void {
    const a = it.unit ? ctx.s.world?.agents.find((x) => x.fleet?.unit === it.unit) : undefined;
    if (a) ctx.select({ kind: "agent", id: a.id });
    else if (it.url) ctx.events.openUrl(it.url);
    else if (it.room && ctx.s.layout?.districts.some((d) => d.key === it.room)) ctx.select({ kind: "room", id: it.room });
    else ctx.toast(it.unit ? "That unit has ended." : "Nothing to open for this line.");
  }

  function play(fresh: FeedItem[]): void {
    const big = fresh.filter((i) => BANNER[i.kind]).sort((a, b) => (WEIGHT[b.kind] ?? 0) - (WEIGHT[a.kind] ?? 0));
    if (!big.length) return;
    // One banner a kind per read: three closes at once are "Mission complete" with "+2 more".
    const first = big[0];
    const more = big.filter((i) => i.kind === first.kind).length - 1;
    const head = first.head ?? (first.kind === "rank" ? first.text.replace(/^to /, "") : `${first.who} ${first.text}`);
    queue.push({ ...first, head: more ? `${head} · +${more} more` : head });
    if (queue.length > 3) queue.splice(0, queue.length - 3);
    if (Date.now() > bannerUntil) next();
  }

  function next(): void {
    const it = queue.shift();
    if (!it) {
      bannerEl.hidden = true;
      return;
    }
    const by = it.by ?? (it.kind === "rank" || it.kind === "alert" || it.kind === "deploy" ? "" : it.who);
    bannerEl.replaceChildren(span("ban-kicker", BANNER[it.kind] ?? ""), span("ban-title", it.head ?? it.text), span("ban-by", [by, it.xp && it.kind !== "rank" ? `+${it.xp} XP` : ""].filter(Boolean).join(" · ")));
    bannerEl.className = `live-banner k-${it.kind}`;
    bannerEl.hidden = false;
    // Restart the animation for a banner that replaces one still showing.
    void bannerEl.offsetWidth;
    bannerEl.classList.add("is-on");
    bannerUntil = Date.now() + BANNER_MS;
    window.clearTimeout(bannerTimer);
    bannerTimer = window.setTimeout(next, BANNER_MS);
  }

  return { paint, play, height: () => (feedEl.hidden ? 0 : feedEl.offsetHeight + 12) };
}

function num(el: HTMLElement, value: string, title: string): void {
  set(el.firstElementChild as HTMLElement, value);
  el.title = title;
}

/** Millions as the bar shows them: 0.8M, 48M, 1.2B. */
function tokens(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(1)}B`;
  return m >= 10 ? `${Math.round(m)}M` : `${m.toFixed(1)}M`;
}

function set(el: HTMLElement, t: string): void {
  if (el.textContent !== t) el.textContent = t;
}
