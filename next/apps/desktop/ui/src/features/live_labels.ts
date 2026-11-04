/**
 * The words on the map: district signs, This Mac and its bays, the landmarks, and each agent's
 * name tag and speech bubble. Bevy draws every shape. Words sit in stage pixels over the world
 * point they belong to, so they stay sharp at any zoom.
 *
 * An agent's tag and bubble are kept per agent and slide with a CSS transition that matches
 * Bevy's glide. While the owner drags, `.is-panning` turns the transition off so the words stay
 * glued to the map.
 */

import { errorText } from "../errors";
import { button, div, holdButton, plural, span, STATE_WORD } from "./live_text";
import type { LiveAgent, LiveCtx } from "./live_types";
import "./live_labels.css";

export type Labels = { paint(): void };

/** Below this zoom only agents that need the owner keep their name tags. */
const TAG_ZOOM = 0.7;
/** Below these zooms This Mac shows only its name, then no bay words. */
const HUB_LINE_ZOOM = 0.6;
const BAY_ZOOM = 0.75;

export function mountLabels(ctx: LiveCtx, layer: HTMLElement): Labels {
  const fixed = div("live-fixed");
  const agents = div("live-agents");
  // Processes no agent owns any more, under This Mac. Kept, not rebuilt, so a hold on Stop
  // survives the repaints a running script makes.
  const left = div("live-left");
  const leftText = span("live-left-text");
  left.append(
    leftText,
    holdButton("Hold to Stop", () => {
      for (const j of (ctx.s.world?.jobs ?? []).filter((x) => x.kind === "left")) void stop(j.pid, j.label);
    }),
  );
  agents.append(left);
  layer.append(fixed, agents);

  async function stop(pid: number, who: string): Promise<void> {
    try {
      await ctx.events.stop(pid);
      ctx.toast(`Asked ${who} to stop.`);
      ctx.poll();
    } catch (e) {
      ctx.toast(`Could not stop ${who}: ${errorText(e, "refused")}`, true);
    }
  }
  const nodes = new Map<string, { el: HTMLElement; tag: HTMLElement; bubble: HTMLElement }>();

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
    const out: HTMLElement[] = [];
    const at = (el: HTMLElement, x: number, y: number) => {
      const p = ctx.toScreen({ x, y });
      el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
      out.push(el);
      return el;
    };

    for (const d of w.districts) {
      const working = d.agents.filter((id) => ctx.agentById(id)?.state !== "idle").length;
      const meta = [working ? `${working} working` : `${d.agents.length} idle`, d.cards ? `${d.cards} for you` : "", d.stuck ? "stuck" : ""].filter(Boolean);
      const sign = button("live-sign", "", () => ctx.select({ kind: "room", id: d.key }));
      sign.append(span("live-sign-name", d.name), span(`live-sign-meta${d.stuck ? " is-stuck" : d.cards ? " is-card" : ""}`, meta.join(" · ")));
      at(sign, d.x, d.y - d.r);
    }

    const m = world.mac;
    const cpu = m.cores ? Math.round(Math.min(1, m.load / m.cores) * 100) : 0;
    const hub = div("live-hub");
    hub.append(span("live-hub-name", "This Mac"), span(`live-hub-line${m.hot ? " is-hot" : ""}`, `CPU ${cpu}% · ${m.hot ? "hot" : "cool"}${(m.quota ?? []).map((q) => ` · ${q.harness} week ${Math.round(q.used)}%`).join("")}`));
    at(hub, w.hub.x - w.hub.w / 2 + 14, w.hub.y - w.hub.h / 2 + 10);
    // Words never spill out of This Mac: they get its width, and the small ones go when it shrinks.
    hub.style.width = `${Math.max(60, w.hub.w * z - 28)}px`;
    hub.classList.toggle("is-small", z < HUB_LINE_ZOOM);
    if (z >= BAY_ZOOM) w.hub.bays.forEach((b, i) => {
      const hold = m.bays[i];
      const owner = ctx.agentById(hold?.agent ?? null);
      const bay = div(`live-bay${hold?.holder ? " is-held" : ""}`);
      bay.style.width = `${Math.max(40, b.w * z - 16)}px`;
      bay.append(span("live-bay-name", `bay ${i + 1}`), span("live-bay-who", hold?.holder ? [owner ? ctx.nameOf(owner) : "", hold.holder].filter(Boolean).join(" · ") : "Free"));
      at(bay, b.x - b.w / 2 + 8, b.y - b.h / 2 + 5);
    });

    const leftJobs = world.jobs.filter((j) => j.kind === "left");
    left.hidden = !leftJobs.length;
    if (leftJobs.length) {
      const procs = leftJobs.reduce((n, j) => n + j.procs, 0);
      leftText.textContent = `Left behind: ${leftJobs.map((j) => j.label).join(", ")} · ${procs} ${plural(procs, "process", "processes")}`;
      const p = ctx.toScreen({ x: w.hub.x, y: w.hub.y + w.hub.h / 2 + 10 });
      left.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
    }

    const L = w.landmarks;
    const mins = s.cards.reduce((n, c) => n + (c.minutes ?? 1), 0);
    const mark = (cls: string, name: string, line: string, x: number, y: number) => {
      const el = div(`live-mark ${cls}`);
      el.append(span("live-mark-name", name), span("live-mark-line", line));
      at(el, x, y);
    };
    mark("is-tower", "GitHub", "pushes and releases", L.tower.x, L.tower.y + 14);
    mark("is-desk", "Inbox", s.cards.length ? `${s.cards.length} ${plural(s.cards.length, "card")}, about ${Math.max(1, Math.round(mins))} min` : "Nothing waits", L.desk.x, L.desk.y + 40);
    mark("is-board", "Board", `${(s.board?.ready ?? []).length} ready · ${(s.board?.now ?? []).length} in work`, L.board.x, L.board.y + 50);
    mark("is-web", "Web", "searches and pages", L.web.x, L.web.y + 50);
    fixed.replaceChildren(...out);

    // Agents: kept, so their move animates.
    const seen = new Set<string>();
    for (const a of world.agents) {
      const spot = w.dots.get(a.id);
      if (!spot || spot.swarm < 0) continue;
      seen.add(a.id);
      const n = agentNode(a);
      const p = ctx.toScreen(s.walks.get(a.id) ?? spot);
      n.el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
      n.el.className = `live-agent is-${a.state}`;
      n.el.setAttribute("aria-label", `${ctx.nameOf(a)}, ${STATE_WORD[a.state]}${a.now ? `: ${a.now.label}` : ""}`);
      const focus = s.hover === a.id || (s.selection?.kind === "agent" && s.selection.id === a.id);
      const urgent = a.state === "turn" || a.state === "stuck";
      n.tag.textContent = spot.swarm > 0 ? `${ctx.nameOf(a)} ×${spot.swarm + a.helpers}` : ctx.nameOf(a);
      n.tag.hidden = !(focus || urgent || z >= TAG_ZOOM);
      const said = s.bubbles.get(a.id) ?? (focus ? (a.now?.label ?? a.lastText ?? STATE_WORD[a.state]) : null);
      n.bubble.textContent = said ?? "";
      n.bubble.hidden = !said;
    }
    for (const [id, n] of nodes)
      if (!seen.has(id)) {
        n.el.remove();
        nodes.delete(id);
      }
  }

  return { paint };
}
