/**
 * The words on the map: plot signs, This Mac and its bays, the landmarks, and each agent's
 * bubble. Bevy draws every shape. Words sit in stage pixels over the world point they belong
 * to, so they stay sharp at any zoom.
 *
 * Every agent always has its bubble: its name and what it does now, beside its dot in its row.
 * A script may put its own words there for a moment. Owner, 2026-11-05: "I like the bubbles
 * that we show what they are doing."
 *
 * Words keep their size while the map zooms, so zooming out packs them together. Three rules
 * keep them apart. A bubble is never wider than its row, and drops to one line below TIGHT_ZOOM.
 * Small words go first as the map shrinks (the zoom levels below). Then every word that is left
 * gets a priority, and one that would touch a more important word hides until there is room.
 * Owner, 2026-11-05: "Zooming out and in, things look weird. Sometimes text overlap."
 *
 * Every element is kept by key and only its text changes, so its size is measured once per text,
 * not on every frame of a drag.
 */

import { landmarkNews, type News } from "./live_playbook";
import { ageOf, ago, button, div, doing, plural, span, STATE_WORD, taskLine } from "./live_text";
import type { LiveAgent, LiveCtx } from "./live_types";
import { along, BUBBLE_DX, BUBBLE_W, TILE_STEP } from "./live_world";
import "./live_labels.css";

export type Labels = { paint(): void };

/** Below these zooms This Mac shows only its name, then no bay words. */
const HUB_LINE_ZOOM = 0.6;
const BAY_ZOOM = 0.75;
/** Below this zoom signs and landmarks show their name without the second part. */
const META_ZOOM = 0.55;
/** Below this zoom a bubble keeps to one line, so it fits its row. Below the small one it shrinks. */
const TIGHT_ZOOM = 0.9;
const SMALL_ZOOM = 0.62;
/** Clear space kept around every word, in CSS pixels. */
const GAP = 3;
/** How long a bubble's edge stays lit after the agent starts a new step. */
const NEW_MS = 1200;
/** A trip's way is a hint under the trip, never louder than the words. */
const LINE_OPACITY = 0.28;

/**
 * Which word wins a spot, lowest first. What an agent says is the point of Live, so its bubble
 * beats a plot's sign. The words that are always the same lose first.
 */
const RANK = { focusBubble: 0, urgentBubble: 1, bubble: 2, sign: 3, hub: 4, mark: 6, bay: 7, foot: 8 } as const;

/** Where a word's box sits against its point. `right` starts just right of an agent's dot. */
type Anchor = "below" | "above" | "corner" | "right";
type Word = { el: HTMLElement; rank: number; x: number; y: number; anchor: Anchor; dx: number };

