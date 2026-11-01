/**
 * The Board's score: what got done, how big it was, and how many days in a row. Pure, so it is tested
 * (tests/board_score.test.mjs). XP is one point per estimated minute, so a number on screen always
 * means real work. An issue closed with no estimate counts as a small one.
 */

export type Closed = { closed_at?: string | null; estimate?: number; dropped?: boolean };

export const NO_ESTIMATE_XP = 15;

export type Day = { date: string; count: number; xp: number };
export type Score = {
  today: Day;
  /** Oldest first, today last. */
  days: Day[];
  week: number;
  lastWeek: number;
  /** Days in a row with at least one close, up to today. A day not over yet does not break it. */
  streak: number;
  dropped: number;
};

/** A local calendar day, "2026-11-01". */
export const dayKey = (at: Date): string => {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
};

export const xpOf = (card: { estimate?: number }): number =>
  card.estimate && card.estimate > 0 ? card.estimate : NO_ESTIMATE_XP;

export function score(done: Closed[], now = new Date(), span = 14): Score {
  const days: Day[] = [];
  const index = new Map<string, Day>();
  for (let back = span - 1; back >= 0; back--) {
    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
    const day = { date: dayKey(at), count: 0, xp: 0 };
    days.push(day);
    index.set(day.date, day);
  }
  let dropped = 0;
  for (const card of done) {
    if (!card.closed_at) continue;
    const day = index.get(dayKey(new Date(card.closed_at)));
    if (!day) continue;
    if (card.dropped) {
      dropped++;
      continue;
    }
    day.count++;
    day.xp += xpOf(card);
  }
  const sum = (from: number, to: number): number => days.slice(from, to).reduce((total, d) => total + d.xp, 0);
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].count) streak++;
    else if (i !== days.length - 1) break;
  }
  return {
    today: days[days.length - 1],
    days,
    week: sum(days.length - 7, days.length),
    lastWeek: sum(Math.max(0, days.length - 14), days.length - 7),
    streak,
    dropped,
  };
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
