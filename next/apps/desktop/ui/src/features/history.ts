/**
 * History — what every coding agent did, including the sessions that never reported.
 *
 * Reports only hold what an agent chose to file. A session that finished at 3am and closed, or
 * one started in a plain terminal outside Panel, left nothing anywhere you looked. Every agent CLI
 * keeps its own record regardless — Claude, Codex, Grok, opencode, Gemini, DeepSeek Harness — and
 * the backend reads them all (src-tauri/src/history/). This screen lists them: what you asked, the
 * last thing the agent said, the files it wrote, the tokens it spent. One click takes you back
 * into the conversation — its live terminal if one holds it, a resumed one if the agent can.
 *
 * Stores differ. Codex keeps no replies and one token total per thread; Grok dates nothing per
 * turn; Gemini cannot resume by id. A row shows what its store has and leaves the rest out.
 *
 * "Since you last looked" is a time stamp, not a read flag per row. Leaving the screen moves it,
 * so the next visit starts from what is new.
 */

import { invoke } from "@tauri-apps/api/core";
import { sessionLink } from "../deeplink";
import { errorText } from "../errors";
import { plainLines, plainText } from "../plain";
import { ENGINES } from "./agent-kinds";
import "./history.css";

/** How a session can be picked back up: by id, or not at all. */
export type HistoryResume = "exact" | "none";

export type HistorySession = {
  id: string;
  /** The agent CLI, by its Panel engine name: claude, codex, grok, opencode, gemini, dshline. */
  agent: string;
  project: string;
  cwd: string;
  title: string;
  firstPrompt: string;
  lastPrompt: string;
  lastText: string;
  startedAt: string;
  endedAt: string;
  /** 0 when the store does not count them (Codex). */
  prompts: number;
  files: string[];
  /** Run without a person at the keyboard: `codex exec`, `claude -p`, a headless Grok. */
  headless: boolean;
  resume: HistoryResume;
};

export type HistoryUsage = {
  session: string;
  agent: string;
  project: string;
  model: string;
  /** `YYYY-MM-DDTHH`, UTC. */
  hour: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** A total the store does not break down (Codex keeps one number per thread). */
  unsplit: number;
};

export type HistoryData = {
  sessions: HistorySession[];
  usage: HistoryUsage[];
  outside: number;
  /** Agents whose store could not be read, each with its reason. */
  problems: string[];
  /** Claude conversation id → the live Panel session holding it. */
  open: Record<string, string>;
};

type Hit = {
  session: string;
  agent: string;
  project: string;
  cwd: string;
  title: string;
  at: string;
  role: "you" | "agent";
  snippet: string;
};

export type HistoryEvents = {
  projectName(project: string): string;
  /** Jump to the live terminal holding a conversation. */
  openTerminal(panelSession: string): void;
  /** Resume a conversation in a new terminal. Resolves to the new Panel session id. */
  resume(session: HistorySession): Promise<string>;
  /** Open a file the session wrote, in its project's Work editor. The path is as the agent wrote
   *  it: relative to the session's folder when inside it. */
  openFile(session: HistorySession, path: string): void;
  /** The stamp moved: badges and Home should recount. */
  seen(): void;
};

export type HistoryHandle = {
  open(focus?: { query?: string; session?: string }): void;
  clear(): void;
  isOpen(): boolean;
};

/* ----------------------------------------------------------------- shared */

const SEEN_KEY = "panel-history-seen";
/** With no stamp yet, "new" means the last day — not the whole fortnight at once. */
const FIRST_LOOK_MS = 24 * 60 * 60 * 1000;

export function seenAt(): number {
  try {
    const stored = Number(localStorage.getItem(SEEN_KEY));
    if (Number.isFinite(stored) && stored > 0) return stored;
  } catch {
    // Storage blocked: fall through to the first-look window.
  }
  return Date.now() - FIRST_LOOK_MS;
}

function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, String(Date.now()));
  } catch {
    // Nothing to keep it in; the next visit shows the same rows as new again.
  }
}

