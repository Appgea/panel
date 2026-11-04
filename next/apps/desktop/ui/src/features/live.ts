/**
 * Live — a dark map of this Mac where every agent is a small electron that acts out what it is
 * doing, and a column beside it that says who each agent is. The owner drags and zooms the map
 * like a game scene.
 *
 * Live shows activity and nothing else. The decisions that wait for the owner are in For you
 * (foryou.ts), the issues on the Board, what agents made in Review. Owner, 2026-11-05: "no
 * review, no boards, tasks. They must be a separate section."
 *
 * The map (live_world.ts): This Mac in the middle with its testlock bays, the GitHub tower above
 * and the web gate right. Each project with a running agent is a round district around them.
 *
 * Each step an agent takes has a verb, and each verb has an animation script in the catalog
 * (live_script.ts). A git push carries a crate up the tower. A search sweeps a radar. A verb
 * with no script yet gets one written on its own (src-tauri/src/live/catalog.rs), and the owner
 * deletes bad ones in the catalog view (live_catalog.ts).
 *
 * Bevy, built to WebAssembly from apps/live, draws every shape from the scene in live_scene.ts.
 * Words are HTML on top: live_labels on the map, live_side, live_panel and live_catalog in the
 * column, and live_top over both.
 *
 * This file mounts, polls, keeps the state, moves the camera and starts scripts. Polled every
 * 2 s and the board every 60 s, only while the screen is open. Bevy sleeps while it is closed.
 * If Bevy cannot start, everything else still works and the stage says why.
 */

import { errorText } from "../errors";
import type { BoardFeed } from "./live_cards";
import { mountCatalog } from "./live_catalog";
import { facts } from "./live_facts";
import { mountLabels } from "./live_labels";
import { mountPanel } from "./live_panel";
import { direct, type EmberEnd, type Seen } from "./live_playbook";
import { scene } from "./live_scene";
import { PLAIN, play, type Pt, type Script, type Stagehand } from "./live_script";
import { mountSide } from "./live_side";
import { button, doing } from "./live_text";
import { mountTop, TOP_HTML } from "./live_top";
import type { BevyView, LiveCtx, LiveEvents, LiveState, Selection } from "./live_types";
import { lay } from "./live_world";
import "./live.css";

export type { LiveAgent, LiveEmber, LiveEvents, LiveJob, LiveWorld } from "./live_types";
export type LiveHandle = { open(): void; clear(): void };

const POLL_MS = 2000;
const BOARD_MS = 60_000;
/** More scripts at once than this is noise. A step that finds no room just shows its words. */
const MAX_SCRIPTS = 6;
/**
 * Below 0.3 a district is a speck and every word is hidden to keep the rest apart. Above 1.6 the
 * map's lines turn thick and soft.
 */
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 1.6;
/** One press of + or −. */
const ZOOM_STEP = 1.25;

