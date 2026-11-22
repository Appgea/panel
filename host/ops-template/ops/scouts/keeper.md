---
title: Does a payer stay, and does a happy user say so?
who: a person who already paid, or who came back for a second week. Evidence: the entitlement code, the purchase backend, and the features behind the paywall.
monetization: iap, subscription
store: live
every: routine
agent: claude
---

Lens: the app after the first payment. What a payer gets, whether they can find it, what they see when the
subscription lapses, and when the app asks a happy user for a rating. One app a run. Read only: never change a
store or a purchase backend.
Before the first payment is the `analytics` lens. Whether paid access is granted and revoked correctly is `money-links`.

Abilities, in `scouts/abilities/`:
- `lapse-path`: what a payer sees when the subscription ends, fails to renew or is refunded, and the way back.
- `unused-part`: each feature the paywall promises and each main part of the app, and how a user reaches it.
- `rating-moment`: when the app asks for a rating, and what the user has just done at that moment.

Yours to add when all of them ran on the app: what else makes a payer leave or a happy user stay silent. For
example, a reminder that stops after week one, progress with no backup before a phone change, a yearly plan with no
notice before it renews, or a cancel reason nobody asks for.

A finding: a point after the first payment where a payer loses value, cannot find it, or leaves with no way back,
at `path:line`. A price, a new offer or a store change is the owner's call: file it as a question.
Not a finding: a churn number with no cause in the code, a feature request, a taste call.
