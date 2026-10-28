# Protocol reference

Everything that crosses a boundary: the loopback HTTP routes, hook events, MCP tools, `panel_send.py`,
Tauri events, the visual and ask vocabularies, and how to extend them. Flow and rationale:
[ARCHITECTURE.md §3](ARCHITECTURE.md). Sources: `next/crates/panel-ingress`, `host/mcp/panel_mcp.py`,
`host/session_hook.py`, `host/panel_send.py`, `protocol.json`, `ui/src/views/*`.

## 1. Loopback HTTP (panel-ingress)

Bound to `127.0.0.1:<ephemeral>`; the port is in `~/.appgeapanel/ingress-port` and in each agent's
`PANEL_PORT`. All bodies/responses are JSON; an unparseable body is treated as `{}`. Any other path →
`{"error":"unknown endpoint"}`.

| route | body | response | caller |
|---|---|---|---|
| `POST /hook/<Event>` | `{instance, cwd, session_id, tool_name, tool_input, prompt, notification_type, message}` | always `{}` (Panel never injects context) | `session_hook.py` |
| `POST /panel/emit` | `{instance?, cwd?, project?, type, payload}` | `{id, routed:bool}` | `panel_mcp.py` (`panel_emit`, `send_to_user`), `panel_send.py` |
| `POST /panel/ask` | `{instance, spec, timeout?}` (timeout seconds, default **280**, min 1) | the answer object; `{"timeout":true}` on expiry; `{"error":"no project is bound to this agent"}` if unroutable (fails fast, no hang) | `panel_mcp.py` (`ask_user`) |
| `POST /panel/answer` | `{qid, value}` | `{ok:bool}` | tooling/tests (the app itself uses the `answer_ask` Tauri command) |

**Routing** (`emit` / `hook`): exact `instance` → else deepest registered project root containing `cwd`.
`/panel/emit` additionally accepts an explicit `project` id, honoured only if registered (no guessing from
cwd then). Unresolvable → hooks dropped silently; emit returns `routed:false`. `/panel/ask` resolves by
`instance` only.

**`emit` path normalisation.** In `payload`, every string (or `{path}` object) in `images`, `audio`,
`video`, `attachments`, `shots` is rewritten from absolute to project-relative with `/` separators.
`_panel_project` is added to the payload. `view = body.type` (default `card`); `title = payload.title`;
`session_id = instance`.

## 2. Hook events → Panel events

`session_hook.py` forwards `hook_event_name` (no event name → exit). Mapping in `Ingress::on_hook`:

