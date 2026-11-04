/**
 * Live — what every agent, script and process on this Mac is doing, and the few things that
 * need the owner. The target look is the concept page at
 * ~/.appgeapanel/state/panel-live/concept.html.
 *
 * One drawn building. Project rooms keep fixed places (live_layout.ts), each with four station
 * pads. This Mac is the base. The owner's ring sits under it with the card beside it. Bevy, built
 * to WebAssembly from apps/live, draws the boxes and the light from the scene in live_scene.ts.
 * Every word is HTML on top: live_rooms, live_queue, live_panel, live_mac and live_top.
 *
 * This file only mounts, polls, keeps the state and wires the parts together. Polled every 2 s
 * and the board every 60 s, only while the screen is open. Bevy sleeps while it is closed. If
 * Bevy cannot start, everything else still works and the stage says why.
 */

import { errorText } from "../errors";
import type { BoardFeed, BoardIssue } from "./live_cards";
import { layout } from "./live_layout";
import { paintMac } from "./live_mac";
import { mountPanel } from "./live_panel";
import { direct, type EmberEnd, type Seen } from "./live_playbook";
import { mountQueue, readSeen, ringWords } from "./live_queue";
import { paintRooms } from "./live_rooms";
import { scene } from "./live_scene";
import { HARNESS } from "./live_text";
import { mountTop, TOP_HTML } from "./live_top";
import type { BevyView, LiveAgent, LiveCtx, LiveEvents, LiveState, Selection, Station } from "./live_types";
import "./live.css";

export type { LiveAgent, LiveEmber, LiveEvents, LiveJob, LiveWorld } from "./live_types";
export type LiveHandle = { open(): void; clear(): void };

const POLL_MS = 2000;
const BOARD_MS = 60_000;
/** A dot moves to a new station only after it held there this long, so it never jitters. */
const STATION_HOLD_MS = 10_000;

