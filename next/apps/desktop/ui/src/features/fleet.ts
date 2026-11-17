/**
 * AI fleet: the cheap builders the fleet runs, one block a unit with what it is typing right now, and
 * under them what the fleet ended today. Owner, 2026-11-17: "I want them on my AppgeaPanel, visible
 * any time I open the appgea panel under an AI fleet tab. So that I can check that on demand".
 *
 * The units run in tmux, outside Panel (ops `runbooks/fleet.py`). This screen only reads `fleet view`
 * through the fleet module: it keeps no terminal, so a unit costs Panel no memory, and quitting Panel
 * ends nothing. It reads when it opens and every few seconds while it is the screen on the glass.
 * Hidden, it asks for nothing. It only shows: starting and stopping the fleet stays a thing he asks for.
 */
import { errorText } from "../errors";
import "./fleet.css";

export type FleetUnit = {
  id: string;
  kind: string;
  app: string | null;
  issues: { number: number; title: string }[];
  minutes: number;
  budget: number;
  tokens: string;
  quiet: number;
  flags: string[];
  screen: string;
};
export type FleetRun = {
  time: string;
  unit: string;
  kind: string;
  app: string;
  closed: number[];
  minutes: number;
  tokens: string;
  result: string;
};
export type FleetView = {
  supervisor?: boolean;
  hold?: boolean;
  spec?: string;
  units?: FleetUnit[];
  today?: FleetRun[];
  error?: string;
};
export type FleetEvents = { view(): Promise<FleetView> };
export type FleetHandle = { open(): void; clear(): void; dispose(): void };

const EVERY = 5_000;

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text) el.textContent = text;
  return el;
};

/** The engine behind a unit kind, for its colour: the same hues the terminals use. */
const engine = (kind: string): string => (kind === "terra" ? "codex" : kind === "flash" ? "opencode" : "claude");

type UnitRow = { root: HTMLElement; nums: HTMLElement; flags: HTMLElement; issues: HTMLElement; screen: HTMLElement };

