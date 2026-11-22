---
id: crashlytics-wired
title: Apps connect Crashlytics to error reporting
applies: all
check: |
  python3 "${APPGEA_OPS:-$HOME/.appgeapanel/ops}/_system/standards.py" --check crashlytics-wired
---

Find Crashlytics plus an error reporting or collection hook in production source. A dependency alone is insufficient. This source audit does not prove dashboard delivery.
