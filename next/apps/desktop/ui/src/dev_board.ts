/**
 * Dev harness for the Board screen. NOT part of the app build — index.html never
 * loads this. It mounts the REAL module (mountBoard) against fixture data and a stub extension,
 * so the screen can be looked at without Tauri. ?empty=1 shows a quiet board. ?real=1 reads
 * board.real.json, a saved `board json` that is never committed.
 */
import "./style.css";
import "./motion.css";
import { mountBoard, type BoardApi, type BoardCard, type BoardData, type DoneCard } from "./features/board";
import type { ReviewCard, ReviewDeck, ReviewHistory } from "./features/swipe";

const params = new URLSearchParams(location.search);
const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();
const at = (days: number, hour: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};
const url = (n: number): string => `https://github.com/Appgea/ops/issues/${n}`;

const closes = (): DoneCard[] => {
  const titles = ["Tavla: dice sound clips on older iPhones", "Speed: board json reads closed issues in parallel", "Pillow: rain category in sleep sounds",
    "Weekcut export drops the last caption", "Interbellum: map labels overlap at small zoom", "Panel: board refresh is slow", "videokit: read stayed-to-watch by API"];
  const apps = [["tavla"], [], ["pillow_app"], ["weekcut"], ["interbellum"], ["panel"], ["videokit"]];
  const out: DoneCard[] = [];
  // A steady two weeks with a quiet day nine days back, so the bars and the streak both show something.
  for (let back = 13; back >= 0; back--) {
    if (back === 9) continue;
    for (let k = 0; k < ((back * 7) % 5) + 1; k++) {
      const n = 900 - back * 10 - k;
      out.push({ number: n, title: titles[n % 7], url: url(n), apps: apps[n % 7], priority: 2, closed_at: ago(back * 1440 + k * 37 + 5),
        estimate: n % 3 ? 10 + (n % 6) * 10 : undefined, dropped: n % 11 === 0 });
    }
  }
  return out.sort((a, b) => (b.closed_at ?? "").localeCompare(a.closed_at ?? ""));
};

const READY: BoardCard[] = [
  { number: 742, title: "Pillow: the sleep timer forgets its value after a background kill", url: url(742), apps: ["pillow_app"], priority: 0, estimate: 30,
    problem: "Set a 30 min timer, lock the phone, and iOS kills the app: the sound keeps playing all night.", why: "Two one-star reviews this week name it.",
    goals: [{ goal: "The timer survives a kill", check: "flutter test test/timer_restore_test.dart" }], confidence: 95 },
  { number: 709, title: "Interbellum: better tiles, and front lines that run whole along a border", url: url(709), apps: ["interbellum"], priority: 1, estimate: 90,
    problem: "The map's tiles are hard to read and too many. Some tiles are in several pieces or sit inside another tile.",
    why: "The map is the game. A player who cannot read the tiles cannot plan a war.",
    goals: [{ goal: "No tile is in two land pieces", check: "python3 tools/tile_audit.py --pieces" }, { goal: "A front line runs unbroken along every border", check: "vk shot map --front" }, { goal: "Tile names read at a glance at the default zoom" }],
    direction: "Merge enclaves into their host tile. Draw the front from the shared border path, not from tile centres. Keep the save format.",
    confidence: 85, run_with: "sonnet", created_at: ago(3 * 1440) },
  { number: 28, title: "Portfolio-wide consent compliance", url: url(28), apps: [], priority: 1, estimate: 60,
    problem: "Three apps ask for tracking before they show the consent screen.", why: "A store reviewer can reject on it, and EU users are owed the choice first.",
    goals: [{ goal: "Every app shows consent before the first tracked event", check: "`rg -n 'logEvent' lib/` runs after `consent.ready`" }], confidence: 62, created_at: ago(9 * 1440) },
  { number: 40, title: "Set up RevenueCat entitlements and offerings for Tavla", url: url(40), apps: ["tavla"], priority: 1, kinds: ["redesign"], estimate: 45,
    problem: "Tavla sells one product with no entitlement, so a restore on a new phone gives nothing.", goals: [{ goal: "Restore on a fresh simulator unlocks the board pack" }], created_at: ago(2 * 1440) },
  { number: 731, title: "Speed: review loop", url: url(731), apps: [], priority: 2, kinds: ["speed"], problem: "review loop", estimate: 20, created_at: ago(300) },
  { number: 66, title: "Write the app kit standards the weekly beat checks", url: url(66), apps: [], priority: 3, created_at: ago(20 * 1440) },
];

