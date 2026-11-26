import type { Payload } from "../types";

export type InboxPost = {
  id: string;
  project: string;
  projectName: string;
  author: string;
  agentKind: string;
  session: string | null;
  flowFiles: string[];
  flowSteps: Payload[];
  at: number;
  view?: "message" | "showcase";
  payload: Payload;
};

export type FeedItem = {
  id: string;
  at: number;
  unread: boolean;
  post: InboxPost;
  earlier: InboxPost[];
};

export type Feed = {
  items: FeedItem[];
  unread: number;
};

export const WINDOW_MS = 48 * 3600_000;

export const READ_KEY = "inbox";

export const THREAD_GAP = 3 * 3600_000;

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

export const holds = (item: FeedItem, postId: string): boolean =>
  item.post.id === postId || item.earlier.some((post) => post.id === postId);

export function buildFeed(posts: InboxPost[], seen: Record<string, number>, now: number): Feed {
  const mark = seen[READ_KEY] ?? 0;
  const items: FeedItem[] = threads(posts.filter((post) => post.at > now - WINDOW_MS)).map((thread) => {
    const post = thread[thread.length - 1];
    return { id: `post:${post.id}`, at: post.at, unread: post.at > mark, post, earlier: thread.slice(0, -1) };
  });
  items.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  return { items, unread: items.filter((item) => item.unread).length };
}
