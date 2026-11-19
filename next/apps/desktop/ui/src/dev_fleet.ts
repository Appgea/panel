/**
 * Dev harness for the AI fleet screen. NOT part of the app build: index.html never loads this.
 * It mounts the REAL module (mountFleet) against a fixture, so the screen can be looked at without
 * Tauri. ?real=1 reads fleet.real.json and ?real=now fleet.now.real.json (saved `fleet view`s,
 * never committed: `python3 ~/.appgeapanel/ops/runbooks/fleet.py view > fleet.now.real.json`). ?empty=1 shows a
 * stopped fleet, ?error=1 a failed read over the last good one.
 */
import "./style.css";
import type { OverviewData } from "./features/board";
import { mountFleet, type FleetView } from "./features/fleet";

const params = new URLSearchParams(location.search);
const clock = (m: number): string =>
  new Date(Date.now() - m * 60_000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

const SCREEN = `
  ┃  You are fleet builder terra-1. Run \`fleet hello terra-1\`, then build #1901.
  ┃

     I'll read the crash report first.

     + 12 commands, 9 thoughts, 14 reads

     The NotificationService extension force-unwraps the payload. Patching it to
     fall back to the plain alert, then running the one test that covers it.

     + 3 commands, 2 thoughts

  ┃  Build auto · GPT-5.5 Codex · high
  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
   ⬝⬝⬝⬝⬝⬝⬝⬝ esc interrupt                        121.5K (12%)  ctrl+p commands`;

const FIXTURE: FleetView = {
  supervisor: true,
  hold: false,
  spec: "terra:2,flash:2",
  units: [
    { id: "terra-1", kind: "terra", app: "tavla", issues: [{ number: 1901, title: "Tavla iOS: NotificationService crash on 5 users" }],
      minutes: 12, budget: 30, tokens: "1.2M", quiet: 0, flags: [], screen: SCREEN },
    { id: "terra-2", kind: "terra", app: "pisti", issues: [{ number: 1807, title: "Splash: Pisti deals one card under the logo" }, { number: 1808, title: "Splash: Wolf 2048 tiles slide into the logo" }],
      minutes: 34, budget: 30, tokens: "2.9M", quiet: 6, flags: ["OVER", "STUCK"], screen: SCREEN },
    { id: "flash-1", kind: "flash", app: null, issues: [], minutes: 1, budget: 20, tokens: "40k", quiet: 0, flags: [], screen: "" },
    { id: "2b5f38", kind: "flash", app: "", scout: "ui-guidelines@Memor", issues: [], minutes: 25, budget: 30, tokens: "11.3M", quiet: 0, flags: [],
      screen: "\n     I'll start by running the hello command and the routine.\n\n     + 67 commands, 71 thoughts, 23 reads\n\n     I've read the code end to end. Now filing the two findings I can prove.\n\n     ⠸ 7 commands, 3 thoughts\n\n  ┃\n  ┃  Build auto · DeepSeek V4.1 Flash 1017 OpenCode Go · high\n  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\n   ⬝⬝⬝⬝⬝⬝⬝⬝ esc interrupt     221.5K (22%)  ctrl+p commands" },
    { id: "sonnet-1", kind: "sonnet", app: "memor", issues: [{ number: 1851, title: "Memor: retry a failed rewarded ad load so the continue offer comes back" }],
      minutes: 19, budget: 30, tokens: "3.4M", quiet: 2, flags: [], screen: SCREEN },
  ],
  today: [
    { time: clock(20), unit: "833b4b", kind: "terra", app: "-", closed: [1992], minutes: 6, tokens: "1.9M", result: "build 1992, said bye" },
    { time: clock(25), unit: "58f38a", kind: "flash", app: "-", closed: [], minutes: 17, tokens: "15.5M", result: "scout wild@gunun_hadisi, said bye" },
    { time: clock(40), unit: "264c8d", kind: "terra", app: "-", closed: [2029, 2030], minutes: 6, tokens: "3.1M", result: "build 2029,2030, said bye" },
    { time: clock(55), unit: "d1143d", kind: "terra", app: "-", closed: [], minutes: 4, tokens: "1.4M", result: "build 1937,1971, said bye" },
    { time: clock(80), unit: "c11dd0", kind: "flash", app: "-", closed: [], minutes: 34, tokens: "16.1M", result: "scout ui-guidelines@snakev, said bye" },
    { time: clock(100), unit: "a1b2c3", kind: "sonnet", app: "memor", closed: [1793, 1797], minutes: 22, tokens: "1M", result: "done" },
  ],
};

async function view(): Promise<FleetView> {
  if (params.has("empty")) return { supervisor: false, units: [], today: [] };
  const real = params.get("real");
  if (real) return (await fetch(real === "now" ? "/fleet.now.real.json" : "/fleet.real.json")).json() as Promise<FleetView>;
  return FIXTURE;
}

// The board's day: today's closes and finds, and yesterday's up to this hour for the pace.
const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
// A closed issue was filed days ago: only a new one counts as a find today.
const card = (number: number, kind: "done" | "new", m: number, scout = "") => ({ number, title: `Issue ${number}`, url: "", kind, apps: [], priority: 2, who: "", at: ago(m), created: ago(kind === "new" ? m : 5 * 24 * 60), scout });
const DAY: OverviewData = {
  since: ago(48 * 60),
  limit: 300,
  cards: [
    // With the fleet's close at 20 minutes, two more in the last half hour light the streak.
    ...[1992, 2029, 2030, 1793, 1797, 1850, 1851, 1852, 1853].map((n, i) => card(n, "done", [20, 40, 40, 100, 100, 5, 12, 170, 190][i])),
    card(2101, "new", 26, "wild@gunun_hadisi"),
    card(2102, "new", 28, "wild@gunun_hadisi"),
    card(2103, "new", 82, "ui-guidelines@snakev"),
    card(2104, "new", 300),
    ...[1001, 1002, 1003, 1004, 1005, 1006].map((n) => card(n, "done", 24 * 60 + 30)),
  ],
};

let reads = 0;
const handle = mountFleet(document.getElementById("fleetScreen")!, {
  openIssue: (n) => console.log("open issue", n),
  day: async () => (params.has("empty") ? { cards: [] } : params.get("real") === "now" ? null : DAY),
  view: async () => {
    reads += 1;
    if (params.has("error") && reads > 1) throw new Error("fleet view timed out after 8 s");
    return view();
  },
});
handle.open();
