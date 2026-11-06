/**
 * The animation catalog: every script Live plays, one per verb, newest first, with the ones
 * still being written on top. The owner plays one on an agent to see it, and holds Delete on a
 * bad one. The next agent doing that verb gets a new script written (catalog.rs).
 */

import { errorText } from "../errors";
import { ago, button, div, holdButton, span } from "./live_text";
import type { LiveCtx } from "./live_types";
import { glyphPath, type Script } from "./live_script";
import "./live_catalog.css";

const SVG = "http://www.w3.org/2000/svg";

export type Catalog = { paint(): void; toggle(): void; count(): number; isOpen(): boolean };

/** `changed` runs after it opens or closes, so the column beside the map can show the right part. */
export function mountCatalog(ctx: LiveCtx, el: HTMLElement, playOn: (verb: string) => boolean, changed: () => void): Catalog {
  el.hidden = true;

  function scripts(): Script[] {
    return [...(ctx.s.world?.catalog ?? [])].sort((a, b) => Number(!!b.pending) - Number(!!a.pending) || (b.madeMs ?? 0) - (a.madeMs ?? 0));
  }

  /** The verb whose note box is open. One at a time. */
  let asking: string | null = null;

  async function improve(verb: string, note: string): Promise<void> {
    try {
      await ctx.events.improveAnimation(verb, note);
      asking = null;
      el.querySelector(".reply")?.remove();
      ctx.toast(`An agent is improving ${verb}. The old one plays until the new one is ready.`);
      ctx.poll();
    } catch (e) {
      ctx.toast(`Could not improve ${verb}: ${errorText(e, "refused")}`, true);
    }
  }

  function noteBox(verb: string): HTMLInputElement {
    const input = document.createElement("input");
    input.className = "reply";
    input.type = "text";
    input.autocomplete = "off";
    input.placeholder = "What should it show better? Enter sends.";
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        asking = null;
        input.remove();
        paint();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const note = input.value.trim();
        if (note) void improve(verb, note);
      }
    });
    return input;
  }

  async function remove(verb: string): Promise<void> {
    try {
      await ctx.events.deleteAnimation(verb);
      ctx.toast(`Deleted ${verb}. The next agent doing it gets a new one.`);
      ctx.poll();
    } catch (e) {
      ctx.toast(`Could not delete ${verb}: ${errorText(e, "refused")}`, true);
    }
  }

  function paint(): void {
    // A hand on Delete or an open note box keeps the list as it is, so the poll never takes the
    // box's focus. Enter, Escape or Improve again closes the box and lets it repaint.
    if (el.hidden || el.querySelector(".is-holding") || (asking && el.querySelector(".reply"))) return;
    const list = scripts();
    const now = Date.now();
    const head = div("cat-head");
    head.append(span("cat-title", "Animations"), span("cat-count", `${list.filter((x) => !x.pending).length} in the catalog`), button("cat-close", "Close", toggle));
    const rows = list.map((x) => {
      const row = div(`cat-row${x.pending ? " is-pending" : ""}`);
      const top = div("cat-top");
      top.append(span("cat-name", x.pending ? "Being written" : (x.title ?? x.verb)), glyphRow(x), span("cat-verb", x.verb));
      row.append(top);
      if (x.about) row.append(div("cat-about", x.about));
      const meta = x.pending
        ? "An agent did this and no animation existed yet."
        : x.improving
          ? "Being improved. This one plays until the new one is ready."
          : [x.by ? `by ${x.by}` : "", x.improved ? `improved: “${x.improved}”` : "", x.madeMs ? ago(x.madeMs, now) : "", `${x.steps?.length ?? 0} moves`].filter(Boolean).join(" · ");
      row.append(div("cat-meta", meta));
      if (!x.pending) {
        const acts = div("cat-acts");
        acts.append(
          button("opt", "Play", () => {
            if (!playOn(x.verb)) ctx.toast("No agent on the map to play it on.", true);
          }),
        );
        if (!x.improving)
          acts.append(
            button("opt", "Improve", () => {
              asking = asking === x.verb ? null : x.verb;
              el.querySelector(".reply")?.remove();
              paint();
              el.querySelector<HTMLInputElement>(".reply")?.focus();
            }),
          );
        acts.append(holdButton("Hold to delete", () => void remove(x.verb)));
        row.append(acts);
        if (asking === x.verb) row.append(noteBox(x.verb));
      }
      return row;
    });
    el.replaceChildren(head, ...(rows.length ? rows : [div("cat-empty", "No animations yet. Each new kind of step gets one.")]));
  }

  /** The glyphs a script draws, so the list shows what each one looks like before it plays. */
  function glyphRow(x: Script): HTMLElement {
    const row = span("cat-glyphs");
    const names = [...new Set((x.steps ?? []).filter((m) => m?.do === "glyph").map((m) => m.name))];
    for (const name of names.slice(0, 4)) {
      const d = glyphPath(x, name);
      if (!d) continue;
      const svg = document.createElementNS(SVG, "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      const path = document.createElementNS(SVG, "path");
      path.setAttribute("d", d);
      svg.append(path);
      svg.setAttribute("aria-label", String(name));
      row.append(svg);
    }
    return row;
  }

  function toggle(): void {
    el.hidden = !el.hidden;
    paint();
    changed();
  }

  return { paint, toggle, count: () => scripts().filter((x) => !x.pending).length, isOpen: () => !el.hidden };
}
