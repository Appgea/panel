---
title: Does the next update keep what the last release saved?
family: history
agent: claude
---

Lens: the gap between the last shipped build and the code that ships next, read for what a person who updates loses. Read only.

1. The run names the app. Pull its repo.
2. The last shipped tag per platform: `git tag --sort=-creatordate | head -6`.
3. The files that read or write stored data, changed since that tag: `git diff --stat <tag>..HEAD` filtered to storage, settings and purchase code.
4. In each diff look for a renamed key, a changed format, a removed field, a new required field with no default.
5. Prove the path: name the old build's writer (`git show <tag>:<path>`) and the new reader at `path:line`.

A finding: a user who updates from the tagged release loses data, a purchase or a setting, with the old writer and the new reader.
Not a finding: a change with a migration that covers it, data only debug builds write, a new field with a safe default.

## Learned
