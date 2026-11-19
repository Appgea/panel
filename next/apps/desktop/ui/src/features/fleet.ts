/**
 * AI fleet: the cheap builders the fleet runs, one card a unit with what it is doing right now, and
 * under them what the fleet ended today. Owner, 2026-11-17: "I want them on my AppgeaPanel, visible
 * any time I open the appgea panel under an AI fleet tab. So that I can check that on demand".
 * Owner, 2026-11-19: "make it nicer and more understandable", then "the graphics and gamification
 * must be way stronger. Text can have some bold and italic parts."
 *
 * The top is the day as a game, scored the way Live scores it (live_game.ts), so both screens
 * name the same rank: the rank's insignia and XP, today's counters against yesterday, the classes
 * ranked by XP, and the run of the day. A card leads with the unit's mission, what closing it
 * earns, and the last sentence it wrote to a person. Its time against its budget is a bar. Its raw
 * terminal is one click away: a CLI screen is mostly tool calls and an input box.
 *
 * The units run in tmux, outside Panel (ops `runbooks/fleet.py`). This screen only reads `fleet view`
 * through the fleet module, and the board's day through the scout module when it is there: it keeps
 * no terminal, so a unit costs Panel no memory, and quitting Panel ends nothing. It reads when it
 * opens and every few seconds while it is the screen on the glass. Hidden, it asks for nothing. It
 * only shows: starting and stopping the fleet stays a thing he asks for.
 */
import { errorText } from "../errors";
import type { OverviewData } from "./board";
import { CLASS, className, duration, marks, mission, runLine, said, tidy, tokens } from "./fleet_words";
import { art, crest, FLAME, insignia, STAR, tier } from "./game_art";
import { hoursBack, newGame, rank, STREAK, update, XP, type Tally } from "./live_game";
import "./fleet.css";

export type FleetUnit = {
  id: string;
  kind: string;
  app: string | null;
  /** A scout's routine, like `legal@TavlaSkor`. Empty for a builder. */
  scout?: string;
  issues: { number: number; title: string }[];
  minutes: number;
  budget: number;
  tokens: string;
  quiet: number;
  flags: string[];
  screen: string;
};
export type FleetRun = {
  time: string;
  unit: string;
  kind: string;
  app: string;
  closed: number[];
  minutes: number;
  tokens: string;
  result: string;
};
export type FleetView = {
  supervisor?: boolean;
  hold?: boolean;
  spec?: string;
  units?: FleetUnit[];
  today?: FleetRun[];
  error?: string;
};
export type FleetEvents = {
  view(): Promise<FleetView>;
  /** The board's closes and finds since a number of hours back, for the score. Without it the fleet's own closes score. */
  day?(hours: number): Promise<OverviewData | null>;
  openIssue?(number: number): void;
};
export type FleetHandle = { open(): void; clear(): void; dispose(): void };

const EVERY = 5_000;
/** The board's day is a GitHub search: once a minute, as Live reads it. */
const DAY_EVERY = 60_000;
/** Today's runs listed at first. A wave day ends a few hundred. */
const RUNS = 30;
/** A unit this long without output reads as quiet. */
const QUIET_MIN = 5;
/** A close this fast earns its row a Speedrun badge. */
const SPEEDRUN_MIN = 10;
/** Flags as `fleet status` prints them, as words. */
const FLAG: Record<string, string> = { OVER: "Over time", STUCK: "Stuck" };

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text) el.textContent = text;
  return el;
};
const set = (el: HTMLElement, text: string): void => {
  if (el.textContent !== text) el.textContent = text;
};
const t = (text: string): Text => document.createTextNode(text);
const kindClass = (kind: string): string => `c-${CLASS[kind] ? kind : "other"}`;
/** A class's crest on a tile in its colour. */
const crestTile = (kind: string, cls = "fl-crest"): HTMLElement => art(`${cls} ${kindClass(kind)}`, crest(kind));
/** A sentence with an agent's own bold, italic and code kept. */
const rich = (text: string): Node[] => marks(text).map((m) => (m.mark ? h(m.mark === "b" ? "b" : m.mark === "i" ? "i" : "code", "", m.text) : t(m.text)));

