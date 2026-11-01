import type { Move, Verdict } from "./swipe";

/** A ← reopens or drops an issue, so it counts only with words for the agent. A bare ← is a slip. */
export const needsNote = (move: Move, note: string): boolean => move === "left" && !note.trim();

/** Judges card `at`: a new card at the end, or a card you walked back to, changed in place.
 *  Null when the move still needs its note. The list stays one verdict per card, in deck order. */
export function judge(verdicts: Verdict[], at: number, verdict: Verdict): Verdict[] | null {
  if (needsNote(verdict.move, verdict.note) || at < 0 || at > verdicts.length) return null;
  const next = verdicts.slice();
  next[at] = verdict;
  return next;
}
