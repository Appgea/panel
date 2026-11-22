---
title: Does every link between the app and its money hold?
who: a buyer or an ad viewer at the moment money moves. Evidence: the purchase and ad code beside the live store ids.
every: routine
agent: claude
---

Lens: money integrity. A person pays or watches an ad, and gets what was promised. The live store and purchase
backend setup, the purchase and ad flows, and what a buyer keeps on another device. Read only: never change a store,
a purchase backend or an ad network.
Whether people reach the paywall at all is the `analytics` lens. Whether a payer stays is `keeper`.

Abilities, in `scouts/abilities/`:
- `id-drift`: the ids in the code against the live store, purchase backend and ad network setup.
- `restore-everywhere`: a buyer on a second device, after a reinstall, a refund, a grace period or offline.
- `purchase-false-result`: what the shop tells the user after each way a purchase can end.
- `ad-flow-dead-end`: an ad that fails, loads late or is dismissed, followed to the reward and the next screen.

Yours to add when all of them ran on the app: what else breaks between the app and its money. For example, a price
shown from a constant instead of the store, a currency or tax shown wrong in one country, an ad SDK that earns
nothing on one platform, an intro offer the store has and the paywall never shows.

A finding: a purchase, a paywall, a restore, an ad or a funnel number that fails real users or misleads a money
decision, at `path:line` with the live value it disagrees with. A fix on live state is the owner's call.
Not a finding: an archived product nobody reads, debug-only ids, an event nobody reads that is also correct.
