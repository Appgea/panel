# Appgea Panel

The admin panel for the portfolio, with an editor built for shared authorship.

Panel manages many apps at once. Agents run in real terminals across several projects
simultaneously; Panel watches them, tells you which one needs you, and hands you the few files
you actually have to touch.

This file used to say "Not an IDE." The Work tab outgrew that. The line stays deleted rather than
softened, because half the design decisions below were made under it and would be made differently
now. The scope that replaces it is narrower and harder: not an editor for everyone, but the editor
for a human sharing a repository with an agent. `WORK.md` is that surface's own plan.

## Two ideas

**1. Agents are hosted, not driven.** `claude` runs in a real PTY, launched exactly as it would
be in any terminal — no wrapper, no side protocol, nothing to desync. Panel only ever *observes*
it. There is no control channel that can break, because there is no control channel.

**2. The project is the unit.** The sidebar is the portfolio, and that is the main navigation.
Each project owns an agent, a working set, a stage and an ambient feed. Selecting a project
changes what you SEE; it never tears down what is RUNNING. Tavla and Sudokov can both be working
while you read Payee. The sidebar sorts the portfolio into lanes by what each project asks of you,
so the rail at rest is the handful that matters today.

## The working set — the thing that is not a file tree

Panel never shows you a repo. It shows you **only the files you still have to touch, and why**:

```
YOUR TURN — 2 files
◆ lib/services/auth.dart
  add the backoff here — the retry budget is a product call
◆ lib/views/login.dart
  surface the new error state; the copy is yours
```

The agent declares that list with the `worklist` type (see `../protocol.json`) once it has done
what it can and hit something only a human should decide. Until then, Panel shows only files the
selected terminal's agent has touched since that session's latest user prompt. A new prompt clears
that session's list; switching terminals switches lists. Repository-wide dirt stays in Git instead
of mixing old or unrelated work into the current request. The `why` is the entire value.

The Work tab does not show that list. People either prompt the agent or work by hand, so its
navigator is a filter box over the project tree, and Command-P opens any file. Under the tab strip
one RELATED row shows what the open file reaches (→) and what reaches it (←), with cross-language
type usage filling the gaps where a repository has no file-level imports (notably Swift).
Command-click navigates a symbol to its definition; Command-Shift-O searches that related set.

Observation arrives on two deliberately unequal paths:

| path | source | reliability |
|---|---|---|
| **hooks** → `POST /hook/<event>` | Claude Code session hooks | fires because the tool *ran* |
| **panel** → `POST /panel/emit` \| `/panel/ask` | the agent's MCP tools | fires because the model *chose* to |

The split is the point. File edits, git moments and turn boundaries animate off hooks, so the
panel stays honest whether or not the model remembers to narrate. Only genuine questions and
things a hook cannot see go through the model.

`/panel/ask` **blocks** — the agent's tool call parks on a request thread until you answer in the
ask tray, and your answer becomes the tool's return value. That is the whole round-trip.

The `Notification` hook covers the other way an agent waits on you: a permission prompt in its own
terminal. Both make the project's dot pulse amber and say "needs you". A turn that finishes while
you look elsewhere turns the dot green and says "your turn" until you open the project. The dock
badge counts both, and a macOS notification fires when Panel is not the focused window.

## The three zones

```
┌────────────┬──────────────────────────────┐
│ PORTFOLIO  │  Dashboard │ Files │ Stage   │
│ ◉ Tavla    │                              │
│   working  │  scoped to the selected      │
│ ◉ Sudokov  │  project                     │
│   needs you│                              │
│ ○ Payee    ├──────────────────────────────┤
│ + add      │  TERMINAL — that project's   │
│            │  agent, a real PTY           │
└────────────┴──────────────────────────────┘
```

The right-hand panel that used to sit beside these is gone. Asks float in the ask tray instead.

- **Portfolio** is the navigation. The dot is the status language: dim = idle, accent = working,
  pulsing amber = *this agent is blocked on you*. You can see that a project needs you without
  being in it.
