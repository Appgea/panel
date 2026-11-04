//! Skill inventory and edits. Session activation is handled by the session owner.
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

const MAX_BYTES: u64 = 512 * 1024;
const MAX_ENTRIES: usize = 3000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillEntry {
    pub path: String,
    pub name: String,
    pub description: String,
    pub body: String,
    pub provider: String,
    pub source: String,
    pub scope: String,
    pub editable: bool,
    pub archived: bool,
    pub department: String,
}

#[derive(Clone)]
struct Known {
    entry: SkillEntry,
    target: PathBuf,
}
static KNOWN: OnceLock<Mutex<HashMap<String, Known>>> = OnceLock::new();
static WRITES: Mutex<()> = Mutex::new(());
fn known() -> &'static Mutex<HashMap<String, Known>> {
    KNOWN.get_or_init(|| Mutex::new(HashMap::new()))
}
fn home() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or("Home directory unavailable".into())
}
fn root() -> PathBuf {
    crate::paths::user_root().join("skills")
}
fn department(dir: &Path) -> String {
    fs::read_to_string(dir.join(".department"))
        .unwrap_or_else(|_| "general".into()).trim().into()
}

fn native_roots() -> Result<Vec<(PathBuf, &'static str)>, String> {
    let home = home()?;
    let claude = std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from)
        .unwrap_or(home.join(".claude"));
    let codex = std::env::var_os("CODEX_HOME").map(PathBuf::from)
        .unwrap_or(home.join(".codex"));
    Ok(vec![(claude.join("skills"), "claude"), (codex.join("skills"), "codex"),
        (home.join(".agents/skills"), "shared")])
}

fn bindings(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let name = dir.file_name().ok_or("Invalid skill folder")?;
    Ok(native_roots()?.into_iter().map(|(root, _)| root.join(name)).collect())
}

fn check_bindings(dir: &Path) -> Result<(), String> {
    for link in bindings(dir)? {
        if fs::symlink_metadata(&link).is_ok()
            && link.canonicalize().ok().as_deref() != Some(dir) {
            return Err(format!("Skill name already exists at {}", link.display()));
        }
    }
    Ok(())
}

fn connect(dir: &Path) -> Result<(), String> {
    check_bindings(dir)?;
    let mut created = Vec::new();
    let result = (|| -> Result<(), String> {
        for link in bindings(dir)? {
            if fs::symlink_metadata(&link).is_ok() { continue; }
            fs::create_dir_all(link.parent().ok_or("Invalid skill link")?).map_err(|e| e.to_string())?;
            crate::platform::link_dir(dir, &link)?;
            created.push(link);
        }
        Ok(())
    })();
    if result.is_err() { for link in created { let _ = crate::platform::remove_link(&link); } }
    result
}
fn bounded_read(path: &Path) -> Result<String, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("Skill must be a regular file".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("Skill exceeds 512 KiB".into());
    }
    String::from_utf8(bytes).map_err(|e| e.to_string())
}

fn scalar(value: &str) -> String {
    let value = value.trim();
    if value.starts_with('"') {
        serde_json::from_str::<String>(value).unwrap_or_else(|_| value.trim_matches('"').into())
    } else if value.len() >= 2 && value.starts_with('\'') && value.ends_with('\'') {
        value[1..value.len() - 1].replace("''", "'")
    } else {
        value.into()
    }
}
fn split(raw: &str) -> Option<(&str, &str)> {
    let raw = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let first = raw.find('\n')?;
    if raw[..first].trim_end() != "---" {
        return None;
    }
    let mut offset = first + 1;
    for line in raw[offset..].split_inclusive('\n') {
        if line.trim() == "---" {
            return Some((&raw[first + 1..offset], raw[offset + line.len()..].trim()));
        }
        offset += line.len();
    }
    None
}
fn field(header: &str, key: &str) -> String {
    let mut lines = header.lines().peekable();
    while let Some(line) = lines.next() {
        if let Some(value) = line.strip_prefix(&format!("{key}:")) {
            let value = value.trim();
            if matches!(value, ">" | "|" | ">-" | "|-" | ">+" | "|+") {
                let mut parts = Vec::new();
                while let Some(next) = lines.peek() {
                    if !next.starts_with(' ') && !next.starts_with('\t') && !next.is_empty() {
                        break;
                    }
                    parts.push(lines.next().unwrap().trim());
                }
                return parts
                    .join(if value.starts_with('|') { "\n" } else { " " })
                    .trim()
                    .into();
            }
            return scalar(value);
        }
    }
    String::new()
}

