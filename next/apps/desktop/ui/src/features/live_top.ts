/**
 * The bar over the map: an on-air dot, the narrator line, the processes no agent owns any more,
 * and the toast. Copied from the concept page: the bar markup at line 192, `narr()` at line 1286,
 * and `.toast` in its CSS. No colour legend: every agent's words say what it does.
 *
 * The left-behind processes sat under This Mac on the map, where their long line ran into the
 * landmarks. The bar has the room, and a Stop button is no part of the map.
 */

import { errorText } from "../errors";
import { holdButton, plural, span } from "./live_text";
import type { LiveCtx } from "./live_types";
import "./live_top.css";

const TOAST_MS = 3000;

export const TOP_HTML = `
  <header class="live-bar">
    <span class="live-onair" aria-hidden="true"></span>
    <span class="live-narr" data-narr>Looking for agents</span>
    <span class="live-left" data-left hidden></span>
  </header>`;

export type Top = { paint(): void; toast(text: string, bad?: boolean): void; say(text: string): void };

export function mountTop(ctx: LiveCtx, root: HTMLElement, toastEl: HTMLElement): Top {
  const narr = root.querySelector<HTMLElement>("[data-narr]")!;
  const left = root.querySelector<HTMLElement>("[data-left]")!;
  // Kept, not rebuilt, so a hold on Stop survives the repaints a running script makes.
  const leftText = span("live-left-text");
  left.append(
    leftText,
    holdButton("Hold to Stop", () => {
      for (const j of (ctx.s.world?.jobs ?? []).filter((x) => x.kind === "left")) void stop(j.pid, j.label);
    }),
  );
  let timer = 0;

  async function stop(pid: number, who: string): Promise<void> {
    try {
      await ctx.events.stop(pid);
      toast(`Asked ${who} to stop.`);
      ctx.poll();
    } catch (e) {
      toast(`Could not stop ${who}: ${errorText(e, "refused")}`, true);
    }
  }

  /** One plain sentence about what runs, from rules. */
  function paint(): void {
    const w = ctx.s.world;
    if (!w) return;
    paintLeft();
    const agents = w.agents;
    if (!agents.length) {
      narr.textContent = `No agent is running on this Mac.${w.mac.hot ? " This Mac is hot." : ""}`;
      return;
    }
    const working = agents.filter((a) => a.state === "work" || a.state === "think");
    const rooms = new Map<string, number>();
    for (const a of working) rooms.set(ctx.roomOf(a), (rooms.get(ctx.roomOf(a)) ?? 0) + 1);
    const busiest = [...rooms.entries()].sort((a, b) => b[1] - a[1])[0];
    const parts: string[] = [];
    if (!working.length) parts.push(`${agents.length} ${plural(agents.length, "agent")}, none working.`);
    else if (rooms.size === 1 && busiest) parts.push(`${busiest[1]} ${plural(busiest[1], "agent")} working in ${ctx.roomName(busiest[0])}.`);
    else parts.push(`${working.length} agents working in ${rooms.size} projects.`);
    const waiting = agents.filter((a) => a.state === "turn").length;
    if (waiting) parts.push(`${waiting} ${waiting === 1 ? "waits" : "wait"} for you.`);
    const stuck = agents.filter((a) => a.state === "stuck").length;
    if (stuck) parts.push(`${stuck} stuck.`);
    if (w.mac.hot) parts.push("This Mac is hot.");
    narr.textContent = parts.join(" ");
  }

  function paintLeft(): void {
    const jobs = (ctx.s.world?.jobs ?? []).filter((j) => j.kind === "left");
    left.hidden = !jobs.length;
    if (!jobs.length || left.querySelector(".is-holding")) return;
    const procs = jobs.reduce((n, j) => n + j.procs, 0);
    const names = [...new Set(jobs.map((j) => j.label))];
    leftText.textContent = `Left behind: ${names.slice(0, 2).join(", ")}${names.length > 2 ? ` and ${names.length - 2} more` : ""} · ${procs} ${plural(procs, "process", "processes")}`;
    leftText.title = names.join(", ");
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
