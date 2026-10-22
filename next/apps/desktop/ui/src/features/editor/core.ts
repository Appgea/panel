/**
 * The one text editor in Panel.
 *
 * Every surface that lets a human type into a file mounts THIS. There is no second CodeMirror
 * configuration anywhere: same keymap, same gutters, same minimap, same Xcode palette, same
 * zoom, same jump-and-flash. A change here moves every editor at once, which is the point.
 *
 * It behaves like Xcode's source editor because that is the editor its human reaches for: SF
 * Mono at Xcode's size and line spacing, breakpoints as blue tags on the line numbers, ⌥⌘[ and
 * ⌥⌘] to move lines, ⌥⌘← / ⌥⌘→ to fold, ⌃I to re-indent, ⌘E to search for the selection, ⌘\ for
 * a breakpoint, ⌃⇧↑/↓ for another caret, a double-click on a bracket selecting its block, and a
 * name that underlines while ⌘ is held when it can jump to its definition.
 *
 * Theme and font ride module-level Compartments, and every live editor is in one registry, so a
 * theme toggle or a ⌘+ lands on all of them in the same frame — an editor cannot drift out of
 * step with its neighbour just because it was mounted later.
 *
 * Hosts differ only in what they do AROUND the buffer: the Work tab parks many states and
 * swaps them (tabs); a host may keep exactly one. Both go through `createState` / `show`, so
 * off-screen states are reconfigured too and switching back can never resurrect an old palette.
 */

import {
  Compartment,
  EditorSelection,
  EditorState,
  RangeSet,
  StateEffect,
  StateField,
  type Extension,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  ViewPlugin,
  crosshairCursor,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  highlightTrailingWhitespace,
  hoverTooltip,
  keymap,
  lineNumberMarkers,
  lineNumbers,
  rectangularSelection,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  addCursorAbove,
  addCursorBelow,
  defaultKeymap,
  history,
  historyKeymap,
  indentSelection,
  indentWithTab,
  moveLineDown,
  moveLineUp,
} from "@codemirror/commands";
import {
  SearchQuery,
  getSearchQuery,
  gotoLine,
  highlightSelectionMatches,
  search,
  searchKeymap,
  selectNextOccurrence,
  selectSelectionMatches,
  setSearchQuery,
} from "@codemirror/search";
import {
  bracketMatching,
  foldAll,
  foldCode,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
  matchBrackets,
  unfoldAll,
  unfoldCode,
} from "@codemirror/language";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completeAnyWord,
  completionKeymap,
} from "@codemirror/autocomplete";
import { currentMode, themePacks, type ThemeMode } from "./theme";
import { minimap, outlineSource, overviewSources, type OutlineSource } from "./minimap";
import { fileExtension, languageFor } from "./languages";
import { indentGuides } from "./indent_guides";
import { stickyScroll } from "./sticky_scroll";
import { outline, type OutlineItem } from "./outline";
import { refreshSymbols, semanticHighlight, symbolSource, type SymbolTable } from "./semantic";
import { createFindPanel, openReplace } from "./find_panel";
import {
  changeGutter,
  closeChangePopover,
  setChangeDocument,
  type StageHunk,
} from "./change_hunks";
import { IS_MAC } from "../keymap";
import "./editor.css";

/* ------------------------------------------------------------- scroll spot */

/**
 * Where a buffer is scrolled, as the first visible line and how far into it. A raw scrollTop
 * drifts when the buffer comes back, because a fresh state starts from estimated line heights.
 */
export type ScrollSpot = { line: number; offset: number; left: number };

function spotOf(view: EditorView): ScrollSpot {
  const { scrollTop, scrollLeft } = view.scrollDOM;
  const height = scrollTop - view.documentPadding.top;
  const block = view.lineBlockAtHeight(height);
  return { line: view.state.doc.lineAt(block.from).number, offset: height - block.top, left: scrollLeft };
}

function spotTop(view: EditorView, spot: ScrollSpot): number {
  const line = view.state.doc.line(Math.max(1, Math.min(spot.line, view.state.doc.lines)));
  return view.lineBlockAt(line.from).top + view.documentPadding.top + spot.offset;
}

/* ------------------------------------------------------------------- flash */

/** A one-shot line highlight. Set on jump, cleared by the fade's own timeout. */
const setFlash = StateEffect.define<number | null>();
const flashDeco = Decoration.line({ class: "cm-flashLine" });

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setFlash)) continue;
      next = effect.value === null ? Decoration.none : Decoration.set([flashDeco.range(effect.value)]);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/* ---------------------------------------------------------- execution line */

/*
 * Where the program is stopped right now.
 *
 * The flash above is a one-shot: it says "your jump landed here" and fades. A paused debugger
 * needs the opposite — a mark that STAYS until the program moves, because the whole time it is
 * paused the question is "which line am I on". So this is a separate field with no timer, set
 * and cleared by the debug bar rather than by a jump. Like Xcode, the line number wears the mark
 * too, so the stop is findable from the gutter alone.
 */
