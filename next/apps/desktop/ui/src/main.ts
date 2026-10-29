/**
 * The spine.
 *
 * Panel is an admin panel across a portfolio, not an IDE inside one repo. The PROJECT is
 * the unit: each one owns an agent, a working set and a stage, and several
 * run at once. Selecting a project swaps what you SEE; it never tears down what is RUNNING.
 *
 * Every event arrives from Rust already tagged with its project, so this file routes rather
 * than guesses. Nothing here knows how a view, a question, or a file is drawn.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { icon } from "./icons";
import { projectIconUrl, schemeOrigin } from "./project-assets";
import { withViewTransition } from "./motion";
import { renderView } from "./registry";
import { str } from "./views/dom";
import { isLightboxOpen } from "./views/lightbox";
import { MAIN_ID } from "./types";
import type {
  ChangeStep,
  PanelModule,
  GitState,
  Group,
  Payload,
  Project,
  ProjectModules,
  ProjectEvent,
  RenderCtx,
  RunInventory,
  Session,
  SimStart,
  WorkFile,
} from "./types";
import { parseAppLink, type FileTarget, type Place } from "./deeplink";
import { TerminalDeck } from "./features/terminal";
import { mountSessionStrip, type SessionStripHandle } from "./features/sessions";
import { openSkills } from "./features/skills";
import { isAgentKind, type SessionKind } from "./features/agent-kinds";
import { mountHome, type HomeHandle, type HomeProject } from "./features/home";
import type { ProjectDeskHandle } from "./features/project_desk";
import type { OpsMapHandle } from "./features/ops_map";
import type { BoardData, BoardHandle, BuildList, Scout, ScoutList, ScoutRun } from "./features/board";
import { mountChat, type ChatHandle } from "./features/chat";
import { mountAskTray, type AskTrayHandle } from "./features/ask_tray";
import type { NotebookHandle } from "./features/notebook";
import type { SupportHandle } from "./features/support";
import { mountReview } from "./features/review";
import { fetchHistory, mountHistory, sinceSeen, type HistoryHandle, type HistorySession } from "./features/history";
import { moduleGet, modulePost } from "./features/modules";
import { mountQuickOpen } from "./features/editor";
import { mountTerminals, type TerminalsHandle } from "./features/terminals";
import {
  EXTENSIONS_EVENT,
  PREF,
  isRecording,
  mountSettings,
  type SettingsHandle,
} from "./features/settings";
import {
  KEYMAP_EVENT,
  IS_MAC,
  type ActionId,
  digitOf,
  label as chordLabel,
  matches as chordMatches,
  matchesShortcut,
  shortcutLabel,
} from "./features/keymap";
import { mountPulse } from "./features/pulse";
import {
  LANES,
  STALE_AFTER,
  age,
  gitChip,
  known,
  laneOf,
  parseQuery,
  platformGroups,
  rowLine,
  sparkSvg,
  splitNames,
  urgent,
  type Lane,
  type Line,
  type RowAction,
  type RowFacts,
} from "./features/rail";
import { mountRailCard, type CardAction, type CardModel } from "./features/rail-card";
import { nextMove } from "./features/next-move";
import { mountRunner, type RunnerHandle, type RunnerProject } from "./features/runner";
import { alertDialog, confirmDialog, promptDialog } from "./views/dialog";
import { mountDashboard, type DashboardHandle } from "./features/dashboard";
import {
  mountProjectTerminals,
  type ProjectTerminalsHandle,
} from "./features/project_terminals";
import { createWorkshop, type WorkshopHandle, type WorkshopPhase } from "./features/workshop";
import { createProjectTools } from "./features/project_tools";
import { errorNote } from "./errors";
import "./views";
import "./motion.css";
import "./style.css";

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};

/**
 * The module rail. Every place you can be on a project screen is one of these, and they all sit
 * TOGETHER at the top — Terminals, Dashboard, then one segment per Panel module.
 *
 * Projects open on Terminals. Git follows immediately for reviewing the agent's changes.
 * Dashboard and Work remain available without interrupting the terminal-first workflow.
 *
 * They used to be scattered: Git was a tab, Product Spine was a ghost button off in the actions, and
 * Release — a whole module, the one that answers "what is actually shipped?" — was not on the
 * screen at all. Three modules, three different shapes, so nothing read as "these are the doors
 * into this project". Same rail, same shape, one hue each.
 *
 * The agent's rendered output is NOT a place of its own: it lands on the Dashboard. It used to
 * have a tab, which meant the same event stream was readable in two fidelities at once
 * (cards / PTY) and the screen read as noise.
 */
type CoreTab = "terminals" | "dash" | "files" | "debug" | "git" | "product-spine" | "release" | "revenuecat" | "analytics";
type Tab = CoreTab | `extension:${string}:${string}`;

type TurnWork = {
  /** First line of the latest user prompt for this terminal session. */
  prompt: string | null;
  /** Files connected to that prompt, never the repository's accumulated Git dirt. */
  files: WorkFile[];
  /** A deliberate agent handoff is authoritative over automatically observed edits. */
  declared: boolean;
};

/**
 * Everything Panel knows about one project. The DOM lives here rather than being re-rendered
 * on switch — a project you come back to should look exactly as you left it, scroll included.
 */
type ProjectState = {
  project: Project;
  stage: HTMLElement;
  /** Automatic, event-derived scene for this project's current work. */
  workshop: WorkshopHandle;
  /** Latest-prompt working set per terminal. Multiple agents in one project never mix lists. */
  workBySession: Map<string, TurnWork>;
  status: string;
  detail: string;
  running: boolean;
  modules: Set<string>;
  tab: Tab;
  unseenStage: number;
  unseenFiles: number;
  /** Every terminal open on this project — agents and shells alike, in the order opened. */
  sessions: Session[];
  /** Which one's screen is showing. The others keep running regardless. */
  activeSession: string | null;
  /** `Date.now()` of the last time this project was selected. 0 = never — sinks to config order. */
  lastActive: number;
};

const states = new Map<string, ProjectState>();
let active: string | null = null;
/** The sidebar's slow facts (git, commits, portfolio status, analytics) and its hover card. Up
 *  here so every function below can read them from the first paint. */
const pulse = mountPulse({
  changed: () => paintProjectsSoon(),
  analyticsInstalled: () => moduleInstalled("analytics"),
});
const railCard = mountRailCard();

/** Sessions whose process has exited. They keep their transcript; they stop claiming to run. */
const exited = new Set<string>();
/**
 * Distinct files an agent has written since the human last looked at this project's Work tab.
 * This is a COUNT for the rail badge and nothing else — there is no banner, no theater and no
 * pending queue any more. What an agent actually did is reported in the chat rail.
 */
const unseenEdits = new Map<string, Set<string>>();
/** Prevent a repeated shortcut or double-click from trying to close the same PTY twice. */
const closing = new Set<string>();
/**
 * Agent sessions that are mid-turn. The OS cannot see this: an agent waiting on the model has
 * forked nothing, so it looks exactly like an idle prompt — and closing it would throw away a
 * turn in flight. Filled from the agent's own status events, emptied when the turn finishes.
 */
const working = new Set<string>();
/**
 * The same knowledge, one step finer, for the one surface that shows sessions side by side.
 *
 * `working` answers "may I close this"; a wall of nine identical black panes needs the other
 * question — WHICH of these is running and which one is parked on you. "ask" is a turn that has
 * stopped and wants an answer; "work" is a turn still moving. A session absent from this map is
 * quiet, and a shell is always absent: it never speaks a status in its life.
 */
const sessionPhase = new Map<string, "work" | "ask">();
/** When each session began waiting on you. ⌘⇧A visits the longest wait first. */
const askSince = new Map<string, number>();
/**
 * Agents put to sleep, and what each gave back (null when there was no reading). Asleep is a
 * kind of exited: no process, the scrollback kept. The difference is that Wake resumes the same
 * conversation in the same pane, where Restart starts a new one.
 */
const asleep = new Map<string, number | null>();
/** The latest reading per live session, from session_memory. */
let memory = new Map<string, { bytes: number | null; canSleep: boolean }>();
/** When a person or the agent last did anything in each session. A session never touched
 *  counts from launch, so a restored wall is not put to sleep on its first tick. */
const touched = new Map<string, number>();
const launchedAt = Date.now();
/** When a sleep was last refused, per session. Most refusals are an agent with no conversation
 *  yet, so auto-sleep waits a while before it asks that one again. */
const refused = new Map<string, number>();
const RETRY_REFUSED = 15 * 60_000;
/** The only writer of sessionPhase, so a wait's start time can never outlive the wait. */
function setPhase(sessionId: string, phase: "work" | "ask" | null): void {
  if (phase !== "ask") askSince.delete(sessionId);
  else if (sessionPhase.get(sessionId) !== "ask") askSince.set(sessionId, Date.now());
  if (phase) sessionPhase.set(sessionId, phase);
  else sessionPhase.delete(sessionId);
}

/* ------------------------------------------------------------------ attention
 * "Which agent needs me" is the question Panel exists to answer. Two states answer it, and the
 * rail row, Home's card and the dock badge all read them from here:
 *
 *   - needs  — a session is parked on you: a permission prompt in its terminal, or an open ask.
 *   - done   — a turn finished while you were not looking. It is your move, and an idle dot
 *              would say the same thing as a project nobody touched all week.
 */
type Attention = "needs" | "done" | null;
/** Projects whose last turn finished out of sight. Cleared by looking at the project. */
const doneUnseen = new Set<string>();
const attentionOf = (here: ProjectState): Attention =>
  here.sessions.some((session) => sessionPhase.get(session.id) === "ask")
    ? "needs"
    : doneUnseen.has(here.project.id)
      ? "done"
      : null;
/** The human can see this project right now. */
const lookingAt = (id: string): boolean =>
  document.hasFocus() &&
  (id === CPO_ID
    ? chatActive && chat.currentSection() === "manager"
    : active === id && !offProject());

type Alert = { title: string; body: string; urgent: boolean };
let badgeShown = -1;
/** Keep the dock badge on the count. An alert is sent with it; Rust drops it if Panel has focus. */
function signalAttention(alert: Alert | null = null): void {
  const count = [...states.values()].filter((here) => attentionOf(here)).length;
  if (!alert && count === badgeShown) return;
  badgeShown = count;
  void invoke("set_attention", { count, alert }).catch((error) =>
    console.warn("[panel] attention signal failed", error),
  );
}

function markSeen(id: string): void {
  if (doneUnseen.delete(id)) paintProjectsSoon();
}

/** A permission wait ends when the agent moves again or you answer it in the terminal. An open
 *  ask does not: only its own answer or timeout ends it. */
function endPermissionWait(id: string, sessionId: string): void {
  if (sessionPhase.get(sessionId) !== "ask" || askTray.sessionAsking(sessionId)) return;
  setPhase(sessionId, "work");
  setStatus(id, "working");
}
/** True while ANY project has a live (non-exited) session. */
const hasLiveSessions = (): boolean =>
  [...states.values()].some((here) => here.sessions.some((session) => !exited.has(session.id)));

// Dev-only: tell vite.config.ts's plugin when a session is live so it defers the full-page
// reload that would otherwise forget the deck's adopted panes mid-session.
if (import.meta.hot) {
  let lastReported: boolean | null = null;
  window.setInterval(() => {
    const live = hasLiveSessions();
    if (live === lastReported) return;
    lastReported = live;
    void fetch("/__panel-sessions", { method: "POST", body: JSON.stringify({ active: live }) }).catch(
      () => undefined,
    );
  }, 1500);
}

/**
 * The portfolio's groups, in config order. Read once at boot — a company is not something that
 * changes while you work, and re-reading it on every repaint would be a disk read per frame.
 *
 * Empty is the normal case for a single-company portfolio, and everything downstream treats it
 * that way: no sidebar sections, no per-group tabs, nothing to notice.
 */
let groups: Group[] = [];
const groupName = (id: string): string =>
  groups.find((group) => group.id === id)?.name ?? (id || "");

const projectList = el("projectList");
const projectFilter = el<HTMLInputElement>("projectFilter");
const projectCount = el("projectCount");
const projectLive = el<HTMLButtonElement>("projectLive");
const projectSort = el<HTMLButtonElement>("projectSort");
const projectsLabel = el("projectsLabel");
const projectShowAll = el<HTMLButtonElement>("projectShowAll");
const filesPane = el("filesPane");
const debugPane = el("debugPane");
const dashPane = el("dashPane");
const terminalsTabPane = el("terminalsTabPane");
const gitPane = el("gitPane");
const productSpinePane = el("productSpinePane");
const releasePane = el("releasePane");
const revenueCatPane = el("revenueCatPane");
const analyticsPane = el("analyticsPane");

let dashboard: DashboardHandle;
let projectTerminals: ProjectTerminalsHandle;
let deck: TerminalDeck;
let strip: SessionStripHandle;
let home: HomeHandle;
let chat: ChatHandle;
let askTray: AskTrayHandle;
let notebook: NotebookHandle | null = null;
let notebookLoading: Promise<NotebookHandle> | null = null;
/** The plan screen. Lazy like the notebook: most sessions never open it. */
let sprint: ProjectDeskHandle | null = null;
let sprintLoading: Promise<ProjectDeskHandle> | null = null;
let sprintActive = false;
let settingsFromSprint = false;
let chatFromSprint = false;
/** The ops network. Lazy: a screen you go to. */
let opsMap: OpsMapHandle | null = null;
let opsMapLoading: Promise<OpsMapHandle> | null = null;
let opsMapActive = false;
let board: BoardHandle | null = null;
let boardLoading: Promise<BoardHandle> | null = null;
let boardActive = false;
let settingsFromOpsMap = false;
let chatFromOpsMap = false;
/** The support queue. Lazy for the same reason as the plan: it is a screen you go to, not one
 *  you land on, and mounting it costs a read of the module's stored log. */
let support: SupportHandle | null = null;
let supportLoading: Promise<SupportHandle> | null = null;
let supportActive = false;
let reviewActive = false;
let review: ReturnType<typeof mountReview>;
/** Every agent session, reported or not, read from each agent's own store. */
let history: HistoryHandle;
let historyActive = false;
let terminals: TerminalsHandle;
/** The workspace screen is up — Runs, or one of the terminal tabs. Every portfolio-level WORK
 *  surface is a tab of this one screen; Home, Settings and a project each replace it. */
let terminalsActive = false;
let settings: SettingsHandle;
/** Settings is a screen, so something has to remember what it took the glass from. */
let settingsActive = false;
let settingsFromWorkspace = false;
let settingsFromHome = false;
let settingsFromNotebook = false;
let runner: RunnerHandle;
/** Home is a screen of its own — the portfolio's landing, not a tab of the work area. */
let homeActive = false;
/** Local Markdown notes. This screen has no project or agent connection. */
let notebookActive = false;
/** Chat is a screen too now, so it needs the same bookkeeping Settings has: it took the glass
 *  from something, and it owes that something back on the way out. */
let chatActive = false;
let chatFromWorkspace = false;
let chatFromHome = false;
let chatFromNotebook = false;
/** Which pinned tab of the workspace is up. Mirrors of terminals.pinnedAt(), kept here because
 *  the hotkey guards below read them on every keystroke and they change only on a tab switch. */
let runnerActive = false;
let chatSequence = 0;

/** Open (or reuse) this project's Claude session and submit a task as its first prompt. */
async function runWithAgent(prompt: string): Promise<void> {
  if (!active) return;
  const session = await openSessionFor(active, "claude");
  if (!session) return;
  await invoke("write_terminal", { terminalId: session.terminal_id, data: `${prompt}\r` });
  jumpToSession(session.project, session.id);
}

/**
 * A command an agent printed, run in a shell of that agent's project. An idle shell already open
 * there takes it, so a row of Run clicks does not leave a row of terminals; otherwise a new one
 * opens at the project root. Panel goes to that shell either way: what ran is never hidden.
 */
async function runInShell(sessionId: string, command: string): Promise<boolean> {
  const project = sessionById(sessionId)?.project;
  const here = project ? state(project) : undefined;
  if (!project || !here) return false;
  let shell: Session | null = null;
  for (const candidate of here.sessions) {
    if (candidate.kind !== "shell" || exited.has(candidate.id) || asleep.has(candidate.id)) continue;
    if (!await invoke<boolean>("session_busy", { session: candidate.id }).catch(() => true)) {
      shell = candidate;
      break;
    }
  }
  shell ??= await openSessionFor(project, "shell");
  if (!shell) return false;
  // One line runs. Several are pasted and wait for Enter: a TUI wraps a long command with a
  // real newline, and running each half on its own could do damage.
  const data = command.includes("\n") ? `\x1b[200~${command}\x1b[201~` : `${command}\r`;
  try {
    // A shell still starting reads it once it is up.
    await invoke("write_terminal", { terminalId: shell.terminal_id, data });
  } catch {
    return false;
  }
  jumpToSession(project, shell.id);
  return true;
}

let shutdownPromptOpen = false;

/** The manager's project id. It has a project state like every worker, so its terminal is tracked
 *  the same way, but it is not in the portfolio: no sidebar row, no Home card, no git surface. The
 *  host resolves it against the ops tree. Mirrors CPO_ID in main.rs. */
const CPO_ID = "appgea";

/** Project states that are not in the portfolio. */
const offPortfolio = (id: string): boolean => id === CPO_ID || id === MAIN_ID;

/** Every project state except the manager's and the main folder's — what the portfolio surfaces iterate. */
function portfolioStates(): ProjectState[] {
  return [...states.values()].filter((here) => !offPortfolio(here.project.id));
}

/** The main folder can move when the portfolio does: with no `mainFolder` set it is derived. */
async function refreshMainFolder(): Promise<void> {
  const main = await invoke<Project>("main_folder_project").catch(() => null);
  if (!main) return;
  const known = states.get(MAIN_ID);
  if (!known) {
    states.set(MAIN_ID, makeState(main));
    return;
  }
  known.project.path = main.path;
  known.project.exists = main.exists;
}

/** The manager's live session, newest first. Null when it is not running. */
function managerSession(): Session | null {
  const here = states.get(CPO_ID);
  const live = here?.sessions.filter((session) => isAgentKind(session.kind) && !exited.has(session.id)) ?? [];
  return live[live.length - 1] ?? null;
}

const projectTools = createProjectTools(
  {
    files: filesPane,
    debugger: debugPane,
    git: gitPane,
    productSpine: productSpinePane,
    release: releasePane,
    revenuecat: revenueCatPane,
    analytics: analyticsPane,
  },
  {
    current() {
      const here = active ? state(active) : undefined;
      if (!here) return null;
      return {
        id: here.project.id,
        path: here.project.path,
      };
    },
    // One entry per terminal that has a turn on record, newest terminal first. `live` is the
    // same mid-turn test the status dot uses, so Git never offers to commit a half-written turn.
    turns(projectId = active ?? undefined) {
      const here = projectId ? state(projectId) : undefined;
      if (!here) return [];
      return [...here.sessions]
        .reverse()
        .flatMap((session) => {
          const turn = here.workBySession.get(session.id);
          if (!turn || exited.has(session.id)) return [];
          return [
            {
              session: session.id,
              agent: session.title || session.kind,
              prompt: turn.prompt,
              files: turn.files.map((file) => file.path),
              live: working.has(session.id),
            },
          ];
        });
    },
    runWithAgent,
    gitProjects: () => portfolioStates()
      .filter(({ project }) => project.role === "leaf" && project.exists)
      .map(({ project }) => ({ id: project.id, name: project.name, path: project.path })),
    openGitProject: (id) => { void select(id, "git"); },
    openProject(path, tab) {
      const target = portfolioStates().find(({ project }) =>
        project.path === path
        || path.startsWith(project.path + "/")
        || project.path.startsWith(path + "/"),
      );
      if (target) void select(target.project.id, tab);
    },
    openRef(path, line) {
      ctx.openRef(`${path}:${line}`);
    },
  },
);

const ctx: RenderCtx = {
  openRef(ref) {
    const match = /^(.*?)(?::(\d+))?$/.exec(ref.trim());
    if (!match || !active) return;
    setTab("files");
    void projectTools.ensureFiles().then((handle) =>
      handle.open(match[1], match[2] ? Number(match[2]) : undefined),
    );
  },
  async openDocument(path, draft) {
    if (!active) throw new Error("No project selected.");
    setTab("files");
    await (await projectTools.ensureFiles()).openDocument(path, draft);
  },
  async finishDocument(path) {
    if (!active) throw new Error("No project selected.");
    return (await projectTools.ensureFiles()).finishDocument(path);
  },
  openPlace(place, alongside) {
    openPlace(active, place, alongside);
  },
};

/**
 * Where a Panel link goes (deeplink.ts). Review opens the deck on the files the report named —
 * falling back to the project's queue when none of them is on disk — and never leaves the screen
 * you were on. Work and Git are the project's own tabs; the Manager is its pane in Chat.
 */
function openPlace(project: string | null, place: Place, alongside: string[] = []): void {
  if (place.to === "manager") {
    chat.showCpo();
    return;
  }
  // The Manager and the main folder are not projects: no Review queue, Work tab or Git to open.
  if (!project || offPortfolio(project)) return;
  if (place.to === "work") {
    projectCtx(project).openRef(place.line ? `${place.path}:${place.line}` : place.path);
  } else if (place.to === "git") {
    void select(project, "git");
  } else {
    const paths = [...new Set([...alongside, ...(place.path ? [place.path] : [])])];
    if (!paths.length) showReview(project);
    else void review.openFiles(project, paths, place.path).then((opened) => opened || showReview(project));
  }
}

/** Chat posts can open a file from ANY project, not whichever project happened to be selected
 * before the Workspace came up. Each post carries its routing context with it. */
function projectCtx(project: string): RenderCtx {
  return {
    openRef(ref) {
      const match = /^(.*?)(?::(\d+))?$/.exec(ref.trim());
      if (!match) return;
      void select(project).then(() => {
        setTab("files");
        void projectTools.ensureFiles().then((handle) =>
          handle.open(match[1], match[2] ? Number(match[2]) : undefined),
        );
      });
    },
    async openDocument(path, draft) {
      await select(project);
      setTab("files");
      await (await projectTools.ensureFiles()).openDocument(path, draft);
    },
    async finishDocument(path) {
      await select(project);
      setTab("files");
      return (await projectTools.ensureFiles()).finishDocument(path);
    },
    openPlace(place, alongside) {
      openPlace(project, place, alongside);
    },
  };
}

/* --------------------------------------------------------------- projects */

function state(id: string): ProjectState | undefined {
  return states.get(id);
}

/** When each project was last worked in, kept across launches (see `lastActive`). */
const recentStamps = readStored<Record<string, number>>("panel-project-recent", {});

/** Record that real work happened in a project. This is the only thing that feeds the rail's
 *  short list, so it is deliberately narrow: opening a session or an agent turn, never a click. */
function touchProject(id: string): void {
  const here = state(id);
  if (!here) return;
  here.lastActive = Date.now();
  recentStamps[id] = here.lastActive;
  try {
    localStorage.setItem("panel-project-recent", JSON.stringify(recentStamps));
  } catch {
    /* a full or blocked store costs us ordering, nothing more */
  }
}

function makeState(project: Project): ProjectState {
  const own = () => {
    const node = document.createElement("div");
    node.className = "own";
    return node;
  };
  return {
    project,
    stage: own(),
    workshop: createWorkshop(
      project,
      (path) => {
        if (active !== project.id) void select(project.id).then(() => ctx.openRef(path));
        else ctx.openRef(path);
      },
      (path) => invoke<ChangeStep[]>("file_changes", { project: project.id, path }),
    ),
    workBySession: new Map(),
    status: "idle",
    detail: "no agent running",
    running: false,
    // Empty until `project_modules` answers. Tabs then FADE IN rather than out: guessing a broad
    // set here meant every project flashed Release and RevenueCat for a frame before losing them.
    modules: new Set<string>(),
    tab: defaultTab(project),
    unseenStage: 0,
    unseenFiles: 0,
    sessions: [],
    activeSession: null,
    // Recency outlives the launch. The rail's short list IS the recent list, so a stamp that
    // reset every morning would hand you five arbitrary rows on the first run of the day.
    lastActive: recentStamps[project.id] ?? 0,
  };
}

/** Terminals, Dashboard, Work and Debug are core surfaces. Every project has them, so they are not
 *  modules and cannot be switched off. Everything else stands only where the project has a use for it:
 *  Analytics without a Firebase config, or RevenueCat without the SDK, is a tab that can only ever
 *  show you an error. Panel detects the set (see `detect_modules` in projects.rs) and
 *  `.panel/modules.json` overrides it. */
