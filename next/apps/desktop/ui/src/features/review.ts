/**
 * Review: what the agents made. Pictures, sounds and videos that appeared in a project while a
 * session was open there, collected in one place so reviewing them is not a trip through Finder.
 *
 * Rust watches each project with an open session and sends `panel-made` once a file has
 * settled (see made.rs). The list's rules are in review_queue.ts and work like messages: a file
 * is new until you look at it in the deck, then it is seen and sits below the new work, where you
 * can scroll back to it. Files land in batches: whatever one project produced within half an hour
 * of itself is one piece of work.
 *
 * Nobody approves anything: what you look at and leave alone is fine. The one verdict is a
 * change, with a note, and what you sent back is remembered so the redo can stand next to it.
 *
 * The list is kept in localStorage: it is this window's to-do list. A file that disappears from
 * disk leaves it the next time Review opens.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { projectAssetUrl } from "../project-assets";
import { openReviewDeck, type DeckEnd, type DeckItem } from "./review_deck";
import {
  arrive,
  batches as batchesOf,
  inOrder,
  keep,
  readQueue,
  see,
  sent,
  writeQueue,
  type Item,
  type Kind,
  type Made,
} from "./review_queue";
import { beforeKey, keepBefore, pruneBefore, readBefore } from "./review_store";
import "./review.css";

export type ReviewEvents = {
  projectName(id: string): string;
  projectPath(id: string): string | null;
  /** New batches: a batch is one piece of work, however many files it wrote. */
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
  /** Go straight into a project's newest new batch, else its newest. False when it has nothing. */
  openProject(project: string): boolean;
  /**
   * Review exactly these files — what one report pointed at — starting on `start`. Files the
   * list has not heard of yet join it here. False when none of them is on disk.
   */
  openFiles(project: string, paths: string[], start?: string): Promise<boolean>;
  open(): void;
  clear(): void;
};

const STORE = "panel-review";
const ASKED = "panel-review-asked";
const FORGOTTEN = "panel-review-forgotten";
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

function stored(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "[]");
  } catch {
    return [];
  }
}

