import "./fleet_design.css";
import { art, crest } from "./game_art";

export type DesignItem = {
  type: "bot" | "lens" | "routine" | "ability" | "kind";
  id: string;
  title: string;
  meta: [string, string][];
  body: string;
  path: string;
  sig: string;
  family?: string;
  paused?: string;
  learned?: number;
  script?: boolean;
};
export type DesignData = {
  bots?: DesignItem[];
  runnable?: string[];
  lenses?: DesignItem[];
  routines?: DesignItem[];
  abilities?: DesignItem[];
  kinds?: DesignItem[];
  undo?: { what: string; at: number } | null;
  refused?: string;
  undone?: string;
  error?: string;
};
export type DesignEvents = {
  load(): Promise<DesignData>;
  send(route: "save" | "delete" | "undo", body: unknown): Promise<DesignData>;
};
export type DesignHandle = { open(): void; dispose(): void };

type Type = DesignItem["type"];
type Field = { key: string; label: string; hint: string; long?: boolean; options?: string[]; colour?: boolean; plays?: boolean };

const NOUN: Record<Type, string> = { bot: "bot", lens: "lens", routine: "routine", ability: "scout ability", kind: "builder ability" };
const ROLES = ["builder", "scout", "checker"];

const FIELDS: Record<Type, Field[]> = {
  bot: [
    { key: "Character", label: "Character", hint: "Who it is, in a few words. Every unit of this bot reads it first.", long: true },
    { key: "Angle", label: "Angle", hint: "The work it is best at, and how it goes at it. Units read this too.", long: true },
    { key: "Limits", label: "Limits", hint: "What it must hand on.", long: true },
    { key: "Engine", label: "Engine", hint: "The CLI and model it runs on." },
    { key: "Plays", label: "Plays", hint: "The roles it takes.", plays: true },
    { key: "Colour", label: "Colour", hint: "Its hue on this screen.", colour: true },
  ],
  lens: [
    { key: "title", label: "Title", hint: "One plain line." },
    { key: "who", label: "Who", hint: "The one person this lens looks as, at which stage, and the evidence only it reads.", long: true },
    { key: "every", label: "Runs", hint: "routine: once a round. manual: only when started by name.", options: ["routine", "manual", "daily"] },
    { key: "priority", label: "Priority", hint: "P0 and P1 come first in a round.", options: ["", "P0", "P1", "P2", "P3"] },
    { key: "agent", label: "Agent", hint: "The session kind that runs it.", options: ["claude", "codex", "opencode"] },
    { key: "kinds", label: "Bots", hint: "Only these bots may run it, like sonnet,opus. Empty: any." },
  ],
  routine: [
    { key: "title", label: "Title", hint: "One plain line." },
    { key: "every", label: "Runs", hint: "routine, manual, daily, a weekday, or hours like 3h." },
    { key: "agent", label: "Agent", hint: "The session kind that runs it." },
    { key: "run", label: "Script", hint: "A shell command run instead of an agent. No AI." },
  ],
  ability: [
    { key: "title", label: "Question", hint: "One question, in plain words, that the code can answer with yes or no." },
    { key: "family", label: "Lens", hint: "The one lens it belongs to. That lens's list of abilities follows it." },
    { key: "parts", label: "Parts", hint: "App parts it reads, like purchase, ads. Empty: every app." },
    { key: "goal", label: "Goal", hint: "The direction.md goal it serves.", options: ["", "1", "2", "3"] },
    { key: "agent", label: "Agent", hint: "The session kind that runs it.", options: ["claude", "codex", "opencode"] },
    { key: "needs", label: "Needs", hint: "browser, when it needs the signed-in Chrome.", options: ["", "browser"] },
  ],
  kind: [
    { key: "When", label: "When", hint: "What Jev reads to pick this kind. Name the neighbour kind and the border.", long: true },
    { key: "Read", label: "Read", hint: "Skill names or files under ~/.appgeapanel/skills, or none." },
    { key: "Pick", label: "Pick", hint: "Folders Jev may add up to two files from." },
  ],
};

const DOC_HINT: Record<Type, string> = {
  bot: "Notes for the commander. Who may run what stays in references/mix.md.",
  lens: "What to look at and what counts as a finding. Say where this lens ends and which one starts there.",
  routine: "What the routine does, step by step.",
  ability: "Exact steps for the smallest model: each one a command and what to write down. Learned lines go last.",
  kind: "The method, as bullets. A small model builds from this card alone.",
};

