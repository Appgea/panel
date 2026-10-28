//! The portfolio.
//!
//! Panel is an admin panel across many apps, not an IDE inside one. The project is the
//! unit of everything: an agent, a working set, a dashboard. The registry is the OLD
//! Panel's `config.json` — the same list, read in place, so both Panels see one
//! portfolio and adding a project in either shows up in the other.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// The floor every project gets when nothing else is detectable. Dashboard and Work are core
/// surfaces and are not modules at all; these two are the ones that are about the *repo* rather
/// than about what the repo ships, so they hold for a website and a game alike.
const BASELINE_MODULES: &[&str] = &["product-spine"];

const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg"];
const SKIP_ICON_DIRS: &[&str] = &[
    "build",
    ".build",
    "Pods",
    "DerivedData",
    "checkouts",
    "node_modules",
    "Preview Content",
    "xcuserdata",
    ".git",
    "target",
    "dist",
    ".next",
    ".venv",
    "venv",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectRole {
    Leaf,
    Collection,
}

impl Default for ProjectRole {
    fn default() -> Self {
        Self::Leaf
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    /// Stable id. Explicit when declared; older entries keep their folder name.
    pub id: String,
    pub name: String,
    pub path: PathBuf,
    pub exists: bool,
    /// Which group owns it, or empty for none. See `Group`.
    #[serde(default)]
    pub group: String,
    /// Structural behavior. Collections own children; leaves own work and sessions.
    #[serde(default)]
    pub role: ProjectRole,
    /// Open domain label. Core understands `generic`; extensions may add their own values.
    #[serde(default = "generic_project_type", rename = "type")]
    pub project_type: String,
    /// Stable parent id. Empty keeps old flat portfolios valid without a migration pass.
    #[serde(default)]
    pub parent_id: String,
    /// Module owning this project's domain surface. Empty means core Panel only.
    #[serde(default)]
    pub extension_id: String,
}

fn generic_project_type() -> String {
    "generic".to_string()
}

/*
 * Groups.
 *
 * The portfolio is not one company any more. Most of it is Appgea; some of it belongs elsewhere.
 * Splitting Panel in two would be the obvious answer and the wrong one — the whole point of this
 * panel is that everything you own is on one screen. So the portfolio stays whole and grows a
 * seam: projects carry a group, and a group carries the things that genuinely differ between one
 * company and another.
 *
 * NOT to be confused with `bundle_id`, which is and stays a reverse-DNS app identifier. A group is
 * who owns the work; a bundle id is what a store calls one app.
 *
 * Two policies are modelled. `ops_root` is live: the CPO's brain — the portfolio spine, the
 * decisions, the principles — is per group, because Appgea's standing decisions have no business
 * governing someone else's repo. The store credentials are declared and read, but nothing consumes
 * them yet; release-manager and ASO still use the global account. That wiring is its own job and
 * pretending otherwise in code would be worse than an empty field.
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Group {
    /// Stable key, used in `config.json` and as the terminal tab's identity.
    pub id: String,
    pub name: String,
    /// This group's ops tree — the folder CONTAINING `ops/`. Empty falls back to the global
    /// `opsRoot`, which is what every project used before groups existed.
    #[serde(default)]
    pub ops_root: String,
    /// App Store Connect / Play credentials for this group's apps. Declared, not yet consumed.
    #[serde(default)]
    pub store: Value,
}

/// Every group in `config.json`, in file order. The order is the strip order and the sidebar
/// order, so it is the human's to arrange by editing the file.
pub fn groups() -> Vec<Group> {
    let Ok(raw) = std::fs::read_to_string(config_path()) else {
        return Vec::new();
    };
    let Ok(config) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    config["groups"]
        .as_array()
        .map(|list| list.iter().filter_map(group_from).collect())
        .unwrap_or_default()
}

/// Move a project into a group, or out of every group when `group` is empty. The rail's row menu
/// is the only caller, and it is the reason groups are usable without opening `config.json`.
pub fn set_group(project: &str, group: &str) -> Result<(), String> {
    let file = config_path();
    let mut config = read_config(&file)?;
    let group = group.trim().to_string();
    // A typo'd id would file the project into a group that renders nowhere. Refuse instead.
    let known = config["groups"].as_array().is_some_and(|list| {
        list.iter()
            .any(|entry| entry["id"].as_str() == Some(&group))
    });
    if !group.is_empty() && !known {
        return Err(format!("no such group: {group}"));
    }
    let list = config["projects"]
        .as_array_mut()
        .ok_or("config.json has no projects array")?;
    let selected = list
        .iter_mut()
        .position(|entry| project_from(entry).is_some_and(|found| found.id == project))
        .ok_or_else(|| format!("no such project: {project}"))?;
    let selected_project = project_from(&list[selected]).ok_or("that project is invalid")?;
    let branch_id = if selected_project.parent_id.is_empty() {
        selected_project.id
    } else {
        selected_project.parent_id
    };
    let index = list
        .iter()
        .position(|entry| project_from(entry).is_some_and(|found| found.id == branch_id))
        .unwrap_or(selected);
    let collection =
        project_from(&list[index]).is_some_and(|found| found.role == ProjectRole::Collection);
    // A collection and its children are one navigation branch. The UI always files through the
    // parent; this propagation also keeps direct callers from splitting that branch by accident.
    for (at, entry) in list.iter_mut().enumerate() {
        let child = entry["parentId"].as_str() == Some(branch_id.as_str())
            || entry["parent_id"].as_str() == Some(branch_id.as_str());
        if at != index && !(collection && child) {
            continue;
        }
        let object = entry
            .as_object_mut()
            .ok_or("that project is not an object")?;
        // Ungrouped drops the key rather than writing `""`. The file stays as short as it was.
        if group.is_empty() {
            object.remove("group");
        } else {
            object.insert("group".into(), Value::String(group.clone()));
        }
    }
    write_config(&file, &config)
}

/// Add a group and hand back the whole list. The id is derived from the name so `config.json`
/// stays readable by hand — a group called "Studio North" is `studio-north` in the file.
pub fn add_group(name: &str) -> Result<Vec<Group>, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("a group needs a name".into());
    }
    let id = slug(name);
    if id.is_empty() {
        return Err("that name has no letters or digits in it".into());
    }
    let file = config_path();
    let mut config = read_config(&file)?;
    if !config["groups"].is_array() {
        config["groups"] = Value::Array(Vec::new());
    }
    let list = config["groups"]
        .as_array_mut()
        .ok_or("config.json has no groups array")?;
    if list.iter().any(|entry| entry["id"].as_str() == Some(&id)) {
        return Err(format!("“{name}” is already a group"));
    }
    // opsRoot and store are written empty on purpose: they are the two policies a group MAY carry,
    // and an empty one means "same as the portfolio", which is the right default for a new group.
    list.push(serde_json::json!({ "id": id, "name": name, "opsRoot": "", "store": {} }));
    write_config(&file, &config)?;
    Ok(groups())
}

fn slug(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

// Read-modify-write the whole document rather than rewriting it from our own structs: the old
// Panel keeps keys here we do not model, and losing them would break it.
fn read_config(file: &Path) -> Result<Value, String> {
    let raw = std::fs::read_to_string(file).map_err(|error| error.to_string())?;
    serde_json::from_str(&raw).map_err(|error| error.to_string())
}

fn write_config(file: &Path, config: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(config).map_err(|error| error.to_string())?;
    std::fs::write(file, bytes).map_err(|error| error.to_string())
}

fn group_from(entry: &Value) -> Option<Group> {
    let id = entry["id"].as_str()?.trim().to_string();
    if id.is_empty() {
        return None;
    }
    let name = entry["name"]
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| id.clone());
    Some(Group {
        id,
        name,
        ops_root: entry["opsRoot"].as_str().unwrap_or("").to_string(),
        store: entry["store"].clone(),
    })
}

/// The ops tree that governs one project: its group's, else the global one. Returns the folder
/// CONTAINING `ops/`, exactly as `opsRoot` in config.json means it.
pub fn ops_root_for(project: Option<&Project>) -> Option<PathBuf> {
    let raw = std::fs::read_to_string(config_path()).ok()?;
    let config = serde_json::from_str::<Value>(&raw).ok()?;
    let group = project.map(|p| p.group.as_str()).unwrap_or("");
    if !group.is_empty() {
        if let Some(found) = config["groups"].as_array().and_then(|list| {
            list.iter()
                .find(|entry| entry["id"].as_str() == Some(group))
                .and_then(|entry| entry["opsRoot"].as_str())
                .filter(|value| !value.trim().is_empty())
        }) {
            return Some(PathBuf::from(found));
        }
    }
    // An empty `opsRoot` is the fresh-install case, not an error: `migrate` has already seeded
    // `~/.appgeapanel/ops` from the shipped template, so the companion has a real tree to read
    // without anyone editing a config file first.
    match config["opsRoot"].as_str().map(str::trim) {
        Some(value) if !value.is_empty() => Some(PathBuf::from(value)),
        _ => Some(crate::paths::ops_root()),
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectModules {
    pub configured: bool,
    pub enabled: Vec<String>,
    pub work_exclude: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct ProjectModulesManifest {
    version: u32,
    enabled: Vec<String>,
    #[serde(default)]
    work: WorkSettings,
}

#[derive(Debug, Default, Deserialize)]
struct WorkSettings {
    #[serde(default)]
    exclude: Vec<String>,
}

/// Repository-owned Panel module availability. Dashboard and Work are core surfaces and are not
/// listed here. Without a manifest Panel DETECTS the set from the repo — see `detect_modules`;
/// once a project opts in, only the named optional modules stand for that project.
/// The host module a UI surface is backed by, when it is backed by one at all.
///
/// The two vocabularies are not the same and should not be forced to be: the tab is called Git
/// because that is what it shows, and the module is called `git-manager` because that is the
/// process.
fn backing_module(surface: &str) -> Option<&'static str> {
    Some(match surface {
        "git" => "git-manager",
        "release" => "release-manager",
        "revenuecat" => "revenuecat",
        "analytics" => "analytics",
        "product-spine" => "product-spine",
        _ => return None,
    })
}

/// Drop any surface whose module this machine has not installed.
///
/// Two independent questions, and both must say yes. The project decides what it *could* show —
/// a repo with no RevenueCat dependency has no use for that tab. The human decides what is
/// installed at all. Answering only the first is how you get a tab that opens onto an error.
fn keep_installed(enabled: Vec<String>, installed: &HashSet<String>) -> Vec<String> {
    enabled
        .into_iter()
        .filter(|surface| match backing_module(surface) {
            Some(module) => installed.contains(module),
            None => true,
        })
        .collect()
}

pub fn modules(root: &Path) -> Result<ProjectModules, String> {
    modules_with_installed(root, &crate::modules::installed_names())
}

fn modules_with_installed(
    root: &Path,
    installed: &HashSet<String>,
) -> Result<ProjectModules, String> {
    let file = root.join(".panel/modules.json");
    if !file.is_file() {
        return Ok(ProjectModules {
            configured: false,
            enabled: keep_installed(detect_modules(root), installed),
            work_exclude: Vec::new(),
        });
    }
    let raw = fs::read_to_string(&file).map_err(|error| error.to_string())?;
    let manifest: ProjectModulesManifest =
        serde_json::from_str(&raw).map_err(|error| format!("{}: {error}", file.display()))?;
    if manifest.version != 1 {
        return Err(format!(
            "unsupported Panel modules version {}",
            manifest.version
        ));
    }
    let mut enabled = Vec::new();
    for module in manifest.enabled {
        let module = match module.trim() {
            // Compatibility with project manifests written before the rename.
            "decisions" | "decision-map" | "spine" => "product-spine",
            current => current,
        }
        .to_string();
        if !module.is_empty() && !enabled.contains(&module) {
            enabled.push(module);
        }
    }
    Ok(ProjectModules {
        configured: true,
        enabled: keep_installed(enabled, installed),
        work_exclude: manifest
            .work
            .exclude
            .into_iter()
            .map(|value| value.trim().replace('\\', "/"))
            .filter(|value| !value.is_empty() && !value.contains(".."))
            .collect(),
    })
}

/// Does any file under `dir`, at most `depth` levels down, match `hit`? Bounded on purpose: this
/// runs on every project switch, and an unbounded walk of a Flutter repo means `build/` and
/// `Pods/`. Everything we look for lives within three levels of a project root.
fn any_file(dir: &Path, depth: usize, hit: &dyn Fn(&Path) -> bool) -> bool {
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };
    let mut dirs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            // The same noise the icon scan skips, plus the build outputs a match would be a lie in.
            if SKIP_ICON_DIRS.contains(&name.as_ref()) || name.starts_with('.') {
                continue;
            }
            dirs.push(path);
        } else if hit(&path) {
            return true;
        }
    }
    if depth == 0 {
        return false;
    }
    dirs.iter().any(|dir| any_file(dir, depth - 1, hit))
}

/// Is `needle` present in any file named one of `names`, within three levels of the root?
fn manifest_mentions(root: &Path, names: &[&str], needle: &str) -> bool {
    let needle = needle.to_ascii_lowercase();
    any_file(root, 3, &|path| {
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            return false;
        };
        if !names.contains(&name) {
            return false;
        }
        // Manifests are small; a lockfile is not. Cap the read so a big Podfile.lock stays cheap.
        let Ok(file) = fs::File::open(path) else {
            return false;
        };
        let mut buffer = Vec::new();
        if file.take(512 * 1024).read_to_end(&mut buffer).is_err() {
            return false;
        }
        String::from_utf8_lossy(&buffer)
            .to_ascii_lowercase()
            .contains(&needle)
    })
}

/// Does a file with one of these names exist within three levels of the root?
fn has_file_named(root: &Path, names: &[&str]) -> bool {
    any_file(root, 3, &|path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| names.contains(&name))
    })
}

/// What Panel surfaces this repo actually has a use for, read off the repo itself.
///
/// A tab you can never act on is worse than a missing one: it reads as a broken feature every
/// time you land on it. So a project earns each optional module by carrying the thing that module
/// operates on — a store build for Release, a RevenueCat dependency for RevenueCat, a Firebase
/// config for Analytics. This is the fallback only; `.panel/modules.json` still overrides it
/// wholesale, which is how a project turns one OFF that it technically could support.
fn detect_modules(root: &Path) -> Vec<String> {
    let mut enabled: Vec<String> = BASELINE_MODULES
        .iter()
        .map(|value| (*value).to_string())
        .collect();

    // A media workspace (it has a workspace.yaml) is content, not an app source tree. Its media library can hold tens of
    // thousands of files, and none of the mobile SDK probes below apply to it.
    if root.join("workspace.yaml").is_file() {
        if root.join(".git").exists() {
            enabled.push("git".to_string());
        }
        return enabled;
    }

    // Git: a repo at the root, or a monorepo whose app is one level in (Fitstrail).
    let versioned = root.join(".git").exists()
        || fs::read_dir(root).is_ok_and(|entries| {
            entries
                .flatten()
                .any(|entry| entry.path().join(".git").exists())
        });
    if versioned {
        enabled.push("git".to_string());
    }

    // Release: something that can actually be shipped to a store. `project.pbxproj` rather than
    // `*.xcodeproj` because the latter is a DIRECTORY — we walk into it and match the file inside.
    // A Godot game carries none of those at rest — its Xcode/Gradle projects are export OUTPUT —
    // so its store intent lives in `export_presets.cfg`, and only when a mobile preset is in it.
    if has_file_named(
        root,
        &[
            "Podfile",
            "build.gradle",
            "build.gradle.kts",
            "Appfile",
            "project.pbxproj",
        ],
    ) || godot_mobile_presets(root)
    {
        enabled.push("release".to_string());
    }

    // RevenueCat: the SDK is a dependency somewhere.
    if manifest_mentions(
        root,
        &[
            "pubspec.yaml",
            "Podfile.lock",
            "Package.resolved",
            "project.pbxproj",
        ],
        "revenuecat",
    ) || manifest_mentions(root, &["pubspec.yaml"], "purchases_flutter")
    {
        enabled.push("revenuecat".to_string());
    }

    // Analytics: a Firebase/GA4 config is present, which is all this tab reads.
    if has_file_named(
        root,
        &[
            "firebase_options.dart",
            "GoogleService-Info.plist",
            "google-services.json",
            "firebase.json",
        ],
    ) {
        enabled.push("analytics".to_string());
    }

    enabled
}

/// Is this a Godot project, and does it export to a phone? A desktop-or-web-only game has nothing
/// for the Release tab to do, so the presets — not the mere presence of `project.godot` — decide.
fn godot_mobile_presets(root: &Path) -> bool {
    crate::sim::godot_presets(root)
        .iter()
        .any(|preset| matches!(preset.platform.as_str(), "iOS" | "Android"))
}

/// Git state, for the dashboard header.
#[derive(Debug, Clone, Serialize, Default)]
pub struct GitState {
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub dirty: u32,
    pub is_repo: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileEntry {
    pub path: String,
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitBranch {
    pub name: String,
    pub current: bool,
    pub upstream: String,
    pub age: String,
    pub old: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitRemote {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub branch: String,
    pub detached: bool,
    pub ahead: u32,
    pub behind: u32,
    pub staged: Vec<GitFileEntry>,
    pub unstaged: Vec<GitFileEntry>,
    pub untracked: Vec<String>,
    pub conflicts: Vec<GitFileEntry>,
    pub operation: String,
    pub stash_count: usize,
    pub latest_stash: String,
    pub branches: Vec<GitBranch>,
    pub remotes: Vec<GitRemote>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitCommitRef {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitCommit {
    pub sha: String,
    pub short: String,
    pub subject: String,
    pub author: String,
    pub age: String,
    pub parents: Vec<String>,
    pub refs: Vec<GitCommitRef>,
    pub lane: usize,
    pub color: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitGraph {
    pub commits: Vec<GitCommit>,
    pub head: String,
    pub lanes: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitOverview {
    pub status: GitStatus,
    pub graph: GitGraph,
}

/// One file the human is expected to touch, and why.
///
/// The agent's `worklist` supplies the `why` — that is the whole value, and it is why a
/// declared worklist beats a derived one. Git can only tell you a file changed; it cannot
/// tell you it changed because the retry budget is a product call.
#[derive(Debug, Clone, Serialize)]
pub struct WorkFile {
    pub path: String,
    pub why: Option<String>,
}

/// The portfolio file. It lives in the human's own directory, never in the shipped tree — it
/// holds one person's absolute project paths and is the single most machine-specific thing Panel
/// owns. `panel_home` is deliberately not a parameter: there is exactly one portfolio per user.
pub fn config_path() -> PathBuf {
    crate::paths::config_file()
}

pub fn load() -> Vec<Project> {
    let Ok(raw) = std::fs::read_to_string(config_path()) else {
        return Vec::new();
    };
    let Ok(config) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    config["projects"]
        .as_array()
        .map(|list| list.iter().filter_map(project_from).collect())
        .unwrap_or_default()
}

/// The folder the portfolio lives in, for a terminal that belongs to no one project.
///
/// `mainFolder` in `config.json` wins. Without it, the deepest folder every project sits under.
/// A portfolio spread across the whole disk would make that `/`, which is no one's main folder,
/// so a root-level answer counts as none.
pub fn main_folder() -> Option<PathBuf> {
    let raw = std::fs::read_to_string(config_path()).ok()?;
    let config = serde_json::from_str::<Value>(&raw).ok()?;
    if let Some(set) = config["mainFolder"].as_str().map(str::trim).filter(|s| !s.is_empty()) {
        return Some(PathBuf::from(set));
    }
    let paths: Vec<PathBuf> = config["projects"]
        .as_array()?
        .iter()
        .filter_map(project_from)
        .filter(|project| project.role == ProjectRole::Leaf)
        .map(|project| project.path)
        .collect();
    common_parent(&paths).filter(|path| path.components().count() > 1)
}

/// The deepest folder that holds every path. One project's main folder is the folder it sits in.
fn common_parent(paths: &[PathBuf]) -> Option<PathBuf> {
    let (first, rest) = paths.split_first()?;
    let mut shared: PathBuf = first.parent()?.to_path_buf();
    for path in rest {
        while !path.starts_with(&shared) {
            shared = shared.parent()?.to_path_buf();
        }
    }
    Some(shared)
}

fn project_from(entry: &Value) -> Option<Project> {
    let path = PathBuf::from(entry["path"].as_str()?);
    let fallback_id = path.file_name()?.to_string_lossy().into_owned();
    let id = entry["id"]
        .as_str()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .unwrap_or(fallback_id);
    let name = entry["name"]
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| id.clone());
    Some(Project {
        exists: path.is_dir(),
        id,
        name,
        path,
        group: entry["group"].as_str().unwrap_or("").trim().to_string(),
        role: match entry["role"].as_str().unwrap_or("leaf") {
            "collection" => ProjectRole::Collection,
            _ => ProjectRole::Leaf,
        },
        project_type: entry["type"]
            .as_str()
            .unwrap_or("generic")
            .trim()
            .to_string(),
        parent_id: entry["parentId"]
            .as_str()
            .or_else(|| entry["parent_id"].as_str())
            .unwrap_or("")
            .trim()
            .to_string(),
        extension_id: entry["extensionId"]
            .as_str()
            .or_else(|| entry["extension_id"].as_str())
            .unwrap_or("")
            .trim()
            .to_string(),
    })
}

/// Append a project to the shared `config.json`, preserving whatever else is in the file.
pub fn add(path: &Path, name: Option<String>) -> Result<Project, String> {
    if !path.is_dir() {
        return Err(format!("not a folder: {}", path.display()));
    }
    let path = path.canonicalize().map_err(|error| error.to_string())?;
    let file = config_path();

    let mut config = read_config(&file)?;

    let list = config["projects"]
        .as_array_mut()
        .ok_or("config.json has no projects array")?;
    let id = path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default();
    if list
        .iter()
        .any(|entry| entry["path"].as_str() == Some(&path.to_string_lossy()))
    {
        return Err("that project is already in the portfolio".into());
    }
    if list
        .iter()
        .any(|entry| project_from(entry).is_some_and(|project| project.id == id))
    {
        return Err(format!("another project already uses id {id}"));
    }

    let name = name
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            path.file_name()
                .map(|value| value.to_string_lossy().into_owned())
                .unwrap_or_default()
        });
    list.push(serde_json::json!({
        "id": id.clone(),
        "path": path.to_string_lossy(),
        "name": name,
        "role": "leaf",
        "type": "generic"
    }));

    write_config(&file, &config)?;

    project_from(&serde_json::json!({ "id": id, "path": path.to_string_lossy(), "name": name }))
        .ok_or_else(|| "could not read the project back".into())
}

/* --------------------------------------------------------------- app icons */

/// Resolve the app's own artwork from its project type. A loose root image is only a legacy
/// fallback; it must never displace the icon a Flutter, native, web, or Godot project ships.
pub fn app_icon(project: &Project) -> Option<PathBuf> {
    if !project.path.is_dir() {
        return None;
    }
    // Media workspaces are media folders. Never recurse through their archives looking for an
    // Xcode icon catalogue; use a root icon when supplied and the UI's letter mark otherwise.
    if project.path.join("workspace.yaml").is_file() {
        return root_icon(&project.path);
    }
    let manifest = fs::read_to_string(project.path.join("appgea.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or(Value::Null);

    let declared = match manifest["appType"].as_str() {
        Some("flutter") => {
            let root = manifest["subpath"]
                .as_str()
                .map(|path| project.path.join(path))
                .unwrap_or_else(|| project.path.clone());
            flutter_icon(&root)
        }
        Some("native") => {
            let root = manifest["ios"]["path"]
                .as_str()
                .or_else(|| manifest["subpath"].as_str())
                .map(|path| project.path.join(path))
                .unwrap_or_else(|| project.path.clone());
            native_icon(&root).or_else(|| android_icon(&project.path))
        }
        Some("web") => web_icon(&project.path),
        Some("godot") => {
            let root = manifest["subpath"]
                .as_str()
                .map(|path| project.path.join(path))
                .unwrap_or_else(|| project.path.clone());
            godot_icon(&root)
        }
        _ => None,
    };

    let icon = declared
        .or_else(|| desktop_icon(&project.path))
        .or_else(|| godot_icon(&project.path))
        .or_else(|| flutter_icon(&project.path))
        .or_else(|| android_icon(&project.path))
        .or_else(|| native_icon(&project.path))
        .or_else(|| web_icon(&project.path))
        .or_else(|| root_icon(&project.path))?;
    // A manifest may contain a relative path. Never let icon serving escape the registered app.
    let root = project.path.canonicalize().ok()?;
    let icon = icon.canonicalize().ok()?;
    icon.starts_with(root).then_some(icon)
}

#[derive(Clone)]
struct IconCacheEntry {
    root: PathBuf,
    path: Option<PathBuf>,
    checked: Instant,
    /// A background re-check is already on its way; don't start another.
    refreshing: bool,
}

type IconCache = Mutex<HashMap<String, IconCacheEntry>>;

fn icon_cache() -> &'static IconCache {
    static CACHE: OnceLock<IconCache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn store_icon(project: &Project, path: Option<PathBuf>) {
    icon_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(
            project.id.clone(),
            IconCacheEntry {
                root: project.path.clone(),
                path,
                checked: Instant::now(),
                refreshing: false,
            },
        );
}

/// Icon discovery may recurse through native source trees: seconds across a portfolio. So a known
/// answer is returned at once, and an old one is re-checked in the background; regenerated
/// artwork shows up on the next request instead of blocking this one.
pub fn cached_app_icon(project: &Project) -> Option<PathBuf> {
    let stale = {
        let mut cache = icon_cache()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match cache.get_mut(&project.id) {
            Some(entry)
                if entry.root == project.path
                    && entry.path.as_ref().is_none_or(|path| path.is_file()) =>
            {
                if entry.checked.elapsed() < Duration::from_secs(10) || entry.refreshing {
                    return entry.path.clone();
                }
                entry.refreshing = true;
                Some(entry.path.clone())
            }
            _ => None,
        }
    };
    match stale {
        Some(path) => {
            let project = project.clone();
            std::thread::spawn(move || {
                let found = app_icon(&project);
                store_icon(&project, found);
            });
            path
        }
        None => {
            let path = app_icon(project);
            store_icon(project, path.clone());
            path
        }
    }
}

/// Android launcher art in either a standalone native repository or Flutter's android subtree.
/// A checked-in preview is the complete adaptive icon, so it outranks separate foreground layers.
fn android_icon(root: &Path) -> Option<PathBuf> {
    for base in [root.to_path_buf(), root.join("android")] {
        let res = base.join("app/src/main/res");
        let preview = res.join("drawable-nodpi/app_icon_preview.png");
        if preview.is_file() {
            return Some(preview);
        }
        for density in ["xxxhdpi", "xxhdpi", "xhdpi", "hdpi", "mdpi"] {
            for name in ["ic_launcher.png", "ic_launcher_round.png"] {
                let candidate = res.join(format!("mipmap-{density}/{name}"));
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

fn flutter_icon(root: &Path) -> Option<PathBuf> {
    pubspec_icon(root)
        .or_else(|| largest_image(&root.join("ios/Runner/Assets.xcassets/AppIcon.appiconset")))
        .or_else(|| {
            ["xxxhdpi", "xxhdpi", "xhdpi", "hdpi", "mdpi"]
                .iter()
                .map(|density| {
                    root.join(format!(
                        "android/app/src/main/res/mipmap-{density}/ic_launcher.png"
                    ))
                })
                .find(|path| path.is_file())
        })
        .or_else(|| {
            [
                "assets/icon.png",
                "assets/app_icon.png",
                "assets/images/icon.png",
                "assets/icon/icon.png",
                "web/icons/Icon-512.png",
                "icon.png",
            ]
            .iter()
            .map(|path| root.join(path))
            .find(|path| path.is_file())
        })
}

/// A Godot game declares its icon in `project.godot` as a `res://` path — which is simply relative
/// to the project root. Everything else here is the engine's own default naming.
fn godot_icon(root: &Path) -> Option<PathBuf> {
    let raw = fs::read_to_string(root.join("project.godot")).ok()?;
    let declared = raw.lines().find_map(|line| {
        let value = line.trim().strip_prefix("config/icon=")?.trim();
        let path = root.join(value.trim_matches('"').strip_prefix("res://")?);
        path.is_file().then_some(path)
    });
    declared.or_else(|| {
        ["icon.png", "icon.svg", "assets/icon.png"]
            .iter()
            .map(|path| root.join(path))
            .find(|path| path.is_file())
    })
}

fn pubspec_icon(root: &Path) -> Option<PathBuf> {
    let raw = fs::read_to_string(root.join("pubspec.yaml")).ok()?;
    raw.lines().find_map(|line| {
        let value = line.trim().strip_prefix("image_path:")?.trim();
        let value = value
            .split('#')
            .next()
            .unwrap_or(value)
            .trim()
            .trim_matches(['\"', '\'']);
        let path = root.join(value);
        path.is_file().then_some(path)
    })
}

fn native_icon(root: &Path) -> Option<PathBuf> {
    let mut catalogs = Vec::new();
    find_icon_catalogs(root, &mut catalogs);
    // Companion watch/widget artwork should not displace the main app's icon.
    let main: Vec<&PathBuf> = catalogs
        .iter()
        .filter(|path| {
            let lower = path.to_string_lossy().to_lowercase();
            !lower.contains("watch") && !lower.contains("widget")
        })
        .collect();
    (if main.is_empty() {
        catalogs.iter().collect::<Vec<_>>()
    } else {
        main
    })
    .into_iter()
    .filter_map(|catalog| largest_image(catalog))
    .max_by_key(|path| fs::metadata(path).map(|meta| meta.len()).unwrap_or(0))
}

fn find_icon_catalogs(root: &Path, found: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if SKIP_ICON_DIRS.contains(&name.as_ref()) {
            continue;
        }
        if name == "AppIcon.appiconset" {
            found.push(path);
        } else {
            find_icon_catalogs(&path, found);
        }
    }
}

fn largest_image(root: &Path) -> Option<PathBuf> {
    fs::read_dir(root)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && is_raster_image(path))
        .max_by_key(|path| fs::metadata(path).map(|meta| meta.len()).unwrap_or(0))
}

fn is_raster_image(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| IMAGE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn desktop_icon(root: &Path) -> Option<PathBuf> {
    [
        "src-tauri/icons",
        "apps/desktop/src-tauri/icons",
        "next/apps/desktop/src-tauri/icons",
    ]
    .iter()
    .flat_map(|dir| {
        ["icon.png", "128x128@2x.png", "128x128.png", "icon.ico"]
            .map(|name| root.join(dir).join(name))
    })
    .find(|path| path.is_file())
}

fn web_icon(root: &Path) -> Option<PathBuf> {
    web_icon_at(root).or_else(|| {
        // Web apps may live in a package below the registered repository (including apps/*).
        let mut packages = Vec::new();
        for parent in [root.to_path_buf(), root.join("apps")] {
            if let Ok(entries) = fs::read_dir(parent) {
                packages.extend(entries.flatten().map(|entry| entry.path()).filter(|path| {
                    path.is_dir()
                        && path.join("package.json").is_file()
                        && !path.file_name().and_then(|name| name.to_str())
                            .is_some_and(|name| SKIP_ICON_DIRS.contains(&name))
                }));
            }
        }
        packages.sort();
        packages.into_iter().find_map(|package| web_icon_at(&package))
    })
}

fn web_icon_at(root: &Path) -> Option<PathBuf> {
    [
        "public/apple-touch-icon.png",
        "public/images/apple-touch-icon.png",
        "public/icon.png",
        "public/logo.png",
        "public/favicon.png",
        "public/favicon.svg",
        "public/favicon.ico",
        "src/app/icon.png",
        "src/app/icon.svg",
        "src/app/favicon.ico",
        "app/icon.png",
        "app/icon.svg",
        "app/favicon.ico",
        "assets/favicon.png",
        "favicon.png",
        "favicon.svg",
        "favicon.ico",
    ]
    .iter()
    .map(|path| root.join(path))
    .find(|path| path.is_file())
}

fn root_icon(root: &Path) -> Option<PathBuf> {
    fs::read_dir(root)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            if !path.is_file() || !is_raster_image(path) {
                return false;
            }
            let name = path
                .file_stem()
                .and_then(|name| name.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            name == "icon"
                || name == "appicon"
                || name.starts_with("icon-")
                || name.starts_with("appicon-")
                || name.starts_with("app_icon-")
        })
        .max_by_key(|path| fs::metadata(path).map(|meta| meta.len()).unwrap_or(0))
}

pub fn git_state(path: &Path) -> GitState {
    let mut state = GitState::default();
    if !path.join(".git").exists() {
        return state;
    }
    state.is_repo = true;
    // Porcelain v2 carries branch, drift and dirt in one stable response. The old path spawned
    // three Git processes for every card on Home, making a portfolio refresh needlessly hot.
    if let Some(status) = git(path, &["status", "--porcelain=v2", "--branch"]) {
        apply_git_status(&mut state, &status);
    }
    state
}

/// Everything the Git tab needs for one refresh.
///
/// The old path made two module calls. Each call launched Python before launching Git several
/// times. These independent reads run together and cross the Tauri boundary once.
pub fn git_overview(path: &Path, limit: usize) -> Result<GitOverview, String> {
    let log_limit = limit.clamp(1, 500).to_string();
    let log_format = "--pretty=%H%x1f%P%x1f%D%x1f%s%x1f%an%x1f%cr";
    let (status_raw, branches_raw, remotes_raw, stash_raw, graph_raw) = std::thread::scope(
        |scope| -> Result<_, String> {
            let status = scope.spawn(|| {
                git_command(
                    path,
                    &[
                        "status",
                        "--porcelain=v2",
                        "-z",
                        "--branch",
                        "--show-stash",
                        "--untracked-files=all",
                    ],
                )
            });
            let branches = scope.spawn(|| {
                git_command(
                    path,
                    &[
                        "for-each-ref",
                        "--format=%(refname:short)%09%(upstream:short)%09%(committerdate:unix)%09%(committerdate:relative)",
                        "refs/heads",
                    ],
                )
            });
            let remotes = scope.spawn(|| git_command(path, &["remote", "-v"]));
            let stash = scope.spawn(|| git_command(path, &["stash", "list", "--format=%gd%x1f%s"]));
            let graph = scope.spawn(|| {
                git_command(
                    path,
                    &["log", "--all", "--date-order", log_format, "-n", &log_limit],
                )
            });

            let status = status
                .join()
                .map_err(|_| "git status worker stopped".to_string())??;
            let branches = branches
                .join()
                .map_err(|_| "git branch worker stopped".to_string())?
                .unwrap_or_default();
            let remotes = remotes
                .join()
                .map_err(|_| "git remote worker stopped".to_string())?
                .unwrap_or_default();
            let stash = stash
                .join()
                .map_err(|_| "git stash worker stopped".to_string())?
                .unwrap_or_default();
            let graph = graph
                .join()
                .map_err(|_| "git graph worker stopped".to_string())?;
            Ok((status, branches, remotes, stash, graph))
        },
    )?;

    let (mut status, head) = parse_git_status(&status_raw);
    status.branches = parse_git_branches(&branches_raw, &status.branch);
    status.remotes = parse_git_remotes(&remotes_raw);
    apply_stash(&mut status, &stash_raw);
    status.operation = git_operation(path);
    status.detached = status.branch.is_empty();

    Ok(GitOverview {
        status,
        graph: parse_git_graph(graph_raw, head),
    })
}

fn parse_git_status(raw: &str) -> (GitStatus, String) {
    let records: Vec<&str> = raw.split('\0').collect();
    let mut status = GitStatus::default();
    let mut head = String::new();
    let mut index = 0;
    while index < records.len() {
        let record = records[index];
        index += 1;
        if let Some(value) = record.strip_prefix("# branch.oid ") {
            if value != "(initial)" {
                head = value.to_string();
            }
            continue;
        }
        if let Some(value) = record.strip_prefix("# branch.head ") {
            if value != "(detached)" {
                status.branch = value.to_string();
            }
            continue;
        }
        if let Some(value) = record.strip_prefix("# branch.ab ") {
            let mut drift = value.split_whitespace();
            status.ahead = drift
                .next()
                .and_then(|part| part.strip_prefix('+'))
                .and_then(|part| part.parse().ok())
                .unwrap_or(0);
            status.behind = drift
                .next()
                .and_then(|part| part.strip_prefix('-'))
                .and_then(|part| part.parse().ok())
                .unwrap_or(0);
            continue;
        }
        if let Some(value) = record.strip_prefix("# stash ") {
            status.stash_count = value.parse().unwrap_or(0);
            continue;
        }

        match record.as_bytes().first().copied() {
            Some(b'1') => {
                let parts: Vec<&str> = record.splitn(9, ' ').collect();
                if parts.len() == 9 {
                    apply_git_file(&mut status, parts[1], parts[8], None);
                }
            }
            Some(b'2') => {
                let parts: Vec<&str> = record.splitn(10, ' ').collect();
                if parts.len() == 10 {
                    let old_path = records.get(index).map(|path| (*path).to_string());
                    if old_path.is_some() {
                        index += 1;
                    }
                    apply_git_file(&mut status, parts[1], parts[9], old_path);
                }
            }
            Some(b'u') => {
                let parts: Vec<&str> = record.splitn(11, ' ').collect();
                if parts.len() == 11 {
                    apply_git_file(&mut status, parts[1], parts[10], None);
                }
            }
            Some(b'?') => {
                if let Some(path) = record.strip_prefix("? ") {
                    status.untracked.push(path.to_string());
                }
            }
            _ => {}
        }
    }
    (status, head)
}

fn apply_git_file(status: &mut GitStatus, code: &str, path: &str, old_path: Option<String>) {
    if code == "??" {
        status.untracked.push(path.to_string());
        return;
    }
    let entry = |code: char| GitFileEntry {
        path: path.to_string(),
        code: code.to_string(),
        old_path: old_path.clone(),
    };
    if matches!(code, "DD" | "AU" | "UD" | "UA" | "DU" | "AA" | "UU") {
        status.conflicts.push(GitFileEntry {
            path: path.to_string(),
            code: code.to_string(),
            old_path,
        });
        return;
    }
    let mut columns = code.chars();
    let staged = columns.next().unwrap_or('.');
    let unstaged = columns.next().unwrap_or('.');
    if !matches!(staged, '.' | '?') {
        status.staged.push(entry(staged));
    }
    if !matches!(unstaged, '.' | '?') {
        status.unstaged.push(entry(unstaged));
    }
}

fn parse_git_branches(raw: &str, current: &str) -> Vec<GitBranch> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    raw.lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.splitn(4, '\t').collect();
            let name = parts.first()?.to_string();
            let timestamp = parts
                .get(2)
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(0);
            Some(GitBranch {
                current: name == current,
                name,
                upstream: parts.get(1).copied().unwrap_or_default().to_string(),
                age: parts.get(3).copied().unwrap_or_default().to_string(),
                old: timestamp > 0 && now.saturating_sub(timestamp) > 60 * 24 * 60 * 60,
            })
        })
        .collect()
}

fn parse_git_remotes(raw: &str) -> Vec<GitRemote> {
    let mut remotes: Vec<GitRemote> = Vec::new();
    for line in raw.lines() {
        let mut parts = line.split_whitespace();
        let Some(name) = parts.next() else { continue };
        let Some(url) = parts.next() else { continue };
        if parts.next() != Some("(fetch)") {
            continue;
        }
        if let Some(found) = remotes.iter_mut().find(|remote| remote.name == name) {
            found.url = url.to_string();
        } else {
            remotes.push(GitRemote {
                name: name.to_string(),
                url: url.to_string(),
            });
        }
    }
    remotes
}

fn apply_stash(status: &mut GitStatus, raw: &str) {
    let rows: Vec<&str> = raw.lines().filter(|line| !line.is_empty()).collect();
    status.stash_count = rows.len();
    status.latest_stash = rows
        .first()
        .and_then(|line| line.split_once('\u{1f}'))
        .map(|(_, subject)| subject.to_string())
        .unwrap_or_default();
}

fn git_operation(root: &Path) -> String {
    let marker = root.join(".git");
    let git_dir = if marker.is_dir() {
        marker
    } else {
        let Ok(pointer) = fs::read_to_string(marker) else {
            return String::new();
        };
        let Some(path) = pointer.trim().strip_prefix("gitdir:") else {
            return String::new();
        };
        let path = PathBuf::from(path.trim());
        if path.is_absolute() {
            path
        } else {
            root.join(path)
        }
    };
    for (operation, markers) in [
        ("rebase", &["rebase-merge", "rebase-apply"][..]),
        ("merge", &["MERGE_HEAD"][..]),
        ("cherry-pick", &["CHERRY_PICK_HEAD"][..]),
        ("revert", &["REVERT_HEAD"][..]),
    ] {
        if markers.iter().any(|marker| git_dir.join(marker).exists()) {
            return operation.to_string();
        }
    }
    String::new()
}

fn parse_git_graph(raw: Result<String, String>, head: String) -> GitGraph {
    let raw = match raw {
        Ok(raw) => raw,
        Err(error) => {
            return GitGraph {
                commits: Vec::new(),
                head,
                lanes: 1,
                error: Some(error),
            };
        }
    };
    let mut commits: Vec<GitCommit> = raw
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.splitn(6, '\u{1f}').collect();
            if parts.len() != 6 {
                return None;
            }
            let refs = parts[2]
                .split(", ")
                .filter_map(|raw_ref| {
                    let raw_ref = raw_ref.trim();
                    let (name, kind) = if let Some(name) = raw_ref.strip_prefix("HEAD -> ") {
                        (name, "head")
                    } else if raw_ref == "HEAD" {
                        ("HEAD", "head")
                    } else if let Some(name) = raw_ref.strip_prefix("tag: ") {
                        (name, "tag")
                    } else if raw_ref.starts_with("origin/") || raw_ref.contains('/') {
                        (raw_ref, "remote")
                    } else if !raw_ref.is_empty() {
                        (raw_ref, "branch")
                    } else {
                        return None;
                    };
                    Some(GitCommitRef {
                        name: name.to_string(),
                        kind: kind.to_string(),
                    })
                })
                .collect();
            Some(GitCommit {
                sha: parts[0].to_string(),
                short: parts[0].chars().take(7).collect(),
                parents: parts[1].split_whitespace().map(str::to_string).collect(),
                refs,
                subject: parts[3].to_string(),
                author: parts[4].to_string(),
                age: parts[5].to_string(),
                lane: 0,
                color: String::new(),
            })
        })
        .collect();

    const COLORS: &[&str] = &[
        "#7c5cff", "#3fb950", "#f0883e", "#58a6ff", "#db61a2", "#e3b341", "#39c5cf", "#f85149",
        "#a371f7", "#56d364",
    ];
    let mut active: Vec<Option<String>> = Vec::new();
    for commit in &mut commits {
        let lane = git_lane(&mut active, &commit.sha);
        commit.lane = lane;
        commit.color = COLORS[lane % COLORS.len()].to_string();
        if let Some(parent) = commit.parents.first() {
            active[lane] = Some(parent.clone());
            for parent in commit.parents.iter().skip(1) {
                if !active
                    .iter()
                    .any(|waiting| waiting.as_ref() == Some(parent))
                {
                    git_lane(&mut active, parent);
                }
            }
        } else {
            active[lane] = None;
        }
    }
    let lanes = commits.iter().map(|commit| commit.lane).max().unwrap_or(0) + 1;
    GitGraph {
        commits,
        head,
        lanes,
        error: None,
    }
}

fn git_lane(active: &mut Vec<Option<String>>, sha: &str) -> usize {
    if let Some(index) = active
        .iter()
        .position(|waiting| waiting.as_deref() == Some(sha))
    {
        return index;
    }
    if let Some(index) = active.iter().position(Option::is_none) {
        active[index] = Some(sha.to_string());
        return index;
    }
    active.push(Some(sha.to_string()));
    active.len() - 1
}

fn git_command(path: &Path, args: &[&str]) -> Result<String, String> {
    use std::process::Stdio;
    use std::sync::mpsc;

    // Local reads must not wait forever on Git or a filesystem helper. Drain both pipes
    // concurrently so a large status result cannot block the child before it exits.
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut child = crate::platform::command("git")
        .current_dir(path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;
    let mut stdout = child.stdout.take().expect("piped git stdout");
    let mut stderr = child.stderr.take().expect("piped git stderr");
    let (out_tx, out_rx) = mpsc::channel();
    let (err_tx, err_rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        let _ = out_tx.send(bytes);
    });
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stderr.read_to_end(&mut bytes);
        let _ = err_tx.send(bytes);
    });
    let timeout = || format!("git {} timed out after 20s", args.first().unwrap_or(&"read"));
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            result => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(result.err().map(|error| error.to_string()).unwrap_or_else(timeout));
            }
        }
    };
    let stdout = out_rx.recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .map_err(|_| timeout())?;
    let stderr = err_rx.recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .map_err(|_| timeout())?;
    if status.success() {
        return Ok(String::from_utf8_lossy(&stdout).into_owned());
    }
    let error = String::from_utf8_lossy(&stderr).trim().to_string();
    Err(if error.is_empty() { "git command failed".to_string() } else { error })
}

