/**
 * The cards the Inbox folds in from the screens it replaced: Review, Support and History.
 * Owner, 2026-11-05: "I don't think I need this many different stuff to look at. One screen."
 * Each source becomes cards of one kind, in the same feed as the board's (live_cards.ts), so one
 * list answers "what is mine to look at". What an agent sent is not a card: each message stands
 * in the feed whole (inbox_feed.ts).
 *
 * History is the simple form the owner asked for: one card per project with the sessions that
 * ended since he looked, and Resume. The full History screen is only behind links now.
 *
 * Pure: the host reads the sources, this only shapes them.
 */

import type { Act, Card, CardKind } from "./live_cards";

export type ReviewBatch = { project: string; items: { path: string; kind: "image" | "audio" | "video"; at: number }[] };
export type SupportItem = { id: string; app: string; subject: string; email: string; form: string; fields: { q: string; a: string }[]; at: number };
export type EndedItem = { id: string; project: string; agent: string; title: string; at: number; resumable: boolean };

export type InboxSources = {
  review: ReviewBatch[];
  support: SupportItem[];
  ended: EndedItem[];
  /** When History was last looked at, the floor for Ended before any Seen tap. */
  endedFloor: number;
};

const SUBJECT_MAX = 160;

const clip = (text: string, n: number): string => (text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text);

function byProject<T extends { project: string }>(list: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const x of list) out.set(x.project, [...(out.get(x.project) ?? []), x]);
  return out;
}

function counted(items: ReviewBatch["items"]): string {
  const of = (kind: string, one: string, many: string) => {
    const n = items.filter((i) => i.kind === kind).length;
    return n ? `${n} ${n === 1 ? one : many}` : "";
  };
  return [of("image", "image", "images"), of("audio", "sound", "sounds"), of("video", "video", "videos")].filter(Boolean).join(", ");
}

const fileName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

export function inboxCards(
  src: InboxSources,
  roomName: (room: string) => string,
  picture: (project: string, path: string) => string,
  seen: Record<string, number>,
): Card[] {
  const cards: Card[] = [];
  const base = (kind: CardKind, room: string) => ({ kind, room, talk: null });
  // Review waits for a look, so it keeps a way to wave it off. The rest are read by being seen.
  const seenOpt = { label: "Seen", act: { do: "seen" } as Act };

  for (const batch of src.review) {
    const items = batch.items;
    if (!items.length) continue;
    const image = items.find((i) => i.kind === "image");
    cards.push({
      ...base("review", batch.project),
      id: `review:${batch.project}:${items[0].path}`,
      title: `${counted(items)} to look at`,
      lines: [],
      items: items.map((i) => fileName(i.path)),
      pictureSrc: image ? picture(batch.project, image.path) : undefined,
      options: [{ label: "Look", act: { do: "review", project: batch.project, paths: items.map((i) => i.path) } }, seenOpt],
      arrivedMs: Math.min(...items.map((i) => i.at)),
      seenKeys: [],
      refs: items.map((i) => i.path),
    });
  }

  for (const m of src.support) {
    if (seen[`support:${m.id}`]) continue;
    const room = m.app || "hq";
    cards.push({
      ...base("support", room),
      id: `support:${m.id}`,
      title: clip(m.subject, SUBJECT_MAX),
      lines: [[m.email, m.form].filter(Boolean).join(" · ")].filter(Boolean),
      // A subject that fits is already the title. A question that ends in its own mark needs no colon.
      items: m.fields
        .filter((f) => f.a.trim() && (m.subject.length > SUBJECT_MAX || f.a.replace(/\s+/g, " ").trim() !== m.subject))
        .map((f) => `${/[?:]$/.test(f.q.trim()) ? f.q.trim() : `${f.q.trim()}:`} ${f.a.trim()}`),
      options: [
        ...(m.email ? [{ label: "Reply by Email", act: { do: "url", url: `mailto:${m.email}?subject=${encodeURIComponent(`Re: your message about ${roomName(room)}`)}` } as Act }] : []),
        { label: "All Support", act: { do: "support" } },
      ],
      arrivedMs: m.at,
      seenKeys: [`support:${m.id}`],
      refs: [m.id],
    });
  }

  for (const [room, list] of byProject(src.ended)) {
    const fresh = list.filter((e) => e.at > (seen[`ended:${room}`] ?? src.endedFloor)).sort((a, b) => b.at - a.at);
    if (!fresh.length) continue;
    const last = fresh[0];
    cards.push({
      ...base("ended", room),
      id: `ended:${room}`,
      title: fresh.length === 1 ? `${last.agent} finished: ${clip(last.title, 120)}` : `${fresh.length} sessions ended in ${roomName(room)}`,
      lines: [],
      items: fresh.length === 1 ? undefined : fresh.map((e) => `${e.agent} · ${clip(e.title, 110)}`),
      options: last.resumable ? [{ label: "Resume Last", act: { do: "resume", session: last.id } }] : [],
      arrivedMs: fresh[fresh.length - 1].at,
      seenKeys: [`ended:${room}`],
    });
  }
  return cards;
}
