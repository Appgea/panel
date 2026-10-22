# User guide

How to use Appgea Panel day to day. Install and first-run steps are in the root
[README](../README.md); this guide starts once the app is open. Shortcuts shown as macOS / Windows·Linux.

**Mental model**
- **Agents are hosted, not driven.** Each agent (`claude`, `codex`, …) runs in a real terminal exactly as it would anywhere else. Panel only watches.
- **The project is the unit.** The sidebar is your portfolio. Picking a project changes what you *see*; nothing running is stopped.
- **Panel tells you who needs you.** Every project shows whether its agent is working, parked on a question, or finished.

---

## 1. Quick start

1. **Add a project:** sidebar → **Add project** → pick the folder (native dialog). It lands in the rail.
2. **Open it.** A project opens on its **Terminals** tab.
3. **Start an agent:** **Start agent** (top right) or the empty-state **Start Claude**, or pick any engine in the NEW row of the session strip. A plain **Shell** is also an option.
4. Talk to the agent in its terminal as normal.
5. Glance at the sidebar dot: pulsing amber = *this agent is blocked on you*; green = *your turn* (it finished while you looked elsewhere).
6. Answer questions in the **ask tray** (bottom right, over every screen). Press **Skip** to decline.
7. Quit safely: Panel always asks before closing and tells you which sessions are still running.

---

## 2. The window

