import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { transformWithOxc } from "vite";

const sdkUrl = new URL("../node_modules/@tauri-apps/api/core.js", import.meta.url).href;
const source = (await readFile(new URL("../src/project-assets.ts", import.meta.url), "utf8"))
  .replace('"@tauri-apps/api/core"', JSON.stringify(sdkUrl));
const { code } = await transformWithOxc(source, "project-assets.ts");
const { projectIconUrl, projectAssetUrl, schemeOrigin } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

test("project icons use Tauri's Windows URL and encode the project id once", () => {
  globalThis.window = {
    __TAURI_INTERNALS__: {
      convertFileSrc(id, protocol) {
        assert.equal(protocol, "project-icon");
        return `http://${protocol}.localhost/${encodeURIComponent(id)}`;
      },
    },
  };
  const id = "app name/%?#Türkçe";
  const url = new URL(projectIconUrl(id));
  assert.equal(url.origin, "http://project-icon.localhost");
  assert.equal(decodeURIComponent(url.pathname.slice(1)), id);
  assert.equal(url.search, "");
  assert.equal(url.hash, "");
});

test("project icons keep the native macOS protocol", () => {
  globalThis.window = {
    __TAURI_INTERNALS__: {
      convertFileSrc: (id, protocol) => `${protocol}://localhost/${encodeURIComponent(id)}`,
    },
  };
  assert.equal(projectIconUrl("Tavla"), "project-icon://panel/Tavla");
  assert.equal(schemeOrigin("module"), "module://panel");
});

test("assets and modules use the Windows origin too, one segment encoded at a time", () => {
  globalThis.window = {
    __TAURI_INTERNALS__: {
      convertFileSrc: (id, protocol) => `http://${protocol}.localhost/${encodeURIComponent(id)}`,
    },
  };
  assert.equal(schemeOrigin("module"), "http://module.localhost");
  assert.equal(
    projectAssetUrl("my app", "shots\\home screen.png"),
    "http://project-asset.localhost/my%20app/shots/home%20screen.png",
  );
});

test("project icons work in browser previews with partial IPC mocks", () => {
  globalThis.window = { __TAURI_INTERNALS__: { invoke: () => {} } };
  assert.equal(projectIconUrl("my app"), "project-icon://panel/my%20app");
  globalThis.window = {};
  assert.equal(projectIconUrl("Tavla"), "project-icon://panel/Tavla");
});