const setExec = StateEffect.define<number | null>();
const execDeco = Decoration.line({ class: "cm-execLine" });

class LineClassMarker extends GutterMarker {
  constructor(readonly elementClass: string) {
    super();
  }

  eq(other: GutterMarker): boolean {
    return other instanceof LineClassMarker && other.elementClass === this.elementClass;
  }
}

const execMarker = new LineClassMarker("cm-exec");

type ExecMarks = { deco: DecorationSet; gutter: RangeSet<GutterMarker> };

const execField = StateField.define<ExecMarks>({
  create: () => ({ deco: Decoration.none, gutter: RangeSet.empty }),
  update(value, tr) {
    let next: ExecMarks = { deco: value.deco.map(tr.changes), gutter: value.gutter.map(tr.changes) };
    for (const effect of tr.effects) {
      if (!effect.is(setExec)) continue;
      next = effect.value === null
        ? { deco: Decoration.none, gutter: RangeSet.empty }
        : { deco: Decoration.set([execDeco.range(effect.value)]), gutter: RangeSet.of([execMarker.range(effect.value)]) };
    }
    return next;
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.deco),
    lineNumberMarkers.from(field, (value) => value.gutter),
  ],
});

/**
 * The word under the pointer, as an expression.
 *
 * Deliberately naive: an identifier, plus the dotted path it hangs off, and nothing more. A real
 * expression parser would occasionally read further and get it wrong, and a wrong value is worse
 * than no value when you are deciding whether a bug is here or upstream.
 */
const NAME = /[A-Za-z_$][\w$]*/;

function expressionAt(view: EditorView, pos: number): { from: number; to: number; text: string } | null {
  const line = view.state.doc.lineAt(pos);
  const offset = pos - line.from;
  let from = offset;
  let to = offset;
  const body = line.text;
  const wordy = (ch: string): boolean => NAME.test(ch);
  while (from > 0 && wordy(body[from - 1])) from -= 1;
  while (to < body.length && wordy(body[to])) to += 1;
  if (from === to) return null;
  // Walk back over `a.b.` so hovering `name` inside `user.profile.name` asks about the whole path.
  let start = from;
  while (start > 1 && body[start - 1] === ".") {
    let back = start - 1;
    while (back > 0 && wordy(body[back - 1])) back -= 1;
    if (back === start - 1) break;
    start = back;
  }
  const text = body.slice(start, to);
  if (!text || !NAME.test(text[0])) return null;
  return { from: line.from + start, to: line.from + to, text };
}

function valueTooltip(resolve: HoverValue): Extension {
  return hoverTooltip(async (view, pos) => {
    const found = expressionAt(view, pos);
    if (!found) return null;
    const value = await resolve(found.text);
    if (value === null) return null;
    return {
      pos: found.from,
      end: found.to,
      above: true,
      create: () => {
        const dom = document.createElement("div");
        dom.className = "cm-valueTip";
        const name = document.createElement("b");
        name.textContent = found.text;
        const body = document.createElement("span");
        body.textContent = value;
        dom.append(name, body);
        return { dom };
      },
    };
  }, { hoverTime: 220 });
}

/* ------------------------------------------------------------ breakpoints */

/*
 * Xcode's breakpoint: a blue tag laid over the line number, not a dot in a gutter of its own.
 * Clicking a number arms it, clicking the tag disarms it. The gutter stays exactly as wide as
 * the numbers need, which is one less column of chrome between you and the code.
 */
const setBreakpointLines = StateEffect.define<readonly number[]>();
const breakpointMarker = new LineClassMarker("cm-bp");

function breakpointSet(state: EditorState, lines: readonly number[]): RangeSet<GutterMarker> {
  const ranges = [...new Set(lines)]
    .filter((line) => line >= 1 && line <= state.doc.lines)
    .sort((a, b) => a - b)
    .map((line) => breakpointMarker.range(state.doc.line(line).from));
  return RangeSet.of(ranges);
}

function breakpointLines(path: string, options: CodeEditorOptions): Extension {
  const field = StateField.define<RangeSet<GutterMarker>>({
    create: (state) => breakpointSet(state, options.breakpoints?.(path) ?? []),
    update(markers, transaction) {
      let next = markers.map(transaction.changes);
      for (const effect of transaction.effects) {
        if (effect.is(setBreakpointLines)) next = breakpointSet(transaction.state, effect.value);
      }
      return next;
    },
    provide: (source) => lineNumberMarkers.from(source),
  });
  return [
    field,
    lineNumbers({
      domEventHandlers: {
        mousedown(view, line, event) {
          if (!(event instanceof MouseEvent) || event.button !== 0) return false;
          options.onToggleBreakpoint?.(path, view.state.doc.lineAt(line.from).number);
          return true;
        },
      },
    }),
    overviewSources.of((state) => {
      const lines: { line: number; tone: "breakpoint" }[] = [];
      state.field(field).between(0, state.doc.length, (from) => {
        lines.push({ line: state.doc.lineAt(from).number, tone: "breakpoint" });
      });
      return lines;
    }),
  ];
}

