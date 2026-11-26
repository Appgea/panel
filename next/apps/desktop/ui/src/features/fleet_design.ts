import "./fleet_design.css";
import { art, crest } from "./game_art";

export type Role = { role: string; say: string; source: string };
export type Numbers = Record<string, number>;
export type Bot = {
  id: string;
  engine: string;
  model: string;
  engine_source: string;
  tier: string;
  reviewer: string;
  bundle: string;
  price: string;
  tier_source: string;
  character: string;
  angle: string;
  persona: string;
  persona_source: string;
  roles: Role[];
  idle: boolean;
  down_until: string;
  numbers: Numbers;
};
export type Routine = {
  id: string;
  title: string;
  who: string;
  every: string;
  runs: "bot" | "script";
  script: string;
  paused: string;
  priority: string;
  goal: string;
  kinds: string[];
  needs: string;
  own_steps: boolean;
  apps: string;
  error: string;
  abilities: string[];
  path: string;
  doc: string;
  numbers: Numbers;
};
export type Ability = {
  id: string;
  title: string;
  lens: string;
  lens_named?: string;
  parts: string[];
  stack: string[];
  needs: string;
  paused: string;
  goal: string;
  learned: number;
  path: string;
  doc: string;
};
export type WorkKind = { id: string; when: string; read: string; pick: string; method: string; path: string };
export type ProblemClass = { id: string; what: string; seen: number; check: string; source?: string };
export type Step = { step: string; say: string; code: string; source: string };
export type DesignData = {
  made?: string;
  home?: string;
  days?: number;
  flows?: { scout: Step[]; build: Step[] };
  bots?: Bot[];
  tiers?: { order: string[]; source: string };
  routines?: Routine[];
  abilities?: Ability[];
  kinds?: WorkKind[];
  classes?: ProblemClass[];
  files?: Record<string, string>;
  error?: string;
};
export type TrustRow = { side?: string; name: string; judged?: number; untrue?: number; wanting?: number; silent?: number; closes?: number; unproven?: number; blamed?: number; trusted: string };
export type TrustData = { made?: string; pending?: boolean; error?: string; days?: number; scouts?: TrustRow[]; builders?: TrustRow[] };
export type DesignEvents = {
  load(): Promise<DesignData>;
  trust(): Promise<TrustData>;
  openFile?(path: string, line?: number): void;
};
export type DesignHandle = { open(): void; dispose(): void };

type Page = { type: "home" } | { type: "bot" | "routine" | "ability" | "kind"; id: string } | { type: "classes" };

const EVERY: Record<string, string> = {
  routine: "Once a round, with every other routine",
  manual: "Only when someone names it",
  daily: "Once a day",
};
const ROLE_ORDER = ["builder", "lead lane", "scout", "pinned scout", "checker", "stand-in", "has stand-in"];
const ROLE_LABEL: Record<string, string> = { "has stand-in": "Out of quota", "pinned scout": "Named scout", "lead lane": "Lead lane", "stand-in": "Stand-in" };

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text) el.textContent = text;
  return el;
};
const button = (cls: string, text: string, onClick: () => void, title = ""): HTMLButtonElement => {
  const b = h("button", cls, text);
  b.type = "button";
  if (title) b.title = title;
  b.addEventListener("click", onClick);
  return b;
};
const human = (id: string): string => (id ? id[0].toUpperCase() + id.slice(1).replace(/-/g, " ") : "");
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const colourOf = (kind: string): string => `c-${["terra", "flash", "haiku", "sonnet", "opus", "fable"].includes(kind) ? kind : "other"}`;

