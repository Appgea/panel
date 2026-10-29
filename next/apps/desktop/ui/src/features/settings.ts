/**
 * Settings — a screen, not a sheet. It swaps with the workspace the way a project does, so it
 * gets the whole window and nothing behind it is half-visible and half-clickable.
 *
 * The layout is a Mac settings window: a list of sections on the left, one section on the right,
 * its rows grouped on quiet surfaces. A setting shows what it does under its name. A shortcut
 * row stays one line, with the explanation as its tooltip: thirty chords with prose under each
 * would bury the chord you came for.
 *
 * Every change lands the moment you make it; there is no OK button to forget. Preferences are
 * plain localStorage keys plus a `panel-prefs` event — whoever cares listens and repaints.
 *
 * Recording a chord swallows the keystroke so the app never runs the thing you are BINDING,
 * and Escape cancels the recording rather than binding itself.
 */

import { invoke } from "@tauri-apps/api/core";
import { icon, type IconName } from "../icons";
import {
  ACTIONS,
  type ActionId,
  IS_MAC,
  KEYMAP_EVENT,
  chordFromEvent,
  chordLabel,
  clashes,
  typesText,
  isCustom,
  isModifierOnly,
  label,
  parseChord,
  resetKeymap,
  setChord,
  type ActionDef,
} from "./keymap";
import "./settings.css";

/* --------------------------------------------------------------- preferences */

/** Fired after any preference changes, so open modules repaint instead of reloading. */
export const PREFS_EVENT = "panel-prefs";

/** The wall's column choice — the same key the toolbar's own picker writes. */
export const COLS_KEY = "panel-wall-cols";
export const COLS = ["1", "2", "3", "auto"] as const;

/**
 * How the Terminals screen shows a tab's terminals.
 *
 * grid: every terminal of the tab at once, split evenly. Best when you watch several agents.
 * tabs: a second row of tabs under the strip, one per terminal, and one terminal at full size.
 * Best when you work in one terminal and only glance at the rest.
 */
export const LAYOUT_KEY = "panel-terminal-layout";
export const LAYOUTS = ["grid", "tabs"] as const;
export type TermLayout = (typeof LAYOUTS)[number];

export const termLayout = (): TermLayout => {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "tabs" ? "tabs" : "grid";
  } catch {
    return "grid";
  }
};

export const setTermLayout = (value: TermLayout): void => {
  try {
    localStorage.setItem(LAYOUT_KEY, value);
  } catch {
    // Private storage: the choice lasts this session only, through the event below.
  }
  window.dispatchEvent(new CustomEvent(PREFS_EVENT));
};

const prefKey = (id: string): string => `panel-pref-${id}`;

export const prefBool = (id: string, fallback: boolean): boolean => {
  const value = localStorage.getItem(prefKey(id));
  return value === null ? fallback : value === "1";
};

export const setPrefBool = (id: string, value: boolean): void => {
  localStorage.setItem(prefKey(id), value ? "1" : "0");
  window.dispatchEvent(new CustomEvent(PREFS_EVENT));
};

/** How long an agent may sit unused before it is put to sleep, as the setting's labels say it. */
export const SLEEP_AFTER = { off: 0, "15m": 15, "30m": 30, "1h": 60, "2h": 120 } as const;
type SleepAfter = keyof typeof SLEEP_AFTER;
const SLEEP_DEFAULT: SleepAfter = "30m";

const sleepAfter = (): SleepAfter => {
  try {
    const saved = localStorage.getItem(prefKey("agents.sleepAfter"));
    return saved && saved in SLEEP_AFTER ? (saved as SleepAfter) : SLEEP_DEFAULT;
  } catch {
    return SLEEP_DEFAULT;
  }
};