function tabEnabled(here: ProjectState, tab: Tab): boolean {
  const extension = extensionTabs.get(tab);
  if (extension) {
    return (
      activeExtensionModules.has(extension.module) &&
      here.project.extension_id === extension.module &&
      (!extension.roles.length || extension.roles.includes(here.project.role)) &&
      (!extension.types.length || extension.types.includes(here.project.type))
    );
  }
  if (here.project.role === "collection") return false;
  if (tab === "terminals" || tab === "dash" || tab === "files" || tab === "debug") return true;
  return here.modules.has(tab);
}

function mountModuleRailControls(): void {
  const rail = document.querySelector<HTMLElement>(".mtabs")!;
  const wrap = document.createElement("div");
  wrap.className = "mtabs-wrap";
  rail.parentElement!.insertBefore(wrap, rail);
  const arrow = (direction: "left" | "right"): HTMLButtonElement => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `mtabs-scroll is-${direction}`;
    button.textContent = direction === "left" ? "‹" : "›";
    button.setAttribute("aria-label", `Scroll project tabs ${direction}`);
    button.addEventListener("click", () => rail.scrollBy({
      left: (direction === "left" ? -1 : 1) * Math.max(180, rail.clientWidth * 0.65),
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    }));
    return button;
  };
  const left = arrow("left");
  const right = arrow("right");
  wrap.append(left, rail, right);
  const update = (): void => {
    const overflow = rail.scrollWidth > rail.clientWidth + 1;
    left.hidden = !overflow;
    right.hidden = !overflow;
    left.disabled = rail.scrollLeft <= 1;
    right.disabled = rail.scrollLeft + rail.clientWidth >= rail.scrollWidth - 1;
  };
  rail.addEventListener("scroll", update, { passive: true });
  new ResizeObserver(update).observe(rail);
  new MutationObserver(update).observe(rail, {
    childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"],
  });
  update();
}

function syncModuleAvailability(here: ProjectState): void {
  el("tabGit").hidden = !tabEnabled(here, "git");
  el("tabProductSpine").hidden = !tabEnabled(here, "product-spine");
  el("tabRelease").hidden = !tabEnabled(here, "release");
  el("tabRevenueCat").hidden = !tabEnabled(here, "revenuecat");
  el("tabAnalytics").hidden = !tabEnabled(here, "analytics");
  for (const entry of TABS) {
    if (entry.extension) el(entry.button).hidden = !tabEnabled(here, entry.tab);
  }
  dashboard.setModules(here.modules);
}

async function select(id: string, requestedTab?: Tab): Promise<void> {
  // Choosing any project always leaves the workspace cleanly; no-ops when it is down. Same
  // for Home and Settings — picking a project is as much a way out of them as Done is.
  dropSettings();
  dropHome();
  dropChat();
  dropNotebook();
  dropSprint();
  dropOpsMap();
  dropBoard();
  dropSupport();
  dropHistory();
  dropReview();
  exitTerminals();
  // Whatever took the glass has handed it back — the project chrome is the screen again. Said
  // here once rather than in each drop*(), which do not know what replaces them.
  mainZone().hidden = false;
  const next = state(id);
  if (!next) return;
  active = id;
  markSeen(id);
  el("startAgentError").hidden = true;
  // Selecting a project does NOT reorder the rail. A tap only moves the highlight — the row
  // floats up later, animated, when there's a real reason: an action or a live terminal
  // (see bumpProject). Reordering on every tap made the sidebar jump under the finger.

  // Swap the per-project DOM in wholesale. Cheap, and it preserves scroll.
  dashboard.stageHost.replaceChildren(next.stage);
  dashboard.workshopHost.replaceChildren(next.workshop.root);
  dashboard.syncStage();

  el("projectName").textContent = next.project.name;
  mainZone().classList.toggle("is-collection", next.project.role === "collection");
  if (next.project.role === "collection") {
    next.modules = new Set();
    next.tab = defaultTab(next.project);
    syncModuleAvailability(next);
    showSessions();
    paintProjects();
    paintNav();
    setTab(next.tab);
    setStatus(id, "idle", "collection");
    return;
  }
  projectTerminals.setProject(id);
  const moduleConfig = await invoke<ProjectModules>("project_modules", { project: id }).catch(() => {
    // Detection failed, so we know nothing about this project. Offer only the surfaces that are
    // about the repo itself — anything store- or SDK-shaped would be a guess.
    return { configured: false, enabled: ["git", "product-spine"], work_exclude: [] };
  });
  if (active !== id) return;
  next.modules = new Set(moduleConfig.enabled);
  syncModuleAvailability(next);
  if (requestedTab) next.tab = requestedTab;
  if (!tabEnabled(next, next.tab)) next.tab = defaultTab(next.project);
  // Git and Product Spine are NOT loaded here — see loadTab(). Eagerly opening them cost a module
  // round-trip each (repo detect + status + a 150-commit graph, and an iframe) on every click in
  // the sidebar, for two screens you were usually not even looking at.
  //
  // The sessions of every OTHER project keep running; we only stop showing them.
  showSessions();
  paintProjects();
  paintNav();
  setTab(next.tab);
  setStatus(id, next.status, next.detail);
  void refreshProject(id);
}

/* ---------------------------------------------------------------- sessions */

/**
 * Draw the strip and show the active session's screen, for whatever project is selected.
 *
 * This is the ONLY place that decides what the terminal zone looks like. Everything that changes
 * a session — opening, closing, exiting, switching project — funnels through here rather than
 * poking the zone itself, keeping the strip and the visible session in sync.
 */
function showSessions(): void {
  const here = active ? state(active) : undefined;
  if (!here) return;

  // A session you closed or that died is not somewhere you can be sent.
  if (here.activeSession && !here.sessions.some((s) => s.id === here.activeSession)) {
    here.activeSession = null;
  }
  if (!here.activeSession && here.sessions.length) {
    here.activeSession = here.sessions[here.sessions.length - 1].id;
  }

  strip.paint(here.sessions, here.activeSession, exited, asleep);
  // Empty, the strip would be a bar holding only Skills; the empty state below speaks instead.
  el("terminalEmpty").hidden = here.sessions.length > 0;
  el("sessionStrip").hidden = here.sessions.length === 0;
  deck.show(projectTerminalVisible() ? here.activeSession : null);
  syncActiveWork(here);

  // An agent is "running" for the dashboard's purposes when a live claude is open on it.
  here.running = here.sessions.some((s) => isAgentKind(s.kind) && !exited.has(s.id));
  here.workshop.setAgents(
    here.sessions
      .filter((session) => isAgentKind(session.kind) && !exited.has(session.id))
      .map((session) => session.title),
  );

  syncProjectTerminals();
  paintBadges();
  if (homeActive) home.sync(homeProjects());
  if (terminalsActive) terminals.sync(wallProjects());
}

/**
 * Open a session on ANY project — the Terminals screen launches across the whole portfolio,
 * so this cannot assume the target is the one being looked at. It ADDS — it never replaces
 * what is running. Simulator runs are NOT sessions: they belong to the Run screen and never
 * join the deck.
 */
/** Why the last start_session call failed — the Terminals wall reads this to explain a failed
 *  launch instead of silently snapping the ＋ pane back to idle. */
let lastStartError = "";

async function openSessionFor(
  projectId: string,
  kind: SessionKind,
  /** Fork here instead of the project root — ⌘T on the wall passes the focused shell's own cwd. */
  cwd?: string,
  /** Pick a past session of this kind back up (History) instead of starting fresh. */
  resume?: string,
): Promise<Session | null> {
  const here = state(projectId);
  if (!here) {
    lastStartError = `project “${projectId}” is not loaded`;
    return null;
  }
  if (here.project.role === "collection") {
    lastStartError = `project “${projectId}” is a collection`;
    return null;
  }
  let started: Session | null = null;
  try {
    lastStartError = "";
    const size = deck.proposeSize();
    const session = resume
      ? await invoke<Session>("resume_history", {
        project: projectId,
        agent: kind,
        conversation: resume,
        cwd: cwd ?? here.project.path,
        cols: size.cols,
        rows: size.rows,
      })
      : await invoke<Session>("start_session", {
        project: projectId,
        kind,
        cols: size.cols,
        rows: size.rows,
        cwd: cwd ?? null,
      });
    // The PTY now exists on the Rust side. From here on, a throw must reap it — otherwise a
    // failure building the xterm pane leaves a live, invisible process behind.
    started = session;
    here.sessions.push(session);
    here.activeSession = session.id;
    touched.set(session.id, Date.now());
    touchProject(projectId); // Feeds the Recent order only — the rail never reorders itself.
    deck.add(session.id, session.terminal_id);
    if (isAgentKind(kind)) setStatus(projectId, "ready", here.project.name);
    if (active === projectId) showSessions();
    paintProjects();
    // The project's RUNNING verdict just changed, and the dashboard draws from that. Without
    // this it goes on saying "at rest" at a live agent.
    void refreshProject(projectId);
    return session;
  } catch (error) {
    lastStartError = String(error);
    console.error("[panel] start_session failed", { projectId, kind, error });
    if (started) {
      // Roll back a half-open session: drop it from the model and kill its orphaned PTY.
      here.sessions = here.sessions.filter((s) => s.id !== started!.id);
      deck.remove(started.id);
      void invoke("stop_session", { session: started.id }).catch(() => undefined);
    }
    return null;
  }
}

/** An ended session, started again: same project, same kind. The ended one goes first, so the
 *  new terminal takes its seat rather than queuing behind a corpse. */
async function restartSession(sessionId: string): Promise<void> {
  if (asleep.has(sessionId)) return wakeSession(sessionId);
  const owner = [...states.values()].find((here) => here.sessions.some((s) => s.id === sessionId));
  const session = owner?.sessions.find((s) => s.id === sessionId);
  if (!owner || !session || !exited.has(sessionId)) return;
  // Runs and tasks restart from their own screens, which know their target and command.
  if (session.kind === "sim" || session.kind === "task") return;
  await closeSession(sessionId);
  const kind: SessionKind = session.kind;
  const next = await openSessionFor(owner.project.id, kind);
  if (!next) {
    await alertDialog(`${session.title} did not start again.\n\n${lastStartError || "Check that its CLI is installed."}`);
    return;
  }
  // On the wall the new tile appears in place; anywhere else, show it.
  if (!terminalsActive) jumpToSession(next.project, next.id);
}

/* ------------------------------------------------------------------ sleep
 * Nothing is torn down to look elsewhere, so by evening the wall is a pile of agents that all
 * still run, each half a gigabyte or more with its MCP servers. Sleep ends an agent's process
 * and keeps its pane. Wake resumes the same conversation there. main.rs has the long version. */

/** The terminal the keyboard is in, if the window has it. Never put to sleep under your hands. */
function typingIn(): string | null {
  if (!document.hasFocus()) return null;
  if (terminalsActive) return terminals?.focusedSession() ?? null;
  return active && !offProject() ? (state(active)?.activeSession ?? null) : null;
}

/** Agents that could sleep now and have been left alone for at least `quietFor` ms. Working,
 *  waiting on you, or under the caret: never. */
function quietAgents(quietFor: number): string[] {
  const now = Date.now();
  const here = typingIn();
  const out: string[] = [];
  for (const owner of states.values()) {
    for (const { id } of owner.sessions) {
      if (id === here || exited.has(id) || closing.has(id) || working.has(id) || sessionPhase.has(id)) continue;
      if (!memory.get(id)?.canSleep) continue;
      if (now - (touched.get(id) ?? launchedAt) < quietFor) continue;
      if (now - (refused.get(id) ?? 0) < RETRY_REFUSED) continue;
      out.push(id);
    }
  }
  return out;
}

/** Read what every live session holds. One `ps` on the Rust side, so cheap enough to poll. */
async function refreshMemory(): Promise<void> {
  const read = await invoke<Record<string, { bytes: number | null; canSleep: boolean }>>("session_memory")
    .catch(() => null);
  if (!read) return;
  memory = new Map(Object.entries(read));
  terminals?.paintMemory();
}

/** `asked`: you pressed it, so a refusal is said out loud. Auto-sleep only notes it. */
async function sleepSessions(ids: string[], asked: boolean): Promise<void> {
  const awake: string[] = [];
  await Promise.all(ids.map(async (id) => {
    if (asleep.has(id) || exited.has(id) || closing.has(id)) return;
    // Filed before the call: the PTY's closing chunk can beat the reply, and the pane must
    // already know to say "asleep" rather than "ended".
    asleep.set(id, memory.get(id)?.bytes ?? null);
    try {
      await invoke("sleep_session", { session: id });
      refused.delete(id);
      deck.ended(id);
    } catch (error) {
      asleep.delete(id);
      refused.set(id, Date.now());
      awake.push(`${sessionById(id)?.title ?? "agent"}: ${String(error)}`);
    }
  }));
  void refreshMemory();
  if (!awake.length) return;
  if (asked) await alertDialog(`${awake.length === 1 ? "It stayed" : `${awake.length} stayed`} awake.\n\n${awake.join("\n\n")}`);
  else console.warn("[panel] left awake", awake);
}

/** The setting's answer to "how long is too long". Checked once a minute. */
function sleepUnused(): void {
  const minutes = PREF.sleepAfterMinutes();
  if (!minutes) return;
  const due = quietAgents(minutes * 60_000);
  if (due.length) void sleepSessions(due, false);
}

/** Fork a sleeping agent again, on its own conversation, in its own pane. */
async function wakeSession(sessionId: string): Promise<void> {
  const owner = [...states.values()].find((here) => here.sessions.some((s) => s.id === sessionId));
  const session = owner?.sessions.find((s) => s.id === sessionId);
  if (!owner || !session || !asleep.has(sessionId)) return;
  const size = deck.proposeSize();
  let woke: Session;
  try {
    woke = await invoke<Session>("wake_session", { session: sessionId, cols: size.cols, rows: size.rows });
  } catch (error) {
    await alertDialog(`${session.title} did not wake.\n\n${String(error)}`);
    return;
  }
  asleep.delete(sessionId);
  exited.delete(sessionId);
  touched.set(sessionId, Date.now());
  // Same id, new PTY. Everything keyed by the id (its tab, its name, its seat) stays put.
  owner.sessions = owner.sessions.map((s) => (s.id === sessionId ? woke : s));
  deck.wake(sessionId, woke.terminal_id);
  owner.running = true;
  setStatus(owner.project.id, "ready", owner.project.name);
  if (active === owner.project.id) showSessions();
  paintProjects();
  void refreshProject(owner.project.id);
  void refreshMemory();
}

/** Who a review's feedback goes to: the agent you were last in on that project, else its newest
 *  live agent. Shells and ended sessions cannot take a message. */
function reviewAgent(projectId: string): Session | null {
  const here = state(projectId);
  if (!here) return null;
  const live = here.sessions.filter((s) => isAgentKind(s.kind) && !exited.has(s.id));
  return live.find((s) => s.id === here.activeSession) ?? live[live.length - 1] ?? null;
}

/** The active-project shorthand every in-project control uses. */
async function openSession(kind: SessionKind): Promise<boolean> {
  if (!active) return false;
  const session = await openSessionFor(active, kind);
  if (session) jumpToSession(session.project, session.id);
  return Boolean(session);
}

/** Is this session doing anything? An agent mid-turn counts even though it has forked nothing;
 *  otherwise it is the OS's answer (the PTY's foreground process is no longer the shell/agent
 *  itself). Unknown counts as busy — a failed probe must cost a click, never an unasked kill. */
async function sessionBusy(sessionId: string): Promise<boolean> {
  if (working.has(sessionId)) return true;
  return invoke<boolean>("session_busy", { session: sessionId }).catch(() => true);
}

/** Close one session for good: confirm a live process, kill the PTY, drop the screen, forget it.
 *  Owner is found by lookup — the Terminals wall closes sessions of projects you are not in. */
async function closeSession(sessionId: string): Promise<void> {
  const here = [...states.values()].find((candidate) =>
    candidate.sessions.some((s) => s.id === sessionId),
  );
  if (!here) return;
  const session = here.sessions.find((candidate) => candidate.id === sessionId);
  if (!session || closing.has(sessionId)) return;

  // An ended session is only retained scrollback and can disappear immediately. A live one is
  // asked about in two cases.
  //
  // One: something is visibly going on — a command running under the shell (the OS knows), or an
  // agent mid-turn (only Panel knows, since a thinking agent has forked nothing).
  //
  // Two: it is an AGENT AT ALL, busy or not. A shell at a prompt holds nothing and closing it
  // costs a keystroke to get back. An agent at a prompt is holding a whole conversation — the
  // context, the plan, everything it has read — and closing it throws that away with no undo and
  // no trace. "It happens to be idle this second" was never a reason to skip the question. So a
  // live agent is always worth one click; a live shell only when it is doing something.
  const liveAgent = !exited.has(sessionId) && isAgentKind(session.kind);
  if (!exited.has(sessionId) && (liveAgent || (await sessionBusy(sessionId)))) {
    const note = liveAgent
      ? "Its conversation and context are lost. This cannot be undone."
      : "Its running process will be stopped.";
    // Asked ON the terminal it is about — the prompt lives in that pane, so nothing else in the
    // app is blocked and there is no doubt which screen is being closed. Only when the pane is
    // off-screen (nothing to ask over) does this fall back to the app-modal confirm.
    const inPlace = deck.confirmClose(sessionId, {
      title: session.title,
      projectId: here.project.id,
      projectName: here.project.name,
      note,
    });
    const confirmed = await (inPlace ??
      confirmDialog(`Close “${session.title}”?\n\n${note}`, {
        okLabel: "Close session",
        danger: true,
      }));
    if (!confirmed) return;
    // The session could have exited or been closed elsewhere while the question was up.
    if (closing.has(sessionId) || !here.sessions.some((candidate) => candidate.id === sessionId)) return;
  }

  closing.add(sessionId);
  try {
    await invoke("stop_session", { session: sessionId }).catch(() => undefined);
    here.sessions = here.sessions.filter((candidate) => candidate.id !== sessionId);
    exited.delete(sessionId);
    asleep.delete(sessionId);
    memory.delete(sessionId);
    touched.delete(sessionId);
    refused.delete(sessionId);
    working.delete(sessionId);
    setPhase(sessionId, null);
    here.workBySession.delete(sessionId);
    deck.remove(sessionId);
    // Closed from the wall or its project page, the manager's pane must stop showing it too.
    chat.noteExit(sessionId);
    here.running = here.sessions.some((candidate) => isAgentKind(candidate.kind) && !exited.has(candidate.id));
    if (active === here.project.id) showSessions();
    if (!here.running) setStatus(here.project.id, "idle", "no agent running");
    paintProjects();
    void refreshProject(here.project.id);
  } finally {
    closing.delete(sessionId);
  }
}

/* -------------------------------------------------------------- workspace */

/**
 * ONE portfolio work screen replaces the per-project chrome while it is up: the Workspace.
 * Runs, and the terminal wall are tabs of it, not screens — see features/terminals.ts. The
 * sidebar has a single door into it for the same reason: the whole area is focused or it
 * isn't, and there is nothing separate left to focus.
 *
 * Home is NOT one of them. It is the portfolio's landing — where you look at the estate rather
 * than work in it — so it is a screen of its own, a standalone row above the group, and it
 * claims no digit chord.
 *
 * It borrows the deck's panes — it LENDS each mount div, the PTYs never notice, and takes
 * them all back on exit. While it is up the deck's single-screen logic stands down
 * (beginOverview) so nothing fights over mounts.
 *
 * ⌘1…⌘9 index the strip one for one while the wall is up: ⌘1 Runs, ⌘2 the first terminal tab.
 * On a project the same digits are Work's file slots. ⌘J is the door between the two, and ⌘K
 * lands straight on Runs.
 */
/** The wall's projects: the portfolio plus the manager, so its terminal sits on the wall like any
 *  worker's. Home and every other portfolio surface use homeProjects() and leave it out. */
function wallProjects(): HomeProject[] {
  return homeProjects(true);
}

function homeProjects(withManager = false): HomeProject[] {
  const pool = withManager ? [...states.values()] : portfolioStates();
  return pool.filter((here) => here.project.role === "leaf").map((here) => ({
    id: here.project.id,
    name: here.project.name,
    path: here.project.path,
    exists: here.project.exists,
    group: here.project.group,
    running: here.running,
    status: here.status,
    detail: here.detail,
    lastActive: here.lastActive,
    sessions: here.sessions,
    attention: attentionOf(here),
  }));
}

const mainZone = (): HTMLElement => document.querySelector<HTMLElement>(".main")!;

/** Strip indexes, in the order set by the `pinned` array handed to mountTerminals below:
 *  Runs, then the terminal tabs. Also the ⌘ ladder, off by one. Inbox used to hold index 0; it
 *  is not a tab any more, so the ladder lost a rung rather than keeping a dead one. */
const TAB_RUNS = 0;
/** The first terminal tab. Everything past it is another one. */
const TAB_WALL = 1;

/**
 * Bring the workspace up, optionally on a given strip index. Already up, it is only a tab
 * switch — nothing is torn down to change tabs. Without an index it lands wherever you left it.
 */
/**
 * Settings takes the glass from whatever was up and gives it back on the way out. It is a
 * screen because it earns one: a full grid of chords and switches is not a dialog, and a sheet
 * over a live wall leaves half the app visible and none of it clickable.
 */
function showSettings(): void {
  if (settingsActive) return;
  dropChat();
  settingsFromWorkspace = terminalsActive;
  settingsFromHome = homeActive;
  settingsFromNotebook = notebookActive;
  settingsFromSprint = sprintActive;
  settingsFromOpsMap = opsMapActive;
  // The workspace comes down properly — its pinned tabs go home and the deck takes its panes
  // back. Reopening rebuilds it on the same tabs; nothing about the PTYs is disturbed.
  if (terminalsActive) exitTerminals();
  dropHome();
  dropNotebook();
  dropSprint();
  dropOpsMap();
  dropBoard();
  dropSupport();
  dropHistory();
  dropReview();
  settingsActive = true;
  mainZone().hidden = true;
  el("settingsScreen").hidden = false;
  settings.open();
  paintNav();
}

/** Take Settings down without deciding what replaces it — for the paths that are on their way
 *  somewhere specific already (a project, Home, a workspace tab). */
function dropSettings(): void {
  if (!settingsActive) return;
  settings.clear();
  settingsActive = false;
  el("settingsScreen").hidden = true;
}

/** Leave Settings for the screen it interrupted. */
function exitSettings(): void {
  if (!settingsActive) return;
  dropSettings();
  if (settingsFromWorkspace) {
    showTerminals();
  } else if (settingsFromHome) {
    showHome();
  } else if (settingsFromNotebook) {
    showNotebook();
  } else if (settingsFromSprint) {
    showSprint();
  } else if (settingsFromOpsMap) {
    showOpsMap();
  } else {
    mainZone().hidden = false;
  }
  paintNav();
}

function showTerminals(at?: number): void {
  // Any other door out of Settings, Home or Chat is still a door out of them.
  dropSettings();
  dropHome();
  dropChat();
  dropNotebook();
  dropSprint();
  dropOpsMap();
  dropBoard();
  dropSupport();
  dropHistory();
  dropReview();
  if (terminalsActive) {
    if (at !== undefined) terminals.select(at);
    return;
  }
  terminalsActive = true;
  mainZone().hidden = true;
  el("terminalsScreen").hidden = false;
  deck.beginOverview(); // the deck stands down; the wall owns the panes
  terminals.open(wallProjects(), at);
  void runner.refreshTargets();
  pushRunBar();
  paintNav();
  paintProjects(); // no project row may stay lit while the workspace is the screen
}

/** Home is its own screen: the app's landing, and what every "back to the portfolio" path means.
 *  It takes the glass from the workspace or a project the same way Settings does. */
function showHome(): void {
  dropSettings();
  dropChat();
  dropNotebook();
  dropSprint();
  dropOpsMap();
  dropBoard();
  dropSupport();
  dropHistory();
  dropReview();
  // The workspace comes down properly — the deck takes its panes back before Home takes the glass.
  if (terminalsActive) exitTerminals();
  if (homeActive) return;
  homeActive = true;
  mainZone().hidden = true;
  el("homeScreen").hidden = false;
  // Home's finder is the one project search while Home is up, so the rail's filter steps aside
  // and must not leave the rail narrowed behind it.
  if (projectFilter.value) projectFilter.value = "";
  home.open(homeProjects());
  paintNav();
  paintProjects(); // no project row may stay lit while Home is the screen
}

/** Take Home down without deciding what replaces it — the caller is already on its way
 *  somewhere (a project, a workspace tab, Settings). */
function dropHome(): void {
  if (!homeActive) return;
  home.clear();
  homeActive = false;
  el("homeScreen").hidden = true;
}

