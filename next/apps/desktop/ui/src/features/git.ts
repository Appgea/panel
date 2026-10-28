/**
 * Git as one spine of time. See ../../../../GIT.md.
 *
 * THREE REGIONS. Next Move at the top: one sentence, one button, always. The Spine on the left:
 * everything in time, newest up — waiting work, then commits, with the remote drawn as a line at
 * the exact place the remote is. Focus on the right: whatever the spine currently points at, with
 * the verb that acts on it living there and nowhere else.
 *
 * THE TURN IS THE UNIT. Waiting files are grouped by agent turn (from the hook events main.ts
 * already receives) before they are grouped by intent. One press commits a turn with its prompt.
 *
 * HONEST MOTION. Nothing moves unless git is doing that thing right now. A class goes on while the
 * request is in flight and comes off when the refreshed status lands.
 */

import { invoke } from "@tauri-apps/api/core";
import { moduleGet, modulePost } from "./modules";
import { errorText } from "../errors";
import { alertDialog, confirmDialog, promptDialog } from "../views/dialog";
import { icon } from "../icons";
import { fileExtension, isImagePath, projectAssetUrl } from "../project-assets";
import { openGitSweep } from "./git-sync";
import { withViewTransition } from "../motion";
import "../motion.css";
import "./git.css";

const M = "/m/git-manager";
const GIT_JOBS_EVENT = "panel-git-jobs-changed";

/* ------------------------------------------------------------------ types */

type Repo = { root: string; name: string; enclosing?: boolean };
type FileEntry = { path: string; code?: string; oldPath?: string };
type Branch = { name: string; current?: boolean; upstream?: string; age?: string; old?: boolean };
type Remote = { name: string; url: string };
type Status = {
  branch?: string;
  detached?: boolean;
  ahead?: number;
  behind?: number;
  staged?: FileEntry[];
  unstaged?: FileEntry[];
  untracked?: string[];
  conflicts?: FileEntry[];
  operation?: string;
  stashCount?: number;
  latestStash?: string;
  branches?: Branch[];
  remotes?: Remote[];
  error?: string;
};
type CommitRef = { name: string; type: "head" | "branch" | "remote" | "tag" };
type Commit = {
  sha: string;
  short: string;
  subject: string;
  author: string;
  age: string;
  parents?: string[];
  refs?: CommitRef[];
};
type Graph = { error?: string; commits?: Commit[]; head?: string };
type GitOverview = { status: Status; graph: Graph };
type CommitDetail = Commit & {
  body?: string;
  date?: string;
  email?: string;
  files?: { path: string; adds: number | null; dels: number | null }[];
  adds?: number;
  dels?: number;
  error?: string;
};
type ChangeKind = "conflict" | "staged" | "unstaged" | "untracked";
type Change = FileEntry & { kind: ChangeKind; key: string };
type AtlasRepo = {
  path: string;
  name: string;
  branch: string;
  remote: string;
  ahead?: number;
  behind?: number;
  dirty?: number;
  hasUpstream?: boolean;
};

/** One agent turn as main.ts knows it: the prompt, the files it touched, whether it is still going. */
export type GitTurn = {
  session: string;
  agent: string;
  prompt: string | null;
  /** Project-relative paths. */
  files: string[];
  live: boolean;
};

export type GitHandle = {
  setProject(projectId: string, path: string): void;
  refresh(): void;
  /** An agent just moved the repo through its own terminal. Say so and re-read. */
  playMoment(kind: string, payload?: Record<string, unknown>): void;
};

export type GitProject = { id: string; name: string; path: string };

export type GitEvents = {
  projects(): GitProject[];
  selectProject(id: string): void;
  /** Open a project agent and submit this task as its first prompt. */
  commitAllWithAgent(prompt: string): Promise<void>;
  /** The selected project's agent turns, most recent first. */
  turns(projectId?: string): GitTurn[];
  /** Atlas row clicked: select that project. */
  openProject(path: string): void;
};

type Card = {
  id: string;
  kind: "conflict" | "turn" | "yours";
  title: string;
  agent: string | null;
  prompt: string | null;
  live: boolean;
  changes: Change[];
};

type Spine = {
  stones: Commit[];
  /** Commits the remote has and the branch lacks, newest first. */
  incoming: Commit[];
  /** Stones before this index are not on the remote. */
  lineAt: number;
  upstream: string | null;
};

type Pick =
  | { kind: "card"; id: string }
  | { kind: "file"; key: string }
  | { kind: "stone"; sha: string }
  | { kind: "line" }
  | null;

type Move = {
  tone: "stuck" | "work" | "sync" | "calm" | "wait";
  text: string;
  act?: string;
  label?: string;
};

type Motion = "commit" | "send" | "bring" | "merge" | null;

type SafetyNote = { text: string; label: string; act: string; until: number };

/* ---------------------------------------------------------------- helpers */

const esc = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      (({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }) as Record<
        string,
        string
      >)[c] ?? c,
  );

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

const fileName = (path: string): string => path.split("/").pop() || path;
const parentPath = (path: string): string => path.split("/").slice(0, -1).join("/");
const changeKey = (kind: ChangeKind, path: string): string => `${kind}:${path}`;
const uniquePaths = (changes: FileEntry[]): string[] => [...new Set(changes.map((change) => change.path))];

function firstLine(text: string | null | undefined, max = 72): string {
  const line = (text ?? "").split("\n").find((part) => part.trim()) ?? "";
  const clean = line.trim().replace(/\s+/g, " ");
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/** Commit messages read as a verb in the imperative; a prompt often arrives as "please add". */
function messageFromPrompt(prompt: string | null): string {
  const line = firstLine(prompt, 72)
    .replace(/^(please|can you|could you|now|then|also|ok|okay)[,\s]+/i, "")
    .replace(/[.!?]+$/, "");
  return line ? line[0].toUpperCase() + line.slice(1) : "";
}

const KIND_LABEL: Record<ChangeKind, string> = {
  conflict: "conflict",
  staged: "staged",
  unstaged: "modified",
  untracked: "new",
};

/* ---------------------------------------------------------------- mount */

/** Each project keeps its own requests, drafts and operations while another is visible. */
export function mountGit(host: HTMLElement, events: GitEvents): GitHandle {
  const projects = new Map<string, { node: HTMLElement; handle: GitHandle }>();
  const busyRepos = new Set<string>();
  let selected: GitHandle | null = null;
  return {
    setProject(id, path) {
      let project = projects.get(id);
      if (!project) {
        const node = document.createElement("div");
        const handle = mountProjectGit(node, {
          ...events,
          turns: () => events.turns(id),
        }, busyRepos);
        project = { node, handle };
        projects.set(id, project);
      }
      // Detached views keep their operation state without doing visible diff work.
      host.replaceChildren(project.node);
      selected = project.handle;
      selected.setProject(id, path);
    },
    refresh: () => selected?.refresh(),
    playMoment: (kind, payload) => selected?.playMoment(kind, payload),
  };
}

/** Bound read waits only. A write never becomes retryable while it may still run. */
function gitRead<T>(request: Promise<T>, timeout = 30_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("Git is taking too long. Try again.")), timeout);
    request.then(resolve, reject).finally(() => window.clearTimeout(timer));
  });
}

