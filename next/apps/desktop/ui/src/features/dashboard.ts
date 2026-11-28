
import type { GitState, Project, WorkFile } from "../types";
import { icon, type IconName } from "../icons";
import { projectIconUrl } from "../project-assets";
import { ENGINES, type SessionKind } from "./agent-kinds";
import type { ProjectRunView } from "./runner";
import { openGitSweep } from "./git-sync";
import { nextMove, plural, type Tone as MoveTone } from "./next-move";
import "./dashboard.css";

const esc = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      (({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }) as Record<
        string,
        string
      >)[c] ?? c,
  );

export type Door = "files" | "git" | "product-spine" | "release" | "revenuecat" | "analytics";

export type DashboardEvents = {
  runWithAgent(prompt: string): Promise<void>;
  openSession(kind: SessionKind): void;
  run(): void;
  stop(): void;
  nudge(restart: boolean): void;
  openFolder(): void;
  installed(module: string): boolean;
};

export type DashboardHandle = {
  setModules(enabled: ReadonlySet<string>): void;
  setProject(project: Project, git: GitState, running: boolean): void;
  setWork(list: WorkFile[]): void;
  workshopHost: HTMLElement;
  stageHost: HTMLElement;
  syncStage(): void;
  setLive(run: ProjectRunView | null, agents: number, shells: number): void;
};

type Tone = MoveTone;

const TONES: readonly Tone[] = ["mute", "ok", "warn", "risk", "live"];

type Fact = { label: HTMLElement; value: HTMLElement; note: HTMLElement };

function tone(node: HTMLElement, next: Tone | null): void {
  for (const name of TONES) node.classList.toggle(`t-${name}`, name === next);
}

