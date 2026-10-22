/**
 * The in-file find bar — Xcode's, at the top of the editor.
 *
 * CodeMirror's stock panel is a row of form controls that does nothing until Enter and never
 * says how many matches there are. Xcode's bar is incremental: every keystroke lands the
 * selection on the nearest match from where you started, the field says "3 of 12", and an
 * empty answer turns the field red instead of leaving you to wonder. Replace is the same bar
 * with a second row, so the two modes never feel like different tools.
 *
 * Keys: ⌘F opens (seeded from the selection), ⌥⌘F opens with replace, Return / ⇧Return walk the
 * matches, ⌘G / ⇧⌘G work from the field too, Esc closes and returns the caret to the buffer.
 */

import { EditorSelection, type EditorState } from "@codemirror/state";
import { EditorView, type Panel, type ViewUpdate } from "@codemirror/view";
import {
  SearchQuery,
  closeSearchPanel,
  openSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  setSearchQuery,
} from "@codemirror/search";
import { IS_MAC } from "../keymap";

/** Past this many matches the count says "10000+" — an exact number would cost a full scan. */
const MAX_COUNT = 10_000;

/** Set by ⌥⌘F before it opens the panel, so the panel mounts with its replace row showing. */
let replaceRequested = false;
/** The open bar per editor, so ⌥⌘F on an open bar shows its replace row instead of reopening. */
const mounted = new WeakMap<EditorView, () => void>();

/** ⌥⌘F — the find bar with its replace row showing and the caret in it. */
export function openReplace(view: EditorView): boolean {
  const show = mounted.get(view);
  if (show) {
    show();
    return true;
  }
  replaceRequested = true;
  openSearchPanel(view);
  return true;
}

function matchStarts(state: EditorState, query: SearchQuery): number[] {
  if (!query.valid || !query.search) return [];
  const starts: number[] = [];
  const cursor = query.getCursor(state);
  for (let step = cursor.next(); !step.done; step = cursor.next()) {
    starts.push(step.value.from);
    if (starts.length >= MAX_COUNT) break;
  }
  return starts;
}

/**
 * The bar sits above the scroller, so showing it shortens the scroller from the top and the text
 * slides down by the bar's height. Scrolling by the same amount keeps every line where the eye
 * left it. Mount runs after the bar is in the DOM and destroy runs before it leaves, both inside
 * the update, so the correction lands in the same frame as the bar.
 */
function holdText(view: EditorView, grew: number): void {
  if (grew) view.scrollDOM.scrollTop += grew;
}

function toggle(label: string, title: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cm-xfind-toggle";
  button.textContent = label;
  button.title = title;
  button.setAttribute("aria-pressed", "false");
  return button;
}

function action(label: string, title: string, className = "cm-xfind-btn"): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.title = title;
  return button;
}

