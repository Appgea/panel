/**
 * Inbox — everything that waits for the owner, on one screen, one card at a time, in value per
 * minute of his time (live_cards.ts).
 *
 * Owner, 2026-11-05: "I don't think I need this many different stuff to look at. One screen.
 * Board must still keep separate." So Reports, Review, Support and History have no sidebar rows
 * any more. Their news arrives here as cards (inbox_cards.ts), next to the board's: Decide is his
 * board agenda, Your Turn a session that waits for him, Done what finished since he last looked,
 * Decided the calls agents made in his place, Better a step that keeps losing time. A card opens
 * the old screen only to read one thing whole: a report with its evidence, files in the deck.
 * The Board keeps its own row. The Manager row is gone: "its no more needed".
 *
 * The card in front is the queue (live_queue.ts). Beside it, every card, so he sees the whole
 * pile, can pull one forward, or narrow it to one kind. It reads the agents every 5 s while open,
 * and the board and the slow sources every 60 s, open or not, so the sidebar count stays true.
 */

import { errorText } from "../errors";
import { inboxCards, type EndedItem, type ReportItem, type ReviewBatch, type SupportItem } from "./inbox_cards";
import { buildCards, KIND, type BoardFeed, type Card, type CardKind } from "./live_cards";
import { facts } from "./live_facts";
import { KIND_COLOUR, mountQueue, readSeen, type QueueEvents, type QueueState } from "./live_queue";
import { button, div, span, withoutRoom } from "./live_text";
import type { LiveWorld } from "./live_types";
import "./foryou.css";

export type ForYouEvents = QueueEvents & {
  world(): Promise<LiveWorld>;
  /** Null when the board module is not installed: the other sources still make cards. */
  board(fresh: boolean): Promise<BoardFeed | null>;
  reports(): ReportItem[];
  review(): ReviewBatch[];
  /** Null when the support module is not installed; rejects when its log cannot be read.
   *  `fresh` pulls the forms. `problem` says why the last pull fell short. */
  support(fresh: boolean): Promise<{ items: SupportItem[]; problem: string } | null>;
  ended(): Promise<{ items: EndedItem[]; floor: number }>;
  /** A Panel project's name, for cards keyed by project rather than portfolio key. */
  projectName(id: string): string | null;
  picture(path: string): Promise<string>;
  pictureSrc(project: string, path: string): string;
  /** The sidebar count: every card there is. */
  count(n: number): void;
};
export type ForYouHandle = { open(): void; clear(): void; refresh(): void };

const POLL_MS = 5000;
const SLOW_MS = 60_000;
/** Cards listed beside the front one. The rest is a count. */
const NEXT = 40;
const TOAST_MS = 3000;

/** The filter chips. Calls is everything the board and the live agents raise. */
const FILTERS: { key: string; label: string; kinds: CardKind[] }[] = [
  { key: "all", label: "All", kinds: [] },
  { key: "calls", label: "Calls", kinds: ["decide", "turn", "better", "decided", "done"] },
  { key: "review", label: "Review", kinds: ["review"] },
  { key: "support", label: "Support", kinds: ["support"] },
  { key: "report", label: "Reports", kinds: ["report"] },
  { key: "ended", label: "Sessions", kinds: ["ended"] },
];

