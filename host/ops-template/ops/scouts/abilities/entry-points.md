---
title: Does every way into the app reach its intended state?
family: journey
agent: claude
---

Lens: every implemented entrance besides the icon, on cold and warm start. Read only.

1. The run names the app. Pull its repo.
2. List the registrations: URL schemes, associated domains, intent filters, widgets, shortcuts, share targets, notification payloads.
3. Find their receivers and routes in the code.
4. Build a sender, payload, receiver, route map for each.
5. Follow cold start through storage and auth loading, and warm start through the existing stack.

A finding: a registered entrance that opens the wrong screen, drops its payload or reads state before it has loaded.
Not a finding: a missing optional integration, a deliberately rejected invalid link.

## Learned
