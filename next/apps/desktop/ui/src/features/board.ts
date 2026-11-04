/**
 * Board — every open issue in Appgea/ops as a card. Needs you is a wide band on top, then the lanes:
 * working, ready, waiting, done. Each card says one thing under its title: your call, or the problem.
 * Click a card and its brief opens as a sheet in the middle of the screen, the point first: your call
 * or the problem, then why, the pictures and the goals. ← and → walk the board.
 * Owner, 2026-11-01: "I should enjoy looking at it and understand them at once", and later the same
 * day, of the old drawer: "my head is stuck reading it on right side … I should be getting the point
 * as fast as possible".
 *
 * No XP, streaks, quests or Crew tab. Owner, 2026-11-04, of the game layer: "remove them. We will
 * make a Live broadcasting system to observe the agents." Watching agents belongs to that system.
 *
 * One screen, read from the `scout` extension. With it absent the Board does not exist. There is no
 * strip on other screens: Owner, 2026-10-30, "it is an antipattern". Nothing polls: a read happens
 * on focus and on session and report events.
 */
import { errorText } from "../errors";
import { icon, type IconName } from "../icons";
import { dayKey, days, engineOf, splitTitle } from "./board_score";
import "./board.css";

/** Who a launched terminal is for. The swipe review opens its agent through main.ts `launchScout`. */
export type Scout = { id: string; agent: string | null; model?: string | null };
export type Goal = { goal: string; check?: string };
/** One open issue. Every part past `priority` is cut from the brief by `board json`, and may be missing. */
export type BoardCard = {
  number: number;
  title: string;
  url: string;
  apps: string[];
  priority: number;
  holder?: string;
  claimed_at?: string | null;
  ask?: string;
  estimate?: number;
  show?: string[];
  problem?: string;
  why?: string;
  direction?: string;
  seen?: string;
  decided?: string;
  run_with?: string;
  bundle?: string;
  recheck?: string;
  cost?: string;
  goals?: Goal[];
  confidence?: number;
  after?: number[];
  kinds?: string[];
  created_at?: string;
};
export type DoneCard = {
  number: number;
  title: string;
  url: string;
  apps: string[];
  priority: number;
  closed_at?: string | null;
  estimate?: number;
  dropped?: boolean;
};
export type BoardData = {
  repo?: string;
  at?: string;
  open?: number;
  now?: BoardCard[];
  you?: BoardCard[];
  /** The first five of `ready`. An older `board` sends only this. */
  next?: BoardCard[];
  ready?: BoardCard[];
  waiting?: BoardCard[];
  /** Closed in the last 14 days, newest first. Null when GitHub did not answer: the score is unknown, not zero. */
  done?: DoneCard[] | null;
  error?: string;
  apps?: Record<string, { name: string; dir: string }>;
};
/** The extension's routes, behind one seam so the dev harness can stand in for it. */
export type BoardApi = {
  board(fresh: boolean): Promise<BoardData>;
  picture(path: string): Promise<string>;
};

export type BoardEvents = {
  api: BoardApi;
  appIcon(dir: string): string | null;
  openUrl(url: string): void;
  /** The full-screen swipe review of what the board did since you last looked (swipe.ts). */
  openSwipe(): void;
};

export type BoardHandle = { open(): void; clear(): void; refresh(fresh?: boolean): void; dispose(): void };

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text) el.textContent = text;
  return el;
};
const button = (cls: string, text = "", title = ""): HTMLButtonElement => {
  const el = h("button", cls, text);
  el.type = "button";
  if (title) el.title = title;
  return el;
};
const glyph = (name: IconName, cls = "bq-glyph"): HTMLElement => {
  const el = h("span", cls);
  el.innerHTML = icon(name, "ui-icon");
  return el;
};
/** Brief text with `code` spans. Everything else stays text, never HTML. */
const rich = (tag: "p" | "span" | "div", cls: string, text: string): HTMLElement => {
  const el = h(tag, cls);
  text.split(/(`[^`]+`)/).forEach((part) => {
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) el.append(h("code", "", part.slice(1, -1)));
    else if (part) el.append(document.createTextNode(part));
  });
  return el;
};

/** "12m", "3h", "2d": how long a claim has been held. */
export const held = (since: string | null | undefined, now = Date.now()): string => {
  if (!since) return "";
  const minutes = Math.max(0, Math.round((now - new Date(since).getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
};

/** A time the way a person says it: "23:55", "tomorrow 08:00", "Sun 08:00". */
export const when = (iso: string | null | undefined, now = new Date()): string => {
  if (!iso) return "";
  const at = new Date(iso);
  const clock = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  const day = (d: Date): number => Math.floor((d.getTime() - d.getTimezoneOffset() * 60_000) / 86_400_000);
  const gap = day(at) - day(now);
  if (gap === 0) return clock;
  if (gap === 1) return `tomorrow ${clock}`;
  if (gap === -1) return `yesterday ${clock}`;
  return `${at.toLocaleDateString(undefined, { weekday: "short" })} ${clock}`;
};

const shortDate = (date: string): string => {
  const at = new Date(/^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00` : date);
  return Number.isNaN(at.getTime()) ? date : at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};
