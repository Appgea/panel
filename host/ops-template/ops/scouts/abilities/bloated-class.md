---
title: Which unrelated jobs have to change in the same file?
family: architecture
agent: claude
---

Lens: one large file whose jobs do not belong together, read through its history. Read only.

1. The run names the app. List the five largest hand-written files.
2. For each, `git log --format=%s -30 -- <file>` and group the commit subjects by job.
3. A file whose commits name three or more unrelated jobs is a suspect. Read it and name each job's lines.
4. Name the split: which lines move to which new file, and what imports change.

A finding: one file, its unrelated jobs with line ranges, the commits that had to touch them together, and the split one builder can do.
Not a finding: a long file with one job, a file that is stable, a rewrite.

## Learned
