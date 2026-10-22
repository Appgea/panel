/**
 * Invented pictures for the made-up portfolio: app icons and the renders its agents "made".
 *
 * capture.mjs serves these as the project-icon and project-asset schemes, so Review, the report
 * gallery and the sidebar show real-looking work without a single file from anyone's machine.
 * Everything is drawn here as SVG; a seeded random keeps every capture identical.
 */

const seeded = (seed) => () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

const svg = (width, height, body, defs = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
  `<defs>${defs}</defs>${body}</svg>`;

const linear = (id, stops, x2 = 0, y2 = 1) =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="${x2}" y2="${y2}">` +
  stops.map(([at, color, opacity = 1]) => `<stop offset="${at}" stop-color="${color}" stop-opacity="${opacity}"/>`).join("") +
  `</linearGradient>`;

/* ------------------------------------------------------------------ icons */

const ICONS = {
  tidepool: {
    from: "#22d3ee",
    to: "#2563eb",
    glyph:
      `<path d="M28 52c10-14 30-16 44-4l10-8v24l-10-8c-14 12-34 10-44-4z" fill="#fff"/>` +
      `<circle cx="60" cy="50" r="3.2" fill="#1e3a8a"/>` +
      `<circle cx="34" cy="30" r="4" fill="#fff" opacity=".7"/><circle cx="44" cy="22" r="2.6" fill="#fff" opacity=".55"/>`,
  },
  lumen: {
    from: "#fbbf24",
    to: "#f43f5e",
    glyph:
      `<circle cx="50" cy="50" r="18" fill="none" stroke="#fff" stroke-width="6"/>` +
      Array.from({ length: 8 }, (_, i) => {
        const a = (i * Math.PI) / 4;
        const x1 = 50 + Math.cos(a) * 28, y1 = 50 + Math.sin(a) * 28;
        const x2 = 50 + Math.cos(a) * 36, y2 = 50 + Math.sin(a) * 36;
        return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#fff" stroke-width="6" stroke-linecap="round"/>`;
      }).join(""),
  },
  orbit: {
    from: "#a78bfa",
    to: "#4c1d95",
    glyph:
      `<ellipse cx="50" cy="50" rx="32" ry="14" fill="none" stroke="#fff" stroke-width="5" transform="rotate(-24 50 50)"/>` +
      `<circle cx="50" cy="50" r="12" fill="#fff"/><circle cx="78" cy="38" r="6" fill="#fde68a"/>`,
  },
  ledgerly: {
    from: "#34d399",
    to: "#047857",
    glyph:
      `<path d="M32 22h36v56l-6-5-6 5-6-5-6 5-6-5-6 5z" fill="#fff"/>` +
      `<rect x="39" y="34" width="22" height="5" rx="2.5" fill="#047857"/>` +
      `<rect x="39" y="46" width="16" height="5" rx="2.5" fill="#047857" opacity=".6"/>` +
      `<rect x="39" y="58" width="19" height="5" rx="2.5" fill="#047857" opacity=".6"/>`,
  },
  quill: {
    from: "#f9a8d4",
    to: "#be185d",
    glyph:
      `<path d="M74 20C48 24 32 44 28 78l6 2c4-10 8-17 13-22 10 0 20-6 25-16-6 1-10 0-13-2 8-3 14-10 15-20z" fill="#fff"/>`,
  },
  kite: {
    from: "#7dd3fc",
    to: "#0369a1",
    glyph:
      `<path d="M50 16l20 26-20 34-20-34z" fill="#fff"/><path d="M50 16v60M30 42h40" stroke="#0369a1" stroke-width="3"/>` +
      `<path d="M50 76c-4 6 4 8 0 14" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round"/>`,
  },
};

export function icon(id) {
  const spec = ICONS[id];
  if (!spec) return null;
  return svg(
    100,
    100,
    `<rect width="100" height="100" rx="22" fill="url(#bg)"/>` +
      `<rect width="100" height="50" rx="22" fill="#fff" opacity=".08"/>` +
      spec.glyph,
    linear("bg", [[0, spec.from], [1, spec.to]], 1, 1),
  );
}

/* --------------------------------------------------------- Tidepool reefs */

