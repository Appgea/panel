import assert from "node:assert/strict";
import test from "node:test";
import { src } from "./load.mjs";

const { newGame, update } = await src("features/live_game.ts");

const now = new Date(2026, 10, 18, 21, 0).getTime();
const at = (d, hh, mm = 0) => new Date(2026, 10, d, hh, mm).toISOString();
const run = (time, unit, closed, result = "said bye", minutes = 8) => ({ time, unit, kind: "terra", app: "-", closed, minutes, tokens: "1.2M", result });
const done = (number, hh) => ({ number, title: `Issue ${number}`, url: `u${number}`, kind: "done", apps: ["tavla"], priority: 2, who: "codex-1", at: at(18, hh) });
const read = (fleet, day, extra = {}) => ({ fleet, day, now, ...extra });

test("opening Live plays no old news, and a close the board and the ledger both tell plays once", () => {
  const g = newGame();
  // The fleet is read first, the board's day a moment later. Neither replays this morning.
  update(g, read({ units: [], today: [run("09:00", "a", [1])] }, null));
  assert.equal(g.fresh.length, 0);
  update(g, read({ units: [], today: [run("09:00", "a", [1])] }, { cards: [done(1, 9), done(2, 10)] }));
  assert.equal(g.fresh.length, 0);
  assert.equal(g.score.closed, 2);

  // The board tells a new close before the unit's ledger line does: one banner, one feed line.
  update(g, read({ units: [], today: [run("09:00", "a", [1])] }, { cards: [done(1, 9), done(2, 10), done(3, 20)] }));
  assert.deepEqual(g.fresh.map((i) => i.id), ["done:3"]);
  update(g, read({ units: [], today: [run("20:59", "b", [3]), run("09:00", "a", [1])] }, { cards: [done(1, 9), done(2, 10), done(3, 20)] }));
  assert.equal(g.fresh.length, 0);
  assert.equal(g.items.filter((i) => i.kind === "close" && i.number === 3).length, 1);
});

test("a find keeps its XP after it closes, and goes to the scout run that filed it", () => {
  const g = newGame();
  const filed = { ...done(4, 9), kind: "new", created: at(18, 9), scout: "legal@VideoKit" };
  // Filed while the unit ran: the running unit gets it.
  update(g, read({ units: [], today: [] }, { cards: [filed] }, { scouts: new Map([["legal@videokit", { unit: "s1", kind: "flash", since: Date.parse(at(18, 8, 50)) }]]) }));
  assert.equal(g.score.found, 1);
  assert.equal(g.score.foundBy.get("s1"), 1);
  // It ended at 09:05 after 20 minutes, and the find was closed since: still its find.
  update(g, read({ units: [], today: [run("09:05", "s1", [], "scout legal@VideoKit, said bye", 20), run("08:30", "s0", [], "scout legal@VideoKit, said bye", 10)] }, { cards: [{ ...filed, kind: "done", at: at(18, 10) }] }));
  assert.deepEqual([g.score.found, g.score.closed, g.score.xp, g.score.foundBy.get("s1"), g.score.foundBy.has("s0")], [1, 1, 13, 1, false]);
  // The ledger's line names the unit's class.
  assert.equal(g.items.find((i) => i.id === "new:4").who, "Terra s1");
});

test("yesterday up to this hour is the pace, and a read that does not reach it has none", () => {
  const g = newGame();
  const y = (n, hh) => ({ ...done(n, 9), at: at(17, hh), created: at(17, hh) });
  const cards = [y(5, 10), y(6, 20), y(7, 22), done(8, 9)];
  update(g, read(null, { since: at(17, 0), cards }));
  // 22:00 yesterday is after this hour, 21:00: not counted.
  assert.deepEqual(g.score.yesterday, { closed: 2, found: 2, xp: 26 });
  update(g, read(null, { since: at(18, 0), cards }));
  assert.equal(g.score.yesterday, null);
  assert.equal(g.score.partial, false);
  // A list that hit its limit may have lost today's issues too: no pace, and the score says so.
  update(g, read(null, { since: at(17, 0), cards, limit: 4 }));
  assert.deepEqual([g.score.yesterday, g.score.partial], [null, true]);
});
