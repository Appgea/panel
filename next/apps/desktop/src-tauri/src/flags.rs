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

fn read() -> Result<Value, String> {
    match std::fs::read_to_string(flags_path()) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|error| format!("flags.json: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({ "version": 1, "flags": {} })),
        Err(error) => Err(error.to_string()),
    }
}

/// The whole document. A missing file reads as no flags, not as an error.
#[tauri::command]
pub fn flags_read() -> Result<Value, String> {
    read()
}

/// One change, read-modify-written, so a script or agent editing another flag is not overwritten.
/// No `repo` sets the default. A `repo` with no `on` drops that repo's override.
#[tauri::command]
pub fn flags_set(name: String, repo: Option<String>, on: Option<bool>) -> Result<Value, String> {
    let mut doc = read()?;
    let flag = doc
        .get_mut("flags")
        .and_then(|flags| flags.get_mut(&name))
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
                Some(on) => repos.insert(repo, json!(on)),
                None => repos.remove(&repo),
            };
        }
        (None, None) => return Err("nothing to set".into()),
    }
    // Write beside, then rename: a reader never sees half a file.
    let path = flags_path();
    let temp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(&doc).map_err(|error| error.to_string())?;
    std::fs::write(&temp, bytes).map_err(|error| error.to_string())?;
    std::fs::rename(&temp, &path).map_err(|error| error.to_string())?;
    Ok(doc)
}
