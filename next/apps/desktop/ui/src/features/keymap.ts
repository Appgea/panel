/**
 * The keymap — every chord Panel answers to, in one table, rebindable.
 *
 * Chords are matched on `event.code`, not `event.key`: with ⌥ held, macOS hands JS the composed
 * character (⌥[ arrives as "“") and with ⇧ held a digit arrives as a symbol, so `key` cannot
 * describe a modified chord at all. `code` is the physical key and never changes under a
 * modifier.
 *
 * Modifiers are matched EXACTLY — ⌘⇧] is not ⌘]. That is what lets ⌃Tab and ⌃⇧Tab be two
 * different actions on one code.
 *
 * A binding lives as a spec string ("Meta+Alt+ArrowLeft"): the modifiers in a fixed order, then
 * the code. Defaults are written out per platform. Terminal creation keeps the same letters
 * and Shift variants on Windows/Linux, with Ctrl taking the place of macOS Command.
 *
 * Only overrides are stored. Change a default later and everyone who never rebound it moves.
 */

const STORE_KEY = "panel-keymap";
/** Fired on every rebind so open UI can repaint its hints. */
export const KEYMAP_EVENT = "panel-keymap";

export const IS_MAC = navigator.userAgent.includes("Mac");

export type Chord = {
  code: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
};

export type ActionId =
  | "app.settings"
  | "app.notebook"
  | "app.runApp"
  | "app.runFresh"
  | "app.stopApp"
  | "app.runExtra"
  | "app.wall"
  | "app.runs"
  | "app.work"
  | "app.git"
  | "app.dash"
  | "project.jump"
  | "wall.picker"
  | "wall.newTab"
  | "wall.layout"
  | "term.select"
  | "wall.newShell"
  | "tab.next"
  | "tab.prev"
  | "term.next"
  | "term.prev"
  | "term.waiting"
  | "term.zoom"
  | "term.find"
  | "term.copy"
  | "term.fullscreen"
  | "term.unzoom"
  | "term.focusLeft"
  | "term.focusRight"
  | "term.focusUp"
  | "term.focusDown"
  | "term.moveToTab"
  | "term.moveToNewTab";

export type ActionDef = {
  id: ActionId;
  group: "Workspace" | "Tabs" | "Terminals";
  name: string;
  note: string;
  /** The chord is a FAMILY: these modifiers plus any digit 1…9. Only the modifiers are
   *  rebindable; the digit row is the whole point. */
  digits?: boolean;
  /** Default spec on macOS, and everywhere else. */
  mac: string;
  other: string;
};

