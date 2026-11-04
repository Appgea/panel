/** The shapes Live passes between its files. The backend's types first, then the screen's state. */

import type { BoardFeed, BoardIssue, Card } from "./live_cards";
import type { Layout } from "./live_layout";
import type { Play } from "./live_playbook";

export type Harness = "claude" | "codex" | "grok" | "opencode" | "gemini" | "kimi";
export type State = "work" | "think" | "turn" | "idle" | "stuck";
export type Station = "plan" | "build" | "check" | "ship";
/** How an agent ended (src-tauri/src/live/embers.rs). */
export type EmberOutcome = "done" | "failed" | "stopped" | "crashed" | "stuck";
export type Step ={ atMs: number; label: string; station: Station; file?: string; helper?: boolean; asks?: boolean };

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
  scannedMs: number;
};

/** What main.ts lends Live. Every one of them already exists elsewhere in Panel. */
export type LiveEvents = {
  world(): Promise<LiveWorld>;
  /** Null when the board module is not installed: Live then shows no cards, and says so. */
  board(fresh: boolean): Promise<BoardFeed | null>;
  answer(body: { number: number; pick?: number; say?: string }): Promise<{ ok: boolean; said?: string }>;
  picture(path: string): Promise<string>;
  openUrl(url: string): void;
  /** Jump to the Panel terminal hosting an agent. False when that terminal is gone. */
  openTerminal(panel: string): boolean;
  sendToAgent(panel: string, text: string): Promise<boolean>;
  seedManager(text: string): Promise<void>;
  openFile(path: string): void;
  openHistory(session: string): void;
  stop(pid: number): Promise<void>;
};

/** What `apps/live` exports after wasm-bindgen. */
export type BevyView = {
  default: () => Promise<unknown>;
  start: (canvas: string) => void;
  set_scene: (json: string) => void;
  set_paused: (paused: boolean) => void;
};

export type Selection = { kind: "agent" | "ember" | "room"; id: string } | null;

/** A light on its way along a card's thread: a new card flies in, an answer flies out. */
export type Flight = { dir: "in" | "out"; room: string; agent: string | null };

/** Everything Live remembers between polls. Only live.ts replaces `world` and `board`. */
export type LiveState = {
  world: LiveWorld | null;
  board: BoardFeed | null;
  boardNote: string;
  boardRead: boolean;
  layout: Layout | null;
  selection: Selection;
  /** The dot under the pointer, by agent id. */
  hover: string | null;
  cards: Card[];
  /** The card in front, kept in front until it is answered or put off. */
  front: string | null;
  later: Record<string, number>;
  answered: Set<string>;
  seen: Record<string, number>;
  talkCard: string | null;
  pendingFx: Play[];
  pendingFlights: Flight[];
  reduced: boolean;
};

/** What every Live file gets: the state, the events, the facts and the few calls that repaint. */
export type LiveCtx = {
  s: LiveState;
  events: LiveEvents;
  stage: HTMLElement;
  issueOf(a: LiveAgent): BoardIssue | undefined;
  roomOf(a: LiveAgent): string;
  roomName(key: string): string;
  weight(key: string): number;
  agentById(id: string | null): LiveAgent | undefined;
  nameOf(a: LiveAgent): string;
  /** Opens a panel, or closes it when `next` is what is already open. */
  select(next: Selection): void;
  /** Lays out and sends a new scene to Bevy. */
  draw(): void;
  paintQueue(): void;
  poll(): void;
  /** A short line for the owner, gone after a few seconds. */
  toast(text: string, bad?: boolean): void;
};
