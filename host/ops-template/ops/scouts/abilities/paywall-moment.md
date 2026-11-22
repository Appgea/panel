---
title: Does the first paywall meet the user at a reason to buy?
family: analytics
agent: claude
---

Lens: a new user's first session, from launch to first value and first paywall. Read only.

1. The run names the app. Pull its repo.
2. Find launch and routing: the entry point, the first route, the onboarding gate.
3. Find value and buying paths: `grep -rniE 'onboard|tutorial|paywall|purchase|subscribe|premium|upgrade' <source>`.
4. Follow the new-install defaults through each route and gate. Name the first useful result the app promises.
5. Trace locked actions a user clearly wants to a buy entry. Follow paywall dismissal, saved flags and later triggers.

A finding: a paywall blocks first value, a locked action has no way to buy, or a dismissal hides the paywall for good.
Not a finding: a deliberate paid-only product, an optional early offer, a reachable alternative buy entry.

## Learned
