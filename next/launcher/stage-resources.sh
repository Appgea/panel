#!/bin/zsh
# Build the read-only tree that goes inside the app bundle.
#
# Tauri copies `bundle.resources` verbatim, so the filtering has to happen before it looks. What
# ships is decided by `"visibility": "public"` in each module.json — FAIL CLOSED: a module that
# forgets the field stays home. That rule is the difference between shipping a tool and shipping
# whatever happened to be in someone's checkout.
#
#   ./stage-resources.sh                 -> next/target/package/host
#   PANEL_PRIVATE=1 ./stage-resources.sh -> the same, plus everything marked private
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"     # …/panel
SRC="$ROOT/host"
OUT="$ROOT/next/target/package/host"

rm -rf "$OUT"
mkdir -p "$OUT/modules"

# The shims an agent is launched with, the schemas, and the ops skeleton. `config.json` is
# deliberately absent: it is one person's portfolio, and its presence in the bundle is also the
# signal `paths::migrate` reads as "this machine ran an older Panel".
for item in session_hook.py panel_send.py keep_media.py slack_mirror.py cpo-response.schema.json mcp ops-template; do
  [[ -e "$SRC/$item" ]] || { echo "missing: host/$item" >&2; exit 1; }
  cp -R "$SRC/$item" "$OUT/"
done

# The fallback report path must run from the bundle alone. Why: 2026-11-02 the bundled
# panel_send.py crashed on an unstaged keep_media import, and an agent's report nearly got lost.
(cd /tmp && python3 "$OUT/panel_send.py" --help >/dev/null) || { echo "bundled panel_send.py does not start: a host import is not staged" >&2; exit 1; }

shipped=()
skipped=()
for manifest in "$SRC"/modules/*/module.json; do
  name="$(basename "$(dirname "$manifest")")"
  visibility="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("visibility",""))' "$manifest")"
  ship="$(python3 -c 'import json,sys; print(str(json.load(open(sys.argv[1])).get("ship",True)).lower())' "$manifest")"
  if [[ "$ship" == "false" ]]; then
    skipped+=("$name")
  elif [[ "$visibility" == "public" || "${PANEL_PRIVATE:-}" == "1" ]]; then
    cp -R "$SRC/modules/$name" "$OUT/modules/$name"
    shipped+=("$name")
  else
    skipped+=("$name")
  fi
done

# A module's own state never belongs in the bundle — it is per-machine, and `secrets/` is exactly
# the thing you must not hand to a stranger. Modules resolve PANEL_STATE_DIR at runtime instead,
# so this is a belt-and-braces sweep over anything a stale checkout left behind.
#
# `.git` is here for a second reason. A module that is its own checkout brings thousands of loose
# objects, and git writes those MODE 444. Tauri re-copies the resource tree on every build, and a
# copy over a read-only file is `Permission denied` — the build dies and the message names no path.
find "$OUT" \
  \( -name secrets -o -name cache -o -name jobs -o -name .state -o -name __pycache__ -o -name .git \) \
  -type d -prune -exec rm -rf {} +
find "$OUT" \( -name creds.json -o -name '.DS_Store' -o -name '*.pyc' \) -type f -delete

# Product Spine regenerates these per user. They can contain private histories and must stay in
# PANEL_STATE_DIR, never inside a signed bundle.
rm -rf "$OUT/modules/product-spine/snapshots" \
       "$OUT/modules/product-spine/reports" \
       "$OUT/modules/product-spine/.worktrees"

echo "staged:  $OUT"
echo "shipped: ${shipped[*]:-none}"
echo "skipped: ${skipped[*]:-none}"

# Loud, because a credential leaving this machine is not a thing to discover later.
if leaked=$(find "$OUT" -type f \( -name '*.p8' -o -name '*.pem' -o -name '*key*.json' \) | head -5) && [[ -n "$leaked" ]]; then
  echo "REFUSING TO STAGE — credential-shaped files in the bundle:" >&2
  echo "$leaked" >&2
  exit 1
fi
