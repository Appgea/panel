import assert from "node:assert/strict";
import test from "node:test";
import { src } from "./load.mjs";

const { headline, plainLines, plainText } = await src("plain.ts");

test("agent markdown reads as plain words", () => {
  const reply = [
    "I committed everything as `22532fc1` on main.",
    "",
    "",
    "- **Check:** `npm run check` passed.",
    "## Next",
    "1. See [the report](https://x.test/r).",
    "```sh",
    "git push",
    "```",
  ].join("\n");
  assert.equal(plainLines(reply), "I committed everything as 22532fc1 on main.\n\nCheck: npm run check passed.\nNext\nSee the report.");
  assert.equal(plainText("Ship it [done-when: both stores]\n- **now**"), "Ship it now");
});

test("a headline is the first plain sentence, one line long", () => {
  assert.equal(headline("Portfolio has rebuilt legal pages for 10 apps (coinapp, fitstrail). Push later."),
    "Portfolio has rebuilt legal pages for 10 apps");
  assert.equal(headline("1.13.0 (20) shipped. iOS in App Review."), "1.13.0 shipped");
  assert.equal(headline("dark mode live on both stores. Left the widget."), "Dark mode live on both stores");
  assert.equal(headline("Sync paused (`.env` false). **Notes** export hidden."), "Sync paused");
  assert.equal(headline("Decide the launch order of the new levels: easy first, or hard first."),
    "Decide the launch order of the new levels");
  assert.equal(headline("Reviews: iOS ratings are low. Cause is install volume."), "Reviews: iOS ratings are low");
  const long = headline("Every screenshot in the store listing needs to be taken again once the new layout lands.");
  assert.ok(long.length <= 73 && long.endsWith("…") && !long.includes("  "), long);
});
