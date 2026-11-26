/**
 * The game's pictures, shared by Live and the AI fleet screen: the day's rank as an insignia on a
 * metal shield, each class's crest, and the streak's flame. Inline SVG, so each is sharp at any
 * size and needs no file. Owner, 2026-11-19: "the graphics and gamification must be way stronger."
 *
 * The rank names are army ranks (live_game.ts), so the shield wears what that rank wears:
 * chevrons up to the sergeants, bars for lieutenant and captain, stars above. Its metal climbs
 * from bronze to a violet legend, so a glance says how far the day has come.
 */

type Tier = { name: string; from: string; to: string; ink: string };

const TIERS: Tier[] = [
  { name: "bronze", from: "#f3bd8a", to: "#93552a", ink: "#2b1606" },
  { name: "silver", from: "#f4f7fb", to: "#8693a5", ink: "#18202d" },
  { name: "gold", from: "#fff0a8", to: "#c3861a", ink: "#2e1f00" },
  { name: "platinum", from: "#dcfcff", to: "#3f97c0", ink: "#05212e" },
  { name: "legend", from: "#f4dcff", to: "#7b3cf0", ink: "#1b0533" },
];

function tierOf(level: number): Tier {
  return TIERS[level <= 3 ? 0 : level <= 5 ? 1 : level <= 7 ? 2 : level <= 10 ? 3 : 4];
}

let ids = 0;

/** The day's rank as a shield. 48 by 56: set its size with CSS width. */
export function insignia(level: number): string {
  const t = tierOf(level);
  const id = `ins${++ids}`;
  return (
    `<svg class="insignia t-${t.name}" viewBox="0 0 48 56" aria-hidden="true">` +
    `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0.35" y2="1">` +
    `<stop offset="0" stop-color="${t.from}"/><stop offset="1" stop-color="${t.to}"/></linearGradient></defs>` +
    `<path d="${SHIELD}" fill="url(#${id})" stroke="${t.to}" stroke-width="1.5"/>` +
    `<path d="M24 5.5 40.5 11.3V26c0 3-.5 5.6-1.5 8H9c-1-2.4-1.5-5-1.5-8V11.3Z" fill="#fff" opacity="0.18"/>` +
    marks(level, t.ink) +
    `</svg>`
  );
}

const SHIELD = "M24 2 44 9v17.5C44 39.5 35.5 48.5 24 54 12.5 48.5 4 39.5 4 26.5V9Z";

function marks(level: number, ink: string): string {
  const chev = (y: number) => `<path d="M13.5 ${y}l10.5 7 10.5-7" fill="none" stroke="${ink}" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round"/>`;
  const bar = (y: number) => `<rect x="14" y="${y}" width="20" height="4.6" rx="1.8" fill="${ink}"/>`;
  const stars = (pts: [number, number, number][]) => pts.map(([x, y, r]) => star(x, y, r, ink)).join("");
  switch (level) {
    case 1:
      return `<circle cx="24" cy="27" r="5.5" fill="none" stroke="${ink}" stroke-width="3.2"/>`;
    case 2:
      return chev(23);
    case 3:
      return chev(18) + chev(27);
    case 4:
      return chev(14) + chev(22.5) + chev(31);
    case 5:
      return chev(11) + chev(19) + chev(27) + `<path d="M14 37q10 6.5 20 0" fill="none" stroke="${ink}" stroke-width="3.6" stroke-linecap="round"/>`;
    case 6:
      return bar(24);
    case 7:
      return bar(19) + bar(28);
    case 8:
      return stars([[24, 27, 9]]);
    case 9:
      return stars([[16.5, 27, 6.5], [31.5, 27, 6.5]]);
    case 10:
      return stars([[24, 19, 6], [16, 32, 6], [32, 32, 6]]);
    default:
      return stars([[16.5, 20, 5.6], [31.5, 20, 5.6], [16.5, 33, 5.6], [31.5, 33, 5.6]]);
  }
}

function star(cx: number, cy: number, r: number, fill: string): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 ? r * 0.45 : r;
    const a = (Math.PI / 5) * i - Math.PI / 2;
    pts.push(`${(cx + rad * Math.cos(a)).toFixed(2)},${(cy + rad * Math.sin(a)).toFixed(2)}`);
  }
  return `<polygon points="${pts.join(" ")}" fill="${fill}"/>`;
}

/** Each class's sign, drawn in currentColor: Terra a mountain, Flash a bolt, Sonnet a quill. */
const CREST: Record<string, string> = {
  terra: "M2 20 9.5 7l4 6.5L16 10l6 10Z",
  flash: "M13.5 2 4 13.5h6.5L9 22l11-13h-6.8L15.5 2Z",
  sonnet: "M21 3C13 3 7.2 8 5.6 16.4L4 21h1.9l1.1-3.3C14 17 19 11.2 21 3Z",
  haiku: "M4.5 19.5C4.5 10.5 10.5 4 20 4c0 9.5-6.5 15.5-15.5 15.5Zm1.6-1.6 7.4-7.4",
  opus: "M3 7.5 7.5 11 12 4l4.5 7L21 7.5 19 19H5Z",
  fable: "M3.5 5h6.5a2.5 2.5 0 0 1 2 1v14a2.6 2.6 0 0 0-2-1H3.5ZM20.5 5H14a2.5 2.5 0 0 0-2 1v14a2.6 2.6 0 0 1 2-1h6.5Z",
};

export function crest(kind: string): string {
  const d = CREST[kind] ?? "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z";
  return `<svg class="crest" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}" fill="currentColor"/></svg>`;
}

export function art(cls: string, svg: string): HTMLElement {
  const el = document.createElement("span");
  el.className = cls;
  el.innerHTML = svg;
  return el;
}
