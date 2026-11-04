/**
 * Live's animation scripts, and the player that runs them.
 *
 * Every step an agent takes has a verb, like `git.push`, `search` or `spawn`
 * (src-tauri/src/live/verbs.rs). The catalog holds one script per verb in
 * `~/.appgeapanel/state/live-catalog/<verb>.json`. When an agent starts a step, its verb's
 * script plays on the map. A verb with no script gets one written by a headless model run that
 * reads this comment as its spec (src-tauri/src/live/catalog.rs). The owner deletes bad ones in
 * the catalog view, and the next sighting writes a new one.
 *
 * THE MAP. A dark field. This Mac, the hub, sits in the middle with two testlock bays. The
 * GitHub tower stands above it, the owner's desk below it, the board to its left and the web
 * gate to its right. Each project with work going on is a round district around the hub, with
 * the files agents touched as small tiles on its rim. Agents are small glowing electrons.
 *
 * A SCRIPT is a JSON object:
 *   {
 *     "title": "Push to GitHub",                 what the owner reads in the catalog
 *     "about": "The agent carries ...",           one sentence: what the animation shows
 *     "by": "sonnet",                             who wrote it
 *     "steps": [ moves, played in order ]
 *   }
 *
 * PLACES. Every "at", "from" and "to" is one of these names:
 *   "self"     the agent, where it stands now
 *   "home"     the middle of the agent's district
 *   "file"     the tile of the file this step touches, or one of the agent's tiles
 *   "files"    each tile the agent touched (repeats the move per tile, at most 8)
 *   "parent"   the agent that started this one, or "self"
 *   "helpers"  each agent this one started (repeats per helper, at most 8), or points around "self"
 *   "hub"      This Mac
 *   "bay"      the agent's testlock bay, or the first one
 *   "tower"    the foot of the GitHub tower
 *   "sky"      high above the tower
 *   "desk"     the owner's desk, where cards wait
 *   "board"    the board
 *   "web"      the web gate
 * or an object with an offset in pixels, y growing down: {"place": "tower", "dx": 0, "dy": -40}
 *
 * COLOURS: "work" cyan, "think" blue, "turn" amber, "stuck" red, "done" green, "idle" grey,
 * "ink" white, or "#rrggbb".
 *
 * MOVES. Each move is an object with "do". Moves start one after another with no pause, except
 * "walk" and "wait", which hold the script until they end. Sizes are pixels, times are ms.
 *   {"do": "walk", "to": PLACE, "ms": 1200}         the agent glides there
 *   {"do": "wait", "ms": 600}
 *   {"do": "say", "text": "Pushing"}                 a bubble over the agent. "{label}" is the step's own words
 *   {"do": "orb", "from": P, "to": P, "color": C, "size": 6, "ms": 900}       a ball of light travels, with a trail
 *   {"do": "packets", "from": P, "to": P, "color": C, "count": 4, "ms": 800}  small balls stream one after another
 *   {"do": "beam", "from": P, "to": P, "color": C, "ms": 1200}                a line of light flashes and fades
 *   {"do": "pulse", "at": P, "color": C, "size": 30, "ms": 900}               a soft glow swells and fades
 *   {"do": "ring", "at": P, "color": C, "size": 60, "ms": 1200}               a thin ring grows and fades
 *   {"do": "burst", "at": P, "color": C, "count": 14, "size": 30}            sparks fly out
 *   {"do": "sweep", "at": P, "color": C, "size": 60, "ms": 2000}              a radar arm turns around the place
 *   {"do": "orbit", "at": P, "color": C, "count": 3, "size": 18, "ms": 2000}  electrons circle the place
 *   {"do": "carry", "color": C}                      the agent holds a glowing crate. With no colour it drops it
 *   {"do": "light", "at": "files" or "file", "color": C, "ms": 1500}          file tiles glow
 * At most 24 moves and 8 seconds. Unknown moves and places are skipped. When the script ends,
 * the agent drops what it carries and glides home. A script without "say" shows the step's
 * words anyway, so an agent always tells what it does.
 */

export type Pt = { x: number; y: number };
export type Place = string | { place: string; dx?: number; dy?: number };
export type Move = { do: string; [field: string]: unknown };
export type Script = { verb: string; title?: string; about?: string; by?: string; madeMs?: number; pending?: boolean; steps?: Move[] };
/** An effect for Bevy, in world pixels (apps/live/src/fx.rs). */
export type FxOut = { kind: string; x: number; y: number; x2?: number; y2?: number; color: string; size?: number; ms?: number; count?: number; delay?: number };

/** What the player needs from the map. live.ts provides it. */
export type Stagehand = {
  /** A named place for this agent. Several points for "files" and "helpers". Empty when unknown. */
  where(agentId: string, place: string): Pt[];
  fx(f: FxOut): void;
  walk(agentId: string, to: Pt | null): void;
  carry(agentId: string, color: string | null): void;
  say(agentId: string, text: string | null): void;
  light(agentId: string, at: "file" | "files", color: string, ms: number): void;
  /** The step's own words. */
  label(agentId: string): string;
  /** Sends what changed to the view. */
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

/** What plays when a verb has no script yet: the agent says what it does, with one soft pulse. */
export const PLAIN: Script = {
  verb: "",
  title: "Working",
  steps: [
    { do: "say", text: "{label}" },
    { do: "pulse", at: "self", color: "work", size: 26 },
    { do: "wait", ms: 2400 },
  ],
};

const colour = (c: unknown): string => (typeof c === "string" ? (COLOR[c] ?? (/^#[0-9a-f]{6}$/i.test(c) ? c : COLOR.ink)) : COLOR.ink);
const num = (v: unknown, fallback: number, lo: number, hi: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);

function points(hand: Stagehand, agentId: string, p: unknown): Pt[] {
  const spec = typeof p === "string" ? { place: p } : p && typeof p === "object" && typeof (p as { place?: unknown }).place === "string" ? (p as { place: string; dx?: number; dy?: number }) : null;
  if (!spec) return [];
  const dx = num(spec.dx, 0, -600, 600);
  const dy = num(spec.dy, 0, -600, 600);
  return hand.where(agentId, spec.place).slice(0, MAX_POINTS).map((q) => ({ x: q.x + dx, y: q.y + dy }));
}

/** Pairs every start with an end: one to many, many to one, or many to many in order. */
function pairs(from: Pt[], to: Pt[]): [Pt, Pt][] {
  if (!from.length || !to.length) return [];
  const n = Math.max(from.length, to.length);
  return Array.from({ length: n }, (_, i) => [from[Math.min(i, from.length - 1)], to[Math.min(i, to.length - 1)]]);
}

/**
 * Plays `script` for one agent. Returns a stop function. A stopped or finished script leaves the
 * agent with nothing carried, no bubble, and on its way home.
 */
export function play(script: Script, agentId: string, hand: Stagehand, done: () => void): () => void {
  let stopped = false;
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
