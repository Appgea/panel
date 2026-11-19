/**
 * The crew's talk: what one agent sends another, read from the steps they take. Owner,
 * 2026-11-19: "when I say gamify, it is not only for the XP and levels. So I see dots
 * communicating, collaborating, doing things in the project."
 *
 * Every talk comes from a real step, never from a timer, so what the map shows happened:
 *   - order: an agent sends a message to agents its words name, or to its helpers. The commander
 *     sends one to each unit the fleet starts.
 *   - look: the commander reads or checks a unit its words name: "Peek at the over-budget scout".
 *   - report: the commander reads the fleet's news, and each unit it names, or else each unit
 *     that took a step since its last look, sends its report. A
 *     helper's or a unit's test, build or push that ends reports to whom it answers to.
 *   - handoff: an agent reads a file another running agent wrote. The file goes from one to the other.
 *
 * live.ts flies each talk as its glyph along the clear way between the two dots. A talk between a
 * helper and the agent it rides on has no way to fly: Bevy flashes it on the helper's orbit
 * instead (live_scene.ts `pings`).
 */

import { COLOR, GLYPHS } from "./live_script";
import type { LiveAgent } from "./live_types";

export type TalkKind = "order" | "look" | "report" | "handoff";
/** `tag` is a few words that land with it, like a file's name. `delay` staggers a round of reports. */
export type Talk = { kind: TalkKind; from: string; to: string; tag?: string; delay?: number };

export const TALK: Record<TalkKind, { glyph: string; color: string; ms: number }> = {
  order: { glyph: GLYPHS.chat, color: COLOR.think, ms: 1500 },
  look: { glyph: GLYPHS.eye, color: COLOR.ink, ms: 1300 },
  report: { glyph: GLYPHS.list, color: COLOR.work, ms: 1500 },
  handoff: { glyph: GLYPHS.file, color: COLOR.work, ms: 1700 },
};

/** The steps that read what someone else wrote. */
const READS = new Set(["read", "search", "review", "test", "typecheck"]);
/** The commander's steps that look at something, rather than change it. */
const LOOKS = new Set(["read", "search", "board", "web", "cmd", "cmd.fleet"]);
/** A commander's words about the fleet's news: its reports come in. */
const NEWS = /\b(fleet|news|reports?|squad|units)\b/i;
/** Most units one step talks to. Four reports at once read as a crowd. */
const MOST = 3;
const STAGGER_MS = 280;
/** A message about the helpers inside the session goes to them. A Slack post or a page does not. */
export const TO_HELPERS = /\bhelpers?\b/i;
const stepOf = (a: LiveAgent) => a.now ?? a.steps[0];

/** What the talk saw last: each agent's newest step, and whether the first look has been taken. */
export type Heard = { steps: Map<string, string>; primed: boolean };
export const newHeard = (): Heard => ({ steps: new Map(), primed: false });

/**
 * The talks since the last look, and the agents that took a new step. A first look only
 * remembers, so opening Live replays nothing. `results` are the steps with a ✓ or ✗ this poll
 * found (live.ts `judge`).
 */
export function talk(agents: LiveAgent[], heard: Heard, results: { agentId: string; ok: boolean }[]): { talks: Talk[]; stepped: LiveAgent[] } {
  const out: Talk[] = [];
  const stepped: LiveAgent[] = [];
  const first = !heard.primed;
  heard.primed = true;
  const boss = agents.find((a) => a.commander);
  const units = agents.filter((a) => a.fleet && a !== boss);
  for (const id of heard.steps.keys()) if (!agents.some((a) => a.id === id)) heard.steps.delete(id);

  for (const a of agents) {
    const st = stepOf(a);
    const key = st ? `${st.verb ?? ""}@${st.atMs}` : "";
    const known = heard.steps.has(a.id);
    const was = heard.steps.get(a.id);
    heard.steps.set(a.id, key);
    if (first) continue;
    // A unit the fleet just started: its orders come from the commander, with its issue.
    if (!known && a.fleet && boss) out.push({ kind: "order", from: boss.id, to: a.id, tag: a.fleet.issues[0] ? `#${a.fleet.issues[0].number}` : undefined });
    if (!st || !known || was === key) continue;
    stepped.push(a);
    const verb = st.verb ?? "";

    if (st.file && READS.has(verb)) {
      const writer = agents.find((b) => b !== a && b.files.includes(st.file!));
      if (writer) out.push({ kind: "handoff", from: writer.id, to: a.id, tag: st.file.split("/").pop() });
    }
    // The commander talks to its units. Words about its own helpers go on to the message below.
    const named = a === boss ? mentioned(st.label, units) : [];
    if (a === boss && LOOKS.has(verb) && NEWS.test(st.label)) {
      // The news it read holds what the named units did, or else what the units did since its last look.
      const since = Number(was?.split("@")[1]) || 0;
      const fresh = units.filter((u) => (stepOf(u)?.atMs ?? 0) > since).sort((x, y) => stepOf(y)!.atMs - stepOf(x)!.atMs);
      (named.length ? named : fresh.slice(0, MOST)).forEach((u, i) => out.push({ kind: "report", from: u.id, to: a.id, delay: i * STAGGER_MS }));
    } else if (named.length) named.forEach((u, i) => out.push({ kind: LOOKS.has(verb) ? "look" : "order", from: a.id, to: u.id, delay: i * STAGGER_MS }));
    else if (verb === "message") {
      const kids = agents.filter((k) => k.parent === a.id);
      const to = TO_HELPERS.test(st.label) ? kids : mentioned(st.label, agents.filter((b) => b !== a));
      to.slice(0, MOST).forEach((b, i) => out.push({ kind: "order", from: a.id, to: b.id, delay: i * STAGGER_MS }));
    }
  }

  if (!first)
    for (const r of results) {
      const a = agents.find((x) => x.id === r.agentId);
      const to = a?.parent ?? (a?.fleet && boss && boss !== a ? boss.id : null);
      if (a && to) out.push({ kind: "report", from: a.id, to });
    }
  return { talks: out, stepped };
}

/**
 * The agents a step's words name: by name, class ("Terra"), project, unit id or issue, or as
 * "scout", "over-budget" or "stuck". At most three.
 */
function mentioned(label: string, among: LiveAgent[]): LiveAgent[] {
  const words = (w: string | null | undefined) => !!w && w.length > 1 && new RegExp(`(?<![\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "iu").test(label);
  const hit = among.filter((a) => {
    const f = a.fleet;
    return (
      words(a.name) ||
      words(a.roomName) ||
      (f && (words(f.kind) || words(f.unit) || f.issues.some((i) => label.includes(`#${i.number}`)))) ||
      (f?.scout && /\bscouts?\b/i.test(label)) ||
      (f?.flags.includes("OVER") && /\bover[- ]budget\b/i.test(label)) ||
      (f?.flags.includes("STUCK") && /\bstuck\b/i.test(label))
    );
  });
  return hit.slice(0, MOST);
}
