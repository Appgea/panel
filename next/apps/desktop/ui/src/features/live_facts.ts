
import type { BoardFeed, BoardIssue } from "./live_cards";
import { cap, who, withoutRoom } from "./live_text";
import type { LiveAgent, LiveEmber, LiveWorld } from "./live_types";

export type Facts = {
  issueOf(a: LiveAgent): BoardIssue | undefined;
  roomOf(a: LiveAgent): string;
  roomName(key: string): string;
  weight(key: string): number;
  agentById(id: string | null): LiveAgent | undefined;
  nameOf(a: LiveAgent): string;
  whoOf(a: LiveAgent): ReturnType<typeof who>;
  emberWho(e: LiveEmber): ReturnType<typeof who>;
};

export function facts(read: () => { world: LiveWorld | null; board: BoardFeed | null }): Facts {
  const issues = (b: BoardFeed | null): BoardIssue[] => [...(b?.now ?? []), ...(b?.you ?? []), ...(b?.ready ?? []), ...(b?.waiting ?? []), ...(b?.done ?? [])];
  const held = (a: LiveAgent): BoardIssue | undefined => {
    const names = [a.session ? `codex-${a.session.slice(-8)}` : "", (a.name ?? "").toLowerCase()].filter(Boolean);
    return (read().board?.now ?? []).find((i) => i.holder && names.includes(i.holder.toLowerCase()));
  };
  const issueOf = (a: LiveAgent) => held(a) ?? (a.issue ? issues(read().board).find((i) => i.number === a.issue) : undefined);
  const roomOf = (a: LiveAgent): string => (a.room !== "elsewhere" && a.room !== "home" ? a.room : (issueOf(a)?.apps[0] ?? a.room));
  const roomMeta = (key: string) => read().world?.rooms.find((r) => r.key === key);
  const agentById = (id: string | null) => (id ? read().world?.agents.find((a) => a.id === id) : undefined);
  const named = (me: ReturnType<typeof who>, iss: BoardIssue | undefined, room: string) =>
    iss && /^Board (worker|reviewer)$/.test(me.title) ? { ...me, title: `#${iss.number} ${cap(withoutRoom(iss.title, room))}`, sub: [me.title, me.sub].filter(Boolean).join(" · ") } : me;
  const own = (a: LiveAgent, parent: string | null) => {
    const room = roomOf(a);
    const name = roomMeta(room)?.name ?? room;
    if (a.fleet) {
      const me = who(a, parent);
      const m = /^(#\d+ )(.*)$/.exec(me.title);
      return m ? { ...me, title: `${m[1]}${cap(withoutRoom(m[2], name))}` } : me;
    }
    return named(who(a, parent), issueOf(a), name);
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
