---
title: Can finishing an operation after leaving its screen crash the app?
family: journey
agent: claude
---

Lens: a result, such as a network reply, a purchase or a timer, that arrives after the user left its screen. Read only.

1. Find async work started from a screen: requests, purchases, timers, streams.
2. For each, check what runs when the result arrives: does it touch the screen's state or navigation?
3. Check for a guard: a mounted or alive check, a cancellation on dispose.

A finding: a callback that touches a gone screen and crashes or navigates wrongly, at `path:line`.
Not a finding: work cancelled on dispose, a callback that only writes to a store.

## Learned
