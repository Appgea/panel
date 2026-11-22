---
title: Does every way into the app and through a failure end somewhere useful?
who: a user already inside the app, off the main path. Evidence: the code of routes, callbacks, saves and messages.
every: routine
agent: claude
---

Lens: the user's path, but not from the icon. The doors besides the icon, the messages a failure shows, and the
reminders that call a person back. Read only.

Abilities, in `scouts/abilities/`:
- `entry-points`: notification taps, widgets, deep links, shortcuts, share targets, live activities.
- `error-copy`: every message a failure shows: its language, what to do next, a retry.
- `notification-value`: each reminder's text, timing, tap target, and when the permission is asked.
- `interrupted-session`: Back, dismissal and backgrounding during a task with unsaved progress.
- `network-recovery`: a dropped, doubled or cancelled live connection, its framing and peer presence.
- `tab-return`: switching tabs and returning to an in-progress flow.
- `state-lost-on-lifecycle`: state kept across lifecycle transitions and interrupted saves.
- `save-confirmation`: a Save the device refuses, followed back to what the screen tells the user.
- `restored-route`: the screen the app reopens by itself, after its destination is gone.
- `callback-after-exit`: a result that arrives after the user left its screen.

Yours to add when all of them ran on the app: other ways a path ends nowhere. For example, the back gesture on
each screen of the core flow, a screen reader's path through it, a rotation or split view mid-task, an empty state
with no next step, or a settings change that the next screen ignores.

A finding: a path a user can take that ends on the wrong screen, with stale state, or with no way forward, at
`path:line`, with the steps that reach it.
Not a finding: a path no build can reach, a wording preference, a missing feature.