function mountProjectGit(host: HTMLElement, events: GitEvents, busyRepos: Set<string>): GitHandle {
  host.className = "pane git-pane git-project-view";
  host.tabIndex = -1;
  host.innerHTML = `
    <div class="git-shell">
      <div class="git-activity" role="status" aria-live="polite" hidden></div>
      <header class="git-move" aria-live="polite"></header>
      <div class="git-body">
        <section class="git-spine" aria-label="Timeline">
          <div class="spine-head"></div>
          <div class="spine-scroll"></div>
        </section>
        <section class="git-focus" aria-label="Detail"></section>
        <aside class="git-drawer" hidden aria-label="Branches"></aside>
        <div class="git-atlas" hidden aria-label="All repositories"></div>
        <div class="stone-menu" hidden role="menu"></div>
      </div>
      <footer class="git-safety"></footer>
    </div>`;

  const activity = host.querySelector<HTMLElement>(".git-activity")!;
  const body = host.querySelector<HTMLElement>(".git-body")!;
  const moveBar = host.querySelector<HTMLElement>(".git-move")!;
  const spineHead = host.querySelector<HTMLElement>(".spine-head")!;
  const spineScroll = host.querySelector<HTMLElement>(".spine-scroll")!;
  const focus = host.querySelector<HTMLElement>(".git-focus")!;
  const drawer = host.querySelector<HTMLElement>(".git-drawer")!;
  const atlas = host.querySelector<HTMLElement>(".git-atlas")!;
  const stoneMenu = host.querySelector<HTMLElement>(".stone-menu")!;
  const safety = host.querySelector<HTMLElement>(".git-safety")!;

  let projectPath = "";
  let projectId = "";
  let repos: Repo[] = [];
  let repo = "";
  let status: Status = {};
  let graph: Graph = {};
  let spine: Spine = { stones: [], incoming: [], lineAt: 0, upstream: null };
  let cards: Card[] = [];
  let pick: Pick = null;
  /** Files unticked on a card, per card id. Ticked is the default, so only exclusions are kept. */
  const leftOut = new Map<string, Set<string>>();
  const drafts = new Map<string, string>();
  let branchQuery = "";
  let refreshSerial = 0;
  let refreshTask: Promise<void> | null = null;
  let refreshAgain = false;
  let pendingTransition: "git-commit" | "git-send" | undefined;
  let focusSerial = 0;
  let mutating = false;
  let motion: Motion = null;
  let phaseWord = "";
  let phaseTimer = 0;
  let receipt: { text: string; ok: boolean } | null = null;
  let receiptTimer = 0;
  let safetyNote: SafetyNote | null = null;
  let safetyTimer = 0;
  let previousHead = "";
  let atlasRows: AtlasRepo[] | null = null;
  let focusError = "";
  let reading = false;
  let readError = "";
  let diffObserver: IntersectionObserver | null = null;
  let diffRevision = 0;
  const diffCache = new Map<string, string>();
  const diffPending = new Map<string, Promise<string>>();
  let diffRunning = 0;
  const diffQueue: Array<() => void> = [];

  const isBrowseAction = (act: string): boolean =>
    ["refresh", "drawer", "atlas", "previous-file", "next-file", "focus-conflicts", "retry-diff", "retry-focus"].includes(act)
    || act.startsWith("review-card:");

  function syncBusyControls(): void {
    const busy = mutating || busyRepos.has(repo);
    for (const control of host.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement>("button[data-act], input[data-tick], .commit-msg")) {
      if (isBrowseAction(control.dataset.act ?? "")) continue;
      if (busy && !control.disabled) {
        control.dataset.gitBusyDisabled = "1";
        control.disabled = true;
      } else if (!busy && control.dataset.gitBusyDisabled) {
        delete control.dataset.gitBusyDisabled;
        control.disabled = false;
      }
    }
  }

  function renderActivity(): void {
    const message = mutating
      ? `${phaseWord || (motion ? { commit: "Committing", send: "Sending", bring: "Bringing in", merge: "Merging" }[motion] : "Updating Git")}… You can switch projects.`
      : busyRepos.has(repo) ? "This repository is updating in another project. You can keep browsing."
      : reading ? "Reading changes and history… You can keep browsing." : readError;
    activity.hidden = !message;
    activity.classList.toggle("is-error", !!readError && !reading && !mutating);
    activity.innerHTML = message ? `<span>${esc(message)}</span>${readError && !reading && !mutating ? '<button class="gbtn mini" type="button" data-act="refresh">Retry</button>' : ""}` : "";
    body.setAttribute("aria-busy", String(reading));
  }

  window.addEventListener(GIT_JOBS_EVENT, (event) => {
    const job = (event as CustomEvent<{ repo: string; owner: HTMLElement }>).detail;
    if (job.repo !== repo || job.owner === host) return;
    syncBusyControls();
    renderActivity();
    if (!mutating && !busyRepos.has(repo) && host.isConnected) void refresh();
  });

  function loadingView(message: string): string {
    return `<div class="git-loading" role="status"><span>${esc(message)}</span><div class="git-loading-lines" aria-hidden="true"><i></i><i></i><i></i></div></div>`;
  }


  /* ------------------------------------------------------------ paths */

  const clean = (value: string): string => value.replaceAll("\\", "/").replace(/\/+$/, "");

  /** A repo-relative change path as the project sees it, or null when it lives outside. */
  function projectRelative(path: string): string | null {
    const projectRoot = clean(projectPath);
    const absolute = path.startsWith("/") ? clean(path) : `${clean(repo)}/${clean(path)}`;
    if (absolute === projectRoot) return "";
    return absolute.startsWith(`${projectRoot}/`) ? absolute.slice(projectRoot.length + 1) : null;
  }

  function assetUrl(path: string): string | null {
    const relative = projectRelative(path);
    if (!projectId || relative === null) return null;
    return projectAssetUrl(projectId, relative);
  }

  /* ------------------------------------------------------------ model */

  function allChanges(): Change[] {
    const order: Record<ChangeKind, number> = { conflict: 0, staged: 1, unstaged: 2, untracked: 3 };
    return [
      ...(status.conflicts ?? []).map((entry) => ({ ...entry, kind: "conflict" as const })),
      ...(status.staged ?? []).map((entry) => ({ ...entry, kind: "staged" as const })),
      ...(status.unstaged ?? []).map((entry) => ({ ...entry, kind: "unstaged" as const })),
      ...(status.untracked ?? []).map((path) => ({ path, code: "?", kind: "untracked" as const })),
    ]
      .map((entry) => ({ ...entry, key: changeKey(entry.kind, entry.path) }))
      .sort((a, b) => order[a.kind] - order[b.kind] || a.path.localeCompare(b.path));
  }

  /** Waiting work, grouped by who made it and in which turn. Conflicts always come first. */
  function buildCards(): Card[] {
    const changes = allChanges();
    const out: Card[] = [];
    const conflicts = changes.filter((change) => change.kind === "conflict");
    if (conflicts.length) {
      out.push({
        id: "conflicts",
        kind: "conflict",
        title: "Needs resolution",
        agent: null,
        prompt: null,
        live: false,
        changes: conflicts,
      });
    }
    const taken = new Set<string>(conflicts.map((change) => change.path));
    // A file edited in two turns belongs to the latest one — that is the turn you are judging.
    for (const turn of events.turns()) {
      const wanted = new Set(turn.files.map(clean));
      const mine = changes.filter((change) => {
        if (taken.has(change.path)) return false;
        const relative = projectRelative(change.path);
        return relative !== null && wanted.has(relative);
      });
      if (!mine.length && !turn.live) continue;
      mine.forEach((change) => taken.add(change.path));
      out.push({
        id: `turn:${turn.session}`,
        kind: "turn",
        title: firstLine(turn.prompt, 64) || `${turn.agent} turn`,
        agent: turn.agent,
        prompt: turn.prompt,
        live: turn.live,
        changes: mine,
      });
    }
    const yours = changes.filter((change) => !taken.has(change.path));
    if (yours.length) {
      out.push({
        id: "yours",
        kind: "yours",
        title: "Your edits",
        agent: null,
        prompt: null,
        live: false,
        changes: yours,
      });
    }
    return out;
  }

  /**
   * The branch's own line of history, and where the remote sits on it. Walks first parents from
   * HEAD; the upstream ref is found among the commits and its position is the line. When the
   * remote has moved on, the commits between its tip and the shared history are the ghosts.
   */
  function buildSpine(): Spine {
    const commits = graph.error ? [] : (graph.commits ?? []);
    const bySha = new Map(commits.map((commit) => [commit.sha, commit]));
    const stones: Commit[] = [];
    const onSpine = new Set<string>();
    let cursor = graph.head ?? "";
    while (cursor && bySha.has(cursor) && !onSpine.has(cursor)) {
      const commit = bySha.get(cursor)!;
      stones.push(commit);
      onSpine.add(commit.sha);
      cursor = commit.parents?.[0] ?? "";
    }

    const upstream = status.branches?.find((branch) => branch.current)?.upstream || null;
    if (!upstream) return { stones, incoming: [], lineAt: stones.length, upstream: null };

    const tip = commits.find((commit) =>
      (commit.refs ?? []).some((ref) => ref.type === "remote" && ref.name === upstream),
    );
    if (!tip) {
      // Beyond the graph window. Trust the count git gave us for the position.
      return { stones, incoming: [], lineAt: Math.min(status.ahead ?? 0, stones.length), upstream };
    }
    const incoming: Commit[] = [];
    let walker: Commit | undefined = tip;
    const seen = new Set<string>();
    while (walker && !onSpine.has(walker.sha) && !seen.has(walker.sha)) {
      incoming.push(walker);
      seen.add(walker.sha);
      walker = bySha.get(walker.parents?.[0] ?? "");
    }
    const lineAt = walker ? stones.findIndex((stone) => stone.sha === walker!.sha) : stones.length;
    return { stones, incoming, lineAt: lineAt < 0 ? stones.length : lineAt, upstream };
  }

  function cardById(id: string): Card | undefined {
    return cards.find((card) => card.id === id);
  }

  function changeByKey(key: string): Change | undefined {
    return allChanges().find((change) => change.key === key);
  }

  function stoneBySha(sha: string): Commit | undefined {
    return spine.stones.find((stone) => stone.sha === sha) ?? spine.incoming.find((stone) => stone.sha === sha);
  }

  /** Which files a card will commit: everything on it minus what was unticked. */
  function cardPaths(card: Card): string[] {
    const out = leftOut.get(card.id);
    return uniquePaths(card.changes.filter((change) => !out?.has(change.path)));
  }

  function cardDraft(card: Card): string {
    return drafts.get(card.id) ?? messageFromPrompt(card.prompt);
  }

  function stuck(): boolean {
    return Boolean(status.operation) || Boolean(status.conflicts?.length);
  }

  /**
   * The ladder. First match wins, and it is the same order a careful person would pick by hand,
   * so the button never suggests something wrong.
   */
  function nextMove(): Move {
    if (!repo) return { tone: "calm", text: "No repository here." };
    const conflicts = status.conflicts?.length ?? 0;
    if (status.operation || conflicts) {
      const what = status.operation ? `${status.operation[0].toUpperCase()}${status.operation.slice(1)} stopped` : "Conflicts";
      if (conflicts) {
        return { tone: "stuck", text: `${what} on ${plural(conflicts, "file")}.`, act: "focus-conflicts", label: "Resolve" };
      }
      return { tone: "stuck", text: `${what}. Everything is resolved.`, act: "continue-operation", label: "Continue" };
    }
    const live = cards.find((card) => card.live);
    const ready = cards.filter((card) => card.kind !== "conflict" && !card.live && card.changes.length);
    if (ready.length) {
      const card = ready[0];
      const who = card.kind === "turn" ? `${card.agent}’s turn` : "You";
      const verb = card.kind === "turn" ? "left" : "changed";
      return {
        tone: "work",
        text: `${who} ${verb} ${plural(uniquePaths(card.changes).length, "file")}.`,
        act: `review-card:${card.id}`,
        label: "Review changes",
      };
    }
    if (live) {
      return {
        tone: "wait",
        text: `${live.agent} is still writing. ${plural(live.changes.length, "file")} so far.`,
      };
    }
    if (!status.remotes?.length) {
      return { tone: "sync", text: "Clean. No remote to send to.", act: "add-remote", label: "Add remote" };
    }
    if (!spine.upstream) {
      return { tone: "sync", text: `${status.branch} is not tracking a remote yet.`, act: "send", label: "Send & track" };
    }
    if (status.behind) {
      return { tone: "sync", text: `${plural(status.behind, "commit")} waiting at ${spine.upstream}.`, act: "bring", label: "Bring in" };
    }
    if (status.ahead) {
      return { tone: "sync", text: `${plural(status.ahead, "commit")} not sent.`, act: "send", label: "Send" };
    }
    return { tone: "calm", text: "In sync. Clean." };
  }

  /* ------------------------------------------------------------ loading */

  async function open(): Promise<void> {
    const serial = ++refreshSerial;
    ++focusSerial;
    repos = [];
    repo = "";
    status = {};
    graph = {};
    cards = [];
    spine = { stones: [], incoming: [], lineAt: 0, upstream: null };
    pick = null;
    leftOut.clear();
    drafts.clear();
    window.clearTimeout(safetyTimer);
    window.clearTimeout(receiptTimer);
    safetyNote = null;
    receipt = null;
    focusError = "";
    previousHead = "";
    closeStoneMenu();
    closeDrawer();
    closeAtlas();
    reading = true;
    readError = "";
    renderActivity();
    renderDetecting();
    if (!projectPath) return;

    try {
      const found = await gitRead(moduleGet<{ repos?: Repo[]; error?: string }>(
        `${M}/repos?path=${encodeURIComponent(projectPath)}`,
      ));
      if (serial !== refreshSerial) return;
      if (found.error) throw new Error(found.error);
      repos = found.repos ?? [];
    } catch (error) {
      if (serial !== refreshSerial) return;
      renderEmpty("Git unavailable", `Couldn’t detect Git for this project.\n${errorText(error, "")}`.trim());
      return;
    }
    if (!repos.length) {
      renderEmpty("No Git repository", "This folder is not under version control.");
      return;
    }
    repo = repos[0].root;
    await refresh();
  }

  function refresh(transition?: "git-commit" | "git-send"): Promise<void> {
    refreshAgain = true;
    if (transition) pendingTransition = transition;
    if (!refreshTask) {
      refreshTask = (async () => {
        while (refreshAgain) {
          refreshAgain = false;
          const nextTransition = pendingTransition;
          pendingTransition = undefined;
          await refreshNow(nextTransition);
        }
      })().finally(() => { refreshTask = null; });
    }
    return refreshTask;
  }

  async function refreshNow(transition?: "git-commit" | "git-send"): Promise<void> {
    if (!repo) return;
    const serial = ++refreshSerial;
    reading = true;
    readError = "";
    renderActivity();
    try {
      const next = await gitRead(invoke<GitOverview>("git_overview", { repo, limit: 160 }));
      if (serial !== refreshSerial) return;
      if (next.status.error) throw new Error(next.status.error);
      status = next.status;
      graph = next.graph;
      ++diffRevision;
      diffCache.clear();
    } catch (error) {
      if (serial !== refreshSerial) return;
      reading = false;
      readError = errorText(error, "Git could not be read for this project.");
      if (!spine.stones.length && !cards.length) renderEmpty("Git unavailable", readError);
      else renderActivity();
      return;
    }
    reading = false;
    renderActivity();
    const apply = () => {
      if (serial !== refreshSerial) return;
      cards = buildCards();
      spine = buildSpine();
      for (const id of [...leftOut.keys()]) if (!cardById(id)) leftOut.delete(id);
      for (const id of [...drafts.keys()]) if (!cardById(id)) drafts.delete(id);
      settlePick();
      render();
    };
    if (transition && host.isConnected && host.getClientRects().length) await withViewTransition(transition, apply);
    else apply();
  }

  /** Keep the selection when it still exists. Otherwise point at the first thing to do. */
  function settlePick(): void {
    if (pick?.kind === "card" && cardById(pick.id)) return;
    if (pick?.kind === "file") {
      if (changeByKey(pick.key)) return;
      const path = pick.key.slice(pick.key.indexOf(":") + 1);
      const changed = allChanges().find((change) => change.path === path);
      if (changed) {
        pick = { kind: "file", key: changed.key };
        return;
      }
    }
    if (pick?.kind === "stone" && stoneBySha(pick.sha)) return;
    if (pick?.kind === "line") return;
    const first = cards.find((card) => card.changes.length);
    pick = first ? { kind: "card", id: first.id } : spine.stones[0] ? { kind: "stone", sha: spine.stones[0].sha } : null;
  }

  /* ------------------------------------------------------------ render */

  function render(): void {
    if (!host.isConnected || !host.getClientRects().length) return;
    const field = document.activeElement instanceof HTMLTextAreaElement
      && focus.contains(document.activeElement) ? document.activeElement : null;
    const selection = field ? [field.selectionStart, field.selectionEnd] as const : null;
    const scroll = focus.querySelector<HTMLElement>(".focus-body")?.scrollTop ?? 0;
    renderMove();
    renderSpineHead();
    renderSpine();
    renderFocus();
    if (field && selection) {
      const replacement = focus.querySelector<HTMLTextAreaElement>(".commit-msg");
      if (replacement && replacement.dataset.card === field.dataset.card) {
        replacement.focus({ preventScroll: true });
        replacement.setSelectionRange(...selection);
        const body = focus.querySelector<HTMLElement>(".focus-body");
        if (body) body.scrollTop = scroll;
      }
    }
    renderSafety();
    if (!drawer.hidden) renderDrawer();
    syncBusyControls();
  }

  function projectPicker(): string {
    const projects = events.projects();
    return `<label class="git-project-switch"><span>Project</span>
      <select class="repo-pick project-pick" aria-label="Git project">
        ${projects.map((project) => `<option value="${esc(project.id)}" title="${esc(project.path)}"${project.id === projectId ? " selected" : ""}>${esc(project.name)}</option>`).join("")}
      </select></label>`;
  }

  function renderDetecting(): void {
    moveBar.innerHTML = `<div class="move-text"><i class="move-dot"></i><span>Reading the working tree…</span></div>${projectPicker()}`;
    spineHead.innerHTML = "";
    spineScroll.innerHTML = loadingView("Loading timeline…");
    focus.innerHTML = loadingView("Loading review…");
    safety.innerHTML = "";
  }

  function renderEmpty(title: string, message: string): void {
    reading = false;
    renderActivity();
    moveBar.innerHTML = `<div class="move-text" data-tone="stuck"><i class="move-dot"></i><span>${esc(title)}</span></div>${projectPicker()}`;
    spineHead.innerHTML = "";
    spineScroll.innerHTML = `<div class="spine-empty">${esc(message)}<p><button class="gbtn" type="button" data-act="refresh">Retry</button></p></div>`;
    focus.innerHTML = "";
    safety.innerHTML = "";
  }

  function authorMark(author: string | null, kind: "agent" | "you" | "unknown"): string {
    const label = kind === "agent" ? author || "agent" : kind === "you" ? "you" : author || "";
    return `<i class="who is-${kind}" title="${esc(label)}">${kind === "agent" ? icon("agent") : kind === "you" ? "●" : "○"}</i>`;
  }

  /** Commit authorship: the agent CLIs sign with their own trailer or name. */
  function whoCommitted(commit: Commit): "agent" | "you" | "unknown" {
    return /claude|codex|grok|kimi|gemini|opencode|agent|bot/i.test(commit.author) ? "agent" : "you";
  }

  function renderMove(): void {
    const move = nextMove();
    const busy = mutating;
    const busyWord = busy ? (phaseWord || (motion ? { commit: "committing", send: "sending", bring: "bringing in", merge: "merging" }[motion] : "updating Git")) : "";
    renderActivity();
    moveBar.innerHTML = `
      <div class="move-text" data-tone="${receipt ? receipt.ok ? "calm" : "stuck" : move.tone}">
        <i class="move-dot${busy ? " mo-pulse" : ""}"></i>
        <span>${busy ? `${esc(busyWord[0].toUpperCase() + busyWord.slice(1))}…` : esc(receipt?.text ?? move.text)}</span>
      </div>
      ${move.act && !busy ? `<button class="move-go" type="button" data-act="${esc(move.act)}">${esc(move.label ?? "Go")}<kbd>⌘↩</kbd></button>` : ""}
      <span class="move-where">
        ${projectPicker()}
        ${repos.length > 1 ? `<select class="repo-pick" aria-label="Repository"${mutating ? " disabled" : ""}>${repos.map((candidate) => `<option value="${esc(candidate.root)}"${candidate.root === repo ? " selected" : ""}>${esc(candidate.name)}</option>`).join("")}</select>` : `<button class="where-repo" type="button" data-act="atlas" title="All repositories">${esc(repos.find((candidate) => candidate.root === repo)?.name ?? "")}</button>`}
        <button class="where-branch" type="button" data-act="drawer" title="Manage branches" aria-expanded="${!drawer.hidden}">${icon("branch")}<b>Branches</b><span>${esc(status.branch || "detached")}</span><span aria-hidden="true">▾</span></button>
        <button class="gbtn icon-only" type="button" data-act="refresh" title="Refresh local Git status" aria-label="Refresh local Git status">${icon("reload")}</button>
      </span>`;
    moveBar.querySelector<HTMLSelectElement>(".repo-pick:not(.project-pick)")?.addEventListener("change", (event) => {
      if (mutating) return;
      ++refreshSerial;
      ++focusSerial;
      repo = (event.target as HTMLSelectElement).value;
      leftOut.clear();
      drafts.clear();
      pick = null;
      void refresh();
    });
    syncBusyControls();
  }

  function renderSpineHead(): void {
    const waiting = uniquePaths(allChanges()).length;
    spineHead.innerHTML = `
      <b>${waiting ? plural(waiting, "file") + " waiting" : "Nothing waiting"}</b>
      <span>${status.ahead ? `${status.ahead} unsent` : ""}${status.ahead && status.behind ? " · " : ""}${status.behind ? `${status.behind} incoming` : ""}</span>`;
  }

  function renderSpine(): void {
    const parts: string[] = [];
    if (status.operation) {
      parts.push(`<div class="barrier"><b>${esc(status.operation)} stopped here</b><span>${status.conflicts?.length ? `${plural(status.conflicts.length, "file")} need a decision` : "ready to continue"}</span></div>`);
    }
    parts.push(`<div class="spine-section is-waiting">${cards.map(cardNode).join("") || `<div class="spine-clean"><i>✓</i>Working tree is clean</div>`}</div>`);

    const ghosts = spine.incoming
      .map((commit) => stoneNode(commit, { ghost: true }))
      .join("");
    const stones = spine.stones.map((commit, index) => {
      const before = index === spine.lineAt ? lineNode() + ghosts : "";
      return before + stoneNode(commit, { unsent: index < spine.lineAt, head: index === 0 });
    });
    if (spine.lineAt >= spine.stones.length) stones.push(lineNode() + ghosts);
    parts.push(`<div class="spine-section is-history">${stones.join("")}${graph.error ? `<div class="spine-empty">${esc(graph.error)}</div>` : ""}</div>`);
    const scroll = spineScroll.scrollTop;
    spineScroll.innerHTML = parts.join("");
    spineScroll.scrollTop = scroll;
  }

  function cardNode(card: Card): string {
    const picked = pick?.kind === "card" && pick.id === card.id;
    const out = leftOut.get(card.id);
    const rows = card.changes
      .map((change) => {
        const filePicked = pick?.kind === "file" && pick.key === change.key;
        const off = out?.has(change.path);
        return `<button class="card-file is-${change.kind}${filePicked ? " is-picked" : ""}${off ? " is-off" : ""}" type="button" data-pick="file:${esc(change.key)}" title="${esc(change.path)}">
          <i class="file-code">${esc(change.code || "?")}</i>
          <span><b>${esc(fileName(change.path))}</b><small>${esc(parentPath(change.path))}</small></span>
          <em>${KIND_LABEL[change.kind]}</em>
        </button>`;
      })
      .join("");
    const who = card.kind === "turn" ? authorMark(card.agent, "agent") : card.kind === "yours" ? authorMark(null, "you") : `<i class="who is-conflict">!</i>`;
    const moving = motion === "commit" && picked ? " is-packing" : "";
    return `<article class="card is-${card.kind}${picked ? " is-picked" : ""}${card.live ? " is-live" : ""}${moving}" data-card="${esc(card.id)}">
      <button class="card-head" type="button" data-pick="card:${esc(card.id)}">
        ${who}
        <span class="card-title"><b>${esc(card.title)}</b><small>${card.kind === "turn" ? esc(card.agent ?? "agent") + " · " : ""}${card.live ? "still writing · " : ""}${plural(uniquePaths(card.changes).length, "file")}</small></span>
        ${card.live ? '<i class="card-live mo-pulse"></i>' : ""}
      </button>
      <div class="card-files">${rows}</div>
    </article>`;
  }

  function stoneNode(commit: Commit, flags: { ghost?: boolean; unsent?: boolean; head?: boolean }): string {
    const picked = pick?.kind === "stone" && pick.sha === commit.sha;
    const who = whoCommitted(commit);
    const refs = (commit.refs ?? [])
      .filter((ref) => ref.type !== "head" && ref.name !== spine.upstream)
      .map((ref) => `<i class="flag is-${esc(ref.type)}">${esc(ref.name)}</i>`)
      .join("");
    const moving =
      (motion === "send" && flags.unsent && " is-sending") ||
      (motion === "bring" && flags.ghost && " is-arriving") ||
      "";
    const fresh = flags.head && previousHead && previousHead !== commit.sha ? " mo-pop" : "";
    return `<button class="stone${flags.ghost ? " is-ghost" : ""}${flags.unsent ? " is-unsent" : ""}${flags.head ? " is-head" : ""}${picked ? " is-picked" : ""}${moving}${fresh}" type="button" data-pick="stone:${esc(commit.sha)}" data-sha="${esc(commit.sha)}" title="${esc(commit.short)} · ${esc(commit.author)} · ${esc(commit.age)}">
      <i class="stone-dot"></i>
      ${authorMark(commit.author, who)}
      <span class="stone-sub">${refs}${esc(commit.subject)}</span>
      <small class="stone-age">${esc(commit.age)}</small>
    </button>`;
  }

  function lineNode(): string {
    const picked = pick?.kind === "line";
    const noRemote = !status.remotes?.length;
    const label = noRemote ? "no remote" : spine.upstream ?? "not tracking";
    const verb = noRemote
      ? { act: "add-remote", text: "Add remote" }
      : !spine.upstream
        ? { act: "send", text: "Send & track" }
        : status.behind && status.ahead
          ? { act: "bring", text: `Bring in ${status.behind}, then send` }
          : status.behind
            ? { act: "bring", text: `Bring in ${status.behind}` }
            : status.ahead
              ? { act: "send", text: `Send ${status.ahead}` }
              : null;
    const busy = mutating && (motion === "send" || motion === "bring");
    return `<div class="remote-line${picked ? " is-picked" : ""}${spine.upstream ? "" : " is-dotted"}${busy ? " is-busy" : ""}" data-pick="line">
      <button class="line-name" type="button" data-pick="line" title="The remote is here">${icon("git")}<span>${esc(label)}</span></button>
      <span class="line-track">${busy ? '<i class="line-packet mo-flow" style="--mo-dur:.9s"></i>' : ""}</span>
      ${busy ? `<span class="line-phase">${esc(phaseWord || (motion === "send" ? "sending" : "fetching"))}…</span>` : verb ? `<button class="line-go" type="button" data-act="${verb.act}">${esc(verb.text)}</button>` : '<span class="line-phase is-ok">in sync</span>'}
    </div>`;
  }

  /* ------------------------------------------------------------ focus faces */

  function renderFocus(): void {
    const serial = ++focusSerial;
    diffObserver?.disconnect();
    if (!pick) return renderFocusEmpty();
    if (pick.kind === "card") {
      const card = cardById(pick.id);
      return card ? renderFocusCard(card) : renderFocusEmpty();
    }
    if (pick.kind === "file") {
      const change = changeByKey(pick.key);
      return change ? void renderFocusFile(change, serial) : renderFocusEmpty();
    }
    if (pick.kind === "stone") {
      const stone = stoneBySha(pick.sha);
      return stone ? void renderFocusStone(stone, serial) : renderFocusEmpty();
    }
    renderFocusLine();
  }

  function renderFocusEmpty(): void {
    focus.innerHTML = `<div class="focus-empty">${icon("git")}<b>Nothing picked</b><span>Pick a turn, a file or a commit on the spine.</span></div>`;
  }

  function focusHead(eyebrow: string, title: string, extra = ""): string {
    return `<header class="focus-head"><div><small>${eyebrow}</small><b title="${esc(title)}">${esc(title)}</b></div>${extra}</header>`;
  }

  function renderFocusCard(card: Card): void {
    ++focusSerial;
    diffObserver?.disconnect();
    const out = leftOut.get(card.id);
    const chosen = cardPaths(card).length;
    const total = uniquePaths(card.changes).length;
    const draft = cardDraft(card);
    if (card.kind === "conflict") {
      const operation = status.operation;
      focus.innerHTML = `
        ${focusHead("NEEDS RESOLUTION", `${plural(uniquePaths(card.changes).length, "file")} conflicted`)}
        <div class="focus-body">
          <p class="focus-lede">Open each file, keep the right side, then mark it resolved. ${operation ? `Then continue the ${esc(operation)}.` : ""}</p>
          <div class="focus-files">${card.changes.map((change) => expandedChange(change, false)).join("")}</div>
          <div class="focus-acts">
            ${operation === "rebase" ? `<button class="gbtn agent" type="button" data-act="resolve-ai">${icon("agent")}Let an agent resolve them</button>` : ""}
            ${operation ? `<button class="gbtn prim" type="button" data-act="continue-operation" disabled>Continue after resolving</button><button class="gbtn danger" type="button" data-act="abort-operation">Abort ${esc(operation)}</button>` : ""}
          </div>
        </div>`;
      void loadExpandedDiffs();
      return;
    }
    focus.innerHTML = `
      ${focusHead(card.kind === "turn" ? `TURN · ${esc(card.agent ?? "agent").toUpperCase()}` : "YOUR EDITS", card.title)}
      <div class="focus-body">
        ${card.prompt ? `<blockquote class="focus-prompt">${esc(card.prompt.trim())}</blockquote>` : ""}
        ${card.live ? `<p class="focus-lede is-live">${esc(card.agent ?? "The agent")} is still writing. Commit when the turn ends.</p>` : ""}
        <div class="selection-bar"><span>${chosen} of ${total} files selected</span><button class="gbtn mini" type="button" data-act="select-all">All</button><button class="gbtn mini" type="button" data-act="select-none">None</button></div>
        <div class="focus-files is-tickable">${card.changes.map((change) => expandedChange(change, true, !out?.has(change.path))).join("")}</div>
        <label class="focus-message">
          <span>Commit message</span>
          <textarea class="commit-msg" rows="2" placeholder="What did this change do?" data-card="${esc(card.id)}">${esc(draft)}</textarea>
        </label>
        <div class="focus-acts">
          <button class="gbtn prim big" type="button" data-act="commit-card:${esc(card.id)}"${card.live || !chosen ? " disabled" : ""}>Commit ${chosen === total ? plural(chosen, "file") : `${chosen} of ${total}`}<kbd>⌘↩</kbd></button>
          <button class="gbtn danger" type="button" data-act="discard-card:${esc(card.id)}"${chosen ? "" : " disabled"}>Discard</button>
          <button class="focus-agent" type="button" data-act="agent-commit">${icon("agent")}<span>or let an agent review and write it</span></button>
        </div>
        <p class="commit-scope">Selected files include all current edits, including unstaged changes.</p>
        <div class="gerr focus-err"></div>
      </div>`;
    void loadExpandedDiffs();
    const field = focus.querySelector<HTMLTextAreaElement>(".commit-msg")!;
    field.addEventListener("input", () => {
      drafts.set(card.id, field.value);
      focus.querySelector(".focus-err")!.textContent = "";
    });
  }

  function fileRow(change: Change, tickable: boolean, on = true): string {
    const picked = pick?.kind === "file" && pick.key === change.key;
    return `<div class="focus-file is-${change.kind}${picked ? " is-picked" : ""}${on ? "" : " is-off"}" data-key="${esc(change.key)}">
      ${tickable ? `<label class="tick"><input type="checkbox" aria-label="Include ${esc(change.path)} in commit" data-tick="${esc(change.path)}"${on ? " checked" : ""}><span></span></label>` : ""}
      <button class="focus-file-open" type="button" data-pick="file:${esc(change.key)}"><i class="file-code">${esc(change.code || "?")}</i><span><b>${esc(fileName(change.path))}</b><small>${esc(parentPath(change.path))}${change.oldPath ? ` · from ${esc(fileName(change.oldPath))}` : ""}</small></span><em>${KIND_LABEL[change.kind]}</em></button>
    </div>`;
  }

  function expandedDiff(header: string, path: string, query: string): string {
    const url = `${M}/diff?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}&${query}`;
    return `<section class="expanded-file">${header}<pre class="focus-diff is-expanded" aria-label="Diff for ${esc(path)}" data-diff-url="${esc(url)}"><span class="diff-hint">Loading diff…</span></pre></section>`;
  }

  function expandedChange(change: Change, tickable: boolean, on = true): string {
    return expandedDiff(fileRow(change, tickable, on), change.path,
      `staged=${change.kind === "staged" ? 1 : 0}&untracked=${change.kind === "untracked" ? 1 : 0}`);
  }

  /** Cache within one status snapshot; keep at most two diff subprocesses in flight. */
  function readDiff(url: string): Promise<string> {
    const key = `${diffRevision}:${url}`;
    if (diffCache.has(key)) return Promise.resolve(diffCache.get(key)!);
    const pending = diffPending.get(key);
    if (pending) return pending;
    const revision = diffRevision;
    const request = new Promise<string>((resolve, reject) => {
      const run = () => {
        if (!host.isConnected || revision !== diffRevision) {
          diffPending.delete(key);
          reject(new Error("Review changed. Load the diff again."));
          diffQueue.shift()?.();
          return;
        }
        ++diffRunning;
        gitRead(moduleGet<{ patch?: string; error?: string }>(url)).then((result) => {
          if (result.error) throw new Error(result.error);
          const patch = result.patch || "(no textual changes)";
          if (revision === diffRevision) {
            if (diffCache.size >= 40) diffCache.delete(diffCache.keys().next().value!);
            diffCache.set(key, patch);
          }
          resolve(patch);
        }).catch(reject).finally(() => {
          --diffRunning;
          diffPending.delete(key);
          diffQueue.shift()?.();
        });
      };
      if (diffRunning < 2) run();
      else diffQueue.push(run);
    });
    diffPending.set(key, request);
    return request;
  }

  /** Off-screen files keep their loading view until scrolling brings them close. */
  function loadExpandedDiffs(): void {
    diffObserver?.disconnect();
    const serial = focusSerial;
    diffObserver = new IntersectionObserver((entries, observer) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const pre = entry.target as HTMLElement;
        observer.unobserve(pre);
        if (!pre.isConnected || serial !== focusSerial) continue;
        pre.setAttribute("aria-busy", "true");
        void readDiff(pre.dataset.diffUrl!).then((patch) => {
          if (pre.isConnected && serial === focusSerial) void renderPatch(pre, patch);
        }).catch((error) => {
          if (pre.isConnected && serial === focusSerial) showDiffError(pre, String(error));
        });
      }
    }, { root: focus.querySelector(".focus-body"), rootMargin: "240px" });
    for (const pre of focus.querySelectorAll<HTMLElement>("[data-diff-url]")) diffObserver.observe(pre);
  }

  function showDiffError(pre: HTMLElement, message: string): void {
    pre.setAttribute("aria-busy", "false");
    pre.innerHTML = `<span class="diff-hint">${esc(message)}</span><button class="gbtn mini" type="button" data-act="retry-diff">Retry diff</button>`;
  }

  async function renderFocusFile(change: Change, serial: number): Promise<void> {
    const image = isImagePath(change.path);
    const owner = cards.find((card) => card.changes.includes(change) || card.changes.some((c) => c.key === change.key));
    const acts = change.kind === "conflict"
      ? `<button class="gbtn prim" type="button" data-act="resolve-file">Mark resolved</button>`
      : `<button class="gbtn prim" type="button" data-act="${change.kind === "staged" ? "unstage-file" : "stage-file"}">${change.kind === "staged" ? "Unstage" : "Stage file"}</button>${change.kind === "unstaged" ? `<button class="gbtn danger" type="button" data-act="discard-file">Discard edits</button>` : ""}${owner ? `<button class="gbtn" type="button" data-pick="card:${esc(owner.id)}">Back to ${esc(owner.kind === "turn" ? "turn" : owner.kind === "yours" ? "your edits" : "conflicts")}</button>` : ""}`;
    focus.innerHTML = `
      ${focusHead(`${KIND_LABEL[change.kind].toUpperCase()}${image ? " · IMAGE" : ""}`, change.path, `<span class="focus-acts inline">${acts}</span>`)}
      <div class="review-nav"><button class="gbtn mini" type="button" data-act="previous-file">↑ Previous file</button><span>j / k to navigate</span><button class="gbtn mini" type="button" data-act="next-file">Next file ↓</button></div>
      <pre class="focus-diff${image ? " is-media" : ""}"></pre>`;
    const pre = focus.querySelector<HTMLElement>(".focus-diff")!;
    if (image) return renderImagePreview(pre, change);
    const url = `${M}/diff?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(change.path)}&staged=${change.kind === "staged" ? 1 : 0}&untracked=${change.kind === "untracked" ? 1 : 0}`;
    pre.dataset.diffUrl = url;
    pre.innerHTML = loadingView("Loading diff…");
    pre.setAttribute("aria-busy", "true");
    try {
      const patch = await readDiff(url);
      if (serial !== focusSerial) return;
      await renderPatch(pre, patch);
    } catch (error) {
      if (serial === focusSerial) showDiffError(pre, String(error));
    }
  }

  async function renderFocusStone(stone: Commit, serial: number): Promise<void> {
    const ghost = spine.incoming.some((commit) => commit.sha === stone.sha);
    const index = spine.stones.findIndex((commit) => commit.sha === stone.sha);
    const unsent = index >= 0 && index < spine.lineAt;
    const eyebrow = `${ghost ? "INCOMING · " : unsent ? "NOT SENT · " : ""}${esc(stone.short)} · ${esc(stone.age)}`;
    focus.innerHTML = `
      ${focusHead(eyebrow, stone.subject, `<span class="focus-acts inline">${ghost ? "" : `<button class="gbtn" type="button" data-act="stone-menu" data-sha="${esc(stone.sha)}">More ▾</button>`}</span>`)}
      <div class="focus-body">${loadingView("Loading commit…")}</div>`;
    try {
      const detail = await gitRead(moduleGet<CommitDetail>(`${M}/commit?repo=${encodeURIComponent(repo)}&sha=${encodeURIComponent(stone.sha)}`));
      if (serial !== focusSerial) return;
      if (detail.error) throw new Error(detail.error);
      const files = (detail.files ?? [])
        .map(
          (file) => expandedDiff(`<div class="focus-file is-commit">
            <i class="file-code">±</i>
            <span><b>${esc(fileName(file.path))}</b><small>${esc(parentPath(file.path))}</small></span>
            <em><i class="adds">${file.adds === null ? "bin" : `+${file.adds}`}</i><i class="dels">${file.dels === null ? "" : `−${file.dels}`}</i></em>
          </div>`, file.path, `sha=${encodeURIComponent(stone.sha)}`),
        )
        .join("");
      focus.querySelector(".focus-body")!.innerHTML = `
        <p class="focus-meta">${authorMark(detail.author, whoCommitted(detail))}<b>${esc(detail.author)}</b><span>${esc(detail.date ?? "")}</span><span class="diffstat"><i class="adds">+${detail.adds ?? 0}</i> <i class="dels">−${detail.dels ?? 0}</i></span></p>
        ${detail.body ? `<pre class="focus-commit-body">${esc(detail.body)}</pre>` : ""}
        <div class="focus-files">${files || '<p class="focus-lede">No files changed.</p>'}</div>`;
      void loadExpandedDiffs();
    } catch (error) {
      if (serial === focusSerial) focus.querySelector(".focus-body")!.innerHTML = `<p class="focus-lede">${esc(String(error))}</p><button class="gbtn" type="button" data-act="retry-focus">Retry</button>`;
    }
  }

  function renderFocusLine(): void {
    const noRemote = !status.remotes?.length;
    const unsent = spine.stones.slice(0, spine.lineAt);
    const title = noRemote ? "No remote" : spine.upstream ?? `${status.branch} is not tracking a remote`;
    const rows = (list: Commit[], cls: string) =>
      list.map((commit) => `<button class="focus-file is-commit ${cls}" type="button" data-pick="stone:${esc(commit.sha)}"><i class="file-code">●</i><span><b>${esc(commit.subject)}</b><small>${esc(commit.short)} · ${esc(commit.author)} · ${esc(commit.age)}</small></span></button>`).join("");
    const phase = mutating && (motion === "send" || motion === "bring") ? `<p class="focus-lede is-live">${esc(phaseWord || (motion === "send" ? "sending" : "fetching"))}…</p>` : "";
    focus.innerHTML = `
      ${focusHead("THE REMOTE", title)}
      <div class="focus-body">
        ${phase}
        ${noRemote ? `<p class="focus-lede">Nothing leaves this machine until a remote exists.</p><div class="focus-acts"><button class="gbtn prim" type="button" data-act="add-remote">Add a remote</button></div>` : ""}
        ${!noRemote && !spine.upstream ? `<p class="focus-lede">The first send creates ${esc(status.remotes?.[0]?.name ?? "origin")}/${esc(status.branch ?? "")} and tracks it.</p><div class="focus-acts"><button class="gbtn prim big" type="button" data-act="send">Send & track</button></div>` : ""}
        ${spine.upstream ? `
          <section class="line-group">
            <h4>Going out <span>${unsent.length || status.ahead || 0}</span></h4>
            ${rows(unsent, "is-unsent") || '<p class="focus-lede">Nothing to send.</p>'}
          </section>
          <section class="line-group">
            <h4>Coming in <span>${spine.incoming.length || status.behind || 0}</span></h4>
            ${rows(spine.incoming, "is-ghost") || '<p class="focus-lede">Nothing waiting at the remote.</p>'}
          </section>
          <div class="focus-acts">
            ${status.behind ? `<button class="gbtn prim big" type="button" data-act="bring">Bring in ${status.behind}</button>` : ""}
            ${status.ahead ? `<button class="gbtn ${status.behind ? "" : "prim big"}" type="button" data-act="send"${status.behind ? " disabled title=\"Bring in first\"" : ""}>Send ${status.ahead}</button>` : ""}
            ${!status.ahead && !status.behind ? `<button class="gbtn" type="button" data-act="fetch">Check the remote</button>` : ""}
          </div>` : ""}
      </div>`;
  }

  /** Yield between chunks so a large diff never holds the input thread. */
  async function renderPatch(pre: HTMLElement, patch: string): Promise<void> {
    const serial = focusSerial;
    const allLines = patch.split("\n");
    const limit = 3500;
    pre.replaceChildren();
    for (let at = 0; at < Math.min(limit, allLines.length); at += 150) {
      if (!pre.isConnected || serial !== focusSerial) return;
      const lines = allLines.slice(at, Math.min(at + 150, limit)).map((line) => {
        let cls = "";
        if (/^(\+\+\+|---|diff |index |new file|deleted file|similarity|rename )/.test(line)) cls = "dl-h";
        else if (line.startsWith("@@")) cls = "dl-at";
        else if (line.startsWith("+")) cls = "dl-add";
        else if (line.startsWith("-")) cls = "dl-del";
        else if (/^(<<<<<<<|=======|>>>>>>>)/.test(line)) cls = "dl-mark";
        return `<span class="${cls}">${esc(line)}</span>`;
      });
      pre.insertAdjacentHTML("beforeend", lines.join(""));
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
    if (!pre.isConnected || serial !== focusSerial) return;
    if (allLines.length > limit) pre.insertAdjacentHTML("beforeend", `<span class="dl-h">… diff trimmed after ${limit} lines</span>`);
    pre.setAttribute("aria-busy", "false");
    pre.scrollTop = 0;
  }

  function renderImagePreview(pre: HTMLElement, change: Change): void {
    const source = assetUrl(change.path);
    if (!source) {
      pre.innerHTML = `<div class="git-media-empty">${icon("image")}<b>Preview unavailable</b><span>This image is outside the open project.</span></div>`;
      return;
    }
    pre.innerHTML = `<figure class="git-image-preview">
      <div class="git-image-stage"><img src="${esc(source)}" alt="${esc(fileName(change.path))}"></div>
      <figcaption><span><b>Current working copy</b><small class="image-meta">Loading image…</small></span><code>${esc(change.path)}</code></figcaption>
    </figure>`;
    const image = pre.querySelector<HTMLImageElement>("img")!;
    const meta = pre.querySelector<HTMLElement>(".image-meta")!;
    image.addEventListener("load", () => {
      meta.textContent = `${image.naturalWidth} × ${image.naturalHeight} · ${fileExtension(change.path).toUpperCase()}`;
    });
    image.addEventListener("error", () => {
      pre.innerHTML = `<div class="git-media-empty">${icon("image")}<b>Image not available</b><span>The file may have been deleted or moved.</span></div>`;
    });
  }

  /* ------------------------------------------------------------ safety bar */

  function renderSafety(): void {
    const stashCount = status.stashCount ?? 0;
    const dirty = uniquePaths(allChanges().filter((change) => change.kind !== "conflict")).length;
    const note = safetyNote && safetyNote.until > Date.now() ? safetyNote : null;
    safety.innerHTML = `
      <button class="safe" type="button" data-act="undo-last"${spine.stones.length && !stuck() ? "" : " disabled"} title="Take the last commit apart. Its files stay changed.">↶ Undo last commit</button>
      <button class="safe" type="button" data-act="stash"${dirty && !stuck() ? "" : " disabled"} title="Stash every change, including new files.">Put aside${dirty ? ` ${dirty}` : ""}</button>
      <button class="safe" type="button" data-act="stash-pop"${stashCount && !stuck() ? "" : " disabled"} title="${esc(status.latestStash || "No saved stash")}">Bring back${stashCount ? ` (${stashCount})` : ""}</button>
      ${note ? `<span class="safe-note mo-rise"><span>${esc(note.text)}</span><button type="button" class="safe" data-act="${esc(note.act)}">${esc(note.label)}</button></span>` : ""}`;
  }

  function noteSafety(text: string, label: string, act: string): void {
    safetyNote = { text, label, act, until: Date.now() + 120_000 };
    window.clearTimeout(safetyTimer);
    safetyTimer = window.setTimeout(() => {
      safetyNote = null;
      renderSafety();
    }, 120_000);
    renderSafety();
  }

  /* ------------------------------------------------------------ drawer */

  function renderDrawer(): void {
    const branches = status.branches ?? [];
    const searchFocused = document.activeElement === drawer.querySelector(".branch-search");
    const selection = drawer.querySelector<HTMLInputElement>(".branch-search")?.selectionStart ?? branchQuery.length;
    const commits = graph.error ? [] : (graph.commits ?? []);
    const bySha = new Map(commits.map((commit) => [commit.sha, commit]));
    const onSpine = new Set(spine.stones.map((stone) => stone.sha));
    const threads = branches
      .filter((branch) => !branch.current)
      .map((branch) => {
        const tip = commits.find((commit) => (commit.refs ?? []).some((ref) => ref.type === "branch" && ref.name === branch.name));
        let walker = tip;
        let count = 0;
        const seen = new Set<string>();
        while (walker && !onSpine.has(walker.sha) && !seen.has(walker.sha) && count < 400) {
          seen.add(walker.sha);
          count += 1;
          walker = bySha.get(walker.parents?.[0] ?? "");
        }
        const fork = walker && onSpine.has(walker.sha) ? walker : null;
        const forkIndex = fork ? spine.stones.findIndex((stone) => stone.sha === fork.sha) : -1;
        const where = !tip
          ? "outside the recent window"
          : count === 0
            ? (tip?.sha === graph.head ? "same tip as " : "already included in ") + (status.branch ?? "this branch")
            : fork
              ? `${plural(count, "commit")} since “${firstLine(fork.subject, 40)}”`
              : `${plural(count, "commit")} of its own`;
        return `<article class="thread${branch.old ? " is-old" : ""}" data-branch="${esc(branch.name)}">
          <i class="thread-line" style="--fork:${Math.max(0, forkIndex)}"></i>
          <div class="thread-body">
            <b>${esc(branch.name)}</b>
            <small>${esc(where)}${branch.age ? ` · ${esc(branch.age)}` : ""}${branch.upstream ? ` · ${esc(branch.upstream)}` : ""}</small>
            <span class="thread-acts">
              <button class="gbtn mini" type="button" data-act="switch" data-branch="${esc(branch.name)}">Switch</button>
              <button class="gbtn mini" type="button" data-act="merge" data-branch="${esc(branch.name)}"${count === 0 && tip ? " disabled" : ""}>Merge into ${esc(status.branch ?? "current")}</button>
              <button class="gbtn mini danger" type="button" data-act="delete-branch" data-branch="${esc(branch.name)}">Delete</button>
            </span>
          </div>
        </article>`;
      })
      .join("");
    drawer.innerHTML = `
      <header class="drawer-head">
        <b>${icon("branch")} Branches · ${branches.length}</b>
        <span class="drawer-acts"><button class="gbtn mini" type="button" data-act="newbranch">＋ New branch</button><button class="gbtn mini icon-only" type="button" data-act="drawer" aria-label="Close">✕</button></span>
      </header>
      <label class="branch-search-wrap"><input class="branch-search" type="search" placeholder="Find a branch…" aria-label="Find a branch" value="${esc(branchQuery)}"></label>
      <article class="thread is-current"><i class="thread-line"></i><div class="thread-body"><b>${esc(status.branch || "detached")}</b><small>Current branch${spine.upstream ? ` · ${esc(spine.upstream)}` : ""}</small></div></article>
      ${threads || '<p class="drawer-empty">Only this branch. New branches start from where you stand.</p>'}
      <p class="drawer-empty branch-no-match" hidden>No matching branches.</p>`;
    const search = drawer.querySelector<HTMLInputElement>(".branch-search")!;
    const filter = (): void => {
      let shown = 0;
      drawer.querySelectorAll<HTMLElement>(".thread[data-branch]").forEach((row) => {
        row.hidden = !(row.dataset.branch ?? "").toLocaleLowerCase().includes(branchQuery.trim().toLocaleLowerCase());
        if (!row.hidden) shown++;
      });
      drawer.querySelector<HTMLElement>(".branch-no-match")!.hidden = !branchQuery.trim() || shown > 0;
    };
    search.addEventListener("input", () => {
      branchQuery = search.value;
      filter();
    });
    filter();
    if (searchFocused) {
      search.focus({ preventScroll: true });
      search.setSelectionRange(selection, selection);
    }
  }

  function openDrawer(): void {
    closeAtlas();
    drawer.hidden = false;
    host.classList.add("has-drawer");
    renderDrawer();
    renderMove();
    drawer.querySelector<HTMLInputElement>(".branch-search")?.focus();
  }

  function closeDrawer(): void {
    drawer.hidden = true;
    drawer.innerHTML = "";
    host.classList.remove("has-drawer");
    branchQuery = "";
    moveBar.querySelector('[data-act="drawer"]')?.setAttribute("aria-expanded", "false");
  }

  /* ------------------------------------------------------------ atlas */

  async function openAtlas(): Promise<void> {
    closeDrawer();
    atlas.hidden = false;
    atlasRows = null;
    renderAtlas();
    try {
      const result = await gitRead(moduleGet<{ pushable?: AtlasRepo[]; error?: string }>(`${M}/pushable`), 60_000);
      if (atlas.hidden) return;
      if (result.error) throw new Error(result.error);
      atlasRows = result.pushable ?? [];
    } catch (error) {
      atlasRows = [];
      atlas.dataset.error = String(error);
    }
    renderAtlas();
  }

  function closeAtlas(): void {
    atlas.hidden = true;
    atlas.innerHTML = "";
    delete atlas.dataset.error;
  }

  function renderAtlas(): void {
    const rows = atlasRows;
    const dots = (count: number, cls: string, max = 8): string =>
      count <= 0 ? "" : `<span class="atlas-dots ${cls}">${"<i></i>".repeat(Math.min(count, max))}${count > max ? `<em>+${count - max}</em>` : ""}</span>`;
    const list = rows === null
      ? '<p class="atlas-empty">Reading every repository…</p>'
      : rows.length
        ? rows
            .map((row) => {
              const here = clean(row.path) === clean(repo);
              const quiet = !row.dirty && !row.ahead && !row.behind;
              return `<button class="atlas-row${here ? " is-here" : ""}${quiet ? " is-quiet" : ""}" type="button" data-open="${esc(row.path)}">
                <span class="atlas-name"><b>${esc(row.name)}</b><small>${esc(row.branch)}${row.hasUpstream ? "" : " · never sent"}</small></span>
                <span class="atlas-spine">
                  ${dots(row.dirty ?? 0, "is-dirty")}
                  ${dots(row.ahead === -1 ? 1 : row.ahead ?? 0, "is-unsent")}
                  <i class="atlas-line"></i>
                  ${dots(row.behind ?? 0, "is-incoming")}
                </span>
                <span class="atlas-sum">${quiet ? "in sync" : [row.dirty ? `${row.dirty} waiting` : "", row.ahead ? `${row.ahead === -1 ? "all" : row.ahead} unsent` : "", row.behind ? `${row.behind} incoming` : ""].filter(Boolean).join(" · ")}</span>
              </button>`;
            })
            .join("")
        : `<p class="atlas-empty">${esc(atlas.dataset.error || "No repositories with a remote.")}</p>`;
    atlas.innerHTML = `
      <header class="atlas-head">
        <b>${icon("git")} Every repository</b>
        <span class="drawer-acts">
          <button class="gbtn prim" type="button" data-sweep="sync">⇅ Sync all</button>
          <button class="gbtn" type="button" data-sweep="pull">Pull all</button>
          <button class="gbtn" type="button" data-sweep="push">Push all</button>
          <button class="gbtn mini icon-only" type="button" data-act="atlas" aria-label="Close">✕</button>
        </span>
      </header>
      <div class="atlas-list">${list}</div>`;
  }

  /* ------------------------------------------------------------ actions */

  function say(text: string, ok = true): void {
    receipt = { text, ok };
    window.clearTimeout(receiptTimer);
    receiptTimer = window.setTimeout(() => {
      receipt = null;
      renderMove();
    }, ok ? 3800 : 7000);
    renderMove();
  }

  function failInFocus(text: string): void {
    const slot = focus.querySelector<HTMLElement>(".focus-err");
    if (slot) slot.textContent = text;
    else void alertDialog(text);
  }

  function startPhasePolling(): void {
    stopPhasePolling();
    const poll = async () => {
      try {
        const progress = await moduleGet<{ phase?: string }>(`${M}/pull/progress?repo=${encodeURIComponent(repo)}`);
        if (!mutating) return;
        const next = progress.phase && !/done|failed|conflict/.test(progress.phase) ? progress.phase : "";
        if (next !== phaseWord) {
          phaseWord = next;
          renderMove();
          renderSpine();
          if (pick?.kind === "line") renderFocusLine();
        }
      } catch {
        /* progress is a courtesy */
      }
      if (mutating) phaseTimer = window.setTimeout(() => void poll(), 450);
    };
    phaseTimer = window.setTimeout(() => void poll(), 200);
  }

  function stopPhasePolling(): void {
    window.clearTimeout(phaseTimer);
    phaseTimer = 0;
    phaseWord = "";
  }

  /**
   * Every mutation goes through here. One request at a time, the motion class on while it runs,
   * a fresh read after it, and the receipt written from what git actually did.
   */
  async function mutate(
    work: () => Promise<{ error?: string; conflict?: boolean } | void>,
    options: { motion?: Motion; done?: string; fail?: string; inFocus?: boolean } = {},
  ): Promise<boolean> {
    if (mutating) return false;
    if (busyRepos.has(repo)) {
      say("This repository has another Git operation running.", false);
      return false;
    }
    const operationRepo = repo;
    busyRepos.add(operationRepo);
    mutating = true;
    window.dispatchEvent(new CustomEvent(GIT_JOBS_EVENT, { detail: { repo: operationRepo, owner: host } }));
    motion = options.motion ?? null;
    previousHead = graph.head ?? "";
    host.classList.add("is-busy");
    renderMove();
    if (motion) {
      renderSpine();
      if (motion === "send" || motion === "bring") startPhasePolling();
    }
    try {
      const result = await work();
      if (result?.error && !result.conflict) throw new Error(result.error);
      const transition = !result?.conflict
        ? motion === "commit"
          ? "git-commit"
          : motion === "send"
            ? "git-send"
            : undefined
        : undefined;
      await refresh(transition);
      if (result?.conflict) {
        say("Stopped on conflicts. The spine shows where.", false);
        return false;
      }
      if (options.done) say(options.done);
      return true;
    } catch (error) {
      await refresh();
      const text = String(error).replace(/^Error:\s*/, "");
      if (options.inFocus) focusError = text;
      else say(`${options.fail ?? "Didn’t go through"}: ${text}`, false);
      return false;
    } finally {
      mutating = false;
      busyRepos.delete(operationRepo);
      window.dispatchEvent(new CustomEvent(GIT_JOBS_EVENT, { detail: { repo: operationRepo, owner: host } }));
      motion = null;
      stopPhasePolling();
      host.classList.remove("is-busy");
      render();
      previousHead = "";
      if (focusError) {
        failInFocus(focusError);
        focusError = "";
      }
    }
  }

  const post = (path: string, body: Record<string, unknown> = {}) =>
    modulePost<{ error?: string; conflict?: boolean }>(`${M}${path}`, { repo, ...body });

  async function commitCard(card: Card): Promise<void> {
    if (stuck()) return failInFocus("Resolve the current Git operation before committing.");
    if (card.live) return failInFocus("The agent is still writing. Wait for the turn to end.");
    const paths = cardPaths(card);
    if (!paths.length) return failInFocus("Nothing is ticked.");
    const message = cardDraft(card).trim();
    if (!message) {
      pick = { kind: "card", id: card.id };
      renderFocus();
      focus.querySelector<HTMLTextAreaElement>(".commit-msg")?.focus();
      return failInFocus("Write one line that says what this did.");
    }
    const stagedOutside = (status.staged ?? []).map((entry) => entry.path).filter((path) => !paths.includes(path));
    const ok = await mutate(
      async () => {
        if (stagedOutside.length) {
          const un = await post("/unstage", { paths: stagedOutside });
          if (un.error) return un;
        }
        const add = await post("/stage", { paths });
        if (add.error) return add;
        return post("/commit", { message });
      },
      { motion: "commit", done: `Committed: ${firstLine(message, 60)}`, inFocus: true },
    );
    if (ok) {
      drafts.delete(card.id);
      leftOut.delete(card.id);
      noteSafety(`Committed ${plural(paths.length, "file")}.`, "Undo", "undo-last");
      pick = spine.stones[0] ? { kind: "stone", sha: spine.stones[0].sha } : null;
      settlePick();
      render();
    }
  }

  async function discardPaths(paths: string[], what: string): Promise<void> {
    if (!paths.length) return;
    const preview = paths.slice(0, 8).join("\n");
    const extra = paths.length > 8 ? `\n…and ${paths.length - 8} more` : "";
    const ok = await confirmDialog(`Discard ${what}?\n\n${preview}${extra}\n\nEdits in tracked files are gone for good. New files stay on disk.`, {
      okLabel: "Discard",
      danger: true,
    });
    if (!ok) return;
    await mutate(() => post("/discard", { paths }), { done: `Discarded ${plural(paths.length, "file")}.` });
  }

  async function send(): Promise<void> {
    const count = status.ahead ?? 0;
    await mutate(() => post("/push", { smart: true, branch: status.branch }), {
      motion: "send",
      done: spine.upstream ? `Sent ${plural(count, "commit")} to ${spine.upstream}.` : `${status.branch} is now on the remote and tracking it.`,
      fail: "Send failed",
    });
  }

  async function bring(): Promise<void> {
    const count = status.behind ?? 0;
    await mutate(() => post("/pull", { branch: status.branch }), {
      motion: "bring",
      done: `Brought in ${plural(count, "commit")}.`,
      fail: "Bring in failed",
    });
  }

  async function fetchRemote(): Promise<void> {
    // No fetch route of its own; the pullable scan with fetch=1 refreshes every tracked remote.
    await mutate(async () => {
      await moduleGet(`${M}/pullable?fetch=1`);
    }, { done: "Checked the remote." });
  }

  async function addRemote(): Promise<void> {
    const url = await promptDialog("Remote URL (it will be called origin):");
    if (!url?.trim()) return;
    await mutate(() => post("/remote", { op: "add", name: "origin", url: url.trim() }), { done: "origin added." });
  }

  function openStoneMenu(anchor: HTMLElement, sha: string): void {
    const stone = stoneBySha(sha);
    if (!stone) return;
    const box = anchor.getBoundingClientRect();
    const hostBox = host.getBoundingClientRect();
    stoneMenu.innerHTML = `
      <button type="button" data-act="revert" data-sha="${esc(sha)}"><b>Revert this commit</b><small>Adds a new commit that undoes it</small></button>
      <button type="button" data-act="reset-to" data-sha="${esc(sha)}" class="is-danger"><b>Go back to here</b><small>Drops every commit after ${esc(stone.short)}</small></button>`;
    stoneMenu.hidden = false;
    stoneMenu.style.left = `${Math.min(box.left - hostBox.left, hostBox.width - 280)}px`;
    stoneMenu.style.top = `${box.bottom - hostBox.top + 4}px`;
  }

  function closeStoneMenu(): void {
    stoneMenu.hidden = true;
    stoneMenu.innerHTML = "";
  }

  function doPick(next: Pick): void {
    pick = next;
    closeStoneMenu();
    renderSpine();
    spineScroll.querySelector(".is-picked")?.scrollIntoView({ block: "nearest" });
    renderFocus();
    syncBusyControls();
  }

  /** Everything pickable, top to bottom, for j / k. */
  function pickOrder(): Pick[] {
    const out: Pick[] = [];
    for (const card of cards) {
      out.push({ kind: "card", id: card.id });
      for (const change of card.changes) out.push({ kind: "file", key: change.key });
    }
    spine.stones.forEach((stone, index) => {
      if (index === spine.lineAt) {
        out.push({ kind: "line" });
        spine.incoming.forEach((ghost) => out.push({ kind: "stone", sha: ghost.sha }));
      }
      out.push({ kind: "stone", sha: stone.sha });
    });
    if (spine.lineAt >= spine.stones.length) out.push({ kind: "line" });
    return out;
  }

  function samePick(a: Pick, b: Pick): boolean {
    if (!a || !b || a.kind !== b.kind) return false;
    if (a.kind === "card" && b.kind === "card") return a.id === b.id;
    if (a.kind === "file" && b.kind === "file") return a.key === b.key;
    if (a.kind === "stone" && b.kind === "stone") return a.sha === b.sha;
    return a.kind === "line";
  }

  function step(delta: number): void {
    const order = pickOrder();
    if (!order.length) return;
    const index = order.findIndex((candidate) => samePick(candidate, pick));
    const next = order[Math.max(0, Math.min(order.length - 1, index + delta))];
    doPick(next);
  }

  function runAct(act: string, target: HTMLElement): void {
    if (target instanceof HTMLButtonElement && target.disabled) return;
    if ((mutating || busyRepos.has(repo)) && !isBrowseAction(act)) return;
    if (act.startsWith("review-card:")) {
      return doPick({ kind: "card", id: act.slice("review-card:".length) });
    }
    if (act.startsWith("commit-card:")) {
      const card = cardById(act.slice("commit-card:".length));
      if (card) {
        if (pick?.kind !== "card" || pick.id !== card.id) doPick({ kind: "card", id: card.id });
        void commitCard(card);
      }
      return;
    }
    if (act.startsWith("discard-card:")) {
      const card = cardById(act.slice("discard-card:".length));
      if (card) {
        const paths = card.changes.filter((change) => change.kind !== "untracked" && cardPaths(card).includes(change.path)).map((change) => change.path);
        if (!paths.length) return failInFocus("Only new files are ticked. Delete those from disk.");
        void discardPaths(paths, card.kind === "turn" ? `what ${card.agent} changed` : "your edits");
      }
      return;
    }
    switch (act) {
      case "select-all":
      case "select-none": {
        const card = pick?.kind === "card" ? cardById(pick.id) : undefined;
        if (!card) return;
        leftOut.set(card.id, new Set(act === "select-none" ? card.changes.map((change) => change.path) : []));
        renderSpine();
        return renderFocusCard(card);
      }
      case "previous-file":
      case "next-file": {
        const files = allChanges();
        const selected = pick?.kind === "file" ? pick.key : "";
        const index = files.findIndex((change) => change.key === selected);
        const next = files[index + (act === "next-file" ? 1 : -1)];
        if (next) doPick({ kind: "file", key: next.key });
        return;
      }
      case "stage-file":
      case "unstage-file": {
        const change = pick?.kind === "file" ? changeByKey(pick.key) : undefined;
        if (!change || change.kind === "conflict") return;
        const staging = act === "stage-file";
        void mutate(() => post(staging ? "/stage" : "/unstage", { paths: [change.path] }), {
          done: `${fileName(change.path)} ${staging ? "staged" : "unstaged"}.`,
        });
        return;
      }
      case "retry-diff": {
        const pre = target.closest<HTMLElement>("[data-diff-url]");
        if (!pre) return;
        pre.innerHTML = loadingView("Loading diff…");
        pre.setAttribute("aria-busy", "true");
        const serial = focusSerial;
        void readDiff(pre.dataset.diffUrl!).then((patch) => {
          if (pre.isConnected && serial === focusSerial) void renderPatch(pre, patch);
        }).catch((error) => {
          if (pre.isConnected && serial === focusSerial) showDiffError(pre, String(error));
        });
        return;
      }
      case "retry-focus":
        return renderFocus();
      case "refresh":
        return void (repo ? refresh() : open());
      case "drawer":
        return drawer.hidden ? openDrawer() : closeDrawer();
      case "atlas":
        return atlas.hidden ? void openAtlas() : closeAtlas();
      case "focus-conflicts":
        return doPick({ kind: "card", id: "conflicts" });
      case "send":
        return void send();
      case "bring":
        return void bring();
      case "fetch":
        return void fetchRemote();
      case "add-remote":
        return void addRemote();
      case "agent-commit":
        return void (async () => {
          const button = target as HTMLButtonElement;
          button.disabled = true;
          try {
            await events.commitAllWithAgent(agentPrompt());
          } catch (error) {
            await alertDialog(`Could not hand the commit to an agent.\n\n${String(error)}`);
          } finally {
            if (button.isConnected) button.disabled = false;
          }
        })();
      case "discard-file": {
        const change = pick?.kind === "file" ? changeByKey(pick.key) : undefined;
        if (change?.kind === "unstaged") void discardPaths([change.path], `edits in ${fileName(change.path)}`);
        return;
      }
      case "resolve-file": {
        const change = pick?.kind === "file" ? changeByKey(pick.key) : undefined;
        if (change) void mutate(() => post("/stage", { paths: [change.path] }), { done: `${fileName(change.path)} marked resolved.` });
        return;
      }
      case "resolve-ai":
        return void mutate(() => post("/pull/resolve"), { motion: "merge", done: "Conflicts resolved. The rebase finished.", fail: "The agent could not resolve it" });
      case "continue-operation":
        return void mutate(() => post("/operation/continue"), { motion: "merge", done: `${status.operation ?? "Operation"} finished.` });
      case "abort-operation":
        return void (async () => {
          if (await confirmDialog(`Abort the ${status.operation ?? "operation"} and go back to before it began?`, { okLabel: "Abort", danger: true })) {
            void mutate(() => post("/operation/abort"), { done: "Back to before it began." });
          }
        })();
      case "undo-last":
        return void (async () => {
          const top = spine.stones[0];
          if (!top) return;
          if (await confirmDialog(`Take apart “${firstLine(top.subject, 60)}”?\n\nIts files stay changed and ready to commit again.`, { okLabel: "Undo commit" })) {
            const ok = await mutate(() => post("/undo-last"), { done: "Last commit taken apart. Its files are waiting again." });
            if (ok) safetyNote = null;
          }
        })();
      case "stash":
        return void (async () => {
          const ok = await mutate(() => post("/stash", { message: `Panel · ${status.branch ?? ""} · ${new Date().toLocaleTimeString()}` }), { done: "Put aside. Bring it back from the safety bar." });
          if (ok) noteSafety("Work put aside.", "Bring back", "stash-pop");
        })();
      case "stash-pop":
        return void mutate(() => post("/stash/pop"), { done: "Brought back.", fail: "Could not bring it back" });
      case "newbranch":
        return void (async () => {
          const name = await promptDialog("New branch name. It starts here and you switch to it:");
          if (name?.trim()) void mutate(() => post("/branch", { name: name.trim(), checkout: true }), { done: `On ${name.trim()} now.` });
        })();
      case "switch": {
        const name = target.dataset.branch ?? "";
        if (name && name !== status.branch) void mutate(() => post("/checkout", { ref: name }), { done: `On ${name} now.` });
        return;
      }
      case "merge":
        return void (async () => {
          const from = target.dataset.branch ?? "";
          const into = status.branch ?? "current";
          if (!from) return;
          if (await confirmDialog(`Merge ${from} into ${into}?\n\n${into} gains everything ${from} has. ${from} stays as it is.`, { okLabel: "Merge" })) {
            closeDrawer();
            void mutate(() => post("/merge", { ref: from }), { motion: "merge", done: `${from} is now part of ${into}.` });
          }
        })();
      case "delete-branch":
        return void (async () => {
          const name = target.dataset.branch ?? "";
          if (!name) return;
          if (await confirmDialog(`Delete branch ${name}?`, { okLabel: "Delete", danger: true })) {
            const result = await modulePost<{ error?: string; unmerged?: boolean }>(`${M}/branch/delete`, { repo, name });
            if (result.unmerged) {
              if (await confirmDialog(`${name} has commits that are nowhere else. Delete it anyway?`, { okLabel: "Delete anyway", danger: true })) {
                void mutate(() => post("/branch/delete", { name, force: true }), { done: `${name} deleted.` });
              }
              return;
            }
            if (result.error) return say(`Delete failed: ${result.error}`, false);
            await refresh();
            say(`${name} deleted.`);
          }
        })();
      case "stone-menu":
        return stoneMenu.hidden ? openStoneMenu(target, target.dataset.sha ?? "") : closeStoneMenu();
      case "revert":
        return void (async () => {
          const sha = target.dataset.sha ?? "";
          const stone = stoneBySha(sha);
          closeStoneMenu();
          if (!stone) return;
          if (allChanges().length) return say("Commit or put aside the waiting files first.", false);
          if (await confirmDialog(`Revert “${firstLine(stone.subject, 60)}”?\n\nA new commit undoes it. History stays.`, { okLabel: "Revert" })) {
            const before = graph.head ?? "";
            const ok = await mutate(() => post("/revert", { sha }), { motion: "commit", done: `Reverted ${stone.short}.` });
            if (ok && before) noteSafety(`Reverted ${stone.short}.`, "Go back", `reset-to-silent:${before}`);
          }
        })();
      case "reset-to":
        return void (async () => {
          const sha = target.dataset.sha ?? "";
          const stone = stoneBySha(sha);
          closeStoneMenu();
          if (!stone) return;
          const after = spine.stones.findIndex((candidate) => candidate.sha === sha);
          if (allChanges().length) return say("Commit or put aside the waiting files first.", false);
          if (await confirmDialog(`Go back to “${firstLine(stone.subject, 60)}”?\n\n${plural(Math.max(0, after), "commit")} after it will be dropped from this branch.`, { okLabel: "Go back", danger: true })) {
            const before = graph.head ?? "";
            const ok = await mutate(() => post("/undo", { sha }), { done: `Back at ${stone.short}.` });
            if (ok && before) noteSafety(`Went back to ${stone.short}.`, "Undo that", `reset-to-silent:${before}`);
          }
        })();
      default:
        if (act.startsWith("reset-to-silent:")) {
          const sha = act.slice("reset-to-silent:".length);
          void mutate(() => post("/undo", { sha }), { done: `Back at ${sha.slice(0, 7)}.` }).then((ok) => {
            if (ok) {
              safetyNote = null;
              renderSafety();
            }
          });
        }
    }
  }

  function agentPrompt(): string {
    const card = pick?.kind === "card" ? cardById(pick.id) : undefined;
    const paths = card ? cardPaths(card) : allChanges().map((change) => change.path);
    return [
      `Handle one complete Git commit for the repository at ${repo}.`,
      `Current branch: ${status.branch || "detached HEAD"}. Scope: ${plural(paths.length, "file")}${card?.prompt ? ` from this request: "${firstLine(card.prompt, 120)}"` : ""}.`,
      paths.length <= 40 ? `Files: ${paths.join(", ")}.` : "",
      "Inspect git status and the full diff for those files first. Run the most relevant quick checks.",
      "Then stage exactly those files and create one clear, concise commit that accurately describes the work.",
      "Do not push. If you find secrets, generated junk, unrelated changes, conflicts, or failing checks, stop and ask me instead of committing.",
    ]
      .filter(Boolean)
      .join(" ");
  }

  /* ------------------------------------------------------------ events */

  host.addEventListener("click", (event) => {
    const node = event.target as HTMLElement;
    const sweep = node.closest<HTMLElement>("[data-sweep]");
    if (sweep) {
      const mode = sweep.dataset.sweep;
      void openGitSweep(mode === "push" || mode === "sync" ? mode : "pull", {
        fixWithAgent: events.commitAllWithAgent,
      }).then(() => {
        if (!atlas.hidden) void openAtlas();
        void refresh();
      });
      return;
    }
    const openRow = node.closest<HTMLElement>("[data-open]");
    if (openRow) {
      const path = openRow.dataset.open ?? "";
      closeAtlas();
      if (clean(path) !== clean(repo)) events.openProject(path);
      return;
    }
    const actNode = node.closest<HTMLElement>("[data-act]");
    if (actNode) {
      runAct(actNode.dataset.act ?? "", actNode);
      return;
    }
    const pickNode = node.closest<HTMLElement>("[data-pick]");
    if (pickNode && !node.closest("label.tick")) {
      const raw = pickNode.dataset.pick ?? "";
      if (raw === "line") return doPick({ kind: "line" });
      const [kind, ...rest] = raw.split(":");
      const id = rest.join(":");
      if (kind === "card") return doPick({ kind: "card", id });
      if (kind === "file") return doPick({ kind: "file", key: id });
      if (kind === "stone") return doPick({ kind: "stone", sha: id });
    }
  });

  host.addEventListener("contextmenu", (event) => {
    const stone = (event.target as HTMLElement).closest<HTMLElement>(".stone:not(.is-ghost)");
    if (!stone) return;
    event.preventDefault();
    doPick({ kind: "stone", sha: stone.dataset.sha ?? "" });
    openStoneMenu(stone, stone.dataset.sha ?? "");
  });

  host.addEventListener("change", (event) => {
    const project = (event.target as HTMLElement).closest<HTMLSelectElement>(".project-pick");
    if (project) {
      const id = project.value;
      project.value = projectId;
      if (id !== projectId && events.projects().some((item) => item.id === id)) {
        events.selectProject(id);
      }
      return;
    }
    const tick = (event.target as HTMLElement).closest<HTMLInputElement>("[data-tick]");
    if (mutating || !tick || pick?.kind !== "card") return;
    const card = cardById(pick.id);
    if (!card) return;
    const out = leftOut.get(card.id) ?? new Set<string>();
    if (tick.checked) out.delete(tick.dataset.tick ?? "");
    else out.add(tick.dataset.tick ?? "");
    leftOut.set(card.id, out);
    renderSpine();
    renderFocusCard(card);
  });

  host.addEventListener("pointerdown", (event) => {
    if (stoneMenu.hidden) return;
    const node = event.target as HTMLElement;
    if (stoneMenu.contains(node) || node.closest('[data-act="stone-menu"]')) return;
    closeStoneMenu();
  });

  host.addEventListener("keydown", (event) => {
    const typing = (event.target as HTMLElement).closest("textarea, input, select");
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (mutating) return;
      const card = pick?.kind === "card" ? cardById(pick.id) : undefined;
      if (card && card.kind !== "conflict") return void commitCard(card);
      const move = nextMove();
      if (move.act) runAct(move.act, moveBar);
      return;
    }
    if (event.key === "Escape") {
      if (!stoneMenu.hidden) return closeStoneMenu();
      if (!atlas.hidden) return closeAtlas();
      if (!drawer.hidden) return closeDrawer();
      return;
    }
    if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "j" || event.key === "ArrowDown") {
      event.preventDefault();
      step(1);
    } else if (event.key === "k" || event.key === "ArrowUp") {
      event.preventDefault();
      step(-1);
    }
  });

  /* ------------------------------------------------------------ handle */

  return {
    setProject(nextProjectId, path) {
      if (path === projectPath && nextProjectId === projectId) {
        if (reading && !repo) return;
        if (repo) render();
        void (repo ? refresh() : open());
        return;
      }
      projectId = nextProjectId;
      projectPath = path;
      void open();
    },
    refresh() {
      void refresh();
    },
    playMoment(kind, payload = {}) {
      const command = String(payload.command ?? "");
      const subject = String(payload.subject ?? payload.message ?? /(?:-m|--message(?:=|\s+))\s*["']([^"']+)/i.exec(command)?.[1] ?? "");
      const verb = { commit: "committed", push: "sent", pull: "brought in", merge: "merged" }[kind] ?? kind;
      say(`Agent ${verb}${subject ? `: ${firstLine(subject, 60)}` : "."}`);
      void refresh();
    },
  };
}
