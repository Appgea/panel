import type { FleetUnit, FleetView } from "./fleet";
import { className, duration, marks, mission, said, tidy } from "./fleet_words";
import { insignia } from "./game_art";
import type { BoardIssue } from "./live_cards";
import { appName } from "./live_text";
import type { LiveAgent } from "./live_types";
import "./fleet_bridge.css";

export type FleetChange = { at: number; time: string; tag: string; text: string; commit: string };
export type BridgeData = {
  view: FleetView;
  commander: LiveAgent | null;
  calls: BoardIssue[] | null;
  changes: FleetChange[] | null;
  names: Record<string, string>;
  xp: number;
  rank: string;
  level: number;
};
export type BridgeEvents = {
  openTerminal?(panel: string): boolean;
  newCommander?(): Promise<boolean>;
  openIssue?(n: number): void;
};
export type BridgeHandle = { paint(d: BridgeData): void; dispose(): void };

const NS = "http://www.w3.org/2000/svg";
const W = 1000;
const H = 470;
const HUB = { x: 500, y: 62 };
const SLOTS = [
  [300, 250], [700, 215], [500, 360], [150, 120], [860, 375], [870, 105], [135, 375], [320, 380],
] as const;
const RING_MAX = 24;
const ROWS = 5;
const CLAUDE = new Set(["haiku", "sonnet", "opus", "fable"]);
const KNOWN = new Set(["terra", "flash", "sol", "astra", "hungerg"]);
const STATE_WORD: Record<string, string> = { work: "working", think: "thinking", turn: "waiting for you", idle: "idle", stuck: "stuck" };
const TAG: Record<string, [string, string]> = {
  ability: ["+", "Ability"], lens: ["◎", "Lens"], rule: ["R", "Skill"], code: ["</>", "Code"], fleet: ["F", "Fleet"],
};

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text) el.textContent = text;
  return el;
};
const s = (tag: string, attrs: Record<string, string | number> = {}, cls = ""): SVGElement => {
  const el = document.createElementNS(NS, tag) as SVGElement;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (cls) el.setAttribute("class", cls);
  return el;
};
const kindCls = (kind: string): string => `k-${CLAUDE.has(kind) ? "claude" : KNOWN.has(kind) ? kind : "other"}`;
const unitName = (u: { kind: string; id: string }): string =>
  `${className(u.kind)} ${u.id.startsWith(`${u.kind}-`) ? u.id.slice(u.kind.length + 1) : u.id.slice(0, 4)}`;
