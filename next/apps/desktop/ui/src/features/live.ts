import { errorText } from "../errors";
import type { BoardFeed } from "./live_cards";
import { mountCamp } from "./live_camp";
import { facts } from "./live_facts";
import { RESULT_MS, RESULTS } from "./live_history";
import { mountPanel } from "./live_panel";
import { OUTCOME_WORD } from "./live_text";
import { mountTop, TOP_HTML } from "./live_top";
import { mountTowns } from "./live_towns";
import type { LiveCtx, LiveEvents, LiveState, Selection } from "./live_types";
import "./live_fonts.css";
import "./live.css";

export type { LiveAgent, LiveEmber, LiveEvents, LiveJob, LiveWorld } from "./live_types";
export type LiveHandle = { open(): void; clear(): void };

const POLL_MS = 2000;
const BOARD_MS = 60_000;
const FLEET_MS = 5000;
const PING_MS = 2500;
const ENDED_MS = 12_000;

export function mountLive(root: HTMLElement, events: LiveEvents): LiveHandle {
  root.innerHTML = `
    ${TOP_HTML}
    <div class="live-body" data-body>
      <div class="live-main">
        <section class="camp" data-camp aria-label="The fleet"></section>
        <div class="groups" data-groups aria-label="Projects with agents"></div>
      </div>
      <aside class="live-side apanel" data-panel aria-label="Selected" hidden></aside>
    </div>
    <div class="live-toast" data-toast role="status" hidden></div>`;
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const body = q("[data-body]");
  const panelEl = q("[data-panel]");

  const s: LiveState = { world: null, board: null, fleet: null, selection: null, results: new Map(), pinged: new Map(), endings: [] };

  let timer: number | null = null;
  let polling = false;
  let boardAt = 0;
  let fleetAt = 0;
  let open = false;
  const judged = new Map<string, string>();
  const said = new Map<string, number>();
  let knownEmbers: Set<string> | null = null;

  const ctx: LiveCtx = {
    ...facts(() => s),
    s,
    events,
    select,
    paint,
    poll: () => void poll(),
    toast: (text, bad) => top.toast(text, bad),
  };
  const top = mountTop(ctx, root, q("[data-toast]"));
  const camp = mountCamp(ctx, q("[data-camp]"));
  const towns = mountTowns(ctx, q("[data-groups]"), camp.boss);
  const panel = mountPanel(ctx, panelEl);

  async function poll(): Promise<void> {
    if (polling) return;
    polling = true;
    try {
      s.world = await events.world();
      const now = Date.now();
      if (now - boardAt > BOARD_MS) void readBoard();
      if (now - fleetAt > FLEET_MS) void readFleet();
      notice(now);
      paint();
    } catch (e) {
      top.say(`Could not read the agents: ${errorText(e, "the scan failed")}`);
    } finally {
      polling = false;
    }
  }

  async function readBoard(): Promise<void> {
    boardAt = Date.now();
    try {
      const b = (await events.board(false)) as (BoardFeed & { error?: string }) | null;
      if (b && !b.error) s.board = b;
    } catch {
      return;
    }
    paint();
  }

  async function readFleet(): Promise<void> {
    fleetAt = Date.now();
    try {
      const f = await events.fleet();
      s.fleet = f && !f.error ? f : null;
    } catch {
      s.fleet = null;
    }
    paint();
  }

  function notice(now: number): void {
    const w = s.world!;
    const alive = new Set(w.agents.map((a) => a.id));
    for (const m of [judged, said, s.pinged, s.results]) for (const id of m.keys()) if (!alive.has(id)) m.delete(id);
    for (const [id, r] of s.results) if (r.until < now) s.results.delete(id);
    for (const a of w.agents) {
      const st = a.steps.find((x) => x.ok !== undefined && x.verb && RESULTS[x.verb]);
      const key = st ? `${st.verb}@${st.atMs}` : "";
      const seen = judged.get(a.id);
      judged.set(a.id, key);
      if (st && seen !== undefined && seen !== key) {
        const ok = st.ok!;
        s.results.set(a.id, { text: RESULTS[st.verb!][ok ? 0 : 1], ok, born: now, until: now + (ok ? RESULT_MS.ok : RESULT_MS.failed) });
      }
      const talk = [a.now, ...a.steps].find((x) => x && (x.verb === "message" || x.verb === "spawn"));
      const before = said.get(a.id);
      said.set(a.id, talk?.atMs ?? 0);
      if (talk && before !== undefined && before !== talk.atMs) {
        s.pinged.set(a.id, now + PING_MS);
        const other = talk.helper ? a.parent : null;
        if (other) s.pinged.set(other, now + PING_MS);
      }
    }
    s.endings = s.endings.filter((e) => e.until > now);
    if (knownEmbers) {
      for (const e of w.embers) {
        if (knownEmbers.has(e.id)) continue;
        const who = ctx.emberWho(e).role;
        s.endings.push({ room: e.room, text: `${who} ended · ${OUTCOME_WORD[e.outcome].toLowerCase()}`, ok: e.outcome === "done", until: now + ENDED_MS });
      }
    }
    knownEmbers = new Set(w.embers.map((e) => e.id));
  }

  function paint(): void {
    if (!s.world) return;
    top.paint();
    camp.paint();
    towns.paint();
    panel.paint();
    body.classList.toggle("has-panel", !panelEl.hidden);
  }

  function select(next: Selection): void {
    const same = next && s.selection && next.kind === s.selection.kind && next.id === s.selection.id;
    s.selection = same ? null : next;
    paint();
  }

  function onKey(e: KeyboardEvent): void {
    if (!open || e.metaKey || e.ctrlKey || e.altKey || e.key !== "Escape" || !s.selection) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable)) return;
    select(null);
    e.preventDefault();
  }

  return {
    open() {
      open = true;
      void poll();
      document.addEventListener("keydown", onKey);
      if (timer === null) timer = window.setInterval(() => void poll(), POLL_MS);
    },
    clear() {
      open = false;
      document.removeEventListener("keydown", onKey);
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    },
  };
}
