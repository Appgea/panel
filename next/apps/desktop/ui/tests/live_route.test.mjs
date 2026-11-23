import assert from "node:assert/strict";
import test from "node:test";
import { src } from "./load.mjs";

const { route, elbows, LANE_Y } = await src("features/live_world.ts");

const BETWEEN_ROWS = 274;
const world = {
  hub: { x: 0, y: 0, w: 320, h: 118, bays: [{ x: -72, y: 26, w: 128, h: 38 }] },
  landmarks: { tower: { x: -290, y: -27, w: 200, h: 64 }, sky: { x: -290, y: -27, w: 200, h: 64 }, web: { x: 290, y: -27, w: 200, h: 64 } },
  districts: [
    { key: "a", x: -154, y: 190, w: 280, h: 140 },
    { key: "b", x: 154, y: 190, w: 280, h: 140 },
    { key: "c", x: 154, y: 358, w: 280, h: 140 },
  ],
  lanes: [BETWEEN_ROWS, 442],
};

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

const dotA = { x: -260, y: 220 };
const dotB = { x: 48, y: 220 };
const dotC = { x: 48, y: 380 };

test("a trip stays in the lanes between plots and never runs over one", () => {
  const trips = [
    [dotA, dotC],
    [dotA, dotB],
    [dotA, { x: -290, y: -27 }],
    [dotA, { x: -290, y: -151 }],
    [dotC, { x: -72, y: 26 }],
    [dotB, { x: 290, y: -27 }],
    [dotA, { x: 154, y: 358 }],
    [dotB, dotC],
  ];
  for (const [a, b] of trips) {
    const path = route(world, a, b);
    const end = Math.abs(b.x) === 290 ? { x: b.x - 72, y: -5 } : b.x === 154 ? { x: 16, y: 358 } : b.x === -72 ? { x: -24, y: 26 } : b;
    assert.deepEqual(path[path.length - 1], end);
    for (let i = 1; i < path.length; i++) assert.ok(!crossesPlot(path[i - 1], path[i]), `${JSON.stringify(path)} piece ${i}`);
  }
});

test("a trip takes the nearest lane, not always the one under This Mac", () => {
  assert.ok(elbows(world, dotA, dotC).some((p) => p.y === BETWEEN_ROWS));
  assert.ok(!elbows(world, dotA, dotC).some((p) => p.y === LANE_Y));
  assert.ok(elbows(world, dotA, { x: -290, y: -27 }).some((p) => p.y === LANE_Y));
  assert.equal(route(world, dotA, { x: -276, y: 240 }).length, 2);
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
