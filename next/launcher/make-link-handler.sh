#!/bin/bash
# Builds "Appgea Panel Links.app": the one app on this Mac that owns appgeapanel:// links.
#
# macOS hands a URL scheme only to an app bundle. A `cargo tauri dev` build is a bare binary, so
# it could never receive a link, and an installed Panel that owned the scheme would launch a
# SECOND Panel beside a dev one. This handler owns the scheme instead. Each link it receives goes
# to whichever Panel is running, dev or installed, over the ingress (POST /panel/link). With no
# Panel running it keeps the link in ~/.appgeapanel/pending-links and opens the installed app,
# which takes the link on startup.
#
#   ./make-link-handler.sh            -> ~/Applications/Appgea Panel Links.app
#
# dev.command and build-app.sh run this; it is quick and safe to run again.
set -euo pipefail
[[ "$(uname)" == "Darwin" ]] || exit 0

DEST="${PANEL_LINK_HANDLER_DIR:-$HOME/Applications}"
APP="$DEST/Appgea Panel Links.app"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# The applet only receives the Apple event; the shell script does the work, so it can be read
# and tested on its own.
cat > "$work/handler.applescript" <<'APPLESCRIPT'
on open location theURL
	do shell script quoted form of (POSIX path of (path to me) & "Contents/Resources/forward.sh") & " " & quoted form of theURL
end open location

on run
	-- Opened by hand rather than by a link: there is nothing to do.
end run
APPLESCRIPT

cat > "$work/forward.sh" <<'SH'
#!/bin/sh
# Hand one appgeapanel:// link to the running Panel, or keep it for the next one.
url="$1"
case "$url" in appgeapanel:*) ;; *) exit 0 ;; esac
root="${PANEL_USER_HOME:-$HOME/.appgeapanel}"
port="$(cat "$root/ingress-port" 2>/dev/null || true)"
# JSON-escape the two characters that could break the string; a URL carries no control bytes.
body="$(printf '%s' "$url" | sed 's/\\/\\\\/g; s/"/\\"/g')"
if [ -n "$port" ] && curl -fsS -m 3 -H 'Content-Type: application/json' \
    --data-binary "{\"url\":\"$body\"}" "http://127.0.0.1:$port/panel/link" 2>/dev/null | grep -q '"ok":true'; then
  exit 0
fi
mkdir -p "$root"
printf '%s\n' "$url" >> "$root/pending-links"
open -b com.appgea.panel 2>/dev/null || true
SH

mkdir -p "$DEST"
rm -rf "$APP"
osacompile -o "$APP" "$work/handler.applescript"
install -m 0755 "$work/forward.sh" "$APP/Contents/Resources/forward.sh"

plist="$APP/Contents/Info.plist"
buddy=/usr/libexec/PlistBuddy
"$buddy" -c "Set :CFBundleIdentifier com.appgea.panel.links" "$plist" 2>/dev/null \
  || "$buddy" -c "Add :CFBundleIdentifier string com.appgea.panel.links" "$plist"
"$buddy" -c "Add :CFBundleName string Appgea Panel Links" "$plist" 2>/dev/null || true
# No Dock icon and no menu bar: it lives for the length of one link.
"$buddy" -c "Add :LSUIElement bool true" "$plist" 2>/dev/null || "$buddy" -c "Set :LSUIElement true" "$plist"
"$buddy" -c "Delete :CFBundleURLTypes" "$plist" 2>/dev/null || true
"$buddy" -c "Add :CFBundleURLTypes array" "$plist"
"$buddy" -c "Add :CFBundleURLTypes:0 dict" "$plist"
"$buddy" -c "Add :CFBundleURLTypes:0:CFBundleURLName string Appgea Panel link" "$plist"
"$buddy" -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" "$plist"
"$buddy" -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string appgeapanel" "$plist"

# osacompile signs ad hoc; editing Info.plist broke that seal, so sign it again.
codesign --force --sign - "$APP" >/dev/null 2>&1 || true
"$LSREGISTER" -f "$APP"
echo "link handler: $APP"
