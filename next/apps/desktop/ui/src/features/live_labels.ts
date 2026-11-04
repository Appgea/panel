/**
 * The words on the map: district signs, This Mac and its bays, the landmarks, and each agent's
 * name tag and speech bubble. Bevy draws every shape. Words sit in stage pixels over the world
 * point they belong to, so they stay sharp at any zoom.
 *
 * Words keep their size while the map zooms, so zooming out packs them together. Two rules keep
 * them apart. Small words go first as the map shrinks (the zoom levels below). Then every word
 * that is left gets a priority, and one that would touch a more important word hides until there
 * is room. Owner, 2026-11-05: "Zooming out and in, things look weird. Sometimes text overlap."
 *
 * Every element is kept by key and only its text changes, so its size is measured once per text,
 * not on every frame of a drag. An agent's tag and bubble slide with a CSS transition that
 * matches Bevy's glide. While the owner drags, `.is-panning` turns the transition off.
 */

import { button, div, span, STATE_WORD } from "./live_text";
import type { LiveAgent, LiveCtx } from "./live_types";
import "./live_labels.css";

export type Labels = { paint(): void };

/** Below this zoom only agents that need the owner, or the one in focus, keep their name tags. */
const TAG_ZOOM = 0.7;
/** Below these zooms This Mac shows only its name, then no bay words. */
const HUB_LINE_ZOOM = 0.6;
const BAY_ZOOM = 0.75;
/** Below this zoom signs and landmarks show their name without the second line. */
const META_ZOOM = 0.55;
/** Clear space kept around every word, in CSS pixels. */
const GAP = 3;

/**
 * Which word wins a spot, lowest first. What an agent says is the point of Live, so its bubble
 * beats a district's sign. The words that are always the same lose first.
 */
const RANK = { focusBubble: 0, urgentTag: 1, bubble: 2, sign: 3, hub: 4, tag: 5, mark: 6, bay: 7 } as const;

/** Where a word's box sits against its point. */
type Anchor = "above" | "below" | "corner";
type Word = { el: HTMLElement; rank: number; x: number; y: number; anchor: Anchor; dy: number };