export function mountLabels(ctx: LiveCtx, layer: HTMLElement): Labels {
  const fixed = div("live-fixed");
  const agents = div("live-agents");
  // Under the bubbles: a glyph passing an agent must never hide what that agent says.
  const marksEl = div("live-fxmarks");
  layer.append(fixed, marksEl, agents);
  const markEls = new Map<number, HTMLElement>();
  let frame = 0;

  /**
   * Glyphs and tags from scripts. They move every frame while one travels, so they repaint on
   * their own loop, which stops when the last one fades. A tag never travels.
   */
  function paintMarks(): void {
    frame = 0;
    const s = ctx.s;
    const now = Date.now();
    s.marks = s.marks.filter((m) => now < m.born + m.ms);
    const live = new Set(s.marks.map((m) => m.id));
    for (const [id, el] of markEls)
      if (!live.has(id)) {
        el.remove();
        markEls.delete(id);
      }
    for (const m of s.marks) {
      let el = markEls.get(m.id);
      if (!el) {
        el = m.line ? lineEl() : m.glyph ? glyphEl(m.glyph) : span("live-tag", m.text ?? "");
        if (!m.line) el.classList.add("live-fx");
        el.style.setProperty("--c", m.color);
        markEls.set(m.id, el);
        // Ways go first, so every glyph and tag draws over them.
        if (m.line) marksEl.prepend(el);
        else marksEl.append(el);
      }
      const t = Math.min(1, (now - m.born) / m.ms);
      if (m.line && m.path) {
        const pts = m.path.map((q) => ctx.toScreen(q));
        el.firstElementChild!.setAttribute("points", pts.map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(" "));
        // Fades by the clock, not by share of life: a later trip on the same way stretches the
        // life, and a share would jump the line back from its fade.
        const age = now - m.born;
        el.style.opacity = String(LINE_OPACITY * Math.max(0, Math.min(1, age / 150, (m.ms - age) / 400)));
        continue;
      }
      // Reduced motion: no travel, the glyph shows where it ends.
      const k = s.reduced ? 1 : m.to ? ease(Math.min(1, t / 0.8)) : 0;
      const at = m.path ? along(m.path, k) : m.to ? { x: m.at.x + (m.to.x - m.at.x) * k, y: m.at.y + (m.to.y - m.at.y) * k } : m.at;
      const p = ctx.toScreen(at);
      el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -50%)`;
      el.style.opacity = String(t < 0.1 ? t / 0.1 : t > 0.75 ? Math.max(0, (1 - t) / 0.25) : 1);
    }
    if (s.marks.length) frame = requestAnimationFrame(paintMarks);
  }

  const pool = new Map<string, HTMLElement>();
  const nodes = new Map<string, { el: HTMLElement; bubble: HTMLElement; who: HTMLElement; kids: HTMLElement; res: HTMLElement; say: HTMLElement; age: HTMLElement; lit: number }>();
  let sizes = new WeakMap<HTMLElement, { sig: string; w: number; h: number }>();
  // Words measured in the fallback font wrap wider and taller. Once Live's fonts arrive every
  // size is measured again, or a bubble would hide the sign above it for good.
  document.fonts?.addEventListener?.("loadingdone", () => {
    sizes = new WeakMap();
    paint();
  });
  /** The bubble width for this zoom, part of every measure's signature. */
  let bw = "";

  function keep(key: string, used: Set<string>, make: () => HTMLElement): HTMLElement {
    let el = pool.get(key);
    if (!el) {
      el = make();
      pool.set(key, el);
      fixed.append(el);
    }
    used.add(key);
    return el;
  }

  function agentNode(a: LiveAgent) {
    let n = nodes.get(a.id);
    if (!n) {
      const el = button("live-agent", "", () => ctx.select({ kind: "agent", id: a.id }));
      el.dataset.agent = a.id;
      const bubble = span("live-bubble");
      const who = span("live-who");
      const kids = span("live-kids");
      const res = span("live-res");
      const say = span("live-say");
      const age = span("live-age");
      bubble.append(who, kids, res, say, age);
      el.append(bubble);
      // Joins the page in paint, after its first place is set, so it never slides in from 0, 0.
      n = { el, bubble, who, kids, res, say, age, lit: 0 };
      nodes.set(a.id, n);
    }
    return n;
  }

  /** What an agent's bubble says when no script speaks: its step, or for an idle one its work. */
  function line(a: LiveAgent): string {
    if (a.state !== "idle") return doing(a);
    const iss = ctx.issueOf(a);
    return iss ? `#${iss.number} ${iss.title}` : (taskLine(a.task) ?? STATE_WORD.idle);
  }

  function paint(): void {
    const s = ctx.s;
    const w = s.layout;
    const world = s.world;
    if (!w || !world) return;
    const z = s.camera.zoom;
    const words: Word[] = [];
    const used = new Set<string>();
    const place = (el: HTMLElement, x: number, y: number) => {
      const p = ctx.toScreen({ x, y });
      el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
      return p;
    };

    // The gap between dot and bubble keeps its size, so it comes out of the bubble's width.
    const nextBw = `${Math.max(60, Math.round((BUBBLE_W + BUBBLE_DX) * z - BUBBLE_DX))}px`;
    if (nextBw !== bw) {
      bw = nextBw;
      layer.style.setProperty("--bw", bw);
    }
    layer.classList.toggle("is-tight", z < TIGHT_ZOOM);
    layer.classList.toggle("is-small", z < SMALL_ZOOM);

    for (const d of w.districts) {
      const sign = keep(`sign:${d.key}`, used, () => {
        const b = button("live-sign", "", () => ctx.select({ kind: "room", id: d.key }));
        b.append(span("live-sign-name"), span("live-sign-meta"));
        return b;
      });
      // Counted as the top line counts: agents, then their helpers apart (live_top.ts `line`).
      const here = d.agents.map((id) => ctx.agentById(id)).filter((a): a is LiveAgent => !!a);
      const mains = here.filter((a) => !a.parent || !ctx.agentById(a.parent));
      const helpers = here.length - mains.length;
      const busy = mains.filter((a) => a.state === "work" || a.state === "think").length;
      const idle = mains.filter((a) => a.state === "idle").length;
      const stuck = mains.filter((a) => a.state === "stuck").length;
      const meta = [d.waiting ? `${d.waiting} ${d.waiting === 1 ? "waits" : "wait"} for you` : "", stuck ? `${stuck} stuck` : "", busy ? `${busy} working` : "", idle ? `${idle} idle` : "", helpers ? `${helpers} ${plural(helpers, "helper")}` : ""].filter(Boolean).join(" · ");
      text(sign.children[0] as HTMLElement, d.name);
      const metaEl = sign.children[1] as HTMLElement;
      text(metaEl, meta);
      metaEl.className =`live-sign-meta${d.stuck ? " is-stuck" : d.waiting ? " is-card" : ""}`;
      sign.classList.toggle("is-small", z < META_ZOOM);
      // The sign stays inside its plot's head at every zoom.
      sign.style.maxWidth = `${Math.max(40, Math.round((d.w - 20) * z))}px`;
      const p = place(sign, d.x - d.w / 2 + 10, d.y - d.h / 2 + 6);
      words.push({ el: sign, rank: RANK.sign, x: p.x, y: p.y, anchor: "corner", dx: 0 });

      // The squares along a plot's foot are files. Unnamed, they read as decoration.
      const last = d.tiles[d.tiles.length - 1];
      if (last && z >= META_ZOOM) {
        const changed = d.tiles.filter((t) => here.some((a) => a.files.includes(t.path) || a.steps.some((st) => st.file === t.path && (st.verb === "edit" || st.station === "build")))).length;
        const read = d.tiles.length - changed;
        const foot = keep(`foot:${d.key}`, used, () => div("live-foot"));
        const said = [changed ? `${changed} ${plural(changed, "file")} changed` : "", read ? `${read} read` : ""].filter(Boolean).join(" · ");
        text(foot, said);
        foot.title = d.tiles.map((t) => t.path.split("/").slice(-2).join("/")).join("\n");
        const fp = place(foot, last.x + TILE_STEP, last.y - 7);
        words.push({ el: foot, rank: RANK.foot, x: fp.x, y: fp.y, anchor: "corner", dx: 0 });
      }
    }

    const m = world.mac;
    const cpu = m.cores ? Math.round(Math.min(1, m.load / m.cores) * 100) : 0;
    const hub = keep("hub", used, () => {
      const h = div("live-hub");
      h.append(span("live-hub-name", "This Mac"), span("live-hub-line"));
      return h;
    });
    const hubLine = hub.children[1] as HTMLElement;
    text(hubLine, `CPU ${cpu}% · ${m.hot ? "hot" : "cool"}${(m.quota ?? []).map((q) => ` · ${q.harness} week ${Math.round(q.used)}%`).join("")}`);
    hubLine.classList.toggle("is-hot", m.hot);
    // Words never spill out of This Mac: they get its width, and the small ones go when it shrinks.
    hub.style.width = `${Math.max(60, w.hub.w * z - 28)}px`;
    hub.classList.toggle("is-small", z < HUB_LINE_ZOOM);
    const hp = place(hub, w.hub.x - w.hub.w / 2 + 14, w.hub.y - w.hub.h / 2 + 10);
    words.push({ el: hub, rank: RANK.hub, x: hp.x, y: hp.y, anchor: "corner", dx: 0 });
    if (z >= BAY_ZOOM)
      w.hub.bays.forEach((b, i) => {
        const hold = m.bays[i];
        const owner = ctx.agentById(hold?.agent ?? null);
        const bay = keep(`bay:${i}`, used, () => {
          const el = div("live-bay");
          el.append(span("live-bay-name", `Test bay ${i + 1}`), span("live-bay-who"));
          return el;
        });
        bay.classList.toggle("is-held", !!hold?.holder);
        bay.style.width = `${Math.max(40, b.w * z - 16)}px`;
        // The holder's command ran past the bay's edge. Its agent's name fits, and the command
        // is in the tooltip.
        text(bay.children[1] as HTMLElement, hold?.holder ? (owner ? ctx.nameOf(owner) : hold.holder) : "Free");
        bay.title = hold?.holder ? `${owner ? `${ctx.nameOf(owner)} runs: ` : ""}${hold.holder}` : "No build or test runs here";
        const p = place(bay, b.x - b.w / 2 + 8, b.y - b.h / 2 + 5);
        words.push({ el: bay, rank: RANK.bay, x: p.x, y: p.y, anchor: "corner", dx: 0 });
      });

    const L = w.landmarks;
    const now = Date.now();
    const mark = (key: string, name: string, line: string, x: number, y: number) => {
      const el = keep(`mark:${key}`, used, () => {
        const e = div(`live-mark is-${key}`);
        e.append(span("live-mark-name", name), span("live-mark-line"));
        return e;
      });
      text(el.children[1] as HTMLElement, line);
      el.title = line;
      el.classList.toggle("is-small", z < META_ZOOM);
      const p = place(el, x, y);
      words.push({ el, rank: RANK.mark, x: p.x, y: p.y, anchor: "above", dx: 0 });
    };
    // A landmark says its last real news, not what it is for.
    const news = landmarkNews(world);
    const told = (n: News | null, none: string) => {
      if (!n) return none;
      const by = n.agent ? ctx.nameOf(n.agent) : n.ember ? ctx.emberWho(n.ember).title : "";
      return `${ago(n.at, now)} · ${by ? `${by}: ` : ""}${n.label}`;
    };
    // Above their landmark: trips come in from the lane below, so the words are never crossed.
    mark("tower", "GitHub", told(news.tower, "No push lately"), L.tower.x, L.tower.y - 142);
    mark("web", "Web", told(news.web, "No web visit lately"), L.web.x, L.web.y - 50);
    for (const [key, el] of pool)
      if (!used.has(key)) {
        el.remove();
        pool.delete(key);
      }

    // Agents: kept by id, so a bubble keeps its element while its words change.
    const seen = new Set<string>();
    for (const a of world.agents) {
      const spot = w.dots.get(a.id);
      if (!spot || spot.swarm < 0) continue;
      seen.add(a.id);
      const fresh = !nodes.has(a.id);
      const n = agentNode(a);
      const p = place(n.el, spot.x, spot.y);
      if (fresh) agents.append(n.el);
      const focus = s.hover === a.id || (s.selection?.kind === "agent" && s.selection.id === a.id);
      const urgent = a.state === "turn" || a.state === "stuck";
      const name = ctx.nameOf(a);
      const said = s.bubbles.get(a.id) ?? line(a);
      const kids = spot.swarm + a.helpers;
      const age = ageOf(a, now);
      const res = s.results.get(a.id);
      const result = res && res.until > now ? res : null;
      // A new step lights the bubble's edge for a moment, so the eye goes to the agent that moved.
      if (!fresh && !s.reduced && n.say.textContent !== said) n.lit = now + NEW_MS;
      text(n.who, name);
      text(n.kids, kids ? `+${kids}` : "");
      n.kids.title = kids ? `${kids} ${plural(kids, "helper")}` : "";
      text(n.res, result ? `${result.ok ? "✓" : "✗"} ${result.text}` : "");
      n.res.className = `live-res${result ? (result.ok ? " is-ok" : " is-bad") : ""}`;
      text(n.say, said);
      text(n.age, age ? (a.state === "turn" ? `waiting ${age}` : age) : "");
      n.el.className = `live-agent is-${a.state}${focus ? " is-focus" : ""}${n.lit > now ? " is-new" : ""}`;
      const full = `${name}, ${STATE_WORD[a.state]}${age ? ` ${age}` : ""}: ${result ? `${result.text}. ` : ""}${said}`;
      n.el.setAttribute("aria-label", full);
      n.bubble.title = full;
      words.push({ el: n.bubble, rank: focus ? RANK.focusBubble : urgent ? RANK.urgentBubble : RANK.bubble, x: p.x, y: p.y, anchor: "right", dx: BUBBLE_DX });
    }
    for (const [id, n] of nodes)
      if (!seen.has(id)) {
        n.el.remove();
        nodes.delete(id);
      }

    cull(words);
    if (!frame) paintMarks();
  }

  /** Measures what changed, then hides each word that would touch one placed before it. */
  function cull(words: Word[]): void {
    const look = layer.className;
    const boxes = words.map((wd) => {
      const sig = `${wd.el.className}|${wd.el.style.width}|${wd.el.style.maxWidth}|${bw}|${look}|${wd.el.textContent}`;
      let size = sizes.get(wd.el);
      if (!size || size.sig !== sig) {
        size = { sig, w: wd.el.offsetWidth, h: wd.el.offsetHeight };
        sizes.set(wd.el, size);
      }
      const { w, h } = size;
      const x0 = wd.anchor === "below" || wd.anchor === "above" ? wd.x - w / 2 : wd.x + wd.dx;
      const y0 = wd.anchor === "right" ? wd.y - h / 2 : wd.anchor === "above" ? wd.y - h : wd.y;
      return { wd, x0: x0 - GAP, y0: y0 - GAP, x1: x0 + w + GAP, y1: y0 + h + GAP };
    });
    boxes.sort((a, b) => a.wd.rank - b.wd.rank);
    const placed: typeof boxes = [];
    for (const b of boxes) {
      const hit = placed.some((p) => b.x0 < p.x1 && b.x1 > p.x0 && b.y0 < p.y1 && b.y1 > p.y0);
      b.wd.el.classList.toggle("is-culled", hit);
      if (!hit) placed.push(b);
    }
  }

  return { paint };
}

const SVG = "http://www.w3.org/2000/svg";

/** A line icon. `d` is a checked path (live_script.ts `glyphPath`), set as an attribute, never as markup. */
function glyphEl(d: string): HTMLElement {
  const wrap = span("live-glyph");
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", d);
  svg.append(path);
  wrap.append(svg);
  return wrap;
}

/** A trip's way: one faint line across the stage, set point by point every frame. */
function lineEl(): HTMLElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "live-path");
  svg.setAttribute("aria-hidden", "true");
  svg.append(document.createElementNS(SVG, "polyline"));
  return svg as unknown as HTMLElement;
}

function ease(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

/** Writes text only when it changed, so a repaint never costs a layout for the same words. */
function text(el: HTMLElement, t: string): void {
  if (el.textContent !== t) el.textContent = t;
}
