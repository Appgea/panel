#!/bin/bash
# Appgea Panel — DEV mode (hot reload).
#
# Frontend changes (TS / HTML / CSS under apps/desktop/ui) hot-reload LIVE in the running
# window via Vite HMR — no restart, and the Rust process that owns your agents, terminals and
# broadcasts keeps running, so open sessions are NOT lost.
#
# Rust changes (apps/desktop/src-tauri, crates/*) are native code and cannot hot-swap: they need
# a recompile, which restarts the app and drops in-process sessions. Two modes for that:
#
#   ./dev.command              Rust edits auto-rebuild & restart the app (default tauri dev).
#   ./dev.command --no-watch   Ignore Rust edits — a running session is never killed mid-work.
#   PANEL_FROZEN=1 ./dev.command   Same as --no-watch (double-click friendly).
#
# In --no-watch, frontend HMR still works (Vite runs its own watcher); restart this script
# yourself when you actually want a Rust change picked up.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
# Tauri copies bundle.resources next to the dev binary, and the app runs from that copy. A
# fresh clone has nothing staged and fails to compile; an old stage runs stale host/ code.
"$ROOT/launcher/stage-resources.sh"
"$ROOT/launcher/prepare-ui.sh"
# appgeapanel:// links reach a dev build only through the link handler (see that script).
"$ROOT/launcher/make-link-handler.sh" || echo "link handler not installed; appgeapanel:// links will not open Panel"
# Tauri runs beforeDevCommand from apps/desktop. Its own CLI starts in src-tauri.
cd "$ROOT/apps/desktop/src-tauri"

args=()
if [[ "${PANEL_FROZEN:-}" == "1" || " $* " == *" --no-watch "* ]]; then
  args+=(--no-watch)
  echo "Appgea Panel dev: --no-watch (Rust edits ignored; frontend still hot-reloads)"
fi

if (( ${#args[@]} )); then
  exec cargo tauri dev "${args[@]}"
else
  exec cargo tauri dev
fi
