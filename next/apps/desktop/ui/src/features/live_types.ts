/** The shapes Live passes between its files. The backend's types first, then the screen's state. */

import type { BoardFeed } from "./live_cards";
import type { Facts } from "./live_facts";
import type { FxOut, Mark, Pt, Script } from "./live_script";
import type { Slots, World } from "./live_world";

export type Harness = "claude" | "codex" | "grok" | "opencode" | "gemini" | "kimi";
export type State = "work" | "think" | "turn" | "idle" | "stuck";
export type Station = "plan" | "build" | "check" | "ship";
/** How an agent ended (src-tauri/src/live/embers.rs). */
export type EmberOutcome = "done" | "failed" | "stopped" | "crashed" | "stuck";
/**
 * `verb` names the kind of work and picks its animation (src-tauri/src/live/verbs.rs). `ok` is how
 * a finished step went, from its tool result: unset while it runs, and for harnesses that do not say.
 */
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
  /** Set on a subagent: its type, like `Explore`. `parent` is the agent that started it. */
  helperKind?: string | null;
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

export type LiveRoom = { key: string; name: string; order: number; weight: number };

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
    /** Weekly quota per harness, where this Mac keeps a record. Claude only, for now. */
    quota?: { harness: string; used: number }[];
  };
  /** One animation script per verb (src-tauri/src/live/catalog.rs). */
  catalog?: Script[];
  scannedMs: number;
};

/** What main.ts lends Live. Every one of them already exists elsewhere in Panel. */
export type LiveEvents = {
  world(): Promise<LiveWorld>;
  /** Null when the board module is not installed. Live reads it only to name an agent's issue and its project. */
  board(fresh: boolean): Promise<BoardFeed | null>;
  openUrl(url: string): void;
  /** Jump to the Panel terminal hosting an agent. False when that terminal is gone. */
  openTerminal(panel: string): boolean;
  sendToAgent(panel: string, text: string): Promise<boolean>;
  openFile(path: string): void;
  openHistory(session: string): void;
  stop(pid: number): Promise<void>;
  /** Removes one animation from the catalog. The next agent doing that verb gets a new one. */
  deleteAnimation(verb: string): Promise<void>;
  /** Has a writer rewrite one animation with the owner's note. The old one plays until then. */
  improveAnimation(verb: string, note: string): Promise<void>;
};

/** What `apps/live` exports after wasm-bindgen. */
export type BevyView = {
  default: () => Promise<unknown>;
  start: (canvas: string) => void;
  set_scene: (json: string) => void;
  set_camera: (x: number, y: number, zoom: number) => void;
  set_paused: (paused: boolean) => void;
};

export type Selection = { kind: "agent" | "ember" | "room"; id: string } | null;

/** The world point at the stage's centre, and world pixels to CSS pixels. */
export type Camera = { x: number; y: number; zoom: number };

/** Everything Live remembers between polls. Only live.ts replaces `world` and `board`. */
export type LiveState = {
  world: LiveWorld | null;
  board: BoardFeed | null;
  layout: World | null;
  slots: Slots;
  camera: Camera;
  /** The owner moved the camera. Until then it fits the map on its own. */
  cameraHeld: boolean;
  /** What running scripts change: what an agent carries, what it says. */
  carries: Map<string, string>;
  bubbles: Map<string, string>;
  /** File tiles a script lit, by path, until a time. */
  lights: Map<string, { color: string; until: number }>;
  selection: Selection;
  /** The dot under the pointer, or the agent row under it in the side list, by agent id. */
  hover: string | null;
  pendingFx: FxOut[];
  /** Glyphs and tags that scripts put on the map, each until `born + ms`. */
  marks: (Mark & { id: number; born: number })[];
  /** How each agent's last test, build or push went, shown in its bubble until `until`. */
  results: Map<string, { text: string; ok: boolean; until: number }>;
  reduced: boolean;
};

/** What every Live file gets: the state, the events, the facts and the few calls that repaint. */
export type LiveCtx = Facts & {
  s: LiveState;
  events: LiveEvents;
  stage: HTMLElement;
  /** Opens a panel, or closes it when `next` is what is already open. */
  select(next: Selection): void;
  /** Marks the agent under the pointer, on the map or in the side list. */
  hover(id: string | null): void;
  /** Lays out and sends a new scene to Bevy. */
  draw(): void;
  /** A world point on the stage, in CSS pixels. */
  toScreen(p: Pt): Pt;
  poll(): void;
  /** A short line for the owner, gone after a few seconds. */
  toast(text: string, bad?: boolean): void;
};
