/**
 * Quick open — ⌘⇧O, Xcode's Open Quickly. A host may add chords (the Work tab answers ⌘P too).
 *
 * A pane hands over a list of places worth jumping to and what to do when one is chosen; this
 * owns the overlay, the fuzzy filter, the keyboard, and the shortcut itself. The Work tab
 * offers the files related to the open one. Same panel, same keys, same look — the list differs because
 * the context does, which is the only thing that should.
 *
 * Several can be mounted at once. Each only answers the shortcut while ITS host is on screen,
 * and swallows the event so a hidden sibling never opens a second panel behind the first.
 */

import { fileVisual } from "./file_icons";
import { matchesShortcut } from "../keymap";
import "./quick_open.css";

export type QuickOpenTarget = {
  /** Shown, and handed back on choose. Project-relative for files. */
  path: string;
  /** 1-indexed, when the target is a place inside the file rather than the file. */
  line?: number;
  /** Why this is on the list — the sentence that makes the row worth reading. */
  detail?: string;
  /** What the row prints and filters on, when it is not the path's last segment. */
  name?: string;
  /** Markup for the glyph slot, when the target is not a file. Replaces the file-type icon. */
  icon?: string;
  /** The right-hand tag, when the target is not a file. Replaces the file-type label. */
  label?: string;
  /** The grey line under the name, when the folder is not the answer (a symbol shows its file). */
  where?: string;
  /** Wins ties. Xcode lists a type before a method of the same name. */
  rank?: number;
};

export type QuickOpenList = {
  /** What this particular list IS, in a few words. Shown above the filter. */
  title: string;
  /** Everything the host already knows. The panel paints these in the same frame. */
  targets: QuickOpenTarget[];
  /**
   * The rest, if the host has to fetch it. The panel opens on `targets` immediately and swaps
   * this in when it lands — the human is already typing by then. Never make them wait on a
   * round-trip to see a panel.
   */
  pending?: Promise<QuickOpenTarget[]>;
  /** Shown while the filter is empty, instead of `targets`. Where you were, newest first. */
  recent?: QuickOpenTarget[];
};

export type QuickOpenOptions = {
  /**
   * The pane the overlay covers. Must be positioned. Its visibility is also the gate: the
   * shortcut is ignored while this element is hidden or has no box.
   */
  host: HTMLElement;
  /** Gather the list for this moment. Async — hosts may have to fetch. */
  load(): Promise<QuickOpenList> | QuickOpenList;
  /** The human chose a row. */
  onChoose(target: QuickOpenTarget): void;
  /** Nothing to offer. The host says so in its own voice (a toast, usually). */
  onEmpty?(): void;
  /** Where focus belongs once the panel closes. Usually the editor. */
  restoreFocus?(): void;
  placeholder?: string;
  emptyText?: string;
  /** The chord that opens it. Cmd/Ctrl+Shift+O unless the host says otherwise.
   *  `late` listens in the bubble phase: every pane on screen gets first refusal, and this one
   *  answers only when none of them swallowed the chord — the portfolio picker's place. */
  shortcut?: Shortcut | Shortcut[];
};

type Shortcut = { key: string; shift: boolean; late?: boolean };

/** Rows painted per render. A project list is thousands long; nobody scrolls past this —
 *  they type another letter. */
const MAX_ROWS = 120;

export type QuickOpen = {
  /** Open it now, asking `load` for the list — for a menu item or button, not just the shortcut. */
  open(): Promise<void>;
  /** Open on a list the caller already has (an ambiguous ⌘-click, say). Skips `load`. */
  openWith(list: QuickOpenList): void;
  close(): void;
  destroy(): void;
};

const basename = (path: string): string => path.split("/").pop() || path;

type Match = { score: number; hits: number[] };

/** Where a word starts: the first letter, after `_ - . / space`, or an upper case after a lower. */
function boundary(text: string, index: number): boolean {
  if (index === 0) return true;
  const before = text[index - 1];
  const here = text[index];
  if ("_-./ :".includes(before)) return true;
  return here !== here.toLocaleLowerCase() && before === before.toLocaleLowerCase() && /[a-z0-9]/i.test(before);
}

/** Letters in order, preferring word starts and runs — `fic` finds FindInProjectCard on its humps. */
function subsequence(text: string, lower: string, needle: string, preferStarts: boolean): number[] | null {
  const hits: number[] = [];
  let from = 0;
  for (const character of needle) {
    let found = -1;
    if (preferStarts) {
      const previous = hits[hits.length - 1];
      if (previous !== undefined && lower[previous + 1] === character) found = previous + 1;
      for (let index = from; found < 0 && index < lower.length; index += 1) {
        if (lower[index] === character && boundary(text, index)) found = index;
      }
    }
    if (found < 0) found = lower.indexOf(character, from);
    if (found < 0) return null;
    hits.push(found);
    from = found + 1;
  }
  return hits;
}

