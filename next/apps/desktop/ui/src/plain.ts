/**
 * Agent words, as a person reads them.
 *
 * Nearly every sentence Panel shows was written by an agent: report titles, last replies, ops
 * lines. Agents write markdown for other agents, long and dense. A screen shows one plain line
 * per item and keeps the full text one click away. Every screen that shows agent words cleans
 * them here, so the rule lives in one place.
 */

/** Markdown and machine noise out, line breaks kept: code blocks, bold, code ticks, links,
 *  heading, quote and bullet marks, `[done-when: …]` tags. */
export function plainLines(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, "")
    .replace(/!?\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s*\[[a-z-]+:[^\]]*\]/gi, "")
    .replace(/\*\*|__|`/g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+•]\s+|\d+[.)]\s+)/, "").replace(/[ \t]+/g, " ").trim())
    // One blank line between paragraphs, never a run of them.
    .filter((line, index, lines) => line !== "" || (index > 0 && lines[index - 1] !== ""))
    .join("\n")
    .trim();
}

/** `plainLines` on one line. */
export function plainText(text: string): string {
  return plainLines(text).replace(/\s+/g, " ").trim();
}

/** The first sentence, without asides, short enough for one line. */
export function headline(text: string, max = 72): string {
  const clean = plainText(text).replace(/\s*\([^()]*\)/g, "");
  const first = clean.split(/(?<=[.!?])\s+(?=[\p{L}\p{N}"'“])|;\s+/u)[0] ?? clean;
  // "Decide the launch order of the new levels: easy first…" already has its headline
  // before the colon. A head of one to three words ("Cosmetics:", "Left on iOS:") is a label,
  // not a headline, so the sentence goes on.
  const head = /^([^:]+):\s/.exec(first)?.[1] ?? "";
  let out = (head.split(" ").length >= 4 ? head : first).replace(/[.:;,\s]+$/, "").trim();
  if (out.length > max) {
    const cut = out.slice(0, max);
    const space = cut.lastIndexOf(" ");
    out = `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[,;:\s-]+$/, "")}…`;
  }
  return out.charAt(0).toUpperCase() + out.slice(1);
}