export function mountFleet(screen: HTMLElement, events: FleetEvents): FleetHandle {
  let visible = false;
  let busy = false;
  let timer: number | undefined;
  let last: FleetView | null = null;
  const rows = new Map<string, UnitRow>();

  const title = h("h1", "", "AI fleet");
  const state = h("span", "fl-state");
  const stamp = h("span", "fl-stamp");
  const heading = h("div", "fl-heading");
  heading.append(title, state);
  const header = h("header", "fl-header");
  header.append(heading, stamp);
  const error = h("p", "fl-error");
  error.hidden = true;
  const units = h("div", "fl-units");
  const empty = h("p", "fl-empty");
  const todayHead = h("h2", "fl-section");
  const today = h("div", "fl-today");
  const body = h("div", "fl-body");
  body.append(units, empty, todayHead, today);
  screen.replaceChildren(header, error, body);
  empty.textContent = "Reading the fleet…";

  function paintUnit(unit: FleetUnit): UnitRow {
    let row = rows.get(unit.id);
    if (!row) {
      const root = h("article", "fl-unit");
      const head = h("header", "fl-unit-head");
      const dot = h("i", `fl-dot k-${engine(unit.kind)}`);
      const flags = h("span", "fl-flags");
      const nums = h("span", "fl-nums");
      head.append(dot, h("span", "fl-kind", unit.kind), h("span", "fl-app", unit.app || "any app"), h("span", "fl-id", unit.id), flags, nums);
      const issues = h("ul", "fl-issues");
      const term = h("pre", "fl-screen");
      term.tabIndex = 0;
      term.setAttribute("aria-label", `Terminal of unit ${unit.id}`);
      root.append(head, issues, term);
      row = { root, nums, flags, issues, screen: term };
      rows.set(unit.id, row);
    }
    row.nums.textContent = `${unit.minutes} of ${unit.budget} min · ${unit.tokens} tokens · quiet ${unit.quiet} min`;
    row.flags.textContent = unit.flags.join(" ");
    row.flags.hidden = unit.flags.length === 0;
    row.issues.replaceChildren(
      ...(unit.issues.length
        ? unit.issues.map((issue) => {
            const item = h("li");
            item.append(h("span", "fl-num", `#${issue.number}`), h("span", "fl-title", issue.title));
            return item;
          })
        : [h("li", "is-none", "No issue yet")]),
    );
    const text = unit.screen || "Nothing on its terminal yet.";
    if (row.screen.textContent !== text) {
      // New output keeps the last line in view, unless he scrolled up to read.
      const term = row.screen;
      const atEnd = term.scrollHeight - term.scrollTop - term.clientHeight < 24;
      term.textContent = text;
      if (atEnd) term.scrollTop = term.scrollHeight;
    }
    return row;
  }

  function paintToday(runs: FleetRun[]): void {
    const closed = runs.reduce((sum, run) => sum + run.closed.length, 0);
    todayHead.textContent = runs.length ? `Today: ${closed} closed by ${runs.length} ${runs.length === 1 ? "unit" : "units"}` : "";
    todayHead.hidden = runs.length === 0;
    today.replaceChildren(
      ...runs.map((run) => {
        const row = h("div", run.closed.length ? "fl-run" : "fl-run is-none");
        row.append(
          h("span", "fl-run-time", run.time),
          h("span", "fl-run-who", `${run.kind} · ${run.app === "-" ? "any app" : run.app}`),
          h("span", "fl-run-closed", run.closed.length ? run.closed.map((n) => `#${n}`).join(" ") : "closed nothing"),
          h("span", "fl-run-nums", `${run.minutes} min · ${run.tokens}`),
          h("span", "fl-run-result", run.result),
        );
        return row;
      }),
    );
  }

  function paint(view: FleetView): void {
    error.hidden = !view.error;
    error.textContent = view.error ? `The fleet could not be read: ${view.error}` : "";
    if (view.error && !view.units) {
      // A failed read keeps the last good fleet on screen, with the error above it.
      if (!last) empty.textContent = "";
      return;
    }
    last = view;
    const list = view.units ?? [];
    state.textContent = view.supervisor
      ? `${view.hold ? "On hold, units finish" : "Running"}${view.spec ? ` · ${view.spec}` : ""}`
      : "Not running";
    state.classList.toggle("is-on", Boolean(view.supervisor) && !view.hold);
    stamp.textContent = `read ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
    const live = new Set(list.map((unit) => unit.id));
    for (const [id, row] of rows) {
      if (live.has(id)) continue;
      row.root.remove();
      rows.delete(id);
    }
    for (const unit of list) {
      const row = paintUnit(unit);
      if (!row.root.isConnected) {
        units.append(row.root);
        row.screen.scrollTop = row.screen.scrollHeight;
      }
    }
    units.hidden = list.length === 0;
    empty.hidden = list.length > 0;
    empty.textContent = view.supervisor
      ? "No unit runs right now. The supervisor starts one when the board has work for it."
      : "No unit runs. The fleet starts when you ask a session for it.";
    paintToday(view.today ?? []);
  }

  async function read(): Promise<void> {
    if (!visible || busy) return;
    busy = true;
    try {
      const view = await events.view().catch((reason: unknown): FleetView => ({ error: errorText(reason, "the fleet extension did not answer") }));
      if (visible) paint(view);
    } finally {
      busy = false;
    }
  }

  return {
    open() {
      visible = true;
      screen.hidden = false;
      void read();
      window.clearInterval(timer);
      timer = window.setInterval(() => void read(), EVERY);
    },
    clear() {
      visible = false;
      screen.hidden = true;
      window.clearInterval(timer);
    },
    dispose() {
      window.clearInterval(timer);
      rows.clear();
      screen.replaceChildren();
    },
  };
}