/** Open the private Markdown notebook outside every project surface. */
function showNotebook(): void {
  dropSettings();
  dropChat();
  if (terminalsActive) exitTerminals();
  dropHome();
  dropSprint();
  dropOpsMap();
  dropBoard();
  dropSupport();
  dropHistory();
  dropReview();
  if (notebookActive) return;
  notebookActive = true;
  mainZone().hidden = true;
  const screen = el("notebookScreen");
  screen.hidden = false;
  if (!notebook) screen.textContent = "Opening notes…";
  const loading = notebookLoading ?? import("./features/notebook").then(({ mountNotebook }) => {
    notebook = mountNotebook(screen);
    return notebook;
  });
  notebookLoading = loading;
  void loading
    .then((handle) => {
      if (notebookActive) return handle.open();
    })
    .catch((error: unknown) => {
      notebookLoading = null;
      if (notebookActive) {
        screen.replaceChildren(errorNote("Notes could not open.", error, () => { dropNotebook(); showNotebook(); }));
      }
    });
  paintNav();
  paintProjects();
}

function dropNotebook(): void {
  if (!notebookActive) return;
  notebook?.clear();
  notebookActive = false;
  el("notebookScreen").hidden = true;
}

/** Project desk reads release evidence and project memory directly. */
function showSprint(): void {
  dropHistory();
  dropSettings();
  dropChat();
  dropNotebook();
  if (terminalsActive) exitTerminals();
  dropHome();
  dropOpsMap();
  dropBoard();
  if (sprintActive) return;
  sprintActive = true;
  mainZone().hidden = true;
  const screen = el("sprintScreen");
  screen.hidden = false;
  if (!sprint) screen.textContent = "Reading projects…";
  const loading = sprintLoading ?? import("./features/project_desk").then(({ mountProjectDesk }) => {
    sprint = mountProjectDesk(screen, (project) => void select(project));
    return sprint;
  });
  sprintLoading = loading;
  void loading
    .then((handle) => {
      if (sprintActive) return handle.open();
    })
    .catch((error: unknown) => {
      sprintLoading = null;
      if (sprintActive) {
        screen.replaceChildren(errorNote("Project desk could not open.", error, () => { dropSprint(); showSprint(); }));
      }
    });
  paintNav();
  paintProjects();
}

function dropSprint(): void {
  if (!sprintActive) return;
  sprint?.clear();
  sprintActive = false;
  el("sprintScreen").hidden = true;
}

/** The ops tree as a network: what finished lately, what is stuck. See features/ops_map.ts. */
function showOpsMap(): void {
  dropBoard();
  dropHistory();
  dropSettings();
  dropChat();
  dropNotebook();
  dropSprint();
  dropSupport();
  dropReview();
  if (terminalsActive) exitTerminals();
  dropHome();
  if (opsMapActive) return;
  opsMapActive = true;
  mainZone().hidden = true;
  const screen = el("opsMapScreen");
  screen.hidden = false;
  if (!opsMap) screen.textContent = "Reading the ops tree…";
  const loading = opsMapLoading ?? import("./features/ops_map").then(({ mountOpsMap }) => {
    opsMap = mountOpsMap(screen, {
      openProject: (project) => void select(project),
      openFile: (path, line) =>
        void openFullPath(line ? { path, line } : { path }, false, null).catch((error: unknown) => console.warn("[panel] ops map", error)),
      activity: (project) => pulse.activity(project),
    });
    return opsMap;
  });
  opsMapLoading = loading;
  void loading
    .then((handle) => {
      if (opsMapActive) handle.open();
    })
    .catch((error: unknown) => {
      opsMapLoading = null;
      if (opsMapActive) {
        screen.replaceChildren(errorNote("Ops map could not open.", error, () => { dropOpsMap(); showOpsMap(); }));
      }
    });
  paintNav();
  paintProjects();
}

function dropOpsMap(): void {
  if (!opsMapActive) return;
  opsMap?.clear();
  opsMapActive = false;
  el("opsMapScreen").hidden = true;
}

/** Who holds what, what waits on you, and the scouts. Portfolio-wide. See features/board.ts. */
function showBoard(): void {
  if (!board) return;
  dropHistory();
  dropSettings();
  dropChat();
  dropNotebook();
  dropSprint();
  dropSupport();
  dropReview();
  dropOpsMap();
  if (terminalsActive) exitTerminals();
  dropHome();
  if (boardActive) return;
  boardActive = true;
  mainZone().hidden = true;
  board.open();
  paintNav();
  paintProjects();
}

function dropBoard(): void {
  if (!boardActive) return;
  board?.clear();
  boardActive = false;
}

/** The Board and its strip come with the scout extension and leave with it. */
function setupBoard(on: boolean): void {
  el("boardButton").hidden = !on;
  if (!on) {
    dropBoard();
    board?.dispose();
    board = null;
    boardLoading = null;
    return;
  }
  if (board || boardLoading) return;
  const loading = import("./features/board").then(({ mountBoard }) => {
    board = mountBoard(el("boardScreen"), el("boardStrip"), {
      api: {
        scouts: () => moduleGet<ScoutList>("/m/scout/scouts"),
        board: (fresh) => moduleGet<BoardData>(`/m/scout/board${fresh ? "?fresh=1" : ""}`),
        builds: () => moduleGet<BuildList>("/m/scout/builds"),
        run: (id) => modulePost<ScoutRun>("/m/scout/run", { id }),
        prompt: (id) =>
          moduleGet<{ prompt: string }>(`/m/scout/prompt?id=${encodeURIComponent(id)}`).then((answer) => answer.prompt),
        start: (id, session) => modulePost<ScoutRun>("/m/scout/start", { id, session }),
        record: (id, status, note) => modulePost<ScoutRun>("/m/scout/record", { id, status, found: 0, note }),
      },
      openUrl: (url) => void invoke("open_link", { url }).catch((error: unknown) => console.warn("[panel] board", error)),
      launch: launchScout,
      showSession: (id) => {
        showTerminals();
        return terminals.reveal(id);
      },
      isLive: (id) => Boolean(sessionById(id)) && !exited.has(id),
      openBoard: () => showBoard(),
    });
    return board;
  });
  boardLoading = loading;
  loading.catch((error: unknown) => {
    boardLoading = null;
    console.warn("[panel] board", error);
  });
}

/**
 * A scout runs where you can see it: a terminal on the main folder, its prompt typed once the
 * agent is up. It never takes the screen you are on; the strip says it is running.
 */
async function launchScout(
  scout: Scout,
  prompt: string,
  started: (session: string) => Promise<unknown>,
): Promise<string | null> {
  const session = await openSessionFor(MAIN_ID, (scout.agent ?? "claude") as SessionKind);
  if (!session) return null;
  // Recorded before the prompt, so a quick agent's own "done" can never be overwritten by it.
  await started(session.id);
  // Typed before the agent switches on bracketed paste, a prompt arrives as raw keys.
  const until = Date.now() + 20_000;
  while (!deck.pasteReady(session.id) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 250));
  if (scout.model && scout.agent === "claude") {
    await deck.sendPrompt(session.id, `/model ${scout.model}`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return (await deck.sendPrompt(session.id, prompt)) ? session.id : null;
}

/** Support is a screen like Home: one queue for the whole portfolio. Every app publishes its own
 *  support form, but the person reading them is one person, so this is one list and not a tab
 *  that appears eleven times. */
function showSupport(): void {
  dropHistory();
  dropReview();
  dropSettings();
  dropChat();
  dropNotebook();
  dropSprint();
  dropOpsMap();
  dropBoard();
  if (terminalsActive) exitTerminals();
  dropHome();
  if (supportActive) return;
  supportActive = true;
  mainZone().hidden = true;
  const screen = el("supportScreen");
  screen.hidden = false;
  if (!support) screen.textContent = "Opening support…";
  const loading = supportLoading ?? import("./features/support").then(({ mountSupport }) => {
    support = mountSupport(screen, { onUnread: paintSupportBadge });
    return support;
  });
  supportLoading = loading;
  void loading
    .then((handle) => {
      if (supportActive) handle.open();
    })
    .catch((error: unknown) => {
      supportLoading = null;
      if (supportActive) {
        screen.replaceChildren(errorNote("Support could not open.", error, () => { dropSupport(); showSupport(); }));
      }
    });
  paintNav();
  paintProjects();
}

function dropSupport(): void {
  if (!supportActive) return;
  support?.clear();
  supportActive = false;
  el("supportScreen").hidden = true;
}

/** Review: what the agents made, across every project. Mounted at boot so the badge counts files
 *  that land while you are elsewhere. From a project, it goes straight into that project's work. */
function showReview(projectId?: string): void {
  if (projectId && review.openProject(projectId)) return;
  dropSupport();
  dropHistory();
  dropSettings();
  dropChat();
  dropNotebook();
  dropSprint();
  dropOpsMap();
  dropBoard();
  if (terminalsActive) exitTerminals();
  dropHome();
  if (reviewActive) return;
  reviewActive = true;
  mainZone().hidden = true;
  el("reviewScreen").hidden = false;
  review.open();
  paintNav();
  paintProjects();
}

function dropReview(): void {
  if (!reviewActive) return;
  review.clear();
  reviewActive = false;
  el("reviewScreen").hidden = true;
}

/** History: every agent session across the portfolio, reported or not. A screen like Support —
 *  one list for one person — opened from its row, from Home, or from an appgeapanel:// link. */
function showHistory(focus?: { query?: string; session?: string }): void {
  dropSupport();
  dropReview();
  dropSettings();
  dropChat();
  dropNotebook();
  dropSprint();
  dropOpsMap();
  dropBoard();
  if (terminalsActive) exitTerminals();
  dropHome();
  historyActive = true;
  mainZone().hidden = true;
  history.open(focus);
  paintNav();
  paintProjects();
}

function dropHistory(): void {
  if (!historyActive) return;
  historyActive = false;
  history.clear();
}

function historyProjectName(id: string): string {
  return state(id)?.project.name ?? id;
}

/** The nav badge and Home's strip: sessions that ended since you last opened History. One read
 *  of the transcripts, which after the first is only the bytes added since. */
function refreshHistorySignals(): void {
  void fetchHistory().then((data) => {
    const fresh = sinceSeen(data);
    const badge = el("historyBadge");
    badge.textContent = fresh.length > 99 ? "99+" : String(fresh.length);
    badge.hidden = fresh.length === 0;
    home.away(fresh.map((session) => ({
      id: session.id,
      agent: session.agent,
      projectName: historyProjectName(session.project),
      title: session.title,
      lastText: session.lastText,
      at: Date.parse(session.endedAt),
    })));
  }).catch((error: unknown) => console.warn("[panel] history unavailable", error));
}

/** Resume from History. Same seat bookkeeping as any new terminal; Rust refuses a conversation a
 *  live terminal already holds. */
async function resumeConversation(session: HistorySession): Promise<string> {
  // History only offers Resume for agents Panel can run, so the agent is an engine kind.
  const started = await openSessionFor(session.project, session.agent as SessionKind, session.cwd, session.id);
  if (!started) throw new Error(lastStartError || "The conversation could not resume.");
  jumpToSession(started.project, started.id);
  return started.id;
}

/** A file History lists is relative to the folder the session ran in, which may sit below the
 *  project root. Work wants it relative to the root. */
function openHistoryFile(projectId: string, cwd: string, path: string): void {
  const root = state(projectId)?.project.path;
  const absolute = path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) ? path : `${cwd}/${path}`;
  const relative = root && absolute.startsWith(`${root}/`) ? absolute.slice(root.length + 1) : absolute;
  openPlace(projectId, { to: "work", path: relative });
}

/**
 * A full path a terminal printed or a link named. Inside a project it opens in Panel: what was
 * made in Review, any other file in Work. A folder, a path outside every project, or a reveal
 * goes to the Mac. `near` is the project the path was printed in, which wins a tie. A link from
 * outside Panel never opens a file in its app: any web page can hand the OS one. It only shows it.
 */
async function openFullPath(target: FileTarget, reveal: boolean, near: string | null, outside = false): Promise<void> {
  const found = await invoke<{ path: string; folder: boolean }>("locate_path", { path: target.path });
  const owners = reveal || found.folder
    ? []
    : portfolioStates().filter((here) => found.path.startsWith(`${here.project.path}/`));
  const owner = owners.sort((a, b) =>
    b.project.path.length - a.project.path.length || Number(b.project.id === near) - Number(a.project.id === near))[0];
  if (!owner) {
    await invoke("open_path", { path: found.path, revealOnly: reveal || (outside && !found.folder) });
    return;
  }
  const relative = found.path.slice(owner.project.path.length + 1);
  if (!(await review.openFiles(owner.project.id, [relative], relative))) {
    openPlace(owner.project.id, target.line ? { to: "work", path: relative, line: target.line } : { to: "work", path: relative });
  }
}

/** An appgeapanel:// link, from outside Panel. Unknown projects and malformed links do nothing. */
function followAppLink(url: string): void {
  const link = parseAppLink(url);
  if (!link) {
    console.warn("[panel] ignored link", url);
    return;
  }
  switch (link.to) {
    case "home":
      showHome();
      return;
    case "review":
      showReview();
      return;
    case "manager":
      chat.showCpo();
      return;
    case "history":
      showHistory({ query: link.query, session: link.session });
      return;
    case "open":
      void openFullPath(link, false, null, true).catch((error: unknown) => console.warn("[panel] link", error));
      return;
    case "project":
      // The Manager and the main folder have no project page for a link to open.
      if (!state(link.project) || offPortfolio(link.project)) return;
      if (link.place) openPlace(link.project, link.place);
      else void select(link.project);
  }
}

function takeAppLinks(): void {
  void invoke<string[]>("take_links").then((urls) => urls.forEach(followAppLink)).catch(() => undefined);
}

/** The count of messages nobody has read yet. Same badge language as Inbox. */
function paintSupportBadge(count: number): void {
  const badge = el("supportBadge");
  badge.textContent = count > 99 ? "99+" : String(count);
  badge.hidden = count === 0;
}

/**
 * Chat takes the glass the way Settings does, and hands it back on the way out.
 *
 * It was a column beside the work, on the reasoning that the conversation is the accessory. The
 * shape was the problem: what arrives here is screenshots, replays and a live agent terminal, and
 * 360px turned all three into a preview of themselves. Esc, ⌘W and the row itself all give the
 * previous screen back, so it still costs one key to leave.
 *
 * Nothing here calls chat.show() — it is the other way round. Chat owns its own visibility and
 * tells the shell through the `visibility` callback, so the class, the badge and the screen can
 * never disagree about whether it is up.
 */
function showChat(): void {
  if (chatActive) return;
  chatFromWorkspace = terminalsActive;
  chatFromHome = homeActive;
  chatFromNotebook = notebookActive;
  chatFromSprint = sprintActive;
  chatFromOpsMap = opsMapActive;
  dropSettings();
  // The workspace comes down properly — the deck takes its panes back before Chat takes the glass.
  if (terminalsActive) exitTerminals();
  dropHome();
  dropNotebook();
  dropSprint();
  dropOpsMap();
  dropBoard();
  dropSupport();
  dropHistory();
  dropReview();
  chatActive = true;
  mainZone().hidden = true;
  paintNav();
}

/** Take Chat down without deciding what replaces it — for callers already on their way somewhere.
 *  Clearing the flag first is what stops chat.hide() from restoring a screen the caller is about
 *  to replace anyway. */
function dropChat(): void {
  if (!chatActive) return;
  chatActive = false;
  chat.hide();
}

/** Leave Chat for the screen it interrupted. */
function exitChat(): void {
  if (!chatActive) return;
  chatActive = false;
  if (chatFromWorkspace) {
    showTerminals();
  } else if (chatFromHome) {
    showHome();
  } else if (chatFromNotebook) {
    showNotebook();
  } else if (chatFromSprint) {
    showSprint();
  } else if (chatFromOpsMap) {
    showOpsMap();
  } else {
    mainZone().hidden = false;
  }
  paintNav();
}

/** Leaving takes the whole workspace down — including the pinned tabs, whose elements
 *  terminals.clear() hands back to #runScreen on the way out. */
function exitTerminals(): void {
  if (!terminalsActive) return;
  terminals.clear();
  deck.reclaimAll();
  terminalsActive = false;
  runnerActive = false;
  el("terminalsScreen").hidden = true;
  mainZone().hidden = false;
  paintNav();
  paintProjects();
}

function runnerProjects(): RunnerProject[] {
  return portfolioStates().filter((here) => here.project.role === "leaf").map((here) => ({
    id: here.project.id,
    name: here.project.name,
    exists: here.project.exists,
    sessions: here.sessions,
  }));
}

/** True while some screen other than a project has the glass. */
const offProject = (): boolean =>
  terminalsActive ||
  homeActive ||
  settingsActive ||
  chatActive ||
  notebookActive ||
  sprintActive ||
  opsMapActive ||
  boardActive ||
  supportActive ||
  reviewActive ||
  historyActive;

/** Navigation and run actions share the project selected on the visible surface. */
function focusedProjectId(): string | null {
  return (runnerActive ? runner.focusedProject() : null)
    ?? (terminalsActive ? terminals.focusedProject() : null)
    ?? active;
}

/** ⌘J — the door between the wall and a project, both ways. Leaving the wall lands on the
 *  focused terminal's project: on the wall that is the only honest "the project I am on". */
function toggleWall(): void {
  if (!terminalsActive) {
    showTerminals(TAB_WALL);
    return;
  }
  leaveWorkspace();
}

/** ⌘K — Runs from anywhere. Already on Runs, it is the way back, the same as ⌘J. */
function toggleRuns(): void {
  if (!terminalsActive || terminals.pinnedAt() !== TAB_RUNS) {
    showTerminals(TAB_RUNS);
    return;
  }
  leaveWorkspace();
}

/** Back to a project: the focused terminal's, else the one you were on, else out. */
function leaveWorkspace(): void {
  const id = focusedProjectId();
  if (id) void select(id);
  else exitTerminals();
}

/** ⌘⇧E / ⌘⇧G / ⌘⇧D — one module of the project you are looking at, from anywhere. From the
 *  wall "looking at" is the focused terminal's project, the same answer ⌘R gives. */
async function goSection(tab: Tab): Promise<void> {
  const id = focusedProjectId();
  if (!id) return;
  if (id !== active || offProject()) {
    await select(id, tab);
  } else {
    await setTab(tab);
  }
}

/** ⌘⇧[ / ⌘⇧] on a project — walk the module rail, wrapping, the way the same chords walk the
 *  strip on the wall. Hidden modules are not rungs. */
function stepRail(delta: number): void {
  const here = active ? state(active) : undefined;
  if (!here) return;
  const rungs = TABS.filter((entry) => tabEnabled(here, entry.tab) && !el(entry.button).hidden);
  if (!rungs.length) return;
  const at = Math.max(0, rungs.findIndex((entry) => entry.tab === here.tab));
  void setTab(rungs[(((at + delta) % rungs.length) + rungs.length) % rungs.length].tab);
}

/** ⌘1…⌘9 on a project — Work's file slots. Work is brought up only when the slot has a file.
 *  False leaves the chord free for its app-level fallback. */
async function jumpToSlot(slot: number): Promise<boolean> {
  const id = active;
  if (!id) return false;
  if (state(id)?.tab !== "files") return false;
  const files = await projectTools.ensureFiles();
  if (active !== id) return false;
  files.setProject(id, state(id)!.project.path); // a no-op once Work has been up on this project
  if (!files.activateSlot(slot)) return false;
  if (state(id)?.tab !== "files") void setTab("files");
  return true;
}

/** The workspace's build bar reads run state from the runner and names from the sidebar — the
 *  runner only knows the projects it was last handed, and it is not always open. */
function pushRunBar(): void {
  if (!terminalsActive) return;
  terminals.setRuns(
    runner.liveRuns().map((run) => ({
      ...run,
      name: state(run.project)?.project.name ?? run.name,
    })),
  );
}

/**
 * ⌘R — run the app you are looking at, and if it is already up, RE-RUN it.
 * ⌘⇧R — a fresh run of that app, always: new build, app deleted off a simulator first.
 *
 * "Looking at" is the focused terminal's project while the workspace is up, because on the wall
 * that is the only honest answer: the tabs hold terminals from every project at once. Inside a
 * project it is that project.
 *
 * A re-run is a hot restart when the run has one — seconds, same process, same device. Where
 * none is on offer the runner falls through to a new build that keeps the app's data, so ⌘R
 * never does nothing. Either build replaces the run in place: same target, same device, new build. Rust reaps the old
 * PTY and hands its lease back before re-taking the same address, so nothing moves.
 *
 * ⌘. is still the only way to stop without starting, and ⌘⌥R is still the only way to get a
 * second copy. Neither is reachable by pressing these twice.
 */
function runFocusedApp(fresh: boolean): void {
  const projectId = focusedProjectId();
  if (!projectId) return;
  if (!state(projectId)) return;
  void runner.ensureTargets().then(() => {
    if (!fresh) {
      void runner.rerunProject(projectId);
      return;
    }
    const live = !!runner.projectRun(projectId)?.live;
    void runner.startProject(projectId, false, false, live, true);
  });
}

/**
 * ⌘⌥R — choose where a SECOND copy should run.
 *
 * Deliberately its own chord and not a variant of ⌘R: it costs a device, a build and a gigabyte,
 * so nobody should reach it by mistake. Runs opens with the app highlighted.
 */
function runExtraInstance(): void {
  const projectId = focusedProjectId();
  if (!projectId || !state(projectId)) return;
  void runner.ensureTargets().then(() => {
    showTerminals(TAB_RUNS);
    runner.highlight(projectId);
  });
}

/**
 * ⌘. — stop the run you are looking at, and give its simulator back.
 *
 * The other half of ⌘R, and the reason a device is ever released: stopping the PTY ends
 * `flutter run`, and Rust shuts the simulator down once nothing else is using it. Deliberately a
 * different key from ⌘R — starting and stopping a build are two decisions, not a toggle.
 *
 * Where "you are looking at" runs out, one live run is not ambiguous: if exactly one app is
 * running anywhere, ⌘. means that one. Several, and it declines rather than guessing which
 * afternoon to end.
 */
function stopFocusedApp(): void {
  // On the Runs tab the screen has an answer of its own — the card last touched.
  if (runnerActive && runner.closeActive()) return;
  const projectId = focusedProjectId();
  if (projectId && runner.projectRun(projectId)?.live) {
    void runner.stopProject(projectId);
    return;
  }
  const live = runner.liveRuns();
  if (live.length === 1) void runner.stopProject(live[0].project);
}

/** Every agent waiting on you, longest first: open questions and permission prompts, then
 *  turns that finished out of sight. Same two states as the rail's attention, one per session. */
function waitingSessions(): Session[] {
  const asking = [...askSince.entries()]
    .filter(([id]) => sessionPhase.get(id) === "ask")
    .sort((a, b) => a[1] - b[1])
    .map(([id]) => sessionById(id))
    .filter((session): session is Session => !!session);
  const finished = [...doneUnseen]
    .map((projectId) => reviewAgent(projectId))
    .filter((session): session is Session => !!session && !asking.some((s) => s.id === session.id));
  return [...asking, ...finished];
}

/** ⌘⇧A: the next agent waiting on you. Pressed on one that waits, it moves past it, so repeated
 *  presses walk the whole queue. The wall keeps you on the wall; anywhere else opens the project. */
function goWaiting(): void {
  const queue = waitingSessions();
  if (!queue.length) return;
  const here = terminalsActive
    ? terminals.focusedSession()
    : active && !offProject()
      ? (state(active)?.activeSession ?? null)
      : null;
  const next = queue[(queue.findIndex((session) => session.id === here) + 1) % queue.length];
  if (terminalsActive && terminals.reveal(next.id)) {
    markSeen(next.project);
    return;
  }
  jumpToSession(next.project, next.id);
}

function sessionById(id: string): Session | null {
  for (const here of states.values()) {
    const session = here.sessions.find((candidate) => candidate.id === id);
    if (session) return session;
  }
  return null;
}

function showSkills(sessionId: string | null = null): void {
  const sessions = [...states.values()].flatMap((here) => here.sessions)
    .filter((session) => !exited.has(session.id));
  openSkills({
    session: sessions.find((session) => session.id === sessionId),
    sessions,
    async onRestart(session) {
      const here = state(session.project);
      if (!here || closing.has(session.id)) throw new Error("Session is no longer available.");
      if (working.has(session.id) || await invoke<boolean>("session_busy", { session: session.id })) {
        throw new Error("Wait for this agent to finish before restarting it.");
      }
      if (!await confirmDialog(`Restart ${session.title} with these skill settings?\n\nThis stops only this terminal. Unsent input will be lost. Choose its saved conversation from the agent’s resume picker. Loaded instructions remain in resumed history.`, {
        okLabel: "Restart session", danger: true,
      })) return session;
      closing.add(session.id);
      try {
        const size = deck.proposeSize();
        const next = await invoke<Session>("skills_session_restart", {
          session: session.id, cols: size.cols, rows: size.rows,
        });
        deck.remove(session.id);
        here.sessions = here.sessions.map((candidate) => candidate.id === session.id ? next : candidate);
        exited.delete(session.id);
        working.delete(session.id);
        setPhase(session.id, null);
        here.workBySession.delete(session.id);
        deck.add(next.id, next.terminal_id);
        jumpToSession(next.project, next.id);
        paintProjects();
        return next;
      } finally {
        closing.delete(session.id);
      }
    },
    async onInsert(session, text) {
      const live = sessionById(session.id);
      if (!live || exited.has(session.id)) throw new Error("Session has ended. Select another session.");
      if (working.has(session.id) || await invoke<boolean>("session_busy", { session: session.id })) {
        throw new Error("Wait for the agent to finish before staging a skill request.");
      }
      // One bracketed paste, never Enter or terminal control sequences from a skill file.
      const data = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
      await invoke("write_terminal", {
        terminalId: live.terminal_id,
        data: `\x1b[200~${data}\x1b[201~`,
      });
      jumpToSession(session.project, session.id);
    },
  });
}

