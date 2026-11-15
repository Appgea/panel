/**
 * Inbox — what agents sent the owner and what waits for him, as one feed, like a Slack channel.
 *
 * Owner, 2026-11-15: "the Inbox is UNUSABLE. It should be just something like slack, extendable.
 * I simply want to open Inbox and easily see what agents send me. I have to tap 5 things to get
 * the proper response, and I even don't see shit." It was a queue: one card in front, a report
 * as a card that opened a second screen, and the report's words folded behind its title there.
 *
 * So opening it is the whole act. Every message stands whole, newest last, and the screen lands
 * on the first one he has not read. A project is a channel. "Needs you" is the channel of what
 * waits for an answer. Reading is seeing: a message that was on screen is read, with no Seen tap.
 * Answers happen in place: a board call has its options under it, an agent has a reply box.
 *
 * It is still the one screen of 2026-11-05 ("I don't think I need this many different stuff to
 * look at. One screen. Board must still keep separate."): Review, Support and History arrive
 * here as cards (inbox_cards.ts), next to the board's (live_cards.ts).
 *
 * The feed's shape is inbox_feed.ts. This file draws it. It reads the agents every 5 s while
 * open, and the board and the slow sources every 60 s, open or not, so the sidebar count is true.
 */

import { errorText } from "../errors";
import { icon, type IconName } from "../icons";
import type { ChangeStep } from "../types";
import { inboxCards, type EndedItem, type ReviewBatch, type SupportItem } from "./inbox_cards";
import { ALL, NEEDS, buildFeed, holds, inChannel, isStuck, postKey, type Feed, type FeedItem, type InboxPost } from "./inbox_feed";
import { buildPeek, type PeekHandle } from "./inbox_peek";
import { buildCards, KIND, type Act, type BoardFeed, type Card, type CardKind } from "./live_cards";
import { facts } from "./live_facts";
import { button, div, hhmm, span, withoutRoom } from "./live_text";
import type { LiveWorld } from "./live_types";
import "./foryou.css";

export type ForYouEvents = {
  world(): Promise<LiveWorld>;
  /** Null when the board module is not installed: the other sources still make cards. */
  board(fresh: boolean): Promise<BoardFeed | null>;
  /** Every kept agent message, oldest first. */
  posts(): InboxPost[];
  review(): ReviewBatch[];
  /** Null when the support module is not installed; rejects when its log cannot be read.
   *  `fresh` pulls the forms. `problem` says why the last pull fell short. */
  support(fresh: boolean): Promise<{ items: SupportItem[]; problem: string } | null>;
  ended(): Promise<{ items: EndedItem[]; floor: number }>;
  /** A Panel project's name, for cards keyed by project rather than portfolio key. */
  projectName(id: string): string | null;
  picture(path: string): Promise<string>;
  pictureSrc(project: string, path: string): string;
  /** The sidebar count: everything unread or waiting for him. And the unread of each project. */
  count(n: number, byProject: Map<string, number>): void;

  answer(body: { number: number; pick?: number; say?: string }): Promise<{ ok: boolean; said?: string }>;
  openUrl(url: string): void;
  /** Jump to the Panel terminal hosting an agent. False when that terminal is gone. */
  openTerminal(panel: string): boolean;
  sendToAgent(panel: string, text: string): Promise<boolean>;
  openReview(project: string, paths: string[]): Promise<boolean>;
  resume(session: string): Promise<void>;
  openSupport(): void;
  /** A card was read or waved off: clear its `refs` at their source too. */
  seen(card: Card): void;

  /** A post's body. Every path and picture it names opens in the evidence box under it. */
  render(post: InboxPost, openRef: (ref: string) => void): HTMLElement;
  renderFlow(post: InboxPost, openRef: (ref: string) => void): HTMLElement | null;
  changes(project: string, path: string): Promise<ChangeStep[]>;
  readFile(project: string, path: string): Promise<string>;
  openRef(project: string, ref: string): void;
  /** Enter the project and focus the terminal that sent a post. */
  openSession(project: string, session: string): void;
  /** False once a session has exited: its post stops offering a reply. */
  isLiveSession(session: string): boolean;
};

