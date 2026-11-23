import { GROUPS, kindOf, PHASES, PHASE_WORD, phaseOf, ROLE, roleName, roleOf, workOf, type Phase, type Role } from "./live_roles";
import { button, cap, div, hhmm, plural, since, span, STATE_RANK, STATE_WORD, withoutRoom } from "./live_text";
import type { LiveAgent, LiveCtx, State } from "./live_types";

const FRESH_MS = 2500;
const HELPERS_SHOWN = 4;

const GLYPH: Record<Role, string> = {
  commander: '<path d="m8 1.800 1.900 3.900 4.300.600-3.100 3 .700 4.300L8 11.600l-3.800 2 .700-4.300-3.100-3 4.300-.600z"/>',
  builder: '<path d="M9.500 2.500 13 6l-1.500 1.500-1-1-6 6a1.060 1.060 0 0 1-1.500-1.500l6-6-1-1z"/>',
  scout: '<circle cx="7" cy="7" r="4"/><path d="m10 10 3.500 3.500"/>',
  checker: '<path d="M8 1.800 13 3.600v4c0 3-2.100 5.400-5 6.600-2.900-1.200-5-3.600-5-6.600v-4z"/><path d="m5.800 8 1.700 1.700 2.900-3.200"/>',
  chief: '<rect x="3.500" y="3" width="9" height="11" rx="1.500"/><path d="M6 3V2h4v1M6 7h4M6 10h4"/>',
  session: '<path d="m3 5 3 3-3 3M8 11h5"/>',
  run: '<circle cx="8" cy="8" r="2.500"/><path d="M8 1.500v2M8 12.500v2M1.500 8h2M12.500 8h2M3.400 3.400l1.400 1.400M11.200 11.200l1.400 1.400M3.400 12.600l1.400-1.400M11.200 4.800l1.400-1.400"/>',
  helper: '<circle cx="8" cy="8" r="2.500"/>',
};

type HelperVM = { id: string; state: State; name: string; text: string };
type UnitVM = {
  id: string;
  role: Role;
  roleName: string;
  fleet: boolean;
  state: State;
  kind: string;
  kindColour: string;
  chip: string;
  number: number | null;
  work: string;
  tip: string;
  note: string;
  tone: "" | "ok" | "bad" | "turn" | "stuck";
  time: string;
  over: boolean;
  phase: Phase | null;
  slot: string;
  helpers: HelperVM[];
  more: number;
  fresh: boolean;
  selected: boolean;
};
type TownVM = { key: string; name: string; meta: string; units: UnitVM[]; done: string; next: string; ended: { text: string; ok: boolean } | null; selected: boolean };
type GroupVM = { key: string; name: string; towns: TownVM[] };

export type Towns = { paint(): void };