/* ------------------------------------------------------------------ folding */

const CHEVRON = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3 2.2 6.6 5 3 7.8"/></svg>';

/** Chevrons that appear when the pointer is over the gutter, like Xcode's folding ribbon. */
const xcodeFoldGutter = foldGutter({
  markerDOM(open) {
    const marker = document.createElement("span");
    marker.className = open ? "cm-fold-mark is-open" : "cm-fold-mark is-folded";
    marker.innerHTML = CHEVRON;
    marker.title = open ? "Fold (⌥⌘←)" : "Unfold (⌥⌘→)";
    return marker;
  },
});

/* ------------------------------------------------------------- indentation */

/**
 * What the file already does, so Tab does the same. A Python file indented by four must not
 * get two spaces from a default nobody chose. Tabs win when any indented line uses one; among
 * spaces, the most common step between consecutive indented lines wins, with 2 as the tie.
 */
function detectIndent(text: string): string {
  let tabs = 0;
  const steps = new Map<number, number>();
  let previous = 0;
  let seen = 0;
  const lines = text.split("\n", 4000);
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line[0] === "\t") {
      tabs += 1;
      continue;
    }
    let spaces = 0;
    while (spaces < line.length && line[spaces] === " ") spaces += 1;
    const delta = Math.abs(spaces - previous);
    if (delta > 0 && delta <= 8) {
      steps.set(delta, (steps.get(delta) ?? 0) + 1);
      seen += 1;
    }
    previous = spaces;
  }
  if (tabs > seen) return "\t";
  let best = 2;
  let votes = 0;
  for (const [step, count] of steps) {
    if (count > votes || (count === votes && step < best)) {
      best = step;
      votes = count;
    }
  }
  return " ".repeat(best);
}

/** "Tab" or "2 spaces" — for the status bar. */
export function indentLabel(state: EditorState): string {
  const unit = state.facet(indentUnit);
  return unit.includes("\t") ? "Tab" : `${unit.length} spaces`;
}

/* -------------------------------------------------------------------- wrap */

/*
 * Line wrapping is per buffer, not per app. Prose wants it — a Markdown paragraph that runs off
 * the right edge is unreadable — and code does not, because indentation is structure and a
 * wrapped line lies about its depth. The default follows the file; the status bar flips it.
 */
const PROSE_EXTENSIONS = new Set(["md", "markdown", "txt", "text", "rst", "adoc", ""]);

const wrapCompartment = new Compartment();
const setWrap = StateEffect.define<boolean>();
const wrapField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setWrap)) return effect.value;
    return value;
  },
});

const wrapExtension = (on: boolean): Extension => (on ? EditorView.lineWrapping : []);

export const wrapsByDefault = (path: string): boolean => PROSE_EXTENSIONS.has(fileExtension(path));

/* ----------------------------------------------------------------- outline */

/** The outline was read again. Hosts repaint their jump bar; the minimap its labels. */
export const outlineChanged = StateEffect.define<null>();

/** Typing pauses this long before the outline is read again. Nobody reads a jump bar mid-word. */
const OUTLINE_IDLE = 180;

/**
 * One buffer's outline, remembered by document. Reading it never re-parses unless the text
 * moved, and while it is moving the last answer stands until typing pauses.
 */
function outlineFor(path: string): OutlineSource {
  const extension = fileExtension(path);
  let latest: { doc: Text; items: OutlineItem[] } | null = null;
  const read = (doc: Text): OutlineItem[] => outline(doc.toString(), extension);
  return {
    items(state) {
      if (!latest) latest = { doc: state.doc, items: read(state.doc) };
      return latest.items;
    },
    refresh(state) {
      if (latest?.doc !== state.doc) latest = { doc: state.doc, items: read(state.doc) };
    },
  };
}

function outlineKeeper(onOutline: (() => void) | undefined): Extension {
  return ViewPlugin.fromClass(
    class {
      private timer = 0;

      constructor(private readonly view: EditorView) {}

      update(update: ViewUpdate): void {
        if (!update.docChanged) return;
        window.clearTimeout(this.timer);
        this.timer = window.setTimeout(() => {
          const source = this.view.state.facet(outlineSource);
          if (!source) return;
          source.refresh(this.view.state);
          this.view.dispatch({ effects: outlineChanged.of(null) });
          onOutline?.();
        }, OUTLINE_IDLE);
      }

      destroy(): void {
        window.clearTimeout(this.timer);
      }
    },
  );
}

