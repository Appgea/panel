---
title: Do the plans on the paywall make sense beside each other?
family: analytics
parts: purchase
agent: claude
---

Lens: the paywall's plans as a row of choices: which comes first, which is picked for the user, what the saving says. Read only.

1. The run names the app. Write down each live plan: id, period, price, trial.
2. Open the paywall screen and its model in the code.
3. Answer each with a `path:line`: which plan is selected by default, is the saving computed from live prices or a constant, does a trial show its terms, does each live plan appear, does the order lead with the plan you want sold.

A finding: a saving that is wrong or hard-coded, a default that hides the best plan, a live plan the paywall never shows, a trial with no terms.
Not a finding: the price itself, paywall art, a plan removed on purpose as `apps/<key>.md` says.

## Learned
