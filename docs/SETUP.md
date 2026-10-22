# Setting up Appgea Panel

From a fresh machine to your first agent reporting back, in about 20 minutes. Most of that is
the first Rust build, which runs on its own.

- [1. Check your tools](#1-check-your-tools)
- [2. Build and install](#2-build-and-install) · [macOS](#macos) · [Windows](#windows)
- [3. First run](#3-first-run)
- [4. Make it yours](#4-make-it-yours)
- [5. Agents](#5-agents)
- [6. Terminals and keys](#6-terminals-and-keys)
- [Update and uninstall](#update-and-uninstall)
- [Troubleshooting](#troubleshooting)
- [Under the hood](#under-the-hood)

---

## 1. Check your tools

macOS and Windows. There is no Linux path today. Keep about **3 GB** free for the Rust build.

| you need | why | install | check |
|---|---|---|---|
| Xcode command line tools *(macOS)* | linking the bundle, `git` | `xcode-select --install` | `xcode-select -p` |
| Git for Windows *(Windows)* | Panel runs project scripts through its Git Bash | [git-scm.com](https://git-scm.com/download/win) | `git --version` |
| Rust (stable) | the app is Tauri v2 (MSVC build tools on Windows) | [rustup.rs](https://rustup.rs) | `cargo --version` |
| Tauri CLI 2 | builds the bundle | `cargo install tauri-cli --version "^2" --locked` | `cargo tauri --version` |
| Node 22.12+ or 20.19+ | the frontend is Vite + TypeScript | [nodejs.org](https://nodejs.org) or `brew install node` | `node --version` |
| Python 3.9+ | the session hook, the panel MCP, the module hosts | ships with the macOS command line tools; [python.org](https://www.python.org) on Windows | `python3 --version` / `python --version` |
| an agent CLI | Panel hosts `claude` by default | `npm install -g @anthropic-ai/claude-code` | `claude --version` |

Run each check in a **new** terminal window. Panel reads `PATH` from your interactive login shell,
so a tool that works there works in Panel.

> **Windows:** `python` must be a real install, not the Microsoft Store stub. Panel runs its
> session hook, panel MCP and modules with it.

## 2. Build and install

```sh
git clone https://github.com/Appgea/panel.git panel
cd panel/next
```

### macOS

```sh
./launcher/build-app.sh /Applications
```

Then open **Appgea Panel** from Applications.

- Omit the path to install onto the Desktop instead.
- The first build compiles the whole Rust dependency tree: **10–20 minutes**. Later builds take a
  few minutes. Frontend dependencies install themselves on the first run.
- To build without replacing your daily copy, pass an empty folder:
  `./launcher/build-app.sh /tmp/panel-check`.

The build signs the app with your Apple Development certificate when you have one, and ad-hoc
otherwise. It is not notarized. An app you built yourself normally opens without a warning; if
macOS blocks it, use **System Settings → Privacy & Security → Open Anyway**
([Apple's instructions](https://support.apple.com/102445)).

### Windows

From PowerShell in `panel\next`:

```powershell
powershell -ExecutionPolicy Bypass -File launcher\build-app.ps1
```

- It checks every tool first and stops with the fix if one is missing.
- It puts **Appgea Panel.exe** and a **Rebuild Appgea Panel** shortcut on the Desktop.
  `-Dest <folder>` picks another place.
- The exe reads `host\` from the checkout, so **keep the checkout where it is**.
- `launcher/build-windows.sh` builds a self-contained NSIS installer instead.
- Shortcuts use **Ctrl** where macOS uses **⌘**. Ctrl+C copies when the terminal has a selection
  and interrupts otherwise. F11 is full screen.

## 3. First run

1. Click **Add project** in the sidebar and pick a repository folder.
2. The project opens on its **Dashboard**. Click **Start Claude**, or pick another agent from the
   arrow next to it.
3. Give the agent a task in its terminal. That's it: Panel watches the session from there.

What you'll see next:

- **The sidebar sorts itself.** Projects move into lanes: **Needs you** (a question, a
  permission, a finished turn, or work to review), **Working**, **Shipping**, **In progress**,
  **Live** and **Quiet**. Hover a row for the next move, the last report and quick actions; you
  can answer a Claude permission prompt right there.
- **Reports arrive.** When an agent finishes, gets blocked or makes something, it files a report
  to **Reports**: a headline, an outcome, screenshots and one-click buttons.
- **Review collects what was made.** Images, sounds and videos land in **Review**. A report with
  media has a **Review** button that opens exactly those files. Flag what needs changing and your
  notes go straight into that agent's terminal.
- **Agents point, you click.** Agents can write `panel:review`, `panel:work:<path>:<line>`,
  `panel:git` or `panel:manager`. Each is a button on the report and ⌘/Ctrl-clickable in the
  terminal.

Fast moves: ⌃1…⌃9 open projects, and typing `tidepool release` in the filter runs that action on
that project. Every screen and key is in the [user guide](USER-GUIDE.md).

## 4. Make it yours

Panel creates its home on first launch:

```
~/.appgeapanel/
  config.json      your portfolio: projects, groups, agent choice, devRunner
  ops/             seeded from the shipped template, yours to edit
  brain/           the append-only note log, including every agent report
  modules/         modules you install yourself
  state/<module>/  each module's private writable dir
```

Nothing here comes from anyone else's machine. The ops tree ships as **structure with no
content**: schema comments, `_template.md` files, empty indexes.

**Rewrite `~/.appgeapanel/ops/AGENTS.md` in your own words.** It is the Manager's standing prompt,
the personality of the thing. You can edit it from the Manager screen (⌘⇧M), with a
reset-to-shipped button.

Good to know: the editor and project tools can change your project files. Shared workflows create
links in agent skill folders such as `~/.claude/skills`. The personal notebook lives at
`~/.appgea/notes.md` and is never shown to agents.

## 5. Agents

Each terminal button runs the CLI of the same name from your `PATH`. Install the ones you use.

| button | runs | Panel wiring |
|---|---|---|
| Claude | `claude` | session hook and panel tools, so status and reports are exact |
| Codex | `codex` | panel tools, so reports reach Panel |
| Grok | `grok` | a small report script through its rules flag |
| Kimi, GLM | `kimi`, `glm` | a plain terminal |
| opencode | `opencode`, with a `--model` for the Kimi K3 and DeepSeek v4 Flash buttons | a plain terminal |
| DeepSeek Harness | `dshline` | a plain terminal |
| Shell | your login shell | a plain terminal |

A missing panel tool never breaks an agent: Panel then launches the plain CLI.

**DeepSeek Harness.** Install [DeepSeek Harness](https://www.deepseek.com/en/harness/) and its
community [dshline terminal interface](https://github.com/riesbri/dshline). Confirm
`dshline --version` works in your shell and configure your DeepSeek key in Harness; Panel uses
that setup. Restoring a DeepSeek terminal opens dshline's saved-session picker.

## 6. Terminals and keys

The Terminals screen has two layouts. Switch in **Settings → General → Terminals**, with the
switch at the right end of the top row, or with ⌘⇧L.

- **Grid** shows every terminal of a tab at once.
- **Tabs** adds a second row with one tab per terminal, grouped by project. One terminal shows at
  full size.

| keys | does |
|---|---|
| ⌘1…⌘9 | open a top tab |
| ⌘⌥↑ / ⌘⌥↓ | previous / next top tab (tabs layout) |
| ⌘⌥← / ⌘⌥→ | previous / next terminal (tabs layout), or the tile beside it (grid) |
| ⌥1…⌥9 | open a terminal of this tab |
| ⌃Tab / ⌃⇧Tab | next / previous terminal |
| ⌘N, ⌘T, ⌘W | new terminal, new shell here, close |
| ⌘⌥1…⌘⌥9 | move the terminal to that tab |
| ⌘⇧M | the Manager |

Every chord can be changed in **Settings → Shortcuts**. Drag a terminal tab to reorder it, or onto
a top tab to move it there.

## Update and uninstall

**Update** — your portfolio in `~/.appgeapanel` is untouched by a rebuild:

```sh
cd panel
git pull
./next/launcher/build-app.sh /Applications          # macOS
# Windows: run the "Rebuild Appgea Panel" shortcut, or launcher\build-app.ps1 again
```

**Coming from Bridge?** Panel used to be called Bridge. If `~/.appgeabridge` exists and
`~/.appgeapanel` does not, the first launch links the new name to the old folder (a junction on
Windows). Nothing moves and your projects stay. The RevenueCat module stores its key under a new
Keychain name, so enter that key once more.

**Uninstall** — quit Panel and delete **Appgea Panel.app** (or the exe). Your portfolio, ops tree
and module state stay in `~/.appgeapanel`; delete that folder too only if you want them gone.

## Troubleshooting

| symptom | fix |
|---|---|
| `error: no such command: tauri` | `cargo install tauri-cli --version "^2" --locked` |
| `could not execute process /opt/homebrew/bin/sccache` | An older checkout pinned the `sccache` compiler cache. `git pull`, or delete `next/.cargo/config.toml`. To keep the cache on purpose, see [CONTRIBUTING.md](../CONTRIBUTING.md#faster-rust-builds). |
| `npm error code EBADENGINE` | Your Node is too old. Install Node 22.12 or newer. |
| An agent button opens a terminal that says `command not found` | Panel cannot see that CLI. Check with `zsh -ilc 'command -v claude'`, fix your `~/.zshrc` until it prints a path, then restart Panel. |
| macOS asks for Desktop or Documents access after every rebuild | An ad-hoc signature changes with each build, so macOS forgets the grant. Install an Apple Development certificate in Xcode, or set `PANEL_SIGN_IDENTITY` before you build. |
| Hooks, MCP or modules do nothing on Windows | `python` is probably the Microsoft Store stub. Install Python from python.org and make sure `python --version` works. |

**Start fresh.** Quit Panel and rename `~/.appgeapanel`. If you came from Bridge, rename
`~/.appgeabridge` too, or the next launch links it again. The next launch seeds a new home.

Still stuck? [Open an issue](https://github.com/Appgea/panel/issues) — see
[CONTRIBUTING.md](../CONTRIBUTING.md#reporting-bugs) for what to include.

## Under the hood

### Two roots

Everything Panel ships is read-only. Everything you own is writable. `paths.rs` is the one place
that decides which is which.

| root | is | holds |
|---|---|---|
| resources | `host/` in a checkout, `Contents/Resources/host` installed | session hook, panel MCP, module hosts, schemas, `ops-template/` |
| user | `~/.appgeapanel` | `config.json`, `ops/`, `brain/`, `modules/`, `state/` |

A module never writes next to its own code. Installed, a module's folder is inside a signed
bundle, so a cache write there works on the machine that built it and fails on every other one.

### Environment overrides

Every one of these has a working default. Set them only if your layout differs.

| var | changes |
|---|---|
| `PANEL_USER_HOME` | where your portfolio and ops tree live |
| `PANEL_PRIVATE=1` | build the unshipped modules too |
| `PANEL_SIGN_IDENTITY` | the code signing identity `build-app.sh` uses |
| `PANEL_STATE_DIR` | a module's writable dir, set by Panel when it launches one |

### Modules

Modules are optional companions. Panel launches, hosts agents and serves its dashboard with every
one of them absent. A module declares itself in `module.json`, and `stage-resources.sh` ships only
the ones marked `"visibility": "public"`. A module that forgets the field stays home.

Shipped: `git-manager`, `revenuecat`, `server-health`, `support`. See
[`host/modules/README.md`](../host/modules/README.md) for the manifest format and
[MODULES.md](MODULES.md) for writing one.

A module can also live in its own repo. Link its folder into `~/.appgeapanel/modules/<name>` and
Panel loads it like a shipped one. The Release tab appears only when a `release-manager` module is
installed that way.

### Secrets

Credentials live in the macOS Keychain or under `~/.appgeapanel/state/<module>/secrets/`, both
outside every git tree. `stage-resources.sh` sweeps state, caches and `.git` out of the bundle,
then **refuses to build** if anything credential-shaped survived.
