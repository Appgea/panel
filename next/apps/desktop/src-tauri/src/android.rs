//! Android emulators and phones — the other half of Run's device world.
//!
//! This is the Android counterpart of `sim.rs`, and it exists as its own file for the same reason
//! the iOS half does: the questions are the same four (what is there, boot it, give it back, does
//! this app live here) but every answer is a different tool. `targets.rs` composes the two and
//! nothing above it branches on platform.
//!
//! **An emulator is addressed by its AVD, never by its serial.** `emulator-5554` is a PORT — the
//! same virtual device is 5554 this morning and 5556 after you opened another one, so a lease
//! keyed on it guards a device that has moved. The AVD name does not move, exists while the
//! device is powered off (which is exactly when Run most needs to name it), and is what the human
//! sees in Android Studio. Phones keep their serial, because a phone's serial IS its identity.
//!
//!     android:@Small_Phone     the emulator, running or not
//!     android:R5CT30ABCDE      the phone plugged into the USB port
//!
//! `common/lease.py`, next to the Panel checkout, builds the same two addresses, because the two halves
//! share one lease file and an address scheme that disagrees is a broker that does not broker.
//!
//! Nothing here uses a bare `adb`/`emulator` off PATH. Panel is opened from Finder as often as
//! from a shell, and a Finder launch inherits a PATH with no Android SDK in it — which used to
//! make the whole Android family silently empty rather than visibly broken.

use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::thread::sleep;
use std::time::{Duration, Instant};

/// One place an Android build can land. Powered-off AVDs are listed too — Run boots what you
/// pick, and a device picker that only shows what is already running is a picker that makes you
/// go and use another tool first.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidDevice {
    /// `android:@<avd>` for an emulator, `android:<serial>` for a phone.
    pub address: String,
    /// What `flutter -d` wants. Empty while an AVD is powered off — `boot` fills it in.
    pub serial: String,
    /// Empty for a phone.
    pub avd: String,
    pub name: String,
    /// "Android 14" for something running, "API 34" for an AVD that is not.
    pub runtime: String,
    pub booted: bool,
    pub emulator: bool,
}

// ------------------------------------------------------------------ the toolchain

/// The SDK, as the SDK's own variables name it, then where Android Studio puts it.
fn sdk_root() -> PathBuf {
    for key in ["ANDROID_HOME", "ANDROID_SDK_ROOT"] {
        if let Some(value) = std::env::var_os(key) {
            let path = PathBuf::from(value);
            if path.is_dir() {
                return path;
            }
        }
    }
    #[cfg(windows)]
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        return PathBuf::from(local).join("Android").join("Sdk");
    }
    home().join("Library/Android/sdk")
}

/// `HOME` is a shell's variable. Windows sets `USERPROFILE`, and Panel opened from Explorer has
/// no `HOME` at all — which turned every AVD path into a relative one and every name into a guess.
fn home() -> PathBuf {
    ["HOME", "USERPROFILE"]
        .iter()
        .filter_map(std::env::var_os)
        .map(PathBuf::from)
        .find(|path| path.is_dir())
        .unwrap_or_default()
}

/// Where AVDs live: `ANDROID_AVD_HOME`, then `ANDROID_USER_HOME/avd`, then `~/.android/avd` —
/// the emulator's own lookup order, so Panel reads the same config the emulator boots.
fn avd_home() -> PathBuf {
    if let Some(dir) = std::env::var_os("ANDROID_AVD_HOME").map(PathBuf::from) {
        if dir.is_dir() {
            return dir;
        }
    }
    if let Some(dir) = std::env::var_os("ANDROID_USER_HOME").map(|d| PathBuf::from(d).join("avd")) {
        if dir.is_dir() {
            return dir;
        }
    }
    home().join(".android").join("avd")
}

/// The SDK's binary if it is there, else the bare name so a machine with a custom install still
/// works off PATH. Never an error: a machine with no SDK simply has no Android devices, and that
/// is an honest empty list rather than a failure to report.
fn tool(dir: &str, name: &str) -> PathBuf {
    let path = sdk_root().join(dir).join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
    if path.is_file() {
        path
    } else {
        PathBuf::from(name)
    }
}

