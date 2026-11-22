---
title: Does the port keep what the old app and the other platform do?
family: history
agent: claude
---

Lens: the user who moved from the old app, or from the same app on the other phone, to this build. Read only.

1. The run names the app. Find the references that exist: the old app, the other platform's code, the rule docs.
2. List the screens, the largest first.
3. Per screen, list what a user can do on each side.
4. Answer each with a `path:line` on both sides. One side missing or different is the lead.
5. Stop at 3 findings, or after 3 screens.

A finding: the old app or the other platform does it at `path:line`, this side does not, and a user notices.
Not a finding: a difference the old app got wrong, a platform convention that differs on purpose.

## Learned
