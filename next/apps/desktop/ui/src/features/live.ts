/**
 * Live — what every agent, script and process on this Mac is doing, and the few things that
 * need the owner.
 *
 * The backend scans what the agents already leave behind (src-tauri/src/live). This screen lays
 * the scene out in CSS pixels and hands it to Bevy, built to WebAssembly from apps/live, which
 * draws the rooms, the glowing dots, the jobs and the embers. Every word is HTML on top, on quiet
 * panels. Light means state.
 *
 * Shortest path for his attention: the queue on the right holds one card at a time, in value
 * per minute (live_cards.ts). One key answers it. One click on a dot shows what that agent does
 * and did. Two clicks reach a stopped agent's report. Rooms keep their places, so the eye learns
 * the map.
 *
 * Polled every 2 s and the board every 60 s, only while the screen is open. Bevy sleeps while
 * it is closed. If Bevy cannot start, everything else still works and the stage says why.
 */

import { errorText } from "../errors";
import { buildCards, KIND, managerBrief, order, queueLine, type Act, type BoardFeed, type BoardIssue, type Card } from "./live_cards";
import { direct, type EmberEnd, type Play, type Seen } from "./live_playbook";
import "./live.css";

type Harness = "claude" | "codex" | "grok" | "opencode" | "gemini" | "kimi";
type State = "work" | "think" | "turn" | "idle" | "stuck";
type Station = "plan" | "build" | "check" | "ship";
type Step = { atMs: number; label: string; station: Station; file?: string; helper?: boolean; asks?: boolean };

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
  outcome: "finished" | "cut";
  files: string[];
  steps: Step[];
  stepCount: number;
  parentName: string | null;
  via: string | null;
  startedMs: number | null;
  endedMs: number;
};

