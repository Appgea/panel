# Panel + native terminal — superseded

This file described the **old Python Panel** (a `panellib/` server, `web/dash/*.js`, `ttyd` + tmux in an
iframe, a right-hand companion panel, `GET /panel`, `/terminal/attach`). None of that is in this tree any
more; keeping the description here made it the most misleading document in the repo.

Current documentation lives in [`docs/`](docs/README.md):

| topic | file |
|---|---|
| how to use Panel | [docs/USER-GUIDE.md](docs/USER-GUIDE.md) |
| architecture, event flow, build, tests (incl. *Differences from the old Python Panel*) | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| HTTP routes, hooks, MCP tools, visual & ask vocabulary, how to add a visual/ask kind | [docs/PROTOCOL.md](docs/PROTOCOL.md) |
| Tauri commands, events, Rust modules, security | [docs/BACKEND.md](docs/BACKEND.md) |
| config files, per-project manifests, ops tree | [docs/CONFIGURATION.md](docs/CONFIGURATION.md) |
| extensions | [docs/MODULES.md](docs/MODULES.md) |

What still holds from the old design: the agent finds Panel only through its environment
(`PANEL_PORT`, `PANEL_INSTANCE`); deterministic hooks are the backbone and the model's MCP calls are the
intentional channel; `ask_user` blocks the agent until you answer in the ask tray; `registerView` /
`registerAsk` are one-line registries keyed by a free string.
