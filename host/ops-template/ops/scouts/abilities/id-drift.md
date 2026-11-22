---
title: Do the ids in the code match the live store and purchase backend?
family: money-links
agent: claude
---

Lens: the strings that tie the code to outside systems, checked against those systems. Read only.

1. The run names the app. Pull its repo.
2. The live side: product ids, entitlement ids, offering ids and ad unit ids, read from the store and backend consoles.
3. The code side, production code only.
4. Compare: an id the code asks for that the live side lacks, a product on one store only, an ad unit from another app.

A finding: a mismatch that makes a purchase, a restore, a paywall or an ad fail for real users, with the code at `path:line`.
Not a finding: an archived product nobody reads, a sandbox-only id in debug code.

## Learned
