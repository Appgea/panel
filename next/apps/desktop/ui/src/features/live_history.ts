import type { Step } from "./live_types";

export const RESULTS: Record<string, [string, string]> = {
  test: ["Tests passed", "Tests failed"],
  typecheck: ["Typecheck passed", "Typecheck failed"],
  build: ["Built", "Build failed"],
  "git.commit": ["Committed", "Commit failed"],
  "git.push": ["Pushed", "Push failed"],
  "git.pull": ["Pulled", "Pull failed"],
  release: ["Released", "Release failed"],
  review: ["Review passed", "Review found problems"],
  render: ["Rendered", "Render failed"],
  shot: ["Screenshots taken", "Screenshots failed"],
};
export const RESULT_MS = { ok: 12_000, failed: 60_000 };

const KEPT = new Set([...Object.keys(RESULTS), "message", "spawn", "ask", "board", "publish"]);
const SAID = /^Step \d+ of \d+/i;

export type Row = { atMs: number; text: string; file?: string; mark?: "ok" | "bad"; folded?: boolean };

export function trim(steps: Step[]): Row[] {
  const out: Row[] = [];
  let edits = new Map<string, { row: Row; label: string; n: number }>();
  let fold: { row: Row; read: number; search: number; other: number } | null = null;
  let last: { row: Row; label: string; n: number } | null = null;
  const cut = () => {
    edits = new Map();
    fold = null;
  };
  for (const st of steps) {
    const verb = st.verb ?? "";
    if (verb === "edit" && st.file) {
      const had = edits.get(st.file);
      if (had) {
        had.n++;
        had.row.text = `${had.label} ×${had.n}`;
        continue;
      }
      const row: Row = { atMs: st.atMs, text: st.label, file: st.file };
      edits.set(st.file, { row, label: st.label, n: 1 });
      out.push(row);
      fold = null;
      continue;
    }
    if (KEPT.has(verb) || st.ok === false || st.asks || SAID.test(st.label)) {
      const judged = st.ok !== undefined && (RESULTS[verb] || st.ok === false);
      const mark = judged ? (st.ok ? "ok" : "bad") : undefined;
      const same = last && last.label === st.label && last.row.mark === mark && out[out.length - 1] === last.row;
      if (same && last) {
        last.n++;
        last.row.text = `${last.label} ×${last.n}`;
      } else {
        const row: Row = { atMs: st.atMs, text: st.label, file: st.file, mark };
        last = { row, label: st.label, n: 1 };
        out.push(row);
      }
      cut();
      continue;
    }
    if (!fold) {
      fold = { row: { atMs: st.atMs, text: "", folded: true }, read: 0, search: 0, other: 0 };
      out.push(fold.row);
    }
    if (verb === "read") fold.read++;
    else if (verb === "search") fold.search++;
    else fold.other++;
    fold.row.text = [count(fold.read, "file read", "files read"), count(fold.search, "search", "searches"), count(fold.other, "other step", "other steps")].filter(Boolean).join(", ");
  }
  return out;
}

const count = (n: number, one: string, many: string): string => (n ? `${n} ${n === 1 ? one : many}` : "");
