import assert from "node:assert/strict";
import test from "node:test";
import { src } from "./load.mjs";

const { buildFeed, holds, READ_KEY } = await src("features/inbox_feed.ts");

const now = Date.parse("2026-11-15T18:00:00Z");
const ago = (min) => now - min * 60_000;
const post = (id, project, min, session = id) => ({ id, project, session, at: ago(min), payload: {} });

test("one session's messages within a few hours are one item, its newest, one unread", () => {
  const posts = [post("take5", "tavla", 90, "s1"), post("other", "tavla", 80, "s2"), post("take6", "tavla", 60, "s1"), post("folder", "tavla", 58, "s1"), post("next-day", "tavla", 60 + 5 * 60, "s1")];
  const feed = buildFeed(posts, {}, now);
  assert.deepEqual(feed.items.map((i) => [i.id, i.earlier.map((p) => p.id)]), [
    ["post:next-day", []],
    ["post:other", []],
    ["post:folder", ["take5", "take6"]],
  ]);
  assert.equal(feed.unread, 3);
  assert.ok(holds(feed.items[2], "take5"));
});

test("only the last 48 hours show, across every project", () => {
  const posts = [post("old", "koza", 49 * 60), post("edge", "koza", 47 * 60), post("a", "tavla", 50), post("b", "pillow", 10)];
  const feed = buildFeed(posts, {}, now);
  assert.deepEqual(feed.items.map((i) => i.id), ["post:edge", "post:a", "post:b"]);
});

test("one read mark covers the whole list", () => {
  const posts = [post("a", "tavla", 50), post("b", "koza", 30), post("c", "pillow", 10)];
  const some = buildFeed(posts, { [READ_KEY]: ago(30) }, now);
  assert.deepEqual(some.items.filter((i) => i.unread).map((i) => i.id), ["post:c"]);
  assert.equal(some.unread, 1);
  assert.equal(buildFeed(posts, { [READ_KEY]: now }, now).unread, 0);
});
