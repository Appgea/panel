import { errorText } from "../errors";
import { roleName } from "./live_roles";
import { holdButton, plural, span } from "./live_text";
import type { LiveCtx } from "./live_types";
import "./live_top.css";

const TOAST_MS = 3000;

export const TOP_HTML = `
  <header class="live-bar">
    <span class="live-onair" aria-hidden="true"></span>
    <span class="live-narr" data-narr>Looking for agents</span>
    <span class="live-left" data-left hidden></span>
    <div class="live-mac" data-mac aria-label="This Mac"></div>
  </header>`;

export type Top = { paint(): void; toast(text: string, bad?: boolean): void; say(text: string): void };

export function mountTop(ctx: LiveCtx, root: HTMLElement, toastEl: HTMLElement): Top {
  const narr = root.querySelector<HTMLElement>("[data-narr]")!;
  const left = root.querySelector<HTMLElement>("[data-left]")!;
  const mac = root.querySelector<HTMLElement>("[data-mac]")!;
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
  let macSig = "";

  function paint(): void {
    if (!ctx.s.world) return;
    paintLeft();
    paintMac();
    const p = parts(ctx);
    const sig = JSON.stringify(p);
    if (sig === narrSig && narr.querySelector(".narr-count")) return;
    narrSig = sig;
    const head = [span("narr-n narr-count", p.head[0]), span("narr-rest", p.head[1])];
    const states = p.states.map(([n, word, state]) => {
      const el = span(`narr-st is-${state}`);
      el.append(span("narr-n", String(n)), document.createTextNode(` ${word}`));
      return el;
    });
    const box = span("narr-states");
    box.append(...states);
    narr.replaceChildren(...head, box);
  }

  function paintMac(): void {
    const w = ctx.s.world!;
    const slots = w.mac.bays.map((b, i) => {
      const a = ctx.agentById(b.agent);
      const by = a ? `${roleName(a)} in ${ctx.roomName(ctx.roomOf(a))}` : "";
      return { n: i + 1, holder: b.holder ?? "", by };
    });
    const quota = (w.mac.quota ?? []).map((x) => ({ name: x.harness, used: Math.round(x.used) }));
    const load = w.mac.cores ? Math.round(w.mac.load / w.mac.cores) : 0;
    const sig = JSON.stringify([slots, quota, w.mac.hot, Math.round(load / 10)]);
    if (sig === macSig) return;
    macSig = sig;
    const out: HTMLElement[] = [span("mac-label", "Build and test")];
    for (const sl of slots) {
      const el = span(`mac-slot${sl.holder ? " is-held" : ""}`);
      el.append(span("mac-dot"), span("mac-what", sl.holder || "free"));
      el.title = sl.holder ? `Slot ${sl.n}: ${sl.holder}${sl.by ? `, run by the ${sl.by}` : ""}` : `Slot ${sl.n} is free. Builds and tests run two at a time.`;
      if (sl.by) el.append(span("mac-by", sl.by));
      out.push(el);
    }
    const heat = span(`mac-heat${w.mac.hot ? " is-hot" : ""}`, w.mac.hot ? "This Mac is hot" : `CPU ${Math.min(load, 100)}%`);
    out.push(heat);
    for (const x of quota) {
      const m = span(`mac-meter${x.used >= 90 ? " is-high" : ""}`);
      const bar = span("mac-bar");
      bar.style.setProperty("--p", `${Math.min(100, x.used)}%`);
      m.append(span("mac-label", `${x.name} week`), bar, span("mac-n", `${x.used}%`));
      m.title = `${x.used}% of this week's ${x.name} quota is used.`;
      out.push(m);
    }
    mac.replaceChildren(...out);
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

type Parts = { head: [string, string]; states: [number, string, string][] };

function parts(ctx: LiveCtx): Parts {
  const w = ctx.s.world!;
  const ids = new Set(w.agents.map((a) => a.id));
  const agents = w.agents.filter((a) => !a.parent || !ids.has(a.parent));
  const helpers = w.agents.length - agents.length;
  if (!agents.length) return { head: ["No agent", " is running on this Mac"], states: [] };
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
  };
}