const BOARD: BoardData = params.get("empty")
  ? { repo: "Appgea/ops", open: 0, now: [], you: [], ready: [], waiting: [], done: [] }
  : {
    repo: "Appgea/ops",
    at: ago(2),
    open: 14,
    apps: {
      panel: { name: "Appgea Panel", dir: "panel" }, tavla: { name: "Tavla", dir: "Tavla" }, pillow_app: { name: "Pillow", dir: "pillow_app" },
      interbellum: { name: "Interbellum", dir: "interbellum" }, weekcut: { name: "Weekcut", dir: "weekcut" }, videokit: { name: "VideoKit", dir: "videokit" },
    },
    now: [
      { number: 67, title: "Panel: scouts and the board, visible all the time", url: url(67), apps: ["panel"], priority: 2, holder: "claude-e9aca641", claimed_at: ago(48), estimate: 30,
        problem: "The board hides who holds what.", goals: [{ goal: "The board shows every holder" }] },
      { number: 20, title: "Tavla Android crash: game screen reads a provider after the widget is unmounted", url: url(20), apps: ["tavla"], priority: 0, holder: "codex-3f1c02aa", claimed_at: ago(12), estimate: 40,
        problem: "Leaving a match mid-move crashes on Android 14.", why: "It is the top Android crash: 31% of crash-free-user loss last week." },
      { number: 42, title: "Bear-off animation sometimes flies to wrong tiles", url: url(42), apps: ["tavla"], priority: 1, holder: "grok-tavla", claimed_at: ago(4) },
      ...(params.get("many")
        ? [
          { number: 55, title: "Weekcut export drops the last caption", url: url(55), apps: ["weekcut"], priority: 1, holder: "sol-weekcut", claimed_at: ago(95) },
          { number: 71, title: "Pillow paywall flashes before the entitlement loads", url: url(71), apps: ["pillow_app"], priority: 1, holder: "claude-77ab", claimed_at: ago(20) },
          { number: 88, title: "Trender slideshow audio drifts", url: url(88), apps: [], priority: 1, holder: "luna-trender", claimed_at: ago(7) },
        ]
        : []),
    ],
    you: [
      { number: 60, title: "Revoke App Store Connect key 6GHLN3V5DS, it is tracked in two repos", url: url(60), apps: [], priority: 1,
        ask: "Revoke the key in App Store Connect. The new one is already in the keychain.", problem: "An old API key sits in two repos' history." },
      { number: 31, title: "Pillow: choose the paywall layout", url: url(31), apps: ["pillow_app"], priority: 1, ask: "Bu satın alma ekranıyla devam edelim mi?", show: ["paywall"], confidence: 60 },
    ],
    ready: READY,
    next: READY.slice(0, 5),
    waiting: [
      { number: 215, title: "Tavla: ship 1.9.3 with the bear-off fix", url: url(215), apps: ["tavla"], priority: 1, after: [42], estimate: 25 },
      { number: 333, title: "Check the paywall_encounter rate after the new layout", url: url(333), apps: ["pillow_app"], priority: 2, recheck: at(6, 12).slice(0, 10), kinds: ["recheck"] },
      { number: 12, title: "How to cut a release in a develop_flow repo", url: url(12), apps: [], priority: 3, kinds: ["guide"] },
    ],
    done: closes(),
  };

