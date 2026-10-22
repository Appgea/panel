//! The Panel modules — git-manager, Product Spine, release-manager — reached without a server.
//!
//! Their host protocol is CGI-like and ONE-SHOT (`"protocol": "cgi-argv"`):
//!
//!     argv:   <interp> <exec> METHOD PATH [..manifest args]     cwd: the module root
//!     stdin:  the request body
//!     stdout: "status\ncontent-type\n\nbody"
//!
//! So there is no daemon to babysit and nothing to port: Appgea Panel invokes the same Python
//! the old Panel invokes, and gets the same bytes back. That is the whole reason the modules
//! were never rewritten — they are IO-bound scripts, and Rust buys nothing by owning them.
//!
//! These are served to the webview through a `module://` URI scheme (see main.rs) rather than
//! a localhost port, so nothing is exposed off-machine.
//!
//! IMPORTANT — the URL shape is load-bearing. A module is passed `--base-path /m/<name>`, so
//! the HTML it emits contains ABSOLUTE links like `/m/product-spine/app/x/business`. The scheme
//! therefore serves at that exact path shape and strips `/m/<name>` back off before invoking,
//! which is precisely what the old Python `server.py` does. Serve it anywhere else and every
//! link inside Product Spine breaks.

use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize)]
pub struct Module {
    pub name: String,
    pub title: String,
    pub icon: String,
    /// `assets/chat.js` + `assets/chat.css` — the module's own renderers and animations.
    pub chat_js: Option<String>,
    pub chat_css: Option<String>,
    /// Project tabs contributed by this extension. Core renders their chrome and mount.
    pub project_surfaces: Vec<ProjectSurface>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectSurface {
    pub id: String,
    pub title: String,
    pub glyph: String,
    pub roles: Vec<String>,
    pub types: Vec<String>,
    /// Module route. `{id}` and `{path}` are resolved by the UI.
    pub mount: String,
}

#[derive(Clone)]
pub struct Manifest {
    pub name: String,
    root: PathBuf,
    exec: PathBuf,
    args: Vec<String>,
}

pub struct Response {
    pub status: u16,
    pub content_type: String,
    pub body: Vec<u8>,
}

impl Response {
    fn text(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            content_type: "text/plain; charset=utf-8".into(),
            body: message.into().into_bytes(),
        }
    }
}

fn modules_dir(panel_home: &Path) -> PathBuf {
    panel_home.join("modules")
}

/// Where modules are looked for, in load order.
///
/// The shipped set first, then `~/.appgeapanel/modules` — anything the human dropped in
/// themselves. A user copy of a shipped name wins, which is what makes "edit the module, restart,
/// see the change" possible without touching an installed app bundle.
fn module_roots(panel_home: &Path) -> [PathBuf; 2] {
    [modules_dir(panel_home), crate::paths::user_modules_dir()]
}

fn canonical_module_name(name: &str) -> &str {
    match name {
        "decision-map" => "product-spine",
        current => current,
    }
}

/// Every module present on disk, installed or not.
fn discover(panel_home: &Path) -> Vec<Manifest> {
    let mut found: Vec<Manifest> = Vec::new();
    for root in module_roots(panel_home) {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for manifest in entries
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| manifest_at(&entry.path()))
        {
            // Later roots override earlier ones by name — see `module_roots`.
            found.retain(|existing| existing.name != manifest.name);
            found.push(manifest);
        }
    }
    found.sort_by(|a, b| a.name.cmp(&b.name));
    found
}

fn cached_discover(panel_home: &Path) -> Vec<Manifest> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, (Instant, Vec<Manifest>)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let cached = cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(panel_home)
        .cloned();
    if let Some((checked, manifests)) = cached {
        if checked.elapsed() < Duration::from_secs(2) {
            return manifests;
        }
    }
    let manifests = discover(panel_home);
    cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(
            panel_home.to_path_buf(),
            (Instant::now(), manifests.clone()),
        );
    manifests
}

/// The modules this Panel actually serves — present AND installed.
///
/// Shipping an extension and turning it on are two different things. Everything public rides
/// along in the bundle so installing is instant and offline, but a module the human never asked
/// for stays dark. Most of them want a credential or a toolchain, and a rail full of tabs that
/// open onto an error is worse than three tabs that work.
pub fn load(panel_home: &Path) -> Vec<Manifest> {
    let mut installed = installed_names();
    installed.extend(required_extension_names());
    cached_discover(panel_home)
        .into_iter()
        .filter(|manifest| installed.contains(&manifest.name))
        .collect()
}

