/**
 * The session strip — every terminal running on this project.
 *
 * This sits immediately above the terminal content it controls. A project can hold as many
 * sessions as you open: several agents, several shells, side by side. Selecting one only changes
 * which screen you SEE; every other session keeps running. Opening another is the NEW row's job
 * (project_terminals.ts); a second row of the same buttons here only made you choose between twins.
 *
 * The strip is pure presentation. It owns no PTY and no state beyond what it is handed — the
 * spine holds the sessions, this draws them and reports clicks.
 */

import type { Session } from "../types";
import "./sessions.css";

export type SessionStripEvents = {
  select(sessionId: string): void;
  close(sessionId: string): void;
  skills?(sessionId: string | null): void;
};

export type SessionStripHandle = {
  /** Redraw for one project. `active` is the session whose screen is showing. An exited session
   *  that is only `asleep` says so, since Wake brings it back. */
  paint(
    sessions: Session[],
    active: string | null,
    exited: ReadonlySet<string>,
    asleep?: { has(id: string): boolean },
  ): void;
};

export function mountSessionStrip(host: HTMLElement, events: SessionStripEvents): SessionStripHandle {
  host.innerHTML = `<div class="sess-tabs"></div><div class="sess-new"></div>`;

  const tabs = host.querySelector<HTMLElement>(".sess-tabs")!;
  const news = host.querySelector<HTMLElement>(".sess-new")!;
  let selected: string | null = null;
  const skills = document.createElement("button");
  skills.type = "button";
  skills.className = "sess-add";
  skills.textContent = "Skills";
  skills.title = "Session skills and shared workflows";
  skills.addEventListener("click", () => events.skills?.(selected));
  if (events.skills) news.append(skills);

  return {
    paint(sessions, active, exited, asleep) {
      selected = active && !exited.has(active) ? active : null;
      // No sessions: the terminal area itself says so and offers the start (#terminalEmpty), so
      // the strip stays quiet rather than saying it a second time.
      if (!sessions.length) {
        tabs.replaceChildren();
        return;
      }

      tabs.replaceChildren(
        ...sessions.map((session) => {
          const dead = exited.has(session.id);
          const tab = document.createElement("div");
          tab.className = `sess-tab k-${session.kind}`;
          tab.classList.toggle("is-active", session.id === active);
          tab.classList.toggle("is-dead", dead);

          tab.innerHTML = `
            <i class="sess-dot"></i>
            <span class="sess-name"></span>
            ${dead ? `<span class="sess-ended">${asleep?.has(session.id) ? "asleep" : "ended"}</span>` : ""}
            <button class="sess-x" type="button" aria-label="close session">×</button>`;
          tab.querySelector(".sess-name")!.textContent = session.title;

          tab.addEventListener("click", (event) => {
            if ((event.target as HTMLElement).closest(".sess-x")) {
              events.close(session.id);
              return;
            }
            events.select(session.id);
          });
          return tab;
        }),
      );
    },
  };
}
