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
    holdButton("Hold to clean up", () => {
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

  function paint(): void {
    if (!ctx.s.world) return;
    paintLeft();
    narr.textContent = line(ctx);
  }

  function paintLeft(): void {
    const jobs = (ctx.s.world?.jobs ?? []).filter((j) => j.kind === "left");
    left.hidden = !jobs.length;
    if (!jobs.length || left.querySelector(".is-holding")) return;
    const procs = jobs.reduce((n, j) => n + j.procs, 0);
    const names = [...new Set(jobs.map((j) => j.label))];
    leftText.textContent = `${procs} ${plural(procs, "process", "processes")} left by ended agents: ${names.slice(0, 2).join(", ")}${names.length > 2 ? ` and ${names.length - 2} more` : ""}`;
    leftText.title = `Nothing uses these any more. Cleaning up stops them: ${names.join(", ")}`;
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

/**
 * One plain sentence about what runs. An agent is a session someone or the board started. A
 * helper rides on the agent that started it and is counted apart, so this line, the list's head
 * and each plot's sign add up to the same numbers. What needs the owner comes first.
 */
export function line(ctx: LiveCtx): string {
  const w = ctx.s.world!;
  const ids = new Set(w.agents.map((a) => a.id));
  const agents = w.agents.filter((a) => !a.parent || !ids.has(a.parent));
  const helpers = w.agents.length - agents.length;
  if (!agents.length) return `No agent is running on this Mac.${w.mac.hot ? " This Mac is hot." : ""}`;
  const n = (state: string[]) => agents.filter((a) => state.includes(a.state)).length;
  const projects = new Set(agents.map((a) => ctx.roomOf(a))).size;
  const states = [
    [n(["turn"]), "waits for you", "wait for you"],
    [n(["stuck"]), "stuck", "stuck"],
    [n(["work", "think"]), "working", "working"],
    [n(["idle"]), "idle", "idle"],
  ] as const;
  const parts = states.filter(([k]) => k).map(([k, one, many]) => `${k} ${k === 1 ? one : many}`);
  const head = `${agents.length} ${plural(agents.length, "agent")} in ${projects} ${plural(projects, "project")}`;
  const kids = helpers ? `, with ${helpers} ${plural(helpers, "helper")}` : "";
  return `${head}${kids}: ${parts.join(", ")}.${w.mac.hot ? " This Mac is hot." : ""}`;
}
