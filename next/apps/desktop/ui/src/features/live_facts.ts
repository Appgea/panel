/**
 * The facts Live and For you both read off the world and the board: which project an agent works
 * for, a project's name and stake, and who an agent is. One copy, so both screens name an agent
 * the same way.
 */

import type { BoardFeed, BoardIssue } from "./live_cards";
import { cap, who, withoutRoom } from "./live_text";
import type { LiveAgent, LiveEmber, LiveWorld } from "./live_types";

export type Facts = {
  issueOf(a: LiveAgent): BoardIssue | undefined;
  /** The project an agent works for. A fleet worker runs in the company folder: its issue's app is its real project. */
  roomOf(a: LiveAgent): string;
  roomName(key: string): string;
  /** A project's stake: 3 for an app that earns, 2 in a store, 1 for the rest. */
  weight(key: string): number;
  agentById(id: string | null): LiveAgent | undefined;
  /** The one name an agent goes by on screen. See `who` in live_text.ts. */
  nameOf(a: LiveAgent): string;
  whoOf(a: LiveAgent): ReturnType<typeof who>;
  /** Who an ended agent was, named the same way. */
  emberWho(e: LiveEmber): ReturnType<typeof who>;
};

export function facts(read: () => { world: LiveWorld | null; board: BoardFeed | null }): Facts {
  const issues = (b: BoardFeed | null): BoardIssue[] => [...(b?.now ?? []), ...(b?.you ?? []), ...(b?.ready ?? []), ...(b?.waiting ?? []), ...(b?.done ?? [])];
  /** The board names a claim by session: `codex-0a513057` for Codex, the folk name for others. */
  const held = (a: LiveAgent): BoardIssue | undefined => {
    const names = [a.session ? `codex-${a.session.slice(-8)}` : "", (a.name ?? "").toLowerCase()].filter(Boolean);
    return (read().board?.now ?? []).find((i) => i.holder && names.includes(i.holder.toLowerCase()));
  };
  const issueOf = (a: LiveAgent) => held(a) ?? (a.issue ? issues(read().board).find((i) => i.number === a.issue) : undefined);
  const roomOf = (a: LiveAgent): string => (a.room !== "elsewhere" && a.room !== "home" ? a.room : (issueOf(a)?.apps[0] ?? a.room));
  const roomMeta = (key: string) => read().world?.rooms.find((r) => r.key === key);
  const agentById = (id: string | null) => (id ? read().world?.agents.find((a) => a.id === id) : undefined);
  // Five rows that all said "Board worker" told the owner nothing. A worker is its issue:
  // "#742 Store build fails", with its role kept in the second line.
  const named = (me: ReturnType<typeof who>, iss: BoardIssue | undefined, room: string) =>
    iss && /^Board (worker|reviewer)$/.test(me.title) ? { ...me, title: `#${iss.number} ${cap(withoutRoom(iss.title, room))}`, sub: [me.title, me.sub].filter(Boolean).join(" · ") } : me;
  const own = (a: LiveAgent, parent: string | null) => {
    const room = roomOf(a);
    return named(who(a, parent), issueOf(a), roomMeta(room)?.name ?? room);
  };
  const whoOf = (a: LiveAgent) => {
    const p = agentById(a.parent);
    return own(a, p ? own(p, null).title : null);
  };
  const emberWho = (e: LiveEmber) => {
    const n = Number(/#(\d{2,6})\b/.exec(e.task ?? "")?.[1] ?? 0);
    return named(who(e, e.parentName), n ? issues(read().board).find((i) => i.number === n) : undefined, e.roomName);
  };
  return {
    issueOf,
    roomOf,
    roomName: (key) => roomMeta(key)?.name ?? read().board?.apps?.[key]?.name ?? key,
    weight: (key) => roomMeta(key)?.weight ?? 1,
    agentById,
    nameOf: (a) => whoOf(a).title,
    whoOf,
    emberWho,
  };
}