const TEMPLATE: Record<Type, { meta: [string, string][]; body: string }> = {
  bot: { meta: [["Character", ""], ["Angle", ""], ["Limits", ""], ["Engine", ""], ["Plays", "builder"], ["Colour", "#7b7bd6"]], body: "" },
  lens: { meta: [["title", ""], ["who", ""], ["every", "routine"], ["agent", "claude"]], body: "\nLens: who you look as, and the one thing you look at.\n\nAbilities, in `scouts/abilities/`:\n\nA finding: \nNot a finding: \n" },
  routine: { meta: [["title", ""], ["every", "manual"], ["agent", "claude"]], body: "\n" },
  ability: { meta: [["title", ""], ["family", ""], ["agent", "claude"]], body: "\nLens: who you look as, and the one thing you look at. Read only.\n\n1. \n\nA finding: \nNot a finding: \nClose with `--learned \"<app>: <facts>\"`.\n\n## Learned\n" },
  kind: { meta: [["When", ""], ["Read", "none"]], body: "- " },
};

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text) el.textContent = text;
  return el;
};
const button = (cls: string, text: string, onClick: () => void, title = ""): HTMLButtonElement => {
  const b = h("button", cls, text);
  b.type = "button";
  if (title) {
    b.title = title;
    b.setAttribute("aria-label", title);
  }
  b.addEventListener("click", onClick);
  return b;
};
const get = (meta: [string, string][], key: string): string => meta.find(([k]) => k === key)?.[1] ?? "";
const keyOf = (it: { type: Type; id: string }): string => `${it.type}:${it.id}`;
const human = (id: string): string => (id ? id[0].toUpperCase() + id.slice(1).replace(/-/g, " ") : "");
const firstSentence = (s: string): string => s.split(/(?<=\.)\s|\n/)[0] ?? "";
const copy = (meta: [string, string][]): [string, string][] => meta.map(([a, b]) => [a, b]);

type Draft = { item: DesignItem; meta: [string, string][]; body: string; id: string; isNew: boolean };
type Tab = "profile" | "docs";