export function mountForYou(root: HTMLElement, events: ForYouEvents): ForYouHandle {
  root.innerHTML = `
    <header class="fy-top">
      <div class="fy-heading">
        <h1>Inbox</h1>
        <p data-sum>Reading the board</p>
        <p class="fy-problem" data-problem hidden><span></span> <button type="button" class="fy-link">Open Support</button></p>
      </div>
      <button class="fy-btn" type="button" data-refresh>Refresh</button>
    </header>
    <div class="fy-body">
      <div class="fy-main">
        <div class="qcard" data-card aria-live="polite"></div>
        <p class="fy-hint">Enter, 2 or 3 answers the card. T talks about it. ↓ puts it off for 30 min.</p>
      </div>
      <aside class="fy-next" aria-label="Every card">
        <div class="fy-chips" role="group" aria-label="Show" data-chips></div>
        <div class="fy-list" data-next></div>
      </aside>
    </div>
    <div class="fy-toast" data-toast role="status" hidden></div>`;
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const sum = q("[data-sum]");
  const chipsEl = q("[data-chips]");
  const nextEl = q("[data-next]");
  const toastEl = q("[data-toast]");
  // With no Support row, this line is the way into its setup when mail cannot be read.
  const problemEl = q("[data-problem]");
  problemEl.querySelector("button")!.addEventListener("click", () => events.openSupport());
  const showProblem = (text: string) => {
    problemEl.hidden = !text;
    problemEl.querySelector("span")!.textContent = text;
  };

  const reducedQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  const s: QueueState = {
    world: null,
    board: null,
    boardNote: "",
    boardRead: false,
    cards: [],
    front: null,
    later: {},
    answered: new Set(),
    seen: readSeen(),
    talkCard: null,
    reduced: !!reducedQuery?.matches,
  };
  root.classList.toggle("is-reduced", s.reduced);

  let support: SupportItem[] = [];
  let ended: { items: EndedItem[]; floor: number } = { items: [], floor: Date.now() };
  let filter = "all";
  /** Every card before the filter, for the chip counts. */
  let all: Card[] = [];
  let timer: number | null = null;
  let toastTimer = 0;
  let slowAt = 0;
  let polling = false;
  let open = false;

  const toast = (text: string, bad = false) => {
    toastEl.textContent = text;
    toastEl.classList.toggle("is-bad", bad);
    toastEl.hidden = !text;
    window.clearTimeout(toastTimer);
    if (text) toastTimer = window.setTimeout(() => (toastEl.hidden = true), TOAST_MS);
  };
  const known = facts(() => s);
  // Cards from Panel's own screens are keyed by Panel project id, not by portfolio key.
  const roomName = (key: string) => {
    const name = known.roomName(key);
    return name === key ? (events.projectName(key) ?? key) : name;
  };

  function build(now: number): Card[] {
    const agents = (s.world?.agents ?? []).map((a) => ({ id: a.id, name: known.nameOf(a), room: known.roomOf(a), state: a.state, stateMs: a.stateMs, headless: a.headless, panel: a.panel, lastText: a.lastText }));
    const sources = { reports: events.reports(), review: events.review(), support, ended: ended.items, endedFloor: ended.floor };
    all = [
      ...buildCards(s.board, agents, known.weight, roomName, s.seen, now),
      ...inboxCards(sources, known.weight, roomName, events.pictureSrc, s.seen, now),
    ].filter((c) => !s.answered.has(c.id));
    // A card put off with Later is not waiting yet.
    events.count(all.filter((c) => (s.later[c.id] ?? 0) <= now).length);
    const kinds = FILTERS.find((f) => f.key === filter)?.kinds ?? [];
    return kinds.length ? all.filter((c) => kinds.includes(c.kind)) : all;
  }

  const queue = mountQueue({ ...known, roomName, s, events, toast, build, painted: paintNext }, q("[data-card]"));

  q("[data-refresh]").addEventListener("click", () => void readSlow(true));

  async function poll(): Promise<void> {
    if (polling) return;
    polling = true;
    try {
      s.world = await events.world();
      if (Date.now() - slowAt > SLOW_MS) await readSlow(false);
      else if (open) queue.paint();
      else build(Date.now());
    } catch (e) {
      sum.textContent = `Could not read the agents: ${errorText(e, "the scan failed")}`;
    } finally {
      polling = false;
    }
  }

  /** The board, Support and History: each slow, each optional. One failing never hides the rest. */
  async function readSlow(fresh: boolean): Promise<void> {
    slowAt = Date.now();
    const [b, sup, end] = await Promise.allSettled([events.board(fresh), events.support(fresh), events.ended()]);
    if (b.status === "fulfilled") {
      const feed = b.value as (BoardFeed & { error?: string }) | null;
      s.board = feed && !feed.error ? feed : s.board;
      s.boardNote = !feed ? "" : feed.error ? `The board did not answer: ${feed.error}` : "";
    } else s.boardNote = `The board did not answer: ${errorText(b.reason, "unknown error")}`;
    // A failed read keeps the cards it had: a blip must not empty the pile.
    if (sup.status === "fulfilled") {
      support = sup.value?.items ?? [];
      showProblem(sup.value?.problem ?? "");
    } else showProblem(`Support mail could not be read: ${errorText(sup.reason, "unknown error")}.`);
    if (end.status === "fulfilled") ended = end.value;
    s.boardRead = true;
    if (!s.world) return;
    if (open) queue.paint();
    else build(Date.now());
  }

  /** The summary line, the chips and every card behind the front one. */
  function paintNext(): void {
    const cards = s.cards;
    const minutes = Math.max(1, Math.round(all.reduce((n, c) => n + c.minutes, 0)));
    sum.textContent = !s.boardRead ? "Reading the board" : all.length ? `${all.length} ${all.length === 1 ? "card" : "cards"} · about ${minutes} min of your time` : "Nothing waits for you.";
    paintChips();
    const rest = cards.slice(1);
    if (!rest.length) return nextEl.replaceChildren();
    const now = Date.now();
    const later = (c: Card) => (s.later[c.id] ?? 0) > now;
    const rows = rest.slice(0, NEXT).map((c) => {
      const room = roomName(c.room);
      const r = button(`fy-row${later(c) ? " is-later" : ""}`, "", () => {
        s.front = c.id;
        delete s.later[c.id];
        s.talkCard = null;
        queue.paint();
      });
      const kind = span("fy-kind", KIND[c.kind].label);
      kind.style.setProperty("--c", KIND_COLOUR[c.kind]);
      r.append(kind, span("fy-room", room), span("fy-title", withoutRoom(c.title, room)));
      r.title = "Bring this card to the front";
      return r;
    });
    const more = rest.length > NEXT ? [div("fy-more", `+${rest.length - NEXT} more`)] : [];
    nextEl.replaceChildren(div("fy-head", `Next · ${rest.length}`), ...rows, ...more);
  }

  /** A chip shows only when it has cards, or is the one picked: an empty chip is noise. */
  function paintChips(): void {
    const chips = FILTERS.map((f) => {
      const n = f.kinds.length ? all.filter((c) => f.kinds.includes(c.kind)).length : all.length;
      if (f.key !== "all" && !n && f.key !== filter) return null;
      const b = button(`fy-chip${f.key === filter ? " is-on" : ""}`, "", () => {
        filter = f.key;
        s.front = null;
        s.talkCard = null;
        queue.paint();
      });
      b.setAttribute("aria-pressed", String(f.key === filter));
      b.append(span("", f.label), span("fy-n", String(n)));
      return b;
    }).filter((b): b is HTMLButtonElement => b !== null);
    chipsEl.replaceChildren(...chips);
  }

  function onKey(e: KeyboardEvent): void {
    if (!open || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    // The reply box handles its own Enter and Escape.
    if (t?.tagName === "INPUT") return;
    // The review deck sits over the Inbox and owns the keys while it is up.
    if (document.querySelector(".rd-veil")) return;
    if (queue.onKey(e)) e.preventDefault();
  }

  const tick = (ms: number) => {
    if (timer !== null) window.clearInterval(timer);
    timer = window.setInterval(() => void poll(), ms);
  };
  // Closed, it still reads once a minute, so the sidebar count is true when he looks at it.
  tick(SLOW_MS);
  void poll();

  return {
    open() {
      open = true;
      void poll();
      document.addEventListener("keydown", onKey);
      tick(POLL_MS);
    },
    clear() {
      open = false;
      document.removeEventListener("keydown", onKey);
      tick(SLOW_MS);
    },
    /** A source changed under the Inbox: a report or a file arrived. Repaint from what is known. */
    refresh() {
      if (!s.world) return;
      if (open) queue.paint();
      else build(Date.now());
    },
  };
}
