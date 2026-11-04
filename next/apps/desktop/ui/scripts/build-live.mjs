// Builds Live's Bevy view (apps/live) to WebAssembly in public/live/, before the UI build.
//
// Cargo skips the work when nothing changed, about 0.2 s. Only the first build on a machine
// compiles Bevy, a few minutes. A Mac without the wasm target or wasm-bindgen-cli still builds
// Panel: this warns and leaves Live's stage to say the view did not start.
// The CLI version must equal the `wasm-bindgen` pin in apps/live/Cargo.toml.

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BINDGEN = "0.2.130";
const ui = join(dirname(fileURLToPath(import.meta.url)), "..");
const crate = join(ui, "..", "..", "live");
const out = join(ui, "public", "live");

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", ...opts });
}

function skip(why) {
  console.warn(`[build-live] skipped: ${why}. Live's stage will say the view did not start.`);
  process.exit(0);
}

if (process.env.PANEL_SKIP_LIVE === "1") skip("PANEL_SKIP_LIVE=1");
let bindgen = "";
try {
  bindgen = run("wasm-bindgen", ["--version"]).trim();
} catch {
  skip(`wasm-bindgen is missing. Install it with: cargo install wasm-bindgen-cli --version ${BINDGEN} --locked`);
}
if (!bindgen.endsWith(BINDGEN)) skip(`${bindgen} is installed, but apps/live needs ${BINDGEN}`);
try {
  if (!run("rustup", ["target", "list", "--installed"]).includes("wasm32-unknown-unknown")) {
    skip("the wasm32 target is missing. Add it with: rustup target add wasm32-unknown-unknown");
  }
} catch {
  // No rustup: let cargo report the missing target itself.
}

// A failed view build must not fail Panel's build. Panel ships, and Live's stage says why.
try {
  execFileSync("cargo", ["build", "--release", "--target", "wasm32-unknown-unknown"], { cwd: crate, stdio: "inherit" });
  execFileSync(
    "wasm-bindgen",
    ["--target", "web", "--no-typescript", "--remove-name-section", "--remove-producers-section", "--out-dir", out, join(crate, "target", "wasm32-unknown-unknown", "release", "panel_live.wasm")],
    { stdio: "inherit" },
  );
} catch (e) {
  skip(`the view build failed (${e.message.split("\n")[0]})`);
}
