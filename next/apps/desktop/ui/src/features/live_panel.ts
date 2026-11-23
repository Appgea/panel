
import { errorText } from "../errors";
import { trim } from "./live_history";
import { kindOf, PHASE_WORD, phaseOf, ROLE, roleName, roleOf, workOf } from "./live_roles";
import { ageOf, ago, appName, button, cap, div, doing, hhmm, holdButton, lensName, OUTCOME_COLOUR, OUTCOME_WORD, plural, since, span, startedBy, STATE_RANK, STATE_WORD, taskLine, unitName } from "./live_text";
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
    for (const r of trim(steps)) {
      const li = document.createElement("li");
      if (r.folded) li.className = "is-folded";
      const t = document.createElement("time");
      t.textContent = hhmm(r.atMs);
      li.append(t, r.file ? link(r.text, () => ctx.events.openFile(r.file!)) : span("", r.text));
      if (r.mark) li.append(span(`pres is-${r.mark}`, r.mark === "ok" ? "✓" : "✗"));
      ol.append(li);
    }
    return [div("psec", title), ol];
  }

  const label = (a: LiveAgent): string => (a.fleet ? `${roleName(a)} ${a.fleet.unit}` : roleName(a));

  function agentPanel(a: LiveAgent): HTMLElement[] {
    const now = Date.now();
    const room = ctx.roomName(ctx.roomOf(a));
    const role = roleOf(a);
    const work = workOf(a, ctx.issueOf(a), room);
    const out: HTMLElement[] = [head(`${work.number ? `#${work.number} ` : ""}${work.title}`, [roleName(a), kindOf(a).name, room].join(" · "), `var(--l-${a.state})`)];
    const phase = role === "scout" || role === "checker" ? "" : ` · ${PHASE_WORD[phaseOf(a)].toLowerCase()} phase`;
    out.push(chipRow(STATE_WORD[a.state], `var(--l-${a.state})`, a.startedMs ? `running ${since(a.startedMs, now)}${phase}` : ""));
    out.push(div("pnote", ROLE[role].what));
    const iss = ctx.issueOf(a);
    const age = ageOf(a, now);
    const parent = ctx.agentById(a.parent);
    const by: string | HTMLElement = parent ? link(label(parent), () => ctx.select({ kind: "agent", id: parent.id })) : startedBy(a.via);
    const kids = s.world!.agents.filter((k) => k.parent === a.id);
    const jobs = s.world!.jobs.filter((j) => j.agent === a.id);
    const fam = div("pfam");
    for (const k of kids) fam.append(link(k.helperKind ? `${k.task ?? label(k)} · ${doing(k)}` : label(k), () => ctx.select({ kind: "agent", id: k.id })));
    if (a.helpers) fam.append(span("", `${a.helpers} ${plural(a.helpers, "helper")}`));
    for (const j of jobs) fam.append(span("", `${j.label}${j.bay ? " in a test bay" : ""}`));
    const list: [string, string | HTMLElement][] = [["Now", `${doing(a)}${age ? ` · ${a.state === "turn" ? `waiting ${age}` : age}` : ""}`]];
    if ((a.state === "stuck" || a.state === "turn") && a.lastText && a.lastText !== doing(a)) list.push(["Last said", a.lastText]);
    const res = s.results.get(a.id);
    if (res && res.until > now) list.push(["Result", `${res.ok ? "✓" : "✗"} ${res.text}`]);
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
      input.placeholder = `Talk to ${label(a)}. Enter sends.`;
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
            ctx.toast(ok ? `Sent to ${label(a)}.` : `${label(a)}'s terminal did not take the text.`, !ok);
          });
        }
      });
      out.push(input);
    }
    const acts = div("pact");
    if (a.panel) {
      acts.append(button(a.state === "turn" ? "opt is-primary" : "opt", a.state === "turn" ? "Answer" : "Talk", () => {
        talking = !talking;
        paint();
      }));
      acts.append(button("opt", "Terminal", () => void (ctx.events.openTerminal(a.panel!) || ctx.toast("That terminal is gone.", true))));
    }
    if (!a.panel && iss) acts.append(button("opt", `Open #${iss.number}`, () => ctx.events.openUrl(iss.url)));
    if (a.session && a.harness === "claude") acts.append(button("opt", "History", () => ctx.events.openHistory(a.session!)));
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
    } else if (a.pid) acts.append(holdButton("Hold to Stop", () => void stopPid(a.pid!, label(a))));
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
    } else if (f.scout) {
      const facts: [string, string][] = [["Lens", lensName(f.scout)]];
      if (f.ability) facts.push(["Ability", cap(f.ability.replace(/-/g, " "))]);
      if (f.scout.includes("@")) facts.push(["App", appName(f.scout.split("@")[1])]);
      if (f.question) facts.push(["Asks", f.question]);
      out.push(rows(facts));
    }
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
    const out: HTMLElement[] = [head(taskLine(e.task) ?? me.role, `${me.role} · ${ctx.roomName(e.room)}`, OUTCOME_COLOUR[o])];
    out.push(chipRow(OUTCOME_WORD[o], OUTCOME_COLOUR[o], `ended ${ago(e.endedMs, now)}`));
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
    out.push(div("psec", "Now"), list(here.map((a) => rowBtn(`var(--l-${a.state})`, label(a), doing(a), () => ctx.select({ kind: "agent", id: a.id }))), "Nobody here now"));
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
