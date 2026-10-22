/**
 * Review: what the agents made. Pictures, sounds and videos that appeared in a project while a
 * session was open there, collected in one place so reviewing them is not a trip through Finder.
 *
 * Rust watches each project with an open session and sends `panel-made` once a file has
 * settled (see made.rs). Files land in batches: whatever one project produced within a few
 * minutes of itself is one piece of work, and is reviewed, revealed or dismissed as one.
 *
 * Nobody approves anything: what you look at and leave alone is fine. The one verdict is a
 * change, with a note, and what you sent back is remembered so the redo can stand next to it.
 *
 * The queue is kept in localStorage: it is this window's to-do list. A file that disappears from
 * disk leaves it the next time Review opens.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { projectAssetUrl } from "../project-assets";
import { openReviewDeck, type DeckEnd, type DeckItem } from "./review_deck";
import { beforeKey, keepBefore, pruneBefore, readBefore } from "./review_store";
import "./review.css";

type Kind = "image" | "audio" | "video";

type Made = {
  project: string;
  path: string;
  kind: Kind;
  size: number;
  modified: number;
};

/** A change you sent to an agent, on the version of the file it was about. */
type Request = { note: string; modified: number; at: number };

/**
 * `at` is when Panel heard of it. A file's own mtime can be days old: a download, an unzip, a copy.
 * `note` is a change you wrote on this version; `before` is the request this version answers.
 */
type Item = Made & { seen: boolean; at: number; note?: string; before?: Request };

export type ReviewEvents = {
  projectName(id: string): string;
  projectPath(id: string): string | null;
  openProject(id: string): void;
  /** Batches with something unseen: a batch is one piece of work, however many files it wrote. */
  onCount(unseen: number): void;
  /** The same, per project, for the sidebar rows. */
  onProjects(counts: Map<string, number>): void;
  /** The agent a review's feedback goes to, by display name, or null when none is open. */
  agentName(project: string): string | null;
  /** Type the feedback into that agent's prompt and submit it. */
  send(project: string, text: string): Promise<boolean>;
  /** True while the Review screen or another full-screen surface makes a peek pointless. */
  busy(): boolean;
};

export type ReviewHandle = {
  /** Go straight into a project's oldest unseen batch, else its newest. False when it has nothing. */
  openProject(project: string): boolean;
  open(): void;
  clear(): void;
};

const STORE = "panel-review";
const ASKED = "panel-review-asked";
/** Seen files kept for looking back. Unseen files and written notes are never what gets cut. */
const CAP = 400;
const HARD_CAP = 2000;
/** A request nobody answered in two weeks is not coming back. */
const ASKED_FOR = 14 * 24 * 60 * 60_000;
/** Files from one project this close together are one batch of work: a sitting, not a single render. */
const BATCH_GAP = 30 * 60_000;
/** Tiles a batch shows before the rest fold into one "+N more" tile. Twelve fills 2, 3, 4 or 6 columns. */
const SHOWN = 12;
/** A folder that wrote this many files in one batch is a pipeline step: one tile for all of it. */
const FOLD = 8;

const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

const fileName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** The version in the URL: the protocol ignores it, the webview's cache does not, so a re-render shows. */
const src = (item: Made): string => `${projectAssetUrl(item.project, item.path)}?v=${item.modified}`;

/** Names the way Finder sorts them: shot_2 before shot_10. */
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const KINDS: { kind: Kind; label: string }[] = [
  { kind: "image", label: "Images" },
  { kind: "audio", label: "Sounds" },
  { kind: "video", label: "Videos" },
];

function ago(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(at).toLocaleDateString();
}

function count(items: Item[]): string {
  const of = (kind: Kind, one: string, many: string): string => {
    const n = items.filter((item) => item.kind === kind).length;
    return n ? `${n} ${n === 1 ? one : many}` : "";
  };
  return [of("image", "image", "images"), of("audio", "sound", "sounds"), of("video", "video", "videos")]
    .filter(Boolean)
    .join(" · ");
}

function load(): Map<string, Item> {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? "[]") as Item[];
    return new Map(saved.map((item) => [item.path, { ...item, at: item.at ?? item.modified }]));
  } catch {
    return new Map();
  }
}