function text(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

function makeFact(host: HTMLElement): Fact {
  const root = document.createElement("div");
  root.className = "dash-fact";
  root.innerHTML = `<label></label><b></b><small></small>`;
  host.append(root);
  return {
    label: root.querySelector("label")!,
    value: root.querySelector("b")!,
    note: root.querySelector("small")!,
  };
}

function paintFact(
  fact: Fact,
  label: string,
  value: string,
  note: string,
  t: Tone | null,
  mono = false,
): void {
  text(fact.label, label);
  text(fact.value, value);
  text(fact.note, note);
  tone(fact.value, t);
  fact.value.classList.toggle("is-mono", mono);
}

type Card = {
  root: HTMLElement;
  body: HTMLElement;
  meta: HTMLElement;
};

function makeCard(
  host: HTMLElement,
  mod: string,
  iconName: IconName,
  title: string,
  doorLabel: string,
  open: () => void,
): Card {
  const root = document.createElement("section");
  root.className = `dash-card c-${mod}`;
  root.innerHTML = `
    <header class="dash-card-head">
      <span class="dash-card-ico">${icon(iconName)}</span>
      <span class="dash-card-title">${title}</span>
      <span class="dash-card-meta"></span>
    </header>
    <div class="dash-card-body"></div>
    <footer class="dash-card-foot">
      <button class="dash-door" type="button">${doorLabel} <span aria-hidden="true">→</span></button>
    </footer>`;

  const go = (): void => open();
  root.querySelector<HTMLButtonElement>(".dash-door")!.addEventListener("click", go);
  root.addEventListener("click", (event) => {
    if (!(event.target as HTMLElement).closest("a, button")) go();
  });

  host.append(root);
  return {
    root,
    body: root.querySelector<HTMLElement>(".dash-card-body")!,
    meta: root.querySelector<HTMLElement>(".dash-card-meta")!,
  };
}

function commitAndPushPrompt(project: Project, git: GitState | null): string {
  const dirty = git?.dirty ?? 0;
  return [
    `Commit and push everything in the repository at ${project.path}.`,
    `Current branch: ${git?.branch || "detached HEAD"}. Current scope: ${dirty} changed ${dirty === 1 ? "file" : "files"}.`,
    "Inspect git status and the full diff first, then run the most relevant quick checks for these changes.",
    "Stage every current change, create one clear, concise commit that accurately describes the work, and push it to the tracked remote.",
    "If you find secrets, credentials, generated junk, unrelated changes that should not be combined, conflicts, or failing checks, stop and ask me instead of committing.",
  ].join(" ");
}

export function mountDashboard(
  host: HTMLElement,
  open: (door: Door) => void,
  events: DashboardEvents,
): DashboardHandle {
  const root = document.createElement("div");
  root.className = "dash";


  const head = document.createElement("header");
  head.className = "dash-head";
  head.innerHTML = `
    <div class="dash-tile"><span></span><img alt="" draggable="false" /></div>
    <div class="dash-id">
      <div class="dash-name"></div>
      <div class="dash-path"></div>
    </div>
    <div class="dash-verdict"><i></i><span></span></div>`;
  const tile = head.querySelector<HTMLElement>(".dash-tile")!;
  const tileGlyph = tile.querySelector<HTMLElement>("span")!;
  const tileImage = tile.querySelector<HTMLImageElement>("img")!;
  const name = head.querySelector<HTMLElement>(".dash-name")!;
  const path = head.querySelector<HTMLElement>(".dash-path")!;
  const verdict = head.querySelector<HTMLElement>(".dash-verdict")!;
  const verdictText = verdict.querySelector<HTMLElement>("span")!;


  const priority = document.createElement("section");
  priority.className = "dash-priority";
  priority.innerHTML = `
    <span class="dash-priority-art" aria-hidden="true"></span>
    <span class="dash-priority-mark" aria-hidden="true"></span>
    <div class="dash-priority-copy">
      <label>NEXT MOVE</label>
      <strong></strong>
      <p></p>
    </div>
    <button class="dash-priority-action" type="button" hidden></button>`;
  const priorityTitle = priority.querySelector<HTMLElement>("strong")!;
  const priorityBody = priority.querySelector<HTMLElement>("p")!;
  const priorityAction = priority.querySelector<HTMLButtonElement>("button")!;
  let priorityDoor: Door | null = null;
  priorityAction.addEventListener("click", () => {
    if (priorityDoor) open(priorityDoor);
  });


  const actions = document.createElement("section");
  actions.className = "dash-actions";
  actions.innerHTML = `
    <div class="dash-do">
      <button class="dash-go is-primary" type="button" data-do="claude">
        ${icon("agent")}<span>Start Claude</span></button>
      <button class="dash-go is-caret" type="button" data-do="engines" aria-expanded="false"
        aria-label="Start another engine" title="Start another engine">
        <span aria-hidden="true">⌄</span></button>
    </div>
    <button class="dash-go" type="button" data-do="shell">
      ${icon("terminal")}<span>Shell</span></button>
    <button class="dash-go" type="button" data-do="run">
      ${icon("play")}<span>Run app</span></button>
    <button class="dash-go is-stop" type="button" data-do="stop" hidden>
      ${icon("stop")}<span>Stop</span></button>
    <button class="dash-go" type="button" data-do="reload" hidden title="Hot reload (r)">
      ${icon("reload")}<span>Reload</span></button>
    <button class="dash-go" type="button" data-do="folder">
      ${icon("folder")}<span>Open folder</span></button>
    <span class="dash-live"></span>`;

  const engines = document.createElement("div");
  engines.className = "dash-engines";
  engines.hidden = true;
  engines.innerHTML = ENGINES.filter((engine) => engine.kind !== "claude" && engine.kind !== "shell")
    .map(
      (engine) =>
        `<button class="dash-engine" type="button" data-kind="${engine.kind}">
           ${icon(engine.glyph)}<span>${esc(engine.name)}</span>${
             engine.sub ? `<small>${esc(engine.sub)}</small>` : ""
           }</button>`,
    )
    .join("");

  const caret = actions.querySelector<HTMLButtonElement>('[data-do="engines"]')!;
  const runButton = actions.querySelector<HTMLButtonElement>('[data-do="run"]')!;
  const stopButton = actions.querySelector<HTMLButtonElement>('[data-do="stop"]')!;
  const reloadButton = actions.querySelector<HTMLButtonElement>('[data-do="reload"]')!;
  const live = actions.querySelector<HTMLElement>(".dash-live")!;

  actions.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-do]");
    if (!button) return;
    switch (button.dataset.do) {
      case "claude":
        return events.openSession("claude");
      case "shell":
        return events.openSession("shell");
      case "run":
        return events.run();
      case "stop":
        return events.stop();
      case "reload":
        return events.nudge(false);
      case "folder":
        return events.openFolder();
      case "engines": {
        const open = engines.hidden !== false;
        engines.hidden = !open;
        caret.setAttribute("aria-expanded", String(open));
        caret.classList.toggle("is-open", open);
        return;
      }
    }
  });

  engines.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-kind]");
    if (!button) return;
    events.openSession(button.dataset.kind as SessionKind);
  });


  const facts = document.createElement("section");
  facts.className = "dash-facts";
  const branch = makeFact(facts);
  const tree = makeFact(facts);
  const remote = makeFact(facts);

  const note = document.createElement("section");
  note.className = "dash-note";
  note.innerHTML = `<b></b><small></small><code></code>`;
  const noteTitle = note.querySelector<HTMLElement>("b")!;
  const noteBody = note.querySelector<HTMLElement>("small")!;
  const notePath = note.querySelector<HTMLElement>("code")!;


  const grid = document.createElement("section");
  grid.className = "dash-grid";

  const work = makeCard(grid, "work", "work", "Work", "Open work", () => open("files"));
  const gitCard = makeCard(grid, "git", "git", "Git", "Open git", () => open("git"));

  const gitChips = document.createElement("div");
  gitChips.className = "dash-chips";
  const gitSync = document.createElement("div");
  gitSync.className = "dash-sync";
  gitSync.innerHTML = `
    <button class="dash-act is-primary" type="button" data-sweep="sync"
      title="Pull then push every tracked repository. An agent fixes what code cannot.">
      <span class="dash-act-arrow" aria-hidden="true">⇅</span><span>Sync all</span></button>
    <button class="dash-act" type="button" data-sweep="pull" title="Pull every tracked repository">
      <span class="dash-act-arrow" aria-hidden="true">↓</span><span>Pull all</span></button>
    <button class="dash-act" type="button" data-sweep="push" title="Push every tracked repository">
      <span class="dash-act-arrow" aria-hidden="true">↑</span><span>Push all</span></button>
    <button class="dash-act is-agent" type="button" data-sweep="agent"
      title="Hand this repository's commit and push to an agent">
      ${icon("agent")}<span>Commit all &amp; push</span></button>`;
  gitCard.body.append(gitChips, gitSync);

  const agentButton = gitSync.querySelector<HTMLButtonElement>('[data-sweep="agent"]')!;
  gitSync.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-sweep]");
    if (!button) return;
    if (button.dataset.sweep === "agent") return void handToAgent();
    const mode = button.dataset.sweep;
    void openGitSweep(mode === "push" || mode === "sync" ? mode : "pull", {
      fixWithAgent: events.runWithAgent,
    });
  });

  async function handToAgent(): Promise<void> {
    if (!currentProject) return;
    const label = agentButton.innerHTML;
    agentButton.disabled = true;
    agentButton.innerHTML = `${icon("agent")}<span>Opening agent…</span>`;
    try {
      await events.runWithAgent(commitAndPushPrompt(currentProject, currentGit));
    } finally {
      agentButton.disabled = false;
      agentButton.innerHTML = label;
    }
  }

  const productSpine = makeCard(
    grid,
    "spine",
    "spine",
    "Product Spine",
    "Open Product Spine",
    () => open("product-spine"),
  );
  const release = makeCard(grid, "rel", "release", "Release", "Open release", () => open("release"));
  const revenuecat = makeCard(
    grid,
    "rc",
    "revenue",
    "RevenueCat",
    "Open revenue",
    () => open("revenuecat"),
  );
  window.addEventListener("panel-revenuecat-updated", (event) => {
    const path = (event as CustomEvent<string>).detail;
    if (currentProject?.path === path && enabledModules.has("revenuecat")) {
      void import("./revenuecat").then(({ paintRevenueCatCard }) =>
        paintRevenueCatCard(path, revenuecat.body),
      );
    }
  });
  const analytics = makeCard(grid, "an", "analytics", "Analytics", "Open analytics", () => open("analytics"));
  const standards = makeCard(grid, "std", "standards", "Standards", "Review all", () => {
    if (!currentProject) return;
    void events.runWithAgent(
      `Report ${currentProject.path} against every portfolio standard in ~/.appgeapanel/ops/standards/. ` +
        `Run \`python3 ~/.appgeapanel/ops/_system/standards.py\` and read this app's row. ` +
        "Say what it fails and what it would take to pass. Change nothing yet.",
    );
  });

  productSpine.body.innerHTML = `
    <p class="dash-lede">Every part of the product, how wide and deep it is, and where it
    should grow.</p>`;


  const workshop = document.createElement("section");
  workshop.className = "dash-workshop";


  const stage = document.createElement("section");
  stage.className = "dash-stage";
  stage.innerHTML = `<label>AGENT OUTPUT</label><div class="dash-stage-list"></div>`;
  const stageList = stage.querySelector<HTMLElement>(".dash-stage-list")!;

  root.append(head, priority, actions, engines, facts, note, grid, workshop, stage);
  host.replaceChildren(root);

  const syncStage = (): void => {
    stage.hidden = !stageList.firstElementChild?.childElementCount;
  };
  syncStage();

  let shown: string | null = null;
  let enabledModules = new Set(["git", "product-spine", "release"]);
  let currentProject: Project | null = null;
  let currentGit: GitState | null = null;
  let currentRunning = false;
  let currentWork: WorkFile[] = [];

  function paintRun(run: ProjectRunView | null): void {
    const busy = run?.busy === true;
    const alive = run?.live === true;
    runButton.hidden = alive;
    stopButton.hidden = !alive;
    runButton.disabled = busy;
    stopButton.disabled = busy;
    reloadButton.hidden = !alive || run?.kind !== "flutter";
    if (run && (run.state === "launching" || run.state === "building")) {
      text(runButton.querySelector("span")!, run.state === "building" ? "Building…" : "Launching…");
    } else {
      text(runButton.querySelector("span")!, "Run app");
    }
  }

  function paintLive(run: ProjectRunView | null, agents: number, shells: number): void {
    const parts: string[] = [];
    if (agents > 0) parts.push(plural(agents, "agent", "agents"));
    if (shells > 0) parts.push(plural(shells, "shell", "shells"));
    if (run?.live) parts.push(run.device ? `app on ${run.device}` : "app running");
    else if (run?.error) parts.push("run failed");
    text(live, parts.join(" · "));
    tone(live, run?.error ? "risk" : parts.length ? "live" : null);
  }

  function paintPriority(): void {
    if (!currentProject || !currentGit) return;

    const move = nextMove({
      exists: currentProject.exists,
      work: currentWork.length,
      why: currentWork[0]?.why,
      running: currentRunning,
      git: currentGit,
    });
    const { title, detail, action, door, mood } = move;
    const verdictWord = move.verdict;
    const verdictMood = move.verdictMood;

    text(priorityTitle, title);
    text(priorityBody, detail);
    priorityDoor = door;
    priorityAction.hidden = !door;
    text(priorityAction, action ? `${action}  →` : "");
    tone(priority, mood);
    priority.dataset.state = mood;
    text(verdictText, verdictWord);
    tone(verdict, verdictMood);
  }

  return {
    workshopHost: workshop,
    stageHost: stageList,
    syncStage,
    setLive(run, agents, shells) {
      paintRun(run);
      paintLive(run, agents, shells);
    },
    setModules(enabled) {
      enabledModules = new Set(enabled);
      productSpine.root.hidden = !enabledModules.has("product-spine");
      release.root.hidden = !enabledModules.has("release");
      revenuecat.root.hidden = !enabledModules.has("revenuecat");
      analytics.root.hidden = !events.installed("analytics");
      standards.root.hidden = !events.installed("standards");
      if (!enabledModules.has("git")) gitCard.root.hidden = true;
    },

    setWork(list) {
      currentWork = [...list];
      work.root.hidden = list.length === 0;
      text(work.meta, list.length ? `${list.length} waiting` : "");
      if (!list.length) {
        work.body.innerHTML = "";
        paintPriority();
        return;
      }
      const rows = list
        .slice(0, 3)
        .map(
          (file) =>
            `<div class="dash-work-row">
               <code>${esc(file.path.split("/").pop())}</code>
               <small>${esc(file.why ?? "changed")}</small>
             </div>`,
        )
        .join("");
      const rest = list.length > 3 ? `<div class="dash-more">+${list.length - 3} more</div>` : "";
      work.body.innerHTML = rows + rest;
      paintPriority();
    },

    setProject(project, git, running) {
      currentProject = project;
      currentGit = git;
      currentRunning = running;
      text(name, project.name);
      text(path, project.path);
      text(tileGlyph, project.name.slice(0, 1).toUpperCase());
      if (tile.dataset.project !== project.id) {
        tile.dataset.project = project.id;
        tileImage.hidden = false;
        tileImage.src = projectIconUrl(project.id);
      }
      tileImage.onerror = () => {
        tileImage.hidden = true;
      };

      const missing = !project.exists;
      const repo = project.exists && git.is_repo;

      paintPriority();


      facts.hidden = !repo;
      note.hidden = repo;
      grid.hidden = missing;
      workshop.hidden = missing;
      actions.hidden = missing;
      if (missing) engines.hidden = true;

      if (repo) {
        paintFact(
          branch,
          "branch",
          git.branch || "detached",
          running ? "agent working here" : "checked out",
          running ? "live" : null,
          true,
        );

        paintFact(
          tree,
          "changes",
          git.dirty === 0 ? "clean" : String(git.dirty),
          git.dirty === 0 ? "nothing uncommitted" : plural(git.dirty, "file changed", "files changed"),
          git.dirty === 0 ? "mute" : git.dirty >= 10 ? "warn" : null,
        );

        const parts: string[] = [];
        if (git.ahead > 0) parts.push(`↑${git.ahead}`);
        if (git.behind > 0) parts.push(`↓${git.behind}`);
        const summary: string[] = [];
        if (git.ahead > 0) summary.push(plural(git.ahead, "commit to push", "commits to push"));
        if (git.behind > 0) summary.push(plural(git.behind, "commit to pull", "commits to pull"));
        paintFact(
          remote,
          "sync",
          parts.length ? parts.join(" ") : "in sync",
          summary.length ? summary.join(" · ") : "nothing to send or fetch",
          git.behind > 0 ? "warn" : parts.length ? null : "mute",
        );
      } else if (missing) {
        text(noteTitle, "This folder is gone");
        text(
          noteBody,
          "Panel has the project but the path no longer resolves on disk. It was moved, renamed, or deleted — no agent can run here until it is restored or the project is re-added.",
        );
        text(notePath, project.path);
        tone(note, "risk");
      } else {
        text(noteTitle, "Not a git repository");
        text(
          noteBody,
          running
            ? "An agent is working in this folder, but it is not under version control — there is no branch, no diff, and nothing to push."
            : "This folder is not under version control, so there is no branch, no diff, and nothing to push. That is a legitimate state — just not one git can report on.",
        );
        text(notePath, project.path);
        tone(note, null);
      }


      gitCard.root.hidden = !repo || !enabledModules.has("git");
      if (repo && enabledModules.has("git")) {
        text(gitCard.meta, git.branch || "detached");
        const chips: string[] = [];
        if (git.dirty > 0) chips.push(`<span class="chip warn">${git.dirty} changed</span>`);
        if (git.ahead > 0) chips.push(`<span class="chip ok">↑${git.ahead} to push</span>`);
        if (git.behind > 0) chips.push(`<span class="chip risk">↓${git.behind} to pull</span>`);
        if (!chips.length) chips.push(`<span class="chip mute">clean · in sync</span>`);
        gitChips.innerHTML = chips.join("");
        agentButton.hidden = git.dirty === 0;
      }


      if (shown !== project.id && project.exists && enabledModules.has("release")) {
        void import("./release").then(({ paintRelease }) =>
          paintRelease(project.path, release.body),
        );
      }

      if (shown !== project.id && project.exists && enabledModules.has("revenuecat")) {
        void import("./revenuecat").then(({ paintRevenueCatCard }) =>
          paintRevenueCatCard(project.path, revenuecat.body),
        );
      }

      if (shown !== project.id && project.exists && events.installed("analytics")) {
        void import("./analytics").then(({ paintAnalyticsCard }) =>
          paintAnalyticsCard(project.path, analytics.body),
        );
      }


      if (shown !== project.id && project.exists && events.installed("standards")) {
        void import("./standards").then(({ paintStandardsCard }) =>
          paintStandardsCard(project.path, standards.body, (prompt) => {
            void events.runWithAgent(prompt);
          }),
        );
      }


      if (shown !== project.id) {
        shown = project.id;
        root.classList.remove("is-enter");
        void root.offsetWidth; // reflow: lets the animation restart on the next project
        root.classList.add("is-enter");
      }
    },
  };
}
