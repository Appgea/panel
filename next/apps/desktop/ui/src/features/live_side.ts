/**
 * The column beside the map: every running agent as a row that says what it is and what it does
 * now, then the agents that ended. The map shows where things happen. This list is what you
 * read. Owner, 2026-11-05: "I should be able to understand which agent is what."
 *
 * A row is two lines, who and where, then what it does. The model and age are in its tooltip
 * and its panel, so twenty agents fit without a scroll. Owner, 2026-11-05: "not space
 * efficient. Hard for me to track."
 *
 * A row is kept by id and only its words change, so a hand on a row never loses it to a repaint.
 * Hovering a row marks its dot on the map. A click opens the agent's panel, which takes the
 * column until it closes.
 */

import { ageOf, ago, button, cap, div, doing, OUTCOME_COLOUR, OUTCOME_WORD, plural, since, span, STATE_RANK, taskLine, unitClass, unitName } from "./live_text";
import type { LiveAgent, LiveCtx, LiveEmber } from "./live_types";
import { XP } from "./live_game";
import { art, crest, STAR } from "./game_art";

/** Ended agents in the list. Older ones are in History. */
const ENDED = 8;
/**
 * Helpers listed under their parent. They ride on their parent on the map too, so only a helper
 * that needs the owner gets its own row. The rest are one "+N helpers" line.
 */
const KIDS = 0;

export type Side = { paint(): void };