- **Dashboard** is the resting face of a project — branch, drift, dirt, agent state — plus a
  living workshop driven only by real events. One robot represents each live agent, edited or
  relevant files become stations, and verification/Git share one checkpoint.
- **Work** is the working set (above), a relationship navigator and the editor. Click a file, edit
  it, ⌘S. When the agent rewrites a file you have unsaved edits in, Panel writes nothing and
  discards nothing — it makes you choose. Click beside a line number, or press F9, to persist a
  breakpoint outside the repository. `WORK.md` holds this surface's plan; it is the one tab held
  to IDE standards, because it is the one you type into.
- **Debug** hosts Debug Adapter Protocol sessions. Flutter and Dart are automatic; the screen owns
  start, pause, continue, stepping, call stacks, variables, evaluation and adapter output. F5 opens
  it and starts the selected profile.
- **Replay** lives on an edited file station. A pre-edit hook captures the before-image and the
  post-edit hook captures the after-image; tapping the station steps through those exact edits,
  with a direct door into Files. Logs are local, memory-only and bounded per file.
- **Stage** is where the agent's deliberate visuals land (`trace`, `card`, `structure`, …).
- **Ask tray** floats over every screen while an agent is parked on a question, and leaves when
  none is. It never takes focus. A `document` ask opens a real project file or safe
  text/Markdown draft in Files, then returns its saved contents to the agent.
- **Review** collects what the agents made. While a project has a session open, `made.rs` watches
  its folder and announces each new picture, sound or video once the file stops changing. Build
  output and caches are skipped. Files one project makes within a few minutes form one batch. Flip
  through a batch and send your verdict to that project's agent, or mark it done.
- **Terminal** is the agent. A real PTY. No tmux, no ttyd, no iframe. One per project, all alive.
- **Live** is a dark map of this Mac you drag and zoom. Agents are small electrons that act out
  each step from a catalog of animation scripts, one per verb (`ui/src/features/live_script.ts`).
  A verb with no script gets one written by a headless model, untested. The owner deletes bad
  ones in the catalog view and the next sighting writes a new one. Silent projects are not drawn.
  Why: owner, 2026-11-04, "Untested is fine, current models don't need testing on everything.
  And if it is bad, I will delete ofc. So we will need a catalog of animations."

## Reuse, not rewrite

`session_hook.py` and `mcp/panel_mcp.py` in the parent Panel checkout remain thin
forwarders to `127.0.0.1:$PANEL_PORT`, and Appgea Panel answers that port in Rust instead of
Python. The hook also carries Panel's hosted-agent instance id so simultaneous terminals keep
separate turns. `protocol.json` still defines every visual type, `worklist` included.

The portfolio is `~/.appgeapanel/config.json`, read and written in place. Adding is
read-modify-write on the whole document, because other readers keep keys there that Next does not
model and must not lose. On first run it is copied out of the old in-tree `host/config.json` if
one is there.

`devRunner` is optional: the absolute path of your own run script. Run asks it `<script> kind` for
any project Panel cannot detect itself, then starts it with `<script> run`. Leave it empty and Run
covers only the kinds Panel detects.

### Typed projects

Old project entries remain valid and become `role: "leaf", type: "generic"` in memory. Typed
entries may add a stable `id`, `role`, domain `type`, `parentId`, and `extensionId`. A
`collection` owns navigation and extension surfaces. Its `leaf` children still own terminals,
files, Git, runs, history, and agent routing. Runtime state stays flat by project id; nesting is a
navigation projection, so parent selection never tears down child work.

A video suite, for example, is one `video-suite` collection with `video-workspace` children.
The child ids remain direct routing targets. The parent has no terminal or simulator capability.

## Two roots

Everything Panel ships is read-only; everything the human owns is writable. `paths.rs` is the one
place that decides which is which, and nothing else may guess.

| root | is | holds |
|---|---|---|
| **resources** | `host/`, or `Contents/Resources/host` installed | session hook, panel MCP, module hosts, schemas, `ops-template/` |
| **user** | `~/.appgeapanel` | `config.json`, `ops/`, `brain/`, `modules/`, `state/<module>/` |

