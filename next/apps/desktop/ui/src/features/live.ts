/**
 * Live — every agent running on this Mac, in the room of the project it works in.
 *
 * The backend scans what the agents already leave behind (src-tauri/src/live.rs). This screen
 * lays the scene out in CSS pixels and hands it to Bevy, built to WebAssembly from apps/live,
 * which draws the rooms and the glowing dots. Words stay in HTML on top: room names, agent
 * names, and the tree of who started whom below the stage.
 *
 * Polled every 2 s, and only while the screen is open. Bevy sleeps while it is closed. If Bevy
 * cannot start, the tree still updates and the stage says why.
 */

import { invoke } from "@tauri-apps/api/core";
import { errorText } from "../errors";
import "./live.css";

type Harness = "claude" | "codex" | "grok" | "opencode" | "gemini" | "kimi";

type LiveAgent = {
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
};

type LiveWorld = { agents: LiveAgent[]; scannedMs: number };

type Box = { x: number; y: number; w: number; h: number };
type PlacedRoom = Box & { key: string; name: string; agents: LiveAgent[] };
type Placed = { rooms: PlacedRoom[]; dots: Map<string, { x: number; y: number; r: number }>; height: number };

/** What `apps/live` exports after wasm-bindgen. */
type BevyView = {
  default: () => Promise<unknown>;
  start: (canvas: string) => void;
  set_scene: (json: string) => void;
  set_paused: (paused: boolean) => void;
};

const POLL_MS = 2000;
const HARNESS: Record<Harness, string> = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
  opencode: "OpenCode",
  gemini: "Gemini",
  kimi: "Kimi",
};
const ROOM_H = 128;
const PAD = 16;
const GAP = 12;
const DOT_STEP = 30;

export type LiveHandle = { open(): void; clear(): void };

export function mountLive(root: HTMLElement): LiveHandle {
  root.innerHTML = `
    <header class="live-bar">
      <span class="live-title">Live</span>
      <span class="live-tally" data-tally>Looking for agents…</span>
    </header>
    <div class="live-body">
      <div class="live-stage" data-stage>
        <canvas id="liveCanvas" class="live-canvas" tabindex="-1" aria-hidden="true"></canvas>
        <div class="live-labels" data-labels></div>
        <p class="live-note" data-note hidden></p>
      </div>
      <section class="live-tree" aria-label="Who started whom">
        <h2 class="live-h2">Who started whom</h2>
        <ul class="live-list" data-tree></ul>
      </section>
    </div>`;
  const stage = root.querySelector<HTMLElement>("[data-stage]")!;
  const labels = root.querySelector<HTMLElement>("[data-labels]")!;
  const note = root.querySelector<HTMLElement>("[data-note]")!;
  const tally = root.querySelector<HTMLElement>("[data-tally]")!;
  const tree = root.querySelector<HTMLElement>("[data-tree]")!;

  let timer: number | null = null;
  let world: LiveWorld | null = null;
  let shown = "";
  let view: BevyView | null = null;
  let viewTried = false;

  const say = (text: string) => {
    note.textContent = text;
    note.hidden = !text;
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
      say(`The live view did not start: ${errorText(e, "Bevy failed to load")}. The list below still updates.`);
    }
  }

  let polling = false;
  async function poll(): Promise<void> {
    // A scan slower than the interval must not stack up `ps` and `lsof` runs.
    if (polling) return;
    polling = true;
    try {
      world = await invoke<LiveWorld>("live_world");
      paint();
    } catch (e) {
      tally.textContent = `Could not read the agents: ${errorText(e, "the scan failed")}`;
    } finally {
      polling = false;
    }
  }

  function paint(): void {
    if (!world) return;
    // The scan time changes every poll. Only a change in the agents themselves repaints.
    const sig = JSON.stringify(world.agents);
    if (sig === shown) return;
    shown = sig;
    const agents = world.agents;
    const rooms = new Set(agents.map((a) => a.room)).size;
    const busy = agents.filter((a) => a.busy).length;
    tally.textContent = agents.length
      ? `${agents.length} ${agents.length === 1 ? "agent" : "agents"} in ${rooms} ${rooms === 1 ? "room" : "rooms"} · ${busy} working`
      : "No agent is running on this Mac";
    paintTree(agents);
    draw();
  }

  function draw(): void {
    if (!world) return;
    const width = stage.clientWidth;
    if (!width) return;
    const placed = place(world.agents, width);
    stage.style.height = `${placed.height}px`;
    paintLabels(placed);
    view?.set_scene(JSON.stringify(scene(placed, world.agents, width)));
  }

  function paintLabels(placed: Placed): void {
    labels.replaceChildren(
      ...placed.rooms.flatMap((room) => {
        const head = div("live-room-name", `${room.name} · ${room.agents.length}`);
        head.style.transform = `translate(${room.x + 12}px, ${room.y + 10}px)`;
        head.style.maxWidth = `${room.w - 24}px`;
        const names = room.agents.map((a) => {
          const dot = placed.dots.get(a.id)!;
          const tag = div("live-dot-name", shortName(a));
          tag.style.transform = `translate(${dot.x}px, ${dot.y + 14}px) translateX(-50%)`;
          tag.title = `${label(a)} · ${HARNESS[a.harness]}${a.headless ? " · no one at it" : ""} · ${a.cwd}`;
          return tag;
        });
        return [head, ...names];
      }),
    );
  }

  function paintTree(agents: LiveAgent[]): void {
    const ids = new Set(agents.map((a) => a.id));
    const kids = new Map<string, LiveAgent[]>();
    for (const a of agents) {
      if (a.parent && ids.has(a.parent)) kids.set(a.parent, [...(kids.get(a.parent) ?? []), a]);
    }
    const row = (a: LiveAgent, depth: number): HTMLElement[] => {
      const li = document.createElement("li");
      li.className = "live-row";
      li.style.paddingLeft = `${depth * 18}px`;
      li.innerHTML = `<i class="live-state ${a.busy ? "is-busy" : ""}" aria-hidden="true"></i>`;
      li.append(
        span("live-who", label(a)),
        span("live-what", [HARNESS[a.harness], a.headless ? "no one at it" : null, a.roomName].filter(Boolean).join(" · ")),
        span("live-when", [a.busy ? "working" : "waiting", a.startedMs ? `for ${since(a.startedMs)}` : null].filter(Boolean).join(", ")),
        span("live-via", a.parent ? "" : a.via ? `from ${a.via}` : "parent unknown"),
      );
      return [li, ...(kids.get(a.id) ?? []).flatMap((k) => row(k, depth + 1))];
    };
    const roots = agents.filter((a) => !a.parent || !ids.has(a.parent));
    tree.replaceChildren(...(roots.length ? roots.flatMap((a) => row(a, 0)) : [emptyRow()]));
  }

  new ResizeObserver(() => draw()).observe(stage);

  return {
    open() {
      view?.set_paused(false);
      void startView();
      void poll();
      if (timer === null) timer = window.setInterval(() => void poll(), POLL_MS);
    },
    clear() {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      // Bevy sleeps until the canvas reappears, so a closed Live costs no frames.
      view?.set_paused(true);
    },
  };
}