export function mountSide(ctx: LiveCtx, el: HTMLElement): Side {
  // The fleet first: its commander and its units, the squad the score is about. Then every other
  // session, the day's table by class, and what ended.
  const cmdHead = div("side-head is-fleet");
  const cmdList = div("side-list");
  const nowHead = div("side-head");
  const nowList = div("side-list");
  const endHead = div("side-head");
  const endList = div("side-list");
  const dayHead = div("side-head", "Today's squad");
  const dayEl = div("side-day");
  // The day's table sits above Ended, so it shows without a scroll on a full wave.
  el.append(cmdHead, cmdList, nowHead, nowList, dayHead, dayEl, endHead, endList);
  const rows = new Map<string, HTMLButtonElement>();
  let daySig = "";

  function row(id: string, onClick: () => void, hoverId: string | null): HTMLButtonElement {
    let r = rows.get(id);
    if (!r) {
      r = button("side-row", "", onClick);
      const dot = document.createElement("i");
      const bud = span("side-bud");
      bud.hidden = true;
      r.append(dot, span("side-who"), span("side-where"), span("side-what"), bud);
      if (hoverId) {
        r.addEventListener("pointerenter", () => ctx.hover(hoverId));
        r.addEventListener("pointerleave", () => ctx.hover(null));
      }
      rows.set(id, r);
    }
    return r;
  }

  function fill(r: HTMLElement, colour: string, whoText: string, where: string, what: string, title: string): void {
    const [dot, w, at, wh] = [...r.children] as HTMLElement[];
    dot.style.setProperty("--c", colour);
    set(w, whoText);
    set(at, where);
    set(wh, what);
    wh.hidden = !what;
    r.title = title;
  }

  function paint(): void {
    const s = ctx.s;
    const w = s.world;
    if (!w) return;
    const now = Date.now();
    const used = new Set<string>();

    const rank = (a: LiveAgent, b: LiveAgent) => STATE_RANK[a.state] - STATE_RANK[b.state] || ctx.roomName(ctx.roomOf(a)).localeCompare(ctx.roomName(ctx.roomOf(b))) || a.id.localeCompare(b.id);
    const ids = new Set(w.agents.map((a) => a.id));
    const kidsOf = new Map<string, LiveAgent[]>();
    for (const a of w.agents) if (a.parent && ids.has(a.parent)) kidsOf.set(a.parent, [...(kidsOf.get(a.parent) ?? []), a]);
    const tops = w.agents.filter((a) => !a.parent || !ids.has(a.parent));
    const squad = (a: LiveAgent) => !!a.fleet || !!a.commander;
    const sessions = tops.filter((a) => !squad(a));
    const helpers = w.agents.filter((a) => a.parent && ids.has(a.parent)).length;
    // Helpers sit under the agent that started them. A swarm of eight would bury the list, so a
    // parent shows KIDS of them, the ones that need you first, and counts the rest.
    const tree = (out: HTMLElement[], a: LiveAgent, depth: number) => {
      out.push(agentRow(a, now, depth));
      const kids = [...(kidsOf.get(a.id) ?? [])].sort(rank);
      const shown = kids.filter((k, i) => i < KIDS || k.state === "turn" || k.state === "stuck");
      for (const k of shown) tree(out, k, depth + 1);
      if (kids.length > shown.length) out.push(moreRow(a, kids.length - shown.length, depth + 1));
    };

    // The commander leads, then the units that need a look, then the ones nearest their budget.
    const units = tops.filter((a) => a.fleet);
    const boss = tops.filter((a) => a.commander && !a.fleet);
    const worry = (a: LiveAgent) => (a.fleet!.flags.length ? 0 : 1);
    const spent = (a: LiveAgent) => (a.fleet!.budget ? (now - a.fleet!.startedMs) / 60_000 / a.fleet!.budget : 0);
    units.sort((a, b) => worry(a) - worry(b) || spent(b) - spent(a) || a.id.localeCompare(b.id));
    const cmdRows: HTMLElement[] = [];
    for (const a of [...boss, ...units]) tree(cmdRows, a, 0);
    const f = ctx.s.fleet;
    const fleetWord = !f ? "" : f.hold ? " · on hold" : f.supervisor ? "" : " · off";
    set(cmdHead, `Fleet · ${units.length} ${plural(units.length, "unit")}${boss.length ? ", 1 commander" : ""}${fleetWord}`);
    cmdHead.hidden = !cmdRows.length;
    cmdList.hidden = !cmdRows.length;
    cmdRows.forEach((r) => used.add(r.dataset.key!));
    order(cmdList, cmdRows);

    const nowRows: HTMLElement[] = [];
    for (const a of [...sessions].sort(rank)) tree(nowRows, a, 0);
    const label = cmdRows.length ? "Sessions" : "Running";
    set(nowHead, sessions.length ? `${label} · ${sessions.length} ${plural(sessions.length, "agent")}${helpers ? `, ${helpers} ${plural(helpers, "helper")}` : ""}` : label);
    nowRows.forEach((r) => used.add(r.dataset.key!));
    if (!w.agents.length) nowRows.push(empty("No agent runs on this Mac."));
    else if (!sessions.length) nowRows.push(empty("Only the fleet runs now."));
    order(nowList, nowRows);
    paintDay();

    const ended = [...w.embers].sort((a, b) => b.endedMs - a.endedMs).slice(0, ENDED);
    endHead.hidden = !ended.length;
    endList.hidden = !ended.length;
    set(endHead, "Ended");
    const endRows = ended.map((e) => emberRow(e, now));
    endRows.forEach((r) => used.add(r.dataset.key!));
    order(endList, endRows);

    for (const id of [...rows.keys()]) if (!used.has(id)) rows.delete(id);
    for (const [id, r] of rows) r.classList.toggle("is-hover", s.hover !== null && id === `a:${s.hover}`);
  }

  function agentRow(a: LiveAgent, now: number, depth: number): HTMLButtonElement {
    const key = `a:${a.id}`;
    const r = row(key, () => ctx.select({ kind: "agent", id: a.id }), a.id);
    r.dataset.key = key;
    const me = ctx.whoOf(a);
    // Under its parent, "Helper of Zenne" says the parent twice. A subagent is named by the job
    // its parent gave it, like "#1332 HUD terms vs glossary", and its role moves to the hover.
    const title = !depth ? me.title : a.helperKind ? (a.task ?? me.role) : me.title.startsWith("Helper of ") ? "Helper" : me.title;
    const room = ctx.roomName(ctx.roomOf(a));
    const iss = ctx.issueOf(a);
    const named = /^#\d/.test(me.title);
    const what = a.state === "idle" ? (iss && !named ? `#${iss.number} ${iss.title}` : (taskLine(a.task) ?? "Idle")) : doing(a);
    const age = ageOf(a, now);
    const meta = [me.sub, a.startedMs ? `running ${since(a.startedMs, now)}` : ""].filter(Boolean).join(" · ");
    const u = a.fleet;
    const used = u?.startedMs ? (now - u.startedMs) / 60_000 : 0;
    const clock = u?.budget ? `${Math.round(used)}/${u.budget} min` : "";
    // A unit's line says its class and its time against the budget. Its plot is on the map.
    const where = u ? [room, clock].filter(Boolean).join(" · ") : a.commander ? "★ Commander" : [depth ? "" : room, age ? (a.state === "turn" ? `waiting ${age}` : age) : ""].filter(Boolean).join(" · ");
    const flags = u?.flags.length ? `${u.flags.join(", ")} · ` : "";
    fill(r, `var(--l-${a.state})`, title, where, `${flags}${what}`, [me.title, meta, taskLine(a.task)].filter(Boolean).join("\n"));
    const bud = r.children[4] as HTMLElement;
    bud.hidden = !u?.budget;
    if (u?.budget) bud.style.setProperty("--p", Math.min(1, used / u.budget).toFixed(3));
    const over = !!u && (u.flags.includes("OVER") || (!!u.budget && used > u.budget));
    bud.classList.toggle("is-over", over);
    r.style.setProperty("--k", u ? unitClass(u.kind).colour : "var(--l-gold)");
    r.className = `side-row is-${a.state}${depth ? " is-child" : ""}${u ? " is-unit" : ""}${a.commander ? " is-boss" : ""}${u?.flags.length ? " is-flagged" : ""}`;
    return r;
  }

  /** The day by class: runs, closes and the median run, and the unit that closed most. */
  function paintDay(): void {
    const runs = ctx.s.fleet?.today ?? [];
    dayHead.hidden = !runs.length;
    dayEl.hidden = !runs.length;
    if (!runs.length) return;
    // A scout's work is what it filed, a builder's what it closed: both score, as on the bar.
    const foundBy = ctx.s.game.score.foundBy;
    const by = new Map<string, { runs: number; closed: Set<number>; found: number; mins: number[] }>();
    for (const r of runs) {
      const k = by.get(r.kind) ?? { runs: 0, closed: new Set<number>(), found: 0, mins: [] };
      k.runs++;
      r.closed.forEach((n) => k.closed.add(n));
      k.found += foundBy.get(r.unit) ?? 0;
      k.mins.push(r.minutes);
      by.set(r.kind, k);
    }
    const xp = (r: (typeof runs)[number]) => r.closed.length * XP.close + (foundBy.get(r.unit) ?? 0) * XP.found;
    const best = [...runs].sort((a, b) => xp(b) - xp(a) || a.minutes - b.minutes)[0];
    const score = (v: { closed: Set<number>; found: number }) => v.closed.size * XP.close + v.found * XP.found;
    const kinds = [...by.entries()].sort((a, b) => score(b[1]) - score(a[1]) || b[1].runs - a[1].runs);
    const sig = JSON.stringify([kinds.map(([k, v]) => [k, v.runs, v.closed.size, v.found, median(v.mins)]), best?.unit, best && xp(best)]);
    if (sig === daySig) return;
    daySig = sig;
    const grid = div("day-grid");
    grid.append(span("day-h", "Class"), span("day-h", "Runs"), span("day-h", "Closed"), span("day-h", "Found"), span("day-h", "Median"));
    for (const [kind, v] of kinds) {
      const c = unitClass(kind);
      const name = span("day-cls");
      name.append(art("day-crest", crest(kind)), span("", c.name));
      name.style.setProperty("--c", c.colour);
      grid.append(name, span("day-n", String(v.runs)), span("day-n is-closed", String(v.closed.size)), span("day-n is-found", String(v.found)), span("day-n", `${median(v.mins)} min`));
    }
    const out: HTMLElement[] = [grid];
    if (best && xp(best)) {
      const n = foundBy.get(best.unit) ?? 0;
      const did = [best.closed.length ? `closed ${best.closed.length}` : "", n ? `found ${n}` : ""].filter(Boolean).join(" and ");
      const mvp = div("day-mvp");
      const star = span("day-star");
      star.append(art("day-star-ico", STAR), document.createTextNode("MVP"));
      const line = span("day-mvp-line");
      const who = document.createElement("b");
      who.textContent = unitName(best.kind, best.unit);
      const mins = document.createElement("i");
      mins.textContent = `${best.minutes} min`;
      line.append(who, ` ${did} in `, mins);
      mvp.append(star, line, span("day-mvp-xp", `+${xp(best)} XP`));
      mvp.title = `${xp(best)} XP in one run${best.closed.length ? `. Closed ${best.closed.map((c) => `#${c}`).join(", ")}` : ""}`;
      out.push(mvp);
    }
    dayEl.replaceChildren(...out);
  }

  /** The helpers a parent row does not list, as one line that opens the parent. */
  function moreRow(parent: LiveAgent, n: number, depth: number): HTMLButtonElement {
    const key = `m:${parent.id}`;
    const r = row(key, () => ctx.select({ kind: "agent", id: parent.id }), parent.id);
    r.dataset.key = key;
    fill(r, "var(--l-ink-3)", `+${n} ${n === 1 ? "helper" : "helpers"}`, "", "", `Open ${ctx.nameOf(parent)} to see them all`);
    r.className = `side-row is-more${depth ? " is-child" : ""}`;
    return r;
  }

  function emberRow(e: LiveEmber, now: number): HTMLButtonElement {
    const key = `e:${e.id}`;
    const r = row(key, () => ctx.select({ kind: "ember", id: e.id }), null);
    r.dataset.key = key;
    const me = ctx.emberWho(e);
    // An agent that did not finish says where it was, since it wrote no result.
    const last = e.steps[0]?.label;
    const detail = e.result ?? (e.outcome !== "done" && last ? `Its last step: ${last}` : (taskLine(e.task) ?? ""));
    const when = ago(e.endedMs, now);
    // How and when it ended lead the line, so the name keeps its room in the row's head.
    const what = `${OUTCOME_WORD[e.outcome]} ${when}${detail ? `. ${cap(detail)}` : ""}`;
    fill(r, OUTCOME_COLOUR[e.outcome], me.title, ctx.roomName(e.room), what, [me.title, [me.sub, when].filter(Boolean).join(" · "), taskLine(e.task)].filter(Boolean).join("\n"));
    r.className = "side-row is-ended";
    return r;
  }

  return { paint };
}

function empty(text: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "side-empty";
  b.disabled = true;
  b.textContent = text;
  b.dataset.key = "";
  return b;
}

/** Puts `want` in the list in that order, touching the DOM only when the order changed. */
function order(list: HTMLElement, want: HTMLElement[]): void {
  const have = [...list.children];
  if (have.length === want.length && have.every((c, i) => c === want[i])) return;
  list.replaceChildren(...want);
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function set(el: HTMLElement, t: string): void {
  if (el.textContent !== t) el.textContent = t;
}