fn scan(
    dir: &Path,
    provider: &str,
    source: &str,
    scope: &Path,
    depth: usize,
    visited: &mut HashSet<PathBuf>,
    found: &mut Vec<Known>,
) {
    if depth > 6 || found.len() >= MAX_ENTRIES || visited.len() >= MAX_ENTRIES {
        return;
    }
    let Ok(canonical) = dir.canonicalize() else {
        return;
    };
    if !visited.insert(canonical) {
        return;
    }
    let file = dir.join("SKILL.md");
    if file.is_file() {
        if let (Ok(target), Ok(raw)) = (file.canonicalize(), bounded_read(&file)) {
            let (header, body) = split(&raw).unwrap_or(("", raw.trim()));
            let parsed_name = field(header, "name");
            let name = if parsed_name.is_empty() {
                dir.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned()
            } else {
                parsed_name
            };
            found.push(Known {
                target,
                entry: SkillEntry {
                    path: file.to_string_lossy().into_owned(),
                    name,
                    description: field(header, "description"),
                    body: body.into(),
                    provider: provider.into(),
                    source: source.into(),
                    scope: scope.to_string_lossy().into_owned(),
                    editable: source != "plugin",
                    archived: source == "panel" && dir.join(".archived").exists(),
                    department: department(dir),
                },
            });
        }
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.take(MAX_ENTRIES).flatten() {
        let path = entry.path();
        if path.is_dir() {
            scan(&path, provider, source, scope, depth + 1, visited, found);
        }
    }
}

pub fn catalog(cwd: Option<PathBuf>) -> Result<Vec<SkillEntry>, String> {
    let home = home()?;
    let mut roots = vec![(root(), "shared", "panel")];
    for (dir, provider) in native_roots()? {
        roots.push((dir, provider, "personal"));
    }
    if let Some(cwd) = cwd {
        let cwd = cwd.canonicalize().map_err(|e| e.to_string())?;
        for ancestor in cwd.ancestors().take(32) {
            if ancestor == home {
                continue;
            }
            for (folder, provider) in [
                (".claude/skills", "claude"),
                (".codex/skills", "codex"),
                (".agents/skills", "shared"),
            ] {
                roots.push((ancestor.join(folder), provider, "project"));
            }
        }
    }
    // Claude's installed manifest excludes stale cached plugin versions.
    if let Ok(raw) = bounded_read(&home.join(".claude/plugins/installed_plugins.json")) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(plugins) = value.get("plugins").and_then(|v| v.as_object()) {
                for installs in plugins.values() {
                    if let Some(installs) = installs.as_array() {
                        for install in installs.iter().take(100) {
                            if let Some(path) = install.get("installPath").and_then(|v| v.as_str())
                            {
                                roots.push((
                                    PathBuf::from(path).join("skills"),
                                    "claude",
                                    "plugin",
                                ));
                            }
                        }
                    }
                }
            }
        }
    }
    // Codex exposes cached skill packages; source explicitly identifies these as plugins.
    roots.push((home.join(".codex/plugins/cache"), "codex", "plugin"));
    let mut found = Vec::new();
    for (dir, provider, source) in roots {
        scan(
            &dir,
            provider,
            source,
            &dir,
            0,
            &mut HashSet::new(),
            &mut found,
        );
    }
    // Panel is scanned first. Native symlinks must not duplicate the shared definition.
    let mut targets = HashSet::new();
    let mut result: Vec<_> = found.iter().filter(|k| targets.insert(k.target.clone()))
        .map(|k| k.entry.clone()).collect();
    result.sort_by(|a, b| (&a.department, &a.name, &a.path).cmp(&(&b.department, &b.name, &b.path)));
    let mut registry = known().lock().map_err(|_| "Skill registry unavailable")?;
    for item in found {
        registry.insert(item.entry.path.clone(), item);
    }
    Ok(result)
}

