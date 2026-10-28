/**
 * Dev harness for the workspace's terminals wall — the project disc and the engine chooser.
 * NOT part of the app build — index.html never loads this. It mounts the REAL mountTerminals
 * against fixture projects and stubbed events, so the drifting pool and the engine picker can be
 * looked at without Tauri. No IO, no invoke, no live PTYs.
 */
import "./style.css";
import { MAIN_ID } from "./types";
import { mountTerminals, type TerminalsEvents, type TerminalsProject } from "./features/terminals";

// ?sessions=N gives the first project N fake sessions, so the picker sits in a narrow cell
// beside live terminals instead of filling the whole wall.
const EXTRA = Number(new URLSearchParams(location.search).get("sessions") ?? "0");

const PROJECTS: TerminalsProject[] = [
  "Kelimelik",
  "Harbor",
  "Sayı Avı",
  "CoinApp",
  "Fitstrail",
  "Memor",
  "Portfolio",
  "Sudokov",
  "Tavla",
  "TavlaSkor",
  "VillagesTown",
  "Wolf2048",
  "Attention Retention",
  "Clearday",
  "Dream Commenter",
  "DroneXtreme",
  "Günün Hadisi",
  "Pillow App",
  "Pisti",
  "Sagar",
  "Sevres",
  "Snake",
  "Solitaire Game",
  "Village Sim",
  "Trading",
].map((name, index) => ({
  id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  name,
  exists: true,
  group: "",
  running: index % 5 === 0,
  lastActive: Date.now() - index * 86_400_000,
  sessions: Array.from({ length: index === 0 && EXTRA > 0 ? EXTRA : 0 }, (_, i) => ({
    id: `s-${i}`,
    project: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    kind: "shell" as const,
    title: `shell ${i + 1}`,
    terminal_id: `t-${i}`,
  })),
}));

// The main folder rides along like the app adds it: one more project, first in the picker.
PROJECTS.push({
  id: MAIN_ID,
  name: "Main folder",
  path: "/Users/dev/Desktop/projects",
  exists: true,
  group: "",
  running: false,
  sessions: [],
});

const host = document.querySelector<HTMLElement>("#terminalsHost")!;

const events: TerminalsEvents = {
  pinned: [],
  start: async () => null,
  adopt: () => {},
  park: () => {},
  refit: () => {},
  focusPane: () => {},
  jump: () => {},
  close: () => {},
  isExited: () => false,
  runApp: () => {},
  runView: () => null,
  runTargetPicker: () => document.createElement("span"),
  runNudge: () => {},
  runStop: () => {},
  runRetry: () => {},
  runDismiss: () => {},
  runExtra: () => {},
  runOpen: () => {},
};

const terminals = mountTerminals(host, events);
terminals.open(PROJECTS, 0);

declare global {
  interface Window {
    __terminals: { openPicker: () => void };
  }
}

// Expose a handle for the screenshot driver: open the engine chooser on the first project.
window.__terminals = {
  openPicker: () => {
    const float = host.querySelector<HTMLElement>(".plus-float");
    if (float) float.click();
  },
};
