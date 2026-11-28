
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
import type { OpsMapHandle } from "./features/ops_map";
import type { OverviewData, Scout } from "./features/board_types";
import type { FleetChange, FleetHandle, FleetView } from "./features/fleet";
import { mountChat, type ChatHandle } from "./features/chat";
import { mountAskTray, type AskTrayHandle } from "./features/ask_tray";
import type { NotebookHandle } from "./features/notebook";
import type { SupportHandle } from "./features/support";
import { mountReview } from "./features/review";
import { mountLive, type LiveHandle, type LiveWorld } from "./features/live";
import { mountForYou, type ForYouHandle } from "./features/foryou";
import type { BoardFeed } from "./features/live_cards";
import { fetchHistory, mountHistory, sinceSeen, type HistoryHandle, type HistorySession } from "./features/history";
import type { InboxPost } from "./features/inbox_feed";
import { moduleGet } from "./features/modules";
import type { DesignData, TrustData } from "./features/fleet_design";
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

type CoreTab = "terminals" | "dash" | "files" | "debug" | "git" | "product-spine" | "release" | "revenuecat" | "analytics";
type Tab = CoreTab | `extension:${string}:${string}`;

type TurnWork = {
  prompt: string | null;
  files: WorkFile[];
  declared: boolean;
};

type ProjectState = {
  project: Project;
  stage: HTMLElement;
  workshop: WorkshopHandle;
  workBySession: Map<string, TurnWork>;
  status: string;
  detail: string;
  running: boolean;
  modules: Set<string>;
  tab: Tab;
  unseenStage: number;
  unseenFiles: number;
  sessions: Session[];
  activeSession: string | null;
  lastActive: number;
};

const states = new Map<string, ProjectState>();
let active: string | null = null;
const pulse = mountPulse({
  changed: () => paintProjectsSoon(),
  analyticsInstalled: () => moduleInstalled("analytics"),
});
const railCard = mountRailCard();

const exited = new Set<string>();
const unseenEdits = new Map<string, Set<string>>();
const closing = new Set<string>();
const working = new Set<string>();
const sessionPhase = new Map<string, "work" | "ask">();
const askSince = new Map<string, number>();
const asleep = new Map<string, number | null>();
let memory = new Map<string, { bytes: number | null; canSleep: boolean }>();
const touched = new Map<string, number>();
const launchedAt = Date.now();
const refused = new Map<string, number>();
const RETRY_REFUSED = 15 * 60_000;
function setPhase(sessionId: string, phase: "work" | "ask" | null): void {
  if (phase !== "ask") askSince.delete(sessionId);
  else if (sessionPhase.get(sessionId) !== "ask") askSince.set(sessionId, Date.now());
  if (phase) sessionPhase.set(sessionId, phase);
  else sessionPhase.delete(sessionId);
}

type Attention = "needs" | "done" | null;
const doneUnseen = new Set<string>();
const attentionOf = (here: ProjectState): Attention =>
  here.sessions.some((session) => sessionPhase.get(session.id) === "ask")
    ? "needs"
    : doneUnseen.has(here.project.id)
      ? "done"
      : null;
const lookingAt = (id: string): boolean =>
  document.hasFocus() &&
  (id === CPO_ID
    ? chatActive
    : active === id && !offProject());

type Alert = { title: string; body: string; urgent: boolean };
let badgeShown = -1;
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

function endPermissionWait(id: string, sessionId: string): void {
  if (sessionPhase.get(sessionId) !== "ask" || askTray.sessionAsking(sessionId)) return;
  setPhase(sessionId, "work");
  setStatus(id, "working");
}
const hasLiveSessions = (): boolean =>
  [...states.values()].some((here) => here.sessions.some((session) => !exited.has(session.id)));

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

let groups: Group[] = [];
const groupName = (id: string): string =>
  groups.find((group) => group.id === id)?.name ?? (id || "");

const projectList = el("projectList");
const projectFilter = el<HTMLInputElement>("projectFilter");
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
let opsMap: OpsMapHandle | null = null;
let opsMapLoading: Promise<OpsMapHandle> | null = null;
let opsMapActive = false;
let fleet: FleetHandle | null = null;
let fleetLoading: Promise<FleetHandle> | null = null;
let fleetActive = false;
let settingsFromOpsMap = false;
let chatFromOpsMap = false;
let support: SupportHandle | null = null;
let supportLoading: Promise<SupportHandle> | null = null;
let supportActive = false;
let reviewActive = false;
let review: ReturnType<typeof mountReview>;
let live: LiveHandle;
let liveActive = false;
let forYou: ForYouHandle;
let forYouActive = false;
let history: HistoryHandle;
let historyActive = false;
let terminals: TerminalsHandle;
let terminalsActive = false;
let settings: SettingsHandle;
let settingsActive = false;
let settingsFromWorkspace = false;
let settingsFromHome = false;
let settingsFromNotebook = false;
let runner: RunnerHandle;
let homeActive = false;
let notebookActive = false;
let chatActive = false;
let chatFromWorkspace = false;
let chatFromHome = false;
let chatFromNotebook = false;
let chatFromForYou = false;
let inboxPosts: InboxPost[] = [];
const POSTS_MAX = 500;
let runnerActive = false;
let chatSequence = 0;

async function runWithAgent(prompt: string): Promise<void> {
  if (!active) return;
  const session = await openSessionFor(active, "claude");
  if (!session) return;
  await invoke("write_terminal", { terminalId: session.terminal_id, data: `${prompt}\r` });
  jumpToSession(session.project, session.id);
}

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
  const data = command.includes("\n") ? `\x1b[200~${command}\x1b[201~` : `${command}\r`;
  try {
    await invoke("write_terminal", { terminalId: shell.terminal_id, data });
  } catch {
    return false;
  }
  jumpToSession(project, shell.id);
  return true;
}

let shutdownPromptOpen = false;

const CPO_ID = "appgea";

const offPortfolio = (id: string): boolean => id === CPO_ID || id === MAIN_ID;

function portfolioStates(): ProjectState[] {
  return [...states.values()].filter((here) => !offPortfolio(here.project.id));
}

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