fn apply_git_status(state: &mut GitState, status: &str) {
    for line in status.lines() {
        if let Some(branch) = line.strip_prefix("# branch.head ") {
            state.branch = if branch == "(detached)" {
                "HEAD"
            } else {
                branch
            }
            .to_string();
        } else if let Some(drift) = line.strip_prefix("# branch.ab ") {
            let mut parts = drift.split_whitespace();
            state.ahead = parts
                .next()
                .and_then(|value| value.strip_prefix('+'))
                .and_then(|value| value.parse().ok())
                .unwrap_or(0);
            state.behind = parts
                .next()
                .and_then(|value| value.strip_prefix('-'))
                .and_then(|value| value.parse().ok())
                .unwrap_or(0);
        } else if !line.is_empty() && !line.starts_with("# ") {
            state.dirty += 1;
        }
    }
}

/// The fallback working set: uncommitted files.
///
/// Deterministic and always available, but it only knows *that* a file changed. When the
/// agent has declared a worklist, that always wins — it carries the reasons.
pub fn git_working_set(path: &Path) -> Vec<WorkFile> {
    let Some(out) = git(path, &["status", "--porcelain", "--untracked-files=all"]) else {
        return Vec::new();
    };
    let exclusions = modules(path)
        .map(|configured| configured.work_exclude)
        .unwrap_or_default();
    out.lines()
        .filter_map(|line| {
            let line = line.trim_end();
            if line.len() < 4 {
                return None;
            }
            let (status, file) = line.split_at(3);
            // A rename reads "R  old -> new"; the new name is the one to open.
            let file = file.rsplit(" -> ").next().unwrap_or(file);
            let file = file.trim().replace('\\', "/");
            if exclusions.iter().any(|excluded| file.contains(excluded)) {
                return None;
            }
            // Work is a text editor, not a second Git status screen. Deleted paths, directories,
            // binary media and generated sidecars stay visible in Git and never become broken
            // editor buttons here.
            if !editable_text_file(&path.join(&file)) {
                return None;
            }
            Some(WorkFile {
                path: file,
                why: Some(describe(status.trim())),
            })
        })
        .collect()
}

