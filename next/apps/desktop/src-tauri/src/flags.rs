//! Flags: switches the human turns on and off in Settings, read by their agents' scripts.
//!
//! The file is `~/.appgeapanel/flags.json`, machine state beside `config.json`. Panel does not
//! know any flag by name: each one declares its own `name` and `note`, so the ops tree that reads
//! a flag also defines it. A flag holds `on`, its default, and `repos`, overrides keyed by the
//! repo folder name.
//!
//! ```json
//! { "version": 1, "flags": { "pr_flow": { "name": "…", "note": "…", "on": false, "repos": { "panel": true } } } }
//! ```

use serde_json::{json, Value};
use std::path::PathBuf;

fn flags_path() -> PathBuf {
    crate::paths::user_root().join("flags.json")
}

/// The raw text beside the parsed document, so a write can tell whether the file moved under it.
fn read_raw() -> Result<(String, Value), String> {
    match std::fs::read_to_string(flags_path()) {
        Ok(raw) => {
            let doc = serde_json::from_str(&raw).map_err(|error| format!("flags.json: {error}"))?;
            Ok((raw, doc))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok((String::new(), json!({ "version": 1, "flags": {} })))
        }
        Err(error) => Err(error.to_string()),
    }
}

/// The whole document. A missing file reads as no flags, not as an error.
#[tauri::command]
pub fn flags_read() -> Result<Value, String> {
    read_raw().map(|(_, doc)| doc)
}

/// One change, read-modify-written, so a script or agent editing another flag is kept.
/// No `repo` sets the default. A `repo` with no `on` drops that repo's override.
///
/// Just before the rename it reads the file again. Changed since the first read: someone else
/// wrote it, so it starts over from their version rather than drop their edit. Best effort: an
/// edit landing in the instant between that check and the rename is still lost. The other
/// writers are a person and an agent editing by hand, so a lock both sides honour is not worth it.
#[tauri::command]
pub fn flags_set(name: String, repo: Option<String>, on: Option<bool>) -> Result<Value, String> {
    for _ in 0..5 {
        let (before, mut doc) = read_raw()?;
        apply(&mut doc, &name, repo.as_deref(), on)?;
        let path = flags_path();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |time| time.subsec_nanos());
        // A unique temp name, so two writers never share one. Rename means no reader sees half a file.
        let temp = path.with_extension(format!("json.{}.{nanos}.tmp", std::process::id()));
        let bytes = serde_json::to_vec_pretty(&doc).map_err(|error| error.to_string())?;
        std::fs::write(&temp, bytes).map_err(|error| {
            let _ = std::fs::remove_file(&temp);
            error.to_string()
        })?;
        // Unreadable now, or changed: either way this temp is not the file to keep.
        match read_raw() {
            Ok((now, _)) if now == before => {}
            Ok(_) => {
                let _ = std::fs::remove_file(&temp);
                continue;
            }
            Err(error) => {
                let _ = std::fs::remove_file(&temp);
                return Err(error);
            }
        }
        std::fs::rename(&temp, &path).map_err(|error| {
            let _ = std::fs::remove_file(&temp);
            error.to_string()
        })?;
        return Ok(doc);
    }
    Err("flags.json kept changing while saving. Try again.".into())
}

fn apply(doc: &mut Value, name: &str, repo: Option<&str>, on: Option<bool>) -> Result<(), String> {
    let flag = doc
        .get_mut("flags")
        .and_then(|flags| flags.get_mut(name))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| format!("no flag named {name}"))?;
    match (repo, on) {
        (None, Some(on)) => {
            flag.insert("on".into(), json!(on));
        }
        (Some(repo), on) => {
            let repos = flag.entry("repos").or_insert_with(|| json!({}));
            let repos = repos.as_object_mut().ok_or("flags.json: repos is not an object")?;
            match on {
                Some(on) => repos.insert(repo.to_string(), json!(on)),
                None => repos.remove(repo),
            };
        }
        (None, None) => return Err("nothing to set".into()),
    }
    Ok(())
}
