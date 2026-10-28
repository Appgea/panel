/**
 * Workspace — the portfolio's work screen. Inbox, Runs, and every live PTY across the
 * portfolio live in a single tab strip. Home is the one portfolio surface that keeps a screen of
 * its own: it is where you look at the estate, not where you work in it.
 *
 * The strip is: **pinned** tabs first (Inbox, then Runs — modules that hand us their element
 * and their open/clear, see PinnedPane), then the terminal tabs. Each terminal tab is its own
 * named subset of sessions with its own ＋ seat, so the portfolio can be split however you
 * like. A session joins whichever terminal tab is active the moment it's born, and moves to any
 * other tab by dragging its head onto that tab (or via the tile's ⇄ menu).
 *
 * A tab is never closed out from under running terminals: while it holds any, it shows their
 * count instead of a ×, and it retires ITSELF the moment its last one is closed or moved away.
 * The × is the empty case only — a fresh tab you asked for and no longer want.
 *
 * The strip IS the ⌘-digit ladder, one for one: ⌘1 Inbox, ⌘2 Runs, ⌘3 the first terminal tab,
 * on to ⌘9. That is the only digit chord in Panel — the old ⌥1…⌥9 tab jump is gone. Home owns
 * no digit: it is not in the strip, so there is nothing for a chord to index.
 *
 * Within a terminal tab, the wall fills the screen and splits it evenly: every tile is a
 * live terminal, and the LAST cell is the ＋ seat. With nothing else running it stays open —
 * listing projects by recency until you pick one and offering the three engines.
 * Once the tab has a terminal, the seat collapses to a small add button and only expands
 * back to the picker on request, so it doesn't hog a cell forever.
 *
 * Keyboard, while the workspace is up — every chord comes from keymap.ts and every one of them
 * is rebindable in Settings (⌘,), so these are defaults, not law:
 *
 *   ⌘N new terminal · ⌘T new tab · ⌘⇧[ / ⌘⇧] walk the strip
 *   ⌃Tab / ⌃⇧Tab walk this tab's terminals in join order
 *   ⌘⌥←↑→↓ move the caret to the nearest tile in that direction · ⌘↩ zoom it · Esc leaves zoom
 *   ^F does the same as ⌘↩ — the key that fullscreens a terminal on a project screen, which
 *     used to be dead on the one screen made entirely of terminals
 *   ⌘⌥1…9 send the focused terminal to that tab of the strip · ⌘⌥T to a tab of its own
 *   ⌃⌘1…9 go to that terminal of this tab · ⌘⇧L flip between the two layouts
 *   ⌘⇧A the next agent waiting on you, in any tab
 *
 * Two layouts, chosen in Settings or with ⌘⇧L. GRID is the wall above. TABS keeps the strip as
 * the top row, the containers, and adds a second row with one tab per terminal of the active
 * container. Only that terminal is on screen, at full size. The ⌘⌥ arrows move over the two rows
 * like a grid: ←/→ walk the terminal tabs, ↑/↓ walk the top tabs. The second row is where you
 * work, so it gets the ⌘ chords: ⌘⇧[ ] walks it and ⌘1…9 jumps in it. The top row trades them
 * for the terminal chords: ⌃Tab walks it and ⌃⌘1…9 jumps in it. Everything else means the same
 * in both.
 *
 * An agent's report arrives as a NOTICE lying over the top of the wall — the agent's words and
 * its pictures, at a size you can read, taking no seat in the grid. Tap its head to fold it
 * away (Esc does the same), tap a picture to fill the screen with it (←/→ walks the set, Esc
 * closes). Nothing in a notice navigates: you are looking at it, not going somewhere.
 *
 * Off macOS, new-terminal and new-shell chords use Ctrl+N/T; Ctrl+Shift+T creates a tab.
 *
 * A sim run is still not a terminal you work in: the Runs pane keeps its own verbs
 * (run / reload / rebuild / stop) and its PTY never joins the deck or the wall. Merging put
 * it one keystroke away, not into the grid.
 *
 * It owns nothing it shows. The deck lends each pane's mount div to a tile (adopt); Inbox and
 * Runs lend their whole element. All of it goes back on clear().
 */

import { MAIN_ID, type Session } from "../types";
import type { LiveRun, ProjectRunView } from "./runner";
import { icon, type IconName } from "../icons";
import { ENGINES, type SessionKind } from "./agent-kinds";
import { projectImage, projectIconUrl } from "../project-assets";
import { prose } from "../views/dom";
import { isLightboxOpen, showLightbox, type LightboxShot } from "../views/lightbox";
import { IS_MAC, KEYMAP_EVENT, chordLabel, chordOf, digitOf, label as chordText, matches } from "./keymap";
import { COLS, COLS_KEY, PREF, PREFS_EVENT, setTermLayout, termLayout } from "./settings";
import { formatBytes } from "./terminal";
import "./terminals.css";

export type { SessionKind };

/** What a tile's state dot says. See TerminalsEvents.phaseOf. */
export type TilePhase = "work" | "ask" | "idle";

export type TerminalsProject = {
  id: string;
  name: string;
  exists: boolean;
  /** Which company owns it. Empty for a project in no group. The strip keeps one tab per group
   *  that has projects, and a terminal born on this project goes to that tab. */
  group: string;
  /** The project folder. The tabs layout compares a terminal's folder with it, so a shell
   *  standing in the root is not labelled with the project's own name twice. */
  path?: string;
  running: boolean;
  /** Last time real work happened here. The launcher sorts the idle list by this. */
  lastActive?: number;
  sessions: Session[];
};

/**
 * A screen that gave up being a screen: it keeps its own element and its own open/clear, and
 * the strip borrows it as a fixed tab. Inbox and Runs are the two. They sit before every
 * terminal tab and never move, so the first two shortcuts mean the same thing for good.
 */
export type PinnedPane = {
  /** Tab label. */
  name: string;
  /** icons.ts key for the tab glyph. */
  glyph: IconName;
  /** The element to borrow into the strip. It is returned to its own parent on clear(). */
  pane(): HTMLElement;
  /** This tab came up — wire to the module's open(). */
  show(): void;
  /** This tab went away, or the workspace closed — wire to the module's clear(). */
  hide(): void;
  /** ⌘W while this tab is up. False means "nothing of mine to close". */
  closeActive(): boolean;
  /** This tab IS the runs screen. The build bar stands down over it — the same run said twice,
   *  once in a strip and once in full, reads as two runs. */
  ownsRuns?: boolean;
};

export type TerminalsEvents = {
  /** The fixed tabs, in strip order, before any terminal tab. */
  pinned: PinnedPane[];

  /** The portfolio's companies, in config order. A getter rather than a value: the strip is
   *  mounted before the list is read off disk. Absent or empty means one company, and then the
   *  strip has no group tabs at all. */
  groups?(): Array<{ id: string; name: string }>;

  /** Start a session on ANY project. Resolves to the new session, or null on failure.
   *  `cwd` overrides the folder it forks in — that is how "another shell here" carries the
   *  folder the terminal you pressed it in was standing in. */
  start(projectId: string, kind: SessionKind, cwd?: string): Promise<Session | null>;
  /** Where this session's process is standing right now, asked of the OS. Null when unknowable
   *  (dead pid, unsupported platform) — the caller then settles for the project root. */
  cwdOf?(sessionId: string): Promise<string | null>;
  /** Why the most recent start() returned null — shown in the ＋ pane on a failed launch. */
  lastError?(): string;
  /** Lend a live pane into a tile body (wired to deck.adopt). */
  adopt(sessionId: string, cell: HTMLElement): void;
  /** Take every pane back under the deck, hidden, without leaving the overview (deck.parkAll).
   *  Called before a wall rebuild so off-page panes survive replaceChildren(). */
  park(): void;
  /** Re-fit every adopted pane (wired to deck.fitAdopted). */
  refit(): void;
  /** Put the caret in one pane (wired to deck.focusSession). */
  focusPane(sessionId: string): void;
  /** Jump into the project with this session's screen up. */
  jump(projectId: string, sessionId: string): void;
  /** Close one session for good (confirmation lives with the caller). */
  close(projectId: string, sessionId: string): void;
  isExited(sessionId: string): boolean;
  skills?(sessionId: string): void;
  /**
   * Where this session's turn stands: "work" is moving, "ask" has stopped and wants you, "idle"
   * is a quiet prompt. The OS cannot answer this — an agent waiting on the model has forked
   * nothing and looks exactly like an empty shell — so it comes from the agent's own status
   * events. A shell never reports one and is always idle.
   *
   * Optional: a host that does not track turns leaves every tile quiet, which is honest.
   */
  phaseOf?(sessionId: string): TilePhase;

  /* --- memory. Every agent stays alive while you look elsewhere, so a day leaves a pile. --- */

  /** What a session and the processes under it hold, and whether it can be put to sleep. Null
   *  before the first reading, and for a session with no process. */
  memoryOf?(sessionId: string): { bytes: number | null; canSleep: boolean } | null;
  /** Ended to free memory, and waiting to be woken. Asleep sessions are also exited. */
  isAsleep?(sessionId: string): boolean;
  /** Put these to sleep. */
  sleep?(sessionIds: string[]): void;
  /** The agents "Sleep idle" would put to sleep right now. */
  sleepable?(): string[];

  /* --- the run bar. Active and failed runs remain reachable from every terminal. --- */

  /** ⌘R, and the bar's own Run button: build and launch this project on a simulator. */
  runApp(projectId: string): void;
  runView(projectId: string): ProjectRunView | null;
  runTargetPicker(projectId: string): HTMLElement;
  /** "r" hot reload / "R" hot restart on one exact run. */
  runNudge(sessionId: string, restart: boolean): void;
  runStop(sessionId: string): void;
  runRetry(sessionId: string): void;
  runDismiss(sessionId: string): void;
  runExtra(projectId: string): void;
  /** Open the Runs tab pointed at this app — where the output and the slot decisions live. */
  runOpen(projectId: string): void;
};

/**
 * A report an agent just sent, shown as a NOTICE over the terminals — not as a cell among them.
 *
 * It used to be a tile in the grid: a peer of the terminals, same size, same zoom, same close.
 * That kept the wall honest and paid for it twice. Nine terminals became eight to make room for
 * a picture, and the picture was then a 300px cell you had to hunt 12px buttons inside — one of
 * which navigated away, so the usual gesture on a report was "leave the wall I was watching".
 *
 * A notice takes no seat. It lies over the top of the wall, as tall as its own contents, and
 * folds away when you are done with it. Everything the report said is IN it — the agent's words
 * and its pictures at a readable size — so there is nothing to go and look up. The only two
 * gestures are: tap the head to fold, tap a picture to fill the screen. Nothing navigates. The
 * Inbox still keeps the durable copy, so dismissing costs a view of the message, never the
 * message.
 *
 * It rides the tab that holds the terminal that produced it, because "which agent said this" is
 * the first thing you ask and the byline plus the position answer it without a word.
 */
export type VisualNotice = {
  /** Stable id — re-showing the same id replaces the notice in place instead of stacking. */
  id: string;
  project: string;
  projectName: string;
  /** The session that produced it, or null when Panel could not resolve one. */
  session: string | null;
  /** Who is talking, as the wall knows them ("cpo", "claude"). Empty falls back to the project. */
  author: string;
  title: string;
  /** The agent's own explanation, shown here in full. That is the whole point of a notice. */
  text: string;
  /** progress | done | blocked | needs_decision, when the report typed itself. Else empty. */
  outcome: string;
  /** Real image files, in the order the agent listed them. */
  shots: Array<{ path: string; caption: string }>;
};

export type TerminalsHandle = {
  /** `at` is a strip index: the pinned tabs first, then the terminal tabs. Out of range
   *  keeps whichever tab was last up. */
  open(projects: TerminalsProject[], at?: number): void;
  /** Post an agent's report over the wall that holds its terminal. No-op while closed — the
   *  Inbox holds it either way, so there is nothing to queue. */
  showVisual(notice: VisualNotice): void;
  /** Live refresh. Rebuilds the wall only when the session set changed. */
  sync(projects: TerminalsProject[]): void;
  clear(): void;
  isOpen(): boolean;
  /** Jump to a strip index while already open. False when there is no such tab. */
  select(at: number): boolean;
  /** How many tabs the strip has, pinned included — the ⌘-digit ladder's upper bound. */
  count(): number;
  /** ⌘1…9 while the tabs layout's second row is up: show that terminal of the row. False when
   *  there is no such row, and the digit belongs to the strip. */
  digit(at: number): boolean;
  /** Which pinned tab is up, or null while a terminal tab is. */
  pinnedAt(): number | null;
  /** Close an empty active tab, otherwise the focused terminal (or first visible tile). */
  closeActive(): boolean;
  /** Which project the keyboard is aimed at — the project of the focused terminal. Null on a
   *  pinned tab or an empty wall. ⌘R reads this to know whose app to run. */
  focusedProject(): string | null;
  /** The terminal the keyboard is aimed at. Null on a pinned tab or an empty wall. */
  focusedSession(): string | null;
  /** Bring a terminal up: switch to the tab that holds it, then show it. False when no tab does. */
  reveal(sessionId: string): boolean;
  /** Hand the build bar its truth. Called on every run-state change, open or not. */
  setRuns(runs: LiveRun[]): void;
  /** A project changed company. Move its terminals to the new company's tab, so the strip is not
   *  left saying something that stopped being true. Takes the FRESH project list, because the
   *  group it must file under is the one that just changed. Works closed as well as open. */
  refile(projects: TerminalsProject[], projectId: string): void;
  /** New memory readings arrived. Repaints the figures in place; nothing is rebuilt. */
  paintMemory(): void;
};

/** A tab is just a named subset of sessions — its own wall, its own ＋ seat. Freely
 *  addable/renamable; a session lands in whichever tab is active when it's born, and can be
 *  moved to any other tab afterwards. A tab is never closed out from under live terminals:
 *  it closes ITSELF once its last one is gone. */
type Tab = {
  id: string;
  name: string;
  /**
   * The group this tab BELONGS to, or empty for a tab you made yourself.
   *
   * A group tab is a fixture: the strip keeps one per company that has projects, it survives
   * going empty, and a terminal born on one of that company's projects lands in it. A hand-made
   * tab has no group and is governed by nothing — you made it, you decide what goes in it.
   */
  group: string;
  sessionIds: Set<string>;
  /** Reports posted over this tab's wall, oldest first. Capped — see NOTICES_PER_TAB. */
  noticeIds: string[];
  /** Whether this tab's ＋ pane is expanded to the picker, or collapsed to the add button. */
  plusOpen: boolean;
  /** This tab has held a terminal at some point. It is what separates "emptied — its work is
   *  over, sweep it" from "fresh ⌘N tab — that empty wall is the picker you just asked for". */
  hadSession: boolean;
  /** The terminal the caret was in when you last left this tab. Focus is per-tab or it is not
   *  focus: coming back to a tab and having to hunt for the pane you were typing in is the
   *  whole complaint. A stale id costs nothing — aimed() falls back to the first tile. */
  focused: string | null;
};

/** One cell of the wall. Every cell is a live terminal now — reports lie over the grid instead
 *  of standing in it, so paging, zoom and the rebuild key are back to speaking session ids. */
type Cell = { p: TerminalsProject; session: Session };

/** One dashboard's worth of cells. More than this and the wall grows page tabs. */
const PAGE_SIZE = 9;

/** A wall is for work. Reports are guests over it: the newest few, then the oldest is swept.
 *  Nothing is lost — Inbox is the archive, this is the glance. */
const NOTICES_PER_TAB = 3;

/** The wall's digit ladder, and the strip is all of it: tab 1 is ⌘1. It stops at ⌘9 —
 *  past that a tab is reachable by click and Ctrl+Tab only, and claims no chord. On a project
 *  the same digits are Work's file slots (main.ts). */
const chordFor = (stripIndex: number): string =>
  stripIndex <= 8 ? `${IS_MAC ? "⌘" : "Ctrl+"}${stripIndex + 1}` : "";

const make = (tag: string, className: string): HTMLElement => {
  const node = document.createElement(tag);
  node.className = className;
  return node;
};