/** Every preference this page owns, so the defaults live in one place. */
export const PREF = {
  /** Minutes before an unused agent sleeps. 0 is never. */
  sleepAfterMinutes: (): number => SLEEP_AFTER[sleepAfter()],
  /** A tab that has lost its last terminal retires itself. Off puts the × back on every tab. */
  tabAutoClose: () => prefBool("tabs.autoClose", true),
  /** Follow a terminal you moved into the tab it landed in. */
  followMove: () => prefBool("tabs.followMove", true),
  /** Picking a project in the ＋ seat opens a plain shell in its folder instead of asking
   *  which engine. Off by default: the wall is an agent wall first. */
  plusShell: () => prefBool("plus.shell", false),
};

/* ------------------------------------------------------------------ recording */

/** True while a row is armed and waiting for a chord. Global handlers check this and stand
 *  down — a chord being BOUND must not also fire whatever it means today. */
let recording = false;
export const isRecording = (): boolean => recording;

/** Puts the armed row back. At most one row is armed: arming another row, a repaint, or leaving
 *  the screen disarms it. Otherwise its key listener outlives its chip and binds the next key
 *  pressed anywhere in the app. */
let disarm: (() => void) | null = null;

/* --------------------------------------------------------------------- screen */

export type SettingsHandle = {
  open(): void;
  clear(): void;
  isOpen(): boolean;
};

export type SettingsEvents = {
  /** Done / Escape — the caller decides which screen comes back. */
  close(): void;
  skills?(): void;
};

const make = (tag: string, className: string): HTMLElement => {
  const node = document.createElement(tag);
  node.className = className;
  return node;
};

const button = (className: string, text: string): HTMLButtonElement => {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.textContent = text;
  return node;
};

/** Plain text in a given class. */
const line = (tag: string, className: string, text: string): HTMLElement => {
  const node = make(tag, className);
  node.textContent = text;
  return node;
};

/** A titled group of rows on one surface. The foot is the fine print under it. */
const group = (title: string, rows: HTMLElement[], foot?: string): HTMLElement => {
  const box = make("section", "set-group");
  box.append(line("h3", "set-group-head", title));
  const list = make("div", "set-list");
  list.append(...rows);
  box.append(list);
  if (foot) box.append(line("p", "set-group-foot", foot));
  return box;
};

/** A row's left side: its name, and what it does underneath. */
const rowText = (name: string, note: string): HTMLElement => {
  const text = make("div", "set-row-text");
  text.append(line("span", "set-row-name", name), line("small", "set-row-note", note));
  return text;
};

/* ------------------------------------------------------------------ sections */

/** One section shows at a time, the way a Mac settings window works. Each is short enough to
 *  read whole, and the list on the left says what else there is without a scroll. */
const SECTIONS = [
  { id: "general", name: "General", glyph: "sliders" },
  { id: "flags", name: "Flags", glyph: "flag" },
  { id: "shortcuts", name: "Shortcuts", glyph: "keyboard" },
  { id: "extensions", name: "Extensions", glyph: "plug" },
  { id: "servers", name: "Servers", glyph: "server" },
] as const satisfies readonly { id: string; name: string; glyph: IconName }[];
type SectionId = (typeof SECTIONS)[number]["id"];

/** The section Settings was left on. A per-machine convenience, so plain localStorage. */
const SECTION_KEY = "panel-settings-section";

const savedSection = (): SectionId => {
  try {
    const value = localStorage.getItem(SECTION_KEY);
    return SECTIONS.find((section) => section.id === value)?.id ?? "general";
  } catch {
    return "general";
  }
};

/* ------------------------------------------------------------------ extensions */

/** One row of the extensions list, as the Rust side reports it. */
type CatalogEntry = {
  name: string;
  title: string;
  icon: string;
  summary: string;
  installed: boolean;
  /** False for anything the human dropped into `~/.appgeapanel/modules` themselves. */
  bundled: boolean;
  requires: string[];
  /** The subset of `requires` this machine does not have. */
  missing: string[];
};

/* -------------------------------------------------------------------- flags */

