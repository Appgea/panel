/**
 * Run — the run system. Not a terminal, deliberately, and not only simulators.
 *
 * A run is a build process attached to a TARGET, and what you do to it is not typing — it is
 * run / reload / rebuild / stop. Idle projects stay compact; only a running or blocked project
 * expands into controls or a decision.
 *
 * A TARGET IS ANYWHERE THE APP CAN RUN, addressed the same way whatever it is:
 *
 *     iphone:<sim-udid>   ipad:<sim-udid>   ios:<phone-udid>   android:<serial>   chrome   macos   desktop
 *
 * The picker beside Run offers exactly the families this project can reach — Rust derives that
 * from the project itself, so a Flutter app with no `web/` never gets a Chrome row it could only
 * fail on. Nothing below the address cares which family it is; that is what makes the screen
 * agnostic rather than a simulator screen with special cases bolted on.
 *
 * ONE RUN PER APP. ⌘R RE-RUNS IT, ⌘⇧R RUNS IT FRESH. ⌘R on a Flutter app that is up is a hot
 * restart: seconds, not a build. Where no hot restart is on offer — a native app, a failed or
 * half-built run — ⌘R falls through to a new build that keeps the app's data. ⌘⇧R always builds
 * in place AND deletes the app off a simulator first, so it launches like a first install. Same
 * target, same device, new build. Rust reaps the old PTY and hands its lease back before re-taking
 * the same address, so nothing moves. A genuine SECOND copy is still a deliberate act — the
 * running card's quiet "＋ Instance", or ⌘⌥R — and it takes its own device and its own card.
 *
 * EVERY RUN HOLDS A LEASE. One lease per target, in ~/.panel/leases.json, and the screenshot
 * pipeline leases out of the same file (common/lease.py, next to Panel). That is the whole reason a
 * capture batch can run while you debug: it cannot be handed a device you are holding, and you
 * cannot be handed one it is capturing on. A held target stays listed and disabled, naming its
 * holder — "Tavla is capturing on it" is a reason, where a greyed row is only a refusal.
 *
 * AN APP KEEPS ITS SIMULATOR. Auto goes back to the device this app is installed on — Rust derives
 * that from the simulators themselves on every ask, so there is no binding file to go stale — and
 * only reaches for a free powered-off one when the app is nowhere yet, preferring a device with no
 * third-party apps on it. The picker overrides that per project: name a target and it is used as
 * given, booted or not. The pick is saved per project across launches. A disconnected phone
 * stays selected until the user changes it, preventing an unexpected simulator launch.
 *
 * PANEL_MAX_SIMS (default 4) is a soft ceiling on OPEN virtual devices: leased by a run, a debug
 * session or a capture, or booted with no lease at all. The last kind is idle, usually a device
 * an agent booted for a screenshot and left up. At capacity the row offers to shut the idle ones
 * down, Queue, or an explicit Run anyway. The header offers the same shutdown at any time.
 * Nothing in use is silently evicted. Chrome, the Mac and an already-booted device cost no seat:
 * none of them spins up a virtual machine.
 *
 * State lives HERE, not in the DOM: sim lifecycle events are routed in via onSim() whether
 * or not the screen is up, so coming back always shows the truth.
 */

import { listen } from "@tauri-apps/api/event";
import type {
  DeviceFamily,
  DeviceLease,
  Payload,
  RunInventory,
  RunTarget,
  Session,
  SimDevice,
  SimStart,
  SimTarget,
} from "../types";
import { ENGINES } from "./agent-kinds";
import { label as chordText } from "./keymap";
import { icon } from "../icons";
import { projectIconUrl } from "../project-assets";
import "./runner.css";

export type RunnerProject = {
  id: string;
  name: string;
  exists: boolean;
  /** Every terminal open on this project. Runs lists them beside the app because a run and the
   *  agent driving it are the same piece of work — see buildTerminalsRow. */
  sessions: Session[];
};

/** One live run, flattened for the workspace's build bar. Same truth as projectRun(), plus who
 *  it belongs to, so a surface with no project of its own can still name the app. */
export type LiveRun = {
  session: string;
  project: string;
  name: string;
  /** 1 for the app's run, 2 and up for deliberate extra instances. */
  instance: number;
  view: ProjectRunView;
};

/**
 * One project's run, flattened for a surface that is NOT this screen — the project's Terminals
 * tab. Run state lives in exactly one place (this module), so the tab reads it instead of
 * keeping a second copy that can disagree about what is running.
 */
export type ProjectRunView = {
  /** "idle" until a run exists, then the sim lifecycle state verbatim. */
  state: string;
  device: string;
  /** "flutter" | "native" | "android" | "godot" | "electron" — only flutter has hot reload. */
  kind: string;
  /** Only virtual devices have a window to raise. */
  canFocus: boolean;
  /** Last build time in ms, when one has been measured. */
  ms: number | null;
  /** The run still owns a process worth talking to. */
  live: boolean;
  /** A start/stop is in flight; the buttons must not fire twice. */
  busy: boolean;
  error: string | null;
  /** Simulator ceiling reached — Run needs an explicit "open another" to proceed. */
  capacity: { booted: number; cap: number } | null;
  queued: boolean;
  /** How many runs of this app are live — 1 normally, more when someone asked for extra
   *  instances out loud. The fields above describe the FIRST of them. */
  instances: number;
  /** There is output worth offering. Cheap — the tail itself is not built to answer this. */
  hasLog: boolean;
  /** This project can run another device-backed instance. */
  canAddInstance: boolean;
  /** ANSI-stripped tail of the run's PTY, built on demand. Build errors are read here. A
   *  function, not a field: this view is rebuilt on every chunk of PTY output, and joining 300
   *  lines to hand back a string nobody is looking at is the one thing here that is not free. */
  log(): string;
};

export type RunnerEvents = {
  /** Spawn `flutter run` (or the native/Godot plan) on a target; null target = auto-pick.
   *  `target` is an ADDRESS (`ipad:<udid>`, `chrome`, `macos`, …), never a bare udid.
   *  Returns the run that is ALREADY live for this project rather than a second one, unless the
   *  caller asked for another instance or for a restart. `fresh` deletes the app off a simulator
   *  before the install, so it launches like a first install. Only ⌘⇧R asks for that. */
  start(
    projectId: string,
    target: string | null,
    allowExtra: boolean,
    extraInstance: boolean,
    restart: boolean,
    fresh: boolean,
  ): Promise<SimStart>;
  /** Feed the run's PTY — "r" is hot reload, "R" is rebuild (hot restart). */
  write(terminalId: string, data: string): void;
  stop(sessionId: string): Promise<void>;
  /** Devices, leases, and runnable projects from one shared portfolio scan. */
  inventory(): Promise<RunInventory>;
  /** Shut down every booted simulator nobody holds. Resolves with how many went down. */
  closeIdle(): Promise<number>;
  /** Raise the window of the device at this address — Simulator.app for iOS, the emulator window
   *  for Android. With no address, Simulator.app, which is what a caller with no run means. */
  focus(address?: string): void;
  /** Open this project's dev server in the default browser. */
  openServer(projectId: string): void;
  /** Open one of the project's terminals — same door the wall's tiles use. */
  jump(projectId: string, sessionId: string): void;
  /** That session's process is gone; the chip says so instead of pretending it can be typed in. */
  isExited(sessionId: string): boolean;
};

export type RunnerHandle = {
  open(projects: RunnerProject[]): void;
  sync(projects: RunnerProject[]): void;
  clear(): void;
  isOpen(): boolean;
  /** Project selected by pointer, keyboard, or an incoming navigation request. */
  focusedProject(): string | null;
  /** Stop the run belonging to the active card (or the first live card). */
  closeActive(): boolean;
  /** Route every `sim` lifecycle event here, screen up or not. */
  onSim(projectId: string, sessionId: string, payload: Payload): void;
  /** Start one project on its own simulator from an external control surface such as CPO.
   *  `allowExtra` is the explicit answer to a simulator-ceiling block, as the card's
   *  "Open another" gives it. `extraInstance` is the deliberate second copy of an app that is
   *  already running — it always takes a fresh device, and nothing in the UI asks for it casually.
   *  True also when the app was already running and was simply brought forward. */
  startProject(
    projectId: string,
    allowExtra?: boolean,
    extraInstance?: boolean,
    restart?: boolean,
    fresh?: boolean,
  ): Promise<boolean>;
  /** Point the screen at one app — scroll its card into view and ring it briefly. Safe to call
   *  right after open(): a project not on screen yet gets lit the next time the grid builds. */
  highlight(projectId: string): void;
  /** Point at one exact run. Used when several instances share one project. */
  highlightRun(sessionId: string): void;

  /* --- per-project control, for the project's own Terminals tab (screen down) --- */

  /** Null when Panel cannot launch this project at all, or does not know yet. */
  projectRun(projectId: string): ProjectRunView | null;
  /** Ask Rust what is launchable, once, so an outside surface can decide whether to offer Run. */
  ensureTargets(): Promise<void>;
  /** Shared target choice for Terminals and Runs. */
  targetPicker(projectId: string): HTMLElement;
  refreshTargets(): Promise<void>;
  focusProject(projectId: string): void;
  stopProject(projectId: string): Promise<boolean>;
  stopRun(sessionId: string): Promise<boolean>;
  retryRun(sessionId: string): Promise<boolean>;
  dismissRun(sessionId: string): Promise<boolean>;
  /** ⌘R. Hot restart when the app is up and has one, else a fresh build over any live run. */
  rerunProject(projectId: string): Promise<boolean>;
  /** "r" hot reload / "R" hot restart on this project's run. False when nothing is live. */
  nudgeProject(projectId: string, restart: boolean): boolean;
  nudgeRun(sessionId: string, restart: boolean): boolean;
  /** Every active or failed run, for the workspace build bar. Screen up or not. */
  liveRuns(): LiveRun[];
  /** Fires on every run-state change, screen up or not. */
  onChange(listener: () => void): void;
};

/** Everything known about ONE run. Keyed by session, not by project: an app normally has exactly
 *  one, and may have more only because someone asked for a second instance out loud. */
type Run = {
  session: string;
  project: string;
  terminalId: string;
  device: string;
  /** The target ADDRESS this run holds, straight from Rust. The device NAME cannot say whether
   *  there is a window to raise; "Pixel 7" is an emulator on one desk and a handset on another. */
  address: string;
  kind: string;
  state: string;
  error: string | null;
  ms: number | null;
  /** 1 for the app's run, 2 and up for deliberate extra instances. Labels the card. */
  instance: number;
};