if (params.get("real")) {
  // Replace, not merge: a real board has its own lanes.
  const real = (await fetch("/board.real.json").then((r) => r.json())) as BoardData;
  for (const key of Object.keys(BOARD) as (keyof BoardData)[]) delete BOARD[key];
  Object.assign(BOARD, real);
  // No real issue may carry a picture. ?picture=URL gives the first ready quest two, to check the brief's pictures.
  const first = BOARD.ready?.[0];
  if (first && params.get("picture")) first.show = ["a.png", "b.png"];
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const api: BoardApi = {
  board: async () => structuredClone(BOARD),
  picture: async () => {
    const path = params.get("picture");
    if (!path) throw new Error("Pass ?picture=URL to preview an issue's image");
    return path;
  },
};

const screen = document.getElementById("boardScreen")!;
const handle = mountBoard(screen, {
  api,
  appIcon: (dir) => params.get(`icon-${dir}`),
  openUrl: (target) => console.log("open", target),
  openSwipe: () => void swipe(),
});
handle.open();

/* Swipe review against fixtures. ?swipe=1 opens it at once; ?swipe=play deals the cards too. */
const card = (c: Partial<ReviewCard> & Pick<ReviewCard, "number" | "title" | "kind">): ReviewCard => ({
  url: url(c.number), apps: [], workflow: false, priority: 2, labels: [], summary: "", why: "", ask: "", points: [],
  minutes: null, who: "", at: ago(90), pictures: [], ...c,
});
const DECK: ReviewDeck = {
  since: ago(60 * 20),
  until: new Date().toISOString(),
  repo: "Appgea/ops",
  profile: { xp: 1340, streak: 4, last_day: null, last_at: null, best_combo: 17, sessions: 6, badges: ["first-swipe", "combo-10", "voice"] },
  moves: {
    done: { right: "Ship it", left: "Redo", up: "Love it", down: "Skip" },
    new: { right: "Go", left: "Drop", up: "Rush", down: "Skip" },
    dropped: { right: "Fine", left: "Revive", up: "Love it", down: "Skip" },
  },
  cards: [
    card({ number: 449, kind: "done", priority: 0, apps: ["tavla"], who: "claude-3f1c02aa", minutes: 38, title: "Tavla Android crash: the game screen reads a provider after the widget is unmounted",
      summary: "Fixed: the game screen now stops listening before it unmounts, so the crash on leaving a match is gone in 1.9.2.",
      points: ["flutter test test/game_screen_test.dart passes, with a new test that leaves a match mid-move", "Crashlytics shows 0 of this crash on the internal track build after 40 matches", "Play internal testing has 1.9.2 build 212"],
      why: "It was the top Android crash: 31% of all crash-free-user loss last week.", pictures: params.get("picture") ? ["/tmp/x.png"] : [] }),
    card({ number: 451, kind: "done", priority: 1, apps: ["pillow_app"], who: "sol-pillow", minutes: 22, title: "Pillow: outside the top 100 for sleep sounds in 8 locales", labels: ["decided"],
      summary: "Pillow 2.4.1 ships the new title, subtitle and keywords in all 8 locales.", points: ["asc_listing --edit shows the new copy, keywords 94 to 100 chars", "Play listing API read-back shows the new title in all 8 locales"] }),
    card({ number: 709, kind: "new", priority: 1, apps: ["interbellum"], title: "Interbellum: better tiles, and front lines that run whole along a border",
      summary: "The map's tiles are hard to read and too many. Some tiles are in several pieces or sit inside another tile.",
      points: ["The tile audit shows 0 tiles in two land pieces", "A front line runs unbroken along every border with no sea gap"],
      why: "The map is the game. A player who cannot read the tiles cannot plan a war.", ask: "Should empty land merge into one big tile per region?" }),
    card({ number: 718, kind: "new", priority: 3, workflow: true, title: "board next picks a P3 before an older P2 when the P2 has no estimate", labels: ["speed"],
      summary: "Sessions starting work get a low-value issue because the sort treats a missing estimate as zero." }),
    card({ number: 702, kind: "dropped", priority: 2, apps: ["weekcut"], labels: ["untrue"], who: "claude-77ab", title: "Weekcut export drops the last caption",
      summary: "Untrue: the last caption is in the export. The player cut it at the end because the video was 0.2 s shorter than the audio." }),
    card({ number: 690, kind: "done", priority: 2, workflow: true, who: "claude-e9aca641", minutes: 12, title: "Panel: scouts and the board, visible all the time",
      summary: "The Board screen now shows who holds what and the scouts' next run.", points: ["npm run check passes", "Dev harness screenshot shows the strip at 1440 and 900 wide"] }),
  ],
};
if (params.get("swipe") && params.get("real")) {
  // The last real deck, its cards with pictures first. Every picture shows ?picture=URL.
  const real = (await fetch("/deck.real.json").then((r) => r.json())) as { cards: ReviewCard[] };
  DECK.cards = real.cards.sort((a, b) => b.pictures.length - a.pictures.length);
}
const HISTORY: ReviewHistory = {
  repo: "Appgea/ops",
  reviews: [
    { id: new Date(Date.now() - 20 * 3_600_000).toISOString(), since: null, until: null, xp: 210, brief: "/tmp/b.md", agent: "live-1",
      verdicts: [
        { number: 640, title: "Tavla: dice roll sound clips on older iPhones", url: "u", apps: ["tavla"], kind: "done", move: "left", label: "Redo",
          note: "Still clips on my iPhone 12. Test on a real device this time.", voice: true, did: ["noted", "reopened"], error: "", now: "closed" },
        { number: 655, title: "Pillow: add a rain category to the sleep sounds", url: "u", apps: ["pillow_app"], kind: "new", move: "up", label: "Rush",
          note: "", voice: false, did: ["P2 to P1"], error: "", now: "open" },
        { number: 661, title: "Weekcut export drops the last caption", url: "u", apps: ["weekcut"], kind: "done", move: "right", label: "Ship it",
          note: "Nice. Add this to the release notes.", voice: false, did: ["noted"], error: "", now: "closed" },
        { number: 662, title: "Scout: weekly review timing", url: "u", apps: [], kind: "new", move: "left", label: "Drop",
          note: "", voice: false, did: [], error: "HTTP 502", now: "open" },
        { number: 663, title: "Interbellum: map labels overlap at small zoom", url: "u", apps: ["interbellum"], kind: "done", move: "right", label: "Ship it",
          note: "", voice: false, did: [], error: "", now: "closed" },
      ] },
    { id: new Date(Date.now() - 50 * 3_600_000).toISOString(), since: null, until: null, xp: 95, brief: null, agent: null,
      verdicts: [
        { number: 600, title: "Panel: board refresh is slow", url: "u", apps: [], kind: "done", move: "right", label: "Ship it",
          note: "", voice: false, did: [], error: "", now: "closed" },
      ] },
  ],
};

async function swipe(): Promise<void> {
  const { openSwipe } = await import("./features/swipe");
  openSwipe({
    api: {
      deck: async () => { await wait(300); return structuredClone(DECK); },
      voice: async () => { await wait(1200); return { text: "Bunu bir sonraki sürümle birlikte gönder, ama önce Türkçe metni kontrol et.", path: "/tmp/x.m4a" }; },
      send: async (body) => {
        await wait(800);
        console.log("send", body);
        return { id: new Date().toISOString(), applied: body.verdicts.map((v) => ({ number: v.number, label: "x", act: v.move === "left" ? "reopen" : null, note: v.note, did: [v.note ? "noted" : "", v.move === "left" ? "reopened" : ""].filter(Boolean) })),
          errors: [], brief: "/tmp/brief.md", prompt: "Read /tmp/brief.md and do what it says.",
          profile: { ...DECK.profile, xp: DECK.profile.xp + body.xp, streak: 5, best_combo: Math.max(17, body.best_combo), badges: body.badges } };
      },
      picture: async () => params.get("picture") ?? "",
      history: async () => { await wait(500); return structuredClone(HISTORY); },
      agent: async (id, session) => console.log("agent", id, session),
    },
    appIcon: (dir) => params.get(`icon-${dir}`),
    appName: (dir) => ({ tavla: "Tavla", pillow_app: "Pillow", interbellum: "Interbellum", weekcut: "Weekcut" })[dir] ?? dir,
    openUrl: (target) => console.log("open", target),
    launchAgent: async () => (params.get("launch") ? "live-2" : null),
    showSession: () => true,
    fullscreen: async (on) => on,
    onClose: () => console.log("swipe closed"),
  });
  if (params.get("swipe") === "play") {
    await wait(500);
    document.querySelector<HTMLButtonElement>(".sw-go")?.click();
  }
}
if (params.get("swipe")) void swipe();
