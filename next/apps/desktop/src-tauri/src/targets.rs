//! Where an app can run — one list, one address scheme, no platform special cases above this file.
//!
//! Run used to mean "an iOS simulator", so the picker was a list of simulators and everything else
//! was unreachable. A Flutter app also runs in Chrome and on the Mac, and an iPad is not an iPhone
//! with a bigger screen when you are looking at a layout. So the unit here is a **target**, and a
//! simulator is only one kind of one.
//!
//! Every target has an address, and the address is what leases, run plans and the picker all speak:
//!
//!   iphone:<sim-udid>   ipad:<sim-udid>   ios:<phone-udid>   android:@<avd>   android:<serial>
//!   chrome   macos   desktop
//!
//! The family prefix is not decoration. It is how a lease can be asked for by family ("give me any
//! free iPad") without a simctl round trip, and how the picker groups without parsing names.
//!
//! Android is the one family with two address shapes, and `android.rs` explains why: an emulator
//! is its AVD (which survives a port change and exists while the device is off), a phone is its
//! serial. Above this file nothing knows the difference — both are just addresses.
//!
//! What a project can run is derived from the project, not offered blindly: a Flutter app with no
//! `web/` directory does not get a Chrome row, because that row could only ever fail.

use crate::android;
use crate::leases;
use crate::sim;
use serde::Serialize;
use std::collections::{BTreeMap, HashSet};
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    /// The address: family, then the device id when the family has more than one member.
    pub id: String,
    pub family: String,
    pub name: String,
    pub runtime: String,
    pub booted: bool,
    /// The toolchain's device identifier: Apple UDID, Android serial, or desktop family name.
    pub device: String,
    /// Held by somebody right now — who, and for what.
    pub held_by: Option<String>,
    pub held_kind: Option<String>,
    /// This app is installed here. The Run screen calls it "its device" and defaults to it.
    pub owns: bool,
}

/// Families with exactly one member, addressed by the family name alone.
pub const SINGLETON: [&str; 4] = ["chrome", "macos", "windows", "desktop"];

pub fn is_singleton(family: &str) -> bool {
    SINGLETON.contains(&family)
}

pub fn family_of(address: &str) -> String {
    address
        .split_once(':')
        .map(|(family, _)| family.to_string())
        .unwrap_or_else(|| address.to_string())
}

/// Which families this project can be launched on at all.
///
/// EVERY ROW IS READ OUT OF THE PROJECT. Not out of `appgea.json`, and not out of a per-kind
/// assumption: a Flutter app offers iPhone because it has an `ios/` directory, offers the Mac
/// because it has a `macos/` one, and offers neither when it has neither. An Xcode project is
/// asked the same question in its own words — `SDKROOT` / `platform:` — so a Mac-only app stops
/// pretending it has a simulator to run on.
///
/// The manifest still says WHERE the project is (`subpath`, `ios.path`). It does not get to say
/// what the project can do, because the directory beside the `pubspec.yaml` already knows.
///
/// A Godot game is the one exception to reading directories: the engine runs the project in its
/// own window, so `desktop` is always offered. Its phones come out of `export_presets.cfg`, the
/// only place a Godot project says which platforms it exports to. An iOS preset offers the
/// simulators; an Android one offers emulators and phones, when this machine has an SDK.
pub fn families_for(root: &Path, kind: &str) -> Vec<&'static str> {
    let dir = sim::project_dir(root);
    match kind {
        "godot" => {
            let presets = sim::godot_presets(&dir);
            let exports = |platform: &str| presets.iter().any(|p| p.platform == platform);
            let mut families = vec!["desktop"];
            if exports("iOS") && apple_tooling() {
                families.push("iphone");
                families.push("ipad");
            }
            if exports("Android") && android::available() {
                families.push("android");
            }
            families
        }
        "electron" => vec!["desktop"],
        // A dev server runs in exactly one place: the port its manifest pins. There is no choice
        // to offer, and offering one would only let the human pick a port the server will not
        // listen on.
        "server" => vec!["localhost"],
        // Anything the shared runner starts and this file has no opinion about. It
        // runs on the Mac in its own pane, which is what `desktop` already means.
        "ag" => vec!["desktop"],
        "android" => {
            if android::available() {
                vec!["android"]
            } else {
                Vec::new()
            }
        }
        "native" => {
            let platforms = sim::native_platforms(&dir);
            let mut families = Vec::new();
            if !apple_tooling() {
                return families;
            }
            if platforms.contains(&"ios") {
                families.push("iphone");
                families.push("ipad");
                families.push("ios");
            }
            if platforms.contains(&"macos") {
                families.push("macos");
            }
            families
        }
        _ => {
            let mut families = Vec::new();
            // A phone app is a phone app on every OS. Where there is no Xcode, its phone is an
            // Android one, and that family has to LEAD: Auto runs on the first family, and a
            // Windows machine that put Chrome first would open a mobile app in a browser tab.
            let android = dir.join("android").is_dir() && android::available();
            if android && !apple_tooling() {
                families.push("android");
            }
            // A Flutter app without an `ios/` folder has no simulator build to make. It used to
            // get the rows anyway, which is the same mistake the Chrome row was written to avoid.
            if dir.join("ios").is_dir() && apple_tooling() {
                families.push("iphone");
                families.push("ipad");
                families.push("ios");
            }
            if dir.join("web").is_dir() {
                families.push("chrome");
            }
            // A desktop build runs only on its own OS: the Mac row on a Mac, the Windows row on
            // Windows. Offering the other one could only produce a toolchain error.
            if cfg!(target_os = "macos") && dir.join("macos").is_dir() {
                families.push("macos");
            }
            if cfg!(windows) && dir.join("windows").is_dir() {
                families.push("windows");
            }
            // Both halves have to be true: the project must have an Android platform folder, and
            // this machine must have an SDK to talk to. Offering the family without a `adb` only
            // produces an empty group nobody can act on.
            if android && apple_tooling() {
                families.push("android");
            }
            families
        }
    }
}