const REEF_PALETTES = {
  dawn: { top: "#fbcfe8", mid: "#38bdf8", deep: "#1e3a8a", sand: "#fcd9a8", weed: "#16a34a", fish: ["#fb923c", "#facc15", "#f472b6"], ray: 0.28 },
  noon: { top: "#a5f3fc", mid: "#06b6d4", deep: "#0e7490", sand: "#fde68a", weed: "#15803d", fish: ["#f97316", "#eab308", "#e11d48"], ray: 0.38 },
  night: { top: "#312e81", mid: "#1e1b4b", deep: "#020617", sand: "#475569", weed: "#14532d", fish: ["#22d3ee", "#a78bfa", "#f0abfc"], ray: 0.12 },
};

function fish(x, y, size, color, flip, glow) {
  const s = size;
  const dir = flip ? -1 : 1;
  return (
    `<g transform="translate(${x} ${y}) scale(${dir} 1)"${glow ? ` filter="url(#glow)"` : ""}>` +
    `<path d="M${-s} 0 C ${-s * 0.4} ${-s * 0.62}, ${s * 0.55} ${-s * 0.55}, ${s} 0 C ${s * 0.55} ${s * 0.55}, ${-s * 0.4} ${s * 0.62}, ${-s} 0 Z" fill="${color}"/>` +
    `<path d="M${-s * 0.9} 0 L ${-s * 1.55} ${-s * 0.48} L ${-s * 1.4} 0 L ${-s * 1.55} ${s * 0.48} Z" fill="${color}" opacity=".85"/>` +
    `<path d="M${-s * 0.1} ${-s * 0.42} q ${s * 0.25} ${-s * 0.35} ${s * 0.5} ${-s * 0.05}" fill="none" stroke="${color}" stroke-width="${s * 0.12}" opacity=".7"/>` +
    `<path d="M${-s * 0.25} ${-s * 0.4} v ${s * 0.8}" stroke="#fff" stroke-width="${s * 0.1}" opacity=".45"/>` +
    `<circle cx="${s * 0.55}" cy="${-s * 0.1}" r="${s * 0.1}" fill="#0f172a"/>` +
    `<circle cx="${s * 0.58}" cy="${-s * 0.13}" r="${s * 0.035}" fill="#fff"/>` +
    `</g>`
  );
}

function reef(mood) {
  const p = REEF_PALETTES[mood];
  const rnd = seeded(mood.length * 7919 + 13);
  const W = 1600, H = 1000;
  const rays = Array.from({ length: 6 }, (_, i) => {
    const x = 180 + i * 260 + rnd() * 80;
    return `<polygon points="${x},0 ${x + 90},0 ${x + 260},${H * 0.82} ${x - 60},${H * 0.82}" fill="url(#ray)" opacity="${p.ray * (0.5 + rnd() * 0.5)}"/>`;
  }).join("");
  const weeds = Array.from({ length: 16 }, () => {
    const x = rnd() * W, h = 160 + rnd() * 300, sway = 30 + rnd() * 50;
    return `<path d="M${x} ${H - 80} C ${x - sway} ${H - 80 - h * 0.35}, ${x + sway} ${H - 80 - h * 0.7}, ${x + sway * 0.3} ${H - 80 - h}" stroke="${p.weed}" stroke-width="${10 + rnd() * 10}" fill="none" stroke-linecap="round" opacity="${0.65 + rnd() * 0.35}"/>`;
  }).join("");
  const coral = Array.from({ length: 5 }, (_, i) => {
    const x = 120 + i * 330 + rnd() * 60, r = 40 + rnd() * 30;
    const hue = ["#fb7185", "#f97316", "#c084fc", "#f472b6", "#fbbf24"][i];
    return `<g opacity="${mood === "night" ? 0.6 : 0.95}"><circle cx="${x}" cy="${H - 110}" r="${r}" fill="${hue}"/><circle cx="${x + r * 0.8}" cy="${H - 130}" r="${r * 0.7}" fill="${hue}" opacity=".8"/><circle cx="${x - r * 0.7}" cy="${H - 125}" r="${r * 0.55}" fill="${hue}" opacity=".7"/></g>`;
  }).join("");
  const school = Array.from({ length: 9 }, (_, i) =>
    fish(160 + rnd() * 1280, 160 + rnd() * 520, 38 + rnd() * 46, p.fish[i % p.fish.length], rnd() > 0.6, mood === "night"),
  ).join("");
  const bubbles = Array.from({ length: 28 }, () =>
    `<circle cx="${rnd() * W}" cy="${rnd() * H * 0.85}" r="${3 + rnd() * 9}" fill="none" stroke="#fff" stroke-width="2" opacity="${0.25 + rnd() * 0.4}"/>`,
  ).join("");
  const stars = mood === "night"
    ? Array.from({ length: 40 }, () => `<circle cx="${rnd() * W}" cy="${rnd() * H * 0.8}" r="${1 + rnd() * 2}" fill="#e0f2fe" opacity="${0.3 + rnd() * 0.6}"/>`).join("")
    : "";
  return svg(
    W,
    H,
    `<rect width="${W}" height="${H}" fill="url(#water)"/>${stars}${rays}${bubbles}${weeds}` +
      `<path d="M0 ${H - 90} C 300 ${H - 150}, 600 ${H - 60}, 900 ${H - 110} S 1400 ${H - 70}, ${W} ${H - 120} V ${H} H 0 Z" fill="url(#sand)"/>` +
      `${coral}${school}` +
      `<rect width="${W}" height="${H}" fill="url(#vignette)"/>`,
    linear("water", [[0, p.top], [0.45, p.mid], [1, p.deep]]) +
      linear("ray", [[0, "#fff", 0.9], [1, "#fff", 0]]) +
      linear("sand", [[0, p.sand], [1, p.deep]]) +
      `<radialGradient id="vignette" cx=".5" cy=".45" r=".75"><stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".35"/></radialGradient>` +
      `<filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`,
  );
}

