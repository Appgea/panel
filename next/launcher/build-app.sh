#!/bin/zsh
# Builds Appgea Panel as a REAL macOS app and installs it — instant launch, no compile, no
# notification, no dev server. This is the daily driver; dev.command stays the tool for
# working ON Panel (hot reload needs the dev server).
#
#   ./build-app.sh                 -> installs onto the Desktop
#   ./build-app.sh /Applications   -> installs into /Applications
#
# Re-run after pulling Panel changes you want in the installed app.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$HOME/Desktop}"
APP="$DEST/Appgea Panel.app"

build_args=(--bundles app)

# Decide what goes in the bundle BEFORE tauri copies bundle.resources. PANEL_PRIVATE=1 also
# ships the host modules not marked public.
"$ROOT/launcher/stage-resources.sh"

"$ROOT/launcher/prepare-ui.sh"

cd "$ROOT/apps/desktop/src-tauri"

cargo tauri build "${build_args[@]}" -- --locked

BUNDLE="$ROOT/target/release/bundle/macos/Appgea Panel.app"
if [[ ! -d "$BUNDLE" ]]; then
  echo "build finished but no bundle at: $BUNDLE" >&2
  exit 1
fi

# Sign the assembled app after resources have been copied into it, or the resource seal stays
# invalid. An ad-hoc signature changes with every build, so macOS privacy (TCC) forgets its
# Desktop grant and asks again. A real identity keeps the grant across rebuilds. Ad-hoc stays
# the fallback on a Mac without one.
identity="${PANEL_SIGN_IDENTITY:-$(security find-identity -v -p codesigning | awk -F'"' '/Apple Development/ {print $2; exit}')}"
codesign --force --deep --sign "${identity:--}" "$BUNDLE"
codesign --verify --deep --strict "$BUNDLE"

mkdir -p "$DEST"
rm -rf "$APP"
cp -R "$BUNDLE" "$APP"
touch "$APP"
echo "installed: $APP"
# The app itself does not own appgeapanel:// on macOS; the handler does, for dev and installed alike.
"$ROOT/launcher/make-link-handler.sh"
