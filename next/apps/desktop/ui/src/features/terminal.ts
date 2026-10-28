/**
 * One PTY per SESSION, all alive at once.
 *
 * It used to be one per project, and the project could only ever run `claude` — so the box at
 * the bottom of the window was not a terminal you could use, it was a window onto the one agent
 * you were allowed. Open a shell and you killed the agent. Let the agent exit and the box went
 * dead with nothing to type into. That is what "the terminal breaks" was.
 *
 * Now a session is the unit: a project holds as many as you open, of either kind, and switching
 * project or session only changes which mount is VISIBLE. Nothing is torn down to look elsewhere.
 *
 * Hidden terminals are the trap: a hidden element has zero width, and xterm asked to fit into
 * zero width thrashes its measure loop (that is the "Measure loop restarted more than 5 times"
 * warning). So fitting is skipped while hidden and done once on show.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { IS_MAC, matches, matchesShortcut, label as chordLabel } from "./keymap";
import { projectIconUrl } from "../project-assets";
import { PLACE_IN_TEXT, parsePlace, type Place } from "../deeplink";
import "@xterm/xterm/css/xterm.css";

type TerminalChunk = {
  terminalId: string;
  data: string;
  closed: boolean;
};

/*
 * xterm paints to a canvas, so — unlike the CodeMirror editor — it cannot read the app's CSS
 * variables. We keep one palette per theme and swap `term.options.theme` when the app theme
 * flips (main.ts fires a `panel-theme-change` event on window; the deck listens below).
 * The ANSI colours are the shell's own semantics: red = --risk, green = --ok, blue = --m-work,
 * magenta = --accent, cyan = --m-wm — so terminal output reads as part of Panel, not a guest.
 */
const darkTheme = {
  background: "#05070c",
  foreground: "#d8deea",
  cursor: "#9a88ff",
  selectionBackground: "#6454aa88",
  black: "#11151c",
  red: "#ff6b81",
  green: "#67d99a",
  yellow: "#e8c66a",
  blue: "#72a9ff",
  magenta: "#aa91ff",
  cyan: "#63d5c8",
  white: "#d8deea",
  // Bright set spelled out: left to xterm, it falls back to its own generic palette.
  brightBlack: "#5c6578",
  brightRed: "#ff8a9b",
  brightGreen: "#8be4b2",
  brightYellow: "#f0d68f",
  brightBlue: "#97c0ff",
  brightMagenta: "#c2b0ff",
  brightCyan: "#8ee2d8",
  brightWhite: "#f2f5fb",
};

/* Light: a clean off-white surface with dark ink; the ANSI hues are darkened so they read on
   white while keeping their family (green/red/blue/magenta/cyan still say the same thing). */
const lightTheme = {
  background: "#f4f6fb",
  foreground: "#1c2333",
  cursor: "#6a52e6",
  selectionBackground: "#6a52e63a",
  black: "#1c2333",
  red: "#c42e44",
  green: "#157f3b",
  yellow: "#8a5a00",
  blue: "#0b6bcb",
  magenta: "#8a3fb8",
  cyan: "#0e7a87",
  white: "#5b6575",
  // Left to xterm, bright white is #ffffff and bright yellow a pale lemon: invisible on this
  // background. Every bright here stays dark enough to read on off-white.
  brightBlack: "#6b7486",
  brightRed: "#a8233a",
  brightGreen: "#0f6a31",
  brightYellow: "#704900",
  brightBlue: "#0a59a8",
  brightMagenta: "#73329b",
  brightCyan: "#0b6570",
  brightWhite: "#1c2333",
};

/**
 * Every terminal id some deck shows. Panel has two decks (the wall and the manager), and each
 * hears every chunk. Without this, each deck parked the other's output in `pending` for nothing:
 * a 64 KB string rebuilt and a timer reset per chunk, for every busy agent.
 */
const claimed = new Set<string>();

/**
 * What a selection should paste as. Agent TUIs pad every line to the pane width and indent their
 * output under a bullet, so a raw copy pasted as ragged trailing spaces and a two-space margin on
 * every line. Trailing space goes; the margin all lines share goes. Relative indentation (code)
 * stays exactly as it was.
 */
const MAC = navigator.platform.toLowerCase().includes("mac");

export function tidyCopy(text: string): string {
  const lines = text.split("\n").map((line) => line.replace(/[ \t\u00a0]+$/, ""));
  const margins = lines.filter((line) => line.trim()).map((line) => /^[ \t]*/.exec(line)![0].length);
  const margin = margins.length ? Math.min(...margins) : 0;
  return lines
    .map((line) => line.slice(Math.min(margin, line.length)))
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}

/** Memory as people read it: "640 MB", "1.4 GB". */
export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb < 1000 ? `${Math.max(1, Math.round(mb))} MB` : `${(mb / 1024).toFixed(1)} GB`;
}

const isLight = (): boolean => document.documentElement.getAttribute("data-theme") === "light";
const termTheme = () => (isLight() ? lightTheme : darkTheme);

/*
 * Swapping the palette only repaints colours the app left to the terminal. A TUI that asked for
 * the background (OSC 11) and baked RGB from the answer keeps painting for the old theme.
 *
 * claude asks again when told the theme changed: it turns on mode 2031 and listens for
 * `CSI ? 997 ; 1|2 n`. xterm.js does not implement that mode, so the deck tracks it per pane
 * and sends the report itself.
 *
 * Apps such as codex use both foreground (OSC 10) and background replies to tint their prompt
 * block. Let xterm answer both: suppressing either reply removes the prompt highlight.
 * A pane that asks gets a contrast floor against each cell's actual background, keeping text
 * readable even when an app retains its original RGB prompt tint after a theme change.
 * This follows the query rather than the session kind, including agents started in shell tabs.
 */
const THEME_NOTIFY_MODE = 2031;
const BAKED_COLOUR_MIN_CONTRAST = 4.5;

/*
 * Terminal zoom. One size for the WHOLE deck, not per pane: the wall shows many terminals at
 * once and half of them at a different size would read as a bug, not a setting. It survives a
 * restart because "the text is too small" is a fact about the human's eyes, not about a session.
 * Bounds are the useful range — below 8px the box-drawing in claude's UI collapses, above 24px
 * a normal pane is too few columns for anything to lay out.
 */
const FONT_KEY = "panel-terminal-font";
const FONT_DEFAULT = 12.5;
const FONT_MIN = 8;
const FONT_MAX = 24;
const FONT_STEP = 0.5;

const loadFontSize = (): number => {
  const saved = Number(localStorage.getItem(FONT_KEY));
  return Number.isFinite(saved) && saved >= FONT_MIN && saved <= FONT_MAX ? saved : FONT_DEFAULT;
};

