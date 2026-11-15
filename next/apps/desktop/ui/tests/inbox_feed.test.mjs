import assert from "node:assert/strict";
import test from "node:test";
import { src } from "./load.mjs";

const { buildFeed, inChannel, postKey, ALL, NEEDS } = await src("features/inbox_feed.ts");

const now = Date.parse("2026-11-15T18:00:00Z");
const ago = (min) => now - min * 60_000;
const post = (id, project, min, outcome = "done") => ({ id, project, at: ago(min), payload: { outcome } });
const card = (id, kind, room, min) => ({ id, kind, room, arrivedMs: ago(min) });

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
