/**
 * Find in project — ⌘⇧F.
 *
 * A drawer under the buffer, not an overlay. Quick open is a jump: you name a place and it
 * disappears. Search is a READING task — you walk a list of hits, open one, decide it was wrong,
 * and come back. A centred panel over the editor would hide the very file you just opened, so
 * this takes the bottom of the pane and leaves the buffer on screen above it.
 *
 * The matching is plain text, done in Rust over the same walker the navigator uses (`code_nav`).
 * Not a regex engine: Panel opens arbitrary repositories cold, and a query that silently means
 * something else because of a stray `.` or `(` is worse than one that only ever means itself.
 * Case and whole-word are the two toggles that actually change an answer.
 *
 * Like quick open, several may be mounted. Each answers the shortcut only while its own host is
 * on screen, and swallows the event so a hidden sibling never opens behind the visible one.
 */

import { invoke } from "@tauri-apps/api/core";
import { fileVisual } from "./file_icons";
import { matchesShortcut } from "../keymap";
import "./find_in_project.css";

type SearchHit = {
  path: string;
  line: number;
  /** 1-indexed CHAR offset into `text`. */
  column: number;
  text: string;
  length: number;
};

type SearchResult = {
  hits: SearchHit[];
  files: number;
  truncated: boolean;
};

export type FindInProjectOptions = {
  /** The pane the drawer is appended to. Its visibility gates the shortcut. */
  host: HTMLElement;
  /** The project to search, or null when none is selected. Read at query time, never cached. */
  project(): string | null;
  /** A hit was chosen. */
  onChoose(path: string, line: number): void;
  /** Text worth seeding the field with — the editor's selection, usually. */
  seed?(): string;
  /** Where focus belongs once the drawer closes. */
  restoreFocus?(): void;
};

export type FindInProject = {
  open(): void;
  close(): void;
  /** Project changed: any result on screen belongs to a tree that is no longer open. */
  reset(): void;
  destroy(): void;
};

/** Long enough that the first keystroke does not walk six thousand files. */
const MIN_QUERY = 2;
const DEBOUNCE_MS = 180;

const basename = (path: string): string => path.split("/").pop() || path;

function dirname(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "" : path.slice(0, cut + 1);
}

