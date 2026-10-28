/**
 * The wire. Mirrors the Rust types — serde tags the event variant as `kind` in snake_case
 * and leaves field names snake_case, so these shapes are exact, not adapted.
 */

import type { SessionKind } from "./features/agent-kinds";
import type { Place } from "./deeplink";

export type { SessionKind };

export type ActivityState = "started" | "finished";

/** Every event arrives already resolved to the project it belongs to. */
export type ProjectEvent = PanelEvent & { project: string };

export type PanelEvent =
  | { kind: "session_started"; session_id: string; provider: string }
  | { kind: "agent_text"; session_id: string; text: string; append: boolean }
  | { kind: "agent_status"; session_id: string; status: string; detail?: string | null }
  | {
      kind: "activity";
      session_id: string;
      activity_id: string;
      state: ActivityState;
      label: string;
      detail?: string | null;
      success?: boolean | null;
    }
  | { kind: "file_changed"; session_id: string; path: string; summary?: string | null }
  | { kind: "ask_requested"; session_id: string; qid: string; spec: AskSpec }
  | { kind: "ask_resolved"; session_id: string; qid: string; answered: boolean }
  | {
      kind: "visual_requested";
      session_id: string;
      view: string;
      title?: string | null;
      payload: Payload;
    }
  | { kind: "turn_finished"; session_id: string; success: boolean; summary?: string | null }
  | { kind: "error"; session_id?: string | null; message: string };

export type Payload = Record<string, unknown>;

/** One app in the portfolio. This is the app's main navigation. */
/** The main folder's project id: the folder the portfolio lives in, for a terminal that belongs
 *  to no single project. Wall only, like the manager. Mirrors MAIN_ID in main.rs. */
export const MAIN_ID = "main-folder";

export type Project = {
  id: string;
  name: string;
  path: string;
  exists: boolean;
  /** Which group owns it. Empty for a project in none — see Group. */
  group: string;
  /** Collections group children. Leaves own sessions and normal project tools. */
  role: "leaf" | "collection";
  /** Domain label. Extensions may add values without changing Panel core. */
  type: string;
  /** Parent project id, or empty for a root project. */
  parent_id: string;
  /** Module owning this project's domain surface. */
  extension_id: string;
};

/**
 * A company inside the portfolio.
 *
 * Panel stays one panel over everything you own; a group is the seam inside it. Projects carry a
 * group id, the sidebar sections by it, and each group gets its own terminal tab.
 *
 * Not `bundle_id`. That is and stays the reverse-DNS id a store calls one app by.
 */
export type Group = {
  id: string;
  name: string;
  /** Folder containing this group's `ops/`. Empty falls back to the global opsRoot. */
  ops_root: string;
  /** Store credentials for this group. Declared in config; nothing reads it yet. */
  store: unknown;
};

export type ProjectModules = {
  configured: boolean;
  enabled: string[];
  work_exclude: string[];
};

export type ProjectSurface = {
  id: string;
  title: string;
  glyph: string;
  roles: string[];
  types: string[];
  mount: string;
};

export type PanelModule = {
  name: string;
  title: string;
  icon: string;
  chat_js?: string | null;
  chat_css?: string | null;
  project_surfaces: ProjectSurface[];
};

/**
 * One live terminal on a project. A project holds as many as you open — this is why the type is
 * keyed by its own id and merely CARRIES a project, rather than being owned by one.
 */
export type Session = {
  id: string;
  project: string;
  kind: SessionKind | "sim" | "task";
  title: string;
  terminal_id: string;
};

/** One available iOS simulator, from `list_simulators`. */
export type SimDevice = {
  udid: string;
  name: string;
  runtime: string;
  booted: boolean;
};

/** A project the Run screen can actually launch, and how. Rust decides this with the same
 *  detection that builds the run plan. Native Android is its own kind. */
/** What a Run request produced. `adopted` means nothing was started because the app was already
 *  running on its own device — this is that run, which is also how a reloaded UI recovers it. */
export type SimStart = {
  session: Session;
  adopted: boolean;
  device: string;
  /** The target address the run holds — `iphone:<udid>`, `android:@<avd>`, `chrome`. The device
   *  name cannot say whether there is a window to raise; the address can. */
  address: string;
  kind: string;
};

