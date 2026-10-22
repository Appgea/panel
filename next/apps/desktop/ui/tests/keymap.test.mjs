import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { transformWithOxc } from "vite";

const source = await readFile(new URL("../src/features/keymap.ts", import.meta.url), "utf8");
const { code } = await transformWithOxc(source, "keymap.ts");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;

const event = (code, modifiers = {}, key = code) => ({
  code,
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...modifiers,
});

for (const platform of ["Windows", "Mac"]) {
  test(`${platform}: contextual shortcuts use the platform modifier and physical key`, async () => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { userAgent: platform },
    });
    globalThis.localStorage = { getItem: () => null, setItem: () => {} };
    globalThis.window = { dispatchEvent: () => {} };
    const keymap = await import(`${moduleUrl}#${platform}`);
    const primary = platform === "Mac" ? { metaKey: true } : { ctrlKey: true };
    const otherPrimary = platform === "Mac" ? { ctrlKey: true } : { metaKey: true };

    // The terminal creation shortcuts substitute Ctrl for Command without extra modifiers.
    assert.equal(keymap.matches(event("KeyN", primary), "wall.picker"), true);
    assert.equal(keymap.matches(event("KeyT", primary), "wall.newShell"), true);
    assert.equal(keymap.matches(event("KeyT", primary), "wall.newTab"), false);
    assert.equal(keymap.matches(event("KeyT", { ...primary, shiftKey: true }), "wall.newTab"), true);
    assert.equal(keymap.matches(event("KeyT", { ...primary, shiftKey: true }), "wall.newShell"), false);
    assert.equal(keymap.label("wall.picker"), platform === "Mac" ? "⌘N" : "Ctrl+N");
    assert.equal(keymap.label("wall.newShell"), platform === "Mac" ? "⌘T" : "Ctrl+T");
    assert.equal(keymap.clashes().has("wall.newTab"), false);
    assert.equal(keymap.matches(event("Enter", primary), "term.zoom"), true);
    assert.equal(keymap.matches(event("KeyN", { ...primary, shiftKey: true }), "app.notebook"), true);

    for (const code of ["KeyP", "KeyW", "Equal", "Minus", "Digit0", "Digit1", "Digit9"]) {
      assert.equal(keymap.matchesShortcut(event(code, primary), `Meta+${code}`), true);
      assert.equal(keymap.matchesShortcut(event(code, otherPrimary), `Meta+${code}`), false);
      assert.equal(keymap.matchesShortcut(event(code, { ...primary, altKey: true }), `Meta+${code}`), false);
      assert.equal(keymap.matchesShortcut(event(code, { ...primary, shiftKey: true }), `Meta+${code}`), false);
    }

    // A different keyboard layout changes key, while code still identifies the shortcut.
    assert.equal(keymap.matchesShortcut(event("KeyO", { ...primary, shiftKey: true }, "Щ"), "Meta+Shift+KeyO"), true);
    assert.equal(keymap.matchesShortcut(event("Equal", { ...primary, shiftKey: true }, "+"), "Meta+Shift+Equal"), true);
    assert.equal(keymap.shortcutLabel("Meta+KeyP"), platform === "Mac" ? "⌘P" : "Ctrl+P");

    const copy = platform === "Mac" ? { metaKey: true } : { ctrlKey: true, shiftKey: true };
    assert.equal(keymap.matchesShortcut(event("KeyC", copy), "Meta+KeyC", "Ctrl+Shift+KeyC"), true);
    assert.equal(keymap.matchesShortcut(event("KeyC", { ctrlKey: true }), "Meta+KeyC", "Ctrl+Shift+KeyC"), false);
    assert.equal(keymap.matchesShortcut(event("KeyC", copy), "Meta+Shift+KeyC", "Ctrl+Alt+KeyC"), false);
    assert.equal(keymap.matches(event("KeyC", primary), "term.copy"), true);
    assert.equal(keymap.matches(event("KeyC"), "term.copy"), false);

    assert.equal(keymap.matches(event("KeyF", primary), "term.find"), true);
    assert.equal(keymap.matches(event("KeyF", primary), "term.fullscreen"), false);
    const fullscreen = platform === "Mac" ? event("KeyF", { ctrlKey: true }) : event("F11");
    assert.equal(keymap.matches(fullscreen, "term.fullscreen"), true);
    assert.equal(keymap.matches(fullscreen, "term.find"), false);
    // Find in project must not be eaten by full screen, which listens first.
    const findInProject = event("KeyF", { ...primary, shiftKey: true });
    assert.equal(keymap.matchesShortcut(findInProject, "Meta+Shift+KeyF"), true);
    assert.equal(keymap.matches(findInProject, "term.fullscreen"), false);
    assert.equal(keymap.clashes().size, 0);

    for (const action of keymap.ACTIONS) {
      const chord = keymap.chordOf(action.id);
      const modifiers = { metaKey: chord.meta, ctrlKey: chord.ctrl, altKey: chord.alt, shiftKey: chord.shift };
      assert.equal(keymap.matches(event(chord.code, modifiers), action.id), true, action.id);
      assert.equal(keymap.matches(event(chord.code, { ...modifiers, altKey: !modifiers.altKey }), action.id), false, action.id);
      if (action.digits) {
        assert.equal(keymap.matches(event("Digit9", modifiers), action.id), true);
        assert.equal(keymap.matches(event("Digit0", modifiers), action.id), false);
      }
    }

    keymap.setChord("app.wall", keymap.parseChord("Alt+KeyJ"));
    assert.equal(keymap.matches(event("KeyJ", { altKey: true }), "app.wall"), true);
    assert.equal(keymap.matches(event("KeyJ", primary), "app.wall"), false);
    keymap.resetKeymap();
    assert.equal(keymap.matches(event("KeyJ", primary), "app.wall"), true);
  });
}
