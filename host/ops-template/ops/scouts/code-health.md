---
title: Code health, one app a run
who: any user on the main path, before the crash report arrives. Evidence: the production code and the analyzer.
own: steps
every: routine
agent: claude
---

Lens: bugs a user hits, found in the code before the crash reporter shows them. Read only.

Abilities, in `scouts/abilities/`:
- `date-or-money-math`: calendar, streak, price and currency sums worked through their real callers.

1. The run names the app. Pull its repo.
2. Read in this order, and stop at 3 findings: money code (purchase, restore, entitlement, receipt), app start and
   lifecycle, async code that touches UI or state after an `await` or a callback, network and sockets, then the
   analyzer or linter the repo already uses. Read only the files it flags as errors or warnings.
3. Look for: state read after an await with no mounted or alive check, a resource opened with no close on the error
   path, a catch that swallows a money error, a date or number parsed with no failure case, a grant that does not
   wait for the store, a chronic crash group the code explains.

A finding: a user-visible failure you can point to by `path:line`, with the input that triggers it. File it with the fix.
Not a finding: style, naming, a missing test, a refactor wish, a TODO, an analyzer info line, code that is odd but correct.
No build, no test run: they belong to the fix.
