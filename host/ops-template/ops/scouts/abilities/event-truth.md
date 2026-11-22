---
title: Do the money numbers count what really happened?
family: analytics
agent: claude
---

Lens: the instrumentation behind the funnel, read as an auditor reads a ledger. Read only.

1. The run names the app. Pull its repo.
2. List every analytics event call in production code.
3. Keep the funnel ones: onboarding done, paywall shown, purchase started, purchase done, trial started, restore.
4. Check each against its moment: does it fire once, after the thing happened, and never on a failed or cancelled path?
5. Stop at 3 findings.

A finding: a funnel number that is wrong today, with the call site at `path:line`, the moment it counts instead, and the decision it misleads.
Not a finding: an event nobody reads that is also correct, naming style, a missing event with no decision behind it.

## Learned
