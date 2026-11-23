
import { errorText } from "../errors";
import type { BoardFeed } from "./live_cards";
import { mountCatalog } from "./live_catalog";
import { facts } from "./live_facts";
import { hoursBack, newGame, update, type FeedItem } from "./live_game";
import { mountHud } from "./live_hud";
import { mountLabels } from "./live_labels";
import { mountPanel } from "./live_panel";
import { direct, RESULT_MS, RESULTS, type EmberEnd, type Seen } from "./live_playbook";
import { scene } from "./live_scene";
import { COLOR, PLAIN, play, type FxOut, type Pt, type Script, type Stagehand } from "./live_script";
import { mountSide } from "./live_side";
import { newHeard, talk, TALK, TO_HELPERS, type Talk } from "./live_talk";
import { appName, button, doing } from "./live_text";
import { mountTop, TOP_HTML } from "./live_top";
import type { BevyView, LiveCtx, LiveEvents, LiveState, Selection } from "./live_types";
import { elbows, lay, markAt, route, stationAt } from "./live_world";
import "./live.css";

export type { LiveAgent, LiveEmber, LiveEvents, LiveJob, LiveWorld } from "./live_types";
export type LiveHandle = { open(): void; clear(): void };

const POLL_MS = 2000;
const BOARD_MS = 60_000;
const FLEET_MS = 5000;
const DAY_MS = 60_000;
const MAX_CHEERS = 4;
const GOLD = "#ffe27a";
const MAX_SCRIPTS = 3;
const MAX_MARKS = 12;
const MAX_TALKS = 3;
const TALK_EVERY_MS = 12_000;
const LINE_LINGER_MS = 500;
const LINE_MIN = 48;
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 1.6;
const ZOOM_STEP = 1.25;
const EDGE = { side: 28, top: 56, bottom: 16 };
const KEY: [string, string][] = [
  ["Top row", "Where agents send work. GitHub takes pushes and board issues. This Mac runs builds and tests, two at a time. Web is searches and page visits."],
  ["Card with a planet", "One project. A gold moon is an issue closed today."],
  ["Ship", "One agent. The first line says who it is, the second what it does right now."],
  ["Ship shapes", "Jet: a session you opened. Flagship: the fleet commander. Freighter: a fleet builder on one issue. Small craft: a scout or a helper."],
  ["Colours", "Cyan works. Blue thinks. Amber waits for you. Red is stuck. Grey is idle."],
  ["Green bar under a row", "How much of its time budget a fleet unit has used. Red means over."],
  ["Light moving on a line", "Something on its way: a push, a build or test, a web visit, or a message between two agents."],
];