export type ForYouHandle = {
  open(): void;
  clear(): void;
  /** A source changed under the Inbox: a message or a file arrived. Repaint from what is known. */
  refresh(): void;
  /** Show one post and flash it. The caller opens the screen. */
  reveal(postId: string): void;
};

const POLL_MS = 5000;
const SLOW_MS = 60_000;
const TOAST_MS = 3000;
/** Rows drawn at first, and added by each "Show earlier". Media in older rows never loads. */
const PAGE = 60;
/** Posts from one agent inside this window read as one burst: one avatar, one byline. */
const GROUP_MS = 5 * 60_000;
/** A list in a card shows this many lines, then a count. */
const ITEMS = 8;
// The key keeps its old name, so what the owner saw on Live stays seen.
const SEEN_KEY = "panel.live.seen";

const KIND_COLOUR: Record<CardKind, string> = {
  decide: "var(--warn)",
  turn: "var(--warn)",
  review: "var(--accent)",
  support: "var(--warn)",
  better: "var(--accent)",
  decided: "var(--ink-dim)",
  done: "var(--ok)",
  ended: "var(--ok)",
};
const KIND_ICON: Record<CardKind, IconName> = {
  decide: "flag",
  turn: "terminal",
  review: "image",
  support: "inbox",
  better: "bolt",
  decided: "standards",
  done: "check",
  ended: "clock",
};

const agentGlyph = (kind: string): IconName => (kind === "codex" || kind === "opencode" ? "code" : kind === "shell" ? "terminal" : "agent");

const dayLabel = (at: number): string => {
  const midnight = (value: number): number => new Date(new Date(value).toDateString()).getTime();
  const days = Math.round((midnight(Date.now()) - midnight(at)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(at);
};

function readSeen(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}") as Record<string, number>;
    // A week of marks is plenty: an older post reads as read, and the board forgets older closes.
    const cut = Date.now() - 7 * 86_400_000;
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === "number" && v > cut));
  } catch {
    return {};
  }
}

function writeSeen(seen: Record<string, number>): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    // Private storage off: read marks last this session only.
  }
}

/** Put `nodes` in `parent` in order. A node already in place is not touched, so a playing clip,
 *  an open evidence box and a half-typed reply all survive the next read. */
function sync(parent: HTMLElement, nodes: HTMLElement[]): void {
  let cursor = parent.firstElementChild;
  for (const node of nodes) {
    if (node === cursor) cursor = cursor.nextElementSibling;
    else parent.insertBefore(node, cursor);
  }
  while (cursor) {
    const next = cursor.nextElementSibling;
    cursor.remove();
    cursor = next;
  }
}

