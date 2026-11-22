---
title: Structure that slows every change
who: the next builder who must change this code. Evidence: file sizes, imports, the layer contract in the README.
own: steps
every: routine
agent: claude
---

Lens: the shape of the code, one app a run. A screen that skips its layer, dead code, state with two owners. Read only.
Bugs a user hits are `code-health`.

Abilities, in `scouts/abilities/`:
- `bloated-class`: one file whose unrelated jobs must change together.
- `rule-in-two-places`: one rule decided in two places that every fix must change together.

1. The run names the app. Its folder is `dir:` in `portfolio.yaml`. Read its README: the layers it names are the contract.
2. Size it. List the largest hand-written source files, generated and build folders excluded, for example
   `find lib src ios android -name '*.dart' -o -name '*.swift' -o -name '*.kt' -o -name '*.ts' | xargs wc -l | sort -rn | head -15`.
   Read the top 3, and the last 30 commits that touch them (`git log -30 --stat`).
3. Look for, in this order:
   - A screen that writes storage, network or purchases directly when the README says only one layer does.
   - Dead code: a file, screen or flag nothing reaches. `grep -rn` its name and its import. Deleting it is a finding.
   - State with two owners: the same value cached in two places and kept in sync by hand.

A finding: a split, a delete or a single source of truth one builder can do in one sitting, with `path:line` evidence
and the cost named: the issue or commit it already slowed, or the drift it already caused.
Not a finding: a long file that is stable and has one job, a rewrite, a new framework, style, naming, a missing test.
Stop at 3.
