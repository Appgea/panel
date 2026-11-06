import assert from "node:assert/strict";
import test from "node:test";
import { src } from "./load.mjs";

const { route, LANE_Y } = await src("features/live_world.ts");

// Two columns of plots, This Mac above them, and the GitHub and Web cards beside it.
const world = {
  hub: { x: 0, y: 0, w: 320, h: 118, bays: [{ x: -72, y: 26, w: 128, h: 38 }] },
  landmarks: { tower: { x: -290, y: -27, w: 200, h: 64 }, sky: { x: -290, y: -27, w: 200, h: 64 }, web: { x: 290, y: -27, w: 200, h: 64 } },
  districts: [
    { key: "a", x: -160, y: 200, w: 280, h: 140 },
    { key: "b", x: 160, y: 200, w: 280, h: 140 },
    { key: "c", x: 160, y: 380, w: 280, h: 140 },
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
test("a trip between plots, to a card or into a bay never runs over a plot", () => {
  const agent = { x: -270, y: 210 };
  const trips = [
    [agent, { x: 30, y: 390 }],
    [agent, { x: -290, y: -27 }],
    // From a script written for the old tower: a point high above the card.
    [agent, { x: -290, y: -151 }],
    [{ x: 30, y: 390 }, { x: -72, y: 26 }],
    [{ x: 30, y: 210 }, { x: 290, y: -27 }],
    [agent, { x: 160, y: 380 }],
    // Dot to dot between two plots stacked in one column.
    [{ x: 40, y: 220 }, { x: 40, y: 400 }],
  ];
  for (const [a, b] of trips) {
    const path = route(world, a, b);
    // A card stops a trip at its bottom edge, and a plot's centre at the plot's left edge.
    const end = Math.abs(b.x) === 290 ? { x: b.x, y: 5 } : b.x === 160 ? { x: 22, y: 380 } : b.x === -72 ? { x: -24, y: 26 } : b;
    assert.deepEqual(path[path.length - 1], end);
    for (let i = 1; i < path.length; i++) assert.ok(!crossesPlot(path[i - 1], path[i]), `${JSON.stringify(path)} piece ${i}`);
  }
  // To a helper beside the dot in the same plot: one straight hop, not out to the gutter and back.
  assert.equal(route(world, agent, { x: -286, y: 230 }).length, 2);
  // Dot to dot in two plots stacked in one column: they share a gutter, but not a plot, so the
  // trip goes by the gutter instead of down the dot column across the lower plot's head.
  assert.ok(route(world, { x: 40, y: 220 }, { x: 40, y: 400 }).length > 2);
  // Between columns, the trip uses the lane under This Mac.
  assert.ok(route(world, agent, { x: 30, y: 390 }).some((p) => p.y === LANE_Y));
});
