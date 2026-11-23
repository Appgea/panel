import { GROUPS, ROLE } from "./live_roles";
import { button, div, lensName, plural, span, unitClass } from "./live_text";
import type { FleetRole, LiveCtx } from "./live_types";

const ASK_CAP = 5;

const KEY: [string, string][] = [
  ["Commander", ROLE.commander.what],
  ["Scout", ROLE.scout.what],
  ["Checker", ROLE.checker.what],
  ["Builder", ROLE.builder.what],
  ["Lens", "One person at one stage, like a stranger before install or a buyer when money moves. A scout looks through one lens."],
  ["Ability", "One narrow check inside a lens, like Restore everywhere. A scout run takes one ability."],
  ["Work kind", "What a builder's issue is: fix, purchase, screen, text, store. It picks the rules the builder follows."],
  ["Terra, Sol, Flash, Astra, Sonnet, Haiku, Opus", "The model a unit runs on. Flash scouts, Astra and Terra build, Opus takes the hard issues."],
  ["Wave", "One scout per lens and app. The fleet sends a wave when the queue is empty, and holds it while 5 asks wait for you."],
  ["Groups", `Projects sit in ${GROUPS.map(([, n]) => n).join(", ")}. A card is one project with who works there.`],
];

type Station = { key: string; name: string; n: number; sub: string; title: string; tone?: "turn" | "done" };
export type Camp = { paint(): void; boss: HTMLElement };

export function mountCamp(ctx: LiveCtx, el: HTMLElement): Camp {
  const s = ctx.s;
  const head = div("camp-head");
  const title = span("camp-title", "Fleet");
  const sup = span("camp-sup");
  const keyEl = div("live-key");
  keyEl.hidden = true;
  for (const [name, what] of KEY) {
    const row = document.createElement("p");
    const b = document.createElement("b");
    b.textContent = name;
    row.append(b, what);
    keyEl.append(row);
  }
  const keyBtn = button("camp-key", "What is what", () => {
    keyEl.hidden = !keyEl.hidden;
    keyBtn.setAttribute("aria-expanded", String(!keyEl.hidden));
  });
  keyBtn.setAttribute("aria-expanded", "false");
  head.append(title, sup, keyBtn);
  const flow = document.createElement("ol");
  flow.className = "flow";
  const boss = div("camp-boss");
  const row = div("camp-row");
  row.append(boss, flow);
  el.append(head, row, keyEl);
  let sig = "";

  function stations(): Station[] {
    const b = s.board;
    const units = s.fleet?.units?.map((u) => ({ role: (u.role ?? (u.scout ? "scout" : "builder")) as FleetRole, scout: u.scout ?? "", flags: u.flags })) ?? (s.world?.agents ?? []).flatMap((a) => (a.fleet ? [{ role: (a.fleet.role ?? (a.fleet.scout ? "scout" : "builder")) as FleetRole, scout: a.fleet.scout ?? "", flags: a.fleet.flags }] : []));
    const of = (role: FleetRole) => units.filter((u) => u.role === role);
    const scouts = of("scout");
    const lenses = [...new Set(scouts.map((u) => lensName(u.scout)))];
    const open = [...(b?.ready ?? []), ...(b?.waiting ?? [])];
    const unread = open.filter((i) => i.unchecked).length;
    const queue = (b?.ready ?? []).filter((i) => !i.unchecked).length;
    const builders = of("builder");
    const slow = builders.filter((u) => u.flags.length).length;
    const today = new Date().toDateString();
    const closed = (b?.done ?? []).filter((i) => !i.dropped && i.closed_at && new Date(i.closed_at).toDateString() === today).length;
    const byFleet = (s.fleet?.today ?? []).reduce((n, r) => n + r.closed.length, 0);
    const asks = b?.you?.length ?? 0;
    const checkers = of("checker").length;
    return [
      { key: "scout", name: "Scouts find", n: scouts.length, sub: lenses.length ? `${lenses.slice(0, 2).join(", ")}${lenses.length > 2 ? ` +${lenses.length - 2}` : ""}` : "No wave out", title: ROLE.scout.what },
      { key: "checker", name: "Checkers confirm", n: unread, sub: unread ? `unread ${plural(unread, "finding")}${checkers ? ` · ${checkers} on it` : ""}` : "Nothing unread", title: ROLE.checker.what },
      { key: "queue", name: "Queue", n: queue, sub: queue ? "ready to build" : "Empty. A wave is due", title: "Shaped, checked issues no one holds yet. Builders take them in board order." },
      { key: "builder", name: "Builders build", n: builders.length, sub: slow ? `${slow} over budget or stuck` : builders.length ? "on budget" : "None running", title: ROLE.builder.what },
      { key: "done", name: "Closed today", n: closed, sub: byFleet ? `${byFleet} by the fleet` : "", title: "Issues closed on the board today.", tone: "done" },
      { key: "ask", name: "Your asks", n: asks, sub: asks >= ASK_CAP ? "Waves are paused" : asks ? "wait for you" : "None waiting", title: `Issues that wait for your answer. At ${ASK_CAP} the fleet stops sending new scout waves.`, tone: "turn" },
    ];
  }

  function paint(): void {
    const f = s.fleet;
    const state = !f ? "Not read yet" : f.hold ? "On hold" : f.supervisor ? "Supervisor on" : "Supervisor off";
    const mix = (f?.spec ?? "").split(/[,\s]+/).filter(Boolean).map((p) => {
      const [kind, n] = p.split(":");
      return `${n ?? 1} ${unitClass(kind).name}`;
    });
    const st = stations();
    const next = JSON.stringify([state, mix, st]);
    if (next === sig) return;
    sig = next;
    sup.textContent = [state, mix.join(", ")].filter(Boolean).join(" · ");
    sup.classList.toggle("is-off", !f?.supervisor || !!f?.hold);
    flow.replaceChildren(
      ...st.map((x) => {
        const li = document.createElement("li");
        li.className = `flow-st is-${x.key}${x.n ? "" : " is-zero"}${x.tone && x.n ? ` is-${x.tone}` : ""}`;
        li.title = x.title;
        li.append(span("flow-name", x.name), span("flow-n", String(x.n)), span("flow-sub", x.sub));
        return li;
      }),
    );
  }

  return { paint, boss };
}