fn authorized(path: &str) -> Result<Known, String> {
    if !known()
        .lock()
        .map_err(|_| "Skill registry unavailable")?
        .contains_key(path)
    {
        catalog(None)?;
    }
    let item = known()
        .lock()
        .map_err(|_| "Skill registry unavailable")?
        .get(path)
        .cloned()
        .ok_or("Refresh the skill library before opening this path")?;
    if Path::new(path).canonicalize().map_err(|e| e.to_string())? != item.target {
        return Err("Skill path changed. Refresh the library".into());
    }
    Ok(item)
}
pub fn read(path: String) -> Result<String, String> {
    let item = authorized(&path)?;
    bounded_read(&item.target)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDocument {
    pub entry: SkillEntry,
    pub content: String,
}

pub fn read_document(path: String) -> Result<SkillDocument, String> {
    let mut item = authorized(&path)?;
    let content = bounded_read(&item.target)?;
    let (header, body) = split(&content).unwrap_or(("", content.trim()));
    let name = field(header, "name");
    if !name.is_empty() {
        item.entry.name = name;
    }
    item.entry.description = field(header, "description");
    item.entry.body = body.into();
    item.entry.department = department(item.target.parent().ok_or("Invalid skill path")?);
    item.entry.archived = item.entry.source == "panel"
        && item
            .target
            .parent()
            .is_some_and(|p| p.join(".archived").exists());
    Ok(SkillDocument {
        entry: item.entry,
        content,
    })
}

/// A file inside the selected skill's folder. No `..`, no hidden parts, no symlink on the way:
/// the browser may read any of them, so none may lead outside the folder.
fn reference_target(item: &Known, relative: &str) -> Result<PathBuf, String> {
    let parts: Vec<_> = Path::new(relative).components().collect();
    if parts.is_empty() || !parts.iter().all(|part| matches!(part,
        std::path::Component::Normal(p) if !p.to_string_lossy().starts_with('.'))) {
        return Err("Use a path inside the skill folder, like references/topic.md".into());
    }
    let base = item.target.parent().ok_or("Invalid skill path")?;
    let target = base.join(relative);
    // The nearest folder that exists must be its own real path. A new subfolder is made under it.
    let existing = target.ancestors().skip(1).find(|dir| fs::symlink_metadata(dir).is_ok())
        .ok_or("Invalid reference path")?;
    if existing.canonicalize().map_err(|e| e.to_string())? != existing {
        return Err("Skill folders cannot be symlinks".into());
    }
    if fs::symlink_metadata(&target).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("Skill files cannot be symlinks".into());
    }
    Ok(target)
}

const SKIP_DIRS: [&str; 4] = ["__pycache__", "node_modules", "target", "venv"];

/// Every file in the skill's folder, relative to it, so the browser can show the whole skill.
pub fn resources(path: String) -> Result<Vec<String>, String> {
    let item = authorized(&path)?;
    let base = item.target.parent().ok_or("Invalid skill path")?.to_path_buf();
    let mut files = Vec::new();
    let mut stack = vec![(base.clone(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.take(MAX_ENTRIES).flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(kind) = entry.file_type() else { continue };
            if name.starts_with('.') || kind.is_symlink() { continue; }
            if kind.is_dir() {
                if depth < 6 && !SKIP_DIRS.contains(&name.as_str()) { stack.push((entry.path(), depth + 1)); }
            } else if kind.is_file() && files.len() < MAX_ENTRIES {
                if let Ok(relative) = entry.path().strip_prefix(&base) {
                    files.push(relative.to_string_lossy().into_owned());
                }
            }
        }
    }
    files.sort();
    Ok(files)
}

pub fn resource_read(path: String, relative: String) -> Result<String, String> {
    bounded_read(&reference_target(&authorized(&path)?, &relative)?)
        .map_err(|e| if e.contains("utf-8") || e.contains("UTF-8") { "Not a text file".into() } else { e })
}

pub fn resource_save(path: String, relative: String, content: String, expected: Option<String>) -> Result<(), String> {
    let _guard = WRITES.lock().map_err(|_| "Skill write lock unavailable")?;
    let item = authorized(&path)?;
    if !item.entry.editable { return Err("Plugin references are read-only".into()); }
    if content.len() as u64 > MAX_BYTES { return Err("Reference exceeds 512 KiB".into()); }
    // SKILL.md goes through `save`, which keeps its header and discovery links right.
    // macOS volumes ignore case, so `skill.md` is the same file as SKILL.md.
    if !relative.ends_with(".md") || relative.eq_ignore_ascii_case("SKILL.md") {
        return Err("Only Markdown files other than SKILL.md are edited here".into());
    }
    let target = reference_target(&item, &relative)?;
    let parent = target.parent().ok_or("Invalid reference path")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    if let Some(expected) = expected {
        replace_expected(&target, &content, &expected)
    } else {
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&target).map_err(|e| e.to_string())?;
        file.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())
    }
}

