//! Running an app on an iOS simulator — hosted exactly like an agent: in a PTY.
//!
//! A `flutter run` is a long-lived process whose stdin takes `r` (hot reload) and `R` (hot
//! restart) and whose stdout narrates its lifecycle. That is *precisely* what `panel-terminal`
//! already owns, so the sim runner invents no new process model. It only:
//!   1. picks and boots a simulator (`xcrun simctl`),
//!   2. hands `panel-terminal` the argv to run (Flutter or a native app),
//!   3. watches the PTY output for lifecycle lines and turns them into `VisualRequested{view:"sim"}`
//!      status events (the same string-routed path git moments already use), and
//!   4. brings the run's own simulator to the front once, when the app first reaches it.
//!      Output alone never raises it again: a hot reload typed elsewhere must not steal focus.
//!
//! Reload is not a signal or a pid-file here: the process lives in a real PTY, so a reload is
//! literally a write of "r" to that PTY (`write_terminal`), and `R` is a hot restart.

use crate::android;
use panel_core::PanelEvent;
use panel_ingress::ProjectEvent;
use serde::Serialize;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// One available simulator, as the device picker sees it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimDevice {
    pub udid: String,
    pub name: String,
    pub runtime: String,
    pub booted: bool,
}

/// A resolved run: what to spawn, and where.
pub struct SimRun {
    /// "flutter", "native", "android", "godot" or "electron" — the UI labels from this.
    pub kind: &'static str,
    pub cwd: PathBuf,
    pub program: String,
    pub args: Vec<String>,
}

// Which kinds need a simulator, and what a device-less run is addressed as, both moved to
// `targets.rs`. A Godot game is developed on the desktop — the engine runs the project in its own
// window — and it now gets a real `desktop` target rather than a stand-in device pretending to be
// a simulator with an empty udid.

/// What Panel tracks about one live run so cleanup can release its device, and so a second Run on
/// the same app finds the run it already has instead of opening another one.
///
/// `device_id` is what the toolchain calls the machine the app landed on — a simulator udid, an
/// Android serial — and is empty for a run with no device of its own (Chrome, the Mac, a Godot
/// window). The lease `address` is always set, because every run holds a lease whether or not a
/// device is involved; that is what stops two runs from fighting over the one Chrome.
pub struct SimMeta {
    pub project: String,
    pub kind: &'static str,
    pub device: String,
    pub device_id: String,
    /// Lease address, e.g. `ipad:8A1F-…` or `chrome`.
    pub address: String,
    /// Lease owner. The project id for its one run; suffixed for a deliberate extra instance.
    pub owner: String,
    /// Panel booted this simulator, so Panel owes the RAM back when the run ends.
    pub booted_by_us: bool,
}

/// Shut a simulator down to actually give the RAM back. Booting keeps a device resident even after
/// its app quits; an idle booted sim is precisely what accumulates until the machine hangs, so the
/// cap and end-of-run cleanup both call this. Fire-and-forget on a throwaway thread.
pub fn shutdown_device(udid: &str) {
    if udid.is_empty() {
        return;
    }
    let udid = udid.to_string();
    std::thread::spawn(move || shutdown_device_now(&udid));
}

/// The same shutdown, waited on. Quitting Panel must not hand the machine back with the
/// afternoon's simulators still resident, and `app.exit` kills a throwaway thread long before
/// `simctl` has finished — so the exit path pays the second it costs to actually release them.
pub fn shutdown_device_now(udid: &str) {
    if udid.is_empty() {
        return;
    }
    let _ = crate::platform::command("xcrun")
        .args(["simctl", "shutdown", udid])
        .status();
}

// ------------------------------------------------------------------ simulators

/// Available iOS simulators, newest runtime first, booted ones flagged.
pub fn list_devices() -> Vec<SimDevice> {
    let out = match crate::platform::command("xcrun")
        .args(["simctl", "list", "devices", "available", "--json"])
        .output()
    {
        Ok(out) if out.status.success() => out.stdout,
        _ => return Vec::new(),
    };
    let value: serde_json::Value = match serde_json::from_slice(&out) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    let mut rows: Vec<(u32, u32, SimDevice)> = Vec::new();
    if let Some(map) = value.get("devices").and_then(|d| d.as_object()) {
        for (runtime, devices) in map {
            if !runtime.contains("iOS") {
                continue;
            }
            let ver = ios_version(runtime);
            let label = format!("iOS {}.{}", ver.0, ver.1);
            for device in devices.as_array().into_iter().flatten() {
                if device.get("isAvailable").and_then(|a| a.as_bool()) == Some(false) {
                    continue;
                }
                let state = device.get("state").and_then(|s| s.as_str()).unwrap_or("");
                rows.push((
                    ver.0,
                    ver.1,
                    SimDevice {
                        udid: device
                            .get("udid")
                            .and_then(|u| u.as_str())
                            .unwrap_or_default()
                            .to_string(),
                        name: device
                            .get("name")
                            .and_then(|n| n.as_str())
                            .unwrap_or_default()
                            .to_string(),
                        runtime: label.clone(),
                        booted: state == "Booted",
                    },
                ));
            }
        }
    }
    // newest runtime first, real iPhones ahead of iPads/watches within a runtime
    rows.sort_by(|a, b| {
        (b.0, b.1, a.2.name.contains("iPhone")).cmp(&(a.0, a.1, b.2.name.contains("iPhone")))
    });
    rows.into_iter().map(|(_, _, device)| device).collect()
}

fn ios_version(runtime_key: &str) -> (u32, u32) {
    // "...SimRuntime.iOS-17-5" -> (17, 5)
    if let Some(tail) = runtime_key.split("iOS-").nth(1) {
        let mut parts = tail.split(['-', '.']);
        let major = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
        let minor = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
        return (major, minor);
    }
    (0, 0)
}

pub fn device_by_udid(udid: &str) -> Option<SimDevice> {
    list_devices().into_iter().find(|d| d.udid == udid)
}

// ------------------------------------------------- which simulator is this app's, derived

/// An app keeps its simulator — and Panel works that out from the devices themselves, every time
/// it is asked. **A simulator that has this app installed on it IS this app's simulator.**
///
/// There is deliberately no stored map. A remembered binding is a claim about the world that stops
/// being true the moment someone erases a device, deletes the app, or runs it from Xcode instead —
/// and then Panel is confidently pointing at the wrong device. The install is the fact; reading it
/// costs a directory walk over a few Info.plists, which is nothing next to a build.
///
/// Every device keeps its containers on disk whether it is booted or not, which is what makes this
/// readable at all: `simctl listapps` needs a booted device, so it cannot answer for the powered-off
/// device Auto most wants to pick.
fn devices_root() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
        .join("Library/Developer/CoreSimulator/Devices")
}

/// Every app bundle installed on one device — the `.app` directories themselves, in no order.
/// Only third-party apps live under `Containers/Bundle/Application`, so nothing here has to filter
/// out iOS itself, and a device with none of these is a genuinely clean device.
fn installed_apps(udid: &str) -> Vec<PathBuf> {
    let root = devices_root()
        .join(udid)
        .join("data/Containers/Bundle/Application");
    let mut apps = Vec::new();
    let Ok(entries) = std::fs::read_dir(&root) else {
        return apps;
    };
    for entry in entries.filter_map(Result::ok) {
        let Ok(inner) = std::fs::read_dir(entry.path()) else {
            continue;
        };
        for app in inner.filter_map(Result::ok) {
            if app.path().extension().and_then(|e| e.to_str()) == Some("app") {
                apps.push(app.path());
            }
        }
    }
    apps
}

/// When `bundle` was last installed on this device, or None if it is not there.
///
/// The question is asked the cheap way round. Reading `CFBundleIdentifier` out of every app would
/// mean parsing plists — a built Info.plist is usually BINARY, and a binary plist keeps its keys and
/// values in separate tables, so the id is nowhere near the key that names it. But we already KNOW
/// the id we are looking for, so the file only has to be searched for it. No parser, no `plutil`
/// subprocess per app, and it works for XML bundles too.
fn app_installed_at(udid: &str, bundle: &str) -> Option<SystemTime> {
    for app in installed_apps(udid) {
        let plist = app.join("Info.plist");
        let Ok(bytes) = std::fs::read(&plist) else {
            continue;
        };
        if !mentions_bundle(&bytes, bundle) {
            continue;
        }
        return Some(
            plist
                .metadata()
                .and_then(|meta| meta.modified())
                .unwrap_or(UNIX_EPOCH),
        );
    }
    None
}

/// Does this plist name exactly this bundle id? The boundary check is the whole correctness of the
/// search: without it `com.appgea.tavla` would also match `com.appgea.tavlaskor`, an app group
/// `group.com.appgea.tavla`, or the watch extension `com.appgea.tavla.watchkitapp`.
///
/// Text and binary need different boundaries, because neighbouring BYTES in a binary plist are
/// another object's marker and can be identifier characters by coincidence. So each format is
/// checked on its own terms — and the binary one is exact rather than heuristic: an ASCII string
/// carries its LENGTH in front of it, which no longer id can share.
fn mentions_bundle(bytes: &[u8], bundle: &str) -> bool {
    let needle = bundle.as_bytes();
    let len = needle.len();
    if len == 0 {
        return false;
    }
    bytes
        .windows(len)
        .enumerate()
        .filter(|(_, window)| *window == needle)
        .any(|(at, _)| {
            // XML: the value is delimited, so no identifier character touches it on either side.
            let free_text = bytes.get(at.wrapping_sub(1)) != Some(&b'.')
                && !bytes.get(at + len).is_some_and(|b| is_bundle_char(*b));
            // Binary, short ASCII string: one marker byte, 0x50 | length.
            let short = len < 15 && bytes.get(at.wrapping_sub(1)) == Some(&(0x50 | len as u8));
            // Binary, 15 characters or more: marker 0x5F, then the length as its own int object.
            let long = (15..=255).contains(&len)
                && at >= 3
                && bytes[at - 3] == 0x5f
                && bytes[at - 2] == 0x10
                && bytes[at - 1] == len as u8;
            free_text || short || long
        })
}