export function mountDesign(root: HTMLElement, events: DesignEvents): DesignHandle {
  let data: DesignData = {};
  let selected = "";
  let draft: Draft | null = null;
  let tab: Tab = "profile";
  let reading = true;
  let query = "";
  let busy = false;
  let removeArmed = "";
  let toastTimer: number | undefined;
  const open = new Set<string>();
  const shut = new Set<string>(["g:routines"]);

  const rail = h("aside", "fd-rail");
  const search = h("input", "fd-search");
  search.type = "search";
  search.placeholder = "Search bots, lenses, abilities";
  search.setAttribute("aria-label", "Search the fleet design");
  search.addEventListener("input", () => {
    query = search.value.trim().toLowerCase();
    paintList();
  });
  const home = button("fd-home", "Overview", () => {
    if (dirty()) return nudge();
    draft = null;
    selected = "";
    paintList();
    paintMain();
  });
  const list = h("nav", "fd-list");
  list.setAttribute("aria-label", "Fleet design");
  rail.append(search, home, list);
  const main = h("section", "fd-main");
  const toast = h("div", "fd-toast");
  toast.hidden = true;
  toast.setAttribute("role", "status");
  root.replaceChildren(rail, main, toast);
  root.classList.add("fd");

  const all = (): DesignItem[] => [...(data.bots ?? []), ...(data.lenses ?? []), ...(data.routines ?? []), ...(data.abilities ?? []), ...(data.kinds ?? [])];
  const find = (k: string): DesignItem | undefined => all().find((it) => keyOf(it) === k);
  const abilitiesOf = (lens: string): DesignItem[] => (data.abilities ?? []).filter((a) => a.family === lens);
  const dirty = (): boolean => {
    if (!draft) return false;
    if (draft.isNew) return true;
    return draft.body !== draft.item.body || JSON.stringify(draft.meta) !== JSON.stringify(draft.item.meta);
  };

  function say(text: string, undoable = false, bad = false): void {
    window.clearTimeout(toastTimer);
    toast.replaceChildren(h("span", "", text));
    toast.classList.toggle("is-bad", bad);
    if (undoable) toast.append(button("fd-toast-undo", "Undo", () => void undo()));
    toast.hidden = false;
    toastTimer = window.setTimeout(() => (toast.hidden = true), bad ? 9000 : 7000);
  }

  function nudge(): void {
    say("Save or discard your changes first.", false, true);
    const b = main.querySelector(".fd-bar");
    b?.classList.add("is-nudge");
    window.setTimeout(() => b?.classList.remove("is-nudge"), 600);
  }

  function avatar(it: { type: Type; id: string; meta: [string, string][] }, size = ""): HTMLElement {
    if (it.type === "bot") {
      const el = art(`fd-avatar is-bot ${size}`, crest(it.id));
      const colour = get(it.meta, "Colour");
      if (colour) el.style.setProperty("--c", colour);
      return el;
    }
    const letters = it.id.split("-").map((w) => w[0] ?? "").join("").slice(0, 2).toUpperCase() || "+";
    return h("span", `fd-avatar is-${it.type} ${size}`, letters);
  }

  function row(it: DesignItem, child = false): HTMLElement {
    const k = keyOf(it);
    const b = h("button", `fd-row${child ? " is-child" : ""}${k === selected ? " is-on" : ""}`);
    b.type = "button";
    const text = h("span", "fd-row-text");
    text.append(h("b", "", it.type === "bot" ? human(it.id) : it.id), h("span", "", it.type === "bot" ? firstSentence(it.title) : it.title));
    b.append(avatar(it, "is-small"), text);
    if (it.paused) b.append(h("span", "fd-tag is-paused", "Paused"));
    if (it.type === "bot" && data.runnable && !data.runnable.includes(it.id)) b.append(h("span", "fd-tag", "Not in fleet"));
    b.addEventListener("click", () => pick(k));
    return b;
  }

  function group(id: string, label: string, count: number, adds: [Type, string][], rows: HTMLElement[]): HTMLElement {
    const g = h("div", "fd-group");
    const head = h("div", "fd-group-head");
    const folded = shut.has(id) && !query;
    const fold = button("fd-fold", "", () => {
      if (shut.has(id)) shut.delete(id);
      else shut.add(id);
      paintList();
    });
    fold.setAttribute("aria-expanded", String(!folded));
    fold.append(h("span", `fd-caret${folded ? "" : " is-open"}`, "›"), h("span", "", label), h("em", "", String(count)));
    head.append(fold);
    for (const [type, title] of adds) head.append(button("fd-add", `+ ${type === "kind" || type === "ability" ? "ability" : type}`, () => create(type), title));
    g.append(head);
    if (!folded) g.append(...rows);
    return g;
  }

  const matches = (it: DesignItem): boolean => !query || `${it.id} ${it.meta.map(([, v]) => v).join(" ")}`.toLowerCase().includes(query);

  function paintList(): void {
    const scroll = list.scrollTop;
    home.classList.toggle("is-on", !draft);
    const bots = (data.bots ?? []).filter(matches);
    const lensRows: HTMLElement[] = [];
    for (const lens of data.lenses ?? []) {
      const kids = abilitiesOf(lens.id).filter(matches);
      if (!matches(lens) && !kids.length) continue;
      const wrap = h("div", "fd-lens");
      const r = row(lens);
      const n = abilitiesOf(lens.id).length;
      const shown = open.has(lens.id) || (!!query && kids.length > 0);
      if (n) {
        const fold = h("span", `fd-kids${shown ? " is-open" : ""}`, String(n));
        fold.title = shown ? "Hide its abilities" : `Show its ${n} abilities`;
        fold.addEventListener("click", (e) => {
          e.stopPropagation();
          if (open.has(lens.id)) open.delete(lens.id);
          else open.add(lens.id);
          paintList();
        });
        r.append(fold);
      }
      wrap.append(r);
      if (shown) wrap.append(...(query ? kids : abilitiesOf(lens.id)).map((a) => row(a, true)));
      lensRows.push(wrap);
    }
    const lensIds = new Set((data.lenses ?? []).map((l) => l.id));
    const orphans = (data.abilities ?? []).filter((a) => !lensIds.has(a.family ?? "") && matches(a));
    const routines = (data.routines ?? []).filter(matches);
    const kinds = (data.kinds ?? []).filter(matches);
    const crew = (text: string, sub: string) => {
      const p = h("p", "fd-crew");
      p.append(h("b", "", text), h("span", "", sub));
      return p;
    };
    list.replaceChildren(
      group("g:bots", "Bots", bots.length, [["bot", "New bot"]], bots.map((b) => row(b))),
      crew("Scouts", "find and file work"),
      group("g:lenses", "Lenses", lensRows.length, [["lens", "New lens"], ["ability", "New scout ability"]], lensRows),
      ...(orphans.length ? [group("g:orphans", "Abilities with no lens", orphans.length, [], orphans.map((a) => row(a)))] : []),
      group("g:routines", "Routines", routines.length, [["routine", "New routine"]], routines.map((r) => row(r))),
      crew("Builders", "build what scouts file"),
      group("g:kinds", "Abilities", kinds.length, [["kind", "New builder ability"]], kinds.map((k) => row(k))),
    );
    list.scrollTop = scroll;
  }

  function pick(k: string): void {
    if (k === selected && draft && !draft.isNew) return;
    if (dirty()) return nudge();
    const it = find(k);
    if (!it) return;
    selected = k;
    draft = { item: it, meta: copy(it.meta), body: it.body, id: it.id, isNew: false };
    removeArmed = "";
    if (it.type === "ability" && it.family) open.add(it.family);
    paintList();
    paintMain();
  }

  function create(type: Type): void {
    if (dirty()) return nudge();
    const t = TEMPLATE[type];
    const meta = copy(t.meta);
    const now = find(selected);
    if (type === "ability") meta[1][1] = now?.type === "lens" ? now.id : now?.type === "ability" ? now.family ?? "" : "";
    const item: DesignItem = { type, id: "", title: "", meta, body: t.body, path: "", sig: "" };
    selected = `${type}:`;
    draft = { item, meta, body: t.body, id: "", isNew: true };
    tab = "profile";
    paintList();
    paintMain();
    main.querySelector<HTMLInputElement>(".fd-id")?.focus();
  }

  function setMeta(k: string, v: string): void {
    if (!draft) return;
    const at = draft.meta.findIndex(([a]) => a === k);
    if (at >= 0) draft.meta[at] = [k, v];
    else draft.meta.push([k, v]);
    paintBar();
  }

  function select(options: [string, string][], value: string, onChange: (v: string) => void, label: string): HTMLSelectElement {
    const s = h("select", "fd-input");
    s.setAttribute("aria-label", label);
    for (const [v, text] of options) {
      const o = h("option", "", text);
      o.value = v;
      s.append(o);
    }
    s.value = value;
    s.addEventListener("change", () => onChange(s.value));
    return s;
  }

  function fieldInput(f: Field, value: string): HTMLElement {
    if (f.plays) {
      const wrap = h("div", "fd-chips");
      const on = new Set(value.split(",").map((s) => s.trim()).filter(Boolean));
      for (const r of ROLES) {
        const c = button(`fd-chip${on.has(r) ? " is-on" : ""}`, r, () => {
          if (on.has(r)) on.delete(r);
          else on.add(r);
          c.classList.toggle("is-on", on.has(r));
          c.setAttribute("aria-pressed", String(on.has(r)));
          setMeta(f.key, ROLES.filter((x) => on.has(x)).join(", "));
        });
        c.setAttribute("aria-pressed", String(on.has(r)));
        wrap.append(c);
      }
      return wrap;
    }
    if (f.colour) {
      const wrap = h("div", "fd-colour");
      const c = h("input");
      c.type = "color";
      c.value = /^#[0-9a-f]{6}$/i.test(value) ? value : "#7b7bd6";
      c.setAttribute("aria-label", f.label);
      const code = h("code", "", value || "none");
      c.addEventListener("input", () => {
        setMeta(f.key, c.value);
        code.textContent = c.value;
        main.querySelector<HTMLElement>(".fd-hero .fd-avatar")?.style.setProperty("--c", c.value);
      });
      wrap.append(c, code);
      return wrap;
    }
    if (f.key === "family") {
      return select([["", "Pick a lens"], ...(data.lenses ?? []).map((l): [string, string] => [l.id, l.id])], value, (v) => setMeta(f.key, v), f.label);
    }
    if (f.options && (f.options.includes(value) || !value)) {
      return select(f.options.map((o): [string, string] => [o, o || "None"]), value, (v) => setMeta(f.key, v), f.label);
    }
    const input = f.long || value.length > 70 ? h("textarea", "fd-input is-long") : h("input", "fd-input");
    input.value = value;
    if (input instanceof HTMLTextAreaElement) input.rows = Math.min(6, Math.max(2, Math.ceil(value.length / 64)));
    input.addEventListener("input", () => setMeta(f.key, input.value));
    return input;
  }

  function profile(d: Draft): HTMLElement {
    const box = h("div", "fd-profile");
    const known = FIELDS[d.item.type];
    const card = h("div", "fd-card");
    for (const f of known) {
      const lab = h("label", "fd-field");
      lab.append(h("span", "fd-label", f.label), fieldInput(f, get(d.meta, f.key)), h("span", "fd-hint", f.hint));
      card.append(lab);
    }
    box.append(card);
    const paused = get(d.meta, "paused");
    if (d.item.type === "ability" && paused) {
      const p = h("div", "fd-paused");
      p.append(h("span", "", `Paused: ${paused}`), button("fd-btn is-ghost", "Resume", () => {
        if (!draft) return;
        draft.meta = draft.meta.filter(([k]) => k !== "paused");
        paintMain();
      }));
      box.append(p);
    }
    const free = d.item.type !== "bot" && d.item.type !== "kind";
    const extra = d.meta.filter(([k]) => !known.some((f) => f.key === k) && k !== "paused");
    if (extra.length || free) {
      const more = h("div", "fd-card");
      more.append(h("p", "fd-card-head", "More keys"));
      for (const [k, v] of extra) {
        const line = h("div", "fd-kv");
        const val = h("input", "fd-input");
        val.value = v;
        val.setAttribute("aria-label", k);
        val.addEventListener("input", () => setMeta(k, val.value));
        line.append(h("code", "", k), val, button("fd-x", "×", () => {
          if (!draft) return;
          draft.meta = draft.meta.filter(([a]) => a !== k);
          paintMain();
        }, `Remove ${k}`));
        more.append(line);
      }
      if (free) {
        const add = h("div", "fd-kv is-new");
        const kIn = h("input", "fd-input");
        kIn.placeholder = "key";
        kIn.setAttribute("aria-label", "New key");
        const vIn = h("input", "fd-input");
        vIn.placeholder = "value";
        vIn.setAttribute("aria-label", "New value");
        add.append(kIn, vIn, button("fd-btn is-ghost", "Add", () => {
          const k = kIn.value.trim();
          if (!/^[A-Za-z][\w-]*$/.test(k)) return say("A key is letters, digits and dashes.", false, true);
          setMeta(k, vIn.value.trim());
          paintMain();
        }));
        more.append(add);
      }
      box.append(more);
    }
    if (d.item.type === "lens" && !d.isNew) {
      const kids = abilitiesOf(d.item.id);
      const c = h("div", "fd-card");
      const head = h("div", "fd-card-row");
      head.append(h("p", "fd-card-head", `Abilities · ${kids.length}`), button("fd-btn is-ghost", "New ability", () => create("ability")));
      c.append(head);
      const grid = h("div", "fd-minis");
      for (const a of kids) {
        const m = button("fd-mini", "", () => pick(keyOf(a)));
        m.append(h("b", "", a.id), h("span", "", a.title));
        if (a.paused) m.append(h("span", "fd-tag is-paused", "Paused"));
        grid.append(m);
      }
      if (!kids.length) grid.append(h("p", "fd-hint", "No abilities yet. Each run of this lens follows its own steps."));
      c.append(grid);
      box.append(c);
    }
    const lens = d.item.type === "ability" && !d.isNew ? (data.lenses ?? []).find((l) => l.id === d.item.family) : undefined;
    if (lens) {
      const c = h("div", "fd-card");
      c.append(h("p", "fd-card-head", "Lens"));
      const m = button("fd-mini is-wide", "", () => pick(keyOf(lens)));
      m.append(h("b", "", lens.id), h("span", "", get(lens.meta, "who")));
      c.append(m);
      box.append(c);
    }
    return box;
  }

  function docs(d: Draft): HTMLElement {
    const box = h("div", "fd-docs");
    const top = h("div", "fd-docs-top");
    const seg = h("div", "fd-seg");
    for (const [on, label] of [[true, "Read"], [false, "Edit"]] as [boolean, string][]) {
      const b = button(`fd-seg-b${reading === on ? " is-on" : ""}`, label, () => {
        reading = on;
        paintMain();
        if (!on) main.querySelector<HTMLTextAreaElement>(".fd-editor")?.focus();
      });
      b.setAttribute("aria-pressed", String(reading === on));
      seg.append(b);
    }
    top.append(h("p", "fd-hint", DOC_HINT[d.item.type]), seg);
    box.append(top);
    if (reading) {
      const page = h("article", "fd-page");
      page.append(...markdown(d.body));
      if (!d.body.trim()) page.append(h("p", "fd-hint", "No documentation yet. Switch to Edit to write it."));
      page.addEventListener("dblclick", () => {
        reading = false;
        paintMain();
      });
      box.append(page);
    } else {
      const ta = h("textarea", "fd-editor");
      ta.value = d.body;
      ta.spellcheck = true;
      ta.setAttribute("aria-label", "Documentation");
      ta.addEventListener("input", () => {
        if (!draft) return;
        draft.body = ta.value;
        paintBar();
      });
      box.append(ta);
    }
    return box;
  }

  const bar = h("footer", "fd-bar");
  const barState = h("span", "fd-bar-state");

  function paintBar(): void {
    if (!draft) return;
    const d = draft;
    const change = dirty();
    barState.textContent = d.isNew ? `New ${NOUN[d.item.type]}` : change ? "Unsaved changes" : "Saved";
    barState.classList.toggle("is-dirty", change);
    bar.replaceChildren(barState);
    if (!d.isNew) {
      const k = keyOf(d.item);
      const armed = removeArmed === k;
      bar.append(button(`fd-btn is-danger${armed ? " is-armed" : ""}`, armed ? "Click again to remove" : "Remove", () => {
        if (removeArmed === k) return void remove();
        removeArmed = k;
        paintBar();
        window.setTimeout(() => {
          if (removeArmed !== k) return;
          removeArmed = "";
          paintBar();
        }, 3500);
      }));
    }
    const discard = button("fd-btn is-ghost", d.isNew ? "Cancel" : "Discard", () => {
      if (d.isNew) {
        draft = null;
        selected = "";
        paintList();
        paintMain();
        return;
      }
      draft = { ...d, meta: copy(d.item.meta), body: d.item.body };
      paintMain();
    });
    discard.disabled = !change;
    const saveB = button("fd-btn is-primary", busy ? "Saving…" : d.isNew ? "Create" : "Save", () => void save());
    saveB.disabled = !change || busy;
    bar.append(h("span", "fd-spacer"), discard, saveB);
  }

  function kicker(it: DesignItem): string {
    if (it.type === "bot") return "Bot";
    if (it.type === "lens") return "Scout lens";
    if (it.type === "routine") return "Scout routine";
    if (it.type === "ability") return `Scout ability · ${it.family || "no lens"}`;
    return "Builder ability";
  }

  function paintMain(): void {
    if (!draft) {
      main.replaceChildren(welcome());
      return;
    }
    const d = draft;
    const hero = h("header", "fd-hero");
    const ident = h("div", "fd-ident");
    if (d.isNew) {
      const id = h("input", "fd-input fd-id");
      id.placeholder = d.item.type === "bot" ? "Its kind key, like terra" : "Its id, like paywall-moment";
      id.value = d.id;
      id.setAttribute("aria-label", "Id");
      id.addEventListener("input", () => {
        if (!draft) return;
        draft.id = id.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
        if (id.value !== draft.id) id.value = draft.id;
      });
      ident.append(h("span", "fd-kicker", `New ${NOUN[d.item.type]}`), id);
    } else {
      ident.append(h("span", "fd-kicker", kicker(d.item)), h("h2", "", d.item.type === "bot" ? human(d.item.id) : d.item.id));
      const tag = d.item.type === "bot" ? get(d.meta, "Character") : d.item.type === "kind" ? get(d.meta, "When") : get(d.meta, "title");
      if (tag) ident.append(h("p", "fd-tagline", tag));
    }
    hero.append(avatar({ type: d.item.type, id: d.id, meta: d.meta }, "is-big"), ident);
    if (!d.isNew) {
      const facts = h("div", "fd-facts");
      if (d.item.type === "bot") {
        const live = data.runnable?.includes(d.item.id);
        facts.append(h("span", `fd-tag${live ? " is-ok" : ""}`, live ? "In the fleet" : "Not in fleet.py KINDS"));
      }
      if (d.item.type === "ability") facts.append(h("span", "fd-tag", `${d.item.learned ?? 0} learned`));
      if (d.item.type === "lens") facts.append(h("span", "fd-tag", `${abilitiesOf(d.item.id).length} abilities`));
      if (d.item.script) facts.append(h("span", "fd-tag", "Script, no AI"));
      const path = h("code", "fd-path", d.item.path.replace(/^\/Users\/[^/]+/, "~"));
      path.title = d.item.path;
      facts.append(path);
      hero.append(facts);
    }
    const tabs = h("div", "fd-tabs");
    tabs.setAttribute("role", "tablist");
    for (const [t, label] of [["profile", "Profile"], ["docs", "Documentation"]] as [Tab, string][]) {
      const b = button(`fd-tab${tab === t ? " is-on" : ""}`, label, () => {
        tab = t;
        paintMain();
      });
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(tab === t));
      tabs.append(b);
    }
    const pane = h("div", "fd-pane");
    pane.append(tab === "profile" ? profile(d) : docs(d));
    paintBar();
    main.replaceChildren(hero, tabs, pane, bar);
  }

  function welcome(): HTMLElement {
    const w = h("div", "fd-welcome");
    w.append(h("h2", "", "Design your fleet"), h("p", "fd-lede", "Bots are who works, each with a character and an angle. Scouts find work through lenses and their abilities. Builders do it, with one ability for each kind of work."));
    const grid = h("div", "fd-bots");
    for (const b of data.bots ?? []) {
      const c = button("fd-bot", "", () => pick(keyOf(b)));
      const colour = get(b.meta, "Colour");
      if (colour) c.style.setProperty("--c", colour);
      const plays = h("span", "fd-plays");
      for (const r of get(b.meta, "Plays").split(",").map((s) => s.trim()).filter(Boolean)) plays.append(h("span", "fd-tag", r));
      c.append(avatar(b, "is-big"), h("b", "", human(b.id)), h("span", "fd-bot-char", get(b.meta, "Character")), h("span", "fd-bot-angle", get(b.meta, "Angle")), plays);
      grid.append(c);
    }
    const add = button("fd-bot is-add", "", () => create("bot"));
    add.append(h("span", "fd-plus", "+"), h("b", "", "New bot"));
    grid.append(add);
    const stats = h("div", "fd-stats");
    const stat = (n: number, label: string, jump: () => void) => {
      const s = button("fd-stat", "", jump);
      s.append(h("b", "", String(n)), h("span", "", label));
      return s;
    };
    const first = (items: DesignItem[] | undefined) => () => items?.[0] && pick(keyOf(items[0]));
    stats.append(
      stat((data.lenses ?? []).length, "scout lenses", first(data.lenses)),
      stat((data.abilities ?? []).length, "scout abilities", first(data.abilities)),
      stat((data.kinds ?? []).length, "builder abilities", first(data.kinds)),
      stat((data.routines ?? []).length, "routines", () => {
        shut.delete("g:routines");
        first(data.routines)();
      }),
    );
    w.append(grid, stats);
    if (data.undo) {
      const u = h("p", "fd-last");
      u.append(document.createTextNode(`Last change: ${data.undo.what}, ${new Date(data.undo.at * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}. `), button("fd-link", "Undo it", () => void undo()));
      w.append(u);
    }
    return w;
  }

  function take(reply: DesignData): boolean {
    const bad = reply.refused ?? reply.error;
    if (bad) {
      say(bad, false, true);
      return false;
    }
    data = reply;
    return true;
  }

  async function save(): Promise<void> {
    if (!draft || busy) return;
    const d = draft;
    if (d.isNew && !/^[a-z0-9][a-z0-9-]*$/.test(d.id)) return say("Give it an id first: lower case letters, digits and dashes.", false, true);
    busy = true;
    paintBar();
    const sent = { meta: copy(d.meta), body: d.body };
    try {
      const reply = await events.send("save", { type: d.item.type, id: d.id, meta: sent.meta, body: sent.body, sig: d.item.sig, new: d.isNew });
      if (!take(reply)) return;
      const k = `${d.item.type}:${d.id}`;
      const typed = draft === d && (d.body !== sent.body || JSON.stringify(d.meta) !== JSON.stringify(sent.meta));
      const fresh = find(k);
      if (typed && fresh) {
        draft = { item: fresh, meta: d.meta, body: d.body, id: d.id, isNew: false };
        selected = k;
        paintList();
        paintMain();
      } else {
        draft = null;
        selected = "";
        pick(k);
      }
      say(`${d.isNew ? "Created" : "Saved"} ${d.id}.`, true);
    } catch (e) {
      say(`Could not save: ${String(e)}`, false, true);
    } finally {
      busy = false;
      paintBar();
    }
  }

  async function remove(): Promise<void> {
    if (!draft || busy) return;
    const it = draft.item;
    busy = true;
    try {
      const reply = await events.send("delete", { type: it.type, id: it.id, sig: it.sig });
      if (!take(reply)) return;
      draft = null;
      selected = "";
      removeArmed = "";
      paintList();
      paintMain();
      say(`Removed ${it.id}.`, true);
    } catch (e) {
      say(`Could not remove: ${String(e)}`, false, true);
    } finally {
      busy = false;
    }
  }

  async function undo(): Promise<void> {
    if (busy) return;
    if (dirty()) return nudge();
    busy = true;
    try {
      const reply = await events.send("undo", {});
      if (!take(reply)) return;
      const keep = selected;
      draft = null;
      selected = "";
      if (find(keep)) pick(keep);
      else {
        paintList();
        paintMain();
      }
      say(`Undone: ${reply.undone ?? "the last change"}.`);
    } catch (e) {
      say(`Could not undo: ${String(e)}`, false, true);
    } finally {
      busy = false;
    }
  }

  async function load(): Promise<void> {
    try {
      const reply = await events.load();
      if (reply.error) {
        main.replaceChildren(h("p", "fd-error", `Fleet Design could not read the files: ${reply.error}`));
        return;
      }
      data = reply;
      const fresh = draft && !draft.isNew ? find(selected) : undefined;
      if (fresh && !dirty()) draft = { item: fresh, meta: copy(fresh.meta), body: fresh.body, id: fresh.id, isNew: false };
      paintList();
      if (!dirty()) paintMain();
    } catch (e) {
      main.replaceChildren(h("p", "fd-error", `Fleet Design could not read the files: ${String(e)}`));
    }
  }

  main.replaceChildren(h("p", "fd-hint", "Reading the fleet's files…"));
  return {
    open() {
      void load();
    },
    dispose() {
      window.clearTimeout(toastTimer);
      root.replaceChildren();
    },
  };
}

