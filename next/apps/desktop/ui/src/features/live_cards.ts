/**
 * The cards of the Inbox: the business the board and the agents raise for the owner.
 *
 * Five kinds, each answering one need. Decide is a call only he can make (his board agenda).
 * Your Turn is a session he runs that waits for him. Done is what got finished since he last
 * looked. Decided is calls agents made in his place. Better is a step that keeps losing time.
 * Permission prompts never come here. The Inbox adds three more kinds from the screens it
 * replaced: see inbox_cards.ts.
 *
 * A card is one message in the Inbox's feed (inbox_feed.ts), beside what the agents sent. Until
 * 2026-11-15 the cards were a queue, one at a time, ordered by value per minute. The owner found
 * it unusable: "It should be just something like slack." So the order is time now, and `KIND`
 * says which kinds wait for an answer.
 *
 * Pure: no DOM, no clock of its own. foryou.ts feeds it the board, the agents and what he has seen.
 * A new kind is one line in `KIND` and a builder that makes its cards.
 */

export type CardKind = "decide" | "turn" | "done" | "decided" | "better" | "review" | "support" | "ended";

export type Act =
  | { do: "answer"; number: number; pick: number }
  | { do: "seen" }
  | { do: "terminal"; panel: string }
  | { do: "url"; url: string }
  /** Look at what an agent made, in the review deck over the Inbox. */
  | { do: "review"; project: string; paths: string[] }
  /** Pick a finished conversation back up. */
  | { do: "resume"; session: string }
  /** The whole support log, with its setup when a form cannot be read. */
  | { do: "support" };

// The Manager was a third place to talk. Owner, 2026-11-05: "its no more needed".
export type Talk = { to: "board"; number: number } | { to: "agent"; panel: string; name: string };

export type Card = {
  id: string;
  kind: CardKind;
  room: string;
  title: string;
  lines: string[];
  options: { label: string; act: Act }[];
  talk: Talk | null;
  /** When the card's reason began: the ask, the first unseen close, the end of a turn. */
  arrivedMs: number;
  /** Keys a Seen tap marks, so the same items never come back. */
  seenKeys: string[];
  number?: number;
  url?: string;
  pictures?: string[];
  agent?: string;
  /** Done and Decided list what they cover, newest first. The card shows four. */
  items?: string[];
  /** A picture the webview can show as it is, with no trip through the scout module. */
  pictureSrc?: string;
  /** What Seen also clears at its source: support message ids, or review file paths. */
  refs?: string[];
};

export type BoardIssue = {
  number: number;
  title: string;
  url: string;
  apps: string[];
  priority?: number;
  ask?: string;
  options?: string[];
  show?: string[];
  problem?: string;
  why?: string;
  direction?: string;
  decided?: string;
  kinds?: string[];
  created_at?: string;
  closed_at?: string | null;
  dropped?: boolean;
  holder?: string;
};

export type BoardFeed = {
  you?: BoardIssue[];
  now?: BoardIssue[];
  ready?: BoardIssue[];
  waiting?: BoardIssue[];
  done?: BoardIssue[] | null;
  apps?: Record<string, { name: string }>;
};

export type CardAgent = {
  id: string;
  name: string;
  room: string;
  state: string;
  stateMs: number | null;
  headless: boolean;
  panel: string | null;
  lastText: string | null;
};

/** `needsYou`: the card waits for an answer or a look. The rest are read, and then gone. */
export const KIND: Record<CardKind, { label: string; needsYou: boolean }> = {
  decide: { label: "Decide", needsYou: true },
  turn: { label: "Your Turn", needsYou: true },
  review: { label: "Review", needsYou: true },
  support: { label: "Support", needsYou: false },
  better: { label: "Better", needsYou: false },
  decided: { label: "Decided", needsYou: false },
  done: { label: "Done", needsYou: false },
  ended: { label: "Ended", needsYou: false },
};

/** With nothing seen yet, Done looks back one day. */
const DONE_LOOKBACK_MS = 24 * 3600_000;
const BETTER_MAX = 3;

const ms = (iso: string | null | undefined, fallback: number): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : fallback;
};

const clip = (text: string, n: number): string => (text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text);