export function mountTowns(ctx: LiveCtx, el: HTMLElement, bossEl: HTMLElement): Towns {
  const s = ctx.s;
  let sig = "";

  function unit(a: LiveAgent, now: number): UnitVM {
    const w = s.world!;
    const role = roleOf(a);
    const room = ctx.roomName(ctx.roomOf(a));
    const iss = ctx.issueOf(a);
    const work = workOf(a, iss, room);
    const kind = kindOf(a);
    const f = a.fleet;
    const used = f?.startedMs ? Math.round((now - f.startedMs) / 60_000) : 0;
    const over = !!f && (f.flags.includes("OVER") || (f.budget > 0 && used > f.budget));
    const res = s.results.get(a.id);
    const live = res && res.until > now ? res : undefined;
    const waited = a.stateMs ? ` · ${since(a.stateMs, now)}` : "";
    const [note, tone]: [string, UnitVM["tone"]] = live
      ? [live.text, live.ok ? "ok" : "bad"]
      : a.state === "turn"
        ? [`Waits for you${waited}`, "turn"]
        : a.state === "stuck"
          ? [`Stuck${waited}`, "stuck"]
          : f?.flags.includes("STUCK")
            ? ["Flagged stuck by the fleet", "stuck"]
            : ["", ""];
    const time = f ? `${used}/${f.budget} min` : a.state === "idle" && a.stateMs ? `idle ${since(a.stateMs, now)}` : a.startedMs ? since(a.startedMs, now) : "";
    const bay = w.mac.bays.findIndex((b) => b.agent === a.id);
    const kids = w.agents.filter((k) => k.parent === a.id).sort((x, y) => STATE_RANK[x.state] - STATE_RANK[y.state] || x.id.localeCompare(y.id));
    const fresh = (!!live && now - live.born < FRESH_MS) || (s.pinged.get(a.id) ?? 0) > now;
    return {
      id: a.id,
      role,
      roleName: roleName(a),
      fleet: !!f,
      state: a.state,
      kind: kind.name,
      kindColour: kind.colour,
      chip: work.chip,
      number: work.number,
      work: work.title,
      tip: [ROLE[role].what, work.question, a.files.length ? `${a.files.length} ${plural(a.files.length, "file")} touched` : ""].filter(Boolean).join("\n"),
      note,
      tone,
      time,
      over,
      phase: role === "scout" || role === "checker" || role === "chief" || a.state === "idle" ? null : phaseOf(a),
      slot: bay >= 0 ? `Holds slot ${bay + 1}: ${w.mac.bays[bay].holder ?? "a run"}` : "",
      helpers: kids.slice(0, HELPERS_SHOWN).map((k) => ({ id: k.id, state: k.state, name: roleName(k), text: (k.task ?? k.now?.label ?? k.lastText ?? "").trim() })),
      more: Math.max(0, kids.length - HELPERS_SHOWN) + (kids.length ? 0 : a.helpers),
      fresh,
      selected: s.selection?.kind === "agent" && s.selection.id === a.id,
    };
  }

  function model(now: number): { boss: UnitVM | null; groups: GroupVM[]; quiet: string[] } {
    const w = s.world!;
    const ids = new Set(w.agents.map((a) => a.id));
    const roots = w.agents.filter((a) => !a.parent || !ids.has(a.parent));
    const bossAgent = roots.find((a) => a.commander);
    const today = new Date(now).toDateString();
    const done = (s.board?.done ?? []).filter((i) => !i.dropped && i.closed_at && new Date(i.closed_at).toDateString() === today).sort((a, b) => Date.parse(b.closed_at!) - Date.parse(a.closed_at!));
    const ready = (s.board?.ready ?? []).filter((i) => !i.unchecked);
    const byRoom = new Map<string, LiveAgent[]>();
    for (const a of roots) {
      if (a === bossAgent) continue;
      const key = ctx.roomOf(a);
      byRoom.set(key, [...(byRoom.get(key) ?? []), a]);
    }
    const meta = (key: string) => w.rooms.find((r) => r.key === key);
    const town = (key: string, here: LiveAgent[]): TownVM => {
      const name = ctx.roomName(key);
      const last = done.find((i) => i.apps.includes(key));
      const ember = last ? undefined : w.embers.filter((e) => e.room === key && e.outcome === "done" && e.result).sort((a, b) => b.endedMs - a.endedMs)[0];
      const next = ready.find((i) => i.apps.includes(key));
      const busy = here.filter((a) => a.state === "work" || a.state === "think").length;
      const end = s.endings.find((e) => e.room === key && e.until > now);
      return {
        key,
        name,
        meta: busy ? `${busy} working` : "",
        units: here.sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || a.id.localeCompare(b.id)).map((a) => unit(a, now)),
        done: last ? `${cap(withoutRoom(last.title, name))} · ${hhmm(Date.parse(last.closed_at!))}` : ember ? `${ember.result} · ${hhmm(ember.endedMs)}` : "",
        next: next ? `#${next.number} ${cap(withoutRoom(next.title, name))}` : "",
        ended: end ? { text: end.text, ok: end.ok } : null,
        selected: s.selection?.kind === "room" && s.selection.id === key,
      };
    };
    const groups: GroupVM[] = [];
    const quiet: string[] = [];
    for (const [gkey, gname] of GROUPS) {
      const keys = [...byRoom.keys()].filter((k) => (meta(k)?.group ?? "hq") === gkey).sort((a, b) => (meta(a)?.order ?? 9999) - (meta(b)?.order ?? 9999));
      if (keys.length) groups.push({ key: gkey, name: gname, towns: keys.map((k) => town(k, byRoom.get(k)!)) });
      else {
        const rooms = new Set(w.rooms.filter((r) => (r.group ?? "hq") === gkey).map((r) => r.key));
        const n = ready.filter((i) => i.apps.some((a) => rooms.has(a))).length;
        quiet.push(n ? `${gname} · ${n} ready` : gname);
      }
    }
    return { boss: bossAgent ? unit(bossAgent, now) : null, groups, quiet };
  }

  function row(u: UnitVM): HTMLElement[] {
    const b = button(`unit is-${u.state} role-${u.role}${u.fleet ? " is-fleet" : ""}${u.fresh ? " is-fresh" : ""}${u.tone ? ` tone-${u.tone}` : ""}${u.selected ? " is-selected" : ""}`, "", () => ctx.select({ kind: "agent", id: u.id }));
    b.title = [`${u.roleName} · ${STATE_WORD[u.state]}`, u.tip, u.slot, u.phase ? `Phase: ${PHASE_WORD[u.phase]}` : ""].filter(Boolean).join("\n");
    const badge = span("unit-badge");
    const tok = span("tok");
    badge.append(tok);
    tok.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.500" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${GLYPH[u.role]}</svg>`;
    const top = span("unit-top");
    const kind = span("unit-kind", u.kind);
    kind.style.setProperty("--k", u.kindColour);
    top.append(span("unit-role", u.roleName), kind);
    if (u.chip) top.append(span("unit-chip", u.chip));
    if (u.slot) top.append(span("unit-slot", "slot"));
    const work = span("unit-work");
    if (u.number) {
      const n = document.createElement("b");
      n.textContent = `#${u.number}`;
      work.append(n);
    }
    work.append(u.work);
    if (u.phase) {
      const pips = span("unit-pips");
      const at = PHASES.indexOf(u.phase);
      PHASES.forEach((_, i) => pips.append(span(i === at ? "is-on" : i < at ? "is-past" : "")));
      badge.append(pips);
    }
    b.append(badge, top, span(`unit-time${u.over ? " is-over" : ""}`, u.time), work);
    if (u.note) b.append(span(`unit-note is-${u.tone}`, u.note));
    const out: HTMLElement[] = [b];
    for (const h of u.helpers) {
      const hb = button(`helper is-${h.state}`, "", () => ctx.select({ kind: "agent", id: h.id }));
      const name = document.createElement("b");
      name.textContent = h.name;
      hb.append(span("helper-dot"), name, span("helper-text", h.text));
      out.push(hb);
    }
    if (u.more) out.push(div("helper is-more", `${u.helpers.length ? "+" : ""}${u.more} ${plural(u.more, "helper")}`));
    return out;
  }

  function paint(): void {
    if (!s.world) return;
    const m = model(Date.now());
    const next = JSON.stringify(m);
    if (next === sig) return;
    sig = next;
    bossEl.replaceChildren(...(m.boss ? row(m.boss) : [div("camp-none", "No commander. Your words here start one.")]));
    const nodes: HTMLElement[] = m.groups.map((g) => {
      const box = document.createElement("section");
      box.className = `group is-${g.key}`;
      box.style.setProperty("--n", String(g.towns.length));
      const towns = div("group-towns");
      for (const t of g.towns) {
        const card = document.createElement("article");
        card.className = `town${t.selected ? " is-selected" : ""}`;
        const head = div("town-head");
        head.append(button("town-name", t.name, () => ctx.select({ kind: "room", id: t.key })), span("town-meta", t.meta));
        const units = div("town-units");
        for (const u of t.units) units.append(...row(u));
        card.append(head, units);
        if (t.ended) card.append(div(`town-ended ${t.ended.ok ? "is-ok" : "is-bad"}`, t.ended.text));
        if (t.done || t.next) {
          const foot = div("town-foot");
          for (const [cls, label, text] of [["is-done", "Done", t.done], ["is-next", "Next", t.next]] as const) {
            if (!text) continue;
            const line = div(`town-line ${cls}`);
            line.append(span("town-label", label), span("town-text", text));
            line.title = text;
            foot.append(line);
          }
          card.append(foot);
        }
        towns.append(card);
      }
      box.append(div("group-name", g.name), towns);
      return box;
    });
    if (!m.groups.length) nodes.push(div("group-empty", "No agent is running in a project."));
    if (m.quiet.length) nodes.push(div("group-quiet", `Quiet: ${m.quiet.join(", ")}`));
    el.replaceChildren(...nodes);
  }

  return { paint };
}