/* ---------------------------------------------------- go to definition */

/** The identifier at `pos`, or null. */
function wordAt(state: EditorState, pos: number): { from: number; to: number; text: string } | null {
  const line = state.doc.lineAt(pos);
  const offset = pos - line.from;
  let from = offset;
  let to = offset;
  while (from > 0 && /[\p{L}\p{N}_$]/u.test(line.text[from - 1])) from -= 1;
  while (to < line.text.length && /[\p{L}\p{N}_$]/u.test(line.text[to])) to += 1;
  const text = line.text.slice(from, to);
  return /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(text) ? { from: line.from + from, to: line.from + to, text } : null;
}

const setLink = StateEffect.define<{ from: number; to: number } | null>();
const linkMark = Decoration.mark({ class: "cm-xc-link" });
const linkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setLink)) next = effect.value ? Decoration.set([linkMark.range(effect.value.from, effect.value.to)]) : Decoration.none;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * ⌘-hover underlines the name, ⌘-click jumps to it, ⌃⌘J jumps from the caret. The underline is
 * the promise: a name you can see will jump is a name you will actually click. Mouse moves cost
 * nothing until ⌘ is down. Off macOS, Ctrl stands in for ⌘.
 */
const PRIMARY_KEY = IS_MAC ? "Meta" : "Control";
const primaryHeld = (event: MouseEvent): boolean => (IS_MAC ? event.metaKey : event.ctrlKey);

function definitionLinks(go: (symbol: string, position: number) => void): Extension {
  const linkPlugin = ViewPlugin.fromClass(
    class {
      private current: string | null = null;
      pointer: { x: number; y: number } | null = null;
      private readonly onKey = (event: KeyboardEvent): void => {
        if (event.key !== PRIMARY_KEY) return;
        if (event.type === "keyup") this.clear();
        else if (this.pointer) this.aim(this.pointer.x, this.pointer.y);
      };
      private readonly onBlur = (): void => this.clear();

      constructor(private readonly view: EditorView) {
        window.addEventListener("keydown", this.onKey);
        window.addEventListener("keyup", this.onKey);
        window.addEventListener("blur", this.onBlur);
      }

      aim(x: number, y: number): void {
        const position = this.view.posAtCoords({ x, y }, false);
        const word = position === null ? null : wordAt(this.view.state, position);
        const key = word ? `${word.from}:${word.to}` : null;
        if (key === this.current) return;
        this.current = key;
        this.view.dispatch({ effects: setLink.of(word ? { from: word.from, to: word.to } : null) });
      }

      move(event: MouseEvent): void {
        this.pointer = { x: event.clientX, y: event.clientY };
        if (primaryHeld(event)) this.aim(event.clientX, event.clientY);
        else if (this.current) this.clear();
      }

      clear(): void {
        if (!this.current) return;
        this.current = null;
        this.view.dispatch({ effects: setLink.of(null) });
      }

      destroy(): void {
        window.removeEventListener("keydown", this.onKey);
        window.removeEventListener("keyup", this.onKey);
        window.removeEventListener("blur", this.onBlur);
      }
    },
    {
      eventHandlers: {
        mousemove(event) {
          this.move(event);
        },
        mouseleave() {
          this.pointer = null;
          this.clear();
        },
      },
    },
  );
  return [
    linkField,
    linkPlugin,
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (!primaryHeld(event) || event.button !== 0 || event.shiftKey || event.altKey) return false;
        const position = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
        const word = position === null ? null : wordAt(view.state, position);
        // No name under the pointer: ⌘-click falls through to adding a caret.
        if (!word) return false;
        event.preventDefault();
        go(word.text, word.from);
        return true;
      },
    }),
    keymap.of([{
      key: "Ctrl-Mod-j",
      preventDefault: true,
      run: (view) => {
        const word = wordAt(view.state, view.state.selection.main.head);
        if (!word) return false;
        go(word.text, word.from);
        return true;
      },
    }]),
  ];
}

/* ------------------------------------------------------- editor commands */

/** ⌘E — Xcode's "Use Selection for Find". The bar need not be open; ⌘G walks from here. */
function useSelectionForFind(view: EditorView): boolean {
  const range = view.state.selection.main;
  if (range.empty) return false;
  const text = view.state.sliceDoc(range.from, range.to);
  if (text.includes("\n")) return false;
  const query = getSearchQuery(view.state);
  view.dispatch({
    effects: setSearchQuery.of(new SearchQuery({
      search: text,
      caseSensitive: query.caseSensitive,
      wholeWord: query.wholeWord,
      regexp: false,
      replace: query.replace,
    })),
  });
  return true;
}

