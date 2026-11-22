---
title: Slow starts, jank, battery and size
who: a user on a mid-range phone with a full battery and a slow network. Evidence: the start path, the frame loop and the asset sizes.
every: routine
agent: claude
---

Lens: what makes the app feel slow or cost the phone, one app a run. Read only.

1. The run names the app. Pull its repo.
2. Read in this order, and stop at 3 findings:
   - App start: everything awaited before the first frame.
   - Heavy work on the UI thread: a parse, an image decode, a sort in a build method or a frame loop.
   - Rebuilds: a whole screen rebuilt per tick, a listener on a timer that redraws all, state set at the root.
   - Leaks: a timer, stream, controller, observer or ad that is never closed.
   - Battery and data: polling, location or sensors left on in the background, a download on each launch.
   - Size: the largest assets (`find . -size +2M -not -path '*/build/*'`), unused packages, uncompressed audio.
3. Use the crash reporter's ANR groups and the store's vitals when the app has them.

A finding: a `path:line` that does the slow thing, the moment a user feels it, and a fix one builder can do.
Not a finding: a micro-optimisation, a guess with no hot path, a profile wish.
