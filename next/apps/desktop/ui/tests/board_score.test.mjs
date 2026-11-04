import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { transformWithOxc } from "vite";

const source = await readFile(new URL("../src/features/board_score.ts", import.meta.url), "utf8");
const { code } = await transformWithOxc(source, "board_score.ts");
const { days, splitTitle, engineOf } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

const now = new Date(2026, 10, 1, 15, 0);
const on = (daysBack, hour = 12) => new Date(2026, 10, 1 - daysBack, hour).toISOString();

test("closes count per local day, a dropped issue is not done, and older closes fall off", () => {
  const d = days([{ closed_at: on(0) }, { closed_at: on(0) }, { closed_at: on(0), dropped: true }, { closed_at: on(3) }, { closed_at: on(14) }], now);
  assert.deepEqual(d.today, { date: "2026-11-01", count: 2 });
  assert.equal(d.days.length, 14);
  assert.equal(d.days.reduce((n, day) => n + day.count, 0), 3);
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