function openProjectFromHome(projectId: string, start = false): void {
  void select(projectId).then(() => {
    if (start) void openSession("claude");
  });
}

/** Jump from a wall tile straight into that session, wherever it lives. */
function jumpToSession(projectId: string, sessionId: string): void {
  // Set the destination BEFORE selecting: select() -> showSessions() reads activeSession.
  const here = state(projectId);
  if (here) here.activeSession = sessionId;
  // The manager's home is its pane in Chat, not a project page around the ops tree.
  if (projectId === CPO_ID) {
    chat.showCpo();
    return;
  }
  // The main folder has no project page: its terminals live on the wall.
  if (projectId === MAIN_ID) {
    showTerminals();
    terminals.reveal(sessionId);
    return;
  }
  void select(projectId, "terminals").then(() => {
    if (active === projectId && projectTerminalVisible()) deck.focus();
  });
}

/** The sidebar's Workspace group. Its two rows are doors to tabs of ONE screen, so the lit
 *  state is the group's, not any row's: the whole area is where you are, or Home is, or a project
 *  is. Which tab is up is the tab strip's job to show — saying it twice would read as two places.
 *  Home is a group of one, lit by the same rule, because it is a screen on its own now. */
function paintNav(): void {
  el("homeNav").classList.toggle("is-active", homeActive);
  el("projectsSection").classList.toggle("home-up", homeActive);
  el("workspaceNav").classList.toggle("is-active", terminalsActive);
  // INBOX and DESK hold separate screens, not tabs of one: the box says which group you are in,
  // and only the row you are actually on carries the accent.
  el("chatNav").classList.toggle("is-active", chatActive || supportActive || reviewActive || historyActive);
  el("historyButton").classList.toggle("is-on", historyActive);
  el("reviewButton").classList.toggle("is-on", reviewActive);
  el("planNav").classList.toggle("is-active", notebookActive || sprintActive || opsMapActive || boardActive);
  el("sprintButton").classList.toggle("is-on", sprintActive);
  el("opsMapButton").classList.toggle("is-on", opsMapActive);
  el("boardButton").classList.toggle("is-on", boardActive);
  el("supportButton").classList.toggle("is-on", supportActive);
  el("notebookButton").classList.toggle("is-on", notebookActive);
  // The gear is a door like any other row: lit while its screen is the one on the glass.
  el("settingsButton").classList.toggle("is-active", settingsActive);
}

/** The manager's lane, on its own row: parked on you, finished out of sight, or mid-turn. */
function paintManagerNav(): void {
  const badge = document.getElementById("cpoState");
  const here = state(CPO_ID);
  if (!badge) return;
  const live = managerSession();
  const attention = here ? attentionOf(here) : null;
  const phase = live ? sessionPhase.get(live.id) : undefined;
  const [label, tone, title] =
    attention === "needs"
      ? ["!", "warn", "The manager is waiting on you"]
      : attention === "done"
        ? ["✓", "ok", "The manager finished a turn"]
        : phase === "work"
          ? ["…", "work", "The manager is working"]
          : ["", "", ""];
  badge.hidden = !label;
  badge.textContent = label;
  badge.className = `nav-badge nav-state${tone ? ` t-${tone}` : ""}`;
  badge.title = title;
}

/** Each sidebar destination reflects the section actually being shown. */
function paintChatNav(): void {
  const selected = chat.currentSection();
  // Looking at the manager's pane is looking at the manager: its finished turn has been seen.
  if (selected === "manager") markSeen(CPO_ID);
  paintManagerNav();
  for (const [id, section] of [["chatButton", "reports"], ["cpoButton", "manager"]] as const) {
    const button = el(id);
    const on = selected === section;
    button.classList.toggle("is-on", on);
    button.setAttribute("aria-pressed", String(on));
    if (on) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
}

/** Terminal shortcuts only act on a visible project terminal. */
function projectTerminalVisible(): boolean {
  return !offProject() && !!active && state(active)?.tab === "terminals";
}

/**
 * A working agent writes files in bursts, and each `file_changed` used to trigger a full git
 * refresh — a rewrite touching twenty files paid for twenty `git status` runs, all of them
 * describing a tree that was still being written. Coalesce: the last write in a burst wins.
 */
const pending = new Map<string, number>();
const refreshing = new Map<string, Promise<void>>();
const refreshAgain = new Set<string>();

function refreshSoon(id: string): void {
  window.clearTimeout(pending.get(id));
  pending.set(
    id,
    window.setTimeout(() => {
      pending.delete(id);
      void refreshProject(id);
    }, 350),
  );
}

/**
 * Pull Git state for the Dashboard and Git module status.
 *
 * Agent edits can outpace Git on a large repo. Keep one status process active per project, then
 * run once more if changes arrived while it worked. Parallel copies only compete for the same
 * index and return stale snapshots in a different order.
 */
function refreshProject(id: string): Promise<void> {
  const underway = refreshing.get(id);
  if (underway) {
    refreshAgain.add(id);
    return underway;
  }
  const request = loadProjectGit(id).finally(() => {
    refreshing.delete(id);
    if (refreshAgain.delete(id)) void refreshProject(id);
  });
  refreshing.set(id, request);
  return request;
}

async function loadProjectGit(id: string): Promise<void> {
  const here = state(id);
  if (!here) return;
  try {
    const git = await invoke<GitState>("project_dashboard", { project: id });
    if (active !== id) return;
    dashboard.setProject(here.project, git, here.running);
    el("projectBranch").textContent = git.is_repo
      ? `${git.branch}${git.dirty ? ` · ${git.dirty} changed` : ""}`
      : here.project.path;
    // The Git segment carries a dot when the repo is holding something — uncommitted work, or
    // commits that never left the machine. It is the only status the rail shows without asking.
    el("gitDot").hidden = !git.is_repo || (git.dirty === 0 && git.ahead === 0);
    // The Git tab shows the same dirt as the dashboard. Re-read it on the same coalesced beat.
    if (!offProject() && here.tab === "git") projectTools.git?.refresh();
  } catch (error) {
    console.error("[panel] project refresh failed", { project: id, error });
  }
}

/* ------------------------------------------------------------------ portfolio order
 * The rail is navigation, and navigation that rearranges itself is navigation you cannot learn.
 * Panel used to float running projects to the top and restamp a key on every agent turn, so the
 * row you were aiming at slid out from under the cursor. It doesn't any more:
 *
 *   - the order is the USER'S — manual by default, dragged into place, pinned at the top;
 *   - activity is shown IN PLACE (the dot) and summed by the ⏻ live chip, which filters on demand
 *     instead of reordering;
 *   - the other orders (recent / A–Z) exist, but only because you asked for them by name, and even
 *     then the list freezes while the pointer is inside it — nothing moves under your hand.
 */
type SortMode = "lanes" | "manual" | "recent" | "name";
const SORT_LABEL: Record<SortMode, string> = { lanes: "Lanes", manual: "Manual", recent: "Recent", name: "A–Z" };
const SORT_HINT: Record<SortMode, string> = {
  lanes: "Order: lanes — grouped by what each project needs from you. Click for your manual order",
  manual: "Order: manual — drag rows to arrange, click to sort by recent",
  recent: "Order: most recently worked on — click to sort A–Z",
  name: "Order: alphabetical — click to go back to lanes",
};

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

let sortMode: SortMode = ((): SortMode => {
  const saved = localStorage.getItem("panel-project-sort");
  return saved === "manual" || saved === "recent" || saved === "name" ? saved : "lanes";
})();
/* ------------------------------------------------------------------ the short rail
 * A portfolio of two dozen apps is a fact, not a menu. Painting all of it every second of the day
 * made the rail a wall you had to read, and the answer to "where was I" was buried in the middle
 * of it. So the rail shows the dozen you last WORKED in (sessions and agent turns — not clicks),
 * and the rest is one button away. Expanded, it is the old full list with its order, drag and pins
 * intact; a filter or the live chip opens it on its own, because a search that hides matches lies.
 */
const RECENT_ROWS = 12;
let showAllProjects = localStorage.getItem("panel-project-showall") === "1";

/** The user's own order, by project id. Anything not in it yet lands at the end, in config order. */
let manualOrder: string[] = readStored<string[]>("panel-project-order", []);
const pinned = new Set<string>(readStored<string[]>("panel-project-pins", []));
/** The live chip's state: show only projects with a running agent. Never sticky across sessions. */
let liveOnly = false;
/** Lanes fold the Quiet lane until you open it. The choice sticks. */
let quietOpen = localStorage.getItem("panel-rail-quiet") === "1";
/** Folded platform rows: guest id → host id, and host id → every member, host first. */
const hostOf = new Map<string, string>();
let membersOf = new Map<string, string[]>();
/** Each project's newest agent report, from the chat archive. */
const lastReport = new Map<string, { id: string; title: string; at: number }>();
/** Unseen review batches per project. */
let reviewCounts = new Map<string, number>();
/** The ids in the order last painted. Used to hold the list still while the pointer is inside. */
let paintedOrder: string[] = [];
let listHot = false;
let dragging = false;
let repaintQueued = false;

function saveOrder(): void {
  manualOrder = manualOrder.filter((id) => states.has(id));
  localStorage.setItem("panel-project-order", JSON.stringify(manualOrder));
  localStorage.setItem("panel-project-pins", JSON.stringify([...pinned].filter((id) => states.has(id))));
  localStorage.setItem("panel-project-sort", sortMode);
}

/** True while the rail is showing the short list. A filter, the live chip, or a portfolio small
 *  enough to fit anyway all mean there is nothing to collapse. */
function railCollapsed(): boolean {
  return (
    sortMode !== "lanes" &&
    !showAllProjects &&
    !liveOnly &&
    !projectFilter.value.trim() &&
    states.size > RECENT_ROWS
  );
}

/** The rule the list actually obeys right now. Collapsed, it is always recency — the short list
 *  IS "recent", and honouring A–Z there would give you five apps beginning with A. */
function activeSort(): SortMode {
  return railCollapsed() ? "recent" : sortMode;
}

/** Pinned first, then whichever rule the user picked. Ties always fall back to the manual order,
 *  so even "recent" never shuffles two projects that were last touched at the same moment. */
function orderProjects(): ProjectState[] {
  const mode = activeSort();
  const all = portfolioStates();
  for (const here of all) if (!manualOrder.includes(here.project.id)) manualOrder.push(here.project.id);
  const children = (id: string): ProjectState[] =>
    all.filter((candidate) => candidate.project.parent_id === id);
  const rawSlot = (here: ProjectState): number => manualOrder.indexOf(here.project.id);
  const slot = (here: ProjectState): number => {
    const own = rawSlot(here);
    if (here.project.role !== "collection") return own;
    return Math.min(own, ...children(here.project.id).map(rawSlot));
  };
  const recent = (here: ProjectState): number =>
    here.project.role === "collection"
      ? Math.max(here.lastActive, ...children(here.project.id).map((child) => child.lastActive))
      : here.lastActive;
  const isPinned = (here: ProjectState): boolean =>
    pinned.has(here.project.id) ||
    (here.project.role === "collection" && children(here.project.id).some((child) => pinned.has(child.project.id)));
  // Frozen: the pointer is in the list (or a drag is live) and the rule is one that can move rows.
  // Keep exactly what is on screen; the new order lands the moment the pointer leaves.
  if ((listHot || dragging) && (mode === "recent" || mode === "lanes") && paintedOrder.length) {
    const held = (here: ProjectState): number => {
      const at = paintedOrder.indexOf(here.project.id);
      return at === -1 ? paintedOrder.length + slot(here) : at;
    };
    return all.sort((a, b) => held(a) - held(b));
  }
  const sorted = all.sort(
    (a, b) =>
      Number(isPinned(b)) - Number(isPinned(a)) ||
      (mode === "name"
        ? a.project.name.localeCompare(b.project.name)
        : mode === "recent" || mode === "lanes"
          ? recent(b) - recent(a) || slot(a) - slot(b)
          : slot(a) - slot(b)),
  );
  const known = new Set(sorted.map((here) => here.project.id));
  const emitted = new Set<string>();
  const nested: ProjectState[] = [];
  const append = (here: ProjectState): void => {
    if (emitted.has(here.project.id)) return;
    emitted.add(here.project.id);
    nested.push(here);
    for (const child of sorted) {
      if (child.project.parent_id === here.project.id) append(child);
    }
  };
  for (const here of sorted) {
    if (!here.project.parent_id || !known.has(here.project.parent_id)) append(here);
  }
  for (const here of sorted) append(here);
  return nested;
}

/*
 * The project row's menu.
 *
 * Groups shipped as an edit to config.json and a relaunch, which is not a feature — it is a note
 * to whoever wrote it. This is the whole of their UI: pick a project's company, or make a company.
 * Everything downstream follows on the next read, so nothing here asks for a restart.
 *
 * Fixed-position and body-owned, because the rail scrolls and clips its own overflow.
 */
const rowMenu = document.createElement("div");
rowMenu.className = "row-menu";
rowMenu.hidden = true;
rowMenu.setAttribute("role", "menu");
document.body.append(rowMenu);
let rowMenuOwner: HTMLElement | null = null;

function closeRowMenu(): void {
  if (rowMenu.hidden) return;
  rowMenu.hidden = true;
  rowMenu.replaceChildren();
  rowMenuOwner?.classList.remove("is-open");
  rowMenuOwner = null;
}

// Capture, so a click meant to dismiss the menu never also lands on the row underneath it.
addEventListener(
  "pointerdown",
  (event) => {
    if (!rowMenu.hidden && !rowMenu.contains(event.target as Node)) closeRowMenu();
  },
  true,
);
addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeRowMenu();
});
addEventListener("blur", closeRowMenu);
addEventListener("resize", closeRowMenu);

/**
 * Write the new company and let the rail and the strip catch up.
 *
 * Optimistic: the row jumps to its new section on this frame and jumps back if the write fails.
 * A disk write is not something a human should watch a list wait for.
 */
async function fileUnder(here: ProjectState, group: string): Promise<void> {
  closeRowMenu();
  const branch = here.project.parent_id ? state(here.project.parent_id) ?? here : here;
  const affected = [
    branch,
    ...[...states.values()].filter(
      (candidate) =>
        branch.project.role === "collection" && candidate.project.parent_id === branch.project.id,
    ),
  ];
  const was = new Map(affected.map((candidate) => [candidate.project.id, candidate.project.group]));
  if (affected.every((candidate) => candidate.project.group === group)) return;
  const settle = (): void => {
    paintProjects();
    for (const candidate of affected) {
      if (candidate.project.role === "leaf") {
        terminals.refile(wallProjects(), candidate.project.id);
      }
    }
  };
  for (const candidate of affected) candidate.project.group = group;
  settle();
  try {
    await invoke("set_project_group", { project: branch.project.id, group });
  } catch (error) {
    for (const candidate of affected) {
      candidate.project.group = was.get(candidate.project.id) ?? "";
    }
    settle();
    await alertDialog(`“${here.project.name}” could not be filed.\n\n${String(error)}`);
  }
}

async function makeGroup(here: ProjectState): Promise<void> {
  closeRowMenu();
  const name = (await promptDialog("Name the new group", ""))?.trim();
  if (!name) return;
  try {
    groups = await invoke<Group[]>("add_group", { name });
  } catch (error) {
    await alertDialog(`That group could not be made.\n\n${String(error)}`);
    return;
  }
  // The project that opened the menu goes straight in. Making a group and then having to file
  // something into it is two steps for one intention.
  const made = groups[groups.length - 1];
  if (made) await fileUnder(here, made.id);
}

function openRowMenu(here: ProjectState, at: { x: number; y: number }): void {
  closeRowMenu();
  const item = (label: string, on: boolean, run: () => void): HTMLButtonElement => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "row-menu-item";
    button.setAttribute("role", "menuitem");
    button.classList.toggle("is-on", on);
    button.innerHTML = `<i>${on ? "✓" : ""}</i><span></span>`;
    button.querySelector("span")!.textContent = label;
    button.addEventListener("click", run);
    return button;
  };
  const label = document.createElement("div");
  label.className = "row-menu-label";
  label.textContent = "Group";
  const nodes: HTMLElement[] = [label];
  for (const group of groups) {
    nodes.push(item(group.name, here.project.group === group.id, () => void fileUnder(here, group.id)));
  }
  nodes.push(item("Ungrouped", !here.project.group, () => void fileUnder(here, "")));
  const sep = document.createElement("div");
  sep.className = "row-menu-sep";
  nodes.push(sep);
  const fresh = item("New group…", false, () => void makeGroup(here));
  fresh.classList.add("is-new");
  nodes.push(fresh);
  rowMenu.replaceChildren(...nodes);

  // Place it, then pull it back inside the window. Measuring needs it visible, so it is shown
  // first at the raw point and corrected before the frame paints.
  rowMenu.hidden = false;
  rowMenu.style.left = "0px";
  rowMenu.style.top = "0px";
  const box = rowMenu.getBoundingClientRect();
  const left = Math.max(6, Math.min(at.x, innerWidth - box.width - 6));
  const top = Math.max(6, Math.min(at.y, innerHeight - box.height - 6));
  rowMenu.style.left = `${left}px`;
  rowMenu.style.top = `${top}px`;
  rowMenu.querySelector<HTMLButtonElement>(".row-menu-item")?.focus();
}

/* ------------------------------------------------------------------ the rail's facts
 * Everything a row says beyond its name comes from here: the pulse (git, commits, portfolio
 * status, analytics), the attention state, the review queue and the last report. The rules live
 * in features/rail.ts; these functions only gather the facts for them.
 */

/** The rows a platform pair folds into one: the host first. A plain project is its own list. */
function membersFor(here: ProjectState): ProjectState[] {
  const ids = membersOf.get(here.project.id) ?? [here.project.id];
  return ids.map((id) => state(id)).filter((member): member is ProjectState => Boolean(member));
}

function unitAttention(members: ProjectState[]): "needs" | "done" | null {
  const all = members.map(attentionOf);
  return all.includes("needs") ? "needs" : all.includes("done") ? "done" : null;
}

/** Pinned, or a collection or a folded row with a pinned member. */
function pinnedUnit(here: ProjectState): boolean {
  if (membersFor(here).some((member) => pinned.has(member.project.id))) return true;
  return (
    here.project.role === "collection" &&
    [...states.values()].some((child) => child.project.parent_id === here.project.id && pinned.has(child.project.id))
  );
}

/** Newest sign of life: a visit, an agent turn, a commit, or a report. */
function touchedAt(here: ProjectState): number {
  const commit = (pulse.peekActivity(here.project.id)?.last_commit ?? 0) * 1000;
  return Math.max(here.lastActive, commit, lastReport.get(here.project.id)?.at ?? 0);
}

function factsOf(here: ProjectState): RowFacts {
  return {
    exists: here.project.exists,
    attention: attentionOf(here),
    running: here.running,
    reviews: reviewCounts.get(here.project.id) ?? 0,
    standing: pulse.standing(here.project.id),
    verdict: pulse.verdict(here.project.id),
    touched: touchedAt(here),
  };
}

/** A collection sits where its busiest child does, a folded row where its busiest member does. */
function unitLane(here: ProjectState): Lane {
  const members =
    here.project.role === "collection"
      ? [...states.values()].filter((child) => child.project.parent_id === here.project.id)
      : membersFor(here);
  return members.map((member) => laneOf(factsOf(member))).reduce(urgent, "quiet" as Lane);
}

/** The member whose state the row's line should speak for: parked, finished, working, else host. */
function leadMember(members: ProjectState[]): ProjectState {
  return (
    members.find((member) => attentionOf(member) === "needs") ??
    members.find((member) => attentionOf(member) === "done") ??
    members.find((member) => member.running) ??
    members[0]
  );
}

function lineInput(here: ProjectState): Parameters<typeof rowLine>[0] {
  const id = here.project.id;
  const git = pulse.peekGit(id);
  const report = lastReport.get(id) ?? null;
  return {
    ...factsOf(here),
    ask: askTray.headline(id),
    status: here.status,
    move: nextMove({ exists: here.project.exists, work: 0, running: false, git }).short,
    report,
  };
}

/** A lane's header. Quiet's is a button: it folds the lane away and brings it back. */
function laneHead(section: string, count: number): HTMLElement {
  const lane = LANES.find((entry) => entry.id === section);
  const label = section === "pinned" ? "Pinned" : lane?.label ?? section;
  if (section !== "quiet") {
    const head = document.createElement("div");
    head.className = "project-group lane-head";
    head.dataset.lane = section;
    head.title = lane?.hint ?? "Your pins, in your order";
    head.innerHTML = `<span></span><i></i>`;
    head.querySelector("span")!.textContent = label;
    head.querySelector("i")!.textContent = String(count);
    return head;
  }
  const head = document.createElement("button");
  head.type = "button";
  head.className = "project-group lane-head is-toggle";
  head.dataset.lane = section;
  head.setAttribute("aria-expanded", String(quietOpen));
  head.title = quietOpen ? "Fold the quiet projects away" : (lane?.hint ?? "");
  head.innerHTML = `<span></span><i></i><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>`;
  head.querySelector("span")!.textContent = label;
  head.querySelector("i")!.textContent = String(count);
  head.addEventListener("click", () => {
    quietOpen = !quietOpen;
    localStorage.setItem("panel-rail-quiet", quietOpen ? "1" : "0");
    listHot = false;
    paintProjects();
  });
  return head;
}

/** One pill per platform, each with its own state dot. A click opens that member. */
function platformPills(members: ProjectState[], labels: string[]): HTMLElement {
  const pills = document.createElement("span");
  pills.className = "project-pills";
  members.forEach((member, at) => {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.tabIndex = -1;
    pill.className = "project-pill";
    const attention = attentionOf(member);
    pill.classList.toggle("is-asking", attention === "needs");
    pill.classList.toggle("is-done", attention === "done");
    pill.classList.toggle("is-running", member.running);
    pill.classList.toggle("is-on", member.project.id === active && !terminalsActive);
    pill.innerHTML = `<i></i><span></span>`;
    pill.querySelector("span")!.textContent = labels[at] || member.project.name;
    pill.title = `Open ${member.project.name}`;
    pill.addEventListener("click", (event) => {
      event.stopPropagation();
      void select(member.project.id);
    });
    pills.append(pill);
  });
  return pills;
}

/** The marks around the name: the corner badge, the git chip, the activity bars, the quick button. */
function decorateRow(
  row: HTMLElement,
  here: ProjectState,
  members: ProjectState[],
  attention: "needs" | "done" | null,
): void {
  if (here.project.role !== "leaf") return;
  const lead = leadMember(members);
  const id = lead.project.id;
  const meta = row.querySelector<HTMLElement>(".project-meta")!;
  const touched = Math.max(...members.map(touchedAt));
  row.classList.toggle("is-stale", touched > 0 && Date.now() - touched > STALE_AFTER && !attention);

  // One corner badge, the loudest signal wins. The title lists them all.
  const reviews = members.reduce((sum, member) => sum + (reviewCounts.get(member.project.id) ?? 0), 0);
  const verdict = members.map((member) => pulse.verdict(member.project.id)).find((v) => v?.risk) ?? null;
  const signals: string[] = [];
  if (!here.project.exists) signals.push("Folder missing");
  if (verdict) signals.push(`Analytics: ${verdict.label || verdict.call}`);
  if (reviews) signals.push(`${reviews} waiting for review`);
  if (signals.length) {
    const badge = document.createElement("i");
    badge.className = `project-badge ${!here.project.exists || verdict ? "t-risk" : "t-review"}`;
    badge.textContent = !here.project.exists ? "!" : verdict ? "↓" : String(Math.min(reviews, 9));
    badge.title = signals.join(" · ");
    row.querySelector(".project-icon")!.append(badge);
  }

  if (attention) {
    const quick = document.createElement("button");
    quick.type = "button";
    quick.className = `project-quick t-${attention === "needs" ? "warn" : "ok"}`;
    quick.textContent = attention === "needs" ? "Answer" : "Diff";
    quick.title =
      attention === "needs"
        ? "See what the agent is asking, and answer it here"
        : "Open the files this turn changed";
    quick.addEventListener("click", (event) => {
      event.stopPropagation();
      if (attention === "needs") railCard.pin(row, () => cardModel(lead));
      else void select(id, "files");
    });
    meta.append(quick);
  } else {
    const chip = gitChip(pulse.peekGit(id));
    if (chip) {
      const node = document.createElement("span");
      node.className = `project-chip${chip.warn ? " is-warn" : ""}`;
      node.textContent = chip.text;
      node.title = chip.title;
      meta.append(node);
    }
  }
  const spark = sparkSvg(pulse.peekActivity(id));
  if (spark) meta.insertAdjacentHTML("beforeend", spark);
}

