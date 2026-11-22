---
title: Does the app ask for a rating right after a good moment?
family: keeper
agent: claude
---

Lens: the one moment the app asks a user to rate it, and what that user did in the minute before. Read only.

1. The run names the app. Find every rating prompt call in the code.
2. For each call, read its caller and write down the trigger: the event, the count or the day.
3. Check each trigger: is it after a good moment, never in the first session, guarded against repeats?
4. No call at all: name the app's best moment, where it should go.

A finding: a live app with no rating prompt, or a prompt that can fire at a bad moment or in the first session.
Not a finding: a prompt after a good moment with a guard, an app before its first release, a kids' app.

## Learned
