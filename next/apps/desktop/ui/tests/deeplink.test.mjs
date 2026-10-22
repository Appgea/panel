import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { transformWithOxc } from "vite";

const source = await readFile(new URL("../src/deeplink.ts", import.meta.url), "utf8");
const { code } = await transformWithOxc(source, "deeplink.ts");
const { parsePlace, PLACE_IN_TEXT } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

test("the four places parse, with or without the panel: prefix", () => {
  assert.deepEqual(parsePlace("panel:review"), { to: "review" });
  assert.deepEqual(parsePlace("review:shots/home.png"), { to: "review", path: "shots/home.png" });
  assert.deepEqual(parsePlace("panel:work:lib/auth.dart:88"), { to: "work", path: "lib/auth.dart", line: 88 });
  assert.deepEqual(parsePlace("panel:work:./src/main.ts"), { to: "work", path: "src/main.ts" });
  assert.deepEqual(parsePlace("panel:git"), { to: "git" });
  assert.deepEqual(parsePlace("panel:manager."), { to: "manager" });
});

test("anything else is not a place", () => {
  for (const link of ["https://example.com", "panel:work", "panel:settings", "panel:git:main", "", "lib/a.ts"]) {
    assert.equal(parsePlace(link), null, link);
  }
});

test("terminal text: only prefixed links, never the bare words", () => {
  const line = "Open panel:review:shots/a.png or (panel:work:lib/a.dart:12), ask the manager about git, then panel:manager";
  assert.deepEqual(line.match(PLACE_IN_TEXT), ["panel:review:shots/a.png", "panel:work:lib/a.dart:12", "panel:manager"]);
});
