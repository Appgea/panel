/**
 * A pretend Panel backend for README screenshots. capture.mjs injects this before the real UI
 * loads, so every screen is the shipped frontend drawing invented data. Nothing here reads or
 * writes a file, starts a process or talks to a network.
 *
 * The portfolio is made up: six apps nobody owns. Their icons and the pictures their agents
 * "made" come from mock-media.mjs, which capture.mjs serves on the project-icon and project-asset
 * schemes.
 *
 * It answers the same Tauri commands the Rust side answers (see `invoke` calls in ui/src) and
 * replays agent events and terminal output through the same event channels. A command it does not
 * know logs `[demo] unhandled` and returns null, which is the first place to look when a new
 * screen comes up empty.
 */
(() => {
  const ROOT = "/Users/dev/projects";
  const OPS = "/Users/dev/.appgeapanel/ops";
  const now = Date.now();
  const MIN = 60_000;

  /* ------------------------------------------------------------- portfolio */

  const project = (id, name, extra = {}) => ({
    id,
    name,
    path: `${ROOT}/${name}`,
    exists: true,
    group: "",
    role: "leaf",
    type: "generic",
    parent_id: "",
    extension_id: "",
    ...extra,
  });

  const PROJECTS = [
    project("tidepool", "Tidepool"),
    project("lumen", "Lumen"),
    project("orbit", "Orbit"),
    project("ledgerly", "Ledgerly"),
    project("quill", "Quill"),
    project("kite", "Kite"),
  ];
  const nameOf = (id) => PROJECTS.find((p) => p.id === id)?.name ?? id;

  const GIT = {
    tidepool: { branch: "main", ahead: 2, behind: 0, dirty: 3, is_repo: true },
    lumen: { branch: "filter-presets", ahead: 4, behind: 0, dirty: 5, is_repo: true },
    orbit: { branch: "main", ahead: 1, behind: 0, dirty: 2, is_repo: true },
    ledgerly: { branch: "main", ahead: 0, behind: 0, dirty: 1, is_repo: true },
    quill: { branch: "main", ahead: 0, behind: 0, dirty: 0, is_repo: true },
    kite: { branch: "radar-layer", ahead: 0, behind: 3, dirty: 0, is_repo: true },
  };

  /** Where each app stands in ops/portfolio.yaml. The sidebar sorts its lanes from this. */
  const STANDINGS = [
    { project: "tidepool", key: "tidepool", status: "live", notes: "Cozy aquarium sim. Reef update in progress." },
    { project: "lumen", key: "lumen", status: "building", notes: "Filter presets for 2.0." },
    { project: "orbit", key: "orbit", status: "review", notes: "1.6 in App Store review." },
    { project: "ledgerly", key: "ledgerly", status: "live", notes: "" },
    { project: "quill", key: "quill", status: "paused", notes: "" },
    { project: "kite", key: "kite", status: "building", notes: "Rain radar layer." },
  ];

  /** Commits per day for the last two weeks, oldest first. The sidebar draws these as bars. */
  const DAYS = {
    tidepool: [0, 1, 0, 2, 3, 0, 0, 1, 4, 2, 0, 3, 5, 2],
    lumen: [2, 0, 0, 1, 0, 3, 2, 0, 0, 4, 1, 0, 2, 3],
    orbit: [0, 0, 3, 1, 0, 0, 0, 2, 0, 0, 1, 0, 0, 1],
    ledgerly: [0, 0, 0, 0, 1, 0, 0, 0, 0, 2, 0, 0, 0, 1],
    quill: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    kite: [1, 0, 2, 0, 0, 1, 0, 0, 3, 0, 1, 2, 0, 1],
  };

  const session = (projectId, n, kind, title) => ({
    id: `s-${projectId}-${n}`,
    project: projectId,
    kind,
    title,
    terminal_id: `t-${projectId}-${n}`,
  });

  /** The Manager is a pseudo-project rooted at the ops tree (CPO_ID in main.ts). */
  const MANAGER = { ...project("appgea", "Manager"), path: OPS };

  const SESSIONS = [
    session("tidepool", 1, "claude", "claude"),
    session("tidepool", 2, "shell", "shell"),
    session("lumen", 1, "codex", "codex"),
    session("orbit", 1, "claude", "claude"),
    session("ledgerly", 1, "shell", "shell"),
  ];
  const MANAGER_SESSION = session("appgea", 1, "claude", "claude");

  /* ----------------------------------------------------------------- files */

  const FEEDING_BEFORE = `import 'dart:math';

import 'fish.dart';
import 'pellet.dart';
import 'tank.dart';

/// Feeding time: pellets sink, each fish picks the nearest one and swims to it.
class FeedingSystem {
  FeedingSystem(this.tank);

  final Tank tank;
  final List<Pellet> pellets = [];
  final Map<Fish, Pellet> targets = {};

  static const sinkSpeed = 18.0; // px per second
  static const biteRange = 6.0;

  void drop(Offset at, {int count = 5}) {
    final rng = Random();
    for (var i = 0; i < count; i++) {
      pellets.add(Pellet(at.translate(rng.nextDouble() * 24 - 12, 0)));
    }
  }

  void tick(double dt) {
    for (final pellet in pellets) {
      pellet.y = min(pellet.y + sinkSpeed * dt, tank.floor);
    }
    for (final fish in tank.fish) {
      final target = targets[fish] ??= nearest(fish);
      if (target == null) continue;
      fish.swimToward(target.position, dt);
      if (fish.distanceTo(target.position) < biteRange) eat(fish, target);
    }
  }

  Pellet? nearest(Fish fish) {
    Pellet? best;
    var bestDistance = double.infinity;
    for (final pellet in pellets) {
      final distance = fish.distanceTo(pellet.position);
      if (distance < bestDistance) {
        best = pellet;
        bestDistance = distance;
      }
    }
    return best;
  }

  void eat(Fish fish, Pellet pellet) {
    fish.hunger = max(0, fish.hunger - pellet.food);
    tank.notify();
  }
}
`;

  const FEEDING_AFTER = FEEDING_BEFORE.replace(
    "    fish.hunger = max(0, fish.hunger - pellet.food);\n",
    "    fish.hunger = max(0, fish.hunger - pellet.food);\n    pellets.remove(pellet);\n    targets.removeWhere((_, chased) => chased == pellet);\n",
  );

  const EATEN_TEST = `import 'package:flutter_test/flutter_test.dart';
import 'package:tidepool/tank/feeding.dart';
import 'package:tidepool/tank/tank.dart';

void main() {
  test('a pellet one fish ate is no longer chased by the others', () {
    final tank = Tank.demo(fish: 3);
    final feeding = FeedingSystem(tank)..drop(const Offset(120, 0), count: 1);

    feeding.tick(0.016);
    feeding.eat(tank.fish.first, feeding.pellets.single);

    expect(feeding.pellets, isEmpty);
    expect(feeding.targets.values, isEmpty);
  });
}
`;

  const TIDEPOOL_FILES = {
    "README.md": "# Tidepool\n\nA cozy aquarium you tend a few minutes a day.\n",
    "pubspec.yaml": "name: tidepool\ndescription: A cozy aquarium sim.\nversion: 2.3.0+41\n\nenvironment:\n  sdk: ^3.5.0\n",
    "analysis_options.yaml": "include: package:flutter_lints/flutter.yaml\n",
    "lib/main.dart": "import 'package:flutter/material.dart';\n\nimport 'ui/app.dart';\n\nvoid main() => runApp(const TidepoolApp());\n",
    "lib/tank/feeding.dart": FEEDING_AFTER,
    "lib/tank/fish.dart": "/// One fish: species, hunger, and where it is headed.\nclass Fish {}\n",
    "lib/tank/pellet.dart": "/// A food pellet sinking to the floor.\nclass Pellet {}\n",
    "lib/tank/tank.dart": "/// The glass box: its fish, its floor and its listeners.\nclass Tank {}\n",
    "lib/scenes/reef.dart": "/// Reef backgrounds by time of day.\nclass ReefScene {}\n",
    "lib/ui/app.dart": "import 'package:flutter/material.dart';\n\nclass TidepoolApp extends StatelessWidget {\n  const TidepoolApp({super.key});\n}\n",
    "lib/ui/tank_view.dart": "class TankView {}\n",
    "lib/ui/shop_sheet.dart": "class ShopSheet {}\n",
    "renders/reef_dawn.png": "",
    "renders/reef_noon.png": "",
    "renders/reef_night.png": "",
    "test/tank/feeding_test.dart": "void main() {}\n",
    "test/tank/eaten_pellet_test.dart": EATEN_TEST,
  };

  const HEAD = { "lib/tank/feeding.dart": FEEDING_BEFORE };
  const GIT_STATES = {
    "lib/tank/feeding.dart": "modified",
    "lib/ui/tank_view.dart": "modified",
    "test/tank/eaten_pellet_test.dart": "untracked",
  };

  const readDir = (dir) => {
    const prefix = dir ? `${dir}/` : "";
    const seen = new Map();
    for (const path of Object.keys(TIDEPOOL_FILES)) {
      if (!path.startsWith(prefix)) continue;
      const [name, ...rest] = path.slice(prefix.length).split("/");
      seen.set(name, seen.get(name) || rest.length > 0);
    }
    return [...seen]
      .map(([name, is_dir]) => ({ name, is_dir }))
      .sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || a.name.localeCompare(b.name));
  };

  const relative = (path) => path.replace(`${ROOT}/Tidepool/`, "");

  /* ------------------------------------------------------------- terminals */

  const ESC = "\x1b[";
  const c = {
    reset: `${ESC}0m`,
    dim: `${ESC}2m`,
    bold: `${ESC}1m`,
    red: `${ESC}31m`,
    green: `${ESC}32m`,
    yellow: `${ESC}33m`,
    blue: `${ESC}34m`,
    magenta: `${ESC}35m`,
    cyan: `${ESC}36m`,
    gray: `${ESC}90m`,
    orange: `${ESC}38;5;209m`,
    violet: `${ESC}38;5;141m`,
  };
  const lines = (...rows) => rows.join("\r\n") + "\r\n";

  const SCREENS = {
    "t-tidepool-1": lines(
      `${c.orange}✻${c.reset} ${c.bold}claude${c.reset} ${c.dim}· ${ROOT}/Tidepool${c.reset}`,
      "",
      `${c.gray}>${c.reset} Fish keep chasing a pellet another fish already ate. Fix it and add a test.`,
      "",
      `${c.reset}● I'll look at how a fish picks its target and what happens when a pellet is eaten.`,
      "",
      `● ${c.bold}Search${c.reset}(pattern: "targets", path: "lib/tank")`,
      `  ${c.gray}⎿  Found 5 matches in 2 files${c.reset}`,
      "",
      `● ${c.bold}Read${c.reset}(lib/tank/feeding.dart)`,
      `  ${c.gray}⎿  Read 62 lines${c.reset}`,
      "",
      `● ${c.bold}Update${c.reset}(lib/tank/feeding.dart)`,
      `  ${c.gray}⎿  Updated lib/tank/feeding.dart with 2 additions${c.reset}`,
      `      ${c.gray}57${c.reset}      fish.hunger = max(0, fish.hunger - pellet.food);`,
      `      ${c.gray}58${c.reset} ${c.green}+    pellets.remove(pellet);${c.reset}`,
      `      ${c.gray}59${c.reset} ${c.green}+    targets.removeWhere((_, chased) => chased == pellet);${c.reset}`,
      `      ${c.gray}60${c.reset}      tank.notify();`,
      "",
      `● ${c.bold}Write${c.reset}(test/tank/eaten_pellet_test.dart)`,
      `  ${c.gray}⎿  Wrote 16 lines${c.reset}`,
      "",
      `● ${c.bold}Bash${c.reset}(flutter test test/tank)`,
      `  ${c.gray}⎿  00:03 +31: All tests passed!${c.reset}`,
      "",
      `● An eaten pellet now leaves the tank and every fish chasing it picks a new one.`,
      `  See ${c.cyan}panel:work:lib/tank/feeding.dart:58${c.reset}`,
      "",
      `${c.orange}✻${c.reset} Rendering the reef at dawn, noon and night… ${c.dim}(24s · esc to interrupt)${c.reset}`,
    ),
    "t-tidepool-2": lines(
      `${c.green}dev@studio${c.reset} ${c.blue}Tidepool${c.reset} % flutter analyze`,
      "Analyzing Tidepool...",
      "No issues found! (ran in 2.8s)",
      `${c.green}dev@studio${c.reset} ${c.blue}Tidepool${c.reset} % `,
    ),
    "t-lumen-1": lines(
      `${c.bold}codex${c.reset} ${c.dim}· ${ROOT}/Lumen${c.reset}`,
      "",
      `${c.cyan}user${c.reset}`,
      "Make three filter presets for 2.0 and export a sample of each.",
      "",
      `${c.magenta}codex${c.reset}`,
      "Golden, Noir and Fade are in. Each is one color matrix, so they stack with the editor's sliders.",
      `  ${c.green}•${c.reset} Edited lib/filters/presets.dart ${c.green}(+88)${c.reset}`,
      `  ${c.green}•${c.reset} Edited lib/editor/filter_strip.dart ${c.green}(+21${c.reset} ${c.red}-4)${c.reset}`,
      `  ${c.green}•${c.reset} Exported exports/golden.png, noir.png, fade.png`,
      "",
      `${c.yellow}Allow command?${c.reset}`,
      `  $ dart run build_runner build --delete-conflicting-outputs`,
      `  ${c.bold}[y]${c.reset} yes   ${c.bold}[a]${c.reset} always   ${c.bold}[n]${c.reset} no`,
    ),
    "t-orbit-1": lines(
      `${c.orange}✻${c.reset} ${c.bold}claude${c.reset} ${c.dim}· ${ROOT}/Orbit${c.reset}`,
      "",
      `${c.gray}>${c.reset} A streak breaks when someone flies across time zones. Fix that.`,
      "",
      `● ${c.bold}Update${c.reset}(lib/streaks/streak.dart)`,
      `  ${c.gray}⎿  Updated with 34 additions and 9 removals${c.reset}`,
      "",
      `● ${c.bold}Bash${c.reset}(flutter test)`,
      `  ${c.gray}⎿  00:05 +146: All tests passed!${c.reset}`,
      "",
      `● Days are now counted in the habit's home time zone, so a trip never costs a streak.`,
      `  Reported to Panel.`,
      "",
      `${c.gray}>${c.reset} `,
    ),
    "t-ledgerly-1": lines(
      `${c.green}dev@studio${c.reset} ${c.blue}Ledgerly${c.reset} % flutter test --coverage`,
      "00:02 +22: loading test/split/by_item_test.dart",
      "00:04 +71: test/settle/minimal_transfers_test.dart: four people, two transfers",
      `00:06 +108: ${c.green}All tests passed!${c.reset}`,
      `${c.green}dev@studio${c.reset} ${c.blue}Ledgerly${c.reset} % `,
    ),
    "t-appgea-1": lines(
      `${c.orange}✻${c.reset} ${c.bold}claude${c.reset} ${c.dim}· ${OPS}${c.reset}`,
      "",
      `${c.gray}>${c.reset} What needs me this morning?`,
      "",
      `● ${c.bold}appgea-panel - list_workers${c.reset}`,
      `  ${c.gray}⎿  5 live terminals: 2 working, 1 waiting on you, 1 finished, 1 idle${c.reset}`,
      "",
      `● ${c.bold}Read${c.reset}(brain/reports/lumen.md, tidepool.md, kite.md)`,
      `  ${c.gray}⎿  Read 3 files${c.reset}`,
      "",
      `● Three things, most urgent first:`,
      "",
      `  ${c.bold}1. Lumen is waiting on you.${c.reset} Codex needs an OK to run build_runner, then a`,
      `     call: which preset is the default? Its samples are in Review.`,
      `  ${c.bold}2. Kite is blocked.${c.reset} The radar provider rejects the staging key. Only you`,
      `     can add a production key in their dashboard.`,
      `  ${c.bold}3. Orbit 1.6 is in App Store review.${c.reset} The time zone fix is done and tested;`,
      `     it should ride along in 1.6.1.`,
      "",
      `  Tidepool and Ledgerly are moving on their own. Want me to brief Orbit on 1.6.1?`,
      "",
      `${c.gray}>${c.reset} Yes, brief it. Keep it small.`,
      "",
      `● ${c.bold}appgea-panel - brief_worker${c.reset}(orbit · claude)`,
      `  ${c.gray}⎿  Waiting for your approval in Panel…${c.reset}`,
    ),
  };

  /* ---------------------------------------------------------------- events */

  const callbacks = new Map();
  const listeners = new Map();
  let nextId = 1;

  const emit = (event, payload) => {
    for (const handler of listeners.get(event) ?? []) {
      callbacks.get(handler)?.({ event, id: handler, payload });
    }
  };

  const agent = (projectId, sessionId, body) => emit("panel-agent-event", { project: projectId, session_id: sessionId, ...body });

  const REPORTS = [
    {
      project: "kite",
      session: null,
      agent: "codex",
      title: "Rain radar is blocked on a key",
      outcome: "blocked",
      text: "The radar provider rejects the staging key. Add a production key in their dashboard and I'll finish the layer.",
      links: [{ url: "panel:work:lib/radar/radar_layer.dart:31", label: "radar_layer.dart" }],
    },
    {
      project: "quill",
      session: null,
      agent: "claude",
      title: "Entries sync across devices",
      outcome: "done",
      text: "Journal entries now sync through iCloud with per-paragraph merges. Tested with two phones offline for a day.",
    },
    {
      project: "ledgerly",
      session: "s-ledgerly-1",
      agent: "claude",
      title: "New store screenshot: split by item",
      outcome: "done",
      text: "The first App Store screenshot now shows itemised splitting. 6.7-inch, ready to upload.",
      images: [{ path: "store/store_01.png", caption: "App Store · 6.7-inch · 01" }],
    },
    {
      project: "orbit",
      session: "s-orbit-1",
      title: "Streaks survive time zones",
      outcome: "done",
      text: "Days are counted in the habit's home time zone, so a trip never costs a streak. 146 tests pass.",
      links: ["panel:work:lib/streaks/streak.dart:58", "panel:git"],
    },
    {
      project: "lumen",
      session: "s-lumen-1",
      title: "Pick the default filter",
      outcome: "needs_decision",
      text: "Golden, Noir and Fade are ready. Which one should new photos open with?",
      images: [
        { path: "exports/golden.png", caption: "Golden" },
        { path: "exports/noir.png", caption: "Noir" },
        { path: "exports/fade.png", caption: "Fade" },
      ],
    },
    {
      project: "tidepool",
      session: "s-tidepool-1",
      title: "The reef has a day and a night",
      outcome: "done",
      text: "Three reef backgrounds, one per time of day, crossfading with the clock. Night fish glow.",
      images: [
        { path: "renders/reef_dawn.png", caption: "Dawn" },
        { path: "renders/reef_noon.png", caption: "Noon" },
        { path: "renders/reef_night.png", caption: "Night" },
      ],
      links: ["panel:work:lib/scenes/reef.dart:42"],
    },
  ];

  /** What Review has collected: files agents wrote while a session was open. Absolute paths. */
  const MADE = [
    { project: "ledgerly", path: `${ROOT}/Ledgerly/store/store_01.png`, kind: "image", size: 412_000, modified: now - 95 * MIN },
    { project: "lumen", path: `${ROOT}/Lumen/exports/golden.png`, kind: "image", size: 288_000, modified: now - 41 * MIN },
    { project: "lumen", path: `${ROOT}/Lumen/exports/noir.png`, kind: "image", size: 251_000, modified: now - 40 * MIN },
    { project: "lumen", path: `${ROOT}/Lumen/exports/fade.png`, kind: "image", size: 262_000, modified: now - 40 * MIN },
    { project: "tidepool", path: `${ROOT}/Tidepool/renders/reef_dawn.png`, kind: "image", size: 530_000, modified: now - 6 * MIN },
    { project: "tidepool", path: `${ROOT}/Tidepool/renders/reef_noon.png`, kind: "image", size: 548_000, modified: now - 5 * MIN },
    { project: "tidepool", path: `${ROOT}/Tidepool/renders/reef_night.png`, kind: "image", size: 497_000, modified: now - 4 * MIN },
  ];

  /** Bring the portfolio to life: terminal screens, agent state, edited files, reports and renders. */
  function play() {
    for (const [terminalId, data] of Object.entries(SCREENS)) {
      emit("panel-terminal-output", { terminalId, data, closed: false });
    }
    for (const s of [...SESSIONS, MANAGER_SESSION]) {
      if (s.kind === "shell") continue;
      agent(s.project, s.id, { kind: "session_started", provider: s.kind });
    }
    for (const report of REPORTS) {
      agent(report.project, report.session, {
        kind: "visual_requested",
        view: "message",
        title: report.title,
        payload: {
          title: report.title,
          outcome: report.outcome,
          text: report.text,
          ...(report.images ? { images: report.images } : {}),
          ...(report.links ? { links: report.links } : {}),
          _panel_project: report.project,
          // A report from an agent that has since closed names itself; a live one is named by its session.
          ...(report.agent ? { source: report.agent, agent_kind: report.agent } : {}),
        },
      });
    }
    // Oldest first, the way the watcher would have announced them.
    for (const made of MADE) emit("panel-made", made);

    agent("tidepool", "s-tidepool-1", { kind: "agent_status", status: "thinking", detail: "Stop fish chasing eaten pellets" });
    for (const path of ["lib/tank/feeding.dart", "test/tank/eaten_pellet_test.dart"]) {
      agent("tidepool", "s-tidepool-1", { kind: "file_changed", path: `${ROOT}/Tidepool/${path}`, summary: null });
    }
    agent("tidepool", "s-tidepool-1", {
      kind: "activity",
      activity_id: "a1",
      state: "finished",
      label: "test",
      detail: "flutter test test/tank · 31 passed",
      success: true,
    });
    agent("tidepool", "s-tidepool-1", { kind: "agent_status", status: "working", detail: "Rendering the reef at three times of day" });
    agent("orbit", "s-orbit-1", { kind: "turn_finished", success: true, summary: "Streaks survive time zones" });
    agent("lumen", "s-lumen-1", { kind: "agent_status", status: "waiting", detail: "Allow dart run build_runner?" });
    agent("appgea", MANAGER_SESSION.id, { kind: "agent_status", status: "working", detail: "Briefing Orbit" });
  }

  /* -------------------------------------------------------------- commands */

  const PREPROMPT = `# Manager

You run a small studio's app portfolio with me. Every morning, tell me what needs me,
in order, in three lines or fewer each. Plan the week from ops/now.md. Brief workers
only after I approve the exact prompt. Never ship, spend or change a price on your own.
`;

  const COMMANDS = {
    launch_context: () => ({ single_project: null }),
    list_modules: () => [
      { name: "git-manager", title: "Git", icon: "⎇", project_surfaces: [] },
      { name: "support", title: "Support", icon: "✉", project_surfaces: [] },
    ],
    list_groups: () => [],
    list_projects: () => PROJECTS,
    manager_project: () => MANAGER,
    cpo_preprompt: () => PREPROMPT,
    restore_wall: () => ({
      savedAt: 0,
      sessions: [...SESSIONS, MANAGER_SESSION].map((s) => ({ session: s, screen: "" })),
    }),
    project_dashboard: ({ project: id }) => GIT[id] ?? { branch: "", ahead: 0, behind: 0, dirty: 0, is_repo: false },
    project_modules: () => ({ configured: false, enabled: ["git"], work_exclude: [] }),
    project_standings: () => STANDINGS,
    project_activity: ({ project: id }) => {
      const days = DAYS[id] ?? Array(14).fill(0);
      const last = days.reduce((at, n, i) => (n ? i : at), -1);
      return { last_commit: last >= 0 ? now - (13 - last) * 86_400_000 : 0, days };
    },
    run_inventory: () => ({ devices: [], leases: {}, androidDevices: [], iosDevices: [], targets: [] }),
    session_busy: () => false,
    session_cwd: ({ session: id }) => {
      if (id === MANAGER_SESSION.id) return OPS;
      const s = SESSIONS.find((one) => one.id === id);
      return s ? `${ROOT}/${nameOf(s.project)}` : null;
    },
    made_entries: ({ project: id, paths }) =>
      MADE.filter((made) => made.project === id && paths.some((path) => made.path.endsWith(`/${path}`) || made.path === path)),
    file_changes: () => [],
    set_attention: () => null,
    resize_terminal: () => null,
    write_terminal: () => null,
    read_dir: ({ path }) => readDir(path),
    read_file: ({ path }) => {
      const text = TIDEPOOL_FILES[relative(path)];
      if (text === undefined) throw new Error(`no such file: ${path}`);
      return text;
    },
    git_file_states: () => GIT_STATES,
    git_head_file: ({ path }) => HEAD[relative(path)] ?? TIDEPOOL_FILES[relative(path)] ?? null,
    project_files: () => Object.keys(TIDEPOOL_FILES),
    file_relationships: () => [
      { path: "lib/tank/fish.dart", line: 3, direction: "outgoing", detail: "import 'fish.dart'" },
      { path: "lib/tank/pellet.dart", line: 4, direction: "outgoing", detail: "import 'pellet.dart'" },
      { path: "lib/ui/tank_view.dart", line: 9, direction: "incoming", detail: "FeedingSystem" },
      { path: "test/tank/eaten_pellet_test.dart", line: 2, direction: "incoming", detail: "FeedingSystem" },
    ],
    symbol_locations: () => [],
    project_symbols: () => [],
    warm_code_nav: () => null,
    debug_breakpoints: () => ({}),
    debug_profiles: () => [],
    debug_targets: () => [],
    debug_status: () => ({ active: false, phase: "idle", threadId: null }),
    debug_set_breakpoints: () => null,
    module_request: ({ path }) => {
      if (path.startsWith("/m/support/inbox")) return { unread: 2, items: [] };
      const name = path.split("/")[2];
      // The real host answers a module that is not installed with a 404, and the UI handles that.
      if (!["git-manager", "support"].includes(name)) throw new Error(`unknown module: ${name}`);
      console.log("[demo] unhandled module route", path);
      return {};
    },
    "plugin:event|listen": ({ event, handler }) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
      return nextId++;
    },
    "plugin:event|unlisten": () => null,
  };

  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback(callback) {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    unregisterCallback: (id) => callbacks.delete(id),
    // The Windows form of a custom scheme. capture.mjs answers these hosts with mock-media.mjs.
    convertFileSrc: (path, protocol = "asset") => `http://${protocol}.localhost/${encodeURIComponent(path)}`,
    async invoke(cmd, args = {}) {
      const answer = COMMANDS[cmd];
      if (answer) return answer(args);
      if (cmd.startsWith("plugin:")) return null;
      console.log("[demo] unhandled", cmd, JSON.stringify(args).slice(0, 120));
      return null;
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__panelDemo = { play, emit };
})();
