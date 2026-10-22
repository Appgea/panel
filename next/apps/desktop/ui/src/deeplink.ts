/**
 * Panel links — how an agent points the human at a place instead of describing it.
 *
 * Four places, and that is on purpose. An agent that could name any tab would name the wrong one;
 * what the human actually does with a report is look at what was made, read the code, now and
 * then check Git, or go back to the Manager. So:
 *
 *   panel:review                 this project's work waiting in Review
 *   panel:review:<path>          Review, on that file
 *   panel:work:<path>[:line]     the file in the project's Work editor, at that line
 *   panel:git                    the project's Git tab
 *   panel:manager                the Manager
 *
 * The project is never in the link. It is the project of whatever carried it: the post, or the
 * terminal it was printed in. The `panel:` prefix is what keeps "git" and "manager" in ordinary
 * prose from turning into links; a report's structured `links` field may leave it off.
 */

export type Place =
  | { to: "review"; path?: string }
  | { to: "work"; path: string; line?: number }
  | { to: "git" }
  | { to: "manager" };

/** What the terminal underlines. Paths stop at whitespace, quotes and brackets around them. */
export const PLACE_IN_TEXT = /\bpanel:(?:review(?::[^\s'"`<>()[\]]+)?|work:[^\s'"`<>()[\]]+|git|manager)\b/g;

/** A link to a Panel place, or null for anything else (a web URL, a typo, an unknown place). */
export function parsePlace(link: string): Place | null {
  const text = link.trim().replace(/^panel:/, "").replace(/[.,;]+$/, "");
  const at = text.indexOf(":");
  const verb = at < 0 ? text : text.slice(0, at);
  const rest = at < 0 ? "" : text.slice(at + 1).replace(/^\.\//, "");
  switch (verb) {
    case "review":
      return rest ? { to: "review", path: rest } : { to: "review" };
    case "work": {
      if (!rest) return null;
      const match = /^(.*?):(\d+)$/.exec(rest);
      return match ? { to: "work", path: match[1], line: Number(match[2]) } : { to: "work", path: rest };
    }
    case "git":
    case "manager":
      return rest ? null : { to: verb };
    default:
      return null;
  }
}

/** The button's words. A path reads as its file name; the full link stays in the tooltip. */
export function placeLabel(place: Place): { kind: string; name: string } {
  const file = (path: string): string => path.replaceAll("\\", "/").split("/").pop() || path;
  switch (place.to) {
    case "review":
      return { kind: "Review", name: place.path ? file(place.path) : "what was made" };
    case "work":
      return { kind: "Code", name: place.line ? `${file(place.path)}:${place.line}` : file(place.path) };
    case "git":
      return { kind: "Git", name: "changes" };
    case "manager":
      return { kind: "Manager", name: "open" };
  }
}
