/**
 * The game's words over the map: the day's rank and score in the bar, the feed of what the fleet
 * just did at the stage's lower left, and the banner when a mission completes. The numbers come
 * from live_game.ts. Owner, 2026-11-18: "I want it usable and nice. Gamified."
 *
 * Usable first: every feed line opens its issue or finds its unit, and the banner never takes a
 * click from the map. The feed shows the newest five, so it reads at a glance and leaves the map.
 * "All of today" opens the whole day as a list, filtered by kind, over the map's corner.
 */

import { FEED_COLOUR, STREAK, rank, type FeedItem, type FeedKind, type Tally } from "./live_game";
import { art, crest, crestKind, FLAME, insignia } from "./game_art";
import { ago, button, div, plural, span } from "./live_text";
import type { LiveCtx } from "./live_types";
import "./live_hud.css";

/** Feed lines on the stage. The rest of today is one click away. */
const FEED_ROWS = 5;
/** Lines the open feed lists at first, and adds a click. A wave day has a few hundred. */
const OPEN_ROWS = 150;
const BANNER_MS = 3800;
/** A line older than this is dimmed: the feed's eye goes to what just happened. */
const FRESH_MS = 15 * 60_000;

const BANNER: Partial<Record<FeedKind, string>> = { close: "Mission complete", rank: "Promoted", alert: "Unit needs a look", deploy: "Unit deployed" };
/** Which news a banner shows first, when one read brings several. */
const WEIGHT: Partial<Record<FeedKind, number>> = { rank: 4, alert: 3, close: 2, deploy: 1 };

