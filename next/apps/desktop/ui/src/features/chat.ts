/**
 * Reports and Manager — separate sidebar destinations sharing a screen host.
 *
 * It was a narrow column parked beside the work. A 360px rail is the wrong shape for what actually
 * arrives here: reports carry screenshots, replays and code, and every one of them was a thumbnail
 * of a thumbnail. The manager's terminal was worse — an 80-column agent in a sliver. So Chat takes
 * the glass now and hands it back on Esc, and the reading measure is capped in CSS rather than by
 * the width of the window.
 *
 * **Reports** is one flat feed of everything every agent has reported, newest last, read-only. It was
 * a set of channels with a composer, and both halves were wrong. Channels asked you to pick a room
 * before you could see whether anything happened, which is the question the surface exists to
 * answer; and the composer was a second, worse terminal — a text box aimed at a PTY you could not
 * see. You answer an agent in its own terminal now, one click away on the post's byline.
 *
 * **Manager** is a planning agent in a terminal. It used to be a sandboxed Codex subprocess with a
 * hard-coded prompt, a JSON action schema, and a bespoke chat renderer — a whole private channel
 * for one participant. It is an ordinary agent session now, rooted at the ops tree, running
 * whichever CLI you start it with. What shapes it is `ops/AGENTS.md`, editable right here, with the
 * shipped text one button away.
 *
 * What survives from the Inbox, deliberately: the evidence box opens under the post that earned it,
 * bursts group, days rule off, and the unread boundary is drawn rather than silently cleared.
 */

import type { ChangeStep, Payload, Session, SessionKind } from "../types";
import { icon, type IconName } from "../icons";
import { buildPeek, type PeekHandle } from "./inbox_peek";
import { ENGINES } from "./agent-kinds";
import { errorText } from "../errors";
import "./chat.css";

export type ChatSection = "reports" | "manager";

export type ChatPost = {
  id: string;
  project: string;
  projectName: string;
  author: string;
  /** Stable engine identity for the post avatar; the title alone may be "codex 2". */
  agentKind: string;
  /** The session that posted, so the byline is a door back to the agent that wrote it. Null for
   *  a post whose origin Panel could not resolve — the byline then stays plain text. */
  session: string | null;
  /** Files observed changing in this agent turn. They are the evidence behind Play flow. */
  flowFiles: string[];
  /** Agent-supplied, code-referenced flow. Required by the reporting contract for every engine. */
  flowSteps: Payload[];
  at: number;
  /** The renderer this notification asked for. Showcases keep their real projector in chat. */
  view?: "message" | "showcase";
  payload: Payload;
};

export type ChatEvents = {
  /** The post body. `openRef` is handed in so every path, screenshot and line the agent named
   *  resolves in the evidence box below the post instead of throwing you into another screen. */
  render(post: ChatPost, openRef: (ref: string) => void): HTMLElement;
  /** Go to the Runs screen with this project's card lit up. */
  openRuns(project: string): void;
  /** Enter the project AND focus the terminal that posted. This is how you answer an agent. */
  openSession(project: string, session: string): void;
  /** False once a session has exited: its byline stops being a door to a dead terminal. */
  isLiveSession(session: string): boolean;
  /** Total unread, for the sidebar's badge. */
  unread(total: number): void;
  /** Per-project unread, for the project rows and Home's cards. Same numbers, addressed. */
  unreadByProject(counts: Map<string, number>): void;
  /** Every post Panel has, newest last — Home's activity strip reads this. Fired on arrival. */
  archive(posts: ChatPost[]): void;
  /* ---- what the evidence box needs; see inbox_peek.ts for why it lives in the post ---- */
  changes(project: string, path: string): Promise<ChangeStep[]>;
  readFile(project: string, path: string): Promise<string>;
  renderFlow(post: ChatPost, openRef: (ref: string) => void): HTMLElement | null;
  openRef(project: string, ref: string): void;
  /** Notify the shell when visibility or the selected destination changes. */
  visibility(visible: boolean): void;
};

/** What the rail needs from the host to run the manager's terminal. Kept as callbacks rather than
 *  imports so the rail never reaches into the app's session bookkeeping. */
