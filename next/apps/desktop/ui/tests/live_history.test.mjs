import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { transformWithOxc } from "vite";

const source = await readFile(new URL("../src/features/live_history.ts", import.meta.url), "utf8");
const { code } = await transformWithOxc(source, "live_history.ts");
const { trim } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

const step = (verb, label, more = {}) => ({ atMs: 0, verb, label, ...more });

test("history keeps results and folds the reading around them", () => {
  const rows = trim([
    step("test", "Ran flutter test", { ok: false }),
    step("edit", "Edited shop.dart", { file: "lib/shop.dart" }),
    step("read", "Read shop.dart"),
    step("edit", "Edited shop.dart", { file: "lib/shop.dart" }),
    step("read", "Read a.dart"),
    step("search", "Searched the code"),
    step("cmd", "Ran ls"),
    step("git.push", "Pushed", { ok: true }),
  ]);
  assert.deepEqual(
    rows.map((r) => [r.text, r.mark ?? "", !!r.folded]),
    [
      ["Ran flutter test", "bad", false],
      ["Edited shop.dart ×2", "", false],
      ["2 files read, 1 search, 1 other step", "", true],
      ["Pushed", "ok", false],
    ],
  );
});