const keyOf = (app: string | null | undefined): string => (app ?? "").trim().toLowerCase();
const plain = (title: string): string => title.replace(/^[^:]{1,32}:\s+/, "");
const clock = (epoch: number): string => new Date(epoch * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

type Planet = { key: string; name: string; x: number; y: number; r: number; units: FleetUnit[]; landed: number; held: number; active: boolean };

function planets(view: FleetView, names: Record<string, string>): { list: Planet[]; dock: FleetUnit[]; more: number } {
  const by = new Map<string, Planet>();
  const dock: FleetUnit[] = [];
  const planet = (raw: string): Planet => {
    const key = keyOf(raw);
    let p = by.get(key);
    if (!p) {
      p = { key, name: names[key] ?? appName(raw), x: 0, y: 0, r: 0, units: [], landed: 0, held: 0, active: false };
      by.set(key, p);
    }
    return p;
  };
  for (const u of view.units ?? []) {
    const app = u.app || u.scout?.split("@")[1] || "";
    if (!app) {
      dock.push(u);
      continue;
    }
    const p = planet(app);
    p.units.push(u);
    p.held += u.issues.length;
    p.active = true;
  }
  for (const r of view.today ?? []) if (r.app && r.app !== "-") planet(r.app).landed += r.closed.length;
  const all = [...by.values()].filter((p) => p.active || p.landed > 0);
  all.sort((a, b) => Number(b.active) - Number(a.active) || b.units.length - a.units.length || b.landed - a.landed || a.name.localeCompare(b.name));
  const list = all.slice(0, SLOTS.length);
  list.forEach((p, i) => {
    [p.x, p.y] = SLOTS[i];
    p.r = p.active ? 30 + Math.min(p.units.length, 4) * 4 : 11 + Math.min(p.landed, 6) * 1.5;
  });
  return { list, dock, more: all.length - list.length };
}

export function mountBridge(root: HTMLElement, events: BridgeEvents): BridgeHandle {
  let data: BridgeData | null = null;
  let picked: string | null = null;
  let mapSig = "";

  const cmdMark = s("svg", { width: 34, height: 34, viewBox: "0 0 34 34", "aria-hidden": "true" });
  cmdMark.append(s("circle", { cx: 17, cy: 17, r: 16 }, "br-cmd-disc"), s("polygon", { points: "17,7 26,24 8,24" }, "br-cmd-tri"));
  const cmdName = h("b");
  const cmdState = h("small");
  const cmdText = h("div", "br-cmd-text");
  cmdText.append(cmdName, cmdState);
  const openBtn = h("button", "br-btn is-main", "Open session");
  openBtn.type = "button";
  const newBtn = h("button", "br-btn", "New session");
  newBtn.type = "button";
  newBtn.hidden = !events.newCommander;
  const cmd = h("div", "br-cmd");
  cmd.append(cmdMark, cmdText, openBtn, newBtn);
  const fuel = h("div", "br-fuel");
  fuel.setAttribute("aria-label", "Quota of each kind");
  const bar = h("header", "br-bar");
  bar.append(cmd, fuel);

  openBtn.addEventListener("click", () => {
    const panel = data?.commander?.panel;
    if (panel) events.openTerminal?.(panel);
  });
  newBtn.addEventListener("click", () => {
    if (!events.newCommander || newBtn.disabled) return;
    newBtn.disabled = true;
    newBtn.textContent = "Starting…";
    void events.newCommander().then((ok) => {
      newBtn.disabled = false;
      newBtn.textContent = ok ? "New session" : "Did not start";
    });
  });

  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "xMidYMid meet", role: "img", "aria-label": "Apps as planets, with the fleet's units around them" });
  const defs = s("defs");
  for (const [id, a, b] of [["br-pl", "#3a4a72", "#141b2e"], ["br-pl2", "#2a3554", "#111727"]]) {
    const g = s("radialGradient", { id, cx: "35%", cy: "30%" });
    g.append(s("stop", { offset: 0, "stop-color": a }), s("stop", { offset: 1, "stop-color": b }));
    defs.append(g);
  }
  const layer = s("g");
  svg.append(defs, layer);
  const stars = h("canvas", "br-stars");
  const badge = h("span", "br-insignia");
  const rankName = h("b");
  const xpText = h("span");
  const rankText = h("div");
  rankText.append(rankName, xpText);
  const score = h("div", "br-score");
  score.append(badge, rankText);
  const tip = h("div", "br-tip");
  tip.hidden = true;
  const docked = h("div", "br-docked");
  docked.append(h("b", "", "The fleet is docked"), h("span", "", "No unit is out and nothing landed today."));
  docked.hidden = true;
  const drawer = h("aside", "br-drawer");
  drawer.hidden = true;
  const space = h("section", "br-space");
  space.append(stars, svg, score, docked, tip, drawer);

  const strip = (title: string): { root: HTMLElement; count: HTMLElement; list: HTMLElement } => {
    const head = h("h2");
    const count = h("span", "br-count");
    count.hidden = true;
    head.append(document.createTextNode(title), count);
    const list = h("div", "br-rows");
    const rootEl = h("div", "br-strip");
    rootEl.append(head, list);
    return { root: rootEl, count, list };
  };
  const calls = strip("Your calls");
  const changes = strip("Fleet changes today");
  const hangar = strip("Hangar");
  hangar.root.classList.add("is-wide");
  hangar.list.className = "br-ships";
  hangar.count.classList.add("is-calm");
  const strips = h("div", "br-strips");
  strips.append(calls.root, changes.root, hangar.root);

  root.classList.add("br");
  root.replaceChildren(bar, space, strips);

  function paintStars(): void {
    const ratio = window.devicePixelRatio || 1;
    const w = (stars.width = Math.max(1, Math.round(space.clientWidth * ratio)));
    const ht = (stars.height = Math.max(1, Math.round(space.clientHeight * ratio)));
    const c = stars.getContext("2d");
    if (!c) return;
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 220; i++) {
      c.fillStyle = `rgba(220,228,245,${(0.15 + rnd() * 0.5).toFixed(2)})`;
      const size = rnd() * 1.4 * ratio;
      c.fillRect(rnd() * w, rnd() * ht, size, size);
    }
  }
  const resize = new ResizeObserver(() => paintStars());
  resize.observe(space);

  function ring(cx: number, cy: number, r: number, landed: number, held: number): SVGElement {
    const g = s("g");
    const total = landed + held;
    if (!total) {
      g.append(s("circle", { cx, cy, r, fill: "none", "stroke-width": 2, "stroke-dasharray": "2 6" }, "br-ring-scout"));
      return g;
    }
    const n = Math.min(total, RING_MAX);
    const green = Math.round((landed / total) * n);
    if (n === 1) {
      g.append(s("circle", { cx, cy, r, fill: "none", "stroke-width": 5 }, green ? "br-seg is-landed" : "br-seg is-held"));
      return g;
    }
    const step = (Math.PI * 2) / n;
    const gap = Math.min(0.12, step * 0.25);
    for (let i = 0; i < n; i++) {
      const a0 = -Math.PI / 2 + i * step + gap / 2;
      const a1 = a0 + step - gap;
      const d = `M ${(cx + r * Math.cos(a0)).toFixed(1)} ${(cy + r * Math.sin(a0)).toFixed(1)} A ${r} ${r} 0 0 1 ${(cx + r * Math.cos(a1)).toFixed(1)} ${(cy + r * Math.sin(a1)).toFixed(1)}`;
      g.append(s("path", { d, fill: "none", "stroke-width": 5, "stroke-linecap": "round" }, i < green ? "br-seg is-landed" : "br-seg is-held"));
    }
    return g;
  }

  function ship(u: FleetUnit, x: number, y: number): SVGElement {
    const scout = u.role === "scout" || Boolean(u.scout);
    const cls = `br-ship ${kindCls(u.kind)}${u.flags.length ? " is-flagged" : ""}`;
    const g = s("g", { transform: `translate(${x.toFixed(1)} ${y.toFixed(1)})`, tabindex: 0, role: "button", "aria-label": `${unitName(u)}: ${mission(u).title}` }, cls);
    g.dataset.unit = u.id;
    if (u.flags.length) g.append(s("circle", { r: 15 }, "br-alarm"));
    g.append(s("circle", { r: u.role === "checker" ? 8 : 10 }, scout ? "br-hull is-scout" : "br-hull"));
    return g;
  }

  function paintMap(d: BridgeData): void {
    const { list, dock, more } = planets(d.view, d.names);
    docked.hidden = list.length > 0 || dock.length > 0;
    const sig = JSON.stringify([list.map((p) => [p.key, p.r, p.landed, p.held, p.units.map((u) => [u.id, u.flags.length, u.role])]), dock.map((u) => [u.id, u.flags.length, u.role]), more, Boolean(d.commander)]);
    if (sig === mapSig) return;
    mapSig = sig;
    const nodes: SVGElement[] = [];
    const hub = s("g", { transform: `translate(${HUB.x} ${HUB.y})` }, d.commander ? "br-hub" : "br-hub is-off");
    for (const p of list.filter((x) => x.active)) {
      hub.append(s("line", { x1: 0, y1: 18, x2: p.x - HUB.x, y2: p.y - HUB.y - p.r - 22 }, "br-link"));
    }
    hub.append(s("polygon", { points: "0,-16 15,10 -15,10" }));
    nodes.push(hub);
    for (const p of list) {
      const g = s("g", {}, p.active ? "br-planet" : "br-planet is-quiet");
      g.append(ring(p.x, p.y, p.r + 16, p.landed, p.held));
      g.append(s("circle", { cx: p.x, cy: p.y, r: p.r, fill: p.active ? "url(#br-pl)" : "url(#br-pl2)" }));
      const name = s("text", { x: p.x, y: p.y + p.r + (p.active ? 42 : 34), "text-anchor": "middle" }, p.active ? "br-pname" : "br-pname is-small");
      name.textContent = p.active ? p.name.toUpperCase() : p.name;
      g.append(name);
      const bits = [p.landed ? `${p.landed} landed` : "", p.held ? `${p.held} in work` : "", !p.held && p.units.length ? "scouting" : ""].filter(Boolean);
      if (bits.length) {
        const meta = s("text", { x: p.x, y: p.y + p.r + (p.active ? 58 : 48), "text-anchor": "middle" }, p.landed ? "br-pmeta is-ok" : "br-pmeta");
        meta.textContent = bits.join(" · ");
        g.append(meta);
      }
      if (p.units.length) {
        const orbit = s("g", {}, "br-orbit");
        orbit.setAttribute("style", `--o:${p.x}px ${p.y}px;--t:${60 + (p.x % 30)}s`);
        const r = p.r + 16;
        p.units.forEach((u, i) => {
          const a = -Math.PI / 4 + (i * Math.PI * 2) / p.units.length;
          orbit.append(ship(u, p.x + r * Math.cos(a), p.y + r * Math.sin(a)));
        });
        g.append(orbit);
      }
      nodes.push(g);
    }
    dock.forEach((u, i) => nodes.push(ship(u, HUB.x - ((dock.length - 1) * 30) / 2 + i * 30, HUB.y + 70)));
    if (more > 0) {
      const t = s("text", { x: W - 16, y: H - 14, "text-anchor": "end" }, "br-pmeta");
      t.textContent = `+${more} more ${more === 1 ? "app" : "apps"}`;
      nodes.push(t);
    }
    layer.replaceChildren(...nodes);
  }

  function paintBar(d: BridgeData): void {
    const c = d.commander;
    cmdName.textContent = c ? c.name ?? "Commander" : "No commander";
    cmdState.textContent = c ? [c.model ?? c.harness, STATE_WORD[c.state] ?? c.state].filter(Boolean).join(" · ") : "Start one in a new session";
    cmdState.className = c ? `is-${c.state}` : "is-none";
    openBtn.hidden = !c;
    openBtn.disabled = !c?.panel || !events.openTerminal;
    openBtn.textContent = c && !c.panel ? "Runs outside Panel" : "Open session";
    newBtn.classList.toggle("is-main", !c);
    const spec = (d.view.spec ?? "").split(" ")[0].split(",").map((x) => x.split(":")[0]).filter(Boolean);
    const down = d.view.down ?? {};
    const kinds = [...new Set([...spec, ...(d.view.units ?? []).map((u) => u.kind), ...Object.keys(down)])];
    fuel.replaceChildren(...kinds.map((k) => {
      const out = down[k];
      const pill = h("span", `br-fuel-pill ${kindCls(k)}${out ? " is-out" : ""}`);
      pill.append(h("i"), document.createTextNode(out ? `${className(k)} · back ${clock(out)}` : className(k)));
      pill.title = out ? `${className(k)}'s quota is out until ${new Date(out * 1000).toLocaleString()}` : `${className(k)} has quota`;
      return pill;
    }));
  }

  function row(dot: HTMLElement, text: string, time = "", onClick?: () => void): HTMLElement {
    const el = onClick ? h("button", "br-row is-link") : h("div", "br-row");
    if (onClick && el instanceof HTMLButtonElement) {
      el.type = "button";
      el.addEventListener("click", onClick);
    }
    el.title = text;
    el.append(dot, h("span", "br-row-text", text));
    if (time) el.append(h("time", "", time));
    return el;
  }

  function paintStrips(d: BridgeData): void {
    const asks = d.calls ?? [];
    calls.count.hidden = asks.length === 0;
    calls.count.textContent = String(asks.length);
    calls.list.replaceChildren(
      ...(d.calls === null
        ? [h("p", "br-none", "The board is not read yet.")]
        : asks.length
          ? asks.slice(0, ROWS).map((a) => row(h("span", `br-dot is-p${Math.min(a.priority ?? 2, 3)}`), a.ask || a.title, "", events.openIssue ? () => events.openIssue!(a.number) : undefined))
          : [h("p", "br-none", "Nothing waits for you.")]),
      ...(asks.length > ROWS ? [h("p", "br-none", `+${asks.length - ROWS} more on the board`)] : []),
    );
    const list = d.changes ?? [];
    changes.list.replaceChildren(
      ...(list.length
        ? list.slice(0, ROWS).map((c) => {
            const [icon, label] = TAG[c.tag] ?? TAG.fleet;
            const ic = h("span", `br-ic is-${TAG[c.tag] ? c.tag : "fleet"}`, icon);
            ic.title = label;
            return row(ic, c.text, c.time);
          })
        : [h("p", "br-none", d.changes === null ? "Changes are not read yet." : "No change to the fleet today.")]),
    );
    const units = [...(d.view.units ?? [])].sort((a, b) => b.flags.length - a.flags.length || b.minutes - a.minutes);
    hangar.count.hidden = units.length === 0;
    hangar.count.textContent = String(units.length);
    hangar.list.replaceChildren(
      ...(units.length
        ? units.map((u) => {
            const m = mission(u);
            const tile = h("button", `br-tile ${kindCls(u.kind)}${u.id === picked ? " is-lit" : ""}${u.flags.length ? " is-flagged" : ""}`);
            tile.type = "button";
            tile.dataset.unit = u.id;
            const top = h("div", "br-tile-top");
            top.append(h("span", "br-dot"), h("b", "", unitName(u)), h("span", "", m.app || u.role || ""));
            const share = u.budget > 0 ? Math.min(100, (u.minutes / u.budget) * 100) : 0;
            const meter = h("i", share > 85 ? "is-late" : "");
            meter.style.setProperty("--v", `${share.toFixed(0)}%`);
            tile.append(top, h("div", "br-tile-m", plain(m.title)), meter);
            tile.title = `${m.title}\n${duration(u.minutes)}${u.budget ? ` of ${duration(u.budget)}` : ""}`;
            return tile;
          })
        : [h("p", "br-none", "No unit is out.")]),
    );
  }

  function paintDrawer(d: BridgeData): void {
    drawer.hidden = !picked;
    if (!picked) return;
    const u = (d.view.units ?? []).find((x) => x.id === picked);
    const close = h("button", "br-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", () => pick(null));
    if (!u) {
      drawer.replaceChildren(close, h("p", "br-none", "This unit has ended."));
      return;
    }
    const m = mission(u);
    const head = h("div", `br-d-head ${kindCls(u.kind)}`);
    head.append(h("span", "br-dot"), h("b", "", unitName(u)), h("span", "", [m.app, u.role].filter(Boolean).join(" · ")));
    const title = h("p", "br-d-title");
    if (m.number && events.openIssue) {
      const n = m.number;
      const link = h("button", "br-issue", `#${n}`);
      link.type = "button";
      link.addEventListener("click", () => events.openIssue!(n));
      title.append(link, document.createTextNode(` ${plain(m.title)}`));
    } else title.textContent = m.title;
    const words = said(u.screen);
    const share = u.budget > 0 ? Math.min(100, (u.minutes / u.budget) * 100) : 0;
    const meter = h("div", "br-d-meter");
    const fill = h("i", share > 85 ? "is-late" : "");
    fill.style.setProperty("--v", `${share.toFixed(0)}%`);
    meter.append(fill, h("span", "", `${duration(u.minutes)}${u.budget ? ` of ${duration(u.budget)}` : ""} · ${u.tokens} tokens${u.quiet >= 5 ? ` · quiet ${duration(u.quiet)}` : ""}`));
    const flags = u.flags.length ? [h("p", "br-d-flags", u.flags.map((f) => (f === "OVER" ? "Over time" : f === "STUCK" ? "Stuck" : f)).join(" · "))] : [];
    const old = drawer.querySelector<HTMLPreElement>(".br-d-term");
    const atEnd = !old || old.scrollHeight - old.scrollTop - old.clientHeight < 24;
    const keep = old?.scrollTop ?? 0;
    const pre = h("pre", "br-d-term", tidy(u.screen) || "Nothing on its terminal yet.");
    pre.tabIndex = 0;
    const saidEl = words ? [h("p", "br-d-said")] : [];
    if (words) saidEl[0].append(...marks(words).map((m) => (m.mark ? h(m.mark, "", m.text) : document.createTextNode(m.text))));
    drawer.replaceChildren(close, head, title, ...flags, ...saidEl, meter, pre);
    pre.scrollTop = atEnd ? pre.scrollHeight : keep;
  }

  function pick(id: string | null): void {
    picked = id === null || picked === id ? null : id;
    if (data) paintAll(data);
  }

  function paintAll(d: BridgeData): void {
    paintBar(d);
    rankName.textContent = d.rank;
    xpText.textContent = `+${d.xp} XP today`;
    if (badge.dataset.level !== String(d.level)) {
      badge.dataset.level = String(d.level);
      badge.innerHTML = d.level ? insignia(d.level) : "";
    }
    paintMap(d);
    layer.querySelectorAll<SVGElement>("[data-unit]").forEach((el) => el.classList.toggle("is-lit", el.dataset.unit === picked));
    paintStrips(d);
    paintDrawer(d);
  }

  const unitAt = (e: Event): string | null => (e.target as Element | null)?.closest<HTMLElement | SVGElement>("[data-unit]")?.dataset.unit ?? null;
  root.addEventListener("click", (e) => {
    const id = unitAt(e);
    if (id) pick(id);
  });
  root.addEventListener("keydown", (e) => {
    const id = unitAt(e);
    if (id && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      pick(id);
    } else if (e.key === "Escape" && picked) pick(null);
  });
  space.addEventListener("mousemove", (e) => {
    const id = unitAt(e);
    const u = id ? data?.view.units?.find((x) => x.id === id) : null;
    if (!u || !drawer.hidden) {
      tip.hidden = true;
      return;
    }
    tip.replaceChildren(h("b", "", unitName(u)), document.createTextNode(plain(mission(u).title)));
    const r = space.getBoundingClientRect();
    tip.style.left = `${Math.max(8, Math.min(e.clientX - r.left + 14, r.width - 240))}px`;
    tip.style.top = `${e.clientY - r.top + 14}px`;
    tip.hidden = false;
  });
  space.addEventListener("mouseleave", () => (tip.hidden = true));

  return {
    paint(d) {
      data = d;
      paintAll(d);
    },
    dispose() {
      resize.disconnect();
    },
  };
}