/** The first row a filter found answers Enter, with the action word if one was typed. */
function markTarget(action: RowAction | null): void {
  const row = [...projectList.querySelectorAll<HTMLElement>(".project-row")].find(
    (candidate) => !candidate.classList.contains("is-collection"),
  );
  if (!row) return;
  row.classList.add("is-target");
  const hint = document.createElement("kbd");
  hint.className = "project-enter";
  hint.textContent = `↵ ${action ?? "open"}`;
  row.querySelector(".project-meta")?.prepend(hint);
}

/** Open a project and do one thing there. The filter's action words and the card share this. */
async function runRowAction(id: string, action: RowAction | null): Promise<void> {
  switch (action) {
    case "claude":
    case "shell": {
      await select(id);
      const live = action === "claude" ? reviewAgent(id) : null;
      if (live) jumpToSession(id, live.id);
      else await openSession(action);
      return;
    }
    case "run":
      await select(id);
      void runner.startProject(id, false);
      return;
    case "release":
      await select(id, "release");
      return;
    case "git":
      await select(id, "git");
      return;
    case "work":
      await select(id, "files");
      return;
    case "review":
      showReview(id);
      return;
    default:
      await select(id);
  }
}

/** The card for one project: everything the row has no room for, plus the doors. */
function cardModel(here: ProjectState): CardModel {
  const id = here.project.id;
  const facts = factsOf(here);
  const lane = laneOf(facts);
  const laneEntry = LANES.find((entry) => entry.id === lane)!;
  const git = pulse.peekGit(id);
  const chip = gitChip(git);
  const activity = pulse.peekActivity(id);
  const standing = facts.standing;
  const move = nextMove({ exists: here.project.exists, work: 0, running: here.running, git });
  const report = lastReport.get(id);
  const live = reviewAgent(id);

  let ask: CardModel["ask"] = null;
  const parked = here.sessions.find((session) => sessionPhase.get(session.id) === "ask");
  if (parked) {
    const open: CardAction = { label: "Open terminal", run: () => jumpToSession(id, parked.id) };
    if (askTray.sessionAsking(parked.id)) {
      ask = { headline: askTray.headline(id) ?? "The agent asked a question", screen: [], actions: [{ ...open, label: "Answer", primary: true }] };
    } else {
      // A terminal permission prompt. Enter takes the highlighted choice and Esc refuses, the
      // same keys the terminal itself answers to. Only Claude's prompt is known to work that way.
      const answerable = parked.kind === "claude";
      const send = (data: string) => async () => {
        await invoke("write_terminal", { terminalId: parked.terminal_id, data });
        endPermissionWait(id, parked.id);
        paintProjectsSoon();
      };
      ask = {
        headline: "Permission prompt",
        screen: deck.tail(parked.id, 14),
        actions: answerable
          ? [
              { label: "Allow", run: () => void send("\r")(), primary: true },
              { label: "Deny", run: () => void send("\x1b")(), danger: true },
              open,
            ]
          : [open],
      };
    }
  }

  const actions: CardAction[] = [];
  if (attentionOf(here) === "done") actions.push({ label: "Open diff", run: () => void select(id, "files"), primary: true });
  if (facts.reviews) actions.push({ label: `Review ${facts.reviews}`, run: () => showReview(id), primary: !actions.length });
  actions.push(
    live
      ? { label: "Open agent", run: () => void runRowAction(id, "claude"), primary: !actions.length }
      : { label: "Start Claude", run: () => void runRowAction(id, "claude"), primary: !actions.length },
  );
  actions.push({ label: "Run app", run: () => void runRowAction(id, "run") });
  if (here.modules.has("release")) actions.push({ label: "Release", run: () => void runRowAction(id, "release") });
  if (move.door === "git") actions.push({ label: "Git", run: () => void runRowAction(id, "git") });

  const commits = activity?.days.reduce((sum, count) => sum + count, 0) ?? 0;
  const last = activity?.last_commit ? `last ${age(activity.last_commit * 1000)} ago` : "no commits";
  const signals: string[] = [];
  const verdict = facts.verdict;
  if (verdict) {
    const trend = verdict.trend === null ? "" : ` · ${Math.round(verdict.trend * 100)}% week on week`;
    signals.push(`${verdict.label || verdict.call} (${verdict.call})${trend}`);
  }
  if (!here.project.exists) signals.push("The folder is missing");

  return {
    name: here.project.name,
    lane: laneEntry.label,
    laneTone: lane === "needs" ? "warn" : lane === "working" ? "live" : lane === "shipping" ? "ok" : "mute",
    status: known(standing?.status),
    notes: standing?.notes ?? "",
    move: move.short || move.door ? { title: move.title, detail: move.detail } : null,
    report: report
      ? { title: report.title, age: age(report.at), open: () => chat.reveal(report.id) }
      : null,
    git: git?.is_repo ? [git.branch, chip?.title || "clean"].filter(Boolean).join(" · ") : "",
    activity: activity ? { spark: sparkSvg(activity), caption: `${commits} commits in 14 days · ${last}` } : null,
    signals,
    ask,
    actions,
  };
}

/** Pins first, in rail order, then every other row as painted. ⌃1…⌃9 walk this list. */
function jumpTargets(): string[] {
  const rows = [...projectList.querySelectorAll<HTMLElement>(".project-row")];
  const ids = (list: HTMLElement[]) => list.map((row) => row.dataset.projectId!).filter(Boolean);
  return [...ids(rows.filter((row) => row.classList.contains("is-pinned"))), ...ids(rows.filter((row) => !row.classList.contains("is-pinned")))];
}

/**
 * Files dropped on a row go to that project's agent: pasted into its prompt, not submitted, so
 * you add the instruction. No agent running starts one first.
 */
async function dropOnProject(id: string, paths: string[]): Promise<void> {
  const here = state(id);
  if (!here || here.project.role !== "leaf" || !paths.length) return;
  let session = reviewAgent(id);
  const fresh = !session;
  if (!session) session = await openSessionFor(id, "claude");
  if (!session) {
    await alertDialog(`Could not start an agent for ${here.project.name}.\n\n${lastStartError}`);
    return;
  }
  await select(id);
  jumpToSession(id, session.id);
  // A brand-new agent draws its prompt after a moment. Typing into it sooner is typing into nothing.
  if (fresh) await new Promise((resolve) => window.setTimeout(resolve, 1500));
  deck.pastePaths(session.id, paths);
}

/** Which project row a physical-pixel window point is over, for a Finder drop. */
function rowAtPoint(x: number, y: number): HTMLElement | null {
  const ratio = window.devicePixelRatio || 1;
  const row = document.elementFromPoint(x / ratio, y / ratio)?.closest<HTMLElement>(".project-row");
  return row && !row.classList.contains("is-collection") ? row : null;
}

function paintRowDrop(row: HTMLElement | null): void {
  for (const candidate of projectList.querySelectorAll(".project-row.is-drop")) {
    if (candidate !== row) candidate.classList.remove("is-drop");
  }
  row?.classList.add("is-drop");
}

/** Display name → project id, any case, for boards that name apps rather than folders. */
function projectNames(): Map<string, string> {
  const names = new Map<string, string>();
  for (const here of portfolioStates()) {
    names.set(here.project.name, here.project.id);
    names.set(here.project.name.toLowerCase(), here.project.id);
  }
  return names;
}

function paintProjects(): void {
  // A direct paint answers any batched one that is still waiting.
  if (paintSoonTimer) {
    window.clearTimeout(paintSoonTimer);
    paintSoonTimer = 0;
  }
  paintManagerNav();
  // A repaint mid-drag would tear the row out of your hand. Hold it until the drop lands.
  if (dragging) {
    repaintQueued = true;
    return;
  }
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  // FLIP step 1 — remember where every row sits right now, keyed by project, before the swap.
  const before = new Map<string, number>();
  if (!reduce) {
    for (const child of projectList.children) {
      const rowId = (child as HTMLElement).dataset.projectId;
      if (rowId) before.set(rowId, child.getBoundingClientRect().top);
    }
  }
  const { query, action: queryAction } = parseQuery(projectFilter.value);
  // Platform pairs fold into their host's row, so the row is listed when any member matches.
  membersOf = platformGroups(portfolioStates().map((here) => here.project));
  hostOf.clear();
  for (const [host, members] of membersOf) for (const id of members) if (id !== host) hostOf.set(id, host);
  // The live chip drops itself when the work stops, and it decides whether the rail is collapsed —
  // so it has to settle BEFORE the order is asked for, not after.
  const liveCount = portfolioStates().filter((here) => here.running).length;
  if (liveOnly && liveCount === 0) liveOnly = false;
  const collapsed = railCollapsed();
  const allProjects = orderProjects();
  paintedOrder = allProjects.map((here) => here.project.id);
  const hits = (here: ProjectState): boolean =>
    (!liveOnly || here.running) &&
    (!query ||
      [
        here.project.name,
        here.project.path,
        here.status,
        here.detail,
        pulse.standing(here.project.id)?.status ?? "",
        groupName(here.project.group),
      ].some((value) => value.toLocaleLowerCase().includes(query)));
  const matching = allProjects.filter(
    (here) => !hostOf.has(here.project.id) && membersFor(here).some(hits),
  );
  // Collapsed, the rail keeps RECENT_ROWS rows — but never at the cost of hiding a pin (a deliberate
  // or the project you are standing in (which may be one you have not worked in yet today).
  const shown = new Set<string>();
  if (collapsed) {
    for (const here of matching) if (pinned.has(here.project.id)) shown.add(here.project.id);
    if (active && !terminalsActive && matching.some((here) => here.project.id === active)) {
      shown.add(active);
    }
    for (const here of matching) {
      if (shown.size >= RECENT_ROWS) break;
      shown.add(here.project.id);
    }
    for (const id of [...shown]) {
      const parent = state(id)?.project.parent_id;
      if (parent && matching.some((here) => here.project.id === parent)) shown.add(parent);
    }
  }
  const visibleProjects = collapsed ? matching.filter((here) => shown.has(here.project.id)) : matching;
  const narrowed = Boolean(query) || liveOnly;
  /*
   * Lanes. Every top-level row takes the lane of its busiest member, children ride with their
   * parent, pins lead in a section of their own, and Quiet folds unless you opened it or a filter
   * is doing the narrowing. A filter that hides matches would be lying.
   */
  const laneMode = activeSort() === "lanes";
  const topOf = (here: ProjectState): ProjectState =>
    here.project.parent_id ? state(here.project.parent_id) ?? here : here;
  const sectionOf = new Map<string, string>();
  const sectionCounts = new Map<string, number>();
  let quietFolded = 0;
  if (laneMode) {
    for (const here of visibleProjects) {
      const top = topOf(here);
      if (sectionOf.has(top.project.id)) continue;
      const key = pinnedUnit(top) ? "pinned" : unitLane(top);
      sectionOf.set(top.project.id, key);
      sectionCounts.set(key, (sectionCounts.get(key) ?? 0) + 1);
    }
    const order = ["pinned", ...LANES.map((lane) => lane.id)];
    const rank = (here: ProjectState): number => order.indexOf(sectionOf.get(topOf(here).project.id) ?? "quiet");
    visibleProjects.sort((a, b) => rank(a) - rank(b));
    if (!quietOpen && !narrowed) {
      const keep = visibleProjects.filter(
        (here) =>
          sectionOf.get(topOf(here).project.id) !== "quiet" ||
          membersFor(topOf(here)).some((member) => member.project.id === active),
      );
      quietFolded = visibleProjects.length - keep.length;
      visibleProjects.splice(0, visibleProjects.length, ...keep);
    }
  }
  // Counts are projects, never rows: a collection is a folder in this list, not a project, and
  // Home counts the same way. Two numbers for one portfolio read as a bug.
  const leaves = (list: typeof allProjects): number =>
    list.filter((here) => here.project.role === "leaf").length;
  const projectTotal = leaves(allProjects);
  projectCount.textContent = narrowed
    ? `${leaves(visibleProjects)}/${projectTotal}`
    : String(projectTotal);
  projectLive.hidden = liveCount === 0;
  projectLive.setAttribute("aria-pressed", String(liveOnly));
  projectLive.querySelector("b")!.textContent = String(liveCount);
  // Collapsed the label says what the rows ARE, and the order chip goes with it: there is no
  // rule to choose while the list is "the ones you were just in".
  projectsLabel.textContent = collapsed ? "RECENT" : "PROJECTS";
  projectSort.hidden = collapsed;
  projectSort.textContent = SORT_LABEL[sortMode];
  projectSort.title = SORT_HINT[sortMode];
  // The one door between the short rail and the whole portfolio. It only appears when there is
  // something behind it, and it stays put while a filter is doing the narrowing.
  const hiddenCount = projectTotal - leaves(visibleProjects);
  projectShowAll.hidden = laneMode || narrowed || (!collapsed && states.size <= RECENT_ROWS);
  projectShowAll.classList.toggle("is-open", !collapsed);
  projectShowAll.querySelector("b")!.textContent = collapsed
    ? `Show all ${projectTotal}`
    : "Show recent";
  projectShowAll.querySelector("small")!.textContent = collapsed
    ? `${hiddenCount} more`
    : `${RECENT_ROWS} you last worked in`;
  projectShowAll.title = collapsed
    ? `Show all ${projectTotal} projects`
    : `Show only the ${RECENT_ROWS} most recent`;
  projectShowAll.setAttribute("aria-expanded", String(!collapsed));
  /*
   * Sectioning by group.
   *
   * Only when there is more than one group ON SCREEN. A portfolio that is all one company gets a
   * header saying "Appgea" above every row it owns, which is a label that never distinguishes
   * anything — so it does not appear until the day it means something. Filters can also narrow
   * the rail to one group, and then the header goes away again on its own.
   *
   * Order inside a group is untouched: pins, drags and sort modes all still decide it. The group
   * only decides which block a row sits in.
   */
  const groupOrder = new Map(groups.map((group, at) => [group.id, at]));
  const groupsOnScreen = new Set(visibleProjects.map((here) => here.project.group || ""));
  const sectioned = !laneMode && groupsOnScreen.size > 1;
  if (sectioned) {
    const rank = (id: string): number => groupOrder.get(id) ?? (id ? 500 : 999);
    // A stable sort by group rank keeps every within-group order exactly as it was computed.
    visibleProjects.sort((a, b) => rank(a.project.group) - rank(b.project.group));
  }
  // No group id can be this, so the first row always opens a section.
  let openSection = "\u0000";
  // Drag is honest about when it can hold: only the manual order is yours to rearrange, only
  // when the list on screen is the whole list, and never across sections — what decides which
  // block a row sits in is its group, and a drag has no way to say that.
  const hierarchical = visibleProjects.some(
    (here) => here.project.role === "collection" || Boolean(here.project.parent_id),
  );
  const canDrag = sortMode === "manual" && !narrowed && !collapsed && !sectioned && !hierarchical;
  projectList.classList.toggle("can-drag", canDrag);

  projectList.replaceChildren(
    ...visibleProjects.flatMap((here, index) => {
      const nodes: HTMLElement[] = [];
      const section = sectionOf.get(topOf(here).project.id);
      if (laneMode && section && section !== openSection) {
        openSection = section;
        nodes.push(laneHead(section, sectionCounts.get(section) ?? 0));
      }
      if (sectioned && here.project.group !== openSection) {
        openSection = here.project.group;
        const head = document.createElement("div");
        head.className = "project-group";
        // "Ungrouped" is a real answer, not a missing one: a project nobody has filed yet.
        head.textContent = groupName(openSection) || "Ungrouped";
        nodes.push(head);
      }
      const row = document.createElement("div");
      row.className = "project-row";
      row.setAttribute("role", "button");
      row.tabIndex = 0;
      row.dataset.projectId = here.project.id;
      row.classList.toggle("is-child", Boolean(here.project.parent_id));
      row.classList.toggle("is-collection", here.project.role === "collection");
      row.classList.toggle("is-pinned", pinned.has(here.project.id));
      // The seam under the last pin is the only thing that says "these two groups are different",
      // and it is also the line a drag will not cross.
      const nextProject = visibleProjects[index + 1];
      if (pinned.has(here.project.id) && nextProject && !pinned.has(nextProject.project.id)) {
        row.classList.add("is-pin-last");
      }
      // While a portfolio screen is up, no project is "where you are" — even though `active`
      // still remembers the last one for a cheap return.
      const members = membersFor(here);
      row.classList.toggle(
        "is-active",
        members.some((member) => member.project.id === active) && !terminalsActive,
      );
      if (row.classList.contains("is-active")) row.setAttribute("aria-current", "page");
      row.classList.toggle("is-missing", !here.project.exists);

      const attention = unitAttention(members);
      const running = members.some((member) => member.running);
      row.classList.toggle("is-asking", attention === "needs");
      row.classList.toggle("is-done", attention === "done");
      row.classList.toggle("is-running", running);
      row.innerHTML = `<span class="project-icon"><span class="project-glyph"></span><i class="dot"></i></span><span class="project-label"><b></b></span><small></small><span class="project-meta"></span><span class="project-tools"><button class="project-pin" type="button" tabindex="-1"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6l-1 6 4 3v2H6v-2l4-3Z"/><path d="M12 14v7"/></svg></button><button class="project-more" type="button" tabindex="-1"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg></button></span>`;
      row.querySelector(".project-glyph")!.textContent = here.project.name.trim().charAt(0).toUpperCase();
      const icon = document.createElement("img");
      icon.src = projectIconUrl(here.project.id);
      icon.alt = "";
      icon.draggable = false;
      icon.addEventListener("error", () => icon.remove());
      row.querySelector(".project-icon")!.prepend(icon);
      const names = splitNames(members.map((member) => member.project.name));
      row.querySelector("b")!.textContent = members.length > 1 ? names.base : here.project.name;
      if (members.length > 1) row.querySelector(".project-label")!.append(platformPills(members, names.pills));
      const line: Line =
        here.project.role === "collection"
          ? {
              text: `${[...states.values()].filter((child) => child.project.parent_id === here.project.id).length} projects`,
              tone: "",
            }
          : rowLine(lineInput(leadMember(members)));
      const small = row.querySelector("small")!;
      small.textContent = line.text;
      if (line.tone) small.classList.add(`t-${line.tone}`);
      const mark = line.text;
      decorateRow(row, here, members, attention);
      // The name survives collapse: the compact rail shows icons only, so it rides on hover.
      row.title = attention ? `${here.project.name} — ${mark}` : here.project.name;
      const pin = row.querySelector<HTMLButtonElement>(".project-pin")!;
      pin.setAttribute("aria-label", pinned.has(here.project.id) ? "Unpin project" : "Pin project to top");
      pin.title = pinned.has(here.project.id) ? "Unpin" : "Pin to top";
      pin.addEventListener("click", (event) => {
        event.stopPropagation();
        if (pinned.has(here.project.id)) pinned.delete(here.project.id);
        else pinned.add(here.project.id);
        saveOrder();
        paintProjects();
      });
      const more = row.querySelector<HTMLButtonElement>(".project-more")!;
      more.setAttribute("aria-label", `Options for ${here.project.name}`);
      more.title = "Options";
      more.addEventListener("click", (event) => {
        event.stopPropagation();
        const box = more.getBoundingClientRect();
        openRowMenu(here, { x: box.right - 4, y: box.bottom + 4 });
        rowMenuOwner = more;
        more.classList.add("is-open");
      });
      // Right-click gets the same menu. The browser fires this for the keyboard's menu key too,
      // so this one listener is also how the menu is reachable without a mouse.
      row.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        const box = row.getBoundingClientRect();
        const x = event.clientX || box.right - 8;
        const y = event.clientY || box.bottom;
        openRowMenu(here, { x, y });
      });
      row.addEventListener("click", () => {
        if (suppressRowClick) return;
        void select(here.project.id);
      });
      row.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        void select(here.project.id);
      });
      row.addEventListener("pointerdown", (event) => {
        railCard.hide();
        beginRowDrag(event, row, canDrag);
      });
      row.addEventListener("pointerenter", () => {
        if (!dragging && here.project.role === "leaf") railCard.hover(row, () => cardModel(here));
      });
      row.addEventListener("pointerleave", () => railCard.leave());
      nodes.push(row);
      return nodes;
    }),
  );
  if (laneMode && quietFolded > 0) projectList.append(laneHead("quiet", sectionCounts.get("quiet") ?? 0));
  railCard.repainted((id) =>
    projectList.querySelector<HTMLElement>(`.project-row[data-project-id="${CSS.escape(id)}"]`),
  );
  if (query) markTarget(queryAction);
  pulse.warm(portfolioStates().filter((here) => here.project.role === "leaf").map((here) => here.project.id));
  if (narrowed && visibleProjects.length === 0) {
    const empty = document.createElement("div");
    empty.className = "project-filter-empty";
    empty.textContent = query
      ? `No project matches “${projectFilter.value.trim()}”`
      : "No agent is running right now";
    projectList.append(empty);
  }
  // FLIP step 2 — a row that moved is placed at its NEW slot, offset back to the old one with no
  // transition, then released next frame so it glides. Order changes are rare and deliberate now
  // (a drag, a pin, a sort switch), so this animates a move the user ASKED for. Nothing scrolls
  // on its own any more: the rail follows your hand, never the other way round.
  if (!reduce && before.size) {
    let moved = false;
    for (const child of projectList.children) {
      const row = child as HTMLElement;
      const wasTop = row.dataset.projectId ? before.get(row.dataset.projectId) : undefined;
      if (wasTop === undefined) continue;
      const shift = wasTop - row.getBoundingClientRect().top;
      if (!shift) continue;
      row.style.transition = "none";
      row.style.transform = `translateY(${shift}px)`;
      moved = true;
    }
    if (moved) {
      requestAnimationFrame(() => {
        for (const child of projectList.children) {
          const row = child as HTMLElement;
          if (!row.style.transform) continue;
          row.style.transition = "transform 320ms var(--ease)";
          row.style.transform = "";
          row.addEventListener(
            "transitionend",
            () => {
              row.style.transition = "";
            },
            { once: true },
          );
        }
      });
    }
  }
  // Everything that changes a project repaints the sidebar, so this one hook is what keeps
  // the portfolio screens live — summaries, card verdicts, wall tiles — while one is open.
  if (homeActive) home.sync(homeProjects());
  if (terminalsActive) terminals.sync(wallProjects());
  if (runnerActive) runner.sync(runnerProjects());
  signalAttention();
  repaintQueued = false;
}

/** A drag that ended is not a click. Cleared on the next tick, after the click would have fired. */
let suppressRowClick = false;

/** Pointer-driven reorder. Not HTML5 drag-and-drop: that one hands the gesture to the OS, and in a
 *  Tauri webview the window's own drop handler eats it. A drag stays inside its group — pinned rows
 *  reorder among pins, the rest among themselves — so the seam is a wall you can feel. */