/* ------------------------------------------------------- Lumen filter set */

const FILTERS = {
  golden: "1.25 0.15 0 0 0.06  0.10 1.02 0 0 0.03  0 0 0.55 0 -0.02  0 0 0 1 0",
  noir: "0.33 0.55 0.12 0 -0.04  0.33 0.55 0.12 0 -0.04  0.33 0.55 0.12 0 -0.04  0 0 0 1 0",
  fade: "0.78 0.08 0.06 0 0.12  0.06 0.80 0.08 0 0.12  0.06 0.10 0.76 0 0.16  0 0 0 1 0",
};

function lake(filter) {
  const W = 1500, H = 1000;
  const rnd = seeded(4242);
  const pines = Array.from({ length: 22 }, (_, i) => {
    const x = i * 72 + rnd() * 30, h = 90 + rnd() * 70, base = 610;
    return `<path d="M${x} ${base} l ${h * 0.28} ${-h} l ${h * 0.28} ${h} z" fill="#14532d"/>`;
  }).join("");
  const scene =
    `<rect width="${W}" height="${H}" fill="url(#sky)"/>` +
    `<circle cx="1050" cy="330" r="90" fill="#fef3c7"/><circle cx="1050" cy="330" r="150" fill="#fde68a" opacity=".25"/>` +
    `<path d="M0 520 L 260 300 L 420 430 L 640 220 L 880 460 L 1080 330 L 1320 470 L ${W} 380 V 620 H 0 Z" fill="#6d28d9" opacity=".55"/>` +
    `<path d="M0 560 L 200 420 L 380 520 L 560 380 L 800 540 L 1000 430 L 1250 560 L ${W} 470 V 640 H 0 Z" fill="#4338ca" opacity=".7"/>` +
    `<g>${pines}</g>` +
    `<rect y="610" width="${W}" height="${H - 610}" fill="url(#lake)"/>` +
    Array.from({ length: 11 }, (_, i) => {
      const w = 150 - i * 11 + rnd() * 30;
      return `<rect x="${1050 - w / 2 + (rnd() - 0.5) * 30}" y="${628 + i * 24}" width="${w}" height="7" rx="3.5" fill="#fef3c7" opacity="${0.55 - i * 0.04}"/>`;
    }).join("") +
    Array.from({ length: 14 }, () => `<rect x="${rnd() * W}" y="${640 + rnd() * 320}" width="${60 + rnd() * 160}" height="3" rx="1.5" fill="#fff" opacity="${0.12 + rnd() * 0.2}"/>`).join("") +
    `<path d="M0 ${H} V 900 C 300 880, 520 940, 760 920 S 1200 870, ${W} 900 V ${H} Z" fill="#1c1917" opacity=".85"/>`;
  return svg(
    W,
    H,
    `<g filter="url(#grade)">${scene}</g><rect width="${W}" height="${H}" fill="url(#vig)"/>`,
    linear("sky", [[0, "#fb923c"], [0.55, "#f9a8d4"], [1, "#c4b5fd"]]) +
      linear("lake", [[0, "#7c3aed"], [1, "#1e1b4b"]]) +
      `<filter id="grade"><feColorMatrix type="matrix" values="${FILTERS[filter]}"/></filter>` +
      `<radialGradient id="vig" cx=".5" cy=".5" r=".75"><stop offset=".65" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".4"/></radialGradient>`,
  );
}

