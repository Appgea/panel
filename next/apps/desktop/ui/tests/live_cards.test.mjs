import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { transformWithOxc } from "vite";

const source = await readFile(new URL("../src/features/live_cards.ts", import.meta.url), "utf8");
const { code } = await transformWithOxc(source, "live_cards.ts");
const { buildCards } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

const now = Date.parse("2026-11-04T18:00:00Z");
const ago = (min) => new Date(now - min * 60_000).toISOString();

test("a seen close, call or turn does not come back", () => {
  const board = { done: [{ number: 3, title: "Dice", url: "u", apps: ["tavla"], closed_at: ago(30) }] };
  const agents = [{ id: "pid:1", name: "Pişekar", room: "tavla", state: "turn", stateMs: now - 1000, headless: false, panel: null, lastText: "Done." }];
  const seen = { "done:tavla": now - 10_000, [`turn:pid:1:${now - 1000}`]: now };
  assert.equal(buildCards(board, agents, (r) => r, seen, now).length, 0);
});