function beginRowDrag(event: PointerEvent, row: HTMLElement, canDrag: boolean): void {
  if (!canDrag || event.button !== 0) return;
  if ((event.target as HTMLElement).closest(".project-tools, .project-meta, .project-pills")) return;
  const rows = [...projectList.querySelectorAll<HTMLElement>(".project-row")];
  const start = rows.indexOf(row);
  if (start === -1) return;
  const isPin = (candidate: HTMLElement): boolean => pinned.has(candidate.dataset.projectId ?? "");
  const group = isPin(row);
  const first = rows.findIndex((candidate) => isPin(candidate) === group);
  let last = first;
  while (last + 1 < rows.length && isPin(rows[last + 1]) === group) last += 1;
  if (last === first) return; // a group of one has nowhere to go
  const rects = rows.map((candidate) => candidate.getBoundingClientRect());
  const stride = rects.length > 1 ? rects[1].top - rects[0].top : rects[start].height + 2;
  const startY = event.clientY;
  let live = false;
  let target = start;

  const move = (moveEvent: PointerEvent): void => {
    const dy = moveEvent.clientY - startY;
    if (!live) {
      if (Math.abs(dy) < 5) return; // a click must survive a shaky hand
      live = true;
      dragging = true;
      row.setPointerCapture(moveEvent.pointerId);
      row.classList.add("is-dragging");
      projectList.classList.add("is-reordering");
    }
    row.style.transform = `translateY(${dy}px)`;
    const center = rects[start].top + dy + rects[start].height / 2;
    let next = start;
    for (let i = first; i <= last; i += 1) {
      if (i === start) continue;
      const mid = rects[i].top + rects[i].height / 2;
      if (i < start && center < mid) next = Math.min(next, i);
      if (i > start && center > mid) next = Math.max(next, i);
    }
    if (next === target) return;
    target = next;
    // Everything the dragged row passes steps aside by exactly one slot — the gap that opens up
    // IS the drop preview, so there is no separate insertion line to read.
    for (let i = first; i <= last; i += 1) {
      if (i === start) continue;
      const shift =
        target > start && i > start && i <= target
          ? -stride
          : target < start && i < start && i >= target
            ? stride
            : 0;
      rows[i].style.transform = shift ? `translateY(${shift}px)` : "";
    }
  };

  const end = (): void => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
    if (!live) return;
    dragging = false;
    suppressRowClick = true;
    setTimeout(() => {
      suppressRowClick = false;
    }, 0);
    projectList.classList.remove("is-reordering");
    row.classList.remove("is-dragging");
    if (target !== start) {
      const ids = rows.map((candidate) => candidate.dataset.projectId!);
      const [moved] = ids.splice(start, 1);
      ids.splice(target, 0, moved);
      manualOrder = [...ids, ...manualOrder.filter((id) => !ids.includes(id))];
      saveOrder();
    }
    // Transforms are left ON PURPOSE: paintProjects measures where the rows LOOK before it swaps
    // them, so the drop glides from under your finger instead of snapping back and re-flying.
    paintProjects();
  };

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}

/* ------------------------------------------------------------------- tabs */

type TabEntry = {
  tab: Tab;
  pane: HTMLElement;
  button: string;
  extension?: {
    module: string;
    mount: string;
    roles: string[];
    types: string[];
    frame: HTMLIFrameElement;
  };
};

const TABS: TabEntry[] = [
  { tab: "terminals", pane: terminalsTabPane, button: "tabTerminals" },
  { tab: "git", pane: gitPane, button: "tabGit" },
  { tab: "dash", pane: dashPane, button: "tabDash" },
  { tab: "files", pane: filesPane, button: "tabFiles" },
  { tab: "debug", pane: debugPane, button: "tabDebug" },
  { tab: "product-spine", pane: productSpinePane, button: "tabProductSpine" },
  { tab: "release", pane: releasePane, button: "tabRelease" },
  { tab: "revenuecat", pane: revenueCatPane, button: "tabRevenueCat" },
  { tab: "analytics", pane: analyticsPane, button: "tabAnalytics" },
];

const extensionTabs = new Map<Tab, NonNullable<TabEntry["extension"]>>();
const activeExtensionModules = new Set<string>();
/** One answer for every screen that shows a module's card: is it installed right now. */
const moduleInstalled = (name: string): boolean => activeExtensionModules.has(name);

function registerProjectSurfaces(modules: PanelModule[]): void {
  activeExtensionModules.clear();
  for (const module of modules) activeExtensionModules.add(module.name);
  const rail = document.querySelector<HTMLElement>(".mtabs")!;
  const panes = document.querySelector<HTMLElement>(".main-panes")!;
  for (const module of modules) {
    for (const surface of module.project_surfaces ?? []) {
      const tab = `extension:${module.name}:${surface.id}` as Tab;
      if (extensionTabs.has(tab)) continue;
      const buttonId = `tab-extension-${module.name}-${surface.id}`;
      const button = document.createElement("button");
      button.id = buttonId;
      button.className = "mtab m-extension";
      button.type = "button";
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", "false");
      button.title = surface.title;
      const glyph = document.createElement("i");
      glyph.className = "mtab-ico extension-glyph";
      glyph.textContent = surface.glyph || module.icon;
      const title = document.createElement("span");
      title.className = "mtab-name";
      title.textContent = surface.title;
      button.append(glyph, title);
      button.addEventListener("click", () => setTab(tab));

      const pane = document.createElement("section");
      pane.className = "pane extension-pane";
      pane.setAttribute("aria-label", surface.title);
      pane.hidden = true;
      const frame = document.createElement("iframe");
      frame.className = "extension-frame";
      frame.title = surface.title;
      pane.append(frame);

      rail.append(button);
      panes.append(pane);
      const extension = {
        module: module.name,
        mount: surface.mount,
        roles: surface.roles ?? [],
        types: surface.types ?? [],
        frame,
      };
      extensionTabs.set(tab, extension);
      TABS.push({ tab, pane, button: buttonId, extension });
    }
  }
}

async function refreshProjectSurfaces(): Promise<void> {
  const modules = await invoke<PanelModule[]>("list_modules").catch(() => []);
  registerProjectSurfaces(modules);
  // Support is a sidebar row rather than a project tab, so nothing above hides it. A row that
  // opens onto "module not installed" is worse than no row, so it follows the install directly.
  setupBoard(modules.some((module) => module.name === "scout"));
  const supportOn = modules.some((module) => module.name === "support");
  el("supportButton").hidden = !supportOn;
  if (!supportOn) {
    dropSupport();
    el("supportBadge").hidden = true;
  } else {
    // The badge has to be true before the screen is ever opened, or it can only tell you what
    // you already went and looked at. One read of a local file — the log is on disk.
    void moduleGet<{ unread: number }>("/m/support/inbox?limit=0")
      .then((seen) => paintSupportBadge(seen.unread))
      .catch(() => undefined);
  }
  const here = active ? state(active) : undefined;
  if (!here) return;
  syncModuleAvailability(here);
  if (!tabEnabled(here, here.tab)) setTab(defaultTab(here.project));
}

function defaultTab(project: Project): Tab {
  if (project.role !== "collection") return "terminals";
  return (
    TABS.find((entry) => {
      const extension = entry.extension;
      return (
        extension &&
        activeExtensionModules.has(extension.module) &&
        project.extension_id === extension.module &&
        (!extension.roles.length || extension.roles.includes(project.role)) &&
        (!extension.types.length || extension.types.includes(project.type))
      );
    })?.tab ?? "terminals"
  );
}

function loadExtensionTab(entry: TabEntry, project: Project): void {
  const extension = entry.extension;
  if (!extension) return;
  const mount = extension.mount
    .replaceAll("{id}", encodeURIComponent(project.id))
    .replaceAll("{path}", encodeURIComponent(project.path));
  const path = mount.startsWith("/") ? mount : `/${mount}`;
  const separator = path.includes("?") ? "&" : "?";
  const target = `${schemeOrigin("module")}/m/${extension.module}${path}${separator}panel_refresh=${Date.now()}`;
  extension.frame.setAttribute("src", target);
}

/**
 * Pay for a screen when you look at it, not when you select a project. Every handle ignores a
 * path it already holds, so this is safe to call on every tab press and every project switch —
 * it does real work only the first time you actually land on the screen for that project.
 *
 * This matters more than it looks: Git, Product Spine and Release each shell out to a Python
 * INTERPRETER. Loading all three on select would spawn three of them per click in the sidebar,
 * for two screens you were usually not even looking at.
 */
async function loadTab(tab: Tab): Promise<void> {
  const here = active ? state(active) : undefined;
  if (!here || !active || !tabEnabled(here, tab)) return;
  const projectId = active;
  const projectPath = here.project.path;
  const extension = TABS.find((entry) => entry.tab === tab);
  if (extension?.extension) loadExtensionTab(extension, here.project);
  if (tab === "files") {
    const tool = await projectTools.ensureFiles();
    if (active === projectId) tool.setProject(projectId, projectPath);
    // Work wears the debug bar, and a bar cannot say "Start" before something has asked whether
    // this project has a profile. The debugger is the one that knows, so it comes up with Work.
    // It costs a 10kB chunk and four cheap file reads; it starts no adapter until you press it.
    void projectTools.ensureDebugger().then((debug) => {
      if (active === projectId) void debug.setProject(projectId, projectPath);
    });
  }
  if (tab === "debug") {
    const tool = await projectTools.ensureDebugger();
    if (active === projectId) await tool.setProject(projectId, projectPath);
  }
  if (tab === "git") {
    const tool = await projectTools.ensureGit();
    if (active === projectId) tool.setProject(projectId, projectPath);
  }
  if (tab === "product-spine") {
    const tool = await projectTools.ensureProductSpine();
    if (active === projectId) tool.setProject(projectId, projectPath);
  }
  if (tab === "release") {
    const tool = await projectTools.ensureRelease();
    if (active === projectId) tool.setProject(projectId, projectPath);
  }
  if (tab === "revenuecat") {
    const tool = await projectTools.ensureRevenueCat();
    if (active === projectId) tool.setProject(projectId, projectPath);
  }
  if (tab === "analytics") {
    const tool = await projectTools.ensureAnalytics();
    if (active === projectId) tool.setProject(projectId, projectPath);
  }
  // Whether this project can be RUN is a Rust filesystem sniff, so it is paid for on arrival at
  // the tab that offers Run — not on every project switch.
  if (tab === "terminals") void runner.refreshTargets().then(syncProjectTerminals);
}

/** Repaint the Terminals tab from truth: this project's sessions, and the runner's own run
 *  state. Cheap and idempotent — called on session changes, run changes and tab entry. */
function syncProjectTerminals(): void {
  const here = active ? state(active) : undefined;
  if (!here) return;
  const run = runner.projectRun(here.project.id);
  projectTerminals.sync(here.sessions, exited, run);
  // The Dashboard's action bar reads the same truth, from the same call. Two surfaces, one sync.
  const alive = here.sessions.filter((session) => !exited.has(session.id));
  dashboard.setLive(
    run,
    alive.filter((session) => isAgentKind(session.kind)).length,
    alive.filter((session) => !isAgentKind(session.kind)).length,
  );
}

/*
 * There used to be an `offerPendingReplay` here, and after it a robot banner on the Work tab, and
 * a theater that performed every edit the agent had made. Both are gone. Work is a reading and
 * editing surface; it does not animate, and it does not carry a notification. The one place that
 * reports what an agent did is the chat rail — the rail is beside the work rather than on top of
 * it, and a second copy on a tab you are trying to work in is noise with a badge on it.
 */

async function setTab(tab: Tab): Promise<void> {
  const here = active ? state(active) : undefined;
  if (here && !tabEnabled(here, tab)) tab = defaultTab(here.project);
  const previous = here?.tab;
  if (here) here.tab = tab;
  const loaded = loadTab(tab);
  const swap = () => {
    for (const entry of TABS) {
      entry.pane.hidden = entry.tab !== tab;
      const button = el(entry.button);
      button.classList.toggle("is-active", entry.tab === tab);
      button.setAttribute("aria-selected", String(entry.tab === tab));
    }
    if (!offProject()) {
      const selected = el(TABS.find((entry) => entry.tab === tab)!.button);
      const rail = selected.closest<HTMLElement>(".mtabs")!;
      const tabBox = selected.getBoundingClientRect();
      const railBox = rail.getBoundingClientRect();
      const left = railBox.left + 24;
      const right = railBox.right - 24;
      if (tabBox.left < left) rail.scrollBy({ left: tabBox.left - left });
      else if (tabBox.right > right) rail.scrollBy({ left: tabBox.right - right });
    }
    mainZone().classList.toggle("is-term-tab", tab === "terminals");
    if (tab === "terminals") syncProjectTerminals();
    // The deck stays inside this tab. Hide every project pane on other surfaces.
    deck.show(projectTerminalVisible() ? here?.activeSession ?? null : null);
    if (here && tab === "dash") here.unseenStage = 0;
    if (here && tab === "files") {
      here.unseenFiles = 0;
      unseenEdits.get(here.project.id)?.clear();
    }
    paintBadges();
    paintNav();
  };

  const from = previous ? TABS.findIndex((entry) => entry.tab === previous) : -1;
  const to = TABS.findIndex((entry) => entry.tab === tab);
  if (here && previous !== tab && from >= 0 && to >= 0 && !offProject()) {
    await withViewTransition(to > from ? "tab-forward" : "tab-backward", swap);
  } else {
    swap();
  }
  await loaded;
}

function paintBadges(): void {
  const here = active ? state(active) : undefined;
  badge("dashBadge", here?.unseenStage ?? 0);
  badge("filesBadge", here?.unseenFiles ?? 0);
  // Terminals wears the count of LIVE sessions, so the rail answers "is anything running here?"
  // without opening the tab.
  badge(
    "terminalsBadge",
    here ? here.sessions.filter((session) => !exited.has(session.id)).length : 0,
  );
}

function badge(id: string, count: number): void {
  const node = el(id);
  node.textContent = String(count);
  node.hidden = count === 0;
}

/* ------------------------------------------------------------- working set */

/**
 * Paint the selected terminal's latest-prompt files. A deliberate agent handoff beats observed
 * edits because it knows which files still need the human and why.
 */
function applyWorklist(id: string, sessionId: string, list: WorkFile[], declared: boolean): void {
  const here = state(id);
  if (!here) return;
  const previous = here.workBySession.get(sessionId);
  here.workBySession.set(sessionId, {
    prompt: previous?.prompt ?? null,
    files: list,
    declared: declared || previous?.declared === true,
  });
  if (active !== id || here.activeSession !== sessionId) return;
  here.workshop.setRelevant(list);
  dashboard.setWork(list);
  if (declared && here.tab !== "files") {
    here.unseenFiles = list.length;
    paintBadges();
  }
}

function syncActiveWork(here: ProjectState): void {
  const list = here.activeSession
    ? here.workBySession.get(here.activeSession)?.files ?? []
    : [];
  here.workshop.setRelevant(list);
  dashboard.setWork(list);
}

function beginTurn(id: string, sessionId: string, prompt?: string | null): void {
  const here = state(id);
  if (!here) return;
  here.workBySession.set(sessionId, { prompt: prompt?.trim() || null, files: [], declared: false });
  if (active !== id || here.activeSession !== sessionId) return;
  here.workshop.begin(prompt);
  syncActiveWork(here);
}

function projectRelative(here: ProjectState, path: string): string {
  const clean = path.trim();
  const root = here.project.path.replace(/\/$/, "");
  return clean.startsWith(`${root}/`) ? clean.slice(root.length + 1) : clean;
}

function addTurnFile(id: string, sessionId: string, path: string): void {
  const here = state(id);
  const turn = here?.workBySession.get(sessionId);
  if (!here || !turn || turn.declared) return;
  const local = projectRelative(here, path);
  if (!local || turn.files.some((file) => file.path === local)) return;
  applyWorklist(
    id,
    sessionId,
    [...turn.files, { path: local, why: "changed for this request" }],
    false,
  );
}

/* ---------------------------------------------------------------- surfaces */

function placeOnStage(id: string, node: HTMLElement): void {
  const here = state(id);
  if (!here) return;
  node.classList.add("enter");
  here.stage.prepend(node);
  while (here.stage.childElementCount > 30) here.stage.lastElementChild?.remove();
  if (active === id) dashboard.syncStage();
  // The stage now lives ON the Dashboard, so only a project you are not looking at — or one you
  // left on another tab — can accumulate output you have not seen.
  if (here.tab !== "dash" || active !== id) {
    here.unseenStage += 1;
    if (active === id) paintBadges();
  }
}

/**
 * One persistent sim status card per project on the Stage, updated in place. Status events replace
 * the card instead of stacking a new one each launch/reload — the card is a live readout, not a log.
 */
function updateSimCard(id: string, payload: Payload): void {
  const here = state(id);
  if (!here) return;
  const node = renderView("sim", payload, ctx);
  const existing = here.stage.querySelector<HTMLElement>(".sim-card");
  if (existing) {
    existing.replaceWith(node);
    return;
  }
  node.classList.add("enter");
  here.stage.prepend(node);
  while (here.stage.childElementCount > 30) here.stage.lastElementChild?.remove();
  if (active === id) dashboard.syncStage();
}

function setStatus(id: string, status: string, detail?: string | null): void {
  const here = state(id);
  if (!here) return;
  here.status = status;
  here.detail = detail ?? "";
  const workshopPhase: WorkshopPhase =
    status === "idle" ? "idle" :
    status === "error" || status === "failed" ? "error" :
    status === "waiting" || status === "asking" ? "asking" :
    status === "done" || status === "complete" ? "done" : "working";
  here.workshop.setPhase(workshopPhase, detail);
  paintProjectsSoon();
}

/**
 * Status events arrive in bursts: several per agent turn, from every agent at once. Each full
 * paint rebuilds every row, reads every row's position first, and re-syncs Home. One paint per
 * burst shows the same final state at a fraction of the cost.
 */
let paintSoonTimer = 0;
function paintProjectsSoon(): void {
  if (paintSoonTimer) return;
  paintSoonTimer = window.setTimeout(() => {
    paintSoonTimer = 0;
    paintProjects();
  }, 80);
}

/* ----------------------------------------------------------------- events */

/**
 * The manager's team tools (list_workers, read_worker, brief_worker in panel_mcp.py). They ride
 * the ask channel and are answered here because this window holds the truth: which terminal is
 * mid-turn, which is parked on you, and the rendered screen (the PTY tail is cursor moves, not
 * text). Only the manager's own sessions get an answer, and no brief is typed until you approve
 * the exact text in a dialog.
 */
async function answerTeam(project: string, qid: string, spec: Payload): Promise<void> {
  const reply = (value: unknown): void => {
    void invoke("answer_ask", { qid, value }).catch(() => undefined);
  };
  if (project !== CPO_ID) {
    reply({ error: "only the manager can use the team tools" });
    return;
  }
  const workers = portfolioStates().flatMap((here) =>
    here.sessions
      .filter((session) => !exited.has(session.id) && session.kind !== "sim" && session.kind !== "task")
      .map((session) => ({ here, session })),
  );
  const statusOf = (here: ProjectState, session: Session): string => {
    if (!isAgentKind(session.kind)) return "shell";
    if (sessionPhase.get(session.id) === "ask") return "waiting_on_human";
    if (working.has(session.id)) return "working";
    if (doneUnseen.has(here.project.id) && reviewAgent(here.project.id)?.id === session.id) return "finished_unseen";
    return "idle";
  };
  const describe = (here: ProjectState, session: Session) => ({
    session: session.id,
    project: here.project.id,
    projectName: here.project.name,
    agent: session.title || session.kind,
    kind: session.kind,
    status: statusOf(here, session),
    prompt: here.workBySession.get(session.id)?.prompt ?? null,
  });

  const kind = String(spec.kind);
  if (kind === "team:list") {
    reply({ workers: workers.map(({ here, session }) => describe(here, session)) });
    return;
  }
  const target = workers.find(({ session }) => session.id === String(spec.session ?? ""));
  if (!target) {
    reply({ error: "no live terminal has that session id; call list_workers" });
    return;
  }
  const { here, session } = target;
  if (kind === "team:read") {
    const lines = Math.min(400, Math.max(1, Number(spec.lines) || 60));
    reply({ ...describe(here, session), screen: deck.tail(session.id, lines).join("\n") });
    return;
  }
  if (kind !== "team:brief") {
    reply({ error: `unknown team request: ${kind}` });
    return;
  }
  // Bracketed paste carries the text; a control character could end the paste and type keys.
  const text = String(spec.text ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, " ").trim();
  const busy = (): string | null =>
    !isAgentKind(session.kind)
      ? "that terminal is a shell, not an agent"
      : exited.has(session.id)
        ? "that worker has ended"
        : sessionPhase.has(session.id) || working.has(session.id)
          ? "the worker is mid-turn or waiting on the human"
          : null;
  const refused = !text ? "the brief is empty" : busy();
  if (refused) {
    reply({ sent: false, reason: refused });
    return;
  }
  signalAttention({
    title: "The manager wants to brief a worker",
    body: `${here.project.name} · ${session.title}`,
    urgent: true,
  });
  const approved = await confirmDialog(
    `The manager wants to send this to ${session.title} on ${here.project.name}:\n\n${text}`,
    { okLabel: "Send brief" },
  );
  if (!approved) {
    reply({ sent: false, reason: "the human declined this brief" });
    return;
  }
  // The worker may have started a turn while the dialog was up.
  const late = busy();
  if (late) {
    reply({ sent: false, reason: late });
    return;
  }
  const sent = await deck.sendPrompt(session.id, text);
  reply(sent ? { sent: true } : { sent: false, reason: "the terminal could not take input" });
}

function onEvent(event: ProjectEvent): void {
  const id = event.project;
  if (!states.has(id)) return;

  switch (event.kind) {
    case "session_started":
      state(id)!.running = true;
      touchProject(id); // Recency, recorded. The row stays exactly where it is.
      setStatus(id, "ready", event.provider);
      state(id)?.workshop.setAgents([event.provider]);
      break;

    case "agent_status":
      touched.set(event.session_id, Date.now());
      setStatus(id, event.status, event.detail);
      // "waiting"/"asking" is still mid-turn — the agent has not handed control back yet.
      if (/^(idle|done|complete|error|failed)$/.test(event.status)) {
        working.delete(event.session_id);
        setPhase(event.session_id, null);
      } else {
        working.add(event.session_id);
        setPhase(
          event.session_id,
          /^(waiting|asking)$/.test(event.status) ? "ask" : "work",
        );
      }
      if (event.status === "thinking") {
        beginTurn(id, event.session_id, event.detail);
        // A new prompt is you answering. Whatever finished before has been seen.
        doneUnseen.delete(id);
      }
      if (/^(waiting|asking)$/.test(event.status)) {
        signalAttention({
          title: `${state(id)!.project.name} needs you`,
          body: event.detail || "An agent is waiting on you in its terminal.",
          urgent: true,
        });
      }
      break;

    case "activity":
      endPermissionWait(id, event.session_id);
      if (/test|check/i.test(event.label)) {
        state(id)?.workshop.checkpoint("test", event.detail, event.success);
      } else if (/build|compile/i.test(event.label)) {
        state(id)?.workshop.checkpoint("build", event.detail, event.success);
      }
      break;

    case "file_changed": {
      endPermissionWait(id, event.session_id);
      // The workshop owns edited files: one station/file evolves in place instead of a feed
      // repeating every write.
      const owner = state(id);
      if (owner?.activeSession === event.session_id) owner.workshop.fileChanged(event.path);
      addTurnFile(id, event.session_id, event.path);
      if (active === id) projectTools.files?.markDirty(event.path);
      let seen = unseenEdits.get(id);
      if (!seen) {
        seen = new Set();
        unseenEdits.set(id, seen);
      }
      seen.add(event.path);
      const pending = seen.size;
      const here = state(id);
      if (here && (active !== id || here.tab !== "files")) {
        here.unseenFiles = Math.max(here.unseenFiles, pending);
        if (active === id) paintBadges();
      }
      // Git still owns repository-wide dirt/ahead state; coalesce its refresh independently of
      // the prompt-scoped Work list above.
      refreshSoon(id);
      break;
    }

    case "visual_requested":
      endPermissionWait(id, event.session_id);
      if (event.view === "message") {
        // A report often means an issue moved or a scout finished.
        board?.refresh(true);
        const here = state(id);
        const source = here?.sessions.find((session) => session.id === event.session_id);
        const flowFiles =
          here?.workBySession.get(event.session_id)?.files.map((file) => file.path) ?? [];
        const flowSteps = Array.isArray(event.payload.flow)
          ? event.payload.flow.filter(
              (step): step is Payload =>
                typeof step === "object" &&
                step !== null &&
                typeof (step as Payload).ref === "string",
            )
          : [];
        chat.add({
          id: `${Date.now()}-${++chatSequence}`,
          project: id,
          projectName: here?.project.name ?? id,
          author: source?.title ?? event.payload.source?.toString() ?? "agent",
          agentKind:
            source?.kind ??
            event.payload.agent_kind?.toString() ??
            event.payload.source?.toString() ??
            "agent",
          session: source ? event.session_id : null,
          flowFiles,
          flowSteps,
          at: Date.now(),
          payload: event.payload,
        });
        // Keep the project-local echo as useful context; the rail is where you answer it, while
        // Dashboard answers "what did this project's agent just send?"
        placeOnStage(id, renderView(event.view, event.payload, projectCtx(id)));
        break;
      }
      // A showcase is a notification too. Keep the terminals completely unobstructed and put
      // the real projector in chat, where its previews remain available after arrival.
      if (event.view === "showcase") {
        const here = state(id);
        const source = here?.sessions.find((session) => session.id === event.session_id);
        placeOnStage(id, renderView(event.view, event.payload, projectCtx(id)));
        chat.add({
          id: `${Date.now()}-${++chatSequence}`,
          project: id,
          projectName: here?.project.name ?? id,
          author: source?.title ?? event.payload.source?.toString() ?? "agent",
          agentKind:
            source?.kind ??
            event.payload.agent_kind?.toString() ??
            event.payload.source?.toString() ??
            "agent",
          session: source ? event.session_id : null,
          flowFiles: [],
          flowSteps: [],
          at: Date.now(),
          view: "showcase",
          payload: event.payload,
        });
        break;
      }
      if (event.view === "worklist") {
        const list = (event.payload.files as WorkFile[]) ?? [];
        applyWorklist(id, event.session_id, list, true);
        break;
      }
      if (event.view.startsWith("git-")) {
        const kind = event.view.slice(4);
        const here = state(id);
        here?.workshop.checkpoint(kind, String(event.payload.command ?? ""), true);
        // Live only when the moment's canvas is actually on screen (that project's Git tab);
        // everywhere else there is nothing to play to.
        if (!offProject() && active === id && here?.tab === "git") {
          projectTools.git?.playMoment(kind, event.payload);
        }
        void refreshProject(id);
        break;
      }
      if (event.view === "sim") {
        // Simulator lifecycle. The Run screen owns the state (screen up or not); the
        // dashboard keeps its in-place card.
        runner.onSim(id, event.session_id, event.payload);
        updateSimCard(id, event.payload);
        break;
      }
      placeOnStage(id, renderView(event.view, event.payload, ctx));
      break;

    case "ask_requested": {
      // A team request is not a question for you; it is answered, or confirmed, on its own.
      if (String(event.spec.kind ?? "").startsWith("team:")) {
        void answerTeam(id, event.qid, event.spec);
        break;
      }
      // The agent's tool call is parked on a socket until this is answered or times out.
      const headline = String(event.spec.title ?? event.spec.prompt ?? event.spec.ask ?? "needs your answer");
      setPhase(event.session_id, "ask");
      askTray.open(id, event.session_id, event.qid, event.spec);
      setStatus(id, "asking", headline);
      signalAttention({ title: `${state(id)!.project.name} needs you`, body: headline, urgent: true });
      break;
    }

    case "ask_resolved":
      askTray.close(event.qid);
      if (sessionPhase.get(event.session_id) === "ask" && !askTray.sessionAsking(event.session_id)) {
        setPhase(event.session_id, "work");
        setStatus(id, "working");
      }
      break;

    case "turn_finished":
      touched.set(event.session_id, Date.now());
      working.delete(event.session_id);
      setPhase(event.session_id, null);
      setStatus(id, "idle", event.summary);
      state(id)?.workshop.setPhase(event.success ? "done" : "error", event.summary);
      if (!lookingAt(id)) {
        doneUnseen.add(id);
        const prompt = state(id)?.workBySession.get(event.session_id)?.prompt;
        signalAttention({
          title: `${state(id)!.project.name} finished`,
          body: prompt ? `Done: ${prompt}` : "Your turn.",
          urgent: false,
        });
      }
      void refreshProject(id);
      break;

    case "error":
      state(id)?.workshop.setPhase("error", event.message);
      break;

    default:
      break;
  }
}