/** Rooms in a grid, busiest first. Dots sit in one row per room, in the order the scan gives. */
function place(agents: LiveAgent[], width: number): Placed {
  const byRoom = new Map<string, LiveAgent[]>();
  for (const a of agents) byRoom.set(a.room, [...(byRoom.get(a.room) ?? []), a]);
  const order = [...byRoom.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const cols = Math.max(1, Math.min(4, Math.floor((width - PAD * 2 + GAP) / (240 + GAP))));
  const w = (width - PAD * 2 - GAP * (cols - 1)) / cols;
  const dots = new Map<string, { x: number; y: number; r: number }>();
  const rooms = order.map(([key, list], i) => {
    const x = PAD + (i % cols) * (w + GAP);
    const y = PAD + Math.floor(i / cols) * (ROOM_H + GAP);
    const step = Math.min(DOT_STEP, (w - 32) / Math.max(1, list.length));
    const start = x + w / 2 - (step * (list.length - 1)) / 2;
    list.forEach((a, n) => dots.set(a.id, { x: start + n * step, y: y + 66, r: a.headless ? 4.5 : 6 }));
    return { key, name: list[0].roomName, agents: list, x, y, w, h: ROOM_H };
  });
  const rows = Math.max(1, Math.ceil(rooms.length / cols));
  return { rooms, dots, height: PAD * 2 + rows * ROOM_H + (rows - 1) * GAP };
}

function scene(placed: Placed, agents: LiveAgent[], width: number) {
  const links = agents.flatMap((a) => {
    const from = a.parent ? placed.dots.get(a.parent) : undefined;
    const to = placed.dots.get(a.id);
    return from && to ? [{ x1: from.x, y1: from.y, x2: to.x, y2: to.y }] : [];
  });
  return {
    w: width,
    h: placed.height,
    rooms: placed.rooms.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h, hot: r.agents.some((a) => a.busy) })),
    links,
    dots: agents.flatMap((a) => {
      const d = placed.dots.get(a.id);
      return d ? [{ ...d, state: a.busy ? "work" : "idle" }] : [];
    }),
  };
}

function label(a: LiveAgent): string {
  return a.name ?? `${HARNESS[a.harness]} ${a.pid ?? a.session?.slice(0, 8) ?? ""}`.trim();
}

function shortName(a: LiveAgent): string {
  return a.name ?? HARNESS[a.harness];
}

function since(ms: number): string {
  const min = Math.max(1, Math.round((Date.now() - ms) / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}

function div(cls: string, text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = cls;
  el.textContent = text;
  return el;
}

function span(cls: string, text: string): HTMLElement {
  const el = document.createElement("span");
  el.className = cls;
  el.textContent = text;
  return el;
}

function emptyRow(): HTMLElement {
  const li = document.createElement("li");
  li.className = "live-empty";
  li.textContent = "No agent is running. Start one from a project, and it shows here within 2 seconds.";
  return li;
}