export function mountLive(root: HTMLElement, events: LiveEvents): LiveHandle {
  root.innerHTML = `
    ${TOP_HTML}
    <div class="live-body">
      <div class="live-stage" data-stage>
        <canvas id="liveCanvas" class="live-canvas" tabindex="-1" aria-hidden="true"></canvas>
        <div class="live-labels" data-labels></div>
        <div class="live-tools" data-tools></div>
        <div class="live-key" data-key hidden></div>
        <div class="live-feed" data-feed aria-label="What the fleet just did" hidden></div>
        <div class="live-banner" data-banner role="status" hidden></div>
        <div class="live-toast" data-toast role="status" hidden></div>
        <p class="live-note" data-note hidden></p>
      </div>
      <aside class="live-side" aria-label="Agents on this Mac">
        <div class="live-list" data-list></div>
        <div class="apanel" data-panel hidden></div>
        <div class="live-catalog" data-catalog></div>
      </aside>
    </div>`;
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
    fleet: null,
    day: null,
    game: newGame(),
    layout: null,
    slots: { cols: 0, col: new Map(), size: "" },
    camera: { x: 0, y: 0, zoom: 0.6 },
    cameraHeld: false,
    carries: new Map(),
    bubbles: new Map(),
    selection: null,
    hover: null,
    pendingFx: [],
    marks: [],
    results: new Map(),
    pings: new Map(),
    calls: new Map(),
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
  let fleetAt = 0;
  let dayAt = 0;
  let shortDay = "";
  let open = false;
  const played = new Map<string, number>();
  let lastSeen: Seen | null = null;
  let knownEmbers: Set<string> | null = null;
  const running = new Map<string, () => void>();
  const acted = new Map<string, string>();
  const judged = new Map<string, string>();
  let freshResults: { agentId: string; ok: boolean }[] = [];
  let markId = 0;
  const heard = newHeard();
  const spoke = new Map<string, number>();
  let talking: number[] = [];

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
  const hud = mountHud(ctx, q("[data-hud]"), q("[data-feed]"), q("[data-banner]"));
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
        if (!String(e).includes("control flow")) throw e;
      }
      view = mod;
      draw();
    } catch (e) {
      say(`The live view did not start: ${errorText(e, "Bevy failed to load")}. Everything else still updates.`);
    }
  }

  async function poll(): Promise<void> {
    if (polling) return;
    polling = true;
    try {
      s.world = await events.world();
      const now = Date.now();
      if (now - boardAt > BOARD_MS) void readBoard();
      if (now - fleetAt > FLEET_MS) void readFleet();
      if (now - dayAt > DAY_MS) void readDay();
      paint();
    } catch (e) {
      top.say(`Could not read the agents: ${errorText(e, "the scan failed")}`);
    } finally {
      polling = false;
    }
  }

  async function readBoard(): Promise<void> {
    boardAt = Date.now();
    try {
      const b = (await events.board(false)) as (BoardFeed & { error?: string }) | null;
      if (b && !b.error) s.board = b;
    } catch {
    }
    paint();
  }

  async function readFleet(): Promise<void> {
    fleetAt = Date.now();
    try {
      const f = await events.fleet();
      s.fleet = f && !f.error ? f : null;
    } catch {
      s.fleet = null;
    }
    score();
  }

  async function readDay(): Promise<void> {
    dayAt = Date.now();
    try {
      const short = shortDay === new Date(dayAt).toDateString();
      const d = await events.day(hoursBack(dayAt, short ? 0 : 1));
      if (d && !d.error) s.day = d;
      score();
      if (s.game.score.partial && !short) {
        shortDay = new Date(dayAt).toDateString();
        dayAt = 0;
      }
    } catch {
      score();
    }
  }

  function score(): void {
    const iss = (n: number) => {
      const b = s.board;
      const i = [...(b?.now ?? []), ...(b?.ready ?? []), ...(b?.done ?? []), ...(b?.waiting ?? []), ...(b?.you ?? [])].find((x) => x.number === n);
      return i ? { title: i.title, url: i.url, room: i.apps[0] } : undefined;
    };
    const scouts = new Map((s.world?.agents ?? []).flatMap((a) => (a.fleet?.scout ? [[a.fleet.scout.toLowerCase(), { unit: a.fleet.unit, kind: a.fleet.kind, since: a.fleet.startedMs }] as const] : [])));
    const place = (key: string) => {
      const n = ctx.roomName(key);
      return n === key ? appName(key) : n;
    };
    update(s.game, { fleet: s.fleet, day: s.day, now: Date.now(), issue: iss, place, scouts });
    hud.play(s.game.fresh);
    celebrate(s.game.fresh);
    paint();
  }

  function celebrate(items: FeedItem[]): void {
    const l = s.layout;
    if (!l || !items.length) return;
    const dotOf = (unit?: string) => {
      const a = unit ? s.world?.agents.find((x) => x.fleet?.unit === unit) : undefined;
      return a ? l.dots.get(a.id) : undefined;
    };
    const boss = s.world?.agents.find((a) => a.commander);
    const bossAt = boss ? l.dots.get(boss.id) : undefined;
    const fx = (...f: FxOut[]) => {
      if (!s.reduced) s.pendingFx.push(...f);
    };
    const flat = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");
    let n = 0;
    for (const it of items) {
      if (n >= MAX_CHEERS) break;
      const d = it.room ? l.districts.find((x) => x.key === it.room || flat(x.key) === flat(it.room!)) : undefined;
      const at = it.kind === "rank" ? bossAt : (dotOf(it.unit) ?? d);
      if (!at) continue;
      n++;
      if (it.kind === "rank") {
        fx({ kind: "burst", x: at.x, y: at.y, color: GOLD, size: 60, count: 40 }, { kind: "ring", x: at.x, y: at.y, color: GOLD, size: 110, ms: 1800 }, { kind: "ring", x: at.x, y: at.y, color: GOLD, size: 70, ms: 1400, delay: 300 });
      } else if ((it.kind === "scout" || it.kind === "end") && bossAt && (bossAt.x !== at.x || bossAt.y !== at.y)) {
        fx({ kind: "orb", x: at.x, y: at.y, x2: bossAt.x, y2: bossAt.y, color: it.kind === "scout" ? COLOR.think : COLOR.idle, size: 4, ms: 1300 });
      } else if (it.kind === "close") {
        fx({ kind: "burst", x: at.x, y: at.y, color: COLOR.done, size: 40, count: 26 }, { kind: "ring", x: at.x, y: at.y, color: COLOR.done, size: 70, ms: 1400 });
        if (bossAt && (bossAt.x !== at.x || bossAt.y !== at.y)) fx({ kind: "orb", x: at.x, y: at.y, x2: bossAt.x, y2: bossAt.y, color: GOLD, size: 5, ms: 1100, delay: 500 });
        if (it.xp) s.marks.push({ text: `+${it.xp} XP`, at: { x: at.x, y: at.y - 14 }, to: { x: at.x, y: at.y - 54 }, color: GOLD, ms: 1900, xp: true, id: ++markId, born: Date.now() });
      } else if (it.kind === "found") {
        fx({ kind: "pulse", x: at.x, y: at.y, color: COLOR.think, size: 46, ms: 1200 });
      } else if (it.kind === "deploy") {
        fx({ kind: "ring", x: at.x, y: at.y, color: COLOR.work, size: 50, ms: 1200 });
      } else if (it.kind === "alert") {
        fx({ kind: "ring", x: at.x, y: at.y, color: COLOR.stuck, size: 56, ms: 1600 });
      }
    }
  }


  const scriptFor = (verb: string): Script | undefined => {
    const find = (v: string) => s.world?.catalog?.find((x) => x.verb === v && !x.pending);
    const dot = verb.lastIndexOf(".");
    return find(verb) ?? (dot > 0 ? find(verb.slice(0, dot)) : undefined);
  };

  const hand: Stagehand = {
    where(id, place) {
      const w = s.layout;
      const spot = w?.dots.get(id);
      if (!w || !spot) return [];
      const self = spot;
      const a = ctx.agentById(id);
      const district = w.districts.find((d) => d.key === spot.room);
      const L = w.landmarks;
      switch (place) {
        case "self":
          return [self];
        case "home":
          return district ? [district] : [self];
        case "file":
        case "files":
          return [self];
        case "parent": {
          const p = a?.parent ? w.dots.get(a.parent) : undefined;
          return [p ?? self];
        }
        case "helpers": {
          const kids = (s.world?.agents ?? []).filter((k) => k.parent === id).flatMap((k) => {
            const d = w.dots.get(k.id);
            return d && d.swarm >= 0 ? [d] : [];
          });
          if (kids.length) return kids;
          const n = Math.max(3, Math.min(8, (a?.helpers ?? 0) + spot.swarm));
          return Array.from({ length: n }, (_, i) => {
            const t = Math.PI / 2 + (Math.PI * (i + 0.5)) / n;
            return { x: self.x + Math.cos(t) * 16, y: self.y + Math.sin(t) * 20 };
          });
        }
        case "hub":
        case "desk":
          return [stationAt(w.hub)];
        case "bay": {
          const bays = s.world?.mac.bays ?? [];
          const own = bays.findIndex((b) => b.agent === id);
          const i = own >= 0 ? own : bays.findIndex((b) => !b.holder);
          return i >= 0 && w.hub.bays[i] ? [w.hub.bays[i]] : [];
        }
        case "board":
          return [markAt(L.tower)];
        case "tower":
        case "sky":
        case "web":
          return [markAt(L[place])];
        default:
          return [];
      }
    },
    fx(f) {
      if (!s.reduced) s.pendingFx.push(f);
    },
    walk(id, to) {
      const w = s.layout;
      const from = w?.dots.get(id);
      const d = w?.districts.find((x) => x.key === from?.room);
      if (!to || !from || !d || s.reduced || Math.hypot(to.x - from.x, to.y - from.y) < 12 || (to.x === d.x && to.y === d.y)) return;
      s.pendingFx.push({ kind: "orb", x: from.x, y: from.y, x2: to.x, y2: to.y, color: s.carries.get(id) ?? COLOR.work, size: 5, ms: 900 });
    },
    carry(id, color) {
      if (color) s.carries.set(id, color);
      else s.carries.delete(id);
    },
    say(id, text) {
      if (text) s.bubbles.set(id, text);
      else s.bubbles.delete(id);
    },
    light(id, _at, color, ms) {
      const spot = s.layout?.dots.get(id);
      if (spot && !s.reduced) s.pendingFx.push({ kind: "pulse", x: spot.x, y: spot.y, color, size: 22, ms: Math.min(ms, 1400) });
    },
    mark(_id, m) {
      if (s.marks.filter((x) => !x.line).length >= MAX_MARKS) return;
      const path = m.to && s.layout ? route(s.layout, m.at, m.to) : undefined;
      const d = !m.to ? s.layout?.districts.find((x) => Math.abs(m.at.x - x.x) <= x.w / 2 + 12 && Math.abs(m.at.y - x.y) <= x.h / 2 + 12) : undefined;
      const room = d && { key: d.key, x: d.x - d.w / 2, y: d.y - d.h / 2 };
      s.marks.push({ ...m, path, room, id: ++markId, born: Date.now() });
      if (path && !s.reduced) addLine(path, m.color, m.ms + LINE_LINGER_MS);
    },
    label(id) {
      const a = ctx.agentById(id);
      return a ? doing(a) : "";
    },
    file(id) {
      const f = ctx.agentById(id)?.now?.file;
      return f ? (f.split("/").pop() ?? "") : "";
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

  function judge(): void {
    const w = s.world!;
    const now = Date.now();
    freshResults = [];
    for (const id of judged.keys()) if (!w.agents.some((a) => a.id === id)) judged.delete(id);
    for (const [id, r] of s.results) if (r.until < now) s.results.delete(id);
    for (const a of w.agents) {
      const st = a.steps.find((x) => x.ok !== undefined);
      const key = st ? `${st.verb ?? ""}@${st.atMs}` : "";
      const seen = judged.get(a.id);
      judged.set(a.id, key);
      const words = st?.verb ? RESULTS[st.verb] : undefined;
      if (!st || seen === undefined || seen === key || !words) continue;
      const ok = st.ok!;
      s.results.set(a.id, { text: ok ? words[0] : words[1], ok, until: now + (ok ? RESULT_MS.ok : RESULT_MS.failed) });
      freshResults.push({ agentId: a.id, ok });
    }
  }

  function chat(): void {
    const { talks, stepped } = talk(s.world!.agents, heard, freshResults);
    const l = s.layout;
    if (!l || (!talks.length && !stepped.length)) return;
    for (const a of stepped) {
      const on = l.dots.get(a.id)?.on;
      const st = a.now ?? a.steps[0];
      if (on) bump(s.pings, on);
      else if (st?.helper) bump(s.pings, a.id);
      if (!on && a.helpers > 0 && (st?.verb === "spawn" || (st?.verb === "message" && TO_HELPERS.test(st.label)))) bump(s.calls, a.id);
    }
    for (const t of talks)
      if (t.delay)
        window.setTimeout(() => {
          speak(t);
          draw();
        }, t.delay);
      else speak(t);
    draw();
  }

  const bump = (m: Map<string, number>, id: string) => m.set(id, (m.get(id) ?? 0) + 1);

  function speak(t: Talk): void {
    const l = s.layout;
    const a = l?.dots.get(t.from);
    const b = l?.dots.get(t.to);
    if (!l || !a || !b || s.reduced) return;
    const top = a.on === t.to ? t.to : b.on === t.from ? t.from : a.on && a.on === b.on ? a.on : null;
    if (top) {
      bump(t.kind === "order" ? s.calls : s.pings, top);
      return;
    }
    const now = Date.now();
    talking = talking.filter((end) => end > now);
    const pair = `${t.kind}:${t.from}>${t.to}`;
    if (talking.length >= MAX_TALKS || now - (spoke.get(pair) ?? -Infinity) < TALK_EVERY_MS || s.marks.filter((x) => !x.line).length >= MAX_MARKS) return;
    spoke.set(pair, now);
    const k = TALK[t.kind];
    talking.push(now + k.ms);
    const path = route(l, a, b);
    s.marks.push({ glyph: k.glyph, talk: true, at: a, to: b, path, color: k.color, ms: k.ms, id: ++markId, born: now });
    addLine(path, k.color, k.ms + LINE_LINGER_MS);
    const lands = Math.round(k.ms * 0.8);
    s.pendingFx.push({ kind: "pulse", x: a.x, y: a.y, color: k.color, size: 22, ms: 600 }, { kind: "ring", x: b.x, y: b.y, color: k.color, size: 28, ms: 800, delay: lands });
    const tag = t.tag;
    if (tag) window.setTimeout(() => hand.mark(t.to, { text: tag, at: { x: b.x, y: b.y - 16 }, color: k.color, ms: 1800 }), lands);
  }

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


  function paint(): void {
    if (!s.world) return;
    top.paint();
    hud.paint();
    judge();
    draw();
    chat();
    freshResults = [];
    act();
    panel.paint();
    catalog.paint();
    side.paint();
    paintTools();
    paintColumn();
  }

  function paintColumn(): void {
    listEl.hidden = catalog.isOpen() || !panelEl.hidden;
  }

  function room(): { w: number; h: number } {
    const foot = Math.min(hud.height(), stage.clientHeight * 0.36);
    return { w: stage.clientWidth - 2 * EDGE.side, h: stage.clientHeight - EDGE.top - Math.max(EDGE.bottom, foot) };
  }

  function fit(): void {
    const b = s.layout?.bounds;
    const { w, h } = room();
    if (!b || w <= 40 || h <= 40) return;
    const zoom = clamp(Math.min(w / (b.x1 - b.x0), h / (b.y1 - b.y0)), ZOOM_MIN, 1);
    s.camera = { x: (b.x0 + b.x1) / 2, y: b.y0 + (stage.clientHeight / 2 - EDGE.top) / zoom, zoom };
  }

  function draw(): void {
    const w = s.world;
    const width = stage.clientWidth;
    if (!w || !width) return;
    const now = Date.now();
    s.layout = lay({ world: w, roomOf: ctx.roomOf, roomName: ctx.roomName, slots: s.slots, stage: room() });
    if (!s.cameraHeld) {
      const { x, y, zoom } = s.camera;
      fit();
      if (x !== s.camera.x || y !== s.camera.y || zoom !== s.camera.zoom) still();
    }

    const snapshot = snap();
    const endings: EmberEnd[] = knownEmbers ? w.embers.filter((e) => !knownEmbers!.has(e.id)).map((e) => ({ id: e.id, agentId: e.id.split("@")[0], outcome: e.outcome })) : [];
    knownEmbers = new Set(w.embers.map((e) => e.id));
    s.pendingFx.push(...direct(lastSeen, snapshot, endings, freshResults, played, now));
    lastSeen = snapshot;
    s.pendingFx = s.pendingFx.flatMap(routeFx);
    labels.paint();
    if (view) view.set_scene(JSON.stringify(scene(ctx, width, stage.clientHeight)));
    s.pendingFx = [];
  }

  function routeFx(f: FxOut): FxOut[] {
    if ((f.kind !== "orb" && f.kind !== "beam") || f.x2 === undefined || f.y2 === undefined || !s.layout) return [f];
    const [a, b] = [{ x: f.x, y: f.y }, { x: f.x2, y: f.y2 }];
    const ms = f.ms ?? (f.kind === "orb" ? 900 : 1200);
    if (f.kind === "orb") {
      const path = route(s.layout, a, b);
      addLine(path, f.color, (f.delay ?? 0) + ms + LINE_LINGER_MS);
      return [{ ...f, path: path.map((p) => [p.x, p.y]) }];
    }
    const path = elbows(s.layout, a, b);
    addLine(route(s.layout, a, b), f.color, (f.delay ?? 0) + ms + LINE_LINGER_MS);
    return path.slice(1).flatMap((p, i) => (Math.hypot(p.x - path[i].x, p.y - path[i].y) < 1 ? [] : [{ ...f, x: path[i].x, y: path[i].y, x2: p.x, y2: p.y }]));
  }

  function addLine(path: Pt[], color: string, ms: number): void {
    if (path.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - path[i].x, p.y - path[i].y), 0) < LINE_MIN) return;
    const key = path.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join(" ");
    const now = Date.now();
    const same = s.marks.find((m) => m.line && m.text === key);
    if (same) {
      same.ms = Math.max(same.ms, now - same.born + ms);
      return;
    }
    s.marks.push({ line: true, text: key, path, at: path[0], color, ms, id: ++markId, born: now });
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

  const zoomOut = button("live-tool is-icon", "−", () => zoomBy(1 / ZOOM_STEP));
  zoomOut.setAttribute("aria-label", "Zoom out");
  zoomOut.title = "Zoom out (−)";
  const zoomIn = button("live-tool is-icon", "+", () => zoomBy(ZOOM_STEP));
  zoomIn.setAttribute("aria-label", "Zoom in");
  zoomIn.title = "Zoom in (+)";
  const fitBtn = button("live-tool", "Fit", () => refit());
  fitBtn.title = "Fit the map (0). Drag to move, scroll or pinch to zoom. Click an agent to follow it.";
  const anim = button("live-tool", "Animations", () => {
    if (!catalog.isOpen() && s.selection) select(null);
    catalog.toggle();
  });
  const keyEl = q("[data-key]");
  for (const [name, what] of KEY) {
    const row = document.createElement("p");
    const b = document.createElement("b");
    b.textContent = name;
    row.append(b, what);
    keyEl.append(row);
  }
  const keyBtn = button("live-tool", "What is what", () => {
    keyEl.hidden = !keyEl.hidden;
    keyBtn.classList.toggle("is-on", !keyEl.hidden);
    keyBtn.setAttribute("aria-expanded", String(!keyEl.hidden));
  });
  keyBtn.title = "What each thing on the map means";
  keyBtn.setAttribute("aria-expanded", "false");
  tools.append(zoomOut, zoomIn, fitBtn, anim, keyBtn);

  function paintTools(): void {
    zoomOut.disabled = s.camera.zoom <= ZOOM_MIN + 0.001;
    zoomIn.disabled = s.camera.zoom >= ZOOM_MAX - 0.001;
    fitBtn.disabled = !s.cameraHeld;
    anim.title = `${catalog.count()} animations. Open the catalog to play, improve or delete one.`;
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

  function zoomBy(f: number): void {
    s.camera.zoom = clamp(s.camera.zoom * f, ZOOM_MIN, ZOOM_MAX);
    moveCamera();
  }


  let stillEnd = 0;
  function still(): void {
    root.classList.add("is-moving");
    window.clearTimeout(stillEnd);
    stillEnd = window.setTimeout(() => root.classList.remove("is-moving"), 150);
  }

  function moveCamera(): void {
    still();
    view?.set_camera(s.camera.x, s.camera.y, s.camera.zoom);
    labels.paint();
    s.cameraHeld = true;
    paintTools();
  }

  const OVER = ".live-tools, .live-key, button, input, .live-feed.is-open";
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
    if (!drag.moved && s.selection) select(null);
    drag = null;
    root.classList.remove("is-panning");
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);
  stage.addEventListener(
    "wheel",
    (e) => {
      if ((e.target as HTMLElement).closest(".live-feed.is-open")) return;
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      const at = { x: e.clientX - r.left, y: e.clientY - r.top };
      const before = toWorld(at);
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
    if (e.key === "Escape" && !keyEl.hidden) keyBtn.click();
    else if (e.key === "Escape" && s.selection) select(null);
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
      view?.set_paused(true);
    },
  };
}

function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v));
}