export type CpoEvents = {
  /** Start the manager as a tracked session: it joins the wall, the attention lanes and the
   *  restored wall like any worker. Rejects with the reason it could not start. */
  start(kind: SessionKind): Promise<Session>;
  /** The manager's live session — started here, from the wall, or restored at boot. */
  current(): Session | null;
  /** Show the manager's screen in this pane, and give it back. */
  lend(sessionId: string, cell: HTMLElement): void;
  unlend(): void;
  /** The manager's Dashboard: what it changed in the ops tree this turn. */
  openChanges(): void;
  stop(sessionId: string): Promise<void>;
  /** Type into the manager's terminal. How the Sprint screen hands it a question. */
  write(terminalId: string, data: string): Promise<void>;
  preprompt(): Promise<string>;
  savePreprompt(text: string): Promise<void>;
  resetPreprompt(): Promise<string>;
};

export type ChatHandle = {
  add(post: ChatPost): void;
  /** From Home's activity strip: show Reports and flash this post. */
  reveal(postId: string): void;
  /** Open the named destination. Reports is the default, regardless of the last visit. */
  show(section?: ChatSection): void;
  hide(): void;
  toggle(section?: ChatSection): void;
  isVisible(): boolean;
  currentSection(): ChatSection | null;
  /** Open the rail on the manager. The hotkey and the sidebar button both land here. */
  showCpo(): void;
  /** Open the manager, start it if it is not running, and submit this as its next prompt. */
  seedCpo(prompt: string): Promise<void>;
  /** A session exited somewhere. If it was the manager's, the pane goes back to its start state. */
  noteExit(sessionId: string): void;
};

const make = (tag: string, className?: string, text?: string): HTMLElement => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const time = (at: number): string =>
  new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(at);

const dayStamp = (at: number): string => new Date(at).toDateString();