/** The table. Order here is the order the settings page lists them in. */
export const ACTIONS: ActionDef[] = [
  {
    id: "app.settings",
    group: "Workspace",
    name: "Settings",
    note: "Open this page",
    mac: "Meta+Comma",
    other: "Ctrl+Comma",
  },
  {
    id: "app.notebook",
    group: "Workspace",
    name: "Open Notebook",
    note: "Open the private local Markdown notebook",
    mac: "Meta+Shift+KeyN",
    other: "Ctrl+Shift+KeyN",
  },
  {
    id: "app.runApp",
    group: "Workspace",
    name: "Run the app",
    note: "Build and launch the focused terminal's project on its target — the project you are looking at, wherever you are looking at it from. Already up? A hot restart where the app has one, else a fresh build on the same device",
    mac: "Meta+KeyR",
    other: "Ctrl+KeyR",
  },
  {
    id: "app.runFresh",
    group: "Workspace",
    name: "Fresh run",
    note: "Always a new build of the project you are looking at, with the app deleted off a simulator first so it launches like a first install. A live run is replaced in place, on the same device",
    mac: "Meta+Shift+KeyR",
    other: "Ctrl+Shift+KeyR",
  },
  {
    id: "app.stopApp",
    group: "Workspace",
    name: "Stop the run",
    note: "Stop the build or run you are looking at and hand its simulator back — the other half of ⌘R, on the key build systems have always used for cancel",
    mac: "Meta+Period",
    other: "Ctrl+Period",
  },
  {
    id: "app.runExtra",
    group: "Workspace",
    name: "Run a second instance",
    note: "Choose a target for ANOTHER copy of this project. Costs a device and a build; ⌘R re-runs the one you already have",
    mac: "Meta+Alt+KeyR",
    other: "Ctrl+Alt+KeyR",
  },
  {
    id: "app.wall",
    group: "Workspace",
    name: "Terminals wall",
    note: "Toggle: from a project to the wall, from the wall back to the focused terminal's project. One modifier, the key VS Code uses for its terminal",
    mac: "Meta+KeyJ",
    other: "Ctrl+KeyJ",
  },
  {
    id: "app.runs",
    group: "Workspace",
    name: "Runs",
    note: "Toggle: from anywhere to the Runs tab, from Runs back to the project you came from. Next to ⌘J on the home row",
    mac: "Meta+KeyK",
    other: "Ctrl+KeyK",
  },
  {
    id: "app.work",
    group: "Workspace",
    name: "Work",
    note: "Open Work on the project you are looking at — from the wall, that is the focused terminal's project",
    mac: "Meta+Shift+KeyE",
    other: "Ctrl+Shift+KeyE",
  },
  {
    id: "app.git",
    group: "Workspace",
    name: "Git",
    note: "Open Git on the project you are looking at",
    mac: "Meta+Shift+KeyG",
    other: "Ctrl+Shift+KeyG",
  },
  {
    id: "app.dash",
    group: "Workspace",
    name: "Dashboard",
    note: "Open the Dashboard of the project you are looking at",
    mac: "Meta+Shift+KeyD",
    other: "Ctrl+Shift+KeyD",
  },
  {
    id: "project.jump",
    group: "Workspace",
    name: "Jump to project 1…9",
    note: "Open a project from the sidebar: your pins first, then the rows in the order you see them",
    digits: true,
    mac: "Ctrl+Digit1",
    other: "Alt+Digit1",
  },
  {
    id: "wall.picker",
    group: "Workspace",
    name: "New terminal",
    note: "Open this tab's ＋ picker",
    mac: "Meta+KeyN",
    other: "Ctrl+KeyN",
  },
  {
    id: "wall.newShell",
    group: "Workspace",
    name: "New shell here",
    note: "Another shell beside the focused one, in the folder it is standing in — ⌘T means what it means in every terminal",
    mac: "Meta+KeyT",
    other: "Ctrl+KeyT",
  },
  {
    id: "wall.newTab",
    group: "Workspace",
    name: "New tab",
    note: "Add an empty terminal tab",
    mac: "Meta+Shift+KeyT",
    other: "Ctrl+Shift+KeyT",
  },
  {
    id: "wall.layout",
    group: "Workspace",
    name: "Switch terminal layout",
    note: "Flip the Terminals screen between grid, every terminal at once, and tabs, one terminal at a time",
    mac: "Meta+Shift+KeyL",
    other: "Ctrl+Shift+KeyL",
  },
  {
    id: "tab.next",
    group: "Tabs",
    name: "Next tab",
    note: "Walk the strip right, wrapping. Tabs layout: the terminal tabs of the second row. On a project, the module rail",
    mac: "Meta+Shift+BracketRight",
    other: "Ctrl+Shift+BracketRight",
  },
  {
    id: "tab.prev",
    group: "Tabs",
    name: "Previous tab",
    note: "Walk the strip left, wrapping. Tabs layout: the second row. On a project, the module rail",
    mac: "Meta+Shift+BracketLeft",
    other: "Ctrl+Shift+BracketLeft",
  },
  {
    id: "term.next",
    group: "Terminals",
    name: "Next terminal",
    note: "Caret to the next terminal in this tab, in join order. Tabs layout: the next top tab",
    mac: "Ctrl+Tab",
    other: "Ctrl+Tab",
  },
  {
    id: "term.prev",
    group: "Terminals",
    name: "Previous terminal",
    note: "Caret back one, same order. Tabs layout: the previous top tab",
    mac: "Ctrl+Shift+Tab",
    other: "Ctrl+Shift+Tab",
  },
  {
    id: "term.waiting",
    group: "Terminals",
    name: "Next waiting agent",
    note: "Go to the agent that has waited on you longest, in any tab or project. Press again for the next one. A finished turn you have not seen counts after the open questions",
    mac: "Meta+Shift+KeyA",
    other: "Ctrl+Shift+KeyA",
  },
  {
    id: "term.select",
    group: "Terminals",
    name: "Terminal 1…9",
    note: "Go to that terminal of this tab on the grid. Tabs layout: that top tab, since ⌘1…9 goes to the terminal",
    digits: true,
    mac: "Meta+Ctrl+Digit1",
    other: "Alt+Shift+Digit1",
  },
  {
    id: "term.focusLeft",
    group: "Terminals",
    name: "Focus left",
    note: "Caret to the nearest tile in that direction on the wall. Tabs layout: the previous terminal tab",
    mac: "Meta+Alt+ArrowLeft",
    other: "Ctrl+Alt+ArrowLeft",
  },
  {
    id: "term.focusRight",
    group: "Terminals",
    name: "Focus right",
    note: "Caret to the nearest tile in that direction on the wall. Tabs layout: the next terminal tab",
    mac: "Meta+Alt+ArrowRight",
    other: "Ctrl+Alt+ArrowRight",
  },
  {
    id: "term.focusUp",
    group: "Terminals",
    name: "Focus up",
    note: "Caret to the nearest tile in that direction on the wall. Tabs layout: the previous top tab",
    mac: "Meta+Alt+ArrowUp",
    other: "Ctrl+Alt+ArrowUp",
  },
  {
    id: "term.focusDown",
    group: "Terminals",
    name: "Focus down",
    note: "Caret to the nearest tile in that direction on the wall. Tabs layout: the next top tab",
    mac: "Meta+Alt+ArrowDown",
    other: "Ctrl+Alt+ArrowDown",
  },
  {
    id: "term.zoom",
    group: "Terminals",
    name: "Zoom terminal",
    note: "Blow the focused tile up to the whole wall, and back",
    mac: "Meta+Enter",
    other: "Ctrl+Enter",
  },
  {
    id: "term.find",
    group: "Terminals",
    name: "Find in terminal",
    note: "Search the focused terminal's scrollback",
    mac: "Meta+KeyF",
    other: "Ctrl+KeyF",
  },
  {
    id: "term.copy",
    group: "Terminals",
    name: "Copy terminal selection",
    note: "Copy selected terminal text. With no selection, Ctrl+C still interrupts the command",
    mac: "Meta+KeyC",
    other: "Ctrl+KeyC",
  },
  {
    id: "term.fullscreen",
    group: "Terminals",
    name: "Full screen",
    note: "Open project Terminals, or zoom the focused terminal on the wall",
    mac: "Ctrl+KeyF",
    // Ctrl+Shift+F is Find in project off macOS; F11 is the Windows full-screen key.
    other: "F11",
  },
  {
    id: "term.unzoom",
    group: "Terminals",
    name: "Leave zoom",
    note: "Back to the even grid. Only while a tile is zoomed",
    mac: "Escape",
    other: "Escape",
  },
  {
    id: "term.moveToTab",
    group: "Terminals",
    name: "Move to tab 1…9",
    note: "Send the focused terminal to that tab of the strip",
    digits: true,
    mac: "Meta+Alt+Digit1",
    other: "Ctrl+Alt+Digit1",
  },
  {
    id: "term.moveToNewTab",
    group: "Terminals",
    name: "Move to a new tab",
    note: "Send the focused terminal to a tab of its own",
    mac: "Meta+Alt+KeyT",
    other: "Ctrl+Alt+KeyT",
  },
];