/** A double-click on a bracket selects everything between it and its partner, brackets included. */
const selectBracketBlock = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.detail !== 2 || event.button !== 0 || event.metaKey || event.shiftKey || event.altKey) return false;
    const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (position === null) return false;
    const { doc } = view.state;
    for (const at of [position, position - 1]) {
      if (at < 0 || at >= doc.length) continue;
      const character = doc.sliceString(at, at + 1);
      if (!"{}[]()".includes(character)) continue;
      const forward = "{[(".includes(character);
      const match = matchBrackets(view.state, forward ? at : at + 1, forward ? 1 : -1);
      if (!match?.matched || !match.end) continue;
      const from = Math.min(match.start.from, match.end.from);
      const to = Math.max(match.start.to, match.end.to);
      event.preventDefault();
      view.dispatch({ selection: EditorSelection.single(from, to), userEvent: "select.pointer" });
      return true;
    }
    return false;
  },
});

/* -------------------------------------------------------------- zoom, theme */

const FONT_SIZE_KEY = "panel.editor.font-size";
/** Where the Work tab kept its zoom before the editor was shared. Read once, never written. */
const LEGACY_FONT_SIZE_KEY = "panel.files.font-size";
const FONT_MIN = 9;
const FONT_MAX = 28;
/** Xcode's default: SF Mono 12. */
const FONT_DEFAULT = 12;
/**
 * Xcode's line spacing (1.1 × SF Mono's natural 1.19 line), rounded to whole pixels so the
 * caret line, selection and every gutter row land on the pixel grid instead of drifting by
 * fractions down a long file.
 */
const LINE_RATIO = 1.34;

/* One Compartment instance is a KEY, not state — every editor's state can carry the same two,
   which is what lets a single reconfigure sweep them all. */
const themeCompartment = new Compartment();
const fontCompartment = new Compartment();

const fontExtension = (size: number): Extension =>
  EditorView.theme({
    "&": { fontSize: `${size}px` },
    ".cm-scroller": { lineHeight: `${Math.round(size * LINE_RATIO)}px` },
  });

function storedFontSize(): number {
  try {
    for (const key of [FONT_SIZE_KEY, LEGACY_FONT_SIZE_KEY]) {
      const stored = Number(localStorage.getItem(key));
      if (Number.isFinite(stored) && stored >= FONT_MIN && stored <= FONT_MAX) return stored;
    }
  } catch {
    /* storage unavailable — the default size stands */
  }
  return FONT_DEFAULT;
}

let fontSize = storedFontSize();
let themeMode: ThemeMode = currentMode();

/** Every mounted editor. Theme and zoom are app-wide, so they are applied across this set. */
const live = new Set<Instance>();

type Instance = {
  view: EditorView;
  options: CodeEditorOptions;
};

/** Push a compartment change into one editor: the live view, then the host's parked states. */
function reconfigure(instance: Instance, effect: StateEffect<unknown>): void {
  instance.view.dispatch({ effects: effect });
  instance.options.onReconfigure?.((state) => state.update({ effects: effect }).state);
}

/**
 * The app theme toggled. Every live view syncs immediately; every parked state gets the same
 * reconfigure applied off-screen so switching to it later cannot resurrect the old palette.
 */
function onThemeChange(): void {
  const mode = currentMode();
  if (mode === themeMode) return;
  themeMode = mode;
  const effect = themeCompartment.reconfigure(themePacks[mode]);
  for (const instance of live) reconfigure(instance, effect);
}
window.addEventListener("panel-theme-change", onThemeChange);

/** Zoom the code, everywhere, clamped and persisted. */
function setFontSize(size: number): void {
  const clamped = Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(size)));
  if (clamped === fontSize) return;
  fontSize = clamped;
  const effect = fontCompartment.reconfigure(fontExtension(clamped));
  for (const instance of live) reconfigure(instance, effect);
  try {
    localStorage.setItem(FONT_SIZE_KEY, String(clamped));
  } catch {
    /* storage unavailable — zoom still holds for this session */
  }
}

const zoomIn = (): boolean => (setFontSize(fontSize + 1), true);
const zoomOut = (): boolean => (setFontSize(fontSize - 1), true);
const zoomReset = (): boolean => (setFontSize(FONT_DEFAULT), true);

/* ------------------------------------------------------------------ editor */

/*
 * Hovering a name while the debugger is paused.
 *
 * The Debug tab already has a variables tree and a REPL; this is neither. It is the one question
 * you ask twenty times per pause — "what is THIS right now" — answered where your eye already is,
 * without typing the name into a prompt on another screen.
 */
export type HoverValue = (expression: string) => Promise<string | null>;