/// Simulators, `xcodebuild` and `devicectl` exist only on a Mac. Anywhere else the iOS families
/// can only ever be empty groups — and worse, the first family is where Auto goes, so an `ios/`
/// folder on Windows sent every run to a simulator clone that could not happen.
fn apple_tooling() -> bool {
    cfg!(target_os = "macos")
}

/// Every target this project could be launched on right now, in picker order: its own device
/// first, then the rest of its family, then the other families in `families_for` order.
pub fn list_for(root: &Path, kind: &str, owner: &str) -> Vec<Target> {
    let held = leases::held();
    let sims = sim::list_devices();
    let own = sim::own_device(&sims, root).map(|device| device.udid);
    let families = families_for(root, kind);
    // The Android app id is read once for the whole list, not once per device — and only when
    // there is an Android family to answer for, so an iOS-only project pays nothing for it.
    let package = families
        .contains(&"android")
        .then(|| android::application_id(root))
        .flatten();
    let mut out: Vec<Target> = Vec::new();

    for family in families {
        for mut target in members_for(root, family, &sims) {
            target.owns = own.as_deref() == Some(target.device.as_str())
                || (family == "android"
                    && package
                        .as_deref()
                        .is_some_and(|id| owns_android(&target, id)));
            if let Some(lease) = held.get(&target.id) {
                if lease.owner != owner {
                    target.held_by = Some(lease.owner.clone());
                    target.held_kind = Some(lease.kind.clone());
                }
            }
            out.push(target);
        }
    }
    // The app's own device leads its family. Everything else keeps the order its source gave it —
    // simctl is already newest-runtime-first, and re-sorting would throw that away.
    out.sort_by_key(|target| !target.owns);
    out
}

/// One family's targets for one project. Every family but `localhost` is portfolio-wide — a
/// simulator belongs to the machine, not to an app. A port belongs to the project that pinned it,
/// so that one has to be asked project by project.
fn members_for(root: &Path, family: &str, sims: &[sim::SimDevice]) -> Vec<Target> {
    if family == "localhost" {
        return server_target(root).into_iter().collect();
    }
    family_members(family, sims)
}

/// The single target a dev server runs on: `localhost:<port>`, straight out of the manifest.
/// None when the manifest has no server block, which is also why the card never appears for a
/// project that cannot serve anything.
pub fn server_target(root: &Path) -> Option<Target> {
    let spec = sim::server_spec(root)?;
    Some(Target {
        id: format!("localhost:{}", spec.port),
        family: "localhost".to_string(),
        name: format!("localhost:{}", spec.port),
        runtime: "Dev server".to_string(),
        booted: true,
        device: spec.port.to_string(),
        held_by: None,
        held_kind: None,
        owns: false,
    })
}

/// Is this app already installed on this Android device? Only a running device can be asked, so a
/// powered-off AVD is never "its device" — which is the honest answer: nothing can be read off a
/// device that is off, and claiming otherwise would send Auto somewhere on a guess.
fn owns_android(target: &Target, package: &str) -> bool {
    !target.device.is_empty()
        && target.booted
        && android::packages(&target.device).contains(package)
}

