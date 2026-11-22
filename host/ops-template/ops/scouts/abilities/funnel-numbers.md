---
title: Which funnel step loses the most people?
family: analytics
parts: analytics
needs: browser
agent: claude
---

Lens: the analytics funnel and retention of one app. The step where most people leave becomes a finding, with the numbers. Read only.

1. The run names the app. Compare with the last run's note, which holds the numbers. Never copy them into a file.
2. Open the app's funnel in the analytics console: install, first open, onboarding done, paywall shown, purchase. Use the last 28 days.
3. Check `apps/<key>.md` and the recent releases: a fix still rolling out means the window shows the old app. Wait for clean days.
4. Find the screen in the code that owns the step with the largest drop.

A finding: the one step with the largest drop, with both counts, the window and the screen in the code that owns that step.
Not a finding: a drop inside a window that holds an old build, a step with under 30 users, a guess with no count.

## Learned