/* ------------------------------------------------------------------- boot */

/**
 * Put last session's terminals back.
 *
 * Rust forks each one again in the folder it had and hands back the screen it was showing; here
 * they rejoin their projects and get that screen painted into them. Ids are preserved across the
 * restart, which is what lets the wall put each terminal back in its own tab and under the name
 * you gave it — both of those are filed by session id.
 *
 * The processes did not survive. Agents that can resume were launched resuming, so the
 * conversation is there; a build that was running is not. The banner in each pane says so.
 */
async function restoreWall(): Promise<void> {
  type RestoredWall = {
    savedAt: number;
    sessions: Array<{ session: Session; screen: string; asleep: boolean }>;
  };
  const wall = await invoke<RestoredWall>("restore_wall", { cols: 120, rows: 34 }).catch(
    (error) => {
      console.warn("[panel] the wall could not be restored", error);
      return { savedAt: 0, sessions: [] } as RestoredWall;
    },
  );
  if (!wall.sessions.length) return;
  const savedAt = wall.savedAt;
  for (const { session, screen, asleep: slept } of wall.sessions) {
    const here = state(session.project);
    // The project was removed from config while Panel was closed. Rust forked the terminal
    // before it could know that, so close it rather than leaking a PTY with no owner.
    if (!here) {
      void invoke("stop_session", { session: session.id }).catch(() => undefined);
      continue;
    }
    here.sessions.push(session);
    here.activeSession ??= session.id;
    // Asleep before the pane exists, so it opens on its Wake bar and never counts as running.
    if (slept) {
      asleep.set(session.id, null);
      exited.add(session.id);
    }
    here.running = here.sessions.some((s) => isAgentKind(s.kind) && !exited.has(s.id));
    deck.add(session.id, session.terminal_id, { screen, savedAt, asleep: slept });
  }
}

