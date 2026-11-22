---
title: What did time change in this app, and what did it break?
who: a user who updates from an older build. Evidence: the releases, the git history and the sibling apps' fixes.
every: routine
agent: claude
---

Lens: the app across time instead of as it stands today. Its releases, the saves its users carry from older builds,
and the bugs its sibling apps fixed this month. Read only.

Abilities, in `scouts/abilities/`:
- `release-diff`: the last shipped release read as one pull request, for changes nobody meant.
- `upgrade-path`: the last release against HEAD, for saves, settings or purchases an updating user loses.
- `sibling-fix`: this month's fixes in other apps, as a list of bugs to look for here.
- `aged-workaround`: old compatibility rules checked against current callers.
- `native-parity`: a port held against the old app and the other platform, for what it dropped.

Yours to add when all of them ran on the app: what else time does. For example, a feature flag or a remote config
whose default changed, a dependency bump in the lockfile and what it changed, a hotfix comment older than two
releases that still guards a user path, or a reverted commit whose bug came back.

A finding: something a user meets because of a change over time, at `path:line`, with the commit or tag that brought it.
Not a finding: a change the task asked for, a refactor with the same behaviour, style.