pub fn adb() -> PathBuf {
    tool("platform-tools", "adb")
}

fn emulator_bin() -> PathBuf {
    tool("emulator", "emulator")
}

/// Is there an SDK to talk to at all? Asked before the family is offered, so a machine without
/// Android tooling gets no Android rows instead of rows that can only fail.
pub fn available() -> bool {
    const TTL: Duration = Duration::from_secs(30);
    static CACHE: OnceLock<Mutex<Option<(Instant, bool)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    if let Some((checked, available)) = *cache.lock().unwrap_or_else(|lock| lock.into_inner()) {
        if checked.elapsed() < TTL {
            return available;
        }
    }
    let available = crate::platform::command(adb())
        .arg("--version")
        .output()
        .is_ok_and(|out| out.status.success());
    *cache.lock().unwrap_or_else(|lock| lock.into_inner()) = Some((Instant::now(), available));
    available
}

/// Run adb and hand back its stdout, or None when the call failed. Every adb call in this file
/// goes through here so a missing SDK is one `None` rather than a panic per call site.
fn adb_out(args: &[&str]) -> Option<String> {
    let out = crate::platform::command(adb()).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// One `getprop`, trimmed. Empty when the device is mid-boot and has not published it yet.
fn getprop(serial: &str, key: &str) -> String {
    adb_out(&["-s", serial, "shell", "getprop", key])
        .unwrap_or_default()
        .trim()
        .to_string()
}

// ------------------------------------------------------------------ inventory

/// Every serial adb can see, with its state and the `model:` adb already knows — so a phone can be
/// named without a round trip. `offline` matters as much as `device` here: a cold emulator sits
/// offline for its first seconds, and a boot watcher that only counted ready devices could not
/// tell "it never started" from "it started and is still waking up".
fn adb_states() -> Vec<(String, String, String)> {
    let Some(text) = adb_out(&["devices", "-l"]) else {
        return Vec::new();
    };
    text.lines()
        .skip(1)
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let serial = parts.next()?.to_string();
            let state = parts.next()?.to_string();
            let model = parts
                .find_map(|field| field.strip_prefix("model:"))
                .unwrap_or_default()
                .replace('_', " ");
            Some((serial, state, model))
        })
        .collect()
}

/// The serials that are actually ready to receive a build. Anything `offline`, `unauthorized` or
/// `bootloader` is left out of the inventory: it cannot be run on, and listing it would only
/// offer a row that fails on click.
fn attached() -> Vec<(String, String)> {
    adb_states()
        .into_iter()
        .filter(|(_, state, _)| state == "device")
        .map(|(serial, _, model)| (serial, model))
        .collect()
}

/// Which AVD a running emulator IS. The console answers `<name>\nOK`; anything else means an
/// emulator too old to ask, and the caller falls back to serial addressing.
fn avd_of(serial: &str) -> Option<String> {
    let text = adb_out(&["-s", serial, "emu", "avd", "name"])?;
    let name = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && *line != "OK")?;
    Some(name.to_string())
}

/// Every AVD defined on this machine, running or not.
fn defined_avds() -> Vec<String> {
    let Ok(out) = crate::platform::command(emulator_bin()).arg("-list-avds").output() else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        // The emulator prints warnings on stdout on some installs; an AVD name has no spaces.
        .filter(|line| !line.is_empty() && !line.contains(' '))
        .map(str::to_string)
        .collect()
}

/// `~/.android/avd/<name>.avd/config.ini`, as key/value pairs. The AVD's display name and its
/// system image both live here, which is the only way to say anything about a device that is off.
fn avd_config(avd: &str) -> Vec<(String, String)> {
    let path = avd_home().join(format!("{avd}.avd")).join("config.ini");
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| (key.trim().to_string(), value.trim().to_string()))
        .collect()
}

