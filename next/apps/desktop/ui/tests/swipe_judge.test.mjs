import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { transformWithOxc } from "vite";

const source = await readFile(new URL("../src/features/swipe_judge.ts", import.meta.url), "utf8");
const { code } = await transformWithOxc(source, "swipe_judge.ts");
const { judge } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

const v = (number, move, note = "") => ({ number, kind: "done", move, note, voice: false, priority: 2 });

test("a left with no words is not judged, so a slipped drag changes nothing", () => {
  assert.equal(judge([], 0, v(1, "left")), null);
  assert.equal(judge([], 0, v(1, "left", "   ")), null);
  assert.deepEqual(judge([], 0, v(1, "left", "the map still overlaps")), [v(1, "left", "the map still overlaps")]);
});

test("walking back and swiping again changes that card in place", () => {
  const deck = [v(1, "right"), v(2, "left", "redo it"), v(3, "down")];
  assert.deepEqual(judge(deck, 1, v(2, "right")), [v(1, "right"), v(2, "right"), v(3, "down")]);
  assert.deepEqual(judge(deck, 3, v(4, "up")).length, 4);
  assert.equal(judge(deck, 5, v(6, "up")), null);
  assert.deepEqual(deck[1], v(2, "left", "redo it"));
});