A module never writes beside its own code. Panel hands each one `PANEL_STATE_DIR`, and a module
run straight from a terminal resolves the same path itself. This is not tidiness: installed, a
module's own folder is inside a signed bundle, so a cache write there works on the machine that
wrote it and fails on every other one.

`host/ops-template/` is the shape of an ops tree with none of anyone's content — schema comments,
`_template.md` files, empty indexes. It is copied to `~/.appgeapanel/ops` on first run and never
overwrites what is already there.

### Private modules

Host modules declare `"visibility": "public"` in `module.json`. Anything else stays out of a
release build. `PANEL_PRIVATE=1 launcher/build-app.sh` ships them too. Modules are loaded from the bundle first and then from `~/.appgeapanel/modules`,
so a user copy of a shipped name wins.

## Routing — the part that is easy to get wrong

An event has to reach the right project and terminal. Both shims carry our own `PANEL_INSTANCE`,
so hosted-agent routing is exact even when a project has several Claude sessions. Older hook
forwarders fall back to `cwd`, matching the deepest registered project root that contains it.
Deepest-wins, or a project nested inside another would have its events stolen by the parent. An
agent Panel did not launch resolves to nothing and is dropped: this shows the agents it runs,
not every `claude` on the machine.

The modules (`release-manager`, `product-spine`, `git-manager`) stay as CLIs and get invoked, not
ported. They are IO-bound scripts; rewriting them in Rust buys nothing and risks the money path.

## Module boundaries

- `panel-core` — the event vocabulary. Nothing else.
- `panel-ingress` — the loopback listener, the blocking-ask machinery, the replay fixture.
- `panel-terminal` — PTY ownership only.
- `panel-store` — persistence only.
- `apps/desktop/src-tauri` — composition, agent launch wiring, sandboxed file commands.
- `apps/desktop/ui` — the three zones and the renderer registries.

### Per-project modules

Dashboard and Work are Panel's core surfaces. Every other project module is repository-owned via
`.panel/modules.json`:

```json
{
  "version": 1,
  "enabled": ["git", "release"]
}
```

Once present, the manifest is authoritative for that project. The module rail, dashboard cards,
lazy module loading and fallback navigation all use the same enabled set. Projects without a
manifest get the set Panel detects from the repository.

An extension may contribute typed project tabs from `module.json` without changing Panel core:

```json
{
  "projectSurfaces": [{
    "id": "overview",
    "title": "Overview",
    "roles": ["collection"],
    "types": ["video-suite"],
    "mount": "/project?root={path}"
  }]
}
```

Panel owns the tab and iframe lifecycle. The module owns the route and page. `{id}` and `{path}`
are URL-encoded from the selected registered project. A project carrying `extensionId` requires
that extension, so its declared surface cannot be disabled behind its back.

The UI does not know what a hook is. The ingress does not know what Tauri is. The terminal does
not know what an agent is. Keep it that way.

## Debug adapters

Flutter and Dart use the debug adapters shipped by their SDKs. Other stacks declare the adapter
without teaching Panel about that language:

```json
{
  "version": 1,
  "configurations": [{
    "id": "native",
    "name": "Native binary",
    "adapter": ["xcrun", "lldb-dap"],
    "type": "lldb-dap",
    "request": "launch",
    "program": "${workspaceFolder}/build/app"
  }]
}
```

Save this as `.panel/debug.json`. `${workspaceFolder}` expands before launch. The remaining keys
pass straight to the adapter as its launch configuration.

## Adding a visual

`registerView("my-type", (payload, ctx) => element)` in `ui/src/views/`. That is all. Rust routes
by string and never inspects a payload, so there is no backend change. Same for a question kind:
`registerAsk("my-kind", (spec, answer) => element)`.

## Running it

`launcher/build-app.sh` builds and installs `Appgea Panel.app`. See the root `README.md` for
prerequisites and first-run setup. The first Rust compile takes 10-20 minutes.

