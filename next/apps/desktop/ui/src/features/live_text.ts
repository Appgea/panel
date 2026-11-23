
import type { EmberOutcome, FleetTag, Harness, LiveAgent, State } from "./live_types";

export const HARNESS: Record<Harness, string> = { claude: "Claude", codex: "Codex", grok: "Grok", opencode: "OpenCode", gemini: "Gemini", kimi: "Kimi" };
export const LETTER: Record<Harness, string> = { claude: "C", codex: "X", grok: "G", opencode: "O", gemini: "M", kimi: "K" };
export const STATE_WORD: Record<State, string> = { work: "Working", think: "Thinking", turn: "Waits for you", idle: "Idle", stuck: "Stuck" };
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

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{2,4}$/;

const PROMPT_ROLES: [RegExp, string][] = [
  [/^You review a diff before it is pushed/i, "Pre-push reviewer"],
  [/^You write one animation script/i, "Animation writer"],
  [/^You are Terra worker (\S+)/i, "Builder · $1"],
  [/^You are fleet builder (\S+)/i, "Fleet builder · $1"],
  [/^You are fleet scout (\S+)/i, "Fleet scout · $1"],
];

export type WhoInput = { name: string | null; harness: Harness; headless: boolean; task: string | null; via: string | null; model: string | null; helperKind?: string | null; fleet?: FleetTag | null };

export type UnitClass = { name: string; colour: string };

const CLASSES: Record<string, UnitClass> = {
  terra: { name: "Terra", colour: "var(--l-terra)" },
  flash: { name: "Flash", colour: "var(--l-flash)" },
  sonnet: { name: "Sonnet", colour: "var(--l-sonnet)" },
  haiku: { name: "Haiku", colour: "var(--l-sonnet)" },
  opus: { name: "Opus", colour: "var(--l-opus)" },
  fable: { name: "Fable", colour: "var(--l-opus)" },
};

export function unitClass(kind: string): UnitClass {
  return CLASSES[kind] ?? { name: cap(kind || "unit"), colour: "var(--l-ink-2)" };
}

export function unitName(kind: string, id: string): string {
  return `${unitClass(kind).name} ${id}`;
}

export function lensName(scout: string): string {
  const lens = scout.split("@")[0].replace(/[-_]+/g, " ").trim();
  return cap(lens.replace(/\bui\b/gi, "UI").replace(/\bux\b/gi, "UX"));
}

function unitWho(f: FleetTag, harness: Harness, model: string | null): { title: string; sub: string; role: string } {
  const m = f.issues[0];
  const role = f.scout ? "Fleet scout" : "Fleet builder";
  const title = m ? `#${m.number} ${cap(m.title)}${f.issues.length > 1 ? ` +${f.issues.length - 1}` : ""}` : f.scout ? `${lensName(f.scout)} scout` : unitName(f.kind, f.unit);
  const engine = [HARNESS[harness], short(model)].filter(Boolean).join(" ");
  return { title, sub: [`${unitName(f.kind, f.unit)}`, engine].filter(Boolean).join(" · "), role };
}

export function millions(t: string | undefined): number {
  const m = /^([\d.]+)\s*([KMG]?)/i.exec(t ?? "");
  if (!m) return 0;
  const n = parseFloat(m[1]) || 0;
  return m[2].toUpperCase() === "K" ? n / 1000 : m[2].toUpperCase() === "G" ? n * 1000 : n;
}

export function helperRole(kind: string): string {
  return /^(general-purpose|helper|fork)$/i.test(kind) ? "Helper" : `${cap(kind.replace(/[-_]/g, " "))} helper`;
}

export function who(a: WhoInput, parent: string | null = null): { title: string; sub: string; role: string } {
  const task = (a.task ?? "").trim();
  if (a.fleet) return unitWho(a.fleet, a.harness, a.model);
  if (a.helperKind) {
    const role = helperRole(a.helperKind);
    const model = [HARNESS[a.harness], short(a.model)].filter(Boolean).join(" ");
    return { title: parent ? `${role} of ${parent}` : role, sub: model, role };
  }
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

export function taskLine(task: string | null): string | null {
  const t = task?.trim();
  if (!t || PROMPT_ROLES.some(([re]) => re.test(t))) return null;
  return humane(t);
}

export function withoutRoom(title: string, room: string): string {
  return title.toLowerCase().startsWith(`${room.toLowerCase()}: `) ? title.slice(room.length + 2) : title;
}

export function appName(key: string): string {
  return /[_-]/.test(key) || key === key.toLowerCase() ? key.split(/[_-]+/).filter(Boolean).map(cap).join(" ") : key;
}

export function humane(text: string): string {
  return text.replace(/\b([a-z][a-z0-9-]*)@([A-Za-z][\w-]*)/g, (_, lens: string, app: string) => `${lensName(lens)} (${appName(app)})`);
}

export function doing(a: LiveAgent): string {
  return humane(doingRaw(a));
}

function doingRaw(a: LiveAgent): string {
  switch (a.state) {
    case "work":
      return a.now?.label ?? a.lastText ?? (a.steps[0] ? `${a.steps[0].label} · working` : a.startedMs && Date.now() - a.startedMs < 120_000 ? "Starting up" : "Working. Panel cannot read its steps");
    case "think":
      return a.steps[0] ? `${a.steps[0].label} · thinking` : (a.lastText ?? "Thinking");
    case "turn":
      return a.lastText ?? "Waits for your answer";
    case "stuck":
      return `No output for ${since(a.stateMs ?? a.now?.atMs ?? Date.now(), Date.now())} on ${lower(a.now?.label ?? "its step")}`;
    default:
      return a.lastText ?? (a.steps[0] ? `Last: ${lower(a.steps[0].label)}` : "Idle");
  }
}

const LONG_STEP_MS = 3 * 60_000;

export function ageOf(a: LiveAgent, now: number): string {
  if (a.state === "turn" && a.stateMs) return since(a.stateMs, now);
  if (a.state === "work" && a.now && now - a.now.atMs > LONG_STEP_MS) return since(a.now.atMs, now);
  return "";
}

export function startedBy(via: string | null): string {
  if (!via) return "Not known";
  if (via === "Terminal") return "You, in Terminal";
  if (/board\.py|launch\.py|fleet/.test(via)) return "The board";
  return via;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

function lower(s: string): string {
  return /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
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
      const held = b.isConnected && b.classList.contains("is-holding");
      cancel();
      if (held) fire();
    }, HOLD_MS);
  });
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) b.addEventListener(ev, cancel);
  return b;
}
