/**
 * The words in the base: This Mac, its heat and CPU, the testlock bays and who holds them, and
 * processes left behind. Copied from `drawBase` in the concept page, lines 919 to 937. Bevy draws
 * the base box and the bay boxes.
 */

import type { Layout } from "./live_layout";
import { div, holdButton, placeAt, plural, span } from "./live_text";
import type { LiveCtx } from "./live_types";
import "./live_mac.css";

export function paintMac(ctx: LiveCtx, l: Layout, stopPid: (pid: number, who: string) => void): HTMLElement[] {
  const m = ctx.s.world!.mac;
  const b = l.base;
  const out: HTMLElement[] = [];
  const at = (el: HTMLElement, x: number, y: number) => {
    placeAt(el, x, y);
    out.push(el);
    return el;
  };
  at(div("live-mac-name", "This Mac"), b.x + 14, b.y + 11);
  const share = m.cores ? Math.min(1, m.load / m.cores) : 0;
  const cpu = Math.round(share * 100);
  const heat = div(`live-mac-line${m.hot ? " is-hot" : ""}`, `Heat: ${m.hot ? "hot" : "cool"}`);
  const cx = l.wide ? b.x + 120 : b.x + 190;
  if (l.wide) at(heat, b.x + 14, b.y + 31);
  else at(heat, b.x + 84, b.y + 13);
  at(div("live-mac-line", `CPU ${cpu}%`), cx, b.y + 13);
  const bar = at(div("live-meter"), cx, b.y + 32);
  const fill = div(`live-meter-fill${share > 0.75 ? " is-hot" : ""}`);
  fill.style.width = `${Math.max(4, cpu)}%`;
  bar.append(fill);
  l.bays.forEach((bay, i) => {
    const hold = m.bays[i];
    const owner = ctx.agentById(hold?.agent ?? null);
    const box = div(`live-bay${hold?.holder ? " is-held" : ""}`);
    placeAt(box, bay.x, bay.y, bay.w, bay.h);
    box.append(span("live-bay-name", `testlock bay ${i + 1}`), span("live-bay-who", hold?.holder ? [owner ? ctx.nameOf(owner) : "", hold.holder].filter(Boolean).join(" · ") : "Free"));
    out.push(box);
  });
  // Wide: each harness's week at the right end, as the concept draws it.
  const quota = l.wide ? (m.quota ?? []).slice(0, 2) : [];
  const qx = b.x + b.w - 190;
  quota.forEach((q, i) => {
    const used = Math.round(Math.min(99, q.used));
    const y = b.y + 13 + i * 20;
    at(div("live-mac-line", `${q.harness} week ${used}%`), qx, y);
    const bar = at(div("live-meter is-short"), qx + 120, y + 4);
    const fill = div("live-meter-fill");
    fill.style.width = `${Math.max(4, used)}%`;
    bar.append(fill);
  });
  const left = ctx.s.world!.jobs.filter((j) => j.kind === "left");
  if (left.length) {
    const procs = left.reduce((n, j) => n + j.procs, 0);
    const line = div("live-left");
    const names = left.map((j) => j.label).join(", ");
    line.append(span("live-left-text", `Left behind: ${names} · ${procs} ${plural(procs, "process", "processes")}`));
    line.append(holdButton("Hold to Stop", () => left.forEach((j) => stopPid(j.pid, j.label))));
    // Between the bays and the quota on a wide stage. Narrow: right of the CPU bar, above the bays.
    const bays = l.bays[l.bays.length - 1];
    const x = l.wide ? bays.x + bays.w + 16 : b.x + 300;
    const end = l.wide ? (quota.length ? qx - 16 : b.x + b.w - 14) : b.x + b.w - 14;
    placeAt(line, x, b.y + 9, Math.max(110, end - x));
    out.push(line);
  }
  return out;
}
