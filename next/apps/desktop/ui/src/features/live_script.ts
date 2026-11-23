
export type Pt = { x: number; y: number };
export type Place = string | { place: string; dx?: number; dy?: number };
export type Move = { do: string; [field: string]: unknown };
export type Script = { verb: string; title?: string; about?: string; by?: string; madeMs?: number; pending?: boolean; improving?: boolean; improved?: string; glyphs?: Record<string, unknown>; steps?: Move[] };
export type FxOut = { kind: string; x: number; y: number; x2?: number; y2?: number; color: string; size?: number; ms?: number; count?: number; delay?: number; path?: [number, number][] };
export type Mark = { glyph?: string; text?: string; at: Pt; to?: Pt; path?: Pt[]; line?: boolean; color: string; ms: number; xp?: boolean; talk?: boolean };

export const GLYPHS: Record<string, string> = {
  file: "M6 3h8l4 4v14H6z M14 3v4h4",
  files: "M8 3h7l3 3v12H8z M5 7v14h10",
  crate: "M4 8l8-4 8 4v8l-8 4-8-4z M4 8l8 4 8-4 M12 12v8",
  branch: "M7 3v18 M17 3v6 M17 9c0 4-10 4-10 8",
  search: "M10 4a6 6 0 1 0 0 12a6 6 0 1 0 0-12z M15 15l5 5",
  globe: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M3 12h18 M12 3c-4 4-4 14 0 18 M12 3c4 4 4 14 0 18",
  chat: "M4 5h16v10H10l-5 4v-4H4z",
  flask: "M9 3h6 M10 3v6l-5 10h14l-5-10V3",
  hammer: "M14 4l6 6-3 3-6-6z M11 9l-7 7 3 3 7-7",
  rocket: "M12 3c4 3 5 8 3 13H9c-2-5-1-10 3-13z M9 16l-3 4 M15 16l3 4 M12 9v2",
  eye: "M2 12c3-5 7-7 10-7s7 2 10 7c-3 5-7 7-10 7s-7-2-10-7z M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z",
  gear: "M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8z M12 2v4 M12 18v4 M2 12h4 M18 12h4 M5 5l3 3 M16 16l3 3 M5 19l3-3 M16 8l3-3",
  camera: "M3 7h4l2-3h6l2 3h4v12H3z M12 10a3 3 0 1 0 0 6a3 3 0 1 0 0-6z",
  film: "M4 4h16v16H4z M8 4v16 M16 4v16 M4 8h4 M4 12h4 M4 16h4 M16 8h4 M16 12h4 M16 16h4",
  book: "M4 5c3-1 6-1 8 1v14c-2-2-5-2-8-1z M20 5c-3-1-6-1-8 1v14c2-2 5-2 8-1z",
  people: "M9 11a3 3 0 1 0 0-6a3 3 0 1 0 0 6z M3 20c0-4 3-6 6-6s6 2 6 6 M16 5a3 3 0 0 1 0 6 M18 14c2 1 3 3 3 6",
  lock: "M6 11h12v10H6z M8 11V8a4 4 0 0 1 8 0v3",
  cloud: "M7 18h10a4 4 0 0 0 0-8a6 6 0 0 0-11-1a4 4 0 0 0 1 9z",
  spark: "M12 3v6 M12 15v6 M3 12h6 M15 12h6 M6 6l3 3 M15 15l3 3 M6 18l3-3 M15 9l3-3",
  list: "M8 6h12 M8 12h12 M8 18h12 M4 6h1 M4 12h1 M4 18h1",
  check: "M5 12l5 5 9-10",
  cross: "M6 6l12 12 M18 6L6 18",
};
const RESULT_GLYPHS = new Set(["check", "cross"]);
const PATH = /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]{1,600}$/;

export function glyphPath(script: Script, name: unknown): string | null {
  if (typeof name !== "string" || !/^[a-z-]{1,24}$/.test(name) || RESULT_GLYPHS.has(name)) return null;
  const own = script.glyphs?.[name];
  if (typeof own === "string" && PATH.test(own)) return own;
  return GLYPHS[name] ?? null;
}

export type Stagehand = {
  where(agentId: string, place: string): Pt[];
  fx(f: FxOut): void;
  walk(agentId: string, to: Pt | null): void;
  carry(agentId: string, color: string | null): void;
  say(agentId: string, text: string | null): void;
  light(agentId: string, at: "file" | "files", color: string, ms: number): void;
  mark(agentId: string, m: Mark): void;
  label(agentId: string): string;
  file(agentId: string): string;
  flush(): void;
};

export const COLOR: Record<string, string> = {
  work: "#6fe7ff",
  think: "#93b4ff",
  turn: "#ffb23f",
  stuck: "#ff5a6a",
  done: "#4be38f",
  idle: "#6b7689",
  ink: "#e6eaf1",
};
const MAX_MOVES = 24;
const MAX_MS = 8000;
const MAX_POINTS = 8;

export const PLAIN: Script = {
  verb: "",
  title: "Working",
  steps: [
    { do: "say", text: "{label}" },
    { do: "pulse", at: "self", color: "work", size: 26 },
    { do: "wait", ms: 2400 },
  ],
};