const make = (tag: string, className: string): HTMLElement => {
  const node = document.createElement(tag);
  node.className = className;
  return node;
};

type Pane = {
  mount: HTMLElement;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  terminalId: string;
  /** The PTY is gone. Keep the scrollback — it is the transcript — but stop pretending to type. */
  dead: boolean;
  /** A selection was made and has not been copied yet. Set while the drag is in flight, acted on
   *  when the mouse comes up — see the copy-on-select note in add(). */
  pendingCopy: boolean;
  /** The app turned on mode 2031 and wants a report when the theme flips. */
  themeNotify: boolean;
};


/** What the on-terminal close prompt needs to name itself: the session, and the app it belongs
 *  to (id for the icon, name for the letter that stands in until it loads). */
export type CloseAsk = {
  title: string;
  projectId: string;
  projectName: string;
  /** What closing actually costs, in the caller's words. A shell mid-command and an agent
   *  holding a conversation lose different things, and "process will be stopped" describes
   *  only the first. Omitted falls back to that line. */
  note?: string;
};

/** Told when a session's process exits on its own, so the strip can mark it and stop lying. */
export type DeckEvents = {
  onExit(sessionId: string): void;
  /** Something you typed reached this session's PTY. */
  onInput?(sessionId: string, data: string): void;
  /** Start the same kind of session again. Given, an ended pane offers a Restart button. A
   *  sleeping pane offers Wake on the same path. Settled, the button can be pressed again. */
  onRestart?(sessionId: string): void | Promise<void>;
  canRestart?(sessionId: string): boolean;
  /** A `panel:` link this session printed was clicked (deeplink.ts). */
  openPlace?(sessionId: string, place: Place): void;
  /** Put to sleep rather than ended: its bar offers Wake, and says what sleeping gave back when
   *  that is known. Null for a session that is not asleep. */
  asleep?(sessionId: string): { freed: number | null } | null;
};

export class TerminalDeck {
  private readonly panes = new Map<string, Pane>();
  /**
   * A fresh PTY can print its prompt before `start_session` returns to JavaScript. At that point
   * there is no pane to receive the event yet, so retain the small startup burst and replay it
   * from add(). Without this, a successfully started shell looks like an empty, frozen terminal.
   *
   * Keep this deliberately bounded: simulator PTYs share the event channel but never join this
   * deck, and their output must not turn this transient hand-off buffer into a log store.
   */
  private readonly pending = new Map<string, { data: string; closed: boolean; timer: number }>();
  private visible: string | null = null;
  /** Last pane the caret was actually in. On the wall there is no single "visible" pane, so this
   *  is what ⌘F searches. */
  private focused: string | null = null;
  private unlisten: UnlistenFn | null = null;
  private dropUnlisten: UnlistenFn | null = null;
  private observer: ResizeObserver;
  /** While the all-terminals wall is up, the overview owns layout — show()/fitVisible() stand down. */
  private overviewActive = false;
  /** The one screen on loan to a host outside the deck, and the observer that fits it there. */
  private lent: { sessionId: string; observer: ResizeObserver } | null = null;
  /** Shared by every pane, remembered across restarts. See FONT_KEY above. */
  private fontSize = loadFontSize();

  constructor(
    private readonly host: HTMLElement,
    private readonly events: DeckEvents,
  ) {
    this.observer = new ResizeObserver(() => this.fitVisible());
    this.observer.observe(host);
    // Repaint every live terminal when the app theme flips. xterm can't read CSS vars, so we
    // hand each pane the new palette object; the canvas re-renders its scrollback in place.
    window.addEventListener("panel-theme-change", this.onThemeChange);
    // One listener for the whole deck, on window rather than on each mount: a selection drag that
    // ends outside the pane it started in is still a finished selection.
    window.addEventListener("mouseup", this.onMouseUp, true);
    void this.attach();
    void this.attachDragDrop();
  }

  private readonly onThemeChange = (): void => {
    const next = termTheme();
    // Palette first: the app answers the report by asking for the background again.
    const report = `\x1b[?997;${isLight() ? 2 : 1}n`;
    for (const pane of this.panes.values()) {
      pane.term.options.theme = next;
      if (pane.themeNotify && !pane.dead) pane.term.input(report, false);
    }
  };

  private readonly onMouseUp = (): void => {
    for (const pane of this.panes.values()) if (pane.pendingCopy) this.copySelection(pane);
  };

  private async attach(): Promise<void> {
    this.unlisten = await listen<TerminalChunk>("panel-terminal-output", ({ payload }) => {
      for (const [sessionId, pane] of this.panes) {
        if (pane.terminalId !== payload.terminalId) continue;
        this.writeChunk(sessionId, pane, payload);
        return;
      }
      if (claimed.has(payload.terminalId)) return;
      const previous = this.pending.get(payload.terminalId);
      if (previous) window.clearTimeout(previous.timer);
      const timer = window.setTimeout(() => this.pending.delete(payload.terminalId), 5_000);
      this.pending.set(payload.terminalId, {
        // A shell prompt is tiny. The cap also protects against a noisy non-deck PTY.
        data: `${previous?.data ?? ""}${payload.data}`.slice(-64 * 1024),
        closed: !!payload.closed || !!previous?.closed,
        timer,
      });
    });
  }

