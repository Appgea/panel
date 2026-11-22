---
id: review-prompt
title: Apps request the native store review prompt
applies: all
check: |
  python3 "${APPGEA_OPS:-$HOME/.appgeapanel/ops}/_system/standards.py" --check review-prompt
---

Find a native review request call in production Swift, Kotlin or Dart source. Tests and generated build folders do not count. This is a source audit, so the weekly beat still inspects trigger timing.