export function mountLabels(ctx: LiveCtx, layer: HTMLElement): Labels {
  const fixed = div("live-fixed");
  const agents = div("live-agents");
  layer.append(fixed, agents);

  const pool = new Map<string, HTMLElement>();
  const nodes = new Map<string, { el: HTMLElement; tag: HTMLElement; bubble: HTMLElement }>();
  const sizes = new WeakMap<HTMLElement, { sig: string; w: number; h: number }>();

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
      const tag = span("live-tag", "");
      const bubble = span("live-bubble", "");
      el.append(tag, bubble);
      agents.append(el);
      n = { el, tag, bubble };
      nodes.set(a.id, n);
    }
    return n;
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

    for (const d of w.districts) {
      const sign = keep(`sign:${d.key}`, used, () => {
        const b = button("live-sign", "", () => ctx.select({ kind: "room", id: d.key }));
        b.append(span("live-sign-name"), span("live-sign-meta"));
        return b;
      });
      const working = d.agents.filter((id) => ctx.agentById(id)?.state !== "idle").length;
      const meta = [working ? `${working} working` : `${d.agents.length} idle`, d.waiting ? `${d.waiting} ${d.waiting === 1 ? "waits" : "wait"} for you` : "", d.stuck ? "stuck" : ""].filter(Boolean).join(" · ");
      text(sign.children[0] as HTMLElement, d.name);
      const line = sign.children[1] as HTMLElement;
      text(line, meta);
      line.className = `live-sign-meta${d.stuck ? " is-stuck" : d.waiting ? " is-card" : ""}`;
      sign.classList.toggle("is-small", z < META_ZOOM);
      const p = place(sign, d.x, d.y - d.r);
      words.push({ el: sign, rank: RANK.sign, x: p.x, y: p.y, anchor: "above", dy: 8 });
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
    words.push({ el: hub, rank: RANK.hub, x: hp.x, y: hp.y, anchor: "corner", dy: 0 });
    if (z >= BAY_ZOOM)
      w.hub.bays.forEach((b, i) => {
        const hold = m.bays[i];
        const owner = ctx.agentById(hold?.agent ?? null);
        const bay = keep(`bay:${i}`, used, () => {
          const el = div("live-bay");
          el.append(span("live-bay-name", `bay ${i + 1}`), span("live-bay-who"));
          return el;
        });
        bay.classList.toggle("is-held", !!hold?.holder);
        bay.style.width = `${Math.max(40, b.w * z - 16)}px`;
        text(bay.children[1] as HTMLElement, hold?.holder ? [owner ? ctx.nameOf(owner) : "", hold.holder].filter(Boolean).join(" · ") : "Free");
        const p = place(bay, b.x - b.w / 2 + 8, b.y - b.h / 2 + 5);
        words.push({ el: bay, rank: RANK.bay, x: p.x, y: p.y, anchor: "corner", dy: 0 });
      });

    const L = w.landmarks;
    const mark = (key: string, name: string, line: string, x: number, y: number) => {
      const el = keep(`mark:${key}`, used, () => {
        const e = div(`live-mark is-${key}`);
        e.append(span("live-mark-name", name), span("live-mark-line", line));
        return e;
      });
      el.classList.toggle("is-small", z < META_ZOOM);
      const p = place(el, x, y);
      words.push({ el, rank: RANK.mark, x: p.x, y: p.y, anchor: "below", dy: 0 });
    };
    mark("tower", "GitHub", "pushes and releases", L.tower.x, L.tower.y + 14);
    mark("web", "Web", "searches and pages", L.web.x, L.web.y + 50);
    for (const [key, el] of pool)
      if (!used.has(key)) {
        el.remove();
        pool.delete(key);
      }

    // Agents: kept, so their move animates.
    const seen = new Set<string>();
    for (const a of world.agents) {
      const spot = w.dots.get(a.id);
      if (!spot || spot.swarm < 0) continue;
      seen.add(a.id);
      const n = agentNode(a);
      const p = place(n.el, ...xy(s.walks.get(a.id) ?? spot));
      n.el.className = `live-agent is-${a.state}`;
      const name = ctx.nameOf(a);
      n.el.setAttribute("aria-label", `${name}, ${STATE_WORD[a.state]}${a.now ? `: ${a.now.label}` : ""}`);
      const focus = s.hover === a.id || (s.selection?.kind === "agent" && s.selection.id === a.id);
      const urgent = a.state === "turn" || a.state === "stuck";
      n.el.classList.toggle("is-focus", focus);
      text(n.tag, spot.swarm > 0 ? `${name} ×${spot.swarm + a.helpers}` : name);
      n.tag.hidden = !(focus || urgent || z >= TAG_ZOOM);
      if (!n.tag.hidden) words.push({ el: n.tag, rank: focus || urgent ? RANK.urgentTag : RANK.tag, x: p.x, y: p.y, anchor: "below", dy: 9 });
      const said = s.bubbles.get(a.id) ?? (focus ? (a.now?.label ?? a.lastText ?? STATE_WORD[a.state]) : null);
      text(n.bubble, said ?? "");
      n.bubble.hidden = !said;
      if (said) words.push({ el: n.bubble, rank: focus ? RANK.focusBubble : RANK.bubble, x: p.x, y: p.y, anchor: "above", dy: 9 });
    }
    for (const [id, n] of nodes)
      if (!seen.has(id)) {
        n.el.remove();
        nodes.delete(id);
      }

    cull(words);
  }

  /** Measures what changed, then hides each word that would touch one placed before it. */
  function cull(words: Word[]): void {
    const boxes = words.map((wd) => {
      const sig = `${wd.el.className}|${wd.el.style.width}|${wd.el.textContent}`;
      let size = sizes.get(wd.el);
      if (!size || size.sig !== sig) {
        size = { sig, w: wd.el.offsetWidth, h: wd.el.offsetHeight };
        sizes.set(wd.el, size);
      }
      const { w, h } = size;
      const x0 = wd.anchor === "corner" ? wd.x : wd.x - w / 2;
      const y0 = wd.anchor === "above" ? wd.y - wd.dy - h : wd.y + wd.dy;
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

function xy(p: { x: number; y: number }): [number, number] {
  return [p.x, p.y];
}

/** Writes text only when it changed, so a repaint never costs a layout for the same words. */
function text(el: HTMLElement, t: string): void {
  if (el.textContent !== t) el.textContent = t;
}