export function mountDesign(root: HTMLElement, events: DesignEvents): DesignHandle {
  let data: DesignData = {};
  let trust: TrustData | null = null;
  let page: Page = { type: "home" };
  let query = "";
  let trustTimer: number | undefined;
  let copiedTimer: number | undefined;
  const back: Page[] = [];
  const open = new Set<string>();
  const shut = new Set<string>(["g:other", "g:scripts"]);

  const rail = h("aside", "fd-rail");
  const search = h("input", "fd-search");
  search.type = "search";
  search.placeholder = "Search bots, routines, abilities, kinds";
  search.setAttribute("aria-label", "Search the fleet");
  search.addEventListener("input", () => {
    query = search.value.trim().toLowerCase();
    paintList();
    if (page.type === "classes") paintMain();
  });
  const list = h("nav", "fd-list");
  list.setAttribute("aria-label", "Fleet parts");
  rail.append(search, list);
  const main = h("section", "fd-main");
  root.replaceChildren(rail, main);
  root.classList.add("fd");

  const bots = (): Bot[] => data.bots ?? [];
  const routines = (): Routine[] => data.routines ?? [];
  const abilities = (): Ability[] => data.abilities ?? [];
  const bot = (id: string): Bot | undefined => bots().find((b) => b.id === id);
  const routine = (id: string): Routine | undefined => routines().find((r) => r.id === id);
  const ability = (id: string): Ability | undefined => abilities().find((a) => a.id === id);
  const lenses = (): Routine[] => routines().filter((r) => r.runs === "bot" && r.who);
  const others = (): Routine[] => routines().filter((r) => r.runs === "bot" && !r.who);
  const scripts = (): Routine[] => routines().filter((r) => r.runs === "script");
  const orphans = (): Ability[] => abilities().filter((a) => !a.lens);
  const same = (a: Page, b: Page): boolean => a.type === b.type && ("id" in a ? a.id : "") === ("id" in b ? b.id : "");

  function go(next: Page): void {
    if (same(next, page)) return;
    back.push(page);
    if (back.length > 30) back.shift();
    page = next;
    if (next.type === "ability") {
      const lens = ability(next.id)?.lens;
      if (lens) open.add(lens);
    }
    paintList();
    paintMain();
    main.scrollTop = 0;
  }

  function source(where: string, label = ""): HTMLElement {
    const m = /^(.*?)(?::(\d+))?$/.exec(where) ?? [where, where];
    const file = m[1] ?? where;
    const line = m[2] ? Number(m[2]) : undefined;
    const full = file.replace(/^~/, data.home ?? "~");
    const b = button("fd-src", label || where, () => events.openFile?.(full, line), events.openFile ? `Open ${where}` : where);
    b.disabled = !events.openFile;
    return b;
  }

  function copyRef(text: string): HTMLButtonElement {
    const b = button("fd-btn is-ghost", "Copy reference", () => {
      void navigator.clipboard?.writeText(text).then(() => {
        b.textContent = "Copied";
        window.clearTimeout(copiedTimer);
        copiedTimer = window.setTimeout(() => (b.textContent = "Copy reference"), 1600);
      });
    }, "Copy a line that names this part, to paste into a prompt");
    return b;
  }

  function avatar(kind: "bot" | "lens" | "routine" | "script" | "ability" | "kind", id: string, size = ""): HTMLElement {
    if (kind === "bot") return art(`fd-avatar is-bot ${colourOf(id)} ${size}`, crest(id));
    const letters = id.split("-").map((w) => w[0] ?? "").join("").slice(0, 2).toUpperCase();
    return h("span", `fd-avatar is-${kind} ${size}`, letters);
  }

  function chip(text: string, cls = "", onClick?: () => void, title = ""): HTMLElement {
    if (!onClick) {
      const s = h("span", `fd-tag ${cls}`, text);
      if (title) s.title = title;
      return s;
    }
    return button(`fd-tag is-link ${cls}`, text, onClick, title);
  }

  function botChip(id: string): HTMLElement {
    const b = button(`fd-botchip ${colourOf(id)}`, "", () => go({ type: "bot", id }), `Open ${human(id)}`);
    b.append(art("fd-dot", crest(id)), document.createTextNode(human(id)));
    return b;
  }

  function row(kind: Parameters<typeof avatar>[0], id: string, title: string, target: Page, extra: HTMLElement[] = [], child = false): HTMLElement {
    const on = same(target, page);
    const b = h("button", `fd-row${child ? " is-child" : ""}${on ? " is-on" : ""}`);
    b.type = "button";
    const text = h("span", "fd-row-text");
    text.append(h("b", "", kind === "bot" ? human(id) : id), h("span", "", title));
    b.append(avatar(kind, id, "is-small"), text, ...extra);
    b.addEventListener("click", () => go(target));
    return b;
  }

  function group(id: string, label: string, rows: HTMLElement[], note = ""): HTMLElement {
    const g = h("div", "fd-group");
    const folded = shut.has(id) && !query;
    const fold = button("fd-fold", "", () => {
      if (shut.has(id)) shut.delete(id);
      else shut.add(id);
      paintList();
    });
    fold.setAttribute("aria-expanded", String(!folded));
    fold.append(h("span", `fd-caret${folded ? "" : " is-open"}`, "›"), h("span", "", label), h("em", "", String(rows.length)));
    if (note) fold.title = note;
    g.append(fold);
    if (!folded) g.append(...rows);
    return g;
  }

  const hit = (...parts: (string | undefined)[]): boolean => !query || parts.join(" ").toLowerCase().includes(query);
  const pausedTag = (p: string): HTMLElement[] => (p ? [chip("Paused", "is-paused", undefined, p)] : []);

  function paintList(): void {
    const scroll = list.scrollTop;
    const home = row("kind", "", "", { type: "home" });
    home.className = `fd-home${page.type === "home" ? " is-on" : ""}`;
    home.replaceChildren(document.createTextNode("How the fleet works"));
    const botRows = bots().filter((b) => hit(b.id, b.character, b.angle, b.model)).map((b) =>
      row("bot", b.id, b.character || b.model, { type: "bot", id: b.id }, b.idle ? [chip("No seat")] : []));
    const lensRows: HTMLElement[] = [];
    for (const lens of lenses()) {
      const kids = lens.abilities.map((id) => ability(id)).filter((a): a is Ability => !!a);
      const shownKids = kids.filter((a) => hit(a.id, a.title));
      if (!hit(lens.id, lens.title, lens.who) && !shownKids.length) continue;
      const wrap = h("div", "fd-lens");
      const extra = [...pausedTag(lens.paused)];
      const showing = open.has(lens.id) || (!!query && shownKids.length > 0);
      if (kids.length) {
        const fold = h("span", `fd-kids${showing ? " is-open" : ""}`, String(kids.length));
        fold.title = showing ? "Hide its abilities" : `Show its ${kids.length} abilities`;
        fold.addEventListener("click", (e) => {
          e.stopPropagation();
          if (open.has(lens.id)) open.delete(lens.id);
          else open.add(lens.id);
          paintList();
        });
        extra.push(fold);
      }
      wrap.append(row("lens", lens.id, lens.title, { type: "routine", id: lens.id }, extra));
      if (showing) wrap.append(...(query ? shownKids : kids).map((a) => row("ability", a.id, a.title, { type: "ability", id: a.id }, pausedTag(a.paused), true)));
      lensRows.push(wrap);
    }
    const plain = (rs: Routine[], kind: "routine" | "script") =>
      rs.filter((r) => hit(r.id, r.title, r.script)).map((r) => row(kind, r.id, r.title, { type: "routine", id: r.id }, pausedTag(r.paused)));
    const lost = orphans().filter((a) => hit(a.id, a.title)).map((a) => row("ability", a.id, a.title, { type: "ability", id: a.id }, [chip("No lens", "is-warn")]));
    const kindRows = (data.kinds ?? []).filter((k) => hit(k.id, k.when, k.method)).map((k) => row("kind", k.id, k.when, { type: "kind", id: k.id }));
    const crew = (text: string, sub: string) => {
      const p = h("p", "fd-crew");
      p.append(h("b", "", text), h("span", "", sub));
      return p;
    };
    const classes = row("kind", "", "", { type: "classes" });
    classes.className = `fd-home is-sub${page.type === "classes" ? " is-on" : ""}`;
    classes.replaceChildren(document.createTextNode(`Problem classes · ${(data.classes ?? []).length}`));
    list.replaceChildren(
      home,
      group("g:bots", "Bots", botRows, "Who does the work: the kinds in fleet.py"),
      crew("Scouting", "find work and file it"),
      group("g:lenses", "Lenses", lensRows, "Routines with a who: line, each one person at one stage"),
      ...(lost.length ? [group("g:orphans", "Abilities whose lens is missing", lost)] : []),
      group("g:other", "Other bot routines", plain(others(), "routine"), "A bot runs it, but it names no who"),
      group("g:scripts", "Script routines", plain(scripts(), "script"), "A script runs it. No bot"),
      classes,
      crew("Building", "do the filed work"),
      group("g:kinds", "Work kinds", kindRows, "The cards in kinds.md. Each issue gets one as its kind: label"),
    );
    list.scrollTop = scroll;
  }

  function section(title: string, ...kids: (HTMLElement | null)[]): HTMLElement {
    const c = h("section", "fd-card");
    c.append(h("h3", "fd-card-head", title), ...kids.filter((k): k is HTMLElement => !!k));
    return c;
  }

  function fact(label: string, value: string | HTMLElement, where = "", note = ""): HTMLElement {
    const r = h("div", "fd-fact");
    const v = h("div", "fd-fact-v");
    v.append(typeof value === "string" ? document.createTextNode(value) : value);
    if (note) v.append(h("span", "fd-note", note));
    r.append(h("span", "fd-fact-k", label), v);
    if (where) r.append(source(where));
    return r;
  }

  function numbers(n: Numbers, what: string): HTMLElement | null {
    const keys = Object.keys(n);
    if (!keys.length) return h("p", "fd-hint", `Nothing in the fleet's logs for the last ${data.days ?? 7} days.`);
    const box = h("div", "fd-nums");
    for (const k of keys) {
      const s = h("div", "fd-num");
      s.append(h("b", "", String(n[k])), h("span", "", k));
      box.append(s);
    }
    const p = h("p", "fd-hint", `${what}, last ${data.days ?? 7} days, from the fleet's own logs on this Mac.`);
    const wrap = h("div");
    wrap.append(box, p);
    return wrap;
  }

  function trustBlock(rows: TrustRow[], kind: "scout" | "builder"): HTMLElement {
    if (!trust || trust.pending) return h("p", "fd-hint", "Measuring from GitHub. It takes about a minute, and this page fills in by itself.");
    if (trust.error) return h("p", "fd-hint", `Could not measure: ${trust.error}`);
    if (!rows.length) return h("p", "fd-hint", `No ${kind === "scout" ? "judged finds" : "logic-fix closes"} in the last ${trust.days ?? 7} days.`);
    const box = h("div", "fd-nums");
    for (const r of rows) {
      const s = h("div", "fd-num is-trust");
      const n = kind === "scout" ? r.judged ?? 0 : r.closes ?? 0;
      s.append(h("b", "", r.trusted), h("span", "", kind === "scout" ? `trusted of ${plural(n, "judged find")}` : `trusted of ${plural(n, "logic-fix close")}`));
      const bad = kind === "scout" ? `${r.untrue ?? 0} untrue, ${r.wanting ?? 0} with a wanting brief, ${r.silent ?? 0} with no word` : `${r.unproven ?? 0} with no code run as proof, ${r.blamed ?? 0} blamed later`;
      s.append(h("span", "fd-note", bad));
      box.append(s);
    }
    const wrap = h("div");
    const when = trust.made ? new Date(trust.made).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";
    const p = h("p", "fd-hint", `From what happened to the work on GitHub, last ${trust.days ?? 7} days. Measured ${when}. `);
    p.append(source(`${data.files?.fleet ?? "fleet.py"}`, "fleet trust"));
    wrap.append(box, p);
    return wrap;
  }

  function doc(text: string, where: string): HTMLElement {
    const c = section("Its file, as the bot reads it");
    const pageEl = h("article", "fd-page");
    pageEl.append(...markdown(text));
    if (!text.trim()) pageEl.append(h("p", "fd-hint", "The file has no text below its header."));
    c.append(pageEl, source(where));
    return c;
  }

  function hero(kind: Parameters<typeof avatar>[0], id: string, kicker: string, title: string, line: string, tags: HTMLElement[], ref: string): HTMLElement {
    const top = h("header", "fd-hero");
    const ident = h("div", "fd-ident");
    ident.append(h("span", "fd-kicker", kicker), h("h2", "", title));
    if (line) ident.append(h("p", "fd-tagline", line));
    const side = h("div", "fd-hero-side");
    side.append(copyRef(ref));
    if (back.length) side.prepend(button("fd-btn is-ghost", "Back", () => {
      const prev = back.pop();
      if (!prev) return;
      page = prev;
      paintList();
      paintMain();
    }));
    top.append(avatar(kind, id, "is-big"), ident, side);
    if (tags.length) {
      const facts = h("div", "fd-facts");
      facts.append(...tags);
      top.append(facts);
    }
    return top;
  }

  function botPage(b: Bot): HTMLElement[] {
    const pinned = routines().filter((r) => r.kinds.includes(b.id));
    const tags = [chip(`${human(b.tier)} tier`), ...(b.down_until ? [chip(`Quota out until ${b.down_until}`, "is-paused")] : []), ...(b.idle ? [chip("No seat")] : [])];
    const roles = section("What it does in the fleet");
    const sorted = [...b.roles].sort((x, y) => ROLE_ORDER.indexOf(x.role) - ROLE_ORDER.indexOf(y.role));
    for (const r of sorted) {
      const say = h("span");
      say.append(...inline(`${r.say[0].toUpperCase()}${r.say.slice(1)}.`));
      roles.append(fact(ROLE_LABEL[r.role] ?? human(r.role), say, r.source));
    }
    if (b.idle) roles.append(h("p", "fd-hint", "No seat, turn or pin names it. It runs only when a command names it, like `fleet build " + b.id + " 1234`."));
    if (pinned.length) {
      const chips = h("div", "fd-chips");
      chips.append(...pinned.map((r) => chip(r.id, "", () => go({ type: "routine", id: r.id }))));
      roles.append(fact("Allowed on", chips, "", "These routines run only on the bots their kinds: line names."));
    }
    const engine = section("What it runs on",
      fact("Engine", b.engine, b.engine_source),
      fact("Model", b.model),
      fact("Tier", human(b.tier), b.tier_source, tierNote(b.tier)),
      fact("Reviewed by", human(b.reviewer), b.tier_source, "Its work gets one review from this model, of another family."),
      b.bundle ? fact("Bundle", `${b.bundle} estimate minutes per board next`, b.tier_source) : null,
      b.price ? fact("List price", b.price, b.tier_source) : null,
    );
    const persona = section("Character and angle",
      h("p", "fd-hint", "These two lines open every prompt this bot runs, so they are instructions to it."),
      b.persona ? h("blockquote", "fd-quote", b.persona) : h("p", "fd-hint", "None set. Its prompt starts with the brief alone."),
      source(b.persona_source),
    );
    const done = section("What it did", numbers(b.numbers, "Runs and issues"),
      h("h4", "fd-sub", "Scout finds, judged by the builder who took them"), trustBlock((trust?.scouts ?? []).filter((r) => r.side === "model" && r.name === b.id), "scout"),
      h("h4", "fd-sub", "Logic-fix closes"), trustBlock((trust?.builders ?? []).filter((r) => r.name === b.id), "builder"));
    return [hero("bot", b.id, "Bot", human(b.id), b.character, tags, `Fleet bot \`${b.id}\` (${b.model}, KINDS in ${b.engine_source})`), body(persona, roles, engine, done)];
  }

  function tierNote(tier: string): string {
    const order = data.tiers?.order ?? [];
    const rank = order.indexOf(tier);
    const above = rank > 0 ? `Above it: ${order.slice(0, rank).join(", ")}.` : "The top tier.";
    const rule = tier === "lead" ? " Only a lead takes Run with: opus, claude or fable, and open-ended work." : tier === "senior" ? " It may take Opus-lane work that needs no screen." : "";
    return `It takes issues at its tier or below first, then bigger ones. ${above}${rule}`;
  }

  function botsAllowed(r: Routine): HTMLElement {
    const chips = h("div", "fd-chips");
    if (r.runs === "script") {
      chips.append(chip("No bot. A script runs it"));
      return chips;
    }
    if (r.kinds.length) chips.append(...r.kinds.map(botChip));
    else {
      const turn = bots().filter((b) => b.roles.some((x) => x.role === "scout")).map((b) => b.id);
      chips.append(...turn.map(botChip), h("span", "fd-note", "Any bot. These take turns."));
    }
    return chips;
  }

  function routinePage(r: Routine): HTMLElement[] {
    const isLens = r.runs === "bot" && !!r.who;
    const kids = r.abilities.map((id) => ability(id)).filter((a): a is Ability => !!a);
    const tags = [chip(EVERY[r.every] ?? `Every ${r.every}`), chip(r.priority), ...pausedTag(r.paused), ...(r.needs ? [chip(`Needs ${r.needs}`, "", undefined, "A fleet unit has no signed-in Chrome, so only a named run takes it")] : []), ...(r.error ? [chip(r.error, "is-warn")] : [])];
    const how = section("How it runs",
      fact("Run by", botsAllowed(r), r.kinds.length ? r.path : ""),
      r.who ? fact("Looks as", r.who, r.path) : null,
      r.script ? fact("Script", h("code", "", r.script), r.path) : null,
      r.goal ? fact("Goal", `Goal ${r.goal} in direction.md`) : null,
      r.paused ? fact("Paused", r.paused, r.path, "Delete the paused: line to run it again.") : null,
    );
    const ways = isLens || kids.length ? section(`Ways it looks · ${kids.length + (r.own_steps ? 1 : 0)}`,
      h("p", "fd-hint", "Each run takes one: the one this app saw longest ago. It skips one that is paused, needs the browser, or wants a part or stack the app lacks."),
      ...(r.own_steps ? [h("div", "fd-mini is-static", "Its own steps, in this file")] : []),
      minis(kids),
      kids.length || r.own_steps ? null : h("p", "fd-hint", "No abilities. Every run follows this file."),
    ) : null;
    const done = section("What it did", numbers(r.numbers, "Runs and issues"),
      h("h4", "fd-sub", "Its finds, judged by the builder who took them"), trustBlock((trust?.scouts ?? []).filter((x) => x.side === "lens" && x.name === r.id), "scout"));
    const kicker = r.runs === "script" ? "Script routine" : isLens ? "Scout lens" : "Bot routine";
    return [hero(isLens ? "lens" : r.runs === "script" ? "script" : "routine", r.id, kicker, r.id, r.title, tags, `Scout ${isLens ? "lens" : "routine"} \`${r.id}\` (${r.path})`),
      body(how, ways, r.runs === "bot" ? done : null, doc(r.doc, r.path))];
  }

  function minis(items: Ability[]): HTMLElement {
    const grid = h("div", "fd-minis");
    for (const a of items) {
      const m = button("fd-mini", "", () => go({ type: "ability", id: a.id }));
      m.append(h("b", "", a.id), h("span", "", a.title));
      const gates = gatesOf(a);
      if (gates.length || a.paused) {
        const g = h("div", "fd-chips");
        g.append(...pausedTag(a.paused), ...gates.map((x) => chip(x)));
        m.append(g);
      }
      grid.append(m);
    }
    return grid;
  }

  const turnsAt = (): string => data.flows?.scout.find((s) => s.step === "An ability")?.source ?? "";
  const gatesOf = (a: Ability): string[] => [...(a.parts.length ? [`parts: ${a.parts.join(", ")}`] : []), ...(a.stack.length ? [`stack: ${a.stack.join(", ")}`] : []), ...(a.needs ? [`needs ${a.needs}`] : [])];

  function abilityPage(a: Ability): HTMLElement[] {
    const lens = routine(a.lens);
    const tags = [...pausedTag(a.paused), chip(plural(a.learned, "learned line")), ...(!a.lens ? [chip(a.lens_named ? `Lens ${a.lens_named} is missing` : "No lens", "is-warn")] : [])];
    const lensBtn = lens ? chip(lens.id, "", () => go({ type: "routine", id: lens.id })) : h("span", "", a.lens_named || "none");
    const when = section("When a run takes it",
      fact("Lens", lensBtn, a.path, lens?.who ?? ""),
      fact("Run by", lens ? botsAllowed(lens) : h("span", "", "No lens, so no run takes it.")),
      fact("App parts", a.parts.length ? a.parts.join(", ") : "Any app", turnsAt(), a.parts.length ? "An app whose map shows one of these parts, or an app with no map yet." : ""),
      a.stack.length ? fact("Stack", a.stack.join(", "), turnsAt(), "Only an app built with one of these.") : null,
      a.needs ? fact("Needs", a.needs, "", "No fleet unit takes it: they have no signed-in Chrome.") : null,
      a.paused ? fact("Paused", a.paused, a.path, "Five empty runs in a row paused it. Delete the line to run it again.") : null,
      fact("Learned", plural(a.learned, "line"), "", "Each run's lesson for the next one, kept at the end of the file."),
    );
    return [hero("ability", a.id, `Scout ability${lens ? ` · ${lens.id}` : ""}`, a.id, a.title, tags, `Scout ability \`${a.id}\` of lens \`${a.lens}\` (${a.path})`), body(when, doc(a.doc, a.path))];
  }

  function kindPage(k: WorkKind): HTMLElement[] {
    const read = h("div", "fd-chips");
    for (const w of k.read.split(/[,\s]+/).filter(Boolean)) read.append(chip(w.replace(/`/g, "")));
    const pick = h("div", "fd-chips");
    for (const w of k.pick.split(/[,\s]+/).filter(Boolean)) pick.append(chip(w.replace(/`/g, "")));
    const card = section("The card",
      fact("Picked when", k.when, k.path, "Jev reads the brief against this line and gives the issue one kind."),
      fact("Read first", read, "", "Skills and files under ~/.appgeapanel/skills a small builder is handed."),
      k.pick ? fact("Jev may add", pick, "", "Up to two more files from here, when they fit this issue.") : null,
    );
    const method = section("The method it follows");
    const pageEl = h("article", "fd-page");
    pageEl.append(...markdown(k.method));
    method.append(pageEl, source(k.path));
    const who = section("Who builds it",
      h("p", "fd-hint", "Any builder bot. The issue's Run with: tier decides who takes it first, not its kind."),
      (() => {
        const c = h("div", "fd-chips");
        c.append(...bots().filter((b) => b.roles.some((r) => r.role === "builder")).map((b) => botChip(b.id)));
        return c;
      })());
    return [hero("kind", k.id, "Work kind", k.id, k.when, [], `Work kind \`${k.id}\` (${k.path})`), body(card, method, who)];
  }

  function classesPage(): HTMLElement[] {
    const all = [...(data.classes ?? [])].filter((c) => hit(c.id, c.what, c.check)).sort((a, b) => b.seen - a.seen);
    const c = section(`Every kind of problem scouts have filed · ${all.length}`,
      h("p", "fd-hint", "A scout files each finding under one of these. A class seen three times should become a check script. One seen five times with no script gets its own ability."));
    const listEl = h("div", "fd-classes");
    for (const k of all.slice(0, 200)) {
      const r = h("div", "fd-class");
      const top = h("div", "fd-class-top");
      top.append(h("b", "", k.id), chip(plural(k.seen, "issue")));
      r.append(top, h("span", "", k.what), h("span", "fd-note", `Check: ${k.check}`));
      if (k.source) r.append(source(k.source));
      listEl.append(r);
    }
    c.append(listEl);
    if (all.length > 200) c.append(h("p", "fd-hint", `The 200 seen most. Search to find the other ${all.length - 200}.`));
    c.append(source(data.files?.classes ?? ""));
    return [hero("kind", "pc", "Scouting", "Problem classes", "What scouts find, by kind", [], `Problem classes (${data.files?.classes ?? ""})`), body(c)];
  }

  function body(...cards: (HTMLElement | null)[]): HTMLElement {
    const b = h("div", "fd-body");
    b.append(...cards.filter((c): c is HTMLElement => !!c));
    return b;
  }

  function flow(title: string, sub: string, steps: Step[], extra: (s: Step, i: number) => HTMLElement | null): HTMLElement {
    const c = h("section", "fd-flow");
    const head = h("div", "fd-flow-head");
    head.append(h("h3", "", title), h("span", "", sub));
    const ol = h("ol", "fd-steps");
    steps.forEach((s, i) => {
      const li = h("li", "fd-step");
      const top = h("div", "fd-step-top");
      top.append(h("span", "fd-step-n", String(i + 1)), h("b", "", s.step));
      const say = h("p");
      say.append(...inline(s.say));
      li.append(top, say);
      const more = extra(s, i);
      if (more) li.append(more);
      if (s.code) {
        const q = h("p", "fd-code-says");
        q.append(h("span", "", "The code says: "), ...inline(s.code));
        li.append(q);
      }
      li.append(source(s.source));
      ol.append(li);
    });
    c.append(head, ol);
    return c;
  }

  function welcome(): HTMLElement {
    const w = h("div", "fd-welcome");
    const made = data.made ? new Date(data.made).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";
    w.append(h("h2", "", "How the fleet works"),
      h("p", "fd-lede", `Read from the code and files that run it, ${made}. Nothing here is a copy. Each line links to the file and line that make it so. To change something, copy its reference and prompt the change.`));
    const grid = h("div", "fd-bots");
    for (const b of bots()) {
      const c = button(`fd-bot ${colourOf(b.id)}`, "", () => go({ type: "bot", id: b.id }));
      const plays = h("span", "fd-plays");
      const roles = [...new Set(b.roles.map((r) => (r.role === "has stand-in" ? "" : r.role)).filter(Boolean))];
      for (const r of roles) plays.append(h("span", "fd-tag", r));
      if (b.idle) plays.append(h("span", "fd-tag", "no seat"));
      c.append(avatar("bot", b.id, "is-big"), h("b", "", human(b.id)), h("span", "fd-bot-char", b.character), h("span", "fd-bot-angle", `${human(b.tier)} tier · ${b.model}`), plays);
      grid.append(c);
    }
    const scoutBots = (s: Step) => (s.step === "A bot" ? (() => {
      const c = h("div", "fd-chips");
      c.append(...bots().filter((b) => b.roles.some((r) => r.role === "scout")).map((b) => botChip(b.id)));
      return c;
    })() : null);
    const buildBots = (s: Step) => {
      if (s.step === "A bot") {
        const c = h("div", "fd-chips");
        c.append(...bots().filter((b) => b.roles.some((r) => r.role === "builder")).map((b) => botChip(b.id)));
        return c;
      }
      if (s.step === "A work kind") {
        const c = h("div", "fd-chips");
        c.append(chip(plural((data.kinds ?? []).length, "work kind"), "", () => {
          shut.delete("g:kinds");
          const first = data.kinds?.[0];
          if (first) go({ type: "kind", id: first.id });
        }));
        return c;
      }
      return null;
    };
    const scoutExtra = (s: Step) => {
      if (s.step === "A round") {
        const c = h("div", "fd-chips");
        c.append(chip(plural(lenses().length, "lens", "lenses")), chip(plural(others().length, "other routine")), chip(plural(scripts().length, "script routine")));
        return c;
      }
      if (s.step === "An ability") {
        const c = h("div", "fd-chips");
        c.append(chip(plural(abilities().length, "ability", "abilities")), chip(`${abilities().filter((a) => a.paused).length} paused`, "is-paused"));
        return c;
      }
      if (s.step === "A finding") {
        const c = h("div", "fd-chips");
        c.append(chip(plural((data.classes ?? []).length, "problem class", "problem classes"), "", () => go({ type: "classes" })));
        return c;
      }
      return scoutBots(s);
    };
    const flows = h("div", "fd-flows");
    flows.append(flow("Scouting", "finds work and files it", data.flows?.scout ?? [], scoutExtra), flow("Building", "does the filed work", data.flows?.build ?? [], buildBots));
    w.append(h("h3", "fd-h3", "The bots"), grid, flows);
    return w;
  }

  function paintMain(): void {
    let parts: HTMLElement[] = [];
    if (page.type === "home") parts = [welcome()];
    else if (page.type === "classes") parts = classesPage();
    else if (page.type === "bot") parts = (b => b ? botPage(b) : [])(bot(page.id));
    else if (page.type === "routine") parts = (r => r ? routinePage(r) : [])(routine(page.id));
    else if (page.type === "ability") parts = (a => a ? abilityPage(a) : [])(ability(page.id));
    else if (page.type === "kind") parts = (k => k ? kindPage(k) : [])((data.kinds ?? []).find((x) => x.id === (page as { id: string }).id));
    if (!parts.length) {
      page = { type: "home" };
      parts = [welcome()];
    }
    const scroll = main.scrollTop;
    main.replaceChildren(...parts);
    main.scrollTop = scroll;
  }

  async function loadTrust(): Promise<void> {
    window.clearTimeout(trustTimer);
    try {
      trust = await events.trust();
    } catch (e) {
      trust = { error: String(e) };
    }
    if (page.type !== "home" && page.type !== "classes") paintMain();
    if (trust?.pending) trustTimer = window.setTimeout(() => void loadTrust(), 20_000);
  }

  async function load(): Promise<void> {
    try {
      const reply = await events.load();
      if (reply.error) {
        main.replaceChildren(h("p", "fd-error", `Could not read the fleet: ${reply.error}`));
        return;
      }
      data = reply;
      paintList();
      paintMain();
    } catch (e) {
      main.replaceChildren(h("p", "fd-error", `Could not read the fleet: ${String(e)}`));
    }
  }

  main.replaceChildren(h("p", "fd-hint fd-pad", "Reading the fleet…"));
  return {
    open() {
      void load();
      void loadTrust();
    },
    dispose() {
      window.clearTimeout(trustTimer);
      window.clearTimeout(copiedTimer);
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