export function mountLive(root: HTMLElement, events: LiveEvents): LiveHandle {
  root.innerHTML = `
    ${TOP_HTML}
    <div class="live-stage" data-stage>
      <canvas id="liveCanvas" class="live-canvas" tabindex="-1" aria-hidden="true"></canvas>
      <div class="live-labels" data-labels></div>
      <div class="qcard" data-card aria-live="polite"></div>
      <div class="apanel" data-panel hidden></div>
      <div class="peek" data-peek hidden></div>
      <div class="live-toast" data-toast role="status" hidden></div>
      <p class="live-note" data-note hidden></p>
    </div>
    <p class="live-hint">Click any dot, room or ember. Answer the card with Enter, 2 or 3. T talks about it. Space opens the room behind it. ↓ moves it to later. Esc closes a panel.</p>`;
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const stage = q("[data-stage]");
  const labels = q("[data-labels]");
  const cardEl = q("[data-card]");
  const panelEl = q("[data-panel]");
  const note = q("[data-note]");

  const reducedQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  const s: LiveState = {
    world: null,
    board: null,
    boardNote: "",
    boardRead: false,
    layout: null,
    selection: null,
    hover: null,
    cards: [],
    front: null,
    later: {},
    answered: new Set(),
    seen: readSeen(),
    talkCard: null,
    pendingFx: [],
    pendingFlights: [],
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
  const stations = new Map<string, { shown: Station; pending: Station; since: number }>();
  const played = new Map<string, number>();
  let lastSeen: Seen | null = null;
  let knownEmbers: Set<string> | null = null;

  // ---------------------------------------------------------------- facts

  const issues = (): BoardIssue[] => [...(s.board?.now ?? []), ...(s.board?.you ?? []), ...(s.board?.ready ?? []), ...(s.board?.waiting ?? []), ...(s.board?.done ?? [])];
  /** The board names a claim by session: `codex-0a513057` for Codex, the folk name for others. */
  const held = (a: LiveAgent): BoardIssue | undefined => {
    const names = [a.session ? `codex-${a.session.slice(-8)}` : "", (a.name ?? "").toLowerCase()].filter(Boolean);
    return (s.board?.now ?? []).find((i) => i.holder && names.includes(i.holder.toLowerCase()));
  };
  const issueOf = (a: LiveAgent) => held(a) ?? (a.issue ? issues().find((i) => i.number === a.issue) : undefined);
  /** A fleet worker runs in the company folder. Its issue's app is its real room. */
  const roomOf = (a: LiveAgent): string => (a.room !== "elsewhere" && a.room !== "home" ? a.room : (issueOf(a)?.apps[0] ?? a.room));
  const roomMeta = (key: string) => s.world?.rooms.find((r) => r.key === key);

  const ctx: LiveCtx = {
    s,
    events,
    stage,
    issueOf,
    roomOf,
    roomName: (key) => roomMeta(key)?.name ?? s.board?.apps?.[key]?.name ?? key,
    weight: (key) => roomMeta(key)?.weight ?? 1,
    agentById: (id) => (id ? s.world?.agents.find((a) => a.id === id) : undefined),
    nameOf: (a) => a.name ?? `${HARNESS[a.harness]} ${a.pid ?? a.session?.slice(0, 4) ?? ""}`.trim(),
    select,
    draw,
    paintQueue: () => queue.paint(),
    poll: () => void poll(),
    toast: (text, bad) => top.toast(text, bad),
  };
  const top = mountTop(ctx, root, q("[data-toast]"));
  const queue = mountQueue(ctx, cardEl);
  const panel = mountPanel(ctx, panelEl, q("[data-peek]"));

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
      if (Date.now() - boardAt > BOARD_MS) void readBoard(false);
      paint();
    } catch (e) {
      top.say(`Could not read the agents: ${errorText(e, "the scan failed")}`);
    } finally {
      polling = false;
    }
  }

  async function readBoard(fresh: boolean): Promise<void> {
    boardAt = Date.now();
    try {
      const b = (await events.board(fresh)) as (BoardFeed & { error?: string }) | null;
      s.board = b && !b.error ? b : s.board;
      s.boardNote = !b ? "No board module: cards come from your sessions only." : b.error ? `The board did not answer: ${b.error}` : "";
    } catch (e) {
      s.boardNote = `The board did not answer: ${errorText(e, "unknown error")}`;
    }
    s.boardRead = true;
    paint();
  }

  function station(a: LiveAgent, now: number): Station {
    const want = a.now?.station ?? a.steps[0]?.station ?? "plan";
    const st = stations.get(a.id);
    if (!st) {
      stations.set(a.id, { shown: want, pending: want, since: now });
      return want;
    }
    if (want === st.shown) st.pending = want;
    else if (want !== st.pending) {
      st.pending = want;
      st.since = now;
    } else if (now - st.since >= STATION_HOLD_MS) st.shown = want;
    return st.shown;
  }

  // ---------------------------------------------------------------- paint

  function paint(): void {
    if (!s.world) return;
    for (const id of stations.keys()) if (!s.world.agents.some((a) => a.id === id)) stations.delete(id);
    queue.paint();
    top.paint();
    draw();
    panel.paint();
  }

  function draw(): void {
    const w = s.world;
    const width = stage.clientWidth;
    if (!w || !width) return;
    const now = Date.now();
    const l = layout({ width, world: w, cards: s.cards, roomOf, roomName: ctx.roomName, stationOf: (a) => station(a, now) });
    s.layout = l;
    cardEl.style.left = `${l.card.x}px`;
    cardEl.style.top = `${l.card.y}px`;
    cardEl.style.width = `${l.card.w}px`;
    labels.replaceChildren(...paintRooms(ctx, l), ...paintMac(ctx, l, (pid, who) => void stopPid(pid, who)), ...ringWords(ctx, l));
    panel.place();
    // The card or an open panel may reach past the building: the stage grows to hold them.
    const panelBottom = panelEl.hidden ? 0 : panelEl.offsetTop + panelEl.offsetHeight + 10;
    stage.style.height = `${Math.ceil(Math.max(l.h, l.card.y + cardEl.offsetHeight + l.pad + 4, panelBottom))}px`;

    const snapshot = snap();
    const endings: EmberEnd[] = knownEmbers ? w.embers.filter((e) => !knownEmbers!.has(e.id)).map((e) => ({ id: e.id, agentId: e.id.split("@")[0], outcome: e.outcome })) : [];
    knownEmbers = new Set(w.embers.map((e) => e.id));
    s.pendingFx.push(...direct(lastSeen, snapshot, endings, played, now));
    lastSeen = snapshot;
    // Effects are for this moment only. Without a view they are dropped, not saved up.
    if (view) view.set_scene(JSON.stringify(scene(ctx, s.pendingFlights, panel.tether())));
    s.pendingFx = [];
    s.pendingFlights = [];
  }

  function snap(): Seen {
    const l = s.layout!;
    const dots: Seen["dots"] = new Map();
    for (const a of s.world!.agents) {
      const d = l.dots.get(a.id);
      if (d) dots.set(a.id, { x: d.x, y: d.y, r: d.r, steps: a.stepCount, station: a.now?.station ?? "", parent: a.parent, nowLabel: a.now?.label ?? null, files: a.files });
    }
    const rooms: Seen["rooms"] = new Map(l.rooms.map((r) => [r.key, { x: r.x, y: r.y, w: r.w, h: r.h }]));
    const closed: Seen["closed"] = new Map((s.board?.done ?? []).filter((i) => !i.dropped).map((i) => [i.number, i.apps[0] ?? "hq"]));
    return { dots, embers: new Set(s.world!.embers.map((e) => e.id)), cards: new Map(s.cards.map((c) => [c.id, c.room])), rooms, closed };
  }

  async function stopPid(pid: number, who: string): Promise<void> {
    try {
      await events.stop(pid);
      top.toast(`Asked ${who} to stop.`);
      void poll();
    } catch (e) {
      top.toast(`Could not stop ${who}: ${errorText(e, "refused")}`, true);
    }
  }

  function select(next: Selection): void {
    const same = next && s.selection && next.kind === s.selection.kind && next.id === s.selection.id;
    s.selection = same ? null : next;
    panel.peek(null);
    panel.paint();
    draw();
  }

  // ---------------------------------------------------------------- pointer and keys

  labels.addEventListener("pointerover", (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>(".live-hit")?.dataset.agent ?? null;
    if (id === s.hover) return;
    s.hover = id;
    panel.peek(id);
    draw();
  });
  labels.addEventListener("pointerleave", () => {
    if (!s.hover) return;
    s.hover = null;
    panel.peek(null);
    draw();
  });

  function onKey(e: KeyboardEvent): void {
    if (!open || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable)) return;
    if (e.key === "Escape" && s.selection) select(null);
    else if (!queue.onKey(e)) return;
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
