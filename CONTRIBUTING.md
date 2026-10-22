# Contributing

Panel is a macOS alpha. Rust, Node, Python, and Xcode command line tools are required.
See [docs/SETUP.md](docs/SETUP.md) for supported versions and setup.

## Development

```sh
cd next
./dev.command --no-watch
```

The frontend reloads as you edit it. `--no-watch` keeps a Rust edit from restarting live
agent terminals. Restart manually after changing Rust. Omit the flag to enable Rust watching.

### Faster Rust builds

[sccache](https://github.com/mozilla/sccache) keeps compiled crates across clean builds and branch
switches. The repository does not require it. To use it on your machine only:

```sh
brew install sccache
mkdir -p ~/.cargo
printf '[build]\nrustc-wrapper = "%s"\n' "$(command -v sccache)" >> ~/.cargo/config.toml
```

If that file already has a `[build]` table, add the `rustc-wrapper` line to it instead. Keep the
absolute path. A Finder-launched `dev.command` does not inherit your shell `PATH`.

## Checks

There is no CI. Run these from the repository root before you push:

```sh
python3 -m unittest discover -s next/launcher -p 'test_*.py'
python3 -m unittest discover -s host/modules/revenuecat -p 'test_*.py'
python3 -m unittest discover -s host/modules/git-manager -p 'test_*.py'
python3 -m unittest discover -s host/modules/support -p 'test_*.py'
./next/launcher/stage-resources.sh
cd next
cargo test --workspace --locked
cd apps/desktop/ui
npm ci --engine-strict
npm run build
```

To verify the complete macOS bundle without replacing your daily app, choose an empty
install folder:

```sh
./next/launcher/build-app.sh /tmp/panel-check-install
```

Scan for secrets with `gitleaks dir --redact --no-banner .` (`brew install gitleaks`).
The app uses an ad-hoc signature. It is not notarized. There are no published releases.

## Screenshots

The README images in `docs/screenshots/` come from a script, not a screen grab. It runs the real
UI in headless WebKit against `next/scripts/screenshots/demo-backend.js`, a made-up portfolio of six invented apps whose icons
and renders are drawn by `mock-media.mjs`. No
window opens and nothing on your machine is read. The top banner, `banner.png`, is rendered from
`next/scripts/screenshots/banner.html` and shows `hero.png`.

The app icon master is `next/apps/desktop/src-tauri/icons/app-icon.png`. After changing it, run
`cargo tauri icon icons/app-icon.png` in `next/apps/desktop/src-tauri` to rebuild every size.

```sh
cd next/scripts/screenshots
npm install
npx playwright install webkit
npm run capture              # every shot
npm run capture -- work      # only the named ones
```

The script starts its own Vite server. With `pngquant` installed (`brew install pngquant`) it also
shrinks the PNGs. After a UI change that shows in a shot, regenerate that shot and look at it
before you commit.

## Reporting bugs

Open an issue with the bug report form. It asks for the macOS version, agent CLI and version,
steps, expected result, and actual result. Remove credentials and private project content from
logs before sharing them. Report security problems privately, as [SECURITY.md](SECURITY.md) says.

Keep state in `~/.appgeapanel`. A bundled module must never write beside its own code.
Do not include project data, credentials, private fixtures, or build caches in a contribution.