export function createFindPanel(view: EditorView): Panel {
  const dom = document.createElement("div");
  dom.className = "cm-xfind";
  dom.setAttribute("role", "search");

  const findRow = document.createElement("div");
  findRow.className = "cm-xfind-row";
  const mode = action("Find", "Show replace (⌥⌘F)", "cm-xfind-mode");
  const field = document.createElement("label");
  field.className = "cm-xfind-field";
  const input = document.createElement("input");
  input.type = "text";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.placeholder = "Find";
  input.setAttribute("main-field", "true");
  input.setAttribute("aria-label", "Find in file");
  const count = document.createElement("span");
  count.className = "cm-xfind-count";
  field.append(input, count);
  const previous = action("‹", "Previous match (⇧⌘G)", "cm-xfind-step");
  const next = action("›", "Next match (⌘G)", "cm-xfind-step");
  const caseToggle = toggle("Aa", "Match case");
  const wordToggle = toggle("W", "Whole words");
  const regexToggle = toggle(".*", "Regular expression");
  const done = action("Done", "Close (Esc)", "cm-xfind-done");
  findRow.append(mode, field, previous, next, caseToggle, wordToggle, regexToggle, done);

  const replaceRow = document.createElement("div");
  replaceRow.className = "cm-xfind-row cm-xfind-replace";
  const spacer = document.createElement("span");
  spacer.className = "cm-xfind-mode-spacer";
  const replaceField = document.createElement("label");
  replaceField.className = "cm-xfind-field";
  const replaceInput = document.createElement("input");
  replaceInput.type = "text";
  replaceInput.spellcheck = false;
  replaceInput.autocomplete = "off";
  replaceInput.placeholder = "Replace";
  replaceInput.setAttribute("aria-label", "Replace with");
  replaceField.append(replaceInput);
  const replaceOne = action("Replace", "Replace this match and find the next");
  const replaceEvery = action("All", "Replace every match");
  replaceRow.append(spacer, replaceField, replaceOne, replaceEvery);
  dom.append(findRow, replaceRow);

  let query = getSearchQuery(view.state);
  let starts: number[] = [];
  /** Where the caret was when the bar opened. Typing searches from here, not from the last hit. */
  let anchor = view.state.selection.main.from;
  let replacing = replaceRequested;
  replaceRequested = false;

  /** How far the bar pushed the scroller down, so closing it can give the same back. */
  let height = 0;

  function setReplacing(on: boolean): void {
    const before = dom.offsetHeight;
    replacing = on;
    replaceRow.hidden = !on;
    mode.textContent = on ? "Replace" : "Find";
    mode.title = on ? "Hide replace" : "Show replace (⌥⌘F)";
    dom.classList.toggle("is-replacing", on);
    if (!dom.isConnected) return;
    const grew = dom.offsetHeight - before;
    height += grew;
    holdText(view, grew);
  }

  function paintToggles(): void {
    caseToggle.setAttribute("aria-pressed", String(query.caseSensitive));
    wordToggle.setAttribute("aria-pressed", String(query.wholeWord));
    regexToggle.setAttribute("aria-pressed", String(query.regexp));
  }

  /** "3 of 12", "12 matches", "No matches" — and the field goes red on none. */
  function paintCount(): void {
    const empty = !query.search;
    const invalid = !empty && !query.valid;
    field.classList.toggle("is-miss", !empty && (invalid || starts.length === 0));
    if (empty) {
      count.textContent = "";
      return;
    }
    if (invalid) {
      count.textContent = "Bad pattern";
      return;
    }
    if (!starts.length) {
      count.textContent = "No matches";
      return;
    }
    const total = starts.length >= MAX_COUNT ? `${MAX_COUNT}+` : String(starts.length);
    const head = view.state.selection.main;
    let low = 0;
    let high = starts.length - 1;
    let at = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (starts[middle] === head.from) {
        at = middle;
        break;
      }
      if (starts[middle] < head.from) low = middle + 1;
      else high = middle - 1;
    }
    count.textContent = at >= 0 && !head.empty ? `${at + 1} of ${total}` : `${total} ${starts.length === 1 ? "match" : "matches"}`;
  }

  function commit(spec: Partial<{ search: string; caseSensitive: boolean; wholeWord: boolean; regexp: boolean; replace: string }>): void {
    query = new SearchQuery({
      search: spec.search ?? query.search,
      caseSensitive: spec.caseSensitive ?? query.caseSensitive,
      wholeWord: spec.wholeWord ?? query.wholeWord,
      regexp: spec.regexp ?? query.regexp,
      replace: spec.replace ?? query.replace,
    });
    view.dispatch({ effects: setSearchQuery.of(query) });
  }

  /** Land on the first match at or after where the bar opened, wrapping to the top. */
  function seek(): void {
    if (!query.valid || !query.search) return;
    let found = query.getCursor(view.state, anchor).next();
    if (found.done) found = query.getCursor(view.state, 0).next();
    if (found.done) return;
    const { from, to } = found.value;
    view.dispatch({
      selection: EditorSelection.single(from, to),
      effects: EditorView.scrollIntoView(from, { y: "center" }),
      userEvent: "select.search",
    });
  }

  input.addEventListener("input", () => {
    commit({ search: input.value });
    seek();
  });
  replaceInput.addEventListener("input", () => commit({ replace: replaceInput.value }));

  const keys = (event: KeyboardEvent): void => {
    const meta = event.metaKey || event.ctrlKey;
    if (event.key === "Escape") {
      closeSearchPanel(view);
      view.focus();
    } else if (event.key === "Enter" && event.target === input) {
      (event.shiftKey ? findPrevious : findNext)(view);
    } else if (event.key === "Enter" && event.target === replaceInput) {
      ((IS_MAC ? event.metaKey : event.ctrlKey) ? replaceAll : replaceNext)(view);
    } else if (meta && event.key.toLowerCase() === "g") {
      (event.shiftKey ? findPrevious : findNext)(view);
    } else if (meta && event.altKey && event.code === "KeyF") {
      setReplacing(true);
      replaceInput.focus();
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };
  input.addEventListener("keydown", keys);
  replaceInput.addEventListener("keydown", keys);

  mode.addEventListener("click", () => {
    setReplacing(!replacing);
    (replacing ? replaceInput : input).focus();
  });
  previous.addEventListener("click", () => findPrevious(view));
  next.addEventListener("click", () => findNext(view));
  caseToggle.addEventListener("click", () => commit({ caseSensitive: !query.caseSensitive }));
  wordToggle.addEventListener("click", () => commit({ wholeWord: !query.wholeWord }));
  regexToggle.addEventListener("click", () => commit({ regexp: !query.regexp }));
  replaceOne.addEventListener("click", () => replaceNext(view));
  replaceEvery.addEventListener("click", () => replaceAll(view));
  done.addEventListener("click", () => {
    closeSearchPanel(view);
    view.focus();
  });

  function sync(state: EditorState): void {
    query = getSearchQuery(state);
    if (input.value !== query.search) input.value = query.search;
    if (replaceInput.value !== query.replace) replaceInput.value = query.replace;
    starts = matchStarts(state, query);
    paintToggles();
    paintCount();
  }

  setReplacing(replacing);
  sync(view.state);
  mounted.set(view, () => {
    setReplacing(true);
    replaceInput.focus();
    replaceInput.select();
  });

  return {
    dom,
    top: true,
    mount() {
      height = dom.parentElement?.offsetHeight ?? dom.offsetHeight;
      holdText(view, height);
      (replacing && input.value ? replaceInput : input).focus();
      input.select();
    },
    destroy() {
      mounted.delete(view);
      holdText(view, -height);
    },
    update(update: ViewUpdate) {
      const changed = !getSearchQuery(update.state).eq(getSearchQuery(update.startState));
      if (changed || update.docChanged) {
        sync(update.state);
      } else if (update.selectionSet) {
        paintCount();
      }
      // ⌘F again re-seeds from the selection; searching resumes from there.
      if (update.transactions.some((tr) => tr.isUserEvent("select.pointer") || tr.isUserEvent("input"))) {
        anchor = update.state.selection.main.from;
      }
    },
  };
}
