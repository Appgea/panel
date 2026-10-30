/**
 * The Ops map's model. Pure: the host's packet in, nodes, edges and positions out. No DOM.
 *
 * The network is WHO holds WHAT. Nodes are the owners in `now.md` (you, the manager, an agent),
 * the apps, the rollouts that span apps, and one Company node for work that names no app. An edge
 * is open work: one `now.md` line drawn from its owner to every app it touches. A rollout is a
 * hub joined to the apps in its table. What finished shows on the app itself, as a ring.
 *
 * Every judgement the screen draws is made here, once:
 *   overdue   a deadline written in the line has passed (`ends 2026-10-26`, `Deadline was 31 Aug`)
 *   waiting   the line sits under Blocked on you
 *   stalled   in flight, its text unchanged for STALL_DAYS, and nothing it touches has a log line
 *             or a commit in that time
 *   done      a log line or a decision dated inside the window
 *   quiet     an app with nothing open and nothing done, hidden unless asked for
 *
 * An app never inherits a rollout's lateness. The reason is written at the rollout edges below.
 */

import { headline, plainText } from "../plain";

export type MapApp = {
  key: string;
  name: string;
  kind: string;
  project: string | null;
  depends_on: string[];
  serves: string[];
};
export type OpenItem = { section: string; tags: string[]; owner: string; text: string; line: number; edited: number };
export type Rollout = { id: string; summary: string; apps: string[]; done_when: string; path: string };
export type DoneEntry = { date: string; kind: "log" | "decision"; tags: string[]; text: string; path: string; line: number };
export type OpsMapData = { today: string; ops: string; apps: MapApp[]; open: OpenItem[]; rollouts: Rollout[]; done: DoneEntry[] };

export type Tone = "risk" | "warn" | "work" | "std" | "ok" | "quiet";
export type NodeKind = "owner" | "company" | "rollout" | "app";

export type Thread = {
  id: string;
  section: string;
  /** Owner node id, or "" for a rollout line. */
  owner: string;
  ownerLabel: string;
  /** Node ids the line touches. Never empty: no app means the Company node. */
  targets: string[];
  /** One readable line, and the whole line in plain words. */
  title: string;
  detail: string;
  line: number;
  /** Whole days since the line's text last changed. Null when git could not say. */
  age: number | null;
  /** Days left to a deadline in the text. Negative once it has passed. */
  deadline: number | null;
  stalled: boolean;
  tone: Tone;
};

export type DoneRow = {
  id: string;
  date: string;
  kind: "log" | "decision";
  title: string;
  detail: string;
  nodes: string[];
  path: string;
  line: number;
  age: number;
};

export type GraphNode = {
  id: string;
  kind: NodeKind;
  label: string;
  project: string | null;
  /** The rollout's own fields, for its detail. */
  rollout: Rollout | null;
  threads: string[];
  done: string[];
  commits: number | null;
  tone: Tone;
  quiet: boolean;
  r: number;
  x: number;
  y: number;
};

export type Edge = { id: string; from: string; to: string; kind: "work" | "rollout" | "depends"; tone: Tone; dashed: boolean; weight: number; threads: string[] };

export type Graph = {
  nodes: GraphNode[];
  edges: Edge[];
  threads: Thread[];
  done: DoneRow[];
  /** Apps with nothing open and nothing done in the window. Hidden unless asked for. */
  quiet: number;
};

export const STALL_DAYS = 14;
const DAY = 86_400_000;
const COMPANY = "company";

/* ------------------------------------------------------------------ words
 * The ops files are written by agents for agents: dense, full of ids, dates as 2026-10-26 and
 * asides in brackets. The screen shows a short headline and keeps the full line one click away.
 */

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ACRONYMS: Record<string, string> = { ios: "iOS", sdk: "SDK", admob: "AdMob", api: "API", ui: "UI", ux: "UX", att: "ATT", ump: "UMP", iap: "IAP" };