fn family_members(family: &str, sims: &[sim::SimDevice]) -> Vec<Target> {
    match family {
        "iphone" | "ipad" => sims
            .iter()
            .filter(|device| sim_family(&device.name) == family)
            .map(|device| Target {
                id: format!("{family}:{}", device.udid),
                family: family.to_string(),
                name: device.name.clone(),
                runtime: device.runtime.clone(),
                booted: device.booted,
                device: device.udid.clone(),
                held_by: None,
                held_kind: None,
                owns: false,
            })
            .collect(),
        "ios" => ios_devices(),
        "android" => android_devices(),
        _ => vec![Target {
            id: family.to_string(),
            family: family.to_string(),
            name: singleton_label(family).to_string(),
            runtime: String::new(),
            booted: true,
            device: family.to_string(),
            held_by: None,
            held_kind: None,
            owns: false,
        }],
    }
}

fn singleton_label(family: &str) -> &'static str {
    match family {
        "chrome" => "Chrome",
        "macos" => "Mac",
        "windows" => "Windows",
        _ => "Desktop",
    }
}

/// iPad or iPhone, off the simulator's name. `sim::list_devices` has already dropped watches and
/// TVs from the runtimes it keeps, so anything left that is not an iPad is a phone.
pub fn sim_family(name: &str) -> &'static str {
    let lower = name.to_ascii_lowercase();
    if lower.contains("ipad") {
        "ipad"
    } else if lower.contains("watch") {
        "watch"
    } else if lower.contains("tv") {
        "tv"
    } else {
        "iphone"
    }
}

/// Booted simulators nobody holds: no run, debug session or capture batch has a lease on them.
/// Usually a device an agent booted for a screenshot or a test and never shut down. Each holds
/// one to five gigabytes, so the cap counts them and the Run screen offers to shut them down.
///
/// Matched on the udid, not the address. A lease names the device as `iphone:` or `ipad:`, and
/// which of the two is a property of the name, not of the device being in use.
pub fn idle_simulators(
    sims: &[sim::SimDevice],
    held: &BTreeMap<String, leases::Lease>,
) -> Vec<sim::SimDevice> {
    let leased: HashSet<&str> = held
        .keys()
        .filter_map(|address| address.split_once(':').map(|(_, id)| id))
        .collect();
    sims.iter()
        .filter(|device| device.booted && !leased.contains(device.udid.as_str()))
        .cloned()
        .collect()
}

/// Every Android target on this machine — attached phones, running emulators, and the AVDs that
/// are merely defined. A powered-off AVD carries no `device` yet: its serial does not exist until
/// it boots, and `run_on` is what fills that in.
pub fn android_devices() -> Vec<Target> {
    android::list()
        .into_iter()
        .map(|device| Target {
            id: device.address,
            family: "android".to_string(),
            name: device.name,
            runtime: device.runtime,
            booted: device.booted,
            device: device.serial,
            held_by: None,
            held_kind: None,
            owns: false,
        })
        .collect()
}

/// Paired iPhones and iPads reachable over USB or Xcode's wireless connection.
/// Physical devices have their own family, outside simulator boot, wipe and shutdown paths.
pub fn ios_devices() -> Vec<Target> {
    let Ok(output) = crate::platform::command("xcrun")
        .args(["xcdevice", "list", "--timeout", "5"])
        .output()
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    let rows: Vec<serde_json::Value> = serde_json::from_slice(&output.stdout).unwrap_or_default();
    rows.into_iter()
        .filter(|row| {
            row["simulator"].as_bool() == Some(false)
                && row["available"].as_bool() == Some(true)
                && row["platform"].as_str() == Some("com.apple.platform.iphoneos")
        })
        .filter_map(|row| {
            let device = row["identifier"].as_str()?.to_string();
            if device.is_empty() {
                return None;
            }
            Some(Target {
                id: format!("ios:{device}"),
                family: "ios".into(),
                name: row["name"].as_str().unwrap_or("iPhone / iPad").into(),
                runtime: format!("iOS {}", row["operatingSystemVersion"].as_str().unwrap_or("")),
                booted: true,
                device,
                held_by: None,
                held_kind: None,
                owns: false,
            })
        })
        .collect()
}

