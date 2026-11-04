/**
 * The animation catalog: every script Live plays, one per verb, newest first, with the ones
 * still being written on top. The owner plays one on an agent to see it, and holds Delete on a
 * bad one. The next agent doing that verb gets a new script written (catalog.rs).
 */

import { errorText } from "../errors";
import { ago, button, div, holdButton, span } from "./live_text";
import type { LiveCtx } from "./live_types";
import type { Script } from "./live_script";
import "./live_catalog.css";

export type Catalog = { paint(): void; toggle(): void; count(): number; isOpen(): boolean };

/** `changed` runs after it opens or closes, so the column beside the map can show the right part. */
export function mountCatalog(ctx: LiveCtx, el: HTMLElement, playOn: (verb: string) => boolean, changed: () => void): Catalog {
  el.hidden = true;

  function scripts(): Script[] {
    return [...(ctx.s.world?.catalog ?? [])].sort((a, b) => Number(!!b.pending) - Number(!!a.pending) || (b.madeMs ?? 0) - (a.madeMs ?? 0));
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
    if (el.hidden || el.querySelector(".is-holding")) return;
    const list = scripts();
    const now = Date.now();
    const head = div("cat-head");
    head.append(span("cat-title", "Animations"), span("cat-count", `${list.filter((x) => !x.pending).length} in the catalog`), button("cat-close", "Close", toggle));
    const rows = list.map((x) => {
      const row = div(`cat-row${x.pending ? " is-pending" : ""}`);
      const top = div("cat-top");
      top.append(span("cat-name", x.pending ? "Being written" : (x.title ?? x.verb)), span("cat-verb", x.verb));
      row.append(top);
      if (x.about) row.append(div("cat-about", x.about));
      const meta = x.pending ? "An agent did this and no animation existed yet." : [x.by ? `by ${x.by}` : "", x.madeMs ? ago(x.madeMs, now) : "", `${x.steps?.length ?? 0} moves`].filter(Boolean).join(" · ");
      row.append(div("cat-meta", meta));
      if (!x.pending) {
        const acts = div("cat-acts");
        acts.append(
          button("opt", "Play", () => {
            if (!playOn(x.verb)) ctx.toast("No agent on the map to play it on.", true);
          }),
          holdButton("Hold to delete", () => void remove(x.verb)),
        );
        row.append(acts);
      }
      return row;
    });
    el.replaceChildren(head, ...(rows.length ? rows : [div("cat-empty", "No animations yet. Each new kind of step gets one.")]));
  }

  function toggle(): void {
    el.hidden = !el.hidden;
    paint();
    changed();
  }

  return { paint, toggle, count: () => scripts().filter((x) => !x.pending).length, isOpen: () => !el.hidden };
}