fn editable_text_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    let Ok(file) = fs::File::open(path) else {
        return false;
    };
    let mut sample = Vec::new();
    if file.take(8192).read_to_end(&mut sample).is_err() {
        return false;
    }
    !sample.contains(&0) && std::str::from_utf8(&sample).is_ok()
}

/// Every changed path in the working tree, keyed by project-relative path.
///
/// Deliberately NOT `git_working_set`. That one is a curated worklist — it drops deleted paths,
/// binaries and excluded sidecars, because those make bad editor buttons. The file tree has the
/// opposite job: it must be able to say a folder is dirty even when the only dirty thing inside
/// it is a deleted PNG. So this reports the raw truth and lets the tree decide what to draw.
///
/// The value is one of `modified` / `added` / `deleted` / `renamed` / `untracked` / `conflict`.
pub fn git_file_states(path: &Path) -> HashMap<String, String> {
    let mut states = HashMap::new();
    let Some(out) = git(path, &["status", "--porcelain", "--untracked-files=all"]) else {
        return states;
    };
    for line in out.lines() {
        let line = line.trim_end();
        if line.len() < 4 {
            continue;
        }
        let (status, file) = line.split_at(3);
        // A rename reads "R  old -> new". The new name is the one the tree can show.
        let file = file.rsplit(" -> ").next().unwrap_or(file);
        let file = file.trim().trim_matches('"').replace('\\', "/");
        if file.is_empty() {
            continue;
        }
        states.insert(file, classify(status));
    }
    states
}

