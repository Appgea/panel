import { errorText } from "../errors";
import { icon, type IconName } from "../icons";
import type { ChangeStep } from "../types";
import { READ_KEY, buildFeed, holds, type Feed, type FeedItem, type InboxPost } from "./inbox_feed";
import { buildPeek, type PeekHandle } from "./inbox_peek";
import { button, div, hhmm, span } from "./live_text";
import "./foryou.css";

export type ForYouEvents = {
  posts(): InboxPost[];
  count(n: number): void;
  sendToAgent(panel: string, text: string): Promise<boolean>;
  render(post: InboxPost, openRef: (ref: string) => void): HTMLElement;
  renderFlow(post: InboxPost, openRef: (ref: string) => void): HTMLElement | null;
  changes(project: string, path: string): Promise<ChangeStep[]>;
  readFile(project: string, path: string): Promise<string>;
  openRef(project: string, ref: string): void;
  openSession(project: string, session: string): void;
  isLiveSession(session: string): boolean;
};

export type ForYouHandle = {
  open(): void;
  clear(): void;
  refresh(): void;
  reveal(postId: string): void;
};

const SLOW_MS = 60_000;
const TOAST_MS = 3000;
const PAGE = 60;
const GROUP_MS = 5 * 60_000;
const SEEN_KEY = "panel.live.seen";

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
    return;
  }
}

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
    <section class="ib-main">
      <header class="ib-head">
        <div class="ib-heading">
          <h2>Inbox</h2>
          <p data-sum>Last 48 hours</p>
        </div>
        <input class="ib-search" type="search" placeholder="Search" aria-label="Search the Inbox" data-search />
        <button class="ib-btn" type="button" data-read title="Mark everything as read">Mark Read</button>
      </header>
      <div class="ib-feed" data-feed></div>
      <button class="ib-jump" type="button" data-jump hidden>Latest ↓</button>
    </section>
    <div class="ib-toast" data-toast role="status" hidden></div>`;
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const sumEl = q("[data-sum]");
  const feedEl = q("[data-feed]");
  const jumpEl = q<HTMLButtonElement>("[data-jump]");
  const searchEl = q<HTMLInputElement>("[data-search]");
  const toastEl = q("[data-toast]");

  const seen = readSeen();
  let fresh = new Set<string>();
  let feed: Feed = { items: [], unread: 0 };
  let query = "";
  let limit = PAGE;
  let land: "new" | string | null = null;
  let flash: string | null = null;
  let open = false;
  let timer: number | null = null;
  let toastTimer = 0;

  const toast = (text: string, bad = false) => {
    toastEl.textContent = text;
    toastEl.classList.toggle("is-bad", bad);
    toastEl.hidden = !text;
    window.clearTimeout(toastTimer);
    if (text) toastTimer = window.setTimeout(() => (toastEl.hidden = true), TOAST_MS);
  };

  const build = (now: number): Feed => buildFeed(events.posts(), seen, now);

  function see(item: FeedItem): boolean {
    if (item.at <= (seen[READ_KEY] ?? 0)) return false;
    seen[READ_KEY] = item.at;
    return true;
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
    { root: feedEl, rootMargin: "0px 0px -20% 0px" },
  );
  function seeOnScreen(): void {
    if (!attentive()) return;
    if (!feed.items.filter((item) => onScreen.has(item.id) && see(item)).length) return;
    writeSeen(seen);
    paintCounts();
  }
  window.addEventListener("focus", seeOnScreen);

  const rows = new Map<string, { el: HTMLElement; sig: string }>();
  const rules = new Map<string, HTMLElement>();
  const peeks = new Map<string, PeekHandle>();

  function rule(key: string, text: string, cls = ""): HTMLElement {
    let node = rules.get(key);
    if (!node) {
      node = div(`msg-day${cls}`);
      node.append(span("", text));
      rules.set(key, node);
    }
    return node;
  }

  function shell(glyph: IconName): { article: HTMLElement; head: HTMLElement; main: HTMLElement } {
    const article = document.createElement("article");
    article.className = "msg";
    const rail = div("msg-rail");
    const avatar = span("msg-avatar");
    avatar.innerHTML = icon(glyph);
    rail.append(avatar);
    const main = div("msg-main");
    const head = document.createElement("header");
    head.className = "msg-head";
    main.append(head);
    article.append(rail, main);
    return { article, head, main };
  }

  function act(label: string, primary: boolean, run: () => void): HTMLButtonElement {
    return button(`ib-act${primary ? " is-primary" : ""}`, label, run);
  }

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
    const { article, head, main } = shell(agentGlyph(post.agentKind));
    article.querySelector<HTMLElement>(".msg-avatar")!.dataset.agent = post.agentKind;
    head.append(span("msg-where", post.projectName));
    if (session && live) {
      const author = button("msg-author is-live", post.author, () => events.openSession(post.project, session));
      author.title = `Open ${post.author}'s terminal`;
      head.append(author);
    } else head.append(Object.assign(document.createElement("b"), { className: "msg-author", textContent: post.author }));
    head.append(Object.assign(document.createElement("time"), { textContent: hhmm(post.at) }));

    const since = (target: InboxPost): number =>
      events.posts().filter((other) => other.session && other.session === target.session && other.at < target.at).at(-1)?.at ?? 0;
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

  function signature(item: FeedItem): string {
    return `${Boolean(item.post.session && events.isLiveSession(item.post.session))}|${item.earlier.length}`;
  }

  function rowFor(item: FeedItem): HTMLElement {
    const sig = signature(item);
    const known = rows.get(item.id);
    if (known && known.sig === sig) return known.el;
    if (known) observer.unobserve(known.el);
    const el = postRow(item.post, sig.startsWith("true"), item.earlier);
    el.dataset.id = item.id;
    rows.set(item.id, { el, sig });
    observer.observe(el);
    return el;
  }

  const haystack = new Map<string, string>();
  function matches(item: FeedItem): boolean {
    if (!query) return true;
    let text = haystack.get(item.id);
    if (text === undefined) {
      text = `${item.post.author} ${item.post.projectName} ${JSON.stringify([item.post.payload, ...item.earlier.map((e) => e.payload)])}`.toLowerCase();
      haystack.set(item.id, text);
    }
    return text.includes(query);
  }

  const nearBottom = () => feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 120;
  const toBottom = () => (feedEl.scrollTop = feedEl.scrollHeight);
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
    const list = feed.items.filter(matches);
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
      const key = `${item.post.project}:${item.post.session ?? item.post.author}`;
      el.classList.toggle("is-grouped", key === lastKey && item.at - lastAt < GROUP_MS);
      el.classList.toggle("is-flash", item.id === flash);
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
      : ["No messages", "Messages from your agents in the last 48 hours appear here."];
    node.replaceChildren(Object.assign(document.createElement("b"), { textContent: title }), Object.assign(document.createElement("p"), { textContent: text }));
    return node;
  }

  let drawn = -1;
  function paintCounts(): void {
    feed = build(Date.now());
    if (feed.unread !== drawn) {
      drawn = feed.unread;
      events.count(feed.unread);
    }
    sumEl.textContent = feed.unread ? `${feed.unread} new · last 48 hours` : "Last 48 hours";
  }

  function paint(): void {
    paintCounts();
    if (!open) return;
    paintFeed();
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

  function arrive(): void {
    fresh = new Set(build(Date.now()).items.filter((item) => item.unread).map((item) => item.id));
    land = "new";
  }

  q("[data-read]").addEventListener("click", () => {
    seen[READ_KEY] = Date.now();
    writeSeen(seen);
    fresh = new Set();
    paint();
  });

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

  const tick = () => {
    if (timer !== null) window.clearInterval(timer);
    timer = window.setInterval(paint, SLOW_MS);
  };
  tick();
  paintCounts();

  return {
    open() {
      if (!open) {
        open = true;
        limit = PAGE;
        arrive();
      }
      paint();
    },
    clear() {
      if (!open) return;
      open = false;
      flash = null;
      paintCounts();
    },
    refresh: paint,
    reveal(postId) {
      const id = feed.items.find((item) => holds(item, postId))?.id ?? `post:${postId}`;
      query = "";
      searchEl.value = "";
      flash = id;
      const at = feed.items.findIndex((item) => item.id === id);
      if (at >= 0) limit = Math.max(PAGE, feed.items.length - at);
      land = id;
      if (open) paint();
    },
  };
}