  /**
   * Files dragged in from Finder. Tauri intercepts OS drops before the webview sees them, so an
   * HTML5 `drop` listener here would never fire — this is the only path. It is also the better
   * one: Tauri hands over REAL paths, so nothing is copied into a temp directory at all.
   *
   * The drop point arrives in physical pixels; elementFromPoint wants CSS pixels. On a Retina
   * screen that factor of two is the difference between the pane you dropped on and the one above
   * it.
   */
  private async attachDragDrop(): Promise<void> {
    this.dropUnlisten = await getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === "leave") {
        this.paintDrop(null);
        return;
      }
      const pane = this.paneAt(payload.position.x, payload.position.y);
      if (payload.type !== "drop") {
        this.paintDrop(pane);
        return;
      }
      this.paintDrop(null);
      if (pane) this.typePaths(pane, payload.paths);
    });
  }

  /** Which pane is under a physical-pixel window point, if any. */
  private paneAt(x: number, y: number): Pane | null {
    const ratio = window.devicePixelRatio || 1;
    const node = document.elementFromPoint(x / ratio, y / ratio);
    const mount = node?.closest(".terminal-mount") ?? null;
    if (!mount) return null;
    for (const pane of this.panes.values()) if (pane.mount === mount) return pane;
    return null;
  }

  /** Outline the one pane a drop would land in, so it is obvious BEFORE letting go. */
  private paintDrop(target: Pane | null): void {
    for (const pane of this.panes.values()) pane.mount.classList.toggle("is-drop", pane === target);
  }

  /** Which buffer cell a mouse event is over. Derived from the screen's own box rather than from
   *  xterm internals, so it stays right through zoom and re-fit. */
  private cellAt(pane: Pane, event: MouseEvent): { col: number; row: number } | null {
    const screen = pane.mount.querySelector(".xterm-screen");
    if (!screen || !pane.term.cols || !pane.term.rows) return null;
    const box = screen.getBoundingClientRect();
    const cellW = box.width / pane.term.cols;
    const cellH = box.height / pane.term.rows;
    if (!(cellW > 0) || !(cellH > 0)) return null;
    const clamp = (value: number, top: number): number => Math.max(0, Math.min(top, Math.floor(value)));
    return {
      col: clamp((event.clientX - box.left) / cellW, pane.term.cols - 1),
      row: pane.term.buffer.active.viewportY + clamp((event.clientY - box.top) / cellH, pane.term.rows - 1),
    };
  }

  /** Put the current selection on the clipboard and say so. Silence is what made the old ⌘C feel
   *  broken even on the times it worked. */
  private copySelection(pane: Pane): void {
    pane.pendingCopy = false;
    const text = tidyCopy(pane.term.getSelection());
    if (!text.trim()) return;
    void this.copyText(text).then((ok) => {
      this.flash(pane, ok ? "copied" : "copy blocked");
      if (!ok) return;
      pane.term.focus();
    });
  }

  private async copyText(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // A custom-scheme webview can withhold the async clipboard API. The old way still works.
      const box = document.createElement("textarea");
      box.value = text;
      box.style.cssText = "position:fixed;top:-1000px;opacity:0";
      document.body.append(box);
      box.select();
      const ok = document.execCommand("copy");
      box.remove();
      return ok;
    }
  }

  /** An ended pane used to say so only in grey text inside the scrollback. The way back was the
   *  NEW row, a fresh seat and a new tab position; this puts it where the eyes already are. */
  private paintEnded(sessionId: string, pane: Pane): void {
    const restart = this.events.onRestart;
    if (!restart || pane.mount.querySelector(".term-ended-bar")) return;
    if (this.events.canRestart && !this.events.canRestart(sessionId)) return;
    const asleep = this.events.asleep?.(sessionId) ?? null;
    const bar = make("div", "term-ended-bar mo-rise");
    const label = make("span", "");
    label.textContent = !asleep
      ? "Session ended"
      : asleep.freed
        ? `Asleep · freed ${formatBytes(asleep.freed)}`
        : "Asleep";
    if (asleep) label.title = "Its process ended to give the memory back. Wake picks the same conversation back up.";
    bar.append(label);
    const again = make("button", "") as HTMLButtonElement;
    again.type = "button";
    again.textContent = asleep ? "Wake" : "Restart";
    again.addEventListener("click", (event) => {
      event.stopPropagation();
      again.disabled = true;
      // A wake that failed leaves the bar up, and it must still work for a second try.
      void Promise.resolve(restart(sessionId)).finally(() => {
        again.disabled = false;
      });
    });
    bar.append(again);
    pane.mount.append(bar);
  }

  /** The right-click menu. One per deck, rebuilt on each open; any click or key elsewhere closes it. */
  private openMenu(pane: Pane, x: number, y: number): void {
    document.querySelector(".term-menu")?.remove();
    const menu = make("div", "row-menu term-menu");
    menu.setAttribute("role", "menu");
    const close = (): void => {
      menu.remove();
      document.removeEventListener("mousedown", outside, true);
      document.removeEventListener("keydown", onKey, true);
    };
    const outside = (event: MouseEvent): void => {
      if (!menu.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };
    const item = (label: string, keys: string, enabled: boolean, run: () => void): void => {
      const button = make("button", "row-menu-item term-menu-item") as HTMLButtonElement;
      button.type = "button";
      button.setAttribute("role", "menuitem");
      button.disabled = !enabled;
      const name = make("span", "");
      name.textContent = label;
      const hint = make("kbd", "");
      hint.textContent = keys;
      button.append(name, hint);
      button.addEventListener("click", () => {
        close();
        run();
      });
      menu.append(button);
    };
    const mod = MAC ? "⌘" : "Ctrl+";
    item("Copy", `${mod}C`, pane.term.hasSelection(), () => this.copySelection(pane));
    item("Paste", `${mod}V`, !pane.dead, () => void this.pasteText(pane));
    item("Select all", `${mod}A`, true, () => {
      pane.term.selectAll();
      pane.term.focus();
    });
    document.body.append(menu);
    const box = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(6, Math.min(x, innerWidth - box.width - 6))}px`;
    menu.style.top = `${Math.max(6, Math.min(y, innerHeight - box.height - 6))}px`;
    document.addEventListener("mousedown", outside, true);
    document.addEventListener("keydown", onKey, true);
  }

  /** Paste for the menu. Rust reads the clipboard: WebKit answers a page's own read with a
   *  second "Paste" bubble, one more click for every paste. */
  private async pasteText(pane: Pane): Promise<void> {
    const text = await invoke<string>("clipboard_text").catch(() => navigator.clipboard.readText());
    if (!text || pane.dead) return;
    pane.term.paste(text);
    pane.term.focus();
  }

  /** A one-line receipt inside the pane. Terminal actions that produce no output — a copy, a
   *  pasted path — otherwise leave the human guessing whether the key landed. */
  private flash(pane: Pane, message: string): void {
    pane.mount.querySelector(".term-flash")?.remove();
    const badge = make("span", "term-flash mo-rise");
    badge.textContent = message;
    pane.mount.append(badge);
    window.setTimeout(() => badge.remove(), 1200);
  }

  private writeChunk(sessionId: string, pane: Pane, chunk: TerminalChunk): void {
    if (chunk.data) pane.term.write(chunk.data);
    // Ended once is ended: a late closing chunk after ended() must not say it twice.
    if (!chunk.closed || pane.dead) return;
    const word = this.events.asleep?.(sessionId) ? "asleep" : "session ended";
    pane.term.write(`\r\n\x1b[90m[${word}]\x1b[0m\r\n`);
    pane.dead = true;
    this.paintEnded(sessionId, pane);
    this.events.onExit(sessionId);
  }

  /** The PTY is known to be gone. Say so now rather than when its closing chunk arrives. */
  ended(sessionId: string): void {
    const pane = this.panes.get(sessionId);
    if (pane) this.writeChunk(sessionId, pane, { terminalId: pane.terminalId, data: "", closed: true });
  }

  /** Hand a pane the output its PTY made before the pane was listening. See `pending`. */
  private flushPending(sessionId: string, pane: Pane): void {
    const startup = this.pending.get(pane.terminalId);
    if (!startup) return;
    window.clearTimeout(startup.timer);
    this.pending.delete(pane.terminalId);
    this.writeChunk(sessionId, pane, {
      terminalId: pane.terminalId,
      data: startup.data,
      closed: startup.closed,
    });
  }

  /**
   * A sleeping pane, woken: the same pane and scrollback, with a new PTY under it. A fresh pane
   * would cost the transcript above, and the wall would see a session it already has and not
   * re-seat it.
   */
  wake(sessionId: string, terminalId: string): void {
    const pane = this.panes.get(sessionId);
    if (!pane) return;
    claimed.delete(pane.terminalId);
    pane.terminalId = terminalId;
    claimed.add(terminalId);
    pane.dead = false;
    // Modes belong to the process that set them, and that process is gone.
    pane.themeNotify = false;
    pane.mount.querySelector(".term-ended-bar")?.remove();
    pane.term.write("\x1b[2m── woken · picking the conversation back up ──\x1b[0m\r\n");
    if (pane.term.cols && pane.term.rows) {
      void invoke("resize_terminal", { terminalId, cols: pane.term.cols, rows: pane.term.rows });
    }
    this.flushPending(sessionId, pane);
  }

  /** Size to open a NEW pty with, measured off the host before any pane for it exists. */
  proposeSize(): { cols: number; rows: number } {
    // Only an actually-laid-out pane is a usable ruler. A pane can be `hidden === false` and still
    // measure zero (its whole tab is off-screen), and xterm answers a zero measurement with NaN or
    // Infinity — which serializes to null and makes the Rust side reject the u16. That is why the
    // SECOND terminal in a row failed to start while the first, with no probe at all, succeeded.
    const probe = [...this.panes.values()].find(
      (pane) => !pane.mount.hidden && pane.mount.clientWidth >= 2,
    );
    const proposed = probe?.fit.proposeDimensions();
    const sane = (value: number | undefined, fallback: number, floor: number): number => {
      const rounded = Math.floor(Number(value));
      return Number.isFinite(rounded) && rounded >= floor ? rounded : fallback;
    };
    return {
      cols: sane(proposed?.cols, 100, 20),
      rows: sane(proposed?.rows, 24, 4),
    };
  }

  /** Give a freshly-started session its screen. */
  /**
   * `restore` is a screen this pane had BEFORE it existed — the tail Rust kept from the last run.
   *
   * It is a parameter of add() rather than a method you call after, and that is the whole point:
   * add() ends by flushing output this PTY already produced (see `pending`), so anything written
   * afterwards lands UNDER newer text. Last session's screen has exactly one correct position,
   * which is first.
   */
  add(
    sessionId: string,
    terminalId: string,
    restore?: { screen: string; savedAt: number; asleep?: boolean },
  ): void {
    const mount = document.createElement("div");
    mount.className = "terminal-mount";
    mount.hidden = true;
    this.host.append(mount);

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      // ui-monospace is how a web view reaches SF Mono; it is not installed under a font name.
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Monaco, monospace',
      fontSize: this.fontSize,
      lineHeight: 1.3,
      scrollback: 10_000,
      allowTransparency: true,
      theme: termTheme(),
      // A full-screen TUI (claude, codex, vim) turns mouse reporting ON, and from then on a drag
      // is the app's event, not a selection — which is why selecting output "stopped working"
      // exactly in the terminals worth copying from. ⌥ takes the mouse back for one gesture.
      macOptionClickForcesSelection: true,
      // Right-click is the Copy / Paste menu. Selecting a word there replaced the selection the
      // menu was opened to copy.
      rightClickSelectsWord: false,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    // Agents print PR, CI and docs URLs constantly. ⌘-click opens one, the way iTerm and VS Code
    // do; a plain click stays a click, so selecting across a URL never launches a browser.
    term.loadAddon(
      new WebLinksAddon(
        (event, uri) => {
          if (!(MAC ? event.metaKey : event.ctrlKey)) return;
          void invoke("open_link", { url: uri }).catch((error) => console.warn("[panel] link", error));
        },
        {
          hover: () => {
            mount.title = MAC ? "⌘-click to open link" : "Ctrl-click to open link";
          },
          leave: () => {
            mount.title = "";
          },
        },
      ),
    );
    // An agent's `panel:review:…` / `panel:work:…` is a place in Panel, opened the same way.
    term.registerLinkProvider({
      provideLinks: (y, callback) => {
        const text = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
        const links = [...text.matchAll(PLACE_IN_TEXT)].flatMap((match) => {
          const place = parsePlace(match[0]);
          if (!place || match.index === undefined) return [];
          return [{
            range: { start: { x: match.index + 1, y }, end: { x: match.index + match[0].length, y } },
            text: match[0],
            activate: (event: MouseEvent) => {
              if (MAC ? event.metaKey : event.ctrlKey) this.events.openPlace?.(sessionId, place);
            },
            hover: () => {
              mount.title = MAC ? "⌘-click to open in Panel" : "Ctrl-click to open in Panel";
            },
            leave: () => {
              mount.title = "";
            },
          }];
        });
        callback(links.length ? links : undefined);
      },
    });
    term.open(mount);

    const pane: Pane = {
      mount,
      term,
      fit,
      search,
      terminalId,
      dead: false,
      pendingCopy: false,
      themeNotify: false,
    };
    // See THEME_NOTIFY_MODE. Returning false lets xterm run its own handling of the other modes.
    const trackThemeNotify = (on: boolean) => (params: (number | number[])[]): boolean => {
      if (params.includes(THEME_NOTIFY_MODE)) pane.themeNotify = on;
      return false;
    };
    term.parser.registerCsiHandler({ prefix: "?", final: "h" }, trackThemeNotify(true));
    term.parser.registerCsiHandler({ prefix: "?", final: "l" }, trackThemeNotify(false));
    // Keep cached RGB prompt backgrounds readable, then let xterm answer the colour query.
    term.parser.registerOscHandler(10, (data) => {
      if (!data.split(";").every((part) => part === "?")) return false;
      term.options.minimumContrastRatio = BAKED_COLOUR_MIN_CONTRAST;
      return false;
    });
    // ⌘V with a FILE or a screenshot on the clipboard: a terminal can only carry text, so xterm
    // drops the bytes and the paste looks broken. We take them before xterm sees the event, park
    // them in a temp file, and type the path — which is exactly what a drag-and-drop into any CLI
    // agent produces, so claude/codex read the file with no cooperation from Panel. Capture
    // phase, because xterm's own handler stops the event on the helper textarea below us.
    mount.addEventListener("paste", (event) => void this.pasteFiles(pane, event), true);

    /*
     * Copy, three ways, because one was not enough.
     *
     * 1. Copy-on-select. Terminal output is read once and pasted somewhere else; making the human
     *    hold a selection steady and then hit a key is the step that kept failing. The selection
     *    IS the copy. Fired on mouseup rather than on every selection change, or a drag would
     *    write the clipboard a hundred times on its way down the screen.
     * 2. ⇧-click extends. Selecting twenty lines in a six-line pane means dragging past the edge
     *    into xterm's auto-scroll, which overshoots. Click the first line, wheel down calmly,
     *    ⇧-click the last. Capture phase: xterm would otherwise start a NEW selection here.
     * 3. ⌘C, below, for when the selection came from the keyboard or a search.
     */
    term.onSelectionChange(() => {
      pane.pendingCopy = term.hasSelection();
    });
    /*
     * A drag always selects. Claude, Codex and every other full-screen TUI turn mouse reporting
     * on, and from then on xterm hands the drag to the app: nothing selects unless you know to
     * hold ⌥. That is the copy that "never works". So the defaults swap while an app owns the
     * mouse: a plain drag selects, and ⌥-click is how a click still reaches the app. xterm reads
     * the modifier off the event, so the press is re-sent with the one it needs.
     */
    let resending = false;
    mount.addEventListener("mousedown", (event) => {
      if (resending || event.button !== 0 || event.shiftKey || event.metaKey || event.ctrlKey) return;
      if (term.modes.mouseTrackingMode === "none") return;
      const select = !event.altKey;
      const init: MouseEventInit = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        detail: event.detail,
        screenX: event.screenX,
        screenY: event.screenY,
        clientX: event.clientX,
        clientY: event.clientY,
        button: 0,
        buttons: event.buttons,
        // Mac forces a selection with ⌥, everything else with ⇧. To reach the app, neither.
        altKey: select && MAC,
        shiftKey: select && !MAC,
      };
      if (!select && !MAC) return; // off the Mac, ⌥ never forced anything; nothing to undo
      event.preventDefault();
      event.stopImmediatePropagation();
      resending = true;
      try {
        event.target?.dispatchEvent(new MouseEvent("mousedown", init));
      } finally {
        resending = false;
      }
      term.focus();
    }, true);
    // Right-click: Copy, Paste, Select all. The keys work, but a menu is where people look first.
    // The press is kept from xterm too: in a TUI it would be reported to the app and drop the
    // selection the menu is about to copy.
    mount.addEventListener("mousedown", (event) => {
      if (event.button !== 2) return;
      event.stopImmediatePropagation();
    }, true);
    mount.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.openMenu(pane, event.clientX, event.clientY);
    });
    mount.addEventListener("mousedown", (event) => {
      if (!event.shiftKey || event.button !== 0 || resending) return;
      const anchor = term.getSelectionPosition();
      const cell = this.cellAt(pane, event);
      if (!anchor || !cell) return;
      const from = anchor.start.y < cell.row || (anchor.start.y === cell.row && anchor.start.x <= cell.col)
        ? anchor.start
        : anchor.end;
      const length = (cell.row - from.y) * term.cols + (cell.col - from.x) + 1;
      if (length <= 0) return;
      event.preventDefault();
      event.stopPropagation();
      term.select(from.x, from.y, length);
      pane.pendingCopy = true;
      this.copySelection(pane);
    }, true);
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      // ⌘A selects the scrollback, as it does in every Mac terminal. ⌃A stays line-start.
      if (IS_MAC && matchesShortcut(event, "Meta+KeyA")) {
        term.selectAll();
        return false;
      }
      // Without a selection, Ctrl+C reaches the shell as its normal interrupt.
      // Ctrl+Shift+C remains available as the familiar Windows/Linux copy alias.
      const copy = matches(event, "term.copy") || (!IS_MAC && matchesShortcut(event, "Meta+Shift+KeyC"));
      if (!copy || !term.hasSelection()) return true;
      this.copySelection(pane);
      return false;
    });
    // Which pane ⌘F acts on is "the one you were last typing in", not "the one the app thinks is
    // selected" — on the wall those differ.
    mount.addEventListener("focusin", () => {
      this.focused = sessionId;
    });
    // Pinch-zoom / ⌘-scroll over a terminal. A trackpad pinch arrives as a wheel event with
    // ctrlKey set — same signal the browser's own page zoom uses — so this is the gesture people
    // already have in their fingers. Non-passive: we cancel it, or the whole window zooms too.
    mount.addEventListener(
      "wheel",
      (event) => {
        if (!event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        // Trackpads emit a stream of small deltas; the sign is all we want, the 0.5 step does
        // the pacing. deltaY is inverted (scroll up = negative = bigger).
        if (event.deltaY) this.zoom(event.deltaY < 0 ? 1 : -1);
      },
      { passive: false },
    );
    search.onDidChangeResults(({ resultIndex, resultCount }) => {
      if (this.searchIn === sessionId) this.paintSearchCount(resultIndex, resultCount);
    });
    // Every keystroke goes to the PTY. A dead session swallows them rather than throwing —
    // typing into a finished transcript should do nothing, not raise.
    term.onData((data) => {
      if (pane.dead) return;
      void invoke("write_terminal", { terminalId: pane.terminalId, data });
      this.events.onInput?.(sessionId, data);
    });
    this.panes.set(sessionId, pane);
    claimed.add(terminalId);
    if (restore?.screen) {
      // Raw, escapes and all, so the colours and the wrapping come back as they were. Modes the
      // old process turned on are not the new one's: a stale 2031 would type reports into a shell.
      pane.term.write(restore.screen.endsWith("\n") ? restore.screen : `${restore.screen}\r\n`, () => {
        pane.themeNotify = false;
      });
      // The banner is not decoration. Without a line saying where the old ends, restored output
      // reads as live output — and the first thing you do is answer a question the agent asked
      // you yesterday. \x1b[2m is faint; \x1b[0m hands the colours back to whatever runs next.
      const when = new Date(restore.savedAt * 1000).toLocaleString();
      pane.term.write(
        `\x1b[2m── restored from ${when} · everything above is last session ──\x1b[0m\r\n`,
      );
    }
    // Restored asleep: there is no PTY under it and no closing chunk will ever come to say so.
    if (restore?.asleep) {
      pane.dead = true;
      this.paintEnded(sessionId, pane);
      return;
    }
    this.flushPending(sessionId, pane);
  }

  /**
   * Turn anything file-shaped on the clipboard into paths and type them. Text-only pastes are left
   * alone so xterm handles them the usual way.
   *
   * The old version took `image/*` only, so ⌘C on a PDF, a log, a .patch — anything not an image —
   * pasted nothing at all and looked like a dead key. Kind is what matters, not MIME.
   *
   * Order matters: a file copied in Finder often arrives with its real `file://` URL attached, and
   * that path beats a byte-for-byte copy in $TMPDIR — it is the file the human meant, at the place
   * they know, and the agent can write back to it.
   */
  private async pasteFiles(pane: Pane, event: ClipboardEvent): Promise<void> {
    if (pane.dead) return;
    const clipboard = event.clipboardData;
    if (!clipboard) return;
    // Everything read off the event must happen NOW: clipboardData is dead after the first await.
    const urls = clipboard.getData("text/uri-list");
    const items = [...clipboard.items].filter((item) => item.kind === "file");
    const files = items.map((item) => item.getAsFile()).filter((file): file is File => file !== null);
    const real = urls
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("file://"))
      .map((line) => {
        try {
          return decodeURIComponent(new URL(line).pathname);
        } catch {
          return "";
        }
      })
      .filter(Boolean);
    if (!files.length && !real.length) return;
    event.preventDefault();
    event.stopPropagation();

    if (real.length) {
      this.typePaths(pane, real);
      return;
    }
    const saved: string[] = [];
    for (const file of files) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        // Chunked so a multi-megabyte screenshot doesn't blow the argument limit of apply().
        let binary = "";
        for (let at = 0; at < bytes.length; at += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
        }
        saved.push(
          await invoke<string>("save_pasted_file", {
            data: btoa(binary),
            name: file.name || null,
            ext: file.type.split("/")[1] ?? "bin",
          }),
        );
      } catch (error) {
        pane.term.write(`\r\n\x1b[31m[paste failed: ${String(error)}]\x1b[0m\r\n`);
      }
    }
    if (saved.length) this.typePaths(pane, saved);
  }

  /**
   * Type file paths into a PTY as if they had been dragged in from Finder.
   *
   * Spaces get backslash-escaped, which is what every terminal on this machine does on drop and
   * what every CLI agent already parses. One write, trailing space, no newline: the paths join
   * whatever the human is mid-sentence on, and pressing return stays their decision.
   */
  private typePaths(pane: Pane, paths: string[]): void {
    if (pane.dead || !paths.length) return;
    const data = `${paths.map((path) => path.replace(/(["'\\ ])/g, "\\$1")).join(" ")} `;
    void invoke("write_terminal", { terminalId: pane.terminalId, data });
    this.flash(pane, paths.length === 1 ? "file path pasted" : `${paths.length} paths pasted`);
  }

  /** Show one session's screen and hide the rest. Everything keeps running either way. */
  show(sessionId: string | null): void {
    if (this.overviewActive) return;
    this.endLoan();
    if (this.searchIn && this.searchIn !== sessionId) this.closeSearch(false);
    this.visible = sessionId;
    if (sessionId) this.focused = sessionId;
    for (const [id, pane] of this.panes) {
      // The workspace wall temporarily adopts mounts into its tiles. A wall rebuild can detach a
      // tile before reclaimAll() sees it, so entering a project must assert the invariant instead
      // of assuming every mount already came home. An xterm left under a detached tile is alive
      // (and its tab is painted) but its canvas is nowhere on screen — the exact blank project
      // terminal failure.
      if (pane.mount.parentElement !== this.host) this.host.appendChild(pane.mount);
      pane.mount.hidden = id !== sessionId;
    }
    if (!sessionId) return;
    // Lay out first, measure second: fitting into a still-hidden element measures zero.
    requestAnimationFrame(() => {
      this.fitVisible();
      const pane = this.panes.get(sessionId);
      // xterm may have rendered while its mount belonged to a hidden/detached wall tile. Refresh
      // the viewport after fitting so existing scrollback appears immediately on the project.
      if (pane && pane.term.rows > 0) pane.term.refresh(0, pane.term.rows - 1);
      pane?.term.focus();
    });
  }

  /**
   * Type a message into a session's prompt and submit it, as if pasted and sent. Bracketed when
   * the app asked for it, so a multi-line message arrives as one message and not one per line.
   */
  async sendPrompt(sessionId: string, text: string): Promise<boolean> {
    const pane = this.panes.get(sessionId);
    if (!pane || pane.dead) return false;
    const body = pane.term.modes.bracketedPasteMode
      ? `\x1b[200~${text}\x1b[201~`
      : text.replace(/\r?\n/g, "\r");
    try {
      await invoke("write_terminal", { terminalId: pane.terminalId, data: body });
      // A beat between the paste and Enter: TUIs treat a paste that ends in Enter as more text.
      await new Promise((resolve) => window.setTimeout(resolve, 120));
      await invoke("write_terminal", { terminalId: pane.terminalId, data: "\r" });
      return true;
    } catch {
      return false;
    }
  }

  /** Paste file paths into a session's prompt without submitting, as a Finder drop would. */
  pastePaths(sessionId: string, paths: string[]): boolean {
    const pane = this.panes.get(sessionId);
    if (!pane || pane.dead) return false;
    this.typePaths(pane, paths);
    return true;
  }

  /**
   * The last non-empty lines on a session's screen, trailing whitespace trimmed. The sidebar
   * card shows them beside a permission prompt, so an Allow is never given blind.
   */
  tail(sessionId: string, lines: number): string[] {
    const pane = this.panes.get(sessionId);
    if (!pane) return [];
    const buffer = pane.term.buffer.active;
    const out: string[] = [];
    for (let at = buffer.baseY + pane.term.rows - 1; at >= 0 && out.length < lines; at -= 1) {
      const text = buffer.getLine(at)?.translateToString(true) ?? "";
      if (text.trim() || out.length) out.unshift(text);
    }
    while (out.length && !out[0].trim()) out.shift();
    return out;
  }

  /** Put the caret back in the terminal — the click that opened it should also let you type. */
  focus(): void {
    if (this.visible) this.panes.get(this.visible)?.term.focus();
  }

  /** Focus one specific pane — the wall taps this when a tile is clicked. */
  focusSession(sessionId: string): void {
    this.panes.get(sessionId)?.term.focus();
  }

  /**
   * Ask to close one terminal ON that terminal. The prompt is built INTO the pane's own mount —
   * the same place the find bar lives — so it travels with the session between the project view
   * and the wall, and the question is asked over the exact screen it is about instead of over a
   * dimmed app. Everything else stays live: other terminals keep printing and keep taking keys.
   *
   * Returns null when the pane cannot show it (no such pane, or its mount is off-screen); the
   * caller falls back to the app-modal confirm so a hidden terminal is never asked about
   * invisibly. Escape cancels, Enter on the card confirms, a click anywhere outside cancels.
   */
  confirmClose(sessionId: string, about: CloseAsk): Promise<boolean> | null {
    const pane = this.panes.get(sessionId);
    if (!pane || pane.mount.hidden || !pane.mount.isConnected) return null;
    const mount = pane.mount;

    return new Promise<boolean>((resolve) => {
      const veil = make("div", "term-confirm mo-rise");
      veil.setAttribute("role", "alertdialog");
      veil.setAttribute("aria-modal", "true");
      veil.setAttribute("aria-label", `Close ${about.title}?`);
      veil.tabIndex = -1;

      // The app's own icon, blown up and pushed behind the card: at a glance the prompt says
      // WHOSE terminal this is, even on a wall of look-alike black rectangles. The letter shows
      // until the real icon loads — or forever, for an app that has none.
      const seal = make("span", "term-confirm-seal");
      seal.setAttribute("aria-hidden", "true");
      const letter = make("span", "term-confirm-letter");
      letter.textContent = about.projectName.trim().charAt(0).toUpperCase();
      seal.append(letter);
      const art = document.createElement("img");
      art.alt = "";
      art.draggable = false;
      art.src = projectIconUrl(about.projectId);
      art.addEventListener("error", () => art.remove());
      seal.append(art);

      const card = make("div", "term-confirm-card");
      const head = make("b", "term-confirm-title");
      head.textContent = `Close “${about.title}”?`;
      const note = make("small", "term-confirm-note");
      note.textContent = about.note ?? "Its running process will be stopped.";
      const row = make("div", "term-confirm-row");
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "dlg-btn";
      cancel.textContent = "Cancel";
      const ok = document.createElement("button");
      ok.type = "button";
      ok.className = "dlg-btn dlg-danger";
      ok.textContent = "Close session";
      row.append(cancel, ok);
      card.append(head, note, row);
      veil.append(seal, card);

      // A prompt the user cannot see is a deadlock: if a wall rebuild parks this mount off-screen
      // while the question is up, answer it the safe way (cancel) rather than wait for a click
      // that can never happen.
      const watch = new MutationObserver(() => {
        if (mount.hidden || !mount.isConnected) settle(false);
      });

      const settle = (value: boolean): void => {
        watch.disconnect();
        document.removeEventListener("keydown", onKey, true);
        document.removeEventListener("mousedown", onOutside, true);
        veil.remove();
        resolve(value);
      };
      // Escape is document-wide (cancel is always safe from anywhere); Enter is NOT — it stays on
      // the card, or typing Enter into another live terminal would kill this one.
      const onKey = (event: KeyboardEvent): void => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        settle(false);
      };
      const onOutside = (event: MouseEvent): void => {
        if (!veil.contains(event.target as Node)) settle(false);
      };
      veil.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          settle(true);
        }
      });
      cancel.addEventListener("click", () => settle(false));
      ok.addEventListener("click", () => settle(true));

      document.addEventListener("keydown", onKey, true);
      document.addEventListener("mousedown", onOutside, true);
      watch.observe(mount, { attributes: true, attributeFilter: ["hidden"] });
      mount.appendChild(veil);
      // Take the caret off the PTY: keystrokes meant for the question must not reach the shell.
      requestAnimationFrame(() => cancel.focus());
    });
  }

  /* ------------------------------------------------------------------- zoom */

  /** Step the terminal text bigger (+1) or smaller (-1). Returns the size actually landed on, so
   *  the caller can say so; at a bound it returns the unchanged size and nothing repaints. */
  zoom(direction: 1 | -1): number {
    return this.setFontSize(this.fontSize + direction * FONT_STEP);
  }

  /** Back to the shipped size — ⌘0, the escape hatch from having zoomed too far to read the UI. */
  resetZoom(): number {
    return this.setFontSize(FONT_DEFAULT);
  }

  fontPx(): number {
    return this.fontSize;
  }

  /**
   * Resize every pane at once. Changing fontSize changes how many cells fit, so each on-screen
   * pane must re-fit and each live PTY must be told its new cols/rows — otherwise the shell keeps
   * wrapping to the old width and the output shreds. Hidden panes are skipped here and picked up
   * by the fit that show() already does; fitting a zero-width mount is what thrashes xterm.
   */
  private setFontSize(next: number): number {
    const clamped = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(next * 2) / 2));
    if (clamped === this.fontSize) return this.fontSize;
    this.fontSize = clamped;
    localStorage.setItem(FONT_KEY, String(clamped));
    for (const pane of this.panes.values()) pane.term.options.fontSize = clamped;
    this.fitAdopted();
    return clamped;
  }

  /* --------------------------------------------------------------- find bar */

  /**
   * ⌘F over the scrollback. One bar for the whole deck, re-parented into whichever pane is in
   * play, so it behaves the same in the project zone and on the wall. It lives INSIDE the mount
   * rather than in the app chrome: on the wall the "current terminal" is a tile, and a bar parked
   * somewhere else would not say which tile it is searching.
   */
  private searchBar: HTMLElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private searchCount: HTMLElement | null = null;
  private searchIn: string | null = null;

  /** The pane a find should act on: last focused, else the single visible one, else any on-screen
   *  pane — a wall with nothing focused yet still answers ⌘F. */
  private searchTarget(): string | null {
    const usable = (id: string | null): boolean =>
      !!id && !!this.panes.get(id) && !this.panes.get(id)!.mount.hidden;
    if (usable(this.focused)) return this.focused;
    if (usable(this.visible)) return this.visible;
    for (const [id, pane] of this.panes) if (!pane.mount.hidden) return id;
    return null;
  }

  openSearch(): void {
    const sessionId = this.searchTarget();
    if (!sessionId) return;
    const pane = this.panes.get(sessionId)!;
    const bar = this.searchBar ?? this.buildSearchBar();
    if (this.searchIn && this.searchIn !== sessionId) this.panes.get(this.searchIn)?.search.clearDecorations();
    this.searchIn = sessionId;
    pane.mount.appendChild(bar);
    const input = this.searchInput!;
    input.title = `Find in terminal (${chordLabel("term.find")})`;
    input.focus();
    input.select();
    if (input.value) this.runSearch(input.value, "next");
  }

  /** `refocus` is false when the pane is on its way out (parked, reclaimed, disposed) — putting the
   *  caret back into something about to be hidden just steals focus from wherever it belongs. */
  closeSearch(refocus = true): void {
    if (!this.searchBar) return;
    const pane = this.searchIn ? this.panes.get(this.searchIn) : undefined;
    pane?.search.clearDecorations();
    this.searchBar.remove();
    this.searchIn = null;
    if (refocus) pane?.term.focus();
  }

  private buildSearchBar(): HTMLElement {
    const bar = make("div", "term-find");
    const input = document.createElement("input");
    input.type = "text";
    input.className = "term-find-input";
    input.placeholder = "Find";
    input.spellcheck = false;
    const count = make("span", "term-find-count");
    const prev = make("button", "term-find-btn") as HTMLButtonElement;
    prev.type = "button";
    prev.textContent = "↑";
    prev.title = "Previous match (⇧⏎)";
    const next = make("button", "term-find-btn") as HTMLButtonElement;
    next.type = "button";
    next.textContent = "↓";
    next.title = "Next match (⏎)";
    const close = make("button", "term-find-btn") as HTMLButtonElement;
    close.type = "button";
    close.textContent = "✕";
    close.title = "Close (Esc)";

    input.addEventListener("input", () => this.runSearch(input.value, "incremental"));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.closeSearch();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        this.runSearch(input.value, event.shiftKey ? "prev" : "next");
      }
    });
    prev.addEventListener("click", () => this.runSearch(input.value, "prev"));
    next.addEventListener("click", () => this.runSearch(input.value, "next"));
    close.addEventListener("click", () => this.closeSearch());

    bar.append(input, count, prev, next, close);
    this.searchBar = bar;
    this.searchInput = input;
    this.searchCount = count;
    return bar;
  }

  private runSearch(query: string, how: "next" | "prev" | "incremental"): void {
    const pane = this.searchIn ? this.panes.get(this.searchIn) : undefined;
    if (!pane) return;
    if (!query) {
      pane.search.clearDecorations();
      this.paintSearchCount(-1, 0);
      return;
    }
    const options = { incremental: how === "incremental", caseSensitive: false };
    if (how === "prev") pane.search.findPrevious(query, options);
    else pane.search.findNext(query, options);
  }

  private paintSearchCount(resultIndex: number, resultCount: number): void {
    if (!this.searchCount) return;
    this.searchCount.textContent = resultCount ? `${resultIndex + 1}/${resultCount}` : "";
    this.searchBar?.classList.toggle("is-empty", !!this.searchInput?.value && resultCount === 0);
  }

  /** Enter the all-terminals wall: the deck stops driving the single visible screen — the
   *  overview owns layout and fitting until reclaimAll(). */
  beginOverview(): void {
    this.endLoan();
    this.overviewActive = true;
  }

  /** Move one session's live screen into a cell of the wall. The PTY is untouched — only the
   *  mount div moves. Caller fits afterwards via fitAdopted(). */
  adopt(sessionId: string, cell: HTMLElement): void {
    const pane = this.panes.get(sessionId);
    if (!pane) return;
    cell.appendChild(pane.mount);
    pane.mount.hidden = false;
  }

  /** Fit every on-screen pane to whatever cell now holds it and tell each live PTY its new size.
   *  The wall shows many panes at once, so unlike fitVisible() this fits all of them. */
  fitAdopted(): void {
    for (const pane of this.panes.values()) {
      if (pane.mount.hidden || pane.mount.clientWidth < 2) continue;
      pane.fit.fit();
      if (!pane.dead) {
        void invoke("resize_terminal", {
          terminalId: pane.terminalId,
          cols: pane.term.cols,
          rows: pane.term.rows,
        });
      }
    }
  }

  /**
   * Show one session's live screen in a host outside the deck — the Manager pane in Chat. A PTY
   * belongs to exactly one deck, so a second view would mean a second xterm racing the first for
   * size; lending moves the one mount instead, and the next show() or reclaim brings it home.
   */
  lend(sessionId: string, cell: HTMLElement): void {
    this.unlend();
    const pane = this.panes.get(sessionId);
    if (!pane) return;
    cell.appendChild(pane.mount);
    pane.mount.hidden = false;
    const fit = (): void => {
      if (pane.mount.parentElement !== cell || pane.mount.clientWidth < 2) return;
      pane.fit.fit();
      if (!pane.dead) {
        void invoke("resize_terminal", {
          terminalId: pane.terminalId,
          cols: pane.term.cols,
          rows: pane.term.rows,
        });
      }
    };
    const observer = new ResizeObserver(fit);
    observer.observe(cell);
    this.lent = { sessionId, observer };
    requestAnimationFrame(() => {
      fit();
      if (pane.term.rows > 0) pane.term.refresh(0, pane.term.rows - 1);
      pane.term.focus();
    });
  }

  /** Forget a loan whose mount something else is about to re-home (show, the wall, a close). */
  private endLoan(): void {
    this.lent?.observer.disconnect();
    this.lent = null;
  }

  /** Take a lent screen back, hidden, under the deck host. */
  unlend(): void {
    if (!this.lent) return;
    const { sessionId, observer } = this.lent;
    this.lent = null;
    observer.disconnect();
    const pane = this.panes.get(sessionId);
    if (!pane || this.overviewActive) return;
    pane.mount.hidden = true;
    this.host.appendChild(pane.mount);
  }

  /** Pull every screen back under the deck host, hidden, WITHOUT leaving the overview — the
   *  wall calls this before a rebuild so panes on other pages survive off-screen instead of
   *  being dropped from the DOM by replaceChildren(). */
  parkAll(): void {
    this.closeSearch(false);
    for (const pane of this.panes.values()) {
      pane.mount.hidden = true;
      this.host.appendChild(pane.mount);
    }
  }

  /** Leave the wall: pull every screen back under the deck host, hidden, and hand control back to
   *  show(). The caller then calls show() to restore the selected session. */
  reclaimAll(): void {
    this.closeSearch(false);
    for (const pane of this.panes.values()) {
      pane.mount.hidden = true;
      this.host.appendChild(pane.mount);
    }
    this.overviewActive = false;
    this.visible = null;
  }

  /** Drop a closed session's screen for good. */
  remove(sessionId: string): void {
    const pane = this.panes.get(sessionId);
    if (!pane) return;
    if (this.lent?.sessionId === sessionId) this.endLoan();
    if (this.searchIn === sessionId) this.closeSearch(false);
    pane.term.dispose();
    pane.mount.remove();
    this.panes.delete(sessionId);
    claimed.delete(pane.terminalId);
    if (this.visible === sessionId) this.visible = null;
    if (this.focused === sessionId) this.focused = null;
  }

  private fitVisible(): void {
    if (this.overviewActive) return;
    if (!this.visible) return;
    const pane = this.panes.get(this.visible);
    // A hidden or unlaid-out mount measures zero; fitting to zero is what thrashes xterm.
    if (!pane || pane.mount.hidden || pane.mount.clientWidth < 2) return;
    pane.fit.fit();
    if (!pane.dead) {
      void invoke("resize_terminal", {
        terminalId: pane.terminalId,
        cols: pane.term.cols,
        rows: pane.term.rows,
      });
    }
  }

  dispose(): void {
    this.observer.disconnect();
    window.removeEventListener("panel-theme-change", this.onThemeChange);
    window.removeEventListener("mouseup", this.onMouseUp, true);
    this.unlisten?.();
    this.dropUnlisten?.();
    for (const pane of this.panes.values()) {
      pane.term.dispose();
      claimed.delete(pane.terminalId);
    }
    this.panes.clear();
  }
}