fn replace_expected(target: &Path, raw: &str, expected: &str) -> Result<(), String> {
    let temp = target.with_file_name(format!(".SKILL-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temp).map_err(|e| e.to_string())?;
        file.write_all(raw.as_bytes()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        if bounded_read(target)? != expected { return Err("File changed on disk. Reopen it before saving".into()); }
        fs::set_permissions(&temp, fs::metadata(target).map_err(|e| e.to_string())?.permissions()).map_err(|e| e.to_string())?;
        fs::rename(&temp, target).map_err(|e| e.to_string())
    })();
    if result.is_err() { let _ = fs::remove_file(temp); }
    result
}

pub fn save(
    path: Option<String>,
    name: String,
    description: String,
    body: String,
    expected: Option<String>,
    selected_department: Option<String>,
) -> Result<SkillEntry, String> {
    let _guard = WRITES.lock().map_err(|_| "Skill write lock unavailable")?;
    let name = name.trim();
    if name.is_empty()
        || name.len() > 64
        || !name
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        || name.starts_with('-')
        || name.ends_with('-')
        || name.contains("--")
    {
        return Err(
            "Name must use lowercase letters, digits, and single hyphens, up to 64 characters"
                .into(),
        );
    }
    if description.trim().is_empty() || body.trim().is_empty() {
        return Err("Description and instructions are required".into());
    }
    let old = path.as_deref().map(authorized).transpose()?;
    let selected_department = selected_department.unwrap_or_else(|| old.as_ref()
        .map(|item| item.entry.department.clone()).unwrap_or_else(|| "general".into()));
    if !matches!(selected_department.as_str(), "general" | "company" | "legal" | "design") {
        return Err("Choose Company, Legal, Design, or General".into());
    }
    if let Some(item) = &old {
        if item.entry.source == "panel" {
            if name != item.entry.name { return Err("Shared skill names are fixed. Edit its description instead".into()); }
            check_bindings(item.target.parent().ok_or("Invalid skill path")?)?;
        }
    }
    let mut preserved = String::new();
    if let Some(item) = &old {
        if !item.entry.editable {
            return Err("Plugin skills are read-only. Create a shared copy".into());
        }
        let current = bounded_read(&item.target)?;
        if expected.as_deref() != Some(current.as_str()) {
            return Err("Skill changed on disk. Reopen it before saving".into());
        }
        // Preserve vendor-specific metadata and its nested values.
        if let Some((header, _)) = split(&current) {
            let mut skip = false;
            for line in header.lines() {
                if !line.starts_with(' ') && !line.starts_with('\t') && !line.is_empty() {
                    skip = line.starts_with("name:") || line.starts_with("description:");
                }
                if !skip {
                    preserved.push_str(line);
                    preserved.push('\n');
                }
            }
        }
    }
    let raw = format!(
        "---\nname: {}\ndescription: {}\n{}---\n\n{}\n",
        serde_json::to_string(name).map_err(|e| e.to_string())?,
        serde_json::to_string(description.trim()).map_err(|e| e.to_string())?,
        preserved,
        body.trim()
    );
    if raw.len() as u64 > MAX_BYTES {
        return Err("Skill exceeds 512 KiB".into());
    }
    let mut entry;
    let target;
    if let Some(item) = old {
        target = item.target;
        entry = item.entry;
        replace_expected(&target, &raw, expected.as_deref().unwrap_or(""))?;
    } else {
        fs::create_dir_all(root()).map_err(|e| e.to_string())?;
        let base = root().canonicalize().map_err(|e| e.to_string())?;
        let dir = base.join(name);
        check_bindings(&dir)?;
        fs::create_dir(&dir).map_err(|e| format!("Cannot create skill: {e}"))?;
        target = dir.join("SKILL.md");
        if let Err(error) = fs::write(&target, raw) {
            let _ = fs::remove_dir(&dir);
            return Err(error.to_string());
        }
        entry = SkillEntry {
            path: target.to_string_lossy().into_owned(),
            name: name.into(),
            description: String::new(),
            body: String::new(),
            provider: "shared".into(),
            source: "panel".into(),
            scope: base.to_string_lossy().into_owned(),
            editable: true,
            archived: false,
            department: selected_department.clone(),
        };
    }
    if entry.source == "panel" {
        let dir = target.parent().ok_or("Invalid skill path")?;
        connect(dir)?;
        fs::write(dir.join(".department"), &selected_department).map_err(|e| e.to_string())?;
        entry.department = selected_department;
        let marker = target
            .parent()
            .ok_or("Invalid skill path")?
            .join(".archived");
        if marker.exists() {
            fs::remove_file(marker).map_err(|e| e.to_string())?;
        }
    }
    entry.name = name.into();
    entry.description = description.trim().into();
    entry.body = body.trim().into();
    entry.archived = false;
    known()
        .lock()
        .map_err(|_| "Skill registry unavailable")?
        .insert(
            entry.path.clone(),
            Known {
                entry: entry.clone(),
                target,
            },
        );
    Ok(entry)
}

pub fn archive(path: String) -> Result<(), String> {
    let _guard = WRITES.lock().map_err(|_| "Skill write lock unavailable")?;
    let item = authorized(&path)?;
    let base = root().canonicalize().map_err(|e| e.to_string())?;
    let dir = item.target.parent().ok_or("Invalid skill path")?;
    if item.entry.source != "panel" || dir.parent() != Some(base.as_path()) {
        return Err("Only Panel shared skills can be archived".into());
    }
    let marker = dir.join(".archived");
    // Remove only links owned by this shared skill. Keep all source files recoverable.
    for link in bindings(dir)? {
        if fs::symlink_metadata(&link).is_ok_and(|m| m.file_type().is_symlink())
            && link.canonicalize().ok().as_deref() == Some(dir) {
            crate::platform::remove_link(&link)?;
        }
    }
    if !marker.exists() {
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(marker)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reference_edits_reject_stale_content_and_escape() {
        let dir = std::env::temp_dir().join(format!("panel-skills-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        let target = dir.join("SKILL.md");
        fs::write(&target, "---\nname: example\ndescription: Example\nmetadata:\n  owner: Appgea\n---\n\nOriginal\n").unwrap();
        let path = target.to_string_lossy().into_owned();
        known().lock().unwrap().insert(path.clone(), Known {
            target: target.clone(),
            entry: SkillEntry {
                path: path.clone(), name: "example".into(), description: "Example".into(),
                body: "Original".into(), provider: "claude".into(), source: "personal".into(),
                scope: dir.to_string_lossy().into_owned(), editable: true, archived: false,
                department: "general".into(),
            },
        });
        let original = read(path.clone()).unwrap();
        save(Some(path.clone()), "example".into(), "Revised".into(), "Updated instructions".into(), Some(original), None).unwrap();
        assert!(read(path.clone()).unwrap().contains("metadata:\n  owner: Appgea"));

        let relative = "references/decisions.md".to_string();
        resource_save(path.clone(), relative.clone(), "First decision".into(), None).unwrap();
        let before = resource_read(path.clone(), relative.clone()).unwrap();
        fs::write(dir.join(&relative), "Newer editor decision").unwrap();
        assert!(resource_save(path.clone(), relative.clone(), "Stale edit".into(), Some(before)).is_err());
        assert_eq!(resource_read(path.clone(), relative).unwrap(), "Newer editor decision");
        assert!(resource_save(path.clone(), "../outside.md".into(), "escape".into(), None).is_err());
        assert!(resource_save(path.clone(), "references/../../outside.md".into(), "escape".into(), None).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&target, dir.join("references/alias.md")).unwrap();
            assert!(resource_read(path.clone(), "references/alias.md".into()).is_err());
        }
        known().lock().unwrap().get_mut(&path).unwrap().entry.editable = false;
        assert!(resource_save(path.clone(), "references/new.md".into(), "plugin edit".into(), None).is_err());
        known().lock().unwrap().remove(&path);
        fs::remove_dir_all(dir).unwrap();
    }
}