export type LiveWorld = {
  agents: LiveAgent[];
  jobs: LiveJob[];
  embers: LiveEmber[];
  rooms: { key: string; name: string; order: number; weight: number }[];
  mac: { load: number; cores: number; hot: boolean; bays: { agent: string | null; holder: string | null }[] };
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
type BevyView = {
  default: () => Promise<unknown>;
  start: (canvas: string) => void;
  set_scene: (json: string) => void;
  set_paused: (paused: boolean) => void;
};

const POLL_MS = 2000;
const BOARD_MS = 60_000;
/** A dot moves to a new station only after it held there this long, so it never jitters. */
const STATION_HOLD_MS = 10_000;
const STATIONS: Station[] = ["plan", "build", "check", "ship"];
const STATION_NAME: Record<Station, string> = { plan: "Plan", build: "Build", check: "Check", ship: "Ship" };
const HARNESS: Record<Harness, string> = { claude: "Claude", codex: "Codex", grok: "Grok", opencode: "OpenCode", gemini: "Gemini", kimi: "Kimi" };
const LETTER: Record<Harness, string> = { claude: "C", codex: "X", grok: "G", opencode: "O", gemini: "M", kimi: "K" };
const STATE_WORD: Record<State, string> = { work: "Working", think: "Thinking", turn: "Waits for you", idle: "Idle", stuck: "Stuck" };
const STATE_RANK: Record<State, number> = { stuck: 0, turn: 1, work: 2, think: 3, idle: 4 };
const SEEN_KEY = "panel.live.seen";
const LATER_MS = 30 * 60_000;
const HOLD_MS = 1000;

const PAD = 16;
const GAP = 14;
const ROOM_MIN = 300;
const HEAD = 38;
/** One row of dots, with room under each dot for its name tag. */
const BAND_ROW = 36;
const BAND_LABEL = 20;
const LINE = 20;
const SHELF = 22;
const COMPACT_H = 40;
const MAX_LINES = 4;
const MAX_JOB_LINES = 3;
const DOT_STEP = 28;
const PANEL_W = 340;

export type LiveHandle = { open(): void; clear(): void };

type RoomLayout = {
  key: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  compact: boolean;
  agents: LiveAgent[];
  jobs: LiveJob[];
  embers: LiveEmber[];
  bandTop: number;
  bandH: number;
  linesTop: number;
};
type Layout = {
  rooms: RoomLayout[];
  dots: Map<string, { x: number; y: number; r: number }>;
  jobs: Map<string, { x: number; y: number }>;
  embers: Map<string, { x: number; y: number }>;
  height: number;
};
type Selection = { kind: "agent" | "ember"; id: string } | null;

export function mountLive(root: HTMLElement, events: LiveEvents): LiveHandle {
  root.innerHTML = `
    <header class="live-bar">
      <span class="live-title">Live</span>
      <span class="live-sum" data-sum>Looking for agents…</span>
      <span class="live-mac-top" data-mactop></span>
    </header>
    <div class="live-body">
      <div class="live-main">
        <div class="live-stage" data-stage>
          <canvas id="liveCanvas" class="live-canvas" tabindex="-1" aria-hidden="true"></canvas>
          <div class="live-labels" data-labels></div>
          <aside class="live-panel" data-panel hidden>
            <div class="live-panel-body" data-panel-body></div>
            <div class="live-talk" data-agent-talk hidden>
              <textarea rows="2" data-agent-text placeholder="Type to it. Enter sends."></textarea>
            </div>
          </aside>
          <p class="live-note" data-note hidden></p>
        </div>
        <section class="live-mac" data-mac aria-label="This Mac"></section>
        <section class="live-roster" aria-label="Every agent">
          <h2 class="live-h2">Every Agent</h2>
          <ul class="live-list" data-roster></ul>
        </section>
      </div>
      <aside class="live-queue" aria-label="For you">
        <header class="live-queue-head">
          <h2 class="live-h2">For You</h2>
          <span class="live-queue-sum" data-qsum></span>
        </header>
        <div class="live-card" data-card></div>
        <div class="live-talk" data-talk hidden>
          <p class="live-talk-to" data-talk-to></p>
          <textarea rows="3" data-talk-text placeholder="Your words. ⌘↩ sends."></textarea>
          <div class="live-talk-row">
            <button type="button" class="live-btn is-primary" data-talk-send>Send</button>
            <button type="button" class="live-btn" data-talk-cancel>Cancel</button>
          </div>
        </div>
        <p class="live-status" data-status hidden></p>
        <ol class="live-next" data-next></ol>
      </aside>
    </div>`;
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const stage = q("[data-stage]");
  const labels = q("[data-labels]");
  const note = q("[data-note]");
  const sum = q("[data-sum]");
  const macTop = q("[data-mactop]");
  const panel = q("[data-panel]");
  const panelBody = q("[data-panel-body]");
  const agentTalk = q("[data-agent-talk]");
  const agentText = q<HTMLTextAreaElement>("[data-agent-text]");
  const macEl = q("[data-mac]");
  const roster = q("[data-roster]");
  const qsum = q("[data-qsum]");
  const cardEl = q("[data-card]");
  const talk = q("[data-talk]");
  const talkTo = q("[data-talk-to]");
  const talkText = q<HTMLTextAreaElement>("[data-talk-text]");
  const statusEl = q("[data-status]");
  const nextEl = q("[data-next]");

  let world: LiveWorld | null = null;
  let board: BoardFeed | null = null;
  let boardNote = "";
  let boardAt = 0;
  let boardRead = false;
  let panelAnchor: { x: number; y: number } | null = null;
  let view: BevyView | null = null;
  let viewTried = false;
  let timer: number | null = null;
  let polling = false;
  let open = false;
  let selection: Selection = null;
  let front: string | null = null;
  let cards: Card[] = [];
  let cardSig = "";
  let talkCard: string | null = null;
  const later: Record<string, number> = {};
  const answered = new Set<string>();
  const seen: Record<string, number> = readSeen();
  const stations = new Map<string, { shown: Station; pending: Station; since: number }>();
  const played = new Map<string, number>();
  const pictures = new Map<string, string>();
  let lastSeen: Seen | null = null;
  let knownEmbers: Set<string> | null = null;
  let layout: Layout | null = null;
  let pendingFx: Play[] = [];

  const say = (text: string) => {
    note.textContent = text;
    note.hidden = !text;
  };
  const status = (text: string, bad = false) => {
    statusEl.textContent = text;
    statusEl.hidden = !text;
    statusEl.classList.toggle("is-bad", bad);
  };

  async function startView(): Promise<void> {
    if (viewTried) return;
    viewTried = true;
    try {
      const mod = (await import(/* @vite-ignore */ `${location.origin}/live/panel_live.js`)) as BevyView;
      await mod.default();
      try {
        mod.start("#liveCanvas");
      } catch (e) {
        // winit leaves Rust's start-up by throwing on the web. That throw is how it says "running".
        if (!String(e).includes("control flow")) throw e;
      }
      view = mod;
      draw();
    } catch (e) {
      say(`The live view did not start: ${errorText(e, "Bevy failed to load")}. Everything else still updates.`);
    }
  }

  async function poll(): Promise<void> {
    // A scan slower than the interval must not stack up `ps` and `lsof` runs.
    if (polling) return;
    polling = true;
    try {
      world = await events.world();
      if (Date.now() - boardAt > BOARD_MS) void readBoard(false);
      paint();
    } catch (e) {
      sum.textContent = `Could not read the agents: ${errorText(e, "the scan failed")}`;
    } finally {
      polling = false;
    }
  }

  async function readBoard(fresh: boolean): Promise<void> {
    boardAt = Date.now();
    try {
      const b = await events.board(fresh);
      board = b && !(b as { error?: string }).error ? b : board;
      boardNote = !b ? "No board module: cards come from your sessions only." : (b as { error?: string }).error ? `The board did not answer: ${(b as { error?: string }).error}` : "";
    } catch (e) {
      boardNote = `The board did not answer: ${errorText(e, "unknown error")}`;
    }
    boardRead = true;
    paint();
  }

  // ---------------------------------------------------------------- facts

  const issues = (): BoardIssue[] => [...(board?.now ?? []), ...(board?.you ?? []), ...(board?.ready ?? []), ...(board?.waiting ?? []), ...(board?.done ?? [])];
  const issue = (n: number | null): BoardIssue | undefined => (n ? issues().find((i) => i.number === n) : undefined);
  /** The board names a claim by session: `codex-0a513057` for Codex, the folk name for others. */
  const held = (a: LiveAgent): BoardIssue | undefined => {
    const names = [a.session ? `codex-${a.session.slice(-8)}` : "", (a.name ?? "").toLowerCase()].filter(Boolean);
    return (board?.now ?? []).find((i) => i.holder && names.includes(i.holder.toLowerCase()));
  };
  const issueOf = (a: LiveAgent): BoardIssue | undefined => held(a) ?? issue(a.issue);
  /** A fleet worker runs in the company folder. Its issue's app is its real room. */
  const roomOf = (a: LiveAgent): string => {
    if (a.room !== "elsewhere" && a.room !== "home") return a.room;
    return issueOf(a)?.apps[0] ?? a.room;
  };
  const agentById = (id: string | null) => (id ? world?.agents.find((a) => a.id === id) : undefined);
  const jobRoom = (j: LiveJob): string => {
    const owner = agentById(j.agent);
    return owner ? roomOf(owner) : j.room;
  };
  const roomMeta = (key: string) => world?.rooms.find((r) => r.key === key);
  const roomName = (key: string): string => roomMeta(key)?.name ?? board?.apps?.[key]?.name ?? key;
  const weight = (key: string): number => roomMeta(key)?.weight ?? 1;
  const nameOf = (a: LiveAgent): string => a.name ?? `${HARNESS[a.harness]} ${a.pid ?? a.session?.slice(0, 4) ?? ""}`.trim();

  function station(a: LiveAgent, now: number): Station {
    const want = a.now?.station ?? a.steps[0]?.station ?? "plan";
    const s = stations.get(a.id);
    if (!s) {
      stations.set(a.id, { shown: want, pending: want, since: now });
      return want;
    }
    if (want === s.shown) s.pending = want;
    else if (want !== s.pending) {
      s.pending = want;
      s.since = now;
    } else if (now - s.since >= STATION_HOLD_MS) s.shown = want;
    return s.shown;
  }

  // ---------------------------------------------------------------- paint

  function paint(): void {
    if (!world) return;
    const now = Date.now();
    for (const id of stations.keys()) if (!world.agents.some((a) => a.id === id)) stations.delete(id);
    const agents = world.agents;
    const working = agents.filter((a) => a.state === "work" || a.state === "think").length;
    const waiting = agents.filter((a) => a.state === "turn" && !a.headless).length;
    const stuck = agents.filter((a) => a.state === "stuck").length;
    const jobs = world.jobs.filter((j) => j.kind === "job" || j.kind === "launcher").length;
    const rooms = new Set(agents.map(roomOf)).size;
    sum.textContent = agents.length
      ? [
          `${agents.length} ${plural(agents.length, "agent")} in ${rooms} ${plural(rooms, "room")}`,
          `${working} working`,
          waiting ? `${waiting} ${waiting === 1 ? "waits" : "wait"} for you` : "",
          stuck ? `${stuck} stuck` : "",
          jobs ? `${jobs} ${plural(jobs, "job")} running` : "",
        ].filter(Boolean).join(" · ")
      : "No agent is running on this Mac";
    paintQueue(now);
    draw();
    paintMac(now);
    paintRoster(now);
    paintPanel(now);
  }

  function draw(): void {
    if (!world) return;
    const width = stage.clientWidth;
    if (!width) return;
    const now = Date.now();
    layout = place(width, now);
    const panelOpen = !panel.hidden;
    stage.style.height = `${Math.max(layout.height, panelOpen ? 480 : 0)}px`;
    paintLabels(layout, now);
    placePanel();
    const snapshot = snap(layout);
    const known = new Set(world.embers.map((e) => e.id));
    const endings: EmberEnd[] = knownEmbers
      ? world.embers.filter((e) => !knownEmbers!.has(e.id)).map((e) => ({ id: e.id, agentId: e.id.split("@")[0], cut: e.outcome === "cut" }))
      : [];
    knownEmbers = known;
    pendingFx.push(...direct(lastSeen, snapshot, endings, played, now));
    lastSeen = snapshot;
    if (view) {
      view.set_scene(JSON.stringify(scene(layout, pendingFx)));
      pendingFx = [];
    }
  }

  function snap(l: Layout): Seen {
    const dots: Seen["dots"] = new Map();
    for (const a of world!.agents) {
      const d = l.dots.get(a.id);
      if (d) dots.set(a.id, { ...d, steps: a.stepCount, station: a.now?.station ?? "", parent: a.parent, nowLabel: a.now?.label ?? null });
    }
    const roomsAt: Seen["rooms"] = new Map(l.rooms.map((r) => [r.key, { x: r.x + 14, y: r.y + 19, r: 6 }]));
    return { dots, embers: new Set(world!.embers.map((e) => e.id)), cards: new Map(cards.map((c) => [c.id, c.room])), rooms: roomsAt };
  }

  /** Rooms in portfolio order, never reshuffled. A room shows while someone is in it, or while
   *  its embers glow. A room with only embers is one quiet line. */
  function place(width: number, now: number): Layout {
    const w = world!;
    const byRoom = new Map<string, { agents: LiveAgent[]; jobs: LiveJob[]; embers: LiveEmber[] }>();
    const slot = (k: string) => byRoom.get(k) ?? byRoom.set(k, { agents: [], jobs: [], embers: [] }).get(k)!;
    for (const a of w.agents) slot(roomOf(a)).agents.push(a);
    for (const j of w.jobs) if (j.kind === "job" || j.kind === "launcher") slot(jobRoom(j)).jobs.push(j);
    for (const e of w.embers) slot(e.room).embers.push(e);
    const keys = [...byRoom.keys()].sort((a, b) => (roomMeta(a)?.order ?? 5000) - (roomMeta(b)?.order ?? 5000) || a.localeCompare(b));
    const full = keys.filter((k) => byRoom.get(k)!.agents.length || byRoom.get(k)!.jobs.length);
    const quiet = keys.filter((k) => !full.includes(k));
    const cols = Math.max(1, Math.min(3, Math.floor((width - PAD * 2 + GAP) / (ROOM_MIN + GAP))));
    const rw = (width - PAD * 2 - GAP * (cols - 1)) / cols;
    const dots: Layout["dots"] = new Map();
    const jobSpots: Layout["jobs"] = new Map();
    const emberSpots: Layout["embers"] = new Map();
    const rooms: RoomLayout[] = [];
    let y = PAD;
    for (let row = 0; row * cols < full.length; row++) {
      const keysInRow = full.slice(row * cols, row * cols + cols);
      const sized = keysInRow.map((key) => {
        const s = byRoom.get(key)!;
        const agents = [...s.agents].sort((a, b) => (a.startedMs ?? 0) - (b.startedMs ?? 0) || a.id.localeCompare(b.id));
        const per = Math.max(1, Math.floor((rw - 24) / 4 / DOT_STEP));
        const counts = STATIONS.map((st) => agents.filter((a) => station(a, now) === st).length);
        const bandRows = Math.max(1, ...counts.map((n) => Math.ceil(n / per)));
        const bandH = bandRows * BAND_ROW + BAND_LABEL;
        const lines = Math.min(agents.length, MAX_LINES) + (agents.length > MAX_LINES ? 1 : 0);
        const jobLines = Math.min(s.jobs.length, MAX_JOB_LINES) + (s.jobs.length > MAX_JOB_LINES ? 1 : 0);
        const last = s.embers.length ? 1 : 0;
        const h = HEAD + bandH + 8 + (lines + jobLines + last) * LINE + (s.embers.length ? SHELF : 8) + 6;
        return { key, s: { ...s, agents }, per, bandH, h };
      });
      const rowH = Math.max(...sized.map((r) => r.h));
      sized.forEach((r, i) => {
        const x = PAD + i * (rw + GAP);
        const bandTop = y + HEAD;
        const colW = (rw - 24) / 4;
        STATIONS.forEach((st, si) => {
          const list = r.s.agents.filter((a) => station(a, now) === st);
          list.forEach((a, n) => {
            const inRow = Math.min(list.length - Math.floor(n / r.per) * r.per, r.per);
            const col = n % r.per;
            const cx = x + 12 + si * colW + colW / 2 + (col - (inRow - 1) / 2) * DOT_STEP;
            dots.set(a.id, { x: cx, y: bandTop + BAND_LABEL + 12 + Math.floor(n / r.per) * BAND_ROW, r: radius(a) });
          });
        });
        const linesTop = bandTop + r.bandH + 8;
        const agentLines = Math.min(r.s.agents.length, MAX_LINES) + (r.s.agents.length > MAX_LINES ? 1 : 0);
        r.s.jobs.slice(0, MAX_JOB_LINES).forEach((j, n) => jobSpots.set(j.id, { x: x + 19, y: linesTop + (agentLines + n) * LINE + LINE / 2 }));
        r.s.embers.slice(0, 24).forEach((e, n) => emberSpots.set(e.id, { x: x + rw - 16 - n * 10, y: y + rowH - 13 }));
        rooms.push({ key: r.key, name: roomName(r.key), x, y, w: rw, h: rowH, compact: false, agents: r.s.agents, jobs: r.s.jobs, embers: r.s.embers, bandTop, bandH: r.bandH, linesTop });
      });
      y += rowH + GAP;
    }
    // Quiet rooms: one line each, two to a row on a wide stage.
    const qcols = width > 760 ? 2 : 1;
    const qw = (width - PAD * 2 - GAP * (qcols - 1)) / qcols;
    quiet.forEach((key, i) => {
      const s = byRoom.get(key)!;
      const x = PAD + (i % qcols) * (qw + GAP);
      const ry = y + Math.floor(i / qcols) * (COMPACT_H + 8);
      s.embers.slice(0, 16).forEach((e, n) => emberSpots.set(e.id, { x: x + qw - 16 - n * 10, y: ry + COMPACT_H / 2 }));
      rooms.push({ key, name: roomName(key), x, y: ry, w: qw, h: COMPACT_H, compact: true, agents: [], jobs: [], embers: s.embers, bandTop: ry, bandH: 0, linesTop: ry });
    });
    if (quiet.length) y += Math.ceil(quiet.length / qcols) * (COMPACT_H + 8) - 8 + GAP;
    return { rooms, dots, jobs: jobSpots, embers: emberSpots, height: Math.max(160, y - GAP + PAD) };
  }

  function scene(l: Layout, fx: Play[]) {
    const w = world!;
    const sel = selection;
    const links: object[] = [];
    for (const a of w.agents) {
      const from = a.parent ? l.dots.get(a.parent) : undefined;
      const to = l.dots.get(a.id);
      if (from && to) links.push({ x1: from.x, y1: from.y, x2: to.x, y2: to.y, kind: "family" });
    }
    for (const j of w.jobs) {
      const at = l.jobs.get(j.id);
      const owner = j.agent ? l.dots.get(j.agent) : undefined;
      if (at && owner) links.push({ x1: at.x, y1: at.y, x2: owner.x, y2: owner.y, kind: "job" });
    }
    const cardRooms = new Set(cards.filter((c) => c.kind === "decide" || c.kind === "turn").map((c) => c.room));
    let tether: object | null = null;
    if (sel && !panel.hidden) {
      const at = sel.kind === "agent" ? l.dots.get(sel.id) : l.embers.get(sel.id);
      if (at) {
        if (panelAnchor) tether = { x1: at.x, y1: at.y, x2: panelAnchor.x, y2: panelAnchor.y };
      }
    }
    return {
      w: stage.clientWidth,
      h: l.height > stage.clientHeight ? l.height : stage.clientHeight,
      rooms: l.rooms.map((r) => ({
        x: r.x,
        y: r.y,
        w: r.w,
        h: r.h,
        edge: r.agents.some((a) => a.state === "stuck") ? "stuck" : cardRooms.has(r.key) ? "card" : r.agents.some((a) => a.state === "work" || a.state === "think") ? "work" : "quiet",
      })),
      links,
      dots: w.agents.flatMap((a) => {
        const d = l.dots.get(a.id);
        return d ? [{ ...d, state: a.state, helpers: a.helpers, selected: sel?.kind === "agent" && sel.id === a.id }] : [];
      }),
      jobs: w.jobs.flatMap((j) => {
        const at = l.jobs.get(j.id);
        return at ? [{ ...at, look: j.kind === "left" ? "left" : j.cpu >= 5 ? "run" : "wait" }] : [];
      }),
      embers: w.embers.flatMap((e) => {
        const at = l.embers.get(e.id);
        return at ? [{ ...at, cut: e.outcome === "cut" }] : [];
      }),
      fx: fx.map((f) => ({ kind: f.kind, x: f.x, y: f.y, x2: f.x2 ?? 0, y2: f.y2 ?? 0, r: f.r ?? 6 })),
      tether,
    };
  }

  function paintLabels(l: Layout, now: number): void {
    const out: HTMLElement[] = [];
    for (const r of l.rooms) {
      const sign = div(r.compact ? "live-sign is-compact" : "live-sign");
      place2(sign, r.x, r.y, r.w, r.h);
      const head = div("live-sign-head");
      head.append(span("live-room", r.name));
      const counts = [
        r.agents.length ? `${r.agents.length} ${plural(r.agents.length, "agent")}` : "",
        r.jobs.length ? `${r.jobs.length} ${plural(r.jobs.length, "job")}` : "",
        r.compact && r.embers.length ? `${r.embers.length} ${plural(r.embers.length, "report")}` : "",
      ].filter(Boolean).join(" · ");
      head.append(span("live-room-count", counts));
      sign.append(head);
      if (r.compact) {
        const e = r.embers[0];
        if (e) {
          const last = button("live-last is-inline", `Last: ${emberLine(e, now)}`, () => select({ kind: "ember", id: e.id }));
          // The line ends where the embers start, so the two never overlap.
          last.style.right = `${22 + Math.min(r.embers.length, 16) * 10}px`;
          sign.append(last);
        }
        out.push(sign);
        continue;
      }
      const band = div("live-band");
      band.style.top = `${r.bandTop - r.y}px`;
      band.style.height = `${r.bandH}px`;
      for (const st of STATIONS) band.append(span("live-station", STATION_NAME[st]));
      sign.append(band);
      const lines = div("live-lines");
      lines.style.top = `${r.linesTop - r.y}px`;
      const ranked = [...r.agents].sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state]);
      for (const a of ranked.slice(0, MAX_LINES)) {
        const line = button(`live-line is-${a.state}`, "", () => select({ kind: "agent", id: a.id }));
        line.append(span("live-bullet"), span("live-who", nameOf(a)), span("live-doing", doing(a, now)));
        lines.append(line);
      }
      if (ranked.length > MAX_LINES) lines.append(div("live-more", `and ${ranked.length - MAX_LINES} more ${plural(ranked.length - MAX_LINES, "agent")}`));
      for (const j of r.jobs.slice(0, MAX_JOB_LINES)) {
        const line = div(`live-line is-job${j.kind === "launcher" ? " is-launcher" : ""}`);
        const owner = agentById(j.agent);
        line.append(
          span("live-diamond"),
          span("live-who", j.label),
          span("live-doing", [j.bay ? "in a test bay" : "", j.kind === "launcher" ? "starts agents" : "", owner ? `for ${nameOf(owner)}` : "", j.startedMs ? since(j.startedMs, now) : "", j.cpu >= 50 ? `${Math.round(j.cpu)}% CPU` : ""].filter(Boolean).join(" · ")),
        );
        lines.append(line);
      }
      if (r.jobs.length > MAX_JOB_LINES) lines.append(div("live-more", `and ${r.jobs.length - MAX_JOB_LINES} more ${plural(r.jobs.length - MAX_JOB_LINES, "job")}`));
      const e = r.embers[0];
      if (e) lines.append(button("live-last", `Last: ${emberLine(e, now)}`, () => select({ kind: "ember", id: e.id })));
      sign.append(lines);
      out.push(sign);
    }
    for (const a of world!.agents) {
      const d = l.dots.get(a.id);
      if (!d) continue;
      const hit = button(`live-hit${selection?.kind === "agent" && selection.id === a.id ? " is-on" : ""}`, "", () => select({ kind: "agent", id: a.id }));
      hit.style.transform = `translate(${d.x - 13}px, ${d.y - 13}px)`;
      hit.setAttribute("aria-label", `${nameOf(a)}, ${STATE_WORD[a.state]}`);
      hit.title = `${nameOf(a)} · ${STATE_WORD[a.state]}${a.now ? ` · ${a.now.label}` : ""}`;
      if (d.r >= 5.5) hit.append(span("live-letter", LETTER[a.harness]));
      out.push(hit);
      // Names show only where the eye needs them: a dot that waits, is stuck or is selected.
      if (a.state === "turn" || a.state === "stuck" || (selection?.kind === "agent" && selection.id === a.id)) {
        const tag = div(`live-tag is-${a.state}`, nameOf(a));
        tag.style.transform = `translate(${d.x}px, ${d.y + 12}px) translateX(-50%)`;
        out.push(tag);
      }
    }
    for (const e of world!.embers) {
      const at = l.embers.get(e.id);
      if (!at) continue;
      const hit = button("live-ember-hit", "", () => select({ kind: "ember", id: e.id }));
      hit.style.transform = `translate(${at.x - 6}px, ${at.y - 6}px)`;
      hit.title = `${e.name ?? HARNESS[e.harness]} · ${e.outcome === "cut" ? "ended mid-step" : "finished"} · ${ago(e.endedMs, now)}`;
      hit.setAttribute("aria-label", hit.title);
      out.push(hit);
    }
    labels.replaceChildren(...out);
  }

  function doing(a: LiveAgent, now: number): string {
    const timer = a.stateMs && now - a.stateMs > 20_000 ? ` · ${clock(now - a.stateMs)}` : "";
    switch (a.state) {
      case "work":
        return `${a.now?.label ?? "Working"}${timer}`;
      case "think":
        return a.steps[0] ? `Thinking after: ${a.steps[0].label}` : "Thinking";
      case "turn":
        return a.lastText ? `Waits for you: ${a.lastText}` : "Waits for you";
      case "stuck":
        return `Stuck on ${a.now?.label ?? "a step"}${timer}`;
      default:
        return a.lastText ? `Idle: ${a.lastText}` : "Idle";
    }
  }

  // ---------------------------------------------------------------- queue

  function paintQueue(now: number): void {
    const agents = world!.agents.map((a) => ({ id: a.id, name: nameOf(a), room: roomOf(a), state: a.state, stateMs: a.stateMs, headless: a.headless, panel: a.panel, lastText: a.lastText }));
    const built = buildCards(board, agents, weight, roomName, seen, now).filter((c) => !answered.has(c.id));
    cards = order(built, now, front, later);
    const top = cards[0] ?? null;
    // The front card holds its place only once the board has answered. Before that, a session's
    // card would claim the front and keep a more valuable decision behind it.
    front = boardRead ? (top?.id ?? null) : null;
    qsum.textContent = queueLine(cards);
    root.classList.toggle("is-calm", !cards.length);
    // The card in front is rebuilt only when it changes, so a hand on it never loses its place.
    const sig = top ? JSON.stringify([top.id, top.title, top.lines, top.options.map((o) => o.label), boardNote]) : `none:${boardNote}`;
    if (sig !== cardSig) {
      cardSig = sig;
      paintCard(top);
    }
    nextEl.replaceChildren(
      ...cards.slice(1, 9).map((c) => {
        const li = document.createElement("li");
        const b = button(`live-next-row is-${c.kind}`, "", () => {
          front = c.id;
          paintQueue(Date.now());
        });
        b.append(span("live-kind", KIND[c.kind].label), span("live-next-room", roomName(c.room)), span("live-next-title", withoutRoom(c.title, roomName(c.room))));
        if ((later[c.id] ?? 0) > now) b.append(span("live-later", "later"));
        li.append(b);
        return li;
      }),
    );
    if (cards.length > 9) {
      const li = document.createElement("li");
      li.className = "live-more";
      li.textContent = `and ${cards.length - 9} more`;
      nextEl.append(li);
    }
  }

  function paintCard(card: Card | null): void {
    if (!card) {
      const calm = div("live-calm");
      calm.append(div("live-calm-title", "Nothing needs you."), div("live-calm-text", "Every agent is working or idle on its own. You can leave."));
      if (boardNote) calm.append(div("live-calm-text is-note", boardNote));
      cardEl.replaceChildren(calm);
      closeTalk();
      return;
    }
    const head = div("live-card-head");
    head.append(span(`live-kind is-${card.kind}`, KIND[card.kind].label), span("live-card-room", roomName(card.room)));
    if (card.number && card.url) head.append(button("live-link", `#${card.number}`, () => events.openUrl(card.url!)));
    const title = div("live-card-title", card.title);
    const body = div("live-card-lines");
    for (const l of card.lines) body.append(div("live-card-line", l));
    const nodes: HTMLElement[] = [head, title, body];
    const pic = card.pictures?.[0];
    if (pic) {
      const img = document.createElement("img");
      img.className = "live-card-pic";
      img.alt = "";
      const cached = pictures.get(pic);
      if (cached) img.src = cached;
      else
        void events
          .picture(pic)
          .then((src) => {
            pictures.set(pic, src);
            img.src = src;
          })
          .catch(() => img.remove());
      nodes.push(img);
    }
    const acts = div("live-acts");
    card.options.forEach((o, i) => {
      const b = button(`live-btn${i === 0 ? " is-primary" : ""}`, "", () => void act(card, o.act));
      b.append(span("live-key", i === 0 ? "↩" : String(i + 1)), span("", o.label));
      acts.append(b);
    });
    if (card.talk) {
      const b = button("live-btn", "", () => openTalk(card));
      b.append(span("live-key", "T"), span("", "Talk"));
      acts.append(b);
    }
    const laterBtn = button("live-btn is-quiet", "", () => putOff(card));
    laterBtn.append(span("live-key", "↓"), span("", "Later"));
    acts.append(laterBtn);
    nodes.push(acts);
    cardEl.replaceChildren(...nodes);
    if (talkCard && talkCard !== card.id) closeTalk();
  }

  async function act(card: Card, a: Act): Promise<void> {
    switch (a.do) {
      case "answer": {
        status(`Answering #${a.number}…`);
        try {
          const r = await events.answer({ number: a.number, pick: a.pick });
          answered.add(card.id);
          status(r.said ? `Answered. ${r.said}` : `Answered #${a.number}.`);
          front = null;
          paintQueue(Date.now());
          void readBoard(true);
        } catch (e) {
          status(`Not answered: ${errorText(e, "the board refused it")}`, true);
        }
        return;
      }
      case "seen":
        markSeen(card);
        return;
      case "terminal":
        if (!events.openTerminal(a.panel)) status("That terminal is gone.", true);
        return;
      case "url":
        events.openUrl(a.url);
    }
  }

  function markSeen(card: Card): void {
    const now = Date.now();
    for (const k of card.seenKeys) seen[k] = now;
    writeSeen(seen);
    front = null;
    status("");
    paintQueue(now);
  }

  function putOff(card: Card): void {
    later[card.id] = Date.now() + LATER_MS;
    front = null;
    paintQueue(Date.now());
  }

  function openTalk(card: Card): void {
    if (!card.talk) return;
    talkCard = card.id;
    talkTo.textContent =
      card.talk.to === "board"
        ? `Goes to the board as your answer to #${card.talk.number}, in your words.`
        : card.talk.to === "agent"
          ? `Types into ${card.talk.name}'s terminal.`
          : "Goes to the Manager, with this card attached.";
    talk.hidden = false;
    talkText.focus();
  }

  function closeTalk(): void {
    talkCard = null;
    talk.hidden = true;
    talkText.value = "";
  }

  async function sendTalk(): Promise<void> {
    const card = cards.find((c) => c.id === talkCard);
    const words = talkText.value.trim();
    if (!card?.talk || !words) return;
    try {
      if (card.talk.to === "board") {
        status(`Sending your words to #${card.talk.number}…`);
        await events.answer({ number: card.talk.number, say: words });
        answered.add(card.id);
        void readBoard(true);
        status(`Your words are on #${card.talk.number}.`);
      } else if (card.talk.to === "agent") {
        if (!(await events.sendToAgent(card.talk.panel, words))) throw new Error("its terminal did not take the text");
        markSeen(card);
        status(`Sent to ${card.talk.name}.`);
      } else {
        await events.seedManager(managerBrief(card, words));
        status("Sent to the Manager.");
      }
      closeTalk();
      front = null;
      paintQueue(Date.now());
    } catch (e) {
      status(`Not sent: ${errorText(e, "unknown error")}`, true);
    }
  }

  q("[data-talk-send]").addEventListener("click", () => void sendTalk());
  q("[data-talk-cancel]").addEventListener("click", closeTalk);
  talkText.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void sendTalk();
    } else if (e.key === "Escape") closeTalk();
  });

  // ---------------------------------------------------------------- the panel beside a dot

  function select(next: Selection): void {
    const same = next && selection && next.kind === selection.kind && next.id === selection.id;
    selection = same ? null : next;
    agentText.value = "";
    paintPanel(Date.now());
    draw();
  }

  function paintPanel(now: number): void {
    const w = world;
    const sel = selection;
    const agent = sel?.kind === "agent" ? w?.agents.find((a) => a.id === sel.id) : undefined;
    const ember = sel?.kind === "ember" ? w?.embers.find((e) => e.id === sel.id) : undefined;
    if (!agent && !ember) {
      if (sel?.kind === "agent") {
        // The agent stopped while its panel was open: show its report instead.
        const report = w?.embers.find((e) => e.id.startsWith(`${sel.id}@`));
        if (report) {
          selection = { kind: "ember", id: report.id };
          return paintPanel(now);
        }
      }
      selection = null;
      panel.hidden = true;
      return;
    }
    const keep = panelBody.scrollTop;
    panelBody.replaceChildren(...(agent ? agentPanel(agent, now) : emberPanel(ember!, now)));
    panelBody.scrollTop = keep;
    agentTalk.hidden = !agent?.panel;
    agentText.placeholder = agent ? `Type to ${nameOf(agent)}. Enter sends.` : "";
    panel.hidden = false;
    placePanel();
  }

  function placePanel(): void {
    if (panel.hidden || !layout || !selection) return;
    const at = selection.kind === "agent" ? layout.dots.get(selection.id) : layout.embers.get(selection.id);
    if (!at) return;
    const width = stage.clientWidth;
    const right = at.x + 26 + PANEL_W <= width - 8;
    const x = right ? at.x + 26 : Math.max(8, at.x - 26 - PANEL_W);
    const maxTop = Math.max(8, stage.clientHeight - panel.offsetHeight - 8);
    const y = Math.min(Math.max(8, at.y - 40), maxTop);
    panel.style.transform = `translate(${x}px, ${y}px)`;
    panel.style.left = "0";
    panel.style.top = "0";
    // The tether ends on the panel's near edge, level with its name.
    panelAnchor = { x: right ? x : x + PANEL_W, y: y + 24 };
  }

  function agentPanel(a: LiveAgent, now: number): HTMLElement[] {
    const out: HTMLElement[] = [];
    const head = div("live-p-head");
    head.append(span(`live-bullet is-${a.state}`), span("live-p-name", nameOf(a)), button("live-x", "×", () => select(null)));
    out.push(head);
    out.push(div("live-p-sub", [HARNESS[a.harness], short(a.model), roomName(roomOf(a)), a.startedMs ? `running ${since(a.startedMs, now)}` : "", a.headless ? "nobody at it" : ""].filter(Boolean).join(" · ")));
    out.push(row("Now", `${STATE_WORD[a.state]}${a.now ? ` · ${a.now.label}` : ""}${a.stateMs && now - a.stateMs > 20_000 && (a.state === "work" || a.state === "stuck") ? ` · ${clock(now - a.stateMs)}` : ""}`));
    const iss = issueOf(a);
    if (iss) {
      const r = row("Task", "");
      r.querySelector(".live-p-val")!.append(button("live-link", `#${iss.number} ${iss.title}`, () => events.openUrl(iss.url)));
      out.push(r);
    } else if (a.task) out.push(row("Task", a.task));
    const parent = agentById(a.parent);
    const started = row("Started by", "");
    const val = started.querySelector(".live-p-val")!;
    if (parent) val.append(button("live-link", nameOf(parent), () => select({ kind: "agent", id: parent.id })));
    else val.textContent = a.via ? (a.via === "Terminal" ? "You, in Terminal" : a.via) : "Unknown";
    out.push(started);
    const kids = world!.agents.filter((k) => k.parent === a.id);
    const jobs = world!.jobs.filter((j) => j.agent === a.id);
    if (kids.length || jobs.length || a.helpers) {
      const fam = row("Family", "");
      const v = fam.querySelector(".live-p-val")!;
      for (const k of kids) v.append(button("live-chip", nameOf(k), () => select({ kind: "agent", id: k.id })));
      if (a.helpers) v.append(span("live-chip is-flat", `${a.helpers} ${plural(a.helpers, "helper")} running`));
      for (const j of jobs) v.append(span("live-chip is-flat", `◆ ${j.label}${j.bay ? " · test bay" : ""}${j.startedMs ? ` · ${since(j.startedMs, now)}` : ""}`));
      out.push(fam);
    }
    if (a.lastText && a.state !== "turn") out.push(row("Said", a.lastText));
    if (a.state === "turn" && a.lastText) out.push(row("Said", a.lastText));
    out.push(stepList(a.steps, now, "Done So Far"));
    if (a.files.length) out.push(fileList(a.files));
    const acts = div("live-acts");
    if (a.panel) acts.append(button("live-btn", "Terminal", () => void (events.openTerminal(a.panel!) || status("That terminal is gone.", true))));
    if (a.session && a.harness === "claude") acts.append(button("live-btn", "History", () => events.openHistory(a.session!)));
    if (a.pid) acts.append(holdButton("Hold to Stop", () => stopPid(a.pid!, nameOf(a))));
    out.push(acts);
    if (!a.panel) out.push(div("live-p-note", a.headless ? "It runs with nobody at it. Talk reaches it through the board." : "It runs outside Panel, so Panel cannot type into it."));
    return out;
  }

  function emberPanel(e: LiveEmber, now: number): HTMLElement[] {
    const out: HTMLElement[] = [];
    const head = div("live-p-head");
    head.append(span(`live-bullet is-${e.outcome === "cut" ? "stuck" : "done"}`), span("live-p-name", e.name ?? HARNESS[e.harness]), button("live-x", "×", () => select(null)));
    out.push(head);
    out.push(div("live-p-sub", [e.outcome === "cut" ? "Ended mid-step" : "Finished", ago(e.endedMs, now), e.startedMs ? `ran ${since(e.startedMs, e.endedMs)}` : "", HARNESS[e.harness], short(e.model), e.roomName].filter(Boolean).join(" · ")));
    if (e.task) out.push(row("Task", e.task));
    if (e.result) out.push(row("Result", e.result));
    out.push(row("Started by", e.parentName ?? (e.via === "Terminal" ? "You, in Terminal" : e.via ?? "Unknown")));
    out.push(stepList(e.steps, now, `What It Did · ${e.stepCount} ${plural(e.stepCount, "step")}`));
    if (e.files.length) out.push(fileList(e.files));
    if (e.session && e.harness === "claude") {
      const acts = div("live-acts");
      acts.append(button("live-btn", "Open in History", () => events.openHistory(e.session!)));
      out.push(acts);
    }
    return out;
  }

  function stepList(steps: Step[], now: number, title: string): HTMLElement {
    const box = div("live-p-steps");
    box.append(div("live-p-label", title));
    if (!steps.length) box.append(div("live-p-empty", "No steps read yet."));
    for (const s of steps.slice(0, 30)) {
      const r = div(`live-step is-${s.station}`);
      const label = s.file ? button("live-link", s.label, () => events.openFile(s.file!)) : span("live-step-label", s.label);
      r.append(span("live-step-dot"), label, span("live-step-when", ago(s.atMs, now)));
      box.append(r);
    }
    return box;
  }

  function fileList(files: string[]): HTMLElement {
    const box = div("live-p-steps");
    box.append(div("live-p-label", `Files Written · ${files.length}`));
    for (const f of files.slice(0, 8)) box.append(button("live-link is-file", f.split("/").slice(-2).join("/"), () => events.openFile(f)));
    return box;
  }

  async function stopPid(pid: number, who: string): Promise<void> {
    try {
      await events.stop(pid);
      status(`Asked ${who} to stop.`);
      void poll();
    } catch (e) {
      status(`Could not stop ${who}: ${errorText(e, "refused")}`, true);
    }
  }

  agentText.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      agentText.blur();
      return;
    }
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    const a = selection?.kind === "agent" ? agentById(selection.id) : undefined;
    const words = agentText.value.trim();
    if (!a?.panel || !words) return;
    void events.sendToAgent(a.panel, words).then((ok) => {
      if (ok) agentText.value = "";
      status(ok ? `Sent to ${nameOf(a)}.` : `${nameOf(a)}'s terminal did not take the text.`, !ok);
    });
  });

  // ---------------------------------------------------------------- this Mac and the roster

  function paintMac(now: number): void {
    const w = world!;
    const m = w.mac;
    const parts: HTMLElement[] = [];
    const load = div("live-mac-item");
    const share = m.cores ? Math.min(1, m.load / m.cores) : 0;
    const bar = div("live-meter");
    const fill = div(`live-meter-fill${share > 0.85 ? " is-hot" : ""}`);
    fill.style.width = `${Math.round(share * 100)}%`;
    bar.append(fill);
    load.append(span("live-mac-label", "Load"), bar, span("live-mac-val", m.cores ? `${m.load.toFixed(1)} of ${m.cores} cores` : m.load.toFixed(1)));
    parts.push(load);
    parts.push(item("Heat", m.hot ? "Hot: macOS slowed the CPU" : "Cool", m.hot));
    m.bays.forEach((b, i) => {
      const owner = agentById(b.agent);
      parts.push(item(`Test Bay ${i + 1}`, b.holder ? `${b.holder}${owner ? ` · ${nameOf(owner)}` : ""}` : "Free"));
    });
    const services = w.jobs.filter((j) => j.kind === "service");
    if (services.length) parts.push(item(`${services.length} ${plural(services.length, "Service")}`, services.map((s) => s.label).join(", ")));
    const left = w.jobs.filter((j) => j.kind === "left");
    if (left.length) {
      const box = div("live-mac-item is-warn");
      box.append(span("live-mac-label", "Left Behind"));
      for (const j of left) {
        const r = div("live-left");
        r.append(span("live-mac-val", `${j.label} · ${j.procs} ${plural(j.procs, "process", "processes")} · ${roomName(j.room)} · idle ${j.startedMs ? since(j.startedMs, now) : ""}`), holdButton("Hold to Stop", () => stopPid(j.pid, j.label)));
        box.append(r);
      }
      parts.push(box);
    }
    macEl.replaceChildren(...parts);
    macTop.textContent = m.hot ? "This Mac is hot" : share > 0.85 ? "This Mac is busy" : "";
    macTop.classList.toggle("is-hot", m.hot || share > 0.85);
  }

  function paintRoster(now: number): void {
    const w = world!;
    const ids = new Set(w.agents.map((a) => a.id));
    const kids = new Map<string, LiveAgent[]>();
    for (const a of w.agents) if (a.parent && ids.has(a.parent)) kids.set(a.parent, [...(kids.get(a.parent) ?? []), a]);
    const rowOf = (a: LiveAgent, depth: number): HTMLElement[] => {
      const li = document.createElement("li");
      const b = button(`live-row${selection?.kind === "agent" && selection.id === a.id ? " is-on" : ""}`, "", () => select({ kind: "agent", id: a.id }));
      b.style.paddingLeft = `${depth * 18 + 4}px`;
      b.append(
        span(`live-bullet is-${a.state}`),
        span("live-who", nameOf(a)),
        span("live-what", [HARNESS[a.harness], short(a.model), roomName(roomOf(a))].filter(Boolean).join(" · ")),
        span("live-doing", doing(a, now)),
        span("live-via", a.parent ? "" : a.via ? `from ${a.via}` : ""),
      );
      li.append(b);
      return [li, ...(kids.get(a.id) ?? []).flatMap((k) => rowOf(k, depth + 1))];
    };
    const roots = w.agents.filter((a) => !a.parent || !ids.has(a.parent));
    if (!roots.length) {
      const li = document.createElement("li");
      li.className = "live-empty";
      li.textContent = "No agent is running. Start one from a project, and it shows here within 2 seconds.";
      roster.replaceChildren(li);
      return;
    }
    roster.replaceChildren(...roots.flatMap((a) => rowOf(a, 0)));
  }

  // ---------------------------------------------------------------- keys

  function onKey(e: KeyboardEvent): void {
    if (!open || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable)) return;
    const card = cards[0];
    if (e.key === "Escape") {
      if (selection) select(null);
      else closeTalk();
      return;
    }
    if (!card) return;
    if (e.key === "Enter" && card.options[0]) void act(card, card.options[0].act);
    else if ((e.key === "2" || e.key === "3") && card.options[Number(e.key) - 1]) void act(card, card.options[Number(e.key) - 1].act);
    else if (e.key === "t" || e.key === "T") openTalk(card);
    else if (e.key === "ArrowDown") putOff(card);
    else if (e.key === " ") {
      const sign = layout?.rooms.find((r) => r.key === card.room);
      if (sign) {
        stage.scrollIntoView({ block: "nearest" });
        pendingFx.push({ entry: "card", kind: "card", x: sign.x + 14, y: sign.y + 19, r: 6 });
        draw();
      }
    } else return;
    e.preventDefault();
  }

  new ResizeObserver(() => draw()).observe(stage);

  return {
    open() {
      open = true;
      view?.set_paused(false);
      void startView();
      void poll();
      document.addEventListener("keydown", onKey);
      if (timer === null) timer = window.setInterval(() => void poll(), POLL_MS);
    },
    clear() {
      open = false;
      document.removeEventListener("keydown", onKey);
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      // Bevy sleeps until the canvas reappears, so a closed Live costs no frames.
      view?.set_paused(true);
    },
  };
}

