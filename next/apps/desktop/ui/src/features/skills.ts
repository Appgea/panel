import { invoke } from "@tauri-apps/api/core";
import type { Session } from "../types";
import { confirmDialog } from "../views/dialog";
import "./skills.css";

type Skill = { path: string; name: string; description: string; provider: string; scope: string; editable: boolean; body: string; source: string; archived: boolean; department: string };
type SessionPolicy = { overrides: Record<string, boolean>; applied: Record<string, boolean> };
type Usage = { supported: boolean; used: string[] };
export type SkillsContext = {
  session?: Session;
  sessions?: Session[];
  onRestart?: (session: Session) => Promise<Session>;
  onInsert?: (session: Session, text: string) => Promise<void>;
};
/** Where the browser stands. No path is the overview; no file is the skill's own SKILL.md. */
type Place = { path?: string; file?: string };
/** What the page pane shows. "new" is the create form, prefilled when copying a skill. */
type Mode = { kind: "read" } | { kind: "edit" } | { kind: "new"; draft?: { name: string; description: string; steps: string } } | { kind: "new-file" };

let dismiss: (() => Promise<void>) | undefined;
/** Reopening the browser returns to the last page, the way a reader expects. */
let lastPlace: Place = {};
const requested = new Map<string, Set<string>>();
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const button = (text: string, action: () => void, primary = false) => {
  const node = el("button", `skills-button${primary ? " is-primary" : ""}`, text);
  node.type = "button";
  node.onclick = action;
  return node;
};
const chevron = (d: string) => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
const providerNames: Record<string, string> = { claude: "Claude", codex: "Codex", shared: "Shared" };
const providerName = (provider: string) => providerNames[provider] ?? provider;
const departments: Record<string, string> = { company: "Company", legal: "Legal", design: "Design", general: "General" };
const skillDir = (skill: Skill) => skill.path.replace(/\/SKILL\.md$/, "");
const samePlace = (a: Place, b: Place) => a.path === b.path && a.file === b.file;
const stripFrontMatter = (text: string) => /^---\n[\s\S]*?\n---\n?/.test(text) ? text.replace(/^---\n[\s\S]*?\n---\n?/, "") : text;
function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") out.pop();
    else if (part !== "." && part !== "") out.push(part);
  }
  return `/${out.join("/")}`;
}