type Filter = "all" | "close" | "found" | "fleet";
const FILTERS: [Filter, string, (i: FeedItem) => boolean][] = [
  ["all", "All", () => true],
  ["close", "Closes", (i) => i.kind === "close"],
  ["found", "Finds", (i) => i.kind === "found"],
  ["fleet", "Fleet", (i) => !!i.unit],
];

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
  const stat = (label: string, pace = false) => {
    const el = span("hud-stat");
    el.append(document.createElement("b"), span("", label));
    if (pace) el.append(span("hud-delta"));
    return el;
  };
  const closedEl = stat("closed", true);
  const foundEl = stat("found", true);
  const unitsEl = stat("units out");
  const tokensEl = stat("tokens");
  const streakEl = span("hud-streak");
  const fleetEl = span("hud-fleet");
  const stats = span("hud-stats");
  stats.append(closedEl, foundEl, unitsEl, tokensEl, streakEl);
  bar.append(rankEl, stats, fleetEl);

  const head = div("feed-head");
  const chips = new Map<Filter, HTMLButtonElement>();
  for (const [key, label] of FILTERS) {
    const c = button("feed-chip", label, () => {
      filter = key;
      shown = OPEN_ROWS;
      paintFeed();
      list.scrollTop = 0;
    });
    chips.set(key, c);
    head.append(c);
  }
  const less = button("feed-less", "Less", () => toggle(false));
  less.title = "Back to the newest five. Esc does it too.";
  head.append(less);
  const list = div("feed-list");
  const more = button("feed-more", "", () => toggle(true));
  const older = button("feed-more feed-older", "", () => {
    shown += OPEN_ROWS;
    paintFeed();
  });
  feedEl.append(head, list, more);
  feedEl.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) {
      e.stopPropagation();
      toggle(false);
    }
  });

  const rows = new Map<string, HTMLButtonElement>();
  const queue: FeedItem[] = [];
  let bannerUntil = 0;
  let bannerTimer = 0;
  let open = false;
  let filter: Filter = "all";
  let shown = OPEN_ROWS;
  /** The feed's height shut, which the camera keeps clear. The open list lies over the map. */
  let shut = 0;

  function toggle(on: boolean): void {
    open = on;
    filter = "all";
    shown = OPEN_ROWS;
    paintFeed();
    if (on) list.scrollTop = 0;
    (on ? chips.get("all") : more)?.focus({ preventScroll: true });
  }

  function paint(): void {
    const g = ctx.s.game;
    const sc = g.score;
    const f = ctx.s.fleet;
    const known = g.primed || g.dayPrimed;
    bar.hidden = !known;
    if (!known) return;
    if (lv.dataset.level !== String(sc.rank.level)) {
      lv.dataset.level = String(sc.rank.level);
      lv.innerHTML = insignia(sc.rank.level);
    }
    set(rk, sc.rank.name);
    const span_ = sc.rank.next ? sc.rank.next - sc.rank.floor : 1;
    fill.style.width = `${sc.rank.next ? Math.round(((sc.xp - sc.rank.floor) / span_) * 100) : 100}%`;
    set(xpText, sc.rank.next ? `${sc.xp} / ${sc.rank.next} XP` : `${sc.xp} XP`);
    const y = sc.yesterday;
    rankEl.title = `Today's rank. A closed issue is 10 XP, a filed one 3.\n${sc.closed} closed, ${sc.found} filed since midnight.${y ? `\nBy this hour yesterday: ${y.xp} XP, ${rank(y.xp).name}.` : ""}`;
    // A cut read may have lost some of today's issues: the count says "at least".
    const plus = sc.partial ? "+" : "";
    const cut = sc.partial ? "\nThe board read stopped at its limit, so the real count may be higher." : "";
    num(closedEl, `${sc.closed}${plus}`, `${sc.closed} issues closed today${sc.fleetClosed ? `, ${sc.fleetClosed} of them by the fleet` : ""}${y ? `\nBy this hour yesterday: ${y.closed}` : ""}${cut}`);
    num(foundEl, `${sc.found}${plus}`, `${sc.found} issues filed today${sc.foundBy.size ? `, ${[...sc.foundBy.values()].reduce((a, b) => a + b, 0)} of them by fleet scouts` : ""}${y ? `\nBy this hour yesterday: ${y.found}` : ""}${cut}`);
    pace(closedEl, sc.closed, y, "closed");
    pace(foundEl, sc.found, y, "found");
    num(unitsEl, String(sc.units), `${sc.units} fleet ${plural(sc.units, "unit")} running, ${sc.runs} ${plural(sc.runs, "run")} ended today`);
    num(tokensEl, tokens(sc.tokens), "Input tokens the fleet read today, ended runs and running units");
    streakEl.hidden = sc.streak < STREAK;
    if (streakEl.dataset.n !== String(sc.streak)) {
      streakEl.dataset.n = String(sc.streak);
      const n = document.createElement("b");
      n.textContent = `×${sc.streak}`;
      streakEl.replaceChildren(art("hud-flame", FLAME), n, " streak");
    }
    streakEl.title = `${sc.streak} closes in the last half hour`;
    const state = !f || f.error ? "off" : f.hold ? "hold" : f.supervisor ? "on" : "off";
    set(fleetEl, state === "on" ? "Fleet on" : state === "hold" ? "Fleet on hold" : "Fleet off");
    fleetEl.className = `hud-fleet is-${state}`;
    fleetEl.title = state === "on" ? `The supervisor runs${f?.spec ? `: ${f.spec}` : ""}` : state === "hold" ? "No new starts. Running units finish." : "No supervisor runs";
    paintFeed();
  }

  function paintFeed(): void {
    const all = ctx.s.game.items;
    const now = Date.now();
    const test = FILTERS.find(([k]) => k === filter)![2];
    const matching = open ? all.filter(test) : all;
    const items = matching.slice(0, open ? shown : FEED_ROWS);
    const left = open ? matching.length - items.length : 0;
    set(older, `Show ${Math.min(left, OPEN_ROWS)} older`);
    feedEl.hidden = !all.length;
    feedEl.classList.toggle("is-open", open);
    head.hidden = !open;
    more.hidden = open || all.length <= FEED_ROWS;
    set(more, `All of today · ${all.length}`);
    more.title = "Every close, find, deployment and flag since midnight";
    if (open) {
      for (const [key, label, t] of FILTERS) {
        const c = chips.get(key)!;
        set(c, `${label} ${all.filter(t).length}`);
        c.classList.toggle("is-on", key === filter);
        c.setAttribute("aria-pressed", String(key === filter));
      }
    }
    const want: HTMLButtonElement[] = [];
    for (const it of items) {
      let r = rows.get(it.id);
      if (!r) {
        r = button(`feed-row k-${it.kind}`, "", () => openItem(it.id));
        rows.set(it.id, r);
        if (ctx.s.game.primed && !ctx.s.reduced && !open) r.classList.add("is-in");
      }
      // A line's words can change: a find names its scout once the ledger does.
      const sig = `${it.who}\n${it.text}\n${it.xp ?? ""}`;
      if (r.dataset.sig !== sig) {
        r.dataset.sig = sig;
        // A fleet unit's line wears its class's crest. Anyone else's, a dot in the kind's colour.
        const kind = it.unit ? crestKind(it.who) : "";
        const tick = kind ? art(`feed-crest c-${kind}`, crest(kind)) : document.createElement("i");
        tick.style.setProperty("--c", FEED_COLOUR[it.kind]);
        r.replaceChildren(tick, span("feed-who", it.who), text(it.text), ...(it.xp ? [span("feed-xp", `+${it.xp} XP`)] : []), span("feed-at"));
      }
      set(r.lastElementChild as HTMLElement, ago(it.at, now).replace(" ago", ""));
      r.classList.toggle("is-old", now - it.at > FRESH_MS);
      r.title = `${it.who} ${it.text}${it.url ? "\nClick to open the issue." : it.unit ? "\nClick to find the unit." : ""}`;
      want.push(r);
    }
    const ids = new Set(all.map((i) => i.id));
    for (const id of [...rows.keys()]) if (!ids.has(id)) rows.delete(id);
    // The open list ends with a button for its older lines, when it has more than it shows.
    const kids: HTMLElement[] = left > 0 ? [...want, older] : want;
    const have = [...list.children];
    if (have.length !== kids.length || have.some((c, i) => c !== kids[i])) list.replaceChildren(...kids);
    if (!open) shut = feedEl.hidden ? 0 : feedEl.offsetHeight + 12;
  }

  /** A feed line finds its unit on the map, else opens its issue. */
  function openItem(id: string): void {
    const it = ctx.s.game.items.find((i) => i.id === id);
    if (!it) return;
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
    const more_ = big.filter((i) => i.kind === first.kind).length - 1;
    const head_ = first.head ?? (first.kind === "rank" ? first.text.replace(/^to /, "") : `${first.who} ${first.text}`);
    queue.push({ ...first, head: more_ ? `${head_} · +${more_} more` : head_ });
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
    // A promotion shows its new insignia, a unit's news its class's crest.
    const kind = crestKind(it.who);
    const pic = it.kind === "rank" ? art("ban-art is-rank", insignia(ctx.s.game.score.rank.level)) : kind && it.unit ? art(`ban-art is-crest c-${kind}`, crest(kind)) : null;
    const byEl = span("ban-by", by);
    if (it.xp && it.kind !== "rank") {
      const xp = document.createElement("b");
      xp.textContent = `+${it.xp} XP`;
      byEl.append(by ? " · " : "", xp);
    }
    const body = span("ban-body");
    body.append(span("ban-kicker", BANNER[it.kind] ?? ""), span("ban-title", it.head ?? it.text), byEl);
    bannerEl.replaceChildren(...(pic ? [pic] : []), body);
    bannerEl.className = `live-banner k-${it.kind}`;
    bannerEl.hidden = false;
    // Restart the animation for a banner that replaces one still showing.
    void bannerEl.offsetWidth;
    bannerEl.classList.add("is-on");
    bannerUntil = Date.now() + BANNER_MS;
    window.clearTimeout(bannerTimer);
    bannerTimer = window.setTimeout(next, BANNER_MS);
  }

  return { paint, play, height: () => (feedEl.hidden ? 0 : open ? shut : feedEl.offsetHeight + 12) };
}

/** Today against yesterday up to this hour: "▲12" ahead, "▼3" behind. Unknown: nothing. */
function pace(el: HTMLElement, today: number, y: Tally | null, key: "closed" | "found"): void {
  const d = el.lastElementChild as HTMLElement;
  const diff = y ? today - y[key] : 0;
  d.hidden = !y;
  set(d, diff > 0 ? `▲${diff}` : diff < 0 ? `▼${-diff}` : "=");
  d.className = `hud-delta ${diff > 0 ? "is-up" : diff < 0 ? "is-down" : ""}`;
}

/** A feed line's words, with its issue numbers in bold so the eye finds them. */
function text(t: string): HTMLElement {
  const el = span("feed-text");
  for (const [i, part] of t.split(/(#\d+)/).entries()) {
    if (!part) continue;
    if (i % 2) {
      const b = document.createElement("b");
      b.textContent = part;
      el.append(b);
    } else el.append(part);
  }
  return el;
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
