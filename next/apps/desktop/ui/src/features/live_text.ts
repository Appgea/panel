/** Live's words: names, times and counts, and the small DOM makers every Live file shares. */

import type { EmberOutcome, Harness, LiveAgent, State } from "./live_types";

export const HARNESS: Record<Harness, string> = { claude: "Claude", codex: "Codex", grok: "Grok", opencode: "OpenCode", gemini: "Gemini", kimi: "Kimi" };
export const LETTER: Record<Harness, string> = { claude: "C", codex: "X", grok: "G", opencode: "O", gemini: "M", kimi: "K" };
export const STATE_WORD: Record<State, string> = { work: "Working", think: "Planning", turn: "Wants to talk", idle: "Idle", stuck: "Stuck" };
export const STATE_RANK: Record<State, number> = { turn: 0, stuck: 1, work: 2, think: 3, idle: 4 };

export function short(model: string | null): string {
  if (!model) return "";
  const m = model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
  const parts = m.split("-");
  if (/^(opus|sonnet|haiku|fable)$/.test(parts[0])) return `${cap(parts[0])} ${parts.slice(1).join(".")}`.trim();
  return m.replace(/^gpt-[\d.]+-/, "").replace(/^./, (c) => c.toUpperCase());
}

export const OUTCOME_WORD: Record<EmberOutcome, string> = { done: "Done", failed: "Failed", stopped: "Stopped", crashed: "Crashed", stuck: "Stuck" };
export const OUTCOME_COLOUR: Record<EmberOutcome, string> = { done: "var(--l-done)", failed: "var(--l-stuck)", crashed: "var(--l-stuck)", stopped: "var(--l-idle)", stuck: "var(--l-turn)" };

/**
 * Claude's own session names, like `cardly-e7` or `cmd-style-drift-80`: a slug and a short hex
 * tail. They say nothing about the agent, so Live never shows them.
 */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{2,4}$/;

/**
 * What kind of agent a headless run is, read from its first prompt. First match wins, and `$1`
 * is the first group. Add a line when a new kind of background run shows up as "Background run".
 */
const PROMPT_ROLES: [RegExp, string][] = [
  [/^You review a diff before it is pushed/i, "Pre-push reviewer"],
  [/^You write one animation script/i, "Animation writer"],
  [/^You are Terra worker (\S+)/i, "Builder · $1"],
];

/** What `who` reads. Agents and embers both have these. */
export type WhoInput = { name: string | null; harness: Harness; headless: boolean; task: string | null; via: string | null; model: string | null };

/**
 * Who an agent is, for a person who did not start it. `title` is the name to show: the folk name
 * of a session someone types into (the name on its terminal tab), else its role. `sub` says the
 * rest: the role or the folk name, and the model. `parent` is the name of the agent that started it.
 */
export function who(a: WhoInput, parent: string | null = null): { title: string; sub: string; role: string } {
  const task = (a.task ?? "").trim();
  let role = "";
  for (const [re, r] of PROMPT_ROLES) {
    const m = task.match(re);
    if (m) {
      role = r.replace("$1", m[1] ?? "").trim();
      break;
    }
  }
  if (!role) {
    if (a.name === "Mahmut Hoca") role = "Board chief";
    else if (/board\.py review/.test(a.via ?? "")) role = "Board reviewer";
    else if (/board\.py|launch\.py|fleet/.test(a.via ?? "")) role = "Board worker";
    else if (parent) role = `Helper of ${parent}`;
    else if (a.via === "Codex app") role = "Codex app";
    else role = a.headless ? "Background run" : "Terminal session";
  }
  const folk = a.name && !SLUG.test(a.name) ? a.name : null;
  const model = [HARNESS[a.harness], short(a.model)].filter(Boolean).join(" ");
  if (folk && !a.headless) return { title: folk, sub: `${role} · ${model}`, role };
  return { title: role, sub: [folk, model].filter(Boolean).join(" · "), role };
}

/** A first prompt that only names the agent's kind is no news once `who` has said the kind. */
export function taskLine(task: string | null): string | null {
  const t = task?.trim();
  if (!t || PROMPT_ROLES.some(([re]) => re.test(t))) return null;
  return t;
}

/** Board titles start with their app, "Tavla: …". The row already names the room. */
export function withoutRoom(title: string, room: string): string {
  return title.toLowerCase().startsWith(`${room.toLowerCase()}: `) ? title.slice(room.length + 2) : title;
}

/** What an agent is doing, in one line. */
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

export function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

export function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function since(ms: number, now: number): string {
  const min = Math.max(1, Math.round((now - ms) / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}

export function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  return `${since(ms, now)} ago`;
}

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** Wall-clock time as HH:MM. */
export function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function div(cls: string, text = ""): HTMLElement {
  const el = document.createElement("div");
  el.className = cls;
  if (text) el.textContent = text;
  return el;
}

export function span(cls: string, text = ""): HTMLElement {
  const el = document.createElement("span");
  if (cls) el.className = cls;
  if (text) el.textContent = text;
  return el;
}

export function button(cls: string, text: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = cls;
  if (text) el.textContent = text;
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return el;
}

const HOLD_MS = 900;

/**
 * Stop needs a one-second hold, so a slip never kills an agent. A view holding one skips its
 * repaint while `.is-holding` is on the page, so the poll never drops a real hold.
 */
export function holdButton(label: string, fire: () => void): HTMLButtonElement {
  const b = button("opt live-hold is-danger", label, () => undefined);
  let t: number | null = null;
  const cancel = () => {
    if (t !== null) window.clearTimeout(t);
    t = null;
    b.classList.remove("is-holding");
  };
  b.addEventListener("pointerdown", () => {
    b.classList.add("is-holding");
    t = window.setTimeout(() => {
      // A repaint that swapped the button out mid-hold took its pointerup with it: no fire.
      const held = b.isConnected && b.classList.contains("is-holding");
      cancel();
      if (held) fire();
    }, HOLD_MS);
  });
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) b.addEventListener(ev, cancel);
  return b;
}