fn avd_field(config: &[(String, String)], key: &str) -> Option<String> {
    config
        .iter()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.clone())
        .filter(|value| !value.is_empty())
}

/// What to call an AVD. Its display name if it has one, else the underscored id made readable.
fn avd_label(avd: &str, config: &[(String, String)]) -> String {
    avd_field(config, "avd.ini.displayname").unwrap_or_else(|| avd.replace('_', " "))
}

/// The API level a powered-off AVD would boot into. Deliberately reported as "API 34" rather than
/// guessed at as "Android 14": the API-to-version table drifts, and a running device answers the
/// real question itself through `getprop`.
fn avd_runtime(config: &[(String, String)]) -> String {
    let image = avd_field(config, "image.sysdir.1")
        .or_else(|| avd_field(config, "target"))
        .unwrap_or_default();
    image
        .split(['/', '-'])
        .skip_while(|part| *part != "android")
        .nth(1)
        .map(|api| format!("API {api}"))
        .unwrap_or_else(|| "Android".to_string())
}

/// Everything Run can land an Android build on: the phones and emulators that are up, then the
/// AVDs that are defined but powered off.
pub fn list() -> Vec<AndroidDevice> {
    let mut out: Vec<AndroidDevice> = Vec::new();
    let mut live_avds: HashSet<String> = HashSet::new();

    for (serial, model) in attached() {
        let release = getprop(&serial, "ro.build.version.release");
        let runtime = if release.is_empty() {
            "Android".to_string()
        } else {
            format!("Android {release}")
        };
        let avd = serial
            .starts_with("emulator-")
            .then(|| avd_of(&serial))
            .flatten();
        match avd {
            Some(avd) => {
                let config = avd_config(&avd);
                live_avds.insert(avd.clone());
                out.push(AndroidDevice {
                    address: format!("android:@{avd}"),
                    name: avd_label(&avd, &config),
                    serial,
                    avd,
                    runtime,
                    booted: true,
                    emulator: true,
                });
            }
            // A phone, or an emulator whose console would not name itself. Either way its serial
            // is the only identity available, so that is what it is addressed by.
            None => {
                let emulator = serial.starts_with("emulator-");
                out.push(AndroidDevice {
                    address: format!("android:{serial}"),
                    name: if model.is_empty() {
                        serial.clone()
                    } else {
                        model
                    },
                    serial,
                    avd: String::new(),
                    runtime,
                    booted: true,
                    emulator,
                });
            }
        }
    }

    for avd in defined_avds() {
        if live_avds.contains(&avd) {
            continue;
        }
        let config = avd_config(&avd);
        out.push(AndroidDevice {
            address: format!("android:@{avd}"),
            name: avd_label(&avd, &config),
            serial: String::new(),
            avd,
            runtime: avd_runtime(&config),
            booted: false,
            emulator: true,
        });
    }

    // Running first, and phones ahead of emulators within that — a device you plugged in is a
    // deliberate act, and it should not be under a list of virtual ones.
    out.sort_by_key(|device| (!device.booted, device.emulator));
    out
}

/// The AVD an address names, if it names one. `android:@Small_Phone` -> `Small_Phone`.
pub fn avd_in(address: &str) -> Option<String> {
    address
        .strip_prefix("android:@")
        .filter(|avd| !avd.is_empty())
        .map(str::to_string)
}

/// Does this address cost a virtual machine's worth of memory? A phone does not, so it has no
/// business counting against the run ceiling.
pub fn is_emulator_address(address: &str) -> bool {
    avd_in(address).is_some()
}

// ------------------------------------------------------------------ boot

/// How long a cold emulator gets to appear on `adb devices` and then finish booting. Generous:
/// the first boot of a fresh AVD genuinely takes minutes on a busy machine, and a timeout that
/// fires early reads as "Panel broke it" while the device carries on booting behind the error.
const APPEAR: Duration = Duration::from_secs(120);
/// A quick-boot RESTORE is a different job from a boot: the guest state is already on disk and
/// the device answers in seconds. So a restore gets a short leash — not because we are impatient,
/// but because the whole point of the short leash is to notice a rotten snapshot early enough to
/// throw it away and boot properly, instead of spending the cold-boot budget on a hang.
const RESTORE_APPEAR: Duration = Duration::from_secs(45);
const BOOT: Duration = Duration::from_secs(240);
const POLL: Duration = Duration::from_millis(1500);

