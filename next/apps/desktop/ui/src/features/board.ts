/**
 * Board — what is happening, all the time: who holds which issue, what waits on you, what is
 * next, and the scouts that find the work.
 *
 * One screen, read from the `scout` extension. With it absent the Board does not exist. There is no
 * strip on other screens: Owner, 2026-10-30, "it is an antipattern".
 *
 * Scouts never start on their own here. `board next` runs due scouts as part of the work, and the
 * Run button runs one now. Nothing polls: a read happens on focus, on session and report events,
 * and once more when the next scout falls due, so it reads as due.
 */
import { errorText } from "../errors";
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
export type BoardCard = {
  number: number;
  title: string;
  url: string;
  apps: string[];
  priority: number;
  holder?: string;
  claimed_at?: string | null;
};
export type BoardData = {
  repo?: string;
  at?: string;
  open?: number;
  now?: BoardCard[];
  you?: BoardCard[];
  next?: BoardCard[];
  error?: string;
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
  run(id: string): Promise<ScoutRun>;
  prompt(id: string): Promise<string>;
  start(id: string, session: string): Promise<ScoutRun>;
  record(id: string, status: "done" | "failed", note: string): Promise<ScoutRun>;
};

export type BoardEvents = {
  api: BoardApi;
  openUrl(url: string): void;
  /** Open a visible terminal for an agent scout and type its prompt. `started` runs before the
   *  prompt is typed. The session id, or null. */
  launch(scout: Scout, prompt: string, started: (session: string) => Promise<unknown>): Promise<string | null>;
  /** Bring a scout's terminal forward. False when it is gone. */
  showSession(session: string): boolean;
  isLive(session: string): boolean;
};

export type BoardHandle = { open(): void; clear(): void; refresh(fresh?: boolean): void; dispose(): void };

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text) el.textContent = text;
  return el;
};
const button = (cls: string, text: string, title = ""): HTMLButtonElement => {
  const el = h("button", cls, text);
  el.type = "button";
  if (title) el.title = title;
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

const EVERY: Record<string, string> = { daily: "Daily", sunday: "Sundays", manual: "On demand" };
const cadence = (every: string): string => EVERY[every] ?? `Every ${every.replace(/h$/, " hours")}`;

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

  screen.classList.add("board");

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
    try {
      const [scouts, read, builtList] = await Promise.all([
        api.scouts(),
        api.board(fresh).catch((error: unknown): BoardData => ({ error: errorText(error, "the scout extension did not answer") })),
        // Builds are extra. A failure here shows in their section and never breaks the board.
        api.builds().catch((error: unknown): BuildList => ({ running: [], recent: [], error: errorText(error, "builds could not be read") })),
      ]);
      list = scouts;
      builds = builtList;
      board = read;
      failure = "";
      paint();
      schedule();
    } catch (error) {
      failure = errorText(error, "the scout extension did not answer");
      paint();
    } finally {
      busy = false;
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
    if (scout.last.found) board = await api.board(true).catch(() => board);
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

  /* ------------------------------------------------------------ the screen */

  function cardRow(card: BoardCard, tone: string, meta: string[]): HTMLButtonElement {
    const row = button(`bd-row ${tone}`, "", card.url);
    row.append(h("i", "bd-dot"), h("b", "bd-num", `#${card.number}`));
    const text = h("span", "bd-text");
    text.append(h("span", "bd-title", card.title));
    const sub = [...card.apps, ...meta].filter(Boolean);
    if (sub.length) text.append(h("small", "", sub.join(" · ")));
    row.append(text);
    row.addEventListener("click", () => events.openUrl(card.url));
    return row;
  }

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

  function buildsSection(): HTMLElement {
    const rows = [...builds.running.map(buildRow), ...builds.recent.map(buildRow)];
    const empty = builds.error ? `Builds could not be read: ${builds.error}` : "No builds yet. Say orchestrate in a terminal.";
    const box = section("Builds", builds.running.length, rows, empty);
    if (builds.error) box.querySelector(".bd-empty")?.classList.add("bd-error-line");
    return box;
  }

  function paintScreen(): void {
    if (!visible) return;
    if (!list && !failure) {
      screen.replaceChildren(h("p", "bd-loading", "Reading the board…"));
      return;
    }
    const header = h("header", "bd-header");
    const heading = h("div", "bd-heading");
    heading.append(h("h1", "", "Board"));
    const stats = h("div", "bd-stats");
    const stat = (n: number, label: string, tone: string): HTMLElement => {
      const el = h("span", `bd-stat ${tone}`);
      el.append(h("b", "", String(n)), document.createTextNode(` ${label}`));
      return el;
    };
    if (board && !board.error) {
      stats.append(stat(board.now?.length ?? 0, "in flight", "t-work"), stat(board.you?.length ?? 0, "need you", "t-warn"),
        stat(board.open ?? 0, "open", "t-quiet"));
    }
    heading.append(stats);
    const actions = h("div", "bd-actions");
    const reread = button("bd-chip", "Refresh", "Read the board and the scouts again");
    reread.addEventListener("click", () => void refresh(true));
    actions.append(reread);
    if (board?.repo) {
      const github = button("bd-chip", "GitHub", `Open ${board.repo} issues`);
      github.addEventListener("click", () => events.openUrl(`https://github.com/${board!.repo}/issues`));
      actions.append(github);
    }
    header.append(heading, actions);

    const work = h("div", "bd-work");
    if (failure || board?.error) {
      work.append(h("p", "bd-error", `The board could not be read: ${failure || board?.error}`));
    } else {
      work.append(
        section("Now", board?.now?.length ?? 0,
          (board?.now ?? []).map((c) => cardRow(c, "t-work", [c.holder ?? "", held(c.claimed_at)])),
          "Nobody is on an issue. Type work in a terminal to start one."),
        buildsSection(),
        section("Needs you", board?.you?.length ?? 0, (board?.you ?? []).map((c) => cardRow(c, "t-warn", [])),
          "Nothing waits on you."),
        section("Next up", null, (board?.next ?? []).map((c) => cardRow(c, "t-quiet", [`P${c.priority}`])),
          "The board is empty."),
      );
    }

    const scouts = h("aside", "bd-scouts");
    scouts.append(h("h2", "", "Scouts"));
    const groups = new Map<string, Scout[]>();
    for (const scout of list?.scouts ?? []) {
      const key = cadence(scout.every);
      groups.set(key, [...(groups.get(key) ?? []), scout]);
    }
    for (const [name, members] of groups) {
      scouts.append(h("h3", "", name), ...members.map(scoutRow));
    }
    if (!list?.scouts.length) scouts.append(h("p", "bd-empty", "No scouts yet. Add a file to ops/scouts."));

    const body = h("div", "bd-body");
    body.append(work, scouts);
    screen.replaceChildren(header, body);
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