/** `2026-10-26` → `Oct 26`. The year stays only when it is not this one. */
export function humanDates(text: string, year: number): string {
  return text.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (whole, y, m, d) =>
    MONTH_NAMES[Number(m) - 1] ? `${MONTH_NAMES[Number(m) - 1]} ${Number(d)}${Number(y) !== year ? `, ${y}` : ""}` : whole);
}

/** `ios-cover-art` → `iOS cover art`, `billing-8` → `Billing 8`. */
export function humanName(id: string): string {
  const words = id.split(/[-_\s]+/).filter(Boolean);
  return words
    .map((word, i) => ACRONYMS[word.toLowerCase()] ?? (i === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ");
}

const fold = (text: string): string =>
  text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/ı/g, "i").replace(/[^a-z0-9]/g, "");
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const dayOf = (date: string): number => Date.parse(`${date}T00:00:00`);

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
/** A date is a deadline only when a deadline word stands right before it. `since 2026-09-01`
 *  is history, not a due date. */
const DEADLINE = new RegExp(
  String.raw`\b(?:ends?|expires?|deadline(?:\s+(?:is|was))?|due|until|before|by)\s+(?:on\s+)?(?:\*\*)?` +
    String.raw`(\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})`,
  "gi",
);

function parseLooseDate(text: string): number | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])).getTime();
  const dayFirst = /^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})$/.exec(text);
  const monthFirst = /^([A-Za-z]{3})[A-Za-z]*\s+(\d{1,2}),?\s+(\d{4})$/.exec(text);
  const [d, m, y] = dayFirst
    ? [dayFirst[1], dayFirst[2], dayFirst[3]]
    : monthFirst
      ? [monthFirst[2], monthFirst[1], monthFirst[3]]
      : [];
  const month = m ? MONTHS[m.toLowerCase()] : undefined;
  return month === undefined ? null : new Date(Number(y), month, Number(d)).getTime();
}

/** Days from today to the nearest deadline in the text. The earliest one wins: it bites first. */
export function deadlineIn(text: string, today: number): number | null {
  let best: number | null = null;
  for (const match of text.matchAll(DEADLINE)) {
    const at = parseLooseDate(match[1].trim());
    if (at === null) continue;
    const days = Math.round((at - today) / DAY);
    if (best === null || days < best) best = days;
  }
  return best;
}

/** Finds which app or rollout a tag or a sentence names. */
function resolver(data: OpsMapData): { tag(tag: string): string | null; mentions(text: string): string[] } {
  const byFold = new Map<string, string>();
  const patterns: Array<{ id: string; re: RegExp }> = [];
  const words = (id: string, names: string[]): void => {
    const unique = [...new Set(names.map((name) => name.trim()).filter((name) => fold(name).length >= 4))];
    for (const name of unique) byFold.set(fold(name), id);
    if (unique.length) {
      const body = unique.map((name) => escape(name).replace(/[_\s-]+/g, "[_\\s-]?")).join("|");
      patterns.push({ id, re: new RegExp(`(?<![\\p{L}\\p{N}_-])(?:${body})(?![\\p{L}\\p{N}_])`, "iu") });
    }
  };
  for (const app of data.apps) {
    // A long store name ("Günün Hadisi - Kütüb-i Sitte") is written short in prose.
    words(`app:${app.key}`, [app.key, app.name, app.name.split(" - ")[0]]);
  }
  const rollouts = new Set([...data.rollouts.map((r) => r.id), ...data.open.filter((o) => o.section === "rollout").flatMap((o) => o.tags)]);
  for (const id of rollouts) words(`rollout:${id}`, [id]);
  return {
    tag: (tag) => byFold.get(fold(tag)) ?? null,
    mentions: (text) => patterns.filter((p) => p.re.test(text)).map((p) => p.id),
  };
}

const ownerId = (owner: string): string => `owner:${fold(owner) || "unknown"}`;
const ownerLabel = (owner: string): string =>
  fold(owner) === "you" ? "You" : fold(owner) === "cpo" ? "CPO" : owner.charAt(0).toUpperCase() + owner.slice(1);

