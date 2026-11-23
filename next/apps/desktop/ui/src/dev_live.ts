import "./style.css";
import "./views";
import { mountForYou } from "./features/foryou";
import type { InboxPost } from "./features/inbox_feed";
import { renderView } from "./registry";
import { mountLive, type LiveAgent, type LiveEmber, type LiveJob, type LiveWorld } from "./features/live";
import type { FleetView } from "./features/fleet";
import type { BoardFeed } from "./features/live_cards";

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

const PLAYS: Record<string, [string, string, string?][]> = {
  "pid:106": [
    ["edit", "Edited live_world.ts", `${ROOT}/panel/ui/src/features/live_world.ts`],
    ["typecheck", "Typecheck the UI"],
    ["build", "Build the Bevy wasm view"],
    ["git.commit", "Commit the new Live map"],
    ["git.push", "Push develop to GitHub"],
    ["edit", "Edited live_scene.ts", `${ROOT}/panel/ui/src/features/live_scene.ts`],
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
    ["read", "Read the fleet news"],
    ["message", "Ask the helpers for their counts"],
    ["message", "Send the new target to Terra"],
    ["search", "Peek at the stuck unit in Tavla"],
    ["think", "Weigh the land and sea numbers"],
    ["cmd.fleet", "Check the fleet reports"],
  ],
  "pid:131": [
    ["read", "Read live_world.ts", `${ROOT}/panel/ui/src/features/live_world.ts`],
    ["review", "Review the Live map diff"],
    ["read", "Read live_scene.ts", `${ROOT}/panel/ui/src/features/live_scene.ts`],
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
  ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`pid:12${i}`, [["search", "Search the timer code"], ["read", "Read sleep_timer.dart", `${ROOT}/pillow_app/lib/sleep_timer.dart`]]])),
};

const agents: LiveAgent[] = [
  agent({
    id: "pid:101", name: "Pişekar", harness: "claude", room: "interbellum", state: "work", panel: "s1", helpers: 0, commander: true,
    task: "Codex map tickets", steps: [step(4, "Read the sun mesh setup", "plan", "read", `${ROOT}/interbellum/docs/art-direction/README.md`)],
    files: [`${ROOT}/interbellum/apps/web/src/map/map_style.css`, `${ROOT}/interbellum/docs/art-direction/README.md`],
    lastText: "Land sits at 70% and sea at 28%. Both are too bright for the B target.",
  }),
  agent({ id: "pid:102", name: "Haiku 9f", harness: "claude", room: "interbellum", state: "work", headless: true, parent: "pid:101", model: "claude-haiku-4-5", via: null, task: "Find every map colour token" }),
  agent({ id: "pid:111", name: "Haiku a3", harness: "claude", room: "interbellum", state: "think", headless: true, parent: "pid:101", model: "claude-haiku-4-5", via: null, task: "Measure the sea", steps: [step(0.3, "Measure the sea lightness", "check", "think")] }),
  agent({ id: "pid:103", name: "Terra 2110", harness: "codex", room: "elsewhere", state: "work", headless: true, via: "fleet", model: "gpt-6.1-terra", issue: 1104, session: "01a1a7f3-2375-7d42-9d3c-c6010a502110", task: "#1104 Interbellum: front line drift at zoom", fleet: { unit: "8d17f4", kind: "terra", scout: null, issues: [{ number: 1104, title: "Interbellum: front line drift at zoom" }], budget: 30, startedMs: min(19), flags: [] } }),
  agent({ id: "pid:141", name: null, harness: "opencode", room: "videokit", state: "think", headless: true, via: "fleet", model: "gemini-3-flash", fleet: { unit: "a832f9", kind: "flash", scout: "legal@VideoKit", issues: [], budget: 30, startedMs: min(12), flags: [] }, steps: [step(0.5, "Read the privacy policy", "check", "read")] }),
  agent({ id: "pid:105", name: "Köroğlu", harness: "claude", room: "videokit", state: "turn", panel: "s2", stateMs: min(6), task: "Zaman makinesi sigara videosu", lastText: "The episode is rendered and passed the judge. It is ready to post today.", steps: [step(6, "Commit and push the due batch", "ship", "git.push")] }),
  agent({ id: "pid:106", name: "Hacivat", harness: "claude", room: "panel", state: "work", panel: "s3", task: "Panel Live map" }),
  agent({ id: "pid:107", name: "Mahmut Hoca", harness: "grok", room: "hq", state: "idle", model: null, via: "Grok Bot", startedMs: min(600) }),
  agent({ id: "pid:108", name: "Sol 77aa", harness: "codex", room: "tavla", state: "stuck", headless: true, via: "fleet", model: "gpt-6.1-sol", stateMs: min(41), now: step(41, "Run the store build", "check", "build"), steps: [step(41, "Run the store build", "check", "build")], issue: 742, task: "#742 Tavla: store build fails", fleet: { unit: "77aa01", kind: "terra", scout: null, issues: [{ number: 742, title: "Tavla: store build fails" }], budget: 30, startedMs: min(44), flags: ["OVER", "STUCK"] } }),
  agent({ id: "pid:109", name: "Karagöz", harness: "claude", room: "tavla", state: "work", panel: "s4", task: "Dice repeat the same roll after a restart" }),
  agent({ id: "pid:110", name: "Zenne", harness: "claude", room: "pillow_app", state: "work", panel: "s5", helpers: 0, task: "Sleep timer forgets its value" }),
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
  { key: "hq", group: "hq", name: "HQ", order: 0, weight: 1 },
  { key: "tavla", group: "games", name: "Tavla", order: 2, weight: 3 },
  { key: "pillow_app", group: "apps", name: "Pillow", order: 5, weight: 2 },
  { key: "videokit", group: "tools", name: "VideoKit", order: 20, weight: 1 },
  { key: "interbellum", group: "games", name: "Interbellum", order: 32, weight: 2 },
  { key: "panel", group: "tools", name: "Panel", order: 33, weight: 1 },
  { key: "home", name: "Home folder", order: 9000, weight: 1 },
  { key: "elsewhere", name: "Elsewhere", order: 9001, weight: 1 },
];


