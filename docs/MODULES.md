# Extensions (host modules)

Optional companion products. **Panel launches, hosts agents and works with every module absent.** A
module is a folder with a `module.json` and a one-shot executable; Panel has no module-specific code.
Product-level overview: [`host/modules/README.md`](../host/modules/README.md) (the manifest vocabulary
list is inherited from the old Python Panel — see the "read by this host" column below for what the
Rust host actually consumes).

## 1. How a call works

```
UI / agent ──► module_request("/m/<name>/<route>", method, body)   (Tauri command)
         or ──► module://panel/m/<name>/<route>                    (URI scheme, e.g. iframes)
                    │
                    ▼  modules::call — ONE REQUEST, ONE PROCESS
   <interp> [-B] <exec> METHOD PATH [manifest args…]      cwd = module root
   stdin  = request body
   stdout = "<status>\n<content-type>\n\n<body>"
   env    = PANEL_STATE_DIR=~/.appgeapanel/state/<name>, PANEL_USER_HOME=~/.appgeapanel
   killed after PANEL_MODULE_TIMEOUT_SECONDS (default 60)
```
- Requests under `/m/<name>/assets/…` are served straight from `<module>/assets/` (no process), with a path-climb guard.
- Each call costs an interpreter start. The UI therefore never polls modules on a timer.
- Python is `python3` (macOS/Linux) or `python` (Windows). `.py` runs with `-B`.
- `module.json` `args` may contain `{root}` (the module folder).
- Old name `decision-map` is served as `product-spine`.

## 2. `module.json`

Fields the Rust host reads (verified in `modules.rs`):

| field | use |
|---|---|
| `name` | unique id; also the URL segment, the state dir, the animation namespace |
| `exec` | executable relative to the module root — **must exist**, else the module is ignored |
| `args` | extra argv; `{root}` substituted |
| `title`, `icon`, `summary` | Extensions screen and rail |
| `requires` | commands that must be on `PATH` for the row to read "available" — reported, never enforced |
| `chatAsset.js` / `.css` | inlined into the page; this is how a module supplies its own renderers/animations (`git-manager` draws the animated commit graph this way) |
| `projectSurfaces` | `[{id, title, glyph?, roles[], types[], mount}]` — typed project tabs. `mount` e.g. `/project?root={path}`; `{id}`/`{path}` are URL-encoded from the selected project. Panel owns the tab + iframe lifecycle, the module owns the route and page |

Read by the **build**, not the app: `visibility` (`"public"` ships in release builds; anything else, or missing, stays home — fail-closed; `PANEL_PRIVATE=1` ships all).

Documented in `host/modules/README.md` and present in shipped manifests, but **not read by this Rust host**
(no reference found in `modules.rs`): `protocol`, `buildInputs`, `build`, `assets`, `card`, `catalog`,
`agentDoc`, `agentContext`, `agentDir`, `hooks`, `animations`. Treat them as inert metadata here
(unverified whether another component reads them; e.g. `agentDoc` files like `AGENT.md` are written for
agents to read). `animations` is the contract for the motion ledger (`motion.json`).

## 3. Installing and where modules live

| source | rule |
|---|---|
| Shipped | `<resources>/host/modules/<name>/` — all public ones ride in the app; **installing just records a choice** (`~/.appgeapanel/modules.json`) |
| Yours | `~/.appgeapanel/modules/<name>/` — dropping it in *is* installing; a same-named folder here overrides the shipped one; remove the folder to uninstall |
| Linked | symlink/junction a module repo into `~/.appgeapanel/modules/<name>` — loads like a shipped one |

