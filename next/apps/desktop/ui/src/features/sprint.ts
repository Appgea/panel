/**
 * Sprint — the two-week plan, and the one answer to "what do I do next".
 *
 * Home says what is moving. This screen says what is PLANNED: the sprint's goals in focus order,
 * which one is next, which are being worked on right now, and where every agent left off. It
 * reads `ops/sprints/<id>.md` through the host and writes back only what a human decides —
 * done, blocked, a new goal, a log line. Whether a goal is in flight is never written: it is a
 * live session Panel started from that goal, and it stops being true the moment the session
 * ends. Same rule Home uses for "working".
 *
 * MOTION: the entrance plays once per open. A refresh repaints in place.
 */

import { icon } from "../icons";
import { plainText } from "../plain";
import { ENGINES, type SessionKind } from "./agent-kinds";
import { createCodeEditor } from "./editor";
import "./sprint.css";

export type SprintGoal = {
  index: number;
  app: string;
  app_name: string;
  project: string | null;
  owner: string;
  text: string;
  done_when: string;
  state: "todo" | "done" | "blocked";
};

export type Sprint = {
  id: string;
  title: string;
  starts: string;
  ends: string;
  focus: string[];
  phase: "active" | "planned" | "past";
  goals: SprintGoal[];
  log: string[];
  path: string;
};

export type SprintApp = { key: string; name: string; project: string | null };

export type SprintReport = {
  project: string;
  project_name: string;
  at: string;
  title: string;
  outcome: string;
  /** The agent stopped and wants you. These are promoted out of the list. */
  waiting: boolean;
  since_start: number;
};

/** What moved in an app's repo during the running sprint. All of it read live from git. */
export type SprintActivity = {
  app: string;
  project: string;
  project_name: string;
  branch: string;
  commits: number;
  last_subject: string;
  last_when: string;
  last_is_older: boolean;
  dirty: number;
  ahead: number;
  reports: number;
};

export type SprintBoard = {
  today: string;
  sprints: Sprint[];
  apps: SprintApp[];
  blocked: string[];
  reports: SprintReport[];
  /** Which sprint `activity` was measured for. Empty when none is running. */
  measured_for: string;
  activity: SprintActivity[];
};

export type SprintEvents = {
  board(): Promise<SprintBoard>;
  setGoal(sprint: string, index: number, text: string, state: SprintGoal["state"]): Promise<void>;
  addGoal(sprint: string, app: string, owner: string, text: string, doneWhen: string): Promise<void>;
  create(id: string, title: string, starts: string, ends: string, focus: string[]): Promise<Sprint>;
  /** The sprint file as it sits on disk, for the hand editor. */
  readRaw(sprint: string): Promise<string>;
  /** Save a hand edit over the exact text the editor loaded. Rejects when someone else wrote. */
  writeRaw(sprint: string, text: string, expect: string): Promise<void>;
  /** Open the goal's project, start an agent there and hand it the goal. Resolves to the
   *  session id, or null when nothing started. The screen is gone by then — that is the point. */
  startGoal(sprint: Sprint, goal: SprintGoal, kind: SessionKind, prompt: string): Promise<string | null>;
  /** Jump to the terminal working a goal. */
  openSession(project: string, session: string): void;
  isLive(session: string): boolean;
  openProject(project: string): void;
  /** Put a question to the manager, in its own terminal. */
  askCpo(prompt: string): void;
};

export type SprintHandle = {
  open(): Promise<void>;
  /** Cheap repaint for what changes underneath — a session ended, a goal's chip goes dark. */
  sync(): void;
  clear(): void;
  isOpen(): boolean;
};

const KIND_KEY = "panel.sprint.kind";
const BINDINGS_KEY = "panel.sprint.bindings";
const AGENT_KINDS = ENGINES.filter((engine) => engine.kind !== "shell");

const make = (tag: string, className?: string, text?: string): HTMLElement => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const button = (className: string, label: string, title: string, onClick: () => void): HTMLButtonElement => {
  const node = make("button", className) as HTMLButtonElement;
  node.type = "button";
  node.innerHTML = label;
  node.title = title;
  node.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return node;
};

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

const message = (error: unknown): string =>
  typeof error === "string" ? error : error instanceof Error ? error.message : String(error);

/* ---------------------------------------------------------------- dates
 * Everything is `YYYY-MM-DD` text. Parsing goes through UTC so a sprint that starts on the 24th
 * starts on the 24th in every timezone, and day arithmetic is plain division.
 */