/** One switch in `~/.appgeapanel/flags.json`. The file names and explains its own flags, so
 *  Panel shows whatever the ops tree declares. `repos` overrides `on`, keyed by repo folder. */
type Flag = { name?: string; note?: string; on?: boolean; repos?: Record<string, boolean> };
type FlagDoc = { flags?: Record<string, Flag> };

/** Fired after an install or uninstall, so the project rail repaints without a reload. */
export const EXTENSIONS_EVENT = "panel-extensions";

export function mountSettings(host: HTMLElement, events: SettingsEvents): SettingsHandle {
  let openState = false;
  let section: SectionId = savedSection();
  let nav: HTMLElement;
  let main: HTMLElement;
  let title: HTMLElement;
  let actions: HTMLElement;
  let body: HTMLElement;
  /* null until module_catalog answers, so the section can say it is still reading. */
  let extensions: CatalogEntry[] | null = null;
  let catalogError = "";
  /* The Servers board is built once and re-parented on every paint. `paint()` runs on every
     toggle press, and rebuilding it would re-fetch the board each time a switch moved. */
  let servers: HTMLElement | null = null;
  /* An install that failed, by extension name. Kept outside the row because the click repaints
     the section, which would wipe a message appended to the old row. */
  const failures = new Map<string, string>();
  /* null until flags_read answers. Repo names come from the registered projects' folders. */
  let flags: FlagDoc | null = null;
  let flagError = "";
  /* Bumped by every set, so a read that left before it cannot paint the older document over it. */
  let flagWrites = 0;
  let repoNames: string[] = [];

  /* ------------------------------------------------------------------- rows */

  /** One shortcut: name, chord, and a reset only once it differs from the default. */
  const keyRow = (def: ActionDef, clashing: boolean): HTMLElement => {
    const typing = typesText(def.id);
    const row = make("div", `set-row set-key${clashing || typing ? " is-clash" : ""}`);
    row.title = clashing
      ? `${def.note} — this chord is bound twice`
      : typing
        ? `${def.note} — ⌥ with this key types a character on some keyboard layouts, so Panel would eat it`
        : def.note;
    row.append(line("span", "set-row-name", def.name));

    const reset = button("set-reset", "↺");
    reset.title = `Back to the default — ${chordLabel(parseChord(IS_MAC ? def.mac : def.other), !!def.digits)}`;
    reset.setAttribute("aria-label", `reset ${def.name}`);
    reset.hidden = !isCustom(def.id);
    reset.addEventListener("click", () => {
      setChord(def.id, null);
      paint();
    });
    row.append(reset);

    const chip = button("set-chord", label(def.id));
    chip.dataset.focus = `chord:${def.id}`;
    function stop(): void {
      window.removeEventListener("keydown", onKey, true);
      chip.classList.remove("is-recording");
      chip.textContent = label(def.id);
      recording = false;
      disarm = null;
    }
    function onKey(event: KeyboardEvent): void {
      // Nothing in the app may act on the key being BOUND, so swallow everything while armed.
      event.preventDefault();
      event.stopImmediatePropagation();
      if (isModifierOnly(event)) return;
      if (event.code === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        stop();
        paint();
        return;
      }
      setChord(def.id, chordFromEvent(event));
      stop();
      paint();
    }
    chip.addEventListener("click", () => {
      if (disarm === stop) return;
      disarm?.();
      disarm = stop;
      recording = true;
      chip.classList.add("is-recording");
      chip.textContent = "press…";
      window.addEventListener("keydown", onKey, true);
    });
    row.append(chip);
    return row;
  };

  const toggleRow = (
    name: string,
    note: string,
    value: boolean,
    onChange: (next: boolean) => void,
  ): HTMLElement => {
    const row = make("div", "set-row");
    const toggle = button(`set-toggle${value ? " is-on" : ""}`, "");
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-checked", String(value));
    toggle.setAttribute("aria-label", name);
    toggle.dataset.focus = `pref:${name}`;
    toggle.append(make("i", "set-knob"));
    toggle.addEventListener("click", () => onChange(!value));
    row.append(rowText(name, note), toggle);
    return row;
  };

  const segRow = (
    name: string,
    note: string,
    values: readonly string[],
    current: string,
    onPick: (value: string) => void,
  ): HTMLElement => {
    const row = make("div", "set-row");
    const seg = make("div", "set-seg");
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", name);
    for (const value of values) {
      const pick = button(`set-seg-item${value === current ? " is-active" : ""}`, value);
      pick.setAttribute("aria-pressed", String(value === current));
      pick.dataset.focus = `seg:${name}:${value}`;
      pick.addEventListener("click", () => onPick(value));
      seg.append(pick);
    }
    row.append(rowText(name, note), seg);
    return row;
  };

  /** One extension: what it is, what it wants, and a switch.
   *
   *  Nothing is downloaded. Every public extension already rides inside the app, so the switch
   *  only records the choice and the rail repaints. What the row adds is the part a name cannot
   *  carry: what the thing does, and which tools it needs that this machine does not have. */
  const extensionRow = (entry: CatalogEntry): HTMLElement => {
    const row = make("div", "set-row set-ext");

    // The manifest's own glyph, the same one the project rail shows for it.
    const glyph = line("span", "set-ext-icon", entry.icon);
    glyph.setAttribute("aria-hidden", "true");

    const text = rowText(entry.title, entry.summary);
    if (entry.missing.length) {
      const warn = line("small", "set-ext-missing", `Not on this machine: ${entry.missing.join(", ")}`);
      warn.title = "You can still install it. The parts that need these will fail until you have them.";
      text.append(warn);
    }
    const failure = failures.get(entry.name);
    if (failure) text.append(line("small", "set-ext-failed", failure));

    const toggle = button(`set-toggle${entry.installed ? " is-on" : ""}`, "");
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-checked", String(entry.installed));
    toggle.setAttribute("aria-label", entry.title);
    toggle.dataset.focus = `ext:${entry.name}`;
    toggle.append(make("i", "set-knob"));
    toggle.addEventListener("click", () => {
      void (async () => {
        toggle.disabled = true;
        try {
          extensions = await invoke<CatalogEntry[]>(
            entry.installed ? "uninstall_module" : "install_module",
            { name: entry.name },
          );
          failures.delete(entry.name);
          window.dispatchEvent(new CustomEvent(EXTENSIONS_EVENT));
        } catch (error) {
          // A user-dropped module refuses to be uninstalled from here — say so on the row rather
          // than in a dialog that steals the screen for one sentence.
          failures.set(entry.name, String(error));
        } finally {
          toggle.disabled = false;
          paint();
        }
      })();
    });

    row.append(glyph, text, toggle);
    return row;
  };

  /** One change at a time, so the Rust side can read-modify-write and keep a script's edit. */
  const setFlag = (name: string, repo: string | null, on: boolean | null): void => {
    flagWrites += 1;
    void invoke<FlagDoc>("flags_set", { name, repo, on })
      .then((doc) => {
        flags = doc;
        flagError = "";
      })
      .catch((error) => {
        flagError = `Could not change the flag. ${error}`;
      })
      .finally(paint);
  };

  /* --------------------------------------------------------------- sections */

  function general(): HTMLElement[] {
    const out = [
      group("Tabs", [
        toggleRow(
          "Tabs close themselves",
          "A tab retires when its last terminal is closed or moved away. Off keeps a × on every tab.",
          PREF.tabAutoClose(),
          (next) => {
            setPrefBool("tabs.autoClose", next);
            paint();
          },
        ),
        toggleRow(
          "Follow a moved terminal",
          "Moving the last terminal out of a tab takes you to the tab it landed in.",
          PREF.followMove(),
          (next) => {
            setPrefBool("tabs.followMove", next);
            paint();
          },
        ),
      ]),
      group("Terminals", [
        toggleRow(
          "Straight to a shell",
          "Picking a project in the ＋ seat opens a plain terminal in its folder instead of asking which agent. Hold ⌥ to be asked anyway.",
          PREF.plusShell(),
          (next) => {
            setPrefBool("plus.shell", next);
            paint();
          },
        ),
        segRow(
          "Terminal layout",
          "grid shows every terminal of a tab at once. tabs shows one at full size, with a tab for each.",
          LAYOUTS,
          termLayout(),
          (value) => {
            setTermLayout(value as TermLayout);
            paint();
          },
        ),
        segRow(
          "Sleep unused agents",
          "An agent you have not typed to, and that has not worked, for this long ends its process to give the memory back. Its pane stays. Wake picks the same conversation back up. Anything it left running in the background stops too.",
          Object.keys(SLEEP_AFTER),
          sleepAfter(),
          (value) => {
            localStorage.setItem(prefKey("agents.sleepAfter"), value);
            window.dispatchEvent(new CustomEvent(PREFS_EVENT));
            paint();
          },
        ),
        segRow(
          "Wall columns",
          "How the terminal wall splits. auto fits the count to the window.",
          COLS,
          localStorage.getItem(COLS_KEY) ?? "auto",
          (value) => {
            localStorage.setItem(COLS_KEY, value);
            window.dispatchEvent(new CustomEvent(PREFS_EVENT));
            paint();
          },
        ),
      ]),
    ];
    if (events.skills) {
      const row = make("div", "set-row");
      const manage = button("set-button", "Manage skills");
      manage.dataset.focus = "skills";
      manage.addEventListener("click", () => events.skills?.());
      row.append(rowText("Skills and workflows", "Create shared workflows. Browse Claude and Codex skill files."), manage);
      out.push(group("Agents", [row]));
    }
    return out;
  }

  function flagSection(): HTMLElement[] {
    // The error sits above the flags, not in place of them: one failed click must not hide them all.
    const error = flagError ? [line("p", "set-state is-error", flagError)] : [];
    if (!flags) return error.length ? error : [line("p", "set-state", "Reading flags…")];
    const entries = Object.entries(flags.flags ?? {});
    if (!entries.length) {
      return [...error, line("p", "set-state", "No flags yet. Ask an agent to add one to ~/.appgeapanel/flags.json.")];
    }
    return [...error, ...entries.map(([id, flag]) => {
      const own = flag.repos ?? {};
      const rows = [
        toggleRow("Everywhere", "Every repo without a switch of its own below.", !!flag.on, (next) =>
          setFlag(id, null, next),
        ),
      ];
      for (const repo of Object.keys(own).sort()) {
        const row = toggleRow(repo, "This repo only.", own[repo], (next) => setFlag(id, repo, next));
        const drop = button("set-reset", "×");
        drop.title = `${repo} follows Everywhere again`;
        drop.setAttribute("aria-label", `remove ${repo}'s own switch`);
        drop.addEventListener("click", () => setFlag(id, repo, null));
        row.insertBefore(drop, row.lastChild);
        rows.push(row);
      }
      const free = repoNames.filter((name) => !(name in own));
      if (free.length) {
        const row = make("div", "set-row");
        const pick = document.createElement("select");
        pick.className = "set-select";
        pick.setAttribute("aria-label", `Add a repo to ${flag.name ?? id}`);
        pick.append(new Option("Add a repo…", ""), ...free.map((name) => new Option(name, name)));
        // A repo is added to differ from Everywhere. Matching it would be a switch that does nothing.
        pick.addEventListener("change", () => pick.value && setFlag(id, pick.value, !flag.on));
        row.append(rowText("A repo of its own", "It starts opposite to Everywhere."), pick);
        rows.push(row);
      }
      return group(flag.name ?? id, rows, flag.note);
    })];
  }

  function shortcuts(taken: Set<ActionId>): HTMLElement[] {
    const groups: HTMLElement[] = [];
    for (const name of new Set(ACTIONS.map((def) => def.group))) {
      const rows = ACTIONS.filter((def) => def.group === name).map((def) => keyRow(def, taken.has(def.id)));
      groups.push(group(name, rows));
    }
    // Two columns when the window has room: the whole keymap in one look, no scroll.
    const columns = make("div", "set-columns");
    columns.append(...groups);
    return [columns];
  }

  function extensionSection(): HTMLElement[] {
    if (catalogError) return [line("p", "set-state is-error", `Could not read the extension list. ${catalogError}`)];
    if (!extensions) return [line("p", "set-state", "Reading the extension list…")];
    if (!extensions.length) return [line("p", "set-state", "No extensions found.")];
    const out: HTMLElement[] = [];
    const bundled = extensions.filter((entry) => entry.bundled);
    const mine = extensions.filter((entry) => !entry.bundled);
    if (bundled.length) out.push(group("Built in", bundled.map(extensionRow)));
    if (mine.length) {
      out.push(
        group(
          "Yours",
          mine.map(extensionRow),
          "Found in ~/.appgeapanel/modules. Delete a folder there to remove it.",
        ),
      );
    }
    return out;
  }

  /**
   * The health check for the servers the human runs. It lives here rather than on a project
   * because a server belongs to the estate: the box serving a static site is usually not
   * described anywhere in that site's repo, so a per-project tab would appear on the wrong
   * screens and hide on the right ones. Settings is also where its list is configured, and the
   * board and the thing that configures it should not be two screens apart.
   *
   * The board itself is a lazy chunk, fetched the first time this section is shown.
   */
  function serverSection(): HTMLElement[] {
    if (!servers) {
      const board = make("div", "set-servers");
      servers = board;
      void import("./server_health")
        .then(({ mountServerHealth }) => mountServerHealth(board))
        .catch(() => {
          board.replaceChildren(line("p", "set-state", "The server-health module is not installed."));
        });
    }
    return [servers];
  }

  const LEADS: Record<SectionId, string> = {
    general: "How the workspace behaves. Every change applies at once.",
    flags: "Switches your agents read before they act. Each one says what it changes.",
    shortcuts: "Click a shortcut, then press the new keys. Esc cancels. Hover a row to see what it does.",
    extensions: "Turn one on and it appears on every project that can use it. No restart.",
    servers:
      "Whether the servers you run are answering, and how long until each certificate expires. " +
      "Ask an agent to set up the list, or edit the file it writes.",
  };

  /* ------------------------------------------------------------------ paint */

  function paint(): void {
    // The armed chip is about to leave the page. Its listener must leave with it.
    disarm?.();
    // A repaint replaces the control that had focus. Put focus back on its replacement, or a
    // keyboard user toggling a switch would be thrown back to the top of the page.
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.focus;
    const taken = clashes();

    nav.replaceChildren(
      ...SECTIONS.map((entry) => {
        const item = button(`set-nav-item${entry.id === section ? " is-active" : ""}`, "");
        item.dataset.focus = `nav:${entry.id}`;
        if (entry.id === section) item.setAttribute("aria-current", "page");
        item.innerHTML = `<i aria-hidden="true">${icon(entry.glyph)}</i><span></span>`;
        item.querySelector("span")!.textContent = entry.name;
        if (entry.id === "shortcuts" && taken.size) {
          const badge = line("b", "set-nav-badge", String(taken.size));
          badge.title = `${taken.size} shortcuts share a chord`;
          item.append(badge);
        }
        item.addEventListener("click", () => show(entry.id));
        return item;
      }),
    );

    title.textContent = SECTIONS.find((entry) => entry.id === section)!.name;
    actions.replaceChildren();
    if (section === "shortcuts") {
      const resetAll = button("set-button", "Reset all");
      resetAll.title = "Every shortcut back to its default";
      resetAll.disabled = !ACTIONS.some((def) => isCustom(def.id));
      resetAll.addEventListener("click", () => {
        resetKeymap();
        paint();
      });
      actions.append(resetAll);
    }

    const content =
      section === "general"
        ? general()
        : section === "flags"
          ? flagSection()
          : section === "shortcuts"
            ? shortcuts(taken)
            : section === "extensions"
              ? extensionSection()
              : serverSection();
    main.dataset.section = section;
    body.replaceChildren(line("p", "set-lead", LEADS[section]), ...content);

    if (focused) host.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focused)}"]`)?.focus();
  }

  function show(next: SectionId): void {
    if (next === section) return;
    section = next;
    try {
      localStorage.setItem(SECTION_KEY, next);
    } catch {
      // Private storage: the next open lands on General. Nothing else depends on it.
    }
    paint();
    body.scrollTop = 0;
  }

  /* ----------------------------------------------------------------- handle */

  const onKey = (event: KeyboardEvent): void => {
    // A recording row swallows its own keys before this; anything here is a plain Escape.
    if (event.key !== "Escape" || recording || document.querySelector(".skills-overlay, .dlg-wrap, dialog[open]")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    events.close();
  };

  return {
    open() {
      openState = true;
      host.hidden = false;

      const inner = make("div", "set-inner is-enter");

      const side = make("aside", "set-side");
      const brand = make("div", "set-brand");
      brand.innerHTML = `<i aria-hidden="true">${icon("gear")}</i><b>Settings</b>`;
      nav = make("nav", "set-nav");
      nav.setAttribute("aria-label", "Settings sections");
      const hint = line("small", "set-side-foot", `${label("app.settings")} opens · Esc closes`);
      side.append(brand, nav, hint);

      main = make("div", "set-main");
      const bar = make("header", "set-bar");
      title = make("h2", "set-title");
      actions = make("div", "set-actions");
      const done = button("set-button is-primary", "Done");
      done.title = "Back to the workspace — Esc";
      done.addEventListener("click", () => events.close());
      bar.append(title, actions, done);
      body = make("div", "set-body");
      main.append(bar, body);

      inner.append(side, main);
      host.replaceChildren(inner);
      paint();

      // Read on open, not at startup: it shells out a `which` per declared tool, which is cheap
      // here and pure waste on every launch for a screen most sessions never see.
      void invoke<CatalogEntry[]>("module_catalog")
        .then((list) => {
          extensions = list;
          catalogError = "";
        })
        .catch((error) => {
          catalogError = String(error);
        })
        .finally(() => {
          if (openState && section === "extensions") paint();
        });

      // Read on every open: an agent may have added a flag since the last look.
      const writes = flagWrites;
      void Promise.all([
        invoke<FlagDoc>("flags_read"),
        invoke<{ path: string }[]>("list_projects").catch(() => []),
      ])
        .then(([doc, projects]) => {
          if (writes === flagWrites) flags = doc;
          flagError = "";
          const names = projects.map((project) => project.path.split(/[\\/]/).filter(Boolean).pop() ?? "");
          repoNames = [...new Set(names.filter(Boolean))].sort();
        })
        .catch((error) => {
          flagError = `Could not read flags.json. ${error}`;
        })
        .finally(() => {
          if (openState && section === "flags") paint();
        });

      window.addEventListener(KEYMAP_EVENT, paint);
      window.addEventListener("keydown", onKey, true);
    },

    clear() {
      disarm?.();
      failures.clear();
      openState = false;
      window.removeEventListener(KEYMAP_EVENT, paint);
      window.removeEventListener("keydown", onKey, true);
      host.replaceChildren();
      host.hidden = true;
    },

    isOpen: () => openState,
  };
}
