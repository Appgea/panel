import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { transformWithOxc } from "vite";

const source = await readFile(new URL("../src/deeplink.ts", import.meta.url), "utf8");
const { code } = await transformWithOxc(source, "deeplink.ts");
const { parsePlace, PLACE_IN_TEXT, parseAppLink, sessionLink, fileTarget, PATH_IN_TEXT, APP_LINK_IN_TEXT } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

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

test("appgeapanel:// links name their project and reuse the four places", () => {
  assert.deepEqual(parseAppLink("appgeapanel://home"), { to: "home" });
  assert.deepEqual(parseAppLink("appgeapanel://history?q=paywall%20crash"), { to: "history", query: "paywall crash" });
  assert.deepEqual(parseAppLink("appgeapanel://project/koza"), { to: "project", project: "koza" });
  assert.deepEqual(parseAppLink("appgeapanel://project/koza/git"), { to: "project", project: "koza", place: { to: "git" } });
  assert.deepEqual(parseAppLink("appgeapanel://project/koza/work/lib/a%20b.dart:12"),
    { to: "project", project: "koza", place: { to: "work", path: "lib/a b.dart", line: 12 } });
  assert.deepEqual(parseAppLink("appgeapanel://project/koza/review/shots/a.png"),
    { to: "project", project: "koza", place: { to: "review", path: "shots/a.png" } });
  const id = "bb941884-24bd-412c-9c60-fc55e78320c6";
  assert.deepEqual(parseAppLink(sessionLink(id)), { to: "history", session: id });
});

test("anything else is not an appgeapanel link", () => {
  for (const link of ["https://example.com", "panel:git", "appgeapanel://settings", "appgeapanel://project",
    "appgeapanel://project/koza/manager", "appgeapanel://home/extra", "appgeapanel://session/%E0%A4%A"]) {
    assert.equal(parseAppLink(link), null, link);
  }
});

test("full paths in terminal text, and only full paths", () => {
  const line = "Saved /Users/me/app/shots/home.png. See (~/Desktop/out) and /tmp/a.log:12, not /compact or a/b or https://x.com/Users/me";
  assert.deepEqual(line.match(PATH_IN_TEXT), ["/Users/me/app/shots/home.png", "~/Desktop/out", "/tmp/a.log:12"]);
  assert.deepEqual("open appgeapanel://open/Users/me/a.png.".match(APP_LINK_IN_TEXT), ["appgeapanel://open/Users/me/a.png"]);
});

test("every spelling of a file link reaches the same path and line", () => {
  assert.deepEqual(fileTarget("/Users/me/lib/a.dart:12"), { path: "/Users/me/lib/a.dart", line: 12 });
  assert.deepEqual(fileTarget("file:///Users/me/a%20b.png"), { path: "/Users/me/a b.png" });
  assert.deepEqual(fileTarget("file:///Users/me/a.ts#L7"), { path: "/Users/me/a.ts", line: 7 });
  assert.deepEqual(fileTarget("vscode://file/Users/me/a.rs:40:2"), { path: "/Users/me/a.rs", line: 40 });
  assert.deepEqual(fileTarget("cursor://file/Users/me/a.rs"), { path: "/Users/me/a.rs" });
  for (const link of ["https://example.com/a", "file://server/share/a", "lib/a.ts", "javascript:alert(1)", "vscode://settings"]) {
    assert.equal(fileTarget(link), null, link);
  }
});

test("appgeapanel://open names a file by full path", () => {
  assert.deepEqual(parseAppLink("appgeapanel://open/Users/me/a%20b.dart:3"), { to: "open", path: "/Users/me/a b.dart", line: 3 });
  assert.deepEqual(parseAppLink("appgeapanel://open/~/Desktop/out"), { to: "open", path: "~/Desktop/out" });
  assert.equal(parseAppLink("appgeapanel://open"), null);
});

test("a command an agent printed comes out ready for a shell", async () => {
  const { commandFrom } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  assert.equal(commandFrom("  board next  "), "board next");
  assert.equal(commandFrom("$ git pull --rebase"), "git pull --rebase");
  assert.equal(commandFrom("! npm test"), "npm test");
  assert.equal(commandFrom("│ flutter run │"), "flutter run");
  assert.equal(commandFrom("python3 a.py \\\n  --image x.png"), "python3 a.py --image x.png");
  assert.equal(commandFrom("cd ~/app\n\nmake"), "cd ~/app\nmake");
  assert.equal(commandFrom("!important"), "!important");
  assert.equal(commandFrom("   \n "), "");
  assert.equal(commandFrom("a\nb\nc\nd"), "");
});