export function fetchHistory(days = 14): Promise<HistoryData> {
  return invoke<HistoryData>("session_history", { days });
}

/** Sessions that ended since you last looked. One a live terminal holds is on the wall already;
 *  a headless run is usually another agent asking for a second opinion, not work you left. */
export function sinceSeen(data: HistoryData, since = seenAt()): HistorySession[] {
  return data.sessions.filter(
    (session) => Date.parse(session.endedAt) > since && !data.open[session.id] && !session.headless,
  );
}

const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

/** Search rows on screen. The newest matter; a longer query narrows the rest. */
const HIT_ROWS = 60;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The engine's own short name. Gemini has no Panel engine, so it is named here. */
export const agentName = (agent: string): string =>
  ENGINES.find((engine) => engine.kind === agent)?.name ?? (agent === "gemini" ? "Gemini" : agent);

/** A dot in the agent's hue beside its name in ink: identity never rides on the text color. */
function agentTag(agent: string): HTMLElement {
  const tag = make("span", `hist-agent k-${agent}`);
  tag.append(make("i", "hist-agent-dot"), make("span", "", agentName(agent)));
  return tag;
}

export function relativeTime(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(mins)) return "";
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

const tokens = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);

const processed = (row: HistoryUsage): number =>
  row.input + row.output + row.cacheRead + row.cacheWrite + row.unsplit;

/** Local calendar day of a UTC hour bucket. */
const hourDay = (hour: string): string => localDay(new Date(`${hour}:00:00Z`));
const localDay = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

