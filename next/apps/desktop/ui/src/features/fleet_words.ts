/**
 * The AI fleet screen's words, apart from its DOM so they can be tested: what a unit is for, what
 * it last said, and what an ended run did. A unit's terminal is a CLI's screen (Codex, OpenCode or
 * Claude Code), mostly tool calls, spinners and the input box. The owner reads the one sentence the
 * agent last wrote to a person, so that sentence leads and the screen sits behind a click.
 */
import { appName, cap, lensName } from "./live_text";

/** The class a unit kind wears, and the CLI that runs it. Live uses the same names and hues. */
export const CLASS: Record<string, { name: string; engine: string }> = {
  terra: { name: "Terra", engine: "Codex" },
  flash: { name: "Flash", engine: "OpenCode" },
  haiku: { name: "Haiku", engine: "Claude Code" },
  sonnet: { name: "Sonnet", engine: "Claude Code" },
  opus: { name: "Opus", engine: "Claude Code" },
  fable: { name: "Fable", engine: "Claude Code" },
};
export const className = (kind: string): string => CLASS[kind]?.name ?? (kind ? kind[0].toUpperCase() + kind.slice(1) : "Unit");

export type Mission = { title: string; number: number | null; more: number; app: string };

/** What a unit is for: its first issue, else its scout routine, else that it looks for work. */
export function mission(u: { issues: { number: number; title: string }[]; scout?: string; app: string | null }): Mission {
  const scoutApp = u.scout?.split("@")[1] ?? "";
  const app = u.app || scoutApp;
  const first = u.issues[0];
  if (first) {
    // "Tavla iOS: crash…" on a Tavla unit says Tavla twice. The app shows apart, so the title drops
    // it. With no app known the lead stays: "Splash: …" is a topic, not an app.
    const lead = /^([^:]{2,24}):\s+(.+)$/.exec(first.title);
    const platform = lead ? (/\s+(iOS|Android|web)$/i.exec(lead[1])?.[1] ?? "") : "";
    const named = lead ? lead[1].slice(0, lead[1].length - (platform ? platform.length + 1 : 0)) : "";
    const same = !!app && !!named && squash(named) === squash(appName(app));
    const title = same ? (platform ? `${platform}: ${lead![2]}` : cap(lead![2])) : first.title;
    return { title, number: first.number, more: u.issues.length - 1, app: app ? appName(app) : "" };
  }
  if (u.scout) return { title: `${lensName(u.scout)} scout`, number: null, more: 0, app: scoutApp ? appName(scoutApp) : "" };
  return { title: "Looking for work", number: null, more: 0, app: app ? appName(app) : "" };
}

const squash = (s: string): string => s.toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "");

/** Lines a CLI draws around the conversation: its input box, footer, spinners and rulers. */
const CHROME = [
  /^\s*$/,
  /^[\s┃╹▀─━│╭╮╰╯⬝■▪▫•·⎯_=-]+$/,
  /^\s*┃/, // OpenCode's input box
  /esc (to )?interrupt|ctrl\+[a-z] (commands|to )|Press ctrl\+|\? for shortcuts|← for agents|shift\+tab to cycle|auto mode on/i,
  /^\s*›\s/, // Codex's prompt
  /^\s*❯/, // Claude Code's prompt
  /^\s*(GPT|Claude|Opus|Sonnet|Haiku|DeepSeek|Build auto)\b.*·/, // model footers
  /^\s*\S+@\S+:~?\//, // a shell prompt line
];

const isChrome = (line: string): boolean => CHROME.some((re) => re.test(line));

/**
 * The last thing the agent wrote to a person, in one paragraph. Null when the screen holds only
 * tool calls. Each CLI marks a message its own way: Claude Code with ⏺, Codex with •, OpenCode by
 * indenting it. Tool calls start with a verb or a call, and their output hangs under ⎿, └ or │.
 */
export function said(screen: string): string | null {
  // An empty line ends a paragraph, so it stays. The rest of the CLI's drawing goes.
  const lines = screen.split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => !l || !isChrome(l));
  const claude = lines.some((l) => /^⏺ /.test(l));
  const codex = !claude && lines.some((l) => /^• /.test(l));
  // A paragraph: a line that opens one, and the indented lines that carry it on. OpenCode marks
  // nothing, so there a paragraph is the indented lines between two empty ones.
  const paras: string[][] = [];
  for (const line of lines) {
    const last = paras[paras.length - 1];
    const carries = !!last?.length && /^\s{2,}\S/.test(line) && !/^\s*[⎿└│↳]/.test(line);
    const opens = claude ? /^⏺ /.test(line) : codex ? /^[•◦] /.test(line) : !carries && /^ {2,6}\S/.test(line);
    if (opens) paras.push([line]);
    else if (line && carries) last.push(line);
    else if (last?.length !== 0) paras.push([]); // an empty line, tool output or anything else ends it
  }
  for (let i = paras.length - 1; i >= 0; i--) {
    const p = paras[i];
    if (!p.length) continue;
    const text = p.map((l) => l.trim()).join(" ").replace(/^[⏺•◦]\s+/, "").replace(/\s+/g, " ").trim();
    if (TOOL.test(text) || !/^[A-Za-zÇĞİÖŞÜçğıöşü"'“]/.test(text) || text.length < 8) continue;
    return text;
  }
  return null;
}

/** A tool call or a CLI status, not words to a person. Whole words only: "Ready to ship" is prose. */
const TOOL = /^(?:(?:Ran|Explored|Edited|Read|Searched|Called|Updated Plan|Thought for|Allowed by|Waiting for background)\b|(?:Working|Thinking)(?:\s*\(|…|$)|(?:Bash|Read|Edit|Write|Update|Grep|Glob|Task|Agent|Fetch)\(|Shell |\+ ?\d|[⠀-⣿↳]|\(|…)/;

/** The screen as it shows behind the click: no runs of empty lines, no input box at its foot. */
export function tidy(screen: string): string {
  const lines = screen.replace(/\s+$/, "").split("\n");
  // Drop the CLI's footer: everything under the last line a person or the agent wrote.
  let end = lines.length;
  while (end > 0 && isChrome(lines[end - 1])) end--;
  return lines
    .slice(0, end)
    .join("\n")
    .replace(/\n(\s*\n){2,}/g, "\n\n")
    .replace(/^\s*\n/, "");
}

export type Marked = { mark: "" | "b" | "i" | "code"; text: string };

/**
 * The inline marks an agent writes, so its sentence keeps them: **bold**, *italic* and `code`.
 * Underscores stay plain: they are mostly in snake_case names. A lone star is just a star.
 */
export function marks(text: string): Marked[] {
  const out: Marked[] = [];
  let at = 0;
  for (const m of text.matchAll(/\*\*([^*]+)\*\*|`([^`]+)`|(?<![\w*])\*(?!\s)([^*]+?)(?<!\s)\*(?![\w*])/g)) {
    if (m.index > at) out.push({ mark: "", text: text.slice(at, m.index) });
    out.push(m[1] ? { mark: "b", text: m[1] } : m[2] ? { mark: "code", text: m[2] } : { mark: "i", text: m[3] });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ mark: "", text: text.slice(at) });
  return out;
}


/** Minutes as a person reads them: 45 min, 3 h 20 min. */
export function duration(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}
