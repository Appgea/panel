/**
 * Dev harness for the Live screen. NOT part of the app build — index.html never loads this.
 * It mounts the REAL module (mountLive) against fixture data that changes every few seconds, so
 * the map, the scripts and the card can be looked at without Tauri. ?real=1 reads
 * live.real.json (a saved `live_world`) and board.real.json, which are never committed.
 * ?calm=1 shows an empty queue. The catalog is the seed scripts, as on a first run.
 *
 * The fixture plays the three scenes the owner asked for: Hacivat ships Panel with a git push,
 * Karagöz hunts a bug in Tavla, and Pişekar orchestrates helpers in Interbellum. Zenne's eight
 * helpers in Pillow show a swarm.
 */
import "./style.css";
import { mountForYou } from "./features/foryou";
import { mountLive, type LiveAgent, type LiveEmber, type LiveJob, type LiveWorld } from "./features/live";
import type { BoardFeed } from "./features/live_cards";
import type { Script } from "./features/live_script";
import seeds from "./features/live_seeds.json";

const params = new URLSearchParams(location.search);
const T = Date.now();
const min = (m: number) => T - m * 60_000;
const iso = (m: number) => new Date(min(m)).toISOString();
const ROOT = "/Users/a/Desktop/projects/appgea-apps";

type St = "plan" | "build" | "check" | "ship";
const step = (m: number, label: string, station: St, verb: string, file?: string) => ({ atMs: min(m), label, station, verb, file });

