import assert from "node:assert/strict";
import test from "node:test";
import { src } from "./load.mjs";

const { said, mission, marks } = await src("features/fleet_words.ts");

test("a card keeps an agent's bold, italic and code, and leaves snake_case and lone stars alone", () => {
  assert.deepEqual(marks("Fixed **two** crashes in `feed.dart`, *finally*."), [
    { mark: "", text: "Fixed " }, { mark: "b", text: "two" }, { mark: "", text: " crashes in " },
    { mark: "code", text: "feed.dart" }, { mark: "", text: ", " }, { mark: "i", text: "finally" }, { mark: "", text: "." },
  ]);
  assert.deepEqual(marks("rate_limit_ms is 5 * 60 * 1000"), [{ mark: "", text: "rate_limit_ms is 5 * 60 * 1000" }]);
});

test("a unit's card reads the last words its CLI wrote to a person, not its tools or input box", () => {
  const codex = [
    "• Ran board release 2153 codex-e772d222 \"No changes made.\"",
    "  └ #2153 released and moved up to opus",
    "",
    "• Both Interbellum issues need lead review of saved-state changes. I'm checking",
    "  the queue again.",
    "",
    "◦ Waiting for background terminal (18m 03s • esc to interrupt)",
    "  └ board next",
    "",
    "› Ask Codex to do anything",
    "  GPT-6.1 Terra medium · ~/Desktop/projects · Run fleet builder",
  ].join("\n");
  assert.equal(said(codex), "Both Interbellum issues need lead review of saved-state changes. I'm checking the queue again.");

  const opencode = [
    "     + 12 commands, 9 thoughts, 14 reads",
    "",
    "     The NotificationService extension force-unwraps the payload. Patching it to",
    "     fall back to the plain alert.",
    "",
    "     ⠸ 3 commands, 2 thoughts",
    "  ┃",
    "  ┃  Build auto · DeepSeek V4.1 Flash · high",
    "   ⬝⬝⬝⬝ esc interrupt          121.5K (12%)  ctrl+p commands",
  ].join("\n");
  assert.equal(said(opencode), "The NotificationService extension force-unwraps the payload. Patching it to fall back to the plain alert.");

  // Tool output hangs under ⎿ and is never the agent's words, even when it reads like a sentence.
  const claude = [
    "     Display the title, body, and other information about an issue.",
    "",
    "⏺ I'll take #2104 next, the queue's oldest.",
    "",
    "⏺ Bash(gh issue view 2104 -R Appgea/ops --json state)",
    "  ⎿  {",
    "       \"labels\": [",
    "  ⎿  Allowed by auto mode",
    "· Fermenting… (3m 0s · ↓ 3.5k tokens)",
    "❯",
  ].join("\n");
  assert.equal(said(claude), "I'll take #2104 next, the queue's oldest.");
  assert.equal(said("     + 3 commands\n  ┃  Build auto · x · high"), null);
  // A sentence that starts like a tool's name is still a sentence.
  assert.equal(said("⏺ Ready to ship the fix."), "Ready to ship the fix.");
  assert.equal(said("• Reading the crash report now."), "Reading the crash report now.");
});

test("a card names the app once: apart from the title, and only when the unit has one", () => {
  assert.deepEqual(mission({ issues: [{ number: 1, title: "Tavla iOS: crash on 5 users" }], app: "tavla" }), { title: "iOS: crash on 5 users", number: 1, more: 0, app: "Tavla" });
  assert.equal(mission({ issues: [{ number: 2, title: "Splash: Pisti deals one card" }], app: "" }).title, "Splash: Pisti deals one card");
  assert.deepEqual(mission({ issues: [], scout: "ui-guidelines@Memor", app: "" }), { title: "UI guidelines scout", number: null, more: 0, app: "Memor" });
});
