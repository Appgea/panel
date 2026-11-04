/**
 * Plain helpers for the Board, pure so they are tested (tests/board_score.test.mjs): closes per local
 * day, title tags and the engine behind a holder. No XP or streaks. Owner, 2026-11-04: "remove them".
 */

export type Closed = { closed_at?: string | null; dropped?: boolean };
export type Day = { date: string; count: number };

/** A local calendar day, "2026-11-01". */
export const dayKey = (at: Date): string => {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
};

/** Closes per local day for the last `span` days, oldest first, today last. A dropped issue is not done. */
export function days(done: Closed[], now = new Date(), span = 14): { today: Day; days: Day[] } {
  const list: Day[] = [];
  const index = new Map<string, Day>();
  for (let back = span - 1; back >= 0; back--) {
    const day = { date: dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - back)), count: 0 };
    list.push(day);
    index.set(day.date, day);
  }
  for (const card of done) {
    if (!card.closed_at || card.dropped) continue;
    const day = index.get(dayKey(new Date(card.closed_at)));
    if (day) day.count++;
  }
  return { today: list[list.length - 1], days: list };
}

/**
 * "videokit: read stayed-to-watch by API" says its app twice: the tile already shows it.
 * "Speed: review loop" names a kind of work, which reads better as a tag.
 * Returns the title without the prefix, and the prefix as a tag unless it only named the app.
 */
export function splitTitle(title: string, appWords: string[]): { tag: string; title: string } {
  const m = /^([^:]{2,28}):\s+(.{3,})$/.exec(title);
  if (!m || m[1].split(/\s+/).length > 3) return { tag: "", title };
  const prefix = m[1].trim();
  const plain = (s: string): string => s.toLowerCase().replace(/[^a-z0-9ığüşöç]/g, "");
  const rest = m[2].charAt(0).toUpperCase() + m[2].slice(1);
  if (appWords.some((word) => plain(word) && plain(word) === plain(prefix))) return { tag: "", title: rest };
  return { tag: prefix, title: rest };
}

/** "codex-a974d24e" → the engine that holds it, for the avatar's colour and name. */
export function engineOf(holder: string): { key: string; name: string } {
  const head = holder.toLowerCase().split(/[-_\s,]/)[0] ?? "";
  const known: Record<string, string> = {
    claude: "Claude", codex: "Codex", sol: "Codex", terra: "Codex", grok: "Grok", kimi: "Kimi",
    gemini: "Gemini", opencode: "OpenCode", glm: "GLM", deepseek: "DeepSeek", sonnet: "Claude", haiku: "Claude",
    opus: "Claude", fable: "Claude", luna: "Codex",
  };
  const name = known[head];
  // DeepSeek has no engine colour in the tokens, so it wears the neutral one.
  if (name) return { key: name === "Codex" ? "codex" : name === "Claude" ? "claude" : name === "DeepSeek" ? "other" : head, name };
  return { key: "other", name: holder.split(/[-_]/)[0] || holder };
}
