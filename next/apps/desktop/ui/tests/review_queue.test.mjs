import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { transformWithOxc } from "vite";

const source = await readFile(new URL("../src/features/review_queue.ts", import.meta.url), "utf8");
const { code } = await transformWithOxc(source, "review_queue.ts");
const { arrive, batches, readQueue, see, sent, writeQueue, BATCH_GAP } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
);

const made = (path, modified = 1, project = "app") => ({ project, path: `/p/${project}/${path}`, kind: "image", size: 10, modified });
const empty = () => readQueue({}, 0);
const folderOf = (item) => item.path.split("/").slice(3, -1).join("/") || ".";
const names = (list) => list.map((batch) => batch.map((item) => item.path.split("/").pop()));

test("a seen file touched again stays seen and stays put; a new version is new", () => {
  const queue = empty();
  see(arrive(queue, made("shots/a.png"), 100));
  // Quick Look or Finder touches it: macOS says "created" again, same mtime.
  assert.equal(arrive(queue, made("shots/a.png"), 200), null);
  const item = queue.items.get("/p/app/shots/a.png");
  assert.deepEqual([item.seen, item.at], [true, 100]);
  assert.equal(arrive(queue, made("shots/a.png", 2), 300).seen, false, "the agent wrote it again");
});

test("what you looked at goes below what you have not, in its own batch", () => {
  const queue = empty();
  for (const [name, at] of [["s_1.png", 100], ["s_2.png", 200], ["s_10.png", 300]]) arrive(queue, made(`out/${name}`), at);
  arrive(queue, made("cover.png", 1, "web"), 250);
  see(queue.items.get("/p/app/out/s_1.png"));
  const { fresh, seen } = batches(queue.items.values(), folderOf);
  assert.deepEqual(names(fresh), [["s_2.png", "s_10.png"], ["cover.png"]]);
  assert.deepEqual(names(seen), [["s_1.png"]]);
});

test("time ends a batch, and the old model's seen flag is kept", () => {
  const queue = readQueue(
    { items: [{ ...made("a.png"), at: 10 + BATCH_GAP + 1, seen: true }, { ...made("b.png"), at: 10, seen: true }, made("c.png")] },
    0,
  );
  const { fresh, seen } = batches(queue.items.values(), folderOf);
  assert.deepEqual(names(seen), [["a.png"], ["b.png"]]);
  assert.deepEqual(names(fresh), [["c.png"]], "no seen flag stored: still new");
});

test("a seen file the cap took off the list does not come back as new", () => {
  const queue = empty();
  for (let at = 0; at < 401; at++) see(arrive(queue, made(`f${at}.png`), at));
  writeQueue(queue);
  assert.equal(queue.items.size, 400);
  assert.equal(arrive(queue, made("f0.png"), 1000), null);
});

test("a sent note waits for the redo, which carries what you asked", () => {
  const queue = empty();
  const item = arrive(queue, made("logo.png"), 100);
  item.note = "bigger";
  sent(queue, [item], 200);
  assert.equal(item.note, undefined, "no longer a draft");
  const redo = arrive(queue, made("logo.png", 2), 300);
  assert.deepEqual([redo.seen, redo.before], [false, { note: "bigger", modified: 1, at: 200 }]);
  assert.equal(queue.asked.size, 0);
});
