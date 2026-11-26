import { invoke } from "@tauri-apps/api/core";
import type { EditorState } from "@codemirror/state";
import { createCodeEditor } from "./editor";
import { errorText } from "../errors";
import "./project_desk.css";

type Document = { path: string; title: string; text: string; writable: boolean; todo_lines: number[] | null };
type Release = { platform: string; tag: string; at: string; pending: number | null; changes: string[] };
type Todo = { path: string; line: number; state: "todo" | "done" | "blocked"; text: string };
type Desk = { documents: Document[]; releases: Release[]; recent: string[]; dirty: string[]; errors: string[]; todos: Todo[]; release_target: string; latest_commit_at: string };
type Summary = { id: string; name: string; group: string; releases: Omit<Release, "changes">[]; open_todos: number; blocked_todos: number; release_target: string; dirty_count: number; latest_commit_at: string; errors: string[] };
type Memory = { doc: Document; heading: string; body: string; line: number };
export type ProjectDeskHandle = { open(): Promise<void>; clear(): void; sync(): void };
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag); el.className = cls; el.textContent = text; return el;
};
const button = (text: string, action: () => void, cls = "pd-button"): HTMLButtonElement => {
  const el = node("button", cls, text); el.type = "button"; el.onclick = action; return el;
};
const field = (label: string, placeholder: string, type = "text"): HTMLInputElement => {
  const el = node("input", "pd-input"); el.type = type; el.placeholder = placeholder; el.setAttribute("aria-label", label); return el;
};
const stamp = (value: string): number => Date.parse(value) || 0;
const absolute = (value: string): string => stamp(value) ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Unknown";
const relative = (value: string): string => {
  if (!stamp(value)) return "No activity";
  const mins = Math.max(0, Math.floor((Date.now() - stamp(value)) / 60000));
  return mins < 1 ? "Just now" : mins < 60 ? `${mins}m ago` : mins < 1440 ? `${Math.floor(mins / 60)}h ago` : `${Math.floor(mins / 1440)}d ago`;
};
const overdue = (value: string): boolean => stamp(value) > 0 && stamp(value) < Date.now();
const targetLabel = (value: string): string => {
  if (!value) return "No target";
  if (!stamp(value)) return "Invalid target";
  const hours = Math.ceil(Math.abs(stamp(value) - Date.now()) / 3600000);
  const distance = hours < 24 ? `${Math.max(1, hours)}h` : `${Math.ceil(hours / 24)}d`;
  return overdue(value) ? `${distance} overdue` : `In ${distance}`;
};
const platform = (value: string): string => value === "ios" ? "iOS" : value === "android" ? "Android" : "Project";
const pending = (p: Summary): number => Math.max(0, ...p.releases.map((r) => r.pending ?? 0));
const attention = (p: Summary): boolean => overdue(p.release_target) || p.blocked_todos > 0 || p.errors.length > 0;
const plain = (text: string): string => text.replace(/!?(\[([^\]]+)\])\([^)]+\)/g, "$2").replace(/[`*_]/g, "").trim();

/** Index sections, ignoring frontmatter and headings inside code fences. */
function memoryIndex(documents: Document[]): Memory[] {
  const out: Memory[] = [];
  for (const doc of documents) {
    let heading = doc.title, body: string[] = [], start = 1, front = false, fence = "";
    const flush = (): void => { if (body.join("\n").trim()) out.push({ doc, heading, body: body.join("\n").trim(), line: start }); };
    doc.text.split("\n").forEach((line, i) => {
      if (i === 0 && line.trim() === "---") { front = true; return; }
      if (front) { if (line.trim() === "---") front = false; return; }
      const marker = line.trim().match(/^(`{3,}|~{3,})/);
      if (marker) {
        if (!fence) fence = marker[1];
        else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = "";
        body.push(line); return;
      }
      const title = !fence && line.match(/^#{1,6}\s+(.+?)(?:\s+#+)?$/);
      if (title) { flush(); heading = plain(title[1]); body = []; start = i + 1; }
      else if (!/^Release target:/.test(line)) body.push(line);
    });
    flush();
  }
  return out;
}

