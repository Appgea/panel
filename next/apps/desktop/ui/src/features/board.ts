/**
 * Board — the quest board. Every open issue in Appgea/ops as a card in one of four lanes: your move,
 * in play, ready, waiting. Done quests score XP above them. Click a card and its brief opens beside
 * the lanes in plain parts: the problem, why it matters, the goals and their proof.
 * Owner, 2026-11-01: "I should enjoy looking at it and understand them at once".
 *
 * The Crew tab holds the scouts that find the work and the builds that do it.
 *
 * One screen, read from the `scout` extension. With it absent the Board does not exist. There is no
 * strip on other screens: Owner, 2026-10-30, "it is an antipattern".
 *
 * Scouts never start on their own here. `board next` runs due scouts as part of the work, and the
 * Run button runs one now. Nothing polls: a read happens on focus, on session and report events,
 * and once more when the next scout falls due, so it reads as due.
 */
import { errorText } from "../errors";
import { icon, type IconName } from "../icons";
import { dayKey, engineOf, score, splitTitle, xpOf, type Score } from "./board_score";
import "./board.css";

export type ScoutRun = {
  at: string;
  status: "running" | "done" | "failed" | "stale";
  found: number;
  note: string;
  session: string | null;
};
export type Scout = {
  id: string;
  title: string;
  every: string;
  after: number;
  kind: "script" | "agent";
  agent: string | null;
  model: string | null;
  needs: string | null;
  summary: string;
  error: string | null;
  due: boolean;
  next_at: string | null;
  last: ScoutRun | null;
};
export type ScoutList = { now: string; next_due_at: string | null; scouts: Scout[] };
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
export type RunningBuild = {
  pid: number;
  builder: string;
  effort: string;
  kind: string;
  repo: string;
  task: string;
  session: string;
  started: string;
};
/** A finished row of builds.tsv. Every cell is text; "-" means not known yet. */
export type BuildRow = {
  date: string;
  builder: string;
  effort: string;
  repo: string;
  minutes: string;
  exit: string;
  session: string;
  kind: string;
  verdict: string;
  task: string;
};
export type BuildList = { running: RunningBuild[]; recent: BuildRow[]; at?: string; error?: string };

/** The extension's routes, behind one seam so the dev harness can stand in for it. */
export type BoardApi = {
  scouts(): Promise<ScoutList>;
  board(fresh: boolean): Promise<BoardData>;
  builds(): Promise<BuildList>;
  picture(path: string): Promise<string>;
  run(id: string): Promise<ScoutRun>;
  prompt(id: string): Promise<string>;
  start(id: string, session: string): Promise<ScoutRun>;
  record(id: string, status: "done" | "failed", note: string): Promise<ScoutRun>;
};