function rate(text: string, hits: number[]): number {
  let score = 0;
  hits.forEach((index, at) => {
    score += 1;
    if (boundary(text, index)) score += 8;
    if (at > 0 && hits[at - 1] === index - 1) score += 5;
  });
  return score - Math.min(30, hits[0] ?? 0) - Math.min(20, text.length / 8);
}

/**
 * How well `text` answers the query, with the letters that matched. The order is what a hand
 * would do: the whole name, then a name that starts with it, then one that has it as a word,
 * then anywhere, then its capitals and word starts (`fip` for find_in_project), then any letters
 * in order. Shorter wins ties, because `main.ts` is meant more often than `vendor/x/main.ts`.
 */
function fuzzy(text: string, needle: string): Match | null {
  const lower = text.toLocaleLowerCase();
  const short = Math.min(99, text.length);
  if (lower === needle) return { score: 1000, hits: [...needle].map((_, at) => at) };
  const at = lower.indexOf(needle);
  const run = (start: number): number[] => [...needle].map((_, offset) => start + offset);
  if (at === 0) return { score: 900 - short, hits: run(0) };
  if (at > 0) {
    let word = at;
    while (word >= 0 && !boundary(text, word)) word = lower.indexOf(needle, word + 1);
    if (word > 0) return { score: 750 - short, hits: run(word) };
    return { score: 600 - short - Math.min(50, at), hits: run(at) };
  }
  const humps = subsequence(text, lower, needle, true);
  const plain = subsequence(text, lower, needle, false);
  if (!humps && !plain) return null;
  const first = humps ? rate(text, humps) : -Infinity;
  const second = plain ? rate(text, plain) : -Infinity;
  const hits = first >= second ? humps! : plain!;
  return { score: 300 + Math.max(first, second), hits };
}

/** A row's best answer: its name, or for a file its path, a little behind. */
function score(target: QuickOpenTarget, needle: string): Match | null {
  const name = target.name ?? basename(target.path);
  const byName = fuzzy(name, needle);
  if (byName) return byName;
  if (!target.name || needle.includes("/")) {
    const byPath = fuzzy(target.path, needle);
    if (byPath) return { score: byPath.score - 250, hits: [] };
  }
  if (target.detail?.toLocaleLowerCase().includes(needle)) return { score: 20, hits: [] };
  return null;
}

/** `login.swift:42` — find the file, land on the line. Xcode's Open Quickly reads the same. */
function parseQuery(raw: string): { needle: string; line?: number } {
  const query = raw.trim().toLocaleLowerCase();
  const spot = /^(.+?):(\d+)$/.exec(query);
  return spot ? { needle: spot[1], line: Number(spot[2]) } : { needle: query };
}

/** The name with the matched letters marked, so the eye lands on WHY this row is here. */
function nameNode(name: string, hits: readonly number[]): HTMLElement {
  const node = document.createElement("b");
  if (!hits.length) {
    node.textContent = name;
    return node;
  }
  const hit = new Set(hits);
  let run = "";
  let marking = false;
  const flush = (): void => {
    if (!run) return;
    if (marking) {
      const mark = document.createElement("mark");
      mark.textContent = run;
      node.append(mark);
    } else {
      node.append(run);
    }
    run = "";
  };
  for (let index = 0; index < name.length; index += 1) {
    if (hit.has(index) !== marking) {
      flush();
      marking = !marking;
    }
    run += name[index];
  }
  flush();
  return node;
}

function dirname(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "" : path.slice(0, cut);
}