export function markdown(text: string): HTMLElement[] {
  const out: HTMLElement[] = [];
  let listEl: HTMLElement | null = null;
  let lastLi: HTMLElement | null = null;
  let para: string[] = [];
  let code: string[] | null = null;
  const flush = () => {
    if (para.length) {
      const p = document.createElement("p");
      p.append(...inline(para.join(" ")));
      out.push(p);
    }
    para = [];
  };
  const pre = (lines: string[]) => {
    const el = document.createElement("pre");
    el.textContent = lines.join("\n");
    out.push(el);
  };
  for (const line of text.split("\n")) {
    if (code) {
      if (line.startsWith("```")) {
        pre(code);
        code = null;
      } else code.push(line);
      continue;
    }
    if (line.startsWith("```")) {
      flush();
      listEl = null;
      code = [];
      continue;
    }
    const head = /^(#{1,4})\s+(.*)$/.exec(line);
    const item = /^(\s*)(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (head) {
      flush();
      listEl = null;
      const el = document.createElement(head[1].length <= 2 ? "h3" : "h4");
      el.append(...inline(head[2]));
      out.push(el);
    } else if (item) {
      flush();
      const ordered = /^\s*\d+\./.test(line);
      const tag = ordered ? "OL" : "UL";
      const li = document.createElement("li");
      li.append(...inline(item[2]));
      const parent = item[1].length >= 2 ? listEl?.lastElementChild : null;
      if (parent) {
        let sub = parent.lastElementChild;
        if (!sub || sub.tagName !== tag) {
          sub = document.createElement(ordered ? "ol" : "ul");
          parent.append(sub);
        }
        sub.append(li);
        lastLi = li;
        continue;
      }
      if (!listEl || listEl.tagName !== tag) {
        listEl = document.createElement(ordered ? "ol" : "ul");
        out.push(listEl);
      }
      listEl.append(li);
      lastLi = li;
    } else if (!line.trim()) {
      flush();
      listEl = null;
    } else if (listEl && /^\s{2,}/.test(line)) {
      lastLi?.append(document.createTextNode(" "), ...inline(line.trim()));
    } else {
      listEl = null;
      para.push(line.trim());
    }
  }
  if (code) pre(code);
  flush();
  return out;
}

function inline(text: string): Node[] {
  const nodes: Node[] = [];
  let at = 0;
  for (const m of text.matchAll(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g)) {
    const i = m.index ?? 0;
    if (i > at) nodes.push(document.createTextNode(text.slice(at, i)));
    const s = m[0];
    const el = document.createElement(s.startsWith("`") ? "code" : s.startsWith("**") ? "b" : "i");
    el.textContent = s.startsWith("**") ? s.slice(2, -2) : s.slice(1, -1);
    nodes.push(el);
    at = i + s.length;
  }
  if (at < text.length) nodes.push(document.createTextNode(text.slice(at)));
  return nodes;
}
