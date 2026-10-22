/**
 * The Product Spine map, drawn natively.
 *
 * This is the whole Product Spine screen in Panel — there is no iframe beside it any more.
 * It shows the navigation between the screens that have a taken screenshot; a screen with no
 * shot is not drawn, and the hop that ran through it is collapsed by the module into a direct
 * one. The module hands over a single cached packet (`map.json`): coordinates, labels,
 * findings, shot URLs. Everything visual happens here on a canvas — pan, zoom, hover,
 * hit-testing — so the map moves at frame rate and never reloads a page.
 *
 * Hover or click a screen and its own paths light up: green for where it goes, red for what
 * reaches it. A two-way pair draws both, bowed apart. Arrowheads march along each path, so the
 * direction reads without reading the colour. Double-click opens the screen's detail page
 * (`spine_inspect.ts`): its looks, its controls, and what each control does.
 */

import { moduleGet, modulePost } from "./modules";
import { schemeOrigin } from "../project-assets";
import { mountInspector, type Runtime } from "./spine_inspect";
import { computeLayout, type GroupCard, type Rect } from "./spine_layout";
import "./spine_map.css";

export type MapPin = {
  name: string;
  title: string;
  kind: "boot" | "hub" | "screen" | "group";
  x: number;
  y: number;
  row: number;
  ghost: boolean;
  leaf: boolean;
  uncharted: boolean;
  level: string | null;
  enter: { label: string | null; ref: string | null } | null;
  shot: string | null;
  shotNote: string;
  stale: string[];
  finding: {
    flags: string[];
    fallback: string | null;
    unaudited: boolean;
    loopholes: number;
  } | null;
  file: string | null;
  line: number | null;
  outs: string[];
  ins: number;
  packet: string | null;
  addresses: { ref: string; label: string | null; kind: string; action: string | null; file: string; line: number }[];
  /** What the probe saw at runtime: looks, controls, effects. Null until shots are retaken. */
  runtime: Runtime | null;
};

export type MapData = {
  error?: string;
  app: string;
  key: string;
  commit: string | null;
  orientation: "portrait" | "landscape";
  width: number;
  height: number;
  hub: string | null;
  pins: MapPin[];
  hops: { from: string; to: string; row: number; label: string }[];
  flows: { label: string; ref: string | null }[];
  missed: string[];
  score: Record<"screens" | "flows" | "uncharted" | "unaudited" | "owned" | "shots" | "stale", number>;
  /** No screen has a shot yet, so there is nothing to navigate between. */
  needShots?: boolean;
  setup?: {
    status: "none" | "no-shots" | "stale" | "fresh";
    test: boolean;
    harness: "fresh" | "stale" | "missing";
    taken?: string | null;
    commit?: string | null;
    changed: number;
    stale: number;
    shotless: number;
    last_run: { ok?: boolean | null; at?: string | null; advice: number };
    reasons: string[];
  };
  /** Screens the map deliberately leaves out: they have no shot. */
  shotless?: string[];
  shots: { commit: string | null; dirty: boolean | null; taken: string | null; device: string | null };
  cached?: boolean;
};

type Laid = {
  pin: MapPin;
  rect: Rect;
  head: Rect;
  enter: Rect | null;
  shotBox: Rect | null;
  image: HTMLImageElement | null;
  /** Index of the flow block this card sits in; -1 for the hub. */
  block: number;
  /** Set when this card stands for a whole collapsed flow. */
  group: GroupCard<MapPin> | null;
};

const M = "/m/product-spine";
const ORIGIN = schemeOrigin("module");
const EXPANDED_STORE = "spine.map.expanded";

