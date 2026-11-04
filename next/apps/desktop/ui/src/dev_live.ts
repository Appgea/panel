/**
 * Dev harness for the Live screen. NOT part of the app build — index.html never loads this.
 * It mounts the REAL module (mountLive) against fixture data that changes every few seconds, so
 * the stage, the queue and the playbook can be looked at without Tauri. ?real=1 reads
 * live.real.json (a saved `live_world`) and board.real.json, which are never committed.
 * ?calm=1 shows an empty queue.
 */
import "./style.css";
import { mountLive, type LiveAgent, type LiveEmber, type LiveJob, type LiveWorld } from "./features/live";
import type { BoardFeed } from "./features/live_cards";

const params = new URLSearchParams(location.search);
const T = Date.now();
const min = (m: number) => T - m * 60_000;
const iso = (m: number) => new Date(min(m)).toISOString();

const step = (m: number, label: string, station: "plan" | "build" | "check" | "ship", file?: string) => ({ atMs: min(m), label, station, file });

const agent = (a: Partial<LiveAgent> & Pick<LiveAgent, "id" | "name" | "harness" | "room" | "state">): LiveAgent => ({
  pid: Number(a.id.replace(/\D/g, "")) || null,
  headless: false,
  session: `sess-${a.id}`,
  cwd: "/Users/a/Desktop/projects/appgea-apps",
  roomName: a.room,
  parent: null,
  via: "Terminal",
  startedMs: min(42),
  busy: a.state === "work",
  stateMs: min(1),
  model: "claude-opus-5-5",
  task: null,
  now: null,
  steps: [],
  stepCount: 10,
  lastText: null,
  helpers: 0,
  files: [],
  panel: null,
  issue: null,
  ...a,
});

const agents: LiveAgent[] = [
  agent({
    id: "pid:101", name: "Pişekar", harness: "claude", room: "interbellum", state: "work", panel: "s1", helpers: 2,
    task: "Codex map tickets", now: step(0.4, "Measure land and sea lightness in the Codex mock", "check"), stateMs: min(0.7),
    steps: [step(0.4, "Measure land and sea lightness in the Codex mock", "check"), step(2, "Edited map_style.css", "build", "/Users/a/Desktop/projects/appgea-apps/interbellum/apps/web/src/map/map_style.css"), step(4, "Read the sun mesh setup and the ground grade", "plan"), step(9, "Post the 1162 remaining steps", "ship")],
    files: ["/Users/a/Desktop/projects/appgea-apps/interbellum/apps/web/src/map/map_style.css", "/Users/a/Desktop/projects/appgea-apps/interbellum/docs/art-direction/README.md"],
    lastText: "Land sits at 70% and sea at 28%. Both are too bright for the B target.",
  }),
  agent({ id: "pid:102", name: "Haiku 9f", harness: "claude", room: "interbellum", state: "work", headless: true, parent: "pid:101", model: "claude-haiku-4-5", via: null, now: step(0.2, "Searched the code", "plan"), steps: [step(0.2, "Searched the code", "plan")], task: "Find every map colour token" }),
  agent({ id: "pid:103", name: "Terra 2110", harness: "codex", room: "elsewhere", state: "work", headless: true, via: "fleet", model: "gpt-6.1-terra", issue: 1104, session: "01a1a7f3-2375-7d42-9d3c-c6010a502110", now: step(1, "Step 2 of 4. The drift is still present.", "build"), steps: [step(1, "Step 2 of 4. The drift is still present.", "build"), step(5, "Step 1 of 4. The board assigned #1104.", "plan")] }),
  agent({ id: "pid:104", name: "Terra c17e", harness: "codex", room: "elsewhere", state: "think", headless: true, via: "fleet", model: "gpt-6.1-terra", issue: 1163, steps: [step(0.5, "The baseline measurements are land 70% and sea 28%.", "check")] }),
  agent({ id: "pid:105", name: "Köroğlu", harness: "claude", room: "videokit", state: "turn", panel: "s2", stateMs: min(6), task: "Zaman makinesi sigara videosu", lastText: "The episode is rendered and passed the judge. It is ready to post today.", steps: [step(6, "Commit and push the due batch", "ship"), step(8, "Review the due batch", "check")] }),
  agent({ id: "pid:106", name: "Hacivat", harness: "claude", room: "panel", state: "work", panel: "s3", task: "Panel app Live Observing screen", now: step(0.1, "Rebuild the Bevy wasm view in a test bay", "check"), steps: [step(0.1, "Rebuild the Bevy wasm view in a test bay", "check"), step(1, "Edited live.ts", "build")] }),
  agent({ id: "pid:107", name: "Mahmut Hoca", harness: "grok", room: "hq", state: "idle", model: null, via: "Grok Bot", startedMs: min(600) }),
  agent({ id: "pid:108", name: "Sol 77aa", harness: "codex", room: "tavla", state: "stuck", headless: true, via: "fleet", model: "gpt-6.1-sol", stateMs: min(41), now: step(41, "Run the dice tests", "check"), steps: [step(41, "Run the dice tests", "check")], issue: 742 }),
];