/// The two porcelain columns are index and working tree. A conflict shows a letter in BOTH, and
/// is the one state the tree must never soften into "modified".
fn classify(status: &str) -> String {
    let mut chars = status.chars();
    let index = chars.next().unwrap_or(' ');
    let tree = chars.next().unwrap_or(' ');
    let state = match (index, tree) {
        ('?', _) => "untracked",
        ('U', _) | (_, 'U') | ('A', 'A') | ('D', 'D') => "conflict",
        ('R', _) => "renamed",
        ('A', _) => "added",
        ('D', _) | (_, 'D') => "deleted",
        _ => "modified",
    };
    state.to_string()
}

/// The committed text of one file, or `None` when it is untracked, deleted at HEAD, or the
/// project is not a repository. Feeds the editor's change gutter, which is why it returns the
/// blob rather than a diff: the diff itself is computed once, in the frontend, and shared with
/// the conflict view so the two can never disagree.
pub fn git_head_file(root: &Path, relative: &str) -> Option<String> {
    // `--` guards a path that looks like a revision. A file named `HEAD` is rare and real.
    let out = crate::platform::command("git")
        .current_dir(root)
        .args(["show", &format!("HEAD:{relative}"), "--"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    // Not `from_utf8_lossy().trim()`: trimming would drop the file's own trailing newline and
    // make the last line read as changed on every single file.
    String::from_utf8(out.stdout).ok()
}

fn describe(status: &str) -> String {
    match status {
        "??" => "new, untracked",
        "M" | "MM" | " M" => "modified",
        "A" | "A " => "added",
        "D" | " D" => "deleted",
        s if s.starts_with('R') => "renamed",
        _ => "changed",
    }
    .to_string()
}

pub(crate) fn git(path: &Path, args: &[&str]) -> Option<String> {
    let out = crate::platform::command("git")
        .current_dir(path)
        .args(args)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn main_folder_is_the_deepest_shared_parent() {
        let paths = |list: &[&str]| list.iter().map(PathBuf::from).collect::<Vec<_>>();
        assert_eq!(
            common_parent(&paths(&["/u/projects/apps/a", "/u/projects/apps/b", "/u/projects/c"])),
            Some(PathBuf::from("/u/projects"))
        );
        // Sharing a prefix of a NAME is not sharing a folder.
        assert_eq!(
            common_parent(&paths(&["/u/app", "/u/apple/x"])),
            Some(PathBuf::from("/u"))
        );
        assert_eq!(common_parent(&paths(&["/u/projects/a"])), Some(PathBuf::from("/u/projects")));
        assert_eq!(common_parent(&[]), None);
    }

    fn all_installed() -> HashSet<String> {
        [
            "git-manager",
            "release-manager",
            "revenuecat",
            "analytics",
            "product-spine",
        ]
            .into_iter()
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn a_porcelain_rename_reports_the_new_name() {
        // "R  old.dart -> new.dart" — opening `old.dart` would 404, so the arrow matters.
        let line = "R  lib/old.dart -> lib/new.dart";
        let (status, file) = line.split_at(3);
        let file = file.rsplit(" -> ").next().unwrap();
        assert_eq!(file.trim(), "lib/new.dart");
        assert_eq!(describe(status.trim()), "renamed");
    }

    #[test]
    fn porcelain_v2_builds_one_dashboard_snapshot() {
        let mut state = GitState::default();
        apply_git_status(
            &mut state,
            "# branch.oid abc123\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -1\n1 .M N... 100644 100644 100644 abc123 abc123 src/main.rs\n? note.md",
        );
        assert_eq!(state.branch, "main");
        assert_eq!((state.ahead, state.behind, state.dirty), (2, 1, 2));
    }

    #[test]
    fn native_git_overview_keeps_status_and_history_together() {
        let root = std::env::temp_dir().join(format!("panel-git-overview-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        git_command(&root, &["init", "-q"]).unwrap();
        git_command(&root, &["config", "user.email", "panel@example.test"]).unwrap();
        git_command(&root, &["config", "user.name", "Panel Test"]).unwrap();
        fs::write(root.join("tracked file.txt"), "one\n").unwrap();
        fs::write(root.join("rename me.txt"), "move\n").unwrap();
        git_command(&root, &["add", "-A"]).unwrap();
        git_command(&root, &["commit", "-qm", "Seed overview"]).unwrap();

        fs::write(root.join("tracked file.txt"), "one\ntwo\n").unwrap();
        git_command(&root, &["add", "--", "tracked file.txt"]).unwrap();
        fs::write(root.join("tracked file.txt"), "one\ntwo\nthree\n").unwrap();
        git_command(&root, &["mv", "rename me.txt", "renamed file.txt"]).unwrap();
        fs::write(root.join("new file.txt"), "new\n").unwrap();

        let overview = git_overview(&root, 20).unwrap();
        assert!(!overview.status.branch.is_empty());
        assert!(overview
            .status
            .staged
            .iter()
            .any(|entry| entry.path == "tracked file.txt"));
        assert!(overview
            .status
            .unstaged
            .iter()
            .any(|entry| entry.path == "tracked file.txt"));
        assert_eq!(overview.status.untracked, ["new file.txt"]);
        assert!(overview.status.staged.iter().any(|entry| {
            entry.path == "renamed file.txt" && entry.old_path.as_deref() == Some("rename me.txt")
        }));
        assert_eq!(overview.graph.commits[0].subject, "Seed overview");
        assert_eq!(overview.graph.head, overview.graph.commits[0].sha);
        let json = serde_json::to_value(&overview).unwrap();
        assert!(json["status"].get("stashCount").is_some());
        assert!(json["status"].get("stash_count").is_none());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_project_can_own_its_optional_module_set() {
        let root = std::env::temp_dir().join(format!("panel-modules-test-{}", std::process::id()));
        let panel = root.join(".panel");
        fs::create_dir_all(&panel).unwrap();
        fs::write(
            panel.join("modules.json"),
            r#"{"version":1,"enabled":["git","release","git"]}"#,
        )
        .unwrap();
        let configured = modules_with_installed(&root, &all_installed()).unwrap();
        assert!(configured.configured);
        assert_eq!(configured.enabled, ["git", "release"]);
        let only_git = HashSet::from(["git-manager".to_string()]);
        assert_eq!(
            modules_with_installed(&root, &only_git).unwrap().enabled,
            ["git"]
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn an_unconfigured_project_earns_its_modules_from_the_repo() {
        let root = std::env::temp_dir().join(format!("panel-detect-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("ios/Runner")).unwrap();
        fs::create_dir_all(root.join("build")).unwrap();
        fs::write(
            root.join("pubspec.yaml"),
            "dependencies:\n  purchases_flutter: ^6.0.0\n",
        )
        .unwrap();
        fs::write(root.join("ios/Podfile"), "platform :ios, '13.0'\n").unwrap();
        // Inside a skipped build dir — a match here must NOT count.
        fs::write(root.join("build/google-services.json"), "{}").unwrap();

        let detected = modules_with_installed(&root, &all_installed()).unwrap();
        assert!(!detected.configured);
        assert!(detected.enabled.contains(&"release".to_string()));
        assert!(detected.enabled.contains(&"revenuecat".to_string()));
        assert!(!detected.enabled.contains(&"analytics".to_string()));
        assert!(!detected.enabled.contains(&"git".to_string()));

        // A Firebase config outside the skip list turns Analytics on.
        fs::write(root.join("ios/Runner/GoogleService-Info.plist"), "<plist/>").unwrap();
        assert!(modules_with_installed(&root, &all_installed())
            .unwrap()
            .enabled
            .contains(&"analytics".to_string()));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_godot_game_earns_release_from_its_export_presets() {
        let root = std::env::temp_dir().join(format!("panel-godot-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("assets")).unwrap();
        fs::write(
            root.join("project.godot"),
            "config/name=\"Game\"\nconfig/icon=\"res://assets/icon.png\"\n",
        )
        .unwrap();
        fs::write(root.join("assets/icon.png"), "png").unwrap();

        // Desktop-only exports ship to no store, so Release must stay off.
        fs::write(
            root.join("export_presets.cfg"),
            "[preset.0]\nname=\"Web\"\nplatform=\"Web\"\n",
        )
        .unwrap();
        assert!(!modules_with_installed(&root, &all_installed())
            .unwrap()
            .enabled
            .contains(&"release".to_string()));

        fs::write(
            root.join("export_presets.cfg"),
            "[preset.0]\nname=\"Web\"\nplatform=\"Web\"\n\n[preset.1]\nname=\"iOS\"\nplatform=\"iOS\"\n",
        )
        .unwrap();
        assert!(modules_with_installed(&root, &all_installed())
            .unwrap()
            .enabled
            .contains(&"release".to_string()));

        // The `res://` icon resolves against the project root.
        assert_eq!(godot_icon(&root), Some(root.join("assets/icon.png")));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_typed_collection_uses_its_app_icon_before_a_loose_root_icon() {
        let root = std::env::temp_dir().join(format!("panel-icon-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("assets")).unwrap();
        fs::write(root.join("appgea.json"), r#"{"appType":"flutter"}"#).unwrap();
        fs::write(
            root.join("pubspec.yaml"),
            "flutter_launcher_icons:\n  image_path: assets/app_icon.png\n",
        )
        .unwrap();
        fs::write(root.join("assets/app_icon.png"), "current app icon").unwrap();
        fs::write(root.join("icon.png"), "loose custom icon").unwrap();
        let project = Project {
            id: "icon-test".into(),
            name: "Icon Test".into(),
            path: root.clone(),
            exists: true,
            group: String::new(),
            role: ProjectRole::Collection,
            project_type: "generic".into(),
            parent_id: String::new(),
            extension_id: String::new(),
        };

        assert_eq!(
            app_icon(&project),
            root.join("assets/app_icon.png").canonicalize().ok()
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn desktop_and_nested_web_app_icons_are_discovered() {
        let root = std::env::temp_dir().join(format!("panel-package-icons-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("next/apps/desktop/src-tauri/icons")).unwrap();
        let desktop = root.join("next/apps/desktop/src-tauri/icons/icon.png");
        fs::write(&desktop, "desktop artwork").unwrap();
        assert_eq!(desktop_icon(&root), Some(desktop));

        fs::create_dir_all(root.join("src/app")).unwrap();
        let next_icon = root.join("src/app/favicon.ico");
        fs::write(&next_icon, "web artwork").unwrap();
        assert_eq!(web_icon(&root), Some(next_icon.clone()));
        fs::remove_file(next_icon).unwrap();

        fs::create_dir_all(root.join("pairdrop/public/images")).unwrap();
        fs::write(root.join("pairdrop/package.json"), "{}").unwrap();
        let nested_icon = root.join("pairdrop/public/images/apple-touch-icon.png");
        fs::write(&nested_icon, "nested web artwork").unwrap();
        assert_eq!(web_icon(&root), Some(nested_icon.clone()));

        fs::create_dir_all(root.join("node_modules/public")).unwrap();
        fs::write(root.join("node_modules/package.json"), "{}").unwrap();
        fs::write(root.join("node_modules/public/icon.png"), "dependency artwork").unwrap();
        fs::remove_file(nested_icon).unwrap();
        assert_eq!(web_icon(&root), None);

        fs::create_dir_all(root.join("apps/web/public")).unwrap();
        fs::write(root.join("apps/web/package.json"), "{}").unwrap();
        let workspace_icon = root.join("apps/web/public/favicon.svg");
        fs::write(&workspace_icon, "workspace artwork").unwrap();
        assert_eq!(web_icon(&root), Some(workspace_icon));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_website_gets_no_store_or_sdk_tabs() {
        let root = std::env::temp_dir().join(format!("panel-site-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join("index.html"), "<h1>hi</h1>").unwrap();

        let detected = modules_with_installed(&root, &all_installed()).unwrap();
        assert!(detected.enabled.contains(&"git".to_string()));
        assert!(!detected.enabled.contains(&"release".to_string()));
        assert!(!detected.enabled.contains(&"revenuecat".to_string()));
        assert!(!detected.enabled.contains(&"analytics".to_string()));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn legacy_decisions_module_names_resolve_to_product_spine() {
        let root = std::env::temp_dir().join(format!("panel-spine-test-{}", std::process::id()));
        let panel = root.join(".panel");
        fs::create_dir_all(&panel).unwrap();
        fs::write(
            panel.join("modules.json"),
            r#"{"version":1,"enabled":["decisions","decision-map","product-spine"]}"#,
        )
        .unwrap();
        let configured = modules_with_installed(&root, &all_installed()).unwrap();
        assert_eq!(configured.enabled, ["product-spine"]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn work_fallback_only_returns_existing_project_relevant_text() {
        let root = std::env::temp_dir().join(format!("panel-work-test-{}", std::process::id()));
        let panel = root.join(".panel");
        fs::create_dir_all(root.join("generated")).unwrap();
        fs::create_dir_all(&panel).unwrap();
        fs::write(
            panel.join("modules.json"),
            r#"{"version":1,"enabled":["git"],"work":{"exclude":["generated/"]}}"#,
        )
        .unwrap();
        fs::write(root.join("note.md"), "human-readable\n").unwrap();
        fs::write(root.join("image.bin"), [0, 159, 146, 150]).unwrap();
        fs::write(root.join("generated/cache.txt"), "derived\n").unwrap();
        let initialized = crate::platform::command("git").arg("init").arg(&root).output().unwrap();
        assert!(initialized.status.success());

        let files = git_working_set(&root);
        assert!(files.iter().any(|file| file.path == "note.md"));
        assert!(!files.iter().any(|file| file.path == "image.bin"));
        assert!(!files.iter().any(|file| file.path.contains("generated/")));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn external_work_fallback_never_points_at_missing_files() {
        let Ok(root) = std::env::var("PANEL_WORK_FIXTURE_ROOT") else {
            return;
        };
        let root = PathBuf::from(root);
        let files = git_working_set(&root);
        eprintln!("editable work files: {}", files.len());
        assert!(files.iter().all(|file| root.join(&file.path).is_file()));
        assert!(files
            .iter()
            .all(|file| editable_text_file(&root.join(&file.path))));
    }
}

