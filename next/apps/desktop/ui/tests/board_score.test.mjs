import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { transformWithOxc } from "vite";

const source = await readFile(new URL("../src/features/board_score.ts", import.meta.url), "utf8");
const { code } = await transformWithOxc(source, "board_score.ts");
const { score, splitTitle, engineOf, NO_ESTIMATE_XP } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

const now = new Date(2026, 10, 1, 15, 0);
const on = (daysBack, hour = 12) => new Date(2026, 10, 1 - daysBack, hour).toISOString();

test("XP is one point per estimated minute, and a close with no estimate counts as a small one", () => {
  const s = score([{ closed_at: on(0), estimate: 40 }, { closed_at: on(0) }, { closed_at: on(0), estimate: 99, dropped: true }], now);
  assert.deepEqual(s.today, { date: "2026-11-01", count: 2, xp: 40 + NO_ESTIMATE_XP });
  assert.equal(s.dropped, 1);
});

test("the streak counts back from today, and a today with nothing yet does not break it", () => {
  const days = [1, 2, 3, 5].map((back) => ({ closed_at: on(back), estimate: 10 }));
  assert.equal(score(days, now).streak, 3);
  assert.equal(score([...days, { closed_at: on(0), estimate: 10 }], now).streak, 4);
  assert.equal(score([{ closed_at: on(2) }], now).streak, 0);
});

test("this week and last week split the fourteen days at seven", () => {
  const s = score([{ closed_at: on(6), estimate: 30 }, { closed_at: on(7), estimate: 20 }, { closed_at: on(13), estimate: 5 }, { closed_at: on(14), estimate: 999 }], now);
  assert.equal(s.days.length, 14);
  assert.deepEqual([s.week, s.lastWeek], [30, 25]);
});

test("a title loses an app prefix the tile already shows, and keeps a kind prefix as a tag", () => {
  assert.deepEqual(splitTitle("videokit: read stayed-to-watch by API", ["videokit", "VideoKit"]), { tag: "", title: "Read stayed-to-watch by API" });
  assert.deepEqual(splitTitle("Speed: review loop", ["panel"]), { tag: "Speed", title: "Review loop" });
  assert.deepEqual(splitTitle("Fix the map: tiles overlap on small phones and more", []), { tag: "Fix the map", title: "Tiles overlap on small phones and more" });
  assert.deepEqual(splitTitle("A very long sentence with many words: then more", []).tag, "");
});

test("a holder names its engine", () => {
  assert.deepEqual(engineOf("codex-a974d24e"), { key: "codex", name: "Codex" });
  assert.deepEqual(engineOf("sol-weekcut"), { key: "codex", name: "Codex" });
  assert.deepEqual(engineOf("claude-e9aca641"), { key: "claude", name: "Claude" });
  assert.equal(engineOf("someone").key, "other");
});