export type BoardEvents = {
  api: BoardApi;
  appIcon(dir: string): string | null;
  openUrl(url: string): void;
  /** Open a visible terminal for an agent scout and type its prompt. `started` runs before the
   *  prompt is typed. The session id, or null. */
  launch(scout: Scout, prompt: string, started: (session: string) => Promise<unknown>): Promise<string | null>;
  /** Bring a scout's terminal forward. False when it is gone. */
  showSession(session: string): boolean;
  isLive(session: string): boolean;
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

const EVERY: Record<string, string> = { daily: "Daily", sunday: "Sundays", manual: "On demand" };
const cadence = (every: string): string => EVERY[every] ?? `Every ${every.replace(/h$/, " hours")}`;

/** Priority as a tier. The word says it; the colour only repeats it. */
const TIERS = ["Critical", "High", "Normal", "Low"];
const tier = (p: number): string => TIERS[Math.min(Math.max(p, 0), 3)];
const KIND_WORD: Record<string, string> = {
  speed: "Speed", redesign: "Redesign", "bug-report": "Bug", question: "Question", guide: "Guide",
};

/** One word for a scout's state, and the tone it wears. Due wins over the last run: it is what happens next. */
const scoutState = (scout: Scout, live: boolean): { tone: string; word: string } => {
  if (scout.error) return { tone: "t-risk", word: "broken" };
  if (scout.last?.status === "running" && (scout.kind === "script" || live)) return { tone: "t-work", word: "running" };
  if (scout.due) return { tone: "t-warn", word: "due" };
  if (scout.last?.status === "failed") return { tone: "t-risk", word: "failed" };
  if (scout.last?.status === "stale" || scout.last?.status === "running") return { tone: "t-quiet", word: "stopped" };
  if (scout.last?.status === "done") return { tone: scout.last.found ? "t-warn" : "t-ok", word: scout.last.found ? `${scout.last.found} filed` : "done" };
  return { tone: "t-quiet", word: "not run" };
};

/** Tone and verdict word for a finished build. A bad exit or a wrong verdict outranks a good one. */
const buildState = (row: BuildRow): { tone: string; word: string } => {
  if (row.verdict === "wrong") return { tone: "t-risk", word: "wrong" };
  if (row.exit !== "0" && row.exit !== "-") return { tone: "t-risk", word: row.verdict === "-" ? `exit ${row.exit}` : row.verdict };
  if (row.verdict === "ship") return { tone: "t-ok", word: "ship" };
  if (row.verdict === "fix") return { tone: "t-warn", word: "fix" };
  return { tone: "t-quiet", word: "no verdict yet" };
};

type Lane = "you" | "now" | "ready" | "waiting";
type Tab = "quests" | "crew";
const LANES: { key: Lane; title: string; hint: string; tone: string; empty: string }[] = [
  { key: "you", title: "Your move", hint: "Only you can unblock these", tone: "t-warn", empty: "Nothing waits on you." },
  { key: "now", title: "In play", hint: "An agent is on it right now", tone: "t-work", empty: "Nobody is on a quest. Type work in a terminal." },
  { key: "ready", title: "Ready", hint: "Free to take, best first", tone: "t-ready", empty: "No free quests." },
  { key: "waiting", title: "Waiting", hint: "Comes back on a date, or after another quest", tone: "t-quiet", empty: "Nothing is parked." },
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
  let list: ScoutList | null = null;
  let board: BoardData | null = null;
  let builds: BuildList = { running: [], recent: [] };
  let failure = "";
  let busy = false;
  let again = false;
  let againFresh = false;
  let timer = 0;
  let visible = false;
  let lastFresh = 0;
  let tab: Tab = remember("tab") === "crew" ? "crew" : "quests";
  let appFilter = remember("app");
  let query = "";
  let selected: number | null = null;
  /** Where the open brief was scrolled to, so a background refresh does not throw the owner back to its top. */
  let readAt = { number: -1, top: 0 };
  let opener: HTMLElement | null = null;
  const pictures = new Map<string, Promise<string>>();
  let lanesHost: HTMLElement | null = null;
  let filterHost: HTMLElement | null = null;

  screen.classList.add("board");
  screen.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && selected !== null) {
      event.stopPropagation();
      closeDrawer();
    }
  });

  const live = (scout: Scout): boolean => Boolean(scout.last?.session && events.isLive(scout.last.session));

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
      const [scouts, read, builtList] = await Promise.all([
        api.scouts(),
        api.board(fresh).catch((error: unknown): BoardData => ({ error: errorText(error, "the scout extension did not answer") })),
        // Builds are extra. A failure here shows in their section and never breaks the board.
        api.builds().catch((error: unknown): BuildList => ({ running: [], recent: [], error: errorText(error, "builds could not be read") })),
      ]);
      list = scouts;
      builds = builtList;
      // A failed read keeps the last good board on screen, with the error above it.
      board = read.error && board && !board.error ? { ...board, error: read.error } : tidy(read);
      const paths = new Set(openCards().flatMap((card) => card.show ?? []));
      for (const path of pictures.keys()) if (!paths.has(path)) pictures.delete(path);
      failure = "";
      paint();
      schedule();
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

  async function runScript(scout: Scout): Promise<void> {
    scout.last = { at: new Date().toISOString(), status: "running", found: 0, note: "", session: null };
    scout.due = false;
    paint();
    try {
      scout.last = await api.run(scout.id);
    } catch (error) {
      scout.last = { ...scout.last, status: "failed", note: errorText(error, "the scout extension did not answer") };
    }
    // It may have filed issues. The next board read is fresh.
    if (scout.last.found) board = await api.board(true).then(tidy).catch(() => board);
    paint();
  }

  async function launch(scout: Scout): Promise<void> {
    scout.due = false;
    try {
      let began: ScoutRun | null = null;
      const session = await events.launch(scout, await api.prompt(scout.id), async (id) => {
        began = await api.start(scout.id, id);
      });
      // A terminal that never opened still counts as a run, so the scout reads as failed, not due.
      scout.last = session && began ? began : await api.record(scout.id, "failed", "the terminal did not take its prompt");
    } catch (error) {
      scout.last = await api.record(scout.id, "failed", errorText(error, "the scout extension did not answer")).catch(() => scout.last);
    }
    paint();
  }

  function schedule(): void {
    window.clearTimeout(timer);
    if (!list?.next_due_at) return;
    // A second past the hour, so the scout reads as due. Capped, because a sleeping Mac stretches timers.
    const wait = new Date(list.next_due_at).getTime() - Date.now() + 1000;
    timer = window.setTimeout(() => void refresh(), Math.min(Math.max(wait, 5000), 6 * 3_600_000));
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

  function xpChip(card: { estimate?: number }, prefix = ""): HTMLElement {
    const chip = h("span", "bq-xp");
    chip.append(glyph("bolt"), document.createTextNode(`${prefix}${xpOf(card)} XP`));
    chip.title = card.estimate ? `${card.estimate} min estimated. 1 XP per minute.` : "No estimate. Counts as a small quest.";
    return chip;
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

  /* ------------------------------------------------------------ a quest card */

  function questCard(card: BoardCard, key: Lane, first: boolean): HTMLButtonElement {
    const el = button(`bq-card p${Math.min(Math.max(card.priority, 0), 3)}`);
    el.dataset.number = String(card.number);
    if (selected === card.number) el.classList.add("is-open");
    el.setAttribute("aria-label", `#${card.number} ${card.title}`);

    const top = h("span", "bq-card-top");
    const apps = h("span", "bq-apps");
    if (card.apps.length) card.apps.slice(0, 3).forEach((a) => apps.append(appTile(a, "sm")));
    else apps.append(appTile(null, "sm"));
    apps.append(h("span", "bq-appname", card.apps.length ? card.apps.map(appName).join(" + ") : "Ops"));
    top.append(apps);
    if (first && key === "ready") top.append(h("span", "bq-badge-next", "Next up"));
    top.append(h("span", "bq-num", `#${card.number}`));
    el.append(top);

    const words = [...card.apps, ...card.apps.map(appName)];
    const split = splitTitle(card.title, words);
    el.append(h("span", "bq-title", split.title));
    if (card.problem && !echoes(card.problem, split.title)) {
      el.append(rich("span", "bq-problem", card.problem));
    }
    if (key === "you" && card.ask) {
      const ask = h("span", "bq-ask");
      ask.append(h("b", "", "Your call"), rich("span", "", card.ask));
      el.append(ask);
    }
    if (key === "now" && card.holder) {
      const who = h("span", "bq-holder");
      const engine = engineOf(card.holder);
      who.append(avatar(card.holder), h("span", "", engine.name), h("small", "", held(card.claimed_at)));
      el.append(who);
      if (card.claimed_at && card.estimate && card.estimate > 0) {
        const minutes = Math.max(0, (Date.now() - Date.parse(card.claimed_at)) / 60_000);
        if (Number.isFinite(minutes)) {
          const label = `${Math.round(minutes)} of ${card.estimate} min`;
          const bar = meter(minutes, card.estimate, minutes > card.estimate ? "is-over" : "", "Time held against the estimate");
          bar.setAttribute("aria-valuetext", label);
          bar.title = label;
          el.append(bar);
        }
      }
    }

    const foot = h("span", "bq-foot");
    const chip = h("span", "bq-tier", `P${card.priority} ${tier(card.priority)}`);
    foot.append(chip);
    if (split.tag) foot.append(h("span", "bq-tag", split.tag));
    for (const kind of card.kinds ?? []) {
      const word = KIND_WORD[kind];
      if (word && word.toLowerCase() !== split.tag.toLowerCase()) foot.append(h("span", "bq-tag", word));
    }
    if (key === "waiting") {
      const wait = h("span", "bq-tag bq-wait");
      wait.append(glyph("clock"), document.createTextNode(waitReason(card)));
      foot.append(wait);
    }
    foot.append(h("span", "bq-gap"));
    if (card.goals?.length) {
      const goals = h("span", "bq-goals");
      goals.append(glyph("target"), document.createTextNode(String(card.goals.length)));
      goals.title = `${card.goals.length} goal${card.goals.length === 1 ? "" : "s"} to finish it`;
      foot.append(goals);
    }
    foot.append(xpChip(card));
    el.append(foot);

    el.addEventListener("click", () => openDrawer(card.number, el));
    return el;
  }

  /* ------------------------------------------------------------ the score */

  function scoreStrip(s: Score): HTMLElement {
    const strip = h("section", "bq-score");
    strip.setAttribute("aria-label", "Score");

    const tile = (cls: string, iconName: IconName, value: string, label: string, sub: string | HTMLElement): HTMLElement => {
      const el = h("div", `bq-stat ${cls}`);
      const head = h("div", "bq-stat-head");
      head.append(glyph(iconName), h("span", "", label));
      el.append(head, h("b", "bq-stat-value", value));
      if (typeof sub === "string") el.append(h("small", "", sub));
      else el.append(sub);
      return el;
    };

    // GitHub did not send the closes. A zero here would read as a lost streak, so the score says it is unread.
    const unread = board?.done === null;
    const show = (value: number): string => (unread ? "–" : number(value));
    const later = "Unread, next refresh tries";

    strip.append(tile("is-today", "trophy", show(s.today.count), "Done today",
      unread ? later : s.today.count ? `+${number(s.today.xp)} XP earned` : "No close yet"));

    const beat = s.week - s.lastWeek;
    const weekSub = h("div", "bq-stat-sub");
    if (unread) weekSub.append(h("small", "", later));
    else weekSub.append(meter(s.week, Math.max(s.week, s.lastWeek, 1), beat >= 0 ? "is-win" : "", "This week against last week"),
      h("small", "", s.lastWeek === 0 ? "Last week had none"
        : beat >= 0 ? `Beat last week by ${number(beat)} XP` : `${number(-beat)} XP to beat last week`));
    strip.append(tile("is-week", "bolt", show(s.week), "XP, last 7 days", weekSub));

    strip.append(tile(s.streak >= 3 ? "is-hot" : "", "flame", show(s.streak), "Day streak",
      unread ? later : s.streak >= 14 ? "Every day for two weeks" : s.today.count ? "Today counts" : "Close one today to keep it"));

    const you = lane("you").length, now = lane("now").length, ready = lane("ready").length, waiting = lane("waiting").length;
    strip.append(tile("is-open", "target", number(board?.open ?? you + now + ready + waiting), "Open quests",
      `${now} in play · ${ready} ready`));

    strip.append(chart(s));
    return strip;
  }

  /** XP per day for two weeks. One series, so no legend: the title names it. */
  function chart(s: Score): HTMLElement {
    const box = h("div", "bq-chart");
    const head = h("div", "bq-stat-head");
    head.append(glyph("analytics"), h("span", "", "XP per day, 14 days"));
    box.append(head);
    const bars = h("div", "bq-bars");
    bars.setAttribute("role", "list");
    const max = Math.max(...s.days.map((d) => d.xp), 1);
    const tip = h("div", "bq-tip");
    tip.hidden = true;
    s.days.forEach((day, i) => {
      const col = h("div", `bq-bar${i === s.days.length - 1 ? " is-today" : ""}`);
      col.setAttribute("role", "listitem");
      const label = `${new Date(`${day.date}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}: ${day.count} done, ${number(day.xp)} XP`;
      col.setAttribute("aria-label", label);
      col.tabIndex = -1;
      const fill = h("i");
      fill.style.height = `${day.xp ? Math.max(6, (day.xp / max) * 100) : 0}%`;
      col.append(fill);
      const show = (): void => {
        tip.textContent = label;
        tip.hidden = false;
        tip.style.left = `${((i + 0.5) / s.days.length) * 100}%`;
      };
      col.addEventListener("mouseenter", show);
      col.addEventListener("mouseleave", () => { tip.hidden = true; });
      bars.append(col);
    });
    box.append(bars, tip);
    return box;
  }

  /* ------------------------------------------------------------ the lanes */

  /** A repaint keeps where each lane, and the row of lanes, was scrolled to. Read while still on screen:
   *  a detached element reads 0. */
  const scrolled = new Map<string, number>();
  function saveScroll(): void {
    screen.querySelectorAll<HTMLElement>(".bq-lane-body").forEach((el) => scrolled.set(el.dataset.lane ?? "", el.scrollTop));
    const row = screen.querySelector<HTMLElement>(".bq-lanes");
    if (row) scrolled.set("_row", row.scrollLeft);
  }
  function restoreScroll(): void {
    screen.querySelectorAll<HTMLElement>(".bq-lane-body").forEach((el) => { el.scrollTop = scrolled.get(el.dataset.lane ?? "") ?? 0; });
    const row = screen.querySelector<HTMLElement>(".bq-lanes");
    if (row) row.scrollLeft = scrolled.get("_row") ?? 0;
  }

  function paintLanes(): void {
    if (!lanesHost) return;
    const row = h("div", "bq-lanes");
    for (const l of LANES) {
      const cards = lane(l.key).filter(matches);
      const col = h("section", `bq-lane ${l.tone}`);
      col.setAttribute("aria-label", l.title);
      const head = h("header", "bq-lane-head");
      const title = h("h2", "", l.title);
      title.append(h("span", "bq-count", String(cards.length)));
      head.append(title, h("small", "", l.hint));
      const body = h("div", "bq-lane-body");
      body.dataset.lane = l.key;
      if (cards.length) cards.forEach((c, i) => body.append(questCard(c, l.key, i === 0 && !query && !appFilter)));
      else body.append(h("p", "bq-empty", lane(l.key).length ? "No match for this filter." : l.empty));
      col.append(head, body);
      row.append(col);
    }
    row.append(doneLane());
    lanesHost.replaceChildren(row);
  }

  function doneLane(): HTMLElement {
    const col = h("section", "bq-lane t-ok bq-done");
    col.setAttribute("aria-label", "Done");
    const all = (board?.done ?? []).filter(matches);
    const s = score(board?.done ?? []);
    const head = h("header", "bq-lane-head");
    const title = h("h2", "", "Done");
    title.append(h("span", "bq-count", String(all.filter((d) => !d.dropped).length)));
    head.append(title, h("small", "", "Closed in the last 14 days"));
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
        if (day && !appFilter && !query) group.append(h("span", "", `${day.count} · ${number(day.xp)} XP`));
        body.append(group);
        lastDay = date;
      }
      const row = button(`bq-done-row${card.dropped ? " is-dropped" : ""}`, "", card.url);
      row.append(glyph(card.dropped ? "close" : "check", "bq-done-mark"));
      const text = h("span", "bq-done-text");
      text.append(h("span", "", splitTitle(card.title, [...card.apps, ...card.apps.map(appName)]).title));
      text.append(h("small", "", `#${card.number}${card.apps.length ? ` · ${card.apps.map(appName).join(" + ")}` : ""}`));
      row.append(text);
      row.append(card.dropped ? h("span", "bq-dropped", "Dropped") : xpChip(card, "+"));
      row.addEventListener("click", () => events.openUrl(card.url));
      body.append(row);
      shown++;
    }
    if (!all.length) body.append(h("p", "bq-empty", board?.done ? "Nothing closed yet."
      : board?.done === null ? "GitHub did not send the closes. The next refresh tries again." : "The score needs a newer board read."));
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
    input.placeholder = "Find a quest";
    input.value = query;
    input.setAttribute("aria-label", "Find a quest by words or number");
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

  /* ------------------------------------------------------------ the brief, beside the lanes */

  function openDrawer(n: number, from: HTMLElement): void {
    selected = n;
    readAt = { number: -1, top: 0 };
    opener = from;
    screen.querySelectorAll(".bq-card.is-open").forEach((el) => el.classList.remove("is-open"));
    from.classList.add("is-open");
    paintDrawer();
    screen.querySelector<HTMLElement>(".bq-drawer")?.focus();
  }

  function closeDrawer(): void {
    selected = null;
    screen.querySelectorAll(".bq-card.is-open").forEach((el) => el.classList.remove("is-open"));
    screen.querySelector(".bq-drawer")?.remove();
    // Back to the card it came from, or to the same card after a repaint.
    const back = opener?.isConnected ? opener : null;
    opener = null;
    back?.focus();
  }

  function paintDrawer(): void {
    const old = screen.querySelector(".bq-drawer");
    const hadFocus = Boolean(old?.contains(document.activeElement));
    old?.remove();
    if (selected === null || tab !== "quests") return;
    const found = LANES.map((l) => ({ l, card: lane(l.key).find((c) => c.number === selected) })).find((x) => x.card);
    if (!found?.card) {
      selected = null;
      return;
    }
    const { card } = found;
    const l = found.l;
    const drawer = h("aside", `bq-drawer p${Math.min(Math.max(card.priority, 0), 3)}`);
    drawer.tabIndex = -1;
    drawer.dataset.number = String(card.number);
    drawer.setAttribute("aria-label", `Quest #${card.number}`);

    const top = h("header", "bq-drawer-top");
    const where = h("div", "bq-drawer-where");
    where.append(h("span", `bq-lane-pill ${l.tone}`, l.title), h("span", "bq-tier", `P${card.priority} ${tier(card.priority)}`),
      h("span", "bq-num", `#${card.number}`));
    const close = button("bq-icon-btn", "", "Close (Esc)");
    close.append(glyph("close"));
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", closeDrawer);
    top.append(where, close);
    drawer.append(top);

    const scroll = h("div", "bq-drawer-body");
    const apps = h("div", "bq-apps");
    if (card.apps.length) card.apps.forEach((a) => apps.append(appTile(a, "sm")));
    else apps.append(appTile(null, "sm"));
    apps.append(h("span", "bq-appname", card.apps.length ? card.apps.map(appName).join(" + ") : "Ops"));
    scroll.append(apps);
    const split = splitTitle(card.title, [...card.apps, ...card.apps.map(appName)]);
    const title = h("h2", "bq-drawer-title", split.title);
    scroll.append(title);

    const facts = h("div", "bq-facts");
    const fact = (iconName: IconName, value: string, label: string): void => {
      const el = h("div", "bq-fact");
      el.append(glyph(iconName), h("b", "", value), h("small", "", label));
      facts.append(el);
    };
    fact("bolt", `${xpOf(card)} XP`, card.estimate ? `${card.estimate} min of work` : "No estimate");
    if (card.goals?.length) fact("target", String(card.goals.length), card.goals.length === 1 ? "goal" : "goals");
    if (card.holder) fact("agent", engineOf(card.holder).name, `on it for ${held(card.claimed_at) || "a moment"}`);
    else if (l.key === "waiting") fact("clock", waitReason(card), "then it is free");
    else if (card.created_at) fact("clock", held(card.created_at), "since it was filed");
    scroll.append(facts);

    if (card.ask) {
      const ask = h("section", "bq-callout");
      ask.append(h("h3", "", "Your call"), rich("p", "", card.ask));
      scroll.append(ask);
    }
    const part = (heading: string, text: string | undefined, cls = ""): void => {
      if (!text) return;
      const box = h("section", `bq-part ${cls}`.trim());
      box.append(h("h3", "", heading), rich("p", "", text));
      scroll.append(box);
    };
    if (card.problem && !echoes(card.problem, split.title)) part("The problem", card.problem);
    part("Why it matters", card.why);
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
      scroll.append(box);
    }
    part("What you will see", card.seen);
    part("Already decided", card.decided);
    part("The plan", card.direction, "is-quiet");
    part("Cost if nobody does it", card.cost, "is-quiet");

    if (typeof card.confidence === "number") {
      const box = h("section", "bq-part");
      box.append(h("h3", "", "How sure the brief is"));
      const row = h("div", "bq-sure");
      row.append(meter(card.confidence, 100, card.confidence < 70 ? "is-low" : "is-win", "How sure the brief is of what you mean"),
        h("b", "", `${card.confidence}%`));
      box.append(row);
      if (card.confidence < 70) box.append(h("small", "bq-note", "Under 70%: an agent asks you before it guesses."));
      scroll.append(box);
    }

    const meta: string[] = [];
    if (card.run_with) meta.push(`Built by ${card.run_with}`);
    if (card.bundle) meta.push(`Bundle ${card.bundle}`);
    if (card.recheck) meta.push(`Recheck ${shortDate(card.recheck)}`);
    if (card.after?.length) meta.push(`After ${card.after.map((n) => `#${n}`).join(", ")}`);
    if (meta.length) scroll.append(h("p", "bq-meta", meta.join(" · ")));

    if (card.show?.length) {
      const preview = h("div", "bq-pictures");
      for (const path of card.show.slice(0, 2)) {
        const img = h("img", "bq-picture");
        img.alt = "Picture for this quest";
        if (!pictures.has(path)) pictures.set(path, api.picture(path));
        void pictures.get(path)!.then((src) => { img.src = src; }).catch((error: unknown) => {
          pictures.delete(path);
          const missing = h("span", "bq-empty", "Picture unavailable");
          missing.title = errorText(error, "The image could not be read");
          img.replaceWith(missing);
        });
        preview.append(img);
      }
      scroll.append(preview);
    }
    drawer.append(scroll);

    const foot = h("footer", "bq-drawer-foot");
    const github = button("bq-primary", "", card.url);
    github.append(glyph("external"), document.createTextNode("Open on GitHub"));
    github.addEventListener("click", () => events.openUrl(card.url));
    foot.append(github);
    drawer.append(foot);
    screen.append(drawer);
    // A refresh rebuilds the brief after paint() has already dropped the old one. The place is kept live instead.
    if (readAt.number === card.number) scroll.scrollTop = readAt.top;
    scroll.addEventListener("scroll", () => { readAt = { number: card.number, top: scroll.scrollTop }; }, { passive: true });
    if (hadFocus) drawer.focus();
  }

  /* ------------------------------------------------------------ crew: builds and scouts */

  function section(title: string, count: number | null, rows: HTMLElement[], empty: string): HTMLElement {
    const box = h("section", "bd-section");
    const head = h("h2", "", title);
    if (count !== null) head.append(h("span", "bd-count", String(count)));
    box.append(head);
    if (rows.length) box.append(...rows);
    else box.append(h("p", "bd-empty", empty));
    return box;
  }

  function buildRow(build: RunningBuild | BuildRow): HTMLElement {
    const running = "pid" in build;
    const state = running ? { tone: "t-work", word: "" } : buildState(build);
    const row = h("div", `bd-build ${state.tone}`);
    // core:pulse — alive. Only a running build's dot moves.
    row.append(h("i", running ? "bd-dot mo-pulse" : "bd-dot"));
    // The builder sits where an issue's number sits, so titles line up down the screen.
    const who = h("b", "bd-num", build.builder);
    who.title = build.builder;
    row.append(who);
    const text = h("div", "bd-text");
    const title = h("span", "bd-title", build.task && build.task !== "-" ? build.task : "(no title)");
    title.title = title.textContent ?? "";
    text.append(title);
    const facts = running
      ? [build.effort, build.kind, build.repo]
      : [build.effort, state.word, build.exit === "4" ? "out of scope" : "", build.repo];
    const line = h("small", "", facts.filter((f) => f && f !== "-").join(" · "));
    line.title = line.textContent ?? "";
    text.append(line);
    row.append(text);
    const took = running ? held(build.started) : build.minutes !== "-" ? `${build.minutes}m` : "";
    row.append(h("span", "bd-kind", took));
    return row;
  }

  function scoutRow(scout: Scout): HTMLElement {
    const isLive = live(scout);
    const state = scoutState(scout, isLive);
    const row = h("div", `bd-scout ${state.tone}`);
    // core:pulse — alive. Only a running scout loops; every other state is still.
    row.append(h("i", state.word === "running" ? "bd-dot mo-pulse" : "bd-dot"));
    const text = h("div", "bd-text");
    const title = h("span", "bd-title", scout.title);
    title.title = scout.summary;
    text.append(title);
    const facts: string[] = [state.word];
    if (scout.error) facts.push(scout.error);
    else if (scout.last && scout.last.status !== "running") facts.push(when(scout.last.at), scout.last.note);
    if (scout.next_at) facts.push(`next ${when(scout.next_at)}`);
    if (scout.needs) facts.push(`needs ${scout.needs}`);
    const line = h("small", "", facts.filter(Boolean).join(" · "));
    line.title = line.textContent ?? "";
    text.append(line);
    row.append(text);
    const kind = h("span", "bd-kind", scout.kind === "script" ? "script" : scout.agent ?? "agent");
    kind.title = scout.kind === "script" ? "Runs a script. No AI." : `Opens a ${scout.agent} terminal you can watch`;
    row.append(kind);
    if (isLive && scout.last?.session) {
      const show = button("bd-act", "Show", "Bring its terminal forward");
      show.addEventListener("click", () => events.showSession(scout.last!.session!));
      row.append(show);
    } else if (!scout.error) {
      const run = button("bd-act", "Run", scout.kind === "script" ? "Run it now" : "Open its terminal now");
      run.disabled = scout.last?.status === "running" && scout.kind === "script";
      run.addEventListener("click", () => {
        run.disabled = true;
        // Then a full read: the list may have been replaced while this ran.
        void (scout.kind === "script" ? runScript(scout) : launch(scout)).finally(() => void refresh());
      });
      row.append(run);
    }
    return row;
  }

  function crew(): HTMLElement {
    const rows = [...builds.running.map(buildRow), ...builds.recent.map(buildRow)];
    const empty = builds.error ? `Builds could not be read: ${builds.error}` : "No builds yet. Say orchestrate in a terminal.";
    const buildBox = section("Builds", builds.running.length, rows, empty);
    if (builds.error) buildBox.querySelector(".bd-empty")?.classList.add("bd-error-line");
    const work = h("div", "bd-work");
    work.append(buildBox);

    const scouts = h("aside", "bd-scouts");
    scouts.append(h("h2", "", "Scouts"));
    const groups = new Map<string, Scout[]>();
    for (const scout of list?.scouts ?? []) {
      const key = cadence(scout.every);
      groups.set(key, [...(groups.get(key) ?? []), scout]);
    }
    for (const [name, members] of groups) scouts.append(h("h3", "", name), ...members.map(scoutRow));
    if (!list?.scouts.length) scouts.append(h("p", "bd-empty", "No scouts yet. Add a file to ops/scouts."));

    const body = h("div", "bd-body");
    body.append(work, scouts);
    return body;
  }

  /* ------------------------------------------------------------ the screen */

  function header(): HTMLElement {
    const head = h("header", "bq-header");
    const left = h("div", "bq-heading");
    left.append(h("h1", "", "Board"));
    const tabs = h("div", "bq-tabs");
    tabs.setAttribute("role", "tablist");
    const running = builds.running.length + (list?.scouts.filter((s) => s.last?.status === "running" && (s.kind === "script" || live(s))).length ?? 0);
    for (const [key, label] of [["quests", "Quests"], ["crew", running ? `Crew · ${running} running` : "Crew"]] as const) {
      const t = button(`bq-tab${tab === key ? " is-on" : ""}`, label);
      t.setAttribute("role", "tab");
      t.setAttribute("aria-selected", String(tab === key));
      t.addEventListener("click", () => {
        if (tab === key) return;
        tab = key;
        remember("tab", tab);
        paint();
      });
      tabs.append(t);
    }
    left.append(tabs);
    const actions = h("div", "bq-actions");
    if (board?.at) {
      const stamp = h("small", "bq-stamp", `Read ${when(board.at)}`);
      stamp.title = "When the board was last read from GitHub";
      actions.append(stamp);
    }
    const swipe = button("bq-action is-swipe", "Swipe review", "Judge what was shipped and filed since your last review, one card at a time");
    swipe.addEventListener("click", () => events.openSwipe());
    const reread = button("bq-action", "Refresh", "Read the board and the scouts again");
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
    if (!list && !failure && !board) {
      screen.replaceChildren(h("p", "bq-loading", "Reading the board…"));
      return;
    }
    const parts: HTMLElement[] = [header()];
    const error = failure || board?.error;
    if (error) parts.push(h("p", "bq-error", `The board could not be read: ${error}`));
    if (tab === "crew") {
      lanesHost = filterHost = null;
      parts.push(crew());
      screen.replaceChildren(...parts);
      return;
    }
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
    main.append(scoreStrip(score(board!.done ?? [])));
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
    paintDrawer();
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
      window.clearTimeout(timer);
      screen.replaceChildren();
    },
  };
}