/// Has this AVD a quick-boot snapshot to restore from? Only then is there anything to distrust.
fn has_snapshot(avd: &str) -> bool {
    avd_home()
        .join(format!("{avd}.avd"))
        .join("snapshots/default_boot/ram.bin")
        .is_file()
}

/// Make the device behind this address ready to receive a build, and hand back the serial
/// `flutter -d` should be given.
///
/// A phone is already on — this only checks it is still there, because unplugging it between the
/// picker and the click is the ordinary way for an Android run to fail. An emulator that is
/// running is returned as-is. Only a powered-off AVD is actually started, and then this waits for
/// `sys.boot_completed` rather than for the window: `flutter run` against a half-booted device
/// fails in a way that reads like a broken app.
pub fn boot(address: &str) -> Result<String, String> {
    let Some(avd) = avd_in(address) else {
        let serial = address
            .strip_prefix("android:")
            .unwrap_or(address)
            .to_string();
        return attached()
            .into_iter()
            .any(|(found, _)| found == serial)
            .then_some(serial.clone())
            .ok_or_else(|| format!("{serial} is not connected any more"));
    };
    if let Some(device) = list().into_iter().find(|d| d.avd == avd && d.booted) {
        return Ok(device.serial);
    }

    // A quick-boot snapshot is a CACHE, and a cache can rot. A half-written `ram.bin` — from a
    // machine that slept, a crash, a kill -9 — makes the emulator start, show its window, and
    // then never come online: no error, no exit, just a device stuck `offline` forever. That is
    // not a state to report and give up on, because the repair is one flag: boot without the
    // snapshot, and the clean shutdown afterwards writes a good one over the bad. So Panel tries
    // the fast path on a short leash, and heals itself on the way to the slow one.
    if has_snapshot(&avd) {
        if let Ok(serial) = start_and_wait(&avd, false, RESTORE_APPEAR) {
            return Ok(serial);
        }
    }
    start_and_wait(&avd, true, APPEAR)
}

/// Start the emulator and wait for it, cleaning up after itself if it never arrives.
///
/// `cold` skips the quick-boot snapshot. Only `-no-snapshot-load`, deliberately not
/// `-no-snapshot-save`: saving on exit is what replaces the bad snapshot with a good one, so the
/// next run is fast again instead of paying for a cold boot forever.
fn start_and_wait(avd: &str, cold: bool, appear: Duration) -> Result<String, String> {
    let before: HashSet<String> = adb_states()
        .into_iter()
        .map(|(serial, ..)| serial)
        .collect();
    let binary = emulator_bin();
    let mut command = crate::platform::command(&binary);
    // Older emulator builds resolve their engine relative to the binary's own directory and
    // PANIC when started from anywhere else. Standing in that directory costs nothing and makes
    // the difference between a run and an unexplained exit.
    if let Some(dir) = binary.parent().filter(|dir| dir.is_dir()) {
        command.current_dir(dir);
    }
    command.args(["-avd", avd]);
    if cold {
        command.arg("-no-snapshot-load");
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("could not start the emulator: {error}"))?;

    match wait_for_boot(avd, &before, appear) {
        Ok(serial) => Ok(serial),
        // A boot that fails must not leave the machine holding the corpse. This is not tidiness:
        // the emulator refuses to start an AVD that is already running ("Running multiple
        // emulators with the same AVD"), so one abandoned process turns a single slow boot into
        // an AVD that can never be used again until somebody finds it in Activity Monitor. It is
        // also what makes the snapshot retry above possible at all.
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(error)
        }
    }
}

