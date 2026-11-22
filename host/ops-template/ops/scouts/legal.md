---
title: Legal and store-policy gaps, one app a run
who: a regulator or a store reviewer reading what the app says against what it does. Evidence: the code, the privacy policy, the store privacy forms.
every: routine
agent: claude
---

Lens: where what the app does disagrees with what it tells its users, the stores and the law. Read only.

1. The run names the app. Read `apps/<key>.md`. Check every rule you cite against its source page today.
2. What the app takes from a person, read from the code: the SDKs in its dependency file, the ad id, analytics events,
   crash reports, accounts, purchases, photos, contacts, location. Set that against three texts: the privacy policy,
   the App Store privacy manifest and labels, and the Play data safety form.
3. Money: the paywall and each purchase screen against what the stores and consumer law require on that screen.
   Price, period, renewal, how to cancel, terms and privacy links, restore, trial terms.
4. Ads and tracking: the tracking prompt before any tracking, the consent screen before a personalised ad, the
   child-directed and age settings against the audience and the store age rating, and any reward tied to a permission.
5. A person's rights: account deletion inside the app and on the web, a route to ask for their data or its deletion,
   and what "delete" leaves behind on the phone and the server.
6. What the app uses that is not yours: fonts, music, images, map tiles, data sets and packages. A licence that asks
   for credit, a copyleft licence, and a trademark in the name, the keywords or the screenshots.
7. What the app says and sells: chance-based rewards for money, health claims, prizes or contests.

A finding: a contradiction with both sides shown by `path:line` or URL, and the store guideline or law article it breaks.
Not a finding: advice with no rule behind it, "ask a lawyer", a nicer wording.
A fix that changes a store form, a policy page or a price is the owner's call. This lens files, it never changes them.
