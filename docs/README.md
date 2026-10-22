# Appgea Panel documentation

An admin panel for a portfolio of apps. Agents (`claude`, `codex`, …) run in real terminals; Panel
watches them, tells you which one needs you, and hands you the few files you have to touch.

| I want to… | Read |
|---|---|
| install it, first run, update, troubleshoot | [SETUP.md](SETUP.md) |
| **use** it — every screen, key and workflow | [USER-GUIDE.md](USER-GUIDE.md) |
| understand the design (hosted agents, two roots, routing) | [next/README.md](../next/README.md) |
| see how the pieces fit: crates, event flow, launch wiring, build, tests | [ARCHITECTURE.md](ARCHITECTURE.md) |
| look up a Tauri command, event, Rust module, or the security model | [BACKEND.md](BACKEND.md) |
| wire an agent to Panel: HTTP routes, hooks, MCP tools, visuals, ask kinds | [PROTOCOL.md](PROTOCOL.md) |
| find a config file/key, per-project manifest, or ops-tree file | [CONFIGURATION.md](CONFIGURATION.md) |
| write or run an extension (module) | [MODULES.md](MODULES.md) |
| the Git tab's design | [next/GIT.md](../next/GIT.md) |
| contribute / dev mode | [CONTRIBUTING.md](../CONTRIBUTING.md) |

## One-minute orientation

```
agent in a PTY ──hooks/MCP──► session_hook.py / panel_mcp.py ──HTTP 127.0.0.1──► panel-ingress ──► UI
                                                                      ▲ blocks on ask_user until you answer
~/.appgeapanel  = what you own (config.json, ops/, brain/, state/, modules/)     host/ = what Panel ships (read-only)
```

## Conventions used in these docs
- **"unverified"** marks a statement I could not confirm from the source (usually a code path that may be read elsewhere, or behaviour on a platform I didn't trace).
- Shortcuts are written macOS / Windows·Linux.
- These docs were written against the source tree as it stands; where an older doc, schema or comment disagrees with the code, the code wins and the disagreement is noted in the relevant file.

## Known gaps in the product itself (found while documenting)
- `features/sprint.ts` (Sprint screen) is not mounted by anything; its backend remains.
- `ask_user` `fields`/`handoff` are accepted by the MCP but ignored by the UI.
- `next/protocol/*.schema.json` are older/looser than the Rust enum and UI registry.
- `plainView` and `disabledModules` appear in the default `config.json` with no reader.
- `panel-store` (`JsonStore`) is a dependency with no call sites in `src-tauri`.
- Modules for Product Spine, Release and Analytics are referenced by the UI but not shipped in `host/modules/`.
