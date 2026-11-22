---
title: Does work survive leaving, recreating or returning to the app?
family: journey
agent: claude
---

Lens: a user who leaves or returns to work already in progress. Read only.

1. In the named app, find the lifecycle handlers, the state owners and the save paths.
2. Trace backgrounding, process death, rotation and returning, wherever the app supports them.
3. For each path, answer yes or no with `path:line`: is the state kept or discarded only after confirmation? Does the restored reader use the same state? If a write fails, is the old state still there?

A finding: the starting state, the transition, the lost values, and the source lines of the owner, the transition and the reader.
Not a finding: a confirmed discard, state the product never promises to keep, an unreachable transition.

## Learned
