/**
 * The bar over the stage: an on-air dot, the narrator line, the colour legend, and the toast.
 * Copied from the concept page: the bar and legend markup at line 192, `narr()` at line 1286,
 * and `.toast` in its CSS.
 */

import { queueLine } from "./live_cards";
import { plural } from "./live_text";
import type { LiveCtx } from "./live_types";
import "./live_top.css";

const TOAST_MS = 3000;
const LEGEND: [string, string][] = [
  ["var(--l-work)", "Working"],
  ["var(--l-think)", "Planning"],
  ["var(--l-turn)", "Wants to talk"],
  ["var(--l-idle)", "Idle"],
  ["var(--l-stuck)", "Stuck"],
  ["var(--l-done)", "Done, then an ember"],
];

export const TOP_HTML = `
  <header class="live-bar">
    <span class="live-onair" aria-hidden="true"></span>
    <span class="live-narr" data-narr>Looking for agents</span>
  </header>
  <div class="live-legend" aria-label="What the colours mean">
    ${LEGEND.map(([c, w]) => `<span><i style="--c:${c}"></i>${w}</span>`).join("")}
  </div>`;

export type Top = { paint(): void; toast(text: string, bad?: boolean): void; say(text: string): void };

export function mountTop(ctx: LiveCtx, root: HTMLElement, toastEl: HTMLElement): Top {
  const narr = root.querySelector<HTMLElement>("[data-narr]")!;
  let timer = 0;

  /** One plain sentence about the building, from rules. */
  function paint(): void {
    const w = ctx.s.world;
    if (!w) return;
    const agents = w.agents;
    if (!agents.length) {
      narr.textContent = `No agent is running on this Mac. ${ctx.s.cards.length ? queueLine(ctx.s.cards) : "Nothing needs you."}`;
      return;
    }
    const working = agents.filter((a) => a.state === "work" || a.state === "think");
    const rooms = new Map<string, number>();
    for (const a of working) rooms.set(ctx.roomOf(a), (rooms.get(ctx.roomOf(a)) ?? 0) + 1);
    const busiest = [...rooms.entries()].sort((a, b) => b[1] - a[1])[0];
    const parts: string[] = [];
    if (!working.length) parts.push(`${agents.length} ${plural(agents.length, "agent")}, none working.`);
    else if (rooms.size === 1 && busiest) parts.push(`${busiest[1]} ${plural(busiest[1], "agent")} working in ${ctx.roomName(busiest[0])}.`);
    else parts.push(`${working.length} agents working in ${rooms.size} rooms.`);
    const stuck = agents.filter((a) => a.state === "stuck").length;
    if (stuck) parts.push(`${stuck} stuck.`);
    const cards = ctx.s.cards;
    if (cards.length) {
      const minutes = Math.max(1, Math.round(cards.reduce((n, c) => n + c.minutes, 0)));
      parts.push(`${cards.length} ${plural(cards.length, "card")} for you, about ${minutes} min.`);
    } else parts.push("Nothing needs you.");
    if (w.mac.hot) parts.push("This Mac is hot.");
    narr.textContent = parts.join(" ");
  }

  function toast(text: string, bad = false): void {
    toastEl.textContent = text;
    toastEl.classList.toggle("is-bad", bad);
    toastEl.hidden = !text;
    window.clearTimeout(timer);
    if (text) timer = window.setTimeout(() => (toastEl.hidden = true), TOAST_MS);
  }

  function say(text: string): void {
    narr.textContent = text;
  }

  return { paint, toast, say };
}
