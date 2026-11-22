---
title: Secrets, stored data and old packages
who: an attacker, a store reviewer or a reader of a leaked repo. Evidence: the repo, its history and the built app.
own: steps
every: routine
agent: claude
---

Lens: what an attacker, a store review or a leaked repo would find, one app a run. Read only.

Abilities, in `scouts/abilities/`:
- `erase-leaves-copy`: every copy of the user's data that survives the erase the app promises.

1. The run names the app. Pull its repo.
2. Read in this order, and stop at 3 findings:
   - Secrets: an API key beyond the public client ones, a keystore, `.env`, a service account, in the tree or in
     history (`git log --all -p -S '<prefix>'`). Name the file. Never print or paste a secret's value.
   - Data at rest: tokens, emails or health data in plain preferences, a database or a log line.
   - Network: plain `http://`, a cleartext or arbitrary-loads exception, a disabled certificate check, a web view with
     JavaScript and a file or remote URL.
   - Trust: a reward, a coin count or an entitlement the client decides alone when a server or the store should.
   - Packages: the dependency versions with a known advisory or end of life (`npm audit`, `flutter pub outdated`,
     the Gradle and Swift package versions).

A finding: a `path:line` or a package version, what someone can do with it, and a fix one builder can do.
A live secret is top priority, and the fix is a key swap, which is the owner's call.
Not a finding: a public client key meant to ship, a theory with no path, a secret in a git-ignored local config that
never entered history. Check `git check-ignore -v FILE` and `git log --all -- FILE` first.