export type CodeEditorOptions = {
  /** The element the CodeMirror view is appended to. */
  parent: HTMLElement;
  /**
   * Resolve the identifier under the pointer to a value, or null when there is nothing to say.
   * Called only after the reader rests on a word, so it is free to go out to a debug adapter.
   */
  hoverValue?: HoverValue;
  /**
   * Watched for visibility instead of `parent`, when the pane that can be hidden is an
   * ancestor. An editor built inside `display:none` caches a zero-size geometry — the gutter
   * prints line numbers but the content viewport never paints — so it re-measures the instant
   * it becomes visible. Revealing the tab is then enough; no scroll or keystroke needed.
   */
  visibilityHost?: HTMLElement;
  /** ⌘/Ctrl+S. The host owns what "save" means and where it writes. */
  onSave?(): void;
  /** Fired for every view update, doc change or not. */
  onUpdate?(update: ViewUpdate): void;
  /** The outline was re-read after typing paused. Hosts with a jump bar repaint it. */
  onOutline?(): void;
  /**
   * The host parks states off-screen (tabs). Called on any theme or zoom change: map each
   * parked state through `apply` and store the result. Single-buffer hosts omit it.
   */
  onReconfigure?(apply: (state: EditorState) => EditorState): void;
  /** Initial breakpoint lines for a file. Omit both hooks for non-code editors. */
  breakpoints?(path: string): readonly number[];
  /** A click on a line number, or ⌘\ / F9. The host persists and reapplies the full line set. */
  onToggleBreakpoint?(path: string, line: number): void;
  /** Draw the git change gutter. The host feeds it through `setChanges`. */
  changeBars?: boolean;
  /** Stage one clicked gutter hunk. Only Work supplies this Git-owned action. */
  onStageHunk?(hunk: StageHunk): Promise<void>;
  /** Surface a hunk action failure in the host's normal status affordance. */
  onHunkError?(message: string): void;
  /**
   * Jump to a name's definition. Supplying it turns on the ⌘-hover underline, ⌘-click and ⌃⌘J.
   * `position` is where the name starts in the live buffer.
   */
  goToDefinition?(symbol: string, position: number): void;
  /** The project's own names, for Xcode's project-vs-SDK colouring. Null when unknown. */
  symbols?(): SymbolTable | null;
  /** Host-specific extensions appended to every state this editor builds. */
  extra?: Extension[];
};

export type CodeEditor = {
  /** The live view. Reach for it only for things this handle deliberately does not wrap. */
  readonly view: EditorView;
  /** Build a state for a buffer — the full pack, plus the language `path` implies. */
  createState(path: string, text: string): EditorState;
  /** Whether the live buffer wraps long lines. */
  wrapped(): boolean;
  /** Flip wrapping on the live buffer only. Other buffers keep their own answer. */
  setWrap(on: boolean): void;
  /** Put a state on screen and re-measure (the pane may have just been revealed). `spot` is
   *  where it was scrolled when it left the screen; without one it opens at the top. */
  show(state: EditorState, spot?: ScrollSpot | null): void;
  /** Where the buffer on screen is scrolled, to hand back to `show` later. */
  scrollSpot(): ScrollSpot;
  /** Build and show in one step. The single-buffer path. */
  load(path: string, text: string): void;
  /** Nothing open: an empty, chrome-free buffer that still carries theme and zoom. */
  blank(): void;
  /** Current buffer contents. */
  doc(): string;
  /** Overwrite the buffer in place, keeping the caret roughly where it was. */
  replaceDoc(text: string): void;
  /** Land the eye on a 1-indexed line: select it, centre it, flash it, release it. */
  jumpTo(line: number): void;
  /** The live buffer's outline — types, functions, marks. Empty for a blank buffer. */
  outline(): readonly OutlineItem[];
  /** The host has a fresh symbol table. Repaint the visible names. */
  refreshSymbols(): void;
  /** Replace the breakpoint markers in the live buffer. */
  setBreakpoints(lines: readonly number[]): void;
  /** Compare the live buffer to this HEAD text. Null clears the change gutter. */
  setChanges(base: string | null): void;
  /**
   * Mark the line the debugger is stopped on, or clear it with null. Unlike `jumpTo`'s flash
   * this does not fade: it is the answer to "where am I" for as long as the program is paused.
   */
  setExecLine(line: number | null): void;
  destroy(): void;
};

