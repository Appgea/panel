/**
 * The Inbox as one feed, like a Slack channel: what agents sent and the cards the board raises,
 * in the order they arrived, newest last. A project is a channel.
 *
 * Owner, 2026-11-15: "It should be just something like slack, extendable. I simply want to open
 * Inbox and easily see what agents send me." It was a queue that showed one card at a time, and a
 * report was a card that opened a second screen where its text sat folded.
 *
 * Two things can be in the feed. A post is a message an agent sent, kept for a month
 * (src-tauri inbox.rs). A card is live state: it stands while its reason does (live_cards.ts,
 * inbox_cards.ts). A new source is a builder that makes cards. Nothing here changes for it.
 *
 * Read marks are the `seen` record the cards already use. A post is read once a newer mark exists
 * for its project, so "read up to here" is one number per channel.
 *
 * Pure: no DOM, no clock of its own.
 */

import type { Payload } from "../types";
import { KIND, type Card } from "./live_cards";

/** One message an agent sent. The window keeps these, and the backend stores them as they are. */
export type InboxPost = {
  id: string;
  project: string;
  projectName: string;
  author: string;
  /** Stable engine identity for the avatar; the title alone may be "codex 2". */
  agentKind: string;
  /** The Panel session that sent it, the door back to that terminal. Null when unknown. */
  session: string | null;
  /** Files observed changing in this agent turn. They are the evidence behind the replay. */
  flowFiles: string[];
  /** Agent-supplied, code-referenced steps. */
  flowSteps: Payload[];
  at: number;
  /** The renderer this message asked for. Showcases keep their real projector in the feed. */
  view?: "message" | "showcase";
  payload: Payload;
};

export type FeedItem = {
  id: string;
  room: string;
  at: number;
  /** Not read yet. A card that waits for an answer is unread for as long as it stands. */
  unread: boolean;
  /** It waits for an answer or a look, not only a read. */
  needsYou: boolean;
  /** The newest message of its thread. */
  post?: InboxPost;
  /** The thread's older messages, oldest first. They fold under the newest. */
  earlier?: InboxPost[];
  card?: Card;
};

export type Channel = { key: string; unread: number; latest: number };

export type Feed = {
  /** Oldest first. */
  items: FeedItem[];
  /** One per project in the feed, the busiest latest first. */
  channels: Channel[];
  /** The sidebar count: everything unread or waiting for him. */
  waiting: number;
  needsYou: number;
};

export const ALL = "all";
export const NEEDS = "needs";

/** With no mark yet, posts older than a day count as read. */
const LOOKBACK_MS = 24 * 3600_000;

/** The read mark of one project's posts. */
export const postKey = (room: string): string => `report:${room}`;

/** A report that says it is stuck waits for him until he has read it. */
const STUCK = new Set(["blocked", "needs_decision"]);
export const isStuck = (post: InboxPost): boolean => STUCK.has(String(post.payload.outcome));

/**
 * One agent's messages this close together are one thread: take 5, take 6, "now the folder".
 * Owner, 2026-11-16: "Fix the system so it doesnt spam to the inbox". 703 messages had come from
 * 220 sessions, and 452 of them followed the same session's last one within two hours. So a
 * thread is one item: its newest message whole, the rest folded under it, one unread.
 */
export const THREAD_GAP = 3 * 3600_000;

/** Oldest first in, oldest-first threads out. Without a session, the author in one project is the agent. */
export function threads(posts: InboxPost[]): InboxPost[][] {
  const open = new Map<string, InboxPost[]>();
  const out: InboxPost[][] = [];
  for (const post of [...posts].sort((a, b) => a.at - b.at)) {
    const key = `${post.project}|${post.session ?? `author:${post.author}`}`;
    const thread = open.get(key);
    if (thread && post.at - thread[thread.length - 1].at <= THREAD_GAP) {
      thread.push(post);
      continue;
    }
    const started = [post];
    open.set(key, started);
    out.push(started);
  }
  return out;
}

/** The item that shows this message, whether it is the newest of its thread or folded under it. */
export const holds = (item: FeedItem, postId: string): boolean =>
  item.post?.id === postId || Boolean(item.earlier?.some((post) => post.id === postId));

/** `viewed` is the cards that were on screen this visit: they stand until he leaves, but as read. */
export function buildFeed(posts: InboxPost[], cards: Card[], seen: Record<string, number>, now: number, viewed: ReadonlySet<string> = new Set()): Feed {
  const items: FeedItem[] = [];
  for (const thread of threads(posts)) {
    const post = thread[thread.length - 1];
    const unread = post.at > (seen[postKey(post.project)] ?? now - LOOKBACK_MS);
    items.push({ id: `post:${post.id}`, room: post.project, at: post.at, unread, needsYou: unread && isStuck(post), post, earlier: thread.slice(0, -1) });
  }
  for (const card of cards) {
    items.push({ id: card.id, room: card.room, at: card.arrivedMs, unread: !viewed.has(card.id), needsYou: KIND[card.kind].needsYou, card });
  }
  // Posts and cards share one clock. A tie keeps posts first, then the id, so a repaint never reorders.
  items.sort((a, b) => a.at - b.at || Number(Boolean(a.card)) - Number(Boolean(b.card)) || a.id.localeCompare(b.id));

  const byRoom = new Map<string, Channel>();
  for (const item of items) {
    const channel = byRoom.get(item.room) ?? { key: item.room, unread: 0, latest: 0 };
    if (item.unread) channel.unread += 1;
    channel.latest = Math.max(channel.latest, item.at);
    byRoom.set(item.room, channel);
  }
  return {
    items,
    channels: [...byRoom.values()].sort((a, b) => b.latest - a.latest || a.key.localeCompare(b.key)),
    waiting: items.filter((item) => item.unread || item.needsYou).length,
    needsYou: items.filter((item) => item.needsYou).length,
  };
}

/** The items one channel shows. `ALL` is everything, `NEEDS` only what waits for him. */
export function inChannel(item: FeedItem, channel: string): boolean {
  return channel === ALL || (channel === NEEDS ? item.needsYou : item.room === channel);
}
