# Kinds of finding

Every finding names one kind. A kind is a shape of problem that shows up in app after app, so the next run knows
to look for it. Add a kind when a finding fits none of these: a slug, then one line a scout can recognise.
A kind with five findings behind it gets an ability in `scouts/abilities/`.

- `dead-end-route`: a path, a link or a restore that lands on a screen with no way forward.
- `state-lost`: work or progress the user had that a lifecycle change, a tab switch or a failed write drops.
- `money-mismatch`: a purchase, a restore or an ad whose result disagrees with what the user paid for or watched.
- `rating-asked-wrong`: a review prompt that fires before any value, at a bad moment, or never.
- `wrong-language`: a message or a screen shown in a language the user did not pick, or as raw technical text.
- `rule-in-two-places`: one product rule decided in two places that drift apart.
