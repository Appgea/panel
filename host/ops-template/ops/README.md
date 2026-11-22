# ops — what your portfolio permanently IS

This tree is read fresh on every question Panel's companion answers. It holds **durable facts and
standing rules**, and nothing else.

What belongs here:

- `portfolio.yaml` — the keyed spine. One row per product: id, stack, stores, dependency edges,
  and `focus` (the one to three you are actively pushing).
- `apps/<key>.md` — per-app durable facts. What the app IS.
- `decisions/index.md` — one line per standing decision. Always loaded.
  `decisions/<year>.md` — the reasoning, in your words. Never injected; pulled only when a
  `D-####` id is actually named.
- `direction.md` — where the portfolio is heading: goals, which apps to push, which to leave alone.
- `principles.md` — standing rules. `para.md` — how anything new gets filed.
- `runbooks/*.sh` — executable procedures. A script costs no context; prose costs it every turn.
- `scouts/` — lenses and their abilities: who to look as, and what to check. Runs file into `backlog.md`.
- `standards/` — rules every app meets. `_system/standards.py` prints the grid.
- `work/`, `backlog.md`, `log/` — what is in flight, what is queued, what happened.

What must NOT go here: anything derivable from git. Branch, dirt, last commit, whether work is in
flight — Panel reads all of that live. A hand-kept second copy of a derivable fact is a copy that
is wrong.

Edit any file and the next question sees it. There is no build step.

Every `_template.md` is a starting shape, not a rule. Delete what you do not use.
