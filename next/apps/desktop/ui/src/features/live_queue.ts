/**
 * The card beside the owner's ring: one piece of business at a time, in value per minute
 * (live_cards.ts). One key answers it. Copied from `renderCard` in the concept page, line 1076,
 * and `.qcard` in its CSS, lines 48 to 74.
 */

import { errorText } from "../errors";
import { buildCards, KIND, managerBrief, order, scoreLine, type Act, type Card, type CardKind } from "./live_cards";
import type { Layout } from "./live_layout";
import { button, div, placeAt, span, withoutRoom } from "./live_text";
import type { LiveCtx } from "./live_types";
import "./live_queue.css";

const LATER_MS = 30 * 60_000;
const SEEN_KEY = "panel.live.seen";
const SOURCE: Record<CardKind, string> = { decide: "Your agenda", turn: "An agent", done: "Closes and releases", decided: "Decided lines", better: "The improve scout" };
const KIND_COLOUR: Record<CardKind, string> ={ decide: "var(--l-turn)", turn: "var(--l-turn)", better: "var(--l-think)", decided: "var(--l-ink-2)", done: "var(--l-done)" };

export type Queue = {
  paint(): void;
  onKey(e: KeyboardEvent): boolean;
};

export function mountQueue(ctx: LiveCtx, el: HTMLElement): Queue {
  const s = ctx.s;
  const pictures = new Map<string, string>();
  let sig = "";

  function paint(): void {
    const now = Date.now();
    const w = s.world!;
    const agents = w.agents.map((a) => ({ id: a.id, name: ctx.nameOf(a), room: ctx.roomOf(a), state: a.state, stateMs: a.stateMs, headless: a.headless, panel: a.panel, lastText: a.lastText }));
    const built = buildCards(s.board, agents, ctx.weight, ctx.roomName, s.seen, now).filter((c) => !s.answered.has(c.id));
    const before = new Set(s.cards.map((c) => c.id));
    s.cards = order(built, now, s.front, s.later);
    // A new card flies from its room into the ring. The first read is the world as it was.
    if (s.boardRead && sig) for (const c of s.cards) if (!before.has(c.id)) s.pendingFlights.push({ dir: "in", room: c.room, agent: c.agent ?? null });
    const top = s.cards[0] ?? null;
    // The front card holds its place only once the board has answered. Before that, a session's
    // card would claim the front and keep a more valuable decision behind it.
    s.front = s.boardRead ? (top?.id ?? null) : null;
    ctx.stage.closest(".live")?.classList.toggle("is-calm", !s.cards.length);
    // The card in front is rebuilt only when it changes, so a hand on it never loses its place.
    const next = top ? JSON.stringify([top.id, top.title, top.lines, top.options.map((o) => o.label), s.talkCard === top.id, s.boardNote]) : `none:${s.boardNote}:${w.agents.length}`;
    if (next !== sig) {
      const first = !sig;
      sig = next;
      if (first) render(top);
      else swap(top);
    } else if (top) paintScore(top, now);
  }

  /** The card fades and drops 6 px while it changes, so the eye sees that it changed. */
  function swap(card: Card | null): void {
    if (s.reduced) return render(card);
    el.classList.add("is-swap");
    window.setTimeout(() => {
      render(card);
      el.classList.remove("is-swap");
    }, 150);
  }

  function render(card: Card | null): void {
    const now = Date.now();
    if (!card) {
      const working = s.world!.agents.filter((a) => a.state === "work" || a.state === "think").length;
      const head = div("qhead");
      const kind = span("qkind", "Live");
      kind.style.setProperty("--c", "var(--l-done)");
      head.append(kind, span("qpos", "0 cards"));
      el.replaceChildren(head, div("qtitle", "Nothing needs you"), div("qwhy", s.boardNote || `${working} ${working === 1 ? "agent" : "agents"} working. You can leave. New calls wait here.`));
      return;
    }
    const room = ctx.roomName(card.room);
    const head = div("qhead");
    const kind = span("qkind", KIND[card.kind].label);
    kind.style.setProperty("--c", KIND_COLOUR[card.kind]);
    const minutes = Math.max(1, Math.round(s.cards.reduce((n, c) => n + c.minutes, 0)));
    head.append(kind, span("qpos", `1 of ${s.cards.length} · about ${minutes} min`));
    const nodes: HTMLElement[] = [head];
    // Who sent it: the owner's agenda, the agent that waits, or where the card's lines come from.
    const who = div("qwho");
    const dots = span("qdots");
    const agent = ctx.agentById(card.agent ?? null);
    const dot = document.createElement("i");
    dot.style.setProperty("--c", agent ? `var(--l-${agent.state})` : KIND_COLOUR[card.kind]);
    dots.append(dot);
    const source = card.number ? `Your agenda · #${card.number}` : agent ? ctx.nameOf(agent) : SOURCE[card.kind];
    who.append(dots, span("", `${source} · ${room}`));
    nodes.push(who);
    nodes.push(div("qtitle", withoutRoom(card.title, room)));
    if (card.lines[0]) nodes.push(div("qwhy", card.lines.join(" ")));
    if (card.items?.length) nodes.push(itemList(card.items));
    const pic = card.pictures?.[0];
    if (pic) nodes.push(picture(pic));
    if (s.talkCard === card.id) nodes.push(reply(card));
    const opts = div("qopts");
    if (s.talkCard === card.id) {
      opts.append(opt("Send", "Enter", true, () => void sendTalk(card)), opt("Back", "Esc", false, closeTalk));
    } else {
      card.options.forEach((o, i) => opts.append(opt(o.label, i === 0 ? "Enter" : String(i + 1), i === 0, () => void act(card, o.act))));
      if (card.talk) opts.append(opt("Talk", "T", false, () => startTalk(card)));
    }
    nodes.push(opts);
    const foot = div("qfoot");
    const laterBtn = button("later", "", () => putOff(card));
    laterBtn.append("Later ", kbd("↓"));
    foot.append(span("qscore"), laterBtn);
    nodes.push(foot);
    el.replaceChildren(...nodes);
    paintScore(card, now);
    el.querySelector<HTMLInputElement>(".reply")?.focus();
  }

  function paintScore(card: Card, now: number): void {
    const score = el.querySelector(".qscore");
    if (score) score.textContent = scoreLine(card, now, ctx.roomName(card.room));
  }

  function picture(path: string): HTMLElement {
    const img = document.createElement("img");
    img.className = "qthumb";
    img.alt = "";
    const cached = pictures.get(path);
    if (cached) img.src = cached;
    else
      void ctx.events
        .picture(path)
        .then((src) => {
          pictures.set(path, src);
          img.src = src;
        })
        .catch(() => img.remove());
    return img;
  }

  function reply(card: Card): HTMLElement {
    const input = document.createElement("input");
    input.className = "reply";
    input.type = "text";
    input.maxLength = 500;
    input.autocomplete = "off";
    const to = card.talk?.to === "agent" ? card.talk.name : card.talk?.to === "board" ? `the board, on #${card.talk.number}` : "the Manager";
    input.placeholder = `Talk to ${to} about this. Enter sends.`;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void sendTalk(card);
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeTalk();
      }
    });
    return input;
  }

  async function act(card: Card, a: Act): Promise<void> {
    switch (a.do) {
      case "answer": {
        try {
          const r = await ctx.events.answer({ number: a.number, pick: a.pick });
          s.answered.add(card.id);
          s.pendingFlights.push({ dir: "out", room: card.room, agent: card.agent ?? null });
          ctx.toast(r.said ? `Answered. ${r.said}` : `Answered #${a.number}.`);
          s.front = null;
          paint();
          ctx.draw();
        } catch (e) {
          ctx.toast(`Not answered: ${errorText(e, "the board refused it")}`, true);
        }
        return;
      }
      case "seen":
        markSeen(card);
        return;
      case "terminal":
        if (!ctx.events.openTerminal(a.panel)) ctx.toast("That terminal is gone.", true);
        return;
      case "url":
        ctx.events.openUrl(a.url);
    }
  }

  function markSeen(card: Card): void {
    const now = Date.now();
    for (const k of card.seenKeys) s.seen[k] = now;
    writeSeen(s.seen);
    s.front = null;
    paint();
  }

  function putOff(card: Card): void {
    s.later[card.id] = Date.now() + LATER_MS;
    s.front = null;
    s.talkCard = null;
    ctx.toast(`${KIND[card.kind].label} card moved to later. It comes back in 30 min.`);
    paint();
  }

  function startTalk(card: Card): void {
    if (!card.talk) return;
    s.talkCard = card.id;
    paint();
  }

  function closeTalk(): void {
    s.talkCard = null;
    paint();
  }

  async function sendTalk(card: Card): Promise<void> {
    const words = el.querySelector<HTMLInputElement>(".reply")?.value.trim() ?? "";
    if (!card.talk || !words) return;
    try {
      if (card.talk.to === "board") {
        await ctx.events.answer({ number: card.talk.number, say: words });
        s.answered.add(card.id);
        ctx.toast(`Your words are on #${card.talk.number}.`);
      } else if (card.talk.to === "agent") {
        if (!(await ctx.events.sendToAgent(card.talk.panel, words))) throw new Error("its terminal did not take the text");
        for (const k of card.seenKeys) s.seen[k] = Date.now();
        writeSeen(s.seen);
        ctx.toast(`Sent to ${card.talk.name}.`);
      } else {
        await ctx.events.seedManager(managerBrief(card, words));
        ctx.toast("Sent to the Manager.");
      }
      s.pendingFlights.push({ dir: "out", room: card.room, agent: card.agent ?? null });
      s.talkCard = null;
      s.front = null;
      paint();
      ctx.draw();
    } catch (e) {
      ctx.toast(`Not sent: ${errorText(e, "unknown error")}`, true);
    }
  }

  /** The card's keys. True when the key was the card's. */
  function onKey(e: KeyboardEvent): boolean {
    const card = s.cards[0];
    if (!card) return false;
    if (e.key === "Enter" && card.options[0]) void act(card, card.options[0].act);
    else if ((e.key === "2" || e.key === "3") && card.options[Number(e.key) - 1]) void act(card, card.options[Number(e.key) - 1].act);
    else if (e.key === "t" || e.key === "T") startTalk(card);
    else if (e.key === "ArrowDown") putOff(card);
    else if (e.key === " ") ctx.select({ kind: "room", id: card.room });
    else if (e.key === "Escape" && s.talkCard) closeTalk();
    else return false;
    return true;
  }

  return { paint, onKey };
}

