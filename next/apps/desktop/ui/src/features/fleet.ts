/**
 * AI fleet: the cheap builders the fleet runs, one card a unit with what it is doing right now, and
 * under them what the fleet ended today. Owner, 2026-11-17: "I want them on my AppgeaPanel, visible
 * any time I open the appgea panel under an AI fleet tab. So that I can check that on demand".
 * Owner, 2026-11-19: "make it nicer and more understandable".
 *
 * A card leads with the unit's mission and the last sentence it wrote to a person. Its time against
 * its budget is a bar. Its raw terminal is one click away: a CLI screen is mostly tool calls and
 * an input box, which buried the one line that says what the unit is doing.
 *
 * The units run in tmux, outside Panel (ops `runbooks/fleet.py`). This screen only reads `fleet view`
 * through the fleet module: it keeps no terminal, so a unit costs Panel no memory, and quitting Panel
 * ends nothing. It reads when it opens and every few seconds while it is the screen on the glass.
 * Hidden, it asks for nothing. It only shows: starting and stopping the fleet stays a thing he asks for.
 */
import { errorText } from "../errors";
import { CLASS, className, duration, millions, mission, runLine, said, tidy, tokens } from "./fleet_words";
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
export type FleetEvents = { view(): Promise<FleetView>; openIssue?(number: number): void };
export type FleetHandle = { open(): void; clear(): void; dispose(): void };

const EVERY = 5_000;
/** Today's runs listed at first. A wave day ends a few hundred. */
const RUNS = 30;
/** A unit this long without output reads as quiet. */
const QUIET_MIN = 5;
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
const kindClass = (kind: string): string => `c-${CLASS[kind] ? kind : "other"}`;

type Card = {
  root: HTMLElement;
  chip: HTMLElement;
  app: HTMLElement;
  title: HTMLElement;
  more: HTMLElement;
  flags: HTMLElement;
  said: HTMLElement;
  fill: HTMLElement;
  time: HTMLElement;
  facts: HTMLElement;
  term: HTMLDetailsElement;
  screen: HTMLElement;
};
type Filter = "all" | "closed" | "scout" | "none";

