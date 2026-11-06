import assert from "node:assert/strict";
import test from "node:test";
import { src } from "./load.mjs";

const { route, LANE_Y } = await src("features/live_world.ts");

// Two columns of plots, This Mac above them, and the tower on the left: the map's shape.
const world = {
  hub: { x: 0, y: 0, w: 320, h: 118, bays: [{ x: -72, y: 26, w: 128, h: 38 }] },
  landmarks: { tower: { x: -280, y: 46 }, sky: { x: -280, y: -320 }, web: { x: 280, y: 0 } },
  districts: [
    { x: -160, y: 200, w: 280, h: 140 },
    { x: 160, y: 200, w: 280, h: 140 },
    { x: 160, y: 380, w: 280, h: 140 },
  ],
};

/** True when a straight piece runs through the inside of a plot, where its words are. */
function crossesPlot(a, b) {
  return world.districts.some((d) => {
    for (let i = 1; i < 20; i++) {
      const x = a.x + ((b.x - a.x) * i) / 20;
      const y = a.y + ((b.y - a.y) * i) / 20;
      if (Math.abs(x - d.x) < d.w / 2 - 30 && Math.abs(y - d.y) < d.h / 2 - 4) return true;
    }
    return false;
  });
}

// Owner, 2026-11-06: "sendings and etc must not be over things, they must pick a clear path".
test("a trip between plots, to the tower or into a bay never runs over a plot", () => {
  const agent = { x: -270, y: 210 };
  const trips = [
    [agent, { x: 30, y: 390 }],
    [agent, { x: -280, y: 36 }],
    [{ x: 30, y: 390 }, { x: -72, y: 26 }],
    [{ x: 30, y: 210 }, { x: 280, y: 0 }],
    [agent, { x: 160, y: 380 }],
  ];
  for (const [a, b] of trips) {
    const path = route(world, a, b);
    // The web gate stops a trip at its bottom edge, and a plot's centre at the plot's left edge.
    const end = b.x === 280 ? { x: 280, y: 42 } : b.x === 160 ? { x: 22, y: 380 } : b;
    assert.deepEqual(path[path.length - 1], end);
    for (let i = 1; i < path.length; i++) assert.ok(!crossesPlot(path[i - 1], path[i]), `${JSON.stringify(path)} piece ${i}`);
  }
  // Between columns, the trip uses the lane under This Mac.
  assert.ok(route(world, agent, { x: 30, y: 390 }).some((p) => p.y === LANE_Y));
});