| hook | condition | emits |
|---|---|---|
| `PreToolUse` | tool ∈ Edit, Write, MultiEdit, NotebookEdit | nothing emitted; captures the **before-image** (≤1 MB file, inside project) for replay |
| `PostToolUse` | tool = `Skill` and instance is a registered agent | records the skill name (dedup, ≤1000); `Activity{label:"Skill", detail:name, finished, success:true}` |
| `PostToolUse` | edit family, non-empty path | captures **after-image** → `ChangeStep`; `FileChanged{path, summary:tool}` |
| `PostToolUse` | `Bash`, command is git | `VisualRequested{view:"git-<kind>", payload:{kind, command≤200, cwd}}` |
| `PostToolUse` | `Bash`, command is a test/build | `Activity{label:"Tests passed"\|"Build completed", detail:command≤200, finished, success:true}` |
| `PostToolUse` | any other tool | `Activity{label:<tool>, finished, success:true}` |
| `UserPromptSubmit` | — | clears that project's replay log; `AgentStatus{status:"thinking", detail:first non-empty prompt line ≤96}` |
| `Stop` | — | `TurnFinished{success:true}` (`SubagentStop` is not registered, so subagents don't count) |
| `Notification` | `notification_type` ∈ `permission_prompt`, `elicitation_dialog`; or empty type with "permission" in message | `AgentStatus{status:"waiting", detail:message≤160}` (`idle_prompt` etc. ignored — `Stop` already reported) |

Git kinds recognised (`git_kind`, last completed git moment in a command; handles `-C`, `cd … &&`, `;`, newlines):
`commit push pull merge rebase checkout branch stash reset revert tag fetch clone add`.
Test prefixes: `cargo test, flutter test, dart test, pytest, python[3] -m pytest, npm test, npm run test, pnpm test, yarn test, go test, swift test, xcodebuild test`.
Build prefixes: `cargo build, flutter build, npm run build, pnpm build, yarn build, go build, swift build, xcodebuild, dart compile`.
`PostToolUse` is the success hook, so `success:true` is always set; failures aren't guessed from shell text.

`session_id` = `instance` when present, else Claude's own `session_id` (older forwarders).

## 3. Events (Rust → UI)

Tauri event `panel-agent-event`, payload `ProjectEvent = {project, kind, session_id, …}` (the `PanelEvent`
flattened; `kind` is snake_case).

| kind | fields |
|---|---|
| `session_started` | `provider` |
| `agent_text` | `text, append` |
| `agent_status` | `status, detail?` — the ingress emits `thinking` (prompt submitted) and `waiting` (permission/elicitation prompt). The UI also treats `asking` as mid-turn and `idle\|done\|complete\|error\|failed` as ending the phase |
| `activity` | `activity_id, state: started\|finished, label, detail?, success?` |
| `file_changed` | `path, summary?` |
| `ask_requested` | `qid, spec` |
| `ask_resolved` | `qid, answered` |
| `visual_requested` | `view, title?, payload` |
| `turn_finished` | `success, summary?` |
| `error` | `session_id?, message` |

Schema note: `next/protocol/panel-events.schema.json` lists `permission_requested` (which is not a
`PanelEvent` variant) and omits `ask_requested`/`ask_resolved`; `panel-ui.schema.json` enumerates only
`card, progress, files, diff, decision, git_review`. Both are looser/older than the code and are not
enforced anywhere found in the Rust or UI source (unverified: no validator located). The Rust enum and the UI registry are authoritative.

Other Tauri events: see [BACKEND.md §2](BACKEND.md).

## 4. MCP server `appgea-panel` (`host/mcp/panel_mcp.py`)

Stdio, newline-delimited JSON-RPC, MCP `2024-11-05`, no third-party deps. Reads `PANEL_PORT` (default
7391) and `PANEL_INSTANCE`. `tools/list` returns three tools.

### `panel_emit`
Fire-and-forget visual. `type` (required, free string → renderer key), `payload` (object). Use only for things hooks can't see (a phase, a plan, a result). Returns `emitted event <id>`.

### `send_to_user`
A **report**, not a chat message: prose is filed to the brain; the Inbox shows the headline + media.
Sent as `/panel/emit` with `type:"message"`.

| param | req | notes |
|---|---|---|
| `title` | ✔ | short |
| `text` | ✔ | one brief explanation |
| `outcome` | ✔ | `progress` \| `done` \| `blocked` \| `needs_decision` |
| `flow` | ✔ (≥1) | `[{ref, label, detail}]`; `ref` = `path:line`; 2–5 steps |
| `images` | | strings or `{path, caption}`; **every screenshot, captioned** |
| `audio` | | strings or `{path, caption}`; plays inline |
| `video` | | strings or `{path, url, caption}`; never inline — opens in a real player |
| `attachments` | | strings or `{path, label, kind: file\|folder}` |
| `links` | | strings or `{url, label}`; web URLs or Panel places (below) |

**Panel places** (`ui/src/deeplink.ts`). One-click doors into the report's own project; paths are
project-relative. The same text printed in an agent terminal is ⌘/Ctrl-clickable.

| link | opens |
|---|---|
| `panel:review` | Review, on this report's images/audio/video (else the project's queue) |
| `panel:review:<path>` | Review, on that file |
| `panel:work:<path>[:<line>]` | the file in the Work editor, at that line |
| `panel:git` | the project's Git tab |
| `panel:manager` | the Manager |

**`appgeapanel://` links** (same file, `parseAppLink`). The same places from OUTSIDE Panel — a
notification, a note, Shortcuts, Raycast — so they name the project. A link never starts anything;
the furthest it goes is putting a Resume button in front of you.

