---
id: consent-before-analytics
title: Analytics starts disabled and has a consent API
applies: all
check: |
  python3 "${APPGEA_OPS:-$HOME/.appgeapanel/ops}/_system/standards.py" --check consent-before-analytics
---

Require an explicit default-off configuration for every present mobile platform plus a consent or collection API in production source. No supported Firebase analytics SDK is n/a. A pass identifies wiring for inspection. It does not prove event ordering or consent semantics at runtime.