const dayOf = (ymd: string): number | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000;
};

const ymd = (day: number): string => new Date(day * 86_400_000).toISOString().slice(0, 10);

const shortDate = (value: string): string => {
  const day = dayOf(value);
  if (day == null) return value;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" }).format(
    day * 86_400_000,
  );
};

/** `2026-w35` — the ISO week, which is what the template asks for. */
const weekId = (today: string): string => {
  const day = dayOf(today);
  if (day == null) return today;
  const date = new Date(day * 86_400_000);
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-w${String(week).padStart(2, "0")}`;
};

/* ------------------------------------------------------------- bindings
 * goal → the session started for it. Kept per viewer in localStorage so a reload keeps the
 * chips lit while the terminals are restored. A binding whose session is gone is dropped on
 * the next paint, so nothing here can outlive the truth.
 */

type Binding = { session: string; project: string };

const goalKey = (sprint: Sprint, goal: SprintGoal): string => `${sprint.id}#${goal.text}`;

const loadBindings = (): Record<string, Binding> => {
  try {
    const raw = localStorage.getItem(BINDINGS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, Binding>) : {};
  } catch {
    return {};
  }
};

const saveBindings = (bindings: Record<string, Binding>): void => {
  try {
    localStorage.setItem(BINDINGS_KEY, JSON.stringify(bindings));
  } catch {
    /* a private window; the chips just do not survive a reload */
  }
};

/* --------------------------------------------------------------- prompts */

const planPrompt = (id: string, today: string): string =>
  `Plan sprint ${id}. Read now.md, backlog.md, rollouts/*.md and sprints/_template.md. ` +
  `Write sprints/${id}.md: starts ${today}, ends 13 days later, at most 8 goals, ` +
  `deadline-bound and blocked-on-me items first, focus ranked. Do not ask me questions. ` +
  `Then say what you picked in 5 lines.`;

const nextPrompt = (sprint: Sprint | null): string =>
  sprint
    ? `What should I do next? Read sprints/${sprint.id}.md and now.md. Answer in 3 lines: the one goal, why it is first, the first step.`
    : `What should I do next? Read now.md. Answer in 3 lines: the one thing, why, the first step.`;

const goalPrompt = (sprint: Sprint, goal: SprintGoal): string => {
  const when = goal.done_when ? ` Done when: ${goal.done_when}.` : "";
  return (
    `Sprint ${sprint.id} goal for ${goal.app_name}: ${goal.text}.${when} ` +
    `Read every module the goal touches before you edit. ` +
    `When done or blocked, report with send_to_user (outcome done or blocked).`
  );
};

export function mountSprint(host: HTMLElement, events: SprintEvents): SprintHandle {
  /**
   * Two roots, because they have opposite lifetimes.
   *
   * The plan is rebuilt on every read — it is a projection of a file. The hand editor is built
   * once and kept: a CodeMirror torn down mid-sentence takes your cursor, your undo history and
   * whatever you had not saved with it. So `paint()` only ever replaces what is inside `plan`.
   */
  const plan = make("div", "sp-plan");
  const editRoot = make("div", "sp-edit");
  editRoot.hidden = true;
  host.replaceChildren(plan, editRoot);

  let openState = false;
  let board: SprintBoard | null = null;
  /** Which sprint the screen shows. Defaults to the active one; a chip in "Other sprints"
   *  switches it, and the switch does not survive clear(). */
  let viewing: string | null = null;
  let bindings = loadBindings();
  let inner: HTMLElement | null = null;
  let busy = false;

  /* ------------------------------------------------------------ derived */

  const current = (): Sprint | null => {
    if (!board) return null;
    return board.sprints.find((s) => s.id === viewing) ?? board.sprints.find((s) => s.phase === "active") ?? null;
  };

  const rank = (sprint: Sprint, app: string): number => {
    const at = sprint.focus.indexOf(app);
    return at < 0 ? 99 : at;
  };

  const ordered = (sprint: Sprint): SprintGoal[] =>
    [...sprint.goals].sort((a, b) => rank(sprint, a.app) - rank(sprint, b.app) || a.index - b.index);

  const liveBinding = (sprint: Sprint, goal: SprintGoal): Binding | null => {
    const binding = bindings[goalKey(sprint, goal)];
    if (!binding) return null;
    if (events.isLive(binding.session)) return binding;
    delete bindings[goalKey(sprint, goal)];
    saveBindings(bindings);
    return null;
  };

  /** Movement is measured for the running sprint only, so a past sprint shows the plan and no
   *  numbers. Numbers under the wrong window would be worse than none. */
  const activityFor = (sprint: Sprint, app: string): SprintActivity | null =>
    board && board.measured_for === sprint.id
      ? (board.activity.find((entry) => entry.app === app) ?? null)
      : null;

  /** An agent that stopped and wants a human. Same band as `now.md`'s blocked list, because to
   *  you they are one question: what is waiting on me right now. */
  const waitingReports = (): SprintReport[] => (board ? board.reports.filter((r) => r.waiting) : []);

  const nextUp = (sprint: Sprint): SprintGoal | null =>
    ordered(sprint).find((goal) => goal.state === "todo" && !liveBinding(sprint, goal)) ?? null;

  const preferredKind = (): SessionKind => {
    const saved = localStorage.getItem(KIND_KEY) as SessionKind | null;
    return saved && AGENT_KINDS.some((engine) => engine.kind === saved) ? saved : "claude";
  };

  /* -------------------------------------------------------------- actions */

  const reload = async (): Promise<void> => {
    board = await events.board();
    paint();
  };

  /** Run a mutation, then re-read the file. Every write goes through here so a failure lands in
   *  the same place and the screen never shows a state it did not read back. */
  const mutate = async (work: () => Promise<unknown>): Promise<void> => {
    if (busy) return;
    busy = true;
    inner?.classList.add("is-busy");
    try {
      await work();
      await reload();
    } catch (error) {
      note(message(error), true);
    } finally {
      busy = false;
      inner?.classList.remove("is-busy");
    }
  };

  /* ----------------------------------------------------------- hand editor
   * The plan is written by an agent, and it is still a Markdown file you own. Everything below
   * exists so that stays true: you open the real text, you save it, and neither writer silently
   * overwrites the other.
   */

  let editing = false;
  let editor: ReturnType<typeof createCodeEditor> | null = null;
  /** Exactly what the editor was handed. The save sends it back so the host can refuse a write
   *  that would land on somebody else's version. */
  let loadedText = "";
  let editStatus: HTMLElement | null = null;
  let editPath: HTMLElement | null = null;
  let editOf = "";

  const editDirty = (): boolean => Boolean(editor) && editor!.doc() !== loadedText;

  const sayEdit = (text: string, failed = false): void => {
    if (!editStatus) return;
    editStatus.textContent = text;
    editStatus.classList.toggle("is-error", failed);
  };

  const buildEditor = (): void => {
    if (editor) return;
    const head = make("header", "sp-edit-head");
    const path = make("span", "sp-edit-path");
    const save = make("button", "sp-btn", "Save") as HTMLButtonElement;
    save.type = "button";
    const close = make("button", "sp-btn is-quiet", "Done") as HTMLButtonElement;
    close.type = "button";
    editStatus = make("span", "sp-edit-status", "");
    head.append(make("b", undefined, "Editing the sprint file"), path, editStatus, save, close);
    const body = make("div", "sp-edit-body");
    editRoot.replaceChildren(head, body);

    editor = createCodeEditor({
      parent: body,
      visibilityHost: editRoot,
      onSave: () => void saveEdit(),
      onUpdate: (update) => {
        if (!update.docChanged) return;
        sayEdit(editDirty() ? "Unsaved" : "Saved");
      },
    });
    editor.blank();
    editPath = path;
    save.addEventListener("click", () => void saveEdit());
    close.addEventListener("click", () => void closeEditor());
  };

  const openEditor = async (sprintId: string): Promise<void> => {
    buildEditor();
    editing = true;
    editOf = sprintId;
    plan.hidden = true;
    editRoot.hidden = false;
    try {
      const text = await events.readRaw(sprintId);
      loadedText = text;
      editor!.load(`${sprintId}.md`, text);
      if (editPath) {
        editPath.textContent = board?.sprints.find((s) => s.id === sprintId)?.path ?? `${sprintId}.md`;
      }
      sayEdit("Saved");
      editor!.view.focus();
    } catch (error) {
      sayEdit(message(error), true);
    }
  };

  const saveEdit = async (): Promise<void> => {
    if (!editor || !editing) return;
    const text = editor.doc();
    sayEdit("Saving…");
    try {
      await events.writeRaw(editOf, text, loadedText);
      loadedText = text;
      sayEdit("Saved");
      await reload();
    } catch (error) {
      sayEdit(message(error), true);
    }
  };

  const closeEditor = async (): Promise<void> => {
    if (editDirty() && !window.confirm("This sprint has unsaved edits. Close and lose them?")) return;
    editing = false;
    editRoot.hidden = true;
    plan.hidden = false;
    await reload();
  };

  /** An agent rewrote the file underneath. A clean buffer takes the new text silently; a dirty
   *  one keeps yours and says so, because nothing you typed may vanish without a click. */
  const editorSawDisk = async (): Promise<void> => {
    if (!editing || !editor) return;
    try {
      const text = await events.readRaw(editOf);
      if (text === loadedText) return;
      if (editDirty()) {
        sayEdit("An agent rewrote this file. Your edits are still here — saving will be refused.", true);
        return;
      }
      loadedText = text;
      editor.load(`${editOf}.md`, text);
      sayEdit("Reloaded — an agent wrote this");
    } catch {
      /* the sprint was renamed or deleted; the next reload() reports it properly */
    }
  };

  let noteNode: HTMLElement | null = null;
  let noteTimer = 0;
  const note = (text: string, failed = false): void => {
    if (!noteNode) return;
    noteNode.textContent = text;
    noteNode.classList.toggle("is-error", failed);
    noteNode.hidden = !text;
    window.clearTimeout(noteTimer);
    if (text && !failed) noteTimer = window.setTimeout(() => note(""), 4_000);
  };

  const start = async (sprint: Sprint, goal: SprintGoal, kind: SessionKind): Promise<void> => {
    if (!goal.project || busy) return;
    localStorage.setItem(KIND_KEY, kind);
    busy = true;
    try {
      const session = await events.startGoal(sprint, goal, kind, goalPrompt(sprint, goal));
      if (session) {
        bindings[goalKey(sprint, goal)] = { session, project: goal.project };
        saveBindings(bindings);
      }
    } catch (error) {
      note(message(error), true);
    } finally {
      busy = false;
    }
  };

  /* ---------------------------------------------------------------- head */

  const kindPicker = (): HTMLSelectElement => {
    const select = document.createElement("select");
    select.className = "sp-kind";
    select.title = "Which agent to start";
    for (const engine of AGENT_KINDS) {
      const option = document.createElement("option");
      option.value = engine.kind;
      option.textContent = engine.sub ? `${engine.name} · ${engine.sub}` : engine.name;
      select.append(option);
    }
    select.value = preferredKind();
    select.addEventListener("change", () => localStorage.setItem(KIND_KEY, select.value));
    select.addEventListener("click", (event) => event.stopPropagation());
    return select;
  };

  const buildHead = (sprint: Sprint | null): HTMLElement => {
    const head = make("header", "sp-head");
    const copy = make("div", "sp-head-copy");
    copy.append(make("span", "sp-kicker", "Sprint"));
    const title = make("b", "sp-title", sprint ? sprint.title : "No sprint running");
    copy.append(title);

    if (sprint) {
      const from = dayOf(sprint.starts);
      const to = dayOf(sprint.ends);
      const today = dayOf(board!.today);
      const parts: string[] = [];
      if (sprint.starts && sprint.ends) parts.push(`${shortDate(sprint.starts)} – ${shortDate(sprint.ends)}`);
      if (from != null && to != null && today != null) {
        const total = to - from + 1;
        if (sprint.phase === "active") parts.push(`day ${today - from + 1} of ${total}`);
        else if (sprint.phase === "planned") parts.push(`starts in ${from - today} days`);
        else parts.push(`ended ${today - to} days ago`);
      }
      const done = sprint.goals.filter((g) => g.state === "done").length;
      parts.push(`${done} of ${sprint.goals.length} done`);
      copy.append(make("small", "sp-meta", parts.join(" · ")));

      // What the repositories say happened, next to what the plan says. When the two disagree,
      // this line is the one telling the truth.
      const moved = board!.measured_for === sprint.id ? board!.activity : [];
      if (moved.length) {
        const commits = moved.reduce((sum, entry) => sum + entry.commits, 0);
        const touched = moved.filter((entry) => entry.commits > 0).length;
        const quiet = moved.length - touched;
        const dirty = moved.reduce((sum, entry) => sum + entry.dirty, 0);
        const unpushed = moved.reduce((sum, entry) => sum + entry.ahead, 0);
        const bits = [`${plural(commits, "commit")} across ${plural(touched, "app")}`];
        if (quiet) bits.push(`${quiet} quiet`);
        if (unpushed) bits.push(`${unpushed} unpushed`);
        if (dirty) bits.push(`${dirty} uncommitted`);
        const line = make("small", "sp-moved", bits.join(" · "));
        line.classList.toggle("is-risk", unpushed > 0 || dirty > 0);
        copy.append(line);
      }

      const meter = make("div", "sp-meter");
      const fill = make("i");
      fill.style.transform = `scaleX(${sprint.goals.length ? done / sprint.goals.length : 0})`;
      meter.append(fill);
      copy.append(meter);

      if (sprint.focus.length) {
        const focus = make("div", "sp-focus");
        for (const key of sprint.focus) {
          const app = board!.apps.find((a) => a.key === key);
          const chip = make("span", "sp-chip", app?.name ?? key);
          if (app?.project) {
            chip.classList.add("is-door");
            chip.title = `Open ${app.name}`;
            chip.addEventListener("click", () => events.openProject(app.project!));
          }
          focus.append(chip);
        }
        copy.append(focus);
      }
    } else {
      copy.append(
        make("p", "sp-lede", "Plan one with the manager, or write it by hand. Two weeks, at most eight goals."),
      );
    }

    const actions = make("div", "sp-head-actions");
    actions.append(
      button("sp-btn", `${icon("agent")}<span>Ask what's next</span>`, "The manager reads the sprint and answers in three lines", () =>
        events.askCpo(nextPrompt(sprint)),
      ),
      button("sp-btn", `${icon("work")}<span>Plan with CPO</span>`, "The manager drafts the next sprint file from the agenda", () =>
        events.askCpo(planPrompt(weekId(board!.today), board!.today)),
      ),
      button("sp-btn is-quiet", `<span>New sprint</span>`, "Open an empty sprint file", () => toggleCreate()),
    );
    // The plan is a file you own. This is the door to it, and it is never behind a menu.
    if (sprint) {
      actions.append(
        button("sp-btn is-quiet", `<span>Edit by hand</span>`, "Open the sprint's Markdown in the editor", () =>
          void openEditor(sprint.id),
        ),
      );
    }
    head.append(copy, actions);
    return head;
  };

  /* -------------------------------------------------------- create form */

  let createForm: HTMLElement | null = null;

  const toggleCreate = (): void => {
    if (!createForm) return;
    createForm.hidden = !createForm.hidden;
    if (!createForm.hidden) createForm.querySelector<HTMLInputElement>("input[name=title]")?.focus();
  };

  const buildCreate = (): HTMLElement => {
    const form = make("form", "sp-create") as HTMLFormElement;
    form.hidden = true;
    const today = dayOf(board!.today) ?? 0;
    form.innerHTML = `
      <label><span>Id</span><input name="id" spellcheck="false" /></label>
      <label class="is-wide"><span>Title</span><input name="title" placeholder="What these two weeks are for" /></label>
      <label><span>Starts</span><input name="starts" type="date" /></label>
      <label><span>Ends</span><input name="ends" type="date" /></label>
      <div class="sp-create-focus"><span>Focus, ranked</span><div class="sp-create-apps"></div></div>
      <footer><button type="submit" class="sp-btn">Create</button></footer>`;
    form.querySelector<HTMLInputElement>("input[name=id]")!.value = weekId(board!.today);
    form.querySelector<HTMLInputElement>("input[name=starts]")!.value = ymd(today);
    form.querySelector<HTMLInputElement>("input[name=ends]")!.value = ymd(today + 13);
    const picked: string[] = [];
    const apps = form.querySelector<HTMLElement>(".sp-create-apps")!;
    for (const app of board!.apps) {
      const chip = button("sp-chip is-pick", app.name, `Add ${app.name} to the focus`, () => {
        const at = picked.indexOf(app.key);
        if (at < 0) picked.push(app.key);
        else picked.splice(at, 1);
        for (const node of apps.querySelectorAll<HTMLElement>(".sp-chip")) {
          const order = picked.indexOf(node.dataset.key!);
          node.classList.toggle("is-on", order >= 0);
          node.dataset.order = order >= 0 ? String(order + 1) : "";
        }
      });
      chip.dataset.key = app.key;
      apps.append(chip);
    }
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const id = String(data.get("id") ?? "").trim();
      void mutate(async () => {
        const created = await events.create(
          id,
          String(data.get("title") ?? ""),
          String(data.get("starts") ?? ""),
          String(data.get("ends") ?? ""),
          picked,
        );
        viewing = created.id;
      });
    });
    createForm = form;
    return form;
  };

  /* --------------------------------------------------------------- goals */

  const stateChip = (sprint: Sprint, goal: SprintGoal): HTMLElement => {
    const live = liveBinding(sprint, goal);
    const chip = make("span", "home-verdict");
    chip.innerHTML = `<i></i><span></span>`;
    const label = chip.querySelector("span")!;
    if (live) {
      chip.classList.add("t-live", "is-door");
      label.textContent = "working";
      chip.title = "Jump to the terminal working this";
      chip.addEventListener("click", () => events.openSession(live.project, live.session));
    } else if (goal.state === "done") {
      chip.classList.add("t-ok");
      label.textContent = "done";
    } else if (goal.state === "blocked") {
      chip.classList.add("t-warn");
      label.textContent = "blocked";
    } else {
      chip.classList.add("t-mute");
      label.textContent = goal.owner === "you" ? "yours" : "todo";
    }
    return chip;
  };

  const goalActions = (sprint: Sprint, goal: SprintGoal, hero: boolean): HTMLElement => {
    const row = make("div", "sp-goal-actions");
    const live = liveBinding(sprint, goal);
    if (goal.state !== "done" && !live && goal.project) {
      if (hero) {
        const picker = kindPicker();
        row.append(
          button("sp-btn is-start", `${icon("play")}<span>Start agent</span>`, "Open the project and hand this goal to an agent", () =>
            void start(sprint, goal, picker.value as SessionKind),
          ),
          picker,
        );
      } else {
        row.append(
          button("sp-mini", icon("play"), `Start ${preferredKind()} on this goal`, () =>
            void start(sprint, goal, preferredKind()),
          ),
        );
      }
    }
    if (goal.state !== "done") {
      row.append(
        button("sp-mini", "✓", "Mark done", () =>
          void mutate(() => events.setGoal(sprint.id, goal.index, goal.text, "done")),
        ),
      );
      row.append(
        button("sp-mini", goal.state === "blocked" ? "▶" : "⛔", goal.state === "blocked" ? "Unblock" : "Mark blocked on you", () =>
          void mutate(() => events.setGoal(sprint.id, goal.index, goal.text, goal.state === "blocked" ? "todo" : "blocked")),
        ),
      );
    } else {
      row.append(
        button("sp-mini", "↺", "Reopen", () =>
          void mutate(() => events.setGoal(sprint.id, goal.index, goal.text, "todo")),
        ),
      );
    }
    return row;
  };

  const buildNext = (sprint: Sprint): HTMLElement => {
    const section = make("section", "sp-next");
    section.append(make("label", "home-label", "Next up"));
    const goal = nextUp(sprint);
    if (!goal) {
      const all = sprint.goals.length && sprint.goals.every((g) => g.state === "done");
      section.append(
        make(
          "div",
          "sp-none",
          all
            ? "Every goal is done. Plan the next sprint."
            : sprint.goals.length
              ? "Everything left is blocked or already being worked on."
              : "No goals yet. Add one below, or let the manager plan.",
        ),
      );
      return section;
    }
    const card = make("article", "sp-hero");
    const top = make("div", "sp-hero-top");
    top.append(make("b", "sp-hero-app", goal.app === "-" ? "Portfolio" : goal.app_name), stateChip(sprint, goal));
    card.append(top, make("p", "sp-hero-text", goal.text));
    if (goal.done_when) card.append(make("small", "sp-hero-when", `Done when: ${goal.done_when}`));
    if (goal.owner === "you") card.append(make("small", "sp-hero-when", "This one is yours, not an agent's."));
    card.append(goalActions(sprint, goal, true));
    section.append(card);
    return section;
  };

  const buildGoals = (sprint: Sprint): HTMLElement => {
    const section = make("section", "sp-goals");
    const head = make("div", "sp-section-head");
    head.append(make("label", "home-label", "Goals"), make("small", "sp-count", `${sprint.goals.length} · edit ${sprint.path.split("/").slice(-2).join("/")}`));
    section.append(head);

    const groups = new Map<string, SprintGoal[]>();
    for (const goal of ordered(sprint)) {
      const list = groups.get(goal.app) ?? [];
      list.push(goal);
      groups.set(goal.app, list);
    }
    for (const [app, goals] of groups) {
      const group = make("div", "sp-group");
      const first = goals[0];
      const name = make("h4", "sp-group-name", app === "-" ? "Portfolio" : first.app_name);
      if (first.project) {
        name.classList.add("is-door");
        name.title = `Open ${first.app_name}`;
        name.addEventListener("click", () => events.openProject(first.project!));
      }
      group.append(name);
      const moved = activityFor(sprint, app);
      if (moved) group.append(activityStrip(moved));
      for (const goal of goals) {
        const row = make("div", `sp-goal is-${goal.state}`);
        row.append(stateChip(sprint, goal));
        const body = make("div", "sp-goal-body");
        body.append(make("span", "sp-goal-text", goal.text));
        if (goal.done_when) body.append(make("small", "sp-goal-when", goal.done_when));
        row.append(body, make("i", "sp-owner", goal.owner), goalActions(sprint, goal, false));
        group.append(row);
      }
      section.append(group);
    }
    section.append(buildComposer(sprint));
    return section;
  };

  /** The repo's own answer for one app, under its name. Commits are the only proof that a goal
   *  moved; dirt and unpushed commits are the two ways finished work still fails to ship. */
  const activityStrip = (moved: SprintActivity): HTMLElement => {
    const strip = make("div", "sp-activity");
    if (!moved.branch) {
      strip.append(make("span", "sp-act-quiet", "not a git repo"));
      return strip;
    }
    strip.append(make("span", "sp-act-branch", moved.branch));
    if (moved.commits) {
      strip.append(make("span", "sp-act-on", plural(moved.commits, "commit")));
    } else {
      strip.classList.add("is-quiet");
      strip.append(make("span", "sp-act-quiet", "nothing this sprint"));
    }
    if (moved.reports) strip.append(make("span", "sp-act-on", `${plural(moved.reports, "report")}`));
    if (moved.ahead) strip.append(make("span", "sp-act-risk", `${moved.ahead} unpushed`));
    if (moved.dirty) strip.append(make("span", "sp-act-risk", `${moved.dirty} changed`));
    if (moved.last_subject) {
      const last = make("span", "sp-act-last");
      last.append(
        make("i", undefined, moved.last_is_older ? "last:" : "→"),
        make("em", undefined, moved.last_subject),
        make("time", undefined, moved.last_when),
      );
      strip.append(last);
    }
    return strip;
  };

  const buildComposer = (sprint: Sprint): HTMLElement => {
    const form = make("form", "sp-composer") as HTMLFormElement;
    const app = document.createElement("select");
    app.name = "app";
    const none = document.createElement("option");
    none.value = "-";
    none.textContent = "Portfolio";
    app.append(none);
    for (const entry of board!.apps) {
      const option = document.createElement("option");
      option.value = entry.key;
      option.textContent = entry.name;
      app.append(option);
    }
    app.value = sprint.focus[0] ?? "-";
    const owner = document.createElement("select");
    owner.name = "owner";
    for (const who of ["cpo", "you"]) {
      const option = document.createElement("option");
      option.value = who;
      option.textContent = who === "cpo" ? "agent" : "me";
      owner.append(option);
    }
    const text = document.createElement("input");
    text.name = "text";
    text.placeholder = "Add a goal — ↵ to save";
    text.autocomplete = "off";
    const when = document.createElement("input");
    when.name = "when";
    when.placeholder = "done when… (optional)";
    when.autocomplete = "off";
    const add = make("button", "sp-btn", "Add") as HTMLButtonElement;
    add.type = "submit";
    form.append(app, owner, text, when, add);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!text.value.trim()) return;
      void mutate(() => events.addGoal(sprint.id, app.value, owner.value, text.value, when.value)).then(() => {
        text.value = "";
        when.value = "";
      });
    });
    return form;
  };

  /* ------------------------------------------------------------- context */

  const buildBlocked = (): HTMLElement | null => {
    const waiting = waitingReports();
    if (!board!.blocked.length && !waiting.length) return null;
    const section = make("section", "sp-blocked");
    const head = make("div", "sp-section-head");
    head.append(
      make("label", "home-label", "Waiting on you"),
      make("small", "sp-count", `${plural(board!.blocked.length + waiting.length, "thing")}`),
    );
    section.append(head);

    // An agent that stopped mid-goal outranks a standing block: it is burning a session.
    for (const report of waiting) {
      const row = make("button", "sp-blocked-row is-agent") as HTMLButtonElement;
      row.type = "button";
      row.title = `Open ${report.project_name}`;
      row.append(
        make("b", undefined, report.outcome === "needs_decision" ? "decide" : "blocked"),
        make("span", undefined, `${report.project_name} — ${report.title}`),
      );
      row.addEventListener("click", () => events.openProject(report.project));
      section.append(row);
    }

    for (const line of board!.blocked) {
      const row = make("div", "sp-blocked-row");
      const parts = line.split("|").map((part) => part.trim());
      if (parts.length >= 3) row.append(make("b", undefined, parts[0]), make("span", undefined, parts.slice(2).join(" | ")));
      else row.append(make("span", undefined, line));
      section.append(row);
    }
    return section;
  };

  const buildLeft = (sprint: Sprint | null): HTMLElement => {
    const section = make("section", "sp-left");
    const head = make("div", "sp-section-head");
    head.append(make("label", "home-label", "Where we left"), make("small", "sp-count", "last report per app"));
    section.append(head);

    const focusProjects = new Set(
      (sprint?.focus ?? [])
        .map((key) => board!.apps.find((a) => a.key === key)?.project)
        .filter((id): id is string => Boolean(id)),
    );
    // The waiting ones are already up in their own band; repeating them here would make the
    // screen say the same thing twice and mean it less both times.
    const rest = board!.reports.filter((r) => !r.waiting);
    const reports = focusProjects.size
      ? rest.filter((r) => focusProjects.has(r.project))
      : rest.slice(0, 5);
    if (!reports.length) {
      section.append(make("div", "sp-none", "No agent has reported on these apps yet."));
    } else {
      for (const report of reports) {
        const row = make("button", "sp-report") as HTMLButtonElement;
        row.type = "button";
        row.title = `Open ${report.project_name}`;
        row.append(make("b", undefined, report.project_name), make("span", undefined, plainText(report.title)));
        const tail = make("small");
        tail.append(make("i", `sp-outcome is-${report.outcome || "none"}`, report.outcome), document.createTextNode(report.at));
        row.append(tail);
        row.addEventListener("click", () => events.openProject(report.project));
        section.append(row);
      }
    }

    if (sprint?.log.length) {
      const log = make("div", "sp-log");
      log.append(make("label", "home-label", "Sprint log"));
      for (const line of sprint.log.slice(-6).reverse()) log.append(make("div", "sp-log-line", line));
      section.append(log);
    }
    return section;
  };

  const buildOthers = (sprint: Sprint | null): HTMLElement | null => {
    const others = board!.sprints.filter((s) => s.id !== sprint?.id);
    if (!others.length) return null;
    const section = make("section", "sp-others");
    section.append(make("label", "home-label", "Other sprints"));
    const row = make("div", "sp-others-row");
    for (const other of others) {
      const done = other.goals.filter((g) => g.state === "done").length;
      const chip = button(
        `sp-chip is-pick is-${other.phase}`,
        `<b></b><span></span>`,
        `Show ${other.title}`,
        () => {
          viewing = other.id;
          paint();
        },
      );
      chip.querySelector("b")!.textContent = other.title;
      chip.querySelector("span")!.textContent = `${other.phase} · ${done}/${other.goals.length}`;
      row.append(chip);
    }
    section.append(row);
    return section;
  };

  /* ---------------------------------------------------------------- paint */

  const paint = (): void => {
    if (!openState || !board) return;
    const sprint = current();
    const entered = inner?.classList.contains("is-enter");
    const next = make("div", `sp-inner${entered === false ? "" : " is-enter"}`);
    noteNode = make("p", "sp-note");
    noteNode.hidden = true;
    next.append(buildHead(sprint), buildCreate(), noteNode);
    if (sprint) next.append(buildNext(sprint));
    const blocked = buildBlocked();
    if (blocked) next.append(blocked);
    if (sprint) next.append(buildGoals(sprint));
    next.append(buildLeft(sprint));
    const others = buildOthers(sprint);
    if (others) next.append(others);
    plan.replaceChildren(next);
    inner = next;
    // The entrance is for the first paint of an open() only — a repaint after a tick or a poll
    // must land without moving.
    if (entered !== undefined) next.classList.remove("is-enter");
  };

  return {
    async open() {
      openState = true;
      host.hidden = false;
      inner = null;
      bindings = loadBindings();
      if (!board) plan.replaceChildren(make("p", "sp-note", "Reading the sprint…"));
      try {
        board = await events.board();
      } catch (error) {
        plan.replaceChildren(make("p", "sp-note is-error", `Sprint could not open: ${message(error)}`));
        return;
      }
      paint();
    },
    sync() {
      if (!openState || !board) return;
      void editorSawDisk();
      void reload();
    },
    clear() {
      openState = false;
      viewing = null;
      inner = null;
      // The editor keeps its buffer across a screen switch. Leaving Sprint mid-edit and coming
      // back to an empty pane would be the same clobber this whole path exists to prevent.
      plan.replaceChildren();
      host.hidden = true;
    },
    isOpen: () => openState,
  };
}
