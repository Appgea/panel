---
title: One plain line
who: the one person this lens looks as, and at which stage. Evidence: what only this lens reads.
every: routine
agent: claude
---

What to look at, and what counts as a finding. Your words, a few lines. Say where the lens ends and which lens
starts there. A narrow check is an ability, not a lens: `scouts/abilities/_template.md`, and `_rules.md` "Lens and ability".

Keys:
- `who`: a lens with abilities must have it. No other lens may have the same person and the same evidence.
- `own`: steps, when the lens file has steps of its own. They take a turn with its abilities. Leave it out when
  every run of the lens is an ability.
- `every`: `routine` for an agent scout, run once a round. `manual` for one you start. A script scout: hours like
  3h, `daily`, or a weekday name.
- `after`: the hour a daily or weekday script waits for. Default 8.
- `priority`: P0 to P3. P0 and P1 run first in a round. Default P2.
- `agent`: a session kind like claude, codex or opencode. Panel's Run button opens it as a terminal.
- `run`: a shell command run from the ops folder instead of an agent. No AI. Use exactly one of `agent` and `run`.
- `needs`: browser, when it needs a signed-in browser.

Abilities, in `scouts/abilities/`:
- `<ability-id>`: one line, what it checks.

Yours to add when all of them ran on the app: what else this person meets. Two or three examples.

A finding: what it is, and the evidence it carries (`path:line`, a number, a URL).
Not a finding: what looks close but is not, so a run does not file it.

## Learned
