---
title: Which copies survive the erase the app promises?
family: security
parts: save, cloud
agent: claude
---

Lens: every copy of the user's data, after the user taps erase or delete account. Read only.

1. Find what the app promises: a delete account, a reset, an erase all data.
2. List every place user data lives: preferences, databases, files, caches, the keychain, cloud backups, the server.
3. Follow the erase path and mark which of those it clears.

A finding: a copy the erase leaves that the promise covers, with the store's `path:line` and the erase path that skips it.
Not a finding: data the policy says is kept, an anonymous crash log.

## Learned
