/**
 * Manager — a planning agent in a terminal, on the whole screen.
 *
 * It was a narrow column parked beside the work, and an 80-column agent in a sliver is the wrong
 * shape. So it takes the glass and hands it back on ⌘W.
 *
 * It used to be a sandboxed Codex subprocess with a hard-coded prompt, a JSON action schema, and a
 * bespoke chat renderer — a whole private channel for one participant. It is an ordinary agent
 * session now, rooted at the ops tree, running whichever CLI you start it with. What shapes it is
 * `ops/AGENTS.md`, editable right here, with the shipped text one button away.
 *
 * Agent reports shared this screen until 2026-11-15. They are messages in the Inbox now
 * (foryou.ts), so there is one place to read what agents send.
 */

import type { Session, SessionKind } from "../types";
import { ENGINES } from "./agent-kinds";
import { errorText } from "../errors";
import "./chat.css";

export type ChatEvents = {
  /** Notify the shell when the screen goes up or down. */
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
  show(): void;
  hide(): void;
  toggle(): void;
  isVisible(): boolean;
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

/** The engine the manager was last started with. It is a preference, not state: the session itself
 *  is gone on restart, but "I run my manager on codex" should survive. */
const CPO_KIND_KEY = "panel-cpo-kind";
/** Only agent engines make sense here — the manager reads and writes Markdown and briefs other
 *  agents, and a bare shell cannot do either. */
const CPO_KINDS: SessionKind[] = ["claude", "codex", "grok"];

const svg = (path: string): string =>
  `<svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;

export function mountChat(host: HTMLElement, events: ChatEvents, cpo: CpoEvents): ChatHandle {
  // Never on at boot. Panel opens on Home or on a project.
  let visible = false;

  /* ------------------------------------------------------------------ DOM */

  host.classList.add("chat");
  const head = make("header", "chat-head");
  const heading = make("div", "chat-heading");
  const title = make("h2", "chat-title", "Manager");
  const description = make("p", "chat-description", "Plan work and brief your agents.");
  heading.append(title, description);
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
  // Esc belongs to the manager's agent while you are typing to it, so ⌘W is the key that closes.
  hideButton.title = "Close Manager (⌘W)";
  hideButton.setAttribute("aria-label", "Close Manager");
  hideButton.innerHTML = svg('<path d="m6 6 12 12M18 6 6 18"/>');
  head.append(heading, changesButton, promptToggle, hideButton);

  /* -------------------------------------------------------------- the CPO */

  const cpoPane = make("div", "cpo-pane");
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

  host.append(head, cpoPane);

  /** The manager's terminal lives in the workspace deck like every other session, so it keeps its
   *  status, its wall seat and its restore. This pane borrows its screen while it is up. */
  let cpoSession: Session | null = cpo.current();
  let starting = false;
  /** Borrow the manager's screen into this pane — only while the pane is what you are looking at. */
  const lendCpo = (): void => {
    cpoSession = cpo.current();
    if (cpoSession && visible) {
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

  /* ---------------------------------------------------------------- state */

  /** The class is what CSS reads; the callback is what the shell reads. Both say the same thing,
   *  and the shell is the one that decides which screen goes back on the glass. */
  const applyVisible = (): void => {
    document.documentElement.classList.toggle("chat-hidden", !visible);
    events.visibility(visible);
  };

  hideButton.addEventListener("click", () => handle.hide());

  const handle: ChatHandle = {
    show() {
      const entering = !visible;
      visible = true;
      // Started from the wall, restored at boot or ended elsewhere: ask, never assume.
      cpoSession = cpo.current();
      paintCpoStart();
      if (entering) applyVisible();
      requestAnimationFrame(() => {
        if (visible) lendCpo();
      });
    },

    hide() {
      if (!visible) return;
      visible = false;
      cpo.unlend();
      applyVisible();
    },

    toggle() {
      if (visible) handle.hide();
      else handle.show();
    },

    isVisible: () => visible,

    async seedCpo(prompt) {
      handle.show();
      if (!cpoSession) {
        const preferred = (localStorage.getItem(CPO_KIND_KEY) as SessionKind | null) ?? "claude";
        await startCpo(preferred);
      }
      if (!cpoSession) return;
      await cpo.write(cpoSession.terminal_id, `${prompt}\r`);
      lendCpo();
    },

    noteExit(sessionId) {
      if (cpoSession?.id === sessionId) endCpo();
    },
  };

  paintCpoStart();
  return handle;
}
