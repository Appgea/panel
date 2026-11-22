---
title: Does Save keep the user's work when the device refuses the write?
family: journey
parts: save
agent: claude
---

Lens: a user who taps Save on a full or locked device. Read only.

1. Find every save path: files, databases, preferences, cloud writes.
2. For each, follow a failed write: does the error reach the screen, or does the screen say saved anyway?
3. Check that the user's input is still there after the failure.

A finding: a save that fails silently, says saved when it did not, or clears the input, with the `path:line` of the write and the screen.
Not a finding: a write that cannot fail, a cache.

## Learned
