/**
 * The panel for a dot, an ember or a district, docked at the top right of the map. Copied from
 * the concept page: `agentHTML` line 1153, `reportHTML` line 1162, `roomHTML` line 1172, and
 * `.apanel` in its CSS.
 */

import { errorText } from "../errors";
import { ago, button, clock, div, doing, HARNESS, hhmm, holdButton, OUTCOME_COLOUR, OUTCOME_WORD, plural, short, since, span, STATE_RANK, STATE_WORD } from "./live_text";
import type { LiveAgent, LiveCtx, LiveEmber, Step } from "./live_types";
import "./live_panel.css";

export type Panel = { paint(): void };

export function mountPanel(ctx: LiveCtx, el: HTMLElement): Panel {
  const s = ctx.s;
  let talking = false;
  let shown = "";

  function paint(): void {
    const w = s.world;
    const sel = s.selection;
    if (!w || !sel) return hide();
    if (sel.kind === "agent") {
      const a = w.agents.find((x) => x.id === sel.id);
      if (!a) {
        // The agent stopped while its panel was open: show its report instead.
        const report = w.embers.find((e) => e.id.startsWith(`${sel.id}@`));
        s.selection = report ? { kind: "ember", id: report.id } : null;
        return paint();
      }
      render(sel.kind + sel.id, agentPanel(a));
    } else if (sel.kind === "ember") {
      const e = w.embers.find((x) => x.id === sel.id);
      if (!e) return hide();
      render(sel.kind + sel.id, reportPanel(e));
    } else {
      render(sel.kind + sel.id, roomPanel(sel.id));
    }
  }

  function render(key: string, nodes: HTMLElement[]): void {
    // A hand on Hold to Stop keeps this panel as it is until it lets go.
    if (key === shown && el.querySelector(".is-holding")) return;
    if (key !== shown) talking = false;
    shown = key;
    const steps = el.querySelector(".pdone");
    const keep = steps?.scrollTop ?? 0;
    const draft = el.querySelector<HTMLInputElement>(".reply");
    const words = draft?.value ?? "";
    const focused = draft && document.activeElement === draft;
    el.replaceChildren(...nodes);
    const again = el.querySelector(".pdone");
    if (again) again.scrollTop = keep;
    const reply = el.querySelector<HTMLInputElement>(".reply");
    if (reply) {
      reply.value = words;
      if (focused || talking) reply.focus();
    }
    el.hidden = false;
  }

  function hide(): void {
    shown = "";
    talking = false;
    el.hidden = true;
  }

  function head(name: string, sub: string, colour: string | null): HTMLElement {
    const h = div("ph");
    if (colour) {
      const dot = span("pdot");
      dot.style.setProperty("--c", colour);
      h.append(dot);
    }
    const t = div("pt");
    t.append(div("pname", name), div("psub", sub));
    const close = button("pclose", "×", () => ctx.select(null));
    close.setAttribute("aria-label", "Close panel");
    h.append(t, close);
    return h;
  }

  function chipRow(word: string, colour: string, after: string): HTMLElement {
    const r = div("pstate");
    const chip = span("chip", word);
    chip.style.setProperty("--c", colour);
    r.append(chip, span("", after));
    return r;
  }

  function rows(list: [string, string | HTMLElement][]): HTMLElement {
    const dl = document.createElement("dl");
    dl.className = "prows";
    for (const [k, v] of list) {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      if (typeof v === "string") dd.textContent = v;
      else dd.append(v);
      dl.append(dt, dd);
    }
    return dl;
  }

  function link(text: string, run: () => void): HTMLButtonElement {
    return button("plink", text, run);
  }

  function doneList(title: string, steps: Step[]): HTMLElement[] {
    const ol = document.createElement("ol");
    ol.className = "pdone";
    if (!steps.length) ol.append(div("muted", "No steps read yet."));
    for (const st of steps.slice(0, 30)) {
      const li = document.createElement("li");
      const t = document.createElement("time");
      t.textContent = hhmm(st.atMs);
      li.append(t, st.file ? link(st.label, () => ctx.events.openFile(st.file!)) : span("", st.label));
      ol.append(li);
    }
    return [div("psec", title), ol];
  }

  function agentPanel(a: LiveAgent): HTMLElement[] {
    const now = Date.now();
    const room = ctx.roomName(ctx.roomOf(a));
    const out: HTMLElement[] = [head(ctx.nameOf(a), [HARNESS[a.harness], short(a.model), room].filter(Boolean).join(" · "), `var(--l-${a.state})`)];
    out.push(chipRow(STATE_WORD[a.state], `var(--l-${a.state})`, a.startedMs ? `running ${since(a.startedMs, now)}` : ""));
    const iss = ctx.issueOf(a);
    const task: string | HTMLElement = iss ? link(`#${iss.number} ${iss.title}`, () => ctx.events.openUrl(iss.url)) : (a.task ?? "Not known");
    const timer = a.stateMs && now - a.stateMs > 20_000 && (a.state === "work" || a.state === "stuck") ? ` · ${clock(now - a.stateMs)}` : "";
    const parent = ctx.agentById(a.parent);
    const by: string | HTMLElement = parent ? link(ctx.nameOf(parent), () => ctx.select({ kind: "agent", id: parent.id })) : a.via ? (a.via === "Terminal" ? "You, in Terminal" : a.via) : "Not known";
    const kids = s.world!.agents.filter((k) => k.parent === a.id);
    const jobs = s.world!.jobs.filter((j) => j.agent === a.id);
    const fam = div("pfam");
    for (const k of kids) fam.append(link(ctx.nameOf(k), () => ctx.select({ kind: "agent", id: k.id })));
    if (a.helpers) fam.append(span("", `${a.helpers} ${plural(a.helpers, "helper")}`));
    for (const j of jobs) fam.append(span("", `${j.label}${j.bay ? " in a test bay" : ""}`));
    if (!fam.childElementCount) fam.textContent = "None";
    out.push(rows([["Task", task], ["Now", `${doing(a)}${timer}`], ["Started by", by], ["Family", fam]]));
    out.push(...doneList("Done so far", a.steps));
    if (talking && a.panel) {
      const input = document.createElement("input");
      input.className = "reply";
      input.type = "text";
      input.autocomplete = "off";
      input.placeholder = `Talk to ${ctx.nameOf(a)}. Enter sends.`;
      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          talking = false;
          paint();
        } else if (e.key === "Enter") {
          e.preventDefault();
          const words = input.value.trim();
          if (!words) return;
          void ctx.events.sendToAgent(a.panel!, words).then((ok) => {
            if (ok) input.value = "";
            ctx.toast(ok ? `Sent to ${ctx.nameOf(a)}.` : `${ctx.nameOf(a)}'s terminal did not take the text.`, !ok);
          });
        }
      });
      out.push(input);
    }
    const acts = div("pact");
    if (a.panel) {
      acts.append(button("opt", "Talk", () => {
        talking = !talking;
        paint();
      }));
      acts.append(button("opt", "Terminal", () => void (ctx.events.openTerminal(a.panel!) || ctx.toast("That terminal is gone.", true))));
    }
    if (a.session && a.harness === "claude") acts.append(button("opt", "History", () => ctx.events.openHistory(a.session!)));
    if (a.pid) acts.append(holdButton("Hold to Stop", () => void stopPid(a.pid!, ctx.nameOf(a))));
    out.push(acts);
    if (!a.panel) out.push(div("pnote", a.headless ? "It runs with nobody at it. Talk reaches it through the board." : "It runs outside Panel, so Panel cannot type into it."));
    return out;
  }

  function reportPanel(e: LiveEmber): HTMLElement[] {
    const now = Date.now();
    const o = e.outcome;
    const out: HTMLElement[] = [head(e.name ?? HARNESS[e.harness], [HARNESS[e.harness], short(e.model), ctx.roomName(e.room)].filter(Boolean).join(" · "), OUTCOME_COLOUR[o])];
    out.push(chipRow(OUTCOME_WORD[o], OUTCOME_COLOUR[o], `ended ${ago(e.endedMs, now)}`));
    if (e.result) out.push(div("presult", e.result));
    out.push(...doneList(`What it did · ${e.stepCount} ${plural(e.stepCount, "step")}`, e.steps));
    const list: [string, string | HTMLElement][] = [];
    if (e.task) list.push(["Task", e.task]);
    if (e.startedMs) list.push(["Ran", since(e.startedMs, e.endedMs)]);
    list.push(["Started by", e.parentName ?? (e.via === "Terminal" ? "You, in Terminal" : (e.via ?? "Not known"))]);
    if (e.files.length) {
      const files = div("pfam");
      for (const f of e.files.slice(0, 8)) files.append(link(f.split("/").slice(-2).join("/"), () => ctx.events.openFile(f)));
      list.push(["Files", files]);
    }
    out.push(rows(list));
    if (e.session && e.harness === "claude") {
      const acts = div("pact");
      acts.append(button("opt", "Open in History", () => ctx.events.openHistory(e.session!)));
      out.push(acts);
    }
    return out;
  }

  function roomPanel(key: string): HTMLElement[] {
    const w = s.world!;
    const here = w.agents.filter((a) => ctx.roomOf(a) === key).sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || a.id.localeCompare(b.id));
    const embers = w.embers.filter((e) => e.room === key).sort((a, b) => b.endedMs - a.endedMs);
    const b = s.board;
    const open = [...(b?.you ?? []), ...(b?.now ?? []), ...(b?.ready ?? []), ...(b?.waiting ?? [])].filter((i) => i.apps.includes(key));
    const out: HTMLElement[] = [head(ctx.roomName(key), `${here.length} ${plural(here.length, "agent")} · ${open.length} open ${plural(open.length, "issue")}`, null)];
    const list = (items: HTMLElement[], empty: string) => {
      const ul = document.createElement("ul");
      ul.className = "rlist";
      if (!items.length) ul.append(div("muted", empty));
      for (const it of items) {
        const li = document.createElement("li");
        li.append(it);
        ul.append(li);
      }
      return ul;
    };
    const rowBtn = (colour: string, name: string, text: string, run: () => void) => {
      const r = button("rowbtn", "", run);
      const i = document.createElement("i");
      i.style.setProperty("--c", colour);
      const bold = document.createElement("b");
      bold.textContent = name;
      r.append(i, bold, span("", text));
      return r;
    };
    out.push(div("psec", "Now"), list(here.map((a) => rowBtn(`var(--l-${a.state})`, ctx.nameOf(a), doing(a), () => ctx.select({ kind: "agent", id: a.id }))), "Nobody here now"));
    out.push(div("psec", "Recently"), list(embers.slice(0, 5).map((e) => rowBtn(OUTCOME_COLOUR[e.outcome], e.name ?? HARNESS[e.harness], e.result ?? OUTCOME_WORD[e.outcome], () => ctx.select({ kind: "ember", id: e.id }))), "Nothing yet today"));
    out.push(div("psec", "Open issues"), list(open.slice(0, 6).map((i) => rowBtn("var(--l-ink-3)", `#${i.number}`, i.title, () => ctx.events.openUrl(i.url))), "No open issues"));
    return out;
  }

  async function stopPid(pid: number, who: string): Promise<void> {
    try {
      await ctx.events.stop(pid);
      ctx.toast(`Asked ${who} to stop.`);
      ctx.poll();
    } catch (e) {
      ctx.toast(`Could not stop ${who}: ${errorText(e, "refused")}`, true);
    }
  }

  return { paint };
}
