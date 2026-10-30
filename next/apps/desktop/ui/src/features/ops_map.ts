/**
 * Ops map — the company brain as a network.
 *
 * One screen for two questions: what finished lately, and what is stuck. The map is who holds
 * what (ops_graph.ts builds it); the column beside it is the same facts as a reading list, worst
 * first. Hover anything in either and its part of the network lights. Click a node and the column
 * narrows to it.
 *
 * Everything is read from the ops tree on open and again whenever the host says a file changed.
 * Nothing here writes. Where a line lives is one click away, so fixing it happens in the file.
 *
 * MOTION: none. The layout is solved before the first paint and drawn at rest. Focus changes
 * opacity only, inside the motion budget.
 */

import { invoke } from "@tauri-apps/api/core";
import { errorNote } from "../errors";
import { plainText } from "../plain";
import { buildGraph, humanDates, layout, STALL_DAYS, type DoneRow, type Graph, type GraphNode, type OpsMapData, type Thread, type Tone } from "./ops_graph";
import "./ops_map.css";

export type OpsMapEvents = {
  openProject(project: string): void;
  openFile(path: string, line?: number): void;
  /** Two weeks of commits for a project, from the rail's own cache. */
  activity(project: string): Promise<{ days: number[] } | null>;
};

export type OpsMapHandle = { open(): void; clear(): void; sync(): void };

const SVG = "http://www.w3.org/2000/svg";
const WINDOWS = [7, 14, 30] as const;
const SPAN: Record<(typeof WINDOWS)[number], string> = { 7: "1 week", 14: "2 weeks", 30: "1 month" };
/** Width of one character of a map name, in map units. Names keep their size when the map
 *  zooms out (see `--om-zoom`), so this is measured at the smallest zoom that still compensates. */
const LABEL_PX = 8.6;

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text) el.textContent = text;
  return el;
};
const s = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] => {
  const el = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value));
  return el;
};
const fileName = (path: string): string => path.split("/").pop() ?? path;
const shortDate = (date: string): string =>
  new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
const days = (n: number): string => (n === 1 ? "1 day" : `${n} days`);
const ago = (n: number): string => (n === 0 ? "updated today" : n === 1 ? "updated yesterday" : `updated ${days(n)} ago`);
/** A list of names, short: two read as a pair, more than three as a count. */
const nameList = (names: string[]): string =>
  names.length > 3 ? `${names.length} apps` : names.length === 3 ? `${names[0]}, ${names[1]} and ${names[2]}` : names.join(" and ");

