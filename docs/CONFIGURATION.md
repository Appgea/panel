# Configuration reference

Every file Panel reads or writes, every key it honours, and where each one lives. Read-only vs writable
roots are explained in [`next/README.md`](../next/README.md#two-roots); command-level behaviour is in
[BACKEND.md](BACKEND.md).

## 1. Directory map

### Resources root — shipped, **read-only**
Bundled: `Contents/Resources/host` (macOS) / `host\` next to the NSIS install. From a checkout: `panel/host`
(found via `PANEL_HOME` → `next/`, `host/` beside it). Contains the hook forwarder, MCP server, sender,
module hosts and `ops-template/`. Never written to.

### User root — yours, **writable**: `~/.appgeapanel` (override: `PANEL_USER_HOME`)

```
~/.appgeapanel/
├─ config.json            the portfolio (§2)
├─ ingress-port           loopback port of the running app (deleted on clean exit)
├─ modules.json           {"version":1,"installed":[…]} — which extensions are on (§5)
├─ modules/<name>/        extensions you dropped in (win over a shipped one of the same name)
├─ state/<module>/        each module's private writable dir (PANEL_STATE_DIR); secrets/, caches, jobs
├─ ops/                   your ops tree ("brain") — seeded from ops-template, never overwritten (§4)
├─ brain/
│  ├─ reports/<project>.md   append-only agent reports (send_to_user prose)
│  └─ projects/<hex(id)>/desk.md   Project desk file
├─ skills/                shared workflows (SKILL.md), linked into agent skill dirs
│  └─ …                   migration journals under state/skills/migrations
└─ (legacy) ~/.appgeabridge → linked here on first launch if this folder doesn't exist
```

### Other locations
| path | what |
|---|---|
| `~/.appgea/notes.md` | the private Notebook |
| `~/.panel/leases.json`, `leases.lock` | device leases shared with `common/lease.py` |
| OS app-local-data `wall.json` | saved terminal wall (consumed once on restore) |
| `$TMPDIR/panel-paste/` | pasted clipboard files |
| `$TMPDIR/appgea-panel-{settings,mcp}-<instance>.json` | per-agent launch files |
| `~/.claude/skills`, `~/.codex/skills` (legacy), `~/.agents/skills` | where shared workflows get linked |
| macOS Keychain `com.appgea.panel.revenuecat` | RevenueCat keys |
| webview localStorage | `panel-keymap`, `panel-prefs`, `panel-terminal-layout`, `panel-wall-cols`, `panel-settings-section`, review queue |

**Start fresh:** quit Panel, rename `~/.appgeapanel` (and `~/.appgeabridge` if present, or it is linked again).

## 2. `~/.appgeapanel/config.json`

Created on first run as `{opsRoot:"", groups:[], projects:[], devRunner:"", plainView:true, disabledModules:[]}`.
Panel does a **read-modify-write of the whole document**, so keys it doesn't model (written by other tools)
are preserved. It is watched: edits by you, an agent, or the folder picker update the sidebar without a relaunch.

| key | type | meaning |
|---|---|---|
| `projects` | array | registered projects (below) |
| `groups` | array | `{id, name, opsRoot, store}` — a "company". Order here = sidebar and terminal-strip order. `opsRoot` = the folder **containing** `ops/` for that group (empty ⇒ global). `store` is declared and read but nothing consumes it yet (store credentials still use the global account — per the source comment). |
| `opsRoot` | string | global ops location (folder containing `ops/`). Empty ⇒ `~/.appgeapanel` so the tree is `~/.appgeapanel/ops` |
| `devRunner` | string | absolute path of your own run script (§3, "Run") |
| `mainFolder` | string | where the **Main folder** terminal opens (wall ＋ seat). Empty ⇒ the deepest folder every project sits under |
| `plainView` | bool | present in the default file; **no reader found** in `src-tauri` or `ui/src` (unverified legacy) |
| `disabledModules` | array | present in the default file; **no reader found** (the Extensions screen uses `modules.json`) |

**Project entry**
```json
{ "id": "tidepool", "name": "Tidepool", "path": "/Users/me/apps/tidepool",
  "group": "games", "role": "leaf", "type": "generic",
  "parentId": "", "extensionId": "" }
```
- `path` required. `id` defaults to the folder name; **ids must be unique** (Add refuses duplicates by path or id). `name` defaults to `id`.
- `role`: `leaf` (default) owns terminals, files, git, runs, history, agent routing. `collection` owns only navigation and extension surfaces; it has no terminal or simulator. Starting a session on a collection is refused.
- `type`: open label; core understands `generic`; extensions add their own (e.g. `video-suite`).
- `parentId` (`parent_id` also accepted): nesting is a *navigation projection* — runtime state stays flat by project id, selecting a parent never tears down child work. Filing a collection under a group moves its children too.
- `extensionId` (`extension_id` accepted): the module owning the project's domain surface. Declaring it **forces that extension on**, and it can't be uninstalled while a project names it.
- Old entries (no role/type) read as `leaf` / `generic`.

**Single-project mode:** `appgea-panel-desktop --project <path>` or `PANEL_SINGLE_PROJECT=<path>` ignores the file and shows one synthetic project.

## 3. Per-project files (in the repo)

### `.panel/modules.json` — which tabs/modules this repo uses
```json
{ "version": 1, "enabled": ["git", "release"], "work": { "exclude": ["generated/"] } }
```
- Once present it is **authoritative** (replaces detection). `version` must be `1`. Names are trimmed and deduped; legacy `decisions`, `decision-map`, `spine` map to `product-spine`.
- Only **installed** extensions survive (`keep_installed`): enabling `release` in a repo does nothing unless the release extension is installed.
- `work.exclude`: repo-relative prefixes (forward slashes, no `..`) hidden from the Work list.
- Core surfaces (Terminals, Dashboard, Work, Debug) are always on.

**Without the file**, Panel detects — a tab you can't act on is worse than a missing one:

| module | enabled when |
|---|---|
| `product-spine` | always (baseline) |
| `git` | `.git` at the root or one level in (monorepo) |
| `release` | a `Podfile`, `build.gradle(.kts)`, `Appfile` or `project.pbxproj` within 3 levels; or a Godot project with an iOS/Android export preset |
| `revenuecat` | a RevenueCat dependency in `pubspec.yaml`/`Podfile.lock`/`Package.resolved`/`project.pbxproj`, or `purchases_flutter` in `pubspec.yaml` |
| `analytics` | `firebase_options.dart`, `GoogleService-Info.plist`, `google-services.json` or `firebase.json` |

A folder with `workspace.yaml` (a media workspace) is treated as content: only baseline + `git`.
Walks are bounded (3 levels, skipping `build/ Pods/ DerivedData/ node_modules/ .git` etc.).
RevenueCat is described as opt-in in its README; in practice detection or the manifest turns it on.

### `.panel/debug.json` — debug adapters
```json
{ "version": 1, "configurations": [{
  "id": "native", "name": "Native binary",
  "adapter": ["xcrun", "lldb-dap"], "type": "lldb-dap", "request": "launch",
  "program": "${workspaceFolder}/build/app" }] }
```
`${workspaceFolder}` expands before launch; all other keys pass to the adapter as its launch configuration.
Flutter/Dart profiles are added automatically. Breakpoints are stored in Panel's user state, never in the repo.

### `.panel/revenuecat.json`
`{"version":1, "project_id":"proj…", "currency":"USD", "revenue_type":"proceeds"}` — non-secret only.
Keys: Keychain (`com.appgea.panel.revenuecat`), or `REVENUECAT_API_V2_KEY`, or a project `.mcp.json` / Claude MCP RevenueCat Bearer (read in-process, never copied).

### `appgea.json` — how to run this app (read by `sim.rs`, `android.rs`, `projects.rs`)
| key | meaning |
|---|---|
| `appType` | `flutter` · `native` · `godot` · `electron` — **a hint, not the last word**: the filesystem must back the claim (`pubspec.yaml`, `project.godot`, `package.json`, Xcode container/XcodeGen spec) or detection falls through |
| `subpath` | app lives in a subfolder |
| `server` | `{command, port, path?}` — declares a dev server. **Port is required** and the command must pin it (e.g. vite `--strictPort`). Beats everything else |
| `ios` | `{path, generator?}` — native project dir; `generator:"xcodegen"` |
| `godot` | `{runArgs:[…]}` e.g. `["--phone"]` |
| `androidPackageName` / `androidApplicationId` / `playStoreId` | Android package for install/launch (else parsed from `build.gradle`) |
| `iosBundleId` | iOS bundle id, must contain a `.` (else read from the `.xcodeproj`) |

Detection order when no hint decides: `pubspec.yaml` → Flutter; `project.godot` → Godot; native Android (gradlew/settings.gradle + app/build.gradle) → Android; XcodeGen spec or `.xcodeproj/.xcworkspace` in root or `ios/` → native iOS; else ask `devRunner`.

### `devRunner` contract
Your script is asked `<script> kind` (prints a kind for the project, or nothing ⇒ not runnable) and then started with `<script> run`. It covers anything Panel doesn't detect (node, rust, tauri, go, python, docker compose, static sites, a Makefile target…). Empty `devRunner` ⇒ Run covers only the kinds above.

## 4. The ops tree (`~/.appgeapanel/ops/`)

Copied from `host/ops-template/ops` on first run; **never overwritten**. It holds *durable facts and standing rules and nothing derivable from git*. The Manager agent runs rooted here.

| file/dir | purpose |
|---|---|
| `AGENTS.md` | the Manager's standing prompt (editable on the Manager screen; resettable). Read by every CLI; a `CLAUDE.md` symlink beside it supports older Claude builds |
| `now.md` | what's in flight and **Blocked on you** (cap ≈ 40 lines) |
| `company.md`, `principles.md`, `para.md` | identity, standing rules, filing rule ("file by actionability, not topic") |
| `portfolio.yaml` | one keyed row per product (`name, dir, kind, status, stores, bundle_id, monetization, revenuecat, depends_on, serves, notes`) + ranked `focus:`. **The sidebar's `Shipping/Live/…` lanes read `status`** (`idea\|building\|review\|releasing\|live\|paused\|archived\|unknown`) matching a project by its folder against `dir` (nearest folder wins) |
| `apps/<key>.md` | per-app durable facts (templates under `_template.md`) |
| `decisions/index.md`, `decisions/<year>.md` | one line per decision (always loaded) / the reasoning (pulled on demand) |
| `sprints/<id>.md` | frontmatter window + `focus:` order, `## Goals` checklist (`- [ ] <app\|-> \| <you\|cpo> \| <goal> [done-when: …]`, `[x]` done, `[!]` blocked), `## Log` |
| `rollouts/`, `runbooks/`, `work/`, `backlog.md`, `log/<year>.md`, `metrics/`, `behavior/` | cross-app work, executable procedures, ledgers |
| `standards/` | markdown standards; conformance is derived at call time (Standards card) |
| `setup/` | hooks (`guard-vault.sh`), skills (`showcase`, `taste`), vault scripts, `autopilot.js` workflow, `settings.json.tmpl` — the scaffold `setup.sh` installs for CLI use |
| `_system/` | `friction.md`, `taste.md`, `sweep.py` |

Rules the template states: one line per thing; close with the outcome, not the story; ask before store submit/publish, price, production release, spending, credential swap, or changing what a product is.

## 5. Extensions

`~/.appgeapanel/modules.json`: `{"version":1,"installed":["git-manager",…]}`. Seeded once: a **fresh** install gets only `git-manager`; an **upgrade** from an older Panel keeps every discovered module. Dropping a folder with a valid `module.json` into `~/.appgeapanel/modules/` counts as installing it. Manifest format and shipped modules: [MODULES.md](MODULES.md).

## 6. Environment variables (summary)

| var | where | effect |
|---|---|---|
| `PANEL_USER_HOME` | app, tests, modules | replaces `~/.appgeapanel` |
| `PANEL_HOME` | dev | `next/` dir used to locate `host/` when unbundled |
| `PANEL_SINGLE_PROJECT` | app | single-project mode |
| `PANEL_MAX_SIMS` | app | cap on booted simulators |
| `PANEL_MODULE_TIMEOUT_SECONDS` | app | module process timeout (default 60) |
| `PANEL_NO_PATHFIX`, `PANEL_SELFTEST` | app | skip login-PATH import; headless spawn test |
| `PANEL_PORT`, `PANEL_INSTANCE`, `PANEL_SEND` | agent env | set by Panel for hosted agents |
| `PANEL_STATE_DIR` | module env | its writable dir |
| `PANEL_PRIVATE=1`, `PANEL_SIGN_IDENTITY` | build | ship private modules; macOS signing identity |
| `PANEL_FROZEN=1` | `dev.command` | same as `--no-watch` |
| `SUPPORT_ENABLE_ADC=1` | support module | allow gcloud ADC |
| `REVENUECAT_API_V2_KEY` | revenuecat module | unattended key |

