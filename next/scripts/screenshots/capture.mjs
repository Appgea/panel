/**
 * Regenerates the README screenshots in docs/screenshots/.
 *
 * The real UI runs in headless WebKit, the engine the macOS app uses, against demo-backend.js.
 * No window opens and nothing on your machine is read, so the shots never show your projects.
 *
 *   cd next/scripts/screenshots
 *   npm install && npx playwright install webkit
 *   npm run capture              # every shot
 *   npm run capture -- home      # only the named ones
 *
 * Set PANEL_UI_URL to reuse a running `npm run dev` instead of starting Vite here.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { webkit } from "playwright";
import { asset, icon } from "./mock-media.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const ui = join(repo, "next", "apps", "desktop", "ui");
const out = join(repo, "docs", "screenshots");
const PORT = 1488;

/** Start the UI's own Vite on a port nothing else uses, and wait until it serves. */
async function startVite() {
  const windows = process.platform === "win32";
  const bin = join(ui, "node_modules", ".bin", windows ? "vite.cmd" : "vite");
  const vite = spawn(bin, ["--host", "127.0.0.1", "--port", String(PORT), "--strictPort"], {
    cwd: ui,
    stdio: ["ignore", "pipe", "pipe"],
    // A .cmd only runs through the shell on Windows.
    shell: windows,
  });
  await new Promise((ready, fail) => {
    const timer = setTimeout(() => fail(new Error("Vite did not start in 30 s")), 30_000);
    vite.stdout.on("data", (chunk) => {
      if (String(chunk).includes("ready in")) {
        clearTimeout(timer);
        ready();
      }
    });
    vite.on("exit", (code) => fail(new Error(`Vite exited with ${code}. Run npm ci in ${ui} first.`)));
  });
  return vite;
}

const settle = (page, ms = 600) => page.waitForTimeout(ms);

/** Stop Vite and, on Windows, the shell it runs under and everything that shell started. */
function stopVite(vite) {
  if (!vite) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(vite.pid), "/T", "/F"]);
  else vite.kill();
}

/**
 * The project-icon and project-asset schemes, answered with mock-media.mjs. demo-backend.js makes
 * the UI ask for them in their Windows form (`http://<scheme>.localhost/…`), which is a URL a
 * page route can catch.
 */
async function serveMockMedia(page) {
  await page.route(/^http:\/\/project-(icon|asset)\.localhost\//, (route) => {
    const url = new URL(route.request().url());
    const [, first] = url.pathname.split("/");
    const body = url.hostname.startsWith("project-icon") ? icon(decodeURIComponent(first)) : asset(url.pathname);
    if (!body) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, contentType: "image/svg+xml", body });
  });
}

/** Each shot starts from a fresh, booted app with the demo playing. */
const SHOTS = [
  {
    name: "home",
    async prepare(page) {
      await page.click("#homeButton");
    },
  },
  {
    name: "project",
    async prepare(page) {
      await page.click('#projectList [data-project-id="tidepool"]');
    },
  },
  {
    name: "dashboard",
    async prepare(page) {
      await page.click('#projectList [data-project-id="tidepool"]');
      await settle(page);
      await page.click("#tabDash");
    },
  },
  {
    name: "work",
    async prepare(page) {
      await page.click('#projectList [data-project-id="tidepool"]');
      await settle(page);
      await page.click("#tabFiles");
      await settle(page);
      const tree = page.locator("#filesPane");
      for (const name of ["lib", "tank", "feeding.dart"]) {
        await tree.getByText(name, { exact: true }).first().click();
        await settle(page, 300);
      }
      // Land on the agent's edit, so the change marks in the gutter are on screen.
      await page.locator(".cm-line", { hasText: "void eat" }).evaluate((line) => line.scrollIntoView({ block: "center" }));
    },
  },
  {
    // What the agents made, waiting in batches. Dark, like the hero: renders read best on it.
    name: "review",
    dark: true,
    async prepare(page) {
      await page.click("#reviewButton");
    },
  },
  {
    // One batch in the deck: a report's Review button lands here.
    name: "review-deck",
    dark: true,
    async prepare(page) {
      await page.click("#reviewButton");
      await settle(page);
      await page.locator(".rv-batch").first().locator(".rv-btn.is-primary").click();
      await settle(page);
      await page.keyboard.press("ArrowRight");
    },
  },
  {
    name: "manager",
    dark: true,
    async prepare(page) {
      await page.click("#cpoButton");
    },
  },
  {
    // The README's first image: every agent at once, in the dark theme.
    name: "hero",
    dark: true,
    async prepare(page) {
      await page.click("#terminalsButton");
    },
  },
  {
    // The other terminal layout: a row of terminal tabs under the strip, one terminal at a time.
    name: "tabs",
    async prepare(page) {
      await page.click("#terminalsButton");
      await settle(page);
      await page.click('.terms-layout-item[aria-label="Tabs layout"]');
    },
  },
  {
    name: "reports",
    async prepare(page) {
      await page.click("#chatButton");
    },
  },
  {
    // The README's top image. A static page, not the app, and it shows hero.png, so it runs last.
    name: "banner",
    page: "banner.html",
    viewport: { width: 1280, height: 640 },
  },
];

const wanted = process.argv.slice(2);
const shots = wanted.length ? SHOTS.filter((shot) => wanted.includes(shot.name)) : SHOTS;
if (!shots.length) throw new Error(`No shot named ${wanted.join(", ")}. Known: ${SHOTS.map((s) => s.name).join(", ")}`);

const vite = process.env.PANEL_UI_URL ? null : await startVite();
const url = process.env.PANEL_UI_URL ?? `http://127.0.0.1:${PORT}/`;
await mkdir(out, { recursive: true });
const written = [];
const browser = await webkit.launch();
try {
  for (const shot of shots) {
    const page = await browser.newPage({
      viewport: shot.viewport ?? { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      colorScheme: shot.dark ? "dark" : "light",
    });
    page.on("console", (message) => {
      if (message.text().startsWith("[demo]") || message.type() === "error") console.log(`  ${shot.name}: ${message.text()}`);
    });
    page.on("pageerror", (error) => console.log(`  ${shot.name}: page error ${error.message}`));
    if (shot.page) {
      await page.goto(pathToFileURL(join(here, shot.page)).href, { waitUntil: "load" });
    } else {
      await serveMockMedia(page);
      await page.addInitScript({ path: join(here, "demo-backend.js") });
      await page.goto(url);
      await page.waitForSelector("#panelBoot", { state: "detached", timeout: 15_000 }).catch(() => undefined);
      await page.evaluate(() => window.__panelDemo.play());
      // Review's corner cards announce the demo's renders. Real, but on every other screen they
      // only cover the sidebar the shot is about.
      if (!shot.peeks) await page.addStyleTag({ content: ".rv-peeks { display: none !important; }" });
      await settle(page);
      await shot.prepare(page);
    }
    await settle(page, 900);
    const file = join(out, `${shot.name}.png`);
    await page.screenshot({ path: file });
    written.push(file);
    console.log(`wrote ${file}`);
    await page.close();
  }
} finally {
  await browser.close();
  stopVite(vite);
}

// Retina PNGs are large. pngquant cuts them to about a third with no visible change; without it
// the shots are still correct, just heavier in git.
const squeezed = spawnSync("pngquant", ["--force", "--skip-if-larger", "--ext", ".png", "--quality", "80-98", ...written]);
if (squeezed.error) console.log("pngquant not found, so the PNGs stay uncompressed (brew install pngquant).");
