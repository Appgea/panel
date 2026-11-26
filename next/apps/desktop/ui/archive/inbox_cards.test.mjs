import assert from "node:assert/strict";
import test from "node:test";
import { src } from "./load.mjs";

const { inboxCards } = await src("features/inbox_cards.ts");

const now = Date.parse("2026-11-05T18:00:00Z");
const ago = (min) => now - min * 60_000;
const name = (k) => k;
const pic = () => "";

// Seen ended sessions stay gone, and only a newer one brings the card back. Support is gone once read.
test("seen sessions and support mail do not come back", () => {
  const src = {
    review: [],
    support: [{ id: "m1", app: "tavla", subject: "Freezes", email: "", form: "Tavla", fields: [], at: ago(60) }],
    ended: [{ id: "h1", project: "panel", agent: "Claude", title: "Live", at: ago(20), resumable: true }],
    endedFloor: ago(24 * 60),
  };
  const first = inboxCards(src, name, pic, {}).map((c) => c.id).sort();
  assert.deepEqual(first, ["ended:panel", "support:m1"]);

  const seen = { "ended:panel": ago(10), "support:m1": ago(10) };
  assert.deepEqual(inboxCards(src, name, pic, seen), []);

  src.ended.push({ id: "h2", project: "panel", agent: "Codex", title: "Labels", at: ago(5), resumable: false });
  const back = inboxCards(src, name, pic, seen);
  assert.deepEqual(back.map((c) => [c.id, c.title]), [["ended:panel", "Codex finished: Labels"]]);
});