// ---------------------------------------------------------------- small parts

function radius(a: LiveAgent): number {
  const m = (a.model ?? "").toLowerCase();
  if (/opus|fable|-sol|gpt-\d+(\.\d+)?$|pro/.test(m)) return 7;
  if (/haiku|flash|mini|nano|lite/.test(m)) return 4.5;
  return 5.5;
}

function short(model: string | null): string {
  if (!model) return "";
  const m = model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
  const parts = m.split("-");
  if (/^(opus|sonnet|haiku|fable)$/.test(parts[0])) return `${cap(parts[0])} ${parts.slice(1).join(".")}`.trim();
  return m.replace(/^gpt-[\d.]+-/, "").replace(/^./, (c) => c.toUpperCase());
}

function emberLine(e: LiveEmber, now: number): string {
  const who = e.name ?? HARNESS[e.harness];
  const how = e.outcome === "cut" ? "ended mid-step" : "finished";
  return `${who} ${how} ${ago(e.endedMs, now)}${e.result ? `: ${e.result}` : ""}`;
}

/** Board titles start with their app, "Tavla: …". The row already names the room. */
function withoutRoom(title: string, room: string): string {
  return title.toLowerCase().startsWith(`${room.toLowerCase()}: `) ? title.slice(room.length + 2) : title;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function since(ms: number, now: number): string {
  const min = Math.max(1, Math.round((now - ms) / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}

function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  return `${since(ms, now)} ago`;
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

function readSeen(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}") as Record<string, number>;
    // A week of seen marks is plenty: the board forgets older closes anyway.
    const cut = Date.now() - 7 * 86_400_000;
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === "number" && v > cut));
  } catch {
    return {};
  }
}

