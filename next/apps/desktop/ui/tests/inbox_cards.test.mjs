import assert from "node:assert/strict";
import test from "node:test";
import { src } from "./load.mjs";

const { inboxCards } = await src("features/inbox_cards.ts");

const now = Date.parse("2026-11-05T18:00:00Z");
const ago = (min) => now - min * 60_000;
const name = (k) => k;
const pic = () => "";

// A Seen tap on a project's reports or ended sessions keeps them gone, and only newer ones bring
// the card back. Support is gone once read.
test("seen reports, sessions and support mail do not come back", () => {
  const src = {
    reports: [{ id: "a", project: "tavla", title: "Built", at: ago(30) }],
    review: [],
    support: [{ id: "m1", app: "tavla", subject: "Freezes", email: "", form: "Tavla", fields: [], at: ago(60) }],
    ended: [{ id: "h1", project: "panel", agent: "Claude", title: "Live", at: ago(20), resumable: true }],
    endedFloor: ago(24 * 60),
  };
  const first = inboxCards(src, () => 1, name, pic, {}, now).map((c) => c.id).sort();
  assert.deepEqual(first, ["ended:panel", "report:tavla", "support:m1"]);

  const seen = { "report:tavla": ago(10), "ended:panel": ago(10), "support:m1": ago(10) };
  assert.deepEqual(inboxCards(src, () => 1, name, pic, seen, now), []);

  src.reports.push({ id: "b", project: "tavla", title: "Shipped", at: ago(5) });
  const back = inboxCards(src, () => 1, name, pic, seen, now);
  assert.deepEqual(back.map((c) => [c.id, c.title]), [["report:tavla", "Shipped"]]);
});