/** Read a CSS token off the pane so the canvas wears the app's own theme. */
function token(el: HTMLElement, name: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

function rr(ctx: CanvasRenderingContext2D, r: Rect, radius: number): void {
  const { x, y, w, h } = r;
  const rad = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

function inside(r: Rect | null, px: number, py: number): boolean {
  return !!r && px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

/** Where a ray from the centre of `r` toward (tx,ty) leaves the box. */
function edgePoint(r: Rect, tx: number, ty: number): { x: number; y: number } {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const sx = dx ? ((dx > 0 ? r.x + r.w : r.x) - cx) / dx : 1e9;
  const sy = dy ? ((dy > 0 ? r.y + r.h : r.y) - cy) / dy : 1e9;
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // clipboard blocked — the toast still shows the text
  }
}

export type SpineMapHandle = {
  load(key: string): Promise<void>;
  destroy(): void;
};

export function mountSpineMap(host: HTMLElement): SpineMapHandle {
  host.innerHTML = `
    <div class="sm-bar">
      <input class="sm-filter" placeholder="filter… (unaudited, money, stale, a name)" />
      <span class="sm-score"></span>
      <span class="sm-legend" title="hover or click a screen · double-click to inspect it">
        <i class="out"></i>goes to<i class="in"></i>comes from</span>
      <span class="sm-zoom">
        <button type="button" data-z="out" title="zoom out">−</button>
        <button type="button" data-z="fit" title="fit">⌂</button>
        <button type="button" data-z="in" title="zoom in">+</button>
      </span>
      <button type="button" class="sm-reveal" title="open every flow, or fold them back into groups">⊞ Reveal all</button>
      <span class="sm-setup" hidden></span>
      <button type="button" class="sm-shots" title="run the app's shot test">⟳ Take shots</button>
      <span class="sm-meta"></span>
    </div>
    <div class="sm-stage"><canvas class="sm-canvas"></canvas><div class="sm-toast"></div></div>
    <div class="sm-inspect" hidden></div>`;

  const stage = host.querySelector<HTMLElement>(".sm-stage")!;
  const canvas = host.querySelector<HTMLCanvasElement>(".sm-canvas")!;
  const ctx = canvas.getContext("2d")!;
  const filterBox = host.querySelector<HTMLInputElement>(".sm-filter")!;
  const scoreEl = host.querySelector<HTMLElement>(".sm-score")!;
  const metaEl = host.querySelector<HTMLElement>(".sm-meta")!;
  const toastEl = host.querySelector<HTMLElement>(".sm-toast")!;
  const inspectHost = host.querySelector<HTMLElement>(".sm-inspect")!;
  const shotsBtn = host.querySelector<HTMLButtonElement>(".sm-shots")!;
  const revealBtn = host.querySelector<HTMLButtonElement>(".sm-reveal")!;
  const setupEl = host.querySelector<HTMLElement>(".sm-setup")!;

  const SETUP_LABEL = { none: "spine not set up", "no-shots": "no shots yet", stale: "out of date", fresh: "up to date" };
  function paintSetup(): void {
    const s = data?.setup;
    if (!s) { setupEl.hidden = true; return; }
    setupEl.hidden = false;
    setupEl.dataset.status = s.status;
    setupEl.textContent = SETUP_LABEL[s.status];
    setupEl.title = s.reasons.length ? s.reasons.join("\n") : `shots @${s.commit ?? "?"} match the source`;
  }

  let data: MapData | null = null;
  let key = "";
  let laid: Laid[] = [];
  let byName = new Map<string, Laid[]>();
  /** The drawn world, from the layout: it grows and shrinks with what is open. */
  let world = { w: 800, h: 600 };
  /** Flow blocks in layout order, with their frames, for the outlines and the hop endpoints. */
  let blocks: ReturnType<typeof computeLayout<MapPin>>["blocks"] = [];
  /** Flow labels the user opened. A flow with one screen is always open. */
  let expanded = new Set<string>();
  let revealAll = false;
  let cam = { x: 0, y: 0, s: 1 };
  let hover: Laid | null = null;
  /** Click sticks a screen in focus so the in/out paths stay lit while you read them. */
  let selected: Laid | null = null;
  /** name -> where it goes / what reaches it, from the collapsed graph, not from the layout. */
  let outsOf = new Map<string, Set<string>>();
  let insOf = new Map<string, Set<string>>();
  /** The trigger label the layout knows for a drawn hop, so a lit path can still name its tap. */
  let hopLabel = new Map<string, string>();
  let filter = "";
  let dirty = true;
  let raf = 0;
  let dragging: { sx: number; sy: number; cx: number; cy: number; moved: boolean } | null = null;
  let toastTimer = 0;
  let alive = true;

  const colors = () => ({
    bg: token(host, "--bg-sunken", "#05070c"),
    raised: token(host, "--bg-raised", "#0c101a"),
    line: token(host, "--line", "#1b2233"),
    ink: token(host, "--ink", "#d8deea"),
    dim: token(host, "--ink-dim", "#7f8ba3"),
    faint: token(host, "--ink-faint", "#4d566a"),
    accent: token(host, "--m-spine", "#d9a441"),
    ok: token(host, "--ok", "#67d99a"),
    risk: token(host, "--risk", "#ff6b81"),
    warn: token(host, "--warn", "#e8c66a"),
  });

  /** The palette of the frame being drawn. Set once per frame so helpers can share it. */
  let c0 = colors();

  function toast(msg: string): void {
    toastEl.textContent = msg;
    toastEl.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl.classList.remove("on"), 2200);
  }

  function invalidate(): void {
    dirty = true;
    if (!raf) raf = requestAnimationFrame(draw);
  }

  // ── grouping state ────────────────────────────────────────────────────────
  function loadExpanded(): void {
    expanded = new Set();
    revealAll = false;
    try {
      const raw = localStorage.getItem(`${EXPANDED_STORE}.${key}`);
      if (raw) {
        const v = JSON.parse(raw) as { all?: boolean; open?: string[] };
        revealAll = !!v.all;
        expanded = new Set(v.open ?? []);
      }
    } catch {
      /* no storage: every load starts grouped */
    }
  }
  function saveExpanded(): void {
    try {
      localStorage.setItem(`${EXPANDED_STORE}.${key}`, JSON.stringify({ all: revealAll, open: [...expanded] }));
    } catch {
      /* fine */
    }
  }
  function paintReveal(): void {
    revealBtn.textContent = revealAll ? "⊟ Group flows" : "⊞ Reveal all";
    const n = data?.flows.length ?? 0;
    revealBtn.disabled = !n;
  }

  // ── layout: pins → rects (world units) ────────────────────────────────────
  function layout(): void {
    laid = [];
    byName = new Map();
    outsOf = new Map();
    insOf = new Map();
    hopLabel = new Map();
    blocks = [];
    if (!data) return;
    for (const pin of data.pins) {
      const outs = outsOf.get(pin.name) ?? new Set<string>();
      for (const t of pin.outs) {
        outs.add(t);
        const ins = insOf.get(t) ?? new Set<string>();
        ins.add(pin.name);
        insOf.set(t, ins);
      }
      outsOf.set(pin.name, outs);
    }
    for (const h of data.hops) if (h.label) hopLabel.set(`${h.from}>${h.to}`, h.label);
    const l = computeLayout<MapPin>({
      pins: data.pins,
      hops: data.hops,
      flows: data.flows,
      orientation: data.orientation,
      expanded: (label) => revealAll || expanded.has(label),
    });
    world = { w: l.width, h: l.height };
    blocks = l.blocks;
    for (const c of l.cards) {
      const image = c.pin.shot ? imageFor(c.pin.shot) : null;
      const x: Laid = { pin: c.pin, rect: c.rect, head: c.head, enter: c.enter, shotBox: c.shotBox, image, block: c.block, group: null };
      laid.push(x);
      const list = byName.get(c.pin.name) ?? [];
      list.push(x);
      byName.set(c.pin.name, list);
    }
    for (const g of l.groups) {
      // A folded flow is one card that answers for every screen inside it.
      const sample = g.sample;
      const pin: MapPin = {
        name: `⊞${g.label}`, title: g.label, kind: "group",
        x: g.rect.x + g.rect.w / 2, y: g.rect.y + g.rect.h / 2,
        row: g.members[0]?.row ?? 0, ghost: false, leaf: true, uncharted: g.members.every((m) => m.uncharted),
        level: null, enter: null, shot: sample?.shot ?? null, shotNote: "", stale: [], finding: null,
        file: null, line: null, outs: [], ins: 0, packet: null, addresses: [], runtime: null,
      };
      const image = pin.shot ? imageFor(pin.shot) : null;
      laid.push({ pin, rect: g.rect, head: g.head, enter: null, shotBox: g.thumb, image, block: g.block, group: g });
    }
  }

  /** The drawn card that answers for a screen in a row: itself, or the group it is folded into. */
  function cardFor(name: string, row: number, hubOk: boolean): Laid | null {
    const own = byName.get(name)?.find((x) => x.pin.row === row || (hubOk && x.pin.kind === "hub"));
    if (own) return own;
    const g = laid.find((x) => x.group && x.group.members.some((m) => m.name === name && m.row === row));
    return g ?? null;
  }

  const images = new Map<string, HTMLImageElement>();
  function imageFor(path: string): HTMLImageElement {
    const bust = data?.shots.taken ?? "";
    const url = `${ORIGIN}${path}?v=${encodeURIComponent(bust)}`;
    let img = images.get(url);
    if (!img) {
      img = new Image();
      img.decoding = "async";
      img.onload = () => invalidate();
      img.src = url;
      images.set(url, img);
    }
    return img;
  }

  // ── camera ────────────────────────────────────────────────────────────────
  function fit(): void {
    if (!data) return;
    const vw = stage.clientWidth;
    const vh = stage.clientHeight;
    const s = Math.min(vw / world.w, vh / world.h) * 0.98;
    cam = { s, x: (vw - world.w * s) / 2, y: (vh - world.h * s) / 2 };
    invalidate();
  }
  function zoomAt(factor: number, px: number, py: number): void {
    const ns = Math.max(0.12, Math.min(2.5, cam.s * factor));
    const wx = (px - cam.x) / cam.s;
    const wy = (py - cam.y) / cam.s;
    cam = { s: ns, x: px - wx * ns, y: py - wy * ns };
    invalidate();
  }
  function toWorld(px: number, py: number): { x: number; y: number } {
    return { x: (px - cam.x) / cam.s, y: (py - cam.y) / cam.s };
  }

  // ── hit testing ───────────────────────────────────────────────────────────
  function hit(px: number, py: number): Laid | null {
    const { x, y } = toWorld(px, py);
    for (let i = laid.length - 1; i >= 0; i--) {
      if (inside(laid[i].rect, x, y)) return laid[i];
    }
    return null;
  }

  function matches(l: Laid): boolean {
    if (!filter) return true;
    const p = l.pin;
    const hay = [p.name, p.title, p.packet ?? "", ...(p.finding?.flags ?? []),
      p.finding?.unaudited ? "unaudited" : p.finding?.flags.length ? "owned" : "",
      p.stale.length ? "stale" : "", p.shot ? "" : "no shot", p.enter?.label ?? ""]
      .join(" ").toLowerCase();
    return hay.includes(filter);
  }

  // ── focused paths ─────────────────────────────────────────────────────────
  /** The screen whose paths are lit: what the pointer is over, else what was clicked. */
  function focused(): Laid | null {
    return hover ?? selected;
  }

  /** A shared screen is drawn once per slice. Light the copy closest to the focused card. */
  function nearestTo(name: string, from: Laid): Laid | null {
    const list = byName.get(name);
    if (!list?.length) return null;
    let best = list[0];
    let bestD = Infinity;
    for (const l of list) {
      const d = (l.pin.x - from.pin.x) ** 2 + (l.pin.y - from.pin.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = l;
      }
    }
    return best;
  }

  const quadAt = (p0: number, cp: number, p1: number, t: number): number =>
    (1 - t) * (1 - t) * p0 + 2 * (1 - t) * t * cp + t * t * p1;
  const quadSlope = (p0: number, cp: number, p1: number, t: number): number =>
    2 * (1 - t) * (cp - p0) + 2 * t * (p1 - cp);

  function head(x: number, y: number, angle: number, size: number, color: string): void {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - size * Math.cos(angle - 0.42), y - size * Math.sin(angle - 0.42));
    ctx.lineTo(x - size * Math.cos(angle + 0.42), y - size * Math.sin(angle + 0.42));
    ctx.closePath();
    ctx.fill();
  }

  /**
   * One lit path, drawn in the direction it is travelled. `bow` pushes it off the straight
   * line so a two-way pair shows both directions side by side instead of on top of each other.
   * Arrowheads run along it, so which way it goes is readable without reading the colour.
   */
  function litPath(from: Laid, to: Laid, color: string, bow: number, phase: number, label: string): void {
    const mx = (from.pin.x + to.pin.x) / 2;
    const my = (from.pin.y + to.pin.y) / 2;
    const dx = to.pin.x - from.pin.x;
    const dy = to.pin.y - from.pin.y;
    const len = Math.hypot(dx, dy) || 1;
    const cpx = mx + (-dy / len) * bow;
    const cpy = my + (dx / len) * bow;
    const a = edgePoint(from.rect, cpx, cpy);
    const b = edgePoint(to.rect, cpx, cpy);

    // A soft halo of the path's own colour, so a lit path reads over the cards it crosses.
    ctx.shadowColor = color;
    ctx.shadowBlur = 14;
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(cpx, cpy, b.x, b.y);
    ctx.stroke();

    // the marching arrowheads
    for (let i = 0; i < 3; i++) {
      const t = (phase + i / 3) % 1;
      const x = quadAt(a.x, cpx, b.x, t);
      const y = quadAt(a.y, cpy, b.y, t);
      const ang = Math.atan2(quadSlope(a.y, cpy, b.y, t), quadSlope(a.x, cpx, b.x, t));
      ctx.globalAlpha = 0.7 + 0.3 * Math.sin(Math.PI * t);
      head(x, y, ang, 14, color);
    }
    ctx.globalAlpha = 1;
    head(b.x, b.y, Math.atan2(b.y - cpy, b.x - cpx), 17, color);
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;

    if (label && cam.s > 0.3) {
      const lx = quadAt(a.x, cpx, b.x, 0.5);
      const ly = quadAt(a.y, cpy, b.y, 0.5);
      ctx.font = "700 12px ui-monospace, Menlo, monospace";
      const tw = ctx.measureText(label).width + 16;
      ctx.fillStyle = color;
      rr(ctx, { x: lx - tw / 2, y: ly - 11, w: tw, h: 22 }, 11);
      ctx.fill();
      ctx.fillStyle = c0.bg;
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      ctx.fillText(label, lx, ly);
      ctx.textAlign = "left";
    }
  }

  // ── drawing ───────────────────────────────────────────────────────────────
  function draw(): void {
    raf = 0;
    if (!dirty || !alive) return;
    dirty = false;
    const dpr = window.devicePixelRatio || 1;
    const vw = stage.clientWidth;
    const vh = stage.clientHeight;
    if (canvas.width !== vw * dpr || canvas.height !== vh * dpr) {
      canvas.width = vw * dpr;
      canvas.height = vh * dpr;
    }
    const c = colors();
    c0 = c;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, vw, vh);
    if (!data) return;
    if (data.needShots) {
      ctx.fillStyle = c.dim;
      ctx.font = "600 14px system-ui, -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const s = data.setup;
      const head = s?.status === "none"
        ? "Spine not set up for this app."
        : "Stage test is there, but no shots were taken.";
      const how = s?.status === "none"
        ? "⟳ Take shots writes test/spine_shots_test.dart from the source, then runs it."
        : "Press ⟳ Take shots to draw the map.";
      ctx.fillText(head, vw / 2, vh / 2 - 12);
      ctx.font = "13px system-ui, -apple-system, sans-serif";
      ctx.fillText(how, vw / 2, vh / 2 + 12);
      const extra = (s?.reasons ?? []).filter((r) => !r.startsWith("no test/") && !r.startsWith("stage test present"));
      extra.forEach((r, i) => ctx.fillText(r, vw / 2, vh / 2 + 36 + i * 20));
      ctx.textAlign = "left";
      return;
    }
    ctx.setTransform(dpr * cam.s, 0, 0, dpr * cam.s, dpr * cam.x, dpr * cam.y);

    // flow frames: an open flow with more than one screen wears a faint outline and its name
    for (const b of blocks) {
      if (!b.expanded || b.kind === "entry" || b.names.size < 2) continue;
      const fr = { x: b.rect.x - 22, y: b.rect.y - 40, w: b.rect.w + 44, h: b.rect.h + 62 };
      ctx.strokeStyle = c.line;
      ctx.setLineDash([6, 8]);
      ctx.lineWidth = 1.5;
      rr(ctx, fr, 22);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = c.dim;
      ctx.font = "700 13px system-ui, -apple-system, sans-serif";
      ctx.textBaseline = "middle";
      ctx.fillText(`${b.label} · ${b.names.size}`, fr.x + 16, fr.y + 18);
    }

    // hops — the resting layout, in the module's own accent
    // A hovered group is not a screen: nothing lights, nothing recedes.
    const focus = (() => { const f = focused(); return f && !f.group ? f : null; })();
    const related = new Set<string>();
    if (focus) {
      const me = focus.pin.name;
      related.add(me);
      for (const n of outsOf.get(me) ?? []) related.add(n);
      for (const n of insOf.get(me) ?? []) related.add(n);
    }
    const drawnHop = new Set<string>();
    for (const h of data.hops) {
      const a = cardFor(h.from, h.row, true);
      const b = cardFor(h.to, h.row, false);
      if (!a || !b || a === b) continue;
      // inside a folded flow the hops are folded too; one arrow reaches the group
      if (a.group && b.group && a.group === b.group) continue;
      const id = `${a.pin.name}>${b.pin.name}`;
      if (drawnHop.has(id)) continue;
      drawnHop.add(id);
      if (!matches(a) || !matches(b)) continue;
      const p1 = edgePoint(a.rect, b.pin.x, b.pin.y);
      const p2 = edgePoint(b.rect, a.pin.x, a.pin.y);
      ctx.strokeStyle = c.accent;
      // Under a focus the whole resting web recedes: the lit pair is drawn over it below.
      ctx.globalAlpha = focus ? 0.2 : 0.5;
      ctx.lineWidth = b.pin.leaf ? 1.2 : 1.8;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
      // arrow head
      const ang = Math.atan2(p2.y - p1.y, p2.x - p1.x);
      ctx.fillStyle = c.accent;
      ctx.beginPath();
      ctx.moveTo(p2.x, p2.y);
      ctx.lineTo(p2.x - 10 * Math.cos(ang - 0.4), p2.y - 10 * Math.sin(ang - 0.4));
      ctx.lineTo(p2.x - 10 * Math.cos(ang + 0.4), p2.y - 10 * Math.sin(ang + 0.4));
      ctx.closePath();
      ctx.fill();
      if (!focus && h.label && cam.s > 0.35) {
        ctx.globalAlpha = 0.85;
        ctx.font = "600 11px ui-monospace, Menlo, monospace";
        const mx = (p1.x + p2.x) / 2;
        const my = (p1.y + p2.y) / 2;
        const tw = ctx.measureText(h.label).width + 12;
        ctx.fillStyle = c.bg;
        rr(ctx, { x: mx - tw / 2, y: my - 9, w: tw, h: 18 }, 9);
        ctx.fill();
        ctx.fillStyle = c.accent;
        ctx.textBaseline = "middle";
        ctx.textAlign = "center";
        ctx.fillText(h.label, mx, my);
        ctx.textAlign = "left";
      }
      ctx.globalAlpha = 1;
    }

    // the focused screen's own paths: green leaves it, red reaches it, both when two-way
    if (focus) {
      const me = focus.pin.name;
      const outs = outsOf.get(me) ?? new Set<string>();
      const ins = insOf.get(me) ?? new Set<string>();
      const phase = (performance.now() % 1500) / 1500;
      for (const name of new Set([...outs, ...ins])) {
        if (name === me) continue;
        const other = nearestTo(name, focus);
        if (!other || !matches(other)) continue;
        const isOut = outs.has(name);
        const isIn = ins.has(name);
        const both = isOut && isIn;
        if (isOut) {
          litPath(focus, other, c.ok, both ? 34 : 0, phase, hopLabel.get(`${me}>${name}`) ?? "");
        }
        if (isIn) {
          litPath(other, focus, c.risk, both ? 34 : 0, phase, hopLabel.get(`${name}>${me}`) ?? "");
        }
      }
    }

    // cards
    for (const l of laid) {
      const p = l.pin;
      if (l.group) {
        drawGroup(l, c, focus);
        continue;
      }
      const dimmed = (focus && !related.has(p.name)) || !matches(l);
      // 1 = the focus goes here, 2 = it comes from here, 3 = both ways.
      const rel =
        focus && p.name !== focus.pin.name
          ? (outsOf.get(focus.pin.name)?.has(p.name) ? 1 : 0) +
            (insOf.get(focus.pin.name)?.has(p.name) ? 2 : 0)
          : 0;
      ctx.globalAlpha = dimmed ? 0.5 : p.ghost ? 0.75 : 1;
      const isHub = p.kind === "hub";
      // shadow + body
      ctx.shadowColor = "rgba(0,0,0,.45)";
      ctx.shadowBlur = isHub ? 40 : 18;
      ctx.shadowOffsetY = 8;
      ctx.fillStyle = c.raised;
      rr(ctx, l.rect, 16);
      ctx.fill();
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      const edge =
        focus === l ? c.accent : rel === 2 ? c.risk : rel ? c.ok : isHub ? c.accent : p.uncharted ? c.faint : c.line;
      ctx.lineWidth = focus === l || rel ? 3 : 1;
      ctx.strokeStyle = edge;
      if (p.uncharted || p.ghost) ctx.setLineDash([4, 4]);
      rr(ctx, l.rect, 16);
      ctx.stroke();
      ctx.setLineDash([]);
      // A two-way neighbour wears both colours: green on the box, red just outside it.
      if (rel === 3) {
        ctx.strokeStyle = c.risk;
        ctx.lineWidth = 3;
        rr(ctx, { x: l.rect.x - 5, y: l.rect.y - 5, w: l.rect.w + 10, h: l.rect.h + 10 }, 21);
        ctx.stroke();
      }
      if (isHub || focus === l || rel) {
        ctx.globalAlpha = (dimmed ? 0.5 : 1) * (focus === l ? 0.4 : rel ? 0.28 : 0.18);
        ctx.strokeStyle = edge;
        ctx.lineWidth = 12;
        rr(ctx, { x: l.rect.x - 7, y: l.rect.y - 7, w: l.rect.w + 14, h: l.rect.h + 14 }, 23);
        ctx.stroke();
        ctx.globalAlpha = dimmed ? 0.5 : 1;
      }

      const compact = p.leaf || p.ghost;
      // enter chip
      if (l.enter && p.enter) {
        const label = `tap ${p.enter.label ?? "…"}`;
        ctx.font = `600 ${compact ? 10 : 11}px ui-monospace, Menlo, monospace`;
        const tw = Math.min(l.enter.w, ctx.measureText(label).width + 14);
        ctx.fillStyle = c.accent + "22";
        rr(ctx, { x: l.enter.x, y: l.enter.y, w: tw, h: l.enter.h }, 8);
        ctx.fill();
        ctx.fillStyle = c.accent;
        ctx.textBaseline = "middle";
        clipText(ctx, label, l.enter.x + 7, l.enter.y + l.enter.h / 2, tw - 14);
      }
      // header: level + title
      ctx.textBaseline = "middle";
      let tx = l.head.x;
      if (p.level || p.ghost) {
        const tag = p.ghost ? "↪" : p.level!;
        ctx.font = `700 ${compact ? 9 : 10}px ui-monospace, Menlo, monospace`;
        const tw = ctx.measureText(tag).width + 10;
        const unaud = p.finding?.unaudited;
        ctx.fillStyle = unaud ? c.risk + "26" : c.accent + "22";
        rr(ctx, { x: tx, y: l.head.y + 4, w: tw, h: l.head.h - 8 }, 6);
        ctx.fill();
        ctx.fillStyle = unaud ? c.risk : c.accent;
        ctx.fillText(tag, tx + 5, l.head.y + l.head.h / 2);
        tx += tw + 7;
      }
      ctx.font = `${isHub ? 800 : 700} ${isHub ? 15 : compact ? 12 : 13.5}px system-ui, -apple-system, sans-serif`;
      ctx.fillStyle = c.ink;
      const routes = p.kind === "boot" ? "" : `←${p.ins} · ${p.outs.length}→`;
      ctx.font = `600 ${compact ? 9 : 10}px ui-monospace, Menlo, monospace`;
      const rw = routes ? ctx.measureText(routes).width : 0;
      ctx.font = `${isHub ? 800 : 700} ${isHub ? 15 : compact ? 12 : 13.5}px system-ui, -apple-system, sans-serif`;
      clipText(ctx, p.title, tx, l.head.y + l.head.h / 2, l.head.w - (tx - l.head.x) - rw - 8);
      if (routes) {
        ctx.font = `600 ${compact ? 9 : 10}px ui-monospace, Menlo, monospace`;
        ctx.fillStyle = c.faint;
        ctx.textAlign = "right";
        ctx.fillText(routes, l.head.x + l.head.w, l.head.y + l.head.h / 2);
        ctx.textAlign = "left";
      }
      // badges
      if (p.kind !== "boot" && !p.ghost) {
        let bx = l.head.x;
        const by = l.head.y + l.head.h + 1;
        const bh = compact ? 13 : 16;
        const chip = (text: string, color: string, dashed = false) => {
          ctx.font = `650 ${compact ? 8.5 : 9.5}px ui-monospace, Menlo, monospace`;
          const tw = ctx.measureText(text).width + 10;
          if (bx + tw > l.head.x + l.head.w) return;
          if (dashed) ctx.setLineDash([3, 3]);
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          rr(ctx, { x: bx, y: by, w: tw, h: bh }, bh / 2);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = color;
          ctx.fillText(text, bx + 5, by + bh / 2);
          bx += tw + 4;
        };
        const f = p.finding;
        if (f?.unaudited) chip("❓ unaudited", c.risk);
        else if (f?.flags.length) chip("✓ owned", c.ok);
        for (const fl of f?.flags ?? []) chip(fl, fl === "money" ? c.warn : c.faint);
        if (f?.loopholes) chip(`🕳 ${f.loopholes}`, c.warn);
        if (p.stale.length) chip("stale", c.warn, true);
        const looks = p.runtime?.states.length ?? 0;
        if (looks > 1) chip(`◫ ${looks} looks`, c.accent);
      }
      // the picture
      if (l.shotBox) {
        rr(ctx, l.shotBox, 10);
        ctx.save();
        ctx.clip();
        if (l.image && l.image.complete && l.image.naturalWidth) {
          ctx.drawImage(l.image, l.shotBox.x, l.shotBox.y, l.shotBox.w, l.shotBox.h);
          if (p.stale.length) {
            ctx.fillStyle = c.warn + "33";
            ctx.fillRect(l.shotBox.x, l.shotBox.y, l.shotBox.w, l.shotBox.h);
          }
        } else {
          ctx.fillStyle = c.bg;
          ctx.fillRect(l.shotBox.x, l.shotBox.y, l.shotBox.w, l.shotBox.h);
          ctx.fillStyle = c.faint;
          ctx.font = "500 10px ui-monospace, Menlo, monospace";
          ctx.textAlign = "center";
          ctx.fillText("loading…", l.shotBox.x + l.shotBox.w / 2, l.shotBox.y + l.shotBox.h / 2);
          ctx.textAlign = "left";
        }
        ctx.restore();
      }
      if (p.kind === "boot") {
        ctx.fillStyle = c.ok;
        ctx.font = "700 12px system-ui, -apple-system, sans-serif";
        ctx.fillText("▶ start here", l.head.x, l.head.y + l.head.h + 16);
      }
      if (p.ghost) {
        ctx.fillStyle = c.accent;
        ctx.font = "600 9.5px ui-monospace, Menlo, monospace";
        ctx.fillText("drawn in another slice → click", l.head.x, l.rect.y + l.rect.h - 9);
      }
      ctx.globalAlpha = 1;
    }

    // The arrowheads march, so a focus keeps asking for frames. Nothing animates at rest.
    if (focus) invalidate();
  }

  /** A folded flow: its name, how many screens it holds, and the top of its first screen. */
  function drawGroup(l: Laid, c: ReturnType<typeof colors>, focus: Laid | null): void {
    const g = l.group!;
    const lit = hover === l;
    const dimmed = (!!focus && focus !== l) || !matches(l);
    ctx.globalAlpha = dimmed ? 0.55 : 1;
    ctx.shadowColor = "rgba(0,0,0,.45)";
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 8;
    ctx.fillStyle = c.raised;
    // a stacked edge behind, so a group reads as "several"
    rr(ctx, { x: l.rect.x + 6, y: l.rect.y - 6, w: l.rect.w, h: l.rect.h }, 16);
    ctx.fill();
    rr(ctx, l.rect, 16);
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.strokeStyle = lit ? c.accent : l.pin.uncharted ? c.faint : c.accent + "88";
    ctx.lineWidth = lit ? 3 : 1.5;
    rr(ctx, l.rect, 16);
    ctx.stroke();
    ctx.textBaseline = "middle";
    ctx.fillStyle = c.ink;
    ctx.font = "700 13.5px system-ui, -apple-system, sans-serif";
    clipText(ctx, `⊞ ${g.label}`, l.head.x, l.head.y + l.head.h / 2, l.head.w);
    ctx.fillStyle = c.dim;
    ctx.font = "600 10px ui-monospace, Menlo, monospace";
    const names = g.members.filter((m) => !m.ghost).map((m) => m.title).join(", ");
    clipText(ctx, `${g.members.length} screens · click to open`, l.head.x, l.head.y + l.head.h + 8, l.head.w);
    if (l.shotBox) {
      rr(ctx, l.shotBox, 10);
      ctx.save();
      ctx.clip();
      ctx.fillStyle = c.bg;
      ctx.fillRect(l.shotBox.x, l.shotBox.y, l.shotBox.w, l.shotBox.h);
      if (l.image && l.image.complete && l.image.naturalWidth) {
        // the top of the first screen, at the card's width: enough to recognise it
        const scale = l.shotBox.w / l.image.naturalWidth;
        ctx.drawImage(l.image, l.shotBox.x, l.shotBox.y, l.shotBox.w, l.image.naturalHeight * scale);
        const fade = ctx.createLinearGradient(0, l.shotBox.y + l.shotBox.h - 40, 0, l.shotBox.y + l.shotBox.h);
        fade.addColorStop(0, c.raised + "00");
        fade.addColorStop(1, c.raised);
        ctx.fillStyle = fade;
        ctx.fillRect(l.shotBox.x, l.shotBox.y + l.shotBox.h - 40, l.shotBox.w, 40);
      }
      ctx.restore();
    }
    l.pin.shotNote = names;
    ctx.globalAlpha = 1;
  }

  function clipText(c2: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number): void {
    if (maxW <= 0) return;
    let t = text;
    if (c2.measureText(t).width <= maxW) {
      c2.fillText(t, x, y);
      return;
    }
    while (t.length > 1 && c2.measureText(t + "…").width > maxW) t = t.slice(0, -1);
    c2.fillText(t + "…", x, y);
  }

  // ── inspector ─────────────────────────────────────────────────────────────
  const inspector = mountInspector(inspectHost, {
    origin: ORIGIN,
    pinOf: (name) => byName.get(name)?.find((x) => !x.pin.ghost)?.pin ?? null,
    copy: (text) => void copy(text),
    toast,
  });

  function openInspector(l: Laid): void {
    const p = l.pin;
    if (p.ghost) {
      const real = byName.get(p.name)?.find((x) => !x.pin.ghost);
      if (real) {
        cam = { s: Math.max(cam.s, 0.8), x: 0, y: 0 };
        cam.x = stage.clientWidth / 2 - real.pin.x * cam.s;
        cam.y = stage.clientHeight / 2 - real.pin.y * cam.s;
        hover = real;
        invalidate();
      }
      return;
    }
    if (p.kind === "boot") return;
    inspector.open(p, data?.shots.taken ?? "");
  }

  // ── events ────────────────────────────────────────────────────────────────
  canvas.addEventListener("pointerdown", (ev) => {
    dragging = { sx: ev.clientX, sy: ev.clientY, cx: cam.x, cy: cam.y, moved: false };
    canvas.setPointerCapture(ev.pointerId);
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (dragging) {
      const dx = ev.clientX - dragging.sx;
      const dy = ev.clientY - dragging.sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) dragging.moved = true;
      cam.x = dragging.cx + dx;
      cam.y = dragging.cy + dy;
      invalidate();
      return;
    }
    const r = canvas.getBoundingClientRect();
    const h = hit(ev.clientX - r.left, ev.clientY - r.top);
    if (h !== hover) {
      hover = h;
      canvas.style.cursor = h ? "pointer" : "grab";
      invalidate();
    }
  });
  canvas.addEventListener("pointerup", (ev) => {
    const wasDrag = dragging?.moved;
    dragging = null;
    if (wasDrag) return;
    const r = canvas.getBoundingClientRect();
    const px = ev.clientX - r.left;
    const py = ev.clientY - r.top;
    const l = hit(px, py);
    if (!l) {
      // clicking the background lets the map go back to resting
      if (selected) {
        selected = null;
        invalidate();
      }
      return;
    }
    const { x, y } = toWorld(px, py);
    if (l.group) {
      openFlow(l.group.label, l.group.block);
      return;
    }
    if (l.enter && inside(l.enter, x, y) && l.pin.enter?.ref) {
      void copy(l.pin.enter.ref);
      toast(`copied\n${l.pin.enter.ref}`);
      return;
    }
    if (inside(l.head, x, y) && l.pin.packet) {
      void copy(l.pin.packet);
      toast(`copied\n${l.pin.packet}`);
      return;
    }
    if (l.pin.ghost) {
      // a ghost is a pointer at the real card — go there instead of focusing a copy
      openInspector(l);
      return;
    }
    // A click sticks the focus, so the in/out paths stay lit once the pointer leaves.
    selected = selected === l ? null : l;
    invalidate();
  });
  canvas.addEventListener("pointerleave", () => {
    if (hover) {
      hover = null;
      invalidate();
    }
  });
  canvas.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      const r = canvas.getBoundingClientRect();
      if (ev.ctrlKey || ev.metaKey) {
        zoomAt(Math.exp(-ev.deltaY * 0.01), ev.clientX - r.left, ev.clientY - r.top);
      } else {
        cam.x -= ev.deltaX;
        cam.y -= ev.deltaY;
        invalidate();
      }
    },
    { passive: false },
  );
  canvas.addEventListener("dblclick", (ev) => {
    const r = canvas.getBoundingClientRect();
    const px = ev.clientX - r.left;
    const py = ev.clientY - r.top;
    const l = hit(px, py);
    // On a card the second click is "show me everything"; on the background it is still zoom.
    if (l) openInspector(l);
    else zoomAt(1.6, px, py);
  });
  host.querySelectorAll<HTMLButtonElement>(".sm-zoom button").forEach((b) => {
    b.addEventListener("click", () => {
      const cx = stage.clientWidth / 2;
      const cy = stage.clientHeight / 2;
      if (b.dataset.z === "fit") fit();
      else zoomAt(b.dataset.z === "in" ? 1.25 : 0.8, cx, cy);
    });
  });
  filterBox.addEventListener("input", () => {
    filter = filterBox.value.trim().toLowerCase();
    invalidate();
  });
  document.addEventListener("keydown", onKey);
  function onKey(ev: KeyboardEvent): void {
    if (ev.key !== "Escape") return;
    if (inspector.isOpen()) inspector.close();
    else if (selected) {
      selected = null;
      invalidate();
    }
  }
  const ro = new ResizeObserver(() => invalidate());
  ro.observe(stage);

  /** Open one flow and keep the camera on it. */
  function openFlow(label: string, block: number): void {
    const before = blocks[block]?.rect;
    expanded.add(label);
    saveExpanded();
    layout();
    const after = blocks.find((b) => b.label === label)?.rect;
    if (before && after) {
      // keep the block's old centre under the same screen point
      const dx = after.x + after.w / 2 - (before.x + before.w / 2);
      const dy = after.y + after.h / 2 - (before.y + before.h / 2);
      cam.x -= dx * cam.s;
      cam.y -= dy * cam.s;
    }
    hover = null;
    selected = null;
    invalidate();
  }
  revealBtn.addEventListener("click", () => {
    revealAll = !revealAll;
    if (!revealAll) expanded.clear();
    saveExpanded();
    paintReveal();
    layout();
    fit();
  });

  shotsBtn.addEventListener("click", async () => {
    if (!key) return;
    shotsBtn.disabled = true;
    shotsBtn.textContent = "⟳ taking shots…";
    toast("running the app's shot test — a cold run takes a minute or two");
    try {
      const started = await modulePost<{ ok: boolean; error?: string; before?: string; before_advice?: string }>(`${M}/app/${key}/shots`, {});
      if (!started.ok) throw new Error(started.error || "could not start");
      const before = started.before ?? "";
      const beforeAdvice = started.before_advice ?? "";
      type Advice = { where: string; what: string; fix: string };
      type LastRun = { ok?: boolean; error?: string; advice?: Advice[]; at?: string };
      const walls = (a: Advice[] | undefined): string =>
        (a ?? []).map((x) => `⚠ ${x.where} — ${x.what}\n   fix: ${x.fix}`).join("\n");
      for (let i = 0; i < 120 && alive; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const ix = await moduleGet<{ taken?: string; commit?: string; last_run?: LastRun }>(`${M}/app/${key}/shots`);
        const run = ix.last_run ?? {};
        if ((ix.taken ?? "") !== before && ix.commit) {
          const w = walls(run.advice);
          toast(w ? `shots taken @${ix.commit} — some need a hand:\n${w}` : `shots taken @${ix.commit}`);
          await load(key);
          return;
        }
        if ((run.at ?? "") !== beforeAdvice && run.ok === false) {
          // The test did not run through. The walls say what to fix by hand.
          throw new Error(`${(run.error ?? "").split("\n")[0]}\n${walls(run.advice)}`);
        }
      }
      throw new Error("no result after 6 minutes — see take.log");
    } catch (error) {
      toast(`shots failed\n${String(error)}`);
    } finally {
      shotsBtn.disabled = false;
      shotsBtn.textContent = "⟳ Take shots";
    }
  });

  function paintScore(): void {
    if (!data) return;
    const s = data.score;
    const hidden = data.shotless?.length ?? 0;
    scoreEl.innerHTML =
      `<b>${s.screens}</b> shot screens · <b>${s.flows}</b> flows · ` +
      `<b class="risk">${s.unaudited}</b> unaudited · <b class="ok">${s.owned}</b> owned · ` +
      `<b class="${s.stale ? "warn" : ""}">${s.stale}</b> stale` +
      (hidden ? ` · <b>${hidden}</b> not shot, not drawn` : "") +
      (s.uncharted ? ` · <b>${s.uncharted}</b> uncharted` : "");
    scoreEl.title = hidden ? `no shot yet: ${data.shotless!.join(", ")}` : "";
    metaEl.textContent = data.shots.commit
      ? `shots @${data.shots.commit}${data.shots.dirty ? "+dirty" : ""} · ${(data.shots.taken ?? "").slice(0, 16).replace("T", " ")}`
      : "no shots yet";
  }

  async function load(k: string): Promise<void> {
    key = k;
    selected = null;
    hover = null;
    inspector.close();
    metaEl.textContent = "reading…";
    const t0 = performance.now();
    const d = await moduleGet<MapData>(`${M}/app/${encodeURIComponent(k)}/map.json`);
    if (!alive || key !== k) return;
    if (d.error) {
      scoreEl.textContent = "";
      setupEl.hidden = true;
      metaEl.textContent = d.error;
      data = null;
      laid = [];
      invalidate();
      return;
    }
    data = d;
    loadExpanded();
    paintReveal();
    layout();
    paintScore();
    paintSetup();
    metaEl.textContent += ` · ${Math.round(performance.now() - t0)} ms${d.cached ? " (cached)" : ""}`;
    fit();
  }

  return {
    load,
    destroy() {
      alive = false;
      ro.disconnect();
      document.removeEventListener("keydown", onKey);
      cancelAnimationFrame(raf);
    },
  };
}