export type SimTarget = {
  project: string;
  kind: string;
  /** The simulator this app has made its own, by name. Empty until it has run once. */
  device: string;
  /** The Android device or emulator this app is installed on, by ADDRESS (`android:@Pixel_7`).
   *  Empty when it is on none, and always empty for a powered-off AVD — nothing can be read off
   *  a device that is off. */
  androidDevice: string;
  /** The families this project can be launched on, in picker order. A Flutter app with no
   *  `web/` directory has no `chrome` here, because that row could only ever fail. */
  families: DeviceFamily[];
};

export type DeviceFamily = "iphone" | "ipad" | "ios" | "android" | "chrome" | "macos" | "windows" | "desktop";

/** One place an app can run, from `run_targets`. The `id` is the address every other surface
 *  speaks — leases, run plans, the picker — so nothing downstream has to parse a device name. */
export type RunTarget = {
  id: string;
  family: DeviceFamily;
  name: string;
  runtime: string;
  booted: boolean;
  /** What `flutter -d` wants: a udid for a simulator, the family name otherwise. */
  device: string;
  /** Somebody else holds it. Who, and whether they are debugging or capturing. */
  heldBy: string | null;
  heldKind: string | null;
  /** This app is installed here. Auto goes back to it. */
  owns: boolean;
};

/** Who holds which target right now, keyed by address. Shared with the screenshot pipeline
 *  through ~/.panel/leases.json — see common/lease.py next to Panel. */
export type DeviceLease = {
  owner: string;
  kind: "interactive" | "capture" | "debug";
  pid: number;
  since: number;
  family: DeviceFamily;
  name: string;
};

/** One consistent Run-screen snapshot from one portfolio scan. */
export type RunInventory = {
  devices: SimDevice[];
  leases: Record<string, DeviceLease>;
  androidDevices: RunTarget[];
  iosDevices: RunTarget[];
  targets: SimTarget[];
  /** Udids of booted simulators nobody holds. Rust decides; the screen only offers to shut them. */
  idle: string[];
};

export type GitState = {
  branch: string;
  ahead: number;
  behind: number;
  dirty: number;
  is_repo: boolean;
};

/** One exact before/after image captured around an agent edit hook. */
export type ChangeStep = {
  id: number;
  path: string;
  before: string;
  after: string;
  tool: string;
  at_ms: number;
};

/**
 * One file the human still has to touch, and why.
 *
 * `why` is the point. Git can tell you a file changed; only the agent can tell you it needs
 * YOU because the retry budget is a product call. A worklist without reasons is a file tree,
 * and we already decided we don't want one of those.
 */
export type WorkFile = {
  path: string;
  why?: string | null;
  /** Optional "path:line" to land on. */
  ref?: string | null;
};

/**
 * A question from the agent. Panel no longer has a surface for one — the ask is declined on
 * arrival — but the event still crosses the wire, so the shape stays named.
 */
export type AskSpec = Payload & { kind?: string };

/** What a rendered view is allowed to do to the rest of the app. Keep this small. */
export type RenderCtx = {
  /** Jump the editor to a location. `ref` may be "lib/auth.dart:88" (project-relative). */
  openRef(ref: string): void;
  /** Create/open an agent-supplied text draft in the real Work editor. */
  openDocument(path: string, draft?: string): Promise<void>;
  /** Save the document if needed and return the exact text to a blocked agent. */
  finishDocument(path: string): Promise<string>;
  /**
   * Go to a Panel place (see deeplink.ts). `alongside` is the media of the report the link came
   * in, so a Review link opens on all of it rather than one file of a set.
   */
  openPlace(place: Place, alongside?: string[]): void;
};

/** Renders one blocking question. `answer` fires at most once and unparks the agent. */
export type AskWidget = (
  spec: AskSpec,
  answer: (value: unknown) => void,
  ctx: RenderCtx,
) => HTMLElement;

/** Renders one `visual_requested` view. Pure: payload in, element out. */
export type ViewRenderer = (payload: Payload, ctx: RenderCtx) => HTMLElement;