const job = (j: Partial<LiveJob> & Pick<LiveJob, "id" | "label" | "kind" | "room">): LiveJob => ({ pid: Number(j.id.replace(/\D/g, "")), agent: null, startedMs: min(8), cpu: 2, procs: 3, bay: false, roomName: j.room, ...j });
const jobs: LiveJob[] = [
  job({ id: "job:201", label: "vk make", kind: "job", room: "videokit", agent: "pid:105", cpu: 398, procs: 27, bay: true }),
  job({ id: "job:202", label: "node shoot.mjs", kind: "job", room: "elsewhere", agent: "pid:103", bay: true, startedMs: min(3) }),
  job({ id: "job:203", label: "fleet", kind: "launcher", room: "hq", startedMs: min(21) }),
  job({ id: "job:204", label: "bridge.py", kind: "service", room: "hq", startedMs: min(8000) }),
  job({ id: "job:205", label: "slack-listen.py", kind: "service", room: "hq", startedMs: min(1700) }),
  job({ id: "job:206", label: "chrome-headless-shell", kind: "left", room: "videokit", startedMs: min(71), cpu: 0, procs: 16 }),
];

const ember = (e: Partial<LiveEmber> & Pick<LiveEmber, "id" | "room">): LiveEmber => ({
  name: "Terra 0a51", harness: "codex", headless: true, roomName: e.room, model: "gpt-6.1-terra", session: null, cwd: "", task: null,
  result: "Released #1162 with the unfinished HUD changes recorded.", outcome: "finished", files: [], steps: [step(30, "Released #1162", "ship")], stepCount: 46,
  parentName: null, via: "fleet", startedMs: min(70), endedMs: min(25), ...e,
});
const embers: LiveEmber[] = [
  ember({ id: "pid:90@1", room: "interbellum", endedMs: min(12) }),
  ember({ id: "pid:91@1", room: "interbellum", name: "Terra 8840", endedMs: min(48), result: "Air borders now use the thin dashed stroke." }),
  ember({ id: "pid:92@1", room: "tavla", name: "Sol 31bc", outcome: "cut", result: null, endedMs: min(90) }),
  ember({ id: "pid:93@1", room: "pillow_app", name: "Haiku 12", harness: "claude", model: "claude-haiku-4-5", endedMs: min(200), result: "Sleep timer survives a background kill." }),
  ember({ id: "pid:94@1", room: "pillow_app", name: "Haiku 13", harness: "claude", model: "claude-haiku-4-5", endedMs: min(260) }),
];

const rooms = [
  { key: "hq", name: "HQ", order: 0, weight: 1 },
  { key: "tavla", name: "Tavla", order: 2, weight: 3 },
  { key: "pillow_app", name: "Pillow", order: 5, weight: 2 },
  { key: "videokit", name: "VideoKit", order: 20, weight: 1 },
  { key: "interbellum", name: "Interbellum", order: 32, weight: 2 },
  { key: "panel", name: "Panel", order: 33, weight: 1 },
  { key: "home", name: "Home folder", order: 9000, weight: 1 },
  { key: "elsewhere", name: "Elsewhere", order: 9001, weight: 1 },
];

let world: LiveWorld = {
  agents,
  jobs,
  embers,
  rooms,
  mac: { load: 11.2, cores: 14, hot: false, bays: [{ agent: "pid:105", holder: "vk make" }, { agent: "pid:103", holder: "node shoot.mjs" }] },
  scannedMs: T,
};

