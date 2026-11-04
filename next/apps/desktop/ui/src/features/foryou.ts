/**
 * For you — the calls that wait for the owner, one card at a time, in value per minute of his
 * time (live_cards.ts). Decide is his board agenda, Your Turn a session that waits for him, Done
 * what finished since he last looked, Decided the calls agents made in his place, Better a step
 * that keeps losing time.
 *
 * These cards sat on the Live map until the owner split them out. Owner, 2026-11-05: "no review,
 * no boards, tasks. They must be a separate section." Live shows what runs. This shows what is
 * his to answer.
 *
 * The card in front is the queue (live_queue.ts). Beside it, the cards behind it, so he sees the
 * whole pile and can pull one forward. It reads the agents every 5 s and the board every 60 s,
 * only while the screen is open.
 */

import { errorText } from "../errors";
import { KIND, type BoardFeed } from "./live_cards";
import { facts } from "./live_facts";
import { KIND_COLOUR, mountQueue, readSeen, type QueueEvents, type QueueState } from "./live_queue";
import { button, div, span, withoutRoom } from "./live_text";
import type { LiveWorld } from "./live_types";
import "./foryou.css";

export type ForYouEvents = QueueEvents & {
  world(): Promise<LiveWorld>;
  /** Null when the board module is not installed: only sessions that wait for him make cards then. */
  board(fresh: boolean): Promise<BoardFeed | null>;
};
export type ForYouHandle = { open(): void; clear(): void };

const POLL_MS = 5000;
const BOARD_MS = 60_000;
/** Cards listed behind the front one. The rest is a count. */
const NEXT = 12;
const TOAST_MS = 3000;

export function mountForYou(root: HTMLElement, events: ForYouEvents): ForYouHandle {
  root.innerHTML = `
    <header class="fy-top">
      <div class="fy-heading">
        <h1>For you</h1>
        <p data-sum>Reading the board</p>
      </div>
      <button class="fy-btn" type="button" data-refresh>Refresh</button>
    </header>
    <div class="fy-body">
      <div class="fy-main">
        <div class="qcard" data-card aria-live="polite"></div>
        <p class="fy-hint">Enter, 2 or 3 answers the card. T talks about it. ↓ puts it off for 30 min.</p>
      </div>
      <aside class="fy-next" aria-label="Cards behind this one" data-next></aside>
    </div>
    <div class="fy-toast" data-toast role="status" hidden></div>`;
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const sum = q("[data-sum]");
  const nextEl = q("[data-next]");
  const toastEl = q("[data-toast]");

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

  let timer: number | null = null;
  let toastTimer = 0;
  let boardAt = 0;
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
  const queue = mountQueue({ ...known, s, events, toast, painted: paintNext }, q("[data-card]"));

  q("[data-refresh]").addEventListener("click", () => void readBoard(true));

  async function poll(): Promise<void> {
    if (polling) return;
    polling = true;
    try {
      s.world = await events.world();
      if (Date.now() - boardAt > BOARD_MS) await readBoard(false);
      else queue.paint();
    } catch (e) {
      sum.textContent = `Could not read the agents: ${errorText(e, "the scan failed")}`;
    } finally {
      polling = false;
    }
  }

  async function readBoard(fresh: boolean): Promise<void> {
    boardAt = Date.now();
    try {
      const b = (await events.board(fresh)) as (BoardFeed & { error?: string }) | null;
      s.board = b && !b.error ? b : s.board;
      s.boardNote = !b ? "No board module: only sessions that wait for you make cards." : b.error ? `The board did not answer: ${b.error}` : "";
    } catch (e) {
      s.boardNote = `The board did not answer: ${errorText(e, "unknown error")}`;
    }
    s.boardRead = true;
    if (s.world) queue.paint();
  }

  /** The summary line and the cards behind the front one. */
  function paintNext(): void {
    const cards = s.cards;
    const minutes = Math.max(1, Math.round(cards.reduce((n, c) => n + c.minutes, 0)));
    sum.textContent = !s.boardRead ? "Reading the board" : cards.length ? `${cards.length} ${cards.length === 1 ? "card" : "cards"} · about ${minutes} min of your time` : "Nothing waits for you.";
    const rest = cards.slice(1);
    nextEl.hidden = !rest.length;
    if (!rest.length) return nextEl.replaceChildren();
    const rows = rest.slice(0, NEXT).map((c) => {
      const room = known.roomName(c.room);
      const r = button("fy-row", "", () => {
        s.front = c.id;
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

  function onKey(e: KeyboardEvent): void {
    if (!open || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    // The reply box handles its own Enter and Escape.
    if (t?.tagName === "INPUT") return;
    if (queue.onKey(e)) e.preventDefault();
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