export function mountFindInProject(options: FindInProjectOptions): FindInProject {
  const root = document.createElement("section");
  root.className = "fip";
  root.hidden = true;
  root.setAttribute("aria-label", "Find in project");

  const head = document.createElement("header");
  head.className = "fip-head";

  const input = document.createElement("input");
  input.className = "fip-input";
  input.type = "search";
  input.spellcheck = false;
  input.autocapitalize = "off";
  input.setAttribute("autocorrect", "off");
  input.placeholder = "Find in project";

  const toggles = document.createElement("div");
  toggles.className = "fip-toggles";
  const caseToggle = document.createElement("button");
  caseToggle.type = "button";
  caseToggle.className = "fip-toggle";
  caseToggle.textContent = "Aa";
  caseToggle.title = "Match case";
  caseToggle.setAttribute("aria-label", "Match case");
  const wordToggle = document.createElement("button");
  wordToggle.type = "button";
  wordToggle.className = "fip-toggle";
  wordToggle.textContent = "ab";
  wordToggle.title = "Whole word";
  wordToggle.setAttribute("aria-label", "Whole word");
  toggles.append(caseToggle, wordToggle);

  const summary = document.createElement("span");
  summary.className = "fip-summary";

  const close = document.createElement("button");
  close.type = "button";
  close.className = "fip-close";
  close.textContent = "×";
  close.setAttribute("aria-label", "Close search");

  head.append(input, toggles, summary, close);

  const list = document.createElement("div");
  list.className = "fip-list";
  list.setAttribute("role", "listbox");

  root.append(head, list);
  options.host.append(root);

  let hits: SearchHit[] = [];
  let index = 0;
  let caseSensitive = false;
  let wholeWord = false;
  let timer = 0;
  /** Only the newest query may paint. A slow answer must never overwrite a fast later one. */
  let generation = 0;
  let searching = false;

  function paintSummary(result: SearchResult | null, note = ""): void {
    if (note) {
      summary.textContent = note;
      return;
    }
    if (!result) {
      summary.textContent = "";
      return;
    }
    if (!result.hits.length) {
      summary.textContent = "No results";
      return;
    }
    const matches = `${result.hits.length} ${result.hits.length === 1 ? "result" : "results"}`;
    const files = `${result.files} ${result.files === 1 ? "file" : "files"}`;
    summary.textContent = result.truncated
      ? `${matches} in ${files} — capped, narrow the search`
      : `${matches} in ${files}`;
  }

  /** One row per hit, grouped under the file that owns them. */
  function render(): void {
    const frag = document.createDocumentFragment();
    let group = "";

    hits.forEach((hit, position) => {
      if (hit.path !== group) {
        group = hit.path;
        const identity = fileVisual({ name: basename(hit.path) });
        const header = document.createElement("div");
        header.className = "fip-file";

        const glyph = document.createElement("span");
        glyph.className = `ft-glyph ${identity.className}`;
        glyph.setAttribute("aria-hidden", "true");
        glyph.innerHTML = identity.svg;

        const name = document.createElement("b");
        name.className = "fip-file-name";
        name.textContent = basename(hit.path);

        const dir = document.createElement("span");
        dir.className = "fip-file-dir";
        dir.textContent = dirname(hit.path);

        const count = document.createElement("small");
        count.className = "fip-file-count";
        count.textContent = String(hits.filter((other) => other.path === hit.path).length);

        header.append(glyph, name, dir, count);
        frag.append(header);
      }

      const row = document.createElement("button");
      row.type = "button";
      row.className = "fip-hit";
      row.setAttribute("role", "option");
      row.dataset.position = String(position);
      row.classList.toggle("is-selected", position === index);
      row.setAttribute("aria-selected", String(position === index));

      const number = document.createElement("span");
      number.className = "fip-line";
      number.textContent = String(hit.line);

      // Built as nodes, never innerHTML: this is repository content, and one file with a
      // `<script>` in it must not be able to reach the panel that found it.
      const text = document.createElement("span");
      text.className = "fip-text";
      const chars = [...hit.text];
      const from = Math.max(0, hit.column - 1);
      const to = Math.min(chars.length, from + hit.length);
      text.append(document.createTextNode(chars.slice(0, from).join("")));
      const mark = document.createElement("mark");
      mark.textContent = chars.slice(from, to).join("");
      text.append(mark, document.createTextNode(chars.slice(to).join("")));

      row.append(number, text);
      row.addEventListener("click", () => {
        index = position;
        render();
        choose();
      });
      frag.append(row);
    });

    list.replaceChildren(frag);
  }

  function select(next: number): void {
    if (!hits.length) return;
    index = Math.max(0, Math.min(hits.length - 1, next));
    render();
    list
      .querySelector<HTMLElement>(`.fip-hit[data-position="${index}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }

  function choose(): void {
    const hit = hits[index];
    if (hit) options.onChoose(hit.path, hit.line);
  }

  function run(): void {
    const query = input.value.trim();
    const project = options.project();
    const mine = ++generation;

    if (!project || query.length < MIN_QUERY) {
      hits = [];
      index = 0;
      render();
      paintSummary(null, query.length ? `Type ${MIN_QUERY} characters` : "");
      root.classList.remove("is-busy");
      return;
    }

    searching = true;
    root.classList.add("is-busy");
    void invoke<SearchResult>("search_project", {
      project,
      query,
      caseSensitive,
      wholeWord,
    })
      .then((result) => {
        if (mine !== generation) return; // a later query already answered
        searching = false;
        root.classList.remove("is-busy");
        hits = result.hits;
        index = 0;
        render();
        paintSummary(result);
      })
      .catch((error: unknown) => {
        if (mine !== generation) return;
        searching = false;
        root.classList.remove("is-busy");
        hits = [];
        render();
        paintSummary(null, typeof error === "string" ? error : "Search failed");
      });
  }

  function schedule(): void {
    window.clearTimeout(timer);
    timer = window.setTimeout(run, DEBOUNCE_MS);
  }

  input.addEventListener("input", schedule);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hide();
    } else if (event.key === "ArrowDown") {
      select(index + 1);
    } else if (event.key === "ArrowUp") {
      select(index - 1);
    } else if (event.key === "Enter") {
      if (searching || !hits.length) return;
      // Shift+Enter steps back a hit first, the find-bar convention everywhere.
      if (event.shiftKey) select(index - 1);
      choose();
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  });

  const flip = (button: HTMLElement, next: boolean): boolean => {
    button.classList.toggle("is-on", next);
    button.setAttribute("aria-pressed", String(next));
    return next;
  };
  flip(caseToggle, false);
  flip(wordToggle, false);
  caseToggle.addEventListener("click", () => {
    caseSensitive = flip(caseToggle, !caseSensitive);
    run();
    input.focus();
  });
  wordToggle.addEventListener("click", () => {
    wholeWord = flip(wordToggle, !wholeWord);
    run();
    input.focus();
  });
  close.addEventListener("click", () => hide());

  function hide(): void {
    if (root.hidden) return;
    window.clearTimeout(timer);
    generation += 1;
    root.hidden = true;
    options.restoreFocus?.();
  }

  function show(): void {
    const seed = options.seed?.().trim() ?? "";
    // A one-line selection is what you meant to search. A paragraph is not, and pasting it in
    // would throw away the query already in the field.
    if (seed && !seed.includes("\n") && seed.length <= 120) input.value = seed;
    root.hidden = false;
    input.focus();
    input.select();
    if (input.value.trim().length >= MIN_QUERY) run();
  }

  const onShortcut = (event: KeyboardEvent): void => {
    if (
      !matchesShortcut(event, "Meta+Shift+KeyF") ||
      event.repeat ||
      options.host.closest("[hidden]") ||
      options.host.getClientRects().length === 0
    ) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (root.hidden) show();
    else hide();
  };
  window.addEventListener("keydown", onShortcut, true);

  return {
    open: show,
    close: hide,
    reset(): void {
      window.clearTimeout(timer);
      generation += 1;
      hits = [];
      index = 0;
      input.value = "";
      list.replaceChildren();
      paintSummary(null);
      root.hidden = true;
    },
    destroy(): void {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onShortcut, true);
      root.remove();
    },
  };
}
