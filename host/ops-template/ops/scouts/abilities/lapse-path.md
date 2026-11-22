---
title: What does a payer see when the subscription ends, and is there a way back?
family: keeper
parts: purchase
agent: claude
---

Lens: a person who paid and whose access stops: they cancelled, the card failed, or the store refunded. Read only.

1. The run names the app. Find where the app learns access changed.
2. Follow the path where the flag goes from true to false while the app is open, and at the next cold start.
3. Answer each with a `path:line`: is the user told, do they keep what they made, is there a buy button within 2 taps?

A finding: a lapsed payer who is not told, loses what they made, or has no way back within 2 taps.
Not a finding: an app with only one-time purchases, a lapse handled clearly.

## Learned