function writeSeen(seen: Record<string, number>): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    // Private storage off: seen marks last this session only.
  }
}

function div(cls: string, text = ""): HTMLElement {
  const el = document.createElement("div");
  el.className = cls;
  if (text) el.textContent = text;
  return el;
}

function span(cls: string, text = ""): HTMLElement {
  const el = document.createElement("span");
  if (cls) el.className = cls;
  if (text) el.textContent = text;
  return el;
}

function button(cls: string, text: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = cls;
  if (text) el.textContent = text;
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return el;
}

function row(label: string, value: string): HTMLElement {
  const r = div("live-p-row");
  r.append(span("live-p-label", label), span("live-p-val", value));
  return r;
}

function item(label: string, value: string, warn = false): HTMLElement {
  const box = div(`live-mac-item${warn ? " is-warn" : ""}`);
  box.append(span("live-mac-label", label), span("live-mac-val", value));
  return box;
}

function place2(el: HTMLElement, x: number, y: number, w: number, h: number): void {
  el.style.transform = `translate(${x}px, ${y}px)`;
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
}

/** Stop needs a one-second hold, so a slip never kills an agent. */
function holdButton(label: string, fire: () => void): HTMLButtonElement {
  const b = button("live-btn is-danger live-hold", label, () => undefined);
  let t: number | null = null;
  const cancel = () => {
    if (t !== null) window.clearTimeout(t);
    t = null;
    b.classList.remove("is-holding");
  };
  b.addEventListener("pointerdown", () => {
    b.classList.add("is-holding");
    t = window.setTimeout(() => {
      cancel();
      fire();
    }, HOLD_MS);
  });
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) b.addEventListener(ev, cancel);
  return b;
}