let world: LiveWorld = {
  agents,
  jobs,
  embers,
  rooms,
  mac: { load: 11.2, cores: 14, hot: false, bays: [{ agent: "pid:105", holder: "vk make" }, { agent: null, holder: null }], quota: [{ harness: "Claude", used: 46 }] },
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
function move(): void {
  tick++;
  const now = Date.now();
  const list = world.agents.map((a, i) => {
    const plays = PLAYS[a.id];
    if (!plays || a.state !== "work" || (tick + i) % 3 !== 0) return a;
    const n = Math.floor((tick + i) / 3) % plays.length;
    const [verb, label, file] = plays[n];
    const s = { atMs: now, label, station: "build" as St, verb, file };
    const files = file && verb === "edit" && !a.files.includes(file) ? [file, ...a.files] : a.files;
    const helpers = a.id === "pid:101" ? 2 : a.helpers;
    const ended = a.now ? [{ ...a.now, ok: a.now.label !== "Run the dice tests" }] : [];
    const rest = a.steps.filter((x) => x !== a.now);
    return { ...a, stepCount: a.stepCount + 1, now: s, stateMs: now, steps: [s, ...ended, ...rest].slice(0, 20), files, helpers };
  });
  const bayHolder = list.find((a) => a.now && (a.now.verb === "test" || a.now.verb === "build") && a.state === "work");
  if (now - T > 12_000 && !list.some((a) => a.id === "pid:150"))
    list.push(agent({ id: "pid:150", name: "Flash c0ffee", harness: "opencode", room: "tavla", state: "work", headless: true, via: "fleet", model: "gemini-3-flash", issue: 1172, task: "#1172 Tavla: dice sound plays twice", fleet: { unit: "c0ffee", kind: "flash", scout: null, issues: [{ number: 1172, title: "Tavla: dice sound plays twice" }], budget: 30, startedMs: now, flags: [] }, now: step(0, "Read the sound player", "plan", "read") }));
  world = {
    ...world,
    agents: list,
    mac: { ...world.mac, bays: [world.mac.bays[0], bayHolder ? { agent: bayHolder.id, holder: bayHolder.now!.verb === "test" ? "flutter test" : "vite build" } : { agent: null, holder: null }] },
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

const hm = (m: number) => {
  const d = new Date(min(m));
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const fixtureFleet = (): FleetView => {
  const late = Date.now() - T > 12_000;
  return {
    supervisor: true,
    hold: false,
    spec: "terra:2,flash:1",
    units: [
      { id: "8d17f4", kind: "terra", app: "interbellum", issues: [{ number: 1104, title: "Interbellum: front line drift at zoom" }], minutes: 19, budget: 30, tokens: "4.1M", quiet: 0, flags: [], screen: "• Ran flutter test test/front_line_test.dart\n  └ 00:04 +12: All tests passed!\n\n• Edited lib/map/front_line.dart (+18 -6)\n\n› Explain the shared border path in the commit" },
      { id: "a832f9", kind: "flash", app: "videokit", issues: [], minutes: 12, budget: 30, tokens: "2.2M", quiet: 0, flags: [], screen: "Read docs/privacy.md\nGrep 'tracking' in lib/\n╹▀▀▀▀▀▀▀▀▀\n⬝⬝⬝■■■ esc interrupt" },
      { id: "77aa01", kind: "terra", app: "tavla", issues: [{ number: 742, title: "Tavla: store build fails" }], minutes: 44, budget: 30, tokens: "9.8M", quiet: 14, flags: ["OVER", "STUCK"], screen: "• Running flutter build ipa --release\n  └ Waiting for another flutter command to release the startup lock..." },
      ...(late ? [{ id: "c0ffee", kind: "flash", app: "tavla", issues: [{ number: 1172, title: "Tavla: dice sound plays twice" }], minutes: 0, budget: 30, tokens: "0.1M", quiet: 0, flags: [], screen: "" }] : []),
    ],
    today: [
      ...(late ? [{ time: hm(0), unit: "8d17f4", kind: "terra", app: "-", closed: [1104], minutes: 19, tokens: "4.1M", result: "said bye" }] : []),
      { time: hm(25), unit: "663f9a", kind: "terra", app: "-", closed: [1150], minutes: 5, tokens: "1.4M", result: "said bye" },
      { time: hm(48), unit: "2503b4", kind: "flash", app: "-", closed: [], minutes: 33, tokens: "16.0M", result: "scout discrepancies@Tavla, said bye" },
      { time: hm(70), unit: "420717", kind: "flash", app: "-", closed: [1124, 1125, 1128], minutes: 46, tokens: "20.8M", result: "said bye" },
      { time: hm(95), unit: "d47815", kind: "terra", app: "-", closed: [1127, 1134, 1135, 1136, 1137], minutes: 33, tokens: "21.3M", result: "said bye" },
      { time: hm(120), unit: "1944ee", kind: "sonnet", app: "-", closed: [], minutes: 5, tokens: "3.8M", result: "scout legal@VillagesTown, said bye" },
    ],
  };
};
const readFleet = async () => (params.has("real") ? ((await (await fetch("/fleet.real.json")).json()) as FleetView) : fixtureFleet());
const openUrl = (url: string) => console.log("[live harness] open", url);
const openTerminal = (panel: string) => (console.log("[live harness] terminal", panel), true);
const sendToAgent = async (panel: string, text: string) => (console.log("[live harness] send", panel, text), true);

if (params.has("foryou")) {
  const ago = (min: number) => Date.now() - min * 60_000;
  const post = (id: string, project: string, projectName: string, author: string, agentKind: string, min: number, payload: InboxPost["payload"], flowFiles: string[] = []): InboxPost => ({
    id, project, projectName, author, agentKind, session: `s-${author}`, flowFiles, flowSteps: [], at: ago(min), payload,
  });
  const posts: InboxPost[] = [
    post("p0", "tavla", "Tavla", "Karagöz", "claude", 26 * 60, { title: "Dice physics moved to a fixed timestep", text: "The roll no longer depends on the frame rate. Checked on the iPad at 60 and 120 Hz.", outcome: "done" }),
    post("p1", "tavla", "Tavla", "Karagöz", "claude", 40, {
      title: "Tavla 2.4 build passed and is on TestFlight",
      text: "Build 2.4 (118) is on TestFlight.\n\n- The dice roll freeze on iPad is fixed. The cause was a tween that never ended when two doubles came in a row.\n- The new board theme is behind the `theme_v2` flag, off by default.\n- One test where the bug could come back: `dice_double_roll_test.dart`.\n\nNothing is left for you. The store release waits for your go on the board.",
      outcome: "done",
    }, ["lib/game/dice.dart", "test/dice_double_roll_test.dart"]),
    post("p2", "tavla", "Tavla", "Karagöz", "claude", 38, { title: "Crash on cold start is gone too", text: "It was the same tween. No separate fix.", outcome: "done" }),
    post("p3", "pillow", "Pillow", "Zenne", "codex", 22, {
      title: "Blocked: the rain loop has no licence file",
      text: "I cannot ship `rain_loop.m4a`. The folder has no licence note and the source URL is dead.\n\nTwo ways out:\n1. I render a new loop with the code engine. About ten minutes.\n2. You point me to the licence.\n\nI did the rest of the sound pass meanwhile.",
      outcome: "blocked",
    }),
    post("p4", "panel", "Panel", "Hacivat", "claude", 6, {
      title: "Inbox is a feed now",
      text: "Every message shows whole. A project is a channel. Reading is seeing: no Seen tap.",
      outcome: "done",
      links: [{ url: "https://github.com/example/panel/pull/12", label: "The change" }],
    }),
  ];
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
    posts: () => posts,
    render: (p, openRef) => renderView(p.view ?? "message", p.payload, { openRef, openDocument: async () => {}, finishDocument: async () => "", openPlace: () => {} }),
    renderFlow: () => null,
    changes: async () => [],
    readFile: async () => "",
    openRef: (project, ref) => console.log("[live harness] ref", project, ref),
    openSession: (project, session) => console.log("[live harness] session", project, session),
    isLiveSession: (session) => session !== "s-Zenne",
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
    fleet: readFleet,
    tellCommander: async (words) => (console.log("[live harness] commander", words), true),
  });
  document.getElementById("liveScreen")!.hidden = false;
  live.open();
  if (params.has("select")) {
    setTimeout(() => document.querySelector<HTMLButtonElement>(".unit")?.click(), 600);
  }
}
