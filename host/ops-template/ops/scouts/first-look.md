---
title: Does a stranger get the screen at first look?
who: a person who opens a screen for the first time, before any scroll or tap. Evidence: current screenshots of the main screens.
priority: P1
every: routine
agent: claude
---

Lens: what a person sees in the first phone screen of each main screen, before any scroll or tap. Read only.
Platform rules such as overflow, tap targets and contrast are a separate check. This lens checks sense.

1. The run names the app. Read `apps/<key>.md` and the README for the app's one-line point.
2. Get current shots of the first screen, the main tab, the paywall or offer, and one core task screen.
   Shots older than the last commit that touched a screen are stale: render again.
3. Once a run, show the shots to a reader with no context: "You have never seen this app. For each screen: what
   does the app do, what is this screen for, what would you tap next, which line did you not understand?"
   Where it gets the app's point wrong, the screen failed.
4. Then judge each screen yourself on five checks:
   - Point: the app's promise is visible in the first screen, not after a scroll.
   - One job: one primary action, in the strongest place. Two equal buttons, or none, is a finding.
   - Lines: each line names the user's own number, place or next action. A line over 12 words on a main screen is read twice.
   - Nouns: count the app's own terms on the screen. Over 3 new ones at once, the user is lost.
   - Look: one type voice per screen, cards only where they group, decoration that never pushes the task down.

A finding: one screen, what the stranger gets wrong or cannot find, the line or element that causes it, and the
picture. A whole-app pattern is one finding that lists the screens. A redesign of the main screen, or cutting a
feature, is the owner's call: file it as a question with before and after pictures.
Not a finding: taste with no stranger confusion behind it, a copy nit.