const agent = (a: Partial<LiveAgent> & Pick<LiveAgent, "id" | "name" | "harness" | "room" | "state">): LiveAgent => ({
  pid: Number(a.id.replace(/\D/g, "")) || null,
  headless: false,
  session: `sess-${a.id}`,
  cwd: ROOT,
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

/** What each working fixture agent does, in a loop: verb, words, file. */
const PLAYS: Record<string, [string, string, string?][]> = {
  "pid:106": [
    ["edit", "Edited live_world.ts", `${ROOT}/panel/ui/src/features/live_world.ts`],
    ["typecheck", "Typecheck the UI"],
    ["build", "Build the Bevy wasm view"],
    ["git.commit", "Commit the new Live map"],
    ["git.push", "Push develop to GitHub"],
    ["read", "Read live_scene.ts", `${ROOT}/panel/ui/src/features/live_scene.ts`],
  ],
  "pid:109": [
    ["search", "Search for the dice roll seed"],
    ["read", "Read dice.dart", `${ROOT}/tavla/lib/game/dice.dart`],
    ["test", "Run the dice tests"],
    ["edit", "Edited dice.dart", `${ROOT}/tavla/lib/game/dice.dart`],
    ["test", "Run the dice tests again"],
    ["git.push", "Push the dice fix"],
  ],
  "pid:101": [
    ["spawn", "Start two helpers for the map colours"],
    ["message", "Ask the helpers for their counts"],
    ["think", "Weigh the land and sea numbers"],
    ["board", "Claim #1163 on the board"],
    ["message", "Send the new target to Terra"],
  ],
  "pid:102": [
    ["search", "Search for map colour tokens"],
    ["read", "Read map_style.css", `${ROOT}/interbellum/apps/web/src/map/map_style.css`],
  ],
  "pid:103": [
    ["web", "Read the MapLibre docs on line dashes"],
    ["edit", "Edited front_line.ts", `${ROOT}/interbellum/apps/web/src/map/front_line.ts`],
    ["shot", "Shoot the map at two sizes"],
  ],
  "pid:110": [
    ["search", "Search the sleep timer code"],
    ["message", "Collect the helpers' findings"],
    ["render", "Render the sleep timer clip"],
  ],
};

const agents: LiveAgent[] = [
  agent({
    id: "pid:101", name: "Pişekar", harness: "claude", room: "interbellum", state: "work", panel: "s1", helpers: 0,
    task: "Codex map tickets", steps: [step(4, "Read the sun mesh setup", "plan", "read", `${ROOT}/interbellum/docs/art-direction/README.md`)],
    files: [`${ROOT}/interbellum/apps/web/src/map/map_style.css`, `${ROOT}/interbellum/docs/art-direction/README.md`],
    lastText: "Land sits at 70% and sea at 28%. Both are too bright for the B target.",
  }),
  agent({ id: "pid:102", name: "Haiku 9f", harness: "claude", room: "interbellum", state: "work", headless: true, parent: "pid:101", model: "claude-haiku-4-5", via: null, task: "Find every map colour token" }),
  agent({ id: "pid:111", name: "Haiku a3", harness: "claude", room: "interbellum", state: "think", headless: true, parent: "pid:101", model: "claude-haiku-4-5", via: null, task: "Measure the sea", steps: [step(0.3, "Measure the sea lightness", "check", "think")] }),
  agent({ id: "pid:103", name: "Terra 2110", harness: "codex", room: "elsewhere", state: "work", headless: true, via: "fleet", model: "gpt-6.1-terra", issue: 1104, session: "01a1a7f3-2375-7d42-9d3c-c6010a502110" }),
  agent({ id: "pid:105", name: "Köroğlu", harness: "claude", room: "videokit", state: "turn", panel: "s2", stateMs: min(6), task: "Zaman makinesi sigara videosu", lastText: "The episode is rendered and passed the judge. It is ready to post today.", steps: [step(6, "Commit and push the due batch", "ship", "git.push")] }),
  agent({ id: "pid:106", name: "Hacivat", harness: "claude", room: "panel", state: "work", panel: "s3", task: "Panel Live map" }),
  agent({ id: "pid:107", name: "Mahmut Hoca", harness: "grok", room: "hq", state: "idle", model: null, via: "Grok Bot", startedMs: min(600) }),
  agent({ id: "pid:108", name: "Sol 77aa", harness: "codex", room: "tavla", state: "stuck", headless: true, via: "fleet", model: "gpt-6.1-sol", stateMs: min(41), now: step(41, "Run the store build", "check", "build"), steps: [step(41, "Run the store build", "check", "build")], issue: 742 }),
  agent({ id: "pid:109", name: "Karagöz", harness: "claude", room: "tavla", state: "work", panel: "s4", task: "Dice repeat the same roll after a restart" }),
  agent({ id: "pid:110", name: "Zenne", harness: "claude", room: "pillow_app", state: "work", panel: "s5", helpers: 0, task: "Sleep timer forgets its value" }),
  // Background runs named the way Claude names them, which say nothing: Live must say what they are.
  agent({ id: "pid:131", name: "cardly-e7", harness: "claude", room: "panel", state: "work", headless: true, via: null, model: "claude-sonnet-5-5", task: "You review a diff before it is pushed. Report only. You never edit, commit or push.", now: step(0.2, "Read live_world.ts", "check", "read", `${ROOT}/panel/ui/src/features/live_world.ts`) }),
  agent({ id: "pid:132", name: "Tuzsuz Deli Bekir", harness: "claude", room: "panel", state: "work", headless: true, via: "Appgea Panel", model: "claude-sonnet-5-5", task: "You write one animation script for Panel Live, a dark map where coding agents are small glowing electrons." }),
  ...Array.from({ length: 8 }, (_, i) =>
    agent({ id: `pid:12${i}`, name: `Haiku ${(i + 10).toString(16)}`, harness: "claude", room: "pillow_app", state: "work", headless: true, parent: "pid:110", model: "claude-haiku-4-5", via: null, now: step(0.1, "Search the timer code", "plan", "search") }),
  ),
];

const job = (j: Partial<LiveJob> & Pick<LiveJob, "id" | "label" | "kind" | "room">): LiveJob => ({ pid: Number(j.id.replace(/\D/g, "")), agent: null, startedMs: min(8), cpu: 2, procs: 3, bay: false, roomName: j.room, ...j });
const jobs: LiveJob[] = [
  job({ id: "job:201", label: "vk make", kind: "job", room: "videokit", agent: "pid:105", cpu: 398, procs: 27, bay: true }),
  job({ id: "job:203", label: "fleet", kind: "launcher", room: "hq", startedMs: min(21) }),
  job({ id: "job:206", label: "chrome-headless-shell", kind: "left", room: "videokit", startedMs: min(71), cpu: 0, procs: 16 }),
];

const ember = (e: Partial<LiveEmber> & Pick<LiveEmber, "id" | "room">): LiveEmber => ({
  name: "Terra 0a51", harness: "codex", headless: true, roomName: e.room, model: "gpt-6.1-terra", session: null, cwd: "", task: null,
  result: "Released #1162 with the unfinished HUD changes recorded.", outcome: "done", files: [], steps: [step(30, "Released #1162", "ship", "release")], stepCount: 46,
  parentName: null, via: "fleet", startedMs: min(70), endedMs: min(25), ...e,
});
const embers: LiveEmber[] = [
  ember({ id: "pid:90@1", room: "interbellum", endedMs: min(12) }),
  ember({ id: "pid:91@1", room: "interbellum", name: "Terra 8840", endedMs: min(48), result: "Air borders now use the thin dashed stroke." }),
  ember({ id: "pid:92@1", room: "tavla", name: "Sol 31bc", outcome: "crashed", result: null, endedMs: min(90) }),
  ember({ id: "pid:93@1", room: "pillow_app", name: "Haiku 12", harness: "claude", model: "claude-haiku-4-5", endedMs: min(200), result: "Sleep timer survives a background kill." }),
  ember({ id: "pid:94@1", room: "panel", name: "cmd-style-drift-80", harness: "claude", model: "claude-sonnet-5-5", via: "Appgea Panel", task: "You write one animation script for Panel Live, a dark map where coding agents are small glowing electrons.", endedMs: min(3), result: "Wrote the cmd.magick script." }),
  ember({ id: "pid:95@1", room: "interbellum", name: "interbellum-43", harness: "claude", model: "claude-sonnet-5-5", via: null, task: "You review a diff before it is pushed. Report only. You never edit, commit or push.", endedMs: min(8), result: "No findings. The batch is clean." }),
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

const catalog: Script[] = [...Object.entries(seeds as Record<string, Omit<Script, "verb">>).map(([verb, x]) => ({ verb, ...x, madeMs: min(30) })), { verb: "cmd.magick", pending: true }];

let world: LiveWorld = {
  agents,
  jobs,
  embers,
  rooms,
  mac: { load: 11.2, cores: 14, hot: false, bays: [{ agent: "pid:105", holder: "vk make" }, { agent: null, holder: null }], quota: [{ harness: "Claude", used: 46 }] },
  catalog,
  scannedMs: T,
};

const fixtureBoard: BoardFeed = {
  you: params.has("calm") ? [] : [
    { number: 1170, title: "Tavla Plus: monthly price", url: "https://github.com/Appgea/ops/issues/1170", apps: ["tavla"], ask: "Tavla Plus aylık fiyatı ne olsun?", options: ["₺99", "₺79", "₺129"], why: "The paywall test needs one price before it ships on Friday.", created_at: iso(40) },
    { number: 1171, title: "VideoKit: post the cigarette episode today", url: "https://github.com/Appgea/ops/issues/1171", apps: ["videokit"], ask: "Sigara bölümü bugün yayınlansın mı?", options: ["Evet, bugün", "Yarın sabah"], created_at: iso(15) },
  ],
  now: [
    { number: 1104, title: "Interbellum: front line drift at zoom", url: "https://github.com/Appgea/ops/issues/1104", apps: ["interbellum"], holder: "codex-0a502110", decided: "The front follows the shared border path, because tile centres drift at low zoom", created_at: iso(300) },
    { number: 742, title: "Tavla: store build fails", url: "https://github.com/Appgea/ops/issues/742", apps: ["tavla"] },
  ],
  ready: [
    { number: 1160, title: "Speed: typecheck reruns the whole workspace on one-file edits", url: "https://github.com/Appgea/ops/issues/1160", apps: ["interbellum"], kinds: ["speed"], problem: "Each edit re-typechecks 40 packages, about 90 s.", direction: "Typecheck only the changed package and its dependants.", created_at: iso(180) },
  ],
  done: params.has("calm") ? [] : [
    { number: 1150, title: "Interbellum: darker overhead map, B target", url: "https://github.com/Appgea/ops/issues/1150", apps: ["interbellum"], closed_at: iso(30) },
  ],
  apps: { tavla: { name: "Tavla" }, interbellum: { name: "Interbellum" }, videokit: { name: "VideoKit" }, pillow_app: { name: "Pillow" } },
};

let tick = 0;
/** Every poll some agents start their next step, so scripts keep playing. */
function move(): void {
  tick++;
  const now = Date.now();
  const list = world.agents.map((a, i) => {
    const plays = PLAYS[a.id];
    // A step lasts about three polls, staggered so the map never plays all at once.
    if (!plays || a.state !== "work" || (tick + i) % 3 !== 0) return a;
    const n = Math.floor((tick + i) / 3) % plays.length;
    const [verb, label, file] = plays[n];
    const s = { atMs: now, label, station: "build" as St, verb, file };
    const files = file && !a.files.includes(file) ? [file, ...a.files] : a.files;
    const helpers = a.id === "pid:101" ? 2 : a.helpers;
    return { ...a, stepCount: a.stepCount + 1, now: s, stateMs: now, steps: [s, ...a.steps].slice(0, 20), files, helpers };
  });
  const bayHolder = list.find((a) => a.now && (a.now.verb === "test" || a.now.verb === "build") && a.state === "work");
  world = {
    ...world,
    agents: list,
    mac: { ...world.mac, bays: [world.mac.bays[0], bayHolder ? { agent: bayHolder.id, holder: bayHolder.now!.verb === "test" ? "flutter test" : "build-live.mjs" } : { agent: null, holder: null }] },
    scannedMs: now,
  };
}

async function realWorld(): Promise<LiveWorld> {
  const r = await fetch("/live.real.json");
  return (await r.json()) as LiveWorld;
}

const readWorld = async () => {
  if (params.has("real")) return realWorld();
  move();
  return world;
};
const readBoard = async () => (params.has("real") ? ((await (await fetch("/board.real.json")).json()) as BoardFeed) : fixtureBoard);
const openUrl = (url: string) => console.log("[live harness] open", url);
const openTerminal = (panel: string) => (console.log("[live harness] terminal", panel), true);
const sendToAgent = async (panel: string, text: string) => (console.log("[live harness] send", panel, text), true);

// ?foryou=1 shows the Inbox instead of the map, with one of each source it folds in.
if (params.has("foryou")) {
  const ago = (min: number) => Date.now() - min * 60_000;
  const fy = mountForYou(document.getElementById("forYouScreen")!, {
    world: readWorld,
    board: readBoard,
    answer: async (body) => {
      console.log("[live harness] answer", body);
      fixtureBoard.you = (fixtureBoard.you ?? []).filter((i) => i.number !== body.number);
      return { ok: true, said: `#${body.number}: recorded` };
    },
    picture: async () => "",
    openUrl,
    openTerminal,
    sendToAgent,
    reports: () => [
      { id: "p1", project: "tavla", title: "Tavla 2.4 build passed and is on TestFlight", at: ago(40) },
      { id: "p2", project: "tavla", title: "Fixed the dice roll freeze on iPad", at: ago(25) },
    ],
    review: () => [{ project: "pillow", items: [{ path: "/tmp/pillow/room_night.png", kind: "image", at: ago(15) }, { path: "/tmp/pillow/rain_loop.m4a", kind: "audio", at: ago(14) }] }],
    support: async () => ({
      problem: "",
      items: [
        { id: "s1", app: "tavla", subject: "The game freezes after I roll doubles twice in a row", email: "player@example.com", form: "Tavla support", fields: [{ q: "What happened?", a: "The game freezes after I roll doubles twice in a row" }, { q: "Device", a: "iPad Air" }], at: ago(90) },
      ],
    }),
    ended: async () => ({ floor: ago(24 * 60), items: [{ id: "h1", project: "panel", agent: "Claude", title: "Panel Live shows only activity", at: ago(50), resumable: true }, { id: "h2", project: "panel", agent: "Codex", title: "Review the live map labels", at: ago(35), resumable: false }] }),
    projectName: (id) => ({ tavla: "Tavla", pillow: "Pillow", panel: "Panel" })[id] ?? null,
    pictureSrc: () => "",
    openReview: async (project, paths) => (console.log("[live harness] review", project, paths), true),
    openReport: (post) => console.log("[live harness] report", post),
    resume: async (session) => console.log("[live harness] resume", session),
    openSupport: () => console.log("[live harness] support"),
    seen: (card) => console.log("[live harness] seen", card.id),
    count: (n) => console.log("[live harness] count", n),
  });
  document.getElementById("forYouScreen")!.hidden = false;
  fy.open();
} else {
  const live = mountLive(document.getElementById("liveScreen")!, {
    world: readWorld,
    board: readBoard,
    openUrl,
    openTerminal,
    sendToAgent,
    openFile: (path) => console.log("[live harness] file", path),
    openHistory: (session) => console.log("[live harness] history", session),
    stop: async (pid) => console.log("[live harness] stop", pid),
    deleteAnimation: async (verb) => {
      world = { ...world, catalog: (world.catalog ?? []).filter((x) => x.verb !== verb) };
    },
  });
  document.getElementById("liveScreen")!.hidden = false;
  live.open();
  if (params.has("select")) {
    setTimeout(() => document.querySelector<HTMLButtonElement>(".live-agent")?.click(), 600);
  }
}