const toneRank: Record<Tone, number> = { risk: 5, warn: 4, work: 3, std: 2, ok: 1, quiet: 0 };
const strongest = (tones: Tone[]): Tone => tones.reduce<Tone>((best, tone) => (toneRank[tone] > toneRank[best] ? tone : best), "quiet");

/**
 * Build the network. `commits` gives an app project's commits in the last STALL_DAYS, or null
 * while unknown. `windowDays` is how far back "done" reaches.
 */
export function buildGraph(data: OpsMapData, windowDays: number, commits: (project: string) => number | null): Graph {
  const today = dayOf(data.today) || new Date().setHours(0, 0, 0, 0);
  const year = new Date(today).getFullYear();
  const words = (text: string): { title: string; detail: string } => {
    const human = humanDates(text, year);
    return { title: headline(human.replace(/^D-\d+\s*·\s*/, "")), detail: plainText(human) };
  };
  const find = resolver(data);
  const nodes = new Map<string, GraphNode>();
  const node = (id: string, kind: NodeKind, label: string, project: string | null = null): GraphNode => {
    let found = nodes.get(id);
    if (!found) {
      found = { id, kind, label, project, rollout: null, threads: [], done: [], commits: null, tone: "quiet", quiet: false, r: 0, x: 0, y: 0 };
      nodes.set(id, found);
    }
    return found;
  };
  for (const app of data.apps) {
    // A long store name ("Günün Hadisi - Kütüb-i Sitte") is drawn by its short form.
    const here = node(`app:${app.key}`, "app", app.name.split(" - ")[0], app.project);
    here.commits = app.project ? commits(app.project) : null;
  }
  for (const rollout of data.rollouts) node(`rollout:${rollout.id}`, "rollout", humanName(rollout.id)).rollout = rollout;

  /** Tags first, then names in the prose. A finished line names a rollout in passing ("left
   *  the billing rollout") far more often than it finishes one, so done text links to apps only. */
  const resolveAll = (tags: string[], text: string, finished = false): string[] => {
    const ids = new Set<string>();
    for (const tag of tags) { const id = find.tag(tag); if (id) ids.add(id); }
    for (const id of find.mentions(text)) if (!finished || id.startsWith("app:")) ids.add(id);
    return [...ids];
  };

  /* ---------------------------------------------------------------- done */
  const done: DoneRow[] = [];
  for (const [at, entry] of data.done.entries()) {
    const day = dayOf(entry.date);
    if (!Number.isFinite(day)) continue;
    const age = Math.round((today - day) / DAY);
    if (age < 0 || age >= windowDays) continue;
    let ids = resolveAll(entry.tags, entry.text, true);
    if (!ids.length) ids = [COMPANY];
    done.push({ id: `done:${at}`, date: entry.date, kind: entry.kind, ...words(entry.text), nodes: ids, path: entry.path, line: entry.line, age });
  }
  done.sort((a, b) => b.date.localeCompare(a.date) || a.line - b.line);
  // "Recently moved" for the stall test looks back a fixed span, whatever window is on screen.
  const movedRecently = new Set<string>();
  for (const entry of data.done) {
    const age = Math.round((today - dayOf(entry.date)) / DAY);
    if (age >= 0 && age < STALL_DAYS) for (const id of resolveAll(entry.tags, entry.text, true)) movedRecently.add(id);
  }

  /* ---------------------------------------------------------------- open */
  const threads: Thread[] = [];
  for (const item of data.open) {
    const isRollout = item.section === "rollout";
    let targets = isRollout
      ? item.tags.map((tag) => find.tag(tag) ?? `rollout:${tag}`)
      : resolveAll(item.tags, item.text);
    if (!targets.length) targets = [COMPANY];
    const age = item.edited > 0 ? Math.max(0, Math.floor((today + DAY - item.edited * 1000) / DAY)) : null;
    const deadline = deadlineIn(item.text, today);
    const moving = targets.some((id) => movedRecently.has(id) || (nodes.get(id)?.commits ?? 0) > 0);
    const stalled = item.section === "flight" && age !== null && age >= STALL_DAYS && !moving;
    const tone: Tone =
      deadline !== null && deadline < 0
        ? "risk"
        : item.section === "blocked"
          ? "warn"
          : item.section === "flight"
            ? stalled ? "warn" : "work"
            : isRollout
              ? "std"
              : "quiet";
    threads.push({
      id: `now:${item.line}`,
      section: item.section,
      owner: isRollout || !item.owner ? "" : ownerId(item.owner),
      ownerLabel: isRollout || !item.owner ? "" : ownerLabel(item.owner),
      targets,
      ...words(item.text),
      line: item.line,
      age,
      deadline,
      stalled,
      tone,
    });
  }

  /* ---------------------------------------------------------------- nodes and edges */
  const edges = new Map<string, Edge>();
  const edge = (from: string, to: string, kind: Edge["kind"], tone: Tone, dashed: boolean, thread?: string): void => {
    const id = `${from}→${to}`;
    const found = edges.get(id);
    if (found) {
      found.weight += 1;
      if (toneRank[tone] > toneRank[found.tone]) found.tone = tone;
      found.dashed = found.dashed && dashed;
      if (thread) found.threads.push(thread);
      return;
    }
    edges.set(id, { id, from, to, kind, tone, dashed, weight: 1, threads: thread ? [thread] : [] });
  };
  for (const thread of threads) {
    if (thread.owner) node(thread.owner, "owner", thread.ownerLabel).threads.push(thread.id);
    for (const target of thread.targets) {
      const here = nodes.get(target) ?? node(target, target === COMPANY ? "company" : "rollout", target === COMPANY ? "Company" : humanName(target.replace(/^rollout:/, "")));
      here.threads.push(thread.id);
      if (thread.owner) edge(thread.owner, target, "work", thread.tone, thread.stalled, thread.id);
    }
  }
  // A rollout's table may still list apps that finished: progress is read live, never written.
  // So a late rollout turns its own hub red, and its edges only say "this app is in it".
  for (const rollout of data.rollouts) {
    const hub = `rollout:${rollout.id}`;
    for (const app of rollout.apps) {
      const id = find.tag(app);
      if (id && id !== hub) edge(hub, id, "rollout", "std", false);
    }
  }
  for (const app of data.apps) {
    for (const other of app.depends_on) if (nodes.has(`app:${other}`)) edge(`app:${app.key}`, `app:${other}`, "depends", "quiet", false);
    for (const other of app.serves) {
      if (nodes.has(`app:${other}`) && !edges.has(`app:${other}→app:${app.key}`)) edge(`app:${other}`, `app:${app.key}`, "depends", "quiet", false);
    }
  }
  for (const row of done) for (const id of row.nodes) (nodes.get(id) ?? node(id, "company", "Company")).done.push(row.id);

  const threadById = new Map(threads.map((t) => [t.id, t]));
  let quiet = 0;
  for (const here of nodes.values()) {
    const own = here.threads.map((id) => threadById.get(id)!.tone);
    const viaRollout = [...edges.values()].filter((e) => e.kind === "rollout" && e.to === here.id).map((e) => e.tone);
    const tone = strongest([...own, ...viaRollout]);
    here.tone = tone === "quiet" && here.done.length ? "ok" : tone;
    // Being listed in a rollout's table is not news. An app is on the map for its own work.
    here.quiet = here.kind === "app" && !here.threads.length && !here.done.length;
    if (here.quiet) quiet += 1;
    const load = here.threads.length + here.done.length * 0.5 + viaRollout.length * 0.35;
    here.r =
      here.kind === "owner" ? 16 + Math.min(12, here.threads.length * 1.3)
        : here.kind === "company" ? 15
          : here.kind === "rollout" ? 9
            : Math.min(17, 6 + 2.4 * Math.sqrt(load));
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], threads, done, quiet };
}