export function mountFleet(screen: HTMLElement, events: FleetEvents): FleetHandle {
  let visible = false;
  let busy = false;
  let timer: number | undefined;
  let last: FleetView | null = null;
  let filter: Filter = "all";
  let shown = RUNS;
  const cards = new Map<string, Card>();

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

  // The day in four numbers.
  const stat = (label: string) => {
    const el = h("div", "fl-stat");
    el.append(h("b"), h("span", "", label));
    return el;
  };
  const stClosed = stat("closed today");
  const stRuns = stat("runs today");
  const stTokens = stat("tokens");
  const stTime = stat("unit time");
  const stats = h("div", "fl-stats");
  stats.append(stClosed, stRuns, stTokens, stTime);

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
  body.append(stats, unitsHead, units, empty, todayHead, today, moreRuns);
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
    const chip = h("span", "fl-chip");
    const app = h("span", "fl-app");
    const flags = h("span", "fl-flags");
    top.append(chip, app, flags);
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
    c = { root, chip, app, title, more, flags, said: saidEl, fill, time, facts, term, screen: pre };
    cards.set(unit.id, c);
    return c;
  }

  function paintUnit(unit: FleetUnit): Card {
    const c = card(unit);
    const m = mission(unit);
    const cls = CLASS[unit.kind];
    set(c.chip, className(unit.kind));
    c.chip.className = `fl-chip ${kindClass(unit.kind)}`;
    c.chip.title = cls ? `${cls.name} runs on ${cls.engine}` : unit.kind;
    set(c.app, m.app);
    c.app.hidden = !m.app;

    c.title.replaceChildren(...(m.number ? [issueLink(m.number, "fl-num"), document.createTextNode(` ${m.title}`)] : [document.createTextNode(m.title)]));
    c.title.classList.toggle("is-idle", !m.number && !unit.scout);
    const others = unit.issues.slice(1);
    c.more.replaceChildren(...(others.length ? [document.createTextNode("Also "), ...others.flatMap((i, k) => [...(k ? [document.createTextNode(", ")] : []), issueLink(i.number)])] : []));
    c.more.hidden = !others.length;
    c.more.title = others.map((i) => `#${i.number} ${i.title}`).join("\n");

    const flagged = unit.flags.filter(Boolean);
    c.flags.replaceChildren(...flagged.map((f) => h("span", `fl-flag is-${f.toLowerCase()}`, FLAG[f] ?? f)));
    c.root.classList.toggle("is-flagged", flagged.length > 0);
    c.root.classList.toggle("is-stuck", flagged.includes("STUCK"));

    const words = said(unit.screen);
    set(c.said, words ?? (unit.screen.trim() ? "Working. No words from it yet." : "Starting up."));
    c.said.classList.toggle("is-none", !words);

    const over = unit.budget > 0 && unit.minutes > unit.budget;
    const share = unit.budget > 0 ? Math.min(1, unit.minutes / unit.budget) : 0;
    c.fill.style.width = `${(share * 100).toFixed(1)}%`;
    c.root.classList.toggle("is-over", over || flagged.includes("OVER"));
    set(c.time, unit.budget > 0 ? `${duration(unit.minutes)} of ${duration(unit.budget)}` : duration(unit.minutes));

    const quiet = unit.quiet >= QUIET_MIN ? `quiet ${duration(unit.quiet)}` : "active";
    set(c.facts, `${unit.tokens} tokens · ${quiet} · ${unit.id}`);
    c.facts.classList.toggle("is-quiet", unit.quiet >= QUIET_MIN);

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

  function paintStats(view: FleetView): void {
    const runs = view.today ?? [];
    const list = view.units ?? [];
    const closed = runs.reduce((n, r) => n + r.closed.length, 0);
    const tok = [...runs.map((r) => r.tokens), ...list.map((u) => u.tokens)].reduce((n, t) => n + millions(t), 0);
    const minutes = [...runs, ...list].reduce((n, r) => n + r.minutes, 0);
    const value = (el: HTMLElement, v: string, title: string) => {
      set(el.firstElementChild as HTMLElement, v);
      el.title = title;
    };
    value(stClosed, String(closed), `${closed} issues closed by fleet units today`);
    value(stRuns, String(runs.length), `${runs.length} runs ended today, ${list.length} running now`);
    value(stTokens, tokens(tok), "Tokens the fleet read today, ended runs and running units");
    value(stTime, duration(minutes), "Minutes every unit ran today, added up");
    stClosed.classList.toggle("is-good", closed > 0);
  }

  // Kept, not rebuilt, so a chip keeps its focus through the reads every few seconds.
  const filters = new Map<Filter, { button: HTMLButtonElement; count: HTMLElement }>();
  for (const [f, label] of [["all", "All"], ["closed", "Closed"], ["scout", "Scouted"], ["none", "Nothing closed"]] as [Filter, string][]) {
    const button = h("button", "fl-filter");
    button.type = "button";
    const count = h("span");
    button.append(document.createTextNode(label), count);
    button.addEventListener("click", () => {
      filter = f;
      shown = RUNS;
      paintToday(last?.today ?? []);
    });
    filters.set(f, { button, count });
    chips.append(button);
  }
  let todaySig = "";

  function paintToday(runs: FleetRun[]): void {
    const sig = `${runs.length}\n${runs[0]?.time}${runs[0]?.unit}\n${filter}\n${shown}`;
    if (sig === todaySig) return;
    todaySig = sig;
    const lines = runs.map((run) => ({ run, line: runLine(run) }));
    const count = (f: Filter) => (f === "all" ? lines.length : lines.filter((l) => l.line.kind === f).length);
    set(todayTitle, "Today");
    todayHead.hidden = runs.length === 0;
    for (const [f, { button, count: n }] of filters) {
      set(n, String(count(f)));
      button.hidden = f !== "all" && count(f) === 0;
      button.classList.toggle("is-on", filter === f);
      button.setAttribute("aria-pressed", String(filter === f));
    }
    const matching = lines.filter((l) => filter === "all" || l.line.kind === filter);
    today.replaceChildren(
      ...matching.slice(0, shown).map(({ run, line }) => {
        const row = h("div", `fl-run is-${line.kind}`);
        const what = h("span", "fl-run-what");
        what.append(document.createTextNode(line.text));
        const nums = line.numbers.slice(0, 6);
        for (const n of nums) what.append(document.createTextNode(" "), issueLink(n));
        if (line.numbers.length > nums.length) what.append(h("span", "fl-run-extra", ` +${line.numbers.length - nums.length}`));
        const chip = h("span", `fl-chip is-small ${kindClass(run.kind)}`, className(run.kind));
        row.append(h("span", "fl-run-time", run.time), chip, what, h("span", "fl-run-nums", `${duration(run.minutes)} · ${run.tokens}`));
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

    paintStats(view);
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

  async function read(): Promise<void> {
    if (!visible || busy) return;
    busy = true;
    try {
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