/// Watch a just-started emulator until it can take a build. Two waits, not one, because they fail
/// differently and the human deserves to be told which: the device appearing on `adb devices` at
/// all, and then the guest OS finishing its own boot.
fn wait_for_boot(avd: &str, before: &HashSet<String>, appear: Duration) -> Result<String, String> {
    let started = Instant::now();
    let serial = loop {
        if started.elapsed() > appear {
            return Err(format!(
                "{avd} never appeared on adb — check it opens in Android Studio"
            ));
        }
        sleep(POLL);
        let fresh: Vec<String> = adb_states()
            .into_iter()
            .map(|(serial, ..)| serial)
            .filter(|serial| serial.starts_with("emulator-") && !before.contains(serial))
            .collect();
        // Match by AVD when the console will say, so two emulators started at once cannot be
        // confused for each other; fall back to "the one new serial" when it will not. `emu avd
        // name` only answers once the device is out of `offline`, which is why this keeps polling
        // rather than deciding on the first sighting.
        if let Some(found) = fresh
            .iter()
            .find(|serial| avd_of(serial).as_deref() == Some(avd))
        {
            break found.clone();
        }
        if fresh.len() == 1 && started.elapsed() > appear / 2 {
            break fresh[0].clone();
        }
    };

    while getprop(&serial, "sys.boot_completed") != "1" {
        if started.elapsed() > BOOT {
            return Err(format!("{avd} started but never finished booting"));
        }
        sleep(POLL);
    }
    Ok(serial)
}

// ------------------------------------------------------------------ giving it back

/// Shut an emulator down so the machine gets its memory back. Fire-and-forget on a throwaway
/// thread, like the iOS half.
pub fn shutdown(serial: &str) {
    let serial = serial.to_string();
    std::thread::spawn(move || shutdown_now(&serial));
}

/// The same shutdown, waited on — the quit path cannot afford a thread `app.exit` will kill.
///
/// Only ever an emulator. `emu kill` is a console command an emulator answers and a phone does
/// not, so a serial that is not an emulator's simply cannot be turned off by this, which is the
/// guarantee worth having: Panel must never power down somebody's actual phone.
pub fn shutdown_now(serial: &str) {
    if !serial.starts_with("emulator-") {
        return;
    }
    let _ = crate::platform::command(adb())
        .args(["-s", serial, "emu", "kill"])
        .status();
}

/// Bring the emulator window forward, the way `sim::focus_simulator` does for Simulator.app.
/// The window belongs to a `qemu-system-*` process, which has no bundle to `open -a`, so this
/// goes through System Events. Best-effort and silent: a machine that refuses the permission
/// still gets its run, just without the window jumping to the front.
#[cfg(not(windows))]
pub fn focus() {
    std::thread::spawn(|| {
        let _ = crate::platform::command("osascript")
            .args([
                "-e",
                r#"tell application "System Events"
                     set candidates to (every process whose name contains "qemu-system")
                     if (count of candidates) > 0 then set frontmost of item 1 of candidates to true
                   end tell"#,
            ])
            .output();
    });
}

/// The Windows half: the same `qemu-system-*` window, raised by its handle through user32.
/// A minimised window is restored first, or activation only flashes the taskbar button.
#[cfg(windows)]
pub fn focus() {
    std::thread::spawn(|| {
        let _ = crate::platform::command("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                r#"$p = Get-Process -Name 'qemu-system-*' -ErrorAction SilentlyContinue |
                     Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
                   if ($p) {
                     Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);'
                     [W.U]::ShowWindow($p.MainWindowHandle, 9) | Out-Null
                     [W.U]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
                   }"#,
            ])
            .output();
    });
}

// ------------------------------------------------------------------ whose device is this

/// Every package installed on a device. One call answers for the whole portfolio, which is the
/// only reason "is this app already on this device" is affordable to ask per project.
pub fn packages(serial: &str) -> HashSet<String> {
    adb_out(&["-s", serial, "shell", "pm", "list", "packages"])
        .unwrap_or_default()
        .lines()
        .filter_map(|line| line.trim().strip_prefix("package:"))
        .map(str::to_string)
        .collect()
}

