---
title: Does changing tabs keep the user's place and work?
family: journey
agent: claude
---

Lens: a user who switches tabs in the middle of a flow and comes back. Read only.

1. Pull the app repo. Find the tab controllers and nested navigators.
2. Pick a flow with progress, a draft or an unread item. Trace leaving its tab, coming back, and system Back.
3. Compare the visible action with the resulting state.

A finding: switching tabs or coming back that silently loses work, applies progress twice, or leaves the user on the wrong screen.
Not a finding: a deliberate, confirmed discard.

## Learned
