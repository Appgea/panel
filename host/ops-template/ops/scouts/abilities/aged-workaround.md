---
title: Does an old workaround still match the app it now guards?
family: history
agent: claude
---

Lens: an old compatibility rule, read against the callers it guards today. Read only.

1. The run names the app. Take the newest three shipped tags.
2. Find workaround code: comments with `workaround`, `hack`, `legacy`, `compat`, `temporary`, and version checks.
3. For each, find the commit that added it and the task it names.
4. Check whether the reason still holds for the callers today.

A finding: a rule made for an older app state that now harms a reachable user, with the commit that added it and the caller it now breaks.
Not a finding: dead code, harmless old wording, an intentional fallback.

## Learned
