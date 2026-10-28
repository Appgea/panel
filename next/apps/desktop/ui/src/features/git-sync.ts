/**
 * Pull all / Push all / Sync all — one sweep across every Panel-tracked repository.
 *
 * The portfolio is a dozen repos, and the question "is everything in sync?" used to cost a dozen
 * visits to the Git tab. This is the one place that answers it and then acts on it: scan, show the
 * plan, run it repo by repo, and settle each row with what actually happened.
 *
 * HONEST MOTION. Every moving thing here is bound to a real phase reported by git, not to a timer
 * pretending to be progress. A row's commit beads travel only while that repo's `fetch` / `rebase`
 * (incoming, right to left) or `push` (outgoing, left to right) is running RIGHT NOW, and the hero
 * stream above the list flows the same way for the same reason. The phase word under the name is
 * the module's own progress file, polled while the repo is in flight — so a slow repo looks slow
 * instead of looking finished.
 *
 * SEQUENTIAL ON PURPOSE. Each repo is a separate one-shot subprocess. Running them one at a time
 * costs wall-clock but buys a readable sweep and keeps a credential prompt or a conflict from
 * landing in the middle of four other repos' output.
 *
 * SYNC is both directions in one pass: pull, let the agent CLI resolve a conflict headless, then
 * push. Whatever code could not finish is handed to one agent terminal as a single prompt.
 */

import { moduleGet, modulePost } from "./modules";
import { icon } from "../icons";
import "../motion.css";
import "./git-sync.css";

const M = "/m/git-manager";

export type SweepMode = "pull" | "push" | "sync";

export type SweepOptions = {
  /** Open an agent terminal with this prompt. Without it, leftovers get no hand-off button. */
  fixWithAgent?: (prompt: string) => Promise<void>;
};

type RepoInfo = {
  path: string;
  name: string;
  branch: string;
  remote: string;
  behind?: number;
  ahead?: number;
  dirty?: number;
  hasUpstream?: boolean;
};

/** `count` is behind (pull) or ahead (push); -1 means "never pushed — unknown, but send it". */
type Row = {
  info: RepoInfo;
  count: number;
  node: HTMLElement;
  phase: HTMLElement;
  note: HTMLElement;
  fix: HTMLElement;
  state: RowState;
};

type RowState = "wait" | "queued" | "active" | "done" | "conflict" | "failed" | "insync";

type PullResult = {
  ok?: boolean;
  pulled?: boolean;
  conflict?: boolean;
  conflicts?: string[];
  error?: string;
};
type PushResult = { ok?: boolean; pushed?: boolean; rejected?: boolean; error?: string };

const esc = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      (({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }) as Record<
        string,
        string
      >)[c] ?? c,
  );

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

/** git's own words, shortened to something readable at a glance in a row. */
const PHASE_COPY: Record<string, string> = {
  fetching: "fetching",
  rebasing: "rebasing",
  pushing: "pushing",
  resolving: "agent resolving",
  done: "done",
  failed: "failed",
  conflict: "conflicted",
};

/** Which way a phase moves commits. Drives the beads and the hero stream. */
const FLOW: Record<string, "in" | "out"> = {
  fetching: "in",
  rebasing: "in",
  "agent resolving": "in",
  pushing: "out",
};

const COPY = {
  pull: {
    title: "Pull all",
    lede: "Every tracked repository, rebased onto its remote.",
    verb: "Pull",
    running: "Pulling",
    done: "pulled",
    nothing: "Nothing to pull — every repository already has its remote's history.",
    unit: "behind",
  },
  push: {
    title: "Push all",
    lede: "Every tracked repository's unsent commits, sent to its remote.",
    verb: "Push",
    running: "Pushing",
    done: "pushed",
    nothing: "Nothing to push — no repository is carrying unsent commits.",
    unit: "ahead",
  },
  sync: {
    title: "Sync all",
    lede: "Every tracked repository pulled from its remote, then pushed back.",
    verb: "Sync",
    running: "Syncing",
    done: "synced",
    nothing: "Nothing to sync — every repository matches its remote.",
    unit: "out of sync",
  },
} as const;

/* The hero's two ends. Drawn here, not in the icon set: nothing else needs a laptop or a cloud. */
const LOCAL_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="11" rx="1.6"/><path d="M2.5 19h19"/></svg>`;
const REMOTE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18.5h10.2a4.3 4.3 0 0 0 .6-8.56A6 6 0 0 0 6.3 9.1 4.7 4.7 0 0 0 7 18.5z"/></svg>`;