export function mountProjectDesk(host: HTMLElement, openProject: (id: string) => void): ProjectDeskHandle {
  host.className = "project-desk";
  let visible = false, selected = "", desk: Desk | null = null;
  let summaries: Summary[] = [], overviewLoaded = false, overviewDirty = true;
  let generation = 0, reading = false, busy = false, updated = "";
  let filter = "all", query = "", editing: Document | null = null, loadingEditor = false;
  let targetEditing = false;
  const drafts = new Map<string, { state: EditorState; base: string }>();
  const captures = new Map<string, string>();
  const queries = new Map<string, string>();
  const targets = new Map<string, string>();
  const undo = new Map<string, { path: string; before: string; after: string }>();
  const header = node("header", "pd-header");
  const heading = node("div", "pd-heading");
  const back = button("‹ All projects", () => { if (!busy) { leaveEditor(); selected = ""; desk = null; targetEditing = false; void reload(); } }, "pd-back");
  const title = node("h1", "", "Project desk"); heading.append(back, title);
  const actions = node("div", "pd-actions");
  const open = button("Open workspace ↗", () => { if (selected) openProject(selected); });
  const refresh = button("Refresh", () => void reload()); actions.append(open, refresh); header.append(heading, actions);
  const feedback = node("div", "pd-feedback");
  const status = node("span"); status.setAttribute("role", "status");
  const undoButton = button("Undo", () => void undoLast(), "pd-link"); feedback.append(status, undoButton);
  const content = node("div", "pd-content");
  const edit = node("section", "pd-edit"); edit.hidden = true;
  const editHead = node("div", "pd-edit-head"); const editTitle = node("b");
  const save = button("Save", () => void saveEditor(), "pd-button is-primary");
  const editBack = button("Back to project", () => { if (!busy) { leaveEditor(); paintProject(); } });
  editHead.append(editTitle, save, editBack);
  const editorHost = node("div", "pd-editor"); edit.append(editHead, editorHost);
  host.replaceChildren(header, feedback, content, edit);
  const code = createCodeEditor({ parent: editorHost, visibilityHost: edit,
    onSave: () => void saveEditor(),
    onUpdate: (update) => {
      if (!loadingEditor && update.docChanged && editing) notice(code.doc() === editing.text ? "Saved" : "Unsaved draft · ⌘S to save");
    },
    onReconfigure: (apply) => { for (const draft of drafts.values()) draft.state = apply(draft.state); },
  });
  function notice(text: string, error = false): void {
    status.textContent = text; feedback.classList.toggle("is-error", error);
    undoButton.hidden = !selected || !undo.has(selected) || !!editing;
  }
  function chrome(): void {
    back.hidden = !selected; open.hidden = !selected;
    title.textContent = selected ? summaries.find((p) => p.id === selected)?.name ?? selected : "Project desk";
    refresh.disabled = busy || reading || !!editing;
    save.disabled = busy;
  }
  function park(): void { if (editing) drafts.set(editing.path, { state: code.view.state, base: editing.text }); }
  function leaveEditor(): void { park(); editing = null; edit.hidden = true; content.hidden = false; chrome(); }
  function openDocument(doc: Document, line = 1): void {
    if (busy) return;
    park(); editing = { ...doc };
    const draft = drafts.get(doc.path);
    loadingEditor = true;
    if (draft && (draft.base === doc.text || draft.state.doc.toString() !== draft.base)) {
      editing.text = draft.base; code.show(draft.state);
    } else code.load(doc.path, doc.text);
    loadingEditor = false;
    editTitle.textContent = doc.title; editTitle.title = doc.path;
    content.hidden = true; edit.hidden = false;
    notice(code.doc() === editing.text ? "Saved · Markdown" : "Unsaved draft · ⌘S to save");
    chrome(); code.view.requestMeasure(); code.jumpTo(line);
  }
  async function write(doc: Document, text: string): Promise<boolean> {
    if (busy || reading) return false;
    const draft = drafts.get(doc.path);
    if (!editing && draft && draft.state.doc.toString() !== draft.base) {
      openDocument(doc); notice("Save this draft before changing the same file.", true); return false;
    }
    busy = true; chrome(); notice("Saving…");
    const project = selected, before = doc.text;
    try {
      const value = await invoke<Desk>("project_desk_save", { project, path: doc.path, text, expect: before });
      doc.text = text;
      undo.set(project, { path: doc.path, before, after: text });
      overviewDirty = true;
      if (selected === project) { desk = value; updateSummary(value); }
      if (!editing || editing.path !== doc.path) drafts.delete(doc.path);
      notice("Saved"); return true;
    } catch (error) { notice(errorText(error, "Could not save. Try again."), true); return false; }
    finally { busy = false; chrome(); }
  }
  async function saveEditor(): Promise<void> {
    if (!editing) return;
    const doc = editing;
    if (code.doc() === doc.text) { notice("Saved"); return; }
    if (await write(doc, code.doc())) {
      if (editing === doc) park();
    }
  }
  async function undoLast(): Promise<void> {
    const previous = undo.get(selected);
    const doc = desk?.documents.find((d) => d.path === previous?.path);
    if (!previous || !doc) return;
    if (doc.text !== previous.after) { undo.delete(selected); notice("This file changed. The previous edit can no longer be undone.", true); return; }
    if (await write(doc, previous.before)) { undo.delete(selected); paintProject(); notice("Edit undone"); }
  }
  function updateSummary(value: Desk): void {
    const summary = summaries.find((p) => p.id === selected);
    if (!summary) return;
    Object.assign(summary, { releases: value.releases, open_todos: value.todos.filter((t) => t.state !== "done").length,
      blocked_todos: value.todos.filter((t) => t.state === "blocked").length, release_target: value.release_target,
      dirty_count: value.dirty.length, latest_commit_at: value.latest_commit_at, errors: value.errors });
  }
  async function choose(id: string): Promise<void> {
    if (busy) return;
    leaveEditor(); selected = id; desk = null; targetEditing = false;
    content.scrollTop = 0; await reload();
  }
  function section(label: string, count?: number): HTMLElement {
    const el = node("section", "pd-section"); const head = node("div", "pd-section-head");
    head.append(node("h2", "", label)); if (count !== undefined) head.append(node("span", "pd-count", String(count)));
    el.append(head); return el;
  }
  function paintOverview(): void {
    chrome(); content.replaceChildren();
    const toolbar = node("div", "pd-toolbar");
    const search = field("Find a project", "Find a project…", "search"); search.value = query;
    const filters = node("div", "pd-filters"); filters.setAttribute("aria-label", "Filter projects");
    const rows = node("div", "pd-overview");
    const hint = node("p", "pd-caption", "Overdue first · then blocked tasks and changes since release tags");
    const stats = node("div", "pd-overview-stats");
    const late = summaries.filter((p) => overdue(p.release_target)).length;
    stats.append(node("b", late ? "pd-risk" : "", late ? `${late} overdue` : "No overdue targets"),
      node("span", "", `${summaries.filter((p) => pending(p) > 0).length} with changes`),
      node("span", "", `${summaries.reduce((n, p) => n + p.open_todos, 0)} open tasks`));
    const repaint = (): void => {
      filters.replaceChildren();
      for (const [key, label] of [["all", "All projects"], ["attention", "Needs attention"], ["changes", "With changes"]]) {
        const tab = button(label, () => { filter = key; repaint(); }, "pd-filter");
        tab.classList.toggle("is-selected", filter === key); tab.setAttribute("aria-pressed", String(filter === key)); filters.append(tab);
      }
      rows.replaceChildren();
      const columns = node("div", "pd-overview-labels");
      for (const text of ["Project", "Release target", "Since release tags", "Tasks", "Recent"]) columns.append(node("span", "", text));
      rows.append(columns);
      const matches = summaries.filter((p) => `${p.name} ${p.group}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
        .filter((p) => filter === "attention" ? attention(p) : filter === "changes" ? pending(p) > 0 || p.dirty_count > 0 : true)
        .sort((a, b) => Number(overdue(b.release_target)) - Number(overdue(a.release_target)) ||
          (overdue(a.release_target) && overdue(b.release_target) ? stamp(a.release_target) - stamp(b.release_target) : 0) ||
          b.blocked_todos - a.blocked_todos || pending(b) - pending(a) || b.open_todos - a.open_todos || stamp(b.latest_commit_at) - stamp(a.latest_commit_at) || a.name.localeCompare(b.name));
      for (const p of matches) {
        const row = button("", () => void choose(p.id), "pd-overview-row"); row.classList.toggle("is-overdue", overdue(p.release_target));
        const name = node("span", "pd-row-name"); name.append(node("b", "", p.name), node("small", "", p.group || "Project"));
        const target = node("span", overdue(p.release_target) ? "pd-row-target pd-risk" : "pd-row-target");
        target.append(node("b", "", targetLabel(p.release_target)), node("small", "", p.release_target ? absolute(p.release_target) : "Set a release date"));
        const changes = node("span", "pd-row-changes");
        const known = p.releases.filter((r) => r.tag && r.pending !== null);
        changes.append(node("b", "", known.length ? known.map((r) => `${platform(r.platform)} ${r.pending}`).join(" · ") : "No baseline"));
        changes.append(node("small", "", p.errors.length ? "Some data unavailable" : p.dirty_count ? `${p.dirty_count} uncommitted files` : "Working tree clean"));
        const tasks = node("span", "pd-row-tasks"); tasks.append(node("b", "", `${p.open_todos} open`), node("small", p.blocked_todos ? "pd-risk" : "", p.blocked_todos ? `${p.blocked_todos} blocked` : ""));
        const recent = node("span", "pd-row-recent", relative(p.latest_commit_at)); recent.title = absolute(p.latest_commit_at);
        row.append(name, target, changes, tasks, recent); rows.append(row);
      }
      if (!matches.length) rows.append(node("p", "pd-empty", summaries.length ? "No projects match this view." : "Add a project to start tracking work."));
    };
    search.oninput = () => { query = search.value; repaint(); };
    toolbar.append(filters, search); content.append(stats, toolbar, hint, rows); repaint();
  }
  function paintProject(): void {
    if (!desk) return;
    chrome(); content.replaceChildren();
    const own = desk.documents[0];
    const overview = node("div", "pd-project-status");
    const target = button(targetLabel(desk.release_target), () => { targetEditing = !targetEditing; paintProject(); if (targetEditing) content.querySelector<HTMLInputElement>('input[type="datetime-local"]')?.focus(); }, "pd-target-button");
    target.classList.toggle("is-overdue", overdue(desk.release_target));
    target.disabled = !own;
    target.title = desk.release_target ? `Release target: ${absolute(desk.release_target)}` : "Set release target";
    const targetCopy = node("div", "pd-target-copy"); targetCopy.append(node("small", "", "Release target"), target);
    overview.append(targetCopy);
    for (const item of desk.releases) {
      const metric = node("div", "pd-status-metric");
      metric.append(node("small", "", platform(item.platform)), node("b", "", item.pending === null ? "No release baseline" : `${item.pending} since tag`));
      overview.append(metric);
    }
    const dirty = node("div", "pd-status-metric"); dirty.append(node("small", "", "Working tree"), node("b", "", `${desk.dirty.length} uncommitted`)); overview.append(dirty);
    content.append(overview);
    if (targetEditing && own) {
      const form = node("form", "pd-target-form"); const input = field("Release target", "", "datetime-local");
      input.value = targets.get(selected) ?? desk.release_target; input.oninput = () => targets.set(selected, input.value);
      const submit = node("button", "pd-button is-primary", "Save target"); submit.type = "submit";
      const saveTarget = async (value: string): Promise<void> => {
        const line = `Release target: ${value}`;
        const text = /^Release target:[^\r\n]*$/m.test(own.text) ? own.text.replace(/^Release target:[^\r\n]*$/m, () => line) : `${line}\n\n${own.text}`;
        if (await write(own, text)) { targets.delete(selected); targetEditing = false; paintProject(); }
      };
      form.onsubmit = (event) => { event.preventDefault(); void saveTarget(input.value); };
      form.append(input, submit, button("Clear", () => void saveTarget("")), button("Cancel", () => { targetEditing = false; targets.delete(selected); paintProject(); }));
      content.append(form);
    }
    if (desk.errors.length) {
      const errors = node("details", "pd-errors"); errors.append(node("summary", "", "Some project data is unavailable"));
      errors.append(node("p", "", desk.errors.join("\n"))); content.append(errors);
    }
    const columns = node("div", "pd-work-columns"); columns.append(buildTodos(), buildReleases()); content.append(columns, buildMemory(), buildRecent());
  }
  function buildTodos(): HTMLElement {
    const value = desk!;
    const open = value.todos.filter((t) => t.state !== "done").sort((a, b) => Number(b.state === "blocked") - Number(a.state === "blocked"));
    const done = value.todos.filter((t) => t.state === "done");
    const el = section("Next actions", open.length); const own = value.documents[0];
    if (!own) { el.append(node("p", "pd-empty", "Project notes could not load. Refresh to try again.")); return el; }
    const form = node("form", "pd-compose"); const input = field("New todo", "Add a task. Enter to save.");
    input.value = captures.get(selected) ?? ""; input.required = true; input.oninput = () => captures.set(selected, input.value);
    const add = node("button", "pd-button is-primary", "Add"); add.type = "submit"; form.append(input, add);
    form.onsubmit = (event) => {
      event.preventDefault(); const text = input.value.trim(); if (!text) return;
      const next = /^## Todos\r?$/m.test(own.text) ? own.text.replace(/^## Todos\r?$/m, (heading) => `${heading}\n- [ ] ${text}`) : `${own.text}\n## Todos\n- [ ] ${text}\n`;
      void write(own, next).then((ok) => {
        if (ok) { captures.delete(selected); paintProject(); content.querySelector<HTMLInputElement>('input[aria-label="New todo"]')?.focus(); }
      });
    }; el.append(form);
    const list = node("div", "pd-task-list");
    const row = (todo: Todo): HTMLElement => {
      const doc = value.documents.find((d) => d.path === todo.path)!;
      const item = node("div", `pd-todo ${todo.state === "done" ? "is-done" : ""}`);
      const check = node("input"); check.type = "checkbox"; check.checked = todo.state === "done"; check.setAttribute("aria-label", `Complete ${todo.text}`);
      const change = async (state: Todo["state"]): Promise<void> => {
        const lines = doc.text.split("\n");
        lines[todo.line] = lines[todo.line].replace(/\[[ xX!]\]/, `[${state === "done" ? "x" : state === "blocked" ? "!" : " "}]`);
        if (await write(doc, lines.join("\n"))) paintProject();
        else { check.checked = todo.state === "done"; check.disabled = false; }
      };
      check.onchange = () => { check.disabled = true; void change(check.checked ? "done" : "todo"); };
      const copy = node("div", "pd-task-copy"); const label = node("span", "", todo.text);
      copy.append(label, button(doc.title, () => openDocument(doc, todo.line + 1), "pd-source"));
      item.append(check, copy);
      if (todo.state !== "done") {
        item.append(button(todo.state === "blocked" ? "Blocked" : "Block", () => void change(todo.state === "blocked" ? "todo" : "blocked"), todo.state === "blocked" ? "pd-task-state is-blocked" : "pd-task-state"));
      }
      return item;
    };
    for (const todo of open) list.append(row(todo));
    if (!open.length) list.append(node("p", "pd-empty", "No open tasks. Capture the next useful action above."));
    el.append(list);
    if (done.length) { const completed = node("details", "pd-completed"); completed.append(node("summary", "", `${done.length} completed`)); for (const todo of done) completed.append(row(todo)); el.append(completed); }
    return el;
  }
  function buildReleases(): HTMLElement {
    const el = section("Waiting to ship");
    const hint = node("p", "pd-caption", "Changes since local release tags · store status unverified"); el.append(hint);
    const list = node("div", "pd-release-list");
    for (const release of desk!.releases) {
      const group = node("article", "pd-release"); const head = node("div", "pd-release-head");
      head.append(node("b", "", platform(release.platform)), node("span", "pd-count", release.pending === null ? "Unknown" : `${release.pending} changes`));
      group.append(head);
      const date = node("p", "pd-caption", release.tag ? `${release.tag} · ${absolute(release.at)}` : "No matching tag on this branch."); date.title = `Tag / commit time: ${absolute(release.at)}`; group.append(date);
      const show = (lines: string[], parent: HTMLElement): void => {
        for (const line of lines) { const parts = line.split(" · "); const hash = parts.shift() ?? ""; const entry = node("p", "pd-change", parts.join(" · ") || line); entry.title = hash; parent.append(entry); }
      };
      show(release.changes.slice(0, 5), group);
      if (release.changes.length > 5) { const more = node("details"); more.append(node("summary", "", `Show ${release.changes.length - 5} more`)); show(release.changes.slice(5), more); group.append(more); }
      if (release.pending === 0) group.append(node("p", "pd-caption", "No committed changes since this tag."));
      if (release.pending !== null && release.pending > release.changes.length) group.append(node("small", "pd-caption", `Newest ${release.changes.length} of ${release.pending} shown`));
      list.append(group);
    }
    const dirty = node("details", "pd-working"); dirty.append(node("summary", "", `${desk!.dirty.length} uncommitted files`));
    for (const line of desk!.dirty) dirty.append(node("p", "pd-change", line)); list.append(dirty); el.append(list); return el;
  }
  function buildMemory(): HTMLElement {
    const el = section("Second brain"); el.classList.add("pd-memory");
    const add = button("Write a note", () => {
      const doc = desk!.documents[0]; const line = doc.text.split("\n").findIndex((line) => line === "## Notes"); openDocument(doc, line < 0 ? 1 : line + 2);
    }); add.disabled = !desk!.documents.length; el.querySelector(".pd-section-head")!.append(add);
    const search = field("Search project memory", "Find a decision, note, or report…", "search"); search.value = queries.get(selected) ?? "";
    const results = node("div", "pd-memory-results");
    const index = memoryIndex(desk!.documents);
    const draw = (): void => {
      results.replaceChildren(); const query = search.value.toLocaleLowerCase().trim();
      const terms = query.split(/\s+/).filter(Boolean);
      const hits = index.filter((item) => terms.every((term) => `${item.doc.title} ${item.heading} ${item.body}`.toLocaleLowerCase().includes(term)));
      const all = node("div", "pd-memory-count", `${hits.length} sections · ${desk!.documents.length} source files`); results.append(all);
      const append = (items: Memory[]): void => {
        for (const item of items) {
          const detail = node("details", "pd-memory-result"); const summary = node("summary");
          const match = item.body.split("\n").find((line) => terms.length && terms.some((term) => line.toLocaleLowerCase().includes(term))) ?? item.body.split("\n").find((line) => line.trim()) ?? "";
          summary.append(node("b", "", item.heading), node("span", "pd-caption", item.doc.title), node("p", "pd-excerpt", plain(match).slice(0, 190)));
          const body = node("div", "pd-memory-body");
          detail.append(summary, body);
          detail.addEventListener("toggle", () => {
            if (!detail.open) { body.replaceChildren(); return; }
            for (const other of results.querySelectorAll<HTMLDetailsElement>(".pd-memory-result")) if (other !== detail) other.open = false;
            body.replaceChildren(node("div", "pd-memory-copy", item.body));
            if (item.doc.writable) body.append(button("Edit source", () => openDocument(item.doc, item.line)));
            const source = node("small", "pd-path", item.doc.path); body.append(source);
          });
          results.append(detail);
        }
      };
      append(hits.slice(0, 10));
      if (hits.length > 10) { const more = button(`Show remaining ${hits.length - 10} sections`, () => { more.remove(); append(hits.slice(10)); }); results.append(more); }
      if (!hits.length) results.append(node("p", "pd-empty", query ? "No matching notes. Try another word." : "No notes yet. Write the first decision worth keeping."));
    };
    search.oninput = () => { queries.set(selected, search.value); draw(); };
    el.append(search, results); draw(); return el;
  }
  function buildRecent(): HTMLElement {
    const el = node("details", "pd-recent"); el.append(node("summary", "", "Recent work"));
    const reports = desk!.documents.find((d) => d.title === "Agent reports");
    if (reports) for (const item of memoryIndex([reports]).slice(-5).reverse()) {
      const detail = node("details", "pd-report"); detail.append(node("summary", "", item.heading), node("div", "pd-memory-copy", item.body)); el.append(detail);
    }
    for (const line of desk!.recent) {
      const parts = line.split(" · "); const when = parts.shift() ?? ""; const hash = parts.shift(); const project = parts.pop();
      const entry = node("div", "pd-recent-row"); const copy = node("span", "", parts.join(" · ")); copy.title = `${project} · ${hash}`;
      const time = node("time", "pd-caption", relative(when)); time.dateTime = when; time.title = absolute(when); entry.append(copy, time); el.append(entry);
    }
    if (!reports && !desk!.recent.length) el.append(node("p", "pd-empty", "No recent work recorded.")); return el;
  }
  async function reload(): Promise<void> {
    if (busy || editing) return;
    const ticket = ++generation; reading = true; chrome(); notice("Reading project data…");
    if (!selected && !overviewLoaded || selected && !desk) content.replaceChildren(node("p", "pd-empty", selected ? "Reading this project…" : "Reading your projects…"));
    try {
      if (selected) {
        const value = await invoke<Desk>("project_desk", { project: selected });
        if (ticket !== generation || !visible) return;
        desk = value; updateSummary(value); updated = `Updated ${new Date().toLocaleTimeString()}`; paintProject(); notice(updated);
      } else {
        const values = !overviewLoaded || overviewDirty ? await invoke<Summary[]>("project_desk_overview") : summaries;
        if (ticket !== generation || !visible) return;
        summaries = values; overviewLoaded = true; overviewDirty = false; updated = `Updated ${new Date().toLocaleTimeString()}`; paintOverview(); notice(updated);
      }
    } catch (error) { if (ticket === generation && visible) notice(errorText(error, "Could not read the project desk. Press Refresh to try again."), true); }
    finally { if (ticket === generation) { reading = false; chrome(); } }
  }
  refresh.onclick = () => { overviewDirty = true; void reload(); };
  return {
    async open() {
      visible = true; overviewDirty = true;
      if (editing) { code.view.requestMeasure(); return; }
      await reload();
    },
    clear() { park(); visible = false; generation++; reading = false; },
    sync() { overviewDirty = true; if (visible && !editing && !busy && !reading) notice("New activity available · Refresh to update"); },
  };
}
