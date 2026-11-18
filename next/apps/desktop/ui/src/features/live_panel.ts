/**
 * The panel for a dot, an ember or a district. It takes the column beside the map while it is
 * open, so it never covers the map. Copied from the concept page: `agentHTML` line 1153,
 * `reportHTML` line 1162, `roomHTML` line 1172, and `.apanel` in its CSS. A district's panel
 * lists agents only: the board's issues are on the Board.
 */

import { errorText } from "../errors";
import { RESULTS } from "./live_playbook";
import { ageOf, ago, button, div, doing, hhmm, holdButton, lensName, OUTCOME_COLOUR, OUTCOME_WORD, plural, since, span, startedBy, STATE_RANK, STATE_WORD, taskLine, unitName } from "./live_text";
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
      // Only steps whose ending is news get a mark, as on the map. A failed `grep` is not news.
      const mark = st.ok !== undefined && st.verb && RESULTS[st.verb] ? span(`pres ${st.ok ? "is-ok" : "is-bad"}`, st.ok ? "✓" : "✗") : null;
      if (mark) mark.title = RESULTS[st.verb!][st.ok ? 0 : 1];
      li.append(t, st.file ? link(st.label, () => ctx.events.openFile(st.file!)) : span("", st.label));
      if (mark) li.append(mark);
      ol.append(li);
    }
    return [div("psec", title), ol];
  }

  function agentPanel(a: LiveAgent): HTMLElement[] {
    const now = Date.now();
    const room = ctx.roomName(ctx.roomOf(a));
    const me = ctx.whoOf(a);
    const out: HTMLElement[] = [head(me.title, `${me.sub} · ${room}`, `var(--l-${a.state})`)];
    out.push(chipRow(STATE_WORD[a.state], `var(--l-${a.state})`, a.startedMs ? `running ${since(a.startedMs, now)}` : ""));
    const iss = ctx.issueOf(a);
    const task: string | HTMLElement = iss ? link(`#${iss.number} ${iss.title}`, () => ctx.events.openUrl(iss.url)) : (taskLine(a.task) ?? (a.task ? me.role : "Not known"));
    const age = ageOf(a, now);
    const parent = ctx.agentById(a.parent);
    const by: string | HTMLElement = parent ? link(ctx.nameOf(parent), () => ctx.select({ kind: "agent", id: parent.id })) : startedBy(a.via);
    const kids = s.world!.agents.filter((k) => k.parent === a.id);
    const jobs = s.world!.jobs.filter((j) => j.agent === a.id);
    const fam = div("pfam");
    // A subagent reads as its job and what it does now, so the parent's panel shows its whole crew.
    for (const k of kids) fam.append(link(k.helperKind ? `${k.task ?? ctx.nameOf(k)} · ${doing(k)}` : ctx.nameOf(k), () => ctx.select({ kind: "agent", id: k.id })));
    if (a.helpers) fam.append(span("", `${a.helpers} ${plural(a.helpers, "helper")}`));
    for (const j of jobs) fam.append(span("", `${j.label}${j.bay ? " in a test bay" : ""}`));
    // A unit's issues are its mission card's, below.
    const list: [string, string | HTMLElement][] = [...(a.fleet ? [] : [["Task", task] as [string, string | HTMLElement]]), ["Now", `${doing(a)}${age ? ` · ${a.state === "turn" ? `waiting ${age}` : age}` : ""}`]];
    // Stuck or waiting, its own last words are the best clue to why.
    if ((a.state === "stuck" || a.state === "turn") && a.lastText && a.lastText !== doing(a)) list.push(["Last said", a.lastText]);
    const res = s.results.get(a.id);
    if (res && res.until > now) list.push(["Result", `${res.ok ? "✓" : "✗"} ${res.text}`]);
    // A unit's class and id are its subtitle already. Its mission card says the rest.
    if (!a.fleet) list.push(["Started by", by]);
    if (a.commander) list.push(["Commands", `${s.world!.agents.filter((x) => x.fleet).length} fleet units`]);
    if (fam.childElementCount) list.push(["Helpers", fam]);
    out.push(rows(list));
    if (a.fleet) out.push(...unitParts(a));
    out.push(...doneList("Steps", a.steps));
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
      // Waiting for you, talking is the one thing to do, so it says so.
      acts.append(button(a.state === "turn" ? "opt is-primary" : "opt", a.state === "turn" ? "Answer" : "Talk", () => {
        talking = !talking;
        paint();
      }));
      acts.append(button("opt", "Terminal", () => void (ctx.events.openTerminal(a.panel!) || ctx.toast("That terminal is gone.", true))));
    }
    if (!a.panel && iss) acts.append(button("opt", `Open #${iss.number}`, () => ctx.events.openUrl(iss.url)));
    if (a.session && a.harness === "claude") acts.append(button("opt", "History", () => ctx.events.openHistory(a.session!)));
    // A unit ends through its commander, whose `fleet end` hands its issue on. A killed process
    // would leave the issue held.
    if (a.fleet) {
      const attach = `tmux -L fleet attach -t ${a.fleet.kind}-${a.fleet.unit}`;
      acts.append(
        button("opt", "Copy attach", () =>
          void navigator.clipboard?.writeText(attach).then(
            () => ctx.toast(`Copied: ${attach}`),
            () => ctx.toast("Could not copy the command.", true),
          ),
        ),
      );
    } else if (a.pid) acts.append(holdButton("Hold to Stop", () => void stopPid(a.pid!, ctx.nameOf(a))));
    out.push(acts);
    if (a.fleet) out.push(div("pnote", "It runs in tmux. Copy attach and paste it in a terminal to watch it live. Ctrl-b d leaves it running."));
    else if (!a.panel)
      out.push(
        div(
          "pnote",
          a.headless
            ? iss
              ? `No terminal to type into. A comment on #${iss.number} reaches it.`
              : "No terminal to type into. Stop it, or let it finish."
            : "It runs in a terminal outside Panel. Answer it there.",
        ),
      );
    return out;
  }

  /**
   * A unit's mission card: its issues, its time against the budget, what it read, its flags, the
   * last lines of its screen, and a line to its commander. Owner, 2026-11-18: he steers the fleet
   * through its commander, so the words go there, never to the unit.
   */
  function unitParts(a: LiveAgent): HTMLElement[] {
    const f = a.fleet!;
    const now = Date.now();
    const view = ctx.s.fleet?.units?.find((u) => u.id === f.unit);
    const out: HTMLElement[] = [div("psec", f.scout ? "Scout run" : "Mission")];
    if (f.issues.length) {
      const miss = div("pmission");
      for (const m of f.issues) {
        const known = ctx.issueOf(a)?.number === m.number ? ctx.issueOf(a) : undefined;
        const url = known?.url ?? `https://github.com/Appgea/ops/issues/${m.number}`;
        miss.append(link(`#${m.number} ${m.title}`, () => ctx.events.openUrl(url)));
      }
      out.push(miss);
    } else if (f.scout) out.push(div("presult", `${lensName(f.scout)}${f.scout.includes("@") ? ` in ${f.scout.split("@")[1]}` : ""}. It files what it finds and builds nothing.`));
    const used = f.startedMs ? (now - f.startedMs) / 60_000 : 0;
    const over = f.flags.includes("OVER") || (f.budget > 0 && used > f.budget);
    const meter = div(`pbudget${over ? " is-over" : ""}`);
    const bar = span("pbudget-bar");
    const fillEl = document.createElement("i");
    fillEl.style.width = `${Math.round(Math.min(1, f.budget ? used / f.budget : 0) * 100)}%`;
    bar.append(fillEl);
    meter.append(span("pbudget-text", `${Math.round(used)} of ${f.budget} min${over ? " · over budget" : ""}`), bar);
    out.push(meter);
    const facts: string[] = [];
    if (view?.tokens) facts.push(`${view.tokens} tokens read`);
    if (view && view.quiet > 0) facts.push(`screen quiet ${view.quiet} min`);
    if (facts.length) out.push(div("pnote", facts.join(" · ")));
    if (f.flags.length) {
      const flags = div("pflags");
      for (const fl of f.flags) flags.append(span("chip is-flag", fl === "OVER" ? "Over budget" : fl === "STUCK" ? "Stuck" : fl));
      out.push(flags);
    }
    // The screen's last lines, without the TUI's rules and boxes.
    const lines = (view?.screen ?? "").split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l && !/^[\s╹╻▀▄█■⬝─│┃━┏┓┗┛╭╮╰╯═║▔▁·.]*$/.test(l));
    if (lines.length) {
      out.push(div("psec", "Screen"));
      const pre = document.createElement("pre");
      pre.className = "pscreen";
      pre.textContent = lines.slice(-14).join("\n");
      out.push(pre);
    }
    const input = document.createElement("input");
    input.className = "reply";
    input.type = "text";
    input.autocomplete = "off";
    // Short enough for the column at its narrowest. The Enter hint is in the tooltip.
    input.placeholder = "Tell the commander about it";
    input.title = "Your words go to the commander, naming this unit. Enter sends.";
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const words = input.value.trim();
      if (!words) return;
      const mission = f.issues[0] ? `#${f.issues[0].number} ${f.issues[0].title}` : f.scout ? `scout ${f.scout}` : "no issue";
      void steer(`About ${unitName(f.kind, f.unit)} (unit ${f.unit}, ${mission}): ${words}`).then((how) => {
        if (how !== "failed") input.value = "";
        ctx.toast(how === "sent" ? "Sent to the commander." : how === "copied" ? "The commander runs outside Panel. Your words are copied: paste them in its terminal." : "No commander terminal took it.", how === "failed");
      });
    });
    out.push(input);
    return out;
  }

  /**
   * His words to the commander: into the commander's own Panel terminal when it has one. A
   * commander that runs outside Panel gets them on the clipboard: Panel cannot type into it, and
   * a second commander would fight the first over the same units. With no commander on the map,
   * the Board's Overview way starts one.
   */
  async function steer(words: string): Promise<"sent" | "copied" | "failed"> {
    const order = `The owner steers the fleet from Panel's Live: "${words}"`;
    const boss = s.world?.agents.find((x) => x.commander);
    if (boss?.panel) return (await ctx.events.sendToAgent(boss.panel, order)) ? "sent" : "failed";
    if (boss) {
      const ok = await navigator.clipboard?.writeText(order).then(() => true, () => false);
      return ok ? "copied" : "failed";
    }
    return (await ctx.events.tellCommander(words)) ? "sent" : "failed";
  }

  function reportPanel(e: LiveEmber): HTMLElement[] {
    const now = Date.now();
    const o = e.outcome;
    const me = ctx.emberWho(e);
    const out: HTMLElement[] = [head(me.title, `${me.sub} · ${ctx.roomName(e.room)}`, OUTCOME_COLOUR[o])];
    out.push(chipRow(OUTCOME_WORD[o], OUTCOME_COLOUR[o], `ended ${ago(e.endedMs, now)}`));
    // With no result written, the step it was on is the clue to what went wrong.
    if (e.result) out.push(div("presult", e.result));
    else if (o !== "done" && e.steps[0]) out.push(div("presult", `Its last step: ${e.steps[0].label}`));
    out.push(...doneList(`What it did · ${e.stepCount} ${plural(e.stepCount, "step")}`, e.steps));
    const list: [string, string | HTMLElement][] = [];
    const task = taskLine(e.task);
    if (task) list.push(["Task", task]);
    if (e.startedMs) list.push(["Ran", since(e.startedMs, e.endedMs)]);
    list.push(["Started by", e.parentName ?? startedBy(e.via)]);
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
    const out: HTMLElement[] = [head(ctx.roomName(key), `${here.length} ${plural(here.length, "agent")} running`, null)];
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
    out.push(div("psec", "Recently"), list(embers.slice(0, 5).map((e) => rowBtn(OUTCOME_COLOUR[e.outcome], ctx.emberWho(e).title, e.result ?? OUTCOME_WORD[e.outcome], () => ctx.select({ kind: "ember", id: e.id }))), "Nothing yet today"));
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
