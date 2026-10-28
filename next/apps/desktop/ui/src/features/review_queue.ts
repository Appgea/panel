/**
 * The rules of the Review list, with nothing to draw and nothing to store.
 *
 * It works like messages. A file is new until you look at it in the deck; then it is seen.
 * Seen files stay in the list, below the new ones, so you can scroll back to them. Nothing else
 * marks a file seen: opening Review, a peek, or a thumbnail in the grid is not looking at it.
 *
 * A file is a path at one version (its mtime). The same version announced again is not news:
 * macOS repeats a file's "created" flag when Finder, Quick Look or Spotlight touches it, and a
 * file you saw must not come back as new because of that. A new version is news.
 */

export type Kind = "image" | "audio" | "video";

export type Made = {
  project: string;
  path: string;
  kind: Kind;
  size: number;
  modified: number;
};

/** A change you sent to an agent, on the version of the file it was about. */
export type Request = { note: string; modified: number; at: number };

/**
 * `at` is when Panel heard of it. A file's own mtime can be days old: a download, an unzip, a copy.
 * `note` is a change you wrote on this version, not sent yet; `before` is the request this version answers.
 */
export type Item = Made & { at: number; seen: boolean; note?: string; before?: Request };

export type Queue = {
  /** Every listed file, by path. One version per path: the newest. */
  items: Map<string, Item>;
  /** Changes sent, by path, until the agent writes that file again. */
  asked: Map<string, Request>;
  /** Seen versions the cap took off the list, so the same version announced again stays off. */
  forgotten: Map<string, number>;
};

export type SavedQueue = { items?: unknown; asked?: unknown; forgotten?: unknown };

/** Files from one project this close together are one batch of work: a sitting, not a single render. */
export const BATCH_GAP = 30 * 60_000;
/** A request nobody answered in two weeks is not coming back. */
const ASKED_FOR = 14 * 24 * 60 * 60_000;
/** Seen files kept for scrolling back. New files and written notes are never what gets cut. */
const CAP = 400;
const HARD_CAP = 2000;
/** Versions remembered after the cap took them. Only a recent one is likely to be announced again. */
const FORGOTTEN_CAP = 4000;

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export function readQueue(saved: SavedQueue, now: number): Queue {
  const items = new Map<string, Item>();
  for (const item of list(saved.items) as Item[]) {
    if (!item?.path || !item.project) continue;
    items.set(item.path, { ...item, seen: item.seen === true, at: item.at ?? item.modified });
  }
  const asked = new Map(
    (list(saved.asked) as [string, Request][]).filter((entry) => Array.isArray(entry) && now - entry[1]?.at < ASKED_FOR),
  );
  const forgotten = new Map((list(saved.forgotten) as [string, number][]).filter((entry) => Array.isArray(entry)));
  return { items, asked, forgotten };
}

/** What to store: newest first, and cut only seen files without a note. */
export function writeQueue(queue: Queue): { items: Item[]; asked: [string, Request][]; forgotten: [string, number][] } {
  const sorted = [...queue.items.values()].sort((a, b) => b.at - a.at);
  const items = sorted.filter((item, at) => at < CAP || !item.seen || item.note !== undefined).slice(0, HARD_CAP);
  if (items.length < sorted.length) {
    const kept = new Set(items);
    for (const item of sorted) {
      if (kept.has(item)) continue;
      queue.items.delete(item.path);
      queue.forgotten.delete(item.path);
      queue.forgotten.set(item.path, item.modified);
    }
  }
  return { items, asked: [...queue.asked], forgotten: [...queue.forgotten].slice(-FORGOTTEN_CAP) };
}

/**
 * A file settled on disk. Returns the new item when it is news, null when this exact version is
 * already listed or was cut from the list. A redo of something you sent back carries what you asked.
 */
export function arrive(queue: Queue, made: Made, now: number): Item | null {
  const known = queue.items.get(made.path);
  if (known?.modified === made.modified || queue.forgotten.get(made.path) === made.modified) return null;
  const request = queue.asked.get(made.path);
  const answers = request && request.modified !== made.modified ? request : undefined;
  if (answers) queue.asked.delete(made.path);
  const before = answers ?? known?.before;
  const item: Item = { ...made, at: now, seen: false, ...(before ? { before } : {}) };
  queue.items.set(made.path, item);
  queue.forgotten.delete(made.path);
  return item;
}

/** A file shown to you in the deck. True when that changed anything. */
export function see(item: Item): boolean {
  if (item.seen) return false;
  item.seen = true;
  return true;
}

/** Into the list, if it is not there: a note written on a file a report showed you. */
export function keep(queue: Queue, item: Item): void {
  if (queue.items.has(item.path)) return;
  queue.items.set(item.path, item);
  if (queue.forgotten.get(item.path) === item.modified) queue.forgotten.delete(item.path);
}

/** The notes went to the agent: each waits for its redo, and is no longer a draft. */
export function sent(queue: Queue, batch: Item[], now: number): void {
  for (const item of batch) {
    if (item.note === undefined) continue;
    queue.asked.set(item.path, { note: item.note, modified: item.modified, at: now });
    delete item.note;
  }
}

const fileName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** Names the way Finder sorts them: shot_2 before shot_10. */
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * A batch in the order it is shown and reviewed: folder by folder, in the order each folder
 * first wrote, and by name inside a folder. Renders and takes finish out of order when made in
 * parallel, so 01, 02, 03 is the order the agent meant, not the order the files landed.
 */
export function inOrder(newestFirst: Item[], folderOf: (item: Item) => string): Item[] {
  const rank = new Map<string, number>();
  for (let at = newestFirst.length - 1; at >= 0; at--) {
    const folder = folderOf(newestFirst[at]);
    if (!rank.has(folder)) rank.set(folder, rank.size);
  }
  return newestFirst.sort(
    (a, b) => rank.get(folderOf(a))! - rank.get(folderOf(b))! || byName.compare(fileName(a.path), fileName(b.path)),
  );
}

/**
 * New batches, then seen ones, each newest first. A batch is one project's files within half an
 * hour of each other, all new or all seen: what you looked at leaves the new batch and goes below.
 */
export function batches(items: Iterable<Item>, folderOf: (item: Item) => string): { fresh: Item[][]; seen: Item[][] } {
  const sorted = [...items].sort((a, b) => b.at - a.at);
  const out = { fresh: [] as Item[][], seen: [] as Item[][] };
  const current = new Map<string, Item[]>();
  for (const item of sorted) {
    const key = `${item.seen}|${item.project}`;
    const batch = current.get(key);
    if (batch && batch[batch.length - 1].at - item.at <= BATCH_GAP) {
      batch.push(item);
      continue;
    }
    const started = [item];
    current.set(key, started);
    (item.seen ? out.seen : out.fresh).push(started);
  }
  return { fresh: out.fresh.map((batch) => inOrder(batch, folderOf)), seen: out.seen.map((batch) => inOrder(batch, folderOf)) };
}