type Card = {
  root: HTMLElement;
  crest: HTMLElement;
  chip: HTMLElement;
  app: HTMLElement;
  title: HTMLElement;
  more: HTMLElement;
  flags: HTMLElement;
  bounty: HTMLElement;
  said: HTMLElement;
  fill: HTMLElement;
  time: HTMLElement;
  facts: HTMLElement;
  term: HTMLDetailsElement;
  screen: HTMLElement;
};
type Filter = "all" | "closed" | "scout" | "none";
type Counter = { root: HTMLElement; value: HTMLElement; delta: HTMLElement };

export function mountFleet(screen: HTMLElement, events: FleetEvents): FleetHandle {
  let visible = false;
  let busy = false;
  let timer: number | undefined;
  let last: FleetView | null = null;
  let filter: Filter = "all";
  let shown = RUNS;
  const cards = new Map<string, Card>();
  const game = newGame();
  let day: OverviewData | null = null;
  let dayAt = 0;
  /** The date whose two-day read was cut at its limit: the rest of that day reads today alone. */
  let shortDay = "";

  // Head: the name, whether the fleet runs, its slots, and when it was read.
  const state = h("span", "fl-state");
  const slots = h("span", "fl-slots");
  const stamp = h("span", "fl-stamp");
  const heading = h("div", "fl-heading");
  heading.append(h("h1", "", "AI fleet"), state, slots);
  const header = h("header", "fl-header");
  header.append(heading, stamp);
  const error = h("p", "fl-error");
  error.hidden = true;

  // The hero: today's rank as an insignia with its XP, the counters, the streak.
  const badge = h("span", "fl-insignia");
  const level = h("span", "fl-kicker");
  const rankName = h("b", "fl-rank-name");
  const xpFill = h("i");
  const xpBar = h("div", "fl-xpbar");
  xpBar.append(xpFill);
  const xpText = h("p", "fl-xp-text");
  const rankCol = h("div", "fl-rank-col");
  rankCol.append(level, rankName, xpBar, xpText);
  const rankBox = h("div", "fl-rank");
  rankBox.append(badge, rankCol);
  const counter = (label: string): Counter => {
    const root = h("div", "fl-count");
    const value = h("b");
    const delta = h("span", "fl-delta");
    delta.hidden = true;
    const top = h("span", "fl-count-top");
    top.append(value, delta);
    root.append(top, h("span", "fl-count-label", label));
    return { root, value, delta };
  };
  const cClosed = counter("closed");
  const cFound = counter("found");
  const cRuns = counter("runs");
  const cTokens = counter("tokens");
  const cTime = counter("unit time");
  const counters = h("div", "fl-counts");
  counters.append(cClosed.root, cFound.root, cRuns.root, cTokens.root, cTime.root);
  const streak = h("span", "fl-streak");
  streak.hidden = true;
  const hero = h("section", "fl-hero");
  hero.append(rankBox, counters, streak);

  // The squad: each class ranked by the XP its runs earned today, and the run of the day.
  const squadList = h("ol", "fl-board");
  const squadBox = h("div", "fl-board-box");
  squadBox.append(h("h2", "fl-section", "Squad today"), squadList);
  const mvp = h("div", "fl-mvp");
  const squad = h("section", "fl-squad");
  squad.append(squadBox, mvp);

  const unitsHead = h("h2", "fl-section");
  const units = h("div", "fl-units");
  const empty = h("p", "fl-empty", "Reading the fleet…");

  const todayHead = h("div", "fl-today-head");
  const todayTitle = h("h2", "fl-section");
  const chips = h("div", "fl-chips");
  chips.setAttribute("role", "group");
  chips.setAttribute("aria-label", "Show runs");
  todayHead.append(todayTitle, chips);
  const today = h("div", "fl-runs");
  const moreRuns = h("button", "fl-more");
  moreRuns.type = "button";
  moreRuns.addEventListener("click", () => {
    shown += RUNS * 4;
    if (last) paintToday(last.today ?? []);
  });

  const body = h("div", "fl-body");
  body.append(hero, squad, unitsHead, units, empty, todayHead, today, moreRuns);
  screen.replaceChildren(header, error, body);

  const issueLink = (n: number, cls = "fl-issue"): HTMLElement => {
    if (!events.openIssue) return h("span", cls, `#${n}`);
    const b = h("button", `${cls} is-link`, `#${n}`);
    b.type = "button";
    b.title = `Open #${n} on GitHub`;
    b.addEventListener("click", () => events.openIssue!(n));
    return b;
  };

  function card(unit: FleetUnit): Card {
    let c = cards.get(unit.id);
    if (c) return c;
    const root = h("article", "fl-unit");
    const top = h("header", "fl-unit-top");
    const crestEl = h("span");
    const chip = h("span", "fl-chip");
    const app = h("span", "fl-app");
    const flags = h("span", "fl-flags");
    const bounty = h("span", "fl-bounty");
    top.append(crestEl, chip, app, flags, bounty);
    const title = h("h3", "fl-title");
    const more = h("p", "fl-also");
    const saidEl = h("p", "fl-said");
    const meter = h("div", "fl-meter");
    const track = h("div", "fl-track");
    const fill = h("i");
    track.append(fill);
    const time = h("span", "fl-time");
    meter.append(track, time);
    const facts = h("p", "fl-facts");
    const term = h("details", "fl-term");
    const summary = h("summary", "", "Terminal");
    const pre = h("pre", "fl-screen");
    pre.tabIndex = 0;
    pre.setAttribute("aria-label", `Terminal of unit ${unit.id}`);
    term.append(summary, pre);
    // Opening it lands on the newest line, as a terminal would.
    term.addEventListener("toggle", () => {
      if (term.open) pre.scrollTop = pre.scrollHeight;
    });
    root.append(top, title, more, saidEl, meter, facts, term);
    c = { root, crest: crestEl, chip, app, title, more, flags, bounty, said: saidEl, fill, time, facts, term, screen: pre };
    cards.set(unit.id, c);
    return c;
  }

  function paintUnit(unit: FleetUnit): Card {
    const c = card(unit);
    const m = mission(unit);
    const cls = CLASS[unit.kind];
    if (c.crest.dataset.kind !== unit.kind) {
      c.crest.replaceWith((c.crest = crestTile(unit.kind)));
      c.crest.dataset.kind = unit.kind;
    }
    set(c.chip, className(unit.kind));
    c.chip.className = `fl-chip ${kindClass(unit.kind)}`;
    c.chip.title = cls ? `${cls.name} runs on ${cls.engine}` : unit.kind;
    set(c.app, m.app);
    c.app.hidden = !m.app;

    c.title.replaceChildren(...(m.number ? [issueLink(m.number, "fl-num"), t(` ${m.title}`)] : [t(m.title)]));
    c.title.classList.toggle("is-idle", !m.number && !unit.scout);
    const others = unit.issues.slice(1);
    c.more.replaceChildren(...(others.length ? [t("Also "), ...others.flatMap((i, k) => [...(k ? [t(", ")] : []), issueLink(i.number)])] : []));
    c.more.hidden = !others.length;
    c.more.title = others.map((i) => `#${i.number} ${i.title}`).join("\n");

    const flagged = unit.flags.filter(Boolean);
    c.flags.replaceChildren(...flagged.map((f) => h("span", `fl-flag is-${f.toLowerCase()}`, FLAG[f] ?? f)));
    c.root.classList.toggle("is-flagged", flagged.length > 0);
    c.root.classList.toggle("is-stuck", flagged.includes("STUCK"));

    // What the mission is worth: each issue it closes, or each issue a scout files.
    const reward = unit.issues.length ? `+${XP.close * unit.issues.length} XP` : unit.scout ? `+${XP.found} XP a find` : "";
    set(c.bounty, reward);
    c.bounty.hidden = !reward;
    c.bounty.title = unit.issues.length ? `Closing ${unit.issues.length === 1 ? "its issue" : `its ${unit.issues.length} issues`} earns ${XP.close} XP each` : `Each issue this scout files earns ${XP.found} XP`;

    const words = said(unit.screen);
    const sig = words ?? `-${unit.screen.trim() ? 1 : 0}`;
    if (c.said.dataset.sig !== sig) {
      c.said.dataset.sig = sig;
      c.said.replaceChildren(...(words ? rich(words) : [t(unit.screen.trim() ? "Working. No words from it yet." : "Starting up.")]));
    }
    c.said.classList.toggle("is-none", !words);

    const over = unit.budget > 0 && unit.minutes > unit.budget;
    const share = unit.budget > 0 ? Math.min(1, unit.minutes / unit.budget) : 0;
    c.fill.style.width = `${(share * 100).toFixed(1)}%`;
    c.root.classList.toggle("is-over", over || flagged.includes("OVER"));
    c.time.replaceChildren(...(unit.budget > 0 ? [h("b", "", duration(unit.minutes)), t(` of ${duration(unit.budget)}`)] : [h("b", "", duration(unit.minutes))]));

    const quiet = unit.quiet >= QUIET_MIN;
    c.facts.replaceChildren(t(`${unit.tokens} tokens · `), quiet ? h("i", "", `quiet ${duration(unit.quiet)}`) : t("active"), t(` · ${unit.id}`));
    c.facts.classList.toggle("is-quiet", quiet);

    const text = tidy(unit.screen) || "Nothing on its terminal yet.";
    if (c.screen.textContent !== text) {
      // New output keeps the last line in view, unless he scrolled up to read.
      const pre = c.screen;
      const atEnd = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
      pre.textContent = text;
      if (atEnd) pre.scrollTop = pre.scrollHeight;
    }
    return c;
  }

  /** The game's score from the fleet and the board's day. Live scores the same way. */
  function score(view: FleetView): void {
    update(game, { fleet: view, day, now: Date.now() });
    paintHero(view);
    paintSquad(view.today ?? []);
  }

  function paintHero(view: FleetView): void {
    const sc = game.score;
    const r = sc.rank;
    if (badge.dataset.level !== String(r.level)) {
      badge.innerHTML = insignia(r.level);
      badge.dataset.level = String(r.level);
      hero.dataset.tier = tier(r.level);
    }
    set(level, `Level ${r.level} · today's rank`);
    set(rankName, r.name);
    const span = r.next ? r.next - r.floor : 1;
    xpFill.style.width = `${r.next ? Math.min(100, ((sc.xp - r.floor) / span) * 100).toFixed(1) : 100}%`;
    const xpSig = `${sc.xp}/${r.next}`;
    if (xpText.dataset.sig !== xpSig) {
      xpText.dataset.sig = xpSig;
      xpText.replaceChildren(h("b", "", `${sc.xp}`), t(r.next ? ` / ${r.next} XP · ` : " XP · "), h("i", "", r.next ? `${r.next - sc.xp} XP to ${rank(r.next).name}` : "the top rank"));
    }
    const y = sc.yesterday;
    rankBox.title = `Today's rank. A closed issue is ${XP.close} XP, a filed one ${XP.found}.\n${sc.closed} closed, ${sc.found} filed since midnight.${y ? `\nBy this hour yesterday: ${y.xp} XP, ${rank(y.xp).name}.` : ""}`;

    const plus = sc.partial ? "+" : "";
    count(cClosed, `${sc.closed}${plus}`, `${sc.closed} issues closed today${sc.fleetClosed ? `, ${sc.fleetClosed} of them by the fleet` : ""}${y ? `\nBy this hour yesterday: ${y.closed}` : ""}`);
    pace(cClosed, sc.closed, y, "closed");
    count(cFound, `${sc.found}${plus}`, `${sc.found} issues filed today${y ? `\nBy this hour yesterday: ${y.found}` : ""}`);
    pace(cFound, sc.found, y, "found");
    // Without the board's day the fleet only knows its own closes, and no finds.
    cFound.root.hidden = !day?.cards;
    const list = view.units ?? [];
    const runs = view.today ?? [];
    count(cRuns, String(sc.runs), `${sc.runs} runs ended today, ${list.length} running now`);
    count(cTokens, tokens(sc.tokens), "Tokens the fleet read today, ended runs and running units");
    const minutes = [...runs, ...list].reduce((n, x) => n + x.minutes, 0);
    count(cTime, duration(minutes), "Minutes every unit ran today, added up");
    cClosed.root.classList.toggle("is-good", sc.closed > 0);

    streak.hidden = sc.streak < STREAK;
    if (!streak.hidden && streak.dataset.n !== String(sc.streak)) {
      streak.dataset.n = String(sc.streak);
      streak.replaceChildren(art("fl-flame", FLAME), h("b", "", `×${sc.streak}`), t(" streak"));
    }
    streak.title = `${sc.streak} closes in the last half hour`;
  }

  let squadSig = "";

  function paintSquad(runs: FleetRun[]): void {
    const foundBy = game.score.foundBy;
    const xpOf = (r: FleetRun) => r.closed.length * XP.close + (foundBy.get(r.unit) ?? 0) * XP.found;
    const by = new Map<string, { runs: number; closed: Set<number>; found: number }>();
    for (const r of runs) {
      const k = by.get(r.kind) ?? { runs: 0, closed: new Set<number>(), found: 0 };
      k.runs++;
      r.closed.forEach((n) => k.closed.add(n));
      k.found += foundBy.get(r.unit) ?? 0;
      by.set(r.kind, k);
    }
    const xpOfClass = (v: { closed: Set<number>; found: number }) => v.closed.size * XP.close + v.found * XP.found;
    const kinds = [...by.entries()].sort((a, b) => xpOfClass(b[1]) - xpOfClass(a[1]) || b[1].runs - a[1].runs);
    const best = [...runs].sort((a, b) => xpOf(b) - xpOf(a) || a.minutes - b.minutes)[0];
    const sig = JSON.stringify([kinds.map(([k, v]) => [k, v.runs, v.closed.size, v.found]), best?.unit, best && xpOf(best), !!day?.cards]);
    if (sig === squadSig) return;
    squadSig = sig;
    squad.hidden = !runs.length;
    const top = Math.max(1, ...kinds.map(([, v]) => xpOfClass(v)));
    squadList.replaceChildren(
      ...kinds.map(([kind, v], i) => {
        const xp = xpOfClass(v);
        const row = h("li", `fl-rank-row ${kindClass(kind)}`);
        const place = h("span", `fl-place p-${i + 1}`, String(i + 1));
        const name = h("span", "fl-who");
        name.append(h("b", "", className(kind)), h("i", "", CLASS[kind]?.engine ?? ""));
        const bar = h("span", "fl-bar");
        const fill = h("i");
        fill.style.width = `${Math.max(xp ? 4 : 0, (xp / top) * 100).toFixed(1)}%`;
        bar.append(fill);
        const facts = h("span", "fl-rank-facts");
        facts.append(h("b", "", String(v.closed.size)), t(" closed · "), ...(day?.cards ? [h("b", "", String(v.found)), t(" found · ")] : []), h("b", "", String(v.runs)), t(` ${v.runs === 1 ? "run" : "runs"}`));
        row.append(place, crestTile(kind), name, bar, h("span", "fl-rank-xp", `${xp} XP`), facts);
        return row;
      }),
    );
    const bestXp = best ? xpOf(best) : 0;
    mvp.hidden = !bestXp;
    if (best && bestXp) {
      const n = foundBy.get(best.unit) ?? 0;
      const did = h("p", "fl-mvp-did");
      if (best.closed.length) did.append(t("closed "), h("b", "", String(best.closed.length)));
      if (best.closed.length && n) did.append(t(" and "));
      if (n) did.append(t("found "), h("b", "", String(n)));
      did.append(t(" in "), h("i", "", duration(best.minutes)));
      const who = h("p", "fl-mvp-who");
      who.append(crestTile(best.kind, "fl-crest is-small"), h("b", "", `${className(best.kind)} ${best.unit}`));
      const head = h("p", "fl-mvp-head");
      head.append(art("fl-mvp-star", STAR), t("Run of the day"));
      mvp.replaceChildren(head, who, did, h("p", "fl-mvp-xp", `+${bestXp} XP`));
      mvp.title = best.closed.length ? `Closed ${best.closed.map((c) => `#${c}`).join(", ")}` : "";
    }
  }

  // Kept, not rebuilt, so a chip keeps its focus through the reads every few seconds.
  const filters = new Map<Filter, { button: HTMLButtonElement; count: HTMLElement }>();
  for (const [f, label] of [["all", "All"], ["closed", "Closed"], ["scout", "Scouted"], ["none", "Nothing closed"]] as [Filter, string][]) {
    const button = h("button", "fl-filter");
    button.type = "button";
    const n = h("span");
    button.append(t(label), n);
    button.addEventListener("click", () => {
      filter = f;
      shown = RUNS;
      paintToday(last?.today ?? []);
    });
    filters.set(f, { button, count: n });
    chips.append(button);
  }
  let todaySig = "";

  function paintToday(runs: FleetRun[]): void {
    const foundBy = game.score.foundBy;
    const sig = `${runs.length}\n${runs[0]?.time}${runs[0]?.unit}\n${filter}\n${shown}\n${[...foundBy].join()}`;
    if (sig === todaySig) return;
    todaySig = sig;
    const lines = runs.map((run) => ({ run, line: runLine(run) }));
    const count_ = (f: Filter) => (f === "all" ? lines.length : lines.filter((l) => l.line.kind === f).length);
    set(todayTitle, "Today");
    todayHead.hidden = runs.length === 0;
    for (const [f, { button, count: n }] of filters) {
      set(n, String(count_(f)));
      button.hidden = f !== "all" && count_(f) === 0;
      button.classList.toggle("is-on", filter === f);
      button.setAttribute("aria-pressed", String(filter === f));
    }
    const matching = lines.filter((l) => filter === "all" || l.line.kind === filter);
    today.replaceChildren(
      ...matching.slice(0, shown).map(({ run, line }) => {
        const finds = foundBy.get(run.unit) ?? 0;
        const row = h("div", `fl-run is-${line.kind}`);
        const what = h("span", "fl-run-what");
        if (line.kind === "closed") what.append(h("b", "", "Closed"));
        else if (line.kind === "scout") what.append(t("Scouted "), h("b", "", line.lens ?? ""), ...(line.app ? [t(" in "), h("i", "", line.app)] : []));
        else what.append(h("i", "", line.text));
        const nums = line.numbers.slice(0, 6);
        for (const n of nums) what.append(t(" "), issueLink(n));
        if (line.numbers.length > nums.length) what.append(h("span", "fl-run-extra", ` +${line.numbers.length - nums.length}`));
        // Badges for a run worth a cheer: a fast close, several at once, a scout that filed.
        if (line.kind === "closed" && run.minutes <= SPEEDRUN_MIN) what.append(h("span", "fl-badge is-speed", "Speedrun"));
        if (run.closed.length > 1) what.append(h("span", "fl-badge is-combo", `Combo ×${run.closed.length}`));
        if (finds) what.append(h("span", "fl-badge is-finds", `${finds} ${finds === 1 ? "find" : "finds"}`));
        const xp = run.closed.length * XP.close + finds * XP.found;
        const who = h("span", "fl-run-who");
        who.append(crestTile(run.kind, "fl-crest is-tiny"), h("span", `fl-chip is-small ${kindClass(run.kind)}`, className(run.kind)));
        row.append(h("span", "fl-run-time", run.time), who, what, h("span", `fl-xp${xp ? "" : " is-none"}`, xp ? `+${xp} XP` : ""), h("span", "fl-run-nums", `${duration(run.minutes)} · ${run.tokens}`));
        row.title = `${className(run.kind)} ${run.unit}: ${run.result}`;
        return row;
      }),
    );
    const left = matching.length - Math.min(shown, matching.length);
    moreRuns.hidden = left <= 0;
    set(moreRuns, `Show ${Math.min(left, RUNS * 4)} more`);
  }

  function paint(view: FleetView): void {
    error.hidden = !view.error;
    error.textContent = view.error ? `The fleet could not be read: ${view.error}` : "";
    if (view.error && !view.units) {
      // A failed read keeps the last good fleet on screen, with the error above it.
      if (!last) empty.textContent = "";
      return;
    }
    last = view;
    const list = [...(view.units ?? [])];
    const on = Boolean(view.supervisor);
    set(state, on ? (view.hold ? "On hold" : "Running") : "Off");
    state.className = `fl-state ${on ? (view.hold ? "is-hold" : "is-on") : "is-off"}`;
    state.title = on ? (view.hold ? "No new starts. Running units finish." : "The supervisor starts units when the board has work.") : "No supervisor runs.";
    // "terra:2,flash:1" is the supervisor's slots: as many of each class at once.
    const spec = (view.spec ?? "").split(",").map((s) => s.split(":")).filter(([k, n]) => k && n);
    set(slots, spec.length ? `Slots: ${spec.map(([k, n]) => `${n} ${className(k)}`).join(" · ")}` : "");
    slots.hidden = !spec.length;
    stamp.textContent = `Read ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;

    score(view);
    // Units that need a look first, then the longest running.
    const worry = (u: FleetUnit) => (u.flags.length ? 0 : 1);
    list.sort((a, b) => worry(a) - worry(b) || b.minutes - a.minutes || a.id.localeCompare(b.id));
    const live = new Set(list.map((u) => u.id));
    for (const [id, c] of cards) {
      if (live.has(id)) continue;
      c.root.remove();
      cards.delete(id);
    }
    const want = list.map((u) => paintUnit(u).root);
    const have = [...units.children];
    if (have.length !== want.length || have.some((el, i) => el !== want[i])) units.replaceChildren(...want);
    set(unitsHead, list.length ? `Running now · ${list.length} ${list.length === 1 ? "unit" : "units"}` : "Running now");
    units.hidden = list.length === 0;
    empty.hidden = list.length > 0;
    empty.textContent = on
      ? "No unit runs right now. The supervisor starts one when the board has work for it."
      : "No unit runs. The fleet starts when you ask a session for it.";
    paintToday(view.today ?? []);
  }

  /** Today's closes and finds on the board, back to yesterday's midnight for the pace to beat. */
  async function readDay(): Promise<void> {
    if (!events.day) return;
    dayAt = Date.now();
    // A read cut at its limit loses issues, so on such a day it asks for today alone and drops the pace.
    const short = shortDay === new Date(dayAt).toDateString();
    const d = await events.day(hoursBack(dayAt, short ? 0 : 1)).catch(() => null);
    if (d && !d.error) day = d;
    if (last && visible) score(last);
    if (game.score.partial && !short) {
      shortDay = new Date(dayAt).toDateString();
      dayAt = 0;
    }
  }

  async function read(): Promise<void> {
    if (!visible || busy) return;
    busy = true;
    try {
      if (events.day && Date.now() - dayAt > DAY_EVERY) void readDay();
      const view = await events.view().catch((reason: unknown): FleetView => ({ error: errorText(reason, "the fleet extension did not answer") }));
      if (visible) paint(view);
    } finally {
      busy = false;
    }
  }

  return {
    open() {
      visible = true;
      screen.hidden = false;
      void read();
      window.clearInterval(timer);
      timer = window.setInterval(() => void read(), EVERY);
    },
    clear() {
      visible = false;
      screen.hidden = true;
      window.clearInterval(timer);
    },
    dispose() {
      window.clearInterval(timer);
      cards.clear();
      screen.replaceChildren();
    },
  };
}

function count(c: Counter, value: string, title: string): void {
  set(c.value, value);
  c.root.title = title;
}

/** Today against yesterday up to this hour: "▲12" ahead, "▼3" behind. Unknown: nothing. */
function pace(c: Counter, today: number, y: Tally | null, key: "closed" | "found"): void {
  const diff = y ? today - y[key] : 0;
  c.delta.hidden = !y;
  set(c.delta, diff > 0 ? `▲${diff}` : diff < 0 ? `▼${-diff}` : "=");
  c.delta.className = `fl-delta ${diff > 0 ? "is-up" : diff < 0 ? "is-down" : ""}`;
}
