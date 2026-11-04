/**
 * Live's queue: the business that reaches the owner, one card at a time, in one order.
 *
 * Five kinds, each answering one need. Decide is a call only he can make (his board agenda).
 * Your Turn is a session he runs that waits for him. Done is what got finished since he last
 * looked. Decided is calls agents made in his place. Better is a step that keeps losing time.
 * Permission prompts never come here.
 *
 * The order is Smith's rule: value per minute of his time, highest first, and a waiting card
 * slowly rises so nothing starves. The card in front never changes under his hand.
 *
 * Pure: no DOM, no clock of its own. live.ts feeds it the board, the agents and what he has seen.
 */

export type CardKind = "decide" | "turn" | "done" | "decided" | "better";

export type Act =
  | { do: "answer"; number: number; pick: number }
  | { do: "seen" }
  | { do: "terminal"; panel: string }
  | { do: "url"; url: string };

export type Talk =
  | { to: "board"; number: number }
  | { to: "agent"; panel: string; name: string }
  | { to: "manager" };

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
  /** What answering it costs him, in minutes. */
  minutes: number;
  stake: number;
  /** Keys a Seen tap marks, so the same items never come back. */
  seenKeys: string[];
  number?: number;
  url?: string;
  pictures?: string[];
  agent?: string;
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

export const KIND: Record<CardKind, { weight: number; minutes: number; label: string }> = {
  decide: { weight: 3, minutes: 1, label: "Decide" },
  better: { weight: 2, minutes: 1.5, label: "Better" },
  turn: { weight: 2, minutes: 2, label: "Your Turn" },
  decided: { weight: 1, minutes: 0.5, label: "Decided" },
  done: { weight: 1, minutes: 1, label: "Done" },
};

/** A card older than this rises no further. An ask from last week is not 100 times more urgent. */
const WAIT_CAP_MIN = 8 * 60;
/** With nothing seen yet, Done looks back one day. */
const DONE_LOOKBACK_MS = 24 * 3600_000;
const BETTER_MAX = 3;

export function priority(card: Card, now: number): number {
  const wait = Math.min(WAIT_CAP_MIN, Math.max(0, (now - card.arrivedMs) / 60_000));
  return (card.stake * (1 + wait / 60)) / card.minutes;
}

/**
 * Highest priority first. `front` stays first while it exists, so a new card lines up behind the
 * one he is reading. A card put off with Later goes to the back until its time is up.
 */
export function order(cards: Card[], now: number, front: string | null, later: Record<string, number>): Card[] {
  const put = (c: Card) => (later[c.id] ?? 0) > now;
  const sorted = [...cards].sort(
    (a, b) => Number(put(a)) - Number(put(b)) || priority(b, now) - priority(a, now) || a.id.localeCompare(b.id),
  );
  const at = front ? sorted.findIndex((c) => c.id === front && !put(c)) : -1;
  if (at > 0) sorted.unshift(...sorted.splice(at, 1));
  return sorted;
}

const ms = (iso: string | null | undefined, fallback: number): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : fallback;
};

const clip = (text: string, n: number): string => (text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text);

/**
 * Every card the board and the agents give right now. `weight` is the room's stake (3 for an app
 * that earns, 2 in a store, 1 for the rest). `seen` maps a seen key to when he saw it.
 */
export function buildCards(
  board: BoardFeed | null,
  agents: CardAgent[],
  weight: (room: string) => number,
  roomName: (room: string) => string,
  seen: Record<string, number>,
  now: number,
): Card[] {
  const cards: Card[] = [];
  const stake = (room: string, kind: CardKind) => weight(room) * KIND[kind].weight;
  const roomOf = (i: BoardIssue) => i.apps[0] ?? "hq";

  for (const i of board?.you ?? []) {
    const room = roomOf(i);
    const options = (i.options ?? []).slice(0, 3).map((label, k) => ({ label, act: { do: "answer", number: i.number, pick: k + 1 } as Act }));
    cards.push({
      id: `decide:${i.number}`,
      kind: "decide",
      room,
      title: i.ask?.trim() || i.title,
      lines: [i.ask ? `#${i.number} ${i.title}` : `#${i.number}`, i.why ? clip(i.why, 220) : ""].filter(Boolean),
      options,
      talk: { to: "board", number: i.number },
      arrivedMs: ms(i.created_at, now),
      minutes: KIND.decide.minutes,
      stake: stake(room, "decide"),
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
      lines: a.lastText ? [`Said: ${clip(a.lastText, 220)}`] : [],
      options: a.panel ? [{ label: "Open Terminal", act: { do: "terminal", panel: a.panel } }, { label: "Seen", act: { do: "seen" } }] : [{ label: "Seen", act: { do: "seen" } }],
      talk: a.panel ? { to: "agent", panel: a.panel, name: a.name } : null,
      arrivedMs: a.stateMs ?? now,
      minutes: KIND.turn.minutes,
      stake: stake(a.room, "turn"),
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
    cards.push({
      id: `done:${room}`,
      kind: "done",
      room,
      title: `${roomName(room)}: ${list.length} done`,
      lines: [...list.slice(0, 4).map((i) => `#${i.number} ${clip(i.title, 90)}`), ...(list.length > 4 ? [`and ${list.length - 4} more`] : [])],
      options: [{ label: "Seen", act: { do: "seen" } }, { label: "Open First", act: { do: "url", url: list[0].url } }],
      talk: { to: "manager" },
      arrivedMs: first,
      minutes: KIND.done.minutes,
      stake: stake(room, "done"),
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
      title: `${roomName(room)}: ${list.length === 1 ? "1 call" : `${list.length} calls`} made for you`,
      lines: list.slice(0, 4).map((i) => `#${i.number} ${clip(i.decided!.trim(), 160)}`),
      options: [{ label: list.length === 1 ? "Keep It" : "Keep All", act: { do: "seen" } }],
      talk: { to: "manager" },
      // The board does not say when the call was made, and the issue's age overstates it: an
      // old issue's note would jump ahead of a decision agents wait on. So it never ages.
      arrivedMs: now,
      minutes: KIND.decided.minutes,
      stake: stake(room, "decided"),
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
      lines: [i.problem ? clip(i.problem, 200) : "", i.direction ? `Proposal: ${clip(i.direction, 200)}` : ""].filter(Boolean),
      options: [{ label: "Seen", act: { do: "seen" } }, { label: "Open Issue", act: { do: "url", url: i.url } }],
      talk: { to: "manager" },
      arrivedMs: ms(i.created_at, now),
      minutes: KIND.better.minutes,
      stake: stake(room, "better"),
      seenKeys: [`better:${i.number}`],
      number: i.number,
      url: i.url,
    });
  }
  return cards;
}

/** "6 cards · about 7 min". */
export function queueLine(cards: Card[]): string {
  if (!cards.length) return "Nothing needs you. You can leave.";
  const minutes = Math.max(1, Math.round(cards.reduce((n, c) => n + c.minutes, 0)));
  return `${cards.length} ${cards.length === 1 ? "card" : "cards"} · about ${minutes} min`;
}

/** What the Manager gets when he talks about a card that has no agent of its own. */
export function managerBrief(card: Card, words: string): string {
  const head = `About this ${KIND[card.kind].label} card in Panel Live: ${card.title}`;
  return [head, ...card.lines.map((l) => `- ${l}`), card.url ? `Issue: ${card.url}` : "", "", `Owner: ${words}`].filter((l, i) => l || i > 0).join("\n");
}
