import type { FleetView } from "./fleet";
import type { BoardFeed } from "./live_cards";
import type { Facts } from "./live_facts";

export type Harness = "claude" | "codex" | "grok" | "opencode" | "gemini" | "kimi";
export type State = "work" | "think" | "turn" | "idle" | "stuck";
export type Station = "plan" | "build" | "check" | "ship";
export type EmberOutcome = "done" | "failed" | "stopped" | "crashed" | "stuck";
export type Step = { atMs: number; label: string; station: Station; file?: string; helper?: boolean; asks?: boolean; verb?: string; ok?: boolean };

export type LiveAgent = {
  id: string;
  pid: number | null;
  harness: Harness;
  headless: boolean;
  name: string | null;
  session: string | null;
  cwd: string;
  room: string;
  roomName: string;
  parent: string | null;
  via: string | null;
  startedMs: number | null;
  busy: boolean;
  state: State;
  stateMs: number | null;
  model: string | null;
  task: string | null;
  now: Step | null;
  steps: Step[];
  stepCount: number;
  lastText: string | null;
  helpers: number;
  files: string[];
  panel: string | null;
  issue: number | null;
  helperKind?: string | null;
  fleet?: FleetTag | null;
  commander?: boolean;
};

export type FleetRole = "builder" | "scout" | "checker";

export type FleetTag = {
  unit: string;
  kind: string;
  scout: string | null;
  role?: FleetRole;
  ability?: string | null;
  question?: string | null;
  issues: { number: number; title: string }[];
  budget: number;
  startedMs: number;
  flags: string[];
};

export type LiveJob = {
  id: string;
  pid: number;
  label: string;
  kind: "job" | "launcher" | "service" | "left";
  agent: string | null;
  startedMs: number | null;
  cpu: number;
  procs: number;
  bay: boolean;
  room: string;
  roomName: string;
};

export type LiveEmber = {
  id: string;
  name: string | null;
  harness: Harness;
  headless: boolean;
  room: string;
  roomName: string;
  model: string | null;
  session: string | null;
  cwd: string;
  task: string | null;
  result: string | null;
  outcome: EmberOutcome;
  files: string[];
  steps: Step[];
  stepCount: number;
  parentName: string | null;
  via: string | null;
  startedMs: number | null;
  endedMs: number;
};

export type LiveRoom = { key: string; name: string; order: number; weight: number; group?: string };

export type LiveWorld = {
  agents: LiveAgent[];
  jobs: LiveJob[];
  embers: LiveEmber[];
  rooms: LiveRoom[];
  mac: {
    load: number;
    cores: number;
    hot: boolean;
    bays: { agent: string | null; holder: string | null }[];
    quota?: { harness: string; used: number }[];
  };
  scannedMs: number;
};

export type LiveEvents = {
  world(): Promise<LiveWorld>;
  board(fresh: boolean): Promise<BoardFeed | null>;
  openUrl(url: string): void;
  openTerminal(panel: string): boolean;
  sendToAgent(panel: string, text: string): Promise<boolean>;
  openFile(path: string): void;
  openHistory(session: string): void;
  stop(pid: number): Promise<void>;
  fleet(): Promise<FleetView | null>;
  tellCommander(words: string): Promise<boolean>;
};

export type Selection = { kind: "agent" | "ember" | "room"; id: string } | null;

export type LiveState = {
  world: LiveWorld | null;
  board: BoardFeed | null;
  fleet: FleetView | null;
  selection: Selection;
  results: Map<string, { text: string; ok: boolean; born: number; until: number }>;
  pinged: Map<string, number>;
  endings: { room: string; text: string; ok: boolean; until: number }[];
};

export type LiveCtx = Facts & {
  s: LiveState;
  events: LiveEvents;
  select(next: Selection): void;
  paint(): void;
  poll(): void;
  toast(text: string, bad?: boolean): void;
};