const colour = (c: unknown): string => (c === "done" || c === "stuck" ? COLOR.work : typeof c === "string" ? (COLOR[c] ?? COLOR.ink) : COLOR.ink);
const num = (v: unknown, fallback: number, lo: number, hi: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);

function points(hand: Stagehand, agentId: string, p: unknown): Pt[] {
  const spec = typeof p === "string" ? { place: p } : p && typeof p === "object" && typeof (p as { place?: unknown }).place === "string" ? (p as { place: string; dx?: number; dy?: number }) : null;
  if (!spec) return [];
  const dx = num(spec.dx, 0, -600, 600);
  const dy = num(spec.dy, 0, -600, 600);
  return hand.where(agentId, spec.place).slice(0, MAX_POINTS).map((q) => ({ x: q.x + dx, y: q.y + dy }));
}

function pairs(from: Pt[], to: Pt[]): [Pt, Pt][] {
  if (!from.length || !to.length) return [];
  const n = Math.max(from.length, to.length);
  return Array.from({ length: n }, (_, i) => [from[Math.min(i, from.length - 1)], to[Math.min(i, to.length - 1)]]);
}

export function play(script: Script, agentId: string, hand: Stagehand, done: () => void): () => void {
  let stopped = false;
  let tagged = false;
  const timers: number[] = [];
  const sleep = (ms: number) => new Promise<void>((r) => timers.push(window.setTimeout(r, ms)));
  const moves = (script.steps ?? []).filter((m) => m && typeof m.do === "string").slice(0, MAX_MOVES);
  const finish = () => {
    if (stopped) return;
    stopped = true;
    timers.forEach((t) => window.clearTimeout(t));
    hand.walk(agentId, null);
    hand.carry(agentId, null);
    hand.say(agentId, null);
    hand.flush();
    done();
  };
  timers.push(window.setTimeout(finish, MAX_MS));
  if (!moves.some((m) => m.do === "say")) hand.say(agentId, hand.label(agentId));

  void (async () => {
    for (const m of moves) {
      if (stopped) return;
      const at = () => points(hand, agentId, m.at);
      const col = colour(m.color);
      switch (m.do) {
        case "walk": {
          const to = points(hand, agentId, m.to)[0];
          const ms = num(m.ms, 1200, 200, 3000);
          if (to) {
            hand.walk(agentId, to);
            hand.flush();
            await sleep(ms);
          }
          break;
        }
        case "wait":
          hand.flush();
          await sleep(num(m.ms, 600, 0, 4000));
          break;
        case "say": {
          const text = typeof m.text === "string" ? m.text.replace("{label}", hand.label(agentId)).slice(0, 120) : "";
          hand.say(agentId, text || null);
          break;
        }
        case "carry":
          hand.carry(agentId, m.color === undefined ? null : col);
          break;
        case "light":
          hand.light(agentId, m.at === "file" ? "file" : "files", col, num(m.ms, 1500, 100, 6000));
          break;
        case "glyph": {
          const glyph = glyphPath(script, m.name);
          const to = m.to === undefined ? [] : points(hand, agentId, m.to);
          if (glyph) for (const [i, p] of at().entries()) hand.mark(agentId, { glyph, at: p, to: to[Math.min(i, to.length - 1)], color: col, ms: num(m.ms, 1400, 300, 4000) });
          break;
        }
        case "tag": {
          if (tagged || typeof m.text !== "string") break;
          const words = m.text.replace("{file}", hand.file(agentId)).replace("{label}", hand.label(agentId)).trim().slice(0, 28);
          const p = at()[0];
          if (words && p) {
            tagged = true;
            hand.mark(agentId, { text: words, at: p, color: col, ms: num(m.ms, 1800, 600, 4000) });
          }
          break;
        }
        case "orb":
        case "beam":
          for (const [a, b] of pairs(points(hand, agentId, m.from), points(hand, agentId, m.to)))
            hand.fx({ kind: m.do, x: a.x, y: a.y, x2: b.x, y2: b.y, color: col, size: num(m.size, 6, 1, 30), ms: num(m.ms, m.do === "orb" ? 900 : 1200, 100, 4000) });
          break;
        case "packets": {
          const count = num(m.count, 4, 1, 10);
          const ms = num(m.ms, 800, 100, 3000);
          for (const [a, b] of pairs(points(hand, agentId, m.from), points(hand, agentId, m.to)))
            for (let i = 0; i < count; i++) hand.fx({ kind: "orb", x: a.x, y: a.y, x2: b.x, y2: b.y, color: col, size: 3, ms, delay: i * 160 });
          break;
        }
        case "pulse":
        case "ring":
        case "burst":
        case "sweep":
        case "orbit":
          for (const p of at())
            hand.fx({ kind: m.do, x: p.x, y: p.y, color: col, size: num(m.size, m.do === "orbit" ? 18 : m.do === "ring" ? 60 : 30, 4, 200), ms: num(m.ms, 1200, 100, 6000), count: num(m.count, m.do === "burst" ? 14 : 3, 1, 40) });
          break;
        default:
          break;
      }
    }
    hand.flush();
    finish();
  })();
  return finish;
}
