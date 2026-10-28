/**
 * Portfolio Home — the landing screen.
 *
 * One screen that answers "where does the portfolio stand?" the way the Dashboard answers
 * it for one project: a verdict and a card per app. The live terminals used to live here
 * too; they now have a screen of their own (features/terminals.ts) — one place, one job.
 */

import type { GitState, Session } from "../types";
import { icon, type IconName } from "../icons";
import { projectIconUrl } from "../project-assets";
import { isAgentKind } from "./agent-kinds";
import { moduleGet } from "./modules";
import { errorText } from "../errors";
import "./home.css";

/* ------------------------------------------------------------------ analytics
 * The portfolio-wide Kill/Keep board. This is the ONE place in Panel that reads across every
 * app at once — the per-project Analytics tab is app-scoped and never shows this. Data comes from
 * the one-shot analytics module; Home only ever receives aggregated numbers.
 */

type AnTone = "ok" | "warn" | "risk" | "info" | "muted";
type AnState = { id: string; label: string; action: string; tone: AnTone };
type RankRow = {
  rank: number; app: string; score: number | null; state: AnState;
  call: string; active_users?: number; trend_wow: number | null; cohort_size?: number;
};
type Portfolio = {
  data_through: string;
  median_score: number | null;
  ranking: RankRow[];
  low_confidence: Array<{ app: string; state: AnState; active_users?: number; cohort_size?: number }>;
  unlinked_apps: string[];
};

const anNum = new Intl.NumberFormat();
const anCount = (value: unknown): string => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? anNum.format(Math.round(parsed)) : "—";
};
const anTrendLabel = (value: number | null | undefined): string => {
  if (value == null || !Number.isFinite(value)) return "—";
  if (Math.abs(value) < 0.02) return "flat";
  return `${value > 0 ? "↑" : "↓"} ${(Math.abs(value) * 100).toFixed(0)}%`;
};
const anTrendTone = (value: number | null | undefined): string => {
  if (value == null || !Number.isFinite(value) || Math.abs(value) < 0.02) return "flat";
  return value > 0 ? "up" : "down";
};
/** analytics tone → Home's t-* vocabulary, so one colour system speaks everywhere. */
const anToneClass = (tone: AnTone): string =>
  tone === "ok" ? "t-ok" : tone === "warn" || tone === "info" ? "t-warn" : tone === "risk" ? "t-risk" : "t-mute";
const callTone: Record<string, string> = { invest: "t-ok", iterate: "t-warn", freeze: "t-risk", kill: "t-risk", hold: "t-mute" };

export type HomeProject = {
  id: string;
  name: string;
  /** Shown on the branch line when git has nothing to say — no repo, or the folder is gone. */
  path: string;
  exists: boolean;
  /** Which company owns it, or empty. Home does not section by it; the workspace does. */
  group: string;
  running: boolean;
  status: string;
  detail: string;
  /** Persisted work recency, also consumed by the workspace's project launcher. */
  lastActive?: number;
  sessions: Session[];
  /** An agent parked on you, or a turn that finished out of sight. Outranks every other state. */
  attention: "needs" | "done" | null;
};

export type HomeEvents = {
  /** Enter a project. `start` also opens a fresh claude agent once inside. */
  openProject(projectId: string, start?: boolean): void;
  isExited(sessionId: string): boolean;
  /** Per-project git snapshot for the card's branch line; may reject (not a repo / gone). */
  projectGit(projectId: string): Promise<GitState>;
  /** Open the chat rail on this post and flash it. The strip below is a table of contents, not
   *  a reader — the post itself is read where you can answer it. */
  openPost(postId: string): void;
  /** Open History, on one session when given. */
  openHistory(sessionId?: string): void;
  /** Whether a Panel module is installed. The analytics board follows the install, like the
   *  Support row: a card that can only ever say "unavailable" is worse than no card. */
  installed(module: string): boolean;
};

/** One line of the activity strip. A projection of the rail's post, not the post itself: Home
 *  needs a headline and an address, never the payload or the evidence behind it. */
export type HomeActivity = {
  id: string;
  project: string;
  projectName: string;
  author: string;
  agentKind: string;
  title: string;
  at: number;
};

/** One session that ended since you last opened History. From the agent's own store, so it is
 *  there whether or not the agent ever filed a report. */
export type HomeAway = {
  id: string;
  /** The agent CLI the session ran in, by engine name. */
  agent: string;
  projectName: string;
  title: string;
  lastText: string;
  at: number;
};