/// A project declaring an extension is an installation request for that extension.
/// This keeps a typed project from opening onto a missing surface after config migration.
fn required_extension_names() -> HashSet<String> {
    crate::projects::load()
        .into_iter()
        .map(|project| project.extension_id)
        .filter(|name| !name.is_empty())
        .collect()
}

/* -------------------------------------------------------------- installation */

/// One row of the extensions screen.
#[derive(Debug, Clone, Serialize)]
pub struct CatalogEntry {
    pub name: String,
    pub title: String,
    pub icon: String,
    pub summary: String,
    pub installed: bool,
    /// False for anything found in `~/.appgeapanel/modules` — the human put it there.
    pub bundled: bool,
    /// Commands the manifest says it needs.
    pub requires: Vec<String>,
    /// The subset of `requires` that is not on PATH. Reported, never enforced: a missing tool is
    /// something to tell someone about, not a reason to refuse the install they just asked for.
    pub missing: Vec<String>,
}

fn installed_file() -> PathBuf {
    crate::paths::installed_modules_file()
}

/// Names the human has turned on. A module dropped into `~/.appgeapanel/modules` by hand counts
/// as installed without asking — putting it there IS the install.
pub fn installed_names() -> HashSet<String> {
    let mut names: HashSet<String> = std::fs::read_to_string(installed_file())
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|config| {
            config["installed"].as_array().map(|list| {
                list.iter()
                    .filter_map(|entry| entry.as_str())
                    .map(str::to_string)
                    .collect()
            })
        })
        .unwrap_or_default();
    if let Ok(entries) = std::fs::read_dir(crate::paths::user_modules_dir()) {
        for entry in entries.filter_map(|entry| entry.ok()) {
            if let Some(manifest) = manifest_at(&entry.path()) {
                names.insert(manifest.name);
            }
        }
    }
    names
}

