---
id: settings-links
title: Settings exposes privacy and support link targets
applies: all
check: |
  python3 "${APPGEA_OPS:-$HOME/.appgeapanel/ops}/_system/standards.py" --check settings-links
---

Find privacy and support URL targets in settings source. A pass proves source evidence only. Check reachability and displayed copy during app verification. A constant or enum target counts, and a pass is source evidence to inspect, not proof the row works.
