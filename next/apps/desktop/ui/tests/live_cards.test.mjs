import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { transformWithOxc } from "vite";

const source = await readFile(new URL("../src/features/live_cards.ts", import.meta.url), "utf8");
const { code } = await transformWithOxc(source, "live_cards.ts");
const { buildCards, order, scoreLine } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

const now = Date.parse("2026-11-04T18:00:00Z");
const ago = (min) => new Date(now - min * 60_000).toISOString();
const weights = { tavla: 3, koza: 2, interbellum: 1, weekcut: 2 };

// The spec's worked example: two money calls first, and the Better card that waited longest
// climbs past two newer cards.
test("cards line up by value per minute, and the card in front stays in front", () => {
  const board = {
    you: [
      { number: 1, title: "Tavla Plus monthly price", url: "u1", apps: ["tavla"], ask: "Fiyat?", options: ["99 TL", "79 TL"], created_at: ago(40) },
      { number: 2, title: "Koza trial length", url: "u2", apps: ["koza"], ask: "Deneme?", options: ["7 gün", "3 gün"], created_at: ago(75) },
    ],
    done: [{ number: 3, title: "Dice sound", url: "u3", apps: ["tavla"], closed_at: ago(30) }],
    ready: [
      { number: 4, title: "Typecheck keeps failing", url: "u4", apps: ["interbellum"], kinds: ["speed"], created_at: ago(120) },
      { number: 5, title: "Map labels", url: "u5", apps: ["interbellum"], decided: "Labels hide below zoom 0.4, because they overlap", created_at: ago(20) },
    ],
  };
  const cards = buildCards(board, [], (r) => weights[r] ?? 1, (r) => r, {}, now);
  const ids = order(cards, now, null, {}).map((c) => c.id);
  assert.deepEqual(ids, ["decide:1", "decide:2", "done:tavla", "better:4", "decided:interbellum"]);

  // He is reading the Done card. A new, more urgent ask arrives: it lines up behind it.
  const front = order(cards, now, "done:tavla", {}).map((c) => c.id);
  assert.equal(front[0], "done:tavla");
  // The card says why it is in front, in its own numbers.
  assert.equal(scoreLine(cards.find((c) => c.id === "decide:1"), now, "Tavla"), "Tavla ×3 · Decide ×3 · waited 40 min · about 1 min of you → 15.00");
  // Later sends a card to the back until its time is up.
  assert.equal(order(cards, now, null, { "decide:1": now + 60_000 }).at(-1).id, "decide:1");
});

test("a seen close, call or turn does not come back", () => {
  const board = { done: [{ number: 3, title: "Dice", url: "u", apps: ["tavla"], closed_at: ago(30) }] };
  const agents = [{ id: "pid:1", name: "Pişekar", room: "tavla", state: "turn", stateMs: now - 1000, headless: false, panel: null, lastText: "Done." }];
  const seen = { "done:tavla": now - 10_000, [`turn:pid:1:${now - 1000}`]: now };
  assert.equal(buildCards(board, agents, () => 1, (r) => r, seen, now).length, 0);
});
