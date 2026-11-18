import assert from "node:assert/strict";
import test from "node:test";
import { src } from "./load.mjs";

const { newGame, update } = await src("features/live_game.ts");

const now = new Date(2026, 10, 18, 21, 0).getTime();
const run = (time, unit, closed) => ({ time, unit, kind: "terra", app: "-", closed, minutes: 8, tokens: "1.2M", result: "said bye" });
const done = (number, hh) => ({ number, title: `Issue ${number}`, url: `u${number}`, kind: "done", apps: ["tavla"], priority: 2, who: "codex-1", at: new Date(2026, 10, 18, hh, 0).toISOString() });
const none = () => undefined;

test("opening Live plays no old news, and a close the board and the ledger both tell plays once", () => {
  const g = newGame();
  // The fleet is read first, the board's day a moment later. Neither replays this morning.
  update(g, { units: [], today: [run("09:00", "a", [1])] }, null, now, none);
  assert.equal(g.fresh.length, 0);
  update(g, { units: [], today: [run("09:00", "a", [1])] }, { cards: [done(1, 9), done(2, 10)] }, now, none);
  assert.equal(g.fresh.length, 0);
  assert.equal(g.score.closed, 2);

  // The board tells a new close before the unit's ledger line does: one banner, one feed line.
  update(g, { units: [], today: [run("09:00", "a", [1])] }, { cards: [done(1, 9), done(2, 10), done(3, 20)] }, now, none);
  assert.deepEqual(g.fresh.map((i) => i.id), ["done:3"]);
  update(g, { units: [], today: [run("20:59", "b", [3]), run("09:00", "a", [1])] }, { cards: [done(1, 9), done(2, 10), done(3, 20)] }, now, none);
  assert.equal(g.fresh.length, 0);
  assert.equal(g.items.filter((i) => i.kind === "close" && i.number === 3).length, 1);
});

test("a find filed today keeps its XP after it closes", () => {
  const g = newGame();
  const filed = { ...done(4, 9), kind: "new", created: new Date(2026, 10, 18, 9, 0).toISOString() };
  update(g, { units: [], today: [] }, { cards: [filed] }, now, none);
  assert.equal(g.score.found, 1);
  update(g, { units: [], today: [] }, { cards: [{ ...filed, kind: "done", at: new Date(2026, 10, 18, 10, 0).toISOString() }] }, now, none);
  assert.deepEqual([g.score.found, g.score.closed, g.score.xp], [1, 1, 13]);
});