export function mountQuickOpen(options: QuickOpenOptions): QuickOpen {
  const root = document.createElement("div");
  root.className = "nav-picker";
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");

  const panel = document.createElement("section");
  const title = document.createElement("b");
  title.className = "nav-picker-title";
  const input = document.createElement("input");
  input.className = "nav-picker-input";
  input.type = "search";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = options.placeholder ?? "Filter by file, folder, or relationship";
  const list = document.createElement("div");
  list.className = "nav-picker-list";
  list.setAttribute("role", "listbox");
  const hint = document.createElement("small");
  hint.textContent = "↑↓ choose  ·  return open  ·  esc close";
  panel.append(title, input, list, hint);
  root.append(panel);
  options.host.append(root);

  let targets: QuickOpenTarget[] = [];
  let recent: QuickOpenTarget[] = [];
  let visible: QuickOpenTarget[] = [];
  let marks = new Map<QuickOpenTarget, number[]>();
  /** The `:42` typed after a name, applied to whichever row is chosen. */
  let typedLine: number | undefined;
  let index = 0;
  /** Bumped on every open and close, so a slow fetch can tell it has been outlived. */
  let generation = 0;
  let awaiting = false;

  function close(): void {
    generation += 1;
    awaiting = false;
    root.hidden = true;
    targets = [];
    recent = [];
    visible = [];
    marks = new Map();
    input.value = "";
    options.restoreFocus?.();
  }

  function choose(target: QuickOpenTarget): void {
    const line = typedLine;
    close();
    options.onChoose(line ? { ...target, line } : target);
  }

  function render(): void {
    const { needle: query, line: wanted } = parseQuery(input.value);
    typedLine = wanted;
    marks = new Map();
    if (query) {
      const rows: { target: QuickOpenTarget; at: number; score: number }[] = [];
      targets.forEach((target, at) => {
        const match = score(target, query);
        if (!match) return;
        rows.push({ target, at, score: match.score + (target.rank ?? 0) });
        marks.set(target, match.hits);
      });
      rows.sort((a, b) => b.score - a.score || a.at - b.at);
      visible = rows.map((row) => row.target);
    } else {
      visible = recent.length ? recent : targets;
    }
    index = Math.max(0, Math.min(index, visible.length - 1, MAX_ROWS - 1));
    const frag = document.createDocumentFragment();
    visible.slice(0, MAX_ROWS).forEach((target, position) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "nav-picker-row";
      row.classList.toggle("is-selected", position === index);
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(position === index));

      const identity = fileVisual({ name: basename(target.path) });
      const icon = document.createElement("span");
      icon.className = target.icon ? "qo-icon" : `ft-glyph ${identity.className}`;
      icon.innerHTML = target.icon ?? identity.svg;
      const body = document.createElement("span");
      const name = nameNode(target.name ?? basename(target.path), marks.get(target) ?? []);
      const detail = document.createElement("small");
      detail.textContent = `${target.where ?? dirname(target.path)}${target.detail ? ` · ${target.detail}` : ""}`;
      body.append(name, detail);
      const line = document.createElement("i");
      line.textContent = typedLine ? `:${typedLine}` : target.line ? `:${target.line}` : (target.label ?? identity.label);
      row.append(icon, body, line);
      row.addEventListener("mouseenter", () => {
        if (index !== position) {
          index = position;
          render();
        }
      });
      row.addEventListener("click", () => choose(target));
      frag.append(row);
    });
    if (!visible.length) {
      const none = document.createElement("p");
      none.className = "nav-picker-empty";
      /* Mid-fetch there is nothing to report yet — saying "no matches" would be a lie that
         corrects itself a moment later, which reads as a bug. */
      none.textContent = awaiting ? "Looking…" : (options.emptyText ?? "Nothing matches.");
      frag.append(none);
    }
    list.replaceChildren(frag);
    list.querySelector(".is-selected")?.scrollIntoView({ block: "nearest" });
  }

  function openWith(next: QuickOpenList): void {
    if (!next.targets.length && !next.pending) {
      options.onEmpty?.();
      return;
    }
    const mine = ++generation;
    targets = next.targets;
    recent = next.recent ?? [];
    awaiting = !!next.pending;
    index = 0;
    title.textContent = next.title;
    input.value = "";
    root.hidden = false;
    render();
    requestAnimationFrame(() => input.focus());

    /* The rest arrives late. Keep whatever they have typed and whatever row they had landed
       on — a list that reshuffles under the cursor is worse than one that arrives slowly. */
    void next.pending?.then((arrived) => {
      if (mine !== generation) return;
      const held = visible[index]?.path;
      targets = arrived;
      awaiting = false;
      render();
      const restored = visible.findIndex((target) => target.path === held);
      if (restored > 0) {
        index = restored;
        render();
      }
      if (!targets.length) {
        close();
        options.onEmpty?.();
      }
    }).catch(() => {
      if (mine !== generation) return;
      awaiting = false;
      render();
    });
  }

  const open = async (): Promise<void> => openWith(await options.load());

  input.addEventListener("input", () => {
    index = 0;
    render();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      index = Math.max(
        0,
        Math.min(visible.length - 1, MAX_ROWS - 1, index + (event.key === "ArrowDown" ? 1 : -1)),
      );
      render();
    } else if (event.key === "Enter") {
      const target = visible[index];
      if (target) choose(target);
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  });
  root.addEventListener("mousedown", (event) => {
    if (event.target === root) close();
  });

  const chords = [options.shortcut ?? { key: "o", shift: true }].flat();
  const late = chords.some((chord) => chord.late);
  const onShortcut = (event: KeyboardEvent): void => {
    if (
      !chords.some((chord) =>
        matchesShortcut(event, `Meta+${chord.shift ? "Shift+" : ""}Key${chord.key.toUpperCase()}`),
      ) ||
      event.repeat ||
      options.host.closest("[hidden]") ||
      options.host.getClientRects().length === 0
    ) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void open();
  };
  window.addEventListener("keydown", onShortcut, !late);

  return {
    open,
    openWith,
    close,
    destroy() {
      window.removeEventListener("keydown", onShortcut, !late);
      root.remove();
    },
  };
}
