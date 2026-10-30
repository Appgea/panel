/**
 * Dev harness for the Board screen. NOT part of the app build — index.html never
 * loads this. It mounts the REAL module (mountBoard) against fixture data and a stub extension,
 * so the screen can be looked at without Tauri. ?empty=1 shows a quiet board.
 */
import "./style.css";
import "./motion.css";
import { mountBoard, type BoardApi, type BoardData, type BuildList, type Scout, type ScoutList } from "./features/board";

const params = new URLSearchParams(location.search);
const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();
const at = (days: number, hour: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};
const url = (n: number): string => `https://github.com/Appgea/ops/issues/${n}`;

const BOARD: BoardData = params.get("empty")
  ? { repo: "Appgea/ops", open: 4, now: [], you: [], next: [] }
  : {
    repo: "Appgea/ops",
    open: 61,
    now: [
      { number: 67, title: "Panel: scouts and the board, visible all the time", url: url(67), apps: ["panel"], priority: 1, holder: "claude-e9aca641", claimed_at: ago(48) },
      { number: 20, title: "Tavla Android crash: game screen reads a provider after the widget is unmounted", url: url(20), apps: ["tavla"], priority: 1, holder: "claude-3f1c02aa", claimed_at: ago(12) },
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
      { number: 60, title: "Revoke App Store Connect key 6GHLN3V5DS, it is tracked in two repos", url: url(60), apps: [], priority: 1 },
      { number: 1, title: "Renew the Apple distribution certificate", url: url(1), apps: [], priority: 1 },
      { number: 31, title: "No iOS privacy manifest, analytics fire before consent", url: url(31), apps: ["pillow_app"], priority: 1 },
    ],
    next: [
      { number: 28, title: "Portfolio-wide consent compliance", url: url(28), apps: [], priority: 1 },
      { number: 29, title: "Money integrity across IAP apps", url: url(29), apps: [], priority: 1 },
      { number: 40, title: "Set up RevenueCat entitlements and offerings for Tavla", url: url(40), apps: ["tavla"], priority: 1 },
      { number: 66, title: "Write the app kit standards the weekly beat checks", url: url(66), apps: [], priority: 2 },
    ],
  };

const scout = (s: Partial<Scout> & Pick<Scout, "id" | "title">): Scout => ({
  every: "daily", after: 8, kind: "agent", agent: "claude", model: null, needs: null, summary: "", error: null,
  due: false, next_at: at(1, 8), last: null, ...s,
});
const SCOUTS: ScoutList = {
  now: new Date().toISOString(),
  next_due_at: at(1, 8),
  scouts: [
    scout({ id: "alive", title: "Servers and sites answer", every: "3h", kind: "script", agent: null, next_at: ago(-150), last: { at: ago(30), status: "done", found: 0, note: "9 checked, 0 down", session: null } }),
    scout({ id: "now", title: "now.md follows the board", every: "3h", kind: "script", agent: null, next_at: ago(-150), last: { at: ago(30), status: "done", found: 0, note: "now.md synced", session: null } }),
    scout({ id: "support", title: "New support entries", kind: "script", agent: null, last: { at: ago(400), status: "done", found: 1, note: "3 unread in 7 days", session: null } }),
    scout({ id: "health", title: "Stores, crashes, money and reviews", last: { at: ago(9), status: "running", found: 0, note: "", session: "live-1" }, next_at: null }),
    scout({ id: "tp-audience", title: "Tarih Parodi comments, DMs and requests", needs: "browser", due: true, next_at: null }),
    scout({ id: "tp-topic", title: "Today's Tarih Parodi episode", after: 9, last: { at: ago(1500), status: "failed", found: 0, note: "the terminal did not open", session: null } }),
    scout({ id: "gardener", title: "Fix the workflow", every: "sunday", after: 10, next_at: at(4, 10) }),
    scout({ id: "risks", title: "What expires or changes soon", every: "sunday", next_at: at(4, 8), last: { at: ago(5000), status: "done", found: 2, note: "2 filed: a certificate and a policy date", session: null } }),
    scout({ id: "app-kit", title: "Gaps every app should not have", every: "sunday", next_at: at(4, 8) }),
  ],
};

const row = (builder: string, effort: string, minutes: number, exit: number, kind: string, verdict: string, task: string, repo = "panel") =>
  ({ date: "2026-10-29", builder, effort, repo, minutes: String(minutes), exit: String(exit), session: "s", kind, verdict, task });
const BUILDS: BuildList = params.get("empty")
  ? { running: [], recent: [] }
  : {
    running: [
      { pid: 101, builder: "sol", effort: "medium", kind: "ui", repo: "panel", task: "Panel's Board screen shows issues and scouts, but not the builder runs that orchestrated work starts, and this title keeps going to test the ellipsis", session: "s1", started: ago(14) },
      { pid: 102, builder: "luna", effort: "low", kind: "mechanical", repo: "tavla", task: "Rename the bear-off helper", session: "s2", started: ago(3) },
    ],
    recent: [
      row("sol", "medium", 22, 0, "edit", "ship", "Add the /builds route to the scout host"),
      row("luna", "low", 6, 0, "text", "fix", "Fix the empty-state copy on Home"),
      row("sol", "high", 31, 0, "logic", "wrong", "Move the terminal restore into its own module", "panel"),
      row("luna", "low", 4, 4, "edit", "-", "Trim unused imports across the scout files", "ops"),
      row("sol", "medium", 12, 0, "ui", "-", "Round the board stat chips"),
    ],
  };

if (params.get("many")) {
  SCOUTS.scouts.push(scout({ id: "extra", title: "Reviews and ratings", last: { at: ago(2), status: "running", found: 0, note: "", session: "live-3" }, next_at: null }));
  BUILDS.running.push({ pid: 103, builder: "sol", effort: "high", kind: "logic", repo: "ops", task: "Move the board reader into its own module", session: "s3", started: ago(25) });
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const api: BoardApi = {
  scouts: async () => structuredClone(SCOUTS),
  board: async () => structuredClone(BOARD),
  builds: async () => structuredClone(BUILDS),
  run: async (id) => {
    await wait(900);
    return { at: new Date().toISOString(), status: "done", found: 0, note: `${id} ran`, session: null };
  },
  prompt: async (id) => `Scout ${id}`,
  start: async (_id, session) => ({ at: new Date().toISOString(), status: "running", found: 0, note: "", session }),
  record: async (_id, status, note) => ({ at: new Date().toISOString(), status, found: 0, note, session: null }),
};

const screen = document.getElementById("boardScreen")!;
const handle = mountBoard(screen, {
  api,
  openUrl: (target) => console.log("open", target),
  // The harness never opens terminals: Run on an agent scout records a launch without one.
  launch: async (_scout, _prompt, started) => {
    if (!params.get("launch")) return null;
    await started("live-2");
    return "live-2";
  },
  showSession: () => true,
  isLive: (session) => session.startsWith("live"),
});
handle.open();
