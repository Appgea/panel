import assert from "node:assert/strict";
import test from "node:test";
import { src } from "./load.mjs";

const { newHeard, talk } = await src("features/live_talk.ts");

const agent = (id, extra = {}) => ({ id, name: null, roomName: "Panel", parent: null, files: [], steps: [], now: null, helpers: 0, state: "work", ...extra });
const unit = (id, kind, room, extra = {}) => agent(id, { roomName: room, fleet: { unit: id, kind, scout: null, issues: [], budget: 30, startedMs: 0, flags: [] }, ...extra });
const at = (a, verb, label, ms, file) => ({ ...a, now: { atMs: ms, label, station: "build", verb, file } });
const pairs = (r) => r.talks.map((t) => `${t.kind} ${t.from}>${t.to}${t.tag ? ` ${t.tag}` : ""}`);

test("talk comes only from new steps, and goes to the agents the words name", () => {
  const heard = newHeard();
  const boss = agent("boss", { name: "Hacivat", commander: true });
  const tavla = at(unit("u1", "terra", "Tavla", { fleet: { unit: "u1", kind: "terra", scout: null, issues: [], budget: 30, startedMs: 0, flags: ["OVER"] } }), "edit", "Edited dice.dart", 1.6);
  const memor = at(unit("u2", "flash", "Memor"), "test", "Ran the tests", 1.5);
  const idle = unit("u4", "sonnet", "Hayrola");
  const writer = agent("w", { name: "Karagöz", files: ["/a/live_world.ts"] });
  const reader = agent("r");
  const lead = agent("lead", { name: "Zenne" });
  const kid = agent("kid", { parent: "lead" });

  // The first look only remembers, whatever the steps say.
  assert.deepEqual(pairs(talk([at(boss, "read", "Read the fleet news", 1), tavla, memor, idle, writer, reader, lead, kid], heard, [])), []);

  // The commander reads the news: the units that did something since its last look report, newest first. A reader opens what another wrote: a handoff.
  let r = talk([at(boss, "read", "Read the fleet news", 2), tavla, memor, idle, writer, at(reader, "read", "Read live_world.ts", 2, "/a/live_world.ts"), lead, kid], heard, []);
  assert.deepEqual(pairs(r), ["report u1>boss", "report u2>boss", "handoff w>r live_world.ts"]);

  // Named by project, by class, or as over budget: a look while it reads, an order while it writes.
  r = talk([at(boss, "search", "Peek at the over-budget scout", 3), tavla, memor, idle, writer, reader, lead, kid], heard, []);
  assert.deepEqual(pairs(r), ["look boss>u1"]);
  r = talk([at(boss, "message", "Send the new target to Flash", 4), tavla, memor, idle, writer, reader, at(lead, "message", "Ask the helpers for counts", 4), kid], heard, []);
  assert.deepEqual(pairs(r), ["order boss>u2", "order lead>kid"]);

  // A unit the fleet starts gets its orders with its issue. A result reports to whom it answers to.
  const fresh = unit("u3", "flash", "Tavla", { fleet: { unit: "u3", kind: "flash", scout: null, issues: [{ number: 1172, title: "x" }], budget: 30, startedMs: 0, flags: [] } });
  r = talk([boss, tavla, memor, idle, writer, reader, lead, kid, fresh], heard, [{ agentId: "kid", ok: true }, { agentId: "u2", ok: false }]);
  assert.deepEqual(pairs(r), ["order boss>u3 #1172", "report kid>lead", "report u2>boss"]);
  // A slack message names nobody on the map: no talk. A message to another session names it.
  r = talk([boss, tavla, memor, idle, writer, reader, at(lead, "message", "Post the release note to Slack", 5), kid, fresh], heard, []);
  assert.deepEqual(pairs(r), []);
  r = talk([boss, tavla, memor, idle, writer, at(reader, "message", "Messaged Zenne", 6), lead, kid, fresh], heard, []);
  assert.deepEqual(pairs(r), ["order r>lead"]);
});