const BY_ID = new Map(ACTIONS.map((def) => [def.id, def]));

export const parseChord = (spec: string): Chord => {
  const parts = spec.split("+");
  const code = parts.pop() ?? "";
  return {
    code,
    meta: parts.includes("Meta"),
    ctrl: parts.includes("Ctrl"),
    alt: parts.includes("Alt"),
    shift: parts.includes("Shift"),
  };
};

export const formatChord = (chord: Chord): string =>
  [
    chord.meta ? "Meta" : "",
    chord.ctrl ? "Ctrl" : "",
    chord.alt ? "Alt" : "",
    chord.shift ? "Shift" : "",
    chord.code,
  ]
    .filter(Boolean)
    .join("+");

/** Overrides only, so a changed default still reaches anyone who never touched it. */
const load = (): Record<string, string> => {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
};

let overrides = load();

const defaultSpec = (def: ActionDef): string => (IS_MAC ? def.mac : def.other);

export const specOf = (id: ActionId): string => {
  const def = BY_ID.get(id)!;
  return overrides[id] ?? defaultSpec(def);
};

export const chordOf = (id: ActionId): Chord => parseChord(specOf(id));

export const isCustom = (id: ActionId): boolean => {
  const def = BY_ID.get(id)!;
  return !!overrides[id] && overrides[id] !== defaultSpec(def);
};

const save = (): void => {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(overrides));
  } catch {
    // A full or blocked store is not worth losing the keystroke over — the map still works
    // for this session.
  }
  window.dispatchEvent(new CustomEvent(KEYMAP_EVENT));
};

/** Rebind, or pass null to fall back to the default. */
export const setChord = (id: ActionId, chord: Chord | null): void => {
  if (chord) overrides[id] = formatChord(chord);
  else delete overrides[id];
  save();
};

export const resetKeymap = (): void => {
  overrides = {};
  save();
};