/** Skills are disk definitions. Staging a request never claims runtime activation. */
export async function openSkills(context: SkillsContext = {}): Promise<void> {
  if (dismiss) { await dismiss(); if (document.querySelector(".skills-overlay")) return; }
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const wrap = el("div", "skills-overlay");
  const card = el("section", "skills-manager");
  card.role = "dialog";
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-label", "Skills");
  const sessions = [...new Map([...(context.sessions ?? []), ...(context.session ? [context.session] : [])].map(s => [s.id, s])).values()];
  let session = context.session;
  let entries: Skill[] = [];
  let byName = new Map<string, Skill>();
  let linksOut = new Map<string, Skill[]>();
  let linksIn = new Map<string, Skill[]>();
  let policy: SessionPolicy = { overrides: {}, applied: {} };
  let usage: Usage = { supported: false, used: [] };
  let place: Place = {};
  let mode: Mode = { kind: "read" };
  let files: string[] = [];
  let trail: Place[] = [];
  let at = -1;
  let dirty = false;
  let busy = false;
  let generation = 0;
  const openFolders = new Set<string>();

  const header = el("header", "skills-header");
  const back = button("", () => { void step(-1); });
  back.innerHTML = chevron("m15 5-7 7 7 7");
  back.className = "skills-nav"; back.title = "Back · ⌘["; back.setAttribute("aria-label", "Back");
  const forward = button("", () => { void step(1); });
  forward.innerHTML = chevron("m9 5 7 7-7 7");
  forward.className = "skills-nav"; forward.title = "Forward · ⌘]"; forward.setAttribute("aria-label", "Forward");
  const crumbs = el("nav", "skills-crumbs");
  crumbs.setAttribute("aria-label", "Location");
  const picker = el("select", "skills-select");
  picker.setAttribute("aria-label", "Skill library or session");
  picker.append(new Option("Whole library", ""));
  sessions.forEach(s => picker.append(new Option(`${providerName(s.kind)} · ${s.project} · ${s.title}`, s.id)));
  picker.value = session?.id ?? "";
  picker.hidden = !sessions.length;
  const native = button("Session /skills", () => { void (async () => {
    if (!session || !context.onInsert || busy || !await discard()) return;
    busy = true;
    try { await context.onInsert(session, "/skills"); dirty = false; busy = false; await close(false); }
    catch (e) { error(e); }
    finally { busy = false; }
  })(); });
  native.title = "Stage /skills in the terminal. Press Enter there. Native settings may affect other sessions.";
  header.append(back, forward, crumbs, picker, native, button("New skill", () => { void start({ kind: "new" }); }, true), button("Done", () => { void close(); }));

  const note = el("p", "skills-context");
  const body = el("div", "skills-layout");
  const sidebar = el("aside", "skills-sidebar");
  const search = el("input", "skills-search");
  search.type = "search";
  search.placeholder = "Search names and text";
  search.setAttribute("aria-label", "Search skills");
  const filters = el("div", "skills-filters");
  const departmentFilter = el("select", "skills-select");
  departmentFilter.setAttribute("aria-label", "Filter department");
  departmentFilter.append(new Option("All areas", ""));
  Object.entries(departments).forEach(([value, label]) => departmentFilter.append(new Option(label, value)));
  const filter = el("select", "skills-select");
  filter.setAttribute("aria-label", "Filter skill source");
  [["All sources", ""], ["Shared", "shared"], ["Claude", "claude"], ["Codex", "codex"]].forEach(([label, value]) => filter.append(new Option(label, value)));
  const refresh = button("", () => { void (async () => { if (!busy && await discard()) { dirty = false; await reload(place.path); } })(); });
  refresh.innerHTML = chevron("M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6");
  refresh.className = "skills-nav"; refresh.title = "Refresh: read the skill folders from disk again"; refresh.setAttribute("aria-label", "Refresh");
  filters.append(departmentFilter, filter, refresh);
  const list = el("div", "skills-list");
  const page = el("main", "skills-page");
  const rail = el("aside", "skills-rail");
  const status = el("div", "skills-status");
  status.role = "status";
  sidebar.append(search, filters, list);
  body.append(sidebar, page, rail);
  card.append(header, note, body, status);
  wrap.append(card);
  document.body.append(wrap);

  const error = (e: unknown) => { status.textContent = String(e); status.classList.add("is-error"); };
  const message = (text: string) => { status.textContent = text; status.classList.remove("is-error"); };
  const discard = async () => !dirty || await confirmDialog("Discard unsaved skill changes?", { okLabel: "Discard changes", danger: true });
  const current = () => entries.find(skill => skill.path === place.path);
  const close = async (restoreFocus = true) => {
    if (busy || !await discard()) return;
    generation++;
    document.removeEventListener("keydown", onKey, true);
    wrap.remove(); dismiss = undefined;
    if (restoreFocus && previousFocus?.isConnected) previousFocus.focus();
  };
  const onKey = (event: KeyboardEvent) => {
    if (document.querySelector(".dlg-wrap")) return;
    const typing = event.target instanceof HTMLElement && event.target.matches("input,textarea,select");
    if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); void close(); return; }
    if ((event.metaKey && event.key === "[") || (event.altKey && event.key === "ArrowLeft" && !typing)) { event.preventDefault(); void step(-1); return; }
    if ((event.metaKey && event.key === "]") || (event.altKey && event.key === "ArrowRight" && !typing)) { event.preventDefault(); void step(1); return; }
    if ((event.metaKey && event.key === "f") || (event.key === "/" && !typing)) { event.preventDefault(); search.focus(); search.select(); return; }
    if (event.key === "Tab") {
      const nodes = [...card.querySelectorAll<HTMLElement>("button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary")].filter(node => node.offsetParent !== null);
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  };
  dismiss = close;
  document.addEventListener("keydown", onKey, true);
  search.focus();

  // ---- The link graph. Skills name each other in backticks and link files by relative path.
  function visibleEntries() {
    return entries.filter(skill => !session || (session.kind !== "claude" && session.kind !== "codex") || skill.provider === "shared" || skill.provider === session.kind);
  }
  function index() {
    byName = new Map();
    for (const skill of entries) {
      const held = byName.get(skill.name);
      if (!held || (skill.source === "panel" && held.source !== "panel")) byName.set(skill.name, skill);
    }
    linksOut = new Map(); linksIn = new Map();
    for (const skill of entries) {
      const named = new Set<Skill>();
      for (const match of skill.body.matchAll(/`([a-z0-9-]+)`/g)) {
        const other = byName.get(match[1]);
        if (other && other.path !== skill.path) named.add(other);
      }
      for (const match of skill.body.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = resolve(match[1], { path: skill.path });
        const other = target && entries.find(entry => entry.path === target.path);
        if (other && other.path !== skill.path) named.add(other);
      }
      const out = [...named].sort((a, b) => a.name.localeCompare(b.name));
      linksOut.set(skill.path, out);
      for (const other of out) linksIn.set(other.path, [...(linksIn.get(other.path) ?? []), skill]);
    }
  }
  function home(): string | undefined {
    const panel = entries.find(skill => skill.source === "panel");
    return panel?.scope.replace(/\/\.appgeapanel\/skills\/?$/, "");
  }
  /** A link or path in a skill's text, as a place in the library. Outside every skill: none. */
  function resolve(href: string, from: Place): Place | undefined {
    const target = href.split("#")[0];
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) return undefined;
    const owner = entries.find(skill => skill.path === from.path);
    let absolute: string;
    if (target.startsWith("~/")) { const root = home(); if (!root) return undefined; absolute = root + target.slice(1); }
    else if (target.startsWith("/")) absolute = target;
    else if (owner) absolute = `${skillDir(owner)}/${from.file?.includes("/") ? from.file.replace(/\/[^/]*$/, "/") : ""}${target}`;
    else return undefined;
    absolute = normalize(absolute);
    const found = entries.filter(skill => absolute === skillDir(skill) || absolute.startsWith(`${skillDir(skill)}/`))
      .sort((a, b) => skillDir(b).length - skillDir(a).length)[0];
    if (!found) return undefined;
    const rest = absolute.slice(skillDir(found).length + 1);
    return { path: found.path, file: rest && rest !== "SKILL.md" ? rest : undefined };
  }

  // ---- Markdown, built as DOM nodes so a skill's text can never inject markup.
  function inline(text: string, into: HTMLElement, from: Place) {
    const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s)>]+)/g;
    let last = 0;
    for (const match of text.matchAll(pattern)) {
      if (match.index > last) into.append(text.slice(last, match.index));
      last = match.index + match[0].length;
      const [, code, strong, label, href, url] = match;
      if (code !== undefined) {
        const skill = byName.get(code);
        const target = skill ? { path: skill.path } : /[/.]/.test(code) ? resolve(code, from) : undefined;
        const known = target && (target.path !== place.path || !target.file || files.includes(target.file));
        if (target && known) into.append(link(code, target, skill ? "is-skill" : "is-file"));
        else into.append(el("code", "", code));
      } else if (strong !== undefined) {
        const node = el("strong", ""); inline(strong, node, from); into.append(node);
      } else if (label !== undefined && href !== undefined) {
        const target = resolve(href, from);
        if (target) into.append(link(label, target, "is-file"));
        else if (/^https?:/.test(href)) into.append(external(label, href));
        else into.append(label);
      } else if (url !== undefined) into.append(external(url, url));
    }
    if (last < text.length) into.append(text.slice(last));
  }
  function link(text: string, target: Place, kind: string) {
    const node = button(text, () => { void go(target); });
    node.className = `skills-link ${kind}`;
    const skill = entries.find(entry => entry.path === target.path);
    node.title = target.file ? `${skill?.name ?? ""} · ${target.file}` : skill?.description ?? "";
    return node;
  }
  function external(text: string, url: string) {
    const node = button(text, () => { void invoke("open_link", { url }).catch(error); });
    node.className = "skills-link is-external"; node.title = url;
    return node;
  }
  function markdown(source: string, from: Place): HTMLElement {
    const root = el("div", "skills-md");
    const lines = source.replace(/\r/g, "").split("\n");
    let paragraph: string[] = [];
    let list: HTMLElement | null = null;
    const flush = () => {
      if (paragraph.length) { const node = el("p", ""); inline(paragraph.join(" "), node, from); root.append(node); }
      paragraph = [];
    };
    const block = () => { flush(); list = null; };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fence = /^\s*(```|~~~)/.exec(line);
      if (fence) {
        block();
        const code: string[] = [];
        while (++i < lines.length && !lines[i].trim().startsWith(fence[1])) code.push(lines[i]);
        const pre = el("pre", "skills-code"); pre.append(el("code", "", code.join("\n"))); root.append(pre);
        continue;
      }
      if (!line.trim()) { block(); continue; }
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        block();
        const node = el(heading[1].length <= 2 ? "h3" : "h4", heading[1].length === 1 ? "is-top" : "");
        inline(heading[2], node, from); root.append(node);
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { block(); root.append(el("hr", "")); continue; }
      if (line.trim().startsWith("|") && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) {
        block();
        const table = el("table", "skills-table");
        const cells = (row: string) => row.trim().replace(/^\||\|$/g, "").split("|").map(cell => cell.trim());
        const head = el("tr", "");
        cells(line).forEach(cell => { const th = el("th", ""); inline(cell, th, from); head.append(th); });
        table.append(head);
        i++;
        while (i + 1 < lines.length && lines[i + 1].trim().startsWith("|")) {
          const row = el("tr", "");
          cells(lines[++i]).forEach(cell => { const td = el("td", ""); inline(cell, td, from); row.append(td); });
          table.append(row);
        }
        const scroller = el("div", "skills-table-wrap"); scroller.append(table); root.append(scroller);
        continue;
      }
      const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (item) {
        flush();
        const kind = /\d/.test(item[2]) ? "ol" : "ul";
        if (!list || list.tagName.toLowerCase() !== kind) { list = el(kind, ""); root.append(list); }
        const li = el("li", item[1].length >= 2 ? "is-nested" : "");
        inline(item[3], li, from); list.append(li);
        continue;
      }
      if (list && /^\s{2,}\S/.test(line)) { const li = (list as HTMLElement).lastElementChild as HTMLElement; li.append(" "); inline(line.trim(), li, from); continue; }
      const quote = /^\s*>\s?(.*)$/.exec(line);
      if (quote) { block(); const node = el("blockquote", ""); inline(quote[1], node, from); root.append(node); continue; }
      list = null;
      paragraph.push(line.trim());
    }
    flush();
    return root;
  }

  // ---- Navigation. Every page is a place in a trail, like a browser.
  function paintNav() {
    back.disabled = at <= 0;
    forward.disabled = at >= trail.length - 1;
    crumbs.replaceChildren();
    const skill = current();
    const root = button("Skills", () => { void go({}); });
    root.className = "skills-crumb";
    crumbs.append(root);
    if (mode.kind === "new") { crumbs.append(el("span", "skills-crumb-sep", "/"), el("span", "skills-crumb is-here", "New skill")); return; }
    if (!skill) { root.classList.add("is-here"); return; }
    const name = button(skill.name, () => { void go({ path: skill.path }); });
    name.className = `skills-crumb${place.file || mode.kind === "new-file" ? "" : " is-here"}`;
    crumbs.append(el("span", "skills-crumb-sep", "/"), name);
    const parts = mode.kind === "new-file" ? ["New file"] : place.file?.split("/") ?? [];
    parts.forEach((part, i) => crumbs.append(el("span", "skills-crumb-sep", "/"), el("span", `skills-crumb${i === parts.length - 1 ? " is-here" : " is-folder"}`, part)));
  }
  async function go(target: Place, push = true): Promise<boolean> {
    if (busy || !await discard()) return false;
    const request = ++generation;
    const sameSkill = target.path === place.path && mode.kind !== "new";
    // The page paints only after its read succeeds, so a failed read rolls back to the old place.
    const before = { place, mode, files };
    try {
      const skill = entries.find(entry => entry.path === target.path);
      if (target.path && !skill) throw new Error("This skill is not in the library any more. Press Refresh.");
      if (skill && !sameSkill) files = await invoke<string[]>("skills_resources", { path: skill.path }).catch(() => []);
      if (request !== generation || !wrap.isConnected) return false;
      place = target; mode = { kind: "read" };
      await paintPage(request);
      if (request !== generation) return false;
      if (push && !(at >= 0 && samePlace(trail[at], target))) { trail = [...trail.slice(0, at + 1), target]; at = trail.length - 1; }
      lastPlace = target; dirty = false;
      if (skill && target.file) for (let dir = target.file.replace(/\/?[^/]*$/, ""); dir; dir = dir.replace(/\/?[^/]*$/, "")) openFolders.add(`${skill.path}:${dir}`);
      paintList(); paintRail(); paintNav();
      page.scrollTop = 0;
      return true;
    } catch (e) {
      if (request === generation) { ({ place, mode, files } = before); error(e); }
      return false;
    }
  }
  async function step(delta: number) {
    const next = at + delta;
    if (next < 0 || next >= trail.length) return;
    if (await go(trail[next], false)) at = next;
    paintNav();
  }
  async function start(next: Mode) {
    if (busy || !await discard()) return;
    generation++;
    const before = { place, mode };
    mode = next; dirty = next.kind === "new" && !!next.draft;
    if (next.kind === "new") place = {};
    try { await paintPage(generation); }
    catch (e) { ({ place, mode } = before); dirty = false; error(e); return; }
    paintList(); paintRail(); paintNav();
    page.querySelector<HTMLElement>("input,textarea")?.focus();
  }

  // ---- The library list.
  function paintList() {
    list.replaceChildren();
    const query = search.value.toLowerCase().trim();
    const scoped = visibleEntries().filter(skill => (!filter.value || skill.provider === filter.value) && (!departmentFilter.value || skill.department === departmentFilter.value));
    const order = Object.keys(departments);
    const rank = (skill: Skill) => { const i = order.indexOf(skill.department); return i < 0 ? order.length : i; };
    const named = scoped.filter(skill => `${skill.name} ${skill.description}`.toLowerCase().includes(query))
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    const inText = query ? scoped.filter(skill => !named.includes(skill) && skill.body.toLowerCase().includes(query)) : [];
    const row = (skill: Skill, hint?: string) => {
      const node = button("", () => { void go({ path: skill.path }); });
      node.className = `skills-row${place.path === skill.path ? " is-selected" : ""}${skill.archived ? " is-archived" : ""}`;
      if (place.path === skill.path) node.setAttribute("aria-current", "page");
      const top = el("span", "skills-row-top");
      top.append(el("span", "skills-row-name", skill.name));
      if (skill.provider !== "shared" || skill.source === "plugin") top.append(el("span", `skills-badge source-${skill.provider}`, skill.source === "plugin" ? "Plugin" : providerName(skill.provider)));
      node.append(top, el("span", "skills-row-description", hint ?? (skill.description || "No description")));
      const used = usage.used.includes(skill.name);
      const staged = !!session && requested.get(session.id)?.has(skill.path);
      const state = used ? "Used this session" : staged ? "Request staged" : skill.archived ? "Archived" : "";
      if (state) node.append(el("span", "skills-row-state", state));
      list.append(node);
    };
    let lastDepartment = "";
    named.forEach(skill => {
      if (skill.department !== lastDepartment) { list.append(el("h3", "skills-group", departments[skill.department] ?? "General")); lastDepartment = skill.department; }
      row(skill);
    });
    if (inText.length) {
      list.append(el("h3", "skills-group", "Mentioned in the text"));
      inText.forEach(skill => {
        const at = skill.body.toLowerCase().indexOf(query);
        const snippet = skill.body.slice(Math.max(0, at - 30), at + query.length + 50).replace(/\s+/g, " ").replace(/[`*#]/g, "");
        row(skill, `…${snippet}…`);
      });
    }
    list.querySelector(".skills-row.is-selected")?.scrollIntoView({ block: "nearest" });
    if (!named.length && !inText.length) list.append(el("p", "skills-empty", query ? `No skill mentions “${search.value.trim()}”.` : "No skills match these filters."));
  }

  // ---- The rail: what this skill hands off to, what calls it, and its files.
  function paintRail() {
    rail.replaceChildren();
    const skill = current();
    if (!skill || mode.kind === "new") { rail.hidden = true; body.classList.add("is-wide"); return; }
    rail.hidden = false; body.classList.remove("is-wide");
    const section = (title: string, items: Skill[], empty: string) => {
      const node = el("section", "skills-rail-section");
      node.append(el("h3", "skills-rail-title", `${title} · ${items.length}`));
      if (!items.length) node.append(el("p", "skills-help", empty));
      const chips = el("div", "skills-chips");
      items.forEach(other => chips.append(link(other.name, { path: other.path }, "is-skill")));
      node.append(chips);
      rail.append(node);
    };
    section("Hands off to", linksOut.get(skill.path) ?? [], "Names no other skill.");
    section("Called from", linksIn.get(skill.path) ?? [], "No skill names it. Agents find it by its description.");
    const tree = el("section", "skills-rail-section");
    const head = el("div", "skills-rail-head");
    head.append(el("h3", "skills-rail-title", `Files · ${files.length}`));
    if (skill.editable) {
      const add = button("New file", () => { void start({ kind: "new-file" }); });
      add.className = "skills-mini";
      head.append(add);
    }
    tree.append(head);
    tree.append(fileTree(skill));
    rail.append(tree);
  }
  function fileTree(skill: Skill): HTMLElement {
    type Folder = { folders: Map<string, Folder>; files: string[] };
    const rootFolder: Folder = { folders: new Map(), files: [] };
    for (const file of files) {
      const parts = file.split("/");
      let folder = rootFolder;
      for (const part of parts.slice(0, -1)) {
        if (!folder.folders.has(part)) folder.folders.set(part, { folders: new Map(), files: [] });
        folder = folder.folders.get(part)!;
      }
      folder.files.push(file);
    }
    const count = (folder: Folder): number => folder.files.length + [...folder.folders.values()].reduce((sum, child) => sum + count(child), 0);
    const fileRow = (file: string) => {
      const target = file === "SKILL.md" ? { path: skill.path } : { path: skill.path, file };
      const node = button(file === "SKILL.md" ? "SKILL.md · instructions" : file.split("/").pop()!, () => { void go(target); });
      const here = samePlace(place, target) && mode.kind !== "new-file";
      node.className = `skills-file${here ? " is-here" : ""}${file.endsWith(".md") ? "" : " is-code"}`;
      if (here) node.setAttribute("aria-current", "page");
      node.title = file;
      return node;
    };
    const paint = (folder: Folder, prefix: string, into: HTMLElement) => {
      const sortedFolders = [...folder.folders.entries()].sort(([a], [b]) => a.localeCompare(b));
      const rootFiles = [...folder.files].sort((a, b) => Number(b === "SKILL.md") - Number(a === "SKILL.md") || a.localeCompare(b));
      if (!prefix) rootFiles.filter(file => file === "SKILL.md").forEach(file => into.append(fileRow(file)));
      for (const [name, child] of sortedFolders) {
        const path = prefix ? `${prefix}/${name}` : name;
        const details = el("details", "skills-folder");
        details.open = openFolders.has(`${skill.path}:${path}`);
        details.ontoggle = () => { if (details.open) openFolders.add(`${skill.path}:${path}`); else openFolders.delete(`${skill.path}:${path}`); };
        const summary = el("summary", "", name);
        summary.append(el("span", "skills-folder-count", String(count(child))));
        details.append(summary);
        const inner = el("div", "skills-folder-body");
        paint(child, path, inner);
        details.append(inner);
        into.append(details);
      }
      rootFiles.filter(file => prefix || file !== "SKILL.md").forEach(file => into.append(fileRow(file)));
    };
    const node = el("div", "skills-tree");
    paint(rootFolder, "", node);
    return node;
  }

  // ---- The page.
  function field(label: string, value: string, multiline = false, readonly = false) {
    const holder = el("label", "skills-field");
    const input = multiline ? el("textarea", "skills-input") : el("input", "skills-input");
    input.value = value; input.readOnly = readonly;
    input.oninput = () => { dirty = true; };
    holder.append(el("span", "skills-label", label), input);
    return { holder, input };
  }
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    busy = true;
    const controls = [...page.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement | HTMLSelectElement>("button,input,textarea,select")];
    const was = controls.map(control => control.disabled);
    controls.forEach(control => control.disabled = true);
    try { await action(); } catch (e) { error(e); }
    finally { busy = false; controls.forEach((control, i) => control.disabled = was[i]); }
  };
  async function paintPage(request: number) {
    const skill = current();
    if (mode.kind === "new") return paintNew(mode.draft);
    if (!skill) return paintOverview();
    if (mode.kind === "new-file") return paintNewFile(skill);
    if (place.file) {
      // Images, binaries and very large files have no text view. Show what they are instead.
      const content = await invoke<string>("skills_resource_read", { path: skill.path, relative: place.file }).then(text => ({ text }), (e: unknown) => ({ unreadable: String(e) }));
      if (request !== generation) return;
      return paintFile(skill, place.file, content);
    }
    const doc = await invoke<{ entry: Skill; content: string }>("skills_read_document", { path: skill.path });
    if (request !== generation) return;
    entries = entries.map(entry => entry.path === skill.path ? doc.entry : entry);
    paintSkill(doc.entry, doc.content);
  }
  function paintOverview() {
    page.replaceChildren();
    const shown = visibleEntries().filter(skill => !skill.archived);
    const links = shown.reduce((sum, skill) => sum + (linksOut.get(skill.path)?.length ?? 0), 0);
    const intro = el("div", "skills-page-head");
    intro.append(el("h2", "", "How the skills work"));
    intro.append(el("p", "skills-lede", `${shown.length} skills, ${links} hand-offs between them. Agents load a skill when its description fits the task. Inside, a skill names the next skill in backticks. Follow those names to walk the chain.`));
    page.append(intro);
    const group = (title: string, help: string, items: Skill[], detail: (skill: Skill) => string) => {
      if (!items.length) return;
      const section = el("section", "skills-overview");
      section.append(el("h3", "", title), el("p", "skills-help", help));
      const rows = el("div", "skills-overview-rows");
      items.forEach(skill => {
        const row = button("", () => { void go({ path: skill.path }); });
        row.className = "skills-overview-row";
        const top = el("span", "skills-row-top");
        top.append(el("span", "skills-row-name", skill.name), el("span", "skills-row-count", detail(skill)));
        row.append(top, el("span", "skills-row-description", skill.description || "No description"));
        rows.append(row);
      });
      section.append(rows);
      page.append(section);
    };
    const out = (skill: Skill) => linksOut.get(skill.path)?.length ?? 0;
    const into = (skill: Skill) => linksIn.get(skill.path)?.length ?? 0;
    group("Start here", "Routers. They hand the work to other skills.", shown.filter(skill => out(skill) >= 3).sort((a, b) => out(b) - out(a)), skill => `hands off to ${out(skill)}`);
    group("Relied on most", "Other skills send work here.", shown.filter(skill => into(skill) >= 2).sort((a, b) => into(b) - into(a)).slice(0, 10), skill => `called from ${into(skill)}`);
    group("Stand-alone", "No other skill names these. Only their description brings them in.", shown.filter(skill => !into(skill)).sort((a, b) => a.name.localeCompare(b.name)), () => "");
  }
  function pageHead(title: string, skill: Skill, sub?: string) {
    const head = el("div", "skills-page-head");
    const line = el("div", "skills-title-line");
    line.append(el("h2", "", title));
    if (skill.provider !== "shared" || skill.source === "plugin") line.append(el("span", `skills-badge source-${skill.provider}`, skill.source === "plugin" ? "Plugin" : providerName(skill.provider)));
    if (skill.archived) line.append(el("span", "skills-badge", "Archived"));
    head.append(line);
    if (sub) head.append(el("p", "skills-lede", sub));
    return head;
  }
  function paintSkill(skill: Skill, content: string) {
    page.replaceChildren();
    const editing = mode.kind === "edit" && skill.editable;
    page.append(pageHead(skill.name, skill, editing ? undefined : skill.description || "No description"));
    const meta = el("p", "skills-path", `${departments[skill.department] ?? "General"} · ${skill.source} · ${skill.path}`);
    page.append(meta);
    const actions = el("div", "skills-actions");
    if (!editing) {
      if (skill.editable) actions.append(button("Edit", () => { void start({ kind: "edit" }); }, true));
      sessionActions(skill, actions);
      actions.append(button("Copy as new skill", () => { void start({ kind: "new", draft: { name: `${skill.name}-copy`, description: skill.description, steps: skill.body } }); }));
      if (skill.editable && !skill.archived && skill.source === "panel") actions.append(button("Archive", () => { void run(async () => {
        if (!await confirmDialog("Archive this skill? New sessions stop finding it. Its files stay. Sessions that loaded it keep it.", { okLabel: "Archive skill", danger: true })) return;
        await invoke("skills_archive", { path: skill.path });
        busy = false; await reload(skill.path); message("Skill archived. Restore it from its page.");
      }); }));
      if (skill.archived && skill.editable) actions.append(button("Restore", () => { void run(async () => {
        await invoke("skills_save", { path: skill.path, name: skill.name, description: skill.description, body: skill.body, expected: content, department: skill.department });
        busy = false; await reload(skill.path); message("Skill restored. New sessions find it again.");
      }); }, true));
      page.append(actions);
      sessionPolicy(skill);
      if (!skill.editable) page.append(el("p", "skills-help", "Installed plugin. Read-only here. Copy it to make your own version."));
      // The page title already names the skill. A first heading that repeats it is noise.
      const text = skill.body.replace(/^#\s+(.*)\n/, (line, title: string) => title.trim().toLowerCase() === skill.name.toLowerCase() ? "" : line);
      page.append(markdown(text, { path: skill.path }));
      return;
    }
    const name = field("Name", skill.name, false, skill.source === "panel");
    if (skill.source === "panel") name.holder.append(el("span", "skills-help", "Shared skill names stay fixed. Other files point at them."));
    const description = field("Description · agents read this to decide when to load the skill", skill.description);
    page.append(name.holder, description.holder);
    const department = el("select", "skills-select");
    Object.entries(departments).forEach(([value, label]) => department.append(new Option(label, value)));
    department.value = skill.department;
    department.onchange = () => { dirty = true; };
    if (skill.source === "panel") { const holder = el("label", "skills-field"); holder.append(el("span", "skills-label", "Area"), department); page.append(holder); }
    const text = field("Instructions · Markdown", skill.body, true);
    text.input.classList.add("skills-markdown");
    page.append(text.holder);
    actions.append(button("Save", () => { void run(async () => {
      if (!name.input.value.trim() || !description.input.value.trim()) throw new Error("Add a name and description.");
      const saved = await invoke<Skill>("skills_save", { path: skill.path, name: name.input.value.trim(), description: description.input.value.trim(), body: text.input.value, expected: content, department: skill.source === "panel" ? department.value : null });
      dirty = false; busy = false;
      await reload(saved.path);
      message("Saved. New sessions read the new text.");
    }); }, true), button("Cancel", () => { void (async () => { if (await discard()) { dirty = false; mode = { kind: "read" }; await go(place, false); } })(); }));
    page.append(actions);
  }
  function paintFile(skill: Skill, file: string, read: { text: string } | { unreadable: string }) {
    page.replaceChildren();
    if (!("text" in read)) {
      page.append(pageHead(file.split("/").pop()!, skill, `Part of ${skill.name}`), el("p", "skills-path", `${skillDir(skill)}/${file}`));
      const actions = el("div", "skills-actions");
      actions.append(button(`Back to ${skill.name}`, () => { void go({ path: skill.path }); }));
      page.append(actions, el("p", "skills-help", `No preview. ${read.unreadable.replace(/^Error:\s*/, "")}.`));
      return;
    }
    const content = read.text;
    const editable = skill.editable && file.endsWith(".md");
    const editing = mode.kind === "edit" && editable;
    page.append(pageHead(file.split("/").pop()!, skill, `Part of ${skill.name}`));
    page.append(el("p", "skills-path", `${skillDir(skill)}/${file}`));
    const actions = el("div", "skills-actions");
    if (!editing) {
      actions.append(button(`Back to ${skill.name}`, () => { void go({ path: skill.path }); }));
      if (editable) actions.append(button("Edit", () => { void start({ kind: "edit" }); }, true));
      page.append(actions);
      if (file.endsWith(".md")) page.append(markdown(stripFrontMatter(content), place));
      else { const pre = el("pre", "skills-code is-file"); pre.append(el("code", "", content)); page.append(pre); }
      return;
    }
    const text = field("Content · Markdown", content, true);
    text.input.classList.add("skills-markdown");
    page.append(text.holder);
    actions.append(button("Save", () => { void run(async () => {
      await invoke("skills_resource_save", { path: skill.path, relative: file, content: text.input.value, expected: content });
      dirty = false; busy = false;
      await go(place, false);
      message("File saved.");
    }); }, true), button("Cancel", () => { void (async () => { if (await discard()) { dirty = false; await go(place, false); } })(); }));
    page.append(actions);
  }
  function paintNewFile(skill: Skill) {
    page.replaceChildren();
    page.append(pageHead("New file", skill, `Inside ${skill.name}. Link it from the instructions so agents find it.`));
    const filename = field("Path inside the skill", "references/topic.md");
    const text = field("Content · Markdown", "", true);
    text.input.classList.add("skills-markdown");
    page.append(filename.holder, text.holder);
    const actions = el("div", "skills-actions");
    actions.append(button("Create file", () => { void run(async () => {
      const relative = filename.input.value.trim();
      await invoke("skills_resource_save", { path: skill.path, relative, content: text.input.value, expected: null });
      dirty = false; busy = false; mode = { kind: "read" };
      place = { path: "\0" }; // a different place forces a fresh file list
      await go({ path: skill.path, file: relative });
      message(`Created ${relative}. Link it from SKILL.md with [${relative.split("/").pop()}](${relative}).`);
    }); }, true), button("Cancel", () => { void (async () => { if (await discard()) { dirty = false; mode = { kind: "read" }; await go({ path: skill.path }, false); } })(); }));
    page.append(actions);
  }
  function paintNew(draft?: { name: string; description: string; steps: string }) {
    page.replaceChildren();
    const head = el("div", "skills-page-head");
    head.append(el("h2", "", "New skill"), el("p", "skills-lede", "Write it once. Claude and Codex both find shared skills."));
    page.append(head);
    const name = field("Name", draft?.name ?? "");
    name.holder.append(el("span", "skills-help", "Lowercase letters, numbers and single hyphens. Up to 64 characters."));
    const description = field("Description · agents read this to decide when to load the skill", draft?.description ?? "");
    const department = el("select", "skills-select");
    Object.entries(departments).forEach(([value, label]) => department.append(new Option(label, value)));
    department.value = departmentFilter.value || "general";
    department.onchange = () => { dirty = true; };
    const area = el("label", "skills-field");
    area.append(el("span", "skills-label", "Area"), department);
    const trigger = field("When to use", draft ? "Use when this skill fits the current task." : "", true);
    const steps = field("Steps", draft?.steps ?? "", true);
    const output = field("Expected output", draft ? "Complete the work and report the result." : "", true);
    page.append(name.holder, description.holder, area, trigger.holder, steps.holder, output.holder);
    const actions = el("div", "skills-actions");
    actions.append(button("Create skill", () => { void run(async () => {
      if (!name.input.value.trim() || !description.input.value.trim()) throw new Error("Add a name and description.");
      if (!trigger.input.value.trim() || !steps.input.value.trim() || !output.input.value.trim()) throw new Error("Add when to use, steps and expected output.");
      const text = `## When to use\n\n${trigger.input.value.trim()}\n\n## Steps\n\n${steps.input.value.trim()}\n\n## Expected output\n\n${output.input.value.trim()}\n`;
      const saved = await invoke<Skill>("skills_save", { path: null, name: name.input.value.trim(), description: description.input.value.trim(), body: text, expected: null, department: department.value });
      dirty = false; busy = false; mode = { kind: "read" };
      await reload(saved.path);
      message("Skill created. New sessions find it.");
    }); }, true), button("Cancel", () => { void (async () => { if (await discard()) { dirty = false; mode = { kind: "read" }; await go(trail[at] ?? {}, false); } })(); }));
    page.append(actions);
  }

  // ---- Session controls, unchanged in meaning: staging writes into the terminal, never submits.
  function sessionActions(skill: Skill, actions: HTMLElement) {
    if (!session || !context.onInsert || (session.kind !== "claude" && session.kind !== "codex")) return;
    if (!skill.archived && policy.applied[skill.path] !== false) actions.append(button("Stage in session", () => { void run(async () => {
      await context.onInsert!(session!, `Use the skill at ${JSON.stringify(skill.path)} for this task. Read its SKILL.md and follow its workflow.\n`);
      const staged = requested.get(session!.id) ?? new Set<string>();
      staged.add(skill.path); requested.set(session!.id, staged);
      message("Request staged. Submit it in the session.");
      busy = false; await close(false);
    }); }));
    if (usage.used.includes(skill.name) || requested.get(session.id)?.has(skill.path)) actions.append(button("Stage stop request", () => { void run(async () => {
      await context.onInsert!(session!, `For subsequent tasks, stop using the skill at ${JSON.stringify(skill.path)} unless I request it again. Existing instructions may remain in context.\n`);
      requested.get(session!.id)?.delete(skill.path);
      message("Stop request staged. Submit it in the session. Loaded text stays in context.");
      busy = false; await close(false);
    }); }));
  }
  function sessionPolicy(skill: Skill) {
    if (!session || !(skill.provider === session.kind || skill.source === "panel" || (session.kind === "codex" && skill.provider === "shared")) || skill.source === "plugin" || skill.archived) return;
    const control = el("section", "skills-policy");
    const setting = el("select", "skills-select");
    setting.setAttribute("aria-label", "Skill availability for this session");
    [["Default", "default"], ["Enabled", "true"], ["Disabled", "false"]].forEach(([label, value]) => setting.append(new Option(label, value)));
    const settingValue = () => skill.path in policy.overrides ? String(policy.overrides[skill.path]) : "default";
    setting.value = settingValue();
    const pending = el("span", "skills-help");
    const resume = button("Apply and resume…", () => { void (async () => {
      if (busy || !context.onRestart || !session || !await discard()) return;
      busy = true; resume.disabled = true;
      try {
        const previous = session;
        session = await context.onRestart(session);
        if (session.terminal_id === previous.terminal_id) return;
        dirty = false; busy = false; await reload(skill.path);
        await close(false);
      } catch (e) { error(e); }
      finally { busy = false; resume.disabled = false; }
    })(); });
    const paintPolicy = () => {
      const paths = new Set([...Object.keys(policy.overrides), ...Object.keys(policy.applied)]);
      const needsRestart = [...paths].some(path => policy.overrides[path] !== policy.applied[path]);
      pending.textContent = needsRestart ? "Pending restart" : Object.keys(policy.applied).length ? "Session settings applied" : "Using agent defaults";
      resume.hidden = !needsRestart || !context.onRestart;
    };
    setting.onchange = () => { void (async () => {
      if (busy) { setting.value = settingValue(); return; }
      busy = true; setting.disabled = true;
      try {
        policy = await invoke<SessionPolicy>("skills_session_set", { session: session!.id, path: skill.path, enabled: setting.value === "default" ? null : setting.value === "true" });
        paintPolicy();
      } catch (e) { setting.value = settingValue(); error(e); }
      finally { busy = false; setting.disabled = false; }
    })(); };
    paintPolicy();
    control.append(el("span", "skills-label", "In this session"), setting, pending, resume, el("p", "skills-help", "Only this session. Restart opens the agent’s conversation picker. Loaded text stays in resumed history."));
    page.append(control);
  }

  async function reload(path?: string) {
    const request = ++generation;
    message("Loading skills…");
    try {
      const [catalog, observed, settings] = await Promise.all([
        invoke<Skill[]>("skills_catalog", { session: session?.id ?? null }),
        session ? invoke<Usage>("skills_usage", { session: session.id }) : Promise.resolve({ supported: false, used: [] }),
        session && (session.kind === "claude" || session.kind === "codex") ? invoke<SessionPolicy>("skills_session_policy", { session: session.id }) : Promise.resolve({ overrides: {}, applied: {} }),
      ]);
      if (request !== generation || !wrap.isConnected) return;
      entries = catalog; usage = observed; policy = settings;
      index();
      native.hidden = !session || !context.onInsert || (session.kind !== "claude" && session.kind !== "codex");
      const supported = !session || session.kind === "claude" || session.kind === "codex";
      note.textContent = !supported ? "This session's engine has no skills. Showing the whole library." : session ? `${providerName(session.kind)} session · ${usage.supported ? "Usage shows skills this session called." : "This engine does not report which skills it used."}${usage.used.length ? ` Used: ${usage.used.join(", ")}.` : ""}` : "";
      note.hidden = !note.textContent;
      message(`${entries.length} skills`);
      const target: Place = path !== undefined ? { path } : entries.some(skill => skill.path === lastPlace.path) ? lastPlace : {};
      place = { path: "\0" }; // a fresh load always refreshes the file list
      mode = { kind: "read" };
      if (!await go(target)) { place = {}; paintList(); paintRail(); paintNav(); }
    } catch (e) { if (request === generation) error(e); }
  }
  picker.onchange = () => { void (async () => {
    if (busy || !await discard()) { picker.value = session?.id ?? ""; return; }
    session = sessions.find(s => s.id === picker.value); filter.value = ""; dirty = false;
    await reload(place.path);
  })(); };
  search.oninput = paintList; filter.onchange = paintList; departmentFilter.onchange = paintList;
  search.onkeydown = event => {
    if (event.key === "Enter") { event.preventDefault(); list.querySelector<HTMLButtonElement>(".skills-row")?.click(); }
    if (event.key === "ArrowDown") { event.preventDefault(); list.querySelector<HTMLButtonElement>(".skills-row")?.focus(); }
  };
  list.onkeydown = event => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = [...list.querySelectorAll<HTMLButtonElement>(".skills-row")];
    const i = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    event.preventDefault();
    if (event.key === "ArrowUp" && i === 0) search.focus();
    else rows[Math.max(0, Math.min(rows.length - 1, i + (event.key === "ArrowDown" ? 1 : -1)))].focus();
  };
  paintNav();
  await reload();
}