export function mountOpsMap(root: HTMLElement, events: OpsMapEvents): OpsMapHandle {
  root.classList.add("ops-map");
  root.replaceChildren();

  /* ------------------------------------------------------------ chrome */
  const header = h("header", "om-header");
  const heading = h("div", "om-heading");
  heading.append(h("h1", "", "Ops map"));
  const stats = h("div", "om-stats");
  heading.append(stats);
  const actions = h("div", "om-actions");
  const windowGroup = h("div", "om-segment");
  windowGroup.setAttribute("role", "radiogroup");
  windowGroup.setAttribute("aria-label", "Done within");
  const quietToggle = h("button", "om-chip");
  quietToggle.type = "button";
  const fitButton = h("button", "om-chip", "Fit to screen");
  fitButton.type = "button";
  actions.append(windowGroup, quietToggle, fitButton);
  header.append(heading, actions);

  const body = h("div", "om-body");
  const stage = h("div", "om-stage");
  const svg = s("svg", { class: "om-svg", role: "group", "aria-label": "Ops network" });
  const world = s("g", { class: "om-world" });
  const edgeLayer = s("g", { class: "om-edges" });
  const nodeLayer = s("g", { class: "om-nodes" });
  world.append(edgeLayer, nodeLayer);
  svg.append(world);
  const legend = h("div", "om-legend");
  legend.innerHTML =
    '<span><i class="lg-line t-risk"></i>Late</span><span><i class="lg-line t-warn"></i>Needs you</span>' +
    '<span><i class="lg-line t-warn is-dashed"></i>Stuck</span><span><i class="lg-line t-work"></i>Moving</span>' +
    '<span><i class="lg-ring"></i>Done recently</span><span><i class="lg-diamond"></i>Rollout: one change, many apps</span>';
  const stageNote = h("div", "om-stage-note");
  stage.append(svg, legend, stageNote);
  const side = h("aside", "om-side");
  side.setAttribute("aria-label", "Ops list");
  body.append(stage, side);
  root.append(header, body);

  /* ------------------------------------------------------------ state */
  let data: OpsMapData | null = null;
  let graph: Graph | null = null;
  /** Everything, quiet apps included. The map draws `graph`; a detail can name any app. */
  let full: Graph | null = null;
  let windowDays: (typeof WINDOWS)[number] = 14;
  let showQuiet = false;
  /** The node the column is narrowed to, and the row open in the column. Independent: opening
   *  a row inside an app's detail keeps you in that app. */
  let pinned: string | null = null;
  let selected: { kind: "thread" | "done"; id: string } | null = null;
  let paintedFor: string | null = null;
  let visible = false;
  let generation = 0;
  let loading = false;
  let stale = false;
  const commits = new Map<string, number>();
  const places = new Map<string, { x: number; y: number }>();
  const view = { x: 0, y: 0, k: 1 };
  let userMoved = false;

  const nodeEls = new Map<string, SVGGElement>();
  const edgeEls = new Map<string, SVGPathElement>();
  const byId = (): Map<string, GraphNode> => new Map(full?.nodes.map((n) => [n.id, n]) ?? []);

  /* ------------------------------------------------------------ header */
  for (const span of WINDOWS) {
    const button = h("button", "om-segment-item", SPAN[span]);
    button.type = "button";
    button.setAttribute("role", "radio");
    button.dataset.span = String(span);
    button.title = `Show what was done in the last ${SPAN[span]}`;
    button.onclick = () => {
      windowDays = span;
      rebuild();
    };
    windowGroup.append(button);
  }
  quietToggle.onclick = () => {
    showQuiet = !showQuiet;
    rebuild();
  };
  fitButton.onclick = () => {
    userMoved = false;
    fit();
  };

  function paintHeader(): void {
    for (const button of windowGroup.children) {
      const on = (button as HTMLElement).dataset.span === String(windowDays);
      button.classList.toggle("is-on", on);
      button.setAttribute("aria-checked", String(on));
    }
    const quiet = graph?.quiet ?? 0;
    quietToggle.textContent = showQuiet ? "Hide quiet apps" : `Show ${quiet} quiet apps`;
    quietToggle.hidden = quiet === 0;
    quietToggle.setAttribute("aria-pressed", String(showQuiet));
    quietToggle.title = "Apps with nothing open and nothing done lately";
    stats.replaceChildren();
    if (!graph) return;
    const t = graph.threads;
    const parts: Array<[number, string, Tone]> = [
      [t.filter((x) => x.tone === "risk").length, "late", "risk"],
      [t.filter((x) => x.section === "blocked" && x.tone !== "risk").length, "need you", "warn"],
      [t.filter((x) => x.stalled && x.tone !== "risk").length, "stuck", "warn"],
      [t.filter((x) => x.section === "flight" && !x.stalled && x.tone !== "risk").length, "moving", "work"],
      [graph.done.length, `done in ${SPAN[windowDays]}`, "ok"],
    ];
    for (const [count, label, tone] of parts) {
      if (!count && tone !== "ok") continue;
      const stat = h("span", `om-stat t-${tone}`);
      stat.append(h("b", "", String(count)), document.createTextNode(` ${label}`));
      stats.append(stat);
    }
  }

  /* ------------------------------------------------------------ data */
  async function load(): Promise<void> {
    const mine = ++generation;
    loading = true;
    if (!data) stageNote.textContent = "Reading the ops tree…";
    stageNote.hidden = !!data;
    try {
      const next = await invoke<OpsMapData>("ops_map");
      if (mine !== generation) return;
      data = next;
      stale = false;
      rebuild();
      void warmCommits(mine);
    } catch (error) {
      if (mine !== generation) return;
      if (data) return; // a failed refresh keeps the last good picture
      stageNote.hidden = false;
      stageNote.replaceChildren(errorNote("The ops tree could not be read.", error, () => void load()));
      side.replaceChildren();
    } finally {
      if (mine === generation) loading = false;
    }
  }

  /** Commits decide whether old in-flight work is stalled. They come from the rail's cache, so
   *  a project the rail has already read costs nothing. One repaint when they have all landed. */
  async function warmCommits(mine: number): Promise<void> {
    const projects = [...new Set((data?.apps ?? []).map((a) => a.project).filter((p): p is string => !!p))];
    let changed = false;
    await Promise.all(
      projects.map(async (project) => {
        const activity = await events.activity(project).catch(() => null);
        if (!activity) return;
        const count = activity.days.slice(-STALL_DAYS).reduce((a, b) => a + b, 0);
        if (commits.get(project) !== count) {
          commits.set(project, count);
          changed = true;
        }
      }),
    );
    if (changed && mine === generation && visible) rebuild();
  }

  function rebuild(): void {
    if (!data) return;
    full = buildGraph(data, windowDays, (project) => commits.get(project) ?? null);
    const shown = full.nodes.filter((n) => showQuiet || !n.quiet);
    const keep = new Set(shown.map((n) => n.id));
    graph = { ...full, nodes: shown, edges: full.edges.filter((e) => keep.has(e.from) && keep.has(e.to)) };
    layout(graph.nodes, graph.edges, labelWidth, places);
    for (const n of graph.nodes) places.set(n.id, { x: n.x, y: n.y });
    if (pinned && !full.nodes.some((n) => n.id === pinned)) pinned = null;
    if (selected?.kind === "thread" && !graph.threads.some((t) => t.id === selected!.id)) selected = null;
    if (selected?.kind === "done" && !graph.done.some((d) => d.id === selected!.id)) selected = null;
    stageNote.hidden = graph.nodes.length > 0;
    if (!graph.nodes.length) stageNote.textContent = "Nothing is open and nothing was done lately.";
    paintHeader();
    draw();
    paintSide();
    if (!userMoved) fit();
  }

  const labelWidth = (n: GraphNode): number => n.label.length * LABEL_PX + 6;

  /* ------------------------------------------------------------ map */
  function draw(): void {
    edgeLayer.replaceChildren();
    nodeLayer.replaceChildren();
    nodeEls.clear();
    edgeEls.clear();
    if (!graph) return;
    const nodes = byId();
    for (const e of graph.edges) {
      const a = nodes.get(e.from)!, b = nodes.get(e.to)!;
      const path = s("path", {
        class: `om-edge e-${e.kind} t-${e.tone}${e.dashed ? " is-dashed" : ""}`,
        d: `M${a.x.toFixed(1)},${a.y.toFixed(1)}L${b.x.toFixed(1)},${b.y.toFixed(1)}`,
        "stroke-width": e.kind === "work" ? (1.3 + Math.min(4, e.weight - 1) * 0.8).toFixed(1) : 1,
      });
      edgeLayer.append(path);
      edgeEls.set(e.id, path);
    }
    const doneRows = new Map(graph.done.map((d) => [d.id, d]));
    // Owners last, so their discs sit over the lines that leave them.
    const order = [...graph.nodes].sort((a, b) => Number(a.kind === "owner") - Number(b.kind === "owner"));
    for (const n of order) {
      // A rollout that is not late is context, not news: drawn faint and unnamed until you
      // hover one of its apps.
      const calm = n.kind === "rollout" && n.tone !== "risk";
      const g = s("g", {
        class: `om-node k-${n.kind} t-${n.tone}${n.quiet ? " is-quiet" : ""}${calm ? " is-calm" : ""}`,
        transform: `translate(${n.x.toFixed(1)},${n.y.toFixed(1)})`,
        tabindex: 0,
        role: "button",
      });
      const open = n.threads.length;
      const done = n.done.length;
      const summary = [n.label, open ? `${open} open` : "", done ? `${done} done in ${SPAN[windowDays]}` : ""].filter(Boolean).join(" · ");
      g.setAttribute("aria-label", summary);
      const title = s("title");
      title.textContent = summary;
      g.append(title);
      if (done) {
        const newest = Math.min(...n.done.map((id) => doneRows.get(id)?.age ?? windowDays));
        g.append(s("circle", {
          class: "om-halo",
          r: n.r + 4.5,
          "stroke-width": Math.min(5, 1.6 + done * 0.7).toFixed(1),
          opacity: newest <= 2 ? 1 : newest <= 7 ? 0.7 : 0.45,
        }));
      }
      if (n.kind === "rollout") {
        const side = n.r * 1.5;
        g.append(s("rect", { class: "om-shape", x: -side / 2, y: -side / 2, width: side, height: side, rx: 2, transform: "rotate(45)" }));
      } else if (n.kind === "company") {
        g.append(s("rect", { class: "om-shape", x: -n.r, y: -n.r, width: n.r * 2, height: n.r * 2, rx: 5 }));
      } else {
        g.append(s("circle", { class: "om-shape", r: n.r }));
      }
      if (n.kind === "owner" || n.kind === "company") {
        // The count of open lines inside, the name under it, like every other node.
        const count = s("text", { class: "om-inner", y: 5 });
        count.textContent = String(open);
        const name = s("text", { class: `om-label${n.kind === "owner" ? " is-owner" : ""}`, y: n.r + 9 });
        name.textContent = n.label;
        g.append(count, name);
      } else {
        // Hanging from just below the done ring, so a name never runs into it.
        const label = s("text", { class: "om-label", y: n.r + 9 });
        label.textContent = n.label;
        g.append(label);
      }
      g.addEventListener("pointerenter", () => light(neighbourhood(n.id)));
      g.addEventListener("pointerleave", () => light(null));
      g.addEventListener("focus", () => light(neighbourhood(n.id)));
      g.addEventListener("blur", () => light(null));
      g.addEventListener("click", (event) => {
        event.stopPropagation();
        pin(n.id);
      });
      g.addEventListener("dblclick", (event) => {
        event.stopPropagation();
        if (n.project) events.openProject(n.project);
      });
      g.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          pin(n.id);
        }
      });
      nodeLayer.append(g);
      nodeEls.set(n.id, g);
    }
    paintFocus();
  }

  type Lit = { nodes: Set<string>; edges: Set<string> };
  let hover: Lit | null = null;

  function neighbourhood(id: string): Lit {
    const lit: Lit = { nodes: new Set([id]), edges: new Set() };
    for (const e of graph?.edges ?? []) {
      if (e.from === id || e.to === id) {
        lit.edges.add(e.id);
        lit.nodes.add(e.from);
        lit.nodes.add(e.to);
      }
    }
    return lit;
  }

  function threadLit(thread: Thread): Lit {
    const lit: Lit = { nodes: new Set(thread.targets), edges: new Set() };
    if (thread.owner) lit.nodes.add(thread.owner);
    for (const e of graph?.edges ?? []) if (e.threads.includes(thread.id)) lit.edges.add(e.id);
    return lit;
  }

  const doneLit = (row: DoneRow): Lit => ({ nodes: new Set(row.nodes), edges: new Set() });

  function selectedLit(): Lit | null {
    if (!graph) return null;
    if (!selected) return pinned ? neighbourhood(pinned) : null;
    if (selected.kind === "done") {
      const row = graph.done.find((d) => d.id === selected!.id);
      return row ? doneLit(row) : null;
    }
    const thread = graph.threads.find((t) => t.id === selected!.id);
    return thread ? threadLit(thread) : null;
  }

  function light(lit: Lit | null): void {
    hover = lit;
    paintFocus();
  }

  function paintFocus(): void {
    const lit = hover ?? selectedLit();
    svg.classList.toggle("has-focus", !!lit);
    for (const [id, el] of nodeEls) {
      el.classList.toggle("is-lit", !!lit?.nodes.has(id));
      el.classList.toggle("is-selected", pinned === id);
    }
    for (const [id, el] of edgeEls) el.classList.toggle("is-lit", !!lit?.edges.has(id));
  }

  /* ------------------------------------------------------------ pan and zoom */
  function apply(): void {
    world.setAttribute("transform", `translate(${view.x.toFixed(1)},${view.y.toFixed(1)}) scale(${view.k.toFixed(4)})`);
    // Names keep their reading size when the map zooms out to fit, down to three quarters.
    svg.style.setProperty("--om-zoom", Math.max(0.75, Math.min(1, view.k)).toFixed(3));
  }

  function fit(): void {
    if (!graph?.nodes.length) return;
    const box = stage.getBoundingClientRect();
    if (!box.width || !box.height) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of graph.nodes) {
      const half = Math.max(n.r + 6, labelWidth(n) / 2);
      minX = Math.min(minX, n.x - half);
      maxX = Math.max(maxX, n.x + half);
      minY = Math.min(minY, n.y - n.r - 8);
      maxY = Math.max(maxY, n.y + n.r + 30);
    }
    const pad = 36;
    const legendRoom = 34;
    const k = Math.min(1.35, (box.width - pad * 2) / (maxX - minX || 1), (box.height - pad * 2 - legendRoom) / (maxY - minY || 1));
    view.k = Math.max(0.2, k);
    view.x = box.width / 2 - ((minX + maxX) / 2) * view.k;
    view.y = (box.height - legendRoom) / 2 - ((minY + maxY) / 2) * view.k;
    apply();
  }

  let drag: { x: number; y: number; vx: number; vy: number; moved: boolean } | null = null;
  svg.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || (event.target as Element).closest(".om-node")) return;
    drag = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y, moved: false };
    svg.setPointerCapture(event.pointerId);
  });
  svg.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    drag.moved = true;
    svg.classList.add("is-panning");
    view.x = drag.vx + dx;
    view.y = drag.vy + dy;
    userMoved = true;
    apply();
  });
  const endDrag = (): void => {
    if (drag && !drag.moved) pin(null);
    drag = null;
    svg.classList.remove("is-panning");
  };
  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", () => {
    drag = null;
    svg.classList.remove("is-panning");
  });
  // A trackpad pinch arrives as a wheel with ctrlKey. A plain two-finger scroll pans.
  svg.addEventListener("wheel", (event) => {
    event.preventDefault();
    userMoved = true;
    if (event.ctrlKey || event.metaKey) {
      const box = svg.getBoundingClientRect();
      const px = event.clientX - box.left, py = event.clientY - box.top;
      const next = Math.max(0.2, Math.min(3, view.k * Math.exp(-event.deltaY * 0.01)));
      view.x = px - ((px - view.x) / view.k) * next;
      view.y = py - ((py - view.y) / view.k) * next;
      view.k = next;
    } else {
      view.x -= event.deltaX;
      view.y -= event.deltaY;
    }
    apply();
  }, { passive: false });
  new ResizeObserver(() => {
    if (visible && !userMoved) fit();
  }).observe(stage);

  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && (selected || pinned)) {
      event.stopPropagation();
      if (selected) select(null);
      else pin(null);
    }
  });

  function select(next: typeof selected): void {
    selected = next;
    paintFocus();
    paintSide();
  }

  function pin(id: string | null): void {
    pinned = id;
    selected = null;
    paintFocus();
    paintSide();
  }

  /* ------------------------------------------------------------ the column */
  const year = (): number => Number(data?.today.slice(0, 4)) || new Date().getFullYear();
  const isOpen = (kind: "thread" | "done", id: string): boolean => selected?.kind === kind && selected.id === id;

  /** One row: a headline you can read at a glance, one line of who and when under it. Click and
   *  the full line opens below, with the way to its file. */
  function row(kind: "thread" | "done", id: string, tone: string, title: string, sub: Node[], detail: string, path: string, line: number, lit: () => Lit, extra: HTMLElement[] = []): HTMLElement {
    const el = h("div", `om-row t-${tone}`);
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    const open = isOpen(kind, id);
    el.setAttribute("aria-expanded", String(open));
    el.classList.toggle("is-open", open);
    el.append(h("p", "om-title", title));
    const meta = h("p", "om-sub");
    sub.forEach((part, i) => {
      if (i) meta.append(document.createTextNode(" · "));
      meta.append(part);
    });
    el.append(meta);
    if (open) {
      el.append(h("p", "om-full", detail));
      const link = h("button", "om-open", `Open in ${fileName(path)}`);
      link.type = "button";
      link.title = `${path}, line ${line}`;
      link.onclick = (event) => {
        event.stopPropagation();
        events.openFile(path, line);
      };
      el.append(link);
      for (const action of extra) el.append(action);
    }
    const toggle = (): void => select(isOpen(kind, id) ? null : { kind, id });
    el.addEventListener("pointerenter", () => light(lit()));
    el.addEventListener("pointerleave", () => light(null));
    el.addEventListener("click", toggle);
    el.addEventListener("keydown", (event) => {
      if ((event.key === "Enter" || event.key === " ") && event.target === el) {
        event.preventDefault();
        toggle();
      }
    });
    return el;
  }

  const text = (value: string, cls = ""): HTMLElement => h("span", cls, value);
  const names = (ids: string[]): string => {
    const nodes = byId();
    return nameList(ids.map((id) => nodes.get(id)?.label ?? (id === "company" ? "Company" : id.replace(/^\w+:/, ""))));
  };

  function threadRow(thread: Thread): HTMLElement {
    const sub: Node[] = [text(names(thread.targets))];
    if (thread.ownerLabel) sub.push(text(thread.ownerLabel, "om-who"));
    if (thread.deadline !== null && thread.deadline < 0) sub.push(text(`${days(-thread.deadline)} late`, "om-risk"));
    else if (thread.deadline !== null && thread.deadline <= 14) sub.push(text(`due in ${days(thread.deadline)}`, "om-warn"));
    if (thread.age !== null) {
      sub.push(text(thread.stalled ? `no change in ${days(thread.age)}` : ago(thread.age), thread.stalled ? "om-warn" : ""));
    }
    const extra = thread.targets
      .filter((id) => id.startsWith("rollout:") && byId().has(id))
      .map((id) => {
        const button = h("button", "om-open", "Show the apps in it");
        button.type = "button";
        button.onclick = (event) => {
          event.stopPropagation();
          pin(id);
        };
        return button;
      });
    return row("thread", thread.id, thread.tone, thread.title, sub, thread.detail, `${data?.ops ?? ""}/now.md`, thread.line, () => threadLit(thread), extra);
  }

  function doneRow(done: DoneRow): HTMLElement {
    const sub: Node[] = [];
    if (done.kind === "decision") sub.push(text("Decision", "om-who"));
    const who = names(done.nodes);
    if (who) sub.push(text(who));
    return row("done", done.id, done.kind === "decision" ? "decision" : "ok", done.title, sub, done.detail, done.path, done.line, () => doneLit(done));
  }

  function section(title: string, rows: HTMLElement[], tone = "", caption = ""): HTMLElement | null {
    if (!rows.length) return null;
    const box = h("section", "om-section");
    const head = h("h2", tone ? `t-${tone}` : "");
    head.append(document.createTextNode(title), h("span", "om-count", String(rows.length)));
    box.append(head);
    if (caption) box.append(h("p", "om-caption", caption));
    box.append(...rows);
    return box;
  }

  function doneSections(rows: DoneRow[]): HTMLElement | null {
    if (!rows.length) return null;
    const box = h("section", "om-section");
    const head = h("h2", "t-ok");
    head.append(document.createTextNode(`Done in ${SPAN[windowDays]}`), h("span", "om-count", String(rows.length)));
    box.append(head);
    let day = "";
    for (const done of rows) {
      if (done.date !== day) {
        day = done.date;
        box.append(h("h3", "om-day", done.age === 0 ? "Today" : done.age === 1 ? "Yesterday" : shortDate(done.date)));
      }
      box.append(doneRow(done));
    }
    return box;
  }

  const worstFirst = (a: Thread, b: Thread): number => (b.age ?? -1) - (a.age ?? -1);

  function threadSections(threads: Thread[]): HTMLElement[] {
    const late = threads.filter((t) => t.tone === "risk").sort((a, b) => a.deadline! - b.deadline!);
    const rest = threads.filter((t) => t.tone !== "risk");
    const waiting = rest.filter((t) => t.section === "blocked").sort(worstFirst);
    const stalled = rest.filter((t) => t.stalled).sort(worstFirst);
    const moving = rest.filter((t) => t.section === "flight" && !t.stalled).sort(worstFirst);
    const rollouts = rest.filter((t) => t.section === "rollout");
    const other = rest.filter((t) => !["blocked", "flight", "rollout"].includes(t.section));
    return [
      section("Late", late.map(threadRow), "risk", "A deadline written in the line has passed."),
      section("Needs you", waiting.map(threadRow), "warn"),
      section("Stuck", stalled.map(threadRow), "warn", `No change in ${STALL_DAYS} days or more, and no new work on its apps.`),
      section("Moving", moving.map(threadRow), "work"),
      section("Rollouts", rollouts.map(threadRow), "std", "One change across many apps."),
      section("Parked", other.map(threadRow)),
    ].filter((x): x is HTMLElement => !!x);
  }

  function paintSide(): void {
    const scroll = side.scrollTop;
    side.replaceChildren();
    if (!graph) return;
    const threads = new Map(full!.threads.map((t) => [t.id, t]));
    const node = pinned ? byId().get(pinned) : null;
    const keepScroll = paintedFor === (node?.id ?? null);
    paintedFor = node?.id ?? null;
    if (!node) {
      const parts = [...threadSections(graph.threads), doneSections(graph.done)].filter((x): x is HTMLElement => !!x);
      side.append(...(parts.length ? parts : [h("p", "om-empty", `Nothing is open, and nothing was done in ${SPAN[windowDays]}.`)]));
      side.scrollTop = keepScroll ? scroll : 0;
      return;
    }
    const head = h("div", "om-detail");
    const back = h("button", "om-back", "← All");
    back.type = "button";
    back.onclick = () => pin(null);
    const facts = [
      node.kind === "company" ? "Work for every app" : node.kind === "rollout" ? "One change across many apps" : "",
      node.threads.length ? `${node.threads.length} open` : "nothing open",
      node.done.length ? `${node.done.length} done in ${SPAN[windowDays]}` : "",
    ];
    if (node.commits !== null) facts.push(node.commits ? `${node.commits} commits in 2 weeks` : "no commits in 2 weeks");
    head.append(back, h("h2", `t-${node.tone}`, node.label), h("p", "om-facts", facts.filter(Boolean).join(" · ")));
    const buttons = h("div", "om-detail-actions");
    if (node.project) {
      const open = h("button", "om-button", "Open project");
      open.type = "button";
      open.onclick = () => events.openProject(node.project!);
      buttons.append(open);
    }
    if (node.rollout) {
      const open = h("button", "om-button", "Open the rollout file");
      open.type = "button";
      open.onclick = () => events.openFile(node.rollout!.path);
      buttons.append(open);
    }
    if (buttons.childElementCount) head.append(buttons);
    if (node.rollout) {
      if (node.rollout.summary) head.append(h("p", "om-prose", plainText(humanDates(node.rollout.summary, year()))));
      if (node.rollout.done_when) head.append(h("p", "om-prose", `Done when ${plainText(node.rollout.done_when).replace(/^\w/, (c) => c.toLowerCase())}`));
    }
    side.append(head);
    // Apps in this rollout, or rollouts this app is in. Each is a door to its own detail.
    const linked = full!.edges
      .filter((e) => e.kind === "rollout" && (e.from === node.id || e.to === node.id))
      .map((e) => byId().get(e.from === node.id ? e.to : e.from))
      .filter((n): n is GraphNode => !!n);
    if (linked.length) {
      const box = h("section", "om-section");
      box.append(h("h2", "t-std", node.kind === "rollout" ? "Apps in it" : "Part of these rollouts"));
      const chips = h("div", "om-chips");
      for (const other of linked) {
        const chip = h("button", `om-link t-${other.tone}`, other.label);
        chip.type = "button";
        chip.onclick = () => pin(other.id);
        chip.onpointerenter = () => light(neighbourhood(other.id));
        chip.onpointerleave = () => light(null);
        chips.append(chip);
      }
      box.append(chips);
      side.append(box);
    }
    side.append(...threadSections(node.threads.map((id) => threads.get(id)!).filter(Boolean)));
    const doneRows = full!.done.filter((row) => node.done.includes(row.id));
    const done = doneSections(doneRows);
    if (done) side.append(done);
    if (!node.threads.length && !doneRows.length && !linked.length) side.append(h("p", "om-empty", `Nothing open, and nothing done in ${SPAN[windowDays]}.`));
    side.scrollTop = keepScroll ? scroll : 0;
  }

  return {
    open() {
      visible = true;
      if (!data || stale) void load();
      else if (!userMoved) fit();
    },
    clear() {
      visible = false;
      hover = null;
    },
    sync() {
      stale = true;
      if (visible && !loading) void load();
    },
  };
}