fn write_installed(names: &HashSet<String>) -> Result<(), String> {
    let mut sorted: Vec<&String> = names.iter().collect();
    sorted.sort();
    let body = serde_json::json!({ "version": 1, "installed": sorted });
    std::fs::write(
        installed_file(),
        serde_json::to_string_pretty(&body).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

/// What a fresh install starts with: the modules that work with no credential and no toolchain.
///
/// Everything else is one click away in the extensions screen. Landing on a Panel where four of
/// six tabs demand an API key teaches people the tabs are broken.
const DEFAULT_INSTALLED: [&str; 1] = ["git-manager"];

/// Write `modules.json` once, on the first launch that finds it missing.
///
/// `upgraded` means this machine already ran an older Panel. Those modules were all live, and
/// silently switching six of them off during an update would read as data loss, so an upgrade
/// keeps everything it finds and only a genuinely new install gets the small default set.
pub fn seed_installed(panel_home: &Path, upgraded: bool) {
    if installed_file().is_file() {
        return;
    }
    let names: HashSet<String> = if upgraded {
        discover(panel_home)
            .into_iter()
            .map(|manifest| manifest.name)
            .collect()
    } else {
        DEFAULT_INSTALLED
            .iter()
            .map(|name| name.to_string())
            .collect()
    };
    let _ = write_installed(&names);
}

/// Every module the human could turn on, with what it is and what it wants.
pub fn catalog(panel_home: &Path) -> Vec<CatalogEntry> {
    let mut installed = installed_names();
    installed.extend(required_extension_names());
    let user_root = crate::paths::user_modules_dir();
    discover(panel_home)
        .into_iter()
        .filter_map(|manifest| {
            let raw = std::fs::read_to_string(manifest.root.join("module.json")).ok()?;
            let json: Value = serde_json::from_str(&raw).ok()?;
            let requires: Vec<String> = json["requires"]
                .as_array()
                .map(|list| {
                    list.iter()
                        .filter_map(|value| value.as_str())
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            let missing = requires
                .iter()
                .filter(|command| !on_path(command))
                .cloned()
                .collect();
            Some(CatalogEntry {
                installed: installed.contains(&manifest.name),
                bundled: !manifest.root.starts_with(&user_root),
                title: json["title"].as_str().unwrap_or(&manifest.name).to_string(),
                icon: json["icon"].as_str().unwrap_or("•").to_string(),
                summary: json["summary"].as_str().unwrap_or("").to_string(),
                name: manifest.name,
                requires,
                missing,
            })
        })
        .collect()
}

/// Turn a module on. The code is already on disk, so this only records the choice.
pub fn install(panel_home: &Path, name: &str) -> Result<Vec<CatalogEntry>, String> {
    if !discover(panel_home).iter().any(|m| m.name == name) {
        return Err(format!("no such extension: {name}"));
    }
    let mut names = installed_names();
    names.insert(name.to_string());
    write_installed(&names)?;
    Ok(catalog(panel_home))
}

/// Turn a module off. Its state under `~/.appgeapanel/state/<name>` is deliberately left alone:
/// uninstalling should not throw away the credentials you would have to paste again to undo it.
pub fn uninstall(panel_home: &Path, name: &str) -> Result<Vec<CatalogEntry>, String> {
    if required_extension_names().contains(name) {
        return Err(format!(
            "{name} is required by a registered project — remove that extensionId first"
        ));
    }
    if crate::paths::user_modules_dir().join(name).is_dir() {
        return Err(format!(
            "{name} lives in ~/.appgeapanel/modules — remove that folder to uninstall it"
        ));
    }
    let mut names = installed_names();
    names.remove(name);
    write_installed(&names)?;
    Ok(catalog(panel_home))
}

/// Is a command reachable? `which` rather than a PATH walk, so shell builtins and shims resolve
/// the same way they will when the module actually runs.
fn on_path(command: &str) -> bool {
    // Manifests say `python3`; `interpreter` runs whatever this platform calls Python.
    let command = if command == "python3" { crate::platform::python() } else { command };
    crate::platform::on_path(command)
}

fn manifest_at(root: &Path) -> Option<Manifest> {
    let raw = std::fs::read_to_string(root.join("module.json")).ok()?;
    let json: Value = serde_json::from_str(&raw).ok()?;
    let name = json["name"].as_str()?.to_string();
    let exec = root.join(json["exec"].as_str()?);
    if !exec.is_file() {
        return None;
    }
    // `{root}` is the only substitution the manifests actually use.
    let root_str = root.to_string_lossy().into_owned();
    let args = json["args"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|arg| arg.as_str())
                .map(|arg| arg.replace("{root}", &root_str))
                .collect()
        })
        .unwrap_or_default();
    Some(Manifest {
        name,
        root: root.to_path_buf(),
        exec,
        args,
    })
}

/// The UI-facing list, with each module's chat assets inlined.
///
/// The assets ARE the design: `git-manager/assets/chat.js` is what draws the animated commit
/// graph (`window.GitManager.renderGraph`), and its chat.css owns the named animations. They
/// are injected into the page rather than fetched, so they work with no origin and no CSP hole.
pub fn describe(panel_home: &Path) -> Vec<Module> {
    load(panel_home)
        .into_iter()
        .filter_map(|manifest| {
            let raw = std::fs::read_to_string(manifest.root.join("module.json")).ok()?;
            let json: Value = serde_json::from_str(&raw).ok()?;
            let asset = |key: &str| {
                json["chatAsset"][key]
                    .as_str()
                    .map(|rel| manifest.root.join(rel))
                    .and_then(|path| std::fs::read_to_string(path).ok())
            };
            let project_surfaces = json["projectSurfaces"]
                .as_array()
                .map(|surfaces| {
                    surfaces
                        .iter()
                        .filter_map(|surface| {
                            let id = surface["id"].as_str()?.trim().to_string();
                            let mount = surface["mount"].as_str()?.trim().to_string();
                            if id.is_empty() || mount.is_empty() {
                                return None;
                            }
                            let strings = |key: &str| {
                                surface[key]
                                    .as_array()
                                    .map(|items| {
                                        items
                                            .iter()
                                            .filter_map(|item| item.as_str().map(str::to_string))
                                            .collect()
                                    })
                                    .unwrap_or_default()
                            };
                            Some(ProjectSurface {
                                title: surface["title"].as_str().unwrap_or(&id).to_string(),
                                glyph: surface["glyph"]
                                    .as_str()
                                    .unwrap_or_else(|| json["icon"].as_str().unwrap_or("•"))
                                    .to_string(),
                                roles: strings("roles"),
                                types: strings("types"),
                                id,
                                mount,
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            Some(Module {
                name: manifest.name.clone(),
                title: json["title"].as_str().unwrap_or(&manifest.name).to_string(),
                icon: json["icon"].as_str().unwrap_or("•").to_string(),
                chat_js: asset("js"),
                chat_css: asset("css"),
                project_surfaces,
            })
        })
        .collect()
}

/// Serve `/m/<name>/<sub>` — the same route shape the old Panel serves.
pub fn serve(panel_home: &Path, url_path: &str, method: &str, body: Vec<u8>) -> Response {
    let Some(rest) = url_path.strip_prefix("/m/") else {
        return Response::text(404, "not a module path");
    };
    let (name, sub) = match rest.split_once('/') {
        Some((name, sub)) => (name, sub),
        None => (rest, ""),
    };

    let modules = load(panel_home);
    // Old bookmarks remain useful after the product rename. The response's own
    // links use /m/product-spine, so navigation naturally becomes current.
    let canonical_name = canonical_module_name(name);
    let Some(manifest) = modules.iter().find(|m| m.name == canonical_name) else {
        return Response::text(404, format!("unknown module: {name}"));
    };

    // Static assets are read straight off disk. The old Panel does the same, to avoid a
    // subprocess spawn just to hand back a stylesheet.
    if let Some(asset) = sub.strip_prefix("assets/") {
        return serve_asset(&manifest.root.join("assets"), asset);
    }

    call(manifest, method, &format!("/{sub}"), body)
}

fn serve_asset(assets: &Path, name: &str) -> Response {
    // Never let a crafted path climb out of the assets folder.
    let file = assets.join(name.split('?').next().unwrap_or(name));
    let Ok(file) = file.canonicalize() else {
        return Response::text(404, "no such asset");
    };
    let Ok(assets) = assets.canonicalize() else {
        return Response::text(404, "no assets");
    };
    if !file.starts_with(&assets) {
        return Response::text(403, "outside the module");
    }
    let Ok(body) = std::fs::read(&file) else {
        return Response::text(404, "no such asset");
    };
    Response {
        status: 200,
        content_type: content_type(&file).into(),
        body,
    }
}

fn module_command(manifest: &Manifest, method: &str, path: &str) -> Command {
    let mut command = crate::platform::command(interpreter(&manifest.exec));
    if manifest.exec.extension().and_then(|e| e.to_str()) == Some("py") {
        // Imports must not add bytecode caches to the signed resource tree.
        command.arg("-B").arg(&manifest.exec);
    }
    command
        .arg(method)
        .arg(path)
        .args(&manifest.args)
        .current_dir(&manifest.root);
    command
}

/// One request, one process. Exactly the old contract.
pub fn call(manifest: &Manifest, method: &str, path: &str, body: Vec<u8>) -> Response {
    use std::io::{Read, Write};
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    let mut command = module_command(manifest, method, path);
    command
        // A module used to write its cache, its secrets and its job records next to its own
        // source. That works in a checkout and fails the moment Panel is installed, because
        // `Contents/Resources` is read-only. Every module gets its own writable directory under
        // the user's home instead, and finds it here rather than guessing from `__file__`.
        .env(
            "PANEL_STATE_DIR",
            crate::paths::module_state_dir(&manifest.name),
        )
        // Portfolio config lives outside the signed bundle. Module hosts use this to discover
        // the projects the installed app registered instead of scanning their own ancestors.
        .env("PANEL_USER_HOME", crate::paths::user_root())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let Ok(mut child) = command.spawn() else {
        return Response::text(500, format!("could not start module {}", manifest.name));
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(&body);
    }
    // Drain both pipes while the process runs. Waiting first can deadlock once a rich module
    // response fills the OS pipe buffer.
    let mut stdout = child.stdout.take().expect("piped module stdout");
    let mut stderr = child.stderr.take().expect("piped module stderr");
    let stdout_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        bytes
    });
    let stderr_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stderr.read_to_end(&mut bytes);
        bytes
    });
    let timeout = std::env::var("PANEL_MODULE_TIMEOUT_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|seconds| *seconds > 0)
        .unwrap_or(60);
    let deadline = Instant::now() + Duration::from_secs(timeout);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Response::text(
                    504,
                    format!("module {} timed out after {timeout}s", manifest.name),
                );
            }
            Err(error) => return Response::text(500, format!("module invoke failed: {error}")),
        }
    }
    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();
    parse(&stdout, &stderr)
}

/// "status\ncontent-type\n\nbody". A module that crashes emits no header — surface its stderr
/// rather than a blank page, because a silent module is the hardest kind to debug.
fn parse(stdout: &[u8], stderr: &[u8]) -> Response {
    // Windows Python print()s `\r\n`. The hosts here write bytes, but a module may not.
    let lf = stdout
        .windows(2)
        .position(|pair| pair == b"\n\n")
        .map(|at| (&stdout[..at], &stdout[at + 2..]));
    let crlf = stdout
        .windows(4)
        .position(|quad| quad == b"\r\n\r\n")
        .map(|at| (&stdout[..at], &stdout[at + 4..]));
    let split = lf.into_iter().chain(crlf).min_by_key(|(head, _)| head.len());

    let Some((head, body)) = split else {
        let message = if stderr.is_empty() { stdout } else { stderr };
        return Response::text(502, String::from_utf8_lossy(message).into_owned());
    };

    let head = String::from_utf8_lossy(head);
    let mut lines = head.lines();
    let Some(status) = lines
        .next()
        .and_then(|line| line.trim().parse::<u16>().ok())
    else {
        let message = if stderr.is_empty() { stdout } else { stderr };
        return Response::text(502, String::from_utf8_lossy(message).into_owned());
    };
    Response {
        status,
        content_type: lines
            .next()
            .map(|line| line.trim().to_string())
            .unwrap_or_else(|| "text/html; charset=utf-8".into()),
        body: body.to_vec(),
    }
}

fn interpreter(exec: &Path) -> PathBuf {
    if exec.extension().and_then(|e| e.to_str()) == Some("py") {
        PathBuf::from(crate::platform::python())
    } else {
        exec.to_path_buf()
    }
}

fn content_type(file: &Path) -> &'static str {
    match file.extension().and_then(|e| e.to_str()) {
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("html") => "text/html; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn home() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../..")
    }

    #[test]
    fn the_real_modules_are_discovered_with_their_chat_assets() {
        if !modules_dir(&home()).is_dir() {
            return; // not a full checkout
        }
        let modules = describe(&home());
        let git = modules.iter().find(|m| m.name == "git-manager");
        let git = git.expect("git-manager should be discovered");
        // The animated commit graph IS this file. If it stops loading, the screen is gone.
        let js = git.chat_js.as_ref().expect("git-manager ships a chat.js");
        assert!(
            js.contains("GitManager"),
            "git-manager chat.js should define window.GitManager"
        );
        assert!(git.chat_css.is_some(), "git-manager ships a chat.css");
    }

    #[test]
    fn python_imports_leave_the_signed_resource_tree_unchanged() {
        let root =
            std::env::temp_dir().join(format!("panel-module-cache-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("helper.py"), "VALUE = 42\n").unwrap();
        let exec = root.join("host.py");
        fs::write(
            &exec,
            // Bytes, as the real hosts write them: print() would turn \n into \r\n on Windows.
            "import helper, sys\nsys.stdout.buffer.write(b'200\\napplication/json\\n\\n{\"value\":%d}\\n' % helper.VALUE)\n",
        )
        .unwrap();
        let manifest = Manifest {
            name: "cache-test".into(),
            root: root.clone(),
            exec,
            args: Vec::new(),
        };
        let output = module_command(&manifest, "GET", "/").output().unwrap();
        let wrote_cache = root.join("__pycache__").exists();
        let _ = fs::remove_dir_all(&root);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            parse(&output.stdout, &output.stderr).body,
            b"{\"value\":42}\n"
        );
        assert!(!wrote_cache, "Python changed the signed resource tree");
    }

    #[test]
    fn a_cgi_header_is_split_from_its_body() {
        let out = b"200\napplication/json; charset=utf-8\n\n{\"ok\":true}";
        let parsed = parse(out, b"");
        assert_eq!(parsed.status, 200);
        assert_eq!(parsed.content_type, "application/json; charset=utf-8");
        assert_eq!(parsed.body, b"{\"ok\":true}");
    }

    #[test]
    fn a_crashed_module_surfaces_its_stderr_instead_of_a_blank_page() {
        let parsed = parse(b"", b"Traceback: boom");
        assert_eq!(parsed.status, 502);
        assert_eq!(String::from_utf8_lossy(&parsed.body), "Traceback: boom");
    }

    #[test]
    fn a_windows_print_head_still_parses() {
        let parsed = parse(b"404\r\ntext/plain\r\n\r\nmissing\n\nline", b"");
        assert_eq!(parsed.status, 404);
        assert_eq!(parsed.content_type, "text/plain");
        assert_eq!(parsed.body, b"missing\n\nline");
    }

    /// The module's own HTML links to `/m/<name>/...`, so this route shape is not cosmetic.
    #[test]
    fn a_module_path_strips_its_prefix_before_invoking() {
        let rest = "/m/product-spine/app/tavla/business"
            .strip_prefix("/m/")
            .unwrap();
        let (name, sub) = rest.split_once('/').unwrap();
        assert_eq!(name, "product-spine");
        assert_eq!(format!("/{sub}"), "/app/tavla/business");
    }

    #[test]
    fn the_legacy_route_name_resolves_to_product_spine() {
        assert_eq!(canonical_module_name("decision-map"), "product-spine");
    }
}
