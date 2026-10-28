/**
 * The portfolio's pulse: the slow facts the sidebar draws on every row.
 *
 * Git status, two weeks of commits, the app's portfolio status and its analytics call. Each is
 * fetched on its own clock, cached here, and read synchronously by the rail. A fetch that lands
 * calls `changed()`, and the rail repaints once for the whole batch.
 *
 * Home's cards read git through `git()` too, so one snapshot serves both surfaces.
 */

import { invoke } from "@tauri-apps/api/core";
import type { GitState } from "../types";
import { moduleGet } from "./modules";

export type Standing = { project: string; key: string; status: string; notes: string };
export type Activity = { last_commit: number; days: number[] };

/** The analytics module's verdict for one app, already mapped to a project. */
export type Verdict = { label: string; call: string; trend: number | null; risk: boolean };

type AnalyticsRow = {
  app: string;
  call: string;
  trend_wow: number | null;
  state: { label: string; tone: string };
};

/** The rail is always on screen, so a minute would mean a git process per project per minute. */
const GIT_TTL = 120_000;
const ACTIVITY_TTL = 10 * 60_000;
const ANALYTICS_TTL = 30 * 60_000;
/** Git spawns a process per read. Three at a time keeps a 30-project boot off the CPU's back. */
const MAX_IN_FLIGHT = 3;

type Entry<T> = { value: T | null; at: number; pending: Promise<T | null> | null };

export type PulseHandle = {
  git(id: string): Promise<GitState | null>;
  peekGit(id: string): GitState | null;
  peekActivity(id: string): Activity | null;
  /** Two weeks of commits, from the cache when it is fresh. */
  activity(id: string): Promise<Activity | null>;
  standing(id: string): Standing | null;
  verdict(id: string): Verdict | null;
  /** Ask for whatever is stale for these projects. Cheap to call on every repaint. */
  warm(ids: string[]): void;
  /** Drop one project's git snapshot, after a commit or a pull it knows about. */
  forget(id: string): void;
  /** Re-read the portfolio file and the analytics board. */
  refreshPortfolio(names: Map<string, string>): void;
};

export function mountPulse(events: {
  changed(): void;
  analyticsInstalled(): boolean;
}): PulseHandle {
  const gits = new Map<string, Entry<GitState>>();
  const activities = new Map<string, Entry<Activity>>();
  let standings = new Map<string, Standing>();
  let verdicts = new Map<string, Verdict>();
  let analyticsAt = 0;
  let inFlight = 0;
  const queue: Array<() => void> = [];
  let changeTimer = 0;

  const changed = (): void => {
    if (changeTimer) return;
    changeTimer = window.setTimeout(() => {
      changeTimer = 0;
      events.changed();
    }, 120);
  };

  const pump = (): void => {
    while (inFlight < MAX_IN_FLIGHT && queue.length) queue.shift()!();
  };

  function fetchInto<T>(cache: Map<string, Entry<T>>, id: string, ttl: number, read: () => Promise<T>): Promise<T | null> {
    const entry = cache.get(id) ?? { value: null, at: 0, pending: null };
    cache.set(id, entry);
    if (entry.pending) return entry.pending;
    if (entry.at && Date.now() - entry.at < ttl) return Promise.resolve(entry.value);
    entry.pending = new Promise<T | null>((resolve) => {
      queue.push(() => {
        inFlight += 1;
        read()
          .then((value) => {
            entry.value = value;
          })
          .catch(() => undefined)
          .finally(() => {
            inFlight -= 1;
            entry.at = Date.now();
            entry.pending = null;
            resolve(entry.value);
            changed();
            pump();
          });
      });
      pump();
    });
    return entry.pending;
  }

  const git = (id: string): Promise<GitState | null> =>
    fetchInto(gits, id, GIT_TTL, () => invoke<GitState>("project_dashboard", { project: id }));
  const activity = (id: string): Promise<Activity | null> =>
    fetchInto(activities, id, ACTIVITY_TTL, () => invoke<Activity>("project_activity", { project: id }));

  /** The board names apps by display name. A project matches on its own name, any case. */
  const loadAnalytics = (names: Map<string, string>): void => {
    if (!events.analyticsInstalled()) return;
    analyticsAt = Date.now();
    void moduleGet<{ ranking?: AnalyticsRow[] }>("/m/analytics/portfolio?days=28")
      .then((board) => {
        const next = new Map<string, Verdict>();
        for (const row of board.ranking ?? []) {
          const id = names.get(row.app) ?? names.get(row.app.toLowerCase());
          if (!id) continue;
          const trend = row.trend_wow;
          next.set(id, {
            label: row.state?.label ?? "",
            call: row.call,
            trend,
            risk: row.call === "kill" || row.call === "freeze" || (trend !== null && trend <= -0.1),
          });
        }
        verdicts = next;
        changed();
      })
      .catch(() => undefined);
  };

  let lastNames = new Map<string, string>();

  return {
    git,
    peekGit: (id) => gits.get(id)?.value ?? null,
    peekActivity: (id) => activities.get(id)?.value ?? null,
    activity,
    standing: (id) => standings.get(id) ?? null,
    verdict: (id) => verdicts.get(id) ?? null,
    warm(ids) {
      for (const id of ids) {
        void git(id);
        void activity(id);
      }
      if (analyticsAt && Date.now() - analyticsAt > ANALYTICS_TTL) loadAnalytics(lastNames);
    },
    forget(id) {
      gits.delete(id);
    },
    refreshPortfolio(names) {
      lastNames = names;
      void invoke<Standing[]>("project_standings")
        .then((rows) => {
          standings = new Map(rows.map((row) => [row.project, row]));
          changed();
        })
        .catch(() => undefined);
      loadAnalytics(names);
    },
  };
}
