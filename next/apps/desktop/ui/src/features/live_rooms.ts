/**
 * The words over the rooms, at the layout's fixed spots: the sign, the Now and Last lines, the
 * station labels, the Quiet pills, and the letters and names on the dots. Copied from
 * `drawRoom` in the concept page, line 869. Bevy draws the boxes, pads, shelves and light.
 */

import type { Layout, RoomSpot } from "./live_layout";
import { STATIONS } from "./live_layout";
import { button, div, LETTER, OUTCOME_WORD, placeAt, span, STATE_RANK, STATE_WORD } from "./live_text";
import type { LiveAgent, LiveCtx, Station } from "./live_types";
import "./live_rooms.css";

const STATION_NAME: Record<Station, string> = { plan: "Plan", build: "Build", check: "Check", ship: "Ship" };

export function roomTag(key: string): string {
  if (key === "hq") return "Ops folder";
  if (key === "elsewhere" || key === "home") return "Outside projects";
  return "";
}

/** One short line for what an agent does now, as "Name: what it does". */
export function doing(a: LiveAgent): string {
  switch (a.state) {
    case "work":
      return a.now?.label ?? "Working";
    case "think":
      return a.steps[0] ? `Planning after ${a.steps[0].label}` : "Planning";
    case "turn":
      return a.lastText ?? "Wants to talk";
    case "stuck":
      return `Stuck on ${a.now?.label ?? "a step"}`;
    default:
      return "Idle";
  }
}

export function paintRooms(ctx: LiveCtx, l: Layout): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const r of l.rooms) out.push(sign(ctx, r));
  out.push(...quietRow(ctx, l));
  out.push(...dotWords(ctx, l));
  return out;
}

function sign(ctx: LiveCtx, r: RoomSpot): HTMLElement {
  const el = button("live-sign", "", () => ctx.select({ kind: "room", id: r.key }));
  el.setAttribute("aria-label", `${r.name} room`);
  placeAt(el, r.x, r.y, r.w, r.h);
  const head = div("live-sign-head");
  const tag = [roomTag(r.key), r.agents.length ? String(r.agents.length) : ""].filter(Boolean).join(" · ");
  head.append(span("live-room", r.name), span("live-room-tag", tag));
  el.append(head);
  const now = div("live-now");
  const ranked = [...r.agents].sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || a.id.localeCompare(b.id));
  if (!ranked.length) now.append(div("live-now-line is-empty", "Nobody here now"));
  for (const a of ranked.slice(0, 2)) {
    const line = div(`live-now-line is-${a.state}`);
    line.append(span("live-now-dot"), span("live-now-text", `${ctx.nameOf(a)}: ${doing(a)}`));
    now.append(line);
  }
  el.append(now);
  const last = r.embers[0];
  el.append(div("live-last", last ? `Last: ${last.result ?? `${last.name ?? "An agent"}, ${OUTCOME_WORD[last.outcome].toLowerCase()}`}` : "Last: nothing yet"));
  STATIONS.forEach((st, i) => {
    const label = span("live-station", STATION_NAME[st]);
    label.style.left = `${r.pads[i].x - r.x}px`;
    el.append(label);
  });
  return el;
}

function quietRow(ctx: LiveCtx, l: Layout): HTMLElement[] {
  if (!l.quiet.length) return [];
  const label = div("live-quiet-label", "Quiet");
  placeAt(label, l.pad + 2, l.quietY);
  const pills = l.quiet.map((q) => {
    const pill = button("live-pill", q.name, () => (q.key ? ctx.select({ kind: "room", id: q.key }) : undefined));
    if (!q.key) pill.classList.add("is-more");
    placeAt(pill, q.x, q.y, q.w, q.h);
    return pill;
  });
  return [label, ...pills];
}

function dotWords(ctx: LiveCtx, l: Layout): HTMLElement[] {
  const out: HTMLElement[] = [];
  const sel = ctx.s.selection;
  const waitingIn = new Map<string, number>();
  for (const r of l.rooms) waitingIn.set(r.key, r.agents.filter((a) => a.state === "turn").length);
  for (const a of ctx.s.world!.agents) {
    const d = l.dots.get(a.id);
    if (!d) continue;
    const isSel = sel?.kind === "agent" && sel.id === a.id;
    const size = Math.max(26, d.r * 2 + 8);
    const hit = button(`live-hit${isSel ? " is-on" : ""}`, "", () => ctx.select({ kind: "agent", id: a.id }));
    hit.dataset.agent = a.id;
    hit.style.width = hit.style.height = `${size}px`;
    placeAt(hit, d.x - size / 2, d.y - size / 2);
    hit.setAttribute("aria-label", `${ctx.nameOf(a)}, ${STATE_WORD[a.state]}`);
    if (d.r >= 7) {
      const letter = span("live-letter", LETTER[a.harness]);
      letter.style.fontSize = `${Math.round(d.r * 1.15)}px`;
      hit.append(letter);
    }
    out.push(hit);
    if (isSel || ctx.s.hover === a.id || a.state === "stuck" || (a.state === "turn" && waitingIn.get(d.room) === 1)) {
      const tag = div(`live-tag is-${a.state}`, ctx.nameOf(a));
      tag.dataset.agent = a.id;
      placeAt(tag, d.x, d.y + d.r + 4);
      out.push(tag);
    }
  }
  for (const [id, at] of l.embers) {
    const e = ctx.s.world!.embers.find((x) => x.id === id);
    if (!e) continue;
    const hit = button("live-ember-hit", "", () => ctx.select({ kind: "ember", id }));
    placeAt(hit, at.x - 7, at.y - 7);
    hit.setAttribute("aria-label", `${e.name ?? "An agent"}'s report`);
    out.push(hit);
  }
  return out;
}