/// Resolve one address back to a target, or report why it cannot be used. The picker hands back
/// an address the human chose; the device behind it may have been erased or taken since.
///
/// `root` is only consulted for `localhost`, whose port is a property of the project rather than
/// of the machine.
pub fn resolve(root: &Path, address: &str, owner: &str) -> Result<Target, String> {
    let family = family_of(address);
    if family == "localhost" {
        let target = server_target(root)
            .ok_or_else(|| "this project has no server block in appgea.json".to_string())?;
        let held = leases::held();
        if !leases::free_for(&held, &target.id, owner) {
            let lease = &held[&target.id];
            // Port collisions are the whole reason a server holds a lease. Say which app has it,
            // because the fix is to stop that one, not to retry this one.
            return Err(format!(
                "port {} is held by {} ({})",
                target.device, lease.owner, lease.kind
            ));
        }
        return Ok(target);
    }
    if is_singleton(&family) {
        let held = leases::held();
        if !leases::free_for(&held, address, owner) {
            let lease = &held[address];
            return Err(format!("{} is held by {}", lease.name, lease.owner));
        }
        return Ok(Target {
            id: address.to_string(),
            family: family.clone(),
            name: singleton_label(&family).to_string(),
            runtime: String::new(),
            booted: true,
            device: family,
            held_by: None,
            held_kind: None,
            owns: false,
        });
    }
    let sims = sim::list_devices();
    let held = leases::held();
    // Matched on the ADDRESS, not on the device id behind it. A powered-off AVD has no serial to
    // compare against yet — its address is the only thing about it that exists.
    let found = family_members(&family, &sims)
        .into_iter()
        .find(|target| target.id == address)
        .ok_or_else(|| format!("that device is gone: {address}"))?;
    if !leases::free_for(&held, &found.id, owner) {
        let lease = &held[&found.id];
        return Err(format!(
            "{} is held by {} ({})",
            found.name, lease.owner, lease.kind
        ));
    }
    Ok(found)
}

/// The best free target of a family for this owner:
///
/// 1. A free, powered-off, **clean** simulator — one with no third-party apps on it. Nobody's
///    afternoon is on it, so taking it cannot install over somebody's manual test.
/// 2. Any free powered-off device. It may hold another app, but it is idle, and breeding a device
///    per project is worse than sharing one.
/// 3. A free booted device. Last, because taking one costs whoever booted it their session.
///
/// Every step is already filtered by the lease file, so "free" here means genuinely unheld — not
/// merely un-booted, which is what it used to mean and what let a capture batch and a debug run
/// land on the same simulator.
///
/// **Android inverts the order, because the cost is inverted.** Booting an iOS simulator is a few
/// seconds and taking a booted one costs somebody their session, so cold wins there. An Android
/// emulator is minutes of cold boot, and a phone on the desk is not somebody's session at all —
/// so a device that is already up wins, and a powered-off AVD is the fallback.
pub fn free_in_family(family: &str, owner: &str) -> Option<Target> {
    let held = leases::held();
    let sims = sim::list_devices();
    let free: Vec<Target> = family_members(family, &sims)
        .into_iter()
        .filter(|target| leases::free_for(&held, &target.id, owner))
        .collect();
    if family == "android" {
        return free
            .iter()
            .find(|target| target.booted)
            .or_else(|| free.first())
            .cloned();
    }
    let idle: Vec<&Target> = free.iter().filter(|target| !target.booted).collect();
    idle.iter()
        .find(|target| sim::is_clean(&target.device))
        .copied()
        .or_else(|| idle.first().copied())
        .or_else(|| free.first())
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sim(udid: &str, name: &str, booted: bool) -> sim::SimDevice {
        sim::SimDevice {
            udid: udid.into(),
            name: name.into(),
            runtime: "iOS 26.1".into(),
            booted,
        }
    }

    fn lease(kind: &str) -> leases::Lease {
        leases::Lease {
            owner: "Tavla".into(),
            kind: kind.into(),
            pid: 1,
            since: 0,
            family: "iphone".into(),
            name: "iPhone 17".into(),
            booted_by_us: false,
        }
    }

    #[test]
    fn only_a_booted_simulator_nobody_holds_is_idle() {
        let sims = vec![
            sim("RUN", "iPhone 17", true),
            sim("CAPTURE", "iPad Pro", true),
            sim("AGENT", "Koza Showcase", true),
            sim("OFF", "iPhone Air", false),
        ];
        let mut held = BTreeMap::new();
        held.insert("iphone:RUN".to_string(), lease("interactive"));
        // Held under the other family's prefix: still held. The udid is what is in use.
        held.insert("iphone:CAPTURE".to_string(), lease("capture"));
        held.insert("chrome".to_string(), lease("interactive"));
        let idle: Vec<String> = idle_simulators(&sims, &held)
            .into_iter()
            .map(|device| device.udid)
            .collect();
        assert_eq!(idle, vec!["AGENT".to_string()]);
    }
}