/* -------------------------------------------------- Ledgerly store screen */

function ledgerlyScreen() {
  const W = 1290, H = 2796;
  const font = `font-family="-apple-system, 'SF Pro Display', 'Segoe UI', system-ui, sans-serif"`;
  const row = (y, who, color, what, amount, share) =>
    `<g transform="translate(90 ${y})">` +
    `<rect width="1110" height="230" rx="48" fill="#fff"/>` +
    `<circle cx="120" cy="115" r="64" fill="${color}"/><text x="120" y="138" text-anchor="middle" font-size="64" font-weight="700" fill="#fff" ${font}>${who[0]}</text>` +
    `<text x="225" y="100" font-size="56" font-weight="600" fill="#0f172a" ${font}>${what}</text>` +
    `<text x="225" y="168" font-size="42" fill="#64748b" ${font}>${who} paid · ${share}</text>` +
    `<text x="1060" y="135" text-anchor="end" font-size="60" font-weight="700" fill="#0f172a" ${font}>${amount}</text>` +
    `</g>`;
  return svg(
    W,
    H,
    `<rect width="${W}" height="${H}" fill="url(#bg)"/>` +
      `<text x="${W / 2}" y="330" text-anchor="middle" font-size="96" font-weight="800" fill="#fff" ${font}>Split by item.</text>` +
      `<text x="${W / 2}" y="420" text-anchor="middle" font-size="96" font-weight="800" fill="#bbf7d0" ${font}>Settle in a tap.</text>` +
      `<g transform="translate(0 560)">` +
      `<rect x="40" width="${W - 80}" height="2160" rx="110" fill="#f1f5f9"/>` +
      `<text x="140" y="190" font-size="76" font-weight="800" fill="#0f172a" ${font}>Ski trip</text>` +
      `<text x="140" y="260" font-size="44" fill="#64748b" ${font}>4 people · 12 receipts</text>` +
      `<rect x="90" y="320" width="1110" height="300" rx="56" fill="url(#card)"/>` +
      `<text x="160" y="430" font-size="46" fill="#d1fae5" ${font}>You are owed</text>` +
      `<text x="160" y="550" font-size="112" font-weight="800" fill="#fff" ${font}>€248.60</text>` +
      row(690, "Mia", "#f97316", "Chalet dinner", "€186.00", "split 4 ways") +
      row(950, "Jonas", "#6366f1", "Lift passes", "€392.00", "by person") +
      row(1210, "You", "#10b981", "Groceries", "€74.30", "by item") +
      row(1470, "Ada", "#ec4899", "Fuel", "€58.90", "split 2 ways") +
      `<rect x="90" y="1780" width="1110" height="170" rx="85" fill="#0f172a"/>` +
      `<text x="${W / 2}" y="1885" text-anchor="middle" font-size="56" font-weight="700" fill="#fff" ${font}>Settle up</text>` +
      `</g>`,
    linear("bg", [[0, "#059669"], [1, "#064e3b"]]) + linear("card", [[0, "#10b981"], [1, "#047857"]], 1, 1),
  );
}

/* ------------------------------------------------------------- the index */

const ART = {
  "reef_dawn.png": () => reef("dawn"),
  "reef_noon.png": () => reef("noon"),
  "reef_night.png": () => reef("night"),
  "golden.png": () => lake("golden"),
  "noir.png": () => lake("noir"),
  "fade.png": () => lake("fade"),
  "store_01.png": () => ledgerlyScreen(),
};

/** The picture for a requested asset path, by file name, or null for anything else. */
export function asset(path) {
  const name = decodeURIComponent(path).split("/").pop();
  return ART[name]?.() ?? null;
}