function loadAsked(): Map<string, Request> {
  try {
    const saved = JSON.parse(localStorage.getItem(ASKED) ?? "[]") as [string, Request][];
    return new Map(saved.filter(([, request]) => Date.now() - request.at < ASKED_FOR));
  } catch {
    return new Map();
  }
}

export function mountReview(screen: HTMLElement, events: ReviewEvents): ReviewHandle {
  const items = load();
  /** Changes sent, by path, waiting for the agent to write that file again. */
  const asked = loadAsked();
  let openState = false;
  /** Unseen when this visit began, or arrived during it: marked and on top until reviewed or left. */
  const fresh = new Set<string>();
  const isNew = (item: Item): boolean => !item.seen || fresh.has(item.path);
  /** What Mark reviewed has taken out in the last few seconds, kept for one Undo. */
  let undo: { items: Item[]; timer: number } | null = null;
  /** The Review screen's narrowing, for this run. Empty is everything. */
  const filter: { project: string; kind: Kind | "" } = { project: "", kind: "" };
  /** The batches as last painted, and the one the keyboard is on. */
  let shown: Item[][] = [];
  let focus = 0;
  let checking = false;

  const save = (): void => {
    const sorted = [...items.values()].sort((a, b) => b.at - a.at);
    const keep = sorted.filter((item, at) => at < CAP || !item.seen || item.note !== undefined).slice(0, HARD_CAP);
    items.clear();
    for (const item of keep) items.set(item.path, item);
    try {
      localStorage.setItem(STORE, JSON.stringify(keep));
      localStorage.setItem(ASKED, JSON.stringify([...asked]));
    } catch {
      // Storage full or blocked: the queue still works for this run.
    }
  };

  /** Old versions still worth having: a note not yet sent, a request not yet answered, a redo on show. */
  const keptVersions = (): Set<string> => {
    const keep = new Set<string>();
    for (const item of [...items.values(), ...(undo?.items ?? [])]) {
      if (item.note !== undefined) keep.add(beforeKey(item.path, item.modified));
      if (item.before) keep.add(beforeKey(item.path, item.before.modified));
    }
    for (const [path, request] of asked) keep.add(beforeKey(path, request.modified));
    return keep;
  };

  // Above announce(): it runs during mount, and a saved queue reaches folderOf through batches().
  const relative = (item: Item): string => {
    const root = events.projectPath(item.project);
    return root && item.path.startsWith(`${root}/`) ? item.path.slice(root.length + 1) : item.path;
  };
  const folderOf = (item: Item): string => relative(item).split("/").slice(0, -1).join("/") || ".";

  const announce = (): void => {
    const waiting = batches().filter((batch) => batch.some((item) => !item.seen));
    events.onCount(waiting.length);
    const counts = new Map<string, number>();
    for (const batch of waiting) counts.set(batch[0].project, (counts.get(batch[0].project) ?? 0) + 1);
    events.onProjects(counts);
  };

  void listen<Made>("panel-made", ({ payload }) => {
    // A re-render of the same file is news again: it moves up and is unseen. If you had sent it
    // back, the new version carries what you asked, so it can be held up against the old one.
    const request = asked.get(payload.path);
    const answers = request && request.modified !== payload.modified ? request : undefined;
    if (answers) asked.delete(payload.path);
    const before = answers ?? items.get(payload.path)?.before;
    items.set(payload.path, { ...payload, seen: openState, at: Date.now(), ...(before ? { before } : {}) });
    // Arriving while you look: it is seen, and still marked new for this visit.
    if (openState) fresh.add(payload.path);
    save();
    announce();
    if (openState) paint();
    else peek(payload.project);
  });
  announce();
  void pruneBefore(keptVersions());

  /**
   * A batch in the order it is shown and reviewed: folder by folder, in the order each folder
   * first wrote, and by name inside a folder. Renders and takes finish out of order when made in
   * parallel, so 01, 02, 03 is the order the agent meant, not the order the files landed.
   */
  function inOrder(newestFirst: Item[]): Item[] {
    const rank = new Map<string, number>();
    for (let at = newestFirst.length - 1; at >= 0; at--) {
      const folder = folderOf(newestFirst[at]);
      if (!rank.has(folder)) rank.set(folder, rank.size);
    }
    return newestFirst.sort(
      (a, b) => rank.get(folderOf(a))! - rank.get(folderOf(b))! || byName.compare(fileName(a.path), fileName(b.path)),
    );
  }

  /** Newest batch first. Time decides where a batch ends; inOrder decides the order inside it. */
  function batches(): Item[][] {
    const sorted = [...items.values()].sort((a, b) => b.at - a.at);
    const out: Item[][] = [];
    const current = new Map<string, Item[]>();
    for (const item of sorted) {
      const batch = current.get(item.project);
      // A new file is a new entry: it never folds into a batch that was already looked at.
      if (batch && isNew(batch[0]) === isNew(item) && batch[batch.length - 1].at - item.at <= BATCH_GAP) {
        batch.push(item);
        continue;
      }
      const fresh = [item];
      current.set(item.project, fresh);
      out.push(fresh);
    }
    return out.map(inOrder);
  }

  function dismiss(batch: Item[]): void {
    // Only what was looked at: a file re-rendered meanwhile is a new item under the same path.
    batch = batch.filter((item) => items.get(item.path) === item);
    if (!batch.length) return;
    for (const item of batch) items.delete(item.path);
    // A second Done inside the window joins the first, so Undo brings back both.
    if (undo) window.clearTimeout(undo.timer);
    undo = {
      items: [...(undo?.items ?? []), ...batch],
      timer: window.setTimeout(() => {
        undo = null;
        void pruneBefore(keptVersions());
        paint();
      }, 8000),
    };
    save();
    announce();
    paint();
  }

  function restore(): void {
    if (!undo) return;
    window.clearTimeout(undo.timer);
    for (const item of undo.items) if (!items.has(item.path)) items.set(item.path, item);
    undo = null;
    save();
    announce();
    paint();
  }

  /** Files no longer on disk leave quietly. A check that cannot reach the file keeps it. */
  async function pruneMissing(): Promise<void> {
    if (checking) return;
    checking = true;
    const all = [...items.values()];
    const gone: Item[] = [];
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < all.length) {
        const item = all[next++];
        try {
          if ((await fetch(src(item), { method: "HEAD", cache: "no-store" })).status === 404) gone.push(item);
        } catch {
          // Unreachable is not gone.
        }
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    checking = false;
    const left = gone.filter((item) => items.get(item.path) === item);
    if (!left.length) return;
    for (const item of left) items.delete(item.path);
    save();
    announce();
    paint();
  }

  /** Where the work that just arrived sits in a batch's order. */
  const newestAt = (batch: Item[]): number => {
    let best = 0;
    batch.forEach((item, at) => {
      if (item.at > batch[best].at) best = at;
    });
    return best;
  };

  /** The batch as the deck sees it, and a review of it from any item. */
  function review(batch: Item[], at = 0): void {
    const project = batch[0].project;
    const urls: string[] = [];
    const deckItems: DeckItem[] = batch.map((item) => ({
      project: item.project,
      path: item.path,
      src: src(item),
      label: relative(item),
      kind: item.kind,
      ...(item.before
        ? {
            before: {
              note: item.before.note,
              src: readBefore(beforeKey(item.path, item.before.modified)).then((blob) => {
                if (!blob) return null;
                const url = URL.createObjectURL(blob);
                urls.push(url);
                return url;
              }),
            },
          }
        : {}),
    }));
    for (const item of batch) {
      item.seen = true;
      fresh.delete(item.path);
    }
    save();
    announce();
    hidePeek(project);
    const notes = new Map<string, string>();
    for (const item of batch) if (item.note !== undefined) notes.set(item.path, item.note);
    openReviewDeck(deckItems, at, {
      title: `${events.projectName(project)} · ${count(batch)}`,
      agentName: events.agentName(project),
      notes,
      onNote(path, note) {
        const item = batch.find((candidate) => candidate.path === path);
        if (!item) return;
        const first = item.note === undefined;
        if (note === null) delete item.note;
        else item.note = note;
        save();
        // The agent will write over this file: copy it now, while it is still the one you saw.
        if (note !== null && first) void keepBefore(beforeKey(item.path, item.modified), src(item));
      },
      send: (text) => events.send(project, text),
      copy: async (text) => {
        try {
          await navigator.clipboard.writeText(text);
          return true;
        } catch {
          return false;
        }
      },
      onClose(end: DeckEnd) {
        for (const url of urls) URL.revokeObjectURL(url);
        if (end === "sent") {
          for (const item of batch) {
            if (item.note !== undefined) asked.set(item.path, { note: item.note, modified: item.modified, at: Date.now() });
          }
        }
        // Walked to the end is reviewed. Left part way, it stays, notes and all.
        if (end === "left") paint();
        else dismiss(batch);
      },
    });
  }

  function tile(item: Item, batch: Item[], at: number): HTMLElement {
    const node = make("button", `rv-shot is-${item.kind}`);
    node.type = "button";
    node.title = relative(item);
    if (item.kind === "image") {
      const image = make("img");
      image.src = src(item);
      image.alt = "";
      image.loading = "lazy";
      image.decoding = "async";
      image.addEventListener("error", () => node.classList.add("is-missing"), { once: true });
      node.append(image);
    } else {
      node.append(make("span", "rv-glyph", item.kind === "audio" ? "♪" : "▶"));
    }
    node.append(make("span", "rv-name", fileName(item.path)));
    marks(node, [item]);
    node.addEventListener("click", () => review(batch, at));
    return node;
  }

  /** A note you wrote, or a redo of one: a corner chip, the words on hover. */
  function marks(node: HTMLElement, group: Item[]): void {
    const noted = group.filter((item) => item.note !== undefined);
    const redone = group.filter((item) => item.before);
    if (noted.length) {
      const chip = make("span", "rv-chip is-change", noted.length > 1 ? `✎ ${noted.length}` : "✎");
      chip.title = noted.map((item) => item.note || "needs changes").join("\n");
      node.append(chip);
    } else if (redone.length) {
      const chip = make("span", "rv-chip is-redo", "redo");
      chip.title = redone.map((item) => `You asked: ${item.before!.note || "changes"}`).join("\n");
      node.append(chip);
    }
  }

  /** A batch by folder. The batch is already folder by folder, so this keeps its order. */
  function folderGroups(batch: Item[]): { folder: string; items: Item[] }[] {
    const groups = new Map<string, Item[]>();
    for (const item of batch) {
      const folder = folderOf(item);
      groups.set(folder, [...(groups.get(folder) ?? []), item]);
    }
    return [...groups].map(([folder, items]) => ({ folder, items }));
  }

  /** A whole folder as one tile: its last picture, or a sound or video glyph, and the count. */
  function folded(group: { folder: string; items: Item[] }, batch: Item[], start: number): HTMLElement {
    const node = make("button", "rv-shot is-folder");
    node.type = "button";
    node.title = `${group.folder} · ${count(group.items)}`;
    const cover = [...group.items].reverse().find((item) => item.kind === "image");
    if (cover) {
      const image = make("img");
      image.src = src(cover);
      image.alt = "";
      image.loading = "lazy";
      image.decoding = "async";
      node.append(image);
    } else {
      node.append(make("span", "rv-glyph", group.items[0].kind === "audio" ? "♪" : "▶"));
    }
    node.append(
      make("span", "rv-stack", String(group.items.length)),
      make("span", "rv-name", `${fileName(group.folder)}/ · ${count(group.items)}`),
    );
    marks(node, group.items);
    node.addEventListener("click", () => review(batch, start));
    return node;
  }

  function card(batch: Item[], at: number): HTMLElement {
    const project = batch[0].project;
    const box = make("article", "rv-batch");
    if (batch.some(isNew)) box.classList.add("is-new");
    box.classList.toggle("is-focus", at === focus);
    box.addEventListener("pointerdown", () => {
      focus = at;
      for (const [index, node] of [...screen.querySelectorAll(".rv-batch")].entries()) node.classList.toggle("is-focus", index === at);
    });
    const head = make("header", "rv-head");
    const title = make("div", "rv-title");
    const noted = batch.filter((item) => item.note !== undefined).length;
    const redone = batch.filter((item) => item.before).length;
    title.append(
      make("b", "", events.projectName(project)),
      make(
        "span",
        "",
        [
          count(batch),
          ago(Math.max(...batch.map((item) => item.at))),
          noted ? `${noted} to change, not sent` : "",
          redone ? `${redone} redone` : "",
        ]
          .filter(Boolean)
          .join(" · "),
      ),
    );
    const groups = folderGroups(batch);
    title.append(make("code", "rv-where", groups.length === 1 ? groups[0].folder : `${groups.length} folders`));
    const actions = make("div", "rv-actions");
    const button = (label: string, hint: string, run: () => void, className = "rv-btn"): void => {
      const node = make("button", className, label);
      node.type = "button";
      node.title = hint;
      node.addEventListener("click", run);
      actions.append(node);
    };
    button("Finder", "Show in Finder", () => reveal(batch), "rv-btn is-quiet");
    button("Done", "Mark reviewed without going through it · D", () => dismiss(batch), "rv-btn is-quiet");
    button("Review", "Go through it one by one · Enter · C needs changes", () => review(batch), "rv-btn is-primary");
    head.append(title, actions);
    const grid = make("div", "rv-grid");
    // The deck walks the batch in the order the tiles show it, so a folded folder is one stretch.
    const tiles: { start: number; node: HTMLElement }[] = [];
    for (const group of groups) {
      const start = batch.indexOf(group.items[0]);
      if (group.items.length >= FOLD) tiles.push({ start, node: folded(group, batch, start) });
      else group.items.forEach((item, at) => tiles.push({ start: start + at, node: tile(item, batch, start + at) }));
    }
    const visible = tiles.length > SHOWN ? SHOWN - 1 : tiles.length;
    grid.append(...tiles.slice(0, visible).map(({ node }) => node));
    if (visible < tiles.length) {
      const from = tiles[visible].start;
      const more = make("button", "rv-shot is-more");
      more.type = "button";
      more.title = "Review from here";
      more.append(make("span", "rv-glyph", `+${batch.length - from}`), make("span", "rv-name", "more in this batch"));
      more.addEventListener("click", () => review(batch, from));
      grid.append(more);
    }
    box.append(head, grid);
    return box;
  }

  function reveal(batch: Item[]): void {
    void invoke("reveal_entry", { project: batch[0].project, path: relative(batch[batch.length - 1]) }).catch(() => undefined);
  }

  /* ------------------------------------------------------------------ peek */

  /** One card per project, stacked in the corner. A new batch never replaces another project's card. */
  const peeks = new Map<string, { node: HTMLElement; timer: number }>();
  const MAX_PEEKS = 4;
  let peekStack: HTMLElement | null = null;

  function hidePeek(project?: string): void {
    for (const [id, peekCard] of [...peeks]) {
      if (project !== undefined && id !== project) continue;
      window.clearTimeout(peekCard.timer);
      peekCard.node.classList.add("is-leaving");
      window.setTimeout(() => peekCard.node.remove(), 180);
      peeks.delete(id);
    }
  }

  /**
   * New work, brought to you: a small card in the corner with the pictures themselves. Each
   * project gets its own card and each card opens its own batch. × or a card left alone just
   * hides it; the batch keeps waiting in Review, unseen.
   */
  function peek(project: string): void {
    if (events.busy()) return;
    const batch = batches().find((candidate) => candidate[0].project === project);
    if (!batch) return;
    const existing = peeks.get(project);
    if (existing) window.clearTimeout(existing.timer);
    const card = existing?.node ?? make("aside", "rv-peek");
    card.setAttribute("role", "status");
    card.classList.remove("is-leaving");
    // Whatever is tapped opens: a face opens that file, anywhere else opens the newest file.
    const reviewFrom = (path?: string): void => {
      const latest = batches().find((candidate) => candidate[0].project === project);
      if (!latest) return hidePeek(project);
      const found = latest.findIndex((item) => item.path === path);
      review(latest, found >= 0 ? found : newestAt(latest));
    };
    const faces = make("div", "rv-peek-faces");
    // The newest three, the ones that made this card appear.
    for (const item of [...batch].sort((a, b) => a.at - b.at).slice(-3)) {
      const face = make("button", `rv-peek-face is-${item.kind}`);
      face.type = "button";
      face.title = relative(item);
      if (item.kind === "image") {
        const image = make("img");
        image.src = src(item);
        image.alt = "";
        face.append(image);
      } else {
        face.textContent = item.kind === "audio" ? "♪" : "▶";
      }
      face.addEventListener("click", (event) => {
        event.stopPropagation();
        reviewFrom(item.path);
      });
      faces.append(face);
    }
    const text = make("div", "rv-peek-text");
    const redo = batch.some((item) => item.before);
    text.append(make("b", "", events.projectName(project)), make("span", "", `${redo ? "redid" : "made"} ${count(batch)}`));
    const open = make("button", "rv-btn is-primary", "Review");
    open.type = "button";
    card.onclick = () => reviewFrom();
    const done = make("button", "rv-peek-close", "×");
    done.type = "button";
    done.setAttribute("aria-label", "Hide, keep in Review");
    done.title = "Hide — it stays in Review";
    done.addEventListener("click", (event) => {
      event.stopPropagation();
      hidePeek(project);
    });
    card.replaceChildren(faces, text, open, done);
    const arm = (): number => window.setTimeout(() => hidePeek(project), 9000);
    if (!existing) {
      if (!peekStack) {
        peekStack = make("div", "rv-peeks");
        document.body.append(peekStack);
      }
      // The oldest card makes room; its batch stays in Review.
      if (peeks.size >= MAX_PEEKS) hidePeek([...peeks.keys()][0]);
      peekStack.append(card);
      const entry = { node: card, timer: arm() };
      peeks.set(project, entry);
      card.addEventListener("mouseenter", () => window.clearTimeout(entry.timer));
      card.addEventListener("mouseleave", () => {
        entry.timer = window.setTimeout(() => hidePeek(project), 4000);
      });
    } else {
      existing.timer = arm();
    }
  }

  /* ------------------------------------------------------------------ screen */

  /** The batches the filter lets through, each cut down to the kinds it lets through. */
  function visibleBatches(): Item[][] {
    return batches()
      .filter((batch) => !filter.project || batch[0].project === filter.project)
      .map((batch) => (filter.kind ? batch.filter((item) => item.kind === filter.kind) : batch))
      .filter((batch) => batch.length > 0)
      // Unseen first, newest first within each.
      .sort((a, b) => Number(b.some(isNew)) - Number(a.some(isNew)));
  }

  /** Narrowing by project and by kind, shown only when there is something to narrow. */
  function filters(): HTMLElement | null {
    const all = [...items.values()];
    const projects = [...new Set(all.map((item) => item.project))];
    const kinds = KINDS.filter(({ kind }) => all.some((item) => item.kind === kind));
    if (projects.length < 2 && kinds.length < 2 && !filter.project && !filter.kind) return null;
    const bar = make("div", "rv-filters");
    if (projects.length > 1 || filter.project) {
      const pick = make("select", "rv-pick");
      pick.setAttribute("aria-label", "Project");
      pick.append(new Option("All projects", ""));
      for (const id of projects.sort((a, b) => byName.compare(events.projectName(a), events.projectName(b)))) {
        pick.append(new Option(events.projectName(id), id));
      }
      pick.value = filter.project;
      pick.addEventListener("change", () => {
        filter.project = pick.value;
        focus = 0;
        paint();
      });
      bar.append(pick);
    }
    if (kinds.length > 1 || filter.kind) {
      const seg = make("div", "rv-seg");
      for (const { kind, label } of [{ kind: "" as const, label: "All" }, ...kinds]) {
        const option = make("button", "rv-seg-btn", label);
        option.type = "button";
        option.classList.toggle("is-on", filter.kind === kind);
        option.addEventListener("click", () => {
          filter.kind = kind;
          focus = 0;
          paint();
        });
        seg.append(option);
      }
      bar.append(seg);
    }
    return bar;
  }

  function paint(): void {
    if (!openState) return;
    shown = visibleBatches();
    focus = Math.min(focus, Math.max(0, shown.length - 1));
    const head = make("header", "rv-top");
    const heading = make("div", "rv-heading");
    heading.append(
      make("h1", "", "Review"),
      make("p", "", "What your agents made. Flip through a batch; send back only what needs changes."),
    );
    head.append(heading);
    const bar = filters();
    if (bar) head.append(bar);
    if (shown.length) {
      const narrowed = Boolean(filter.project || filter.kind);
      const all = make("button", "rv-btn is-quiet", narrowed ? "Mark these reviewed" : "Mark all reviewed");
      all.type = "button";
      all.addEventListener("click", () => dismiss(shown.flat()));
      head.append(all);
    }
    const body = make("div", "rv-body");
    if (undo) {
      const bar = make("div", "rv-undo");
      bar.append(make("span", "", `Marked ${undo.items.length === 1 ? "1 file" : `${undo.items.length} files`} reviewed.`));
      const again = make("button", "rv-btn", "Undo");
      again.type = "button";
      again.title = "Undo · U";
      again.addEventListener("click", restore);
      bar.append(again);
      body.append(bar);
    }
    if (!shown.length) {
      const empty = make("div", "rv-empty");
      empty.append(
        make("b", "", items.size ? "Nothing here with this filter" : "Nothing to review"),
        make("p", "", "When an agent saves an image, a sound or a video in its project, it shows up here."),
      );
      body.append(empty);
    } else {
      body.append(...shown.map(card));
    }
    screen.replaceChildren(head, body);
  }

  /** J/K or ↓/↑ move between batches, Enter reviews, D marks reviewed, F shows in Finder, U undoes. */
  function onKey(event: KeyboardEvent): void {
    if (!openState || event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
    if (document.querySelector(".rd-veil")) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("input, textarea, select, [contenteditable='true'], .xterm")) return;
    const key = event.key.toLowerCase();
    const move = (by: number): void => {
      if (!shown.length) return;
      focus = Math.max(0, Math.min(shown.length - 1, focus + by));
      const cards = [...screen.querySelectorAll<HTMLElement>(".rv-batch")];
      cards.forEach((node, at) => node.classList.toggle("is-focus", at === focus));
      cards[focus]?.scrollIntoView({ block: "nearest" });
    };
    const batch = shown[focus];
    let handled = true;
    if (key === "j" || key === "arrowdown") move(1);
    else if (key === "k" || key === "arrowup") move(-1);
    else if (key === "enter" && batch && target?.tagName !== "BUTTON") review(batch);
    else if (key === "d" && batch) dismiss(batch);
    else if (key === "f" && batch) reveal(batch);
    else if (key === "u" && undo) restore();
    else handled = false;
    if (handled) event.preventDefault();
  }

  return {
    openProject(project) {
      const mine = batches().filter((batch) => batch[0].project === project);
      // What you have not seen comes first, oldest of it first, so the work reads in order.
      const target = [...mine].reverse().find((batch) => batch.some((item) => !item.seen)) ?? mine[0];
      if (target) review(target, target.some((item) => !item.seen) ? 0 : newestAt(target));
      return Boolean(target);
    },
    open() {
      openState = true;
      focus = 0;
      hidePeek();
      // Looking is seeing: the badge clears, the "new" marks and order stay for this visit.
      let changed = false;
      for (const item of items.values()) {
        if (!item.seen) {
          fresh.add(item.path);
          item.seen = true;
          changed = true;
        }
      }
      paint();
      if (changed) {
        save();
        announce();
      }
      document.addEventListener("keydown", onKey);
      void pruneMissing();
    },
    clear() {
      openState = false;
      fresh.clear();
      document.removeEventListener("keydown", onKey);
      for (const player of screen.querySelectorAll<HTMLMediaElement>("audio, video")) player.pause();
      screen.replaceChildren();
    },
  };
}
