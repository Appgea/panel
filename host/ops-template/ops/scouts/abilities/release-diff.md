---
title: What did the last release change that nobody checked?
family: history
agent: claude
---

Lens: the shipped release read as one pull request, the way a careful reviewer would have read it before it went out. Read only.

1. The run names the app. Pull its repo.
2. The last two shipped tags of one platform: `git tag --sort=-creatordate | head -4`.
3. `git log --oneline --no-merges <older>..<newer>` and `git diff --stat <older>..<newer>`.
4. Read the diff of each user-facing file. Look for a changed default, a removed guard, a copy change in one language only, a route that moved.
5. For each suspect, read the task its commit names to learn what was meant. Stop at 3 findings.

A finding: a behaviour a user of the shipped build meets that the change did not mean, at `path:line`, with the commit.
Not a finding: a change the task asked for, a refactor with the same behaviour, style.

## Learned