const dayLabel = (at: number): string => {
  const midnight = (value: number): number => new Date(new Date(value).toDateString()).getTime();
  const days = Math.round((midnight(Date.now()) - midnight(at)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(at);
};

/** Consecutive posts from the same agent inside this window read as one burst: one avatar, one
 *  byline, the rest carrying only a hover timestamp. */
const GROUP_WINDOW = 5 * 60_000;

const agentGlyph = (kind: string): IconName =>
  kind === "codex" || kind === "opencode" ? "code" : kind === "shell" ? "terminal" : "agent";

/** The engine the manager was last started with. It is a preference, not state: the session itself
 *  is gone on restart, but "I run my manager on codex" should survive. */
const CPO_KIND_KEY = "panel-cpo-kind";
/** Only agent engines make sense here — the manager reads and writes Markdown and briefs other
 *  agents, and a bare shell cannot do either. */
const CPO_KINDS: SessionKind[] = ["claude", "codex", "grok"];

const svg = (path: string): string =>
  `<svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;

export function mountChat(host: HTMLElement, events: ChatEvents, cpo: CpoEvents): ChatHandle {
  const posts: ChatPost[] = [];
  const unread = new Map<string, number>();
  // Never on at boot. Panel opens on Home or on a project — a screen you did not ask for is a
  // worse greeting than a rail you did not ask for was.
  let visible = false;
  let section: ChatSection = "reports";
  let query = "";
  /** Set when you ARRIVE. Holding scroll position is right for a repaint of the feed you are
   *  already reading; carrying it into a fresh visit lands you at a meaningless offset. */
  let land = true;
  /** A post to scroll to and flash once this paint lands — see reveal(). */
  let flash: string | null = null;
  /** Nothing that predates this window counts as new — the boundary starts at boot, not at 0. */
  const bootedAt = Date.now();
  let seenAt = bootedAt;
  /** The boundary to DRAW on this visit, kept after the badge clears so "where was I" survives. */
  let dividerAt = 0;

  /* ------------------------------------------------------------------ DOM */

  host.classList.add("chat");
  const head = make("header", "chat-head");
  const heading = make("div", "chat-heading");
  const title = make("h2", "chat-title");
  const description = make("p", "chat-description");
  heading.append(title, description);
  const searchToggle = make("button", "chat-head-tool") as HTMLButtonElement;
  searchToggle.type = "button";
  searchToggle.title = "Search reports";
  searchToggle.setAttribute("aria-label", "Search reports");
  searchToggle.innerHTML = svg('<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>');
  const promptToggle = make("button", "chat-head-tool") as HTMLButtonElement;
  promptToggle.type = "button";
  promptToggle.title = "Edit manager instructions";
  promptToggle.setAttribute("aria-label", "Edit manager instructions");
  promptToggle.innerHTML = svg('<path d="M4 20h16"/><path d="m14 4 6 6-9 9H5v-6z"/>');
  const changesButton = make("button", "chat-head-tool") as HTMLButtonElement;
  changesButton.type = "button";
  changesButton.title = "What the manager changed";
  changesButton.setAttribute("aria-label", "What the manager changed");
  changesButton.innerHTML = svg('<path d="M6 3h9l4 4v14H6z"/><path d="M9 13h6M12 10v6"/>');
  changesButton.addEventListener("click", () => cpo.openChanges());
  const hideButton = make("button", "chat-head-tool") as HTMLButtonElement;
  hideButton.type = "button";
  hideButton.innerHTML = svg('<path d="m6 6 12 12M18 6 6 18"/>');
  head.append(heading, searchToggle, changesButton, promptToggle, hideButton);

  const search = document.createElement("input");
  search.type = "search";
  search.className = "chat-search";
  search.placeholder = "Search every report";
  search.setAttribute("aria-label", "Search every report");
  search.hidden = true;

  const feed = make("div", "chat-feed");

  /** Shown when you have scrolled away from the bottom — see `nearBottom`. */
  const jump = make("button", "inbox-jump") as HTMLButtonElement;
  jump.type = "button";
  jump.hidden = true;
  jump.textContent = "Jump to latest ↓";

  /* -------------------------------------------------------------- the CPO */

  const cpoPane = make("div", "cpo-pane");
  cpoPane.hidden = true;
  const cpoStart = make("div", "cpo-start");
  const cpoTerm = make("div", "cpo-term");
  const cpoEditor = make("form", "cpo-editor");
  cpoEditor.hidden = true;
  const promptBox = document.createElement("textarea");
  promptBox.className = "cpo-editor-box";
  promptBox.spellcheck = false;
  promptBox.setAttribute("aria-label", "Manager instructions");
  const promptBar = make("footer", "cpo-editor-bar");
  const promptSave = make("button", "cpo-editor-save", "Save") as HTMLButtonElement;
  promptSave.type = "submit";
  const promptReset = make("button", "cpo-editor-reset", "Reset to default") as HTMLButtonElement;
  promptReset.type = "button";
  const promptNote = make("span", "cpo-editor-note", "");
  promptBar.append(promptReset, promptNote, promptSave);
  cpoEditor.append(
    make("p", "cpo-editor-lede", "Instructions for new manager sessions."),
    promptBox,
    promptBar,
  );
  cpoPane.append(cpoStart, cpoTerm, cpoEditor);

  host.append(head, search, feed, jump, cpoPane);

  /** The manager's terminal lives in the workspace deck like every other session, so it keeps its
   *  status, its wall seat and its restore. This pane borrows its screen while it is up. */
  let cpoSession: Session | null = cpo.current();
  let starting = false;
  /** Borrow the manager's screen into this pane — only while the pane is what you are looking at. */
  const lendCpo = (): void => {
    cpoSession = cpo.current();
    if (cpoSession && visible && section === "manager") {
      cpo.lend(cpoSession.id, cpoTerm);
    }
  };
  /** Why the last start failed. Painted with the card, so a repaint cannot wipe it. */
  let startError = "";

  const paintCpoStart = (): void => {
    cpoStart.replaceChildren();
    cpoStart.hidden = Boolean(cpoSession);
    cpoTerm.hidden = !cpoSession;
    if (cpoSession) return;
    cpoStart.append(make("i", undefined, "APPGEA"));
    cpoStart.append(make("h3", undefined, "Start your manager"));
    cpoStart.append(
      make(
        "p",
        undefined,
        "Choose an agent to plan work and maintain your notes.",
      ),
    );
    const row = make("div", "cpo-start-kinds");
    const preferred = localStorage.getItem(CPO_KIND_KEY) as SessionKind | null;
    for (const kind of CPO_KINDS) {
      const name = ENGINES.find((engine) => engine.kind === kind)?.name ?? kind;
      const button = make("button", "cpo-start-kind", `Start ${name}`) as HTMLButtonElement;
      button.type = "button";
      button.disabled = starting;
      if (kind === (preferred ?? "claude")) button.classList.add("is-preferred");
      button.addEventListener("click", () => void startCpo(kind));
      row.append(button);
    }
    cpoStart.append(row);
    if (startError) cpoStart.append(make("p", "cpo-start-error", startError));
  };

  const startCpo = async (kind: SessionKind): Promise<void> => {
    if (cpoSession || starting) return;
    starting = true;
    startError = "";
    paintCpoStart();
    try {
      cpoSession = await cpo.start(kind);
      localStorage.setItem(CPO_KIND_KEY, kind);
      paintCpoStart();
      lendCpo();
    } catch (error) {
      startError = errorText(error, "The manager could not start. Try again.");
    } finally {
      starting = false;
      if (!cpoSession) paintCpoStart();
    }
  };

  /** The manager's terminal died — by exit, by ⌘W, by a crash. Fall back to the start state rather
   *  than leaving a frozen pane that looks alive. */
  function endCpo(): void {
    if (!cpoSession) return;
    cpo.unlend();
    cpoSession = null;
    paintCpoStart();
  }

  /* --------------------------------------------------------- the preprompt */

  let promptLoaded = false;
  const say = (text: string): void => {
    promptNote.textContent = text;
    if (!text) return;
    window.setTimeout(() => {
      if (promptNote.textContent === text) promptNote.textContent = "";
    }, 2400);
  };

  const openEditor = async (): Promise<void> => {
    cpoEditor.hidden = false;
    promptToggle.classList.add("is-on");
    if (!promptLoaded) {
      promptBox.value = "loading…";
      try {
        promptBox.value = await cpo.preprompt();
        promptLoaded = true;
      } catch (error) {
        promptBox.value = "";
        say(String(error));
      }
    }
    promptBox.focus();
  };

  const closeEditor = (): void => {
    cpoEditor.hidden = true;
    promptToggle.classList.remove("is-on");
  };

  cpoEditor.addEventListener("submit", (event) => {
    event.preventDefault();
    void cpo
      .savePreprompt(promptBox.value)
      // The running session read the old text at launch, so saying "saved" alone would imply a
      // change that has not reached the agent you are looking at.
      .then(() => say(cpoSession ? "Saved — restart the manager to apply" : "Saved"))
      .catch((error: unknown) => say(String(error)));
  });

  promptReset.addEventListener("click", () => {
    void cpo
      .resetPreprompt()
      .then((text) => {
        promptBox.value = text;
        promptLoaded = true;
        say(cpoSession ? "Restored — restart the manager to apply" : "Restored");
      })
      .catch((error: unknown) => say(String(error)));
  });

  promptToggle.addEventListener("click", () => {
    if (cpoEditor.hidden) void openEditor();
    else closeEditor();
  });

  /* -------------------------------------------------------------- plumbing */

  /** Within a screen-ish of the end, "new report arrived" means "show me". Further up it means
   *  "do not move" — being yanked to the bottom mid-paragraph is the classic feed sin. */
  const nearBottom = (): boolean => feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120;
  const paintJump = (): void => {
    jump.hidden = section !== "reports" || nearBottom();
  };
  const toBottom = (): void => {
    feed.scrollTop = feed.scrollHeight;
    paintJump();
  };
  feed.addEventListener("scroll", paintJump, { passive: true });
  jump.addEventListener("click", () => toBottom());

  /** Everything the agent wrote, flattened once per post so search looks at all of it. */
  const haystack = new WeakMap<ChatPost, string>();
  const searchable = (post: ChatPost): string => {
    const cached = haystack.get(post);
    if (cached !== undefined) return cached;
    const text = `${post.author} ${post.projectName} ${JSON.stringify(post.payload)}`.toLowerCase();
    haystack.set(post, text);
    return text;
  };
  const matches = (post: ChatPost): boolean => !query || searchable(post).includes(query);

  /** One evidence box per post, kept across repaints — a feed that rebuilds must not slam the
   *  drawer you were reading, or close a replay mid-show. Built on first use only. */
  const peeks = new Map<string, PeekHandle>();

  /** Where this post's turn starts: the previous report from the same agent. */
  const since = (post: ChatPost): number => {
    const prior = posts.filter(
      (other) => other.session && other.session === post.session && other.at < post.at,
    );
    return prior.at(-1)?.at ?? 0;
  };

  const peekFor = (post: ChatPost): PeekHandle => {
    const existing = peeks.get(post.id);
    if (existing) return existing;
    const built = buildPeek(post, {
      changes: (project, path) => events.changes(project, path),
      readFile: (project, path) => events.readFile(project, path),
      flow: (target, openRef) => events.renderFlow(target, openRef),
      openRef: (project, ref) => events.openRef(project, ref),
      since,
    });
    peeks.set(post.id, built);
    return built;
  };

  const unreadTotal = (): number => [...unread.values()].reduce((sum, value) => sum + value, 0);
  const notifyUnread = (): void => {
    events.unread(unreadTotal());
    events.unreadByProject(new Map(unread));
  };

  /**
   * Clearing the badge and losing the answer to "which of these had I not seen" used to be the
   * same act. The count still clears — you are looking at the thing it notified you about — but
   * the boundary is kept and the feed draws a line on it.
   */
  const markRead = (): void => {
    if (!visible || section !== "reports") return;
    dividerAt = seenAt;
    seenAt = Date.now();
    unread.clear();
    notifyUnread();
  };

  /* ----------------------------------------------------------------- rows */

  /** One post row: a 28px gutter carrying the avatar (or, inside a burst, a hover timestamp) and a
   *  body that runs the width of the rail. `head` is null on a grouped row. */
  let lastKey = "";
  let lastAt = 0;
  let lastDay = "";
  /** The unread boundary for this visit. Drawn once, above the first row past it, then cleared. */
  let newLine = 0;
  const row = (at: number, key: string) => {
    const day = dayStamp(at);
    if (day !== lastDay) {
      const rule = make("div", "msg-day");
      rule.append(make("span", undefined, dayLabel(at)));
      feed.append(rule);
      lastDay = day;
      lastKey = "";
    }
    if (newLine && at > newLine) {
      const rule = make("div", "msg-day is-new");
      rule.append(make("span", undefined, "New"));
      feed.append(rule);
      newLine = 0;
      lastKey = ""; // a burst does not survive being cut in half by the line
    }
    const grouped = key === lastKey && at - lastAt < GROUP_WINDOW;
    lastKey = key;
    lastAt = at;
    const article = make("article", `msg${grouped ? " is-grouped" : ""}`);
    article.dataset.at = String(at);
    const rail = make("div", "msg-rail");
    const main = make("div", "msg-main");
    article.append(rail, main);
    rail.append(make("time", "msg-railtime", time(at)));
    const header = make("header", "msg-head");
    main.append(header);
    feed.append(article);
    return { article, rail, main, head: header };
  };

  const appendPost = (post: ChatPost): void => {
    const session = post.session;
    const live = Boolean(session && events.isLiveSession(session));
    // The burst key carries the project: two agents reporting a minute apart from different apps
    // are two voices, and merging them would hide which app you are reading about.
    const { article, rail, main, head: header } = row(
      post.at,
      `agent:${post.project}:${post.session ?? post.author}`,
    );
    article.dataset.post = post.id;
    if (post.id === flash) {
      article.classList.add("is-flash");
      // Cleared after the frame so a later repaint does not re-flash a post you have read.
      window.setTimeout(() => article.classList.remove("is-flash"), 1600);
    }
    const avatar = make("span", "msg-avatar");
    avatar.dataset.agent = post.agentKind;
    avatar.innerHTML = icon(agentGlyph(post.agentKind));
    avatar.title = post.agentKind;
    rail.append(avatar);
    // One feed for every project means the project IS the headline. It leads the byline, and
    // it is the door: a post you cannot place is a post you cannot act on.
    const where = make("button", "msg-where", post.projectName) as HTMLButtonElement;
    where.type = "button";
    where.title = `Show ${post.projectName} on the Runs screen`;
    where.addEventListener("click", () => events.openRuns(post.project));
    header.append(where);
    // The byline names the agent — "claude 2" — and is the door to that exact terminal, which
    // is now the ONLY way to answer it. A session that has exited keeps the name, loses the door.
    if (session && live) {
      const authorButton = make("button", "msg-author is-live", post.author);
      (authorButton as HTMLButtonElement).type = "button";
      authorButton.title = `Open ${post.author} on ${post.projectName}`;
      authorButton.addEventListener("click", () => events.openSession(post.project, session));
      header.append(authorButton);
    } else header.append(make("b", "msg-author", post.author));
    header.append(make("time", undefined, time(post.at)));
    // A box created after this paint (first click on a ref) still has to reach the DOM, and it
    // belongs to THIS row — the one the human is looking at, not the one it was born under.
    const openPeek = (): PeekHandle => {
      const peek = peekFor(post);
      if (peek.root.parentElement !== main) main.append(peek.root);
      return peek;
    };
    // Refs inside the body — screenshots, paths, the files it names — land in this post's box.
    const body = events.render(post, (ref) => openPeek().showRef(ref));
    body.classList.add("in-feed");
    main.append(body);
    if (post.flowSteps.length || post.flowFiles.length) {
      const flowCount = post.flowFiles.length || post.flowSteps.length;
      const flowUnit = post.flowFiles.length ? "file" : "step";
      const flow = make("button", "inbox-flow") as HTMLButtonElement;
      flow.type = "button";
      flow.innerHTML = `${icon("play")}<span>See what changed · ${flowCount} ${flowUnit}${flowCount === 1 ? "" : "s"}</span>`;
      flow.title = "Replay the captured edits here";
      flow.addEventListener("click", () => {
        const peek = openPeek();
        peek.toggle();
        flow.classList.toggle("is-on", peek.isOpen());
      });
      const actions = make("footer", "msg-actions");
      actions.append(flow);
      main.append(actions);
    }
    // Answering happens in the agent's own terminal, so the row's one tool is the door to it.
    if (session && live) {
      const bar = make("div", "msg-tools");
      const open = make("button", "msg-tool") as HTMLButtonElement;
      open.type = "button";
      open.innerHTML = `${icon("terminal")}<span>Answer in terminal</span>`;
      open.title = `Open ${post.author} on ${post.projectName}`;
      open.addEventListener("click", () => events.openSession(post.project, session));
      bar.append(open);
      article.append(bar);
    }
    // A box built earlier keeps its state (and its running replay) across repaints.
    const peek = peeks.get(post.id);
    if (peek) main.append(peek.root);
  };

  const removePostRow = (post: ChatPost): number => {
    const before = feed.scrollHeight;
    feed.querySelector<HTMLElement>(`[data-post="${CSS.escape(post.id)}"]`)?.remove();
    const first = feed.querySelector<HTMLElement>(".msg");
    if (first) {
      first.classList.remove("is-grouped");
      const wantedDay = dayLabel(Number(first.dataset.at));
      let node = feed.firstElementChild;
      while (node && node !== first) {
        const next = node.nextElementSibling;
        if (node.matches(".msg-day:not(.is-new)") && node.textContent !== wantedDay) node.remove();
        node = next;
      }
    }
    return Math.max(0, before - feed.scrollHeight);
  };

  const appendLivePost = (post: ChatPost, dropped?: ChatPost): void => {
    if (query || feed.querySelector(".inbox-empty")) {
      paintFeed();
      return;
    }
    const stick = nearBottom();
    const wasAt = feed.scrollTop;
    const removedHeight = dropped ? removePostRow(dropped) : 0;
    appendPost(post);
    requestAnimationFrame(() => {
      if (stick) toBottom();
      else {
        feed.scrollTop = Math.max(0, wasAt - removedHeight);
        paintJump();
      }
    });
  };

  const paintFeed = (): void => {
    lastKey = "";
    lastAt = 0;
    lastDay = "";
    newLine = dividerAt;
    // Captured before the rebuild: whether you were reading the bottom, and where you were if not.
    const stick = land || !feed.childElementCount || nearBottom();
    const wasAt = feed.scrollTop;
    land = false;

    const list = posts.filter(matches);
    feed.replaceChildren();

    if (!list.length) {
      const empty = make("div", "inbox-empty");
      if (query) {
        empty.append(make("i", undefined, "◇"), make("b", undefined, "Nothing matches"));
        empty.append(make("p", undefined, `No report mentions “${query}”.`));
      } else {
        empty.append(make("i", undefined, "◇"), make("b", undefined, "No reports yet"));
        empty.append(make("p", undefined, "Updates appear here when your project agents report back."));
      }
      feed.append(empty);
      paintJump();
      return;
    }

    for (const post of list) appendPost(post);

    const wanted = flash;
    flash = null;
    requestAnimationFrame(() => {
      if (wanted) {
        const node = feed.querySelector<HTMLElement>(`[data-post="${CSS.escape(wanted)}"]`);
        if (node) {
          node.scrollIntoView({ block: "center", behavior: "smooth" });
          paintJump();
          return;
        }
      }
      if (stick) toBottom();
      else {
        feed.scrollTop = wasAt;
        paintJump();
      }
    });
  };

  /* --------------------------------------------------------- destinations */

  const paintSection = (): void => {
    const reports = section === "reports";
    title.textContent = reports ? "Reports" : "Manager";
    description.textContent = reports
      ? "Agent updates from every project. Reply in the agent's terminal."
      : "Plan work and brief your agents.";
    // Esc belongs to the manager's agent while you are typing to it, so ⌘W is the key that always closes.
    hideButton.title = `Close ${section} (${reports ? "Esc" : "⌘W"})`;
    hideButton.setAttribute("aria-label", `Close ${section}`);
    searchToggle.hidden = !reports;
    promptToggle.hidden = reports;
    changesButton.hidden = reports;
    feed.hidden = !reports;
    cpoPane.hidden = reports;
    search.hidden = !reports || !searchToggle.classList.contains("is-on");
    paintJump();
  };

  const paint = (): void => {
    paintSection();
    if (section === "reports") paintFeed();
  };

  /* --------------------------------------------------------------- search */

  let searchTimer = 0;
  searchToggle.addEventListener("click", () => {
    search.hidden = !search.hidden;
    searchToggle.classList.toggle("is-on", !search.hidden);
    if (search.hidden) {
      search.value = "";
      query = "";
      land = true;
      paintFeed();
    } else search.focus();
  });
  search.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      query = search.value.trim().toLowerCase();
      land = true;
      paintFeed();
    }, 120);
  });
  search.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    search.value = "";
    query = "";
    search.hidden = true;
    searchToggle.classList.remove("is-on");
    land = true;
    paintFeed();
  });

  /* ---------------------------------------------------------------- state */

  /** The class is what CSS reads; the callback is what the shell reads. Both say the same thing,
   *  and the shell is the one that decides which screen goes back on the glass. */
  const applyVisible = (): void => {
    document.documentElement.classList.toggle("chat-hidden", !visible);
    events.visibility(visible);
  };

  hideButton.addEventListener("click", () => handle.hide());

  const handle: ChatHandle = {
    add(post) {
      posts.push(post);
      // The evidence box outlives its post otherwise: `peeks` is keyed by post id and nothing
      // ever dropped the entry for a post that fell off the end of the feed.
      const dropped = posts.length > 200 ? posts.shift() : undefined;
      if (dropped) peeks.delete(dropped.id);
      if (visible && section === "reports") {
        // Watched it land — it is not waiting for you on the next visit.
        seenAt = post.at;
      } else {
        unread.set(post.project, (unread.get(post.project) ?? 0) + 1);
      }
      notifyUnread();
      events.archive([...posts]);
      if (visible && section === "reports") appendLivePost(post, dropped);
      paintSection();
    },

    reveal(postId) {
      if (!posts.some((candidate) => candidate.id === postId)) return;
      window.clearTimeout(searchTimer);
      query = "";
      search.value = "";
      flash = postId;
      handle.show("reports");
    },

    show(next = "reports") {
      const entering = !visible || section !== next;
      // Select the destination before marking anything read or notifying navigation.
      section = next;
      visible = true;
      if (entering) {
        land = true;
        markRead();
      }
      if (section === "manager") {
        // Started from the wall, restored at boot or ended elsewhere: ask, never assume.
        cpoSession = cpo.current();
        paintCpoStart();
      } else {
        cpo.unlend();
      }
      paint();
      if (entering) applyVisible();
      if (section === "manager") requestAnimationFrame(() => {
        if (visible && section === "manager") lendCpo();
      });
    },

    hide() {
      if (!visible) return;
      visible = false;
      cpo.unlend();
      applyVisible();
    },

    toggle(next = "reports") {
      if (visible && section === next) handle.hide();
      else handle.show(next);
    },

    isVisible: () => visible,
    currentSection: () => visible ? section : null,

    async seedCpo(prompt) {
      this.showCpo();
      if (!cpoSession) {
        const preferred = (localStorage.getItem(CPO_KIND_KEY) as SessionKind | null) ?? "claude";
        await startCpo(preferred);
      }
      if (!cpoSession) return;
      await cpo.write(cpoSession.terminal_id, `${prompt}\r`);
      lendCpo();
    },
    showCpo() {
      handle.show("manager");
    },

    noteExit(sessionId) {
      if (cpoSession?.id === sessionId) endCpo();
    },
  };

  paintCpoStart();
  markRead();
  paint();
  return handle;
}
