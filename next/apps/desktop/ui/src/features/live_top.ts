/**
 * The bar over the map: an on-air dot, the day's score (live_hud.ts fills it), the narrator line,
 * the processes no agent owns any more, and the toast. Copied from the concept page: the bar markup at line 192, `narr()` at line 1286,
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

// What runs leads, since Live is about activity. The day's score sits on the right as one block.
export const TOP_HTML = `
  <header class="live-bar">
    <span class="live-onair" aria-hidden="true"></span>
    <span class="live-narr" data-narr>Looking for agents</span>
    <span class="live-left" data-left hidden></span>
    <div class="hud" data-hud hidden></div>
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

  let narrSig = "";

  function paint(): void {
    if (!ctx.s.world) return;
    paintLeft();
    const p = parts(ctx);
    const sig = JSON.stringify(p);
    // say() writes over the line, so a changed sentence or a said one repaints it.
    if (sig === narrSig && narr.querySelector(".narr-count")) return;
    narrSig = sig;
    const head = [span("narr-n narr-count", p.head[0]), span("narr-rest", p.head[1])];
    const states = p.states.map(([n, word, state]) => {
      const el = span(`narr-st is-${state}`);
      el.append(span("narr-n", String(n)), document.createTextNode(` ${word}`));
      return el;
    });
    const box = span("narr-states");
    box.append(...states, ...(p.hot ? [span("narr-st is-stuck", "This Mac is hot")] : []));
    narr.replaceChildren(...head, box);
    narr.title = line(ctx);
  }

  function paintLeft(): void {
    const jobs = (ctx.s.world?.jobs ?? []).filter((j) => j.kind === "left");
    left.hidden = !jobs.length;
    if (!jobs.length || left.querySelector(".is-holding")) return;
    const procs = jobs.reduce((n, j) => n + j.procs, 0);
    const names = [...new Set(jobs.map((j) => j.label))];
    leftText.textContent = `${procs} ${plural(procs, "process", "processes")} left behind`;
    left.title = `Ended agents left these running, and nothing uses them any more: ${names.join(", ")}. Hold the button to stop them.`;
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
  const p = parts(ctx);
  if (!p.states.length) return `${p.head.join("")}.${p.hot ? " This Mac is hot." : ""}`;
  return `${p.head.join("")}: ${p.states.map(([k, word]) => `${k} ${word}`).join(", ")}.${p.hot ? " This Mac is hot." : ""}`;
}

type Parts = { head: [string, string]; states: [number, string, string][]; hot: boolean };

/** The sentence in pieces: the bar shows the count big and each state in its own colour. */
function parts(ctx: LiveCtx): Parts {
  const w = ctx.s.world!;
  const ids = new Set(w.agents.map((a) => a.id));
  const agents = w.agents.filter((a) => !a.parent || !ids.has(a.parent));
  const helpers = w.agents.length - agents.length;
  if (!agents.length) return { head: ["No agent", " is running on this Mac"], states: [], hot: w.mac.hot };
  const n = (state: string[]) => agents.filter((a) => state.includes(a.state)).length;
  const projects = new Set(agents.map((a) => ctx.roomOf(a))).size;
  const states = [
    [n(["turn"]), "waits for you", "wait for you", "turn"],
    [n(["stuck"]), "stuck", "stuck", "stuck"],
    [n(["work", "think"]), "working", "working", "work"],
    [n(["idle"]), "idle", "idle", "idle"],
  ] as const;
  const kids = helpers ? `, with ${helpers} ${plural(helpers, "helper")}` : "";
  return {
    head: [`${agents.length} ${plural(agents.length, "agent")}`, ` in ${projects} ${plural(projects, "project")}${kids}`],
    states: states.filter(([k]) => k).map(([k, one, many, state]) => [k, k === 1 ? one : many, state]),
    hot: w.mac.hot,
  };
}
