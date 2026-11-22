---
title: Which two places decide the same rule?
family: architecture
agent: claude
---

Lens: one product rule, such as a price, a limit or an unlock, decided in two places that every fix must change together. Read only.

1. The run names the app. List the rules the README or `apps/<key>.md` names: limits, prices, unlocks, scoring.
2. For each rule, grep its value and its name across the source.
3. Two places that compute or hard-code the same rule are a suspect. Check the history: did a fix change one and miss the other?

A finding: the two `path:line` places, the value each holds, and the one place the rule should live.
Not a finding: a constant used in two places from one definition, a test that repeats a value on purpose.

## Learned