| link | opens |
|---|---|
| `appgeapanel://home` · `appgeapanel://review` · `appgeapanel://manager` | that screen |
| `appgeapanel://history[?q=<words>]` | History, searching if asked |
| `appgeapanel://session/<agent-session-id>` | History, on that session (any agent) |
| `appgeapanel://project/<id>[/git\|/review[/<path>]\|/work/<path>[:<line>]]` | the project, or one of its places |
| `appgeapanel://open/<full path>[:<line>]` | any file: Panel finds its project, Review for media, Work for code. A folder outside every project opens in Finder. A file there is only shown in Finder |

**Who receives a link.** On macOS a small handler app, `~/Applications/Appgea Panel Links.app`, owns
the scheme (`launcher/make-link-handler.sh`; `dev.command` and `build-app.sh` run it). It POSTs the
link to whichever Panel is running, dev build or installed, at `POST /panel/link` on the ingress
(`{"url": "appgeapanel://…"}`, `Content-Type: application/json` required, so a web page cannot fire it
without a preflight the ingress never answers). With no Panel running it appends the link to
`~/.appgeapanel/pending-links` and opens the installed app, which drains that file on startup. The
Panel bundle itself does not claim the scheme on macOS (`tauri.macos.conf.json`), so LaunchServices
has one owner. Windows and Linux register the scheme at runtime and forward a link to the running
Panel (single-instance plugin) instead of opening a second one.

A report with media gets a **Review** button without any link. Anything that is neither a web URL
nor a place renders as a struck-out chip, so a wrong link is visible.

### `ask_user`
Blocks until answered. Params: `prompt` (required), `kind`, `title`, `options`, `fields`, `path`, `draft`,
`why`, `handoff`, `timeout`. Forwarded as `spec` (only these keys) to `/panel/ask`; the tool result is the
JSON-encoded answer. HTTP client timeout = `timeout + 20`.

## 5. `panel_send.py` (any engine, no MCP)

`python3 panel_send.py --title T --text X --outcome {progress|done|blocked|needs_decision} --flow 'REF|LABEL|DETAIL' [--flow …] [--image P]… [--audio P]… [--video P]… [--file P]… [--folder P]… [--link U]…`
Posts the same `message` payload to `/panel/emit` using `PANEL_PORT`/`PANEL_INSTANCE` (and `cwd` as a routing fallback). The path is injected into every agent as `PANEL_SEND`.

## 6. Ask kinds and answers

Registered widgets (`ui/src/views/index.ts` + `asks.ts`). Unknown/missing kind → `pick` if `options`
present, else `text`. `prompt` is aliased to `ask`; string options become `{id,title}`; an option with
`recommended:true` becomes `rec`.

| kind | spec fields | answer returned to the agent |
|---|---|---|
| `pick` / `choice` | `ask`/`prompt`, `options[{id,title,desc,recommended}]`, `rec`, `why`, `ref` | `{"id": "<option id>"}` |
| `multi` | + `rec:[ids]`, `min`, `max` | `{"ids": [...]}` |
| `text` | `ask`, `draft`, `multiline` (⇧⏎ for newline) | `{"text": "..."}` |
| `tier` | `ask`, `tiers:[labels]`, `rec`, `why` | `{"tier": "<label>"}` |
| `confirm` | `action`/`ask`, `detail`, `danger` | `{"confirmed": true\|false}` |
| `card` | a full `card` view whose last `input` block is armed | `{"<inputId>": <scalar>}` |
| `document` | `path` (default `.panel/agent-input.md`), `title`, `prompt`/`ask`/`why`, `draft` (used only if `path` is absent) | `{"path", "contents"}` after the human edits in **Work** and presses Continue |

Always possible: `{"skipped": true}` (Skip button in the tray) and `{"timeout": true}` (default 280 s).

`signature`: `rec` + `why` puts the agent's name on a recommendation (shown as a "rec" chip); the human can override.

**Not implemented in the UI** (grep of `ui/src` finds no reader): MCP-accepted `fields` (the old `form` kind) and `handoff` (`{task, provider?, button?}` — the old PANEL.md described a button that starts a new session). `form` falls back to `text`; `handoff` is ignored. Treat both as unavailable.

## 7. Visual (`view`) types