export function mountTerminals(host: HTMLElement, events: TerminalsEvents): TerminalsHandle {
  let openState = false;
  /** Flattened session-id set currently on the wall — the cheap "did the grid change?" test. */
  let renderedKey = "";
  let observer: ResizeObserver | null = null;
  let refitQueued = false;
  /** The session just launched from the ＋ pane — its tile enters the wall glowing. */
  let bornSession: string | null = null;
  let snapshot: TerminalsProject[] = [];
  /** The ＋ pane's chosen project while the engine row is up. */
  let plusPicked: string | null = null;
  /** What has been typed into the ＋ pane's search. */
  let plusQuery = "";
  /** Which match the ＋ pane's list has highlighted — where ↩ would go. */
  let plusIndex = 0;
  /** The next ＋ pane to be painted should take the caret: someone asked for this picker. */
  let plusFocus = false;
  let launching = false;
  /** Which dashboard page is up. Sessions fill pages of PAGE_SIZE; the ＋ pane sits last. */
  let page = 0;
  /** Session expanded to fill the whole wall, or null when the grid is even. */
  let zoomed: string | null = null;
  /** Where Ctrl+Tab last left the caret — also the tile the wall draws a ring around, so
   *  you can see which terminal you are typing into without hunting for the cursor. */
  let focusedSession: string | null = null;
  /** One tab exists to start with; the user grows the set from there. */
  let nextTabId = 1;
  /** Every report currently over any wall, by id. The tabs hold ids; this holds the notices. */
  const notices = new Map<string, VisualNotice>();
  /** Which notices are unfolded. A report arrives open — that is what being notified means —
   *  and any older one folds to its head so the band over the wall stays one report tall. */
  const unfolded = new Set<string>();
  const newTab = (name: string, group = ""): Tab => ({
    id: `tab-${nextTabId++}`,
    name,
    group,
    sessionIds: new Set(),
    noticeIds: [],
    // Seat starts collapsed: an empty tab still shows the picker via `alone`, but the
    // first terminal (however it arrives) gets the whole wall — a new one is on demand
    // via the header ＋ button, never a permanent half-cell beside a lone terminal.
    plusOpen: false,
    hadSession: false,
    focused: null,
  });
  /*
   * The tab layout, across a restart.
   *
   * Rust brings the terminals back with their ORIGINAL session ids, which is the only reason this
   * can work: a tab is a set of session ids, so restoring the sets restores the wall. Without it
   * six terminals come back in one heap on Tab 1, which is the layout you spent the last session
   * arranging, thrown away.
   *
   * Names and split are all that is kept. Which tab was up, what was zoomed, which report was
   * open — those are where you were, not what you had, and they are supposed to reset.
   */
  const TABS_KEY = "panel-term-tabs";
  /** Last value written. The save hooks sit on hot paths (every strip paint, every wall build),
   *  and localStorage is a synchronous write — so an unchanged layout must cost nothing. */
  let savedTabsJson = "";
  const saveTabs = (): void => {
    const next = JSON.stringify(
      tabs.map((tab) => ({
        id: tab.id,
        name: tab.name,
        group: tab.group,
        sessions: [...tab.sessionIds],
      })),
    );
    if (next === savedTabsJson) return;
    savedTabsJson = next;
    try {
      localStorage.setItem(TABS_KEY, next);
    } catch {
      /* storage disabled — the layout still holds for this run */
    }
  };
  const loadTabs = (): Tab[] => {
    try {
      const raw = JSON.parse(localStorage.getItem(TABS_KEY) ?? "[]") as Array<{
        id?: string;
        name?: string;
        group?: string;
        sessions?: string[];
      }>;
      const restored = raw
        .filter((entry) => typeof entry?.name === "string")
        .map((entry) => {
          const tab = newTab(entry.name!, entry.group ?? "");
          if (entry.id) tab.id = entry.id;
          for (const id of entry.sessions ?? []) tab.sessionIds.add(id);
          // A tab that held terminals last time must not reap itself before they arrive — the
          // wall is built once before Rust's restore lands, and an empty spent tab retires.
          tab.hadSession = tab.sessionIds.size > 0;
          return tab;
        });
      if (!restored.length) return [newTab("Tab 1")];
      // Restored ids were minted by a previous run's counter. Push ours past the highest of them
      // or the next new tab collides with one that is already on the strip.
      for (const tab of restored) {
        const at = Number(tab.id.replace("tab-", ""));
        if (Number.isFinite(at) && at >= nextTabId) nextTabId = at + 1;
      }
      return restored;
    } catch {
      return [newTab("Tab 1")];
    }
  };
  let tabs: Tab[] = loadTabs();
  let activeTab = 0;
  const currentTab = (): Tab => tabs[activeTab] ?? tabs[0];
  /** Which pinned tab is on screen, or null while a terminal tab is. While a pinned tab is up
   *  the wall and its bar stand down, and `activeTab` is remembered underneath so coming back
   *  lands where you left. Panel opens on Home, so that is where this starts. */
  let activePinned: number | null = 0;
  const pinnedCount = (): number => events.pinned.length;
  /** Pinned tabs come first, so a terminal tab `i` answers to `i + pinnedCount()`. */
  const stripCount = (): number => pinnedCount() + tabs.length;

  /*
   * Telling two terminals apart.
   *
   * A session is named by Rust as "claude", "claude 2", "shell 3" — the kind plus a seat. Two
   * agents on one project therefore differ by a digit and nothing else: same icon, same project,
   * same head. These two maps are the second and third answers to "which one is this".
   *
   * `names` is what YOU called it, kept across a reload because a name you typed is worth more
   * than one we generated. `folders` is where the process is actually standing, asked of the OS
   * once per session — on a monorepo that is usually the whole answer by itself.
   */
  const NAMES_KEY = "panel-term-names";
  const names = new Map<string, string>(
    (() => {
      try {
        return Object.entries(
          JSON.parse(localStorage.getItem(NAMES_KEY) ?? "{}") as Record<string, string>,
        );
      } catch {
        return [];
      }
    })(),
  );
  const saveNames = (): void => {
    localStorage.setItem(NAMES_KEY, JSON.stringify(Object.fromEntries(names)));
  };
  /** Resolved cwd basename per session. `null` once asked and unknowable — so a session with no
   *  answer is asked once, not on every rebuild. */
  const folders = new Map<string, string | null>();

  /** What the head's tag and the terminal tab say beside the project. One rule for both, see
   *  ttabBase. Before the project is known it falls back to your name, the folder, the title. */
  const tagOf = (session: Session): string => {
    const p = snapshot.find((entry) => entry.id === session.project);
    return p
      ? ttabBase(p, session)
      : names.get(session.id) || folders.get(session.id) || session.title;
  };

  /**
   * A terminal tab's own words, under a header that already names the project: your name for
   * it, else the engine, plus the folder when it stands somewhere other than the project root.
   * A shell in lib/ reads "lib"; Claude in the root reads "claude".
   */
  const ttabBase = (p: TerminalsProject, session: Session): string => {
    const named = names.get(session.id);
    if (named) return named;
    // Lowercase, like the project screen's own strip: "claude", "shell", "kimi k3".
    const engine = (ENGINES.find((entry) => entry.kind === session.kind)?.name ?? session.title).toLowerCase();
    const folder = folders.get(session.id) ?? "";
    const root = p.path?.split("/").filter(Boolean).pop() ?? "";
    const sub = folder && folder !== root ? folder : "";
    if (!sub) return engine;
    return session.kind === "shell" ? sub : `${engine} · ${sub}`;
  };

  // Stable anchors, set on every open().
  let liveCount: HTMLElement;
  let wall: HTMLElement;
  /** The wall and the notice band share one box: the band is absolutely placed inside this, so
   *  posting a report never re-flows a single terminal. */
  let stack: HTMLElement;
  /** The band of reports lying over the top of the wall. Empty means zero height and no layer
   *  in the way — see .term-notices, which is pointer-transparent apart from its cards. */
  let noticeBand: HTMLElement;
  /** What the band was last painted from: the tab, its notice ids, and which were unfolded.
   *  Repainting on an unchanged key would re-create every <img> and flash the pictures. */
  let noticeKey = "";
  /** The wall's own header (title, live count, ＋, page pips, column picker). */
  let toolbar: HTMLElement;
  let pagesBox: HTMLElement;
  let tabsBar: HTMLElement;
  /** The second row: one tab per terminal of the active tab. Only in the tabs layout. */
  let termBar: HTMLElement;
  /** The layout the wall was last built in, so a settings change knows whether to rebuild. */
  let builtLayout = termLayout();
  /** The toolbar's column picker, kept so a change made in Settings can light the right one. */
  let colsGroup: HTMLElement;
  /** The pinned modules' elements while we hold them, and the parents they came from. */
  let pinnedPanes: HTMLElement[] = [];
  let pinnedHomes: Array<HTMLElement | null> = [];
  /** Which pinned modules we have actually called show() on — so a tab switch never fires a
   *  module's open() or clear() twice, and never fires clear() on one that was already down. */
  let pinnedShown: boolean[] = [];
  /** The header's tiny "add terminal" icon — the wall only spends a whole cell on the
   *  picker while it's actually open; otherwise this is the entire launcher. */
  let addButton: HTMLElement;
  /** The build bar: one strip per live run, above everything, only while something is building
   *  or running. Held as state so it survives a rebuild of the wall under it. */
  let runBar: HTMLElement;
  let runLauncher: HTMLElement;
  let runs: LiveRun[] = [];

  /** Settings changed under us — a rebound chord in a tooltip, a column count, or the tabs'
   *  own close rule. Repaint rather than reload: the panes on the wall are live PTYs. */
  const onSettings = (): void => {
    if (!openState) return;
    applyCols(savedCols());
    paintCols(colsGroup);
    // Turning self-closing tabs ON with tabs already sitting empty sweeps them now, not later.
    // Only that and a layout flip are worth a wall rebuild; a column change is a data attribute
    // and a re-fit.
    const swept = reap();
    const flipped = termLayout() !== builtLayout;
    if (flipped) zoomed = null;
    paintTabs();
    if (swept || flipped) buildWall(snapshot);
    if (flipped) paintSide();
  };

  /** A chord moved. Only the hints have to change — the handler reads the keymap live. */
  const onKeymap = (): void => {
    if (!openState) return;
    addButton.title = `New terminal — ${chordText("wall.picker")}`;
    paintTabs();
    paintTermBar();
  };

  const queueRefit = (): void => {
    if (refitQueued) return;
    refitQueued = true;
    requestAnimationFrame(() => {
      refitQueued = false;
      if (!openState) return;
      // Width first, then fit: an `auto` wall can gain or lose a column on resize, which changes
      // which tile has to stretch — and a pane fitted before that measures the wrong box.
      stretchLastRow();
      events.refit();
    });
  };
  const onWindowResize = (): void => queueRefit();

  /** Panel coming back to the front is the same promise as coming back to this screen: the
   *  terminal you were in is still the one you are in. The OS hands focus back to <body> when
   *  the pane it was in got re-parented while we were away. */
  const onWindowFocus = (): void => {
    if (openState) restoreFocus();
  };

  const liveTerminals = (projects: TerminalsProject[]): number =>
    projects.reduce((sum, p) => sum + p.sessions.filter((s) => !events.isExited(s.id)).length, 0);

  /** Keyed on the ACTIVE tab's slice, not the whole portfolio — switching tabs must look like
   *  the session set changed even though no session actually opened or closed. Reports are NOT
   *  in the key: a notice lies over the grid, so posting one costs no rebuild. */
  const sessionKey = (projects: TerminalsProject[]): string =>
    `${currentTab().id}|` + activeSessions(projects).map(({ session }) => session.id).join(",");

  const flatSessions = (
    projects: TerminalsProject[],
  ): Array<{ p: TerminalsProject; session: Session }> =>
    projects.flatMap((p) => p.sessions.map((session) => ({ p, session })));

  /* ----------------------------------------------------------------- tabs */

  /**
   * One tab per company, kept for as long as that company has projects.
   *
   * Only when there is more than one group in the portfolio. A single-company portfolio gets no
   * group tabs at all — a tab named "Appgea" holding everything is a tab that separates nothing,
   * and the strip is too small to spend a seat saying what is already true of every seat.
   *
   * Group tabs are appended, never inserted, so adding a company tomorrow does not renumber the
   * ⌘-digit of a tab you already use.
   */
  const ensureGroupTabs = (projects: TerminalsProject[]): void => {
    const live = new Set(projects.filter((p) => p.exists).map((p) => p.group).filter(Boolean));
    if (live.size < 2) return;
    const named = new Map((events.groups?.() ?? []).map((group) => [group.id, group.name]));
    // Config order, not set order — the strip should read the way the portfolio is written down.
    for (const group of (events.groups?.() ?? []).map((g) => g.id).filter((id) => live.has(id))) {
      if (tabs.some((tab) => tab.group === group)) continue;
      tabs.push(newTab(named.get(group) ?? group, group));
    }
  };

  /** The tab a terminal on this project belongs in, or null when nothing claims it. */
  const tabForGroup = (group: string): Tab | null =>
    (group && tabs.find((tab) => tab.group === group)) || null;

  /**
   * A session nobody has claimed yet — brand new, restored from last run, or from before tabs
   * existed — is filed here.
   *
   * Its company's tab wins, when there is one. That is the whole point of the split: a Nexa
   * terminal belongs with the Nexa terminals no matter which tab you happened to be standing on
   * when you pressed ＋.
   *
   * The company wins over the tab you were standing on, with no exception. An exception would
   * have to be a rule about which hand-made tabs are "deliberate enough" to keep a launch, and
   * there is no such rule that is not a guess. A terminal that landed somewhere you did not want
   * moves in one drag; a rule you cannot predict costs you every time.
   *
   * Without any group tab — one company, or a project filed under none — this is what it always
   * was: the session joins whichever tab is up.
   */
  const ensureAssigned = (projects: TerminalsProject[]): void => {
    const known = new Set(tabs.flatMap((t) => [...t.sessionIds]));
    const here = currentTab();
    for (const { p, session } of flatSessions(projects)) {
      if (known.has(session.id)) continue;
      const home = tabForGroup(p.group) ?? here;
      home.sessionIds.add(session.id);
      home.hadSession = true;
    }
  };

  /** Forget sessions the portfolio no longer has. Without this a tab's id set only ever grows,
   *  and "does this tab still hold a terminal?" — the whole basis for sweeping it — is a lie. */
  const prune = (projects: TerminalsProject[]): void => {
    const alive = new Set(flatSessions(projects).map(({ session }) => session.id));
    for (const tab of tabs) {
      for (const id of tab.sessionIds) if (!alive.has(id)) tab.sessionIds.delete(id);
    }
    // Hand-given names outlive a reload but not the terminal they named. Without this the map
    // grows by one dead uuid per session, forever.
    let dropped = false;
    for (const id of [...names.keys()]) {
      if (!alive.has(id)) {
        names.delete(id);
        dropped = true;
      }
    }
    if (dropped) saveNames();
    saveTabs();
  };

  /** A tab that HELD terminals and has lost its last one is over — it closes itself, so the
   *  strip never accumulates dead tabs and closing one is never a decision you have to make
   *  while something is still running in it. A fresh tab is left alone, and the strip always
   *  keeps one tab. Returns whether the strip changed. */
  const reap = (): boolean => {
    if (!PREF.tabAutoClose()) return false;
    // A group tab is a fixture, not a workspace that got used up. Sweeping "Studio North" the
    // moment its last terminal closes would mean the company vanishes off the strip and comes
    // back on the next launch — a tab that blinks in and out is not a landmark.
    const spent = (tab: Tab): boolean =>
      !tab.group && tab.hadSession && tab.sessionIds.size === 0;
    if (!tabs.some(spent)) return false;
    const activeId = currentTab().id;
    let kept = tabs.filter((tab) => !spent(tab));
    if (!kept.length) {
      // The last terminal anywhere just went. Keep the first tab, reset to fresh, so the
      // workspace lands back on the picker instead of on nothing.
      const first = tabs[0];
      first.hadSession = false;
      first.plusOpen = false;
      kept = [first];
    }
    if (kept.length === tabs.length) return false;
    // A swept tab takes its reports with it — otherwise the map keeps growing entries no wall
    // will ever draw again.
    for (const tab of tabs) {
      if (kept.includes(tab)) continue;
      for (const id of tab.noticeIds) forget(id);
    }
    tabs = kept;
    const still = tabs.findIndex((tab) => tab.id === activeId);
    if (still >= 0) {
      activeTab = still;
    } else {
      // The tab under us was the one that emptied — land on whatever took its place.
      activeTab = Math.max(0, Math.min(activeTab, tabs.length - 1));
      plusPicked = null;
      zoomed = null;
      focusedSession = tabs[activeTab]?.focused ?? null;
      page = 0;
    }
    if (renamingTab && !tabs.some((tab) => tab.id === renamingTab)) renamingTab = null;
    return true;
  };

  /** Re-home one terminal into another tab — `to === tabs.length` means a brand new one. The
   *  PTY is untouched: only which wall adopts its pane changes. Emptying the source tab this
   *  way sweeps it, exactly as closing its last terminal would. */
  const moveSession = (sessionId: string, to: number): void => {
    if (to < 0 || to > tabs.length) return;
    const from = tabs.findIndex((tab) => tab.sessionIds.has(sessionId));
    if (from < 0 || from === to) return;
    const dest = to === tabs.length ? newTab(`Tab ${tabs.length + 1}`) : tabs[to];
    if (to === tabs.length) tabs.push(dest);
    tabs[from].sessionIds.delete(sessionId);
    dest.sessionIds.add(sessionId);
    dest.hadSession = true;
    // A terminal's reports belong with it, so they travel too. Leaving them behind would strand
    // a screenshot on a wall that no longer has the agent that took it.
    const moved = tabs[from].noticeIds.filter((id) => notices.get(id)?.session === sessionId);
    tabs[from].noticeIds = tabs[from].noticeIds.filter((id) => !moved.includes(id));
    dest.noticeIds.push(...moved);
    while (dest.noticeIds.length > NOTICES_PER_TAB) {
      const dropped = dest.noticeIds.shift();
      if (dropped) forget(dropped);
    }
    if (zoomed === sessionId) zoomed = null;
    // The caret travels with the terminal: land in it on the tab it moved to, and stop pointing
    // the old tab at a pane it no longer holds.
    if (tabs[from].focused === sessionId) tabs[from].focused = null;
    dest.focused = sessionId;
    if (focusedSession === sessionId) focusedSession = null;
    const destId = dest.id;
    const sourceId = tabs[from].id;
    const wasHere = from === activeTab && activePinned === null;
    reap();
    // If that was the source tab's last terminal, the source is gone — follow the terminal
    // rather than landing on whichever neighbour happens to have taken the index.
    if (PREF.followMove() && wasHere && !tabs.some((tab) => tab.id === sourceId)) {
      const at = tabs.findIndex((tab) => tab.id === destId);
      if (at >= 0) {
        activeTab = at;
        page = 0;
        focusedSession = sessionId;
      }
    }
    paintTabs();
    buildWall(snapshot);
  };

  /** This tab's slice of the portfolio — what the wall actually renders. */
  /** The tab's own order, not the portfolio's. Grouping by project would move a new terminal to
   *  wherever its project sits in the sidebar — you click the ＋ at the end of the wall and the
   *  tile appears somewhere near the top. The tab remembers the order sessions joined it, so a
   *  new terminal lands in the seat you launched it from and everything else stays put. */
  const activeSessions = (
    projects: TerminalsProject[],
  ): Array<{ p: TerminalsProject; session: Session }> => {
    const joined = [...currentTab().sessionIds];
    const rank = new Map(joined.map((id, at) => [id, at]));
    const ordered = flatSessions(projects)
      .filter(({ session }) => rank.has(session.id))
      .sort((a, b) => rank.get(a.session.id)! - rank.get(b.session.id)!);
    return tabbed() ? byProject(ordered) : ordered;
  };

  /** The tabs layout keeps a project's terminals side by side under one header. Projects keep
   *  the order they first joined in, and terminals keep their order inside a project. */
  const byProject = <T extends { p: TerminalsProject }>(cells: T[]): T[] => {
    const firstAt = new Map<string, number>();
    cells.forEach(({ p }, at) => {
      if (!firstAt.has(p.id)) firstAt.set(p.id, at);
    });
    return cells
      .map((cell, at) => ({ cell, at }))
      .sort((a, b) => firstAt.get(a.cell.p.id)! - firstAt.get(b.cell.p.id)! || a.at - b.at)
      .map(({ cell }) => cell);
  };

  /** The cells on the page being looked at. Everything that means "on screen right now" —
   *  ⌘W's target, the ＋ seat's page, the zoom — reads this, not the raw session list. */
  const visibleSessions = (): Cell[] => {
    if (tabbed()) {
      const shown = shownId();
      return activeSessions(snapshot).filter(({ session }) => session.id === shown);
    }
    return activeSessions(snapshot).slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  };

  const tabbed = (): boolean => termLayout() === "tabs";

  /** The tabs layout's second row is on screen with terminals in it. While it is, the chords you
   *  work with — ⌘⇧[ ] and ⌘1…9 — walk that row. ⌃Tab and ⌃⌘1…9 take the top row instead. */
  const rowUp = (): boolean =>
    tabbed() && activePinned === null && activeSessions(snapshot).length > 0;

  /** The chord that opens this strip tab: ⌘N, or ⌃⌘N in the tabs layout, where ⌘N is a terminal. */
  const stripKey = (stripIndex: number): string =>
    !tabbed()
      ? chordFor(stripIndex)
      : stripIndex <= 8
        ? chordLabel({ ...chordOf("term.select"), code: `Digit${stripIndex + 1}` })
        : "";

  /**
   * The one terminal the tabs layout shows: the tab's remembered one, else its first. Null while
   * the ＋ picker has the stage, or the tab is empty.
   */
  const shownId = (): string | null => {
    const tab = currentTab();
    if (tab.plusOpen) return null;
    const all = activeSessions(snapshot);
    if (!all.length) return null;
    const want = focusedSession ?? tab.focused;
    return all.some(({ session }) => session.id === want) ? want : all[0].session.id;
  };

  /** Put one terminal of this tab on screen in the tabs layout, or the caret in it on the grid. */
  const showTerminal = (sessionId: string): void => {
    if (!activeSessions(snapshot).some(({ session }) => session.id === sessionId)) return;
    if (tabbed()) {
      const changed = sessionId !== shownId();
      currentTab().plusOpen = false;
      plusPicked = null;
      plusQuery = "";
      zoomed = null;
      setFocused(sessionId);
      if (changed || !wall.querySelector(".term-tile")) buildWall(snapshot);
      else paintTermBar();
      events.focusPane(sessionId);
      return;
    }
    const wanted = pageOf(sessionId);
    if (wanted !== page) {
      page = wanted;
      buildWall(snapshot);
    }
    setFocused(sessionId);
    events.focusPane(sessionId);
  };

  /** Which page holds a terminal, so anything asking to be brought into view lands on it. */
  const pageOf = (id: string): number => {
    const at = activeSessions(snapshot).findIndex(({ session }) => session.id === id);
    return at >= 0 ? Math.floor(at / PAGE_SIZE) : page;
  };

  /* --------------------------------------------------------------- notices */

  const forget = (id: string): void => {
    notices.delete(id);
    unfolded.delete(id);
  };

  /** This tab's reports, oldest first. */
  const activeNotices = (): VisualNotice[] =>
    currentTab()
      .noticeIds.map((id) => notices.get(id))
      .filter((notice): notice is VisualNotice => notice !== undefined);

  /**
   * Post a report over the tab that holds its terminal, so it lands where that agent's work is
   * rather than wherever you happen to be standing.
   *
   * The arrival unfolds itself and folds whatever was open before it. Two reports open at once
   * is a wall you can no longer see, and the newest is the one you were just told about.
   */
  const showNotice = (notice: VisualNotice): void => {
    const home =
      (notice.session ? tabs.find((tab) => tab.sessionIds.has(notice.session!)) : null) ??
      currentTab();
    notices.set(notice.id, notice);
    if (!home.noticeIds.includes(notice.id)) home.noticeIds.push(notice.id);
    while (home.noticeIds.length > NOTICES_PER_TAB) {
      const dropped = home.noticeIds.shift();
      if (dropped) forget(dropped);
    }
    for (const id of home.noticeIds) unfolded.delete(id);
    unfolded.add(notice.id);
    // Only the band you are looking at has to repaint; another tab paints when you reach it.
    if (home === currentTab() && activePinned === null) paintNotices();
  };

  const dismissNotice = (id: string): void => {
    forget(id);
    for (const tab of tabs) {
      const at = tab.noticeIds.indexOf(id);
      if (at >= 0) tab.noticeIds.splice(at, 1);
    }
    paintNotices();
  };

  /** Esc, and ⌘W with nothing zoomed: fold the open report, then the next one down. Folding
   *  before dismissing is deliberate — the first Esc gives the wall back, and nothing is thrown
   *  away by a key you pressed to stop looking. */
  const foldTopNotice = (): boolean => {
    const open = activeNotices().filter((notice) => unfolded.has(notice.id));
    if (!open.length) return false;
    unfolded.delete(open[open.length - 1].id);
    paintNotices();
    return true;
  };

  /** Show exactly one body — a pinned module's element, or the wall with its bar. The wall's
   *  panes stay adopted the whole time; they are merely out of view, so nothing is torn down
   *  and rebuilt. Coming back re-fits them: xterm measures zero inside a display:none box. */
  const paintSide = (): void => {
    const onPinned = activePinned !== null;
    // The tabs layout swaps the wall's toolbar for its second row: columns and pages mean
    // nothing with one terminal on screen, and the row has its own ＋.
    toolbar.hidden = onPinned || tabbed();
    termBar.hidden = onPinned || !tabbed();
    // The bar follows you across tabs, but stands down over the Runs tab itself.
    paintRunBar();
    // The wall and its notice band go down together: a report over Home would be a report over
    // somebody else's screen.
    stack.hidden = onPinned;
    pinnedPanes.forEach((pane, index) => {
      pane.hidden = activePinned !== index;
    });
    events.pinned.forEach((entry, index) => {
      const want = activePinned === index;
      if (want === pinnedShown[index]) return;
      pinnedShown[index] = want;
      if (want) entry.show();
      else entry.hide();
    });
    if (!onPinned) queueRefit();
  };

  const switchTab = (index: number): void => {
    if (index === activeTab && activePinned === null) return;
    activeTab = index;
    activePinned = null;
    plusPicked = null;
    plusQuery = "";
    plusIndex = 0;
    zoomed = null;
    // Land back in the terminal this tab was left in — and on the page that holds it, or the
    // caret would be restored onto a pane that isn't on screen.
    focusedSession = currentTab().focused;
    page = 0; // set first: pageOf() falls back to `page` when the id is gone, and 0 is the
    if (focusedSession) page = pageOf(focusedSession); // right fallback for a tab we just entered
    paintTabs();
    paintSide();
    buildWall(snapshot);
  };

  /** The strip's own coordinate: pinned tabs, then terminal tabs. This is what the ⌘-digit
   *  ladder speaks, and the only thing outside this module ever needs to name a tab by. */
  const selectStrip = (index: number): boolean => {
    if (index < 0 || index >= stripCount()) return false;
    if (index >= pinnedCount()) {
      switchTab(index - pinnedCount());
      return true;
    }
    if (activePinned === index) return true;
    activePinned = index;
    // A zoomed tile left behind would come back covering the wall on return.
    zoomed = null;
    paintTabs();
    paintSide();
    return true;
  };

  const addTab = (): void => {
    tabs.push(newTab(`Tab ${tabs.length + 1}`));
    switchTab(tabs.length - 1);
  };

  /** Give this tab's ＋ seat its cell back. The header button and the hotkey share this. */
  const openPicker = (): void => {
    // Asked for by hand, so it gets the caret — even if it was already open, which is what
    // pressing the chord twice means: "put me back in the search".
    plusFocus = true;
    plusQuery = "";
    plusIndex = 0;
    if (currentTab().plusOpen) {
      wall.querySelector<HTMLInputElement>(".plus-search")?.focus();
      plusFocus = false;
      return;
    }
    currentTab().plusOpen = true;
    buildWall(snapshot);
  };

  /**
   * ⌘T — another shell beside the focused one, in the folder that one is standing in.
   *
   * The path is asked of the OS at press time rather than remembered from the launch: a `cd`
   * inside the PTY is invisible to us, and "here" has to mean where the shell IS, which is the
   * whole reason the key exists in every other terminal app. No terminal focused means there is
   * no "here" to inherit, so the picker opens instead of nothing happening.
   */
  const newShellHere = async (): Promise<void> => {
    const id = aimed();
    const from = id ? visibleSessions().find(({ session }) => session.id === id) : undefined;
    if (!from) {
      openPicker();
      return;
    }
    if (launching) return;
    launching = true;
    let session: Session | null = null;
    try {
      const cwd = (await events.cwdOf?.(from.session.id)) ?? null;
      session = await events.start(from.p.id, "shell", cwd ?? undefined);
    } finally {
      launching = false;
    }
    if (!session) return;
    currentTab().sessionIds.add(session.id);
    currentTab().hadSession = true;
    // A launch can spill onto a fresh page (this one was full) — follow the newborn. The caret
    // is claimed before the build: in the tabs layout it is what decides which terminal shows.
    page = pageOf(session.id);
    setFocused(session.id);
    buildWall(snapshot);
    wall
      .querySelector(`.term-tile[data-session="${CSS.escape(session.id)}"]`)
      ?.classList.add("is-born");
    events.focusPane(session.id);
  };

  /** Mark one tile as the caret's home. Cheap — repaints the ring in place, no rebuild.
   *  Also remembered on the tab, so coming back to it lands in the same terminal. */
  const setFocused = (sessionId: string | null): void => {
    focusedSession = sessionId;
    if (activePinned === null) currentTab().focused = sessionId;
    wall.querySelectorAll<HTMLElement>(".term-tile").forEach((tile) => {
      tile.classList.toggle("is-focused", tile.dataset.session === focusedSession);
    });
    termBar?.querySelectorAll<HTMLElement>(".term-ttab").forEach((tab) => {
      const on = tab.dataset.session === focusedSession && !currentTab().plusOpen;
      tab.classList.toggle("is-active", on);
      tab.setAttribute("aria-selected", String(on));
    });
    paintRunLauncher();
  };

  /**
   * The wall always names one tile as the caret's home. There is no such thing as a wall of
   * terminals with none of them lit.
   *
   * This is the marking half only, split off from restoreFocus() on purpose. Moving the caret
   * has to stand down for a ＋ pane search or a rename field — the human is typing into those —
   * but the RING has no such duty, and letting it go dark whenever the caret was busy elsewhere
   * is how the wall used to end up with nine equal tiles and no answer to "where am I".
   *
   * aimed() already falls back to the first tile on the page, so this only goes quiet when the
   * page genuinely holds no terminal.
   */
  const ensureFocused = (): void => {
    if (activePinned !== null) return;
    const target = aimed();
    if (target) setFocused(target);
  };

  /**
   * Put the caret back in a terminal after the wall was rebuilt.
   *
   * A rebuild re-parents every live mount (park → replaceChildren → adopt), and a re-parented
   * node loses DOM focus — so anything that redraws the grid while you are typing silently drops
   * you out of the pane. That is one bug, not four: a visual arriving, a session ending, a tab
   * switch and a launch all land here. Whoever asked for the caret by hand keeps it — a picker
   * search or a tab-rename field is a real input the human is in the middle of.
   */
  const restoreFocus = (): void => {
    if (activePinned !== null) return;
    // Mid-choice in the ＋ seat: the picker owns the keyboard even across a rebuild that dropped
    // its caret. Handing those keystrokes to a live PTY instead would be worse than losing them.
    if (plusQuery || plusPicked || launching) return;
    const active = document.activeElement as HTMLElement | null;
    // xterm's own helper textarea IS a terminal having focus; every other field outranks us.
    if (
      active &&
      !active.classList.contains("xterm-helper-textarea") &&
      active.matches("input, textarea, select, [contenteditable='true']")
    ) {
      return;
    }
    const target = aimed();
    if (!target) return;
    setFocused(target);
    events.focusPane(target);
  };

  /** Ctrl+Tab walks the caret through THIS tab's terminals, Ctrl+Shift+Tab walks back. It
   *  follows across pages, and while one tile is zoomed it moves the ZOOM instead — that is
   *  the only terminal on screen, so "next" has to mean showing a different one. */
  const cycleTerminal = (delta: number): void => {
    const all = activeSessions(snapshot);
    if (!all.length) return;
    const from = tabbed() ? shownId() : (zoomed ?? focusedSession);
    const at = all.findIndex(({ session }) => session.id === from);
    const index =
      at < 0
        ? delta > 0
          ? 0
          : all.length - 1
        : (((at + delta) % all.length) + all.length) % all.length;
    const target = all[index].session.id;
    if (tabbed()) {
      showTerminal(target);
      return;
    }
    if (zoomed) {
      setZoom(target); // puts the caret in it too
      setFocused(target);
      return;
    }
    // The next terminal may live on another page — bring that page up rather than no-op.
    const wanted = pageOf(target);
    if (wanted !== page) {
      page = wanted;
      buildWall(snapshot);
    }
    setFocused(target);
    events.focusPane(target);
  };

  /** The terminal the keyboard is aimed at: where Ctrl+Tab last left the caret, else whatever
   *  is zoomed, else the first tile on this page. Never nothing while the wall has a tile. */
  const aimed = (): string | null => {
    const visible = visibleSessions();
    if (!visible.length) return null;
    const wanted = focusedSession ?? zoomed;
    return visible.some(({ session }) => session.id === wanted)
      ? wanted
      : visible[0].session.id;
  };

  /** Walk the whole strip, wrapping — the relative half of the ⌘-digit ladder, pinned tabs
   *  included. It is one strip; a "next tab" that skipped Home would be lying about that. */
  const stepStrip = (delta: number): void => {
    const total = stripCount();
    if (total < 2) return;
    const here = activePinned ?? pinnedCount() + activeTab;
    selectStrip((((here + delta) % total) + total) % total);
  };

  /** Move the caret to the nearest tile in a direction, by geometry rather than by join order:
   *  on a 3×3 wall "the next one" is a guess, but "the one to the right" is not. Zoom has one
   *  tile on screen and no geometry to speak of, so there the arrows walk the order instead. */
  const focusToward = (dx: number, dy: number): void => {
    // One terminal on screen has no geometry: the arrows walk the second row instead.
    if (zoomed || tabbed()) {
      cycleTerminal(dx + dy > 0 ? 1 : -1);
      return;
    }
    const tiles = [...wall.querySelectorAll<HTMLElement>(".term-tile")];
    if (tiles.length < 2) return;
    const from = aimed();
    const current = tiles.find((tile) => tile.dataset.session === from) ?? tiles[0];
    const a = current.getBoundingClientRect();
    const ax = a.left + a.width / 2;
    const ay = a.top + a.height / 2;
    let best: HTMLElement | null = null;
    let bestScore = Infinity;
    for (const tile of tiles) {
      if (tile === current) continue;
      const b = tile.getBoundingClientRect();
      const bx = b.left + b.width / 2;
      const by = b.top + b.height / 2;
      const along = (bx - ax) * dx + (by - ay) * dy;
      if (along <= 4) continue; // behind us, or the same row/column
      const across = Math.abs((bx - ax) * dy + (by - ay) * dx);
      // Straight ahead beats a diagonal of the same distance — hence the drift penalty.
      const score = along + across * 2;
      if (score < bestScore) {
        bestScore = score;
        best = tile;
      }
    }
    const id = best?.dataset.session;
    if (!id) return;
    setFocused(id);
    events.focusPane(id);
  };

  /** ⌘↩ on the tile the caret is in. With nothing focused it zooms the first one rather than
   *  doing nothing — the wall always has an obvious "this one". */
  const toggleZoom = (): void => {
    if (zoomed) {
      setZoom(null);
      return;
    }
    const id = aimed();
    if (id) setZoom(id);
  };

  /** Keyboard control of the wall — only while it is actually up, so the project screen and
   *  the rest of the app keep these chords for themselves. Every chord comes from the keymap,
   *  so the settings page can move any of them. */
  const onKey = (event: KeyboardEvent): void => {
    if (!openState) return;
    // A field on the wall — the tab rename, the ＋ pane's search — owns its own letters,
    // digits and arrows. It does NOT own the ⌘ chords: you must still be able to open a tab
    // while the caret sits in the picker.
    if (
      event.target instanceof HTMLInputElement &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      return;
    }
    // A dialog owns the keyboard while it is up; the wall is behind glass. Without this,
    // Escape would leave a zoom instead of closing what is actually in front of you. An expanded
    // picture is the same situation — Esc must close the picture, ←/→ must walk it.
    if (document.querySelector(".dlg-wrap, .skills-overlay") || isLightboxOpen()) return;

    const take = (): void => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    /** Claim the keystroke and run the action. Every branch below is one of these. */
    const run = (act: () => void): void => {
      take();
      act();
    };

    // Tabs layout: the two rows trade chords. ⌘⇧[ ] walks the terminals you work in, and ⌃Tab
    // and ⌃⌘1…9 take over the tabs above. With no second row up — a pinned tab, an empty tab —
    // ⌘⇧[ ] falls through to the strip, so it still gets you off one.
    if (tabbed()) {
      if (rowUp() && matches(event, "tab.next")) return run(() => cycleTerminal(1));
      if (rowUp() && matches(event, "tab.prev")) return run(() => cycleTerminal(-1));
      if (matches(event, "term.prev")) return run(() => stepStrip(-1));
      if (matches(event, "term.next")) return run(() => stepStrip(1));
      if (matches(event, "term.select")) {
        const digit = digitOf(event);
        if (!digit || digit > stripCount()) return;
        return run(() => void selectStrip(digit - 1));
      }
    }

    // Strip-level chords work from a pinned tab too — they are how you get off one.
    if (matches(event, "tab.next")) return run(() => stepStrip(1));
    if (matches(event, "tab.prev")) return run(() => stepStrip(-1));
    if (matches(event, "wall.newTab")) return run(addTab);
    if (matches(event, "wall.layout")) {
      return run(() => setTermLayout(tabbed() ? "grid" : "tabs"));
    }

    // Tabs layout: the arrows move over two rows, so ↑/↓ go to the row above. They walk the
    // whole strip and work from Inbox or Runs too, which is how you get back off them.
    if (tabbed()) {
      if (matches(event, "term.focusUp")) return run(() => stepStrip(-1));
      if (matches(event, "term.focusDown")) return run(() => stepStrip(1));
    }

    // Everything below needs a wall under it.
    if (activePinned !== null) return;

    if (matches(event, "wall.picker")) return run(openPicker);
    if (matches(event, "wall.newShell")) return run(() => void newShellHere());
    // The picker is the frontmost thing on the wall. Esc dismisses it before it can unzoom or
    // fold anything behind it; the search input handles the same key locally.
    if (matches(event, "term.unzoom") && wall.querySelector(".term-plus")) {
      return run(() => {
        dismissPicker();
      });
    }
    // Prev is checked first: it is the same code as next with ⇧ added, and an exact modifier
    // match is the only thing keeping the two apart.
    if (matches(event, "term.select")) {
      const digit = digitOf(event);
      const target = digit ? activeSessions(snapshot)[digit - 1] : undefined;
      if (!target) return;
      return run(() => showTerminal(target.session.id));
    }
    if (matches(event, "term.prev")) return run(() => cycleTerminal(-1));
    if (matches(event, "term.next")) return run(() => cycleTerminal(1));
    if (matches(event, "term.focusLeft")) return run(() => focusToward(-1, 0));
    if (matches(event, "term.focusRight")) return run(() => focusToward(1, 0));
    if (matches(event, "term.focusUp")) return run(() => focusToward(0, -1));
    if (matches(event, "term.focusDown")) return run(() => focusToward(0, 1));
    if (matches(event, "term.zoom")) return run(toggleZoom);
    // ^F means "fullscreen this terminal" on a project screen. It used to mean nothing here, on
    // the one screen that is nothing but terminals. Same act as ⌘↩.
    if (matches(event, "term.fullscreen")) return run(toggleZoom);
    // Escape is everyone's cancel key. Claim it only when there is actually a zoom to leave,
    // so a dialog or a shell's own Escape is never eaten by an idle wall.
    if (matches(event, "term.unzoom")) {
      if (zoomed) {
        take();
        setZoom(null);
        return;
      }
      // Nothing zoomed: Esc is then "give me my wall back" — a folded report is the only other
      // thing sitting over it. Claimed only when there IS one open, so an idle wall never eats
      // a shell's own Escape.
      if (foldTopNotice()) {
        take();
        restoreFocus();
      }
      return;
    }
    if (matches(event, "term.moveToNewTab")) {
      const id = aimed();
      if (!id) return;
      take();
      moveSession(id, tabs.length);
      return;
    }
    if (matches(event, "term.moveToTab")) {
      const digit = digitOf(event);
      const id = aimed();
      // The digit is the STRIP's, so ⌘⌥4 sends the terminal to the tab ⌘4 opens. A pinned
      // digit has no wall to land on and is simply not a target.
      const to = (digit ?? 0) - 1 - pinnedCount();
      if (!digit || !id || to < 0 || to >= tabs.length) return;
      take();
      moveSession(id, to);
    }
  };

  /** Closing a tab by hand is only ever the empty case — a tab holding terminals has no ×,
   *  because it closes itself the moment its last one does (reap). Nothing is ever re-homed
   *  behind your back, and no click can strand a live PTY on a wall you can no longer see. */
  const closeTab = (index: number): void => {
    if (tabs.length < 2) return;
    // With self-closing tabs off, the old behaviour is back: the × is on every tab, and it
    // re-homes whatever is running into the first one rather than killing it.
    if (tabs[index]?.sessionIds.size && PREF.tabAutoClose()) return;
    const [gone] = tabs.splice(index, 1);
    if (renamingTab === gone.id) renamingTab = null;
    for (const id of gone.sessionIds) {
      tabs[0].sessionIds.add(id);
      tabs[0].hadSession = true;
    }
    if (activeTab === index) {
      activeTab = Math.max(0, index - 1);
      plusPicked = null;
      zoomed = null;
      page = 0;
    } else if (activeTab > index) {
      activeTab -= 1;
    }
    paintTabs();
    buildWall(snapshot);
  };

  /** Put the add-terminal surface away before touching any terminal behind it. An empty tab
   *  exists only to host this picker, so dismissing retires that tab; the original empty wall
   *  falls back to the first pinned workspace pane. */
  const dismissPicker = (): boolean => {
    if (!wall.querySelector(".term-plus")) return false;
    plusPicked = null;
    plusQuery = "";
    plusIndex = 0;
    plusFocus = false;
    if (currentTab().sessionIds.size) {
      currentTab().plusOpen = false;
      buildWall(snapshot);
      restoreFocus();
      return true;
    }
    if (tabs.length > 1) {
      closeTab(activeTab);
      return true;
    }
    if (pinnedCount()) {
      selectStrip(0);
      return true;
    }
    return false;
  };

  /** Which tab is being renamed, BY ID rather than by a live input element. A double-click
   *  on an inactive tab also fires two plain clicks, which switch tabs and repaint the whole
   *  strip — an input held only in the DOM is destroyed mid-rename. Held as state, the
   *  repaint simply draws the field again. */
  let renamingTab: string | null = null;

  const commitRename = (tab: Tab, value: string): void => {
    const name = value.trim();
    if (name) tab.name = name;
    renamingTab = null;
    paintTabs();
  };

  /** The rename field, standing IN PLACE of its tab button — an <input> nested inside a
   *  <button> is invalid and every click in it would trigger the button. */
  const buildRenameField = (tab: Tab): HTMLElement => {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "terms-tab-input";
    input.value = tab.name;
    input.setAttribute("aria-label", "tab name");
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") commitRename(tab, input.value);
      if (event.key === "Escape") {
        renamingTab = null;
        paintTabs();
      }
    });
    input.addEventListener("blur", () => {
      if (renamingTab !== tab.id) return;
      // Losing focus because a repaint pulled us out of the DOM is NOT a commit: that
      // repaint already owns the strip, and re-entering paintTabs() from inside its own
      // replaceChildren() would append a second copy of every tab.
      if (!input.isConnected) return;
      commitRename(tab, input.value);
    });
    // Focus only once it is actually in the document — focus() on a detached node is a no-op.
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
    return input;
  };

  /** A pinned tab holds its strip index for good: never closed, never renamed, never moved,
   *  so ⌘1 and ⌘2 mean the same thing forever. */
  const buildPinnedTab = (entry: PinnedPane, index: number): HTMLElement => {
    const on = activePinned === index;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `terms-tab terms-tab-pinned${on ? " is-active" : ""}`;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(on));
    const chord = stripKey(index);
    button.title = `${entry.name}${chord ? ` — ${chord}` : ""}`;
    const glyph = make("i", "terms-tab-ico");
    glyph.setAttribute("aria-hidden", "true");
    glyph.innerHTML = icon(entry.glyph);
    const label = make("span", "terms-tab-name");
    label.textContent = entry.name;
    button.append(glyph, label);
    button.addEventListener("click", () => selectStrip(index));
    return button;
  };

  /** The terminal currently being dragged by its head, so a tab knows whether to light up.
   *  Held here rather than read off the drop event: dataTransfer is write-only during
   *  dragover, which is exactly when the strip needs to answer "would this land?". */
  let dragging: string | null = null;

  /** Any tab in the strip takes a dropped terminal; `at === tabs.length` is the ＋ button,
   *  which makes a new tab out of it. */
  const makeDropTab = (target: HTMLElement, at: number): void => {
    const holds = (): boolean => at < tabs.length && !!dragging && tabs[at].sessionIds.has(dragging);
    target.addEventListener("dragover", (event) => {
      if (!dragging || holds()) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      target.classList.add("is-drop");
    });
    target.addEventListener("dragleave", () => target.classList.remove("is-drop"));
    target.addEventListener("drop", (event) => {
      target.classList.remove("is-drop");
      if (!dragging || holds()) return;
      event.preventDefault();
      const id = dragging;
      dragging = null;
      moveSession(id, at);
    });
  };

  /** The other half of moving: a menu on the tile, for when dragging across a full wall is
   *  fiddlier than picking the tab by name. */
  const moveMenu = (tile: HTMLElement, sessionId: string): void => {
    tile.querySelector(".term-move-menu")?.remove();
    const menu = make("div", "term-move-menu");
    const row = (label: string, to: number): void => {
      const item = make("button", "term-move-item");
      (item as HTMLButtonElement).type = "button";
      item.textContent = label;
      item.addEventListener("click", (event) => {
        event.stopPropagation();
        menu.remove();
        moveSession(sessionId, to);
      });
      menu.append(item);
    };
    tabs.forEach((tab, index) => {
      if (tab.sessionIds.has(sessionId)) return;
      row(tab.name, index);
    });
    row("＋ New tab", tabs.length);
    // Anything else on the wall dismisses it — including the button that opened it.
    const away = (event: MouseEvent): void => {
      if (menu.contains(event.target as Node)) return;
      menu.remove();
      window.removeEventListener("mousedown", away, true);
    };
    window.addEventListener("mousedown", away, true);
    tile.append(menu);
  };

  const paintTabs = (): void => {
    saveTabs(); // renames and closes land here and nowhere else
    tabsBar.replaceChildren(...events.pinned.map(buildPinnedTab));
    tabs.forEach((tab, index) => {
      if (renamingTab === tab.id) {
        tabsBar.append(buildRenameField(tab));
        return;
      }
      const on = activePinned === null && index === activeTab;
      const button = document.createElement("button");
      button.type = "button";
      button.className = `terms-tab${on ? " is-active" : ""}`;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(on));
      const chord = stripKey(index + pinnedCount());
      button.title = `${tab.name}${chord ? ` — ${chord}` : ""} · double-click to rename`;
      button.dataset.tab = tab.id;
      const label = make("span", "terms-tab-name");
      label.textContent = tab.name;
      // Lit when a terminal in this tab is working or waiting on you, so a parked agent behind
      // another tab is still visible from here.
      const dot = make("i", "terms-tab-dot");
      dot.setAttribute("aria-hidden", "true");
      button.append(dot, label);
      button.addEventListener("dblclick", (event) => {
        event.preventDefault();
        renamingTab = tab.id;
        paintTabs();
      });
      // The × is the empty case only. With terminals on it, a tab is closed by closing them —
      // it then goes on its own, so there is no button here to strand a running PTY with.
      // Unless self-closing tabs are off, in which case every tab keeps its ×.
      if (tabs.length > 1 && (tab.sessionIds.size === 0 || !PREF.tabAutoClose())) {
        const close = document.createElement("span");
        close.className = "terms-tab-close";
        close.setAttribute("role", "button");
        close.setAttribute("aria-label", `close ${tab.name}`);
        close.textContent = "×";
        close.addEventListener("click", (event) => {
          event.stopPropagation();
          closeTab(index);
        });
        button.append(close);
      } else if (tab.sessionIds.size) {
        const count = make("span", "terms-tab-count");
        count.textContent = String(tab.sessionIds.size);
        count.title = "closes itself when its last terminal does";
        button.append(count);
      }
      button.addEventListener("click", () => switchTab(index));
      makeDropTab(button, index);
      tabsBar.append(button);
    });
    const add = document.createElement("button");
    add.type = "button";
    add.className = "terms-plus terms-tab-add";
    add.setAttribute("aria-label", "new tab");
    add.title =
      `New tab — ${chordText("wall.newTab")} · drop a terminal here to move it into one`;
    add.addEventListener("click", () => addTab());
    makeDropTab(add, tabs.length);
    tabsBar.append(add);
    if (activePinned === null && events.memoryOf) {
      tabsBar.append(memoryMeter);
      paintMeter();
    }
    if (activePinned === null) tabsBar.append(buildLayoutSwitch());
    paintTermBarStates();
  };

  /*
   * What the wall costs the machine, and the one move that gives most of it back. Built once and
   * re-attached on every strip paint, so a reading never waits for a rebuild and a rebuild never
   * drops a reading.
   */
  const memoryMeter = make("span", "terms-mem");
  const meterTotal = make("span", "terms-mem-total");
  const meterSleep = document.createElement("button");
  meterSleep.type = "button";
  meterSleep.className = "terms-mem-sleep";
  meterSleep.addEventListener("click", () => events.sleep?.(events.sleepable?.() ?? []));
  memoryMeter.append(meterTotal, meterSleep);

  const paintMeter = (): void => {
    let total = 0;
    let read = false;
    for (const p of snapshot) {
      for (const session of p.sessions) {
        const bytes = events.memoryOf?.(session.id)?.bytes;
        if (bytes == null) continue;
        total += bytes;
        read = true;
      }
    }
    memoryMeter.hidden = !read;
    meterTotal.textContent = formatBytes(total);
    meterTotal.title = "What every terminal holds, with the servers and builds its agent started";
    const idle = events.sleepable?.() ?? [];
    const freed = idle.reduce((sum, id) => sum + (events.memoryOf?.(id)?.bytes ?? 0), 0);
    meterSleep.hidden = idle.length === 0;
    meterSleep.textContent = `Sleep ${idle.length} idle`;
    meterSleep.title =
      `Gives back about ${formatBytes(freed)}. Each pane stays, and Wake picks its conversation back up. ` +
      "Agents that are working or waiting on you are left alone, and so is the one you are typing in.";
  };

  /* ------------------------------------------------------------ layout */

  const LAYOUT_GLYPH = {
    grid:
      '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="5" height="5" rx="1.2"/><rect x="9" y="2.5" width="5" height="5" rx="1.2"/><rect x="2" y="9.5" width="5" height="5" rx="1.2"/><rect x="9" y="9.5" width="5" height="5" rx="1.2"/></svg>',
    tabs:
      '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3.5h4.5M8.5 3.5H14"/><path d="M2 6.5h3M7 6.5h3"/><rect x="2" y="8.5" width="12" height="6" rx="1.2"/></svg>',
  } as const;

  /** Grid or tabs, one click away on the strip. Same choice as Settings and ⌘⇧L. */
  const buildLayoutSwitch = (): HTMLElement => {
    const group = make("span", "terms-layout");
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", "Terminal layout");
    const chord = chordText("wall.layout");
    const choices = [
      { id: "grid", text: "Grid", note: "every terminal of the tab at once" },
      { id: "tabs", text: "Tabs", note: "a row of terminal tabs, one terminal at a time" },
    ] as const;
    for (const choice of choices) {
      const button = document.createElement("button");
      button.type = "button";
      const on = termLayout() === choice.id;
      button.className = `terms-layout-item${on ? " is-active" : ""}`;
      button.setAttribute("aria-pressed", String(on));
      button.setAttribute("aria-label", `${choice.text} layout`);
      button.title = `${choice.text}: ${choice.note}${chord ? ` — ${chord} flips` : ""}`;
      button.innerHTML = LAYOUT_GLYPH[choice.id];
      button.addEventListener("click", () => {
        if (!on) setTermLayout(choice.id);
      });
      group.append(button);
    }
    return group;
  };

  /* -------------------------------------------------------- terminal tabs */

  /** Where a terminal's turn stands, for the second row and the strip's dots. */
  const phaseFor = (sessionId: string): TilePhase | "dead" =>
    events.isExited(sessionId) ? "dead" : (events.phaseOf?.(sessionId) ?? "idle");

  /** "⌘⌥←" and "⌘⌥→" print as "⌘⌥←→" when they share modifiers, else both in full. */
  const pairLabel = (a: string, b: string): string => {
    const prefix = (label: string): string => label.slice(0, -1);
    return a && b && prefix(a) === prefix(b) ? `${a}${b.slice(-1)}` : [a, b].filter(Boolean).join(" ");
  };

  /** Re-colour the dots in place. A status tick must not rebuild either row. */
  const paintTermBarStates = (): void => {
    if (!tabsBar) return;
    termBar?.querySelectorAll<HTMLElement>(".term-ttab").forEach((tab) => {
      const phase = phaseFor(tab.dataset.session ?? "");
      tab.classList.toggle("is-work", phase === "work");
      tab.classList.toggle("is-ask", phase === "ask");
      tab.classList.toggle("is-dead", phase === "dead");
    });
    tabsBar.querySelectorAll<HTMLElement>(".terms-tab[data-tab]").forEach((button) => {
      const tab = tabs.find((entry) => entry.id === button.dataset.tab);
      const phases = [...(tab?.sessionIds ?? [])].map(phaseFor);
      button.classList.toggle("has-ask", phases.includes("ask"));
      button.classList.toggle("has-work", !phases.includes("ask") && phases.includes("work"));
    });
  };

  /** Drag a terminal tab along its row to change the order. The order is the tab's join order,
   *  so the grid's seats and the ⌃⌘ digits follow it too. */
  const reorder = (sessionId: string, target: string, after: boolean): void => {
    const tab = currentTab();
    if (sessionId === target || !tab.sessionIds.has(sessionId) || !tab.sessionIds.has(target)) return;
    const order = [...tab.sessionIds].filter((id) => id !== sessionId);
    order.splice(order.indexOf(target) + (after ? 1 : 0), 0, sessionId);
    tab.sessionIds = new Set(order);
    buildWall(snapshot);
  };

  /** Rename in place, the same gesture and the same names as the tile head. */
  const renameTermTab = (tab: HTMLElement, label: HTMLElement, session: Session): void => {
    const field = document.createElement("input");
    field.className = "term-ttab-input";
    field.value = names.get(session.id) ?? "";
    field.placeholder = tagOf(session);
    field.spellcheck = false;
    tab.draggable = false;
    const done = (keep: boolean): void => {
      if (!field.isConnected) return;
      if (keep) {
        const next = field.value.trim();
        if (next) names.set(session.id, next);
        else names.delete(session.id);
        saveNames();
      }
      field.replaceWith(label);
      tab.draggable = true;
      paintTermBar();
      const head = wall.querySelector<HTMLElement>(
        `.term-tile[data-session="${CSS.escape(session.id)}"] .term-title`,
      );
      if (head) head.textContent = tagOf(session);
      events.focusPane(session.id);
    };
    field.addEventListener("keydown", (key) => {
      key.stopPropagation();
      if (key.key === "Enter") done(true);
      else if (key.key === "Escape") done(false);
    });
    field.addEventListener("blur", () => done(true));
    field.addEventListener("click", (event) => event.stopPropagation());
    label.replaceWith(field);
    field.focus();
    field.select();
  };

  /**
   * The second row of the tabs layout. One tab per terminal of the active tab, in join order:
   * state dot, app icon, the terminal's tag, and its ⌘ digit. Click shows it, middle-click
   * or × closes it, double-click renames it, drag reorders it or drops it on a tab of the top row.
   */
  const paintTermBar = (): void => {
    if (!termBar) return;
    if (!tabbed() || activePinned !== null) {
      termBar.replaceChildren();
      return;
    }
    const shown = shownId();
    const ordered = activeSessions(snapshot);
    const projectOf = new Map(ordered.map(({ p, session }) => [session.id, p.id]));
    // Two shells in one project both say "Shell" — number the repeats so each tab is its own.
    const seen = new Map<string, number>();
    const labels = ordered.map(({ p, session }) => {
      const base = ttabBase(p, session);
      const key = `${p.id}\n${base}`;
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      return count > 1 ? `${base} ${count}` : base;
    });
    const cells = ordered.map(({ p, session }, index) => {
      const on = session.id === shown;
      const tab = document.createElement("div");
      // k-* gives the tab its engine's hue, the same classes the project screen's strip uses.
      // A thin rule where one project's run of tabs ends and the next begins. The app icon in
      // each tab says which project; a caption cell per project cost a whole column each.
      const starts = index > 0 && ordered[index - 1].p.id !== p.id;
      tab.className = `term-ttab k-${session.kind}${on ? " is-active" : ""}${starts ? " is-group-start" : ""}`;
      tab.dataset.session = session.id;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = -1;
      const key = chordFor(index);
      tab.dataset.project = p.id;
      tab.title = `${p.name} — ${labels[index]}${key ? ` · ${key}` : ""} · double-click to rename · drag to reorder or onto a tab above`;

      // One dot: the engine's hue at rest, pulsing while it works, amber while it waits on you.
      const dot = make("i", "term-ttab-dot");
      dot.setAttribute("aria-hidden", "true");
      const ico = projectIcon(p);
      ico.classList.add("term-ttab-ico");
      const label = make("span", "term-ttab-tag");
      label.textContent = labels[index];
      tab.append(dot, ico, label);
      const close = make("button", "term-ttab-close");
      (close as HTMLButtonElement).type = "button";
      close.setAttribute("aria-label", `close ${p.name} terminal`);
      close.title = "Close this terminal";
      close.textContent = "×";
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        events.close(p.id, session.id);
      });
      tab.append(close);

      tab.addEventListener("click", () => showTerminal(session.id));
      tab.addEventListener("auxclick", (event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        events.close(p.id, session.id);
      });
      tab.addEventListener("dblclick", (event) => {
        event.preventDefault();
        renameTermTab(tab, label, session);
      });

      tab.draggable = true;
      tab.addEventListener("dragstart", (event) => {
        dragging = session.id;
        tab.classList.add("is-dragging");
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", session.title);
        }
      });
      tab.addEventListener("dragend", () => {
        dragging = null;
        tab.classList.remove("is-dragging");
        for (const node of document.querySelectorAll(".is-drop, .is-drop-before, .is-drop-after")) {
          node.classList.remove("is-drop", "is-drop-before", "is-drop-after");
        }
      });
      const side = (event: DragEvent): boolean => {
        const box = tab.getBoundingClientRect();
        return event.clientX > box.left + box.width / 2;
      };
      tab.addEventListener("dragover", (event) => {
        // Order is kept inside a project; a tab dragged to another project's group would only
        // snap back under its own header.
        if (!dragging || dragging === session.id || projectOf.get(dragging) !== p.id) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        const after = side(event);
        tab.classList.toggle("is-drop-after", after);
        tab.classList.toggle("is-drop-before", !after);
      });
      tab.addEventListener("dragleave", () => tab.classList.remove("is-drop-before", "is-drop-after"));
      tab.addEventListener("drop", (event) => {
        tab.classList.remove("is-drop-before", "is-drop-after");
        if (!dragging || dragging === session.id || projectOf.get(dragging) !== p.id) return;
        event.preventDefault();
        const id = dragging;
        dragging = null;
        reorder(id, session.id, side(event));
      });
      return tab;
    });

    const add = document.createElement("button");
    add.type = "button";
    add.className = `term-ttab-add${currentTab().plusOpen || !cells.length ? " is-active" : ""}`;
    add.setAttribute("aria-label", "new terminal");
    add.title = `New terminal — ${chordText("wall.picker")} · new shell here — ${chordText("wall.newShell")}`;
    add.textContent = "+";
    add.addEventListener("click", () => openPicker());

    // The keys live in tooltips, not as words on the row: the row is for terminals.
    const walk = pairLabel(chordText("tab.prev"), chordText("tab.next"));
    const across = pairLabel(chordText("term.focusLeft"), chordText("term.focusRight"));
    const down = pairLabel(chordText("term.focusUp"), chordText("term.focusDown"));
    const above = pairLabel(chordText("term.prev"), chordText("term.next"));
    termBar.title =
      `${walk} or ${across} walk these terminals · ${chordFor(0).slice(0, -1)}1…9 jumps to one · ` +
      `${above} or ${down} walk the tabs above · ${chordText("term.select")} jumps to one`;
    const filler = make("span", "term-ttabs-fill");
    // The tabs layout hides the tile head, so its one tool worth keeping moves up here.
    const extras: HTMLElement[] = [];
    const current = ordered.find(({ session }) => session.id === shown);
    if (
      current &&
      events.skills &&
      !events.isExited(current.session.id) &&
      (current.session.kind === "claude" || current.session.kind === "codex")
    ) {
      const skills = make("button", "term-ttabs-skills");
      (skills as HTMLButtonElement).type = "button";
      skills.textContent = "Skills";
      skills.title = `${current.session.kind} session skills and shared workflows`;
      skills.addEventListener("click", () => events.skills?.(current.session.id));
      extras.push(skills);
    }
    // The row is a grid so every tab gets the same width whatever its label says: equal tabs
    // read as one calm row.
    const columns = cells.map(() => "minmax(120px, 200px)");
    termBar.style.gridTemplateColumns = [...columns, "auto", "1fr", ...extras.map(() => "auto")].join(" ");
    termBar.replaceChildren(...cells, add, filler, ...extras);
    paintTermBarStates();
    // Keep the shown tab in view when the row overflows.
    termBar.querySelector<HTMLElement>(".term-ttab.is-active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  const buildTabsBar = (): HTMLElement => {
    const bar = make("div", "terms-tabs");
    bar.setAttribute("role", "tablist");
    bar.setAttribute("aria-label", "Workspace tabs");
    return bar;
  };

  /* ------------------------------------------------------------------ bar */

  const savedCols = (): string => {
    const value = localStorage.getItem(COLS_KEY);
    return value && (COLS as readonly string[]).includes(value) ? value : "auto";
  };

  const applyCols = (value: string): void => {
    wall.dataset.cols = value;
    queueRefit();
  };

  /** How many columns the wall is ACTUALLY in. `auto` packs by width, so the number has to be
   *  measured rather than read — and the wall needs it to know if its last row has a hole. */
  const resolveCols = (): number => {
    if (tabbed()) return 1;
    const preference = wall.dataset.cols ?? "auto";
    if (preference !== "auto") return Math.max(1, Number(preference) || 1);
    const width = wall.clientWidth;
    if (width < 2) return 1;
    // Mirrors the auto-fit track in CSS: minmax(330px, 1fr) with a 7px gap.
    return Math.max(1, Math.floor((width + 7) / 337));
  };

  /**
   * A last row with a hole in it reads as a broken grid, not as spare room — three terminals in
   * two columns leaves a quarter of the screen blank and looks like something failed to load.
   * The final tile takes the empty cells instead: a wider terminal is useful, a void never is.
   */
  const stretchLastRow = (): void => {
    const cells = [...wall.children] as HTMLElement[];
    for (const cell of cells) cell.style.removeProperty("grid-column");
    const perRow = resolveCols();
    const spare = cells.length % perRow;
    const last = cells.at(-1);
    // The ＋ seat is already the thing that fills a gap; widening it would make the picker the
    // biggest object on a wall of real work.
    if (!last || perRow < 2 || spare === 0 || last.classList.contains("term-plus")) return;
    last.style.gridColumn = `span ${perRow - spare + 1}`;
  };

  const paintCols = (group: HTMLElement): void => {
    const current = savedCols();
    group.querySelectorAll<HTMLElement>(".terms-col").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.cols === current);
    });
  };

  /* --------------------------------------------------------------- build bar */

  /**
   * A build is the one thing that happens to you rather than in front of you.
   *
   * Everything else on this screen is somewhere you went. A build starts, takes a minute, and
   * either lands on a simulator or fails — and until now the only place that said so was the Runs
   * tab, which is exactly the tab you are not on while you wait. So the bar rides above every
   * terminal: it appears when a run does, says which app and where it is, carries the four verbs
   * worth having (reload, restart, stop, go look), and disappears the moment nothing is live.
   *
   * Failed runs stay here until retried or closed. It is a READER. Run state lives in the runner
   * and nowhere else; setRuns() is the only way
   * anything gets in here.
   */
  const runTone = (state: string): { text: string; tone: string } => {
    switch (state) {
      case "launching":
        return { text: "launching", tone: "is-work" };
      case "building":
        return { text: "building", tone: "is-work" };
      case "running":
        return { text: "running", tone: "is-ok" };
      case "reloaded":
        return { text: "reloaded", tone: "is-ok" };
      case "restarted":
        return { text: "restarted", tone: "is-ok" };
      case "error":
      case "failed":
        return { text: "failed", tone: "is-risk" };
      default:
        return { text: state, tone: "is-mute" };
    }
  };

  /** What the bar was last painted from. A run's PTY talks constantly; repainting the same words
   *  on every chunk would restart the pulse animation a hundred times a build. */
  let runBarKey = "";

  const paintRunLauncher = (): void => {
    if (!openState || !runLauncher) return;
    const session = activePinned === null ? aimed() : null;
    const project = snapshot.find((project) => project.sessions.some((item) => item.id === session));
    const view = project ? events.runView(project.id) : null;
    runLauncher.hidden = !project || !view;
    if (!project || !view) return;
    if (runLauncher.dataset.project !== project.id) {
      runLauncher.dataset.project = project.id;
      const name = make("b", "terms-launch-name");
      name.textContent = project.name;
      const go = document.createElement("button");
      go.type = "button";
      go.className = "pt-go terms-launch-go";
      go.addEventListener("click", () => events.runApp(project.id));
      const note = document.createElement("button");
      note.type = "button";
      note.className = "terms-launch-note";
      note.title = "Open run details";
      note.addEventListener("click", () => events.runOpen(project.id));
      runLauncher.replaceChildren(name, events.runTargetPicker(project.id), go, note);
    }
    const go = runLauncher.querySelector<HTMLButtonElement>(".terms-launch-go")!;
    go.innerHTML = `${icon("play")}<span>${view.live ? "Rerun app" : "Run app"}</span>`;
    go.title = view.live
      ? `Hot restart, or rebuild if it has none · ${chordText("app.runApp")} · fresh build ${chordText("app.runFresh")}`
      : `Build on the selected target · ${chordText("app.runApp")}`;
    go.disabled = view.busy;
    const note = runLauncher.querySelector<HTMLButtonElement>(".terms-launch-note")!;
    note.textContent = view.error ?? (view.capacity ? "Simulator limit reached · open Runs" : "");
    note.hidden = !note.textContent;
  };

  const paintRunBar = (): void => {
    if (!openState) return;
    paintRunLauncher();
    // The Runs tab says all of this in full. Two copies of one run is two runs to a reader.
    const onRunsTab = activePinned !== null && !!events.pinned[activePinned]?.ownsRuns;
    const showing = runs.length > 0 && !onRunsTab;
    const key = showing
      ? runs
          .map((r) => `${r.project}|${r.instance}|${r.name}|${r.view.state}|${r.view.busy}|${r.view.ms}|${r.view.device}|${r.view.kind}`)
          .join("~")
      : "";
    if (key === runBarKey) return;
    runBarKey = key;
    runBar.hidden = !showing;
    if (!showing) {
      runBar.replaceChildren();
      return;
    }

    runBar.replaceChildren(
      ...runs.map(({ session, project, name, instance, view }) => {
        const strip = make("div", "terms-run");
        const { text, tone } = runTone(view.state);
        strip.classList.add(tone);

        const pill = make("span", "terms-run-state");
        pill.innerHTML = `<i aria-hidden="true"></i><b></b>`;
        pill.querySelector("b")!.textContent = view.busy ? "working…" : text;

        const who = make("button", "terms-run-name") as HTMLButtonElement;
        who.type = "button";
        who.title = `Open ${name} on the Runs tab`;
        // Two strips for one app differ only by seat, and the verbs here speak to the app's own
        // run — so say which copy this is instead of showing the same name twice.
        who.textContent = instance > 1 ? `${name} · ${instance}` : name;
        who.addEventListener("click", () => events.runOpen(project));

        const failed = view.state === "error" || view.state === "failed";
        const note = make("span", "terms-run-note");
        note.textContent = failed
          ? view.error ?? view.device
          : [view.device, view.ms ? `${(view.ms / 1000).toFixed(1)}s build` : ""]
              .filter(Boolean)
              .join(" · ");

        const verbs = make("span", "terms-run-verbs");
        const verb = (
          className: string,
          glyph: IconName,
          title: string,
          action: () => void,
        ): HTMLButtonElement => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = `terms-run-verb ${className}`;
          button.title = title;
          button.innerHTML = icon(glyph);
          button.addEventListener("click", action);
          return button;
        };
        // Only flutter hot-reloads. Offering the verb elsewhere is a button whose only outcome
        // is nothing happening.
        if (!failed && view.kind === "flutter") {
          verbs.append(
            verb("terms-run-reload", "reload", "Hot reload — injects the change and keeps state", () =>
              events.runNudge(session, false),
            ),
            verb("terms-run-restart", "rebuild", "Hot restart — rebuilds and reattaches", () =>
              events.runNudge(session, true),
            ),
          );
        }
        if (failed) {
          verbs.append(
            verb("terms-run-retry", "rebuild", "Choose a target before retrying", () => events.runRetry(session)),
            verb("terms-run-dismiss", "stop", "Close this failed run", () => events.runDismiss(session)),
          );
        } else {
          if (instance === 1 && view.canAddInstance) {
            verbs.append(
              verb("terms-run-extra", "play", "Choose a target for another instance", () =>
                events.runExtra(project),
              ),
            );
          }
          verbs.append(
            verb("terms-run-stop", "stop", "Stop this run", () => events.runStop(session)),
          );
        }
        verbs.append(
          verb("terms-run-out", "log", "Open the run output on the Runs tab", () =>
            events.runOpen(project),
          ),
        );

        strip.append(pill, who, note, verbs);
        return strip;
      }),
    );
  };

  const buildBar = (): HTMLElement => {
    const bar = make("header", "terms-bar");
    const title = make("span", "terms-name");
    title.innerHTML = `<i aria-hidden="true">${icon("terminal")}</i><b>Terminals</b>`;
    liveCount = make("span", "terms-live");
    pagesBox = make("span", "terms-pages");
    pagesBox.setAttribute("role", "group");
    pagesBox.setAttribute("aria-label", "Terminal dashboards");
    pagesBox.hidden = true;
    addButton = document.createElement("button");
    (addButton as HTMLButtonElement).type = "button";
    addButton.className = "terms-plus terms-add";
    addButton.hidden = true;
    addButton.setAttribute("aria-label", "add terminal");
    addButton.title = `New terminal — ${chordText("wall.picker")}`;
    addButton.addEventListener("click", () => openPicker());
    bar.append(title, liveCount, addButton, pagesBox);

    const cols = make("span", "terms-cols");
    cols.setAttribute("role", "group");
    cols.setAttribute("aria-label", "Wall columns");
    for (const value of COLS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "terms-col";
      button.dataset.cols = value;
      button.textContent = value;
      button.addEventListener("click", () => {
        localStorage.setItem(COLS_KEY, value);
        applyCols(value);
        paintCols(cols);
        // Same preference the Settings sheet edits — tell it, in case it is open behind this.
        window.dispatchEvent(new CustomEvent(PREFS_EVENT));
      });
      cols.append(button);
    }
    bar.append(cols);
    colsGroup = cols;
    paintCols(cols);
    return bar;
  };

  /** The dashboard tabs: one button per page of PAGE_SIZE terminals. Hidden with one page. */
  const paintPages = (count: number): void => {
    pagesBox.hidden = count < 2;
    pagesBox.replaceChildren();
    if (count < 2) return;
    for (let i = 0; i < count; i++) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `terms-page${i === page ? " is-active" : ""}`;
      button.textContent = String(i + 1);
      button.addEventListener("click", () => {
        if (page === i) return;
        page = i;
        zoomed = null;
        buildWall(snapshot);
      });
      pagesBox.append(button);
    }
  };

  /** Expand one tile onto the padded stage, or hand the wall back to the even grid. The
   *  tile is FLIP-animated between its old and new boxes so both directions stay smooth
   *  without animating grid tracks (which would continuously re-fit every live PTY). */
  const setZoom = (sessionId: string | null): void => {
    if (sessionId === zoomed) return;
    const movingId = sessionId ?? zoomed;
    const movingTile = movingId
      ? wall.querySelector<HTMLElement>(`[data-cell="${CSS.escape(movingId)}"]`)
      : null;
    const before = movingTile?.getBoundingClientRect();

    zoomed = sessionId;
    wall.classList.toggle("is-zoomed", zoomed !== null);
    wall.title = zoomed ? "Click the padding to shrink this terminal" : "";
    wall.querySelectorAll<HTMLElement>(".term-tile").forEach((tile) => {
      const on = tile.dataset.cell === zoomed;
      tile.classList.toggle("is-zoom", on);
      const button = tile.querySelector<HTMLElement>(".term-zoom");
      if (button) {
        button.textContent = on ? "⤡" : "⤢";
        button.setAttribute("aria-label", on ? "shrink terminal" : "expand terminal");
      }
    });

    if (movingTile && before && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const after = movingTile.getBoundingClientRect();
      if (before.width > 0 && before.height > 0 && after.width > 0 && after.height > 0) {
        const dx = before.left - after.left;
        const dy = before.top - after.top;
        const sx = before.width / after.width;
        const sy = before.height / after.height;
        movingTile.animate(
          [
            { transformOrigin: "top left", transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
            { transformOrigin: "top left", transform: "none" },
          ],
          { duration: 280, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
        );
      }
    }
    queueRefit();
    if (zoomed) events.focusPane(zoomed);
  };

  const updateLive = (projects: TerminalsProject[]): void => {
    const live = liveTerminals(projects);
    const text = `${live} live`;
    if (liveCount.textContent !== text) liveCount.textContent = text;
    liveCount.classList.toggle("is-live", live > 0);
  };

  /* --------------------------------------------------------------- ＋ pane */

  const projectIcon = (p: TerminalsProject): HTMLElement => {
    const ico = make("span", "plus-ico");
    // The main folder is no app: it has no icon to find, and a letter would read as a project.
    if (p.id === MAIN_ID) {
      ico.classList.add("is-folder");
      ico.innerHTML = icon("folder");
      return ico;
    }
    const glyph = make("span", "plus-glyph");
    glyph.textContent = p.name.trim().charAt(0).toUpperCase();
    ico.append(glyph);
    const img = document.createElement("img");
    img.src = projectIconUrl(p.id);
    img.alt = "";
    img.draggable = false;
    img.addEventListener("error", () => img.remove());
    ico.append(img);
    return ico;
  };

  /** Rebuild the picker only when its available projects change. */
  const plusKey = (): string =>
    snapshot
      .filter((p) => p.exists)
      .map((p) => `${p.id}:${p.name}`)
      .join("|");

  /** The projects proper: everything the picker offers except the main folder. */
  const plusProjects = (): TerminalsProject[] =>
    snapshot.filter((p) => p.exists && p.id !== MAIN_ID);

  /** The main folder, when it is on offer. It answers to its name and to its path, so typing the
   *  folder you mean finds it even when you never think of it as "main". */
  const plusMain = (): TerminalsProject | null => {
    const main = snapshot.find((p) => p.id === MAIN_ID && p.exists);
    if (!main) return null;
    const query = plusQuery.trim().toLowerCase();
    if (!query) return main;
    return `${main.name} ${main.path ?? ""}`.toLowerCase().includes(query) ? main : null;
  };

  /** A path as you would say it: your home is ~. */
  const homePath = (path = ""): string => path.replace(/^\/(Users|home)\/[^/]+/, "~");

  /** Projects the ＋ pane is offering right now. Ranked by WHERE the query hits the name, so
   *  typing "sh" puts Shopper above Flashcards instead of listing them in portfolio order. */
  const plusMatches = (): TerminalsProject[] => {
    const all = plusProjects();
    const query = plusQuery.trim().toLowerCase();
    if (!query) return all.sort((a, b) => a.name.localeCompare(b.name));
    return all
      .map((p) => ({ p, at: p.name.toLowerCase().indexOf(query) }))
      .filter(({ at }) => at >= 0)
      .sort((a, b) => a.at - b.at || a.p.name.localeCompare(b.p.name))
      .map(({ p }) => p);
  };

  /** Columns the ＋ pane's list gets: one count for the recent row and the grid, so they line up. */
  let plusColumns = 4;
  const measurePlus = (body: HTMLElement): void => {
    const width = Math.min(940, (body.clientWidth || 940) - 32) - 8;
    plusColumns = Math.max(1, Math.min(5, Math.floor((width + 8) / 208)));
  };

  /** Where you were last: one full row of it, the first thing to offer before any reading. */
  const plusRecent = (): TerminalsProject[] => {
    if (plusQuery.trim()) return [];
    const all = plusProjects();
    if (all.length <= plusColumns * 2 || plusColumns < 2) return [];
    return all
      .filter((p) => p.running || (p.lastActive ?? 0) > 0)
      .sort(
        (a, b) =>
          Number(b.running) - Number(a.running) ||
          (b.lastActive ?? 0) - (a.lastActive ?? 0) ||
          a.name.localeCompare(b.name),
      )
      .slice(0, plusColumns);
  };

  /** Every pickable seat in screen order: the main folder, recent cards, then the full list.
   *  ↩ takes `plusIndex`. */
  const plusEntries = (): TerminalsProject[] => {
    const main = plusMain();
    return [...(main ? [main] : []), ...plusRecent(), ...plusMatches()];
  };

  const since = (at?: number): string => {
    if (!at) return "";
    const minutes = Math.round((Date.now() - at) / 60_000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    const days = Math.round(hours / 24);
    return days < 30 ? `${days} d ago` : new Date(at).toLocaleDateString();
  };

  /** Repaint results without replacing the input and its caret. */
  const paintPlusBody = (
    body: HTMLElement,
    pick: (p: TerminalsProject, alt?: boolean) => void,
  ): void => {
    measurePlus(body);
    const main = plusMain();
    const recent = plusRecent();
    const list = plusMatches();
    const total = (main ? 1 : 0) + recent.length + list.length;
    const scroll = body.querySelector(".plus-results")?.scrollTop ?? 0;
    body.replaceChildren();
    if (plusIndex >= total) plusIndex = Math.max(0, total - 1);

    const results = make("div", "plus-results");
    results.style.setProperty("--plus-cols", String(plusColumns));
    let seat = 0;
    const button = (p: TerminalsProject, className: string): HTMLElement => {
      const at = seat++;
      const row = make("button", `${className}${at === plusIndex ? " is-on" : ""}`);
      (row as HTMLButtonElement).type = "button";
      row.dataset.seat = String(at);
      row.title = p.name;
      row.addEventListener("click", (event) => pick(p, event.altKey));
      row.addEventListener("mousemove", () => {
        if (plusIndex === at) return;
        plusIndex = at;
        results.querySelector(".is-on")?.classList.remove("is-on");
        row.classList.add("is-on");
      });
      return row;
    };
    const section = (label: string, count?: number): HTMLElement => {
      const head = make("div", "plus-section");
      head.textContent = label;
      if (count != null) {
        const n = make("span", "plus-section-count");
        n.textContent = String(count);
        head.append(n);
      }
      results.append(head);
      return head;
    };

    if (main) {
      const bar = button(main, "plus-main");
      bar.append(projectIcon(main));
      const text = make("span", "plus-card-text");
      const name = make("b", "plus-result-name");
      name.textContent = main.name;
      const where = make("small", "plus-main-path");
      where.textContent = homePath(main.path);
      text.append(name, where);
      bar.append(text);
      if (main.running) {
        const tag = make("small", "plus-card-when is-live");
        tag.textContent = "running";
        bar.append(tag);
      }
      results.append(bar);
    }

    if (recent.length) {
      section("Recent");
      const cards = make("div", "plus-cards");
      for (const p of recent) {
        const card = button(p, "plus-card");
        card.append(projectIcon(p));
        const text = make("span", "plus-card-text");
        const name = make("b", "plus-result-name");
        name.textContent = p.name;
        const when = make("small", `plus-card-when${p.running ? " is-live" : ""}`);
        when.textContent = p.running ? "running" : since(p.lastActive);
        text.append(name, when);
        card.append(text);
        cards.append(card);
      }
      results.append(cards);
      section(plusQuery.trim() ? "Matches" : "All projects", list.length);
    }

    const grid = make("div", "plus-grid");
    for (const p of list) {
      const row = button(p, "plus-result");
      row.append(projectIcon(p));
      const name = make("span", "plus-result-name");
      name.textContent = p.name;
      row.append(name);
      if (p.running) row.append(make("i", "plus-live"));
      grid.append(row);
    }
    results.append(grid);
    if (!list.length && !main) {
      const empty = make("small", "plus-empty");
      empty.textContent = plusQuery.trim()
        ? `No project matches “${plusQuery.trim()}”`
        : "Add a project first";
      results.append(empty);
    }
    const hint = make("small", "plus-hint");
    hint.textContent = PREF.plusShell()
      ? "↩ opens a shell in the selected project · ⌥↩ picks an engine"
      : "Arrows move · ↩ opens · Esc closes";
    body.append(results, hint);
    results.scrollTop = scroll;
  };

  /** Arrow keys over a grid: ←→ walk the order, ↑↓ go to the seat straight above or below. */
  const plusStep = (body: HTMLElement, key: string): number | null => {
    const seats = [...body.querySelectorAll<HTMLElement>("[data-seat]")];
    if (!seats.length) return null;
    const current = seats[plusIndex] ?? seats[0];
    if (key === "ArrowRight") return Math.min(seats.length - 1, plusIndex + 1);
    if (key === "ArrowLeft") return Math.max(0, plusIndex - 1);
    const from = current.getBoundingClientRect();
    const down = key === "ArrowDown";
    let best: { at: number; score: number } | null = null;
    seats.forEach((seat, at) => {
      const box = seat.getBoundingClientRect();
      const gap = down ? box.top - from.bottom : from.top - box.bottom;
      if (gap < -2) return;
      const across = Math.abs(box.left + box.width / 2 - (from.left + from.width / 2));
      const score = gap * 4 + across;
      if (!best || score < best.score) best = { at, score };
    });
    return best ? (best as { at: number }).at : plusIndex;
  };

  /** The empty seat: type to filter, arrows to select, Enter to open. */
  const paintPlusIdle = (pane: HTMLElement): void => {
    plusPicked = null;
    pane.dataset.v = plusKey();
    pane.classList.remove("is-launching");
    pane.replaceChildren();

    const search = document.createElement("input");
    search.type = "text";
    search.className = "plus-search";
    search.placeholder = PREF.plusShell() ? "Type a project — ↩ opens a shell" : "Type a project…";
    search.autocomplete = "off";
    search.spellcheck = false;
    search.setAttribute("aria-label", "find a project to open a terminal on");
    // A rebuild (a terminal closed somewhere else) makes a NEW input for the same scene —
    // it resumes the query rather than silently dropping what you were half-way through.
    search.value = plusQuery;
    const body = make("div", "plus-body");
    /** A project was chosen. Normally that opens the engine row; with "straight to a shell"
     *  on it IS the launch — a terminal in that folder, no question asked. ⌥ overrides either
     *  way, so the engines are always one modifier away. */
    const pick = (p: TerminalsProject, alt = false): void => {
      if (PREF.plusShell() && !alt) {
        void launch(pane, p.id, "shell");
        return;
      }
      paintPlusPicked(pane, p, true);
    };

    search.addEventListener("input", () => {
      plusQuery = search.value;
      plusIndex = 0;
      paintPlusBody(body, pick);
    });
    search.addEventListener("keydown", (event) => {
      const list = plusEntries();
      const arrows = ["ArrowDown", "ArrowUp"];
      // ←→ stay with the text while there is text to move through.
      if (!search.value) arrows.push("ArrowLeft", "ArrowRight");
      if (arrows.includes(event.key)) {
        if (!list.length) return;
        event.preventDefault();
        const next = plusStep(body, event.key);
        if (next == null || next === plusIndex) return;
        body.querySelector("[data-seat].is-on")?.classList.remove("is-on");
        plusIndex = next;
        const seat = body.querySelector<HTMLElement>(`[data-seat="${next}"]`);
        seat?.classList.add("is-on");
        seat?.scrollIntoView({ block: "nearest" });
        return;
      }
      if (event.key === "Enter") {
        if (!list.length) return;
        event.preventDefault();
        pick(list[plusIndex], event.altKey);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        dismissPicker();
      }
    });

    pane.append(search, body);
    paintPlusBody(body, pick);
    // A window or column change re-deals the grid only when the column count really changes.
    new ResizeObserver(() => {
      const before = plusColumns;
      measurePlus(body);
      if (body.isConnected && before !== plusColumns) paintPlusBody(body, pick);
    }).observe(body);
    appendCollapse(pane);
    // The caret goes in only when this seat is what you just asked for: an empty tab's whole
    // wall, or a picker you opened by hand. Never on a background rebuild, which would pull
    // you out of a terminal you were typing in.
    const wanted = pane.classList.contains("is-alone") || plusFocus;
    plusFocus = false;
    if (wanted) {
      requestAnimationFrame(() => {
        if (search.isConnected) search.focus();
      });
    }
  };

  /** A corner ×, only once the tab already has a terminal to fall back to — collapses the
   *  open picker back into the small add button rather than leaving an empty wall behind. */
  const appendCollapse = (pane: HTMLElement): void => {
    if (currentTab().sessionIds.size === 0) return;
    const collapse = document.createElement("button");
    collapse.type = "button";
    collapse.className = "plus-collapse";
    collapse.setAttribute("aria-label", "close add-terminal picker");
    collapse.textContent = "×";
    collapse.addEventListener("click", (event) => {
      event.stopPropagation();
      currentTab().plusOpen = false;
      buildWall(snapshot);
    });
    pane.append(collapse);
  };

  /** An icon was chosen: the same cell offers the three engines. */
  const paintPlusPicked = (
    pane: HTMLElement,
    p: TerminalsProject,
    takeCaret = false,
  ): void => {
    plusPicked = p.id;
    pane.replaceChildren();
    const chooser = make("div", "plus-chooser");
    const head = make("div", "plus-chosen");
    head.append(projectIcon(p));
    const label = make("b", "plus-chosen-name");
    label.textContent = p.name;
    head.append(label);
    // The main folder is a place, not a name you know: say where the terminal will stand.
    if (p.id === MAIN_ID) {
      const where = make("small", "plus-main-path");
      where.textContent = homePath(p.path);
      head.append(where);
    }
    const back = make("button", "plus-back");
    (back as HTMLButtonElement).type = "button";
    back.setAttribute("aria-label", "back to projects");
    back.textContent = "×";
    back.addEventListener("click", () => {
      plusFocus = true;
      paintPlusIdle(pane);
    });
    head.append(back);
    chooser.append(head);

    const row = make("div", "plus-engines");
    const seats: HTMLElement[] = [];
    const engineKeys = "1234567890";
    ENGINES.forEach((engine, index) => {
      const button = make("button", `plus-engine e-${engine.kind}`);
      (button as HTMLButtonElement).type = "button";
      button.innerHTML = `<i></i><span></span>`;
      button.querySelector("i")!.innerHTML = icon(engine.glyph);
      button.querySelector("span")!.textContent = engine.name;
      if (engine.sub) {
        const tag = make("small", "plus-engine-sub");
        tag.textContent = engine.sub;
        button.append(tag);
      }
      const key = engineKeys[index];
      button.title = key ? `${engine.name} — ${key}` : engine.name;
      button.addEventListener("click", () => void launch(pane, p.id, engine.kind));
      row.append(button);
      seats.push(button);
    });
    chooser.append(row);

    // Second half of the keyboard path: you arrived here with ↩, so ↩ has to be able to
    // finish the job. ←→ walk the engines, 1…9 and 0 select directly, Esc goes back to the
    // search with the query cleared.
    chooser.addEventListener("keydown", (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const at = seats.indexOf(document.activeElement as HTMLElement);
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault();
        const step = event.key === "ArrowRight" ? 1 : -1;
        const next = (((at < 0 ? 0 : at + step) % seats.length) + seats.length) % seats.length;
        seats[next].focus();
        return;
      }
      if (event.key.length === 1 && engineKeys.includes(event.key)) {
        const seat = seats[engineKeys.indexOf(event.key)];
        if (!seat) return;
        event.preventDefault();
        seat.click();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismissPicker();
      }
    });

    const hint = make("small", "plus-hint");
    hint.textContent = "1…9, 0 or ↩ · Esc goes back";
    chooser.append(hint);
    pane.append(chooser);
    appendCollapse(pane);
    // Land on the first engine so ↩ launches without a single extra keystroke — but only
    // when a human just arrived here, never on a rebuild that merely restored the scene.
    if (takeCaret) {
      requestAnimationFrame(() => {
        if (seats[0]?.isConnected) seats[0].focus();
      });
    }
  };

  const launch = async (pane: HTMLElement, projectId: string, kind: SessionKind): Promise<void> => {
    if (launching) return;
    launching = true;
    pane.classList.add("is-launching");
    const session = await events.start(projectId, kind);
    launching = false;
    plusPicked = null;
    // start() triggered a sync() which rebuilt the wall — `pane` may be a detached ancestor
    // by now, so settle whatever ＋ pane is CURRENTLY on the wall.
    const current = wall.querySelector<HTMLElement>(".term-plus");
    if (session) {
      plusQuery = "";
      plusIndex = 0;
      if (current) paintPlusIdle(current);
      bornSession = null;
      currentTab().sessionIds.add(session.id);
      currentTab().hadSession = true;
      currentTab().plusOpen = false;
      // A launch can spill onto a fresh page (the old one was full) — follow the newborn.
      page = pageOf(session.id);
      // Claim the caret BEFORE the build: buildWall's restoreFocus reads focusedSession, so
      // setting it here is what makes the newborn — not the first tile — the one you type into.
      setFocused(session.id);
      buildWall(snapshot);
      wall
        .querySelector(`.term-tile[data-session="${CSS.escape(session.id)}"]`)
        ?.classList.add("is-born");
      events.focusPane(session.id);
    } else if (current) {
      // The launch failed. Do NOT snap back to the idle picker as if nothing happened — say why,
      // so a missing binary or a bad folder is visible instead of a silent reset.
      paintPlusError(current, events.lastError?.() ?? "");
    }
  };

  /** A launch that returned no session: keep the ＋ pane, but show the reason and a way back. */
  const paintPlusError = (pane: HTMLElement, reason: string): void => {
    plusPicked = null;
    pane.replaceChildren();
    const box = make("div", "plus-error");
    const title = make("b", "plus-error-title");
    title.textContent = "Couldn't start the terminal";
    const msg = make("small", "plus-error-msg");
    msg.textContent = reason || "The agent did not start. Check that its CLI is installed, then try again.";
    const back = make("button", "plus-error-back");
    (back as HTMLButtonElement).type = "button";
    back.textContent = "Try again";
    back.addEventListener("click", () => paintPlusIdle(pane));
    box.append(title, msg, back);
    pane.append(box);
    appendCollapse(pane);
  };

  /** A wall rebuild must not eat a choice in progress: the fresh pane resumes the scene the
   *  old one was showing — mid-launch, mid-choice, or the idle sky. Only called while the
   *  picker is actually meant to be on screen (buildWall gates on showPlus). */
  const buildPlusPane = (alone: boolean): HTMLElement => {
    const pane = make("article", `term-plus${alone ? " is-alone" : ""}`);
    const picked = plusPicked ? snapshot.find((p) => p.exists && p.id === plusPicked) : undefined;
    if (launching) {
      pane.classList.add("is-launching");
      const note = make("small", "plus-hint");
      note.textContent = "Starting…";
      pane.append(note);
      appendCollapse(pane);
    } else if (picked) {
      paintPlusPicked(pane, picked);
    } else {
      paintPlusIdle(pane);
    }
    return pane;
  };

  /* ----------------------------------------------------------------- wall */

  /**
   * The engine, as one character inside its coloured badge.
   *
   * The dot was colour and nothing else, which fails twice: a tab running one engine paints nine
   * identical dots, and Claude's hue IS the app accent — the same colour the focus ring uses. A
   * letter carries the same fact without a legend, and survives being colourblind.
   *
   * "X" for codex and "M" for GLM are chosen against the other letters, not from the name: two
   * engines starting with C, two with G, and a badge this small has room for one glyph.
   */
  const KIND_LETTER: Record<string, string> = {
    claude: "C",
    codex: "X",
    grok: "G",
    kimi: "K",
    glm: "M",
    opencode: "O",
    shell: "$",
    task: "T",
    sim: "▶",
  };
  const kindLetter = (kind: string): string => KIND_LETTER[kind] ?? kind.charAt(0).toUpperCase();

  /** The state dot, and the tile class the wall styles from. Dead outranks everything — an
   *  exited pane is not mid-turn no matter what its last status said. */
  /** The head's memory figure, its sleep button, and whether an ended pane is only asleep. */
  const paintTileMemory = (tile: HTMLElement, sessionId: string, dead: boolean): void => {
    const memory = dead ? null : (events.memoryOf?.(sessionId) ?? null);
    const figure = tile.querySelector<HTMLElement>(".term-mem");
    if (figure) {
      figure.hidden = memory?.bytes == null;
      figure.textContent = memory?.bytes == null ? "" : formatBytes(memory.bytes);
      figure.title = "This terminal's memory, with the servers and builds it started";
    }
    const sleep = tile.querySelector<HTMLButtonElement>(".term-sleep");
    if (sleep) {
      sleep.hidden = !memory?.canSleep;
      sleep.title =
        `Sleep${memory?.bytes ? `, giving back ${formatBytes(memory.bytes)}` : ""}. ` +
        "The pane stays, and Wake picks the same conversation back up.";
    }
    const ended = tile.querySelector<HTMLElement>(".term-ended");
    if (ended) ended.textContent = events.isAsleep?.(sessionId) ? "asleep" : "ended";
  };

  const paintPhase = (tile: HTMLElement, sessionId: string, dead: boolean): void => {
    const phase = dead ? "idle" : (events.phaseOf?.(sessionId) ?? "idle");
    tile.classList.toggle("is-work", phase === "work");
    tile.classList.toggle("is-ask", phase === "ask");
    const dot = tile.querySelector<HTMLElement>(".term-state");
    if (dot) dot.title = phase === "work" ? "working" : phase === "ask" ? "waiting on you" : "";
  };

  /** Where this session is standing, asked of the OS once and kept. The answer is the folder's
   *  own name — the full path is a runway, and on a monorepo the last segment is the point. */
  const askFolder = (sessionId: string): void => {
    if (!events.cwdOf || folders.has(sessionId)) return;
    folders.set(sessionId, null); // claim it now: a rebuild mid-flight must not ask twice
    void events.cwdOf(sessionId).then((path) => {
      const leaf = path?.split("/").filter(Boolean).pop() ?? null;
      if (!leaf) return;
      folders.set(sessionId, leaf);
      // The tile may be off-page or already gone. Repainting the label in place is the whole
      // update — a rebuild here would tear down live panes for a word.
      const tag = wall.querySelector<HTMLElement>(
        `.term-tile[data-session="${CSS.escape(sessionId)}"] .term-title`,
      );
      const session = flatSessions(snapshot).find(({ session: s }) => s.id === sessionId)?.session;
      if (tag && session) tag.textContent = tagOf(session);
      if (tabbed()) paintTermBar();
    });
  };

  const buildTile = (p: TerminalsProject, session: Session, seat: number): HTMLElement => {
    const dead = events.isExited(session.id);
    const tile = make(
      "article",
      `term-tile${dead ? " is-dead" : ""}` +
        `${session.id === zoomed ? " is-zoom" : ""}` +
        `${session.id === focusedSession ? " is-focused" : ""}`,
    );
    tile.dataset.session = session.id;
    tile.dataset.cell = session.id;
    if (session.id === bornSession) {
      tile.classList.add("is-born");
      bornSession = null;
    }
    askFolder(session.id);

    // The head names the pane four times over, cheapest cue first: the seat number, the app's
    // own icon (with the engine lettered on its corner), the project, then the tag. The letter
    // under the icon is what shows until — or unless — the real one loads.
    const head = make("div", "term-tile-head");
    head.innerHTML =
      `<span class="term-seat">${seat}</span>` +
      `<span class="term-logo"><span class="term-logo-glyph"></span>` +
      `<i class="term-kind-dot k-${session.kind}" title="${session.kind}">${kindLetter(session.kind)}</i>` +
      `</span>` +
      `<b class="term-project"></b><span class="term-title"></span>` +
      `<i class="term-state" aria-hidden="true"></i>` +
      `<span class="term-ended"${dead ? "" : " hidden"}>ended</span>` +
      `<span class="term-mem" hidden></span>`;
    const logo = head.querySelector<HTMLElement>(".term-logo")!;
    logo.querySelector<HTMLElement>(".term-logo-glyph")!.textContent =
      p.name.trim().charAt(0).toUpperCase();
    const logoImg = document.createElement("img");
    logoImg.src = projectIconUrl(p.id);
    logoImg.alt = "";
    logoImg.draggable = false;
    logoImg.addEventListener("error", () => logoImg.remove());
    logo.append(logoImg);
    head.querySelector<HTMLElement>(".term-project")!.textContent = p.name;
    const tag = head.querySelector<HTMLElement>(".term-title")!;
    tag.textContent = tagOf(session);
    tag.title = "double-click to rename this terminal";
    // The rest of the head is a door into the project. The tag is not — a first click on the
    // way to a double one must not navigate the screen out from under the rename.
    tag.addEventListener("click", (event) => event.stopPropagation());
    // Renaming a terminal is the same gesture as renaming a tab, on the same kind of tag. The
    // field stands in place of the label; ↩ keeps it, Esc and blur drop it. An empty name is how
    // you take yours back off and fall to the folder or the engine again.
    tag.addEventListener("dblclick", (event) => {
      event.stopPropagation(); // the head is a door into the project
      const field = document.createElement("input");
      field.className = "term-title-input";
      field.value = names.get(session.id) ?? "";
      field.placeholder = tagOf(session);
      field.spellcheck = false;
      // A draggable ancestor eats mouse selection inside the field, so the head stops being a
      // drag handle for as long as the name is being typed.
      head.draggable = false;
      const done = (keep: boolean): void => {
        if (field.parentElement !== head) return;
        head.draggable = true;
        if (keep) {
          const next = field.value.trim();
          if (next) names.set(session.id, next);
          else names.delete(session.id);
          saveNames();
        }
        field.replaceWith(tag);
        tag.textContent = tagOf(session);
        events.focusPane(session.id);
      };
      field.addEventListener("keydown", (key) => {
        key.stopPropagation(); // the wall's chords must not read a name being typed
        if (key.key === "Enter") done(true);
        else if (key.key === "Escape") done(false);
      });
      field.addEventListener("blur", () => done(true));
      tag.replaceWith(field);
      field.focus();
      field.select();
    });
    if (!dead && events.skills && (session.kind === "claude" || session.kind === "codex")) {
      const skills = document.createElement("button");
      skills.type = "button";
      skills.className = "term-skills";
      skills.textContent = "Skills";
      skills.title = `${session.kind} session skills and shared workflows`;
      skills.addEventListener("click", (event) => {
        event.stopPropagation();
        events.skills?.(session.id);
      });
      head.append(skills);
    }
    if (events.sleep) {
      const sleep = document.createElement("button");
      sleep.type = "button";
      sleep.className = "term-sleep";
      sleep.setAttribute("aria-label", "put this agent to sleep");
      sleep.textContent = "☾";
      sleep.hidden = true;
      sleep.addEventListener("click", (event) => {
        event.stopPropagation(); // the head underneath would jump into the project
        events.sleep?.([session.id]);
      });
      head.append(sleep);
    }
    const zoom = document.createElement("button");
    zoom.type = "button";
    zoom.className = "term-zoom";
    const zoomedNow = session.id === zoomed;
    zoom.setAttribute("aria-label", zoomedNow ? "shrink terminal" : "expand terminal");
    zoom.title = zoomedNow ? `Shrink back into the wall — Esc` : `Fill the wall with this terminal — ${chordText("term.zoom")}`;
    zoom.textContent = zoomedNow ? "⤡" : "⤢";
    zoom.addEventListener("click", (event) => {
      event.stopPropagation(); // the head underneath would jump into the project
      setZoom(zoomed === session.id ? null : session.id);
    });
    head.append(zoom);
    const move = document.createElement("button");
    move.type = "button";
    move.className = "term-move";
    move.setAttribute("aria-label", "move terminal to another tab");
    move.title =
      `Move to another tab — ${chordText("term.moveToTab")}, or drag this head onto a tab`;
    move.textContent = "⇄";
    move.addEventListener("click", (event) => {
      event.stopPropagation();
      moveMenu(tile, session.id);
    });
    head.append(move);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "term-close";
    close.setAttribute("aria-label", "close session");
    close.title = "Close this terminal";
    close.textContent = "×";
    close.addEventListener("click", (event) => {
      event.stopPropagation(); // the head underneath would also jump
      events.close(p.id, session.id);
    });
    head.append(close);
    // The whole head is a door into the session; the body below stays a real terminal,
    // so clicks there must reach the PTY, never navigate.
    head.addEventListener("click", () => events.jump(p.id, session.id));
    head.title = `open ${p.name} — ${session.title} · drag onto a tab to move it`;
    // The head is also the terminal's handle: drag it onto any tab to re-home the session.
    // The body can't be the handle — that's the PTY, and a drag there is a text selection.
    head.draggable = true;
    head.addEventListener("dragstart", (event) => {
      dragging = session.id;
      tile.classList.add("is-dragging");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", session.title);
      }
    });
    head.addEventListener("dragend", () => {
      dragging = null;
      tile.classList.remove("is-dragging");
      tabsBar.querySelectorAll(".is-drop").forEach((node) => node.classList.remove("is-drop"));
    });
    tile.append(head);
    paintPhase(tile, session.id, dead);
    paintTileMemory(tile, session.id, dead);

    const body = make("div", "term-tile-body");
    // Clicking into a pane makes it the caret's home, so Ctrl+Tab carries on from there
    // rather than from wherever it last landed. focusin covers every other way in — the ⌘-ladder,
    // arrows, a launch — so the ring always names the pane the keyboard is actually in, instead
    // of only the one that was last clicked.
    body.addEventListener("mousedown", () => setFocused(session.id));
    body.addEventListener("focusin", () => setFocused(session.id));
    tile.append(body);
    events.adopt(session.id, body);
    return tile;
  };

  /* ----------------------------------------------------------- notice band */

  const OUTCOMES = new Map([
    ["progress", "in progress"],
    ["done", "done"],
    ["blocked", "blocked"],
    ["needs_decision", "needs you"],
  ]);

  /** What the bar says beside the title: whose project, where the work stands, how many
   *  pictures. Folded, this line is the entire report. */
  const noticeMeta = (notice: VisualNotice): string => {
    const parts = [notice.projectName];
    if (OUTCOMES.has(notice.outcome)) parts.push(OUTCOMES.get(notice.outcome)!);
    if (notice.shots.length) {
      parts.push(notice.shots.length === 1 ? "1 shot" : `${notice.shots.length} shots`);
    }
    return parts.join(" · ");
  };

  const unfold = (notice: VisualNotice): void => {
    // One report open at a time. Two of them stacked is a wall you can no longer see, and the
    // one you just clicked is the one you meant.
    for (const id of currentTab().noticeIds) unfolded.delete(id);
    unfolded.add(notice.id);
    paintNotices();
  };

  /**
   * A folded report: one pill in a single row along the top of the wall.
   *
   * Folded reports used to be full-width bars stacked on each other, which meant three of them
   * hid the top row of terminals for as long as you left them there. A row of pills is one line
   * high no matter how many there are, and clicking one is the whole gesture to get it back.
   */
  const buildPill = (notice: VisualNotice): HTMLElement => {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "term-note-pill";
    pill.dataset.note = notice.id;
    pill.setAttribute("aria-expanded", "false");
    pill.title = `${notice.title} — ${noticeMeta(notice)}`;
    pill.innerHTML =
      `<span class="term-note-glyph">◳</span>` +
      `<b class="term-note-who"></b>` +
      `<span class="term-note-title"></span>` +
      (notice.shots.length ? `<span class="term-note-n"></span>` : "");
    pill.querySelector<HTMLElement>(".term-note-who")!.textContent =
      notice.author || notice.projectName;
    pill.querySelector<HTMLElement>(".term-note-title")!.textContent = notice.title;
    const count = pill.querySelector<HTMLElement>(".term-note-n");
    if (count) count.textContent = `◫ ${notice.shots.length}`;
    pill.addEventListener("click", () => unfold(notice));
    return pill;
  };

  /**
   * The open report, lying over the wall.
   *
   * Two hit targets and no small ones. The bar is the fold — the whole width of it, so putting a
   * report away is a click anywhere along the top rather than at a glyph. Each picture is the
   * other, and it opens the lightbox at itself, which is the only place a screenshot is worth
   * looking at properly. There is deliberately no door into the editor or the project: this is
   * the surface you read a report ON, and every trip out of it was a trip you had to walk back.
   */
  const buildNotice = (notice: VisualNotice): HTMLElement => {
    const card = make("section", "term-note is-open");
    card.dataset.note = notice.id;

    const bar = make("div", "term-note-bar");
    const fold = document.createElement("button");
    fold.type = "button";
    fold.className = "term-note-fold";
    fold.setAttribute("aria-expanded", "true");
    fold.title = "Fold this report away — Esc";
    fold.innerHTML =
      `<span class="term-note-glyph">◳</span>` +
      `<b class="term-note-who"></b>` +
      `<span class="term-note-title"></span>` +
      `<span class="term-note-meta"></span>` +
      `<span class="term-note-caret">⌃</span>`;
    fold.querySelector<HTMLElement>(".term-note-who")!.textContent =
      notice.author || notice.projectName;
    fold.querySelector<HTMLElement>(".term-note-title")!.textContent = notice.title;
    fold.querySelector<HTMLElement>(".term-note-meta")!.textContent = noticeMeta(notice);
    fold.addEventListener("click", () => {
      unfolded.delete(notice.id);
      paintNotices();
      // The caret was in a terminal before this click and belongs back in it — a pill holding
      // the keyboard would swallow the next thing you typed.
      restoreFocus();
    });
    bar.append(fold);

    const close = document.createElement("button");
    close.type = "button";
    close.className = "term-note-x";
    close.setAttribute("aria-label", "dismiss report");
    // Say what dismissing costs, because it costs nothing: the Inbox keeps the message.
    close.title = "Dismiss — the Inbox keeps it";
    close.textContent = "×";
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      dismissNotice(notice.id);
      restoreFocus();
    });
    bar.append(close);
    card.append(bar);

    const body = make("div", "term-note-body");
    if (notice.text.trim()) body.append(prose(notice.text, "term-note-text"));

    if (notice.shots.length) {
      const strip = make("div", `term-note-strip count-${Math.min(notice.shots.length, 4)}`);
      const shots: LightboxShot[] = notice.shots.map((shot) => ({
        project: notice.project,
        path: shot.path,
        caption: shot.caption,
      }));
      notice.shots.forEach((shot, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "term-note-shot";
        button.title = shot.caption || "Expand — ←/→ walks the set, Esc closes";
        const image = projectImage(notice.project, shot.path, shot.caption || "");
        image.className = "term-note-img";
        button.append(image);
        if (shot.caption) {
          const cap = make("i", "term-note-cap");
          cap.textContent = shot.caption;
          button.append(cap);
        }
        button.addEventListener("click", () => showLightbox(shots, index));
        strip.append(button);
      });
      body.append(strip);
    }

    if (!body.childElementCount) {
      const empty = make("p", "term-note-text is-empty");
      empty.textContent = "The agent sent no words and no pictures with this one.";
      body.append(empty);
    }
    card.append(body);
    return card;
  };

  /**
   * Repaint the band: the folded reports as one row of pills, then whichever is open beneath it.
   * Newest first in both.
   *
   * Only when something actually changed — repainting an unchanged band would re-create every
   * <img> and flash the pictures on every status tick.
   */
  const paintNotices = (): void => {
    const mine = activeNotices();
    const key =
      `${currentTab().id}|` +
      mine.map((notice) => `${notice.id}${unfolded.has(notice.id) ? "+" : "-"}`).join(",");
    if (key === noticeKey) return;
    noticeKey = key;
    const newestFirst = [...mine].reverse();
    const folded = newestFirst.filter((notice) => !unfolded.has(notice.id));
    const parts: HTMLElement[] = [];
    if (folded.length) {
      const pills = make("div", "term-note-pills");
      pills.append(...folded.map(buildPill));
      parts.push(pills);
    }
    parts.push(...newestFirst.filter((notice) => unfolded.has(notice.id)).map(buildNotice));
    noticeBand.replaceChildren(...parts);
    noticeBand.hidden = mine.length === 0;
  };

  /** (Re)build the grid and adopt every pane, ＋ pane last. The one expensive path — sync()
   *  only comes here when the set of sessions actually changed. */
  const buildWall = (projects: TerminalsProject[]): void => {
    renderedKey = sessionKey(projects);
    // Park every pane under the deck first: replaceChildren() would otherwise detach the
    // mounts of tiles that are not on this page and their screens would leave the DOM.
    events.park();
    wall.replaceChildren();

    const all = activeSessions(projects);
    if (zoomed && !all.some(({ session }) => session.id === zoomed)) zoomed = null;
    // An empty tab has nowhere else to show the picker, so it's forced open; otherwise the
    // wall only spends a cell on it when the header's ＋ button was actually clicked.
    const alone = all.length === 0;
    const showPlus = alone || currentTab().plusOpen;
    const tabsLayout = tabbed();
    builtLayout = termLayout();
    wall.dataset.layout = builtLayout;
    const pageCount = tabsLayout
      ? 1
      : Math.max(1, Math.ceil((all.length + (showPlus ? 1 : 0)) / PAGE_SIZE));
    if (page >= pageCount) page = pageCount - 1;
    paintPages(pageCount);

    if (tabsLayout) {
      // One terminal on the stage, or the picker in its place. The rest stay parked and live.
      const shown = showPlus ? null : shownId();
      const at = all.findIndex(({ session }) => session.id === shown);
      if (at >= 0) {
        const { p, session } = all[at];
        if (focusedSession !== session.id) {
          focusedSession = session.id;
          currentTab().focused = session.id;
        }
        wall.append(buildTile(p, session, at + 1));
      }
    } else {
      // The seat number is the tab's join order, counted across every page — so a terminal
      // keeps its number when the wall re-flows, and "the 4th one" means one terminal for good.
      const from = page * PAGE_SIZE;
      all.slice(from, from + PAGE_SIZE).forEach(({ p, session }, index) => {
        wall.append(buildTile(p, session, from + index + 1));
      });
    }
    paintTermBar();
    // The band belongs to the tab, not to the grid under it — a rebuild is also how a tab switch
    // arrives, so this is where the right tab's reports come up.
    paintNotices();
    // The ＋ pane is the first free cell, so it lives on the last page only.
    if (showPlus && page === pageCount - 1) wall.append(buildPlusPane(alone));
    wall.classList.toggle("is-zoomed", zoomed !== null);
    addButton.hidden = alone || currentTab().plusOpen;
    // Before the frame is shown, not inside the rAF below: a wall that paints once with nothing
    // lit and then lights a tile is a flash, and the eye reads a flash as a change.
    ensureFocused();
    // Every route into the wall passes through here — a launch, a move between tabs, a close.
    // Guarded on the value, so an unchanged layout is not written.
    saveTabs();

    // Fit only after the grid has laid out — fitting into unmeasured cells measures zero.
    requestAnimationFrame(() => {
      stretchLastRow();
      events.refit();
      // Last: the ＋ pane's own rAF (queued during the build above, so it runs first) may have
      // claimed the caret, and restoreFocus() stands down when it did.
      restoreFocus();
    });
  };

  /** The cheap path: ended-state in place. Panes never move; the ＋ pane keeps its scene. */
  const updateWallStates = (projects: TerminalsProject[]): void => {
    paintTermBarStates();
    for (const p of projects) {
      for (const session of p.sessions) {
        const tile = wall.querySelector<HTMLElement>(
          `.term-tile[data-session="${CSS.escape(session.id)}"]`,
        );
        if (!tile) continue;
        const dead = events.isExited(session.id);
        tile.classList.toggle("is-dead", dead);
        const ended = tile.querySelector<HTMLElement>(".term-ended");
        if (ended) ended.hidden = !dead;
        // This is the path a status tick takes — a turn starting or ending never changes the
        // session list, so the wall is never rebuilt for one. The dot has to be painted here or
        // it is painted never.
        paintPhase(tile, session.id, dead);
        paintTileMemory(tile, session.id, dead);
      }
    }
    paintMeter();
    // The icon set can change (project added/renamed) — refresh an IDLE ＋ pane only when it
    // actually did; repainting on every status tick restarts the drift and the sky twitches.
    // A pane mid-choice or mid-launch is never yanked out of the human's hands.
    const pane = wall.querySelector<HTMLElement>(".term-plus");
    // …and never while something is typed into it: repainting the seat rebuilds the input and
    // takes the query, the caret and the highlight with it.
    if (pane && plusPicked === null && !launching && !plusQuery && pane.dataset.v !== plusKey()) {
      paintPlusIdle(pane);
    }
  };

  /* --------------------------------------------------------------- handle */

  return {
    open(projects, at) {
      window.removeEventListener("resize", onWindowResize);
      window.removeEventListener("focus", onWindowFocus);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener(PREFS_EVENT, onSettings);
      window.removeEventListener(KEYMAP_EVENT, onKeymap);
      observer?.disconnect();

      openState = true;
      snapshot = projects;
      prune(projects);
      // Companies first: a session can only be filed into its company's tab if that tab exists.
      ensureGroupTabs(projects);
      ensureAssigned(projects);
      reap();
      host.hidden = false;
      if (at !== undefined && at >= 0 && at < stripCount()) {
        activePinned = at < pinnedCount() ? at : null;
        if (at >= pinnedCount()) activeTab = at - pinnedCount();
      }
      // Leaving the workspace tore the wall down (clear()), so this is a cold build — pick the
      // tab's remembered terminal back up, and the page it sits on, before anything is laid out.
      // Without this, coming back always dumps the caret on the first tile.
      focusedSession = activePinned === null ? currentTab().focused : null;
      page = 0;
      if (focusedSession) page = pageOf(focusedSession);

      const inner = make("div", "terms-inner is-enter");
      tabsBar = buildTabsBar();
      termBar = make("div", "terms-ttabs");
      termBar.setAttribute("role", "tablist");
      termBar.setAttribute("aria-label", "Terminals in this tab");
      termBar.hidden = true;
      runBar = make("div", "terms-runbar");
      runBar.hidden = true;
      runBarKey = "";
      runLauncher = make("div", "terms-launcher");
      runLauncher.hidden = true;
      toolbar = buildBar();
      wall = make("div", "terms-wall");
      wall.addEventListener("click", (event) => {
        // In zoom mode the grid's padding belongs to the wall, not the terminal tile.
        if (zoomed && event.target === wall) setZoom(null);
      });
      // The band is a layer over the wall, not a row of it: same box, absolute, so an arriving
      // report never re-flows a terminal or costs the grid a cell.
      noticeBand = make("div", "term-notices");
      noticeBand.hidden = true;
      noticeKey = "";
      stack = make("div", "terms-stack");
      stack.append(wall, noticeBand);
      // Borrow each pinned module's element into the strip and remember where to put it back.
      // They are siblings of the wall, not tiles: exactly one body is ever visible.
      pinnedPanes = events.pinned.map((entry) => entry.pane());
      pinnedHomes = pinnedPanes.map((pane) => pane.parentElement);
      pinnedShown = events.pinned.map(() => false);
      inner.append(tabsBar, termBar, runLauncher, runBar, toolbar, ...pinnedPanes, stack);
      host.replaceChildren(inner);
      paintTabs();
      updateLive(projects);
      applyCols(savedCols());
      buildWall(projects);
      paintSide();

      // The wall's box changes with the window and the sidebar; every change re-fits panes.
      observer = new ResizeObserver(() => queueRefit());
      observer.observe(wall);
      window.addEventListener("resize", onWindowResize);
      window.addEventListener("focus", onWindowFocus);
      window.addEventListener(PREFS_EVENT, onSettings);
      window.addEventListener(KEYMAP_EVENT, onKeymap);
      // Capture phase: a focused xterm pane sees keydown first, and we must claim the chord
      // before it decides whether to swallow it.
      window.addEventListener("keydown", onKey, true);
    },

    showVisual(notice) {
      if (!openState) return;
      showNotice(notice);
    },

    sync(projects) {
      if (!openState) return;
      snapshot = projects;
      prune(projects);
      // Companies first: a session can only be filed into its company's tab if that tab exists.
      ensureGroupTabs(projects);
      ensureAssigned(projects);
      // A terminal closing anywhere can retire its whole tab — the strip has to repaint with
      // the wall, not on the next click.
      const swept = reap();
      updateLive(projects);
      if (swept || sessionKey(projects) !== renderedKey) paintTabs();
      if (swept || sessionKey(projects) !== renderedKey) buildWall(projects);
      else updateWallStates(projects);
    },

    clear() {
      observer?.disconnect();
      observer = null;
      window.removeEventListener("resize", onWindowResize);
      window.removeEventListener("focus", onWindowFocus);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener(PREFS_EVENT, onSettings);
      window.removeEventListener(KEYMAP_EVENT, onKeymap);
      // Hand the borrowed elements back BEFORE emptying the host — replaceChildren() would
      // otherwise take nodes we only borrowed out of the document with them.
      events.pinned.forEach((entry, index) => {
        if (!pinnedShown[index]) return;
        pinnedShown[index] = false;
        entry.hide();
      });
      pinnedPanes.forEach((pane, index) => {
        pane.hidden = true;
        (pinnedHomes[index] ?? document.body).append(pane);
      });
      pinnedPanes = [];
      pinnedHomes = [];
      host.replaceChildren();
      host.hidden = true;
      openState = false;
      // Reports are a glance over the wall, not state worth carrying: the Inbox is where they
      // live. Leaving them parked would greet you with yesterday's screenshots on the way back.
      notices.clear();
      unfolded.clear();
      noticeKey = "";
      for (const tab of tabs) tab.noticeIds = [];
      renderedKey = "";
      plusPicked = null;
      page = 0;
      zoomed = null;
      focusedSession = null;
      renamingTab = null;
      runBarKey = "";
    },

    isOpen: () => openState,

    focusedProject() {
      if (!openState || activePinned !== null) return null;
      const target = aimed();
      if (!target) return null;
      return visibleSessions().find(({ session }) => session.id === target)?.p.id ?? null;
    },

    focusedSession() {
      return openState && activePinned === null ? aimed() : null;
    },

    reveal(sessionId) {
      if (!openState) return false;
      const at = tabs.findIndex((tab) => tab.sessionIds.has(sessionId));
      if (at < 0) return false;
      switchTab(at);
      showTerminal(sessionId);
      return true;
    },

    setRuns(next) {
      runs = next;
      paintRunBar();
    },

    refile(projects, projectId) {
      snapshot = projects;
      // The company may have had no projects a second ago, and so no tab.
      ensureGroupTabs(projects);
      const moved = projects.find((p) => p.id === projectId);
      const target = moved ? tabForGroup(moved.group) : null;
      // No destination — filed under no company, or a company the strip is not splitting on.
      // Leaving the terminals where they sit beats scattering them into whatever tab is up.
      if (!moved || !target) return;
      let changed = false;
      for (const { id } of moved.sessions) {
        for (const tab of tabs) {
          if (tab !== target && tab.sessionIds.delete(id)) changed = true;
        }
        if (!target.sessionIds.has(id)) {
          target.sessionIds.add(id);
          target.hadSession = true;
          changed = true;
        }
      }
      if (!changed) return;
      saveTabs();
      if (!openState) return;
      reap();
      paintTabs();
      buildWall(projects);
    },

    paintMemory() {
      if (!openState) return;
      wall.querySelectorAll<HTMLElement>(".term-tile").forEach((tile) => {
        const id = tile.dataset.session ?? "";
        paintTileMemory(tile, id, events.isExited(id));
      });
      paintMeter();
    },

    select: (at) => (openState ? selectStrip(at) : false),

    count: stripCount,
    digit: (at) => {
      if (!openState || !rowUp()) return false;
      // Bounds are the row's: with three terminals, ⌘6 is nobody's, not the strip's sixth tab.
      const target = activeSessions(snapshot)[at];
      if (target) showTerminal(target.session.id);
      return true;
    },

    pinnedAt: () => (openState ? activePinned : null),

    closeActive() {
      if (!openState) return false;
      if (activePinned !== null) return events.pinned[activePinned].closeActive();
      // ⌘W follows visual stacking: close the add-terminal surface, never the live PTY beneath.
      if (dismissPicker()) return true;
      // An open report is what ⌘W means while it is up — putting a picture away is free, and
      // closing the terminal underneath it would not be.
      if (foldTopNotice()) {
        restoreFocus();
        return true;
      }
      const visible = visibleSessions();
      if (!currentTab().sessionIds.size && tabs.length > 1) {
        closeTab(activeTab);
        return true;
      }
      const target =
        visible.find(({ session }) => session.id === (zoomed ?? focusedSession)) ?? visible[0];
      if (!target) return false;
      events.close(target.p.id, target.session.id);
      return true;
    },
  };
}