const dayName = (date: string, today: string, yesterday: string): string =>
  date === today ? "Today" : date === yesterday ? "Yesterday"
    : new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
const number = (n: number): string => n.toLocaleString();

/** Priority as a tier. The word says it; the colour only repeats it. */
const TIERS = ["Critical", "High", "Normal", "Low"];
const tier = (p: number): string => TIERS[Math.min(Math.max(p, 0), 3)];
const KIND_WORD: Record<string, string> = {
  speed: "Speed", redesign: "Redesign", "bug-report": "Bug", question: "Question", guide: "Guide",
};

type Lane = "you" | "now" | "ready" | "waiting";
const LANES: { key: Lane; title: string; hint: string; tone: string; icon: IconName; empty: string }[] = [
  { key: "you", title: "Needs you", hint: "Only you can unblock these", tone: "t-warn", icon: "flag", empty: "Nothing waits on you." },
  { key: "now", title: "Working", hint: "An agent is on it right now", tone: "t-work", icon: "play", empty: "No agent is working. Type work in a terminal." },
  { key: "ready", title: "Ready", hint: "Free to take, best first", tone: "t-ready", icon: "inbox", empty: "No free issues." },
  { key: "waiting", title: "Waiting", hint: "Back on a date, or after another issue", tone: "t-quiet", icon: "clock", empty: "Nothing is parked." },
];
const NO_APP = "_ops";

/** A problem that only repeats the title, as speed issues do, adds nothing under it. */
const echoes = (problem: string, title: string): boolean => {
  const plain = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  return plain(title).includes(plain(problem).slice(0, 40));
};

/** `app:ops` and no app at all are the same work: the company's own. One "Ops" group, not two. */
const tidy = (read: BoardData): BoardData => {
  const strip = <T extends { apps: string[] }>(cards: T[] | undefined): T[] | undefined =>
    cards?.map((card) => (card.apps.includes("ops") ? { ...card, apps: card.apps.filter((a) => a !== "ops") } : card));
  return { ...read, now: strip(read.now), you: strip(read.you), next: strip(read.next), ready: strip(read.ready), waiting: strip(read.waiting),
    done: read.done === null ? null : strip(read.done) };
};

const remember = (key: string, value?: string): string => {
  try {
    if (value === undefined) return localStorage.getItem(`panel.board.${key}`) ?? "";
    localStorage.setItem(`panel.board.${key}`, value);
  } catch {
    /* storage is a convenience only */
  }
  return value ?? "";
};

