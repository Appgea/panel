import { errorText } from "../errors";
import type { OverviewData } from "./board_types";
import { mountBridge, type BridgeHandle, type FleetChange } from "./fleet_bridge";
import { className } from "./fleet_words";
import type { BoardIssue } from "./live_cards";
import { hoursBack, newGame, update } from "./live_game";
import type { LiveAgent } from "./live_types";
import type { DesignEvents, DesignHandle } from "./fleet_design";
import "./fleet.css";

export type FleetUnit = {
  id: string;
  kind: string;
  app: string | null;
  scout?: string;
  role?: "builder" | "scout" | "checker";
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
  down?: Record<string, number>;
  units?: FleetUnit[];
  today?: FleetRun[];
  error?: string;
};
export type FleetCalls = { you: BoardIssue[]; names: Record<string, string> };
export type FleetEvents = {
  view(): Promise<FleetView>;
  day?(hours: number): Promise<OverviewData | null>;
  commander?(): Promise<LiveAgent | null>;
  calls?(): Promise<FleetCalls | null>;
  changes?(): Promise<FleetChange[] | null>;
  openTerminal?(panel: string): boolean;
  newCommander?(): Promise<boolean>;
  openIssue?(number: number): void;
  design?: DesignEvents;
};
export type FleetHandle = { open(): void; clear(): void; dispose(): void };
export type { FleetChange };

const EVERY = 5_000;
const SLOW_EVERY = 60_000;

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text) el.textContent = text;
  return el;
};
const set = (el: HTMLElement, text: string): void => {
  if (el.textContent !== text) el.textContent = text;
};

