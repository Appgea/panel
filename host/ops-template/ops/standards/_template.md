---
id: <kebab-id>
title: <one line, plain>
applies: all            # or a list of portfolio keys: [app_a, app_b]
check: |                # OPTIONAL. Shell run from the app root. exit 0 = pass, 1 = fail, 2 = n/a.
  test -f something
fix: |                  # OPTIONAL. Shell run from the app root. Makes a failing app pass.
  echo "not scripted"
---

Why this is a standard. Your words. Two or three lines at most.

## Manual state

Only for standards with no `check:`. One line per app, `- <key>: pass|fail|n/a — note`.
Delete this whole block the day a `check:` is written.