export type HomeHandle = {
  /** Build the whole screen. Fire the entrance once. */
  open(projects: HomeProject[]): void;
  /** Live refresh: update summary + card verdicts/counts cheaply. Never re-fire the entrance. */
  sync(projects: HomeProject[]): void;
  /** Everything the agents have said, newest last. Home keeps the last handful. */
  activity(posts: HomeActivity[]): void;
  /** Unread per project, for the cards. Same numbers the sidebar rows draw. */
  unread(counts: Map<string, number>): void;
  /** Sessions that ended since you last looked, newest first. */
  away(rows: HomeAway[]): void;
  clear(): void;
  isOpen(): boolean;
};

const make = (tag: string, className: string): HTMLElement => {
  const node = document.createElement(tag);
  node.className = className;
  return node;
};

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

export function mountHome(host: HTMLElement, events: HomeEvents): HomeHandle {
  let openState = false;
  const GIT_TTL_MS = 60_000;
  const MAX_GIT_IN_FLIGHT = 3;
  type GitSnapshot = {
    value: GitState | null;
    at: number;
    pending?: Promise<GitState | null>;
  };

  // Stable anchors, set on every open(). sync() mutates inside them, never re-creates them.
  let stats: HTMLElement;
  let hero: HTMLElement;
  let cardsGrid: HTMLElement;
  const projectCards = new Map<string, HTMLElement>();
  const gitSnapshots = new Map<string, GitSnapshot>();
  const gitQueue: Array<{ project: string; generation: number; finish: (git: GitState | null) => void }> = [];
  let gitInFlight = 0;
  let gitGeneration = 0;
  let boardBody: HTMLElement;
  let findWrap: HTMLElement;
  let findInput: HTMLInputElement;
  let findEmpty: HTMLElement;
  /** The last set handed to open()/sync(), so the finder can match on more than what a card shows. */
  let known: HomeProject[] = [];
  /** The cross-project record, held here because Home is where you sweep it. It arrives from the
   *  chat rail, which is the thing that actually receives the posts. */
  let feed: HomeActivity[] = [];
  let unreadBy = new Map<string, number>();
  let awayRows: HomeAway[] = [];
  let awaySection: HTMLElement | null = null;
  let activityBody: HTMLElement | null = null;
  let activityCount: HTMLElement | null = null;
  /** The project Enter would open. Kept across keystrokes while it still matches. */
  let picked: string | null = null;
  let onType: ((event: KeyboardEvent) => void) | null = null;

  /* -------------------------------------------------------------- derived */

  const liveAgentCount = (p: HomeProject): number =>
    p.sessions.filter((s) => isAgentKind(s.kind) && !events.isExited(s.id)).length;

  const phase = (p: HomeProject): "working" | "starting" | "idle" =>
    liveAgentCount(p) ? "working" : p.running ? "starting" : "idle";

  const verdict = (p: HomeProject): { tone: string; text: string } => {
    if (p.attention === "needs") return { tone: "t-warn", text: "needs you" };
    if (p.attention === "done") return { tone: "t-ok", text: "your turn" };
    const state = phase(p);
    return state === "working" ? { tone: "t-live", text: state }
      : state === "starting" ? { tone: "t-warn", text: state }
        : { tone: "t-mute", text: state };
  };

  /** The portfolio's one-word answer. */
  const headState = (projects: HomeProject[]): { tone: string; text: string } => {
    const needs = projects.filter((p) => p.attention === "needs").length;
    if (needs) return { tone: "t-warn", text: `${needs} need${needs === 1 ? "s" : ""} you` };
    const working = projects.filter((p) => phase(p) === "working").length;
    const starting = projects.filter((p) => phase(p) === "starting").length;
    if (working) return { tone: "t-live", text: `${working} working${starting ? ` · ${starting} starting` : ""}` };
    if (starting) return { tone: "t-warn", text: `${starting} starting` };
    return { tone: "t-mute", text: "all quiet" };
  };

  /** The default statuses restate what the pill already says — only real detail earns the line. */
  const meaningfulDetail = (p: HomeProject): string => {
    const detail = p.detail.trim();
    if (!detail || detail === "no agent running" || detail === p.name) return "";
    return detail;
  };

  /* ---------------------------------------------------------------- pills */

  const pillNode = (): HTMLElement => {
    const node = make("span", "home-verdict");
    node.innerHTML = `<i></i><span></span>`;
    return node;
  };

  /** Skip identical repaints — replacing the dot mid-pulse restarts its keyframe visibly. */
  const paintPill = (node: HTMLElement, state: { tone: string; text: string }): void => {
    const key = `${state.tone}|${state.text}`;
    if (node.dataset.v === key) return;
    node.dataset.v = key;
    node.className = `home-verdict ${state.tone}`;
    node.querySelector("span")!.textContent = state.text;
  };

  /* ----------------------------------------------------------------- head */

  /** A short strip, not a poster: the counts that change what you do next, and the wolf. */
  const buildHead = (): HTMLElement => {
    const head = make("header", "home-head");
    head.innerHTML = `
      <div class="home-head-copy">
        <b class="home-title">Portfolio</b>
        <div class="home-stats" aria-live="polite"></div>
      </div>
      <div class="home-head-art" aria-hidden="true"></div>`;
    hero = head;
    stats = head.querySelector<HTMLElement>(".home-stats")!;
    return head;
  };

  const changed = (p: HomeProject): number => {
    const git = gitSnapshots.get(p.id)?.value;
    return git?.is_repo ? git.dirty : 0;
  };

  const updateHead = (projects: HomeProject[]): void => {
    const working = projects.filter((p) => phase(p) === "working").length;
    const starting = projects.filter((p) => phase(p) === "starting").length;
    const withChanges = projects.filter((p) => changed(p) > 0).length;
    const unread = projects.reduce((sum, p) => sum + (unreadBy.get(p.id) ?? 0), 0);
    const items: Array<[number, string, string]> = [
      [projects.length, projects.length === 1 ? "project" : "projects", ""],
      [working, "working", working ? "t-live" : ""],
      ...(starting ? [[starting, "starting", "t-warn"] as [number, string, string]] : []),
      [withChanges, "with changes", withChanges ? "t-warn" : ""],
      [unread, "unread", unread ? "t-live" : ""],
    ];
    const key = items.map((item) => item.join(":")).join("|");
    if (stats.dataset.v !== key) {
      stats.dataset.v = key;
      stats.replaceChildren(
        ...items.map(([count, label, tone]) => {
          const stat = make("span", `home-stat ${tone}`.trim());
          const n = document.createElement("b");
          n.textContent = String(count);
          stat.append(n, ` ${label}`);
          return stat;
        }),
      );
    }
    hero.dataset.state = headState(projects).tone;
  };

  /* -------------------------------------------------------------- order
   * The grid leads with what needs you: agents parked on you, turns finished out of sight, agents working, then starting, then unread reports, then
   * uncommitted changes. Ties keep your config order, so a quiet portfolio reads as you wrote it.
   * Cards never move under the pointer; a held reorder lands when the pointer leaves the grid.
   */
  const rank = (p: HomeProject): number => {
    if (!p.exists) return 5;
    if (p.attention === "needs") return -2;
    if (p.attention === "done") return -1;
    if (liveAgentCount(p)) return 0;
    if (p.running) return 1;
    if (unreadBy.get(p.id)) return 2;
    const git = gitSnapshots.get(p.id)?.value;
    if (git?.is_repo && (git.dirty || git.ahead || git.behind)) return 3;
    return 4;
  };

  const reorder = (): void => {
    if (!openState || !cardsGrid || cardsGrid.matches(":hover")) return;
    const order = known
      .map((p, index) => ({ p, index, rank: rank(p) }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map(({ p }) => projectCards.get(p.id))
      .filter((card): card is HTMLElement => Boolean(card));
    const current = [...cardsGrid.children];
    if (order.length && order.some((card, index) => current[index] !== card)) cardsGrid.append(...order);
  };

  /* ---------------------------------------------------------------- cards */

  /** Everything on a card that a status poll may change, shared by build and sync. */
  const paintCard = (card: HTMLElement, p: HomeProject): void => {
    const state = verdict(p);
    const text = meaningfulDetail(p);
    const active = liveAgentCount(p);
    const key = `${p.exists}|${p.running}|${p.sessions.length}|${active}|${text}|${p.attention}`;
    if (card.dataset.state === key) return;
    card.dataset.state = key;
    card.classList.toggle("is-missing", !p.exists);
    card.classList.toggle("is-working", state.tone === "t-live");
    card.classList.toggle("is-needs", state.tone === "t-warn");
    card.classList.toggle("is-done", state.tone === "t-ok");
    card.setAttribute("aria-label", `${p.name}, ${state.text}${text ? `, ${text}` : ""}`);
    paintPill(card.querySelector<HTMLElement>(".home-verdict")!, state);

    const detail = card.querySelector<HTMLElement>(".home-card-detail")!;
    if (detail.textContent !== text) detail.textContent = text;
    detail.hidden = !text;

    const sessions = card.querySelector<HTMLElement>('[data-role="sessions"]')!;
    const sessionCount = sessions.querySelector<HTMLElement>("span")!;
    const count = plural(p.sessions.length, "session");
    if (sessionCount.textContent !== count) sessionCount.textContent = count;
    // "0 sessions" on every quiet card was noise; the chip appears once there is something to count.
    sessions.hidden = p.sessions.length === 0;

    card.querySelector<HTMLElement>('[data-role="agent"]')!.hidden = active === 0;
    // A missing folder is not a start target; a live agent already started.
    card.querySelector<HTMLElement>(".home-start")!.hidden = !p.exists || p.running || active > 0;
  };

  const pumpGit = (): void => {
    while (gitInFlight < MAX_GIT_IN_FLIGHT && gitQueue.length) {
      const job = gitQueue.shift()!;
      if (!openState || job.generation !== gitGeneration) {
        job.finish(null);
        continue;
      }
      gitInFlight += 1;
      void events.projectGit(job.project).catch(() => null).then((git) => {
        gitInFlight -= 1;
        job.finish(git);
        pumpGit();
      });
    }
  };

  const queuedGit = (project: string): Promise<GitState | null> =>
    new Promise((finish) => {
      gitQueue.push({ project, generation: gitGeneration, finish });
      pumpGit();
    });

  const paintGit = (card: HTMLElement, p: HomeProject): void => {
    const branch = card.querySelector<HTMLElement>(".home-card-branch span")!;
    const changes = card.querySelector<HTMLElement>('[data-role="changed"]')!;
    const show = (git: GitState | null): void => {
      const text = git?.is_repo
        ? `${git.branch}${git.ahead ? ` ↑${git.ahead}` : ""}${git.behind ? ` ↓${git.behind}` : ""}`
        : p.path || "no repo";
      if (branch.textContent !== text) branch.textContent = text;
      const dirty = git?.is_repo ? git.dirty : 0;
      const label = `${dirty} changed`;
      if (changes.querySelector("span")!.textContent !== label) changes.querySelector("span")!.textContent = label;
      changes.hidden = dirty === 0;
    };
    const cached = gitSnapshots.get(p.id);
    if (cached && Date.now() - cached.at < GIT_TTL_MS) {
      show(cached.value);
      return;
    }
    if (cached) show(cached.value);
    if (cached?.pending) return;
    const generation = gitGeneration;
    const pending = queuedGit(p.id).then((git) => {
      if (generation === gitGeneration) gitSnapshots.set(p.id, { value: git, at: Date.now() });
      return git;
    });
    gitSnapshots.set(p.id, { value: cached?.value ?? null, at: cached?.at ?? 0, pending });
    void pending.then((git) => {
      if (card.isConnected && projectCards.get(p.id) === card) show(git);
      // Here, not in pumpGit: the snapshot is stored by now, so the count includes this answer.
      // Every answer may change "with changes"; the last one in flight settles the order.
      if (openState) {
        updateHead(known);
        if (!gitInFlight && !gitQueue.length) reorder();
      }
    });
  };

  const buildCard = (p: HomeProject): HTMLElement => {
    const card = make("article", "home-card");
    card.dataset.project = p.id;
    card.tabIndex = 0;
    card.setAttribute("role", "button");

    const head = make("div", "home-card-head");
    const ico = make("span", "home-card-ico");
    const glyph = make("span", "home-glyph");
    glyph.textContent = p.name.trim().charAt(0).toUpperCase();
    ico.append(glyph);
    // The real app icon paints over the initial when the protocol has one — same graceful
    // fallback the sidebar rows use.
    const img = document.createElement("img");
    img.src = projectIconUrl(p.id);
    img.alt = "";
    img.draggable = false;
    img.addEventListener("error", () => img.remove());
    ico.append(img);
    const id = make("span", "home-card-id");
    id.innerHTML = `<b class="home-card-name"></b><small class="home-card-detail" hidden></small>`;
    id.querySelector("b")!.textContent = p.name;
    head.append(ico, id, pillNode());
    card.append(head);

    // Filled when git answers; the card is useful before it does, so nothing waits on it.
    const branch = make("div", "home-card-branch");
    branch.innerHTML = `${icon("branch")}<span>…</span>`;
    card.append(branch);

    const chips = make("div", "home-card-chips");
    const sessions = make("span", "chip");
    sessions.dataset.role = "sessions";
    sessions.innerHTML = `${icon("terminal")}<span></span>`;
    const changes = make("span", "chip warn");
    changes.dataset.role = "changed";
    changes.innerHTML = `${icon("git")}<span></span>`;
    changes.hidden = true;
    const agent = make("span", "chip ok");
    agent.dataset.role = "agent";
    agent.innerHTML = `${icon("agent")}<span>agent</span>`;
    agent.hidden = true;
    const start = document.createElement("button");
    start.type = "button";
    start.className = "home-start";
    start.innerHTML = `${icon("play")}<span>Start</span>`;
    start.hidden = true;
    start.addEventListener("click", (event) => {
      event.stopPropagation(); // the card underneath would also fire openProject
      events.openProject(p.id, true);
    });
    chips.append(changes, sessions, agent, start);
    card.append(chips);

    card.addEventListener("click", () => events.openProject(p.id));
    card.addEventListener("keydown", (event) => {
      if (event.target !== card || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      events.openProject(p.id);
    });
    paintCard(card, p);
    projectCards.set(p.id, card);
    paintGit(card, p);
    return card;
  };

  const buildCards = (projects: HomeProject[]): void => {
    projectCards.clear();
    const live = new Set(projects.map((p) => p.id));
    for (const id of gitSnapshots.keys()) if (!live.has(id)) gitSnapshots.delete(id);
    cardsGrid.dataset.v = projects.map((p) => p.id).join("|");
    if (!projects.length) {
      const none = make("div", "home-none");
      none.textContent = "No projects yet. Add one from the sidebar.";
      cardsGrid.replaceChildren(none);
      return;
    }
    cardsGrid.replaceChildren(...projects.map(buildCard));
    reorder();
  };

  /* ---------------------------------------------------------------- finder
   * Home is a wall of doors, and the fastest way through a wall of doors is to say where you are
   * going. So typing anywhere on this screen narrows the cards and arms Enter: the grid IS the
   * result list, and the app you meant is the one lit up. No palette, no second window — you were
   * already looking at the answer, we just took the others away.
   */

  const matchesQuery = (p: HomeProject, query: string): boolean =>
    !query || p.name.toLowerCase().includes(query) || p.id.toLowerCase().includes(query);

  /** Best guess at what you meant: a name that STARTS with what you typed beats one that merely
   *  contains it — "pi" is Pisti before Pillow, and never Attention Retention. */
  const bestPick = (hits: HomeProject[], query: string): string | null =>
    hits.find((p) => p.name.toLowerCase().startsWith(query))?.id ?? hits[0]?.id ?? null;

  const applyFind = (): void => {
    if (!findInput) return;
    const query = findInput.value.trim().toLowerCase();
    const hits = known.filter((p) => matchesQuery(p, query));
    findWrap.classList.toggle("is-active", Boolean(query));
    // Keep the pick you already had while it still matches — a fourth keystroke must not move the
    // target out from under Enter.
    if (!query) picked = null;
    else if (!picked || !hits.some((p) => p.id === picked)) picked = bestPick(hits, query);

    for (const card of cardsGrid.querySelectorAll<HTMLElement>(".home-card")) {
      const id = card.dataset.project!;
      card.hidden = !hits.some((p) => p.id === id);
      card.classList.toggle("is-picked", Boolean(query) && id === picked);
    }
    // An empty box is not a search. With no projects yet, "No project matches" would sit under
    // "No projects yet" and say the same thing twice.
    findEmpty.hidden = !query || hits.length > 0;
    findEmpty.textContent = `No project matches “${findInput.value.trim()}”`;
    findWrap.dataset.count = query ? `${hits.length}` : "";
  };

  /** Move the pick along the visible cards. The grid wraps, so ↓/→ are the same next. */
  const movePick = (step: number): void => {
    const shown = [...cardsGrid.querySelectorAll<HTMLElement>(".home-card")].filter((c) => !c.hidden);
    if (!shown.length) return;
    const at = shown.findIndex((c) => c.dataset.project === picked);
    const next = shown[(at + step + shown.length) % shown.length] ?? shown[0];
    picked = next.dataset.project!;
    for (const card of shown) card.classList.toggle("is-picked", card === next);
    next.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  const openPicked = (): void => {
    if (picked) events.openProject(picked);
  };

  const clearFind = (): void => {
    findInput.value = "";
    picked = null;
    applyFind();
  };

  const buildFind = (): HTMLElement => {
    findWrap = make("div", "home-find");
    findWrap.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>
      <input type="search" autocomplete="off" spellcheck="false" aria-label="Find a project"
             placeholder="Type to find a project — ↵ opens it" />
      <kbd>↵</kbd>`;
    findInput = findWrap.querySelector("input")!;
    findInput.addEventListener("input", applyFind);
    findInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        openPicked();
      } else if (event.key === "Escape") {
        event.preventDefault();
        if (findInput.value) clearFind();
        else findInput.blur();
      } else if (event.key === "ArrowDown" || event.key === "ArrowRight") {
        event.preventDefault();
        movePick(1);
      } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
        event.preventDefault();
        movePick(-1);
      }
    });
    return findWrap;
  };

  /** Typing anywhere on Home lands in the finder. Nothing else on this screen takes plain keys,
   *  so a stray letter can only ever have meant "find me this app". */
  const startTyping = (event: KeyboardEvent): void => {
    if (!openState || event.defaultPrevented) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target === findInput) return;
    // Someone else owns the keyboard — a filter, a prompt, an editor. Leave it alone.
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;

    if (event.key.length === 1 && event.key !== " ") {
      event.preventDefault();
      findInput.value += event.key;
    } else if (event.key === "Backspace" && findInput.value) {
      event.preventDefault();
      findInput.value = findInput.value.slice(0, -1);
    } else if (event.key === "Escape" && findInput.value) {
      event.preventDefault();
      clearFind();
      return;
    } else if (event.key === "Enter" && findInput.value) {
      event.preventDefault();
      openPicked();
      return;
    } else {
      return;
    }
    findInput.focus();
    applyFind();
  };

  /* -------------------------------------------------------------- activity */

  /**
   * What every agent said, across every project, newest first.
   *
   * This is the half of the old Inbox that could not follow the conversation into the rail. The
   * rail is per project by design — you talk to ONE agent — so "what happened everywhere while I
   * was away" needed somewhere else to live, and it belongs on the screen that already answers
   * every other portfolio-wide question.
   *
   * It is a table of contents and nothing more: a line per report, and a click that opens it in
   * the rail where you can actually answer. Rendering the reports here as well would rebuild the
   * feed we just took apart, one screen to the left.
   */
  const ACTIVITY_ROWS = 8;

  const relative = (at: number): string => {
    const mins = Math.round((Date.now() - at) / 60_000);
    if (mins < 1) return "now";
    if (mins < 60) return `${mins}m`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.round(hours / 24)}d`;
  };

  const activityGlyph = (kind: string): IconName =>
    kind === "codex" || kind.startsWith("opencode")
      ? "code"
      : kind === "shell"
        ? "terminal"
        : "agent";

  const paintActivity = (): void => {
    if (!activityBody || !activityCount) return;
    const rows = [...feed].reverse().slice(0, ACTIVITY_ROWS);
    const waiting = [...unreadBy.values()].reduce((sum, value) => sum + value, 0);
    activityCount.textContent = waiting ? `${waiting} unread` : plural(feed.length, "report");
    activityCount.classList.toggle("is-unread", waiting > 0);
    if (!rows.length) {
      const none = make("div", "home-none");
      none.textContent = "No agent has reported yet. Their handoffs land here.";
      activityBody.replaceChildren(none);
      return;
    }
    activityBody.replaceChildren(
      ...rows.map((post) => {
        const row = make("button", "home-act");
        (row as HTMLButtonElement).type = "button";
        row.title = `${post.author} on ${post.projectName} — open in chat`;
        const avatar = make("span", "home-act-ico");
        avatar.dataset.agent = post.agentKind;
        avatar.innerHTML = icon(activityGlyph(post.agentKind));
        const body = make("span", "home-act-body");
        const line = make("span", "home-act-line");
        line.append(
          make("b", "home-act-project"),
          make("i", "home-act-author"),
        );
        line.querySelector("b")!.textContent = post.projectName;
        line.querySelector("i")!.textContent = post.author;
        const title = make("span", "home-act-title");
        title.textContent = post.title;
        body.append(line, title);
        const when = make("time", "home-act-when");
        when.textContent = relative(post.at);
        row.append(avatar, body, when);
        row.addEventListener("click", () => events.openPost(post.id));
        return row;
      }),
    );
  };

  const buildActivity = (): HTMLElement => {
    const section = make("section", "home-activity");
    const head = make("div", "home-activity-head");
    const label = make("label", "home-label");
    label.textContent = "Activity";
    activityCount = make("span", "home-activity-count");
    head.append(label, activityCount);
    activityBody = make("div", "home-activity-body");
    section.append(head, activityBody);
    paintActivity();
    return section;
  };

  /* ------------------------------------------------------------------ away
   * The other half of "what happened while I was away". Activity lists what agents REPORTED;
   * this lists every session that ended since you last opened History, reported or not, because
   * the session that finished at 3am and closed without a word is the one you would miss.
   * Hidden when there is nothing new: an empty strip is one more thing to read for no news.
   */
  const AWAY_ROWS = 5;

  const paintAway = (): void => {
    if (!awaySection) return;
    awaySection.hidden = awayRows.length === 0;
    if (!awayRows.length) return;
    const head = make("div", "home-activity-head");
    const label = make("label", "home-label");
    label.textContent = "Since you last looked";
    const count = make("span", "home-activity-count is-unread");
    count.textContent = plural(awayRows.length, "session");
    const all = document.createElement("button");
    all.type = "button";
    all.className = "home-away-all";
    all.textContent = "Open History";
    all.addEventListener("click", () => events.openHistory());
    head.append(label, count, all);
    const body = make("div", "home-activity-body");
    body.append(
      ...awayRows.slice(0, AWAY_ROWS).map((session) => {
        const row = make("button", "home-act");
        (row as HTMLButtonElement).type = "button";
        row.title = `${session.projectName}: ${session.title}. Open in History`;
        const avatar = make("span", "home-act-ico");
        avatar.dataset.agent = session.agent;
        avatar.innerHTML = icon(activityGlyph(session.agent));
        const text = make("span", "home-act-body");
        const line = make("span", "home-act-line");
        line.append(make("b", "home-act-project"), make("i", "home-act-author"));
        line.querySelector("b")!.textContent = session.projectName;
        line.querySelector("i")!.textContent = session.title;
        const last = make("span", "home-act-title");
        last.textContent = session.lastText || "No reply recorded.";
        text.append(line, last);
        const when = make("time", "home-act-when");
        when.textContent = relative(session.at);
        row.append(avatar, text, when);
        row.addEventListener("click", () => events.openHistory(session.id));
        return row;
      }),
    );
    if (awayRows.length > AWAY_ROWS) {
      const more = make("div", "home-away-more");
      more.textContent = `${plural(awayRows.length - AWAY_ROWS, "more session")} in History`;
      body.append(more);
    }
    awaySection.replaceChildren(head, body);
  };

  const buildAway = (): HTMLElement => {
    awaySection = make("section", "home-activity home-away");
    paintAway();
    return awaySection;
  };

  const buildProjects = (projects: HomeProject[]): HTMLElement => {
    const section = make("section", "home-projects");
    const head = make("div", "home-projects-head");
    const label = make("label", "home-label");
    label.textContent = "Projects";
    head.append(label, buildFind());
    cardsGrid = make("div", "home-grid");
    cardsGrid.addEventListener("mouseleave", reorder);
    findEmpty = make("div", "home-none");
    findEmpty.hidden = true;
    section.append(head, cardsGrid, findEmpty);
    buildCards(projects);
    return section;
  };

  /* ----------------------------------------------------- analytics board */

  const boardNote = (title: string, detail: string): void => {
    const note = make("div", "home-board-note");
    note.innerHTML = `<b></b><small></small>`;
    note.querySelector("b")!.textContent = title;
    note.querySelector("small")!.textContent = detail;
    boardBody.replaceChildren(note);
  };

  const paintBoard = (p: Portfolio): void => {
    if (!p.ranking.length && !p.low_confidence.length) {
      boardNote("No analytics yet", p.unlinked_apps.length
        ? `${p.unlinked_apps.length} apps not linked to a GA4 property.`
        : "No linked apps have data to rank.");
      return;
    }
    boardBody.replaceChildren();

    const head = make("div", "home-board-meta");
    head.textContent = `${p.ranking.length} confident · median ${p.median_score ?? "—"} · ranked by D1 lower bound · through ${p.data_through}`;
    boardBody.append(head);

    const rows = make("div", "home-rank-rows");
    for (const r of p.ranking) {
      const row = make("button", `home-rank ${anToneClass(r.state.tone)}`);
      (row as HTMLButtonElement).type = "button";
      row.innerHTML = `
        <span class="home-rank-n"></span>
        <span class="home-rank-name"></span>
        <span class="home-rank-state"></span>
        <span class="home-rank-users"></span>
        <span class="home-rank-trend is-${anTrendTone(r.trend_wow)}"></span>
        <span class="home-rank-call ${callTone[r.call] ?? "t-mute"}"></span>`;
      row.querySelector(".home-rank-n")!.textContent = String(r.rank);
      row.querySelector(".home-rank-name")!.textContent = r.app;
      row.querySelector(".home-rank-state")!.textContent = r.state.label;
      row.querySelector(".home-rank-users")!.textContent = `${anCount(r.active_users)} · n${anCount(r.cohort_size)}`;
      row.querySelector(".home-rank-trend")!.textContent = anTrendLabel(r.trend_wow);
      row.querySelector(".home-rank-call")!.textContent = r.call;
      row.addEventListener("click", () => events.openProject(idForApp(r.app) ?? r.app));
      rows.append(row);
    }
    boardBody.append(rows);

    if (p.low_confidence.length) {
      const low = make("div", "home-lowconf");
      low.innerHTML = `<h4>Below the line — too little data to rank</h4>`;
      const list = make("div", "home-lowconf-rows");
      for (const r of p.low_confidence) {
        const row = make("div", `home-lowrow ${anToneClass(r.state.tone)}`);
        row.innerHTML = `<span></span><i></i><b></b>`;
        row.querySelector("span")!.textContent = r.app;
        row.querySelector("i")!.textContent = r.state.label;
        row.querySelector("b")!.textContent = `${anCount(r.active_users)} act · n${anCount(r.cohort_size)}`;
        list.append(row);
      }
      low.append(list);
      boardBody.append(low);
    }
  };

  // Map a board app-name back to a project id so a row can open the app. Names usually match.
  let appToId = new Map<string, string>();
  const idForApp = (app: string): string | undefined =>
    appToId.get(app) ?? appToId.get(app.toLowerCase());

  const buildBoard = (): HTMLElement => {
    const section = make("section", "home-board");
    const label = make("label", "home-label");
    label.textContent = "Analytics — Kill / Keep";
    boardBody = make("div", "home-board-body");
    section.append(label, boardBody);
    boardNote("Reading analytics…", "");
    return section;
  };

  // Fetched once per open(). It shells out to Python and is cached 15 min server-side, so a
  // status poll (sync) must never drag it along — that is why it is not in sync().
  const loadBoard = (): void => {
    void moduleGet<Portfolio>("/m/analytics/portfolio?days=28")
      .then((p) => { if (openState) paintBoard(p); })
      .catch((error) => {
        if (!openState) return;
        const message = String(error);
        boardNote(/412|service account|no credential/i.test(message) ? "Analytics not set up" : "Analytics unavailable",
          /412|service account|no credential/i.test(message)
            ? "Connect a GA4 service account from any app's Analytics tab."
            : errorText(error, "The analytics module did not answer. Home asks again next time it opens."));
      });
  };

  const syncCards = (projects: HomeProject[]): void => {
    // The set of projects can only really change through flows that leave Home, but a
    // stale grid drawing a ghost card would be worse than one cheap rebuild.
    if (cardsGrid.dataset.v !== projects.map((p) => p.id).join("|")) {
      buildCards(projects);
      return;
    }
    for (const p of projects) {
      const card = projectCards.get(p.id);
      if (card) {
        paintCard(card, p);
        paintGit(card, p);
      }
    }
    reorder();
  };

  /* --------------------------------------------------------------- handle */

  return {
    open(projects) {
      openState = true;
      host.hidden = false;
      known = projects;
      picked = null;
      appToId = new Map(projects.flatMap((p) => [[p.name, p.id], [p.name.toLowerCase(), p.id]]));

      const inner = make("div", "home-inner is-enter");
      const analytics = events.installed("analytics");
      inner.append(buildHead(), buildAway(), buildProjects(projects), buildActivity());
      if (analytics) inner.append(buildBoard());
      host.replaceChildren(inner);
      updateHead(projects);
      if (analytics) loadBoard();
      if (!onType) {
        onType = startTyping;
        window.addEventListener("keydown", onType);
      }
    },

    sync(projects) {
      if (!openState) return;
      known = projects;
      appToId = new Map(projects.flatMap((p) => [[p.name, p.id], [p.name.toLowerCase(), p.id]]));
      updateHead(projects);
      syncCards(projects);
      // A status poll rebuilds cards from time to time. Put the narrowing back before the frame
      // lands, or the grid flashes every app you had just filtered away.
      applyFind();
    },

    activity(posts) {
      feed = posts.map((post) => ({ ...post }));
      paintActivity();
    },

    away(rows) {
      awayRows = rows;
      paintAway();
    },

    unread(counts) {
      unreadBy = new Map(counts);
      paintActivity();
      // Cards are only in the DOM while Home is up; off-screen the map is enough — the next
      // open() paints from it.
      if (openState) {
        updateHead(known);
        syncCards(known);
      }
    },

    clear() {
      gitGeneration += 1;
      for (const job of gitQueue.splice(0)) job.finish(null);
      for (const [id, snapshot] of gitSnapshots) {
        if (snapshot.pending) gitSnapshots.set(id, { value: snapshot.value, at: snapshot.at });
      }
      host.replaceChildren();
      host.hidden = true;
      activityBody = null;
      activityCount = null;
      awaySection = null;
      openState = false;
      picked = null;
      if (onType) {
        window.removeEventListener("keydown", onType);
        onType = null;
      }
    },

    isOpen: () => openState,
  };
}