fn is_bundle_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-' || byte == b'_'
}

/// The iOS bundle id this project installs. `appgea.json` states it for a managed app; for anything
/// else it comes out of the Xcode project, which is where the build reads it from anyway.
pub fn bundle_id(root: &Path) -> Option<String> {
    if let Some(manifest) = std::fs::read_to_string(root.join("appgea.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
    {
        if let Some(id) = manifest
            .get("iosBundleId")
            .and_then(|id| id.as_str())
            .filter(|id| id.contains('.'))
        {
            return Some(id.to_string());
        }
    }
    for dir in [root.to_path_buf(), root.join("ios")] {
        for project in std::fs::read_dir(&dir)
            .ok()
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
        {
            if project.path().extension().and_then(|e| e.to_str()) != Some("xcodeproj") {
                continue;
            }
            if let Some(id) = bundle_id_in_pbxproj(&project.path().join("project.pbxproj")) {
                return Some(id);
            }
        }
    }
    None
}

/// The app target's bundle id, skipping the test targets that carry one of their own.
fn bundle_id_in_pbxproj(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    text.split("PRODUCT_BUNDLE_IDENTIFIER = ")
        .skip(1)
        .filter_map(|tail| tail.split(';').next())
        .map(|id| id.trim().trim_matches('"').to_string())
        .find(|id| {
            id.contains('.')
                && !id.ends_with("Tests")
                && !id.ends_with(".xctrunner")
                && !id.contains("RunnerTests")
        })
}

/// Every simulator that currently has `bundle` installed, freshest install first, booted ahead of
/// powered-off. That order is the whole heuristic: the device showing the app wins, otherwise the
/// one it was most recently run on.
fn devices_with_app(devices: &[SimDevice], bundle: &str) -> Vec<SimDevice> {
    let mut owned: Vec<(bool, SystemTime, SimDevice)> = devices
        .iter()
        .filter_map(|device| {
            let installed = app_installed_at(&device.udid, bundle)?;
            Some((device.booted, installed, device.clone()))
        })
        .collect();
    owned.sort_by(|a, b| (b.0, b.1).cmp(&(a.0, a.1)));
    owned.into_iter().map(|(_, _, device)| device).collect()
}

/// The device this app is already on, if any. What the Run screen labels "its simulator".
pub fn own_device(devices: &[SimDevice], root: &Path) -> Option<SimDevice> {
    let bundle = bundle_id(root)?;
    devices_with_app(devices, &bundle).into_iter().next()
}

/// Resolve every portfolio bundle in one pass over simulator app containers.
///
/// `own_device` is the right small query for one run. The Run library asks the same question for
/// every project, so rereading each Info.plist once per project turns P projects × D devices into
/// avoidable disk work. This keeps the same installed-app truth while reading every plist once.
pub fn device_owners(
    devices: &[SimDevice],
    bundles: &HashSet<String>,
) -> HashMap<String, SimDevice> {
    let mut found: HashMap<String, (bool, SystemTime, SimDevice)> = HashMap::new();
    for device in devices {
        for app in installed_apps(&device.udid) {
            let plist = app.join("Info.plist");
            let Ok(bytes) = std::fs::read(&plist) else {
                continue;
            };
            let installed = plist
                .metadata()
                .and_then(|meta| meta.modified())
                .unwrap_or(UNIX_EPOCH);
            for bundle in bundles {
                if !mentions_bundle(&bytes, bundle) {
                    continue;
                }
                let candidate = (device.booted, installed);
                let replace = found
                    .get(bundle)
                    .is_none_or(|current| candidate > (current.0, current.1));
                if replace {
                    found.insert(bundle.clone(), (device.booted, installed, device.clone()));
                }
            }
        }
    }
    found
        .into_iter()
        .map(|(bundle, (_, _, device))| (bundle, device))
        .collect()
}

/// Has nobody's work on it — no third-party apps at all. A clean device is nobody's afternoon, so
/// taking one cannot install over somebody else's test. `targets::free_in_family` prefers these
/// among the free devices; the lease already stops Auto from taking a device somebody holds, and
/// this is the softer courtesy on top of that, for a device installed from Xcode by hand.
pub fn is_clean(udid: &str) -> bool {
    installed_apps(udid).is_empty()
}

/// Explicitly create one more powered-off simulator by cloning the newest iPhone definition.
/// This is only called after the human chooses "Open another"; Auto never creates devices.
pub fn clone_device() -> Result<SimDevice, String> {
    let source = list_devices()
        .into_iter()
        .find(|device| device.name.contains("iPhone") && !device.name.contains("Watch"))
        .ok_or_else(|| "No iPhone simulator is available to clone.".to_string())?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() % 100_000)
        .unwrap_or(0);
    let name = format!("Panel {} {stamp}", source.name);
    let out = crate::platform::command("xcrun")
        .args(["simctl", "clone", &source.udid, &name])
        .output()
        .map_err(|error| error.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let udid = String::from_utf8_lossy(&out.stdout).trim().to_string();
    device_by_udid(&udid)
        .ok_or_else(|| "The new simulator was created but could not be found.".to_string())
}

/// Wipe this app off the device before it is installed again — what "fresh simulator" means.
///
/// A run reinstalls over the old container, so yesterday's onboarding flags, cached files and
/// keychain-free defaults survive and the app you are looking at is not the app a new user gets.
/// `simctl uninstall` throws that container away. It is per-app on purpose: erasing the whole
/// device would take somebody else's work with it, and the lease only promises us this app.
///
/// Silent when the app was never there — `simctl` says so on stderr and there is nothing to do.
pub fn uninstall_app(udid: &str, root: &Path) {
    if udid.is_empty() {
        return;
    }
    let Some(bundle) = bundle_id(root) else {
        return;
    };
    let _ = crate::platform::command("xcrun")
        .args(["simctl", "uninstall", udid, &bundle])
        .output();
}

/// Boot the device if it isn't already. Headless: the window comes up once, when the app is
/// running (`focus_simulator`). Raising it here too stole focus at the start of every build.
pub fn ensure_booted(udid: &str) -> Result<(), String> {
    // A device-less run (Godot on the desktop) has no simulator to boot.
    if udid.is_empty() {
        return Ok(());
    }
    let out = crate::platform::command("xcrun")
        .args(["simctl", "boot", udid])
        .output()
        .map_err(|e| e.to_string())?;
    let stderr = String::from_utf8_lossy(&out.stderr);
    // "Unable to boot device in current state: Booted" — already up, fine.
    if !out.status.success() && !stderr.contains("current state: Booted") {
        return Err(stderr.trim().to_string());
    }
    Ok(())
}

/// Bring THIS simulator to the front. Non-blocking: the actual `open` runs on a throwaway thread
/// so a caller on the PTY reader thread is never stalled, and the children get reaped.
///
/// Xcode 27 dropped Simulator.app for DeviceHub (`com.apple.dt.Devices`). Opening DeviceHub alone
/// shows whichever device it showed last, so a run on one simulator raised a powered-off window
/// of another. `devices://manage/select?id=<udid>` selects the device in DeviceHub's one main
/// window. Its sibling `devices://device/open` opens a window per device instead, and each one
/// stays open on a powered-off frame long after its run ended. Older Xcodes have no `devices:`
/// handler, `open` fails on it, and Simulator.app is the fallback. An empty udid raises the app.
pub fn focus_simulator(udid: &str) {
    let udid = udid.to_string();
    std::thread::spawn(move || {
        let open = |args: &[&str]| {
            crate::platform::command("open")
                .args(args)
                .status()
                .map(|status| status.success())
                .unwrap_or(false)
        };
        // A udid is hex and dashes. Anything else is not ours to put in a URL.
        let udid_ok = !udid.is_empty() && udid.chars().all(|c| c.is_ascii_hexdigit() || c == '-');
        if udid_ok && open(&[&format!("devices://manage/select?id={udid}")]) {
            return;
        }
        if open(&["-a", "Simulator"]) {
            return;
        }
        let _ = open(&["-b", "com.apple.dt.Devices"]);
    });
}

// ------------------------------------------------------------------ what to run

/// Resolve a project to (kind, working dir) using its `appgea.json`, falling back to a
/// `pubspec.yaml` sniff for un-manifested Flutter apps.
/// A dev server: the command that starts it, the port it must answer on, and the path worth
/// opening. Read from `appgea.json`, because nothing about a server is guessable from the
/// filesystem — `npm run dev` could be a bundler, a watcher, or a test loop.
///
/// The port is REQUIRED and the command is expected to pin it (`--strictPort` for vite, and its
/// equivalent elsewhere). A server that drifts to 5174 when 5173 is busy has no stable address,
/// so its lease would guard the wrong port and the browser would open on somebody else's app.
/// Pinning turns a silent drift into a loud failure, which is the trade worth making.
#[derive(Debug, Clone)]
pub struct ServerSpec {
    pub command: String,
    pub port: u16,
    /// Appended to `http://localhost:<port>` when the browser is opened. "/" unless stated.
    pub path: String,
}

pub fn server_spec(root: &Path) -> Option<ServerSpec> {
    let manifest = std::fs::read_to_string(root.join("appgea.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())?;
    let server = manifest.get("server")?;
    let command = server.get("command")?.as_str()?.to_string();
    let port = server.get("port")?.as_u64()? as u16;
    let path = server
        .get("path")
        .and_then(|p| p.as_str())
        .unwrap_or("/")
        .to_string();
    Some(ServerSpec {
        command,
        port,
        path,
    })
}

/// The URL a finished server run is worth looking at.
pub fn server_url(spec: &ServerSpec) -> String {
    let path = if spec.path.starts_with('/') {
        spec.path.clone()
    } else {
        format!("/{}", spec.path)
    };
    format!("http://localhost:{}{path}", spec.port)
}

/// Does the tree actually back up what the manifest claims to be? `appgea.json` is a hint about
/// where to look, never the last word: a repo that says `flutter` but carries no `pubspec.yaml`
/// is not a Flutter project, and believing the file over the filesystem produces a run plan that
/// can only fail. A claim that does not hold falls through to the sniff below.
fn claim_holds(kind: &str, dir: &Path) -> bool {
    match kind {
        "flutter" => dir.join("pubspec.yaml").is_file(),
        "godot" => dir.join("project.godot").is_file(),
        "electron" => dir.join("package.json").is_file(),
        "native" => {
            dir.join("project.yml").is_file()
                || dir.join("project.yaml").is_file()
                || has_xcode_container(dir)
        }
        "android" => is_native_android(dir),
        _ => true,
    }
}

fn is_native_android(dir: &Path) -> bool {
    (dir.join("gradlew").is_file()
        || dir.join("settings.gradle").is_file()
        || dir.join("settings.gradle.kts").is_file())
        && (dir.join("app/build.gradle").is_file() || dir.join("app/build.gradle.kts").is_file())
}

fn has_xcode_container(dir: &Path) -> bool {
    std::fs::read_dir(dir)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .any(|entry| {
            matches!(
                entry
                    .path()
                    .extension()
                    .and_then(|extension| extension.to_str()),
                Some("xcodeproj" | "xcworkspace")
            )
        })
}

fn detect(root: &Path) -> Option<(&'static str, PathBuf, bool)> {
    let manifest = std::fs::read_to_string(root.join("appgea.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok());
    if let Some(manifest) = manifest {
        // A `server` block is the declaration, whatever else the manifest says. A project can be
        // a Flutter app AND have a dev server, and the block is the thing that was written down.
        if manifest.get("server").is_some() {
            let dir = manifest
                .get("subpath")
                .and_then(|s| s.as_str())
                .map(|s| root.join(s))
                .unwrap_or_else(|| root.to_path_buf());
            return Some(("server", dir, false));
        }
        match manifest.get("appType").and_then(|t| t.as_str()) {
            Some("flutter") => {
                let dir = manifest
                    .get("subpath")
                    .and_then(|s| s.as_str())
                    .map(|s| root.join(s))
                    .unwrap_or_else(|| root.to_path_buf());
                if claim_holds("flutter", &dir) {
                    return Some(("flutter", dir, false));
                }
            }
            Some("native") => {
                let dir = manifest
                    .get("ios")
                    .and_then(|i| i.get("path"))
                    .and_then(|p| p.as_str())
                    .map(|p| root.join(p))
                    .unwrap_or_else(|| root.to_path_buf());
                let xcodegen = manifest
                    .get("ios")
                    .and_then(|i| i.get("generator"))
                    .and_then(|g| g.as_str())
                    == Some("xcodegen")
                    || dir.join("project.yml").is_file()
                    || dir.join("project.yaml").is_file();
                if claim_holds("native", &dir) {
                    return Some(("native", dir, xcodegen));
                }
            }
            Some("godot") => {
                let dir = manifest
                    .get("subpath")
                    .and_then(|s| s.as_str())
                    .map(|s| root.join(s))
                    .unwrap_or_else(|| root.to_path_buf());
                if claim_holds("godot", &dir) {
                    return Some(("godot", dir, false));
                }
            }
            // An Electron app opens its own window on the desktop, like a Godot game. Declared, not
            // sniffed: a package.json with electron somewhere in its tree is just as often a web app
            // that ships a shell on the side.
            Some("electron") => {
                let dir = manifest
                    .get("subpath")
                    .and_then(|s| s.as_str())
                    .map(|s| root.join(s))
                    .unwrap_or_else(|| root.to_path_buf());
                if claim_holds("electron", &dir) {
                    return Some(("electron", dir, false));
                }
            }
            _ => {}
        }
    }
    if root.join("pubspec.yaml").is_file() {
        return Some(("flutter", root.to_path_buf(), false));
    }
    if root.join("project.godot").is_file() {
        return Some(("godot", root.to_path_buf(), false));
    }
    if is_native_android(root) {
        return Some(("android", root.to_path_buf(), false));
    }
    // A standalone native project does not need an appgea manifest. Accept both the project root
    // and the conventional `ios/` subfolder; a spec alone is enough because XcodeGen creates the
    // Xcode container later in the run plan.
    for dir in [root.to_path_buf(), root.join("ios")] {
        let xcodegen = dir.join("project.yml").is_file() || dir.join("project.yaml").is_file();
        if xcodegen || has_xcode_container(&dir) {
            return Some(("native", dir, xcodegen));
        }
    }
    // Last resort: ask the shared runner. It knows every other kind this portfolio
    // has — node, rust, tauri, go, django, python, docker compose, a static site,
    // or a project's own Makefile target — and teaching this file each of them
    // again would be a second detector to keep in step. A project created today
    // therefore gets a Run row without anyone writing an appgea.json first.
    if dev_runner_kind(root).is_some() {
        return Some(("ag", root.to_path_buf(), false));
    }
    None
}

/// The shared runner script, from `devRunner` in config.json. Optional: without one, Run covers
/// only the kinds this file detects itself. It answers `<runner> kind` and `<runner> run`.
fn dev_runner() -> Option<PathBuf> {
    #[cfg(test)]
    return TEST_RUNNER.with(|runner| runner.borrow().clone());
    #[cfg(not(test))]
    {
        let raw = std::fs::read_to_string(crate::paths::config_file()).ok()?;
        let config: serde_json::Value = serde_json::from_str(&raw).ok()?;
        let path = config["devRunner"].as_str()?.trim();
        let path = match path.strip_prefix("~/") {
            Some(rest) => PathBuf::from(std::env::var_os("HOME")?).join(rest),
            None => PathBuf::from(path),
        };
        (path.is_absolute() && path.is_file()).then_some(path)
    }
}

// Per test thread, so a test's fake runner never leaks into another test or reads the real config.
#[cfg(test)]
thread_local! {
    static TEST_RUNNER: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

/// What the shared runner thinks this project is, or None when it cannot run it either.
///
/// Memoised until the project or runner changes. Caching a missing launcher forever
/// makes Run ignore a package.json or Makefile added while Panel is open.
fn dev_runner_kind(root: &Path) -> Option<String> {
    type Stamp = Vec<Option<(SystemTime, u64)>>;
    type Cache = HashMap<PathBuf, (Stamp, Option<String>)>;
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let key = root.to_path_buf();
    let runner = dev_runner();
    let mut inputs = vec![root.to_path_buf()];
    inputs.extend(["appgea.json", "package.json", "Makefile"].map(|name| root.join(name)));
    inputs.extend(runner.iter().cloned());
    let stamp: Stamp = inputs
        .iter()
        .map(|path| {
            let meta = std::fs::metadata(path).ok()?;
            Some((meta.modified().ok()?, meta.len()))
        })
        .collect();
    if let Ok(guard) = cache.lock() {
        if let Some((old_stamp, hit)) = guard.get(&key) {
            if *old_stamp == stamp {
                return hit.clone();
            }
        }
    }
    let kind = runner.and_then(|runner| {
        // Windows cannot exec a shell script, so it goes through Git Bash; platform::command
        // keeps the console window from flashing once per project row.
        #[cfg(windows)]
        let mut command = {
            let mut command = crate::platform::command(posix_shell());
            command.arg(&runner);
            command
        };
        #[cfg(not(windows))]
        let mut command = crate::platform::command(&runner);
        let out = command.arg("kind").current_dir(root).output().ok()?;
        if !out.status.success() {
            return None;
        }
        let kind = String::from_utf8_lossy(&out.stdout)
            .split_whitespace()
            .next()?
            .to_string();
        (!kind.is_empty() && kind != "unknown").then_some(kind)
    });
    if let Ok(mut guard) = cache.lock() {
        guard.insert(key, (stamp, kind.clone()));
    }
    kind
}

/// The directory the project actually lives in — the manifest's `subpath`/`ios.path` when there
/// is one, the root otherwise. `families_for` needs this: a Flutter app nested in a subfolder
/// keeps its `macos/` and `web/` beside its `pubspec.yaml`, not beside the repo's `.git`.
pub fn project_dir(root: &Path) -> PathBuf {
    detect(root)
        .map(|(_, dir, _)| dir)
        .unwrap_or_else(|| root.to_path_buf())
}

/// Which Apple platforms an Xcode project is actually built for, read out of the project itself.
///
/// A `.xcodeproj` states this in `SDKROOT` / `SUPPORTED_PLATFORMS`, and an XcodeGen spec states it
/// as `platform:`. Both are plain text, and a substring read of them is enough to answer a yes/no
/// question that only decides which rows the picker offers. When neither file says anything
/// recognisable we assume iOS, because that is what an unannotated iOS app has always been here.
pub fn native_platforms(dir: &Path) -> Vec<&'static str> {
    let mut text = String::new();
    for spec in ["project.yml", "project.yaml"] {
        if let Ok(raw) = std::fs::read_to_string(dir.join(spec)) {
            text.push_str(&raw);
        }
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("xcodeproj") {
                if let Ok(raw) = std::fs::read_to_string(path.join("project.pbxproj")) {
                    text.push_str(&raw);
                }
            }
        }
    }
    let lower = text.to_ascii_lowercase();
    let mac = lower.contains("sdkroot = macosx")
        || lower.contains("sdkroot = \"macosx\"")
        || lower.contains("platform: macos")
        || (lower.contains("supported_platforms") && lower.contains("macosx"));
    let ios = lower.contains("sdkroot = iphoneos")
        || lower.contains("sdkroot = \"iphoneos\"")
        || lower.contains("platform: ios")
        || lower.contains("iphonesimulator");
    let mut out = Vec::new();
    if ios || !mac {
        out.push("ios");
    }
    if mac {
        out.push("macos");
    }
    out
}

/// Build the argv for the run. Both kinds go through a login shell so `flutter`/`fvm` and the
/// Xcode toolchain are on PATH even when Panel was launched from Finder (a bare `flutter` would
/// not be found otherwise). `exec` makes the tool the pane's own process, so `r`/`R` reach it.
/// Can this project be launched on a simulator at all, and as what? The same detection `plan`
/// uses — asked without building a plan, so the Run screen can list only what it can run
/// instead of offering every project and failing at the first click.
pub fn kind_of(root: &Path) -> Option<&'static str> {
    detect(root).map(|(kind, _, _)| kind)
}

/// The Xcode app directory and whether it is generated, for a native project. `None` for every
/// other kind. The debugger needs both: one to run xcodebuild in, one to know whether the
/// container exists before the build starts.
pub fn native_spec(root: &Path) -> Option<(PathBuf, bool)> {
    match detect(root) {
        Some(("native", dir, xcodegen)) => Some((dir, xcodegen)),
        _ => None,
    }
}

/// Build the argv for a run on one target.
///
/// `device` is whatever `flutter -d` wants — a simulator udid, an Android serial, or the literal
/// `chrome`/`macos`. Flutter takes all of them through one code path, which is the whole reason
/// the Run screen can be platform-agnostic: there is no per-family branch to get wrong here.
/// Native projects stay on their own platform; neither Xcode nor Gradle has a web destination.
pub fn plan(root: &Path, device: &str, family: &str) -> Result<SimRun, String> {
    let (kind, cwd, xcodegen) = detect(root)
        .ok_or_else(|| {
            "not a Flutter, native iOS, native Android, Godot, or Electron project".to_string()
        })?;
    if kind == "native" && !matches!(family, "iphone" | "ipad" | "ios" | "macos") {
        return Err(format!("a native Xcode project cannot run on {family}"));
    }
    if kind == "native" && family == "macos" && !native_platforms(&cwd).contains(&"macos") {
        return Err("this Xcode project has no macOS destination".to_string());
    }
    if kind == "android" && family != "android" {
        return Err(format!("a native Android project cannot run on {family}"));
    }
    if matches!(kind, "ag" | "electron") && family != "desktop" {
        return Err(format!("this project runs on the desktop, not on {family}"));
    }
    if kind == "godot" && !matches!(family, "desktop" | "android" | "iphone" | "ipad") {
        return Err(format!("a Godot project cannot run on {family}"));
    }
    let shell = posix_shell();
    let script = match kind {
        "flutter" => format!("exec flutter run -d {}", shell_quote(device)),
        "godot" => match family {
            "android" => godot_android_script(root, &cwd, device)?,
            "iphone" | "ipad" => godot_ios_script(&cwd, device)?,
            _ => godot_script(&godot_run_args(root)),
        },
        "electron" => electron_script(&cwd),
        // The manifest's command verbatim, through a login shell so `npm`/`node`/`bun` are on
        // PATH when Panel was opened from Finder. `exec` makes it the pane's own process, so
        // stopping the run actually stops the server rather than orphaning it under a shell.
        "server" => {
            let spec = server_spec(root)
                .ok_or_else(|| "this project has no server block in appgea.json".to_string())?;
            format!("{}exec {}", stale_server_preamble(root, spec.port), spec.command)
        }
        "android" => native_android_script(root, device)?,
        // Whatever the shared runner decided. It prints what it is doing, so the
        // pane reads the same as every other run.
        "ag" => {
            let runner = dev_runner()
                .ok_or_else(|| "no shared runner: set devRunner in config.json".to_string())?;
            format!("exec {} run", shell_quote(&runner.to_string_lossy()))
        }
        _ if family == "macos" => native_mac_script(xcodegen),
        _ if family == "ios" => native_device_script(device, xcodegen),
        _ => native_script(device, xcodegen),
    };
    let script = if matches!(family, "iphone" | "ipad") {
        format!("{}{script}", slim_preamble(device))
    } else {
        script
    };
    Ok(SimRun {
        kind,
        cwd,
        program: shell,
        args: vec!["-lc".into(), script],
    })
}

/// Build, install and launch a standalone Gradle Android app. Logcat keeps the PTY alive and
/// gives Stop the same process lifecycle every other run kind already has.
fn native_android_script(root: &Path, serial: &str) -> Result<String, String> {
    let package = android::application_id(root)
        .ok_or_else(|| "native Android project has no applicationId".to_string())?;
    let adb = shell_quote(&android::adb().to_string_lossy());
    let serial = shell_quote(serial);
    let package = shell_quote(&package);
    let python = crate::platform::python();
    Ok(format!(
        r#"set -e
ADB={adb}
SERIAL={serial}
PACKAGE={package}
if [ -x ./gradlew ]; then GRADLE=./gradlew
elif command -v gradle >/dev/null 2>&1; then GRADLE=$(command -v gradle)
else echo "error: Gradle wrapper was not found" >&2; exit 127
fi
echo ">> building Android app"
"$GRADLE" :app:assembleDebug
APK=$(find app/build/outputs/apk/debug -maxdepth 1 -name '*.apk' -print)
[ -f "$APK" ] || {{ echo "error: expected one debug APK in app/build/outputs/apk/debug" >&2; exit 2; }}
"$ADB" -s "$SERIAL" install -r "$APK"
if [ -f app/build/outputs/apk/debug/output-metadata.json ]; then
  PACKAGE=$({python} -c 'import json; print(json.load(open("app/build/outputs/apk/debug/output-metadata.json"))["applicationId"])')
fi
COMPONENT=$("$ADB" -s "$SERIAL" shell cmd package resolve-activity --brief "$PACKAGE" 2>/dev/null | tr -d '\r' | tail -1)
case "$COMPONENT" in */*) ;; *) echo "error: no launcher activity found for $PACKAGE" >&2; exit 2 ;; esac
"$ADB" -s "$SERIAL" shell am force-stop "$PACKAGE"
echo ">> launching $COMPONENT"
"$ADB" -s "$SERIAL" shell am start -n "$COMPONENT"
PID=""
for _ in 1 2 3 4 5; do
  PID=$("$ADB" -s "$SERIAL" shell pidof -s "$PACKAGE" | tr -d '\r')
  [ -n "$PID" ] && break
  sleep 1
done
[ -n "$PID" ] || {{ echo "error: $PACKAGE stopped during launch" >&2; exit 2; }}
exec "$ADB" -s "$SERIAL" logcat --pid="$PID""#
    ))
}

/// Shell prefix that slims a stock simulator on its first run (simslim, ~30s, reboots it). Slim
/// state is only readable on a booted device, so the check lives in the pane after boot, not in
/// `ensure_booted`. No simslim installed, or a failed slim, and the run proceeds stock.
fn slim_preamble(udid: &str) -> String {
    let udid = shell_quote(udid);
    format!(
        "if command -v simslim >/dev/null 2>&1 && ! simslim verify {udid} >/dev/null 2>&1; then \
echo '>> slimming simulator (one-time, ~30s)'; \
simslim on {udid} || echo '>> slim failed, running stock'; fi\n"
    )
}

/// Shell prefix that frees a server's pinned port from this project's own leftover server.
///
/// A `npm run dev` typed in a terminal, or one orphaned when its shell died, keeps the port, and
/// the pinned command then refuses to start, so Run fails on a healthy project. Only a listener
/// whose working directory is inside this project is stopped. Another app on the port is left
/// alone, and the pinned command fails loudly as before.
fn stale_server_preamble(root: &Path, port: u16) -> String {
    let root = shell_quote(&root.to_string_lossy());
    format!(
        "for pid in $(lsof -nP -iTCP:{port} -sTCP:LISTEN -t 2>/dev/null); do \
cwd=$(lsof -a -p \"$pid\" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'); \
case \"$cwd/\" in {root}/*) \
echo \">> stopping this project's old server on :{port} (pid $pid)\"; kill \"$pid\"; \
for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 \"$pid\" 2>/dev/null || break; sleep 0.3; done;; \
esac; done\n"
    )
}

/// The shell every run script goes through. The scripts are POSIX, so on Windows that is Git
/// Bash — found where its installer puts it, because `SHELL` there is unset or an MSYS path, and
/// a bare `bash.exe` on PATH can resolve to WSL's, which cannot see a Windows project directory.
pub fn posix_shell() -> String {
    #[cfg(windows)]
    {
        let installs = ["ProgramW6432", "ProgramFiles", "LOCALAPPDATA"]
            .iter()
            .filter_map(|var| std::env::var(var).ok())
            .flat_map(|base| {
                [
                    Path::new(&base).join("Git/bin/bash.exe"),
                    Path::new(&base).join("Programs/Git/bin/bash.exe"),
                ]
            });
        for candidate in installs {
            if candidate.is_file() {
                return candidate.to_string_lossy().into_owned();
            }
        }
        "bash.exe".to_string()
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Resolve the engine binary into `$GODOT`. It is not on PATH for most installs — Godot ships as an
/// .app bundle — so look the way a human would: `GODOT_BIN`, then PATH, then the usual bundle
/// locations. Every Godot run starts with this, desktop or device, so it lives in one place.
const GODOT_LOCATE: &str = r#"GODOT="${GODOT_BIN:-}"
if [ -z "$GODOT" ]; then
  for candidate in godot godot4 Godot; do
    if command -v "$candidate" >/dev/null 2>&1; then GODOT=$(command -v "$candidate"); break; fi
  done
fi
if [ -z "$GODOT" ]; then
  for bundle in /Applications/Godot.app /Applications/Godot_mono.app "$HOME/Applications/Godot.app"; do
    BIN=$(ls "$bundle/Contents/MacOS/" 2>/dev/null | head -1)
    if [ -n "$BIN" ]; then GODOT="$bundle/Contents/MacOS/$BIN"; break; fi
  done
fi
if [ -z "$GODOT" ]; then
  # Windows ships Godot as a loose exe. The _console build writes its log into this pane.
  for dir in "$HOME/Godot" "$HOME/Downloads" "$LOCALAPPDATA/Programs/Godot" "$PROGRAMFILES/Godot"; do
    BIN=$(ls -1 "$dir"/Godot*_win64_console.exe "$dir"/Godot*_win64.exe 2>/dev/null | sort -r | head -1)
    if [ -n "$BIN" ]; then GODOT="$BIN"; break; fi
  done
fi
if [ -z "$GODOT" ]; then
  echo "error: Godot was not found. Install it, or set GODOT_BIN to the engine binary." >&2
  exit 127
fi
"#;

/// Run the game in the engine, in its own window. `args` are the project's own launch arguments
/// (see `godot_run_args`); they go after `--`, where the engine hands them to the game untouched.
fn godot_script(args: &[String]) -> String {
    let game_args = if args.is_empty() {
        String::new()
    } else {
        format!(
            " -- {}",
            args.iter().map(|a| shell_quote(a)).collect::<Vec<_>>().join(" ")
        )
    };
    format!(
        r#"set -e
{GODOT_LOCATE}echo ">> starting Godot: $GODOT"
exec "$GODOT" --path .{game_args}"#
    )
}

/// What a Godot project asks to be launched with on the desktop: `"godot": {"runArgs": [...]}` in
/// `appgea.json`. A game that is built for a phone uses it to open as one (`--phone`) — a window
/// the shape of the device, touch controls on — so the desktop run tests the mobile game rather
/// than a different, wider one. A project that says nothing gets the bare engine, as before.
pub fn godot_run_args(root: &Path) -> Vec<String> {
    std::fs::read_to_string(root.join("appgea.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|manifest| {
            manifest
                .get("godot")?
                .get("runArgs")?
                .as_array()
                .map(|args| {
                    args.iter()
                        .filter_map(|a| a.as_str().map(str::to_string))
                        .collect()
                })
        })
        .unwrap_or_default()
}

/// One export preset out of a Godot project's `export_presets.cfg`.
pub struct GodotPreset {
    pub name: String,
    pub platform: String,
    pub export_path: String,
    pub options: HashMap<String, String>,
}

/// Every preset in the project, in file order. A Godot game has no Gradle or Xcode project at
/// rest — those are export OUTPUT — so the presets are the only statement of which phones it can
/// reach and what it is called there. The cfg quotes string values (`platform="iOS"`).
pub fn godot_presets(dir: &Path) -> Vec<GodotPreset> {
    let Ok(raw) = std::fs::read_to_string(dir.join("export_presets.cfg")) else {
        return Vec::new();
    };
    let mut presets: Vec<GodotPreset> = Vec::new();
    let mut in_options = false;
    for line in raw.lines().map(str::trim) {
        if let Some(section) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            in_options = section.ends_with(".options");
            if section.starts_with("preset.") && !in_options {
                presets.push(GodotPreset {
                    name: String::new(),
                    platform: String::new(),
                    export_path: String::new(),
                    options: HashMap::new(),
                });
            }
            continue;
        }
        let (Some(preset), Some((key, value))) = (presets.last_mut(), line.split_once('=')) else {
            continue;
        };
        let (key, value) = (key.trim(), value.trim().trim_matches('"'));
        if in_options {
            preset.options.insert(key.to_string(), value.to_string());
        } else if key == "name" {
            preset.name = value.to_string();
        } else if key == "platform" {
            preset.platform = value.to_string();
        } else if key == "export_path" {
            preset.export_path = value.to_string();
        }
    }
    presets
}

/// The preset a run on this platform builds from, or why there isn't one. Android needs a preset
/// that exports an APK: the release preset is an AAB for Play, and an AAB cannot be installed on a
/// device. iOS takes the first preset; both are export-the-project-only there.
fn godot_run_preset(dir: &Path, platform: &str) -> Result<GodotPreset, String> {
    let installable = |preset: &GodotPreset| {
        platform != "Android"
            || preset.options.get("gradle_build/use_gradle_build").map(String::as_str) != Some("true")
            || preset.options.get("gradle_build/export_format").map(String::as_str) == Some("0")
    };
    godot_presets(dir)
        .into_iter()
        .find(|preset| preset.platform == platform && installable(preset))
        .ok_or_else(|| {
            if platform == "Android" {
                "no Android preset that exports an APK — add an 'Android Debug' preset with \
                 gradle_build/export_format=0 (the release preset builds an AAB, which a device \
                 cannot install)"
                    .to_string()
            } else {
                format!("no {platform} export preset in export_presets.cfg")
            }
        })
}

/// Godot names the exported project after the preset's export path: `build/ios/Game.ipa` makes
/// `Game.xcodeproj`. The run reuses that name so the output reads like the project's own.
fn export_stem(preset: &GodotPreset) -> String {
    Path::new(&preset.export_path)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.is_empty() && !stem.contains(['"', '\'', '$', ' ']))
        .unwrap_or("game")
        .to_string()
}

/// Build a debug APK from the project's APK preset, install it on `serial`, launch it and follow
/// its log. The Android build template is installed on first use (`--install-android-build-template`
/// is only valid beside an export, and is skipped once `android/build` exists). A copy signed with
/// another key — the store build — cannot be replaced in place, and that failure says so.
fn godot_android_script(root: &Path, dir: &Path, serial: &str) -> Result<String, String> {
    let preset = godot_run_preset(dir, "Android")?;
    let package = preset
        .options
        .get("package/unique_name")
        .cloned()
        .filter(|id| id.contains('.') && !id.contains('$'))
        .or_else(|| android::application_id(root))
        .ok_or_else(|| "the Android preset has no package/unique_name".to_string())?;
    let adb = shell_quote(&android::adb().to_string_lossy());
    let serial = shell_quote(serial);
    let package = shell_quote(&package);
    let preset_name = shell_quote(&preset.name);
    let stem = export_stem(&preset);
    // Only a Gradle export needs the build template. A project on the prebuilt APK templates would
    // otherwise get 200 MB of Gradle project it never asked for.
    let template_check = if preset.options.get("gradle_build/use_gradle_build").map(String::as_str) == Some("true") {
        "[ -d android/build ] || TEMPLATE=\"--install-android-build-template\"\n"
    } else {
        ""
    };
    Ok(format!(
        r#"set -e
{GODOT_LOCATE}ADB={adb}
SERIAL={serial}
PACKAGE={package}
APK="build/panel/android/{stem}.apk"
mkdir -p build/panel/android
TEMPLATE=""
{template_check}echo ">> building Android debug APK"
"$GODOT" --headless --path . $TEMPLATE --export-debug {preset_name} "$APK"
[ -f "$APK" ] || {{ echo "error: Godot produced no APK at $APK" >&2; exit 2; }}
echo ">> installing on $SERIAL"
if ! OUT=$("$ADB" -s "$SERIAL" install -r "$APK" 2>&1); then
  echo "$OUT"
  case "$OUT" in
    *UPDATE_INCOMPATIBLE*) echo "error: $PACKAGE on this device is signed with another key (the store build). Uninstall it: adb -s $SERIAL uninstall $PACKAGE" >&2 ;;
    *) echo "error: install failed" >&2 ;;
  esac
  exit 2
fi
"$ADB" -s "$SERIAL" shell am force-stop "$PACKAGE"
COMPONENT=$("$ADB" -s "$SERIAL" shell cmd package resolve-activity --brief "$PACKAGE" 2>/dev/null | tr -d '\r' | tail -1)
case "$COMPONENT" in */*) ;; *) echo "error: no launcher activity found for $PACKAGE" >&2; exit 2 ;; esac
echo ">> launching $COMPONENT"
"$ADB" -s "$SERIAL" shell am start -n "$COMPONENT"
PID=""
for _ in 1 2 3 4 5; do
  PID=$("$ADB" -s "$SERIAL" shell pidof -s "$PACKAGE" | tr -d '\r')
  [ -n "$PID" ] && break
  sleep 1
done
[ -n "$PID" ] || {{ echo "error: $PACKAGE stopped during launch" >&2; exit 2; }}
exec "$ADB" -s "$SERIAL" logcat --pid="$PID""#
    ))
}

/// Export the Xcode project Godot writes for iOS, build it for one simulator without signing,
/// install it and launch with a live console. Godot's iOS preset is export-project-only, so the
/// build is xcodebuild's; the derived data stays between runs so the second build is incremental.
fn godot_ios_script(dir: &Path, udid: &str) -> Result<String, String> {
    let preset = godot_run_preset(dir, "iOS")?;
    let preset_name = shell_quote(&preset.name);
    let stem = export_stem(&preset);
    let udid = shell_quote(udid);
    Ok(format!(
        r#"set -e
{GODOT_LOCATE}UDID={udid}
OUT=build/panel/ios
mkdir -p "$OUT"
echo ">> building iOS project"
"$GODOT" --headless --path . --export-debug {preset_name} "$OUT/{stem}.ipa"
PROJ=$(ls -d "$OUT"/*.xcodeproj 2>/dev/null | head -1)
[ -n "$PROJ" ] || {{ echo "error: Godot wrote no Xcode project in $OUT" >&2; exit 2; }}
SCHEME=$(basename "$PROJ" .xcodeproj)
echo ">> building $SCHEME for the simulator"
xcodebuild -project "$PROJ" -scheme "$SCHEME" -configuration Debug -destination "id=$UDID" -derivedDataPath "$OUT/dd" CODE_SIGNING_ALLOWED=NO build
APP="$OUT/dd/Build/Products/Debug-iphonesimulator/$SCHEME.app"
[ -d "$APP" ] || APP=$(find "$OUT/dd/Build/Products/Debug-iphonesimulator" -maxdepth 1 -name '*.app' ! -name '*-Runner.app' | head -1)
[ -n "$APP" ] || {{ echo "error: the simulator build produced no .app" >&2; exit 2; }}
echo ">> installing $APP"
xcrun simctl install "$UDID" "$APP"
BID=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Info.plist")
xcrun simctl terminate "$UDID" "$BID" >/dev/null 2>&1 || true
echo ">> launching $BID"
exec xcrun simctl launch --console-pty "$UDID" "$BID""#
    ))
}

/// Start an Electron app in its own window. The project's own `make run` is the declaration when
/// it has one — that is where a repo says which of its scripts opens the shell — and `npm start`,
/// Electron's convention, otherwise. Dependencies are installed first on a fresh clone.
fn electron_script(dir: &Path) -> String {
    let makefile = std::fs::read_to_string(dir.join("Makefile")).unwrap_or_default();
    let start = if makefile.lines().any(|line| line.starts_with("run:")) {
        "exec make run"
    } else {
        "exec npm start"
    };
    format!(
        r#"set -e
if [ ! -f node_modules/.package-lock.json ]; then
  echo ">> building: npm install"
  npm install
fi
echo ">> launching Electron"
{start}"#
    )
}

/// Best-effort native run: regenerate/integrate the project when configured, resolve its app
/// scheme, build for the sim, install, and launch with a live console.
/// The part every Xcode path shares: regenerate when configured, find the container, resolve the
/// scheme. Extracted because three scripts need it verbatim — run, run-on-Mac, and debug — and
/// three hand-kept copies of a scheme resolver is three places for it to drift.
fn xcode_preamble(xcodegen: bool) -> String {
    let generate = if xcodegen {
        r#"echo ">> generating Xcode project"
command -v xcodegen >/dev/null || { echo "error: this project requires XcodeGen, but xcodegen is not installed" >&2; exit 127; }
xcodegen generate
if [ -f Podfile ]; then
  echo ">> integrating CocoaPods"
  command -v pod >/dev/null || { echo "error: this project requires CocoaPods, but pod is not installed" >&2; exit 127; }
  pod install --silent
fi
"#
    } else {
        ""
    };
    format!(
        r#"set -e
{generate}CONTAINER=$(ls -d *.xcworkspace 2>/dev/null | head -1)
if [ -n "$CONTAINER" ]; then FLAG=(-workspace "$CONTAINER"); else CONTAINER=$(ls -d *.xcodeproj 2>/dev/null | head -1); FLAG=(-project "$CONTAINER"); fi
if [ -z "$CONTAINER" ]; then echo "error: no .xcworkspace or .xcodeproj found after generation" >&2; exit 2; fi
APP_NAME=$(basename "$CONTAINER"); APP_NAME=${{APP_NAME%.xcworkspace}}; APP_NAME=${{APP_NAME%.xcodeproj}}
SCHEME=$(xcodebuild "${{FLAG[@]}}" -list -json | python3 -c 'import sys,json;d=json.load(sys.stdin);n=sys.argv[1];s=((d.get("workspace") or d.get("project")) or {{}}).get("schemes",[]);print(n if n in s else (s[0] if s else ""))' "$APP_NAME")
if [ -z "$SCHEME" ]; then echo "error: no shared Xcode scheme found in $CONTAINER" >&2; exit 2; fi
"#
    )
}

/// Build, install, and launch the app SUSPENDED, waiting for a debugger.
///
/// `simctl launch --wait-for-debugger` is the whole trick: the app starts and stops before
/// `main`, so lldb can attach in time to catch a breakpoint in startup code. It prints
/// `<bundle id>: <pid>`, and the pid is the only thing the caller needs — that goes into the DAP
/// `attach` request. Everything before that line is build noise the debug console keeps.
pub fn native_debug_script(udid: &str, xcodegen: bool) -> String {
    let preamble = xcode_preamble(xcodegen);
    format!(
        r#"{preamble}DD=build/panel-debug-dd
echo ">> building $SCHEME"
xcodebuild "${{FLAG[@]}}" -scheme "$SCHEME" -configuration Debug -destination "id={udid}" -derivedDataPath "$DD" build
APP="$DD/Build/Products/Debug-iphonesimulator/$SCHEME.app"
[ -d "$APP" ] || APP=$(find "$DD/Build/Products/Debug-iphonesimulator" -maxdepth 1 -name '*.app' ! -name '*-Runner.app' | head -1)
if [ -z "$APP" ]; then echo "error: the simulator build produced no .app" >&2; exit 2; fi
echo ">> installing $APP"
xcrun simctl install {udid} "$APP"
BID=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Info.plist")
xcrun simctl terminate {udid} "$BID" >/dev/null 2>&1 || true
echo ">> launching $BID suspended"
LAUNCH=$(xcrun simctl launch --wait-for-debugger {udid} "$BID")
echo "PANEL_DEBUG_PID=${{LAUNCH##*: }}"
echo "PANEL_DEBUG_APP=$APP""#
    )
}

fn native_script(udid: &str, xcodegen: bool) -> String {
    let preamble = xcode_preamble(xcodegen);
    format!(
        r#"{preamble}DD=build/panel-sim-dd
echo ">> building $SCHEME"
xcodebuild "${{FLAG[@]}}" -scheme "$SCHEME" -configuration Debug -destination "id={udid}" -derivedDataPath "$DD" build
APP="$DD/Build/Products/Debug-iphonesimulator/$SCHEME.app"
[ -d "$APP" ] || APP=$(find "$DD/Build/Products/Debug-iphonesimulator" -maxdepth 1 -name '*.app' ! -name '*-Runner.app' | head -1)
echo ">> installing $APP"
xcrun simctl install {udid} "$APP"
BID=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Info.plist")
echo ">> launching $BID"
exec xcrun simctl launch --console-pty {udid} "$BID""#
    )
}

/// Device builds use the project's signing settings and CoreDevice's attached console.
fn native_device_script(udid: &str, xcodegen: bool) -> String {
    let preamble = xcode_preamble(xcodegen);
    let device = shell_quote(udid);
    format!(
        r#"{preamble}DEVICE={device}
DD="build/panel-device-$DEVICE-dd"
echo ">> building $SCHEME for device"
xcodebuild "${{FLAG[@]}}" -scheme "$SCHEME" -configuration Debug -sdk iphoneos -destination "id=$DEVICE" -derivedDataPath "$DD" build
APP="$DD/Build/Products/Debug-iphoneos/$SCHEME.app"
[ -d "$APP" ] || APP=$(find "$DD/Build/Products/Debug-iphoneos" -maxdepth 1 -name '*.app' ! -name '*-Runner.app' | head -1)
if [ -z "$APP" ]; then echo "error: the device build produced no .app" >&2; exit 2; fi
echo ">> installing $APP"
xcrun devicectl device install app --device "$DEVICE" "$APP"
BID=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Info.plist")
echo ">> starting $BID on device"
exec xcrun devicectl device process launch --device "$DEVICE" --terminate-existing --console "$BID""#
    )
}

/// The same build, aimed at the Mac. It diverges from the simulator path at the end and only
/// there: there is nothing to install, so the pane execs the binary inside the bundle directly.
/// `open -a` would hand the process to launchd and leave this pane watching an empty PTY, which
/// costs the run its console and its stop button.
fn native_mac_script(xcodegen: bool) -> String {
    let preamble = xcode_preamble(xcodegen);
    format!(
        r#"{preamble}DD=build/panel-mac-dd
echo ">> building $SCHEME"
xcodebuild "${{FLAG[@]}}" -scheme "$SCHEME" -configuration Debug -destination "platform=macOS" -derivedDataPath "$DD" build
APP="$DD/Build/Products/Debug/$SCHEME.app"
[ -d "$APP" ] || APP=$(find "$DD/Build/Products/Debug" -maxdepth 1 -name '*.app' ! -name '*-Runner.app' | head -1)
if [ -z "$APP" ]; then echo "error: the macOS build produced no .app" >&2; exit 2; fi
BIN=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")
echo ">> launching $APP"
exec "$APP/Contents/MacOS/$BIN""#
    )
}

// ------------------------------------------------------------------ status from stdout

/// Turn a chunk of PTY output into a lifecycle state, if it carries one. Best-effort and tolerant
/// of ANSI noise — this drives a status pulse, not control flow. Returns the LAST state seen in the
/// chunk plus the reload/restart duration in ms when the line reports one.
pub fn parse_status(chunk: &str) -> Option<(&'static str, Option<u64>)> {
    let mut latest = None;
    for raw in chunk.lines() {
        let line = raw.trim();
        if line.contains("Reloaded ") && line.contains("librar") {
            latest = Some(("reloaded", parse_ms(line)));
        } else if line.contains("Restarted application") {
            latest = Some(("restarted", parse_ms(line)));
        } else if line.contains("Flutter run key commands")
            || line.contains("Dart VM Service on")
            || line.contains("Syncing files to device")
            || line.contains(">> launching")
            || line.contains("Launched application with ")
            // Godot's own banner: the window is up by the time the driver line prints.
            || line.contains("Vulkan API ")
            || line.contains("OpenGL API ")
            || line.contains("Metal - Forward")
            // A dev server is up when it says where it is listening. Matched on the URL rather
            // than on a framework's wording — vite, next, nuxt, astro and a bare node server all
            // print a localhost URL, and none of them agree on anything else.
            || line.contains("http://localhost:")
            || line.contains("http://127.0.0.1:")
            || line.contains("Listening on ")
        {
            latest = Some(("running", None));
        } else if line.contains("Launching lib/")
            || line.contains(">> building")
            || line.starts_with("Godot Engine v")
            // Android's build and install are Gradle's, and they are the slow half of the run.
            // Without these the card sits blank through a two-minute assembleDebug and only wakes
            // up when Dart finally speaks.
            || line.contains("Running Gradle task")
            || line.contains("Installing build/app/outputs/")
        {
            latest = Some(("launching", None));
        } else if line.contains("Lost connection to device")
            || line.contains("Failed to build")
            || line.contains("BUILD FAILED")
            || line.contains("xcodebuild: error:")
            // Gradle's own failure banner. `flutter run` prints it and then exits, so without
            // this the run reads as "launching" right up until the PTY closes.
            || line.contains("FAILURE: Build failed with an exception")
            || line.contains("Error: ADB exited with exit code")
            || line.contains("Error connecting to the service protocol")
            // A GDScript that will not parse means the game did not start. A runtime SCRIPT ERROR
            // deliberately does NOT count: Godot keeps running, and a red card would be a lie.
            || line.starts_with("Parse Error:")
            || line.starts_with("error:")
        {
            latest = Some(("error", None));
        }
    }
    latest
}

fn parse_ms(line: &str) -> Option<u64> {
    // "...in 374ms (compile: ...)" / "...in 817ms."
    line.split(" in ")
        .nth(1)
        .and_then(|tail| tail.split("ms").next())
        .and_then(|num| num.trim().parse::<u64>().ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_real_flutter_lifecycle_lines() {
        assert_eq!(
            parse_status("Launching lib/main.dart on iPhone 17 Pro..."),
            Some(("launching", None))
        );
        assert_eq!(
            parse_status("Flutter run key commands."),
            Some(("running", None))
        );
        assert_eq!(
            parse_status(
                "Reloaded 27 of 2416 libraries in 374ms (compile: 133 ms, reload: 117 ms)."
            ),
            Some(("reloaded", Some(374)))
        );
        assert_eq!(
            parse_status("Restarted application in 817ms."),
            Some(("restarted", Some(817)))
        );
        assert_eq!(
            parse_status("Lost connection to device."),
            Some(("error", None))
        );
        assert_eq!(parse_status("just some ordinary log output"), None);
    }

    #[test]
    fn reads_real_android_lifecycle_lines() {
        // Gradle owns the slow half of an Android run, and it narrates in its own words.
        assert_eq!(
            parse_status("Running Gradle task 'assembleDebug'..."),
            Some(("launching", None))
        );
        assert_eq!(
            parse_status("Installing build/app/outputs/flutter-apk/app-debug.apk..."),
            Some(("launching", None))
        );
        assert_eq!(
            parse_status("FAILURE: Build failed with an exception."),
            Some(("error", None))
        );
        // Past the build it is ordinary Flutter again — one lifecycle, two toolchains.
        assert_eq!(
            parse_status("Syncing files to device sdk gphone64 arm64..."),
            Some(("running", None))
        );
    }

    #[test]
    fn reads_real_godot_lifecycle_lines() {
        assert_eq!(
            parse_status("Godot Engine v4.7.stable.official - https://godotengine.org"),
            Some(("launching", None))
        );
        assert_eq!(
            parse_status(
                "Vulkan API 1.2.290 - Forward+ - Using Vulkan Device #0: Apple - Apple M1"
            ),
            Some(("running", None))
        );
        // A runtime script error must NOT read as a dead run — Godot keeps going.
        assert_eq!(
            parse_status("SCRIPT ERROR: Invalid get index 'x' on base: 'Nil'"),
            None
        );
        assert_eq!(
            parse_status("Parse Error: Identifier \"foo\" not declared."),
            Some(("error", None))
        );
    }

    #[test]
    fn an_electron_app_runs_its_own_make_target_on_the_desktop() {
        let root = std::env::temp_dir().join(format!("panel-sim-electron-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("appgea.json"), r#"{"appType":"electron"}"#).unwrap();
        std::fs::write(root.join("package.json"), "{}").unwrap();
        std::fs::write(root.join("Makefile"), "run:\n\tnpm run play\n").unwrap();

        assert_eq!(kind_of(&root), Some("electron"));
        assert!(plan(&root, "", "iphone").is_err());
        let run = plan(&root, "", "desktop").unwrap();
        assert_eq!(run.kind, "electron");
        let script = &run.args[1];
        assert!(script.contains("exec make run"), "{script}");
        assert!(!script.contains("simctl"), "{script}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_godot_project_runs_without_a_simulator() {
        let root = std::env::temp_dir().join(format!("panel-sim-godot-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("project.godot"), "config/name=\"Game\"\n").unwrap();

        assert_eq!(kind_of(&root), Some("godot"));

        let run = plan(&root, "", "desktop").unwrap();
        assert_eq!(run.kind, "godot");
        assert_eq!(run.cwd, root);
        let script = &run.args[1];
        assert!(script.contains("--path ."), "{script}");
        assert!(script.contains("GODOT_BIN"), "{script}");
        // Nothing in the plan may reach for a simulator.
        assert!(!script.contains("simctl"), "{script}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A phone-ready Godot project: a release AAB preset for Play, a debug APK preset, and iOS.
    fn godot_phone_project(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("panel-godot-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("project.godot"), "config/name=\"Game\"\n").unwrap();
        std::fs::write(
            root.join("export_presets.cfg"),
            r#"[preset.0]

name="iOS"
platform="iOS"
export_path="build/ios/Game.ipa"

[preset.0.options]

application/bundle_identifier="com.example.game"

[preset.1]

name="Android"
platform="Android"
export_path="build/android/Game.aab"

[preset.1.options]

gradle_build/use_gradle_build=true
gradle_build/export_format=1
package/unique_name="com.example.game"

[preset.2]

name="Android Debug"
platform="Android"
export_path="build/android/Game-debug.apk"

[preset.2.options]

gradle_build/use_gradle_build=true
gradle_build/export_format=0
package/unique_name="com.example.game"
"#,
        )
        .unwrap();
        root
    }

    #[test]
    fn a_godot_project_can_ask_to_open_on_the_desktop_as_a_phone() {
        let root = godot_phone_project("args");
        std::fs::write(
            root.join("appgea.json"),
            r#"{"appType":"godot","godot":{"runArgs":["--phone"]}}"#,
        )
        .unwrap();
        let script = plan(&root, "desktop", "desktop").unwrap().args[1].clone();
        assert!(script.contains("exec \"$GODOT\" --path . -- '--phone'"), "{script}");

        // No declaration, no arguments: the bare engine, as every other Godot project runs.
        std::fs::remove_file(root.join("appgea.json")).unwrap();
        let script = plan(&root, "desktop", "desktop").unwrap().args[1].clone();
        assert!(script.ends_with("--path ."), "{script}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_godot_android_run_builds_the_apk_preset_not_the_release_bundle() {
        let root = godot_phone_project("android");
        let script = plan(&root, "emulator-5554", "android").unwrap().args[1].clone();
        assert!(script.contains("--export-debug 'Android Debug'"), "{script}");
        assert!(script.contains("build/panel/android/Game-debug.apk"), "{script}");
        assert!(script.contains("'com.example.game'"), "{script}");
        assert!(script.contains("'emulator-5554'"), "{script}");
        assert!(!script.contains("Game.aab"), "{script}");
        // Launched by resolved component: `monkey` silently does nothing for a Godot activity.
        assert!(script.contains("am start -n"), "{script}");
        assert!(!script.contains("monkey"), "{script}");
        // The project exports through Gradle, so the build template is installed when missing.
        assert!(script.contains("--install-android-build-template"), "{script}");

        // On the prebuilt APK templates there is no Gradle project to install.
        let cfg = std::fs::read_to_string(root.join("export_presets.cfg")).unwrap();
        let (release, debug) = cfg.split_once("[preset.2]").unwrap();
        let debug = debug.replace("use_gradle_build=true", "use_gradle_build=false");
        std::fs::write(root.join("export_presets.cfg"), format!("{release}[preset.2]{debug}")).unwrap();
        let script = plan(&root, "emulator-5554", "android").unwrap().args[1].clone();
        assert!(!script.contains("--install-android-build-template"), "{script}");
        assert!(script.contains("--export-debug 'Android Debug'"), "{script}");
        std::fs::write(root.join("export_presets.cfg"), cfg).unwrap();

        // Only a release AAB preset: nothing installable, and the error says how to fix it.
        let cfg = std::fs::read_to_string(root.join("export_presets.cfg")).unwrap();
        let aab_only = cfg.split("[preset.2]").next().unwrap();
        std::fs::write(root.join("export_presets.cfg"), aab_only).unwrap();
        let error = plan(&root, "emulator-5554", "android").err().unwrap();
        assert!(error.contains("APK"), "{error}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_godot_ios_run_builds_for_the_simulator_it_was_given() {
        let root = godot_phone_project("ios");
        let script = plan(&root, "UDID-1", "iphone").unwrap().args[1].clone();
        assert!(script.contains("--export-debug 'iOS'"), "{script}");
        assert!(script.contains("-destination \"id=$UDID\""), "{script}");
        assert!(script.contains("UDID='UDID-1'"), "{script}");
        assert!(script.contains("CODE_SIGNING_ALLOWED=NO"), "{script}");
        assert!(plan(&root, "", "chrome").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_godot_project_offers_the_phones_its_presets_export_to() {
        let root = godot_phone_project("families");
        let presets = godot_presets(&root);
        let platforms: Vec<&str> = presets.iter().map(|p| p.platform.as_str()).collect();
        assert_eq!(platforms, ["iOS", "Android", "Android"]);
        assert_eq!(presets[2].name, "Android Debug");
        assert_eq!(presets[2].options["gradle_build/export_format"], "0");
        let families = crate::targets::families_for(&root, "godot");
        assert_eq!(families[0], "desktop");
        assert!(families.contains(&"iphone") && families.contains(&"ipad"), "{families:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn shared_runner_rereads_an_electron_launcher_added_while_panel_is_open() {
        // Its own folder: the Electron plan test runs in parallel and owns `panel-sim-electron-`.
        let root = std::env::temp_dir().join(format!("panel-sim-electron-runner-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        assert_eq!(kind_of(&root), None);

        // A stand-in for the human's own runner, answering `kind` from what is on disk.
        let runner = root.with_extension("runner.sh");
        std::fs::write(
            &runner,
            "#!/bin/sh\nif grep -q '\"electron ' package.json 2>/dev/null; then echo electron\n\
             elif [ -f Makefile ]; then echo make\nelif [ -f package.json ]; then echo node\n\
             else echo unknown; fi\n",
        )
        .unwrap();
        std::fs::set_permissions(&runner, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
        TEST_RUNNER.with(|slot| *slot.borrow_mut() = Some(runner.clone()));
        assert_eq!(kind_of(&root), None);

        // Undeclared on purpose. An appgea.json saying `electron` is Panel's own run now, and the
        // runner only answers for what no built-in kind claims.
        std::fs::write(
            root.join("package.json"),
            r#"{"scripts":{"dev":"vite","play":"electron ."}}"#,
        )
        .unwrap();
        assert_eq!(dev_runner_kind(&root).as_deref(), Some("electron"));
        let run = plan(&root, "desktop", "desktop").unwrap();
        assert_eq!(run.kind, "ag");
        assert_eq!(run.cwd, root);
        assert!(run.args[1].contains(&*runner.to_string_lossy()));
        assert!(plan(&root, "macos", "macos").is_err());

        std::fs::write(root.join("package.json"), r#"{"scripts":{"dev":"vite"}}"#).unwrap();
        assert_eq!(dev_runner_kind(&root).as_deref(), Some("node"));
        std::fs::write(root.join("Makefile"), "run:\n\techo desktop\n").unwrap();
        assert_eq!(dev_runner_kind(&root).as_deref(), Some("make"));
        std::fs::remove_file(root.join("Makefile")).unwrap();
        std::fs::remove_file(root.join("package.json")).unwrap();
        assert_eq!(kind_of(&root), None);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_file(&runner);
    }

    #[test]
    fn the_last_state_in_a_multiline_chunk_wins() {
        let chunk = "Launching lib/main.dart...\nSyncing files to device...\nReloaded 3 of 700 libraries in 42ms.";
        assert_eq!(parse_status(chunk), Some(("reloaded", Some(42))));
    }

    #[test]
    fn ios_runtime_key_parses_to_a_version() {
        assert_eq!(
            ios_version("com.apple.CoreSimulator.SimRuntime.iOS-18-4"),
            (18, 4)
        );
        assert_eq!(
            ios_version("com.apple.CoreSimulator.SimRuntime.iOS-26-1"),
            (26, 1)
        );
    }

    #[test]
    fn a_bundle_id_is_matched_whole_in_either_plist_format() {
        // XML, as an un-built or hand-written bundle carries it.
        let xml = b"<dict><key>CFBundleIdentifier</key><string>com.appgea.tavla</string></dict>";
        assert!(mentions_bundle(xml, "com.appgea.tavla"));

        // Binary, exactly as a built app carries it — verified against a real installed Info.plist:
        // keys in one table, values in another, and a 15+ character string prefixed 0x5F 0x10 <len>.
        // The next object's marker follows immediately and may be an identifier character ('V').
        let binary = b"bplist00\xd1\x01\x02\x52CFBundleIdentifier\x5cCFBundleName\
\x5f\x10\x10com.appgea.tavla\x56Runner";
        assert!(mentions_bundle(binary, "com.appgea.tavla"));
        // A shorter id is one marker byte, 0x50 | length.
        assert!(mentions_bundle(b"\x5ecom.appgea.abc\x56", "com.appgea.abc"));
        // The length is what makes it exact: a longer id sharing our prefix cannot claim our length.
        assert!(!mentions_bundle(
            b"\x5f\x10\x14com.appgea.tavlaskor\x56",
            "com.appgea.tavla"
        ));

        // The near misses this exists to reject.
        assert!(!mentions_bundle(
            b"com.appgea.tavlaskor",
            "com.appgea.tavla"
        ));
        assert!(!mentions_bundle(
            b"group.com.appgea.tavla",
            "com.appgea.tavla"
        ));
        assert!(!mentions_bundle(
            b"com.appgea.tavla.watchkitapp",
            "com.appgea.tavla"
        ));
        assert!(!mentions_bundle(b"com.appgea.memor", "com.appgea.tavla"));
        assert!(!mentions_bundle(b"com.appgea.tavla", ""));
    }

    #[test]
    fn a_projects_bundle_id_comes_from_its_manifest_then_its_xcode_project() {
        let root = std::env::temp_dir().join(format!("panel-sim-bundle-{}", std::process::id()));
        let ios = root.join("ios/Runner.xcodeproj");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&ios).unwrap();
        // The test target is listed first on purpose: it is the one that must NOT win.
        std::fs::write(
            ios.join("project.pbxproj"),
            "PRODUCT_BUNDLE_IDENTIFIER = com.appgea.memor.RunnerTests;\n\
             PRODUCT_BUNDLE_IDENTIFIER = com.appgea.memor;\n",
        )
        .unwrap();
        assert_eq!(bundle_id(&root).as_deref(), Some("com.appgea.memor"));

        // A manifest states it outright, and outranks the sniff.
        std::fs::write(
            root.join("appgea.json"),
            r#"{"iosBundleId":"com.appgea.stated"}"#,
        )
        .unwrap();
        assert_eq!(bundle_id(&root).as_deref(), Some("com.appgea.stated"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_app_is_found_on_the_device_it_is_installed_on() {
        // The real container layout, under a fake HOME: Devices/<udid>/data/Containers/Bundle/...
        let home = std::env::temp_dir().join(format!("panel-sim-home-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let device = home
            .join(
                "Library/Developer/CoreSimulator/Devices/UDID-A/data/Containers/Bundle/Application",
            )
            .join("11111111-2222-3333-4444-555555555555/Runner.app");
        std::fs::create_dir_all(&device).unwrap();
        std::fs::write(
            device.join("Info.plist"),
            "<dict><key>CFBundleIdentifier</key><string>com.appgea.tavla</string></dict>",
        )
        .unwrap();
        // SAFETY: single-threaded test process; HOME is restored below.
        let previous = std::env::var("HOME").unwrap_or_default();
        unsafe { std::env::set_var("HOME", &home) };

        assert_eq!(installed_apps("UDID-A").len(), 1);
        assert!(installed_apps("UDID-B").is_empty());
        assert!(app_installed_at("UDID-A", "com.appgea.tavla").is_some());
        assert!(app_installed_at("UDID-A", "com.appgea.memor").is_none());

        let devices = vec![
            SimDevice {
                udid: "UDID-B".into(),
                name: "iPhone Clean".into(),
                runtime: "iOS 26.0".into(),
                booted: false,
            },
            SimDevice {
                udid: "UDID-A".into(),
                name: "iPhone Tavla".into(),
                runtime: "iOS 26.0".into(),
                booted: false,
            },
        ];
        assert_eq!(
            devices_with_app(&devices, "com.appgea.tavla")
                .into_iter()
                .map(|device| device.udid)
                .collect::<Vec<_>>(),
            vec!["UDID-A".to_string()]
        );
        // A near-miss bundle id is a different app, not this one.
        assert!(devices_with_app(&devices, "com.appgea.tav").is_empty());

        unsafe { std::env::set_var("HOME", previous) };
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn native_xcodegen_plan_generates_before_inspecting_the_project() {
        let script = native_script("SIMULATOR-ID", true);
        let generate = script.find("xcodegen generate").unwrap();
        let pods = script.find("pod install --silent").unwrap();
        let inspect = script.find("*.xcworkspace").unwrap();
        assert!(generate < inspect);
        assert!(generate < pods && pods < inspect);
        assert!(script.contains("destination \"id=SIMULATOR-ID\""));
    }

    #[test]
    fn native_plain_xcode_plan_does_not_require_xcodegen() {
        let script = native_script("SIMULATOR-ID", false);
        assert!(!script.contains("xcodegen generate"));
        assert!(script.contains("no .xcworkspace or .xcodeproj found"));
    }

    #[test]
    fn native_run_prefers_the_container_named_scheme() {
        let script = native_script("device-1", false);
        assert!(script.contains("n if n in s else"));
        assert!(script.contains("APP_NAME=${APP_NAME%.xcworkspace}"));
    }

    #[test]
    fn standalone_xcodegen_project_is_detected_before_its_xcodeproj_exists() {
        let root =
            std::env::temp_dir().join(format!("panel-xcodegen-detect-{}", std::process::id()));
        let ios = root.join("ios");
        std::fs::create_dir_all(&ios).unwrap();
        std::fs::write(ios.join("project.yml"), "name: Example\n").unwrap();

        let (kind, cwd, xcodegen) = detect(&root).unwrap();
        assert_eq!(kind, "native");
        assert_eq!(cwd, ios);
        assert!(xcodegen);

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn standalone_android_project_gets_a_gradle_run_plan() {
        let root =
            std::env::temp_dir().join(format!("panel-android-detect-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("app")).unwrap();
        std::fs::write(root.join("gradlew"), "#!/bin/sh\n").unwrap();
        std::fs::write(
            root.join("app/build.gradle.kts"),
            "defaultConfig { applicationId = \"com.appgea.clearday\" }",
        )
        .unwrap();

        assert_eq!(kind_of(&root), Some("android"));
        let run = plan(&root, "emulator-5554", "android").unwrap();
        assert_eq!(run.kind, "android");
        assert_eq!(run.cwd, root);
        assert!(run.args[1].contains(":app:assembleDebug"));
        assert!(run.args[1].contains("com.appgea.clearday"));
        assert!(run.args[1].contains("logcat --pid"));

        let _ = std::fs::remove_dir_all(&root);
    }
}

/// The status event the UI's `visual_requested` handler renders as the sim card / pulse.
///
/// `address` rides along because the UI has to know WHICH KIND of device this run landed on —
/// raising a window is right for a simulator or an emulator and wrong for a phone, and a device
/// NAME cannot answer that. It is also the only way a webview that reloaded mid-run learns the
/// address again, having forgotten everything it started.
pub fn status_event(
    project: &str,
    session_id: &str,
    device: &str,
    address: &str,
    kind: &str,
    state: &str,
    ms: Option<u64>,
    terminal_id: &str,
) -> ProjectEvent {
    ProjectEvent {
        project: project.to_string(),
        event: PanelEvent::VisualRequested {
            session_id: session_id.to_string(),
            view: "sim".to_string(),
            title: Some(device.to_string()),
            payload: json!({
                "state": state,
                "device": device,
                "address": address,
                "kind": kind,
                "ms": ms,
                "terminalId": terminal_id,
            }),
        },
    }
}
