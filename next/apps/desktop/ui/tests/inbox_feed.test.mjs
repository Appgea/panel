import assert from "node:assert/strict";
import test from "node:test";
import { src } from "./load.mjs";

const { buildFeed, holds, inChannel, postKey, ALL, NEEDS } = await src("features/inbox_feed.ts");

const now = Date.parse("2026-11-15T18:00:00Z");
const ago = (min) => now - min * 60_000;
// Each post its own session unless a test says otherwise: one session's posts fold into one thread.
const post = (id, project, min, outcome = "done", session = id) => ({ id, project, session, at: ago(min), payload: { outcome } });
const card = (id, kind, room, min) => ({ id, kind, room, arrivedMs: ago(min) });

test("one session's messages within a few hours are one item, its newest, one unread", () => {
  const posts = [post("take5", "tavla", 90, "done", "s1"), post("other", "tavla", 80, "done", "s2"), post("take6", "tavla", 60, "done", "s1"), post("folder", "tavla", 58, "blocked", "s1"), post("next-day", "tavla", 60 + 5 * 60, "done", "s1")];
  const feed = buildFeed(posts, [], {}, now);
  assert.deepEqual(feed.items.map((i) => [i.id, (i.earlier ?? []).map((p) => p.id)]), [
    ["post:next-day", []],
    ["post:other", []],
    ["post:folder", ["take5", "take6"]],
  ]);
  assert.equal(feed.waiting, 3, "five messages, three threads, three unread");
  assert.equal(feed.needsYou, 1, "the newest message decides: it is blocked");
  assert.ok(holds(feed.items[2], "take5"));
});

// The feed is one timeline. A read mark per project says which posts are new, and the count is
// everything unread or waiting.
test("posts and cards share one timeline, and a project's mark reads its posts", () => {
  const posts = [post("a", "tavla", 50), post("b", "tavla", 10), post("c", "koza", 30, "blocked"), post("old", "koza", 3 * 24 * 60)];
  const cards = [card("decide:1", "decide", "tavla", 40), card("done:koza", "done", "koza", 20)];
  const feed = buildFeed(posts, cards, { [postKey("tavla")]: ago(20) }, now);

  assert.deepEqual(feed.items.map((i) => i.id), ["post:old", "post:a", "decide:1", "post:c", "done:koza", "post:b"]);
  assert.deepEqual(feed.items.filter((i) => i.unread).map((i) => i.id), ["decide:1", "post:c", "done:koza", "post:b"]);
  // A blocked report and a decision wait for him. A done card is only read.
  assert.deepEqual(feed.items.filter((i) => inChannel(i, NEEDS)).map((i) => i.id), ["decide:1", "post:c"]);
  assert.equal(feed.waiting, 4);
  assert.deepEqual(feed.channels.map((c) => [c.key, c.unread]), [["tavla", 2], ["koza", 2]]);
  assert.equal(feed.items.filter((i) => inChannel(i, ALL)).length, 6);
  assert.deepEqual(feed.items.filter((i) => inChannel(i, "koza")).map((i) => i.id), ["post:old", "post:c", "done:koza"]);

  // Read, the blocked report stops waiting.
  const read = buildFeed(posts, [], { [postKey("tavla")]: now, [postKey("koza")]: now }, now);
  assert.equal(read.waiting, 0);
});