/** Beads drawn per row, per direction. Past this the row says "+n" instead of crowding. */
const MAX_BEADS = 6;

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Open the sweep. Resolves when the panel closes, carrying how many repos actually moved — the
 * caller uses that to decide whether the dashboard's numbers are stale.
 */
export function openGitSweep(mode: SweepMode, options: SweepOptions = {}): Promise<number> {
  return new Promise((resolve) => {
    const copy = COPY[mode];
    let rows: Row[] = [];
    let running = false;
    let changed = 0;
    let closed = false;
    let drawn = false;

    /* ------------------------------------------------------------------ shell */

    const wrap = document.createElement("div");
    wrap.className = "gs-wrap";
    wrap.dataset.mode = mode;
    wrap.dataset.stage = "scan";
    wrap.innerHTML = `
      <section class="gs-card mo-rise" role="dialog" aria-modal="true" aria-label="${copy.title}">
        <header class="gs-head">
          <span class="gs-ico" aria-hidden="true">${icon("git")}</span>
          <div class="gs-title">
            <strong>${copy.title}</strong>
            <small>${copy.lede}</small>
          </div>
          <button class="gs-close" type="button" title="Close" aria-label="Close">✕</button>
        </header>
        <div class="gs-hero" aria-hidden="true">
          <div class="gs-lanes">
            <div class="gs-lane is-out">${"<i></i>".repeat(6)}</div>
            <div class="gs-lane is-in">${"<i></i>".repeat(6)}</div>
          </div>
          <div class="gs-end is-local">
            <span class="gs-end-ico">${LOCAL_SVG}</span>
            <div class="gs-end-copy"><b>This Mac</b><small class="gs-out-n">&nbsp;</small></div>
          </div>
          <div class="gs-dial">
            <svg viewBox="0 0 80 80">
              <circle class="gs-dial-track" cx="40" cy="40" r="35" />
              <circle class="gs-dial-fill" cx="40" cy="40" r="35" pathLength="100" />
              <circle class="gs-dial-stuck" cx="40" cy="40" r="35" pathLength="100" />
            </svg>
            <strong class="gs-big">…</strong>
          </div>
          <div class="gs-end is-remote">
            <span class="gs-end-ico">${REMOTE_SVG}</span>
            <div class="gs-end-copy"><b>Remotes</b><small class="gs-in-n">&nbsp;</small></div>
          </div>
          <small class="gs-big-sub">reading repositories</small>
        </div>
        <div class="gs-list" role="list">${'<div class="gs-skel"><i></i><b></b><span></span><em></em></div>'.repeat(4)}</div>
        <div class="gs-handoff" hidden></div>
        <footer class="gs-foot">
          <div class="gs-summary">Scanning repositories…</div>
          <div class="gs-acts">
            <button class="gs-btn gs-go" type="button" disabled>Scanning…</button>
          </div>
        </footer>
      </section>`;

    const card = wrap.querySelector<HTMLElement>(".gs-card")!;
    const list = wrap.querySelector<HTMLElement>(".gs-list")!;
    const summary = wrap.querySelector<HTMLElement>(".gs-summary")!;
    const acts = wrap.querySelector<HTMLElement>(".gs-acts")!;
    const go = wrap.querySelector<HTMLButtonElement>(".gs-go")!;
    const closeBtn = wrap.querySelector<HTMLButtonElement>(".gs-close")!;
    const handoff = wrap.querySelector<HTMLElement>(".gs-handoff")!;
    const big = wrap.querySelector<HTMLElement>(".gs-big")!;
    const bigSub = wrap.querySelector<HTMLElement>(".gs-big-sub")!;
    const outN = wrap.querySelector<HTMLElement>(".gs-out-n")!;
    const inN = wrap.querySelector<HTMLElement>(".gs-in-n")!;
    const dialFill = wrap.querySelector<SVGCircleElement>(".gs-dial-fill")!;
    const dialStuck = wrap.querySelector<SVGCircleElement>(".gs-dial-stuck")!;

    const close = (): void => {
      if (running || closed) return;
      closed = true;
      document.removeEventListener("keydown", onKey, true);
      card.classList.add("is-leaving");
      setTimeout(() => wrap.remove(), 140);
      resolve(changed);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener("keydown", onKey, true);
    closeBtn.addEventListener("click", close);
    wrap.addEventListener("mousedown", (event) => {
      if (event.target === wrap) close();
    });
    document.body.append(wrap);

    /* ------------------------------------------------------------------- hero */

    /** Commits each direction still has to travel, from what the rows say right now. */
    function tally(): { incoming: number; outgoing: number } {
      let incoming = 0;
      let outgoing = 0;
      for (const row of rows) {
        if (row.state === "done" || row.state === "insync") continue;
        if (mode !== "push") incoming += row.info.behind ?? 0;
        if (mode !== "pull") {
          const ahead = row.info.ahead ?? 0;
          outgoing += ahead < 0 ? 1 : ahead;
        }
      }
      return { incoming, outgoing };
    }

    /** The dial's number flips in place when it changes, so a settled repo is felt, not read. */
    let shown = "";
    function setBig(text: string, sub: string): void {
      bigSub.textContent = sub;
      if (text === shown) return;
      shown = text;
      big.textContent = text;
      big.classList.remove("is-tick");
      void big.offsetWidth;
      big.classList.add("is-tick");
    }

    function paintHero(): void {
      const { incoming, outgoing } = tally();
      outN.textContent = mode === "pull" ? "local clones" : outgoing ? `↑ ${plural(outgoing, "commit")} to send` : "nothing to send";
      inN.textContent = mode === "push" ? "remote copies" : incoming ? `↓ ${plural(incoming, "commit")} waiting` : "nothing waiting";
      const moving = rows.filter((row) => row.state !== "insync");
      const settled = moving.filter((row) => row.state === "done").length;
      const stuck = moving.filter((row) => row.state === "failed" || row.state === "conflict").length;
      const stage = wrap.dataset.stage;
      // The dial is the sweep's one progress meter. Settled repos fill it in green; a repo that
      // could not finish takes its own red arc, so a 4-of-5 sweep never draws a closed ring.
      const whole = moving.length || 1;
      const ok = stage === "done" && !moving.length ? 100 : (settled / whole) * 100;
      const bad = (stuck / whole) * 100;
      // A 0.01 dash still paints a round cap, so an empty arc is hidden rather than drawn tiny.
      dialFill.style.strokeDasharray = `${ok} 100`;
      dialFill.style.opacity = ok > 0 ? "1" : "0";
      dialStuck.style.strokeDasharray = `${bad} 100`;
      dialStuck.style.strokeDashoffset = String(-ok);
      dialStuck.style.opacity = bad > 0 ? "1" : "0";
      if (stage === "scan") return;
      if (stage === "plan") {
        if (!moving.length) return setBig("✓", "already in sync");
        return setBig(
          String(moving.length),
          mode === "sync" ? (moving.length === 1 ? "repository to sync" : "repositories to sync") : `to ${mode}`,
        );
      }
      if (stage === "run") {
        const active = rows.find((row) => row.state === "active");
        return setBig(`${Math.min(settled + stuck + 1, moving.length)}/${moving.length}`, active ? active.info.name : "");
      }
      setBig(
        stuck ? `${settled}/${moving.length}` : "✓",
        stuck ? `${copy.done} · ${stuck} need${stuck === 1 ? "s" : ""} you` : `all ${copy.done}`,
      );
      wrap.dataset.outcome = stuck ? "stuck" : "clean";
    }

    /* ------------------------------------------------------------------- rows */

    function setState(row: Row, state: RowState): void {
      row.state = state;
      row.node.dataset.state = state;
      if (state !== "active") row.node.dataset.flow = "";
    }

    const beads = (count: number, dir: "in" | "out"): string => {
      if (!count) return "";
      const n = Math.min(count < 0 ? 1 : count, MAX_BEADS);
      const dots = Array.from({ length: n }, (_, i) => `<i style="--i:${i};--n:${n}"></i>`).join("");
      const more = count > MAX_BEADS ? `<em style="--n:${n}">+${count - MAX_BEADS}</em>` : "";
      return `<span class="gs-beads is-${dir}">${dots}${more}</span>`;
    };

    function makeRow(info: RepoInfo, count: number, index: number): Row {
      const node = document.createElement("div");
      // Rows rise in once. A redraw with fresher counts (pull's live fetch) must not replay it.
      node.className = drawn ? "gs-row" : "gs-row mo-rise";
      node.style.setProperty("--mo-delay", `${Math.min(index, 12) * 32}ms`);
      node.setAttribute("role", "listitem");
      const ahead = info.ahead ?? 0;
      const behind = info.behind ?? 0;
      // The plan badge wears the bead colours: incoming blue, outgoing green.
      const arrows = [
        mode !== "push" && behind ? `<span class="d-in">↓${behind}</span>` : "",
        mode !== "pull" && ahead ? `<span class="d-out">${ahead < 0 ? "first push" : `↑${ahead}`}</span>` : "",
      ].filter(Boolean);
      const badge = arrows.join(" ") || "in sync";
      node.innerHTML = `
        <span class="gs-mark" aria-hidden="true"></span>
        <div class="gs-id">
          <b>${esc(info.name)}</b>
          <small class="mono">${icon("branch")}${esc(info.branch)}<span>→ ${esc(info.remote)}</span></small>
        </div>
        <div class="gs-track" aria-hidden="true">
          <span class="gs-rail"></span>
          ${mode !== "pull" ? beads(ahead, "out") : ""}
          ${mode !== "push" ? beads(behind, "in") : ""}
        </div>
        <div class="gs-status">
          <span class="gs-phase">${badge}</span>
          <small class="gs-note"></small>
        </div>
        <div class="gs-fix"></div>`;
      list.append(node);
      return {
        info,
        count,
        node,
        phase: node.querySelector<HTMLElement>(".gs-phase")!,
        note: node.querySelector<HTMLElement>(".gs-note")!,
        fix: node.querySelector<HTMLElement>(".gs-fix")!,
        state: "wait",
      };
    }

    /**
     * An in-sync repo is a fact, not a task. It gets a chip in one quiet cloud under the list, so
     * thirty repos with five to move read as five rows. The chip still carries a Row so the
     * leftovers and tallies see it like any other.
     */
    function makeChip(info: RepoInfo, shelf: HTMLElement): Row {
      const node = document.createElement("span");
      node.className = "gs-chip";
      node.title = info.dirty ? `${info.path} · ${plural(info.dirty, "file")} uncommitted` : info.path;
      node.innerHTML = `${esc(info.name)}${info.dirty && mode === "sync" ? `<i>${info.dirty}</i>` : ""}<span hidden></span><small hidden></small><div hidden></div>`;
      shelf.append(node);
      return {
        info,
        count: 0,
        node,
        phase: node.querySelector<HTMLElement>("span")!,
        note: node.querySelector<HTMLElement>("small")!,
        fix: node.querySelector<HTMLElement>("div")!,
        state: "insync",
      };
    }

    function paintRow(row: Row, phase: string, note = ""): void {
      row.phase.textContent = phase;
      row.note.textContent = note;
      row.note.title = note;
      if (row.state === "active") {
        const flow = FLOW[phase] ?? "";
        row.node.dataset.flow = flow;
        wrap.dataset.flow = flow;
      }
    }

    /* ------------------------------------------------------------------ scan */

    const listPath = (fetch: boolean): string =>
      mode === "pull"
        ? `${M}/pullable?fetch=${fetch ? 1 : 0}`
        : `${M}/pushable?fetch=${fetch ? 1 : 0}`;

    /** Sync counts both ways. A never-pushed branch (-1) still counts as one thing to send. */
    const countOf = (info: RepoInfo): number =>
      mode === "pull"
        ? (info.behind ?? 0)
        : mode === "push"
          ? (info.ahead ?? 0)
          : (info.behind ?? 0) + ((info.ahead ?? 0) < 0 ? 1 : (info.ahead ?? 0));

    async function scan(): Promise<void> {
      let seen: RepoInfo[] = [];
      if (mode === "sync") {
        // One live scan: both counts only mean something against a freshly fetched remote.
        wrap.classList.add("is-scanning");
        summary.textContent = "Refreshing remotes…";
        try {
          const live = await moduleGet<{ syncable?: RepoInfo[] }>(`${M}/syncable`);
          if (closed) return;
          draw(live.syncable ?? []);
        } catch (error) {
          summary.textContent = `Could not read the project list. ${String(error)}`;
          go.hidden = true;
          return;
        } finally {
          wrap.classList.remove("is-scanning");
        }
        armGo();
        return;
      }
      // Two-stage on pull: the cached counts land instantly so the panel has something true to
      // show, then the fetched counts replace them. Push needs no network to know what it holds.
      try {
        const first = await moduleGet<{ pullable?: RepoInfo[]; pushable?: RepoInfo[] }>(
          listPath(false),
        );
        seen = first.pullable ?? first.pushable ?? [];
      } catch (error) {
        summary.textContent = `Could not read the project list. ${String(error)}`;
        go.hidden = true;
        return;
      }
      draw(seen);

      if (mode === "pull") {
        wrap.classList.add("is-scanning");
        summary.textContent = "Refreshing remotes…";
        try {
          const live = await moduleGet<{ pullable?: RepoInfo[] }>(listPath(true));
          if (closed) return;
          draw(live.pullable ?? seen);
        } catch {
          // offline or auth-blocked: the cached counts stay, and the summary says so
          summary.textContent = "Remotes could not be refreshed — showing last known counts.";
        }
        wrap.classList.remove("is-scanning");
      }
      armGo();
    }

    function draw(infos: RepoInfo[]): void {
      const ordered = [...infos].sort((a, b) => {
        const diff = Math.abs(countOf(b)) - Math.abs(countOf(a));
        return diff || a.name.localeCompare(b.name);
      });
      list.replaceChildren();
      const moving = ordered.filter((info) => countOf(info) !== 0);
      const quiet = ordered.filter((info) => countOf(info) === 0);
      rows = moving.map((info, index) => {
        const row = makeRow(info, countOf(info), index);
        setState(row, "wait");
        return row;
      });
      if (quiet.length) {
        const shelf = document.createElement("div");
        shelf.className = drawn ? "gs-shelf" : "gs-shelf mo-rise";
        shelf.style.setProperty("--mo-delay", `${Math.min(moving.length, 12) * 32 + 40}ms`);
        shelf.innerHTML = `<label>${icon("git")}<span>Already in sync · ${quiet.length}</span></label><div class="gs-chips"></div>`;
        const chips = shelf.querySelector<HTMLElement>(".gs-chips")!;
        list.append(shelf);
        rows.push(...quiet.map((info) => makeChip(info, chips)));
      }
      wrap.dataset.stage = "plan";
      drawn = true;
      paintHero();
    }

    const pending = (): Row[] => rows.filter((row) => row.count !== 0);

    function armGo(): void {
      const todo = pending();
      const insync = rows.length - todo.length;
      if (!rows.length) {
        summary.textContent = "No tracked repository has a remote to sync with.";
        go.hidden = true;
        setBig("—", "no remotes");
        return;
      }
      if (!todo.length) {
        go.hidden = true;
        settle();
        summary.textContent = copy.nothing;
        return;
      }
      const total = todo.reduce((sum, row) => sum + Math.max(row.count, 1), 0);
      summary.innerHTML = `<b>${plural(todo.length, "repository", "repositories")}</b> · ${plural(
        total,
        "commit",
      )} to move${insync ? ` · ${insync} already in sync` : ""}`;
      go.disabled = false;
      go.innerHTML = `<span>${copy.verb} ${plural(todo.length, "repository", "repositories")}</span><kbd>↵</kbd>`;
      go.focus();
    }

    /* -------------------------------------------------------------- the sweep */

    /** Poll the module's progress file so a row says what git is doing, not what we hope it is. */
    function watch(row: Row): () => void {
      let alive = true;
      const tick = async (): Promise<void> => {
        while (alive) {
          try {
            const state = await moduleGet<{ phase?: string; note?: string }>(
              `${M}/${mode}/progress?repo=${encodeURIComponent(row.info.path)}`,
            );
            if (!alive) return;
            const phase = state.phase ?? "";
            if (phase && phase !== "done" && phase !== "failed") {
              paintRow(row, PHASE_COPY[phase] ?? phase, state.note ?? "");
            }
          } catch {
            /* progress is a nicety — never let it break the sweep */
          }
          await sleep(450);
        }
      };
      void tick();
      return () => {
        alive = false;
      };
    }

    /** One repo, one direction. Also the retry path, so a failed row is never a dead end. */
    async function runRepo(row: Row): Promise<void> {
      setState(row, "active");
      row.fix.replaceChildren();
      row.node.scrollIntoView({ block: "nearest", behavior: "smooth" });
      paintRow(row, mode === "push" ? "pushing" : row.info.behind || mode === "pull" ? "fetching" : "pushing");
      paintHero();
      const stop = watch(row);
      try {
        if (mode === "sync") {
          await syncRepo(row);
        } else if (mode === "pull") {
          const result = await modulePost<PullResult>(`${M}/pull`, {
            repo: row.info.path,
            remote: row.info.remote,
            branch: row.info.branch,
          });
          if (result.conflict) {
            setState(row, "conflict");
            paintRow(
              row,
              "conflicted",
              `${plural(result.conflicts?.length ?? 0, "file")} need resolving`,
            );
            offerFix(row);
          } else if (result.error) {
            setState(row, "failed");
            paintRow(row, "failed", result.error);
            offerRetry(row);
          } else {
            setState(row, "done");
            paintRow(row, `↓${row.count} ${copy.done}`);
            changed += 1;
          }
        } else {
          const result = await modulePost<PushResult>(`${M}/push`, {
            repo: row.info.path,
            remote: row.info.remote,
            branch: row.info.branch,
            smart: true,
          });
          if (result.error) {
            setState(row, "failed");
            paintRow(
              row,
              "failed",
              result.rejected ? "the remote moved on — pull this repo first" : result.error,
            );
            offerRetry(row, Boolean(result.rejected));
          } else {
            setState(row, "done");
            paintRow(
              row,
              row.count < 0 ? copy.done : `↑${row.count} ${copy.done}`,
              row.info.dirty ? `${plural(row.info.dirty, "file")} still uncommitted` : "",
            );
            changed += 1;
          }
        }
      } catch (error) {
        setState(row, "failed");
        paintRow(row, "failed", String(error).replace(/^Error:\s*/, ""));
        offerRetry(row);
      } finally {
        stop();
        wrap.dataset.flow = "";
        paintHero();
      }
    }

    /**
     * Sync one repo: pull if the remote moved, let the agent resolve a conflict headless, then
     * push what is ahead. Every stop is a settled row with a reason, never a half-run.
     */
    async function syncRepo(row: Row): Promise<void> {
      const fail = (note: string): void => {
        setState(row, "failed");
        paintRow(row, "failed", note);
        offerRetry(row);
      };
      let resolved = 0;
      if (row.info.behind) {
        const pulled = await modulePost<PullResult>(`${M}/pull`, {
          repo: row.info.path,
          remote: row.info.remote,
          branch: row.info.branch,
        });
        if (pulled.conflict) {
          paintRow(row, "agent resolving", `${plural(pulled.conflicts?.length ?? 0, "file")} conflicted`);
          const fixed = await modulePost<{ ok?: boolean; files?: string[]; error?: string }>(
            `${M}/pull/resolve`,
            { repo: row.info.path },
          );
          if (fixed.error) return fail(fixed.error);
          resolved = fixed.files?.length ?? 0;
        } else if (pulled.error) {
          return fail(pulled.error);
        }
        // The incoming half has landed: its beads leave the rail and the hero stops counting them.
        row.info.behind = 0;
        row.node.querySelector(".gs-beads.is-in")?.classList.add("is-landed");
        paintHero();
      }
      if (row.info.ahead) {
        paintRow(row, "pushing");
        const pushed = await modulePost<PushResult>(`${M}/push`, {
          repo: row.info.path,
          remote: row.info.remote,
          branch: row.info.branch,
          smart: true,
        });
        if (pushed.error) {
          return fail(pushed.rejected ? "the remote moved on again — push was refused" : pushed.error);
        }
      }
      setState(row, "done");
      const notes = [
        resolved ? `AI resolved ${plural(resolved, "file")}` : "",
        row.info.dirty ? `${plural(row.info.dirty, "file")} still uncommitted` : "",
      ].filter(Boolean);
      paintRow(row, copy.done, notes.join(" · "));
      changed += 1;
    }

    /** A push the remote refused is not a failure to shrug at — it is one pull away from working. */
    async function pullThenPush(row: Row): Promise<void> {
      setState(row, "active");
      row.fix.replaceChildren();
      paintRow(row, "fetching");
      const stop = watch(row);
      try {
        const result = await modulePost<PullResult>(`${M}/pull`, {
          repo: row.info.path,
          remote: row.info.remote,
          branch: row.info.branch,
        });
        if (result.conflict) {
          setState(row, "conflict");
          paintRow(row, "conflicted", `${plural(result.conflicts?.length ?? 0, "file")} need resolving`);
          offerFix(row);
          return;
        }
        if (result.error) {
          setState(row, "failed");
          paintRow(row, "failed", result.error);
          offerRetry(row);
          return;
        }
      } catch (error) {
        setState(row, "failed");
        paintRow(row, "failed", String(error).replace(/^Error:\s*/, ""));
        offerRetry(row);
        return;
      } finally {
        stop();
      }
      await runRepo(row);
      retally();
    }

    async function sweep(): Promise<void> {
      const todo = pending();
      running = true;
      wrap.dataset.stage = "run";
      wrap.classList.add("is-running");
      go.disabled = true;
      closeBtn.disabled = true;
      go.innerHTML = `<span class="gs-spin" aria-hidden="true"></span><span>${copy.running}…</span>`;
      todo.forEach((row) => {
        setState(row, "queued");
        paintRow(row, "queued");
      });

      for (const row of todo) await runRepo(row);

      running = false;
      wrap.classList.remove("is-running");
      closeBtn.disabled = false;
      settle();
    }

    /** The footer, recomputed from what the rows actually say — retries and resolves keep it true. */
    function retally(): void {
      const count = (state: RowState): number => rows.filter((row) => row.state === state).length;
      const parts = [`<b class="ok">${count("done")} ${copy.done}</b>`];
      if (count("conflict")) parts.push(`<b class="warn">${count("conflict")} conflicted</b>`);
      if (count("failed")) parts.push(`<b class="risk">${count("failed")} failed</b>`);
      if (wrap.dataset.stage === "done") summary.innerHTML = parts.join(" · ");
      paintHero();
      if (!running && go.hidden) offerAgent();
    }

    function settle(): void {
      wrap.dataset.stage = "done";
      retally();
      go.hidden = true;
      acts.querySelector(".gs-resolve-all")?.remove();
      acts.querySelector(".gs-done")?.remove();
      if (rows.filter((row) => row.state === "conflict").length > 1) {
        const all = document.createElement("button");
        all.className = "gs-btn gs-resolve-all";
        all.type = "button";
        all.innerHTML = `${icon("agent")}<span>Resolve all with AI</span>`;
        all.addEventListener("click", () => void resolveAll());
        acts.prepend(all);
      }
      offerAgent();
      const done = document.createElement("button");
      done.className = "gs-btn gs-done";
      done.type = "button";
      done.textContent = "Close";
      done.addEventListener("click", close);
      acts.append(done);
      done.focus();
    }

    /* ------------------------------------------------------------ agent hand-off */

    /** What code could not finish: failed or conflicted rows, plus, on sync, uncommitted work. */
    function leftovers(): Array<{ row: Row; why: string }> {
      return rows.flatMap((row) => {
        if (row.state === "failed" || row.state === "conflict") {
          const why = (row.note.textContent || row.phase.textContent || "failed").split("\n")[0];
          return [{ row, why: `${row.state}: ${why.slice(0, 200)}` }];
        }
        if (mode === "sync" && row.info.dirty) {
          return [{ row, why: `${plural(row.info.dirty, "file")} uncommitted` }];
        }
        return [];
      });
    }

    function agentPrompt(items: Array<{ row: Row; why: string }>): string {
      return [
        `Finish syncing ${plural(items.length, "git repository", "git repositories")} with their remotes. Panel's ${copy.title} could not finish these:`,
        ...items.map(
          ({ row, why }) =>
            `- ${row.info.path} (branch ${row.info.branch}, remote ${row.info.remote}): ${why}`,
        ),
        "For each one: if a rebase is already in progress, finish it. Otherwise pull with rebase, resolve any conflict by combining both sides' intent, run the most relevant quick checks, then push.",
        "Uncommitted changes: inspect the diff, commit them with one clear message only if they are clearly finished work, then push.",
        "Never force-push. Never discard work. If you find secrets, a conflict you cannot judge, or failing checks, leave that repo untouched, note why, and move on.",
        "At the end, list every repository with its final state.",
      ].join("\n");
    }

    /**
     * The end of a sweep that could not finish everything is not an error list — it is one card
     * with the names on it and one button that hands all of them to an agent terminal.
     */
    function offerAgent(): void {
      const items = leftovers();
      if (!items.length || !options.fixWithAgent) {
        handoff.hidden = true;
        handoff.replaceChildren();
        return;
      }
      const failed = items.filter(({ row }) => row.state === "failed" || row.state === "conflict").length;
      const dirty = items.length - failed;
      const why = [
        failed ? `${failed} could not finish` : "",
        dirty ? `${dirty} ${dirty === 1 ? "has" : "have"} uncommitted work` : "",
      ].filter(Boolean).join(" · ");
      const names = items.slice(0, 6).map(({ row }) => `<span>${esc(row.info.name)}</span>`).join("");
      const more = items.length > 6 ? `<span class="more">+${items.length - 6}</span>` : "";
      const fresh = handoff.hidden === true;
      handoff.hidden = false;
      handoff.classList.toggle("mo-rise", fresh);
      handoff.innerHTML = `
        <span class="gs-handoff-ico" aria-hidden="true">${icon("terminal")}</span>
        <div class="gs-handoff-copy">
          <b>${plural(items.length, "repository needs", "repositories need")} a hand</b>
          <small>${why}. Claude opens in a terminal with each one and what went wrong.</small>
          <div class="gs-handoff-names">${names}${more}</div>
        </div>
        <button class="gs-btn gs-agent" type="button">${icon("agent")}<span>Fix in terminal</span><kbd>→</kbd></button>`;
      handoff.querySelector("button")!.addEventListener("click", () => {
        const prompt = agentPrompt(leftovers());
        close();
        void options.fixWithAgent?.(prompt);
      });
    }

    /* --------------------------------------------------------------- conflicts */

    /**
     * A settled row always offers its way out. A plain failure gets "Try again"; a push the
     * remote refused gets the actual fix — pull that repo, then send it — because telling someone
     * what went wrong and making them go do it elsewhere is the dead end this panel exists to kill.
     */
    function offerRetry(row: Row, rejected = false): void {
      row.fix.innerHTML = `<button class="gs-mini ghost" type="button">${
        rejected ? "Pull, then push" : "Try again"
      }</button>`;
      row.fix.querySelector("button")!.addEventListener("click", () => {
        if (rejected) return void pullThenPush(row);
        void runRepo(row).then(retally);
      });
    }

    function offerFix(row: Row): void {
      row.fix.innerHTML = `
        <button class="gs-mini" type="button" data-fix="ai">Resolve with AI</button>
        <button class="gs-mini ghost" type="button" data-fix="abort">Leave it</button>`;
      row.fix.querySelector('[data-fix="ai"]')!.addEventListener("click", () => void resolveOne(row));
      row.fix
        .querySelector('[data-fix="abort"]')!
        .addEventListener("click", () => void abort(row));
    }

    async function resolveOne(row: Row): Promise<void> {
      row.fix.replaceChildren();
      setState(row, "active");
      paintRow(row, "agent resolving");
      const stop = watch(row);
      try {
        const result = await modulePost<{ ok?: boolean; files?: string[]; error?: string }>(
          `${M}/pull/resolve`,
          { repo: row.info.path },
        );
        if (result.error) {
          setState(row, "failed");
          paintRow(row, "failed", result.error);
        } else {
          setState(row, "done");
          paintRow(row, `↓${row.count} pulled`, `AI resolved ${plural(result.files?.length ?? 0, "file")}`);
          changed += 1;
        }
      } catch (error) {
        setState(row, "failed");
        paintRow(row, "failed", String(error));
        offerRetry(row);
      } finally {
        stop();
        wrap.dataset.flow = "";
        retally();
      }
    }

    async function resolveAll(): Promise<void> {
      const stuck = rows.filter((row) => row.state === "conflict");
      if (!stuck.length) return;
      acts.querySelector(".gs-resolve-all")?.remove();
      const stops = stuck.map((row) => {
        row.fix.replaceChildren();
        setState(row, "active");
        paintRow(row, "agent resolving");
        return watch(row);
      });
      try {
        const result = await modulePost<{
          results?: Array<{ repo: string; ok?: boolean; error?: string; files?: string[] }>;
        }>(`${M}/pull/resolve-all`, { repos: stuck.map((row) => row.info.path) });
        for (const row of stuck) {
          const own = (result.results ?? []).find((entry) => entry.repo === row.info.path);
          if (own?.ok) {
            setState(row, "done");
            paintRow(row, `↓${row.count} pulled`, `AI resolved ${plural(own.files?.length ?? 0, "file")}`);
            changed += 1;
          } else {
            setState(row, "failed");
            paintRow(row, "failed", own?.error ?? "could not be resolved — left untouched");
          }
        }
      } catch (error) {
        stuck.forEach((row) => {
          setState(row, "failed");
          paintRow(row, "failed", String(error));
        });
      } finally {
        stops.forEach((stop) => stop());
        wrap.dataset.flow = "";
        retally();
      }
    }

    async function abort(row: Row): Promise<void> {
      row.fix.replaceChildren();
      try {
        await modulePost(`${M}/pull/abort`, { repo: row.info.path });
        setState(row, "wait");
        paintRow(row, "left alone", "rebase aborted — the repo is back where it was");
        offerRetry(row);
      } catch (error) {
        setState(row, "failed");
        paintRow(row, "failed", String(error));
        offerRetry(row);
      }
      retally();
    }

    go.addEventListener("click", () => void sweep());
    void scan();
  });
}