export function mountLive(root: HTMLElement, events: LiveEvents): LiveHandle {
  root.innerHTML = `
    ${TOP_HTML}
    <div class="live-body">
      <div class="live-stage" data-stage>
        <canvas id="liveCanvas" class="live-canvas" tabindex="-1" aria-hidden="true"></canvas>
        <div class="live-labels" data-labels></div>
        <div class="live-tools" data-tools></div>
        <div class="live-toast" data-toast role="status" hidden></div>
        <p class="live-note" data-note hidden></p>
      </div>
      <aside class="live-side" aria-label="Agents on this Mac">
        <div class="live-list" data-list></div>
        <div class="apanel" data-panel hidden></div>
        <div class="live-catalog" data-catalog></div>
      </aside>
    </div>
    <p class="live-hint">Drag to move. Scroll or pinch to zoom, 0 fits the map. Click an agent or its row to follow it.</p>`;
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const stage = q("[data-stage]");
  const tools = q("[data-tools]");
  const note = q("[data-note]");
  const listEl = q("[data-list]");
  const panelEl = q("[data-panel]");
  const catalogEl = q("[data-catalog]");

  const reducedQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  const s: LiveState = {
    world: null,
    board: null,
    layout: null,
    slots: new Map(),
    camera: { x: 0, y: 0, zoom: 0.6 },
    cameraHeld: false,
    walks: new Map(),
    carries: new Map(),
    bubbles: new Map(),
    lights: new Map(),
    selection: null,
    hover: null,
    pendingFx: [],
    reduced: !!reducedQuery?.matches,
  };
  root.classList.toggle("is-reduced", s.reduced);
  reducedQuery?.addEventListener?.("change", (e) => {
    s.reduced = e.matches;
    root.classList.toggle("is-reduced", s.reduced);
    draw();
  });

  let view: BevyView | null = null;
  let viewTried = false;
  let timer: number | null = null;
  let polling = false;
  let boardAt = 0;
  let open = false;
  const played = new Map<string, number>();
  let lastSeen: Seen | null = null;
  let knownEmbers: Set<string> | null = null;
  /** The stop function of each running script, by agent. */
  const running = new Map<string, () => void>();
  /** The last step each agent acted out, as verb@time, so a step plays once. */
  const acted = new Map<string, string>();

  const toScreen = (p: Pt): Pt => ({ x: (p.x - s.camera.x) * s.camera.zoom + stage.clientWidth / 2, y: (p.y - s.camera.y) * s.camera.zoom + stage.clientHeight / 2 });
  const toWorld = (p: Pt): Pt => ({ x: (p.x - stage.clientWidth / 2) / s.camera.zoom + s.camera.x, y: (p.y - stage.clientHeight / 2) / s.camera.zoom + s.camera.y });

  const ctx: LiveCtx = {
    ...facts(() => s),
    s,
    events,
    stage,
    select,
    hover,
    draw,
    toScreen,
    poll: () => void poll(),
    toast: (text, bad) => top.toast(text, bad),
  };
  const top = mountTop(ctx, root, q("[data-toast]"));
  const panel = mountPanel(ctx, panelEl);
  const labels = mountLabels(ctx, q("[data-labels]"));
  const side = mountSide(ctx, listEl);
  const catalog = mountCatalog(ctx, catalogEl, playOn, () => {
    paintTools();
    paintColumn();
  });

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
      say(`The live view did not start: ${errorText(e, "Bevy failed to load")}. Everything else still updates.`);
    }
  }

  async function poll(): Promise<void> {
    // A scan slower than the interval must not stack up `ps` and `lsof` runs.
    if (polling) return;
    polling = true;
    try {
      s.world = await events.world();
      if (Date.now() - boardAt > BOARD_MS) void readBoard();
      paint();
    } catch (e) {
      top.say(`Could not read the agents: ${errorText(e, "the scan failed")}`);
    } finally {
      polling = false;
    }
  }

  /** The board names each worker's issue and project, and its closes ring their district. */
  async function readBoard(): Promise<void> {
    boardAt = Date.now();
    try {
      const b = (await events.board(false)) as (BoardFeed & { error?: string }) | null;
      if (b && !b.error) s.board = b;
    } catch {
      // Without the board an agent shows its own task instead of its issue.
    }
    paint();
  }

  // ---------------------------------------------------------------- scripts

  const scriptFor = (verb: string): Script | undefined => s.world?.catalog?.find((x) => x.verb === verb && !x.pending);

  const hand: Stagehand = {
    where(id, place) {
      const w = s.layout;
      const spot = w?.dots.get(id);
      if (!w || !spot) return [];
      const self = s.walks.get(id) ?? spot;
      const a = ctx.agentById(id);
      const district = w.districts.find((d) => d.key === spot.room);
      const mine = district?.tiles.filter((t) => t.agents.includes(id)) ?? [];
      const L = w.landmarks;
      switch (place) {
        case "self":
          return [self];
        case "home":
          return district ? [district] : [self];
        case "file": {
          const f = a?.now?.file;
          const t = district?.tiles.find((x) => x.path === f) ?? mine[0];
          return [t ?? self];
        }
        case "files":
          return mine;
        case "parent": {
          const p = a?.parent ? w.dots.get(a.parent) : undefined;
          return [p ? (s.walks.get(a!.parent!) ?? p) : self];
        }
        case "helpers": {
          const kids = (s.world?.agents ?? []).filter((k) => k.parent === id).flatMap((k) => {
            const d = w.dots.get(k.id);
            return d && d.swarm >= 0 ? [s.walks.get(k.id) ?? d] : [];
          });
          if (kids.length) return kids;
          // Helpers that are not on the map, or a swarm: points around the agent.
          const n = Math.max(3, Math.min(8, (a?.helpers ?? 0) + spot.swarm));
          return Array.from({ length: n }, (_, i) => ({ x: self.x + Math.cos((i / n) * Math.PI * 2) * 34, y: self.y + Math.sin((i / n) * Math.PI * 2) * 26 }));
        }
        case "hub":
        // The desk and the board left the map. Scripts written before still name them: the
        // owner sits at This Mac, and the board is GitHub's.
        case "desk":
          return [w.hub];
        case "bay": {
          const i = s.world?.mac.bays.findIndex((b) => b.agent === id) ?? -1;
          return [w.hub.bays[Math.max(0, i)]];
        }
        case "board":
          return [L.tower];
        case "tower":
        case "sky":
        case "web":
          return [L[place]];
        default:
          return [];
      }
    },
    fx(f) {
      if (!s.reduced) s.pendingFx.push(f);
    },
    walk(id, to) {
      if (to && !s.reduced) s.walks.set(id, to);
      else s.walks.delete(id);
    },
    carry(id, color) {
      if (color) s.carries.set(id, color);
      else s.carries.delete(id);
    },
    say(id, text) {
      if (text) s.bubbles.set(id, text);
      else s.bubbles.delete(id);
    },
    light(id, at, color, ms) {
      const w = s.layout;
      const a = ctx.agentById(id);
      const spot = w?.dots.get(id);
      const district = w?.districts.find((d) => d.key === spot?.room);
      const tiles = (district?.tiles ?? []).filter((t) => t.agents.includes(id));
      const pick = at === "file" ? [tiles.find((t) => t.path === a?.now?.file) ?? tiles[0]].filter(Boolean) : tiles;
      const until = Date.now() + ms;
      for (const t of pick) s.lights.set(t.path, { color, until });
    },
    label(id) {
      const a = ctx.agentById(id);
      return a ? doing(a) : "";
    },
    flush: () => draw(),
  };

  function run(id: string, script: Script): void {
    running.get(id)?.();
    running.set(
      id,
      play(script, id, hand, () => running.delete(id)),
    );
  }

  /** Each new step of a working agent plays its verb's script, or the plain one. */
  function act(): void {
    const w = s.world!;
    for (const id of running.keys()) if (!w.agents.some((a) => a.id === id)) running.get(id)?.();
    for (const id of acted.keys()) if (!w.agents.some((a) => a.id === id)) acted.delete(id);
    for (const a of w.agents) {
      const step = a.now ?? (a.state === "think" ? a.steps[0] : undefined);
      if (!step || (a.state !== "work" && a.state !== "think")) continue;
      const key = `${step.verb ?? ""}@${step.atMs}`;
      if (acted.get(a.id) === key) continue;
      if (running.has(a.id) || running.size >= MAX_SCRIPTS || (s.layout?.dots.get(a.id)?.swarm ?? -1) < 0) continue;
      acted.set(a.id, key);
      run(a.id, scriptFor(step.verb ?? "") ?? PLAIN);
    }
  }

  /** The catalog's Play: on the open agent, or on the busiest one. */
  function playOn(verb: string): boolean {
    const x = scriptFor(verb);
    const w = s.world;
    if (!x || !w) return false;
    const sel = s.selection?.kind === "agent" ? s.selection.id : null;
    const a = (sel && w.agents.find((g) => g.id === sel)) || w.agents.find((g) => g.state === "work") || w.agents.find((g) => (s.layout?.dots.get(g.id)?.swarm ?? -1) >= 0);
    if (!a) return false;
    run(a.id, x);
    return true;
  }

  // ---------------------------------------------------------------- paint

  function paint(): void {
    if (!s.world) return;
    top.paint();
    draw();
    act();
    panel.paint();
    catalog.paint();
    side.paint();
    paintTools();
    paintColumn();
  }

  /** The column shows one thing: the catalog, else the open panel, else the list of agents. */
  function paintColumn(): void {
    listEl.hidden = catalog.isOpen() || !panelEl.hidden;
  }

  function fit(): void {
    const b = s.layout?.bounds;
    const W = stage.clientWidth;
    const H = stage.clientHeight;
    if (!b || !W || !H) return;
    const zoom = clamp(Math.min((W - 40) / (b.x1 - b.x0), (H - 40) / (b.y1 - b.y0)), ZOOM_MIN, 1);
    s.camera = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, zoom };
  }

  function draw(): void {
    const w = s.world;
    const width = stage.clientWidth;
    if (!w || !width) return;
    const now = Date.now();
    s.layout = lay({ world: w, roomOf: ctx.roomOf, roomName: ctx.roomName, slots: s.slots });
    for (const [path, l] of s.lights) if (l.until < now) s.lights.delete(path);
    if (!s.cameraHeld) fit();
    labels.paint();

    const snapshot = snap();
    const endings: EmberEnd[] = knownEmbers ? w.embers.filter((e) => !knownEmbers!.has(e.id)).map((e) => ({ id: e.id, agentId: e.id.split("@")[0], outcome: e.outcome })) : [];
    knownEmbers = new Set(w.embers.map((e) => e.id));
    s.pendingFx.push(...direct(lastSeen, snapshot, endings, played, now));
    lastSeen = snapshot;
    // Effects are for this moment only. Without a view they are dropped, not saved up.
    if (view) view.set_scene(JSON.stringify(scene(ctx, width, stage.clientHeight)));
    s.pendingFx = [];
  }

  function snap(): Seen {
    const l = s.layout!;
    const dots: Seen["dots"] = new Map();
    for (const a of s.world!.agents) {
      const d = l.dots.get(a.id);
      if (d) dots.set(a.id, { x: d.x, y: d.y, r: d.r, parent: a.parent, files: a.files });
    }
    const districts: Seen["districts"] = new Map(l.districts.map((d) => [d.key, { x: d.x, y: d.y, r: d.r }]));
    const closed: Seen["closed"] = new Map((s.board?.done ?? []).filter((i) => !i.dropped).map((i) => [i.number, i.apps[0] ?? "hq"]));
    return { dots, districts, closed };
  }

  // The tools are made once. A drag repaints them on every move, so a repaint only sets states.
  const zoomOut = button("live-tool is-icon", "−", () => zoomBy(1 / ZOOM_STEP));
  zoomOut.setAttribute("aria-label", "Zoom out");
  zoomOut.title = "Zoom out (−)";
  const zoomIn = button("live-tool is-icon", "+", () => zoomBy(ZOOM_STEP));
  zoomIn.setAttribute("aria-label", "Zoom in");
  zoomIn.title = "Zoom in (+)";
  const fitBtn = button("live-tool", "Fit", () => refit());
  fitBtn.title = "Fit the map (0)";
  const anim = button("live-tool", "Animations", () => {
    if (!catalog.isOpen() && s.selection) select(null);
    catalog.toggle();
  });
  tools.append(zoomOut, zoomIn, fitBtn, anim);

  function paintTools(): void {
    const n = catalog.count();
    const writing = (s.world?.catalog ?? []).filter((x) => x.pending).length;
    zoomOut.disabled = s.camera.zoom <= ZOOM_MIN + 0.001;
    zoomIn.disabled = s.camera.zoom >= ZOOM_MAX - 0.001;
    fitBtn.disabled = !s.cameraHeld;
    const label = `Animations ${n}${writing ? ` · ${writing} writing` : ""}`;
    if (anim.textContent !== label) anim.textContent = label;
    anim.classList.toggle("is-on", catalog.isOpen());
  }

  function select(next: Selection): void {
    const same = next && s.selection && next.kind === s.selection.kind && next.id === s.selection.id;
    s.selection = same ? null : next;
    if (s.selection && catalog.isOpen()) catalog.toggle();
    panel.paint();
    draw();
    side.paint();
    paintColumn();
  }

  function hover(id: string | null): void {
    if (id === s.hover) return;
    s.hover = id;
    draw();
    side.paint();
  }

  function refit(): void {
    s.cameraHeld = false;
    draw();
    paintTools();
  }

  /** Zooms around the stage's centre, for the buttons and keys. */
  function zoomBy(f: number): void {
    s.camera.zoom = clamp(s.camera.zoom * f, ZOOM_MIN, ZOOM_MAX);
    moveCamera();
  }

  // ---------------------------------------------------------------- camera, pointer and keys

  /** Moves the camera without a new scene, so a drag stays smooth. */
  function moveCamera(): void {
    view?.set_camera(s.camera.x, s.camera.y, s.camera.zoom);
    labels.paint();
    s.cameraHeld = true;
    paintTools();
  }

  const OVER = ".live-tools, button, input";
  let drag: { x: number; y: number; moved: boolean; id: number } | null = null;
  stage.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest(OVER)) return;
    drag = { x: e.clientX, y: e.clientY, moved: false, id: e.pointerId };
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    if (!drag.moved) root.classList.add("is-panning");
    drag.moved = true;
    drag.x = e.clientX;
    drag.y = e.clientY;
    s.camera.x -= dx / s.camera.zoom;
    s.camera.y -= dy / s.camera.zoom;
    moveCamera();
  });
  const endDrag = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    // A click on empty map closes the open panel.
    if (!drag.moved && s.selection) select(null);
    drag = null;
    root.classList.remove("is-panning");
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);
  stage.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      const at = { x: e.clientX - r.left, y: e.clientY - r.top };
      const before = toWorld(at);
      // A pinch on a trackpad comes as a wheel with ctrl held, and moves faster.
      s.camera.zoom = clamp(s.camera.zoom * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), ZOOM_MIN, ZOOM_MAX);
      s.camera.x = before.x - (at.x - stage.clientWidth / 2) / s.camera.zoom;
      s.camera.y = before.y - (at.y - stage.clientHeight / 2) / s.camera.zoom;
      root.classList.add("is-panning");
      moveCamera();
      window.clearTimeout(wheelEnd);
      wheelEnd = window.setTimeout(() => root.classList.remove("is-panning"), 120);
    },
    { passive: false },
  );
  let wheelEnd = 0;
  stage.addEventListener("dblclick", (e) => {
    if (!(e.target as HTMLElement).closest(OVER)) refit();
  });

  stage.addEventListener("pointerover", (e) => {
    hover((e.target as HTMLElement).closest<HTMLElement>(".live-agent")?.dataset.agent ?? null);
  });
  stage.addEventListener("pointerleave", () => hover(null));

  function onKey(e: KeyboardEvent): void {
    if (!open || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable)) return;
    if (e.key === "Escape" && s.selection) select(null);
    else if (e.key === "0") refit();
    else if (e.key === "+" || e.key === "=") zoomBy(ZOOM_STEP);
    else if (e.key === "-") zoomBy(1 / ZOOM_STEP);
    else return;
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
      for (const stop of [...running.values()]) stop();
      // Bevy sleeps until the canvas reappears, so a closed Live costs no frames.
      view?.set_paused(true);
    },
  };
}

function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v));
}