export function createCodeEditor(options: CodeEditorOptions): CodeEditor {
  options.parent.classList.add("panel-editor", "ui-still");
  const view = new EditorView({ parent: options.parent });
  const instance: Instance = { view, options };
  live.add(instance);

  const visibility = new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.isIntersecting) view.requestMeasure();
  });
  visibility.observe(options.visibilityHost ?? options.parent);

  // ⌘/Ctrl + wheel (and trackpad pinch, which the OS reports as ctrl+wheel) zooms too.
  const onWheel = (event: WheelEvent): void => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    setFontSize(fontSize + (event.deltaY < 0 ? 1 : -1));
  };
  options.parent.addEventListener("wheel", onWheel, { passive: false });

  let flashTimer = 0;
  const outlineKeeperExtension = outlineKeeper(options.onOutline);
  const definitions = options.goToDefinition ? definitionLinks(options.goToDefinition) : [];

  function createState(path: string, text: string): EditorState {
    const wrap = wrapsByDefault(path);
    const toggleBreakpoint = (target: EditorView): boolean => {
      options.onToggleBreakpoint?.(path, target.state.doc.lineAt(target.state.selection.main.head).number);
      return true;
    };
    return EditorState.create({
      doc: text,
      extensions: [
        indentUnit.of(detectIndent(text)),
        wrapField.init(() => wrap),
        wrapCompartment.of(wrapExtension(wrap)),
        /* Xcode's gutter order: numbers (carrying breakpoints), the change bar, the fold ribbon. */
        options.onToggleBreakpoint ? breakpointLines(path, options) : lineNumbers(),
        ...(options.changeBars
          ? [changeGutter(path, { stage: options.onStageHunk, failed: options.onHunkError })]
          : []),
        xcodeFoldGutter,
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        highlightTrailingWhitespace(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        highlightActiveLine(),
        /* An explicit selection lights its other copies. The caret's symbol is semantic.ts's
           job, because only it knows a name from a keyword. */
        highlightSelectionMatches({ minSelectionLength: 2, maxMatches: 500 }),
        rectangularSelection(),
        crosshairCursor(),
        /* Xcode's find bar sits at the TOP of the editor, and counts. */
        search({ top: true, createPanel: createFindPanel }),
        /* Quotes and brackets close themselves, and typing the closer skips over it. */
        closeBrackets(),
        /* Completion. Language packs contribute their own sources; every language also gets
           words already in the document, which is what actually helps in a prose file or
           a config file where no grammar knows the vocabulary. */
        autocompletion(),
        EditorState.languageData.of(() => [{ autocomplete: completeAnyWord }]),
        /* ⌃⇧click adds a cursor, as in Xcode. ⌘click is a definition jump when the host offers
           one and there is a name under the pointer; otherwise it adds a cursor too. */
        EditorView.clickAddsSelectionRange.of(
          (event) => (event.ctrlKey && event.shiftKey) || primaryHeld(event),
        ),
        selectBracketBlock,
        symbolSource.of(options.symbols ?? (() => null)),
        semanticHighlight(),
        outlineSource.of(outlineFor(path)),
        outlineKeeperExtension,
        definitions,
        indentGuides(),
        stickyScroll(),
        minimap(),
        flashField,
        execField,
        ...(options.hoverValue ? [valueTooltip(options.hoverValue)] : []),
        keymap.of([
          /* Completion and bracket keys go first — they must win over the plain editing
             bindings while a tooltip is open, or Escape and the arrows land in the document. */
          ...closeBracketsKeymap,
          ...completionKeymap,
          /* Multi-cursor. ⌘D FINDS AND SELECTS the next occurrence — it never duplicates
             anything. It is bound here rather than left to `searchKeymap` at the bottom of
             this array so nothing added later can quietly shadow it. ⌥⌘E is Xcode's name for
             the same move; ⌃⌘E and ⌘⇧L take every occurrence at once. */
          { key: "Mod-d", preventDefault: true, run: selectNextOccurrence },
          { key: "Mod-Alt-e", preventDefault: true, run: selectNextOccurrence },
          { key: "Mod-Ctrl-e", preventDefault: true, run: selectSelectionMatches },
          { key: "Ctrl-Shift-ArrowUp", preventDefault: true, run: addCursorAbove },
          { key: "Ctrl-Shift-ArrowDown", preventDefault: true, run: addCursorBelow },
          /* Xcode's line moves and folds. These sit above `foldKeymap`, which would otherwise
             take ⌥⌘[ and ⌥⌘] for folding. */
          { key: "Mod-Alt-[", preventDefault: true, run: moveLineUp },
          { key: "Mod-Alt-]", preventDefault: true, run: moveLineDown },
          { key: "Mod-Alt-ArrowLeft", preventDefault: true, run: foldCode },
          { key: "Mod-Alt-ArrowRight", preventDefault: true, run: unfoldCode },
          { key: "Mod-Alt-Shift-ArrowLeft", preventDefault: true, run: foldAll },
          { key: "Mod-Alt-Shift-ArrowRight", preventDefault: true, run: unfoldAll },
          /* ⌃I re-indents the selection to the language's rules. */
          { key: "Ctrl-i", preventDefault: true, run: indentSelection },
          { key: "Mod-e", preventDefault: true, run: useSelectionForFind },
          { key: "Mod-Alt-f", preventDefault: true, run: openReplace },
          /* Xcode puts Go to Line on ⌘L. CodeMirror's own ⌥⌘G still works. */
          { key: "Mod-l", preventDefault: true, run: gotoLine },
          ...(options.onToggleBreakpoint
            ? [
                { key: "F9", preventDefault: true, run: toggleBreakpoint },
                { key: "Mod-\\", preventDefault: true, run: toggleBreakpoint },
              ]
            : []),
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              options.onSave?.();
              return true;
            },
          },
          { key: "Mod-=", preventDefault: true, run: zoomIn },
          { key: "Mod-+", preventDefault: true, run: zoomIn },
          { key: "Mod--", preventDefault: true, run: zoomOut },
          { key: "Mod-0", preventDefault: true, run: zoomReset },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          ...foldKeymap,
        ]),
        themeCompartment.of(themePacks[themeMode]),
        fontCompartment.of(fontExtension(fontSize)),
        EditorView.updateListener.of((update) => options.onUpdate?.(update)),
        ...(options.extra ?? []),
        ...languageFor(path),
      ],
    });
  }

  /**
   * Put a buffer back where it was. Placed twice on purpose. The measure places it first, so the
   * lines around the spot are rendered. Then WebKit moves it: Safari 26 ignores
   * focus({ preventScroll }), as CodeMirror's source notes, so the refocus inside setState ends
   * in a scroll toward the caret on the layout after ours. A returning tab landed hundreds of
   * pixels off. A ResizeObserver's first callback runs after that layout and before paint, so
   * the spot is put back there and the wrong position is never drawn.
   */
  function show(state: EditorState, spot?: ScrollSpot | null): void {
    closeChangePopover(view);
    view.setState(state);
    view.scrollDOM.scrollLeft = spot?.left ?? 0;
    if (!spot) {
      view.scrollDOM.scrollTop = 0;
      view.requestMeasure();
      return;
    }
    view.requestMeasure({
      read: (target) => spotTop(target, spot),
      write: (top, target) => {
        target.scrollDOM.scrollTop = top;
      },
    });
    const hold = new ResizeObserver(() => {
      hold.disconnect();
      const top = spotTop(view, spot);
      if (Math.abs(view.scrollDOM.scrollTop - top) > 1) view.scrollDOM.scrollTop = top;
      view.scrollDOM.scrollLeft = spot.left;
    });
    hold.observe(view.scrollDOM);
  }

  return {
    view,
    createState,
    show,
    scrollSpot: () => spotOf(view),
    load: (path, text) => show(createState(path, text)),
    blank() {
      closeChangePopover(view);
      view.setState(
        EditorState.create({
          doc: "",
          extensions: [
            themeCompartment.of(themePacks[themeMode]),
            fontCompartment.of(fontExtension(fontSize)),
          ],
        }),
      );
    },
    doc: () => view.state.doc.toString(),
    wrapped: () => view.state.field(wrapField, false) ?? false,
    setWrap(on) {
      if (!view.state.field(wrapField, false) === !on) return;
      view.dispatch({ effects: [setWrap.of(on), wrapCompartment.reconfigure(wrapExtension(on))] });
    },
    replaceDoc(text) {
      const head = Math.min(view.state.selection.main.head, text.length);
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: head },
      });
    },
    jumpTo(line) {
      const doc = view.state.doc;
      const target = doc.line(Math.max(1, Math.min(line, doc.lines)));
      view.dispatch({
        selection: { anchor: target.from + (target.text.search(/\S|$/) || 0) },
        effects: [setFlash.of(target.from), EditorView.scrollIntoView(target.from, { y: "center" })],
      });
      view.focus();
      window.clearTimeout(flashTimer);
      flashTimer = window.setTimeout(() => {
        view.dispatch({ effects: setFlash.of(null) });
      }, 1100);
    },
    outline: () => view.state.facet(outlineSource)?.items(view.state) ?? [],
    refreshSymbols() {
      view.dispatch({ effects: refreshSymbols.of(null) });
    },
    setBreakpoints(lines) {
      view.dispatch({ effects: setBreakpointLines.of(lines) });
    },
    setChanges(base) {
      if (!options.changeBars) return;
      setChangeDocument(view, base);
    },
    setExecLine(line) {
      const doc = view.state.doc;
      if (line === null || line < 1 || line > doc.lines) {
        view.dispatch({ effects: setExec.of(null) });
        return;
      }
      const target = doc.line(line);
      view.dispatch({
        effects: [setExec.of(target.from), EditorView.scrollIntoView(target.from, { y: "center" })],
      });
    },
    destroy() {
      window.clearTimeout(flashTimer);
      closeChangePopover(view);
      options.parent.removeEventListener("wheel", onWheel);
      options.parent.classList.remove("panel-editor", "ui-still");
      visibility.disconnect();
      live.delete(instance);
      view.destroy();
    },
  };
}
