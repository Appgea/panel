---
title: Does a bug fixed in one app still live in its siblings?
family: history
agent: claude
---

Lens: the portfolio's own fixes, read as a list of bugs to look for. Read only.

1. The run names the target app.
2. List the last 30 days of fixes in every other app in `portfolio.yaml`: `git log --since=30.days --grep=fix --oneline`.
3. Keep the fixes whose cause is a pattern, not one app's rule: a missing lifecycle check, a purchase not awaited, a date in the wrong zone.
4. For each kept fix, `git show <sha>` and write the bad shape in one line. Grep the target for it.
5. Stop at 3 findings, or after 8 fixes checked.

A finding: the same root cause in the target, reachable by a user, at `path:line`, naming the sibling commit that fixed it there.
Not a finding: a pattern that looks alike but is guarded another way here, a fix to app-only rules, test or tool code.

## Learned