export function mountFleet(screen: HTMLElement, events: FleetEvents): FleetHandle {
  let visible = false;
  let busy = false;
  let timer: number | undefined;
  let last: FleetView | null = null;
  let commander: LiveAgent | null = null;
  let calls: FleetCalls | null = null;
  let changes: FleetChange[] | null = null;
  let day: OverviewData | null = null;
  let slowAt = 0;
  let shortDay = "";
  const game = newGame();

  const state = h("span", "fl-state");
  const slots = h("span", "fl-slots");
  const stamp = h("span", "fl-stamp");
  const heading = h("div", "fl-heading");
  heading.append(h("h1", "", "AI fleet"), state, slots);
  const header = h("header", "fl-header");
  let mode: "live" | "design" = "live";
  let design: DesignHandle | null = null;
  const designRoot = h("div");
  designRoot.hidden = true;
  const modes = h("div", "fl-modes");
  modes.setAttribute("role", "tablist");
  const modeButtons = (["live", "design"] as const).map((m) => {
    const b = h("button", "fl-mode", m === "live" ? "Live" : "Fleet Design");
    b.type = "button";
    b.setAttribute("role", "tab");
    b.addEventListener("click", () => setMode(m));
    return [m, b] as const;
  });
  modes.append(...modeButtons.map(([, b]) => b));
  modes.hidden = !events.design;
  heading.append(modes);
  header.append(heading, stamp);
  const error = h("p", "fl-error");
  error.hidden = true;

  const body = h("div", "fl-body");
  const bridgeRoot = h("div");
  body.append(bridgeRoot);
  const bridge: BridgeHandle = mountBridge(bridgeRoot, {
    openTerminal: events.openTerminal,
    newCommander: events.newCommander,
    openIssue: events.openIssue,
  });
  screen.replaceChildren(header, error, body, designRoot);

  function paintMode(): void {
    for (const [m, b] of modeButtons) {
      b.classList.toggle("is-on", m === mode);
      b.setAttribute("aria-selected", String(m === mode));
    }
    body.hidden = mode !== "live";
    designRoot.hidden = mode !== "design";
    stamp.hidden = state.hidden = slots.hidden = mode !== "live";
    if (mode === "live" && last) paint(last);
  }

  function setMode(m: "live" | "design"): void {
    if (m === mode && (m === "live" || design)) return;
    mode = m;
    try {
      localStorage.setItem("panel.fleet.mode", m);
    } catch {
      void 0;
    }
    paintMode();
    window.clearInterval(timer);
    if (!visible) return;
    if (m === "live") {
      void read();
      timer = window.setInterval(() => void read(), EVERY);
      return;
    }
    if (design) return design.open();
    designRoot.textContent = "Opening Fleet Design…";
    void import("./fleet_design")
      .then(({ mountDesign }) => {
        if (!events.design) return;
        design = mountDesign(designRoot, events.design);
        if (mode === "design" && visible) design.open();
      })
      .catch((reason: unknown) => {
        designRoot.textContent = `Fleet Design could not open: ${errorText(reason, "it did not load")}`;
      });
  }

  function paint(view: FleetView): void {
    error.hidden = !view.error;
    error.textContent = view.error ? `The fleet could not be read: ${view.error}` : "";
    if (view.error && !view.units) {
      if (!last) bridge.paint({ view: {}, commander, calls: calls?.you ?? null, changes, names: calls?.names ?? {}, xp: 0, rank: "", level: 0 });
      return;
    }
    last = view;
    const on = Boolean(view.supervisor);
    set(state, on ? (view.hold ? "On hold" : "Running") : "Off");
    state.className = `fl-state ${on ? (view.hold ? "is-hold" : "is-on") : "is-off"}`;
    state.title = on ? (view.hold ? "No new starts. Running units finish." : "The supervisor starts units when the board has work.") : "No supervisor runs.";
    const spec = (view.spec ?? "").split(" ")[0].split(",").map((x) => x.split(":")).filter(([k, n]) => k && n);
    set(slots, spec.length ? `Slots: ${spec.map(([k, n]) => `${n} ${className(k)}`).join(" · ")}` : "");
    slots.hidden = !spec.length;
    stamp.textContent = `Read ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
    update(game, { fleet: view, day, now: Date.now() });
    bridge.paint({
      view,
      commander,
      calls: calls?.you ?? null,
      changes,
      names: calls?.names ?? {},
      xp: game.score.xp,
      rank: game.score.rank.name,
      level: game.score.rank.level,
    });
  }

  async function readSlow(): Promise<void> {
    slowAt = Date.now();
    const short = shortDay === new Date(slowAt).toDateString();
    const [d, c, ch] = await Promise.all([
      events.day ? events.day(hoursBack(slowAt, short ? 0 : 1)).catch(() => null) : Promise.resolve(null),
      events.calls ? events.calls().catch(() => null) : Promise.resolve(null),
      events.changes ? events.changes().catch(() => null) : Promise.resolve(null),
    ]);
    if (d && !d.error) day = d;
    if (c) calls = c;
    if (ch) changes = ch;
    if (game.score.partial && !short) {
      shortDay = new Date(slowAt).toDateString();
      slowAt = 0;
    }
    if (last && visible && mode === "live") paint(last);
  }

  async function read(): Promise<void> {
    if (!visible || busy) return;
    busy = true;
    try {
      if (Date.now() - slowAt > SLOW_EVERY) void readSlow();
      const [view, boss] = await Promise.all([
        events.view().catch((reason: unknown): FleetView => ({ error: errorText(reason, "the fleet extension did not answer") })),
        events.commander ? events.commander().catch(() => commander) : Promise.resolve(null),
      ]);
      commander = boss;
      if (visible && mode === "live") paint(view);
    } finally {
      busy = false;
    }
  }

  return {
    open() {
      visible = true;
      screen.hidden = false;
      let saved = "live";
      try {
        saved = localStorage.getItem("panel.fleet.mode") ?? "live";
      } catch {
        void 0;
      }
      mode = "live";
      if (saved === "design" && events.design) return setMode("design");
      paintMode();
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
      design?.dispose();
      bridge.dispose();
      screen.replaceChildren();
    },
  };
}
