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

import { ago, button, div, doing, OUTCOME_COLOUR, OUTCOME_WORD, since, span, STATE_RANK, taskLine, who } from "./live_text";
import type { LiveAgent, LiveCtx, LiveEmber } from "./live_types";

/** Ended agents in the list. Older ones are in History. */
const ENDED = 8;
/**
 * Helpers listed under their parent. They ride on their parent on the map too, so only a helper
 * that needs the owner gets its own row. The rest are one "+N helpers" line.
 */
const KIDS = 0;

export type Side = { paint(): void };

export function mountSide(ctx: LiveCtx, el: HTMLElement): Side {
  const nowHead = div("side-head");
  const nowList = div("side-list");
  const endHead = div("side-head");
  const endList = div("side-list");
  el.append(nowHead, nowList, endHead, endList);
  const rows = new Map<string, HTMLButtonElement>();

  function row(id: string, onClick: () => void, hoverId: string | null): HTMLButtonElement {
    let r = rows.get(id);
    if (!r) {
      r = button("side-row", "", onClick);
      const dot = document.createElement("i");
      r.append(dot, span("side-who"), span("side-where"), span("side-what"));
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
    set(nowHead, w.agents.length ? `Running · ${w.agents.length}` : "Running");
    // Helpers sit under the agent that started them. A swarm of eight would bury the list, so a
    // parent shows KIDS of them, the ones that need you first, and counts the rest.
    const nowRows: HTMLElement[] = [];
    const tree = (a: LiveAgent, depth: number) => {
      nowRows.push(agentRow(a, now, depth));
      const kids = [...(kidsOf.get(a.id) ?? [])].sort(rank);
      const shown = kids.filter((k, i) => i < KIDS || k.state === "turn" || k.state === "stuck");
      for (const k of shown) tree(k, depth + 1);
      if (kids.length > shown.length) nowRows.push(moreRow(a, kids.length - shown.length, depth + 1));
    };
    for (const a of [...w.agents].filter((x) => !x.parent || !ids.has(x.parent)).sort(rank)) tree(a, 0);
    nowRows.forEach((r) => used.add(r.dataset.key!));
    if (!w.agents.length) nowRows.push(empty("No agent runs on this Mac."));
    order(nowList, nowRows);

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
    const what = a.state === "idle" ? (iss ? `#${iss.number} ${iss.title}` : (taskLine(a.task) ?? "Idle")) : doing(a);
    const meta = [me.sub, a.startedMs ? since(a.startedMs, now) : ""].filter(Boolean).join(" · ");
    fill(r, `var(--l-${a.state})`, title, depth ? "" : room, what, [me.title, meta, taskLine(a.task)].filter(Boolean).join("\n"));
    r.className = `side-row is-${a.state}${depth ? " is-child" : ""}`;
    return r;
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
    const me = who(e, e.parentName);
    const what = e.result ?? taskLine(e.task) ?? "";
    fill(r, OUTCOME_COLOUR[e.outcome], `${me.title} · ${OUTCOME_WORD[e.outcome].toLowerCase()}`, e.roomName, what, [me.title, [me.sub, ago(e.endedMs, now)].filter(Boolean).join(" · "), taskLine(e.task)].filter(Boolean).join("\n"));
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

function set(el: HTMLElement, t: string): void {
  if (el.textContent !== t) el.textContent = t;
}