/* ------------------------------------------------------------------ layout */

const hash = (text: string): number => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
};

/**
 * Force layout, run to rest in one call. No animation loop: the map is drawn once, at rest.
 * Deterministic: the same graph always lands the same way. `previous` keeps nodes that were
 * already on screen where they were, so a live refresh moves only what changed.
 *
 * You sit at the centre. Owners are heavy, so the work they hold arranges around them.
 * `labelWidth` lets an app keep room for its name under it.
 */
export function layout(
  nodes: GraphNode[],
  edges: Edge[],
  labelWidth: (node: GraphNode) => number,
  previous: Map<string, { x: number; y: number }> = new Map(),
): void {
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const ring: Record<NodeKind, number> = { owner: 110, company: 90, rollout: 240, app: 190 };
  const vx = new Float64Array(nodes.length);
  const vy = new Float64Array(nodes.length);
  const fixed = (n: GraphNode): boolean => n.id === "owner:you";
  let fresh = 0;
  for (const n of nodes) {
    const was = previous.get(n.id);
    if (was) {
      n.x = was.x;
      n.y = was.y;
      continue;
    }
    fresh += 1;
    const angle = hash(n.id) * Math.PI * 2;
    const radius = fixed(n) ? 0 : ring[n.kind] * (0.85 + hash(`${n.id}#r`) * 0.3);
    n.x = Math.cos(angle) * radius;
    n.y = Math.sin(angle) * radius;
  }
  // Nothing new: the old picture is still the right one.
  if (!fresh && previous.size) return;
  const links = edges
    .map((e) => ({ a: index.get(e.from)!, b: index.get(e.to)!, e }))
    .filter((l) => l.a !== undefined && l.b !== undefined);
  const degree = new Float64Array(nodes.length);
  for (const l of links) { degree[l.a] += 1; degree[l.b] += 1; }
  // Every name sits under its node, so every node keeps room for its name and a line of air.
  const room = nodes.map((n) => Math.max(n.r + 14, labelWidth(n) * 0.5 + 6));
  const rest = (l: (typeof links)[number]): number =>
    l.e.kind === "depends" ? 80 : l.e.kind === "rollout" ? 95 : 110 + nodes[l.a].r + nodes[l.b].r;
  // Forces stay constant; the temperature only caps how far a node may move in one step. A
  // repulsion with a reach, and a pull home that never fades, keep a small island near the rest
  // instead of letting it drift until the fit has to shrink everything to show it.
  const REACH = 260;
  const steps = previous.size ? 160 : 480;
  for (let step = 0; step < steps; step++) {
    const temperature = 1 + 24 * (1 - step / steps);
    for (const l of links) {
      const a = nodes[l.a], b = nodes[l.b];
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 1;
      const strength = (l.e.kind === "depends" ? 0.03 : 0.06) / Math.max(1, Math.sqrt(Math.min(degree[l.a], degree[l.b])));
      const pull = ((dist - rest(l)) / dist) * strength;
      const share = degree[l.a] / (degree[l.a] + degree[l.b]);
      vx[l.a] += dx * pull * (1 - share); vy[l.a] += dy * pull * (1 - share);
      vx[l.b] -= dx * pull * share; vy[l.b] -= dy * pull * share;
    }
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = hash(a.id + b.id) - 0.5; dy = hash(b.id + a.id) - 0.5; d2 = dx * dx + dy * dy; }
        const dist = Math.sqrt(d2);
        if (dist > REACH + room[i] + room[j]) continue;
        const charge = (a.kind === "owner" || b.kind === "owner" ? 1400 : 420) / d2;
        const overlap = room[i] + room[j] - dist;
        const push = charge + (overlap > 0 ? (overlap / dist) * 0.45 : 0);
        vx[i] -= dx * push; vy[i] -= dy * push;
        vx[j] += dx * push; vy[j] += dy * push;
      }
    }
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (fixed(n)) { n.x = 0; n.y = 0; vx[i] = vy[i] = 0; continue; }
      // A node with few links leans on gravity for its place, so it gets more of it.
      const gravity = degree[i] ? 0.006 + 0.01 / degree[i] : 0.02;
      vx[i] -= n.x * gravity;
      vy[i] -= n.y * gravity;
      n.x += Math.max(-temperature, Math.min(temperature, vx[i]));
      n.y += Math.max(-temperature, Math.min(temperature, vy[i]));
      vx[i] *= 0.55;
      vy[i] *= 0.55;
    }
  }
}