/** Actions that would answer the same keystroke — what the settings page marks in red. */
export const clashes = (): Set<ActionId> => {
  const seen = new Map<string, ActionId[]>();
  for (const def of ACTIONS) {
    const chord = chordOf(def.id);
    // A digit family owns its modifiers across every digit, so it clashes on modifiers alone.
    const key = def.digits
      ? `${formatChord({ ...chord, code: "" })}Digit*`
      : formatChord(chord);
    seen.set(key, [...(seen.get(key) ?? []), def.id]);
  }
  const hit = new Set<ActionId>();
  for (const ids of seen.values()) {
    if (ids.length > 1) ids.forEach((id) => hit.add(id));
  }
  return hit;
};

const MODIFIER_CODES = new Set([
  "MetaLeft",
  "MetaRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "ShiftLeft",
  "ShiftRight",
  "CapsLock",
]);

/** True while the event carries nothing but modifiers — a half-typed chord, not a chord. */
export const isModifierOnly = (event: KeyboardEvent): boolean => MODIFIER_CODES.has(event.code);

export const chordFromEvent = (event: KeyboardEvent): Chord => ({
  code: event.code,
  meta: event.metaKey,
  ctrl: event.ctrlKey,
  alt: event.altKey,
  shift: event.shiftKey,
});

/** Exact modifier match, so ⌃Tab and ⌃⇧Tab stay two different actions. */
const matchesChord = (event: KeyboardEvent, chord: Chord, digits = false): boolean => {
  if (
    event.metaKey !== chord.meta ||
    event.ctrlKey !== chord.ctrl ||
    event.altKey !== chord.alt ||
    event.shiftKey !== chord.shift
  ) {
    return false;
  }
  return digits ? /^Digit[1-9]$/.test(event.code) : event.code === chord.code;
};

/** Keys that type a character. With ⌥ alone held, macOS types a character on them instead:
 *  ⌥3 is # and ⌥8 is [ on Turkish Q, ⌥[ is [ on Bulgarian. A chord there steals that character
 *  from every terminal and editor in Panel. */
const TYPING_CODE = /^(Key[A-Z]|Digit\d|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|IntlBackslash|Space)$/;

/** True when this action's chord would eat a character some keyboard layout types with it. */
export const typesText = (id: ActionId): boolean => {
  const chord = chordOf(id);
  return IS_MAC && chord.alt && !chord.meta && !chord.ctrl && (!!BY_ID.get(id)?.digits || TYPING_CODE.test(chord.code));
};
export const matches = (event: KeyboardEvent, id: ActionId): boolean =>
  matchesChord(event, chordOf(id), !!BY_ID.get(id)?.digits);

/** Platform-aware chords for contextual commands outside the rebindable action table. */
export const matchesShortcut = (
  event: KeyboardEvent,
  mac: string,
  other = mac.replace(/Meta/g, "Ctrl"),
): boolean => matchesChord(event, parseChord(IS_MAC ? mac : other));

/** Which digit a digit-family event carried, 1…9, or null. */
export const digitOf = (event: KeyboardEvent): number | null =>
  /^Digit[1-9]$/.test(event.code) ? Number(event.code.slice(5)) : null;

const CODE_LABELS: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Enter: IS_MAC ? "↩" : "Enter",
  Escape: "Esc",
  Space: "Space",
  Tab: "Tab",
  Backspace: IS_MAC ? "⌫" : "Backspace",
  BracketLeft: "[",
  BracketRight: "]",
  Backquote: "`",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Minus: "-",
  Equal: "=",
};

export const codeLabel = (code: string): string => {
  if (CODE_LABELS[code]) return CODE_LABELS[code];
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  return code;
};

/** What a human reads: ⌘⌥← on a Mac, Ctrl+Alt+← everywhere else. */
export const chordLabel = (chord: Chord, digits = false): string => {
  const tail = digits ? "1…9" : codeLabel(chord.code);
  if (IS_MAC) {
    return (
      `${chord.ctrl ? "⌃" : ""}${chord.alt ? "⌥" : ""}${chord.shift ? "⇧" : ""}` +
      `${chord.meta ? "⌘" : ""}${tail}`
    );
  }
  return [
    chord.ctrl ? "Ctrl" : "",
    chord.alt ? "Alt" : "",
    chord.shift ? "Shift" : "",
    chord.meta ? "Meta" : "",
    tail,
  ]
    .filter(Boolean)
    .join("+");
};

export const shortcutLabel = (mac: string, other = mac.replace(/Meta/g, "Ctrl")): string =>
  chordLabel(parseChord(IS_MAC ? mac : other));

/** The label for one action — what buttons and tooltips print. */
export const label = (id: ActionId): string =>
  chordLabel(chordOf(id), !!BY_ID.get(id)?.digits);

export const actionDef = (id: ActionId): ActionDef => BY_ID.get(id)!;
