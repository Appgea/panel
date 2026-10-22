//! Two roots. Keeping them apart is what makes Panel shippable.
//!
//! **Resources** is everything Panel SHIPS: the session hook, the panel MCP, the module hosts,
//! the schemas, the ops template. Inside a signed `.app` that tree is read-only, and macOS means
//! it — a module that writes a cache file next to its own source works in a source checkout and
//! fails the moment it is installed. So nothing may ever be written here.
//!
//! **User** is everything the human OWNS: the portfolio, the ops tree, the brain, module state,
//! credentials. It lives at `~/.appgeapanel`, outside every git tree and outside the bundle, so
//! upgrading Panel never touches it and uninstalling Panel never loses it.
//!
//! The two used to be one directory. That is precisely why the old build could not leave this
//! machine: `config.json` held one human's twenty absolute paths, and it sat in the shipped tree.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Set once during Tauri setup from the bundle's resource dir. Absent in tests and in any
/// non-Tauri entry point, where the dev checkout answers instead.
static RESOURCES: OnceLock<PathBuf> = OnceLock::new();

/// Called once, from `setup()`, with the resolved `host/` inside the app bundle. A second call is
/// ignored rather than fatal: losing a window is worse than running against the dev tree.
pub fn init_resources(root: PathBuf) {
    let _ = RESOURCES.set(root);
}

/// Read-only: hooks, MCP shims, module code, schemas.
pub fn resources_root() -> PathBuf {
    if let Some(root) = RESOURCES.get() {
        return root.clone();
    }
    dev_resources()
}

/// The source-checkout answer — `host/` beside `next/`. `PANEL_HOME` still points at
/// `next/`, so the old override keeps working for anyone who set it.
fn dev_resources() -> PathBuf {
    let next = std::env::var_os("PANEL_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../..")
                .canonicalize()
                .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.."))
        });
    next.parent()
        .map(|parent| parent.join("host"))
        .unwrap_or_else(|| next.join("host"))
}

/// Writable: `~/.appgeapanel`. Created on first read, because every caller past this point
/// assumes it exists and a missing home is not a state worth threading through the app.
pub fn user_root() -> PathBuf {
    let root = std::env::var_os("PANEL_USER_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let home = std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."));
            let root = home.join(".appgeapanel");
            // Panel was called Bridge, and its home was `~/.appgeabridge`. Link the new name to
            // the old folder rather than move it: other tools may still read the old path, and a
            // link breaks none of them. This runs before the create below, or that would win.
            // On Windows the link is a junction unless Developer Mode allows a real symlink.
            let legacy = home.join(".appgeabridge");
            if !root.exists() && legacy.is_dir() {
                let _ = crate::platform::link_dir(&legacy, &root);
            }
            root
        });
    let _ = fs::create_dir_all(&root);
    root
}

/// The portfolio. One file, one human, never shipped.
pub fn config_file() -> PathBuf {
    user_root().join("config.json")
}

/// Where the second brain appends. Was `~/.appgea/brain`; [`migrate`] moves it.
pub fn brain_dir() -> PathBuf {
    user_root().join("brain")
}

/// The human-only Markdown notebook.
///
/// This deliberately lives outside Panel's user root. Nothing under this path is a project,
/// an ops tree, agent context, or MCP resource. The notebook commands are its only consumer.
pub fn notebook_file() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".appgea")
        .join("notes.md")
}

/// The default ops tree, used when `config.json` names no `opsRoot`.
///
/// `opsRoot` means "the folder CONTAINING `ops/`", so this is the user home itself and the tree
/// is `~/.appgeapanel/ops`. Seeded from the shipped template on first run, which is the whole
/// difference between shipping a brain and shipping the shape of one.
pub fn ops_root() -> PathBuf {
    user_root()
}

/// The `ops/` directory itself.
pub fn ops_dir() -> PathBuf {
    ops_root().join("ops")
}

/// A module's private writable directory, handed over as `PANEL_STATE_DIR`. Per module, because
/// two modules sharing one state dir is how a cache key collision becomes a credential leak.
pub fn module_state_dir(module: &str) -> PathBuf {
    let dir = user_root().join("state").join(module);
    let _ = fs::create_dir_all(&dir);
    dir
}

/// Extensions the human installed, as opposed to the ones Panel shipped. Scanned after the
/// bundle's own `modules/`, so a user copy of a shipped name wins.
pub fn user_modules_dir() -> PathBuf {
    user_root().join("modules")
}

/// Which extensions this human has turned on.
///
/// Bundled extensions ship with the app but stay dormant until installed, because most of them
/// want a credential or a toolchain and a rail full of modules that error is worse than a rail
/// with three that work. The file is the record; the code stays in the bundle either way.
pub fn installed_modules_file() -> PathBuf {
    user_root().join("modules.json")
}

