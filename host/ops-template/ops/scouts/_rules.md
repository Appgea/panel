# Scout rules

A scout finds work and files it. It never builds. What it files must be meaningful and well defined.
- Meaningful: the task says what a user sees, or which number moves, once it is done. A chore that changes neither is not filed.
- Well defined: a builder who has never seen the app can finish it from the task alone. The one way, the files, the
  exact values, the check.
- Read the code. The code alone shows how a flow or a mechanic works, and it is faster than running the app.
  The best find is a mechanic or flow judged as a whole: its inputs, its choices for the user, what it feeds into.
  Hold it two ways:
  - Logic: a route that ends nowhere, a rule that scores or pays wrong, two screens that disagree.
  - Depth: a mechanic shallower than the rest of the product, held against how the best products of its kind build it.
  A hardening find, such as a failed save or a clock set back, ranks below both.
- Never file to show the run did something. A run with nothing worth that bar files nothing, and leaves a lesson instead.
- No run comes back empty. A run that files nothing writes one line under `## Learned` in the file it ran, so the
  next run starts from it. Blocked by a missing build, tool or login: find the way past it and write it down.
  The area is clean: write what you checked, so the next run looks somewhere else.
- One find, then the sweep. A finding in one app: look at the same part in the other apps in `portfolio.yaml`, a few
  minutes each, and file what you find under the same kind.

## Lens and ability

A lens is one person at one stage, with evidence of its own. Its file says so in `who:`. `stranger` is the person
before the install, read from the store page. `analytics` is the new user up to the first payment. `keeper` is the
payer after it. `money-links` is the buyer at the moment money moves. `journey` is the user off the main path.

An ability is one narrow check inside a lens, a file in `scouts/abilities/` with exact steps. It has one lens, its
`family:`, and it never runs on its own. Without this split, narrow checks grow beside broad lenses, overlap, and
file the same thing twice.
- A new way of looking is an ability first. Hold it against each lens's `who:`. The same person and the same
  evidence as an existing lens: it is that lens's ability. Copy `scouts/abilities/_template.md`.
- A new lens only when no lens has that person, or the evidence is new. Copy `scouts/_template.md`, fill `who:`, and
  say where it ends and which lens starts there.
- Two abilities that could file the same finding: each file names the other and where the border is.
- A kind of finding that keeps coming back gets an ability, never a lens.

## A run

Panel's Board lists every scout in this folder. Its Run button opens a terminal with the lens.
A run named `<lens>@<App>` is that lens on one app.
- Pick the ability this app saw longest ago. Skip one whose `parts:` the app does not have, and one with a `paused:` line.
  A lens with `own: steps` also takes a turn with the steps in its own file.
- Read that one ability file in full, its `## Learned` too, and follow its steps.
- Write every step for the smallest model you use: a command, and what to write down from what it prints.
  A step that made you guess: rewrite it in the file before you close the run.
- Five empty runs in a row pause that ability, not its lens: add `paused: <date>, five empty runs` to its frontmatter.
  Delete the line to run it again.
- A step you did by hand that the next run will repeat: make it a script in `runbooks/`.
- Priority follows `direction.md`. An app it keeps hands off gets no findings.
- Never write product code or commit in a product repo.

## Filing

File each finding where `AGENTS.md` says work is queued. In this template that is `backlog.md`: one line with
`done-when:`, and the brief below it, indented. Search the backlog for the same thing in other words first.
At most 3 findings a run.

Every finding names its kind from `scouts/_classes.md`. A kind that is not there yet goes into that file in the same
run, and it is the better find: you saw what no list told you to look for.

A bug or a plain win: file it as is. Never write "decide which": a finding carries one way.
A fix whose call is a product, design or direction choice: write your call as `Decided:` with `Confidence:`.
Under 70% sure, a price, final art, live store state, or a big feature: it is the owner's question. File it with
2 to 4 options and your best guess first.

## A filing that passes

A made-up finding, to copy the shape from. Every line is one a builder who never saw the app can act on.

    - [ ] | agent | myapp | P2 | Rating prompt fires on first launch, before any game  [done-when: no review call in startup.dart]  (created 2026-01-15)
      Problem: The app asks for a rating on the first launch, before the player has finished one game. A new player has no reason to rate yet, and the store shows the prompt only a few times a year.
      Why: Ratings decide whether a stranger taps the store page. The page has 2 ratings.
      Checked: 2026-01-15 `grep -rn requestReview lib` shows one call, lib/app/startup.dart:41, inside `initState` with no guard.
      Direction: Move the call out of startup. Call it from the win screen after the third won game, once per app version.
      Files: lib/app/startup.dart:41, lib/game/win_screen.dart, lib/settings/settings_store.dart
      Done when:
      - `grep -n requestReview lib/app/startup.dart` prints nothing.
      - `grep -n requestReview lib/game/win_screen.dart` prints one line.
      Decided: ask after the third win, because a win is the app's best moment and the first session is too early.
      Confidence: 85%
      Kind: rating-asked-wrong

- `Problem:` is what the user meets. `Checked:` is the command and the `path:line` you saw today.
- `Direction:` is one way, with every call made. `Files:` are real paths you opened.
- Each `Done when:` line is a command and what it prints. It fails today and passes after the fix.
