/**
 * The version of a file you asked an agent to change, kept so its redo can be held up against it.
 * The agent writes over the same path, so the old bytes are only ours if we copy them before it
 * does. IndexedDB, not localStorage: these are whole pictures and takes, not a to-do list.
 */
const DB = "panel-review";
const STORE = "before";
/** Anything bigger is a long video: the note alone says what you asked. */
const MAX_BYTES = 64 * 1024 * 1024;

let opening: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  opening ??= new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opening;
}

async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const base = await db();
  if (!base) return null;
  return new Promise((resolve) => {
    try {
      const request = work(base.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export const beforeKey = (path: string, modified: number): string => `${path}@${modified}`;

/** Copy the file as it is now. False when it is gone, too big, or storage refused it. */
export async function keepBefore(key: string, url: string): Promise<boolean> {
  try {
    const response = await fetch(url);
    if (!response.ok) return false;
    const size = Number(response.headers.get("content-length") ?? 0);
    if (size > MAX_BYTES) {
      void response.body?.cancel();
      return false;
    }
    const blob = await response.blob();
    if (blob.size > MAX_BYTES) return false;
    return (await run("readwrite", (store) => store.put(blob, key))) !== null;
  } catch {
    return false;
  }
}

export async function readBefore(key: string): Promise<Blob | null> {
  const found = await run<unknown>("readonly", (store) => store.get(key));
  return found instanceof Blob ? found : null;
}

export function dropBefore(key: string): void {
  void run("readwrite", (store) => store.delete(key));
}

/** Everything but `keep`: copies whose request or redo is no longer in Review. */
export async function pruneBefore(keep: Set<string>): Promise<void> {
  const keys = await run("readonly", (store) => store.getAllKeys());
  for (const key of keys ?? []) if (typeof key === "string" && !keep.has(key)) dropBefore(key);
}