Then either **Start claude** (a real agent, wired to the panel) or **Replay fixture** — a scripted
turn that drives the exact same event stream with no model and no tokens. Build views against the
fixture; it is why it exists.

### Developing with hot reload

The `.command` above runs the static production build, so every edit needs a full rebuild and
relaunch. To iterate, run **`./dev.command`** (`cargo tauri dev`) instead:

- **Frontend edits** (TS / HTML / CSS in `apps/desktop/ui`) hot-reload live via Vite HMR — no
  restart, and the Rust process keeps its agents, terminals and broadcasts, so **open sessions
  survive**.
- **Config the Rust reads per call** (e.g. `.panel/modules.json`) is already live — refresh
  the view, no restart.
- **Rust edits** (`src-tauri`, `crates/*`) are native code and cannot hot-swap; they recompile and
  restart the app, dropping in-process sessions. Run `./dev.command --no-watch` to ignore Rust
  edits while you work the frontend, then restart when you actually want the Rust change.

Rule of thumb: keep logic that changes often in the frontend or in disk-read config so it reloads
live; reserve Rust for the parts that rarely change.

## Checks

- `cargo test --workspace` — includes a real PTY round trip, the blocking-ask round trip, and the
  ask timeout that stops a silent UI from hanging an agent forever.
- `cd apps/desktop/ui && npm run check` — type-checks the interface.

## The motion budget

The old Panel was replaced because it ate CPU. A dashboard that chugs while the agent works is
worse than no dashboard — it steals the machine from the thing you care about.

- **Allowed:** `transform`, `opacity`, `filter`. Canvas for anything continuous.
- **Banned:** animating width/height/top/left, animating box-shadow, a DOM node per token,
  `setInterval` repaint loops, rAF that keeps running while nothing moves.

The panel's canvas stops its render loop entirely when idle. If something spins the fan, it is a
bug, not a tradeoff.

## Skills and shared workflows

Open **Skills** from a Claude or Codex terminal header, the project session strip,
or Settings. The session picker includes the engine, project, and terminal title.
The library lists local skill definitions with their provider and source path.
Plugin entries are read-only disk inventory and can include inactive cached versions.
Company, Legal, Design, and General headings group the library. Department filters
keep each list short. Supporting Markdown references can be opened, added, and
edited beside the instructions, with stale-save protection.

Create a shared workflow with a name, description, trigger, steps, and expected output.
Panel stores its `SKILL.md` under `~/.appgeapanel/skills/`. Shared workflows can be
edited, archived, restored, or staged into either agent's terminal. Saving connects
the same folder to Claude's personal skills, Codex's legacy personal skills, and
`~/.agents/skills`. Canonical paths collapse duplicate discovery links in Panel.
Archiving removes only those owned links and preserves the source. Existing
conversations can retain loaded instructions. Restoring reconnects discovery.
Staging never submits a prompt. External edits preserve metadata and reject stale saves.

`python3 scripts/consolidate_skills.py` previews personal-skill consolidation.
Add `--apply` to move sources into Panel and retain their original paths as links.
Conflicting files stop migration before any moves. Duplicate copies and a migration
journal remain under `~/.appgeapanel/state/skills/migrations`. System and plugin
packages stay provider-owned. The user's department content stays outside the repo.

Shared, personal, and project skills have session-specific Default / Enabled / Disabled
settings. Changes stay pending until **Apply and resume** confirms a restart of that
terminal. Claude receives a `skillOverrides` launch overlay; Codex receives merged
`skills.config` CLI overrides. Global skill files and settings remain untouched by
these controls. The resume picker lets you choose the correct saved conversation.
Resumed history can still contain previously loaded skill instructions.

Claude's successful Skill hooks supply **Used this session** evidence. Codex usage
is explicitly unknown. On-disk definitions and staged requests are never called
active context. **Manage session skills** stages the native `/skills` menu command;
settings changed there can affect other sessions, according to the agent's rules.