export function mountForYou(root: HTMLElement, events: ForYouEvents): ForYouHandle {
  root.innerHTML = `
    <aside class="ib-side" aria-label="Channels">
      <h1>Inbox</h1>
      <nav class="ib-chans" data-chans></nav>
    </aside>
    <section class="ib-main">
      <header class="ib-head">
        <div class="ib-heading">
          <h2 data-title>All</h2>
          <p data-sum>Reading the board</p>
        </div>
        <input class="ib-search" type="search" placeholder="Search" aria-label="Search the Inbox" data-search />
        <button class="ib-btn" type="button" data-read title="Mark everything in this channel as read">Mark Read</button>
        <button class="ib-btn" type="button" data-refresh title="Read the board and the support forms again">Refresh</button>
      </header>
      <p class="ib-problem" data-problem hidden><span></span> <button type="button" class="ib-link">Open Support</button></p>
      <div class="ib-feed" data-feed></div>
      <button class="ib-jump" type="button" data-jump hidden>Latest ↓</button>
    </section>
    <div class="ib-toast" data-toast role="status" hidden></div>`;
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const chansEl = q("[data-chans]");
  const titleEl = q("[data-title]");
  const sumEl = q("[data-sum]");
  const feedEl = q("[data-feed]");
  const jumpEl = q<HTMLButtonElement>("[data-jump]");
  const searchEl = q<HTMLInputElement>("[data-search]");
  const toastEl = q("[data-toast]");
  // With no Support row, this line is the way into its setup when mail cannot be read.
  const problemEl = q("[data-problem]");
  problemEl.querySelector("button")!.addEventListener("click", () => events.openSupport());
  const showProblem = (text: string) => {
    problemEl.hidden = !text;
    problemEl.querySelector("span")!.textContent = text;
  };

  let world: LiveWorld | null = null;
  let board: BoardFeed | null = null;
  let boardNote = "";
  let boardRead = false;
  let support: SupportItem[] = [];
  let ended: { items: EndedItem[]; floor: number } = { items: [], floor: Date.now() };
  const seen = readSeen();
  /** Board calls answered here, gone before the board's next read says so. */
  const answered = new Set<string>();
  /** Cards that were on screen this visit. They stay until he leaves, then they are read. */
  const viewed = new Set<string>();
  /** What was unread when this visit began: the "New" line is drawn above the first of them. */
  let fresh = new Set<string>();
  /** What waited for him when this visit began. Reading a stuck report must not pull it out from
   *  under his eyes, so these stay in "Needs you", marked, until he leaves. */
  let held = new Set<string>();
  const shows = (item: FeedItem) => inChannel(item, channel) || (channel === NEEDS && held.has(item.id));
  let feed: Feed = { items: [], channels: [], waiting: 0, needsYou: 0 };
  let channel = ALL;
  let query = "";
  let limit = PAGE;
  /** Where the next paint should scroll: the first unread message, or one post. */
  let land: "new" | string | null = null;
  let flash: string | null = null;
  let open = false;
  let timer: number | null = null;
  let toastTimer = 0;
  let slowAt = 0;
  let polling = false;

  const toast = (text: string, bad = false) => {
    toastEl.textContent = text;
    toastEl.classList.toggle("is-bad", bad);
    toastEl.hidden = !text;
    window.clearTimeout(toastTimer);
    if (text) toastTimer = window.setTimeout(() => (toastEl.hidden = true), TOAST_MS);
  };
  const known = facts(() => ({ world, board }));
  // Cards from Panel's own screens are keyed by Panel project id, not by portfolio key.
  const roomName = (key: string) => {
    const name = known.roomName(key);
    return name === key ? (events.projectName(key) ?? key) : name;
  };

  function build(now: number): Feed {
    const agents = (world?.agents ?? []).map((a) => ({ id: a.id, name: known.nameOf(a), room: known.roomOf(a), state: a.state, stateMs: a.stateMs, headless: a.headless, panel: a.panel, lastText: a.lastText }));
    const sources = { review: events.review(), support, ended: ended.items, endedFloor: ended.floor };
    const cards = [...buildCards(board, agents, roomName, seen, now), ...inboxCards(sources, roomName, events.pictureSrc, seen)].filter((c) => !answered.has(c.id));
    return buildFeed(events.posts(), cards, seen, now, viewed);
  }

  /* ------------------------------------------------------------- reading */

  /** A post on screen is read up to there. A card on screen is read when he leaves: taking it
   *  away while he looks at it would be a jump. A card that waits for an answer stays. */
  function see(item: FeedItem): boolean {
    if (item.post) {
      const key = postKey(item.room);
      if (item.at <= (seen[key] ?? 0)) return false;
      seen[key] = item.at;
    } else if (item.card && !item.needsYou && !viewed.has(item.id)) viewed.add(item.id);
    else return false;
    return true;
  }

  /** Read the viewed cards for good, at their source too. */
  function settle(cards: Card[]): void {
    const now = Date.now();
    for (const card of cards) {
      for (const key of card.seenKeys) seen[key] = now;
      events.seen(card);
      viewed.delete(card.id);
    }
    if (cards.length) writeSeen(seen);
  }

  const onScreen = new Set<string>();
  const attentive = () => open && document.visibilityState === "visible" && document.hasFocus();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.id ?? "";
        if (entry.isIntersecting) onScreen.add(id);
        else onScreen.delete(id);
      }
      seeOnScreen();
    },
    // The bottom fifth does not count: a row has to come up into view, not peek over the edge.
    { root: feedEl, rootMargin: "0px 0px -20% 0px" },
  );
  function seeOnScreen(): void {
    if (!attentive()) return;
    if (!feed.items.filter((item) => onScreen.has(item.id) && see(item)).length) return;
    writeSeen(seen);
    paintCounts();
  }
  window.addEventListener("focus", seeOnScreen);

  /* ---------------------------------------------------------------- rows */

  const rows = new Map<string, { el: HTMLElement; sig: string }>();
  const rules = new Map<string, HTMLElement>();
  const peeks = new Map<string, PeekHandle>();
  const pictures = new Map<string, string>();

  function rule(key: string, text: string, cls = ""): HTMLElement {
    let node = rules.get(key);
    if (!node) {
      node = div(`msg-day${cls}`);
      node.append(span("", text));
      rules.set(key, node);
    }
    return node;
  }

  /** The row every message shares: an avatar gutter, a byline, a body. */
  function shell(glyph: IconName, tint: string): { article: HTMLElement; head: HTMLElement; main: HTMLElement } {
    const article = document.createElement("article");
    article.className = "msg";
    const rail = div("msg-rail");
    const avatar = span("msg-avatar");
    avatar.innerHTML = icon(glyph);
    if (tint) avatar.style.setProperty("--c", tint);
    rail.append(avatar);
    const main = div("msg-main");
    const head = document.createElement("header");
    head.className = "msg-head";
    main.append(head);
    article.append(rail, main);
    return { article, head, main };
  }

  /** The project as the headline of a row. It opens that project's channel. */
  function where(room: string): HTMLElement {
    const b = button("msg-where", roomName(room), () => show(room));
    b.title = `Show only ${roomName(room)}`;
    return b;
  }

  function act(label: string, primary: boolean, run: () => void): HTMLButtonElement {
    return button(`ib-act${primary ? " is-primary" : ""}`, label, run);
  }

  /** A reply box under a message. Enter sends, Esc closes. */
  function replyBox(to: string, send: (words: string) => Promise<void>, done: () => void): HTMLElement {
    const form = document.createElement("form");
    form.className = "ib-reply";
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 500;
    input.autocomplete = "off";
    input.placeholder = `Reply to ${to}`;
    input.setAttribute("aria-label", `Reply to ${to}`);
    const sendBtn = document.createElement("button");
    sendBtn.type = "submit";
    sendBtn.className = "ib-act is-primary";
    sendBtn.textContent = "Send";
    form.append(input, sendBtn);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const words = input.value.trim();
      if (!words || sendBtn.disabled) return;
      sendBtn.disabled = true;
      send(words)
        .then(done)
        .catch((error: unknown) => toast(`Not sent: ${errorText(error, "unknown error")}`, true))
        .finally(() => (sendBtn.disabled = false));
    });
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      done();
    });
    return form;
  }

  /** A Reply button that swaps itself for the box. */
  function replyAct(actions: HTMLElement, to: string, send: (words: string) => Promise<void>): HTMLButtonElement {
    const b = act("Reply", false, () => {
      const box = replyBox(to, send, () => {
        box.remove();
        b.hidden = false;
      });
      b.hidden = true;
      actions.after(box);
      box.querySelector("input")!.focus();
    });
    return b;
  }

  /** A thread's older messages, folded. Drawn on first open: a long thread costs nothing until then. */
  function earlierFold(earlier: InboxPost[]): HTMLElement {
    const fold = document.createElement("details");
    fold.className = "ib-earlier";
    const summary = document.createElement("summary");
    summary.textContent = `${earlier.length} earlier ${earlier.length === 1 ? "message" : "messages"}`;
    fold.append(summary);
    fold.addEventListener("toggle", () => {
      if (!fold.open || fold.childElementCount > 1) return;
      for (const older of [...earlier].reverse()) {
        const entry = div("ib-earlier-one");
        entry.append(Object.assign(document.createElement("time"), { textContent: hhmm(older.at) }));
        const body = events.render(older, (ref) => events.openRef(older.project, ref));
        body.classList.add("in-feed");
        entry.append(body);
        fold.append(entry);
      }
    });
    return fold;
  }

  function postRow(post: InboxPost, live: boolean, earlier: InboxPost[]): HTMLElement {
    const session = post.session;
    const { article, head, main } = shell(agentGlyph(post.agentKind), "");
    article.querySelector<HTMLElement>(".msg-avatar")!.dataset.agent = post.agentKind;
    head.append(where(post.project));
    if (session && live) {
      const author = button("msg-author is-live", post.author, () => events.openSession(post.project, session));
      author.title = `Open ${post.author}'s terminal`;
      head.append(author);
    } else head.append(Object.assign(document.createElement("b"), { className: "msg-author", textContent: post.author }));
    head.append(Object.assign(document.createElement("time"), { textContent: hhmm(post.at) }));

    const since = (target: InboxPost): number =>
      events.posts().filter((other) => other.session && other.session === target.session && other.at < target.at).at(-1)?.at ?? 0;
    // The box is built on first use and belongs to this row, so it keeps a running replay.
    const openPeek = (): PeekHandle => {
      let peek = peeks.get(post.id);
      if (!peek) {
        peek = buildPeek(post, { changes: events.changes, readFile: events.readFile, flow: events.renderFlow, openRef: events.openRef, since });
        peeks.set(post.id, peek);
      }
      if (peek.root.parentElement !== main) main.append(peek.root);
      return peek;
    };
    const body = events.render(post, (ref) => openPeek().showRef(ref));
    body.classList.add("in-feed");
    main.append(body);

    const actions = document.createElement("footer");
    actions.className = "ib-acts";
    if (post.flowSteps.length || post.flowFiles.length) {
      const n = post.flowFiles.length || post.flowSteps.length;
      const flow = act(`What changed · ${n} ${post.flowFiles.length ? "file" : "step"}${n === 1 ? "" : "s"}`, false, () => {
        const peek = openPeek();
        peek.toggle();
        flow.classList.toggle("is-on", peek.isOpen());
      });
      flow.title = "Replay the edits here";
      actions.append(flow);
    }
    if (session && live) {
      actions.append(
        replyAct(actions, post.author, async (words) => {
          if (!(await events.sendToAgent(session, words))) throw new Error("its terminal did not take the text");
          toast(`Sent to ${post.author}.`);
        }),
        act("Open Terminal", false, () => events.openSession(post.project, session)),
      );
    }
    if (actions.childElementCount) main.append(actions);
    if (earlier.length) main.append(earlierFold(earlier));
    const peek = peeks.get(post.id);
    if (peek) main.append(peek.root);
    return article;
  }

  function cardRow(card: Card): HTMLElement {
    const room = roomName(card.room);
    const { article, head, main } = shell(KIND_ICON[card.kind], KIND_COLOUR[card.kind]);
    article.classList.add("is-card");
    if (KIND[card.kind].needsYou) article.classList.add("is-needs");
    article.style.setProperty("--c", KIND_COLOUR[card.kind]);
    const agent = known.agentById(card.agent ?? null);
    const source = card.number ? `#${card.number}` : agent ? known.nameOf(agent) : "";
    head.append(where(card.room), span("ib-kind", KIND[card.kind].label));
    if (source) head.append(span("ib-src", source));
    // A Decided card carries no time: the board does not say when the call was made.
    if (card.kind !== "decided") head.append(Object.assign(document.createElement("time"), { textContent: hhmm(card.arrivedMs) }));

    main.append(div("ib-title", withoutRoom(card.title, room)));
    for (const line of card.lines) main.append(div("ib-line", line));
    if (card.items?.length) {
      const ul = document.createElement("ul");
      ul.className = "ib-list";
      for (const text of card.items.slice(0, ITEMS)) ul.append(Object.assign(document.createElement("li"), { textContent: text }));
      if (card.items.length > ITEMS) ul.append(Object.assign(document.createElement("li"), { className: "more", textContent: `+${card.items.length - ITEMS} more` }));
      main.append(ul);
    }
    const shots = div("ib-shots");
    if (card.pictureSrc) shots.append(thumb(card.pictureSrc));
    for (const path of (card.pictures ?? []).slice(0, 4)) shots.append(picture(path));
    if (shots.childElementCount) main.append(shots);

    const actions = document.createElement("footer");
    actions.className = "ib-acts";
    card.options.forEach((o, i) => actions.append(act(o.label, i === 0 && KIND[card.kind].needsYou, () => void run(card, o.act))));
    const talk = card.talk;
    if (talk) {
      const to = talk.to === "agent" ? talk.name : `the board, on #${talk.number}`;
      actions.append(
        replyAct(actions, to, async (words) => {
          if (talk.to === "board") {
            await events.answer({ number: talk.number, say: words });
            answered.add(card.id);
            toast(`Your words are on #${talk.number}.`);
          } else {
            if (!(await events.sendToAgent(talk.panel, words))) throw new Error("its terminal did not take the text");
            settle([card]);
            toast(`Sent to ${talk.name}.`);
          }
          paint();
        }),
      );
    }
    if (actions.childElementCount) main.append(actions);
    return article;
  }

  /** A picture in a card. A click shows it at full width, and again folds it back. */
  function thumb(src: string): HTMLImageElement {
    const img = Object.assign(document.createElement("img"), { className: "ib-shot", alt: "", loading: "lazy" as const });
    if (src) img.src = src;
    img.addEventListener("click", () => img.classList.toggle("is-big"));
    return img;
  }

  function picture(path: string): HTMLImageElement {
    const img = thumb(pictures.get(path) ?? "");
    if (!pictures.has(path))
      void events
        .picture(path)
        .then((src) => {
          pictures.set(path, src);
          img.src = src;
        })
        .catch(() => img.remove());
    return img;
  }

  async function run(card: Card, a: Act): Promise<void> {
    switch (a.do) {
      case "answer":
        try {
          const r = await events.answer({ number: a.number, pick: a.pick });
          answered.add(card.id);
          toast(r.said ? `Answered. ${r.said}` : `Answered #${a.number}.`);
          paint();
        } catch (e) {
          toast(`Not answered: ${errorText(e, "the board refused it")}`, true);
        }
        return;
      case "seen":
        settle([card]);
        paint();
        return;
      case "terminal":
        if (!events.openTerminal(a.panel)) toast("That terminal is gone.", true);
        return;
      case "url":
        events.openUrl(a.url);
        return;
      case "review":
        // The deck marks each file seen as it is looked at, so the card leaves on its own.
        if (!(await events.openReview(a.project, a.paths))) toast("Those files are gone from disk.", true);
        return;
      case "resume":
        try {
          await events.resume(a.session);
          settle([card]);
          paint();
        } catch (e) {
          toast(`Not resumed: ${errorText(e, "the agent refused")}`, true);
        }
        return;
      case "support":
        events.openSupport();
    }
  }

  /** What a row is built from. A changed signature rebuilds the row. */
  function signature(item: FeedItem): string {
    if (item.post) return `${Boolean(item.post.session && events.isLiveSession(item.post.session))}|${item.earlier?.length ?? 0}`;
    const c = item.card!;
    return JSON.stringify([c.title, c.lines, c.items, c.options.map((o) => o.label), c.pictureSrc, c.pictures, roomName(c.room)]);
  }

  function rowFor(item: FeedItem): HTMLElement {
    const sig = signature(item);
    const known = rows.get(item.id);
    if (known && known.sig === sig) return known.el;
    if (known) observer.unobserve(known.el);
    const el = item.post ? postRow(item.post, sig.startsWith("true"), item.earlier ?? []) : cardRow(item.card!);
    el.dataset.id = item.id;
    rows.set(item.id, { el, sig });
    observer.observe(el);
    return el;
  }

  /* --------------------------------------------------------------- paint */

  const haystack = new Map<string, string>();
  function matches(item: FeedItem): boolean {
    if (!query) return true;
    let text = haystack.get(item.id);
    if (text === undefined) {
      const p = item.post;
      const c = item.card;
      text = (p ? `${p.author} ${p.projectName} ${JSON.stringify([p.payload, ...(item.earlier ?? []).map((e) => e.payload)])}` :`${roomName(c!.room)} ${c!.title} ${c!.lines.join(" ")} ${(c!.items ?? []).join(" ")}`).toLowerCase();
      // A card's words change under one id, so only a post's are worth keeping.
      if (p) haystack.set(item.id, text);
    }
    return text.includes(query);
  }

  const nearBottom = () => feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 120;
  const toBottom = () => (feedEl.scrollTop = feedEl.scrollHeight);
  /** The landing spot, held while pictures load and move it. His own scroll lets go of it. */
  let hold: (() => void) | null = null;
  const paintJump = () => (jumpEl.hidden = nearBottom());
  feedEl.addEventListener("scroll", paintJump, { passive: true });
  for (const type of ["wheel", "touchmove", "keydown", "mousedown"] as const) feedEl.addEventListener(type, () => (hold = null), { passive: true });
  feedEl.addEventListener("load", () => hold?.(), true);
  jumpEl.addEventListener("click", () => {
    hold = toBottom;
    toBottom();
  });

  function paintFeed(): void {
    const list = feed.items.filter((item) => shows(item) && matches(item));
    const shown = list.slice(-limit);
    const stick = nearBottom();
    const nodes: HTMLElement[] = [];
    if (list.length > shown.length) {
      nodes.push(
        rules.get("earlier") ??
          rules
            .set(
              "earlier",
              button("ib-earlier", "Show earlier", () => {
                const from = feedEl.scrollHeight;
                limit += PAGE;
                paintFeed();
                feedEl.scrollTop += feedEl.scrollHeight - from;
              }),
            )
            .get("earlier")!,
      );
    }
    let lastDay = "";
    let lastKey = "";
    let lastAt = 0;
    let newDrawn = false;
    for (const item of shown) {
      const day = new Date(item.at).toDateString();
      if (day !== lastDay) {
        nodes.push(rule(`day:${day}`, dayLabel(item.at)));
        lastDay = day;
        lastKey = "";
      }
      if (!newDrawn && fresh.has(item.id)) {
        nodes.push(rule("new", "New", " is-new"));
        newDrawn = true;
        lastKey = "";
      }
      const el = rowFor(item);
      const key = item.post ? `${item.post.project}:${item.post.session ?? item.post.author}` : "";
      el.classList.toggle("is-grouped", key !== "" && key === lastKey && item.at - lastAt < GROUP_MS);
      el.classList.toggle("is-flash", item.id === flash);
      if (item.post) el.classList.toggle("is-needs", isStuck(item.post) && (item.needsYou || held.has(item.id)));
      lastKey = key;
      lastAt = item.at;
      nodes.push(el);
    }
    if (!shown.length) nodes.push(empty());
    sync(feedEl, nodes);

    if (land) {
      const target = land === "new" ? (newDrawn ? rules.get("new")! : null) : (rows.get(land)?.el ?? null);
      land = null;
      hold = target ? () => (feedEl.scrollTop = Math.max(0, target.offsetTop - 12)) : toBottom;
      hold();
    } else if (stick && shown.length) toBottom();
    paintJump();
  }

  function empty(): HTMLElement {
    const node = rules.get("empty") ?? rules.set("empty", div("inbox-empty")).get("empty")!;
    const [title, text] = query
      ? ["Nothing matches", `No message mentions “${query}”.`]
      : channel === NEEDS
        ? ["Nothing needs you", "Calls, waiting agents and files to look at show up here."]
        : !boardRead
          ? ["Reading the board", "Messages from your agents appear here."]
          : ["No messages yet", "Messages from your agents appear here."];
    node.replaceChildren(Object.assign(document.createElement("b"), { textContent: title }), Object.assign(document.createElement("p"), { textContent: text }));
    return node;
  }

  function chan(key: string, label: string, n: number, cls = ""): HTMLButtonElement {
    const b = button(`ib-chan${cls}${key === channel ? " is-on" : ""}`, "", () => show(key));
    b.setAttribute("aria-current", String(key === channel));
    b.append(span("ib-chan-name", label));
    if (n) b.append(span("ib-n", n > 99 ? "99+" : String(n)));
    return b;
  }

  /** The channel list as last drawn. A read that changes nothing must not rebuild it under the cursor. */
  let drawn = "";
  function paintCounts(): void {
    feed = build(Date.now());
    const sig = JSON.stringify([channel, feed.waiting, feed.needsYou, feed.channels.map((c) => [c.key, roomName(c.key), c.unread])]);
    if (sig !== drawn) {
      drawn = sig;
      events.count(feed.waiting, new Map(feed.channels.map((c) => [c.key, c.unread])));
      const names = feed.channels.map((c) => chan(c.key, roomName(c.key), c.unread));
      chansEl.replaceChildren(chan(ALL, "All", feed.waiting), chan(NEEDS, "Needs you", feed.needsYou, " is-needs"), ...(names.length ? [div("ib-chans-label", "Projects"), ...names] : []));
    }
    titleEl.textContent = channel === ALL ? "All" : channel === NEEDS ? "Needs you" : roomName(channel);
    const mine = feed.items.filter(shows);
    const unread = mine.filter((item) => item.unread).length;
    const needs = mine.filter((item) => item.needsYou).length;
    sumEl.textContent = boardNote || [unread ? `${unread} new` : "", needs ? `${needs} ${needs === 1 ? "needs" : "need"} you` : ""].filter(Boolean).join(" · ") || (boardRead ? "All read." : "Reading the board");
  }

  function paint(): void {
    paintCounts();
    if (!open) return;
    paintFeed();
    // Rows of messages that left the feed: a card that was answered, a post past its month.
    const live = new Set(feed.items.map((item) => item.id));
    for (const [id, row] of rows) {
      if (live.has(id)) continue;
      observer.unobserve(row.el);
      rows.delete(id);
      onScreen.delete(id);
      haystack.delete(id);
      peeks.delete(id.slice("post:".length));
    }
  }

  /** Switch channel. The cards he saw in the one he leaves are read. */
  function show(next: string): void {
    leave();
    channel = next;
    limit = PAGE;
    arrive();
    paint();
  }

  function arrive(): void {
    const items = build(Date.now()).items;
    fresh = new Set(items.filter((item) => item.unread).map((item) => item.id));
    held = new Set(items.filter((item) => item.needsYou).map((item) => item.id));
    land = "new";
  }

  function leave(): void {
    settle(feed.items.flatMap((item) => (item.card && viewed.has(item.id) ? [item.card] : [])));
  }

  q("[data-read]").addEventListener("click", () => {
    const now = Date.now();
    const mine = feed.items.filter(shows);
    for (const item of mine) if (item.post) seen[postKey(item.room)] = now;
    writeSeen(seen);
    settle(mine.flatMap((item) => (item.card && !item.needsYou ? [item.card] : [])));
    fresh = new Set();
    held = new Set();
    paint();
  });
  q("[data-refresh]").addEventListener("click", () => void readSlow(true));

  let searchTimer = 0;
  searchEl.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      query = searchEl.value.trim().toLowerCase();
      limit = PAGE;
      land = "new";
      paint();
    }, 120);
  });

  /* ------------------------------------------------------------- sources */

  async function poll(): Promise<void> {
    if (polling) return;
    polling = true;
    try {
      world = await events.world();
      if (Date.now() - slowAt > SLOW_MS) await readSlow(false);
      else paint();
    } catch (e) {
      boardNote = `Could not read the agents: ${errorText(e, "the scan failed")}`;
      paint();
    } finally {
      polling = false;
    }
  }

  /** The board, Support and History: each slow, each optional. One failing never hides the rest. */
  async function readSlow(freshPull: boolean): Promise<void> {
    slowAt = Date.now();
    const [b, sup, end] = await Promise.allSettled([events.board(freshPull), events.support(freshPull), events.ended()]);
    if (b.status === "fulfilled") {
      const got = b.value as (BoardFeed & { error?: string }) | null;
      board = got && !got.error ? got : board;
      boardNote = !got ? "" : got.error ? `The board did not answer: ${got.error}` : "";
    } else boardNote = `The board did not answer: ${errorText(b.reason, "unknown error")}`;
    // A failed read keeps the cards it had: a blip must not empty the feed.
    if (sup.status === "fulfilled") {
      support = sup.value?.items ?? [];
      showProblem(sup.value?.problem ?? "");
    } else showProblem(`Support mail could not be read: ${errorText(sup.reason, "unknown error")}.`);
    if (end.status === "fulfilled") ended = end.value;
    boardRead = true;
    paint();
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
      if (!open) {
        open = true;
        channel = ALL;
        limit = PAGE;
        arrive();
      }
      paint();
      void poll();
      tick(POLL_MS);
    },
    clear() {
      if (!open) return;
      leave();
      open = false;
      flash = null;
      tick(SLOW_MS);
      paintCounts();
    },
    refresh: paint,
    reveal(postId) {
      // A message folded under a newer one opens on its thread.
      const id = feed.items.find((item) => holds(item, postId))?.id ?? `post:${postId}`;
      channel = ALL;
      query = "";
      searchEl.value = "";
      flash = id;
      const at = feed.items.filter((item) => inChannel(item, ALL)).findIndex((item) => item.id === id);
      if (at >= 0) limit = Math.max(PAGE, feed.items.length - at);
      land = id;
      if (open) paint();
    },
  };
}