export function mountReview(screen: HTMLElement, events: ReviewEvents): ReviewHandle {
  const queue = readQueue({ items: stored(STORE), asked: stored(ASKED), forgotten: stored(FORGOTTEN) }, Date.now());
  let openState = false;
  /** The Review screen's narrowing to one project, for this run. Empty is everything. */
  let only = "";
  /** The batches as last painted, new then seen, and the one the keyboard is on. */
  let shown: Item[][] = [];
  let focus = 0;
  let checking = false;

  const save = (): void => {
    const saved = writeQueue(queue);
    try {
      localStorage.setItem(STORE, JSON.stringify(saved.items));
      localStorage.setItem(ASKED, JSON.stringify(saved.asked));
      localStorage.setItem(FORGOTTEN, JSON.stringify(saved.forgotten));
    } catch {
      // Storage full or blocked: the list still works for this run.
    }
  };

  /** Old versions still worth having: a note not yet sent, a request not yet answered, a redo on show. */
  const keptVersions = (): Set<string> => {
    const kept = new Set<string>();
    for (const item of queue.items.values()) {
      if (item.note !== undefined) kept.add(beforeKey(item.path, item.modified));
      if (item.before) kept.add(beforeKey(item.path, item.before.modified));
    }
    for (const [path, request] of queue.asked) kept.add(beforeKey(path, request.modified));
    return kept;
  };

  // Above announce(): it runs during mount, and a saved list reaches folderOf through batches().
  const relative = (item: Item): string => {
    const root = events.projectPath(item.project);
    return root && item.path.startsWith(`${root}/`) ? item.path.slice(root.length + 1) : item.path;
  };
  const folderOf = (item: Item): string => relative(item).split("/").slice(0, -1).join("/") || ".";
  const batches = (): { fresh: Item[][]; seen: Item[][] } => batchesOf(queue.items.values(), folderOf);

  const announce = (): void => {
    const { fresh } = batches();
    events.onCount(fresh.length);
    const counts = new Map<string, number>();
    for (const batch of fresh) counts.set(batch[0].project, (counts.get(batch[0].project) ?? 0) + 1);
    events.onProjects(counts);
  };

  void listen<Made>("panel-made", ({ payload }) => {
    if (!arrive(queue, payload, Date.now())) return;
    save();
    announce();
    if (openState) paint();
    else peek(payload.project);
  });
  announce();
  void pruneBefore(keptVersions());

  /**
   * Files no longer on disk leave quietly. Rust answers for a whole project at once; a project it
   * cannot find right now proves nothing, so its files stay.
   */
  async function pruneMissing(): Promise<void> {
    if (checking) return;
    checking = true;
    const byProject = new Map<string, Item[]>();
    for (const item of queue.items.values()) byProject.set(item.project, [...(byProject.get(item.project) ?? []), item]);
    let changed = false;
    for (const [project, listed] of byProject) {
      const found = await invoke<Made[]>("made_entries", { project, paths: listed.map((item) => item.path) }).catch(() => null);
      if (!found) continue;
      // The same name can reach us in two Unicode forms: a Turkish file name from FSEvents and from the disk.
      const there = new Set(found.map((made) => made.path.normalize("NFC")));
      for (const item of listed) {
        if (there.has(item.path.normalize("NFC")) || queue.items.get(item.path) !== item) continue;
        queue.items.delete(item.path);
        changed = true;
      }
    }
    checking = false;
    if (!changed) return;
    save();
    announce();
    paint();
  }

  /** The deck on one batch, from any item. Each piece is seen once it is on screen. */
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
    hidePeek();
    const find = (path: string): Item | undefined => batch.find((candidate) => candidate.path === path);
    const notes = new Map<string, string>();
    for (const item of batch) if (item.note !== undefined) notes.set(item.path, item.note);
    openReviewDeck(deckItems, at, {
      title: `${events.projectName(project)} · ${count(batch)}`,
      agentName: events.agentName(project),
      notes,
      onNote(path, note) {
        const item = find(path);
        if (!item) return;
        const first = item.note === undefined;
        if (note === null) delete item.note;
        else item.note = note;
        // A note on a file a report showed you, not in the list: it joins, so the note is kept.
        if (note !== null) keep(queue, item);
        save();
        // The agent will write over this file: copy it now, while it is still the one you saw.
        if (note !== null && first) void keepBefore(beforeKey(item.path, item.modified), src(item));
      },
      onSeen(path) {
        const item = find(path);
        if (!item || !see(item)) return;
        save();
        announce();
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
      reveal: (path) => void invoke("reveal_entry", { project, path }).catch(() => undefined),
      onClose(end: DeckEnd) {
        for (const url of urls) URL.revokeObjectURL(url);
        if (end === "sent") {
          sent(queue, batch, Date.now());
          save();
        }
        paint();
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
      chip.title = noted.map((item) => item.note).join("\n");
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
    const fresh = !batch[0].seen;
    const box = make("article", fresh ? "rv-batch is-new" : "rv-batch");
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
          noted ? `${noted} ${noted === 1 ? "note" : "notes"} not sent` : "",
          redone ? `${redone} redone` : "",
        ]
          .filter(Boolean)
          .join(" · "),
      ),
    );
    const groups = folderGroups(batch);
    title.append(make("code", "rv-where", groups.length === 1 ? groups[0].folder : `${groups.length} folders`));
    const open = make("button", fresh ? "rv-btn is-primary" : "rv-btn", fresh ? "Review" : "Look again");
    open.type = "button";
    open.title = "Go through it one by one · Enter";
    open.addEventListener("click", () => review(batch));
    head.append(title, open);
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

  /* ------------------------------------------------------------------ peek */

  /** One card in the corner for whatever arrived last. It never stacks. */
  let peekCard: { node: HTMLElement; timer: number } | null = null;

  function hidePeek(): void {
    if (!peekCard) return;
    const { node, timer } = peekCard;
    window.clearTimeout(timer);
    node.classList.add("is-leaving");
    window.setTimeout(() => node.remove(), 180);
    peekCard = null;
  }

  /** The project's newest batch you have not looked at. */
  const newestFresh = (project: string): Item[] | undefined =>
    batches().fresh.find((candidate) => candidate[0].project === project);

  /**
   * New work, brought to you: a small card in the corner with the pictures themselves. Tapping it
   * opens the batch. × or a card left alone just hides it; the batch stays new in Review.
   */
  function peek(project: string): void {
    if (events.busy()) return;
    const batch = newestFresh(project);
    if (!batch) return;
    if (peekCard) window.clearTimeout(peekCard.timer);
    const node = peekCard?.node ?? make("aside", "rv-peek");
    node.setAttribute("role", "status");
    node.classList.remove("is-leaving");
    // A face opens that file; anywhere else opens the batch from its start.
    const reviewFrom = (path?: string): void => {
      const latest = newestFresh(project);
      if (!latest) return hidePeek();
      review(latest, Math.max(0, latest.findIndex((item) => item.path === path)));
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
    node.onclick = () => reviewFrom();
    const close = make("button", "rv-peek-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Hide, keep in Review");
    close.title = "Hide — it stays new in Review";
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      hidePeek();
    });
    node.replaceChildren(faces, text, open, close);
    if (!node.isConnected) {
      document.body.append(node);
      node.addEventListener("mouseenter", () => peekCard && window.clearTimeout(peekCard.timer));
      node.addEventListener("mouseleave", () => {
        if (peekCard) peekCard.timer = window.setTimeout(hidePeek, 4000);
      });
    }
    peekCard = { node, timer: window.setTimeout(hidePeek, 9000) };
  }

  /* ------------------------------------------------------------------ screen */

  /** One project or all of them, shown only when more than one is listed. */
  function projectPick(): HTMLElement | null {
    const projects = [...new Set([...queue.items.values()].map((item) => item.project))];
    if (only && !projects.includes(only)) only = "";
    if (projects.length < 2) return null;
    const pick = make("select", "rv-pick");
    pick.setAttribute("aria-label", "Project");
    pick.append(new Option("All projects", ""));
    for (const id of projects.sort((a, b) => byName.compare(events.projectName(a), events.projectName(b)))) {
      pick.append(new Option(events.projectName(id), id));
    }
    pick.value = only;
    pick.addEventListener("change", () => {
      only = pick.value;
      focus = 0;
      paint();
    });
    return pick;
  }

  function paint(): void {
    if (!openState) return;
    const pick = projectPick();
    const mine = (batch: Item[]): boolean => !only || batch[0].project === only;
    const all = batches();
    const fresh = all.fresh.filter(mine);
    const seen = all.seen.filter(mine);
    shown = [...fresh, ...seen];
    focus = Math.min(focus, Math.max(0, shown.length - 1));
    const head = make("header", "rv-top");
    const heading = make("div", "rv-heading");
    heading.append(make("h1", "", "Review"), make("p", "", "What your agents made. New on top, what you've looked at below."));
    head.append(heading);
    if (pick) head.append(pick);
    if (fresh.length) {
      const read = make("button", "rv-btn is-quiet", "Mark all seen");
      read.type = "button";
      read.title = "Move the new work below without going through it";
      read.addEventListener("click", () => {
        for (const item of fresh.flat()) see(item);
        save();
        announce();
        paint();
      });
      head.append(read);
    }
    const body = make("div", "rv-body");
    if (!shown.length) {
      const empty = make("div", "rv-empty");
      empty.append(
        make("b", "", "Nothing to review"),
        make("p", "", "When an agent saves an image, a sound or a video in its project, it shows up here."),
      );
      body.append(empty);
    } else {
      body.append(make("h2", "rv-section", "New"));
      if (fresh.length) body.append(...fresh.map((batch, at) => card(batch, at)));
      else body.append(make("p", "rv-none", "Nothing new. Everything below you have looked at."));
      if (seen.length) body.append(make("h2", "rv-section", "Seen"), ...seen.map((batch, at) => card(batch, fresh.length + at)));
    }
    screen.replaceChildren(head, body);
  }

  /** J/K or ↓/↑ move between batches, Enter reviews. */
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
    else handled = false;
    if (handled) event.preventDefault();
  }

  return {
    openProject(project) {
      const target = newestFresh(project) ?? batches().seen.find((batch) => batch[0].project === project);
      if (target) review(target);
      return Boolean(target);
    },
    async openFiles(project, paths, start) {
      const found = await invoke<Made[]>("made_entries", { project, paths }).catch(() => [] as Made[]);
      if (!found.length) return false;
      const now = Date.now();
      // New versions join the list like any arrival. One the list let go of is shown, not re-added.
      const changed = found.map((made) => arrive(queue, made, now)).some(Boolean);
      const batch = inOrder(
        found.map((made) => queue.items.get(made.path) ?? { ...made, at: now, seen: true }),
        folderOf,
      );
      if (changed) {
        save();
        announce();
      }
      const wanted = start?.replaceAll("\\", "/");
      const at = wanted
        ? batch.findIndex((item) => {
            const path = item.path.replaceAll("\\", "/");
            return path === wanted || path.endsWith(`/${wanted}`);
          })
        : -1;
      review(batch, Math.max(0, at));
      return true;
    },
    open() {
      openState = true;
      focus = 0;
      hidePeek();
      paint();
      document.addEventListener("keydown", onKey);
      void pruneMissing();
    },
    clear() {
      openState = false;
      document.removeEventListener("keydown", onKey);
      for (const player of screen.querySelectorAll<HTMLMediaElement>("audio, video")) player.pause();
      screen.replaceChildren();
    },
  };
}
