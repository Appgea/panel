import type { BoardIssue } from "./live_cards";
import { appName, cap, HARNESS, helperRole, lensName, short, taskLine, unitClass, withoutRoom } from "./live_text";
import type { LiveAgent, Step } from "./live_types";

export type Role = "commander" | "builder" | "scout" | "checker" | "chief" | "session" | "run" | "helper";

export const ROLE: Record<Role, { name: string; what: string }> = {
  commander: { name: "Commander", what: "The lead session you steer the fleet through." },
  builder: { name: "Builder", what: "A fleet unit that builds one shaped issue from the queue." },
  scout: { name: "Scout", what: "A fleet unit that looks at one app through one lens. It files up to 3 findings and builds nothing." },
  checker: { name: "Checker", what: "A fleet unit that reads each finding's premise in the code. It closes the untrue ones and shapes the rest into briefs." },
  chief: { name: "Board chief", what: "Keeps the board in order." },
  session: { name: "Session", what: "A terminal session you opened." },
  run: { name: "Background run", what: "A headless run with no terminal." },
  helper: { name: "Helper", what: "A subagent of the session above it." },
};

export const GROUPS: [string, string][] = [
  ["games", "Games"],
  ["apps", "Apps"],
  ["channels", "Channels"],
  ["tools", "Tools"],
  ["hq", "HQ"],
];

export function roleOf(a: LiveAgent): Role {
  if (a.commander) return "commander";
  if (a.fleet) return a.fleet.role ?? (a.fleet.scout ? "scout" : "builder");
  if (a.helperKind || a.parent) return "helper";
  if (a.name === "Mahmut Hoca") return "chief";
  return a.headless ? "run" : "session";
}

export function roleName(a: LiveAgent): string {
  const r = roleOf(a);
  return r === "helper" && a.helperKind ? helperRole(a.helperKind) : ROLE[r].name;
}

export function kindOf(a: LiveAgent): { name: string; colour: string } {
  if (a.fleet) return unitClass(a.fleet.kind);
  const model = short(a.model);
  const family = model.split(" ")[0].toLowerCase();
  return { name: model || HARNESS[a.harness], colour: unitClass(family).colour };
}

export type Work = { title: string; number: number | null; chip: string; question: string };

export function workOf(a: LiveAgent, iss: BoardIssue | undefined, room: string): Work {
  const f = a.fleet;
  if (f?.scout) {
    const app = f.scout.split("@")[1] ?? "";
    const lens = lensName(f.scout);
    const ability = f.ability ? cap(f.ability.replace(/-/g, " ")) : "";
    return { title: ability || `${lens} lens${app ? ` on ${appName(app)}` : ""}`, number: null, chip: lens, question: f.question ?? "" };
  }
  const first = f?.issues[0];
  if (first) {
    const more = f.issues.length > 1 ? ` +${f.issues.length - 1}` : "";
    return { title: `${cap(withoutRoom(first.title, room))}${more}`, number: first.number, chip: iss?.work ?? "", question: "" };
  }
  if (iss) return { title: cap(withoutRoom(iss.title, room)), number: iss.number, chip: iss.work ?? "", question: "" };
  const task = taskLine(a.task);
  const none = f ? "Looking for work" : a.name === "Mahmut Hoca" ? "Watches the board" : "No task named";
  return { title: task ?? a.lastText ?? none, number: null, chip: "", question: "" };
}

export type Phase = "plan" | "build" | "check" | "ship";
export const PHASES: Phase[] = ["plan", "build", "check", "ship"];
export const PHASE_WORD: Record<Phase, string> = { plan: "Plan", build: "Build", check: "Check", ship: "Ship" };

const PHASE_OF: Record<string, Phase> = {
  edit: "build",
  build: "build",
  render: "build",
  test: "check",
  typecheck: "check",
  review: "check",
  shot: "check",
  "git.commit": "ship",
  "git.push": "ship",
  release: "ship",
};

export function phaseOfStep(st: Step): Phase | null {
  return (st.verb && PHASE_OF[st.verb]) || null;
}

export function phaseOf(a: LiveAgent): Phase {
  for (const st of [...(a.now ? [a.now] : []), ...a.steps]) {
    const p = phaseOfStep(st);
    if (p) return p;
  }
  return "plan";
}