Renderer registry (`registerView`): `trace`, `card`, `structure`, `showcase`, `educate`, `message`, `sim`.
Handled specially in `main.ts` instead of rendered: `worklist`, `git-*`, `sim` (also rendered). Any other
type renders as a `card`; a renderer that throws renders a raw JSON dump (an ugly card beats silence).
Core vocabulary and authoring guidance live in `protocol.json` (single source of truth for core types;
modules add types via their `module.json`).

| type | kind | payload (example from `protocol.json`) |
|---|---|---|
| `trace` | display | `{title, steps:[{ref:"path:line", label, detail}]}` — replayable walk through code you read |
| `card` | display+input | `{title, icon?, ref?, blocks:[…]}` — generic; blocks below |
| `pick` `multi` `text` `tier` `confirm` | input / gate | same specs as §6; as a *view* they're an input-kit element (usually inside a card's `input` block). `confirm` posts alone, never queued with picks — use for irreversible/money/publish actions |
| `worklist` | display | `{title, files:[{path, why, ref?}]}` — files the **human** must touch, each with a reason; becomes the Work list for that terminal until the next prompt |
| `structure` | display | `{layers:[…], nodes:[{id, layer:int, label, hot?, violation?}], deps:[[from,to],…]}` — architecture blueprint |
| `showcase` | display | `{shots:[{title, cap, color}]}` — phone mockups; also filed in Reports |
| `educate` | display | `{classes:[{n, l, file, p, f, t}]}` — name, layer, `file:line`, what it is, what breaks if it fails, depends-on |
| `message` | display | the `send_to_user` payload (§4) + `_panel_project`, `_panel_note` (path of the filed report) |
| `sim` | status | `{state, device, address, kind, ms?, terminalId}`; `state` ∈ `launching running reloaded restarted error` (at least; `start_sim` may emit lifecycle states of its own — unverified); emitted by `sim.rs` from run output, not by agents |
| `git-<kind>` | status | `{kind, command, cwd}` — from the Bash hook; drives the workshop checkpoint and the Git tab's pull/commit/push scene when visible |

`card` blocks: `heading{text,sub?}` · `text{md}` (inline **bold**/`code` only) · `kv{rows:[{k,v,tone?}]}` ·
`meter{label,value,max?,tone?,note?}` · `badges{items:[{text,tone}|string]}` · `steps{items:[{label,state,note?}]}`
(state: done\|active\|pending\|fail) · `callout{tone,text}` (tone: info\|ok\|warn\|risk) · `coderef{file,lines?,note?}` ·
`table{cols≤4, rows}` · `divider{}` · `input{input:{…}}` (always last).

Old docs mention `note`, `milestone`, `status`, `tool`, `progress` animations; none are registered now → they render as cards.

## 8. Extending

**New visual** — `ui/src/views/index.ts` (or any module loaded at start):
```ts
import { registerView } from "../registry";
registerView("deploy", (payload, ctx) => {
  const el = document.createElement("article");
  el.className = "view";
  el.textContent = `${payload.env} · ${payload.sha}`;
  return el;                       // ViewRenderer = (payload, ctx) => HTMLElement
});
```
No Rust change: the ingress and `panel_emit` pass the type string through. An agent then calls
`panel_emit(type="deploy", payload={env:"prod", sha:"ab12"})`.

**New ask kind** —
```ts
import { registerAsk } from "../registry";
registerAsk("rating", (spec, answer, ctx) => {   // AskWidget
  const box = document.createElement("div");
  [1,2,3,4,5].forEach(n => {
    const b = document.createElement("button");
    b.textContent = "★".repeat(n);
    b.onclick = () => answer({ rating: n });      // whatever object the agent should receive
    box.append(b);
  });
  return box;
});
```
The agent calls `ask_user(kind="rating", prompt="…")` and gets `{"rating": 4}`. Note the MCP schema
description lists only `choice|multi|confirm|text|document`; other kinds work because `kind` is a free string.

**Module-contributed types, animations, tabs** — `module.json`: see [MODULES.md](MODULES.md).
**Motion ids** — namespaced `<namespace>:<name>`, ledger in `motion.json` (`core:*` reserved; a module owns the namespace equal to its `name`). Motion budget: animate only `transform/opacity/filter`; no `setInterval` repaint loops; canvas loops stop when idle.

