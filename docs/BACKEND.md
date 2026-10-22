# Backend reference (Rust / Tauri)

Source: `next/apps/desktop/src-tauri/src/`. Everything the UI can ask the OS to do goes through the
**98 `#[tauri::command]` handlers** listed in [§3](#3-command-reference). The crates they build on
(`panel-core`, `panel-ingress`, `panel-terminal`, `panel-store`) are in [ARCHITECTURE.md](ARCHITECTURE.md).

## 1. Composition (`main.rs`)

`main()` order:

1. **PATH fix.** Non-Windows: `ensure_login_path()` runs the user's login shell to copy its `PATH`
   (a Finder/Dock launch inherits only launchd's). Skipped when `PANEL_NO_PATHFIX` is set.
2. **HOME fix.** Windows: if `HOME` is unset, set it to `USERPROFILE` (everything Panel owns hangs off `HOME`).
3. **Self-test.** `PANEL_SELFTEST` set → `selftest()` spawns each agent kind through the real PTY path, prints one line per kind, exits non-zero if any fails. No window.
4. **Tauri builder** with `dialog` + `notification` plugins, three **URI schemes** (below), `setup`, the 98 handlers, and the lifecycle guard.

`setup`:

1. If a bundled `resource_dir/host` exists, `paths::init_resources()` points the resources root at it.
2. `paths::migrate()` (legacy `~/.appgeabridge`, `~/.appgea/brain` moves; returns whether it upgraded).
3. `modules::seed_installed()` — extensions ship dormant; fresh installs get only the ones needing no credential/toolchain.
4. `Ingress::serve(event_sink)` — binds `127.0.0.1:<ephemeral>`; every existing project is `register_project`ed.
5. Writes the port to `~/.appgeapanel/ingress-port` (removed on clean exit).
6. `app.manage(DesktopState{…})`, then `watch_portfolio` and `watch_sprints` (see §4).

`DesktopState`: `terminals` (`Mutex<TerminalManager>`), `debugger` (`Arc<DebugManager>`), `ingress`, `sessions` (`Mutex<HashMap<id, Session>>`), `sims` (live runs, `Arc<Mutex<…>>`), `panel_home` (resources root), two shutdown `AtomicBool`s, `made` (media watcher).

`Session { id, project, kind, title, terminal_id, cwd, instance(skipped in JSON) }`. A project holds **many** sessions; they are keyed by their own id, never by project.

**Threading rule.** Anything that touches the world (fs, git, subprocess, PTY spawn) is an `async fn` that hands its body to `off_main()` (`spawn_blocking`). Pure in-memory commands (mutex/map reads, a PTY write) stay sync on purpose — `write_terminal` runs on every keystroke.

**URI schemes** (all answered on blocking threads):

| scheme | serves | confinement |
|---|---|---|
| `project-icon://` | a project's app icon | only registered project ids; only files discovered inside that project |
| `project-asset://<projectId>/<path>` | read-only project media (images/audio/video, byte-range + ETag aware) | first segment = registered project id; remainder canonicalized and must stay under the project root; request origin must pass `app_origin()` (only the app page itself) |
| `module://panel/m/<name>/<sub>` | a module's one-shot host, e.g. Product Spine's HTML | served at the exact `/m/<name>` path shape modules emit links for; nothing listens on a port |

**Shutdown guard.** Window close and app quit both call `guard_shutdown`: unless `shutdown_approved`, it emits `panel-shutdown-requested` (payload: live sessions) once (`shutdown_prompt_pending`) and **prevents** the close. Fail-closed: if the webview can't receive the event, Panel stays open. The UI answers with `shutdown_panel` (approve) or `cancel_shutdown`. `shutdown_panel` unroutes the ingress, reaps every PTY, stops all debuggers, sets approved, then exits.

**Single-project mode.** `--project <path>` or `PANEL_SINGLE_PROJECT=<path>` makes the portfolio a single synthetic project (id = folder name, no group). `launch_context` tells the UI.

**The Manager.** `CPO_ID = "appgea"` is a pseudo-project: not in the portfolio, no dashboard/modules/git; its folder is the ops tree. `start_session` on that id resolves via `cpo_root()` and launches with `Role::Manager`. Its standing prompt is `<ops>/AGENTS.md`.

## 2. Tauri events (backend → UI)

| event | payload | emitted by |
|---|---|---|
| `panel-agent-event` | `ProjectEvent {project, …PanelEvent}` (see [PROTOCOL.md](PROTOCOL.md)) | ingress sink; `message` visuals are first filed to the brain (`reports::file`) and get `_panel_note` |
| `panel-terminal-output` | `TerminalChunk` | every session PTY |
| `panel-run-output` | `TerminalChunk` | sim/run PTYs |
| `panel-shutdown-requested` | `Vec<Session>` | `guard_shutdown` |
| `panel-portfolio-changed` | `()` | `config.json` changed on disk |
| `panel-sprints-changed` | `()` | any `*.md` under `<ops>/sprints/` changed |
| `panel-made` | `Made` | new finished media file in a watched project (`made.rs`) |
| `panel-debug-event` | DAP event | `debug.rs` |

Both watchers debounce: after the first event they drain the burst until 200 ms of quiet, then emit once.

## 3. Command reference

Args are JSON-camelCase on the wire (`project_id` → `projectId`). `P` = project id string. "off-main" = async/blocking pool.

### Launch, manager, desk, sprints, notebook

> The `sprint_*` commands, `sprints.rs` and the `panel-sprints-changed` watcher are live in the backend, but the only UI caller is `features/sprint.ts`, whose `mountSprint` is not imported anywhere in `ui/src` (grep). The sidebar **Project desk** button mounts `project_desk` instead. So the Sprint screen is currently unreachable from the UI; the Manager can still read/write sprint files directly.

| command | args → returns | what it does |
|---|---|---|
| `launch_context` | → `{single_project?}` | Is this a single-project Panel. Sync. |
| `cpo_preprompt` | → `String` | Read `<ops>/AGENTS.md` (the Manager's live prompt). |
| `set_cpo_preprompt` | `text` | Overwrite it. |
| `reset_cpo_preprompt` | → `String` | Restore shipped `ops-template/ops/AGENTS.md`, return it. |
| `project_desk` | `project` → `Desk` | Local release evidence + project memory docs, no agent. |
| `project_desk_overview` | → `Vec<Overview>` | Same for the whole portfolio; git work in batches of 4 repos. |
| `project_desk_save` | `project, path, text, expect` → `Desk` | Save a desk document; `expect` = prior content (stale-save protection). |
| `sprint_board` | → `Board` | Parse `<ops>/sprints/*.md`; active sprint derived from dates; goal "in flight" derived from live sessions. |
| `sprint_set_goal` | `sprint, index, text, state` | Rewrite one goal line. Only `done`/`blocked`/`todo` are ever written. |
| `sprint_add_goal` | `sprint, app, owner, text, done_when` | Append a goal. |
| `sprint_log` | `sprint, text` | Append to `## Log`. |
| `sprint_read` / `sprint_write` | `sprint` / `sprint, text, expect` | Raw file read; stale-protected write. |
| `sprint_create` | `id, title, starts, ends, focus[]` → `Sprint` | New sprint file. |
| `read_notebook` / `save_notebook` | → `String` / `text` | The private Markdown notebook (`~/.appgea/notes.md` — deliberately outside the user root; never a project, ops tree, agent context or MCP resource). Never exposed to agents. |

### Portfolio and projects

| command | args → returns | what it does |
|---|---|---|
| `list_projects` | → `Vec<Project>` | Read `config.json`, stat each folder. |
| `list_groups` | → `Vec<Group>` | Groups in file order (= sidebar order). |
| `set_project_group` | `project, group` | File a project under a group (`""` = none). Writes `config.json`. |
| `add_group` | `name` → `Vec<Group>` | New group (`{id,name,opsRoot:"",store:{}}`). |
| `project_modules` | `project` → `ProjectModules` | Enabled per-project modules (`.panel/modules.json` or detected). |
| `add_project` | `path, name?` → `Project` | Register; read-modify-write of the whole config document. |
| `pick_project_folder` | → `Option<String>` | Native folder dialog. `None` = cancelled. |
| `open_project_folder` | `project, path?` | Open root (or a confined child) in the OS file manager. |
| `open_revenuecat_setup` | `project_id?` | Open the RevenueCat key page. |
| `project_dashboard` | `project` → `GitState` | One `git status` → branch, drift, dirt. |
| `project_standings` | → `Vec<Standing>` | Each project's row in its company `portfolio.yaml`. |
| `project_activity` | `project` → `Activity` | Two weeks of commits. |
| `project_working_set` | `project` → `Vec<WorkFile>` | Git-derived working set (fallback when no worklist declared). |

### Git

| command | args → returns | what it does |
|---|---|---|
| `git_overview` | `repo, limit?` → `GitOverview` | Status + branches + remotes + commit graph in one native pass. |
| `git_file_states` | `project` → `{path: state}` | Every dirty path, for tree decorations. |
| `git_head_file` | `project, path` → `Option<String>` | File at `HEAD` (change gutter). `None` = untracked/unborn. |

Mutating git actions (commit, push, pull, …) are **not** commands; they go through `module_request` to the `git-manager` module.

### Sessions and terminals

| command | args → returns | what it does |
|---|---|---|
| `list_sessions` | → `Vec<Session>` | All live sessions. Sync. |
| `start_session` | `project, kind, cols, rows, cwd?` → `Session` | **Adds** a session (never replaces). `kind` = `shell` or an agent binary. Binds the agent in the ingress *before* spawning. Bad/vanished `cwd` falls back to the project root. Collections are refused. |
| `restore_wall` | `cols, rows` → `RestoredWall` | Re-fork every saved terminal with the same ids, resume flags, and saved screen. The snapshot file is **consumed** (read, deleted, then spawned) so a crash mid-restore can't double-launch. |
| `stop_session` | `session` | Close one session (kills the process tree). |
| `session_cwd` | `session` → `Option<String>` | Live cwd of the shell, asked of the OS (macOS/Linux; `None` if unknown → UI falls back to root). |
| `session_busy` | `session` → `bool` | Is anything running in the foreground? Foreground process-group ≠ spawned pid. Errs toward `true`; unknown session → `false`. |
| `write_terminal` | `terminalId, data` | Keystrokes → PTY. Sync. |
| `resize_terminal` | `terminalId, cols, rows` | PTY resize. |
| `close_terminal` | `terminalId` | Take under lock, end outside it. |
| `save_pasted_file` | `data, name?, ext` → path | Park clipboard bytes in `$TMPDIR/panel-paste`; UI types the path into the PTY. Name/ext sanitized; cannot leave the paste dir. |
| `clipboard_text` | → `String` | Clipboard text for right-click Paste. |
| `answer_ask` | `qid, value` → `bool` | Resolve a parked `ask_user`; `false` if already closed. |
| `set_attention` | `count, alert?` | Dock badge = count; notification only when Panel isn't the focused window. |
| `cancel_shutdown` / `shutdown_panel` | — | See guard above. |

Agent launch (inside `start_session`): `kind_program()` maps `opencode-kimi-k3` / `opencode-deepseek-v4-flash` to `opencode --model …`; every other kind execs the binary of the same name. Order of argv: resume flags → model args → Panel wiring (`launch.rs`) → skill-session args. Env injected: `PANEL_PORT`, `PANEL_INSTANCE`, `PANEL_SEND` (path to `panel_send.py`). Wiring: `claude` → `--append-system-prompt`, `--settings` (hooks), `--mcp-config`; `codex` → `-c mcp_servers.appgea-panel.*` + `developer_instructions`; `grok` → `--rules`; others get env only. See [ARCHITECTURE.md §4](ARCHITECTURE.md).

### Files, editor, code navigation (all confined to the project)

| command | args → returns | what it does |
|---|---|---|
| `read_dir` | `project, path` → `Vec<DirEntry>` | One level, dirs first. Hides dotfiles and `node_modules, target, build, dist, Pods, DerivedData, __pycache__, venv`. |
| `project_files` | `project` → `Vec<String>` | Every file (relative), for ⌘P and the filter box. |
| `read_file` | `project, path` → `String` | UTF-8 text, **max 2 MB**. |
| `write_file` | `project, path, contents` | Overwrite. |
| `ensure_document` | `project, path, contents` → path | Create a text handoff only if absent. |
| `create_entry` | `project, path, is_dir` → path | Refuses to overwrite. |
| `rename_entry` | `project, from, to` → path | Target must not exist. |
| `delete_entry` | `project, path` | File or folder; refuses the project root. UI confirms first. |
| `reveal_entry` | `project, path` | Finder / Explorer `/select,` / parent folder on Linux. |
| `file_changes` | `project, path` → `Vec<ChangeStep>` | Replay history (memory-only, from the edit hooks). Sync. |
| `file_relationships` | `project, path` → `Vec<FileRelation>` | RELATED row: import/path edges + type-use edges. |
| `warm_code_nav` | `project` | Pre-parse for the Related row; re-reads only changed files. |
| `symbol_locations` | `project, path, symbol` → `Vec<SymbolLocation>` | Cross-language definition lookup; ambiguity returned, not guessed. |
| `project_symbols` | `project` → `Vec<ProjectSymbol>` | All declared names (colouring, Open Quickly). |
| `search_project` | `project, query, case_sensitive, whole_word` → `SearchResult` | Plain-text search. |

### Debugging

| command | args → returns | what it does |
|---|---|---|
| `debug_profiles` | `project` → `Vec<DebugProfile>` | `.panel/debug.json` + automatic Dart/Flutter profiles. |
| `debug_targets` | `project` → `Vec<Target>` | Devices a profile can launch on. |
| `debug_status` | `project` → `DebugStatus` | Sync. |
| `debug_breakpoints` | `project` → `{path: [lines]}` | From Panel's user state, never the repo. |
| `debug_set_breakpoints` | `project, path, lines[]` | Persist (and push to a live adapter). |
| `debug_start` | `project, profile, target?` → `DebugProfile` | Spawn the adapter (one per project). |
| `debug_request` | `project, command, arguments` → `Value` | Raw DAP request. |
| `debug_stop` | `project` | End the adapter. |

### Run, devices, leases

| command | args → returns | what it does |
|---|---|---|
| `start_sim` | `project, device?, allow_extra?, extra_instance?, restart?, fresh?, cols, rows` → `SimStart` | Run the project on a **target address** in a PTY (`flutter run`, native build, Godot…). **One run per project**: a second call returns the live run unless `extra_instance` or `restart`. `fresh` uninstalls the app first. Takes a device **lease**. Not registered with the ingress. Hot reload = `write_terminal(id,"r")`. |
| `run_inventory` | → `RunInventory` | One portfolio scan: devices + leases + project bindings. |
| `sim_targets` | → `Vec<SimTarget>` | Which projects are runnable (same detection as the run plan). |
| `list_simulators` | → `Vec<SimDevice>` | `simctl` inventory. |
| `android_targets` | → `Vec<Target>` | `adb` devices + AVDs (separate: `adb` may be absent). |
| `device_leases` | → `{address: Lease}` | Who holds what. |
| `close_idle_sims` | → `usize` | Shut down every simulator nobody leases (re-checks the lease per device). |
| `sim_focus` | `address?` | Raise that device's window (no address → Simulator.app). Fire-and-forget. |
| `open_server` | `project` | Open the page a running dev server serves. |
| `open_link` | `url` | Open a web URL (validated by `web_link`). |
| `open_media` | `project, path` | Hand a file to the OS player. |

`PANEL_MAX_SIMS` caps simultaneously booted simulators (`capacity_check`).

### Skills

| command | args → returns | what it does |
|---|---|---|
| `skills_catalog` | `session?` → `Vec<SkillEntry>` | Disk inventory (personal, project, shared, plugin). |
| `skills_read` / `skills_read_document` | `path` | Text / parsed `SKILL.md`. |
| `skills_save` | `path?, name, description, body, expected?, department?` → `SkillEntry` | Create/edit a shared workflow under `~/.appgeapanel/skills/`; stale-save protected. |
| `skills_archive` | `path` | Remove only Panel-owned links; keep the source. |
| `skills_resources` / `skills_resource_read` / `skills_resource_save` | `path[, relative[, content, expected?]]` | Supporting Markdown beside a skill. |
| `skills_session_policy` | `session` → `Policy` | Default/Enabled/Disabled per skill for this terminal. |
| `skills_session_set` | `session, path, enabled?` → `Policy` | Stage a choice (pending). |
| `skills_session_restart` | `session, cols, rows` → `Session` | Apply: restart that terminal with the policy (Claude `skillOverrides`; Codex `skills.config` `-c`). Never `--last`. |
| `skills_usage` | `session` → `Value` | "Used this session" evidence from Claude Skill hooks. Codex = unknown. |

### Extensions (host modules)

| command | args → returns | what it does |
|---|---|---|
| `list_modules` | → `Vec<Module>` | Installed manifests with chat assets inlined. |
| `module_catalog` | → `Vec<CatalogEntry>` | Every extension shipped, installed or not, with what it needs and what's missing. |
| `install_module` / `uninstall_module` | `name` → catalog | Local record only (public modules ship inside the app). User-dropped modules: remove the folder to uninstall. State under `~/.appgeapanel/state/<name>` is left alone. |
| `module_request` | `path, method?, body?` → `Value` | JSON call into a module (`/m/git-manager/graph?repo=…`). **Spawns one Python process per call.** |

## 4. Rust modules

| file | purpose / notes |
|---|---|
| `paths.rs` | The two roots (see [CONFIGURATION.md](CONFIGURATION.md)). `migrate()` moves legacy dirs; creates `config.json` skeleton `{opsRoot:"", groups:[], projects:[], devRunner:"", plainView:true}`. |
| `projects.rs` (2015 lines) | Portfolio registry (`config.json`), typed projects (`role` leaf/collection, `type`, `parentId`, `extensionId`), groups, per-project modules, all native git snapshots (`GitState/GitOverview/GitGraph`), working set, app icon discovery. Atomic read-modify-write of the whole document so foreign keys survive. |
| `launch.rs` | Builds per-launch `--settings`/`--mcp-config` JSON in the temp dir (`appgea-panel-settings-<instance>.json`, `appgea-panel-mcp-<instance>.json`); `Role::{Worker,Manager}` rules; Codex `-c` overrides; Grok `--rules`. Missing shim → flag omitted → plain agent still launches. |
| `modules.rs` | Manifest loader (bundle first, then `~/.appgeapanel/modules`; user copy of a shipped name wins), catalog/install state (`~/.appgeapanel/modules.json`), `cgi-argv` one-shot protocol: `argv = <interp> <exec> METHOD PATH [args…]`, cwd = module root, stdin = body, stdout = `status\ncontent-type\n\nbody`. Runs `.py` hosts as `python -B <exec>` (no bytecode in the signed tree), sets `PANEL_STATE_DIR` and `PANEL_USER_HOME` for the child, kills it after `PANEL_MODULE_TIMEOUT_SECONDS` (default 60). Modules that emit absolute `/m/<name>/…` links get `--base-path` through their manifest `args` (the shipped manifests here have empty `args`, so unverified for the unshipped ones). |
| `sim.rs` (1959) | Run plans for Flutter / native iOS / Godot / server projects; simctl boot/clone/uninstall; PTY lifecycle parsing → `sim` visual events; bundle-id detection. |
| `android.rs` | `adb`/`emulator` (never bare PATH — Finder launches lack the SDK); emulators addressed by **AVD** (`android:@Small_Phone`), phones by serial. |
| `targets.rs` | One address scheme: `iphone:<udid>` `ipad:<udid>` `ios:<udid>` `android:@<avd>` `android:<serial>` `chrome` `macos` `desktop`. Families offered per project are *derived* (no `web/` → no Chrome row). Singletons (Chrome/Mac) are single-occupancy. |
| `leases.rs` | Device broker. Store `~/.panel/leases.json` + `leases.lock`, byte-compatible with `common/lease.py` so out-of-app screenshot pipelines respect it. Liveness = holder pid; no TTL, no daemon. |
| `debug.rs` | DAP host: framed JSON over pipes, one adapter per project, `.panel/debug.json`, breakpoints in user state. |
| `code_nav.rs` | Not an LSP. Import/path graph + type-use fallback (Swift), symbol table, project search. |
| `made.rs` | FSEvents/notify watcher on projects with a session; announces finished media after a quiet period; skips build output. |
| `pulse.rs` | Sidebar facts: `portfolio.yaml` standing + 2-week commit activity. |
| `reports.rs` | Appends an agent's `message` prose to an append-only per-project Markdown log under `<user>/brain/reports/`; Inbox keeps headline + media only. |
| `sprints.rs` | Markdown sprint parser / line rewriter (no second store). |
| `skills.rs`, `skill_sessions.rs` | Skill inventory/edits; per-session policy applied **at process launch only**. |
| `project_desk.rs` | Release evidence + project docs without an agent. |
| `notebook.rs` | One private Markdown file. |
| `ops.rs` | Which folder is the ops tree for a project (group `opsRoot` → global `opsRoot` → `~/.appgeapanel/ops`). |
| `platform.rs` | The few Windows/Unix differences: `command()`, `python()`, `open()`, `pid_alive()`, `on_path()`, dir symlink/junction helpers. |

## 5. Environment variables the backend reads

| var | effect |
|---|---|
| `HOME` | Root of everything (`USERPROFILE` fallback on Windows). |
| `PANEL_USER_HOME` | Overrides the user root (`~/.appgeapanel`). Used by tests; honoured in release code. |
| `PANEL_NO_PATHFIX` | Skip login-shell PATH import (non-Windows). |
| `PANEL_SELFTEST` | Headless spawn test, then exit. |
| `PANEL_SINGLE_PROJECT` | Single-project mode (same as `--project <path>`). |
| `PANEL_MAX_SIMS` | Cap on booted simulators. |
| `PANEL_MODULE_TIMEOUT_SECONDS` | Per-call timeout for a module process (default 60). |
| `PANEL_HOME` | Dev only: the `next/` dir used to find `host/` when not bundled. |
| `PANEL_STATE_DIR` | Handed to each module as its writable dir (`~/.appgeapanel/state/<module>`). |
| `PANEL_PORT`, `PANEL_INSTANCE`, `PANEL_SEND` | Set *for agents*, not read by the app. |
| `PANEL_PRIVATE=1` | Build-time: ship non-public modules ([ARCHITECTURE.md §6](ARCHITECTURE.md)). |
| `SHELL` | Used by the PATH fix and `selftest`. |

Test-only: `PANEL_PATHS_TEST_*`, `PANEL_MODULE_T*`, `PANEL_DEBUG_*` appear in tests (unverified whether any are read in release code paths).

## 6. Security model

- **Webview CSP** (`tauri.conf.json`): scripts only from self + `module:`; frames only `module:`; images/media only from self, `project-icon:`, `project-asset:`, `module:`; connect only IPC, the dev server, `module:`, `project-asset:`.
- **Capabilities** (`capabilities/default.json`): window `main` gets only `core:default`, `core:event:default`, `core:window:allow-set-theme`. Everything else is a custom command.
- **File sandbox.** `confine()` canonicalizes *before* checking `starts_with(root)`, so `../../..` and symlink escapes fail. `confine_new()` (create/rename targets) checks the nearest existing ancestor and rejects absolute paths, `..`, and drive prefixes. Every editor, search, code-nav, replay and media command goes through one of the two.
- **Loopback only.** The ingress binds `127.0.0.1` on an ephemeral port; modules are served through an in-process URI scheme. Nothing listens off-machine.
- **Read-only vs writable.** The resources root (bundle `host/`) is never written. A module never writes beside its own code; it gets `PANEL_STATE_DIR`.
- **Credentials** never enter the webview: RevenueCat keys go to the OS keychain via stdin; Support/Analytics keys stay in the module's state dir.
- **Fail-open for agents.** The hook forwarder exits 0 on any error; a missing shim omits its flag. A broken Panel never blocks an agent turn.