function openPlace(project: string | null, place: Place, alongside: string[] = []): void {
  if (place.to === "manager") {
    chat.show();
    return;
  }
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


function state(id: string): ProjectState | undefined {
  return states.get(id);
}

const recentStamps = readStored<Record<string, number>>("panel-project-recent", {});

function touchProject(id: string): void {
  const here = state(id);
  if (!here) return;
  here.lastActive = Date.now();
  recentStamps[id] = here.lastActive;
  try {
    localStorage.setItem("panel-project-recent", JSON.stringify(recentStamps));
  } catch {
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
    modules: new Set<string>(),
    tab: defaultTab(project),
    unseenStage: 0,
    unseenFiles: 0,
    sessions: [],
    activeSession: null,
    lastActive: recentStamps[project.id] ?? 0,
  };
}

function tabEnabled(here: ProjectState, tab: Tab): boolean {
  const extension = extensionTabs.get(tab);
  if (extension) {
    return (
      activeExtensionModules.has(extension.module) &&
      (extension.every ? here.project.role === "leaf" : here.project.extension_id === extension.module) &&
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
  dropSettings();
  dropHome();
  dropChat();
  dropNotebook();
  dropOpsMap();
  dropFleet();
  dropSupport();
  dropHistory();
  dropReview();
  dropLive();
  dropForYou();
  exitTerminals();
  mainZone().hidden = false;
  const next = state(id);
  if (!next) return;
  active = id;
  markSeen(id);
  el("startAgentError").hidden = true;

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
    return { configured: false, enabled: ["git", "product-spine"], work_exclude: [] };
  });
  if (active !== id) return;
  next.modules = new Set(moduleConfig.enabled);
  syncModuleAvailability(next);
  if (requestedTab) next.tab = requestedTab;
  if (!tabEnabled(next, next.tab)) next.tab = defaultTab(next.project);
  showSessions();
  paintProjects();
  paintNav();
  setTab(next.tab);
  setStatus(id, next.status, next.detail);
  void refreshProject(id);
}


function showSessions(): void {
  const here = active ? state(active) : undefined;
  if (!here) return;

  if (here.activeSession && !here.sessions.some((s) => s.id === here.activeSession)) {
    here.activeSession = null;
  }
  if (!here.activeSession && here.sessions.length) {
    here.activeSession = here.sessions[here.sessions.length - 1].id;
  }

  strip.paint(here.sessions, here.activeSession, exited, asleep);
  el("terminalEmpty").hidden = here.sessions.length > 0;
  el("sessionStrip").hidden = here.sessions.length === 0;
  deck.show(projectTerminalVisible() ? here.activeSession : null);
  syncActiveWork(here);

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

let lastStartError = "";

async function openSessionFor(
  projectId: string,
  kind: SessionKind,
  cwd?: string,
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
    started = session;
    here.sessions.push(session);
    here.activeSession = session.id;
    touched.set(session.id, Date.now());
    touchProject(projectId); // Feeds the Recent order only — the rail never reorders itself.
    deck.add(session.id, session.terminal_id);
    if (isAgentKind(kind)) setStatus(projectId, "ready", here.project.name);
    if (active === projectId) showSessions();
    paintProjects();
    void refreshProject(projectId);
    return session;
  } catch (error) {
    lastStartError = String(error);
    console.error("[panel] start_session failed", { projectId, kind, error });
    if (started) {
      here.sessions = here.sessions.filter((s) => s.id !== started!.id);
      deck.remove(started.id);
      void invoke("stop_session", { session: started.id }).catch(() => undefined);
    }
    return null;
  }
}

async function restartSession(sessionId: string): Promise<void> {
  if (asleep.has(sessionId)) return wakeSession(sessionId);
  const owner = [...states.values()].find((here) => here.sessions.some((s) => s.id === sessionId));
  const session = owner?.sessions.find((s) => s.id === sessionId);
  if (!owner || !session || !exited.has(sessionId)) return;
  if (session.kind === "sim" || session.kind === "task") return;
  await closeSession(sessionId);
  const kind: SessionKind = session.kind;
  const next = await openSessionFor(owner.project.id, kind);
  if (!next) {
    await alertDialog(`${session.title} did not start again.\n\n${lastStartError || "Check that its CLI is installed."}`);
    return;
  }
  if (!terminalsActive) jumpToSession(next.project, next.id);
}


function typingIn(): string | null {
  if (!document.hasFocus()) return null;
  if (terminalsActive) return terminals?.focusedSession() ?? null;
  return active && !offProject() ? (state(active)?.activeSession ?? null) : null;
}

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

async function refreshMemory(): Promise<void> {
  const read = await invoke<Record<string, { bytes: number | null; canSleep: boolean }>>("session_memory")
    .catch(() => null);
  if (!read) return;
  memory = new Map(Object.entries(read));
  terminals?.paintMemory();
}

async function sleepSessions(ids: string[], asked: boolean): Promise<void> {
  const awake: string[] = [];
  await Promise.all(ids.map(async (id) => {
    if (asleep.has(id) || exited.has(id) || closing.has(id)) return;
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

function sleepUnused(): void {
  const minutes = PREF.sleepAfterMinutes();
  if (!minutes) return;
  const due = quietAgents(minutes * 60_000);
  if (due.length) void sleepSessions(due, false);
}

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
  owner.sessions = owner.sessions.map((s) => (s.id === sessionId ? woke : s));
  deck.wake(sessionId, woke.terminal_id);
  owner.running = true;
  setStatus(owner.project.id, "ready", owner.project.name);
  if (active === owner.project.id) showSessions();
  paintProjects();
  void refreshProject(owner.project.id);
  void refreshMemory();
}

function reviewAgent(projectId: string): Session | null {
  const here = state(projectId);
  if (!here) return null;
  const live = here.sessions.filter((s) => isAgentKind(s.kind) && !exited.has(s.id));
  return live.find((s) => s.id === here.activeSession) ?? live[live.length - 1] ?? null;
}

async function openSession(kind: SessionKind): Promise<boolean> {
  if (!active) return false;
  const session = await openSessionFor(active, kind);
  if (session) jumpToSession(session.project, session.id);
  return Boolean(session);
}

async function sessionBusy(sessionId: string): Promise<boolean> {
  if (working.has(sessionId)) return true;
  return invoke<boolean>("session_busy", { session: sessionId }).catch(() => true);
}

async function closeSession(sessionId: string): Promise<void> {
  const here = [...states.values()].find((candidate) =>
    candidate.sessions.some((s) => s.id === sessionId),
  );
  if (!here) return;
  const session = here.sessions.find((candidate) => candidate.id === sessionId);
  if (!session || closing.has(sessionId)) return;

  const liveAgent = !exited.has(sessionId) && isAgentKind(session.kind);
  if (!exited.has(sessionId) && (liveAgent || (await sessionBusy(sessionId)))) {
    const note = liveAgent
      ? "Its conversation and context are lost. This cannot be undone."
      : "Its running process will be stopped.";
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

const TAB_RUNS = 0;
const TAB_WALL = 1;

function showSettings(): void {
  if (settingsActive) return;
  dropChat();
  settingsFromWorkspace = terminalsActive;
  settingsFromHome = homeActive;
  settingsFromNotebook = notebookActive;
  settingsFromOpsMap = opsMapActive;
  if (terminalsActive) exitTerminals();
  dropHome();
  dropNotebook();
  dropOpsMap();
  dropFleet();
  dropSupport();
  dropHistory();
  dropReview();
  dropLive();
  dropForYou();
  settingsActive = true;
  mainZone().hidden = true;
  el("settingsScreen").hidden = false;
  settings.open();
  paintNav();
}

function dropSettings(): void {
  if (!settingsActive) return;
  settings.clear();
  settingsActive = false;
  el("settingsScreen").hidden = true;
}

function exitSettings(): void {
  if (!settingsActive) return;
  dropSettings();
  if (settingsFromWorkspace) {
    showTerminals();
  } else if (settingsFromHome) {
    showHome();
  } else if (settingsFromNotebook) {
    showNotebook();
  } else if (settingsFromOpsMap) {
    showOpsMap();
  } else {
    mainZone().hidden = false;
  }
  paintNav();
}

function showTerminals(at?: number): void {
  dropSettings();
  dropHome();
  dropChat();
  dropNotebook();
  dropOpsMap();
  dropFleet();
  dropSupport();
  dropHistory();
  dropReview();
  dropLive();
  dropForYou();
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

function showHome(): void {
  dropSettings();
  dropChat();
  dropNotebook();
  dropOpsMap();
  dropFleet();
  dropSupport();
  dropHistory();
  dropReview();
  dropLive();
  dropForYou();
  if (terminalsActive) exitTerminals();
  if (homeActive) return;
  homeActive = true;
  mainZone().hidden = true;
  el("homeScreen").hidden = false;
  if (projectFilter.value) projectFilter.value = "";
  home.open(homeProjects());
  paintNav();
  paintProjects(); // no project row may stay lit while Home is the screen
}

function dropHome(): void {
  if (!homeActive) return;
  home.clear();
  homeActive = false;
  el("homeScreen").hidden = true;
}

function showNotebook(): void {
  dropSettings();
  dropChat();
  if (terminalsActive) exitTerminals();
  dropHome();
  dropOpsMap();
  dropFleet();
  dropSupport();
  dropHistory();
  dropReview();
  dropLive();
  dropForYou();
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

function showOpsMap(): void {
  dropFleet();
  dropHistory();
  dropSettings();
  dropChat();
  dropNotebook();
  dropSupport();
  dropReview();
  dropLive();
  dropForYou();
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

function showFleet(): void {
  dropHistory();
  dropSettings();
  dropChat();
  dropNotebook();
  dropSupport();
  dropReview();
  dropLive();
  dropForYou();
  dropOpsMap();
  if (terminalsActive) exitTerminals();
  dropHome();
  if (fleetActive) return;
  fleetActive = true;
  mainZone().hidden = true;
  const screen = el("fleetScreen");
  screen.hidden = false;
  if (!fleet) screen.textContent = "Reading the fleet…";
  const loading = fleetLoading ?? import("./features/fleet").then(({ mountFleet }) => {
    fleet = mountFleet(screen, {
      view: () => moduleGet<FleetView>("/m/fleet/view"),
      day: (hours) => (moduleInstalled("scout") ? moduleGet<OverviewData>(`/m/scout/review/overview?hours=${hours}`).catch(() => null) : Promise.resolve(null)),
      commander: async () => {
        const agents = (await invoke<LiveWorld>("live_world")).agents;
        return agents.find((a) => commanderSession && a.panel === commanderSession) ?? agents.find((a) => a.commander) ?? null;
      },
      calls: async () => {
        if (!moduleInstalled("scout")) return null;
        const feed = await moduleGet<BoardFeed>("/m/scout/board").catch(() => null);
        if (!feed || "error" in feed) return null;
        return { you: feed.you ?? [], names: Object.fromEntries(Object.entries(feed.apps ?? {}).map(([k, v]) => [k.toLowerCase(), v.name])) };
      },
      changes: () => moduleGet<FleetChange[]>("/m/fleet/changes").then((c) => (Array.isArray(c) ? c : null)),
      openTerminal: (panel) => {
        const session = sessionById(panel);
        if (!session) return false;
        jumpToSession(session.project, session.id);
        return true;
      },
      newCommander,
      openIssue: (n) => void invoke("open_link", { url: `https://github.com/Appgea/ops/issues/${n}` }).catch((error: unknown) => console.warn("[panel] fleet", error)),
      design: {
        load: () => moduleGet<DesignData>("/m/fleet/design"),
        trust: () => moduleGet<TrustData>("/m/fleet/design/trust"),
        openFile: (path, line) => void openFullPath({ path, line }, false, null).catch((error: unknown) => console.warn("[panel] fleet design", error)),
      },
    });
    return fleet;
  });
  fleetLoading = loading;
  void loading
    .then((handle) => {
      if (fleetActive) handle.open();
    })
    .catch((error: unknown) => {
      fleetLoading = null;
      if (fleetActive) {
        screen.replaceChildren(errorNote("AI fleet could not open.", error, () => { dropFleet(); showFleet(); }));
      }
    });
  paintNav();
  paintProjects();
}

function dropFleet(): void {
  if (!fleetActive) return;
  fleet?.clear();
  fleetActive = false;
  el("fleetScreen").hidden = true;
}

let commanderSession: string | null = null;
async function tellCommander(words: string, from = "Overview"): Promise<boolean> {
  const said = words.replace(/\s+/g, " ").trim();
  const order = `The owner steers the fleet from Panel's ${from}: "${said}"`;
  if (commanderSession && (await deck.sendPrompt(commanderSession, order))) return true;
  commanderSession = await launchScout({ id: "commander", agent: "claude" } as Scout,
    `You are the fleet commander. Read ~/.appgeapanel/skills/fleet/SKILL.md, section "When he steers", and act on it. ${order}`,
    async () => undefined);
  return commanderSession !== null;
}

async function newCommander(): Promise<boolean> {
  const session = await launchScout({ id: "commander", agent: "claude" } as Scout,
    "You are the fleet commander. Read ~/.appgeapanel/skills/fleet/SKILL.md. Run `fleet status`, tell the owner in two lines how the fleet stands, then wait for his words.",
    async () => undefined);
  if (!session) return false;
  commanderSession = session;
  const opened = sessionById(session);
  if (opened) jumpToSession(opened.project, opened.id);
  return true;
}

async function launchScout(
  scout: Scout,
  prompt: string,
  started: (session: string) => Promise<unknown>,
): Promise<string | null> {
  const session = await openSessionFor(MAIN_ID, (scout.agent ?? "claude") as SessionKind);
  if (!session) return null;
  await started(session.id);
  const until = Date.now() + 20_000;
  while (!deck.pasteReady(session.id) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 250));
  if (scout.model && scout.agent === "claude") {
    await deck.sendPrompt(session.id, `/model ${scout.model}`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return (await deck.sendPrompt(session.id, prompt)) ? session.id : null;
}

function showSupport(): void {
  dropHistory();
  dropReview();
  dropLive();
  dropForYou();
  dropSettings();
  dropChat();
  dropNotebook();
  dropOpsMap();
  dropFleet();
  if (terminalsActive) exitTerminals();
  dropHome();
  if (supportActive) return;
  supportActive = true;
  mainZone().hidden = true;
  const screen = el("supportScreen");
  screen.hidden = false;
  if (!support) screen.textContent = "Opening support…";
  const loading = supportLoading ?? import("./features/support").then(({ mountSupport }) => {
    support = mountSupport(screen, { onUnread: () => undefined });
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

function showReview(projectId?: string): void {
  if (projectId && review.openProject(projectId)) return;
  dropLive();
  dropForYou();
  dropSupport();
  dropHistory();
  dropSettings();
  dropChat();
  dropNotebook();
  dropOpsMap();
  dropFleet();
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

function showLive(): void {
  dropSupport();
  dropReview();
  dropHistory();
  dropSettings();
  dropChat();
  dropNotebook();
  dropOpsMap();
  dropFleet();
  dropForYou();
  if (terminalsActive) exitTerminals();
  dropHome();
  if (liveActive) return;
  liveActive = true;
  mainZone().hidden = true;
  el("liveScreen").hidden = false;
  live.open();
  paintNav();
  paintProjects();
}

function dropLive(): void {
  if (!liveActive) return;
  live.clear();
  liveActive = false;
  el("liveScreen").hidden = true;
}

function showForYou(): void {
  dropSupport();
  dropReview();
  dropHistory();
  dropSettings();
  dropChat();
  dropNotebook();
  dropOpsMap();
  dropFleet();
  dropLive();
  if (terminalsActive) exitTerminals();
  dropHome();
  if (forYouActive) return;
  forYouActive = true;
  mainZone().hidden = true;
  el("forYouScreen").hidden = false;
  forYou.open();
  paintNav();
  paintProjects();
}

function dropForYou(): void {
  if (!forYouActive) return;
  forYou.clear();
  forYouActive = false;
  el("forYouScreen").hidden = true;
}

function showHistory(focus?: { query?: string; session?: string }): void {
  dropSupport();
  dropReview();
  dropLive();
  dropForYou();
  dropSettings();
  dropChat();
  dropNotebook();
  dropOpsMap();
  dropFleet();
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

function refreshHistorySignals(): void {
  void fetchHistory().then((data) => {
    const fresh = sinceSeen(data);
    home.away(fresh.map((session) => ({
      id: session.id,
      agent: session.agent,
      projectName: historyProjectName(session.project),
      title: session.title,
      at: Date.parse(session.endedAt),
    })));
  }).catch((error: unknown) => console.warn("[panel] history unavailable", error));
}

async function resumeConversation(session: HistorySession): Promise<string> {
  const started = await openSessionFor(session.project, session.agent as SessionKind, session.cwd, session.id);
  if (!started) throw new Error(lastStartError || "The conversation could not resume.");
  jumpToSession(started.project, started.id);
  return started.id;
}

function openHistoryFile(projectId: string, cwd: string, path: string): void {
  const root = state(projectId)?.project.path;
  const absolute = path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) ? path : `${cwd}/${path}`;
  const relative = root && absolute.startsWith(`${root}/`) ? absolute.slice(root.length + 1) : absolute;
  openPlace(projectId, { to: "work", path: relative });
}

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
    case "live":
      showLive();
      return;
    case "fleet":
      showFleet();
      return;
    case "support":
      showSupport();
      return;
    case "manager":
      chat.show();
      return;
    case "history":
      showHistory({ query: link.query, session: link.session });
      return;
    case "open":
      void openFullPath(link, false, null, true).catch((error: unknown) => console.warn("[panel] link", error));
      return;
    case "project":
      if (!state(link.project) || offPortfolio(link.project)) return;
      if (link.place) openPlace(link.project, link.place);
      else void select(link.project);
  }
}

function takeAppLinks(): void {
  void invoke<string[]>("take_links").then((urls) => urls.forEach(followAppLink)).catch(() => undefined);
}

function addPost(post: InboxPost): void {
  inboxPosts.push(post);
  if (inboxPosts.length > POSTS_MAX) inboxPosts.shift();
  void invoke("inbox_keep", { message: post }).catch((error: unknown) => console.warn("[panel] inbox keep", error));
  postsChanged();
}

function postsChanged(): void {
  const title = (post: InboxPost) => str(post.payload.title, str(post.payload.outcome, "Report"));
  for (const post of inboxPosts) {
    const known = lastReport.get(post.project);
    if (!known || known.at < post.at) lastReport.set(post.project, { id: post.id, title: title(post), at: post.at });
  }
  forYou?.refresh();
  paintProjectsSoon();
  home?.activity(
    inboxPosts.map((post) => ({
      id: post.id,
      project: post.project,
      projectName: post.projectName,
      author: post.author,
      agentKind: post.agentKind,
      title: title(post),
      at: post.at,
    })),
  );
}

async function loadKeptPosts(): Promise<void> {
  const kept = await invoke<Partial<InboxPost>[]>("inbox_messages");
  const good = kept.flatMap((row): InboxPost[] =>
    row && typeof row.id === "string" && typeof row.project === "string" && typeof row.at === "number" && row.payload && typeof row.payload === "object"
      ? [
          {
            id: row.id,
            project: row.project,
            projectName: str(row.projectName, row.project),
            author: str(row.author, "agent"),
            agentKind: str(row.agentKind, "agent"),
            session: typeof row.session === "string" ? row.session : null,
            flowFiles: Array.isArray(row.flowFiles) ? row.flowFiles : [],
            flowSteps: Array.isArray(row.flowSteps) ? row.flowSteps : [],
            at: row.at,
            view: row.view === "showcase" ? "showcase" : "message",
            payload: row.payload,
          },
        ]
      : [],
  );
  const have = new Set(inboxPosts.map((post) => post.id));
  inboxPosts = [...good.filter((post) => !have.has(post.id)), ...inboxPosts].sort((a, b) => a.at - b.at).slice(-POSTS_MAX);
  postsChanged();
}

function revealPost(postId: string): void {
  showForYou();
  forYou.reveal(postId);
}

function paintInboxBadge(count: number): void {
  const badge = el("forYouBadge");
  badge.textContent = count > 99 ? "99+" : String(count);
  badge.hidden = count === 0;
}

function showChat(): void {
  if (chatActive) return;
  chatFromWorkspace = terminalsActive;
  chatFromHome = homeActive;
  chatFromNotebook = notebookActive;
  chatFromOpsMap = opsMapActive;
  chatFromForYou = forYouActive;
  dropSettings();
  if (terminalsActive) exitTerminals();
  dropHome();
  dropNotebook();
  dropOpsMap();
  dropFleet();
  dropSupport();
  dropHistory();
  dropReview();
  dropLive();
  dropForYou();
  chatActive = true;
  mainZone().hidden = true;
  paintNav();
}

function dropChat(): void {
  if (!chatActive) return;
  chatActive = false;
  chat.hide();
}

function exitChat(): void {
  if (!chatActive) return;
  chatActive = false;
  if (chatFromWorkspace) {
    showTerminals();
  } else if (chatFromHome) {
    showHome();
  } else if (chatFromNotebook) {
    showNotebook();
  } else if (chatFromOpsMap) {
    showOpsMap();
  } else if (chatFromForYou) {
    showForYou();
  } else {
    mainZone().hidden = false;
  }
  paintNav();
}

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

const offProject = (): boolean =>
  terminalsActive ||
  homeActive ||
  settingsActive ||
  chatActive ||
  notebookActive ||
  opsMapActive ||
  fleetActive ||
  supportActive ||
  reviewActive ||
  liveActive ||
  forYouActive ||
  historyActive;

function focusedProjectId(): string | null {
  return (runnerActive ? runner.focusedProject() : null)
    ?? (terminalsActive ? terminals.focusedProject() : null)
    ?? active;
}

function toggleWall(): void {
  if (!terminalsActive) {
    showTerminals(TAB_WALL);
    return;
  }
  leaveWorkspace();
}

function toggleRuns(): void {
  if (!terminalsActive || terminals.pinnedAt() !== TAB_RUNS) {
    showTerminals(TAB_RUNS);
    return;
  }
  leaveWorkspace();
}

function leaveWorkspace(): void {
  const id = focusedProjectId();
  if (id) void select(id);
  else exitTerminals();
}

async function goSection(tab: Tab): Promise<void> {
  const id = focusedProjectId();
  if (!id) return;
  if (id !== active || offProject()) {
    await select(id, tab);
  } else {
    await setTab(tab);
  }
}

function stepRail(delta: number): void {
  const here = active ? state(active) : undefined;
  if (!here) return;
  const rungs = TABS.filter((entry) => tabEnabled(here, entry.tab) && !el(entry.button).hidden);
  if (!rungs.length) return;
  const at = Math.max(0, rungs.findIndex((entry) => entry.tab === here.tab));
  void setTab(rungs[(((at + delta) % rungs.length) + rungs.length) % rungs.length].tab);
}

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

function pushRunBar(): void {
  if (!terminalsActive) return;
  terminals.setRuns(
    runner.liveRuns().map((run) => ({
      ...run,
      name: state(run.project)?.project.name ?? run.name,
    })),
  );
}

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

function runExtraInstance(): void {
  const projectId = focusedProjectId();
  if (!projectId || !state(projectId)) return;
  void runner.ensureTargets().then(() => {
    showTerminals(TAB_RUNS);
    runner.highlight(projectId);
  });
}

function stopFocusedApp(): void {
  if (runnerActive && runner.closeActive()) return;
  const projectId = focusedProjectId();
  if (projectId && runner.projectRun(projectId)?.live) {
    void runner.stopProject(projectId);
    return;
  }
  const live = runner.liveRuns();
  if (live.length === 1) void runner.stopProject(live[0].project);
}

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

function jumpToSession(projectId: string, sessionId: string): void {
  const here = state(projectId);
  if (here) here.activeSession = sessionId;
  if (projectId === CPO_ID) {
    chat.show();
    return;
  }
  if (projectId === MAIN_ID) {
    showTerminals();
    terminals.reveal(sessionId);
    return;
  }
  void select(projectId, "terminals").then(() => {
    if (active === projectId && projectTerminalVisible()) deck.focus();
  });
}

function paintNav(): void {
  el("homeNav").classList.toggle("is-active", homeActive);
  el("homeButton").classList.toggle("is-on", homeActive);
  el("projectsSection").classList.toggle("home-up", homeActive);
  el("workspaceNav").classList.toggle("is-active", terminalsActive);
  const runsUp = terminalsActive && runnerActive;
  el("runButton").classList.toggle("is-on", runsUp);
  el("terminalsButton").classList.toggle("is-on", terminalsActive && !runsUp);
  const readingFromInbox = chatActive || supportActive || reviewActive || historyActive;
  el("chatNav").classList.toggle("is-active", readingFromInbox || liveActive || forYouActive);
  el("forYouButton").classList.toggle("is-on", forYouActive || readingFromInbox);
  el("liveButton").classList.toggle("is-on", liveActive);
  el("planNav").classList.toggle("is-active", notebookActive || opsMapActive || fleetActive);
  el("fleetButton").classList.toggle("is-on", fleetActive);
  el("opsMapButton").classList.toggle("is-on", opsMapActive);
  el("notebookButton").classList.toggle("is-on", notebookActive);
  el("settingsButton").classList.toggle("is-active", settingsActive);
}

function paintChatNav(): void {
  if (chat.isVisible()) markSeen(CPO_ID);
}

function projectTerminalVisible(): boolean {
  return !offProject() && !!active && state(active)?.tab === "terminals";
}

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
    el("gitDot").hidden = !git.is_repo || (git.dirty === 0 && git.ahead === 0);
    if (!offProject() && here.tab === "git") projectTools.git?.refresh();
  } catch (error) {
    console.error("[panel] project refresh failed", { project: id, error });
  }
}

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
const RECENT_ROWS = 12;
let showAllProjects = localStorage.getItem("panel-project-showall") === "1";

let manualOrder: string[] = readStored<string[]>("panel-project-order", []);
const pinned = new Set<string>(readStored<string[]>("panel-project-pins", []));
let liveOnly = false;
let quietOpen = localStorage.getItem("panel-rail-quiet") === "1";
const hostOf = new Map<string, string>();
let membersOf = new Map<string, string[]>();
const lastReport = new Map<string, { id: string; title: string; at: number }>();
let reviewCounts = new Map<string, number>();
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

function railCollapsed(): boolean {
  return (
    sortMode !== "lanes" &&
    !showAllProjects &&
    !liveOnly &&
    !projectFilter.value.trim() &&
    states.size > RECENT_ROWS
  );
}

function activeSort(): SortMode {
  return railCollapsed() ? "recent" : sortMode;
}

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


function membersFor(here: ProjectState): ProjectState[] {
  const ids = membersOf.get(here.project.id) ?? [here.project.id];
  return ids.map((id) => state(id)).filter((member): member is ProjectState => Boolean(member));
}

function unitAttention(members: ProjectState[]): "needs" | "done" | null {
  const all = members.map(attentionOf);
  return all.includes("needs") ? "needs" : all.includes("done") ? "done" : null;
}

function pinnedUnit(here: ProjectState): boolean {
  if (membersFor(here).some((member) => pinned.has(member.project.id))) return true;
  return (
    here.project.role === "collection" &&
    [...states.values()].some((child) => child.project.parent_id === here.project.id && pinned.has(child.project.id))
  );
}

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

function unitLane(here: ProjectState): Lane {
  const members =
    here.project.role === "collection"
      ? [...states.values()].filter((child) => child.project.parent_id === here.project.id)
      : membersFor(here);
  return members.map((member) => laneOf(factsOf(member))).reduce(urgent, "quiet" as Lane);
}

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

function laneHead(section: string, count: number): HTMLElement {
  const lane = LANES.find((entry) => entry.id === section);
  const label = section === "pinned" ? "Pinned" : lane?.label ?? section;
  if (section !== "quiet") {
    const head = document.createElement("div");
    head.className = "project-group lane-head";
    head.dataset.lane = section;
    head.title = lane?.hint ?? "Your pins, in your order";
    head.innerHTML = `<span></span>`;
    head.querySelector("span")!.textContent = label;
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

function decorateRow(row: HTMLElement, here: ProjectState, members: ProjectState[], attention: "needs" | "done" | null): void {
  if (here.project.role !== "leaf") return;
  const touched = Math.max(...members.map(touchedAt));
  row.classList.toggle("is-stale", touched > 0 && Date.now() - touched > STALE_AFTER && !attention);
}

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
      ? { title: report.title, age: age(report.at), open: () => revealPost(report.id) }
      : null,
    git: git?.is_repo ? [git.branch, chip?.title || "clean"].filter(Boolean).join(" · ") : "",
    activity: activity ? { spark: sparkSvg(activity), caption: `${commits} commits in 14 days · ${last}` } : null,
    signals,
    ask,
    actions,
  };
}

function jumpTargets(): string[] {
  const rows = [...projectList.querySelectorAll<HTMLElement>(".project-row")];
  const ids = (list: HTMLElement[]) => list.map((row) => row.dataset.projectId!).filter(Boolean);
  return [...ids(rows.filter((row) => row.classList.contains("is-pinned"))), ...ids(rows.filter((row) => !row.classList.contains("is-pinned")))];
}

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
  if (fresh) await new Promise((resolve) => window.setTimeout(resolve, 1500));
  deck.pastePaths(session.id, paths);
}

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

function projectNames(): Map<string, string> {
  const names = new Map<string, string>();
  for (const here of portfolioStates()) {
    names.set(here.project.name, here.project.id);
    names.set(here.project.name.toLowerCase(), here.project.id);
  }
  return names;
}

function paintProjects(): void {
  if (paintSoonTimer) {
    window.clearTimeout(paintSoonTimer);
    paintSoonTimer = 0;
  }
  if (dragging) {
    repaintQueued = true;
    return;
  }
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const before = new Map<string, number>();
  if (!reduce) {
    for (const child of projectList.children) {
      const rowId = (child as HTMLElement).dataset.projectId;
      if (rowId) before.set(rowId, child.getBoundingClientRect().top);
    }
  }
  const { query, action: queryAction } = parseQuery(projectFilter.value);
  membersOf = platformGroups(portfolioStates().map((here) => here.project));
  hostOf.clear();
  for (const [host, members] of membersOf) for (const id of members) if (id !== host) hostOf.set(id, host);
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
  const leaves = (list: typeof allProjects): number =>
    list.filter((here) => here.project.role === "leaf").length;
  const projectTotal = leaves(allProjects);
  projectLive.hidden = liveCount === 0;
  projectLive.setAttribute("aria-pressed", String(liveOnly));
  projectLive.querySelector("b")!.textContent = String(liveCount);
  projectsLabel.textContent = collapsed ? "Recent" : "Projects";
  projectSort.hidden = collapsed;
  projectSort.textContent = SORT_LABEL[sortMode];
  projectSort.title = SORT_HINT[sortMode];
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
  const groupOrder = new Map(groups.map((group, at) => [group.id, at]));
  const groupsOnScreen = new Set(visibleProjects.map((here) => here.project.group || ""));
  const sectioned = !laneMode && groupsOnScreen.size > 1;
  if (sectioned) {
    const rank = (id: string): number => groupOrder.get(id) ?? (id ? 500 : 999);
    visibleProjects.sort((a, b) => rank(a.project.group) - rank(b.project.group));
  }
  let openSection = "\u0000";
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
      const nextProject = visibleProjects[index + 1];
      if (pinned.has(here.project.id) && nextProject && !pinned.has(nextProject.project.id)) {
        row.classList.add("is-pin-last");
      }
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
      row.innerHTML = `<span class="project-icon"><span class="project-glyph"></span><i class="dot"></i></span><span class="project-label"><b></b></span><span class="project-meta"></span><span class="project-tools"><button class="project-pin" type="button" tabindex="-1"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6l-1 6 4 3v2H6v-2l4-3Z"/><path d="M12 14v7"/></svg></button><button class="project-more" type="button" tabindex="-1"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg></button></span>`;
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
      const speaks = line.tone !== "" && line.tone !== "mute";
      const mark = line.text;
      decorateRow(row, here, members, attention);
      row.title = speaks ? `${here.project.name} — ${mark}` : here.project.name;
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
  if (homeActive) home.sync(homeProjects());
  if (terminalsActive) terminals.sync(wallProjects());
  if (runnerActive) runner.sync(runnerProjects());
  signalAttention();
  repaintQueued = false;
}

let suppressRowClick = false;

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
    paintProjects();
  };

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}


type TabEntry = {
  tab: Tab;
  pane: HTMLElement;
  button: string;
  extension?: {
    module: string;
    mount: string;
    roles: string[];
    types: string[];
    every: boolean;
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
const moduleInstalled = (name: string): boolean => activeExtensionModules.has(name);

addEventListener("message", (event) => {
  const url = (event.data as { open?: unknown } | null)?.open;
  if (typeof url !== "string") return;
  if (![...extensionTabs.values()].some((entry) => entry.frame.contentWindow === event.source)) return;
  void invoke("open_link", { url }).catch((error: unknown) => console.warn("[panel] extension link", error));
});

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
        every: surface.every_project ?? false,
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
  el("fleetButton").hidden = !modules.some((module) => module.name === "fleet");
  if (!modules.some((module) => module.name === "support")) dropSupport();
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
  if (tab === "terminals") void runner.refreshTargets().then(syncProjectTerminals);
}

function syncProjectTerminals(): void {
  const here = active ? state(active) : undefined;
  if (!here) return;
  const run = runner.projectRun(here.project.id);
  projectTerminals.sync(here.sessions, exited, run);
  const alive = here.sessions.filter((session) => !exited.has(session.id));
  dashboard.setLive(
    run,
    alive.filter((session) => isAgentKind(session.kind)).length,
    alive.filter((session) => !isAgentKind(session.kind)).length,
  );
}


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


function placeOnStage(id: string, node: HTMLElement): void {
  const here = state(id);
  if (!here) return;
  node.classList.add("enter");
  here.stage.prepend(node);
  while (here.stage.childElementCount > 30) here.stage.lastElementChild?.remove();
  if (active === id) dashboard.syncStage();
  if (here.tab !== "dash" || active !== id) {
    here.unseenStage += 1;
    if (active === id) paintBadges();
  }
}

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

let paintSoonTimer = 0;
function paintProjectsSoon(): void {
  if (paintSoonTimer) return;
  paintSoonTimer = window.setTimeout(() => {
    paintSoonTimer = 0;
    paintProjects();
  }, 80);
}


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
      refreshSoon(id);
      break;
    }

    case "visual_requested":
      endPermissionWait(id, event.session_id);
      if (event.view === "message") {
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
        addPost({
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
        placeOnStage(id, renderView(event.view, event.payload, projectCtx(id)));
        break;
      }
      if (event.view === "showcase") {
        const here = state(id);
        const source = here?.sessions.find((session) => session.id === event.session_id);
        placeOnStage(id, renderView(event.view, event.payload, projectCtx(id)));
        addPost({
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
        if (!offProject() && active === id && here?.tab === "git") {
          projectTools.git?.playMoment(kind, event.payload);
        }
        void refreshProject(id);
        break;
      }
      if (event.view === "sim") {
        runner.onSim(id, event.session_id, event.payload);
        updateSimCard(id, event.payload);
        break;
      }
      placeOnStage(id, renderView(event.view, event.payload, ctx));
      break;

    case "ask_requested": {
      if (String(event.spec.kind ?? "").startsWith("team:")) {
        void answerTeam(id, event.qid, event.spec);
        break;
      }
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


type Wall = {
  savedAt: number;
  sessions: Array<{ session: Session; screen: string; asleep: boolean }>;
};

async function restoreWall(): Promise<void> {
  const none: Wall = { savedAt: 0, sessions: [] };
  deck.dropPending();
  const live = await invoke<Wall>("live_wall").catch((error) => {
    console.warn("[panel] the live sessions could not be read", error);
    return none;
  });
  adoptWall(live, false);
  const saved = await invoke<Wall>("restore_wall", { cols: 120, rows: 34 }).catch((error) => {
    console.warn("[panel] the wall could not be restored", error);
    return none;
  });
  adoptWall(saved, true);
}

function adoptWall(wall: Wall, forked: boolean): void {
  for (const { session, screen, asleep: slept } of wall.sessions) {
    const here = state(session.project);
    if (!here) {
      if (forked) void invoke("stop_session", { session: session.id }).catch(() => undefined);
      continue;
    }
    here.sessions.push(session);
    here.activeSession ??= session.id;
    if (slept) {
      asleep.set(session.id, null);
      exited.add(session.id);
    }
    here.running = here.sessions.some((s) => isAgentKind(s.kind) && !exited.has(s.id));
    deck.add(session.id, session.terminal_id, { screen, savedAt: forked ? wall.savedAt : undefined, asleep: slept });
  }
}

async function boot(): Promise<void> {
  mountModuleRailControls();
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

  askTray = mountAskTray({
    projectName: (id) => state(id)?.project.name ?? id,
    sessionName: (id) => sessionById(id)?.title ?? "agent",
    ctx: (id) => projectCtx(id),
    answer: (qid, value) => void invoke("answer_ask", { qid, value }),
    openSession: (project, session) => jumpToSession(project, session),
    changed: () => paintProjectsSoon(),
  });
  window.addEventListener("focus", () => {
    if (active && !offProject()) markSeen(active);
  });

  deck = new TerminalDeck(el("terminalHost"), {
    onInput(sessionId, data) {
      touched.set(sessionId, Date.now());
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
      askTray.closeSession(sessionId);
      chat.noteExit(sessionId);
      working.delete(sessionId);
      setPhase(sessionId, null);
      const owner = [...states.values()].find((here) =>
        here.sessions.some((s) => s.id === sessionId),
      );
      if (!owner) return;
      owner.running = owner.sessions.some((s) => isAgentKind(s.kind) && !exited.has(s.id));
      if (owner.project.id === active) {
        showSessions();
        void refreshProject(owner.project.id);
      }
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

  const liveWorld = () => invoke<LiveWorld>("live_world");
  const liveBoard = (fresh: boolean) => moduleGet<BoardFeed>(`/m/scout/board${fresh ? "?fresh=1" : ""}`).catch(() => null);
  const openLink = (url: string) => void invoke("open_link", { url }).catch((error: unknown) => console.warn("[panel] live", error));
  const openTerminal = (panel: string) => {
    const session = sessionById(panel);
    if (!session) return false;
    jumpToSession(session.project, session.id);
    return true;
  };
  live = mountLive(el("liveScreen"), {
    world: liveWorld,
    board: liveBoard,
    openUrl: openLink,
    openTerminal,
    sendToAgent: (panel, text) => deck.sendPrompt(panel, text),
    openFile: (path) => void openFullPath({ path }, false, null).catch((error: unknown) => console.warn("[panel] live", error)),
    openHistory: (session) => showHistory({ session }),
    stop: (pid) => invoke("live_stop", { pid }),
    fleet: () => (moduleInstalled("fleet") ? moduleGet<FleetView>("/m/fleet/view").catch(() => null) : Promise.resolve(null)),
    tellCommander: (words) => tellCommander(words, "Live"),
  });
  forYou = mountForYou(el("forYouScreen"), {
    sendToAgent: (panel, text) => deck.sendPrompt(panel, text),
    posts: () => inboxPosts,
    render: (post, openRef) =>
      renderView(post.view ?? "message", post.payload, { ...projectCtx(post.project), openRef }),
    renderFlow: (post, openRef) =>
      post.flowSteps.length
        ? renderView(
            "trace",
            { title: String(post.payload.title ?? "Agent flow"), steps: post.flowSteps },
            { ...projectCtx(post.project), openRef },
          )
        : null,
    changes: (project, path) => invoke<ChangeStep[]>("file_changes", { project, path }),
    readFile: (project, path) => invoke<string>("read_file", { project, path }),
    openRef: (project, ref) => projectCtx(project).openRef(ref),
    openSession: (project, session) => jumpToSession(project, session),
    isLiveSession: (session) => !exited.has(session) && sessionById(session) !== null,
    count: paintInboxBadge,
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
    onCount: () => forYou.refresh(),
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
  el("terminalEmptyStart").addEventListener("click", () => el<HTMLButtonElement>("startAgent").click());

  home = mountHome(el("homeScreen"), {
    openProject: (id, start) => openProjectFromHome(id, start),
    isExited: (sessionId) => exited.has(sessionId),
    projectGit: (id) =>
      pulse.git(id).then((git) => git ?? Promise.reject(new Error("no git snapshot"))),
    openPost: (postId) => revealPost(postId),
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
    visibility: (shown) => {
      if (shown) showChat();
      else exitChat();
      paintChatNav();
    },
  },
  {
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
      if (escape && (event.target as Element | null)?.closest?.(".cpo-term")) return;
      chat.hide();
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );

  terminals = mountTerminals(el("terminalsScreen"), {
    skills: (sessionId) => showSkills(sessionId),
    groups: () => groups.map(({ id, name }) => ({ id, name })),
    pinned: [
      {
        name: "Runs",
        glyph: "play",
        pane: () => el("runScreen"),
        show: () => {
          runnerActive = true;
          runner.open(runnerProjects());
          paintNav();
        },
        hide: () => {
          runnerActive = false;
          runner.clear();
          paintNav();
        },
        closeActive: () => runner.closeActive(),
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
  el("homeButton").addEventListener("click", () => showHome());
  paintChatNav();
  el("notebookButton").addEventListener("click", () => showNotebook());
  el("opsMapButton").addEventListener("click", () => showOpsMap());
  el("skillsButton").addEventListener("click", () => showSkills());
  el("fleetButton").addEventListener("click", () => showFleet());
  el("liveButton").addEventListener("click", () => showLive());
  el("forYouButton").addEventListener("click", () => showForYou());
  const paintNotebookHint = (): void => {
    el("notebookButton").title = `Notebook (${chordLabel("app.notebook")})`;
  };
  paintNotebookHint();
  window.addEventListener(KEYMAP_EVENT, paintNotebookHint);

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

  runner = mountRunner(el("runScreen"), {
    start: (projectId, target, allowExtra, extraInstance, restart, fresh) =>
      invoke<SimStart>("start_sim", {
        project: projectId,
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
    focus: (address) => void invoke("sim_focus", { address: address ?? null }).catch(() => undefined),
    openServer: (projectId) => void invoke("open_server", { project: projectId }).catch(() => undefined),
    jump: (projectId, sessionId) => jumpToSession(projectId, sessionId),
    isExited: (sessionId) => exited.has(sessionId),
  });
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
  window.addEventListener(
    "keydown",
    (event) => {
      if (isRecording() || isLightboxOpen()) return;
      if (event.repeat) return;
      if (matchesShortcut(event, "Meta+Shift+KeyM")) {
        chat.toggle();
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (!matchesShortcut(event, "Meta+Shift+KeyC", "Ctrl+Alt+KeyC")) return;
      showForYou();
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

  window.addEventListener(
    "keydown",
    (event) => {
      if (isRecording() || isLightboxOpen()) return;
      if (event.repeat || !/^Digit[1-9]$/.test(event.code)) return;
      if (!matchesShortcut(event, `Meta+${event.code}`)) return;
      const at = Number(event.code.slice(5)) - 1;
      if (terminalsActive) {
        if (terminals.digit(at)) {
        } else if (document.body.classList.contains("single-project")) {
          if (at !== 0) return;
          showTerminals(TAB_WALL);
        } else {
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
      if (offProject() || !active) return;
      if (chordMatches(event, "tab.next")) return go(() => stepRail(1));
      if (chordMatches(event, "tab.prev")) return go(() => stepRail(-1));
    },
    true,
  );

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

  window.addEventListener(
    "keydown",
    (event) => {
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

  window.addEventListener("keydown", (event) => {
    if (isRecording() || isLightboxOpen() || offProject() || event.repeat) return;
    if (!chordMatches(event, "term.fullscreen")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void setTab("terminals").then(() => deck.focus());
  }, true);

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
  void invoke("cancel_shutdown").catch(() => undefined);

  const context = await invoke<{ single_project: string | null }>("launch_context");
  document.body.classList.toggle("single-project", !!context.single_project);
  await refreshProjectSurfaces();
  groups = await invoke<Group[]>("list_groups").catch(() => []);
  const list = await invoke<Project[]>("list_projects");
  for (const project of list) states.set(project.id, makeState(project));
  const manager = await invoke<Project>("manager_project").catch(() => null);
  if (manager && !states.has(CPO_ID)) states.set(CPO_ID, makeState({ ...manager, name: "Manager" }));
  await refreshMainFolder();
  pulse.refreshPortfolio(projectNames());
  await restoreWall();
  paintProjects();
  const single = context.single_project
    ? list.find((project) => project.id === context.single_project) ?? list[0]
    : undefined;
  if (single) {
    await select(single.id);
  } else {
    showHome();
  }

  void loadKeptPosts().catch((error: unknown) => console.warn("[panel] inbox load", error));
  await listen<ProjectEvent>("panel-agent-event", ({ payload }) => onEvent(payload));
  await listen<Wall["sessions"][number]>("panel-session-opened", ({ payload }) => {
    if (sessionById(payload.session.id)) return;
    adoptWall({ savedAt: 0, sessions: [payload] }, false);
    if (active === payload.session.project) showSessions();
    paintProjects();
  });
  await listen("panel-portfolio-changed", () => void refreshPortfolio());
  await listen("panel-ops-changed", () => opsMap?.sync());
  await listen("panel-link", takeAppLinks);
  takeAppLinks();
  refreshHistorySignals();
  window.setInterval(refreshHistorySignals, 3 * 60_000);
  void refreshMemory();
  window.setInterval(() => void refreshMemory(), 20_000);
  window.setInterval(sleepUnused, 60_000);

  for (const entry of TABS) {
    if (!entry.extension) el(entry.button).addEventListener("click", () => setTab(entry.tab));
  }

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

  window.addEventListener("keydown", (event) => {
    if (event.key !== "F5" || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
    if (document.querySelector(".skills-overlay")) return;
    const here = active ? state(active) : undefined;
    if (!here || !tabEnabled(here, "debug")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void setTab("debug").then(() => projectTools.debugger?.start());
  }, true);

  window.addEventListener(
    "keydown",
    (event) => {
      if (isRecording() || isLightboxOpen() || document.querySelector(".skills-overlay")) return;
      if (
        !matchesShortcut(event, "Meta+KeyW") ||
        event.repeat
      ) {
        return;
      }
      if (terminalsActive && terminals.closeActive()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      const here = active ? state(active) : undefined;
      if (!here) return;
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

  projectSort.addEventListener("click", () => {
    sortMode =
      sortMode === "lanes" ? "manual" : sortMode === "manual" ? "recent" : sortMode === "recent" ? "name" : "lanes";
    saveOrder();
    listHot = false;
    paintProjects();
  });

  projectLive.addEventListener("click", () => {
    liveOnly = !liveOnly;
    paintProjects();
  });

  projectShowAll.addEventListener("click", () => {
    showAllProjects = !showAllProjects;
    localStorage.setItem("panel-project-showall", showAllProjects ? "1" : "0");
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
        icon: `<b>${here.project.name.trim().charAt(0).toUpperCase()}</b><img src="${projectIconUrl(here.project.id)}" alt="" onerror="this.remove()" />`,
        label: here.running ? "live" : "",
        name: here.project.name,
      })),
    }),
  });

  window.addEventListener(
    "keydown",
    (event) => {
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

  settings = mountSettings(el("settingsScreen"), {
    close: () => exitSettings(),
    skills: () => showSkills(),
  });
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

  const themeToggle = el("themeToggle");
  const paintToggle = (theme: string) => {
    themeToggle.innerHTML = icon(theme === "light" ? "moon" : "sun");
    themeToggle.title = theme === "light" ? "Switch to dark theme" : "Switch to light theme";
  };
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
    }
    window.dispatchEvent(new Event("panel-theme-change"));
    paintToggle(next);
    syncWindowChrome(next);
  });

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

async function addProject(): Promise<void> {
  let path: string | null = null;
  try {
    path = await invoke<string | null>("pick_project_folder");
  } catch {
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
    if (!live.has(id) && id !== active && !offPortfolio(id)) states.delete(id);
  }
  await refreshMainFolder();
  pulse.refreshPortfolio(projectNames());
  paintProjects();
}

function revealApp(): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.body.classList.remove("panel-booting");
      document.body.classList.add("panel-ready");
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