/** The count in the owner's ring, and "You" under it. Bevy draws the ring itself. */
export function ringWords(ctx: LiveCtx, l: Layout): HTMLElement[] {
  const n = div(`live-ring-count${ctx.s.cards.length ? "" : " is-empty"}`, String(ctx.s.cards.length));
  placeAt(n, l.ring.x, l.ring.y);
  const you = div("live-ring-you", "You");
  placeAt(you, l.ring.x, l.ring.y + l.ring.r + 5);
  return [n, you];
}

/** Up to four items, then "+N more". */
function itemList(items: string[]): HTMLElement {
  const ul = document.createElement("ul");
  ul.className = "qlist";
  for (const t of items.slice(0, 4)) {
    const li = document.createElement("li");
    li.textContent = t;
    ul.append(li);
  }
  if (items.length > 4) {
    const li = document.createElement("li");
    li.className = "more";
    li.textContent = `+${items.length - 4} more`;
    ul.append(li);
  }
  return ul;
}

function opt(label: string, key: string, primary: boolean, run: () => void): HTMLButtonElement {
  const b = button(`opt${primary ? " primary" : ""}`, "", run);
  b.append(span("", label), kbd(key));
  return b;
}

function kbd(text: string): HTMLElement {
  const k = document.createElement("kbd");
  k.textContent = text;
  return k;
}

export function readSeen(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}") as Record<string, number>;
    // A week of seen marks is plenty: the board forgets older closes anyway.
    const cut = Date.now() - 7 * 86_400_000;
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === "number" && v > cut));
  } catch {
    return {};
  }
}

function writeSeen(seen: Record<string, number>): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    // Private storage off: seen marks last this session only.
  }
}