/** States in which the run still owns a process worth talking to. */
const LIVE = new Set(["launching", "building", "running", "reloaded", "restarted", "error"]);
/** States in which the app has reached its target and can take a hot restart. */
const UP = new Set(["running", "reloaded", "restarted"]);
const FAILED = new Set(["error", "failed"]);

const make = (tag: string, className: string): HTMLElement => {
  const node = document.createElement(tag);
  node.className = className;
  return node;
};

export function mountRunner(host: HTMLElement, events: RunnerEvents): RunnerHandle {
  let openState = false;
  /** sessionId -> that run. Survives screen switches; sim events keep it true. */
  const runs = new Map<string, Run>();
  /** Runs waiting for the recommended simulator ceiling to have room. */
  const queued = new Set<string>();
  /** Capacity decisions are shown in the affected row, never as a global error dialog. */
  const capacityBlocks = new Map<string, { booted: number; cap: number }>();
  const errors = new Map<string, string>();
  /** Closed failed runs ignore their final PTY events. Session ids never repeat. */
  const ignoredRuns = new Set<string>();
  const stoppedWaiters = new Map<string, () => void>();
  let devices: SimDevice[] = [];
  /** projectId -> runnable toolchain kind. Rust owns this
   *  call: most of the portfolio is not runnable, and a card that can only fail is worse than no
   *  card. Null until the first answer arrives — the grid waits rather than guessing. */
  let targets: Map<string, string> | null = null;
  /** projectId -> the name of the simulator this app is installed on right now, as Rust derives it
   *  from the devices themselves. Read-only, and re-read rather than remembered. */
  let bound = new Map<string, string>();
  /** projectId -> the ADDRESS of the Android device this app is installed on. Kept apart from
   *  `bound` because the two are different devices: an app can be on its simulator AND on the
   *  phone, and they are two rows in the same picker. */
  let androidBound = new Map<string, string>();
  /** projectId -> the families it can run on. A Flutter app with a `web/` directory gets Chrome;
   *  one without does not, because that row could only ever fail. */
  let families = new Map<string, DeviceFamily[]>();
  /** Target address -> who holds it. Shared with the screenshot pipeline through the lease file,
   *  which is why a capture batch can grey out a device this app never touched. */
  let leased = new Map<string, DeviceLease>();
  /** Attached Android devices and running emulators, portfolio-wide. Empty when adb is not
   *  installed, which is the honest answer rather than an error. */
  let android: RunTarget[] = [];
  let ios: RunTarget[] = [];
  /** Udids of booted simulators nobody holds, as Rust counts them. What "Shut down idle" offers. */
  let idle: string[] = [];
  let closingIdle = false;
  /** projectId -> the target the human picked, by ADDRESS (`ipad:<udid>`, `chrome`, …). Absent
   *  means Auto, which is the safe default: the app's own device, else a free powered-off one,
   *  never something already showing another app. An explicit pick is allowed to be a booted one
   *  — that is the whole point of choosing. */
  const picks = new Map<string, string>();
  const pickNames = new Map<string, string>();
  const PICK_STORAGE = "panel.runTargets.v1";
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(PICK_STORAGE) ?? "{}");
    if (saved && typeof saved === "object") {
      for (const [project, entry] of Object.entries(saved)) {
        if (!entry || typeof entry.address !== "string") continue;
        picks.set(project, entry.address);
        if (typeof entry.name === "string") pickNames.set(entry.address, entry.name);
      }
    }
  } catch { /* A damaged preference must not block the runner. */ }
  const setPick = (projectId: string, address: string): void => {
    if (address) picks.set(projectId, address);
    else picks.delete(projectId);
    const target = targetsFor(projectId).find((target) => target.id === address);
    if (target) pickNames.set(address, target.name);
    try {
      localStorage.setItem(PICK_STORAGE, JSON.stringify(Object.fromEntries(
        [...picks].map(([project, address]) => [project, { address, name: pickNames.get(address) }]),
      )));
    } catch { /* The current session still keeps the selection. */ }
  };
  const externalPickers = new Map<HTMLElement, string>();
  const pruneExternalPickers = (): void => {
    for (const picker of externalPickers.keys()) {
      if (!picker.isConnected) externalPickers.delete(picker);
    }
  };
  /** The target chosen for the next deliberate instance, scoped to its project. */
  const instancePicks = new Map<string, string>();
  /** A failed run may retry elsewhere without changing the project's normal target. */
  const retryPicks = new Map<string, string>();
  const AUTO = "";
  let snapshot: RunnerProject[] = [];
  /** Last card the human interacted with, by session; ⌘W and ⌘. use it when several are running. */
  let activeRun: string | null = null;
  let deck: HTMLElement;
  let launcher: HTMLElement;
  let openCount: HTMLElement;
  let queueCount: HTMLElement;
  let searchQuery = "";
  let searchInput: HTMLInputElement | null = null;
  let platformFilter: "all" | "flutter" | "native" | "android" | "godot" | "electron" | "server" = "all";
  /** The tile the keyboard is standing on, by project id. Always a visible tile, so ↵ has an
   *  answer the moment the screen is up — no click needed to start driving. */
  let cursor: string | null = null;
  let focusedProjectId: string | null = null;
  const busy = new Set<string>();
  /** The project an arrival asked us to point at, until its ring has faded. */
  let spotlight: string | null = null;
  let spotlightRun: string | null = null;
  let spotlightTimer = 0;

  /* ------------------------------------------------------------------- log */

  /**
   * A run's PTY output, kept as a readable tail. The deck ignores sim terminals, but their
   * bytes still arrive on the shared terminal event — this is the only listener that wants
   * them. Bounded per RUN, ANSI stripped, so a build error can be READ, not trusted to a pill.
   * Per run and not per app: two instances of one project have two different builds to explain.
   */
  const LOG_CAP = 300;
  const LOG_LINE_CAP = 4096;
  const logs = new Map<string, string[]>();
  const partial = new Map<string, string>();
  const openLogs = new Set<string>();
  /** PTY output can beat the initial sim event across the native/webview boundary. Hold that
   *  small race by terminal id, then attach it as soon as onSim identifies the run. */
  const pendingOutput = new Map<string, string>();
  const dirtyLogs = new Set<string>();
  let logPaintFrame = 0;

  /** The readable tail, as text. Shared with the project Terminals tab, which shows the same
   *  bytes — one formatter, so a build error reads identically in both places. */
  const logText = (session: string): string => {
    const tail = partial.get(session) ?? "";
    // A progress bar redraws with \r; only what survives the last one is the current line.
    const current = tail.slice(tail.lastIndexOf("\r") + 1);
    return [...(logs.get(session) ?? []), current].join("\n");
  };

  const paintLog = (session: string): void => {
    if (!openState) return;
    const pre = deck.querySelector<HTMLElement>(`[data-run="${CSS.escape(session)}"] .run-log`);
    if (!pre || pre.hidden) return;
    pre.textContent = logText(session);
    pre.scrollTop = pre.scrollHeight;
  };

  const scheduleLogPaint = (session: string): void => {
    dirtyLogs.add(session);
    if (logPaintFrame) return;
    logPaintFrame = requestAnimationFrame(() => {
      logPaintFrame = 0;
      for (const dirty of dirtyLogs) paintLog(dirty);
      dirtyLogs.clear();
      for (const watch of watchers) watch();
    });
  };

  const appendLog = (session: string, data: string): void => {
    const cleaned = data
      .replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g, "") // OSC (titles etc.)
      .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "") // CSI (colour, cursor)
      .replace(/\u001b[=>]/g, "");
    const parts = ((partial.get(session) ?? "") + cleaned).split("\n");
    partial.set(session, (parts.pop() ?? "").slice(-LOG_LINE_CAP));
    const lines = logs.get(session) ?? [];
    for (const raw of parts) {
      lines.push(raw.slice(raw.lastIndexOf("\r") + 1).trimEnd().slice(-LOG_LINE_CAP));
    }
    if (lines.length > LOG_CAP) lines.splice(0, lines.length - LOG_CAP);
    logs.set(session, lines);
    // Repaint once per frame while a build streams many chunks.
    scheduleLogPaint(session);
  };

  // Attached once for the app's lifetime — runs outlive the screen, and so must their logs.
  void listen<{ terminalId: string; data: string; closed: boolean }>(
    "panel-run-output",
    ({ payload }) => {
      if (!payload.data) return;
      for (const run of runs.values()) {
        if (run.terminalId !== payload.terminalId) continue;
        appendLog(run.session, payload.data);
        return;
      }
      const waiting = (pendingOutput.get(payload.terminalId) ?? "") + payload.data;
      const buffered = waiting.slice(-20_000);
      pendingOutput.set(payload.terminalId, buffered);
      window.setTimeout(() => {
        if (pendingOutput.get(payload.terminalId) === buffered) pendingOutput.delete(payload.terminalId);
      }, 2000);
    },
  );

  const isLive = (run: Run | undefined): run is Run => !!run && LIVE.has(run.state);
  const isFailed = (run: Run | undefined): boolean => !!run && FAILED.has(run.state);

  /** Every run this app has, oldest instance first. */
  const runsOf = (projectId: string): Run[] =>
    [...runs.values()]
      .filter((run) => run.project === projectId)
      .sort((a, b) => a.instance - b.instance);

  /**
   * THE app's run: its live one, or the last one it had. Every surface outside this screen — the
   * project's Terminals tab, the build bar, ⌘R, ⌘. — speaks about "this project's run", and with
   * one run per app that is exactly what this is. Extra instances are visible only where they are
   * addressed individually, on their own card.
   */
  const runOf = (projectId: string): Run | undefined => {
    const mine = runsOf(projectId);
    return mine.find(isLive) ?? mine[mine.length - 1];
  };

  const liveOf = (projectId: string): Run[] => runsOf(projectId).filter(isLive);

  /** The seat a new run takes: 1 normally, the next free number for a deliberate extra instance. */
  const nextInstance = (projectId: string): number =>
    liveOf(projectId).reduce((top, run) => Math.max(top, run.instance), 0) + 1;

  /** A run is busy while its own stop is in flight, or while its app's launch is. */
  const isBusy = (run: Run): boolean => busy.has(run.session) || busy.has(run.project);

  /** Forget this app's finished runs, and their output with them. Called when a new run of the
   *  same app starts: the dead session's tail is not this build's story. */
  const forgetDeadRuns = (projectId: string): void => {
    for (const run of runsOf(projectId)) {
      if (LIVE.has(run.state)) continue;
      runs.delete(run.session);
      logs.delete(run.session);
      partial.delete(run.session);
      openLogs.delete(run.session);
      if (activeRun === run.session) activeRun = null;
    }
  };

  const forgetRun = (sessionId: string): void => {
    const run = runs.get(sessionId);
    if (!run) return;
    runs.delete(sessionId);
    logs.delete(sessionId);
    partial.delete(sessionId);
    openLogs.delete(sessionId);
    retryPicks.delete(sessionId);
    if (activeRun === sessionId) activeRun = null;
    if (spotlightRun === sessionId) spotlightRun = null;
    if (!runsOf(run.project).some(isFailed)) errors.delete(run.project);
  };

  /* ------------------------------------------------------------------ card */

  const stateTone = (run: Run | undefined): { tone: string; text: string } => {
    if (!run) return { tone: "t-mute", text: "" };
    switch (run.state) {
      case "running":
      case "reloaded":
      case "restarted":
        return { tone: "t-ok", text: run.state };
      case "launching":
      case "building":
        return { tone: "t-live", text: run.state };
      case "error":
        return { tone: "t-risk", text: "error" };
      default:
        return { tone: "t-mute", text: run.state };
    }
  };

  const KIND_LABELS: Record<string, string> = {
    native: "Native iOS",
    android: "Native Android",
    godot: "Godot · desktop",
    electron: "Electron · desktop",
    server: "Dev server",
    flutter: "Flutter",
  };

  const kindLabel = (projectId: string): string =>
    KIND_LABELS[targets?.get(projectId) ?? "flutter"] ?? "Flutter";

  /** Is there a choice worth showing? A Godot game runs in the engine's own window and a project
   *  with one target has no decision to make, so the picker is hidden rather than shown offering
   *  choices that do nothing. */
  const needsDevice = (projectId: string): boolean => targetsFor(projectId).length > 1;

  /** Is there a window to raise for this address? A simulator and an emulator each live inside a
   *  window Panel can bring forward. A phone, Chrome, the Mac and a Godot game do not: the phone
   *  is already on the desk and the other three put their own window up, so "Focus" would either
   *  do nothing or shove the thing the human asked to see behind something unrelated. */
  const raisable = (address: string): boolean =>
    address.startsWith("iphone:") || address.startsWith("ipad:") || address.startsWith("android:@");

  const canAddInstance = (projectId: string): boolean =>
    (families.get(projectId) ?? []).some((family) =>
      family === "iphone" || family === "ipad" || family === "ios" || family === "android"
    );

  // Which target a run is on used to be read back out of the lease file by matching the owner.
  // Rust now states it on the run itself (`Run.address`), which is both cheaper and correct for a
  // second instance — those hold a lease under a suffixed owner the match would have missed.

  /* ---------------------------------------------------------- target picker */

  /** What the picker calls each family. The heading a human scans for, not the internal key. */
  const FAMILY_LABELS: Record<DeviceFamily, string> = {
    iphone: "iPhone simulators",
    ipad: "iPad simulators",
    ios: "iPhone / iPad devices",
    android: "Android",
    chrome: "Chrome",
    macos: "Mac",
    windows: "Windows",
    desktop: "Desktop",
  };

  /** Every target this project could run on, in picker order: its families as Rust listed them,
   *  and within a family the devices in the order simctl gave (newest runtime first).
   *
   *  Built here rather than fetched per project because the expensive halves — the simulator list
   *  and the lease file — are portfolio-wide. A per-card round trip would ask the same two
   *  questions once per project on every repaint. */
  const targetsFor = (
    projectId: string,
    options: { blockOwnLeases?: boolean; allowAddress?: string; instancesOnly?: boolean } = {},
  ): RunTarget[] => {
    const own = bound.get(projectId) ?? "";
    const out: RunTarget[] = [];
    for (const family of families.get(projectId) ?? []) {
      if (family === "iphone" || family === "ipad") {
        for (const device of devices) {
          if (simFamily(device.name) !== family) continue;
          out.push({
            id: `${family}:${device.udid}`,
            family,
            name: device.name,
            runtime: device.runtime,
            booted: device.booted,
            device: device.udid,
            heldBy: null,
            heldKind: null,
            owns: device.name === own,
          });
        }
      } else if (family === "ios") {
        out.push(...ios.map((target) => ({ ...target })));
      } else if (family === "android") {
        // Android comes from `adb` and `emulator`, which Rust runs for the whole portfolio at the
        // same moment it lists simulators — the family is per project, the devices are not. Which
        // of them holds THIS app is per project, though, and that is what `androidBound` carries.
        const mine = androidBound.get(projectId);
        out.push(...android.map((target) => ({ ...target, owns: target.id === mine })));
      } else {
        out.push({
          id: family,
          family,
          name: FAMILY_LABELS[family],
          runtime: "",
          booted: true,
          device: family,
          heldBy: null,
          heldKind: null,
          owns: false,
        });
      }
    }
    if (options.instancesOnly) {
      for (let index = out.length - 1; index >= 0; index -= 1) {
        if (!["iphone", "ipad", "ios", "android"].includes(out[index].family)) out.splice(index, 1);
      }
    }
    // Whoever holds a target is the reason it cannot be picked, and saying so beats greying it
    // out silently. A lease this project owns is not a block — that is its own run.
    for (const target of out) {
      const lease = leased.get(target.id);
      const ownLease = lease?.owner === projectId || lease?.owner.startsWith(`${projectId}#`);
      if (
        lease &&
        target.id !== options.allowAddress &&
        (options.blockOwnLeases || !ownLease)
      ) {
        target.heldBy = ownLease ? "another instance" : lease.owner;
        target.heldKind = lease.kind;
      }
    }
    return out;
  };

  /** iPad or iPhone from the simulator's name. Rust has already dropped watches and TVs from the
   *  runtimes it keeps, so anything that is not an iPad is a phone. */
  const simFamily = (name: string): DeviceFamily => {
    const lower = name.toLowerCase();
    if (lower.includes("ipad")) return "ipad";
    return "iphone";
  };

  /** What an option says. A held target names its holder and what they are doing: "Tavla is
   *  capturing on it" is a reason, where a greyed row is only a refusal. Booted is worth naming
   *  too — choosing one installs over whatever is on it, which Auto exists to avoid. The app's
   *  own device says so instead; installing over your own last build is the point. */
  const optionLabel = (target: RunTarget): string => {
    if (target.heldBy) {
      const verb = target.heldKind === "capture"
        ? "capturing"
        : target.heldKind === "debug"
          ? "debugging"
          : "running";
      return `${target.name} · ${target.heldBy} is ${verb} on it`;
    }
    if (target.owns) return `${target.name} · its device`;
    if (target.family === "chrome" || target.family === "macos" || target.family === "windows" || target.family === "desktop") {
      return target.name;
    }
    // Android reads the opposite way round from iOS, and the same word would lie in both.
    // A booted SIMULATOR is somebody's session, so "in use" is a warning. A running EMULATOR is
    // just ready, and the one worth choosing — the alternative is a cold boot measured in minutes.
    // A phone is neither: it is a handset on the desk, and naming that is the whole label.
    if (target.family === "android") {
      if (!target.id.startsWith("android:@")) return `${target.name} · phone · ${target.device}`;
      return `${target.name} · ${target.booted ? "running" : "cold start"}`;
    }
    if (target.family === "ios") return `${target.name} · ${target.runtime} · device`;
    return `${target.name}${target.booted ? " · in use" : ""}`;
  };

  /** The target SET, not their states. Rebuilding the <select> mid-interaction closes an open
   *  dropdown under the pointer, so a lease or a booted flag flipping only relabels. */
  const targetKey = (list: RunTarget[]): string => list.map((t) => t.id).join(",");

  const autoDestination = (projectId: string): { label: string; title: string } => {
    const simulator = bound.get(projectId);
    if (simulator) {
      return {
        label: `Auto — ${simulator}, its simulator`,
        title: `Run on ${simulator}, this app's simulator`,
      };
    }
    const address = androidBound.get(projectId);
    const device = android.find((target) => target.id === address)?.name;
    if (device) {
      return { label: `Auto — ${device}, its device`, title: `Run on ${device}` };
    }
    if ((families.get(projectId) ?? []).length === 1 && families.get(projectId)?.[0] === "android") {
      return { label: "Auto — ready Android device", title: "Run on an Android device" };
    }
    return { label: "Auto — fresh simulator", title: "Build and launch on a fresh simulator" };
  };

  const buildDevicePicker = (projectId: string): HTMLSelectElement => {
    const select = document.createElement("select");
    select.className = "run-device";
    select.setAttribute("aria-label", "where to run");
    select.addEventListener("change", () => {
      setPick(projectId, select.value);
      paintAll();
    });
    return select;
  };

  const buildRunTargetPicker = (
    projectId: string,
    selected: string,
    onChange: (address: string) => void,
    options: {
      purpose: "instance" | "retry";
      allowAddress?: string;
    },
  ): HTMLSelectElement => {
    const select = document.createElement("select");
    select.className = "run-device run-target-choice";
    select.setAttribute("aria-label", options.purpose === "instance" ? "target for new instance" : "retry target");
    const list = targetsFor(projectId, {
      blockOwnLeases: true,
      allowAddress: options.allowAddress,
      instancesOnly: options.purpose === "instance",
    });
    const auto = document.createElement("option");
    auto.value = AUTO;
    auto.textContent = options.purpose === "instance"
      ? "Auto · another free device"
      : "Auto · choose a free target";
    select.append(auto);
    let group: HTMLOptGroupElement | null = null;
    let groupLabel = "";
    for (const target of list) {
      const label = target.runtime && (target.family === "iphone" || target.family === "ipad")
        ? `${FAMILY_LABELS[target.family]} · ${target.runtime}`
        : FAMILY_LABELS[target.family];
      if (!group || groupLabel !== label) {
        group = document.createElement("optgroup");
        group.label = label;
        groupLabel = label;
        select.append(group);
      }
      const option = document.createElement("option");
      option.value = target.id;
      option.textContent = target.id === options.allowAddress
        ? `${optionLabel(target)} · current`
        : optionLabel(target);
      option.disabled = target.heldBy !== null;
      group.append(option);
    }
    if (selected && !list.some((target) => target.id === selected)) {
      const missing = new Option(`${pickNames.get(selected) ?? selected} · unavailable`, selected);
      missing.disabled = true;
      select.append(missing);
    }
    select.value = selected;
    select.addEventListener("change", () => onChange(select.value));
    return select;
  };

  /** Keep disconnected selections visible. Reconnecting and refreshing restores the same pick. */
  const paintDevice = (card: HTMLElement, p: Pick<RunnerProject, "id">, enabled: boolean): void => {
    const select = card.querySelector<HTMLSelectElement>(".run-device")!;
    select.hidden = !enabled;
    const list = targetsFor(p.id);
    const wanted = picks.get(p.id);
    const own = `${bound.get(p.id) ?? ""}|${androidBound.get(p.id) ?? ""}`;

    // The binding is part of the key: the app's device is named in the Auto option, so a project
    // that has just earned one has to relist rather than keep saying "fresh simulator".
    if (select.dataset.v !== `${targetKey(list)}|${own}|${wanted ?? ""}`) {
      select.dataset.v = `${targetKey(list)}|${own}|${wanted ?? ""}`;
      const auto = document.createElement("option");
      auto.value = AUTO;
      // Auto is not a lottery once an app has a device: say which one, so the default reads as
      // "back to its simulator" rather than "somewhere new".
      auto.textContent = autoDestination(p.id).label;
      select.replaceChildren(auto);
      // Grouped by family first, then by runtime inside the simulator families. Family is the
      // heading that matters: choosing between an iPad and Chrome is a different decision from
      // choosing between two iOS versions.
      let group: HTMLOptGroupElement | null = null;
      let groupLabel = "";
      for (const target of list) {
        const label =
          target.runtime && (target.family === "iphone" || target.family === "ipad")
            ? `${FAMILY_LABELS[target.family]} · ${target.runtime}`
            : FAMILY_LABELS[target.family];
        if (!group || groupLabel !== label) {
          group = document.createElement("optgroup");
          group.label = label;
          groupLabel = label;
          select.append(group);
        }
        const option = document.createElement("option");
        option.value = target.id;
        option.textContent = optionLabel(target);
        option.disabled = target.heldBy !== null;
        group.append(option);
      }
      if (wanted && !list.some((target) => target.id === wanted)) {
        const missing = new Option(`${pickNames.get(wanted) ?? wanted} · unavailable`, wanted);
        missing.disabled = true;
        select.append(missing);
      }
    } else {
      for (const target of list) {
        const option = select.querySelector<HTMLOptionElement>(
          `option[value="${CSS.escape(target.id)}"]`,
        );
        if (option) {
          option.textContent = optionLabel(target);
          option.disabled = target.heldBy !== null;
        }
      }
    }
    select.value = picks.get(p.id) ?? AUTO;
  };

  const projectIcon = (p: RunnerProject): HTMLElement => {
    const ico = make("span", "run-ico");
    const glyph = make("span", "run-glyph");
    glyph.textContent = p.name.trim().charAt(0).toUpperCase();
    ico.append(glyph);
    const img = document.createElement("img");
    img.src = projectIconUrl(p.id);
    img.alt = "";
    img.draggable = false;
    img.addEventListener("error", () => img.remove());
    ico.append(img);
    return ico;
  };

  const actionButton = (
    className: string,
    label: string,
    glyph: "play" | "reload" | "rebuild" | "stop" | "log" | null,
    action: () => void,
  ): HTMLButtonElement => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.innerHTML = `${glyph ? icon(glyph) : ""}<span>${label}</span>`;
    button.addEventListener("click", action);
    return button;
  };

  /**
   * The project's terminals, on the card of the app they belong to.
   *
   * A run and the agent that asked for it are one piece of work, and until now they lived on two
   * different screens — you watched a build here and typed to the agent there. The chips are the
   * shortest path back: one click lands in that session, exactly as a wall tile does. Projects
   * with nothing open get no row rather than an empty one, so the library stays scannable.
   */
  const buildTerminalsRow = (p: RunnerProject): HTMLElement | null => {
    if (!p.sessions.length) return null;
    const row = make("div", "run-terms");
    const key = make("span", "run-terms-key");
    key.textContent = "Terminals";
    row.append(key);
    for (const session of p.sessions) {
      const chip = document.createElement("button");
      chip.type = "button";
      const dead = events.isExited(session.id);
      chip.className = `run-term is-${session.kind}${dead ? " is-dead" : ""}`;
      chip.title = dead
        ? `${session.title} — ended. Open the transcript.`
        : `Open ${session.title} on ${p.name}`;
      const glyph = ENGINES.find((engine) => engine.kind === session.kind)?.glyph ?? "terminal";
      chip.innerHTML = `${icon(glyph)}<span></span>`;
      chip.querySelector("span")!.textContent = session.title;
      chip.addEventListener("click", (event) => {
        event.stopPropagation();
        events.jump(p.id, session.id);
      });
      row.append(chip);
    }
    return row;
  };

  /** "iOS 26.1" / "Android 14" — whichever inventory this run's device came out of. Looked up by
   *  ADDRESS on the Android side, because two emulators can share a model name. */
  const runtimeFor = (run: Run): string =>
    devices.find((device) => device.name === run.device)?.runtime ??
    android.find((target) => target.id === run.address)?.runtime ??
    ios.find((target) => target.id === run.address)?.runtime ??
    "";

  /** The lifecycle is intentionally coarse: Flutter and Xcode report different intermediate
   *  phrases, but both answer the useful question — has the app reached the device yet? */
  const progressFor = (run: Run): number =>
    UP.has(run.state) ? 3 : 0;

  const buildLiveCard = (p: RunnerProject, run: Run): HTMLElement => {
    const card = make("article", "run-live-card");
    card.dataset.project = p.id;
    card.dataset.run = run.session;
    card.classList.toggle("is-error", run.state === "error");
    card.classList.toggle("is-busy", isBusy(run));
    card.classList.toggle("is-extra", run.instance > 1);
    card.addEventListener("pointerdown", () => {
      activeRun = run.session;
    });

    const tone = stateTone(run);
    const runtime = runtimeFor(run);
    const buildTime = run.ms ? `${(run.ms / 1000).toFixed(1)}s build` : "build in progress";
    const device = make("div", "run-live-device");
    device.innerHTML = `
      <span class="run-device-dot" aria-hidden="true"></span>
      <b></b>
      <small></small>
      <span class="run-pill ${tone.tone}"><i></i><span></span></span>`;
    device.querySelector("b")!.textContent = run.device || "Opening simulator…";
    device.querySelector("small")!.textContent = runtime ? `· ${runtime}` : "";
    device.querySelector(".run-pill span")!.textContent = tone.text;

    const identity = make("div", "run-live-identity");
    const copy = make("span", "run-live-copy");
    copy.innerHTML = `<b></b><small></small>`;
    // An extra instance says so on its own card. Two identical cards for one app, differing only
    // by device name, is how you end up reloading the copy you were not looking at.
    copy.querySelector("b")!.textContent =
      run.instance > 1 ? `${p.name} · instance ${run.instance}` : p.name;
    copy.querySelector("small")!.textContent = `${kindLabel(p.id)} · ${buildTime}`;
    identity.append(projectIcon(p), copy);

    const steps = make("div", "run-progress");
    const progress = progressFor(run);
    // A server neither installs nor gets installed onto anything. Naming its middle step "Install"
    // would be a step that never happens sitting permanently unlit.
    const stepNames =
      run.kind === "server" ? ["Start", "Listen", "Serving"] : ["Build", "Install", "Running"];
    stepNames.forEach((label, index) => {
      const step = make("span", "run-progress-step");
      if (index < progress) step.classList.add("is-done");
      if (index === Math.min(progress, 2) && progress < 3) step.classList.add("is-current");
      step.innerHTML = `<i></i><span>${label}</span>`;
      steps.append(step);
    });

    const controls = make("div", "run-live-controls");
    if (run.state === "error") {
      controls.append(
        buildRunTargetPicker(
          p.id,
          retryPicks.get(run.session) ?? run.address,
          (address) => retryPicks.set(run.session, address),
          { purpose: "retry", allowAddress: run.address },
        ),
      );
      const retry = actionButton("run-retry", "Retry", "rebuild", () => {
        void retryRunBySession(run.session);
      });
      retry.title = "Stop this failed run and build it again";
      const close = actionButton("run-stop", "Close", "stop", () => {
        void dismissRunBySession(run.session);
      });
      close.title = "Stop and close this failed run";
      controls.append(retry, close);
    } else if (run.kind === "flutter") {
      const reload = actionButton("run-reload", "Reload", "reload", () => {
        if (!isLive(runs.get(run.session))) return;
        events.write(run.terminalId, "r");
        events.focus(run.address);
        nudge(run.session);
      });
      reload.title = "Hot reload — injects the change and keeps state";
      const rebuild = actionButton("run-rebuild", "Restart", "rebuild", () => {
        if (!isLive(runs.get(run.session))) return;
        events.write(run.terminalId, "R");
        events.focus(run.address);
        nudge(run.session);
      });
      rebuild.title = "Hot restart — rebuilds and attaches to the same simulator";
      controls.append(reload, rebuild);
    }
    const stop = actionButton("run-stop", "Stop", "stop", () =>
      void act(run.session, () => events.stop(run.session)),
    );
    stop.title = `Stop this run and give ${run.device || "its device"} back — ${chordText("app.stopApp")}`;
    // A server has no window to focus; its result is a page. The button opens it, for when the
    // human closed the tab the first "running" line opened for them. A phone has no window
    // either, and it is already lying on the desk — so it gets no button rather than a dead one.
    if (run.state === "error") {
      // Retry and Close already own this state.
    } else if (run.kind === "server") {
      const open = actionButton("run-focus", "Open", null, () => events.openServer(p.id));
      open.title = `Open ${run.device} in your browser`;
      controls.append(open, stop);
    } else if (raisable(run.address)) {
      const focus = actionButton("run-focus", "Focus", null, () => events.focus(run.address));
      focus.title = `Bring ${run.device} to the front`;
      controls.append(focus, stop);
    } else {
      controls.append(stop);
    }

    const logButton = actionButton("run-logbtn", "Output", "log", () => {
      if (openLogs.has(run.session)) openLogs.delete(run.session);
      else openLogs.add(run.session);
      paintAll();
    });
    logButton.classList.toggle("is-active", openLogs.has(run.session));
    logButton.title = "Show the run output — build errors live here";
    controls.append(logButton);

    // The deliberate second instance. It is a real cost — another simulator, another build, another
    // gigabyte — so it is a quiet control on the card of the app already running, and never the
    // thing that happens when you press Run twice. Only offered where a second copy can actually
    // go somewhere: there is one Chrome and one Mac, and two runs there would fight over a window.
    if (run.state !== "error" && run.instance === 1 && canAddInstance(p.id)) {
      const target = buildRunTargetPicker(
        p.id,
        instancePicks.get(p.id) ?? AUTO,
        (address) => instancePicks.set(p.id, address),
        { purpose: "instance" },
      );
      const another = actionButton("run-another", "＋ Instance", null, () => {
        void act(p.id, async () => {
          const result = await startRun(
            p.id,
            false,
            true,
            false,
            false,
            instancePicks.get(p.id) || null,
          );
          if (result === "started" || result === "adopted") instancePicks.delete(p.id);
        });
      });
      another.title =
        `Run a SECOND copy of ${p.name} on another simulator — ${chordText("app.runExtra")}. ` +
        `Costs a device and a build; ${chordText("app.runApp")} re-runs this one.`;
      controls.append(target, another);
    }

    const log = make("pre", "run-log");
    log.hidden = !openLogs.has(run.session);
    card.append(device, identity, steps, controls);
    // Terminal chips belong to the app, so they ride on its first card only.
    const terms = run.instance === 1 ? buildTerminalsRow(p) : null;
    if (terms) card.append(terms);
    card.append(log);
    return card;
  };

  type AttentionKind = "queued" | "capacity" | "error";

  const buildAttentionRow = (
    p: RunnerProject,
    kind: AttentionKind,
    failedRun?: Run,
  ): HTMLElement => {
    const row = make("article", `run-attention run-attention-${kind}`);
    row.dataset.project = p.id;
    // A row like this has no run of its own. Its output, when there is any, is the tail of the
    // attempt that just died — the app's last session.
    const last = failedRun?.session ?? runOf(p.id)?.session ?? "";
    const hasLog = !!last && (!!logs.get(last)?.length || !!partial.get(last));
    if (last) row.dataset.run = last;
    row.classList.toggle("is-busy", busy.has(p.id));
    const copy = make("div", "run-attention-copy");
    const title = kind === "queued"
      ? `${p.name} — next when a slot is free`
      : kind === "capacity"
        ? `${p.name} needs a simulator`
        : `${p.name}${failedRun && failedRun.instance > 1 ? ` · instance ${failedRun.instance}` : ""} failed`;
    const detail = kind === "queued"
      ? "Panel will launch it automatically."
      : kind === "capacity"
        ? capacityDetail(capacityBlocks.get(p.id))
        : failedRun?.error ?? errors.get(p.id) ?? "The run could not start.";
    copy.append(projectIcon(p));
    const text = make("span", "run-attention-text");
    text.innerHTML = `<b></b><small></small>`;
    text.querySelector("b")!.textContent = title;
    text.querySelector("small")!.textContent = detail;
    copy.append(text);
    const actions = make("div", "run-attention-actions");

    if (kind === "queued") {
      actions.append(
        actionButton("run-extra", "Run now anyway", "play", () =>
          void act(p.id, async () => { await startRun(p.id, true); }),
        ),
        actionButton("run-cancel", "Remove", null, () => {
          queued.delete(p.id);
          capacityBlocks.delete(p.id);
          paintAll();
        }),
      );
    } else if (kind === "capacity") {
      // Idle devices are the cheapest seat there is: nobody is using them. Offered first, and
      // only while there are some — the count is re-read, so a stale row never offers zero.
      if (idle.length) {
        const close = actionButton("run-close-idle", `Shut down ${idleLabel(idle.length)}`, "stop", () =>
          void act(p.id, async () => {
            await closeIdle();
            await startRun(p.id, false);
          }),
        );
        close.title = IDLE_TITLE;
        actions.append(close);
      }
      actions.append(
        actionButton("run-queue", "Queue", null, () => {
          capacityBlocks.delete(p.id);
          queued.add(p.id);
          paintAll();
          window.setTimeout(drainQueue, 0);
        }),
        actionButton("run-extra", "Run anyway", "play", () =>
          void act(p.id, async () => { await startRun(p.id, true); }),
        ),
      );
    } else {
      const selected = failedRun
        ? retryPicks.get(failedRun.session) ?? failedRun.address
        : picks.get(p.id) ?? AUTO;
      actions.append(
        buildRunTargetPicker(
          p.id,
          selected,
          (address) => {
            if (failedRun) retryPicks.set(failedRun.session, address);
            else setPick(p.id, address);
          },
          { purpose: "retry", allowAddress: failedRun?.address },
        ),
      );
      actions.append(
        actionButton("run-retry", "Try again", "play", () =>
          failedRun
            ? void retryRunBySession(failedRun.session)
            : void act(p.id, async () => { await startRun(p.id, false); }),
        ),
      );
      if (hasLog) {
        const output = actionButton("run-logbtn", "Output", "log", () => {
          if (openLogs.has(last)) openLogs.delete(last);
          else openLogs.add(last);
          paintAll();
        });
        output.classList.toggle("is-active", openLogs.has(last));
        actions.append(output);
      }
      actions.append(
        actionButton("run-cancel", "Close", null, () => {
          if (failedRun) forgetRun(failedRun.session);
          else errors.delete(p.id);
          paintAll();
        }),
      );
    }
    row.append(copy, actions);
    if (kind === "error" && hasLog) {
      const log = make("pre", "run-log");
      log.hidden = !openLogs.has(last);
      row.append(log);
    }
    return row;
  };

  const idleLabel = (count: number): string => `${count} idle simulator${count === 1 ? "" : "s"}`;
  const IDLE_TITLE =
    "Booted simulators no run, debug session or capture is using. Usually left up by an agent. " +
    "An agent still using one will have to boot it again.";

  const capacityDetail = (block: { booted: number; cap: number } | undefined): string => {
    const open = block?.booted ?? 0;
    const head = `${open} simulator${open === 1 ? " is" : "s are"} open, the limit is ${block?.cap ?? open}.`;
    return idle.length
      ? `${head} ${idle.length} of them ${idle.length === 1 ? "is" : "are"} idle.`
      : `${head} Queue it or explicitly use more memory.`;
  };

  /** Shut the idle simulators down and re-read the inventory, so every count on screen is the
   *  device list after the shutdown, not before it. */
  const closeIdle = async (): Promise<void> => {
    if (closingIdle) return;
    closingIdle = true;
    paintAll();
    try {
      await events.closeIdle();
      await refreshInventory();
    } finally {
      closingIdle = false;
      paintAll();
    }
  };

  const paintIdleButton = (): void => {
    const button = host.querySelector<HTMLButtonElement>(".run-head-status .run-close-idle");
    if (!button) return;
    button.hidden = !idle.length && !closingIdle;
    button.disabled = closingIdle;
    button.querySelector("span")!.textContent = closingIdle
      ? "Shutting down…"
      : `Shut down ${idleLabel(idle.length)}`;
  };

  const buildAppTile = (p: RunnerProject): HTMLElement => {
    const tile = make("article", "run-app-tile");
    tile.dataset.project = p.id;
    tile.dataset.name = p.name.toLocaleLowerCase();
    tile.dataset.platform = targets?.get(p.id) ?? "flutter";
    tile.classList.toggle("is-busy", busy.has(p.id));

    const head = make("div", "run-app-head");
    const copy = make("span", "run-app-copy");
    copy.innerHTML = `<b></b><small></small>`;
    copy.querySelector("b")!.textContent = p.name;
    copy.querySelector("small")!.textContent = kindLabel(p.id);
    head.append(projectIcon(p), copy);

    const launch = make("div", "run-app-launch");
    const select = buildDevicePicker(p.id);
    const go = actionButton("run-go", `Run ${p.name}`, "play", () =>
      void act(p.id, async () => { await startRun(p.id, false); }),
    );
    go.title = `${autoDestination(p.id).title} — ${chordText("app.runApp")}`;
    launch.append(select, go);
    tile.append(head, launch);
    const terms = buildTerminalsRow(p);
    if (terms) tile.append(terms);
    paintDevice(tile, p, needsDevice(p.id));
    return tile;
  };

  /**
   * Substring first, then subsequence — "sv" finds "Son Vapur" the way a launcher should, without
   * demoting the exact match somebody actually typed.
   */
  const matchesQuery = (name: string): boolean => {
    if (!searchQuery) return true;
    if (name.includes(searchQuery)) return true;
    let i = 0;
    for (const ch of name) {
      if (ch === searchQuery[i]) i += 1;
      if (i === searchQuery.length) return true;
    }
    return false;
  };

  const applyLauncherFilter = (): void => {
    if (!openState) return;
    let shown = 0;
    launcher.querySelectorAll<HTMLElement>(".run-app-tile").forEach((tile) => {
      const platform = tile.dataset.platform ?? "";
      const matchesPlatform = platformFilter === "all" || platform === platformFilter;
      tile.hidden = !matchesPlatform || !matchesQuery(tile.dataset.name ?? "");
      if (!tile.hidden) shown += 1;
    });
    const none = launcher.querySelector<HTMLElement>(".run-launch-none");
    if (none) none.hidden = shown > 0;
    paintCursor();
  };

  /* --------------------------------------------------------------- keyboard */

  const visibleTiles = (): HTMLElement[] =>
    openState
      ? [...launcher.querySelectorAll<HTMLElement>(".run-app-tile")].filter((tile) => !tile.hidden)
      : [];

  /** The cursor follows the filter: whatever you typed, the top surviving tile is what ↵ runs. */
  const paintCursor = (): void => {
    const tiles = visibleTiles();
    if (cursor && !tiles.some((tile) => tile.dataset.project === cursor)) cursor = null;
    if (!cursor) cursor = tiles[0]?.dataset.project ?? null;
    for (const tile of tiles) tile.classList.toggle("is-cursor", tile.dataset.project === cursor);
  };

  /** How many tiles the auto-fill grid put on one row, read off the layout rather than guessed —
   *  the column count changes with the window and no constant here could stay true. */
  const columnCount = (tiles: HTMLElement[]): number => {
    const top = tiles[0].offsetTop;
    let n = 0;
    for (const tile of tiles) {
      if (tile.offsetTop !== top) break;
      n += 1;
    }
    return Math.max(1, n);
  };

  const moveCursor = (dx: number, dy: number): void => {
    const tiles = visibleTiles();
    if (!tiles.length) return;
    const from = Math.max(0, tiles.findIndex((tile) => tile.dataset.project === cursor));
    // Vertical steps that would leave the grid do nothing, rather than snapping to a corner the
    // human never aimed at. Horizontal steps clamp at the ends.
    const next = from + dx + dy * columnCount(tiles);
    if (dy !== 0 && (next < 0 || next >= tiles.length)) return;
    const landing = tiles[Math.max(0, Math.min(tiles.length - 1, next))];
    cursor = landing.dataset.project ?? null;
    focusedProjectId = cursor;
    paintCursor();
    landing.scrollIntoView({ block: "nearest" });
  };

  const setQuery = (raw: string): void => {
    focusedProjectId = null;
    searchQuery = raw.trim().toLocaleLowerCase();
    if (searchInput && searchInput.value !== raw) searchInput.value = raw;
    applyLauncherFilter();
  };

  const runCursor = (): void => {
    const tiles = visibleTiles();
    const tile = tiles.find((candidate) => candidate.dataset.project === cursor) ?? tiles[0];
    const id = tile?.dataset.project;
    if (!id || busy.has(id)) return;
    void act(id, async () => { await startRun(id, false); });
  };

  /**
   * Type anywhere on this screen and you are searching. The screen has no text of its own to
   * type into, so a bare letter can only have meant "find this app" — making the human click a
   * field first is a step that answers nothing. ↵ runs what is under the cursor, so the whole
   * launch is one word and a return.
   *
   * Global rather than bound to the host: the pane holds no focus until something in it is
   * clicked, so a listener on the element would only hear the keys of people already using a
   * mouse. Guarded by openState and host.hidden, and it steps aside for any other field, any
   * modal, and every modified chord — ⌘R belongs to the keymap, not here.
   */
  const onKey = (event: KeyboardEvent): void => {
    if (!openState || host.hidden) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (document.querySelector(".dlg-wrap")) return;
    const target = event.target as HTMLElement | null;
    const inSearch = !!target && target === searchInput;
    if (!inSearch && target) {
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) {
        return;
      }
    }
    const take = (): void => {
      event.preventDefault();
      event.stopPropagation();
    };
    // Somebody tabbed to a control and pressed it. That key belongs to the button under the
    // focus ring, not to the tile under the cursor.
    const onControl = !!target?.closest("button, a[href], select");
    if (onControl && (event.key === "Enter" || event.key === " ")) return;
    switch (event.key) {
      case "ArrowRight":
        take();
        return moveCursor(1, 0);
      case "ArrowLeft":
        take();
        return moveCursor(-1, 0);
      case "ArrowDown":
        take();
        return moveCursor(0, 1);
      case "ArrowUp":
        take();
        return moveCursor(0, -1);
      case "Enter":
        take();
        return runCursor();
      case "Escape":
        if (!searchInput?.value) return;
        take();
        searchInput.blur();
        return setQuery("");
      case "Backspace":
        if (inSearch) return; // the field is already doing this
        if (!searchInput?.value) return;
        take();
        return setQuery(searchInput.value.slice(0, -1));
      default:
        break;
    }
    if (inSearch) return;
    // One printable character, no modifiers: the first keystroke is both the focus and the query.
    if (event.key.length !== 1 || !searchInput) return;
    if (event.key === " " && !searchInput.value) return; // Space is a scroll, not a search
    take();
    searchInput.focus();
    setQuery(searchInput.value + event.key);
  };

  window.addEventListener("keydown", onKey, true);
  const trackProject = (event: Event): void => {
    if (!openState || !(event.target instanceof Element)) return;
    const card = event.target.closest<HTMLElement>("[data-project]");
    if (card && host.contains(card)) focusedProjectId = card.dataset.project ?? null;
  };
  host.addEventListener("pointerdown", trackProject);
  host.addEventListener("focusin", trackProject);

  /** Surfaces outside this screen that mirror run state — currently the project Terminals tab.
   *  They are told on every change, including while the Runs screen is down, because that is
   *  exactly when they are the only thing showing it. */
  const watchers: Array<() => void> = [];

  const paintAll = (): void => {
    for (const watch of watchers) watch();
    pruneExternalPickers();
    for (const [picker, projectId] of externalPickers) {
      paintDevice(picker, { id: projectId }, true);
      picker.querySelector<HTMLSelectElement>("select")!.disabled = busy.has(projectId);
    }
    if (!openState) return;
    build();
  };

  /**
   * Show "building" while a reload/rebuild is in flight — but flutter says NOTHING for an
   * `r` with no pending changes, so an event may never come. Settle back to "running" if
   * the pill is still optimistic after a while, rather than lying forever.
   */
  const nudge = (session: string): void => {
    const run = runs.get(session);
    if (!run) return;
    run.state = "building";
    paintAll();
    window.setTimeout(() => {
      const now = runs.get(session);
      if (now && now.state === "building") {
        now.state = "running";
        paintAll();
      }
    }, 12_000);
  };

  const act = async (projectId: string, action: () => Promise<void>): Promise<void> => {
    if (busy.has(projectId)) return;
    busy.add(projectId);
    paintAll();
    try {
      await action();
    } finally {
      busy.delete(projectId);
      paintAll();
    }
  };

  type StartResult = "started" | "adopted" | "capacity" | "error";

  /** The run this project already has is the answer to "run it": raise its simulator, point the
   *  screen at its card, and leave the process — and its log — untouched. */
  const adopt = (projectId: string): StartResult => {
    // The app is running, so nothing about it is still waiting or broken.
    queued.delete(projectId);
    capacityBlocks.delete(projectId);
    errors.delete(projectId);
    // Only a simulator run has a Simulator window to raise. A Chrome, Mac or Godot run puts its
    // own window up, and raising Simulator would shove an unrelated empty device in front of the
    // human instead of the thing they asked to see.
    const live = runOf(projectId);
    if (live && raisable(live.address)) events.focus(live.address);
    spotlight = projectId;
    window.clearTimeout(spotlightTimer);
    spotlightTimer = window.setTimeout(() => {
      spotlight = null;
    }, 15_000);
    paintAll();
    return "adopted";
  };

  const startRun = async (
    projectId: string,
    allowExtra: boolean,
    extraInstance = false,
    restart = false,
    fresh = false,
    targetOverride?: string | null,
    seatOverride?: number,
  ): Promise<StartResult> => {
    // One run per app. Asked to run something that is already running, show it rather than
    // spending a second simulator on a second copy of the same build. A restart is the one thing
    // that overrides that: ⌘R means "build this again", and answering it by raising a window
    // leaves the human staring at the binary they were trying to replace.
    if (!extraInstance && !restart && isLive(runOf(projectId))) return adopt(projectId);
    const seat = seatOverride ?? (extraInstance ? nextInstance(projectId) : 1);
    const picked = targetOverride === undefined ? picks.get(projectId) || null : targetOverride;
    try {
      const started = await events.start(
        projectId,
        picked,
        allowExtra,
        extraInstance,
        restart,
        fresh,
      );
      const { session } = started;
      // Rust holds the same rule and starts nothing when the app is already live — the case this
      // module cannot see after a reload, having forgotten what is running. Take that run as it
      // really is instead of relabelling it "launching"; its log is keyed by the same session, so
      // it comes back with it.
      if (started.adopted) {
        const known = runs.get(session.id);
        runs.set(session.id, {
          session: session.id,
          project: projectId,
          terminalId: session.terminal_id,
          device: started.device,
          address: started.address ?? known?.address ?? "",
          kind: started.kind,
          state: "running",
          error: null,
          ms: known?.ms ?? null,
          instance: known?.instance ?? seat,
        });
        return adopt(projectId);
      }
      // The previous attempt's output belongs to a session that is gone. Drop it now that a new
      // one exists, rather than leaving a dead tail that reads like this build's failure.
      forgetDeadRuns(projectId);
      runs.set(session.id, {
        session: session.id,
        project: projectId,
        terminalId: session.terminal_id,
        // Rust names the target it actually resolved, for every family — a simulator, Chrome, the
        // Mac. Trusting it beats re-deriving a name from the pick, which would be blank whenever
        // the pick was Auto.
        device: (started.device ?? "").trim() || "Opening…",
        address: started.address ?? "",
        kind: started.kind || (targets?.get(projectId) ?? "flutter"),
        state: "launching",
        error: null,
        ms: null,
        instance: seat,
      });
      queued.delete(projectId);
      capacityBlocks.delete(projectId);
      errors.delete(projectId);
      // This run may be what earned the app its device. Refresh the shared inventory once.
      refreshInventory();
      return "started";
    } catch (cause) {
      const message = String(cause);
      const capacity = /SIM_CAPACITY\|(\d+)\|(\d+)/.exec(message);
      if (capacity) {
        capacityBlocks.set(projectId, { booted: Number(capacity[1]), cap: Number(capacity[2]) });
        // The row offers to shut the idle ones down, so it needs the same list the header shows.
        void refreshInventory();
        errors.delete(projectId);
        return "capacity";
      }
      queued.delete(projectId);
      capacityBlocks.delete(projectId);
      errors.set(
        projectId,
        message.replace(/^SIM_NO_FREE\|/, "").replace(/^Error:\s*/, "") || "Run could not start",
      );
      return "error";
    }
  };

  const dismissRunBySession = async (sessionId: string): Promise<boolean> => {
    const run = runs.get(sessionId);
    if (!run || isBusy(run)) return false;
    if (isLive(run)) {
      ignoredRuns.add(sessionId);
      await act(sessionId, () => events.stop(sessionId));
    }
    forgetRun(sessionId);
    paintAll();
    return true;
  };

  const retryRunBySession = async (sessionId: string): Promise<boolean> => {
    const run = runs.get(sessionId);
    if (!run || !isFailed(run) || isBusy(run)) return false;
    const { project, address, instance } = run;
    const target = (retryPicks.get(sessionId) ?? address) || null;
    if (isLive(run)) {
      const stopped = new Promise<void>((resolve) => {
        stoppedWaiters.set(sessionId, resolve);
        window.setTimeout(resolve, 3000);
      });
      ignoredRuns.add(sessionId);
      await act(sessionId, () => events.stop(sessionId));
      await stopped;
      stoppedWaiters.delete(sessionId);
    }
    forgetRun(sessionId);
    const result = await startRun(project, false, instance > 1, false, false, target, instance);
    paintAll();
    return result === "started" || result === "adopted";
  };

  let drainingQueue = false;
  const drainQueue = (): void => {
    const projectId = queued.values().next().value as string | undefined;
    if (!projectId || drainingQueue || busy.has(projectId)) return;
    drainingQueue = true;
    void act(projectId, async () => {
      const result = await startRun(projectId, false);
      if (result === "capacity" && queued.has(projectId)) {
        window.setTimeout(drainQueue, 3000);
      }
    }).finally(() => {
      drainingQueue = false;
    });
  };

  /** The grid's population: projects that exist AND that Rust says it can launch. Before the
   *  first targets() answer this is empty on purpose — better a blank moment than a flash of
   *  cards for projects that turn out not to be iOS apps. */
  const runnable = (): RunnerProject[] =>
    targets === null ? [] : snapshot.filter((p) => p.exists && targets!.has(p.id));

  const build = (): void => {
    deck.replaceChildren();
    launcher.replaceChildren();
    // Emulators are open devices too, and the heavier ones. A count that only saw simulators
    // would say "1 open" with three virtual machines on the machine.
    const booted =
      devices.filter((device) => device.booted).length +
      android.filter((target) => target.booted && target.id.startsWith("android:@")).length;
    openCount.textContent = `${booted} open`;
    paintIdleButton();
    queueCount.querySelector("span")!.textContent = `${queued.size} queued`;
    queueCount.hidden = queued.size === 0;

    if (targets === null) {
      const deckLoading = make("div", "run-deck-empty");
      deckLoading.innerHTML = `
        <span class="run-deck-empty-mark">${icon("play")}</span>
        <span><b>Checking simulator state…</b><small>Panel is finding runnable apps and available devices.</small></span>`;
      deck.append(deckLoading);
      const loading = make("div", "run-none");
      loading.textContent = "Finding runnable apps…";
      launcher.append(loading);
      return;
    }
    const cards = runnable();
    if (!cards.length) {
      const none = make("div", "run-none");
      none.textContent = snapshot.some((p) => p.exists)
        ? "Nothing here is runnable. Run needs a Flutter app, an Xcode project or a Godot game."
        : "No projects to run. Add one from the sidebar.";
      const empty = make("div", "run-deck-empty");
      empty.innerHTML = `
        <span class="run-deck-empty-mark">${icon("play")}</span>
        <span><b>Nothing running</b><small>Runnable Flutter, Xcode and Godot projects will appear in the app library.</small></span>`;
      deck.append(empty);
      launcher.append(none);
      return;
    }

    // One card per RUN, not per app: an app with a deliberate second instance has two builds,
    // two devices and two Reload buttons, and one card cannot honestly stand for both.
    const live = cards.flatMap((p) => liveOf(p.id).map((run) => ({ p, run })));
    const failed = cards.flatMap((p) =>
      runsOf(p.id).filter((run) => run.state === "failed").map((run) => ({ p, run })),
    );
    const attention = cards.filter((p) =>
      !failed.some(({ p: failedProject }) => failedProject.id === p.id) &&
      !liveOf(p.id).length &&
      (queued.has(p.id) || capacityBlocks.has(p.id) || errors.has(p.id)),
    );
    for (const { p, run } of live) deck.append(buildLiveCard(p, run));
    for (const { p, run } of failed) deck.append(buildAttentionRow(p, "error", run));
    for (const p of attention) {
      const kind: AttentionKind = queued.has(p.id)
        ? "queued"
        : capacityBlocks.has(p.id)
          ? "capacity"
          : "error";
      deck.append(buildAttentionRow(p, kind));
    }
    if (!live.length && !failed.length && !attention.length) {
      const empty = make("div", "run-deck-empty");
      empty.innerHTML = `
        <span class="run-deck-empty-mark">${icon("play")}</span>
        <span><b>No runs yet</b><small>Choose an app and a target below. Connect your phone and refresh devices to find it.</small></span>`;
      deck.append(empty);
    }

    const idle = cards.filter((p) =>
      !runsOf(p.id).some((run) => isLive(run) || isFailed(run)) &&
      !queued.has(p.id) && !capacityBlocks.has(p.id) && !errors.has(p.id),
    );
    for (const p of idle) launcher.append(buildAppTile(p));
    const noMatch = make("div", "run-launch-none");
    noMatch.textContent = idle.length ? "No apps match this search." : "Every runnable app is already in the deck.";
    launcher.append(noMatch);
    applyLauncherFilter();
    for (const session of openLogs) paintLog(session);
    applySpotlight();
  };

  /**
   * Land on the card the caller asked for. Arriving on Runs from an Inbox report means "show me
   * THIS app" — a screen full of peers with nothing lit is the same as no destination at all.
   * The ring fades on its own, so it reads as an arrival rather than a selection you now have
   * to undo.
   */
  const applySpotlight = (): void => {
    if (!spotlight) return;
    const target =
      (spotlightRun
        ? deck.querySelector<HTMLElement>(`[data-run="${CSS.escape(spotlightRun)}"]`)
        : null) ??
      deck.querySelector<HTMLElement>(`[data-project="${CSS.escape(spotlight)}"]`) ??
      launcher.querySelector<HTMLElement>(`[data-project="${CSS.escape(spotlight)}"]`);
    if (!target) return;
    window.clearTimeout(spotlightTimer);
    target.classList.add("is-spotlit");
    requestAnimationFrame(() => target.scrollIntoView({ block: "center", behavior: "smooth" }));
    spotlightTimer = window.setTimeout(() => {
      target.classList.remove("is-spotlit");
      spotlight = null;
      spotlightRun = null;
    }, 2800);
  };

  /** The one place run state is flattened for a surface outside this screen. Null when Panel
   *  cannot launch the project at all, or does not know yet. */
  const runViewOf = (projectId: string, only?: Run): ProjectRunView | null => {
    if (!targets?.has(projectId)) return null;
    const run = only ?? runOf(projectId);
    const session = run?.session ?? "";
    return {
      state: run?.state ?? "idle",
      device: run?.device ?? "",
      kind: run?.kind ?? targets.get(projectId) ?? "flutter",
      canFocus: !!run && raisable(run.address),
      ms: run?.ms ?? null,
      live: isLive(run),
      busy: busy.has(projectId) || (!!run && busy.has(run.session)),
      error: run?.error ?? errors.get(projectId) ?? null,
      capacity: capacityBlocks.get(projectId) ?? null,
      queued: queued.has(projectId),
      instances: liveOf(projectId).length,
      hasLog: (logs.get(session)?.length ?? 0) > 0 || !!partial.get(session),
      canAddInstance: canAddInstance(projectId),
      log: () => logText(session),
    };
  };

  /** One place the targets answer is unpacked, so kind, device binding and families never drift
   *  apart. */
  const absorbTargets = (list: SimTarget[]): void => {
    targets = new Map(list.map((target) => [target.project, target.kind]));
    bound = new Map(
      list.filter((target) => target.device).map((target) => [target.project, target.device]),
    );
    androidBound = new Map(
      list
        .filter((target) => target.androidDevice)
        .map((target) => [target.project, target.androidDevice]),
    );
    families = new Map(list.map((target) => [target.project, target.families]));
  };

  const absorbInventory = (inventory: RunInventory): void => {
    devices = inventory.devices;
    leased = new Map(Object.entries(inventory.leases));
    android = inventory.androidDevices;
    ios = inventory.iosDevices ?? [];
    idle = inventory.idle ?? [];
    absorbTargets(inventory.targets);
  };

  /** Re-read the portfolio as one snapshot. Rust shares device scans across every field. */
  let inventoryRequest: Promise<void> | null = null;
  const refreshInventory = (): Promise<void> => {
    if (inventoryRequest) return inventoryRequest;
    inventoryRequest = events.inventory().then((inventory) => {
      absorbInventory(inventory);
      paintAll();
    }).finally(() => { inventoryRequest = null; });
    return inventoryRequest;
  };

  /* --------------------------------------------------------------- handle */

  const handle: RunnerHandle = {
    open(projects) {
      openState = true;
      snapshot = projects;
      host.hidden = false;

      const inner = make("div", "run-inner is-enter");
      const head = make("header", "run-screen-head");
      head.innerHTML = `
        <div class="run-head-title">
          <span class="run-mark" aria-hidden="true">${icon("play")}</span>
          <span class="run-title-id">
            <b>Runs</b>
            <small>Run on your phone, simulator, or desktop. Target choices stay saved per app.</small>
          </span>
        </div>
        <div class="run-head-status">
          <span class="run-count run-open-count"><i></i><span></span></span>
          <span class="run-count run-queue-count"><i></i><span></span></span>
          <button class="run-close-idle" type="button" hidden>${icon("stop")}<span></span></button>
          <button class="run-refresh-devices" type="button">Refresh devices</button>
          <button class="run-show-simulator" type="button">Show Simulator</button>
        </div>`;
      openCount = head.querySelector<HTMLElement>(".run-open-count span")!;
      queueCount = head.querySelector<HTMLElement>(".run-queue-count")!;
      const refresh = head.querySelector<HTMLButtonElement>(".run-refresh-devices")!;
      refresh.addEventListener("click", () => {
        refresh.disabled = true;
        void refreshInventory().finally(() => { refresh.disabled = false; });
      });
      head.querySelector<HTMLButtonElement>(".run-show-simulator")!
        .addEventListener("click", () => events.focus());
      const closeIdleButton = head.querySelector<HTMLButtonElement>(".run-close-idle")!;
      closeIdleButton.title = IDLE_TITLE;
      closeIdleButton.addEventListener("click", () => void closeIdle());

      const deckSection = make("section", "run-section run-deck-section");
      const deckHead = make("header", "run-section-head");
      deckHead.innerHTML = `
        <span><small>Live capacity</small><b>Active runs</b></span>
        <p>Running apps, queued work, and slot decisions stay together.</p>`;
      deck = make("div", "run-deck");
      deckSection.append(deckHead, deck);

      const launchSection = make("section", "run-section run-launch-section");
      const launchHead = make("header", "run-section-head run-launch-head");
      launchHead.innerHTML = `
        <span><small>App library</small><b>Launch another app</b></span>
        <div class="run-launch-tools">
          <label class="run-search"><span aria-hidden="true">⌕</span><input type="search" placeholder="Type to find an app" aria-label="Search runnable apps"><kbd class="run-search-hint">↑↓ ↵ run</kbd></label>
          <span class="run-filters" role="group" aria-label="Filter by platform"></span>
        </div>`;
      const search = launchHead.querySelector<HTMLInputElement>(".run-search input")!;
      searchInput = search;
      search.value = searchQuery;
      search.addEventListener("input", () => setQuery(search.value));
      const filters = launchHead.querySelector<HTMLElement>(".run-filters")!;
      ([
        ["all", "All"],
        ["flutter", "Flutter"],
        ["native", "Native iOS"],
        ["android", "Native Android"],
        ["godot", "Godot"],
        ["electron", "Electron"],
        ["server", "Servers"],
      ] as const).forEach(([value, label]) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "run-filter";
        button.textContent = label;
        button.setAttribute("aria-pressed", String(platformFilter === value));
        button.addEventListener("click", () => {
          platformFilter = value;
          focusedProjectId = null;
          filters.querySelectorAll<HTMLButtonElement>(".run-filter").forEach((candidate) => {
            candidate.setAttribute("aria-pressed", String(candidate === button));
          });
          applyLauncherFilter();
        });
        filters.append(button);
      });
      launcher = make("div", "run-launcher");
      launchSection.append(launchHead, launcher);

      inner.append(head, deckSection, launchSection);
      host.replaceChildren(inner);
      build();
      refreshInventory();
    },

    sync(projects) {
      if (!openState) return;
      // The key carries the terminals too: a session opened or closed changes what the cards
      // show, and paintAll() only repaints run state — it never rebuilds a chip row.
      const key = (list: RunnerProject[]): string =>
        list.map((p) => `${p.id}:${p.sessions.map((s) => s.id).join(",")}`).join("|");
      const before = key(snapshot);
      const membership =
        projects.map((p) => p.id).join("|") !== snapshot.map((p) => p.id).join("|");
      snapshot = projects;
      // A project came or went: its runnability is unknown, so re-ask before redrawing the grid.
      if (membership) {
        build();
        refreshInventory();
      } else if (key(projects) !== before) {
        build();
      }
      paintAll();
    },

    clear() {
      host.replaceChildren();
      host.hidden = true;
      openState = false;
      // The field and the tile it pointed at are gone with the DOM; holding their ids would only
      // let the next open() aim at something that no longer exists.
      searchInput = null;
      cursor = null;
      focusedProjectId = null;
    },

    isOpen: () => openState,

    focusedProject() {
      if (!openState) return null;
      const id = focusedProjectId ?? cursor;
      return snapshot.some((project) => project.id === id) ? id : null;
    },

    highlight(projectId) {
      spotlight = projectId;
      spotlightRun = null;
      // Runs only lists what a simulator can actually launch. Asking it to point at a website or
      // a package leaves a request nothing will ever satisfy — expire it rather than let it fire
      // on some unrelated rebuild ten minutes later.
      window.clearTimeout(spotlightTimer);
      spotlightTimer = window.setTimeout(() => {
        spotlight = null;
        spotlightRun = null;
      }, 15_000);
      // A stale search would hide the very tile we were asked to point at.
      searchQuery = "";
      platformFilter = "all";
      // Arriving on a card is also standing on it: ↵ runs what you were just sent to look at.
      cursor = projectId;
      focusedProjectId = projectId;
      if (!openState) return; // build() lights it as soon as the screen comes up
      const search = host.querySelector<HTMLInputElement>(".run-search input");
      if (search) search.value = "";
      host.querySelectorAll<HTMLButtonElement>(".run-filter").forEach((chip, index) => {
        chip.setAttribute("aria-pressed", String(index === 0));
      });
      build();
    },

    highlightRun(sessionId) {
      const run = runs.get(sessionId);
      if (!run) return;
      spotlight = run.project;
      spotlightRun = sessionId;
      window.clearTimeout(spotlightTimer);
      spotlightTimer = window.setTimeout(() => {
        spotlight = null;
        spotlightRun = null;
      }, 15_000);
      searchQuery = "";
      platformFilter = "all";
      cursor = run.project;
      focusedProjectId = run.project;
      if (!openState) return;
      const search = host.querySelector<HTMLInputElement>(".run-search input");
      if (search) search.value = "";
      host.querySelectorAll<HTMLButtonElement>(".run-filter").forEach((chip, index) => {
        chip.setAttribute("aria-pressed", String(index === 0));
      });
      build();
    },

    closeActive() {
      if (!openState) return false;
      const selected = activeRun ? runs.get(activeRun) : undefined;
      // The card you last touched, else the only sensible reading of "the one" — the first live
      // run. Stopping by session, never by app: an app may have two, and giving back the wrong
      // simulator is worse than doing nothing.
      const target = selected && (isLive(selected) || isFailed(selected))
        ? selected
        : [...runs.values()].find((run) => isLive(run) || isFailed(run));
      if (!target) return false;
      if (isFailed(target)) void dismissRunBySession(target.session);
      else void act(target.session, () => events.stop(target.session));
      return true;
    },

    async startProject(
      projectId,
      allowExtra = false,
      extraInstance = false,
      restart = false,
      fresh = false,
    ) {
      if (busy.has(projectId)) return false;
      if (!targets) absorbInventory(await events.inventory());
      if (!targets?.has(projectId)) return false;
      busy.add(projectId);
      paintAll();
      try {
        // "Adopted" is a yes: the app the caller asked for is running and now in front of them.
        const result = await startRun(projectId, allowExtra, extraInstance, restart, fresh);
        return result === "started" || result === "adopted";
      } finally {
        busy.delete(projectId);
        paintAll();
      }
    },

    async ensureTargets() {
      if (targets) return;
      await refreshInventory();
    },

    refreshTargets: refreshInventory,

    focusProject(projectId) {
      const run = runOf(projectId);
      if (run && raisable(run.address)) events.focus(run.address);
    },

    targetPicker(projectId) {
      pruneExternalPickers();
      const picker = make("span", "run-inline-picker");
      const select = buildDevicePicker(projectId);
      const refresh = actionButton("run-refresh-devices", "Refresh devices", "reload", () => {
        refresh.disabled = true;
        void refreshInventory().finally(() => { refresh.disabled = false; });
      });
      refresh.title = "Reconnect your phone, then refresh. iPhone needs trust and Developer Mode. Android needs USB debugging.";
      picker.append(select, refresh);
      paintDevice(picker, { id: projectId }, true);
      externalPickers.set(picker, projectId);
      return picker;
    },

    // Before the first targets() answer, and for everything that is not a launchable app, there
    // is nothing honest to say. The caller hides the control rather than offering a button that
    // can only fail.
    projectRun: (projectId) => runViewOf(projectId),

    async stopProject(projectId) {
      const run = runOf(projectId);
      if (!isLive(run) || isBusy(run)) return false;
      await act(run.session, () => events.stop(run.session));
      return true;
    },

    async stopRun(sessionId) {
      const run = runs.get(sessionId);
      if (!isLive(run) || isBusy(run)) return false;
      await act(sessionId, () => events.stop(sessionId));
      return true;
    },

    retryRun: (sessionId) => retryRunBySession(sessionId),

    dismissRun: (sessionId) => dismissRunBySession(sessionId),

    rerunProject(projectId) {
      const run = runOf(projectId);
      if (run && UP.has(run.state) && handle.nudgeProject(projectId, true)) {
        return Promise.resolve(true);
      }
      return handle.startProject(projectId, false, false, isLive(run));
    },

    nudgeProject(projectId, restart) {
      const run = runOf(projectId);
      if (!isLive(run) || run.kind !== "flutter") return false;
      events.write(run.terminalId, restart ? "R" : "r");
      events.focus(run.address);
      nudge(run.session);
      return true;
    },

    nudgeRun(sessionId, restart) {
      const run = runs.get(sessionId);
      if (!isLive(run) || run.kind !== "flutter") return false;
      events.write(run.terminalId, restart ? "R" : "r");
      events.focus(run.address);
      nudge(run.session);
      return true;
    },

    liveRuns() {
      const out: LiveRun[] = [];
      for (const run of runs.values()) {
        if (!isLive(run) && !isFailed(run) && !isBusy(run)) continue;
        const view = runViewOf(run.project, run);
        if (!view) continue;
        out.push({
          session: run.session,
          project: run.project,
          name: snapshot.find((p) => p.id === run.project)?.name ?? run.project,
          instance: run.instance,
          view,
        });
      }
      return out;
    },

    onChange(listener) {
      watchers.push(listener);
    },

    onSim(projectId, sessionId, payload) {
      const state = String(payload.state ?? "");
      if (ignoredRuns.has(sessionId)) {
        if (state === "stopped" || state === "paused") {
          ignoredRuns.delete(sessionId);
          stoppedWaiters.get(sessionId)?.();
          stoppedWaiters.delete(sessionId);
          refreshInventory();
          window.setTimeout(drainQueue, 1200);
        }
        return;
      }
      // Keyed by session, so an event can only ever describe its own run — a late word from a
      // run that has been replaced updates that dead run and nothing else.
      const existing = runs.get(sessionId);
      const failedStop =
        state === "stopped" &&
        !!existing &&
        ["launching", "building", "error"].includes(existing.state);
      const nextState = failedStop ? "failed" : state;
      const runError = nextState === "error"
        ? "The run failed. Open Output for the build error."
        : nextState === "failed"
          ? existing?.error ?? "The run stopped before reaching its target."
          : null;
      runs.set(sessionId, {
        session: sessionId,
        project: projectId,
        terminalId: String(payload.terminalId ?? existing?.terminalId ?? ""),
        device: String(payload.device ?? existing?.device ?? ""),
        address: String(payload.address ?? existing?.address ?? ""),
        kind: String(payload.kind ?? existing?.kind ?? "flutter"),
        state: nextState,
        error: runError,
        ms: typeof payload.ms === "number" ? payload.ms : null,
        // A run Panel did not start itself — adopted after a webview reload — still needs a seat.
        instance: existing?.instance ?? nextInstance(projectId),
      });
      const terminalId = String(payload.terminalId ?? existing?.terminalId ?? "");
      const early = pendingOutput.get(terminalId);
      if (early) {
        pendingOutput.delete(terminalId);
        appendLog(sessionId, early);
      }
      // A launch/build that dies should explain itself without making the human discover the Log
      // button. Deliberate stops after a successful run stay compact.
      if (
        nextState === "error" || nextState === "failed"
      ) {
        openLogs.add(sessionId);
      }
      if (UP.has(nextState)) {
        errors.delete(projectId);
      }
      paintAll();
      if (openLogs.has(sessionId)) paintLog(sessionId);
      // Shutdown is asynchronous; give Simulator a moment to release the slot, then start the
      // oldest queued project.
      if (state === "stopped" || state === "paused") {
        refreshInventory();
        window.setTimeout(drainQueue, 1200);
      }
    },
  };
  return handle;
}