/** Every card the board and the agents give right now. `seen` maps a seen key to when he saw it. */
export function buildCards(
  board: BoardFeed | null,
  agents: CardAgent[],
  roomName: (room: string) => string,
  seen: Record<string, number>,
  now: number,
): Card[] {
  const cards: Card[] = [];
  const roomOf = (i: BoardIssue) => i.apps[0] ?? "hq";

  for (const i of board?.you ?? []) {
    const room = roomOf(i);
    const options = (i.options ?? []).slice(0, 3).map((label, k) => ({ label, act: { do: "answer", number: i.number, pick: k + 1 } as Act }));
    cards.push({
      id: `decide:${i.number}`,
      kind: "decide",
      room,
      title: i.ask?.trim() || i.title,
      // The card's who line already names the issue number.
      lines: [i.why ? clip(i.why, 600) : i.ask ? i.title : ""].filter(Boolean),
      options,
      talk: { to: "board", number: i.number },
      arrivedMs: ms(i.created_at, now),
      seenKeys: [],
      number: i.number,
      url: i.url,
      pictures: i.show,
    });
  }

  for (const a of agents) {
    if (a.state !== "turn" || a.headless) continue;
    const key = `turn:${a.id}:${a.stateMs ?? 0}`;
    if (seen[key]) continue;
    cards.push({
      id: key,
      kind: "turn",
      room: a.room,
      title: `${a.name} waits for you`,
      lines: a.lastText ? [clip(a.lastText, 600)] : [],
      options: a.panel ? [{ label: "Open Terminal", act: { do: "terminal", panel: a.panel } }, { label: "Dismiss", act: { do: "seen" } }] : [{ label: "Dismiss", act: { do: "seen" } }],
      talk: a.panel ? { to: "agent", panel: a.panel, name: a.name } : null,
      arrivedMs: a.stateMs ?? now,
      seenKeys: [key],
      agent: a.id,
    });
  }

  const byRoom = new Map<string, BoardIssue[]>();
  for (const i of board?.done ?? []) {
    if (i.dropped) continue;
    const room = roomOf(i);
    const at = ms(i.closed_at, 0);
    if (at <= (seen[`done:${room}`] ?? now - DONE_LOOKBACK_MS)) continue;
    byRoom.set(room, [...(byRoom.get(room) ?? []), i]);
  }
  for (const [room, list] of byRoom) {
    const first = Math.min(...list.map((i) => ms(i.closed_at, now)));
    const newest = [...list].sort((a, b) => ms(b.closed_at, 0) - ms(a.closed_at, 0));
    cards.push({
      id: `done:${room}`,
      kind: "done",
      room,
      title: `${list.length} done in ${roomName(room)}`,
      lines: [],
      items: newest.map((i) => `#${i.number} ${clip(i.title, 90)}`),
      options: [{ label: "Open First", act: { do: "url", url: list[0].url } }],
      talk: null,
      arrivedMs: first,
      seenKeys: [`done:${room}`],
    });
  }

  const calls = new Map<string, BoardIssue[]>();
  for (const i of [...(board?.now ?? []), ...(board?.ready ?? [])]) {
    if (!i.decided?.trim() || seen[`decided:${i.number}`]) continue;
    const room = roomOf(i);
    calls.set(room, [...(calls.get(room) ?? []), i]);
  }
  for (const [room, list] of calls) {
    cards.push({
      id: `decided:${room}`,
      kind: "decided",
      room,
      title: `${list.length === 1 ? "1 call" : `${list.length} calls`} made for you in ${roomName(room)}`,
      lines: [],
      items: list.map((i) => `#${i.number} ${clip(i.decided!.trim(), 400)}`),
      options: [{ label: "Open First", act: { do: "url", url: list[0].url } }],
      talk: null,
      // The board does not say when the call was made, and the issue's age overstates it: an
      // old issue's note would jump ahead of a decision agents wait on. So it never ages.
      arrivedMs: now,
      seenKeys: list.map((i) => `decided:${i.number}`),
    });
  }

  const slow = [...(board?.ready ?? []), ...(board?.waiting ?? [])]
    .filter((i) => i.kinds?.includes("speed") && !seen[`better:${i.number}`])
    .sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9))
    .slice(0, BETTER_MAX);
  for (const i of slow) {
    const room = roomOf(i);
    cards.push({
      id: `better:${i.number}`,
      kind: "better",
      room,
      title: i.title,
      lines: [i.problem ? clip(i.problem, 400) : "", i.direction ? `Proposal: ${clip(i.direction, 400)}` : ""].filter(Boolean),
      options: [{ label: "Open Issue", act: { do: "url", url: i.url } }],
      talk: null,
      arrivedMs: ms(i.created_at, now),
      seenKeys: [`better:${i.number}`],
      number: i.number,
      url: i.url,
    });
  }
  return cards;
}