```
┌ SIDEBAR ──────────┬ MODULE RAIL: Terminals · Git · Dashboard · Work · Debug · Product Spine · Release · RevenueCat · Analytics ┐
│ Home              │                                                                                                      │
│ WORKSPACE         │  the selected project's screen                                                                       │
│   Runs            │                                                                                                      │
│   Terminals       │                                                                                                      │
│ INBOX             │                                                                                                      │
│   Reports         │                                                                                                      │
│   Manager         │                                                                                                      │
│   Support         │                                                                                                      │
│   Review          │                                                                                                      │
│ DESK              │                                                                                                      │
│   Project desk    │                                                                                                      │
│   Notebook        │                                                                                                      │
│ PROJECTS (filter) │                                                                                                      │
│ ⚙ Settings  ◐     │                                                                                                      │
└───────────────────┴──────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Portfolio-level screens (Home, Runs, Terminals, Reports, Manager, Support, Review, Project desk,
Notebook, Settings) **swap with** the project screen and hand it back when you leave (Esc on Reports,
Manager and Settings). Only the tabs the project has enabled appear in its rail (Git, Release,
RevenueCat, Analytics, Product Spine are optional — see §12).

| Sidebar row | What it is |
|---|---|
| **Home** | The portfolio's landing: a verdict and a card per app; where the whole estate stands. |
| **Runs** | Tab of the Workspace: start/stop apps on devices (§8). |
| **Terminals** | The **wall**: every live terminal across every project (§4). |
| **Reports** `⌘⇧C / Ctrl+Alt+C` | Feed of what agents reported (§6). |
| **Manager** `⌘⇧M` | A planning agent rooted at your ops tree (§6). |
| **Support** | Every app's support form, merged into one queue (§6). |
| **Review** | Pictures/sounds/videos agents made (§6). |
| **Project desk** | Per-project release target, todos and notes (§9). |
| **Notebook** `⌘⇧N / Ctrl+Shift+N` | Your private Markdown notes; never shared with agents. |
| **Settings** `⌘, / Ctrl+,` | Preferences, shortcuts, extensions, servers. |
| ◐ | Light/dark toggle. "Local" = Panel runs entirely on your machine. |

---

## 3. The sidebar: reading your portfolio

Rows are grouped into **lanes** by what each project asks of you:

| Lane | Meaning |
|---|---|
| **Needs you** | An agent is parked on a question/permission, a turn finished, or media waits for review |
| **Working** | An agent is mid-turn |
| **Shipping** | In store review / being released (from your `portfolio.yaml`) |
| **In progress** | Being built, or active without a portfolio status |
| **Live** | Live apps that moved in the last 2 weeks |
| **Quiet** | Nothing waiting, no movement for 14 days, or paused/archived (fades after 30 days) |

Each row's second line is the one thing worth knowing: the question being asked, "your turn · <report title>",
"N to review", the working status, "folder missing", a risk signal, the next move, or recency. Git chips
show `↓N` behind, `±N` uncommitted, `↑N` unpushed.

- **Hover** a row for the project card: next move, last report, git, two weeks of commits, standing, and quick actions. A parked question shows with the terminal's last lines so you can see what you're allowing. **Answer** pins it open.
- **Filter projects** box, **live** chip (only projects with a live agent), and an **order** chip (manual ↔ other rule). Manual order: drag rows. The rail shows the five you last worked in; **Show all** reveals the rest.
- **Groups** (companies) come from `config.json`; file a project under a group from its row menu (it writes `config.json`; collections move their children together).
- **Jump to project 1…9:** `⌃1…9` / `Alt+1…9` — your pins first, then rows in visible order.
- Editing `config.json` by hand (or an agent doing so) updates the rail live.

---

## 4. Terminals and agents

### Starting
Engines available (order shown everywhere): **Shell, Claude, Codex, Grok, Kimi, GLM, opencode, Kimi K3 (opencode), DeepSeek v4 Flash (opencode), DeepSeek (Harness)**. Each is the executable of that name on `PATH` (the two opencode variants run `opencode --model …`). The agent CLI must be installed; Panel doesn't install it.

A project may hold **many** sessions at once (several agents, several shells, side by side). Opening one never replaces another — a build and the agent that broke it can run together.

### The wall (Terminals row, or `⌘J / Ctrl+J`)
- **Grid** shows every terminal of a tab at once; **Tabs** shows one at full size with a tab each. Toggle `⌘⇧L`, or Settings → *Terminal layout*. *Wall columns* = auto or fixed.
- The last cell is the **＋ seat**: lists projects by recency, then offers the engines. With **Straight to a shell** on (Settings), picking a project opens a plain shell; hold `⌥` to be asked which agent.
- **Terminal tabs** are named subsets of sessions. A session joins the active tab when born; drag its header onto another tab (or use the tile's ⇄ menu) to move it. A tab shows a count of its terminals instead of ×; it retires itself when its last terminal closes or moves (Settings → *Tabs close themselves*).
- **Next waiting agent** `⌘⇧A`: jumps to the agent that has waited on you longest (open questions first, then finished turns you haven't seen).
- Per-terminal: `⌘Enter` zoom/unzoom (Esc leaves), `⌘F` find in scrollback, `⌘C` copy selection (with no selection `Ctrl+C` still interrupts), `⌘T` another shell **in the folder this one is standing in**, `⌘W` close.
- Right-click → Paste works without the browser's "Paste" bubble. **Pasting a file or image** saves it to a temp folder and types its path — any CLI agent can read a path.
- **Closing** a terminal with something running asks first ("busy" = a command is in the foreground). A thinking agent counts as running; an agent sitting at its prompt does not.
- **Quit / close window:** always confirms and lists live sessions. On quit Panel saves the wall (what each terminal was, its title, its screen). **Next launch restores it**: same folders, old screen replayed under a dated banner, agents resumed (`claude --continue`, `codex resume --last`, DeepSeek Harness `--resume`; other engines start fresh). Running processes do *not* survive the app.

### In a project (Terminals tab)
Above the terminal is the **session strip** (switching only changes what you see) and a **NEW** row. **Open folder** opens the project in Finder/Explorer. The tab badge counts live sessions.

---

## 5. When an agent needs you

Three signals, all aggregated into the dock badge and (when Panel isn't the focused window) an OS notification:

1. **Asks** — the agent called `ask_user`. A card appears in the **ask tray**. It never grabs keyboard focus (a question that stole focus would eat your next keystroke). The agent's tool call is *parked* until you answer, press **Skip** (it receives `{"skipped": true}`), or it times out (default 280 s). Answer shapes: [PROTOCOL.md §6](PROTOCOL.md).
   - A **document** ask opens a file (or an editable draft) in **Work**; edit normally and press **Continue** — the saved contents go back to the agent.
2. **Permission prompts** in the agent's own terminal — detected by the `Notification` hook; the project dot pulses amber ("needs you").
3. **Finished turns** — a turn that ends while you look elsewhere turns the dot green ("your turn") until you open the project.

What you see isn't polled: file edits, git moments, turn boundaries and permission waits come from Claude hooks, so they are accurate even if the model forgets to narrate.

---

## 6. The Inbox group

### Reports
A flat, read-only feed (newest last) of everything agents reported via `send_to_user` / `panel_send.py`: headline, outcome chip (*in progress / done / blocked / needs you*), screenshots (click for lightbox), audio (inline player), video (a link — opens in your real player), attachments and links. The **evidence box** opens under a post: the edit replay, a file at the cited line, a screenshot — without leaving. Answer an agent in *its terminal* (one click away on the post's byline). Full prose reports are filed to `~/.appgeapanel/brain/reports/<project>.md`.

### Manager
An ordinary agent session rooted at your **ops tree**, running whichever CLI you start it with. It plans, keeps `ops/` current and writes briefs you hand to workers; it does not edit app code and cannot see or type into worker terminals (it reads their report logs). Its standing prompt is `ops/AGENTS.md` — **editable on the Manager screen, with a reset-to-shipped button**. See [CONFIGURATION.md §4](CONFIGURATION.md) for the ops tree.

### Review
Pictures, sounds and videos that appeared in a project while a session was open there (build output and caches skipped; a file counts once it stops changing). Files one project makes within a few minutes form a **batch**. Unseen batches sit on top with an accent edge; the corner pop-up's `×` only hides it. Open the **deck**: big media, keyboard-driven — `← →` previous/next, `Space` play/pause, `C` needs changes (short note; empty Enter takes it back), `B` before/after on a redo, `Esc` close. Nothing needs approving: what you don't flag is fine. Notes are kept as you write them, so leaving part way loses nothing. Walking to the end marks the batch reviewed; with notes, they become one message **sent straight into that agent's terminal**. When the agent writes that file again, the new version shows a **redo** chip, what you asked, and `B` flips to the old version. On the Review screen: filter by project and kind, `J`/`K` move, `Enter` review, `D` done, `F` Finder, `U` undo. Files gone from disk leave the list. The queue lives in this window's local storage; old versions in IndexedDB.

### Support
Every app's support form (Google Forms) merged into one queue; badge = unread. Needs the `support` extension and a Google service-account key (§12). It never polls — press fetch when you want fresh data.

---

## 7. Per-project tabs

### Terminals
See §4.

### Git (`⌘⇧G / Ctrl+Shift+G`)
Git as one spine of time, with **plain words** (hover shows the real git term). Design doc: [`next/GIT.md`](../next/GIT.md).
- **Next move** (top): one sentence and one button — resolve a stopped merge → *Commit turn N* → *Commit* your changes → *Bring in* remote work → *Send* unpushed commits → "In sync. Clean." `⌘↵` presses it.
- **Spine** (left): waiting work grouped by **agent turn** (title = the prompt), your own edits as "Yours", then commits newest-first with the remote drawn as a line where the remote actually is.
- **Focus** (right): the diff/commit under the cursor with its verb and its undo (e.g. **Commit** beside **Discard**).
- **Safety bar**: undo last commit, put aside / bring back, branches.
- Motion only plays while git is really working. A dot on the tab means unpushed work.
- **Pull all / Push all** sweeps every tracked repo sequentially with per-repo phase words.
- Mutating actions are executed by the `git-manager` extension (needs `git` + Python).

### Dashboard (`⌘⇧D / Ctrl+Shift+D`)
"What needs me here?" read in a second: **Next move**, the action buttons, a quiet repo pulse (branch, drift, dirt), agent state, files the agent handed you (a `worklist`), and cards for enabled modules (each wearing its module's colour). Below it, the **living workshop**: one robot per live agent, one *station* per edited file (click → opens the file in Work; with a before/after capture, tap to **replay** the edit like a theatre — pause/speed/skip, nothing writes), and a single checkpoint for tests/builds/git. It only shows what hooks proved.

### Work (`⌘⇧E / Ctrl+Shift+E`)
An Xcode-style workspace for a human sharing a repo with an agent.
- **Navigator** (left): a filter box over a lazy folder tree (dotfiles and build folders hidden). Type to flatten into a match list.
- **Editor** (CodeMirror 6): *preview tab* (italic, single click) vs *kept tab* (type, save, double-click, ⌘-click, or a jump from the agent); basename tabs grow to `parent/name` on collision.
- **RELATED row** under the tabs: what the open file reaches (→) and what reaches it (←); works across languages (notably Swift).
- **Agent edits underneath you:** a clean buffer reloads silently; a dirty buffer becomes a **conflict you resolve** — Panel writes nothing and discards nothing without asking.
- Files over 2 MB won't open. Right-click a tab or tree row for rename, delete (confirms), reveal, new file/folder.
- Status bar: path, caret, whether the buffer agrees with disk, language.

| Key | Action |
|---|---|
| `⌘P` | Open any file (quick open) |
| `⌘⇧O` | Open any file *or symbol* |
| `⌘⇧F` | Find in project (plain text; case/whole-word toggles) |
| `⌘`-click a name | Jump to definition (picker if ambiguous) |
| `⌃6` / `⌃1` | Jump within the file (outline) / Related files |
| `⌘S` / `⌘⌥S` (`Ctrl+Shift+S`) | Save / Save all |
| `⌘W` | Close tab |
| `⌘⌃←/→` (`Alt+←/→`) | Back / forward |
| `F9` (or click beside a line number) | Toggle breakpoint (stored outside the repo) |

### Debug (`F5`)
Debug Adapter Protocol host: profiles, start/pause/continue/step, call stack, variables, evaluate, adapter output. **Flutter and Dart work with no config.** Other stacks declare their adapter in `.panel/debug.json` ([CONFIGURATION.md §3](CONFIGURATION.md)). One adapter per project. Breakpoints persist in Panel's user state.

### Product Spine
A native canvas map of the product's screens that have a taken screenshot: hover/click a screen to light its paths (green = goes to, red = reaches it), pan/zoom, double-click for the screen's detail page (every look, every control and what it does, from a real probe run). Appears only for projects registered with the `product-spine` extension.

### Release
Per-project release status, or the whole portfolio answering "which app needs a release at all". The Python release module is the engine; the tab shows what is live vs waiting to ship and hand-off prompts. Needs the release extension (§12).

### RevenueCat (opt-in)
Read-only proceeds, MRR, active subscriptions, new customers, trials and a 90-day trend. Appears only when the repo adds `"revenuecat"` to `.panel/modules.json`. Connect once with a V2 read-only key (Projects/Overview/Charts read); the key is stored in the OS keychain, never in config. Results cached 5 min; today's value is marked provisional. Full setup: `host/modules/revenuecat/README.md`.

### Analytics
Firebase/GA4 health for the *selected app only*, via insight presets. (The portfolio Kill/Keep board is on Home.) Credentials stay in the Python module.

---

## 8. Running apps (Runs, `⌘K`)

A **run** is a build process attached to a **target**; you don't type into it — you run / reload / restart / stop.

Targets (one address scheme): `iphone:` / `ipad:` / `ios:` (simulators / a plugged phone), `android:` (emulator by AVD name, phone by serial), `chrome`, `macos`, `desktop`. The picker next to **Run** offers only what *this project* can reach (a Flutter app with no `web/` gets no Chrome row). Project kinds detected: Flutter, native iOS, Android, Godot, dev servers, and your own `devRunner` script.

| Action | Keys | Behaviour |
|---|---|---|
| Run | `⌘R / Ctrl+R` | Not running → build and launch. Running Flutter app → **hot restart** (seconds). Where no hot restart exists, or the run failed → a new build that **keeps app data**. |
| Fresh run | `⌘⇧R` | Always a new build on the same device with the app **deleted first** (first-install behaviour). |
| Stop | `⌘.` | Stop and give the device back. |
| Second instance | `⌘⌥R` | A deliberate extra copy on another device. |
| Reload / Restart | buttons | Hot reload (`r`) and restart go into the run's PTY (a run is a real interactive process). |
| Focus / Open | buttons | Raise the device window / open the dev server's page. |
| Shut down idle | button | Shut down simulators nobody holds. |

**One run per project:** running an app that's up shows the existing one rather than burning another device. **Leases:** every run holds a device lease (`~/.panel/leases.json`) so a screenshot batch can't be handed a device you're debugging on — and vice versa. `PANEL_MAX_SIMS` caps booted simulators. Android uses `adb`/`emulator` found via your Android SDK, not bare `PATH`.

---

## 9. Desk

### Project desk
A per-project page that works **without an agent**: release target (set a date; overdue ones are flagged), "Waiting to ship" (commits since the last release tag per platform), Todos, Notes, "Second brain" documents, recent work and uncommitted files. Overview mode lists every project with open/blocked todos and overdue targets. It stores `~/.appgeapanel/brain/projects/<hex id>/desk.md` (Markdown: `Release target:`, `## Todos`, `## Notes`). Edit documents in place (`⌘S`), with undo of the last edit and stale-save protection.