/// First-run setup, and the one-time move off the old layout.
///
/// Every step is skip-if-present. Running this on every launch is deliberate: a user who deletes
/// their ops tree gets the template back, and a user who edits it is never overwritten.
///
/// Returns true when this machine was running an older Panel — see the `config.json` step. This
/// module deliberately knows nothing about extensions; the caller passes the answer on.
#[must_use]
pub fn migrate() -> bool {
    let user = user_root();
    let resources = resources_root();

    // The portfolio used to live in the shipped tree. Copy, do not move — the old Python Panel
    // reads the same file, and breaking it was never part of this.
    //
    // Whether that file was there is also the one honest signal for "was this an existing Panel
    // or a fresh install", and `crate::modules` needs it: an existing setup must keep every
    // module it already had, while a fresh one starts with the few that need no credential.
    let config = user.join("config.json");
    let mut upgraded = false;
    if !config.is_file() {
        let legacy = resources.join("config.json");
        if legacy.is_file() {
            let _ = fs::copy(&legacy, &config);
            upgraded = true;
        } else {
            let _ = fs::write(&config, DEFAULT_CONFIG);
        }
    }

    // `~/.appgea/brain` predates this split. Move it whole; an append-only log has no merge.
    let brain = brain_dir();
    if !brain.is_dir() {
        let legacy = std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|home| home.join(".appgea").join("brain"));
        match legacy {
            Some(legacy) if legacy.is_dir() => {
                let _ = fs::rename(&legacy, &brain);
            }
            _ => {
                let _ = fs::create_dir_all(&brain);
            }
        }
    }

    // The ops template ships empty of content and full of structure. That is the whole point:
    // a new user gets the shape of a portfolio brain, never the previous owner's decisions.
    let ops = ops_dir();
    if !ops.is_dir() {
        let template = resources.join("ops-template").join("ops");
        if template.is_dir() {
            let _ = copy_tree(&template, &ops);
        } else {
            let _ = fs::create_dir_all(&ops);
        }
    }

    let _ = fs::create_dir_all(user_modules_dir());
    let _ = fs::create_dir_all(user.join("state"));
    upgraded
}

/// A fresh portfolio: empty, but shaped like the file every reader already expects.
const DEFAULT_CONFIG: &str = r#"{
  "opsRoot": "",
  "groups": [],
  "projects": [],
  "injectOps": "floor",
  "defaultAgent": "claude",
  "terminalApp": "terminal",
  "devRunner": "",
  "plainView": true,
  "disabledModules": []
}
"#;

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Run the first-run check in its own process. Changing HOME or PANEL_USER_HOME in this
    /// process would race every other test that reads the user's portfolio or modules.
    #[test]
    fn a_fresh_home_is_usable_and_never_inside_the_bundle() {
        if std::env::var_os("PANEL_PATHS_TEST_CHILD").is_none() {
            let base =
                std::env::temp_dir().join(format!("panel-paths-test-{}", std::process::id()));
            let _ = fs::remove_dir_all(&base);
            fs::create_dir_all(&base).unwrap();
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "paths::tests::a_fresh_home_is_usable_and_never_inside_the_bundle",
                ])
                .env("PANEL_PATHS_TEST_CHILD", "1")
                .env("PANEL_USER_HOME", base.join("user"))
                .env("HOME", &base)
                .output()
                .unwrap();
            let _ = fs::remove_dir_all(&base);
            assert!(
                output.status.success(),
                "fresh-home check failed:\n{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }

        let home = PathBuf::from(std::env::var_os("PANEL_USER_HOME").unwrap());

        let _ = migrate();

        assert!(config_file().is_file(), "no config.json after migrate");
        assert!(brain_dir().is_dir(), "no brain dir after migrate");
        assert!(
            user_modules_dir().is_dir(),
            "no user modules dir after migrate"
        );

        // The guarantee the whole split exists for.
        let resources = resources_root();
        assert!(
            ops_dir().join("portfolio.yaml").is_file(),
            "ops was not seeded from the template"
        );
        assert!(
            !ops_dir().join("apps/tavla.md").exists(),
            "the template must carry structure, never the previous owner's apps"
        );

        for path in [
            config_file(),
            brain_dir(),
            ops_dir(),
            user_modules_dir(),
            module_state_dir("analytics"),
        ] {
            assert!(
                !path.starts_with(&resources),
                "{} is inside the read-only bundle",
                path.display()
            );
            assert!(
                path.starts_with(&home),
                "{} escaped the user home",
                path.display()
            );
        }
    }

    /// A Bridge-era home keeps working under the new name, and stays where it was.
    #[test]
    fn an_old_bridge_home_is_linked_not_moved() {
        if std::env::var_os("PANEL_PATHS_TEST_CHILD").is_none() {
            let base =
                std::env::temp_dir().join(format!("panel-legacy-test-{}", std::process::id()));
            let _ = fs::remove_dir_all(&base);
            fs::create_dir_all(base.join(".appgeabridge")).unwrap();
            fs::write(base.join(".appgeabridge/config.json"), "{\"projects\":[]}").unwrap();
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "paths::tests::an_old_bridge_home_is_linked_not_moved"])
                .env("PANEL_PATHS_TEST_CHILD", "1")
                .env_remove("PANEL_USER_HOME")
                .env("HOME", &base)
                .output()
                .unwrap();
            let _ = fs::remove_dir_all(&base);
            assert!(
                output.status.success(),
                "legacy-home check failed:\n{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }

        let home = PathBuf::from(std::env::var_os("HOME").unwrap());
        let root = user_root();
        assert_eq!(root, home.join(".appgeapanel"));
        assert!(fs::symlink_metadata(&root).unwrap().file_type().is_symlink());
        assert_eq!(
            fs::read_to_string(config_file()).unwrap(),
            "{\"projects\":[]}",
            "the old portfolio must read through the new name"
        );
        assert!(home.join(".appgeabridge/config.json").is_file(), "the old home must stay put");
    }
}
