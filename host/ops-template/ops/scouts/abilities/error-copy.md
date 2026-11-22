---
title: Does a failure tell the user how to recover, in their language?
family: journey
agent: claude
---

Lens: reachable failure messages and the recovery action next to each, across supported languages. Read only.

1. The run names the app. Pull its repo.
2. Find where messages are shown: snack bars, dialogs, alerts, toasts, inline error text.
3. Find the localized failure strings in each supported language.
4. Follow each failure branch to the text shown and the locale lookup.
5. For network, permission, storage and purchase failures, name what the user can do next and trace its action.

A finding: a reachable failure that shows the wrong language or raw technical text, or gives a recovery step that does not work.
Not a finding: wording taste, developer logs, an irreversible failure honestly explained.

## Learned