/// The Android application id this project installs. The manifest states it for a managed app;
/// otherwise it comes out of the Gradle script, which is where the build reads it from anyway.
pub fn application_id(root: &Path) -> Option<String> {
    if let Some(manifest) = std::fs::read_to_string(root.join("appgea.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
    {
        for key in ["androidPackageName", "androidApplicationId", "playStoreId"] {
            if let Some(id) = manifest
                .get(key)
                .and_then(|id| id.as_str())
                .filter(|id| id.contains('.'))
            {
                return Some(id.to_string());
            }
        }
    }
    // Flutter keeps Gradle under android/app. A native Android repository keeps app directly
    // under its root. They are the same fact in two layouts, so inspect both here.
    for app in [root.join("app"), root.join("android/app")] {
        for name in ["build.gradle.kts", "build.gradle"] {
            let Ok(text) = std::fs::read_to_string(app.join(name)) else {
                continue;
            };
            // `applicationId = "com.x"` (kts) and `applicationId "com.x"` (groovy). A flavour
            // block may add more; the first is the default config's, which an ordinary run uses.
            if let Some(id) = text
                .split("applicationId")
                .skip(1)
                .filter_map(|tail| tail.split('"').nth(1))
                .find(|id| id.contains('.'))
            {
                return Some(id.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_emulator_is_addressed_by_its_avd_and_a_phone_by_its_serial() {
        assert_eq!(
            avd_in("android:@Small_Phone").as_deref(),
            Some("Small_Phone")
        );
        assert_eq!(avd_in("android:R5CT30ABCDE"), None);
        assert_eq!(avd_in("android:@"), None);
        assert!(is_emulator_address("android:@Pixel_7"));
        assert!(!is_emulator_address("android:R5CT30ABCDE"));
    }

    #[test]
    fn a_powered_off_avd_still_describes_itself_from_its_config() {
        let config = vec![
            ("avd.ini.displayname".to_string(), "Small Phone".to_string()),
            (
                "image.sysdir.1".to_string(),
                "system-images/android-34/google_apis_playstore/arm64-v8a/".to_string(),
            ),
        ];
        assert_eq!(avd_label("Small_Phone", &config), "Small Phone");
        assert_eq!(avd_runtime(&config), "API 34");
        // No config at all is still a readable name, not a blank row.
        assert_eq!(avd_label("Small_Phone", &[]), "Small Phone");
        assert_eq!(avd_runtime(&[]), "Android");
    }

    #[test]
    fn a_projects_application_id_comes_from_its_manifest_then_its_gradle_script() {
        let root = std::env::temp_dir().join(format!("panel-android-id-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("android/app")).unwrap();
        std::fs::write(
            root.join("android/app/build.gradle.kts"),
            "android {\n  defaultConfig {\n    applicationId = \"com.appgea.tavla\"\n  }\n}\n",
        )
        .unwrap();
        assert_eq!(application_id(&root).as_deref(), Some("com.appgea.tavla"));

        std::fs::write(
            root.join("appgea.json"),
            r#"{"androidPackageName":"com.appgea.stated"}"#,
        )
        .unwrap();
        assert_eq!(application_id(&root).as_deref(), Some("com.appgea.stated"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_groovy_gradle_script_states_it_without_an_equals_sign() {
        let root =
            std::env::temp_dir().join(format!("panel-android-groovy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("android/app")).unwrap();
        std::fs::write(
            root.join("android/app/build.gradle"),
            "defaultConfig {\n    applicationId \"com.appgea.memor\"\n}\n",
        )
        .unwrap();
        assert_eq!(application_id(&root).as_deref(), Some("com.appgea.memor"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_standalone_android_repo_states_its_application_id_at_root() {
        let root =
            std::env::temp_dir().join(format!("panel-native-android-id-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("app")).unwrap();
        std::fs::write(
            root.join("app/build.gradle.kts"),
            "defaultConfig { applicationId = \"com.appgea.clearday\" }",
        )
        .unwrap();
        assert_eq!(
            application_id(&root).as_deref(),
            Some("com.appgea.clearday")
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
