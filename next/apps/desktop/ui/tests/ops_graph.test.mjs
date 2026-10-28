import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { transformWithOxc } from "vite";

const source = await readFile(new URL("../src/features/ops_graph.ts", import.meta.url), "utf8");
const { code } = await transformWithOxc(source, "ops_graph.ts");
const { buildGraph, deadlineIn, headline, humanDates, humanName, layout, STALL_DAYS } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
);

const app = (key, name, extra = {}) => ({ key, name, kind: "flutter-app", project: null, depends_on: [], serves: [], ...extra });
const at = (date) => Date.parse(`${date}T12:00:00`) / 1000;
const data = (over = {}) => ({
  today: "2026-10-28",
  ops: "/ops",
  apps: [
    app("tavla", "Tavla", { project: "tavla-p" }),
    app("tavla_skor", "TavlaSkor"),
    app("dream_commenter", "Hayrola"),
    app("gunun_hadisi", "Günün Hadisi - Kütüb-i Sitte"),
    app("memor", "Memor"),
  ],
  open: [],
  rollouts: [],
  done: [],
  ...over,
});
const today = new Date(2026, 9, 28).getTime();

test("a date is a deadline only after a deadline word", () => {
  assert.equal(deadlineIn("The certificate ends 2026-10-26.", today), -2);
  assert.equal(deadlineIn("Deadline was 31 Aug 2026.", today), -58);
  assert.equal(deadlineIn("Due Nov 4, 2026", today), 7);
  assert.equal(deadlineIn("Moved here 2026-09-20 from projects/.", today), null);
});

test("tags and prose find apps by key, name and short name", () => {
  const graph = buildGraph(data({
    open: [
      { section: "blocked", tags: ["tavlaskor"], owner: "you", text: "x", line: 3, edited: at("2026-10-27") },
      { section: "blocked", tags: [], owner: "you", text: "Rebuilt legal pages for Günün Hadisi and memor.", line: 4, edited: 0 },
      { section: "flight", tags: [], owner: "cpo", text: "Product spine extractor.", line: 5, edited: 0 },
    ],
    done: [{ date: "2026-10-19", kind: "log", tags: ["hayrola"], text: "subscriptions approved", path: "l", line: 9 }],
  }), 14, () => null);
  const [one, two, three] = graph.threads;
  assert.deepEqual(one.targets, ["app:tavla_skor"]);
  assert.deepEqual(two.targets.sort(), ["app:gunun_hadisi", "app:memor"]);
  assert.deepEqual(three.targets, ["company"], "work that names no app belongs to the company");
  assert.deepEqual(graph.done[0].nodes, ["app:dream_commenter"]);
  assert.ok(!graph.threads.some((t) => t.targets.includes("app:tavla")), "Tavla is not TavlaSkor");
});

test("stalled means old text and nothing moved; a commit or a log line saves it", () => {
  const old = { section: "flight", tags: ["tavla"], owner: "cpo", text: "Cosmetics.", line: 7, edited: at("2026-09-20") };
  assert.equal(buildGraph(data({ open: [old] }), 14, () => 0).threads[0].stalled, true);
  assert.equal(buildGraph(data({ open: [old] }), 14, () => 3).threads[0].stalled, false);
  const logged = [{ date: "2026-10-20", kind: "log", tags: ["tavla"], text: "fix live", path: "l", line: 1 }];
  assert.equal(buildGraph(data({ open: [old], done: logged }), 7, () => 0).threads[0].stalled, false,
    "the stall test looks back STALL_DAYS whatever the window");
  const fresh = { ...old, edited: at("2026-10-27") };
  assert.equal(buildGraph(data({ open: [fresh] }), 14, () => 0).threads[0].stalled, false);
  assert.equal(STALL_DAYS, 14);
});

test("tones: overdue beats waiting; a late rollout stays on its hub", () => {
  const graph = buildGraph(data({
    open: [
      { section: "blocked", tags: ["tavla"], owner: "you", text: "Renew before 2026-10-01.", line: 2, edited: 0 },
      { section: "rollout", tags: ["billing-8"], owner: "", text: "Deadline was 31 Aug 2026.", line: 9, edited: 0 },
    ],
    rollouts: [{ id: "billing-8", summary: "", apps: ["memor"], done_when: "", path: "r" }],
  }), 14, () => null);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get("app:tavla").tone, "risk");
  assert.equal(byId.get("owner:you").tone, "risk");
  assert.equal(byId.get("rollout:billing-8").tone, "risk");
  assert.equal(byId.get("app:memor").tone, "std", "memor is in the rollout, not late itself");
  assert.equal(byId.get("app:gunun_hadisi").quiet, true);
  assert.equal(byId.get("app:memor").quiet, true, "a rollout listing alone is not news");
  assert.equal(graph.quiet, 4);
});

test("done honours the window, and layout is stable and keeps old places", () => {
  const done = [
    { date: "2026-10-26", kind: "log", tags: ["memor"], text: "a", path: "l", line: 1 },
    { date: "2026-10-10", kind: "log", tags: ["memor"], text: "b", path: "l", line: 2 },
  ];
  assert.equal(buildGraph(data({ done }), 7, () => null).done.length, 1);
  assert.equal(buildGraph(data({ done }), 30, () => null).done.length, 2);
  const open = [{ section: "blocked", tags: ["tavla", "memor"], owner: "you", text: "x", line: 2, edited: 0 }];
  const place = () => {
    const g = buildGraph(data({ open, done }), 30, () => null);
    layout(g.nodes, g.edges, () => 40);
    return g.nodes.map((n) => [n.id, Math.round(n.x), Math.round(n.y)]);
  };
  assert.deepEqual(place(), place());
  const g = buildGraph(data({ open, done }), 30, () => null);
  layout(g.nodes, g.edges, () => 40, new Map(g.nodes.map((n) => [n.id, { x: 5, y: 6 }])));
  assert.ok(g.nodes.every((n) => n.x === 5 && n.y === 6), "nothing new, nothing moves");
});

test("ops lines read as one plain headline", () => {
  const read = (text) => headline(humanDates(text, 2026));
  assert.equal(read("The signing certificate ends 2026-10-26. Renewing means a new one."),
    "The signing certificate ends Oct 26");
  assert.equal(read("Portfolio has rebuilt legal pages for 10 apps (coinapp, fitstrail). Push later."),
    "Portfolio has rebuilt legal pages for 10 apps");
  assert.equal(read("1.13.0 (20) shipped. iOS in App Review."), "1.13.0 shipped");
  assert.equal(read("dark mode live on both stores. Left the widget."), "Dark mode live on both stores");
  assert.equal(read("D-0042 · No app sells in China mainland (ICP filing); new apps leave CHN unchecked"),
    "No app sells in China mainland");
  assert.equal(read("Sync paused (`.env` false). **Notes** export hidden."), "Sync paused");
  const long = read("Every screenshot in the store listing needs to be taken again once the new layout lands.");
  assert.ok(long.length <= 73 && long.endsWith("…") && !long.includes("  "), long);
  assert.equal(read("Decide the launch order of the new levels: easy first, or hard first."),
    "Decide the launch order of the new levels");
  assert.equal(read("Reviews: iOS ratings are low. Cause is install volume."), "Reviews: iOS ratings are low");
  assert.equal(humanDates("from 2025-12-01", 2026), "from Dec 1, 2025");
  assert.deepEqual(["billing-8", "ios-cover-art", "admob-consolidation"].map(humanName), ["Billing 8", "iOS cover art", "AdMob consolidation"]);
});