export function mountBoard(screen: HTMLElement, events: BoardEvents): BoardHandle {
  const { api } = events;
  let board: BoardData | null = null;
  let failure = "";
  let busy = false;
  let again = false;
  let againFresh = false;
  let visible = false;
  let lastFresh = 0;
  let appFilter = remember("app");
  let query = "";
  let selected: number | null = null;
  /** Where the open brief was scrolled to, and if its fine print was open, so a background refresh
   *  does not throw the owner back to its top. */
  let readAt = { number: -1, top: 0, more: false };
  const pictures = new Map<string, Promise<string>>();
  let lanesHost: HTMLElement | null = null;
  let filterHost: HTMLElement | null = null;

  screen.classList.add("board");
  screen.addEventListener("keydown", (event) => {
    if (selected === null) return;
    const zoomed = screen.querySelector<HTMLElement>(".bq-zoom");
    if (event.key === "Escape") {
      event.stopPropagation();
      if (zoomed) unzoom();
      else closeBrief();
    } else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && !zoomed) {
      event.preventDefault();
      event.stopPropagation();
      step(event.key === "ArrowLeft" ? -1 : 1);
    }
  });

  /* ------------------------------------------------------------ the clock */

  async function refresh(fresh = false): Promise<void> {
    // Only the open Board shows a read, so a hidden one costs no `gh` calls. open() reads.
    if (!visible) return;
    // One pass at a time. A trigger that lands mid-pass runs one more pass after it, never two.
    if (busy) {
      again = true;
      againFresh ||= fresh;
      return;
    }
    // Every report asks for a fresh board. One gh read per 30 s is plenty.
    if (fresh && Date.now() - lastFresh < 30_000) fresh = false;
    if (fresh) lastFresh = Date.now();
    busy = true;
    screen.classList.add("bq-busy");
    try {
      const read = await api.board(fresh).catch((error: unknown): BoardData => ({ error: errorText(error, "the scout extension did not answer") }));
      // A failed read keeps the last good board on screen, with the error above it.
      board = read.error && board && !board.error ? { ...board, error: read.error } : tidy(read);
      const paths = new Set(openCards().flatMap((card) => card.show ?? []));
      for (const path of pictures.keys()) if (!paths.has(path)) pictures.delete(path);
      failure = "";
      paint();
    } catch (error) {
      failure = errorText(error, "the scout extension did not answer");
      paint();
    } finally {
      busy = false;
      screen.classList.remove("bq-busy");
      if (again) {
        const next = againFresh;
        again = againFresh = false;
        void refresh(next);
      }
    }
  }

  /* ------------------------------------------------------------ the data, as lanes */

  const lane = (key: Lane): BoardCard[] => {
    if (!board) return [];
    if (key === "ready") return board.ready ?? board.next ?? [];
    return board[key] ?? [];
  };
  const openCards = (): BoardCard[] => LANES.flatMap((l) => lane(l.key));
  const appName = (key: string): string => board?.apps?.[key]?.name ?? key;

  const matches = (card: { number: number; title: string; apps: string[]; problem?: string }): boolean => {
    if (appFilter === NO_APP ? card.apps.length > 0 : appFilter && !card.apps.includes(appFilter)) return false;
    if (!query) return true;
    const q = query.toLowerCase();
    return `#${card.number} ${card.title} ${card.problem ?? ""} ${card.apps.map(appName).join(" ")}`.toLowerCase().includes(q);
  };

  /* ------------------------------------------------------------ pieces */

  function appTile(key: string | null, size = ""): HTMLElement {
    const app = key ? board?.apps?.[key] ?? { name: key, dir: key } : { name: "Ops", dir: "" };
    const tile = h("span", `bq-tile ${size}`.trim(), app.name.charAt(0).toUpperCase());
    tile.title = app.name;
    const src = key ? events.appIcon(app.dir) : null;
    if (src) {
      const img = h("img");
      img.src = src;
      img.alt = "";
      img.addEventListener("error", () => img.remove(), { once: true });
      tile.append(img);
    }
    return tile;
  }

  function avatar(holder: string): HTMLElement {
    const engine = engineOf(holder);
    const el = h("span", `bq-avatar k-${engine.key}`, engine.name.charAt(0).toUpperCase());
    el.title = holder;
    return el;
  }

  function waitReason(card: BoardCard): string {
    const openNums = new Set(openCards().map((c) => c.number));
    const blockers = (card.after ?? []).filter((n) => openNums.has(n));
    if (blockers.length) return `After ${blockers.map((n) => `#${n}`).join(", ")}`;
    if (card.recheck) return `Back ${shortDate(card.recheck)}`;
    if (card.kinds?.includes("guide")) return "Kept to read";
    return "Parked";
  }

  function meter(value: number, max: number, cls: string, label: string): HTMLElement {
    const bar = h("span", `bq-meter ${cls}`);
    bar.setAttribute("role", "meter");
    bar.setAttribute("aria-label", label);
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", String(max));
    bar.setAttribute("aria-valuenow", String(Math.min(value, max)));
    const fill = h("i");
    fill.style.width = `${max > 0 ? Math.min(100, (value / max) * 100) : 0}%`;
    bar.append(fill);
    return bar;
  }

  /* ------------------------------------------------------------ an issue card */

  const appsLabel = (card: { apps: string[] }): string => (card.apps.length ? card.apps.map(appName).join(" + ") : "Ops");
  const titleOf = (card: BoardCard): { title: string; tag: string } =>
    splitTitle(card.title, [...card.apps, ...card.apps.map(appName)]);
  const level = (card: { priority: number }): number => Math.min(Math.max(card.priority, 0), 3);
  /** One kind word for a card: the title's own tag, else its first known kind. */
  const kindOf = (card: BoardCard, tag: string): string =>
    tag || ((card.kinds ?? []).map((k) => KIND_WORD[k]).find(Boolean) ?? "");

  /** A card says three things at a glance: whose app, what, and the one line that matters. Only Critical
   *  and High wear their tier; Normal and Low are most cards, so a chip there was noise. */
  function questCard(card: BoardCard, key: Lane, first: boolean): HTMLButtonElement {
    const p = level(card);
    const el = button(`bq-card p${p}`);
    el.dataset.number = String(card.number);
    if (selected === card.number) el.classList.add("is-open");
    el.setAttribute("aria-label", `#${card.number} ${card.title}`);

    const top = h("span", "bq-card-top");
    top.append(appTile(card.apps[0] ?? null, "sm"), h("span", "bq-appname", appsLabel(card)));
    if (first && key === "ready") top.append(h("span", "bq-badge-next", "Next up"));
    else if (p <= 1) top.append(h("span", "bq-urgent", tier(p)));
    top.append(h("span", "bq-num", `#${card.number}`));
    el.append(top);

    const split = titleOf(card);
    el.append(h("span", "bq-title", split.title));
    if (key === "you" && card.ask) {
      const ask = h("span", "bq-ask");
      ask.append(h("b", "", "Your call"), rich("span", "", card.ask));
      el.append(ask);
    } else if (card.problem && !echoes(card.problem, split.title)) {
      el.append(rich("span", "bq-problem", card.problem));
    }

    const foot = h("span", "bq-foot");
    if (key === "now" && card.holder) {
      foot.append(avatar(card.holder), h("span", "bq-who", engineOf(card.holder).name), h("small", "bq-held", held(card.claimed_at)));
    } else if (key === "waiting") {
      const wait = h("span", "bq-wait");
      wait.append(glyph("clock"), document.createTextNode(waitReason(card)));
      foot.append(wait);
    } else {
      const kind = kindOf(card, split.tag);
      if (kind) foot.append(h("span", "bq-kind", kind));
    }
    if (card.estimate) foot.append(h("span", "bq-gap"), h("span", "bq-est", `${card.estimate} min`));
    el.append(foot);

    // Time held against the estimate, as a line along the card's bottom edge.
    if (key === "now" && card.claimed_at && card.estimate && card.estimate > 0) {
      const minutes = Math.max(0, (Date.now() - Date.parse(card.claimed_at)) / 60_000);
      if (Number.isFinite(minutes)) {
        const label = `${Math.round(minutes)} of ${card.estimate} min`;
        const bar = meter(minutes, card.estimate, `is-edge${minutes > card.estimate ? " is-over" : ""}`, "Time held against the estimate");
        bar.setAttribute("aria-valuetext", label);
        el.title = label;
        el.append(bar);
      }
    }

    el.addEventListener("click", () => openBrief(card.number));
    return el;
  }

  /* ------------------------------------------------------------ the lanes */

  /** A repaint keeps where each lane, and the row of lanes, was scrolled to. Read while still on screen:
   *  a detached element reads 0. */
  const scrolled = new Map<string, number>();
  function saveScroll(): void {
    screen.querySelectorAll<HTMLElement>(".bq-lane-body").forEach((el) => scrolled.set(el.dataset.lane ?? "", el.scrollTop));
    const row = screen.querySelector<HTMLElement>(".bq-lanes");
    if (row) scrolled.set("_row", row.scrollLeft);
    const you = screen.querySelector<HTMLElement>(".bq-you-row");
    if (you) scrolled.set("_you", you.scrollLeft);
  }
  function restoreScroll(): void {
    screen.querySelectorAll<HTMLElement>(".bq-lane-body").forEach((el) => { el.scrollTop = scrolled.get(el.dataset.lane ?? "") ?? 0; });
    const row = screen.querySelector<HTMLElement>(".bq-lanes");
    if (row) row.scrollLeft = scrolled.get("_row") ?? 0;
    const you = screen.querySelector<HTMLElement>(".bq-you-row");
    if (you) you.scrollLeft = scrolled.get("_you") ?? 0;
  }

  function laneTitle(name: IconName, title: string, count: number): HTMLElement {
    const el = h("h2");
    el.append(glyph(name), h("span", "", title), h("span", "bq-count", String(count)));
    return el;
  }

  /** What waits on the owner leads the screen, wide, so the ask reads before anything else. Clear, it
   *  shrinks to one green line: that is the news. */
  function youBand(): HTMLElement {
    const l = LANES[0];
    const all = lane("you");
    const cards = all.filter(matches);
    const clear = !cards.length;
    const band = h("section", `bq-you ${clear && !all.length ? "t-ok is-clear" : l.tone}`);
    band.setAttribute("aria-label", l.title);
    const head = h("header", "bq-you-head");
    head.append(laneTitle(clear && !all.length ? "check" : l.icon, l.title, cards.length),
      h("small", "", cards.length ? l.hint : all.length ? "No match for this filter." : l.empty));
    band.append(head);
    if (!clear) {
      const row = h("div", "bq-you-row");
      cards.forEach((c) => row.append(questCard(c, "you", false)));
      band.append(row);
    }
    return band;
  }

  function paintLanes(): void {
    if (!lanesHost) return;
    const row = h("div", "bq-lanes");
    for (const l of LANES.slice(1)) {
      const cards = lane(l.key).filter(matches);
      const col = h("section", `bq-lane ${l.tone}`);
      col.setAttribute("aria-label", l.title);
      const head = h("header", "bq-lane-head");
      head.append(laneTitle(l.icon, l.title, cards.length), h("small", "", l.hint));
      const body = h("div", "bq-lane-body");
      body.dataset.lane = l.key;
      if (cards.length) cards.forEach((c, i) => body.append(questCard(c, l.key, i === 0 && !query && !appFilter)));
      else body.append(h("p", "bq-empty", lane(l.key).length ? "No match for this filter." : l.empty));
      col.append(head, body);
      row.append(col);
    }
    row.append(doneLane());
    lanesHost.replaceChildren(youBand(), row);
  }

  function doneLane(): HTMLElement {
    const col = h("section", "bq-lane t-ok bq-done");
    col.setAttribute("aria-label", "Done");
    const all = (board?.done ?? []).filter(matches);
    const s = days(board?.done ?? []);
    const head = h("header", "bq-lane-head");
    head.append(laneTitle("check", "Done", all.filter((d) => !d.dropped).length), h("small", "", "Closed in the last 14 days"));
    const body = h("div", "bq-lane-body");
    body.dataset.lane = "done";
    const today = s.today.date;
    const yesterday = s.days[s.days.length - 2]?.date ?? "";
    const byDate = new Map(s.days.map((d) => [d.date, d]));
    let shown = 0;
    let lastDay: string | null = null;
    const LIMIT = 80;
    for (const card of all) {
      if (shown >= LIMIT) break;
      const key = card.closed_at ? dayKey(new Date(card.closed_at)) : "";
      const date = byDate.has(key) ? key : "";
      if (date !== lastDay) {
        const day = byDate.get(date);
        const group = h("h3", "bq-day", date ? dayName(date, today, yesterday) : "Earlier");
        if (day && !appFilter && !query) group.append(h("span", "", String(day.count)));
        body.append(group);
        lastDay = date;
      }
      const row = button(`bq-done-row${card.dropped ? " is-dropped" : ""}`, "", card.url);
      row.append(glyph(card.dropped ? "close" : "check", "bq-done-mark"));
      const text = h("span", "bq-done-text");
      text.append(h("span", "", splitTitle(card.title, [...card.apps, ...card.apps.map(appName)]).title));
      text.append(h("small", "", `#${card.number}${card.apps.length ? ` · ${card.apps.map(appName).join(" + ")}` : ""}`));
      row.append(text);
      if (card.dropped) row.append(h("span", "bq-dropped", "Dropped"));
      row.addEventListener("click", () => events.openUrl(card.url));
      body.append(row);
      shown++;
    }
    if (!all.length) body.append(h("p", "bq-empty", board?.done ? "Nothing closed yet."
      : board?.done === null ? "GitHub did not send the closes. The next refresh tries again." : "Done needs a newer board read."));
    else if (all.length > shown) body.append(h("p", "bq-empty", `${all.length - shown} more on GitHub.`));
    col.append(head, body);
    return col;
  }

  /* ------------------------------------------------------------ the filter */

  function filterBar(): HTMLElement {
    const bar = h("div", "bq-filter");
    const search = h("label", "bq-search");
    search.append(glyph("search"));
    const input = h("input");
    input.type = "search";
    input.placeholder = "Find an issue";
    input.value = query;
    input.setAttribute("aria-label", "Find an issue by words or number");
    input.addEventListener("input", () => {
      query = input.value.trim();
      paintLanes();
    });
    search.append(input);
    bar.append(search);

    const chips = h("div", "bq-chips");
    chips.setAttribute("role", "radiogroup");
    chips.setAttribute("aria-label", "Show one app");
    const counts = new Map<string, number>();
    for (const card of openCards()) {
      if (!card.apps.length) counts.set(NO_APP, (counts.get(NO_APP) ?? 0) + 1);
      for (const a of card.apps) counts.set(a, (counts.get(a) ?? 0) + 1);
    }
    if (appFilter && !counts.has(appFilter)) appFilter = "";
    const chip = (key: string, label: string, count: number): HTMLButtonElement => {
      const el = button(`bq-chip${appFilter === key ? " is-on" : ""}`);
      el.setAttribute("role", "radio");
      el.setAttribute("aria-checked", String(appFilter === key));
      if (key && key !== NO_APP) el.append(appTile(key, "xs"));
      el.append(h("span", "", label), h("small", "", String(count)));
      el.addEventListener("click", () => {
        appFilter = appFilter === key ? "" : key;
        remember("app", appFilter);
        paintFilter();
        paintLanes();
      });
      return el;
    };
    chips.append(chip("", "All", openCards().length));
    [...counts.entries()].sort((a, b) => b[1] - a[1]).forEach(([key, n]) =>
      chips.append(chip(key, key === NO_APP ? "Ops" : appName(key), n)));
    bar.append(chips);
    return bar;
  }

  function paintFilter(): void {
    if (!filterHost) return;
    const focused = document.activeElement instanceof HTMLInputElement && filterHost.contains(document.activeElement);
    const caret = focused ? (document.activeElement as HTMLInputElement).selectionStart : null;
    const next = filterBar();
    filterHost.replaceWith(next);
    filterHost = next;
    if (focused) {
      const input = next.querySelector("input")!;
      input.focus();
      if (caret !== null) input.setSelectionRange(caret, caret);
    }
  }

  /* ------------------------------------------------------------ the brief, a sheet in the middle */

  /** The issues in the order the board shows them, so ← and → walk the board. */
  const shownCards = (): BoardCard[] => LANES.flatMap((l) => lane(l.key).filter(matches));

  function openBrief(n: number): void {
    selected = n;
    readAt = { number: -1, top: 0, more: false };
    paintBrief();
    screen.querySelector<HTMLElement>(".bq-sheet")?.focus();
  }

  function closeBrief(): void {
    const n = selected;
    selected = null;
    paintBrief();
    // Back to the card it came from, found again in case a refresh rebuilt it.
    screen.querySelector<HTMLElement>(`.bq-card[data-number="${n}"]`)?.focus();
  }

  function step(by: number): void {
    const order = shownCards();
    const at = order.findIndex((c) => c.number === selected);
    const next = at < 0 ? undefined : order[at + by];
    if (next) openBrief(next.number);
  }

  function zoom(host: HTMLElement, src: string): void {
    const big = button("bq-zoom", "", "Click or Esc to close");
    const img = h("img");
    img.src = src;
    img.alt = "Picture for this issue, full size";
    big.append(img);
    big.addEventListener("click", unzoom);
    host.append(big);
    big.focus();
  }

  function unzoom(): void {
    screen.querySelector(".bq-zoom")?.remove();
    screen.querySelector<HTMLElement>(".bq-sheet")?.focus();
  }

  function paintBrief(): void {
    const old = screen.querySelector(".bq-focus");
    const hadFocus = Boolean(old?.contains(document.activeElement));
    old?.remove();
    const found = selected === null ? undefined
      : LANES.map((l) => ({ l, card: lane(l.key).find((c) => c.number === selected) })).find((x) => x.card);
    if (!found?.card) selected = null;
    // The board behind the sheet takes no clicks, keys or focus while it is open.
    for (const el of screen.children) if (el instanceof HTMLElement) el.inert = selected !== null;
    screen.querySelectorAll<HTMLElement>(".bq-card").forEach((el) => el.classList.toggle("is-open", Number(el.dataset.number) === selected));
    if (!found?.card) return;
    const card = found.card;
    const l = found.l;
    const p = level(card);

    const veil = h("div", "bq-focus");
    veil.addEventListener("click", (event) => {
      if (event.target === veil) closeBrief();
    });
    const sheet = h("article", `bq-sheet ${l.tone} p${p}`);
    sheet.tabIndex = -1;
    sheet.dataset.number = String(card.number);
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", `Issue #${card.number}`);

    const top = h("header", "bq-sheet-top");
    const where = h("div", "bq-sheet-where");
    const pill = h("span", "bq-lane-pill");
    pill.append(glyph(l.icon), document.createTextNode(l.title));
    where.append(appTile(card.apps[0] ?? null, "sm"), h("span", "bq-appname", appsLabel(card)), pill);
    if (p <= 1) where.append(h("span", "bq-urgent", tier(p)));
    const order = shownCards();
    const at = order.findIndex((c) => c.number === card.number);
    const nav = h("div", "bq-sheet-nav");
    const walk = (by: number, label: string): HTMLButtonElement => {
      const el = button(`bq-icon-btn${by < 0 ? " is-back" : ""}`, "", `${label} (${by < 0 ? "←" : "→"})`);
      el.append(glyph("arrow"));
      el.setAttribute("aria-label", label);
      el.disabled = at < 0 || !order[at + by];
      el.addEventListener("click", () => step(by));
      return el;
    };
    const close = button("bq-icon-btn", "", "Close (Esc)");
    close.append(glyph("close"));
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", closeBrief);
    nav.append(walk(-1, "Previous issue"), h("small", "bq-pos", at >= 0 ? `${at + 1} of ${order.length}` : ""),
      walk(1, "Next issue"), close);
    top.append(where, nav);
    sheet.append(top);

    const body = h("div", "bq-sheet-body");
    const split = titleOf(card);
    const kicker = [`#${card.number}`, kindOf(card, split.tag)].filter(Boolean).join(" · ");
    body.append(h("p", "bq-kicker", kicker), h("h2", "bq-sheet-title", split.title));

    // The point first: your call when there is one, else the problem.
    const problem = card.problem && !echoes(card.problem, split.title) ? card.problem : "";
    if (card.ask) {
      const ask = h("section", "bq-callout");
      ask.append(h("h3", "", "Your call"), rich("p", "", card.ask));
      body.append(ask);
    } else if (problem) {
      body.append(rich("p", "bq-lead", problem));
    }

    const facts = h("div", "bq-facts");
    const fact = (name: IconName, text: string, cls = ""): void => {
      const el = h("span", `bq-fact ${cls}`.trim());
      el.append(glyph(name), document.createTextNode(text));
      facts.append(el);
    };
    if (card.estimate) fact("clock", `${card.estimate} min of work`);
    if (card.holder) fact("agent", `${engineOf(card.holder).name} on it · ${held(card.claimed_at) || "just now"}`);
    else if (l.key === "waiting") fact("clock", waitReason(card));
    if (card.created_at) fact("inbox", `Filed ${held(card.created_at)} ago`);
    body.append(facts);

    const part = (into: HTMLElement, heading: string, text: string | undefined): void => {
      if (!text) return;
      const box = h("section", "bq-part");
      box.append(h("h3", "", heading), rich("p", "", text));
      into.append(box);
    };
    if (card.ask) part(body, "The problem", problem);
    part(body, "Why it matters", card.why);

    if (card.show?.length) {
      const shots = h("div", `bq-shots${card.show.length === 1 ? " is-one" : ""}`);
      for (const path of card.show.slice(0, 4)) {
        const shot = button("bq-shot", "", "Click to see it big");
        const img = h("img");
        img.alt = "Picture for this issue";
        shot.append(img);
        if (!pictures.has(path)) pictures.set(path, api.picture(path));
        // A path that cannot be read, or a file that is not a picture, shows a plain line, not a broken icon.
        const fail = (error: unknown): void => {
          pictures.delete(path);
          const missing = h("span", "bq-empty", "Picture unavailable");
          missing.title = errorText(error, "The image could not be read");
          shot.replaceWith(missing);
        };
        img.addEventListener("error", () => fail(null), { once: true });
        void pictures.get(path)!.then((src) => { img.src = src; }).catch(fail);
        shot.addEventListener("click", () => {
          if (img.src) zoom(veil, img.src);
        });
        shots.append(shot);
      }
      body.append(shots);
    }

    if (card.goals?.length) {
      const box = h("section", "bq-part");
      box.append(h("h3", "", "Done when"));
      const ol = h("ol", "bq-goal-list");
      for (const g of card.goals) {
        const li = h("li");
        li.append(glyph("target", "bq-goal-mark"));
        const text = h("div");
        text.append(rich("span", "bq-goal", g.goal));
        if (g.check) text.append(rich("span", "bq-proof", `Proof: ${g.check}`));
        li.append(text);
        ol.append(li);
      }
      box.append(ol);
      body.append(box);
    }
    part(body, "What you will see", card.seen);
    part(body, "Already decided", card.decided);

    // The builder's part stays folded: the owner reads the point, an agent reads the plan.
    const more = h("details", "bq-more");
    more.append(h("summary", "", "The plan and the fine print"));
    part(more, "The plan", card.direction);
    part(more, "Cost if nobody does it", card.cost);
    if (typeof card.confidence === "number") {
      const box = h("section", "bq-part");
      box.append(h("h3", "", "How sure the brief is"));
      const row = h("div", "bq-sure");
      row.append(meter(card.confidence, 100, card.confidence < 70 ? "is-low" : "is-win", "How sure the brief is of what you mean"),
        h("b", "", `${card.confidence}%`));
      box.append(row);
      if (card.confidence < 70) box.append(h("small", "bq-note", "Under 70%: an agent asks you before it guesses."));
      more.append(box);
    }
    const meta: string[] = [];
    if (card.run_with) meta.push(`Built by ${card.run_with}`);
    if (card.bundle) meta.push(`Bundle ${card.bundle}`);
    if (card.recheck) meta.push(`Recheck ${shortDate(card.recheck)}`);
    if (card.after?.length) meta.push(`After ${card.after.map((n) => `#${n}`).join(", ")}`);
    if (meta.length) more.append(h("p", "bq-meta", meta.join(" · ")));
    if (more.children.length > 1) body.append(more);
    sheet.append(body);

    const foot = h("footer", "bq-sheet-foot");
    const github = button("bq-primary", "", card.url);
    github.append(glyph("external"), document.createTextNode("Open on GitHub"));
    github.addEventListener("click", () => events.openUrl(card.url));
    foot.append(github, h("small", "", "← → next issue · Esc closes"));
    sheet.append(foot);
    veil.append(sheet);
    screen.append(veil);

    // A refresh rebuilds the brief after paint() has already dropped the old one. The place is kept live instead.
    if (readAt.number === card.number) {
      more.open = readAt.more;
      body.scrollTop = readAt.top;
    }
    const keep = (): void => { readAt = { number: card.number, top: body.scrollTop, more: more.open }; };
    body.addEventListener("scroll", keep, { passive: true });
    more.addEventListener("toggle", keep);
    // A refresh drops the old sheet with focus inside it, so focus falls to the body. Take it back, or the keys stop.
    if (hadFocus || document.activeElement === document.body || !document.activeElement) sheet.focus();
  }

  /* ------------------------------------------------------------ the screen */

  function header(): HTMLElement {
    const head = h("header", "bq-header");
    const left = h("div", "bq-heading");
    left.append(h("h1", "", "Board"));
    // One plain count. GitHub not sending the closes reads as unknown, never as zero.
    if (board && board.done !== undefined) {
      const done = board.done === null ? "–" : number(days(board.done).today.count);
      const count = h("span", "bq-today", `${done} done today`);
      if (board.done === null) count.title = "GitHub did not send the closes. The next refresh tries again.";
      left.append(count);
    }
    const actions = h("div", "bq-actions");
    if (board?.at) {
      const stamp = h("small", "bq-stamp", `Read ${when(board.at)}`);
      stamp.title = "When the board was last read from GitHub";
      actions.append(stamp);
    }
    const swipe = button("bq-action is-swipe", "Swipe review", "Judge what was shipped and filed since your last review, one card at a time");
    swipe.addEventListener("click", () => events.openSwipe());
    const reread = button("bq-action", "Refresh", "Read the board again");
    reread.addEventListener("click", () => void refresh(true));
    actions.append(swipe, reread);
    if (board?.repo) {
      const github = button("bq-action", "GitHub", `Open ${board.repo} issues`);
      github.addEventListener("click", () => events.openUrl(`https://github.com/${board!.repo}/issues`));
      actions.append(github);
    }
    head.append(left, actions);
    return head;
  }

  function paintScreen(): void {
    if (!visible) return;
    if (!failure && !board) {
      screen.replaceChildren(h("p", "bq-loading", "Reading the board…"));
      return;
    }
    const parts: HTMLElement[] = [header()];
    const error = failure || board?.error;
    if (error) parts.push(h("p", "bq-error", `The board could not be read: ${error}`));
    const hasBoard = board && (board.now || board.ready || board.next);
    if (!hasBoard) {
      lanesHost = filterHost = null;
      screen.replaceChildren(...parts);
      return;
    }
    const focusedSearch = document.activeElement instanceof HTMLInputElement && Boolean(filterHost?.contains(document.activeElement));
    const caret = focusedSearch ? (document.activeElement as HTMLInputElement).selectionStart : null;
    saveScroll();
    const main = h("div", "bq-main");
    filterHost = filterBar();
    main.append(filterHost);
    lanesHost = h("div", "bq-lanes-host");
    paintLanes();
    main.append(lanesHost);
    parts.push(main);
    screen.replaceChildren(...parts);
    restoreScroll();
    if (focusedSearch) {
      const input = filterHost.querySelector("input")!;
      input.focus();
      if (caret !== null) input.setSelectionRange(caret, caret);
    }
    paintBrief();
  }

  function paint(): void {
    paintScreen();
  }

  paint();

  return {
    open() {
      visible = true;
      screen.hidden = false;
      paintScreen();
      void refresh();
    },
    clear() {
      visible = false;
      screen.hidden = true;
    },
    refresh(fresh = false) {
      void refresh(fresh);
    },
    dispose() {
      screen.replaceChildren();
    },
  };
}
