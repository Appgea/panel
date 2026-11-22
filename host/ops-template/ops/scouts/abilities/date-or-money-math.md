---
title: Do calendar and money calculations match what the app shows?
family: code-health
parts: time
agent: claude
---

Lens: calendar, streak, price and currency sums worked through their real callers. Read only.

1. The run names the app. Find date and money code: `grep -rnE 'DateTime|Calendar|Duration|days|streak|price|amount|currency|round' <source>`.
2. For each calculation, write down its inputs and its callers.
3. Work three cases by hand: a day boundary in the user's time zone, a daylight-saving change, and a currency with no decimals or a price that rounds.
4. Compare each result with what the screen shows.

A finding: a calculation that gives the user a wrong day, streak, total or price, with the `path:line` and the case that breaks it.
Not a finding: a display format preference, a calculation no screen uses.

## Learned