function dayLabel(day: string): string {
  const today = localDay(new Date());
  const yesterday = localDay(new Date(Date.now() - 86_400_000));
  if (day === today) return "Today";
  if (day === yesterday) return "Yesterday";
  return new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

const clock = (iso: string): string =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = make("textarea");
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

/* ----------------------------------------------------------------- screen */

export function mountHistory(host: HTMLElement, events: HistoryEvents): HistoryHandle {
  let openState = false;
  let data: HistoryData | null = null;
  /** The stamp as it was when this visit began, so rows stay marked new while you read them. */
  let since = 0;
  let days = 14;
  let query = "";
  /** Show one agent's sessions, or every agent's when empty. */
  let agent = "";
  /** Headless runs (`codex exec`, `claude -p`) are mostly agents calling agents. Off by default. */
  let headless = false;
  let lastHits: Hit[] = [];
  let searchTimer = 0;
  let searchGeneration = 0;
  /** Conversations resumed from here before their first hook names them. */
  const resumed = new Map<string, string>();
  const expanded = new Set<string>();

  host.innerHTML = "";
  const bar = make("header", "hist-bar");
  const title = make("b", "hist-title", "History");
  const tally = make("span", "hist-tally");
  const find = make("input", "hist-find");
  find.type = "search";
  find.placeholder = "Search what you asked and what agents said";
  find.setAttribute("aria-label", "Search sessions");
  find.spellcheck = false;
  const range = make("select", "hist-range");
  range.setAttribute("aria-label", "How far back");
  for (const [value, label] of [[1, "Today"], [7, "7 days"], [14, "14 days"], [30, "30 days"]] as const) {
    const option = make("option", "", label);
    option.value = String(value);
    range.append(option);
  }
  range.value = String(days);
  bar.append(title, tally, find, range);

  const agents = make("div", "hist-agents");
  agents.setAttribute("role", "group");
  agents.setAttribute("aria-label", "Agent");
  const usage = make("section", "hist-usage");
  const list = make("div", "hist-list");
  list.setAttribute("role", "list");
  const foot = make("p", "hist-foot");
  const body = make("div", "hist-body");
  body.append(agents, usage, list, foot);
  host.append(bar, body);

  const liveTerminal = (conversation: string): string | undefined =>
    data?.open[conversation] ?? resumed.get(conversation);

  const kept = (session: HistorySession): boolean => headless || !session.headless;
  const shownSessions = (): HistorySession[] =>
    (data?.sessions ?? []).filter((session) => kept(session) && (!agent || session.agent === agent));
  const shownUsage = (): HistoryUsage[] => (data?.usage ?? []).filter((row) => !agent || row.agent === agent);

  /* ------------------------------------------------------------ agents */

  const repaint = (): void => {
    paintAgents();
    paintUsage();
    if (query) paintHits(lastHits);
    else paintSessions();
  };

  /** One chip per agent that has sessions in the window, All first, then the headless switch.
   *  Hidden when there is nothing to choose between. */
  const paintAgents = (): void => {
    const counts = new Map<string, number>();
    const all = data?.sessions ?? [];
    for (const session of all.filter(kept)) counts.set(session.agent, (counts.get(session.agent) ?? 0) + 1);
    const runs = all.filter((session) => session.headless).length;
    if (agent && !counts.has(agent)) agent = "";
    agents.hidden = counts.size < 2 && runs === 0;
    const order = ENGINES.map((engine) => engine.kind as string);
    const rank = (name: string): number => (order.includes(name) ? order.indexOf(name) : order.length);
    const chip = (value: string, label: HTMLElement | string, count: number): HTMLButtonElement => {
      const button = make("button", "hist-agent-chip");
      button.type = "button";
      button.setAttribute("aria-pressed", String(agent === value));
      button.append(label, make("span", "hist-agent-count", String(count)));
      button.addEventListener("click", () => {
        agent = value;
        repaint();
      });
      return button;
    };
    const shown = [...counts.values()].reduce((sum, count) => sum + count, 0);
    agents.replaceChildren(
      chip("", "All", shown),
      ...[...counts.entries()]
        .sort((a, b) => rank(a[0]) - rank(b[0]))
        .map(([name, count]) => chip(name, agentTag(name), count)),
    );
    if (runs) {
      const toggle = make("button", "hist-agent-chip is-switch");
      toggle.type = "button";
      toggle.title = "Runs with no one at the keyboard, like codex exec or claude -p. Mostly agents asking other agents.";
      toggle.setAttribute("aria-pressed", String(headless));
      toggle.append(make("span", "", "Headless runs"), make("span", "hist-agent-count", String(runs)));
      toggle.addEventListener("click", () => {
        headless = !headless;
        repaint();
      });
      agents.append(toggle);
    }
  };

  /* ------------------------------------------------------------ usage */

  /** Tokens per project over the window, biggest first. One series, one hue: a bar per project
   *  with its number beside it. The breakdown a bar hides is in its tooltip. */
  const paintUsage = (): void => {
    if (!data) return;
    const today = localDay(new Date());
    const rows = shownUsage();
    const todayTotal = rows.filter((row) => hourDay(row.hour) === today).reduce((sum, row) => sum + processed(row), 0);
    const total = rows.reduce((sum, row) => sum + processed(row), 0);
    const byProject = new Map<string, HistoryUsage[]>();
    for (const row of rows) byProject.set(row.project, [...(byProject.get(row.project) ?? []), row]);
    const ranked = [...byProject.entries()]
      .map(([project, own]) => ({ project, own, sum: own.reduce((acc, row) => acc + processed(row), 0) }))
      .sort((a, b) => b.sum - a.sum);

    const head = make("div", "hist-usage-head");
    head.append(make("span", "hist-label", "Tokens processed"));
    const figures = make("span", "hist-usage-figures");
    figures.append(make("b", "", tokens(todayTotal)), make("span", "", " today"));
    if (days > 1) figures.append(make("span", "", " · "), make("b", "", tokens(total)), make("span", "", ` in ${days} days`));
    head.append(figures);
    usage.replaceChildren(head);
    if (!ranked.length) {
      usage.append(make("p", "hist-muted", "No tokens recorded in this window."));
      return;
    }
    const top = ranked[0].sum || 1;
    const bars = make("div", "hist-bars");
    for (const { project, own, sum } of ranked.slice(0, 8)) {
      const row = make("div", "hist-bar-row");
      const part = (key: keyof Pick<HistoryUsage, "input" | "output" | "cacheRead" | "cacheWrite" | "unsplit">): number =>
        own.reduce((acc, item) => acc + item[key], 0);
      const models = [...new Set(own.map((item) => item.model).filter(Boolean))].join(", ");
      const byAgent = new Map<string, number>();
      for (const item of own) byAgent.set(item.agent, (byAgent.get(item.agent) ?? 0) + processed(item));
      const unsplit = part("unsplit");
      row.title = [
        `${events.projectName(project)}: ${tokens(sum)} tokens`,
        [...byAgent.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${agentName(name)} ${tokens(n)}`).join(" · "),
        `input ${tokens(part("input"))} · output ${tokens(part("output"))}`,
        `cache read ${tokens(part("cacheRead"))} · cache write ${tokens(part("cacheWrite"))}`,
        unsplit ? `not split by kind ${tokens(unsplit)} (Codex keeps one total)` : "",
        models,
      ].filter(Boolean).join("\n");
      const track = make("span", "hist-bar-track");
      const fill = make("i", "hist-bar-fill");
      fill.style.width = `${Math.max(1.5, (sum / top) * 100)}%`;
      track.append(fill);
      row.append(make("span", "hist-bar-name", events.projectName(project)), track, make("span", "hist-bar-value", tokens(sum)));
      bars.append(row);
    }
    usage.append(bars);
    if (ranked.length > 8) usage.append(make("p", "hist-muted", `${plural(ranked.length - 8, "more project")} below these.`));
  };

  /* ------------------------------------------------------------ sessions */

  const actionButton = (label: string, onClick: (button: HTMLButtonElement) => void, primary = false): HTMLButtonElement => {
    const button = make("button", primary ? "hist-btn is-primary" : "hist-btn", label);
    button.type = "button";
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick(button);
    });
    return button;
  };

  const sessionRow = (session: HistorySession): HTMLElement => {
    const row = make("article", "hist-row");
    row.dataset.session = session.id;
    row.setAttribute("role", "listitem");
    row.tabIndex = 0;
    const isNew = Date.parse(session.endedAt) > since;
    const live = liveTerminal(session.id);
    row.classList.toggle("is-new", isNew && !live);
    row.classList.toggle("is-open", expanded.has(session.id));

    const top = make("div", "hist-row-top");
    top.append(make("i", "hist-dot"));
    top.append(make("b", "hist-row-project", events.projectName(session.project)));
    top.append(make("span", "hist-row-title", plainText(session.title) || "Untitled session"));
    if (session.headless) top.append(make("span", "hist-chip", "headless"));
    if (live) top.append(make("span", "hist-chip is-live", "open"));
    top.append(make("time", "hist-row-when", clock(session.endedAt)));
    row.append(top);

    const meta = make("div", "hist-row-meta");
    const used = data?.usage.filter((item) => item.session === session.id).reduce((sum, item) => sum + processed(item), 0) ?? 0;
    meta.append(agentTag(session.agent));
    if (session.prompts) meta.append(make("span", "", plural(session.prompts, "prompt")));
    if (session.files.length) meta.append(make("span", "", plural(session.files.length, "file")));
    if (used) meta.append(make("span", "", `${tokens(used)} tokens`));
    const status = make("span", "hist-row-status");
    status.setAttribute("role", "status");

    const actions = make("div", "hist-row-actions");
    if (live) {
      actions.append(actionButton("Open terminal", () => events.openTerminal(live), true));
    } else if (session.resume !== "none") {
      const resume = actionButton("Resume", (button) => {
        button.disabled = true;
        status.textContent = "Starting…";
        void events.resume(session).then((panelSession) => {
          resumed.set(session.id, panelSession);
          status.textContent = "";
        }).catch((error: unknown) => {
          status.textContent = errorText(error, "It could not resume.");
          button.disabled = false;
        });
      }, true);
      actions.append(resume);
    }
    actions.append(actionButton("Copy link", (button) => {
      void copy(sessionLink(session.id)).then(() => {
        button.textContent = "Copied";
        window.setTimeout(() => { button.textContent = "Copy link"; }, 1400);
      });
    }));
    meta.append(status, actions);
    row.append(meta);

    if (expanded.has(session.id)) row.append(detail(session));

    const toggle = (): void => {
      if (expanded.has(session.id)) expanded.delete(session.id);
      else expanded.add(session.id);
      row.replaceWith(sessionRow(session));
      host.querySelector<HTMLElement>(`.hist-row[data-session="${CSS.escape(session.id)}"]`)?.focus();
    };
    row.addEventListener("click", toggle);
    row.addEventListener("keydown", (event) => {
      if (event.target !== row || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      toggle();
    });
    return row;
  };

  const detail = (session: HistorySession): HTMLElement => {
    const box = make("div", "hist-detail");
    box.addEventListener("click", (event) => event.stopPropagation());
    const field = (label: string, text: string): void => {
      if (!text) return;
      const item = make("div", "hist-field");
      item.append(make("span", "hist-label", label), make("p", "", text));
      box.append(item);
    };
    field("First ask", session.firstPrompt);
    if (session.lastPrompt !== session.firstPrompt) field("Last ask", session.lastPrompt);
    // The agent's last reply, only here: a folded row is the title, so a day of sessions stays a
    // list you can scan.
    field("Last reply", plainLines(session.lastText));
    if (session.files.length) {
      const item = make("div", "hist-field");
      item.append(make("span", "hist-label", "Files written"));
      const files = make("div", "hist-files");
      for (const path of session.files) {
        // Agents also write outside the folder they run in. Work opens project files only.
        if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) {
          const plain = make("span", "hist-file is-outside", path);
          plain.title = "Outside this project";
          files.append(plain);
          continue;
        }
        const button = make("button", "hist-file", path);
        button.type = "button";
        button.title = `Open ${path} in Work`;
        button.addEventListener("click", () => events.openFile(session, path));
        files.append(button);
      }
      item.append(files);
      box.append(item);
    }
    field("Folder", session.cwd);
    if (!session.lastText && session.agent === "codex") field("Replies", "Codex does not keep replies on disk.");
    const started = new Date(session.startedAt);
    const ended = new Date(session.endedAt);
    const sameDay = localDay(started) === localDay(ended);
    field("Ran", `${started.toLocaleString()} → ${sameDay ? clock(session.endedAt) : ended.toLocaleString()}`);
    return box;
  };

  const paintSessions = (): void => {
    if (!data || query) return;
    const sessions = shownSessions();
    const fresh = sinceSeen(data, since).filter((session) => !agent || session.agent === agent).length;
    tally.textContent = fresh ? `${fresh} new since you last looked` : plural(sessions.length, "session");
    tally.classList.toggle("is-hot", fresh > 0);
    if (!sessions.length) {
      list.replaceChildren(make("div", "hist-none", "No agent sessions in your projects in this window."));
    } else {
      const groups = new Map<string, HistorySession[]>();
      for (const session of sessions) {
        const day = localDay(new Date(session.endedAt));
        groups.set(day, [...(groups.get(day) ?? []), session]);
      }
      list.replaceChildren(
        ...[...groups.entries()].flatMap(([day, rows]) => [
          make("h3", "hist-day", dayLabel(day)),
          ...rows.map(sessionRow),
        ]),
      );
    }
    foot.textContent = [
      data.outside
        ? `${plural(data.outside, "session")} ran outside your projects, in scratch or temp folders. They are not listed.`
        : "",
      ...data.problems.map((problem) => `Could not read ${problem}`),
    ].filter(Boolean).join(" ");
  };

  /* ------------------------------------------------------------ search */

  const paintHits = (all: Hit[]): void => {
    lastHits = all;
    const quiet = new Set((data?.sessions ?? []).filter((session) => !kept(session)).map((session) => session.id));
    const matching = all.filter((hit) => !quiet.has(hit.session) && (!agent || hit.agent === agent));
    const hits = matching.slice(0, HIT_ROWS);
    tally.textContent = matching.length > HIT_ROWS ? `${HIT_ROWS}+ matches` : plural(hits.length, "match");
    tally.classList.remove("is-hot");
    if (!hits.length) {
      const who = agent ? agentName(agent) : "an agent";
      list.replaceChildren(make("div", "hist-none", `Nothing you or ${who} said matches “${query}”.`));
      return;
    }
    list.replaceChildren(
      ...hits.map((hit) => {
        const row = make("button", "hist-hit");
        row.type = "button";
        const top = make("div", "hist-row-top");
        top.append(
          make("b", "hist-row-project", events.projectName(hit.project)),
          make("span", "hist-row-title", hit.title),
          agentTag(hit.agent),
          ...(hit.role === "you" ? [make("span", "hist-chip is-you", "you")] : []),
          make("time", "hist-row-when", relativeTime(hit.at)),
        );
        row.append(top, make("p", "hist-hit-snippet", plainText(hit.snippet)));
        row.addEventListener("click", () => focusSession(hit.session));
        return row;
      }),
    );
  };

  const runSearch = (): void => {
    query = find.value.trim();
    // Results first while searching; the usage box is about the window, not the query.
    usage.hidden = Boolean(query);
    window.clearTimeout(searchTimer);
    if (!query) {
      paintSessions();
      return;
    }
    const generation = ++searchGeneration;
    searchTimer = window.setTimeout(() => {
      void invoke<Hit[]>("search_history", { query, days })
        .then((hits) => {
          if (openState && generation === searchGeneration) paintHits(hits);
        })
        .catch((error: unknown) => {
          if (openState && generation === searchGeneration) {
            list.replaceChildren(make("div", "hist-none", errorText(error, "Search failed.")));
          }
        });
    }, 220);
  };

  /** Leave search, open the session's row and bring it into view. */
  const focusSession = (id: string): void => {
    find.value = "";
    query = "";
    expanded.add(id);
    paintSessions();
    const row = host.querySelector<HTMLElement>(`.hist-row[data-session="${CSS.escape(id)}"]`);
    if (!row) {
      list.prepend(make("div", "hist-none", "That conversation is older than this window, or ran outside your projects."));
      return;
    }
    row.scrollIntoView({ block: "center" });
    row.classList.add("is-flash");
    row.focus({ preventScroll: true });
  };

  /* ------------------------------------------------------------ load */

  const load = (focus?: { query?: string; session?: string }): void => {
    tally.textContent = "Reading sessions…";
    tally.classList.remove("is-hot");
    void fetchHistory(days)
      .then((next) => {
        if (!openState) return;
        data = next;
        paintAgents();
        paintUsage();
        if (focus?.session) focusSession(focus.session);
        else if (query) runSearch();
        else paintSessions();
      })
      .catch((error: unknown) => {
        if (!openState) return;
        tally.textContent = "";
        list.replaceChildren(make("div", "hist-none", errorText(error, "The session stores could not be read.")));
      });
  };

  find.addEventListener("input", runSearch);
  find.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && find.value) {
      event.preventDefault();
      event.stopPropagation();
      find.value = "";
      runSearch();
    }
  });
  range.addEventListener("change", () => {
    days = Number(range.value);
    load();
  });

  return {
    open(focus) {
      const first = !openState;
      openState = true;
      host.hidden = false;
      if (first) since = seenAt();
      if (focus?.query !== undefined) find.value = focus.query;
      query = find.value.trim();
      load(focus);
      if (!focus?.session) find.focus({ preventScroll: true });
    },
    clear() {
      if (!openState) return;
      openState = false;
      host.hidden = true;
      window.clearTimeout(searchTimer);
      expanded.clear();
      markSeen();
      events.seen();
    },
    isOpen: () => openState,
  };
}