### Notebook
One private Markdown file (`~/.appgea/notes.md`) with Obsidian-style live preview. Never exposed to agents, projects or MCP.

> A **Sprint** screen (two-week plan from `ops/sprints/<id>.md`) exists in the source with its backend commands, but nothing in the current UI mounts it (the *Project desk* button opens `project_desk`). The Manager can still read and write sprint files.

---

## 10. Skills and shared workflows

Open **Skills** from a Claude/Codex terminal header, the session strip, or Settings → Agents → *Manage skills*.
- The library lists local skill definitions with provider and path, grouped Company / Legal / Design / General with department filters. Plugin entries are read-only disk inventory (may include inactive cached versions).
- **Create a shared workflow:** name, description, trigger, steps, expected output → stored as `SKILL.md` under `~/.appgeapanel/skills/` and linked into Claude's personal skills, Codex's legacy personal skills and `~/.agents/skills`. Edit, archive (removes only Panel's links), restore, or **stage** into a terminal (staging never submits a prompt). Supporting Markdown files can be added/edited beside the instructions.
- **Per-session** Default / Enabled / Disabled settings stay *pending* until **Apply and resume** restarts that terminal (Claude gets a `skillOverrides` overlay; Codex gets `skills.config` overrides). Global skill files are never touched. The resume picker lets you choose which saved conversation to continue.
- **Used this session** evidence comes from Claude's successful Skill hooks; Codex usage is shown as unknown. Staged requests and on-disk definitions are never claimed as active context.
- Consolidate scattered personal skills: `python3 next/scripts/consolidate_skills.py` (preview) then `--apply`.

---

## 11. Settings (`⌘,`)

| Section | Contents |
|---|---|
| **General** | *Tabs close themselves*; *Follow a moved terminal*; *Straight to a shell*; *Terminal layout* (grid/tabs); *Wall columns* (auto/N); *Manage skills*. Changes apply immediately. |
| **Shortcuts** | Every chord, rebindable. Click a chord → press the new one (Esc cancels; the keystroke is swallowed so nothing else fires). ↺ resets one. Conflicts and ⌥-typing-characters warnings show on the row. Only overrides are stored, so future default changes reach you. |
| **Extensions** | Built-in extensions and your own (from `~/.appgeapanel/modules`), with a switch each and a note of tools missing on this machine. Nothing is downloaded — public ones ride in the app. |
| **Servers** | Health board for servers you run (portfolio-wide): `up / degraded / down / skipped`. Shows the stored answer with its age; a live check is something you ask for. See [MODULES.md](MODULES.md). |

---

## 12. Shortcuts (all rebindable unless noted)

| Action | macOS | Windows / Linux |
|---|---|---|
| Settings | `⌘,` | `Ctrl+,` |
| Notebook | `⌘⇧N` | `Ctrl+Shift+N` |
| Run / Fresh run / Stop / 2nd instance | `⌘R` / `⌘⇧R` / `⌘.` / `⌘⌥R` | `Ctrl+R` / `Ctrl+Shift+R` / `Ctrl+.` / `Ctrl+Alt+R` |
| Terminals wall (toggle) | `⌘J` | `Ctrl+J` |
| Runs (toggle) | `⌘K` | `Ctrl+K` |
| Work / Git / Dashboard (current project) | `⌘⇧E` / `⌘⇧G` / `⌘⇧D` | `Ctrl+Shift+E/G/D` |
| Reports / Manager *(hard-wired, not in the rebind table)* | `⌘⇧C` / `⌘⇧M` | `Ctrl+Alt+C` / unverified (source binds `Meta+Shift+M` only) |
| **`⌘1…⌘9` — the ladder** *(hard-wired, context-sensitive)* | On the wall: `⌘1` Runs, `⌘2` the first terminal tab, … (tabs layout: the second row of terminals takes the digits and the strip moves to `⌃⌘1…9`). On a project: Work's open-file slots. Home/Settings/Reports/Notebook own no digit. A digit past the last rung does nothing. `⌘J` walks between the two strips. | `Ctrl+1…9` (same rules; per source `Meta+Digit` is matched via `matchesShortcut`) |
| Jump to project 1…9 | `⌃1…9` | `Alt+1…9` |
| New terminal (＋ picker) / New shell here / New tab | `⌘N` / `⌘T` / `⌘⇧T` | `Ctrl+N` / `Ctrl+T` / `Ctrl+Shift+T` |
| Switch layout (grid ↔ tabs) | `⌘⇧L` | `Ctrl+Shift+L` |
| Next / previous tab (on a project: module rail) | `⌘⇧]` / `⌘⇧[` | `Ctrl+Shift+]` / `[` |
| Next / previous terminal | `⌃Tab` / `⌃⇧Tab` | same |
| Next waiting agent | `⌘⇧A` | `Ctrl+Shift+A` |
| Terminal 1…9 (this tab) | `⌘⌃1…9` | `Alt+Shift+1…9` |
| Focus left/right/up/down | `⌘⌥←→↑↓` | `Ctrl+Alt+←→↑↓` |
| Zoom terminal / leave zoom | `⌘Enter` / `Esc` | `Ctrl+Enter` / `Esc` |
| Find in terminal / copy selection | `⌘F` / `⌘C` | `Ctrl+F` / `Ctrl+C` |
| Full screen (project Terminals, or zoom on wall) | `⌃F` | `F11` |
| Move terminal to tab 1…9 / to a new tab | `⌘⌥1…9` / `⌘⌥T` | `Ctrl+Alt+1…9` / `Ctrl+Alt+T` |
| Git: press Next move | `⌘↵` | `Ctrl+↵` |
| Terminal text size (bigger / smaller / reset) | `⌘=` / `⌘-` / `⌘0` | bound to `Meta` in source; behaviour on Windows/Linux unverified |
| Review screen | `J K Enter D F U` | same |
| Review deck | `← → Space C B Esc` | same |

---

## 13. Everyday recipes

- **Run three agents on three apps and see who needs you** → start each from its project; watch the sidebar lanes; `⌘⇧A` jumps to the longest-waiting.
- **Hand an agent a screenshot** → paste into its terminal; Panel types the saved file's path.
- **Review what an agent drew** → Review → open the batch → `→` through it, `C` on what needs changes → the notes go to its terminal.
- **Undo an agent's overreach** → Dashboard station → replay the edit; Git → *Discard* on the turn's card, or *Undo last commit* in the safety bar.
- **Edit a file the agent is also editing** → just type; if it writes underneath you, resolve the conflict banner (keep your buffer — `⌘S` then overwrites the agent's version — or take the agent's).
- **Debug a Flutter app** → Debug tab → `F5`; set breakpoints with `F9`.
- **Ship check** → Project desk overview → overdue targets and "waiting to ship" per platform → Release tab.
- **Plan across apps** → Manager → "what's blocked on me?" (it reads `now.md`, the sprint, and each project's report log).

## 14. Troubleshooting

See the root README's troubleshooting section for install problems. Common in-app ones:

| Symptom | Likely cause / fix |
|---|---|
| Project dot never changes | Agent wasn't launched by Panel (started in an outside terminal) → events are dropped by design. Start it from Panel. |
| Agent launches but no questions/reports | A shim (`session_hook.py`, `panel_mcp.py`) is missing → Panel launches a plain agent. Reinstall/rebuild so `host/` ships. |
| "folder missing" on a row | The registered path moved; edit `~/.appgeapanel/config.json` or re-add. |
| No Android/iOS targets | `adb`/`emulator` not found (set up the SDK) or Xcode simctl unavailable. |
| Windows: `~/.appgeapanel` in the wrong place | `HOME` unset → Panel maps it to `USERPROFILE`; if you run the exe from odd contexts check that. |
| Extension row says "Not on this machine: …" | Install the named tool (e.g. `git`, `python3`); you can still switch it on. |
| Question vanished | It timed out (default 280 s) — the agent received `{"timeout": true}` and carries on. |
| Wall came back with old screens | Intended: a dated banner marks restored scrollback; processes did not survive. |