First-run set: fresh install = `git-manager` only; upgrade = everything found. Discovery is cached ~2 s.
Uninstalling leaves `state/<name>` (credentials you'd otherwise re-paste). A project with `extensionId` pins its extension on.

## 4. Writing a module (minimum)

```
~/.appgeapanel/modules/hello/
├─ module.json   {"name":"hello","title":"Hello","summary":"…","icon":"👋","exec":"bin/host.py","args":[],"requires":["python3"]}
└─ bin/host.py
```
```python
#!/usr/bin/env python3
import sys, os
method, path = sys.argv[1], sys.argv[2]            # then manifest args
body = sys.stdin.read()
state = os.environ["PANEL_STATE_DIR"]              # write here, never beside this file
sys.stdout.write('200\napplication/json\n\n{"hello":"%s"}' % path)
```
Then Settings → Extensions shows it (switched on, because it lives in `~/.appgeapanel/modules`), and
`module_request({path:"/m/hello/x"})` returns `{"hello":"/x"}`.
Rules: no daemon, no port; never write beside your own code (the bundle is signed/read-only); credentials
go in `$PANEL_STATE_DIR/secrets/` or the OS keychain; keep calls cheap (one process each).

## 5. Shipped modules

Only four are in this checkout. The UI also has screens for **Product Spine**, **Release** and
**Analytics**, but their module hosts (`product-spine`, `release-manager`, `analytics`) are **not in
`host/modules/`** here. The root README says the Release tab appears only when a `release-manager`
module is linked into `~/.appgeapanel/modules/<name>`; I found nothing stating where Product Spine or
Analytics come from (unverified — likely the same arrangement). Until such a module is installed its tab
stays hidden even if a repo enables it (`keep_installed` filters the enabled list).

### git-manager (public, default-installed; needs `python3`, `git`)
Branch, status, commit graph, staging, commit/undo, stash, branches, merge/rebase/cherry-pick/revert,
push/pull/pull-all with progress, per-hunk staging. Drives the **Git tab**; the Git screen's mutating
actions go through it (read-only snapshots use the native `git_overview`). Routes (`bin/host.py`):
`/card /repos /pullable /pushable /pull/progress /push/progress /status /graph /commit /compare /diff
/stage-hunk /stage /unstage /discard /undo-last /stash /stash/pop /operation/continue /operation/abort
/branch /branch/delete /branches/delete /checkout /merge /rebase /cherry-pick /revert /verb/plan /verb/run
/undo /push /pull /pull/resolve-all /pull/resolve /pull/abort /remote`.
Owns the `git` animation scenes (`git-manager:march, edge-in, head-pulse, converge, landed, pull-incoming, pull-land`) and the chat `git` card (`commit`/`merge`/`push` payloads per `AGENT.md`; never emit `graph` into chat). Tests: `test_gitops.py`.

### revenuecat (public; needs `python3`) — see its [README](../host/modules/revenuecat/README.md)
Read-only Charts & Metrics: dashboard widget (proceeds, MRR, active subscriptions, new customers) and a rail screen (overview, active users, trials, 90-day trend). Routes: `GET /status /discover /probe /warm /dashboard`, `POST /connect`. Config `.panel/revenuecat.json`; key in Keychain `com.appgea.panel.revenuecat` (stdin, never argv) → fallbacks `REVENUECAT_API_V2_KEY`, project/Claude MCP Bearer, or legacy gitignored state keys (read-only). 5-minute cache; today is provisional. Guided setup: Open RevenueCat API keys → create V2 key "Panel read-only" (Projects, Overview, Charts read) → paste → Connect securely. Tests: `test_host.py`.

### server-health (public; needs `python3`) — see its [AGENT.md](../host/modules/server-health/AGENT.md)
Portfolio-wide uptime board (Settings → Servers). Ships an **empty list**. Per-target checks `dns tcp http redirect tls json json_parses body latency`; `expect {status, json, body_contains, redirects_to, follow_redirects}`; `tls_warn_days` (default 21), `timeout_s` (10), `slow_ms` (2500), `port`, `enabled`, `note`. **Unknown fields are rejected on purpose.** States `up / degraded / down / skipped`; `down` needs two consecutive misses to be `confirmed`. Routes: `GET /portfolio[?fresh=1] /check?id= /targets /schema`; `POST /targets/add|remove|toggle|` and `--sweep`. List at `~/.appgeapanel/state/server-health/targets.json` (edit that, never `assets/targets.default.json`). Optional launchd sweep: `host/modules/server-health/install-sweep.sh` every 5 min (`--uninstall`). It knows nothing inside the boxes — a 200 only means the front door opened.

### support (public; needs `python3`) — see its [AGENT.md](../host/modules/support/AGENT.md)
Reads every app's Google Form responses into one inbox (Support screen). Read-only against Google. Routes: `GET /setup /forms /inbox?days=&app=&unread=1&limit= /schema`; `POST /autodiscover /scan /fetch /read`. `setup.stage` ∈ `no_key | no_access | partial | ready`. Setup: `POST /autodiscover` (registers the repos' fastlane Google identity by path) or drop `*.sa.json` into `state/support/secrets/`; enable Drive + Forms APIs in that project; **share every form with `grant_email` as Editor** (Viewer isn't enough); `POST /fetch`. The registry is *scanned* from the repos (store `support_url.txt`, privacy pages, `Links.swift`…) — never hand-edit `forms.json`; unreadable forms are listed in `forms_unreachable`; forms Drive sees that no repo publishes are `orphan_forms`. `SUPPORT_ENABLE_ADC=1` allows gcloud ADC (needs a login that carried Forms scopes). Tests: `test_sources.py`.

### Product Spine (not in this checkout)
Deterministic product-ownership layer: Flutter-first extractor, one-shot host; per the overview it
subscribes to `PostToolUse`/`UserPromptSubmit` hooks to flag edits touching a recorded decision. The app
embeds only its `map.json` (native canvas, `spine_map.ts`); the Python-rendered pages
(`system business findings delta wire`) still exist for the CLI. A project is "registered" with it by key.
Note the hook subscription described there is a Python-Panel feature: this Rust ingress replies `{}` to
every hook and does not fan out to modules (unverified for external modules).

## 6. Motion ledger (`motion.json`)

Every animation has a namespaced id `<namespace>:<name>`; `core:*` is the reserved shared block; a module owns the namespace equal to its `name`. Motion encodes a fact, never decoration: living state may loop, discrete events play once and settle. A shared motion appearing in ≥2 namespaces graduates to `core:*`. UI budget: only `transform/opacity/filter`; no animating width/height/top/left or box-shadow; no `setInterval` repaint loops; canvas loops stop when idle.
