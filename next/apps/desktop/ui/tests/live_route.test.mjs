import assert from "node:assert/strict";
import test from "node:test";
import { src } from "./load.mjs";

const { route, elbows, LANE_Y } = await src("features/live_world.ts");

const BETWEEN_ROWS = 234;
const tower = { x: -328, y: 0, w: 300, h: 104 };
const web = { x: 328, y: 0, w: 300, h: 104 };
const world = {
  hub: { x: 0, y: 0, w: 300, h: 104, bays: [{ x: -70, y: 24, w: 128, h: 38 }] },
  landmarks: { tower, sky: tower, web },
  districts: [
    { key: "a", x: -328, y: 150, w: 300, h: 140 },
    { key: "b", x: 0, y: 150, w: 300, h: 140 },
    { key: "c", x: 0, y: 318, w: 300, h: 140 },
  ],
  lanes: [BETWEEN_ROWS, 402],
};
const mark = (c) => ({ x: c.x - c.w / 2 + 36, y: c.y - c.h / 2 + 34 });

function crossesPlot(a, b) {
  return world.districts.some((d) => {
    for (let i = 1; i < 20; i++) {
      const x = a.x + ((b.x - a.x) * i) / 20;
      const y = a.y + ((b.y - a.y) * i) / 20;
      if (Math.abs(x - d.x) < d.w / 2 - 40 && Math.abs(y - d.y) < d.h / 2 - 4) return true;
    }
    return false;
  });
}

const dotA = { x: -444, y: 170 };
const dotB = { x: -116, y: 170 };
const dotC = { x: -116, y: 340 };

test("a trip stays in the lanes between plots and never runs over one", () => {
  const trips = [
    [dotA, dotC],
    [dotA, dotB],
    [dotA, mark(tower), { x: mark(tower).x, y: mark(tower).y + 24 }],
    [dotC, { x: -70, y: 24 }, { x: -22, y: 24 }],
    [dotB, mark(web), { x: mark(web).x, y: mark(web).y + 24 }],
    [dotA, { x: 0, y: 318 }, { x: -148, y: 318 }],
    [dotB, dotC],
  ];
  for (const [a, b, end = b] of trips) {
    const path = route(world, a, b);
    assert.deepEqual(path[path.length - 1], end);
    for (let i = 1; i < path.length; i++) assert.ok(!crossesPlot(path[i - 1], path[i]), `${JSON.stringify(path)} piece ${i}`);
  }
});

test("a trip takes the nearest lane, not always the one under This Mac", () => {
  assert.ok(elbows(world, dotA, dotC).some((p) => p.y === BETWEEN_ROWS));
  assert.ok(!elbows(world, dotA, dotC).some((p) => p.y === LANE_Y));
  assert.ok(elbows(world, dotA, mark(tower)).some((p) => p.y === LANE_Y));
  assert.equal(route(world, dotA, { x: -444, y: 190 }).length, 2);
  assert.ok(elbows(world, dotB, dotC).length > 2);
});

test("a turn is a curve: no piece of a trip turns a right angle", () => {
  const path = route(world, dotA, dotC);
  assert.ok(path.length > elbows(world, dotA, dotC).length);
  for (let i = 2; i < path.length; i++) {
    const [p, c, n] = [path[i - 2], path[i - 1], path[i]];
    const turn = Math.abs(Math.atan2(n.y - c.y, n.x - c.x) - Math.atan2(c.y - p.y, c.x - p.x));
    assert.ok(Math.min(turn, 2 * Math.PI - turn) < Math.PI / 3, `piece ${i} turns ${turn}`);
  }
});