const fixtureBoard: BoardFeed = {
  you: params.has("calm") ? [] : [
    { number: 1170, title: "Tavla Plus: monthly price", url: "https://github.com/Appgea/ops/issues/1170", apps: ["tavla"], ask: "Tavla Plus aylık fiyatı ne olsun?", options: ["₺99", "₺79", "₺129"], why: "The paywall test needs one price before it ships on Friday.", created_at: iso(40) },
    { number: 1171, title: "VideoKit: post the cigarette episode today", url: "https://github.com/Appgea/ops/issues/1171", apps: ["videokit"], ask: "Sigara bölümü bugün yayınlansın mı?", options: ["Evet, bugün", "Yarın sabah"], created_at: iso(15) },
  ],
  now: [
    { number: 1104, title: "Interbellum: front line drift at zoom", url: "https://github.com/Appgea/ops/issues/1104", apps: ["interbellum"], holder: "codex-0a502110", decided: "The front follows the shared border path, because tile centres drift at low zoom", created_at: iso(300) },
    { number: 742, title: "Pillow: sleep timer forgets its value", url: "https://github.com/Appgea/ops/issues/742", apps: ["tavla"] },
  ],
  ready: [
    { number: 1160, title: "Speed: typecheck reruns the whole workspace on one-file edits", url: "https://github.com/Appgea/ops/issues/1160", apps: ["interbellum"], kinds: ["speed"], problem: "Each edit re-typechecks 40 packages, about 90 s.", direction: "Typecheck only the changed package and its dependants.", created_at: iso(180) },
  ],
  done: params.has("calm") ? [] : [
    { number: 1150, title: "Interbellum: darker overhead map, B target", url: "https://github.com/Appgea/ops/issues/1150", apps: ["interbellum"], closed_at: iso(30) },
    { number: 1151, title: "Interbellum: HUD slides in at 100 ms", url: "https://github.com/Appgea/ops/issues/1151", apps: ["interbellum"], closed_at: iso(55) },
    { number: 1140, title: "Tavla: dice sound clips on older iPhones", url: "https://github.com/Appgea/ops/issues/1140", apps: ["tavla"], closed_at: iso(80) },
  ],
  apps: { tavla: { name: "Tavla" }, interbellum: { name: "Interbellum" }, videokit: { name: "VideoKit" }, pillow_app: { name: "Pillow" } },
};

const labels = ["Edited map_style.css", "Run the map shots at two sizes", "Read the art direction", "Commit the darker map", "Measure land and sea lightness"];
let tick = 0;
/** Every few seconds the fixture world moves: steps advance, a worker ends, a new one starts. */
function move(): void {
  tick++;
  const now = Date.now();
  const next = world.agents.map((a) => {
    if (a.state !== "work") return a;
    const label = labels[(tick + a.stepCount) % labels.length];
    const st = label.startsWith("Commit") ? "ship" : label.startsWith("Edited") ? "build" : label.startsWith("Run") || label.startsWith("Measure") ? "check" : "plan";
    const s = { atMs: now, label, station: st as "plan" };
    return { ...a, stepCount: a.stepCount + 1, now: s, stateMs: now, steps: [s, ...a.steps].slice(0, 20) };
  });
  let endedEmbers = world.embers;
  let list = next;
  if (tick % 5 === 0) {
    const gone = list.find((a) => a.id === "pid:102");
    if (gone) {
      list = list.filter((a) => a !== gone);
      endedEmbers = [{ ...ember({ id: `${gone.id}@${now}`, room: "interbellum" }), name: gone.name, harness: "claude", model: gone.model, endedMs: now, result: "Found 14 colour tokens in three files." }, ...endedEmbers];
    } else {
      list = [...list, agent({ id: "pid:102", name: "Haiku 9f", harness: "claude", room: "interbellum", state: "work", headless: true, parent: "pid:101", model: "claude-haiku-4-5", via: null, startedMs: now, now: step(0, "Searched the code", "plan") })];
    }
  }
  world = { ...world, agents: list, embers: endedEmbers, scannedMs: now };
}

async function realWorld(): Promise<LiveWorld> {
  const r = await fetch("/live.real.json");
  return (await r.json()) as LiveWorld;
}

const live = mountLive(document.getElementById("liveScreen")!, {
  world: async () => {
    if (params.has("real")) return realWorld();
    move();
    return world;
  },
  board: async () => (params.has("real") ? ((await (await fetch("/board.real.json")).json()) as BoardFeed) : fixtureBoard),
  answer: async (body) => {
    console.log("[live harness] answer", body);
    fixtureBoard.you = (fixtureBoard.you ?? []).filter((i) => i.number !== body.number);
    return { ok: true, said: `#${body.number}: recorded` };
  },
  picture: async () => "",
  openUrl: (url) => console.log("[live harness] open", url),
  openTerminal: (panel) => (console.log("[live harness] terminal", panel), true),
  sendToAgent: async (panel, text) => (console.log("[live harness] send", panel, text), true),
  seedManager: async (text) => console.log("[live harness] manager", text),
  openFile: (path) => console.log("[live harness] file", path),
  openHistory: (session) => console.log("[live harness] history", session),
  stop: async (pid) => console.log("[live harness] stop", pid),
});
document.getElementById("liveScreen")!.hidden = false;
live.open();
if (params.has("select")) {
  setTimeout(() => (document.querySelector<HTMLButtonElement>(".live-hit")?.click()), 600);
}