async function boot(): Promise<void> {
  mountModuleRailControls();
  // The dashboard's module cards are doors, and a door has to lead somewhere. It does not know
  // what a tab is — it hands back which module it was a door to, and the rail does the rest.
  dashboard = mountDashboard(dashPane, (door) => setTab(door), {
    runWithAgent,
    openSession: (kind) => void openSession(kind),
    run: () => {
      const here = active ? state(active) : undefined;
      if (here) void runner.startProject(here.project.id, false);
    },
    stop: () => {
      const here = active ? state(active) : undefined;
      if (here) void runner.stopProject(here.project.id);
    },
    nudge: (restart) => {
      const here = active ? state(active) : undefined;
      if (here) runner.nudgeProject(here.project.id, restart);
    },
    openFolder: () => void openProjectFolder(),
    installed: moduleInstalled,
  });

  // A session's process can end without anyone clicking anything — `exit`, a crash, claude
  // finishing. The strip has to say so, or it goes on showing a live dot for a dead PTY.
  askTray = mountAskTray({
    projectName: (id) => state(id)?.project.name ?? id,
    sessionName: (id) => sessionById(id)?.title ?? "agent",
    ctx: (id) => projectCtx(id),
    answer: (qid, value) => void invoke("answer_ask", { qid, value }),
    openSession: (project, session) => jumpToSession(project, session),
    changed: () => paintProjectsSoon(),
  });
  // Coming back to the window is looking at whatever project is on screen.
  window.addEventListener("focus", () => {
    if (active && !offProject()) markSeen(active);
    // Coming back is also when the board and due scouts are read. Nothing polls.
    board?.refresh();
  });

  deck = new TerminalDeck(el("terminalHost"), {
    onInput(sessionId, data) {
      touched.set(sessionId, Date.now());
      // A permission prompt is answered with Enter, Esc, or its number key. Arrows only move the
      // highlight, and focus reports are the terminal talking, not you.
      if (!/^(\r|\x1b|[0-9])$/.test(data)) return;
      const owner = [...states.values()].find((here) => here.sessions.some((s) => s.id === sessionId));
      if (owner) endPermissionWait(owner.project.id, sessionId);
    },
    openPlace(sessionId, place) {
      openPlace(sessionById(sessionId)?.project ?? null, place);
    },
    openFile(sessionId, target, reveal) {
      return openFullPath(target, reveal, sessionById(sessionId)?.project ?? null);
    },
    openAppLink: followAppLink,
    runCommand: runInShell,
    onExit(sessionId) {
      exited.add(sessionId);
      board?.refresh();
      askTray.closeSession(sessionId);
      // The manager's terminal shares the exit path with every other session, so the rail hears
      // about its own death here rather than through a second channel.
      chat.noteExit(sessionId);
      sprint?.sync();
      working.delete(sessionId);
      setPhase(sessionId, null);
      const owner = [...states.values()].find((here) =>
        here.sessions.some((s) => s.id === sessionId),
      );
      if (!owner) return;
      owner.running = owner.sessions.some((s) => isAgentKind(s.kind) && !exited.has(s.id));
      if (owner.project.id === active) {
        showSessions();
        // The agent that just died was what made this project "live". Say so.
        void refreshProject(owner.project.id);
      }
      // paintProjects() ends by syncing Home, which flips this session's tile to "ended".
      paintProjects();
    },
    onRestart(sessionId) {
      return restartSession(sessionId);
    },
    canRestart(sessionId) {
      const kind = sessionById(sessionId)?.kind;
      return Boolean(kind) && kind !== "sim" && kind !== "task";
    },
    asleep(sessionId) {
      return asleep.has(sessionId) ? { freed: asleep.get(sessionId) ?? null } : null;
    },
  });

  review = mountReview(el("reviewScreen"), {
    projectName: (id) => state(id)?.project.name ?? id,
    projectPath: (id) => state(id)?.project.path ?? null,
    agentName: (id) => reviewAgent(id)?.title ?? null,
    async send(id, text) {
      const target = reviewAgent(id);
      return target ? deck.sendPrompt(target.id, text) : false;
    },
    busy: () => reviewActive || isLightboxOpen() || Boolean(document.querySelector(".rd-veil")),
    onProjects(counts) {
      reviewCounts = counts;
      paintProjectsSoon();
    },
    onCount(unseen) {
      const badge = el("reviewBadge");
      badge.textContent = unseen > 99 ? "99+" : String(unseen);
      badge.hidden = unseen === 0;
    },
  });

  strip = mountSessionStrip(el("sessionStrip"), {
    skills: (sessionId) => showSkills(sessionId),
    select(sessionId) {
      const here = active ? state(active) : undefined;
      if (!here) return;
      here.activeSession = sessionId;

      showSessions();
      deck.focus();
    },
    close(sessionId) {
      void closeSession(sessionId);
    },
  });
  // The empty terminal area's one button is the head's Start agent, not a second implementation.
  el("terminalEmptyStart").addEventListener("click", () => el<HTMLButtonElement>("startAgent").click());

  // Home no longer owns a screen — it is tab 1 of the workspace, opened by the strip.
  home = mountHome(el("homeScreen"), {
    openProject: (id, start) => openProjectFromHome(id, start),
    isExited: (sessionId) => exited.has(sessionId),
    projectGit: (id) =>
      pulse.git(id).then((git) => git ?? Promise.reject(new Error("no git snapshot"))),
    // Home lists what was said; Chat is where it is read and answered. Clicking a line opens
    // Chat on that post — Esc brings Home straight back.
    openPost: (postId) => chat.reveal(postId),
    openHistory: (sessionId) => showHistory(sessionId ? { session: sessionId } : undefined),
    installed: moduleInstalled,
  });

  history = mountHistory(el("historyScreen"), {
    projectName: historyProjectName,
    openTerminal: (panelSession) => {
      const session = sessionById(panelSession);
      if (session) jumpToSession(session.project, session.id);
    },
    resume: resumeConversation,
    openFile: (session, path) => openHistoryFile(session.project, session.cwd, path),
    seen: refreshHistorySignals,
  });

  chat = mountChat(el("chatRail"), {
    // Same message view as ever, but its refs resolve in the post's own evidence box. Only the
    // explicit ↗ inside that box still travels — see inbox_peek.ts (the box kept its name).
    render: (post, openRef) =>
      renderView(post.view ?? "message", post.payload, { ...projectCtx(post.project), openRef }),
    // A report is something you READ. The old project-page link turned every post into a
    // one-way door out of the feed and into a work surface nobody asked for. The Runs screen
    // is the one destination a handoff earns: go look at the thing running.
    openRuns: (id) => {
      showTerminals(TAB_RUNS);
      runner.highlight(id);
    },
    openSession: (project, session) => jumpToSession(project, session),
    isLiveSession: (session) => !exited.has(session) && sessionById(session) !== null,
    changes: (project, path) => invoke<ChangeStep[]>("file_changes", { project, path }),
    readFile: (project, path) => invoke<string>("read_file", { project, path }),
    renderFlow: (post, openRef) =>
      post.flowSteps.length
        ? renderView(
            "trace",
            { title: String(post.payload.title ?? "Agent flow"), steps: post.flowSteps },
            { ...projectCtx(post.project), openRef },
          )
        : null,
    openRef: (project, ref) => projectCtx(project).openRef(ref),
    // Chat decides whether it is up; the shell decides what that costs. Every path lands here —
    // the sidebar row, ⌘⇧C, Esc, ⌘W, and Home clicking a report.
    visibility: (shown) => {
      if (shown) showChat();
      else exitChat();
      paintChatNav();
    },
    unread: (total) => {
      const badge = el("chatBadge");
      badge.textContent = total > 99 ? "99+" : String(total);
      badge.hidden = total === 0;
    },
    // Unread is one number in one place. It was spread across every project row and Home card,
    // and a badge on ten surfaces is ten things to clear for one thing to read. The Inbox row
    // carries the count; Home still totals it above the activity list, because that list IS the
    // inbox in miniature.
    unreadByProject: (counts) => {
      home.unread(counts);
    },
    archive: (posts) => {
      for (const post of posts) {
        const known = lastReport.get(post.project);
        if (known && known.at >= post.at) continue;
        lastReport.set(post.project, {
          id: post.id,
          title: str(post.payload.title, str(post.payload.outcome, "Report")),
          at: post.at,
        });
      }
      paintProjectsSoon();
      home.activity(
        posts.map((post) => ({
          id: post.id,
          project: post.project,
          projectName: post.projectName,
          author: post.author,
          agentKind: post.agentKind,
          title: str(post.payload.title, str(post.payload.outcome, "Report")),
          at: post.at,
        })),
      );
    },
  },
  {
    // The manager is a session like any other: it opens through the same path as a worker, so
    // its status, attention, wall seat and restore come from the same bookkeeping.
    start: async (kind) => {
      const session = await openSessionFor(CPO_ID, kind);
      if (!session) throw new Error(lastStartError || "The manager could not start.");
      return session;
    },
    current: () => managerSession(),
    lend: (sessionId, cell) => deck.lend(sessionId, cell),
    unlend: () => deck.unlend(),
    openChanges: () => void select(CPO_ID, "dash"),
    stop: (sessionId) => invoke("stop_session", { session: sessionId }).then(() => undefined),
    write: (terminalId, data) => invoke("write_terminal", { terminalId, data }).then(() => undefined),
    preprompt: () => invoke<string>("cpo_preprompt"),
    savePreprompt: (text) => invoke("set_cpo_preprompt", { text }).then(() => undefined),
    resetPreprompt: () => invoke<string>("reset_cpo_preprompt"),
  });

  // Chat is the frontmost conversational surface. Close it before a terminal, tab, or native
  // window can consume the same key. Modals and expanded previews remain above chat and keep Esc.
  window.addEventListener(
    "keydown",
    (event) => {
      if (
        !chat.isVisible() ||
        isRecording() ||
        isLightboxOpen() ||
        document.querySelector(".dlg-wrap")
      ) {
        return;
      }
      const escape =
        event.key === "Escape" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey;
      const closeChord = matchesShortcut(event, "Meta+KeyW");
      if (!escape && !closeChord) return;
      // The manager is an agent in a terminal, and Esc is how you interrupt an agent. While its
      // terminal has the caret, Esc goes to the agent. ⌘W, ⌘⇧M and × still close the screen.
      if (escape && (event.target as Element | null)?.closest?.(".cpo-term")) return;
      chat.hide();
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );

  // The workspace is presentation-only: the deck lends it every live pane and takes them back
  // on exit. The launch pad starts sessions on ANY project through the same one door
  // (openSessionFor) the in-project controls use. Runs is lent to it the same way — a whole
  // element this time — and handed back on clear(). Home is not among them: it is a screen of
  // its own. Neither is Chat, for the same reason — it never enters the strip.
  terminals = mountTerminals(el("terminalsScreen"), {
    skills: (sessionId) => showSkills(sessionId),
    // A getter, not the list: the strip is mounted before config.json has been read.
    groups: () => groups.map(({ id, name }) => ({ id, name })),
    pinned: [
      {
        name: "Runs",
        glyph: "play",
        pane: () => el("runScreen"),
        show: () => {
          runnerActive = true;
          runner.open(runnerProjects());
        },
        hide: () => {
          runnerActive = false;
          runner.clear();
        },
        closeActive: () => runner.closeActive(),
        // This tab shows every run in full, so the build bar stands down over it.
        ownsRuns: true,
      },
    ],
    start: (projectId, kind, cwd) => openSessionFor(projectId, kind, cwd),
    cwdOf: (sessionId) =>
      invoke<string | null>("session_cwd", { session: sessionId }).catch(() => null),
    lastError: () => lastStartError,
    adopt: (sessionId, cell) => deck.adopt(sessionId, cell),
    park: () => deck.parkAll(),
    refit: () => deck.fitAdopted(),
    focusPane: (sessionId) => deck.focusSession(sessionId),
    jump: (projectId, sessionId) => jumpToSession(projectId, sessionId),
    close: (_projectId, sessionId) => void closeSession(sessionId),
    isExited: (sessionId) => exited.has(sessionId),
    phaseOf: (sessionId) => sessionPhase.get(sessionId) ?? "idle",
    memoryOf: (sessionId) => memory.get(sessionId) ?? null,
    isAsleep: (sessionId) => asleep.has(sessionId),
    sleep: (sessionIds) => void sleepSessions(sessionIds, true),
    sleepable: () => quietAgents(0),
    runApp: (projectId) => void runner.rerunProject(projectId),
    runView: (projectId) => runner.projectRun(projectId),
    runTargetPicker: (projectId) => runner.targetPicker(projectId),
    runNudge: (sessionId, restart) => runner.nudgeRun(sessionId, restart),
    runStop: (sessionId) => void runner.stopRun(sessionId),
    runRetry: (sessionId) => {
      showTerminals(TAB_RUNS);
      runner.highlightRun(sessionId);
    },
    runDismiss: (sessionId) => void runner.dismissRun(sessionId),
    runExtra: (projectId) => {
      showTerminals(TAB_RUNS);
      runner.highlight(projectId);
    },
    runOpen: (projectId) => {
      showTerminals(TAB_RUNS);
      runner.highlight(projectId);
    },
  });
  // Home is its own screen and its own row, above the group — no strip index, no chord.
  el("homeButton").addEventListener("click", () => showHome());
  // The sidebar's three doors into the workspace, each landing on its tab. Strip indexes, so
  // they read straight off the ⌘ ladder: Runs 0, first terminal tab 1. Chat is not on it — it is
  // a screen beside the workspace, not a tab of it, so it answers to ⌘⇧C instead.
  el("chatButton").addEventListener("click", () => {
    chat.show("reports");
  });
  paintChatNav();
  el("cpoButton").addEventListener("click", () => {
    chat.showCpo();
  });
  el("notebookButton").addEventListener("click", () => showNotebook());
  el("sprintButton").addEventListener("click", () => showSprint());
  el("opsMapButton").addEventListener("click", () => showOpsMap());
  el("boardButton").addEventListener("click", () => showBoard());
  el("supportButton").addEventListener("click", () => showSupport());
  el("reviewButton").addEventListener("click", () => showReview());
  el("historyButton").addEventListener("click", () => showHistory());
  // The row starts hidden and `refreshProjectSurfaces` turns it on once the module list says the
  // module is installed. Until then it is not a place you can be.
  el("supportButton").hidden = true;
  el("boardButton").hidden = true;
  const paintNotebookHint = (): void => {
    el("notebookButton").title = `Notebook (${chordLabel("app.notebook")})`;
  };
  paintNotebookHint();
  window.addEventListener(KEYMAP_EVENT, paintNotebookHint);

  // The chords are TAUGHT where they land, not only listed in Settings: hold ⌘ and every rung
  // shows its key — K on the Runs row, J on the Terminals row, ⇧E/⇧G/⇧D on the rail, 1…9 on
  // Work's file slots (files.ts). Nothing is on screen until the hand is already on the
  // modifier, so a screen at rest stays quiet and the key is there the moment you reach for it.
  // Repainted on rebind.
  const chordHints: [string, ActionId][] = [
    ["runButton", "app.runs"],
    ["terminalsButton", "app.wall"],
    ["tabFiles", "app.work"],
    ["tabGit", "app.git"],
    ["tabDash", "app.dash"],
  ];
  const paintChordHints = (): void => {
    for (const [id, action] of chordHints) {
      const button = el(id);
      const chord = chordLabel(action);
      const base = button.dataset.title ?? (button.dataset.title = button.title);
      button.title = `${base} (${chord})`;
      let key = button.querySelector<HTMLElement>(":scope > .key-hint");
      if (!key) {
        key = document.createElement("kbd");
        key.className = "key-hint";
        key.setAttribute("aria-hidden", "true");
        button.append(key);
      }
      key.textContent = chord;
    }
  };
  paintChordHints();
  el("chatButton").title = `Agent reports · ${shortcutLabel("Meta+Shift+KeyC", "Ctrl+Alt+KeyC")}`;
  el("cpoButton").title = `Manager · Plan work with an agent · ${shortcutLabel("Meta+Shift+KeyM")}`;
  window.addEventListener(KEYMAP_EVENT, paintChordHints);
  window.addEventListener("keydown", (event) => {
    if (event.key === (IS_MAC ? "Meta" : "Control")) document.body.classList.add("is-cmd-held");
  });
  window.addEventListener("keyup", (event) => {
    if (event.key === (IS_MAC ? "Meta" : "Control")) document.body.classList.remove("is-cmd-held");
  });
  window.addEventListener("blur", () => document.body.classList.remove("is-cmd-held"));
  el("runButton").addEventListener("click", () => showTerminals(TAB_RUNS));
  el("terminalsButton").addEventListener("click", () => showTerminals(TAB_WALL));

  // Run owns the simulators. Its PTYs are real but never join the deck — the pane's verbs
  // (run / r / R / stop) are the whole interface, and the Rust sim cap guards the memory.
  // It has no screen of its own any more: it is tab 3 of the workspace, opened by the strip.
  runner = mountRunner(el("runScreen"), {
    start: (projectId, target, allowExtra, extraInstance, restart, fresh) =>
      invoke<SimStart>("start_sim", {
        project: projectId,
        // Rust's parameter is still called `device`, but it now takes a target ADDRESS.
        device: target,
        allowExtra,
        extraInstance,
        restart,
        fresh,
        cols: 120,
        rows: 34,
      }),
    write: (terminalId, data) => void invoke("write_terminal", { terminalId, data }),
    stop: (sessionId) =>
      invoke("stop_session", { session: sessionId }).catch(() => undefined) as Promise<void>,
    inventory: () =>
      invoke<RunInventory>("run_inventory").catch(() => ({
        devices: [],
        leases: {},
        androidDevices: [],
        iosDevices: [],
        targets: [],
        idle: [],
      })),
    closeIdle: () => invoke<number>("close_idle_sims").catch(() => 0),
    // The address decides WHAT gets raised: Simulator.app for an iOS run, the emulator window for
    // an Android one, nothing at all for a phone on the desk. Without one, Rust falls back to
    // Simulator.app — which is what a caller with no run in hand means.
    focus: (address) => void invoke("sim_focus", { address: address ?? null }).catch(() => undefined),
    openServer: (projectId) => void invoke("open_server", { project: projectId }).catch(() => undefined),
    jump: (projectId, sessionId) => jumpToSession(projectId, sessionId),
    isExited: (sessionId) => exited.has(sessionId),
  });
  // The project's Terminals tab and the workspace's build bar mirror run state, and one of them
  // is usually the only surface up when a build is talking. One truth (the runner), three readers.
  runner.onChange(syncProjectTerminals);
  runner.onChange(pushRunBar);
  const terminalZone = el("terminalZone");
  projectTerminals = mountProjectTerminals(terminalsTabPane, {
    openSession: (kind) => void openSession(kind),
    targetPicker: (projectId) => runner.targetPicker(projectId),
    run: (allowExtra) => {
      const here = active ? state(active) : undefined;
      if (here) void runner.startProject(here.project.id, allowExtra);
    },
    stop: () => {
      const here = active ? state(active) : undefined;
      if (here) void runner.stopProject(here.project.id);
    },
    nudge: (restart) => {
      const here = active ? state(active) : undefined;
      if (here) runner.nudgeProject(here.project.id, restart);
    },
    focusSimulator: () => { if (active) runner.focusProject(active); },
    openRuns: () => {
      const here = active ? state(active) : undefined;
      showTerminals(TAB_RUNS);
      if (here) runner.highlight(here.project.id);
    },
  });
  terminalsTabPane.append(terminalZone);
  // Each shortcut opens its destination, or closes it when already there.
  window.addEventListener(
    "keydown",
    (event) => {
      if (isRecording() || isLightboxOpen()) return;
      if (event.repeat) return;
      if (matchesShortcut(event, "Meta+Shift+KeyM")) {
        chat.toggle("manager");
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (!matchesShortcut(event, "Meta+Shift+KeyC", "Ctrl+Alt+KeyC")) return;
      chat.toggle("reports");
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );

  window.addEventListener(
    "keydown",
    (event) => {
      if (event.repeat || isRecording() || isLightboxOpen()) return;
      if (!chordMatches(event, "app.notebook")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      showNotebook();
    },
    true,
  );

  // ⌘1…⌘9 — the strip you are looking at, one for one, from inside a terminal too (capture
  // phase beats xterm). On the wall that is the workspace strip: ⌘1 Runs, ⌘2 the first terminal
  // tab. In the tabs layout the second row of terminals takes the digits while it is up, and the
  // strip moves to ⌃⌘1…9. On a project it is Work's file slots. Two strips, one ladder, and ⌘J walks between
  // them — the digits never leave the screen you are on. Home, Settings, Chat and the notebook
  // own no digit. A digit past the last rung does nothing rather than landing you on a
  // neighbour you did not ask for. ⌘1 is the app fallback: when this screen has no first
  // rung, it opens the first terminal tab.
  window.addEventListener(
    "keydown",
    (event) => {
      // A chord being RECORDED in Settings must not also fire the thing it is bound to today,
      // and an expanded picture owns the keyboard for as long as it is up.
      if (isRecording() || isLightboxOpen()) return;
      if (event.repeat || !/^Digit[1-9]$/.test(event.code)) return;
      if (!matchesShortcut(event, `Meta+${event.code}`)) return;
      const at = Number(event.code.slice(5)) - 1;
      if (terminalsActive) {
        // The tabs layout's second row takes the digits while it is up; terminals.ts decides.
        if (terminals.digit(at)) {
          // handled
        } else if (document.body.classList.contains("single-project")) {
          // A single-project Panel has no portfolio to jump across.
          if (at !== 0) return;
          showTerminals(TAB_WALL);
        } else {
        // Bounds are the strip's, not the keyboard's: with three tabs, ⌘6 is nobody's.
          if (at >= terminals.count()) return;
          showTerminals(at);
        }
      } else {
        if (offProject() || !active) {
          if (at !== 0) return;
          showTerminals(TAB_WALL);
        } else {
          void jumpToSlot(at + 1).then((handled) => {
            if (!handled && at === 0) showTerminals(TAB_WALL);
          });
        }
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );

  // ⌘J, ⌘K, ⌘⇧E, ⌘⇧G, ⌘⇧D — the screens, by letter, from anywhere. The wall and Runs toggle;
  // the three modules open on the project you are looking at.
  window.addEventListener(
    "keydown",
    (event) => {
      if (isRecording() || isLightboxOpen() || event.repeat) return;
      const go = (act: () => void): void => {
        event.preventDefault();
        event.stopImmediatePropagation();
        act();
      };
      if (chordMatches(event, "app.wall")) return go(toggleWall);
      if (chordMatches(event, "app.runs")) return go(toggleRuns);
      if (chordMatches(event, "app.work")) return go(() => void goSection("files"));
      if (chordMatches(event, "app.git")) return go(() => void goSection("git"));
      if (chordMatches(event, "app.dash")) return go(() => void goSection("dash"));
      if (chordMatches(event, "term.waiting")) return go(goWaiting);
      // The wall answers these itself while it is up (terminals.ts); here they walk the rail.
      if (offProject() || !active) return;
      if (chordMatches(event, "tab.next")) return go(() => stepRail(1));
      if (chordMatches(event, "tab.prev")) return go(() => stepRail(-1));
    },
    true,
  );

  // ⌘R / ⌘⇧R — re-run or fresh-run the app you are looking at, from anywhere, including from
  // inside a terminal. Capture phase and preventDefault are not optional here: in a webview both
  // are RELOAD, and a reload of Panel would take every terminal on screen down with it.
  window.addEventListener(
    "keydown",
    (event) => {
      if (isRecording() || isLightboxOpen()) return;
      const fresh = chordMatches(event, "app.runFresh");
      if ((!fresh && !chordMatches(event, "app.runApp")) || event.repeat) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      runFocusedApp(fresh);
    },
    true,
  );

  // ⌘. — stop that run and release its simulator. Capture phase for the same reason ⌘R needs it:
  // the keystroke must not reach a terminal on the way, and nothing else in Panel claims it.
  window.addEventListener(
    "keydown",
    (event) => {
      if (isRecording() || isLightboxOpen()) return;
      if (!chordMatches(event, "app.stopApp") || event.repeat) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      stopFocusedApp();
    },
    true,
  );

  // ⌘⌥R — a second instance of that app, on a second simulator. Capture phase like ⌘R, since the
  // webview would still read the R as a reload.
  window.addEventListener(
    "keydown",
    (event) => {
      if (isRecording() || isLightboxOpen()) return;
      if (!chordMatches(event, "app.runExtra") || event.repeat) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      runExtraInstance();
    },
    true,
  );

  // ⌘F — find in the terminal you are looking at. Capture phase, because xterm would otherwise
  // eat the keystroke and send it to the shell. Only when a terminal is actually on screen:
  // the wall, or an open terminal zone on a project. Everywhere else ⌘F is nobody's shortcut yet,
  // so it is left alone rather than swallowed.
  window.addEventListener(
    "keydown",
    (event) => {
      // A chord being RECORDED in Settings must not also fire the thing it is bound to today,
      // and an expanded picture owns the keyboard for as long as it is up.
      if (isRecording() || isLightboxOpen()) return;
      if (
        !chordMatches(event, "term.find") ||
        event.repeat
      ) {
        return;
      }
      if (homeActive || runnerActive) return;
      if (!terminalsActive && !projectTerminalVisible()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      deck.openSearch();
    },
    true,
  );

  // ⌘+ / ⌘- / ⌘0 — terminal text size. Capture phase for the same reason as ⌘F: xterm would send
  // the keystroke to the shell. `repeat` is deliberately ALLOWED here — holding ⌘- to shrink is
  // the whole gesture, unlike a tab jump where a held key would be a mistake. On a Mac keyboard
  // ⌘+ is physically ⌘⇧=, so "=" and "+" are the same request and shift is not disqualifying.
  // Same visibility rule as ⌘F: only when a terminal is actually on screen.
  window.addEventListener(
    "keydown",
    (event) => {
      if (isRecording() || isLightboxOpen()) return;
      const step =
        matchesShortcut(event, "Meta+Equal") || matchesShortcut(event, "Meta+Shift+Equal")
          ? 1
          : matchesShortcut(event, "Meta+Minus") || matchesShortcut(event, "Meta+Shift+Minus")
            ? -1
            : matchesShortcut(event, "Meta+Digit0")
              ? 0
              : null;
      if (step === null) return;
      if (homeActive || runnerActive) return;
      if (!terminalsActive && !projectTerminalVisible()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (step === 0) deck.resetZoom();
      else deck.zoom(step as 1 | -1);
    },
    true,
  );

  // ^F opens the project's full-screen terminal tab. The wall owns its own zoom.
  window.addEventListener("keydown", (event) => {
    if (isRecording() || isLightboxOpen() || offProject() || event.repeat) return;
    if (!chordMatches(event, "term.fullscreen")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void setTab("terminals").then(() => deck.focus());
  }, true);

  // Register before any project IO: even closing Panel during startup must be caught while its
  // native runtime may already own a session.
  await listen<Session[]>("panel-shutdown-requested", async ({ payload }) => {
    if (shutdownPromptOpen) return;
    shutdownPromptOpen = true;
    const rows = payload.map((session) => {
      const project = state(session.project)?.project.name ?? session.project;
      return `• ${project} — ${session.title}`;
    });
    const message = payload.length
      ? `Panel still has ${payload.length} running ${payload.length === 1 ? "session" : "sessions"}:\n\n${rows.join("\n")}\n\nQuit Panel and stop ${payload.length === 1 ? "this process" : "all of these processes"}?`
      : "Quit Panel?";
    const confirmed = await confirmDialog(message, { okLabel: "Quit Panel", danger: true });
    if (confirmed) {
      await invoke("shutdown_panel").catch((error) =>
        alertDialog(`Panel could not shut down safely:\n\n${String(error)}`),
      );
    } else {
      await invoke("cancel_shutdown").catch(() => undefined);
    }
    shutdownPromptOpen = false;
  });

  const context = await invoke<{ single_project: string | null }>("launch_context");
  document.body.classList.toggle("single-project", !!context.single_project);
  await refreshProjectSurfaces();
  groups = await invoke<Group[]>("list_groups").catch(() => []);
  const list = await invoke<Project[]>("list_projects");
  for (const project of list) states.set(project.id, makeState(project));
  // Before the wall comes back, or the manager's restored terminal has no owner and is closed.
  // No ops tree means no manager; the pane then says why when you try to start it.
  const manager = await invoke<Project>("manager_project").catch(() => null);
  if (manager && !states.has(CPO_ID)) states.set(CPO_ID, makeState({ ...manager, name: "Manager" }));
  await refreshMainFolder();
  pulse.refreshPortfolio(projectNames());
  await restoreWall();
  board?.refresh();
  paintProjects();
  // The portfolio lands on Home. Only a Panel scoped to ONE project skips it — there is no
  // portfolio to look across, so it goes straight in, exactly as before.
  const single = context.single_project
    ? list.find((project) => project.id === context.single_project) ?? list[0]
    : undefined;
  if (single) {
    await select(single.id);
  } else {
    showHome();
  }

  await listen<ProjectEvent>("panel-agent-event", ({ payload }) => onEvent(payload));
  await listen("panel-portfolio-changed", () => void refreshPortfolio());
  // The plan is written by agents in their own terminals. The screen follows the file rather
  // than waiting to be told, so an agent's plan lands without anyone pressing refresh.
  await listen("panel-sprints-changed", () => sprint?.sync());
  // now.md, the log and the rollouts are written by agents too. The map follows the files.
  await listen("panel-ops-changed", () => opsMap?.sync());
  // A link that launched Panel waited in Rust for this moment; later ones arrive as an event.
  await listen("panel-link", takeAppLinks);
  takeAppLinks();
  refreshHistorySignals();
  // Transcripts grow without telling anyone; a rescan after the first is milliseconds.
  window.setInterval(refreshHistorySignals, 3 * 60_000);
  // Memory moves without an event to say so. Read it often enough for the wall to stay honest,
  // and look for agents left unused once a minute.
  void refreshMemory();
  window.setInterval(() => void refreshMemory(), 20_000);
  window.setInterval(sleepUnused, 60_000);

  // Every module is a segment of the same rail now, so every one is wired the same way. Product Spine
  // used to be special-cased here as a toggle — which is exactly why it never read as a module.
  for (const entry of TABS) {
    if (!entry.extension) el(entry.button).addEventListener("click", () => setTab(entry.tab));
  }

  // ⌃1…⌃9 open a project from the sidebar: pins first, then rows in the order you see them.
  window.addEventListener(
    "keydown",
    (event) => {
      if (isRecording() || isLightboxOpen() || event.repeat) return;
      if (!chordMatches(event, "project.jump")) return;
      const digit = digitOf(event);
      const id = digit ? jumpTargets()[digit - 1] : undefined;
      if (!id) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void select(id);
    },
    true,
  );

  // Files dropped from Finder onto a project row go to that project's agent. Tauri hands drops
  // over before the webview sees them, so this listens beside the terminal's own drop handler.
  void getCurrentWebview().onDragDropEvent(({ payload }) => {
    if (payload.type === "leave") {
      paintRowDrop(null);
      return;
    }
    const row = rowAtPoint(payload.position.x, payload.position.y);
    if (payload.type !== "drop") {
      paintRowDrop(row);
      return;
    }
    paintRowDrop(null);
    if (row?.dataset.projectId) void dropOnProject(row.dataset.projectId, payload.paths);
  });

  // F5 is the debugger's one global door. It opens the project screen first, then starts the
  // selected profile. A live session treats the second press as a no-op instead of duplicating.
  window.addEventListener("keydown", (event) => {
    if (event.key !== "F5" || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
    if (document.querySelector(".skills-overlay")) return;
    const here = active ? state(active) : undefined;
    if (!here || !tabEnabled(here, "debug")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void setTab("debug").then(() => projectTools.debugger?.start());
  }, true);

  // Capture before xterm sees the keystroke. Cmd-W closes the visible terminal first: a simulator
  // run, a tile on the Terminals wall, or the open project terminal. With no visible terminal it
  // closes the Work file; falling through can only request an app close, which Rust always guards.
  window.addEventListener(
    "keydown",
    (event) => {
      // A chord being RECORDED in Settings must not also fire the thing it is bound to today,
      // and an expanded picture owns the keyboard for as long as it is up.
      if (isRecording() || isLightboxOpen() || document.querySelector(".skills-overlay")) return;
      if (
        !matchesShortcut(event, "Meta+KeyW") ||
        event.repeat
      ) {
        return;
      }
      // One door for the whole workspace: on the Runs tab it stops a run, otherwise it closes
      // a terminal or an empty tab. The strip decides which — main.ts no longer has to.
      if (terminalsActive && terminals.closeActive()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      const here = active ? state(active) : undefined;
      if (!here) return;
      // Home has no visible terminal. Let the native close request reach the confirmation guard.
      if (offProject()) return;
      if (
        here.activeSession &&
        projectTerminalVisible()
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        void closeSession(here.activeSession);
        return;
      }
      // Without an open terminal, Work keeps the familiar close-current-file behavior.
      if (here.tab === "files") {
        if (projectTools.files?.closeActiveTab()) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        return;
      }
    },
    true,
  );

  // The head's button is the common case — start working on this project. Everything else about
  // sessions (a second agent, a shell, closing one) lives on the strip, where they are visible.
  el("startAgent").addEventListener("click", () => {
    const button = el<HTMLButtonElement>("startAgent");
    const error = el("startAgentError");
    button.disabled = true;
    error.hidden = true;
    void openSession("claude").then((started) => {
      button.disabled = false;
      if (started) return;
      error.textContent = lastStartError || "Agent could not start";
      error.title = error.textContent;
      error.hidden = false;
    });
  });

  el("openProjectFolder").addEventListener("click", () => void openProjectFolder());

  // The list holds still while your pointer (or focus) is inside it, and catches up the moment you
  // leave — the one exception being a rule you set yourself, which applies immediately.
  projectList.addEventListener("pointerenter", () => {
    listHot = true;
  });
  projectList.addEventListener("pointerleave", () => {
    listHot = false;
    if (repaintQueued || activeSort() === "recent" || activeSort() === "lanes") paintProjects();
  });
  projectList.addEventListener("focusin", () => {
    listHot = true;
  });
  projectList.addEventListener("focusout", () => {
    if (projectList.matches(":hover")) return;
    listHot = false;
    if (repaintQueued || activeSort() === "recent" || activeSort() === "lanes") paintProjects();
  });

  // One chip, one rule. Manual is the default and the only one that can be dragged; the other two
  // exist because sometimes you want the machine's answer, and then you asked for it out loud.
  projectSort.addEventListener("click", () => {
    sortMode =
      sortMode === "lanes" ? "manual" : sortMode === "manual" ? "recent" : sortMode === "recent" ? "name" : "lanes";
    saveOrder();
    listHot = false;
    paintProjects();
  });

  // "Where is the work" used to be answered by shoving rows to the top. Now it is a filter you
  // press — the portfolio keeps its shape either way.
  projectLive.addEventListener("click", () => {
    liveOnly = !liveOnly;
    paintProjects();
  });

  // Open the whole portfolio, or fold it back to the five. The choice sticks — a rail you opened
  // on purpose has no business closing itself the next time you launch.
  projectShowAll.addEventListener("click", () => {
    showAllProjects = !showAllProjects;
    localStorage.setItem("panel-project-showall", showAllProjects ? "1" : "0");
    // The pointer is on the button, not in the list, but the freeze is about the same gesture:
    // release it so the new order lands with this click instead of one hover later.
    listHot = false;
    paintProjects();
  });

  projectFilter.addEventListener("input", paintProjects);
  projectFilter.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      const target = projectList.querySelector<HTMLElement>(".project-row.is-target");
      if (!target?.dataset.projectId) return;
      event.preventDefault();
      const { action } = parseQuery(projectFilter.value);
      projectFilter.value = "";
      projectFilter.blur();
      paintProjects();
      void runRowAction(target.dataset.projectId, action);
      return;
    }
    if (event.key === "Escape" && (projectFilter.value || liveOnly)) {
      projectFilter.value = "";
      liveOnly = false;
      paintProjects();
    }
  });
  // ⌘⇧O with no pane claiming it — no Work tab, no script open — is "open a project": the same
  // panel the Work tab uses for related files, listing the portfolio by name. Panes register
  // their own ⌘⇧O in the capture phase and swallow it; this one listens late and only ever
  // hears what they let through.
  mountQuickOpen({
    host: el("app"),
    shortcut: { key: "o", shift: true, late: true },
    placeholder: "Project name",
    emptyText: "No project by that name.",
    onChoose: (target) => void select(target.path),
    load: () => ({
      title: "Open project",
      targets: orderProjects().map((here) => ({
        path: here.project.id,
        detail: here.project.role === "collection" ? "collection" : here.project.path,
        // The letter sits under the icon; a project without one shows the letter.
        icon: `<b>${here.project.name.trim().charAt(0).toUpperCase()}</b><img src="${projectIconUrl(here.project.id)}" alt="" onerror="this.remove()" />`,
        label: here.running ? "live" : "",
        name: here.project.name,
      })),
    }),
  });

  // The project list is the portfolio's fastest switcher. ⌘K focuses its local filter from
  // anywhere except single-project mode, where the rail is deliberately absent. Runs owns ⌘K by
  // default (app.runs fires first), so this only answers once that chord is rebound in Settings.
  window.addEventListener(
    "keydown",
    (event) => {
      // A chord being RECORDED in Settings must not also fire the thing it is bound to today,
      // and an expanded picture owns the keyboard for as long as it is up.
      if (isRecording() || isLightboxOpen()) return;
      if (
        !matchesShortcut(event, "Meta+KeyK") ||
        event.repeat ||
        document.body.classList.contains("single-project")
      ) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      projectFilter.focus();
      projectFilter.select();
    },
    true,
  );

  // Settings — the gear in the sidebar's foot, and ⌘, the way every Mac app answers it. The
  // sheet is its own module; nothing here knows what is in it.
  settings = mountSettings(el("settingsScreen"), {
    close: () => exitSettings(),
    skills: () => showSkills(),
  });
  // Installing an extension changes which tabs a project has. Re-select the open project so its
  // rail is right the moment Settings closes, rather than on the next click into the sidebar.
  window.addEventListener(EXTENSIONS_EVENT, () => {
    const open = active;
    void refreshProjectSurfaces().then(() => {
      if (open) void select(open);
    });
  });
  const settingsButton = el("settingsButton");
  settingsButton.addEventListener("click", () => (settingsActive ? exitSettings() : showSettings()));
  const paintSettingsHint = (): void => {
    settingsButton.title = `Settings (${chordLabel("app.settings")})`;
  };
  paintSettingsHint();
  window.addEventListener(KEYMAP_EVENT, paintSettingsHint);
  // ⌘, both ways: the screen you opened with it is the screen it closes.
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.repeat || isRecording() || !chordMatches(event, "app.settings")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (settingsActive) exitSettings();
      else showSettings();
    },
    true,
  );

  el("addProject").addEventListener("click", () => void addProject());

  // Theme. The <head> script already set data-theme before first paint (saved choice, else
  // the OS preference); here we just flip and persist it. The glyph shows the destination:
  // a filled-left moon in dark means "tap for light", and vice versa.
  const themeToggle = el("themeToggle");
  const paintToggle = (theme: string) => {
    themeToggle.innerHTML = icon(theme === "light" ? "moon" : "sun");
    themeToggle.title = theme === "light" ? "Switch to dark theme" : "Switch to light theme";
  };
  // The native title bar only follows the OS appearance, not Panel's own theme — left alone it
  // stays light on a light-mode Mac even while the app itself renders its (default) dark theme.
  // Force it to track our theme instead, so the traffic-light strip never clashes with the body.
  const syncWindowChrome = (theme: string) => {
    void getCurrentWindow().setTheme(theme === "light" ? "light" : "dark");
  };
  paintToggle(document.documentElement.getAttribute("data-theme") ?? "dark");
  syncWindowChrome(document.documentElement.getAttribute("data-theme") ?? "dark");
  themeToggle.addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("panel-theme", next);
    } catch {
      /* private mode / storage disabled — the theme still applies for this session */
    }
    // The CSS-driven surfaces flip via the attribute alone; the canvas terminals can't read
    // CSS vars, so they listen for this and re-skin themselves.
    window.dispatchEvent(new Event("panel-theme-change"));
    paintToggle(next);
    syncWindowChrome(next);
  });

  // Sidebar width. Same pre-paint arrangement as the theme: the <head> script already put
  // `sidebar-compact` on <html> (it runs before <body> exists, so the class lives there and
  // the CSS keys off it); here we just flip and persist. The chevron points where the edge
  // will move: ‹ folds the rail away, › brings it back.
  const sidebarToggle = el("sidebarToggle");
  const paintSidebarToggle = (compact: boolean) => {
    sidebarToggle.innerHTML = icon(compact ? "panel-right" : "panel-left");
    sidebarToggle.title = compact ? "Expand sidebar" : "Collapse sidebar";
    sidebarToggle.setAttribute("aria-label", sidebarToggle.title);
    sidebarToggle.setAttribute("aria-pressed", String(compact));
  };
  paintSidebarToggle(document.documentElement.classList.contains("sidebar-compact"));
  sidebarToggle.addEventListener("click", () => {
    const compact = document.documentElement.classList.toggle("sidebar-compact");
    try {
      localStorage.setItem("panel-sidebar-compact", compact ? "1" : "0");
    } catch {
      /* private mode / storage disabled — the width still applies for this session */
    }
    paintSidebarToggle(compact);
  });
}

async function openProjectFolder(): Promise<void> {
  if (!active) return;
  try {
    await invoke("open_project_folder", { project: active, path: null });
  } catch (error) {
    await alertDialog(`Could not open the project folder.\n\n${String(error)}`);
  }
}

/**
 * Adding a project writes to the SHARED config.json, so it appears in the old Panel too.
 * The folder comes from the native picker — the human already has the folder in front of them,
 * and typing a path was the only reason adding a project felt like admin work.
 */
async function addProject(): Promise<void> {
  let path: string | null = null;
  try {
    path = await invoke<string | null>("pick_project_folder");
  } catch {
    // No picker on this platform build. A typed path still gets the project in.
    path = (await promptDialog("Path to the project folder")) ?? null;
  }
  if (!path?.trim()) return;
  try {
    const project = await invoke<Project>("add_project", { path, name: null });
    states.set(project.id, makeState(project));
    paintProjects();
    await select(project.id);
  } catch (error) {
    await alertDialog(String(error));
  }
}

/**
 * `config.json` is shared, so it changes under us: the old Panel, an agent, a hand edit. The
 * rail follows it live rather than asking for a relaunch. Existing projects keep their state —
 * only the registry fields are refreshed, so a running session survives a portfolio edit.
 */
async function refreshPortfolio(): Promise<void> {
  const [nextGroups, list, panelModules] = await Promise.all([
    invoke<Group[]>("list_groups").catch(() => groups),
    invoke<Project[]>("list_projects").catch(() => null),
    invoke<PanelModule[]>("list_modules").catch(() => null),
  ]);
  if (!list) return;
  if (panelModules) registerProjectSurfaces(panelModules);
  groups = nextGroups;
  for (const project of list) {
    const known = states.get(project.id);
    if (!known) {
      states.set(project.id, makeState(project));
      continue;
    }
    known.project.name = project.name;
    known.project.path = project.path;
    known.project.group = project.group;
    known.project.exists = project.exists;
    known.project.role = project.role;
    known.project.type = project.type;
    known.project.parent_id = project.parent_id;
    known.project.extension_id = project.extension_id;
  }
  const live = new Set(list.map((project) => project.id));
  for (const id of [...states.keys()]) {
    // The open project is never yanked out from under the human, even if the file dropped it.
    if (!live.has(id) && id !== active && !offPortfolio(id)) states.delete(id);
  }
  await refreshMainFolder();
  pulse.refreshPortfolio(projectNames());
  paintProjects();
}

/**
 * Do not expose the placeholder shell while native project discovery and the first dashboard
 * snapshot are still changing its shape. Two frames let the settled layout paint underneath the
 * opening screen before it fades away.
 */
function revealApp(): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.body.classList.remove("panel-booting");
      document.body.classList.add("panel-ready");
      // Outlives the 360ms opacity fade; removing the node is also what ends the warp loop.
      window.setTimeout(() => document.getElementById("panelBoot")?.remove(), 420);
    });
  });
}

function showBootError(error: unknown): void {
  const screen = document.getElementById("panelBoot");
  const message = document.getElementById("panelBootMessage");
  const retry = document.getElementById("panelBootRetry") as HTMLButtonElement | null;
  screen?.classList.add("is-error");
  screen?.setAttribute("role", "alert");
  if (message) message.replaceWith(errorNote("Panel could not open.", error));
  if (retry) {
    retry.hidden = false;
    retry.addEventListener("click", () => window.location.reload(), { once: true });
    retry.focus();
  }
  console.error("Panel startup failed", error);
}

void boot().then(revealApp).catch(showBootError);
