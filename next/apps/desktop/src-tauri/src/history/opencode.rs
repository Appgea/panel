//! opencode sessions, read from `~/.local/share/opencode/opencode.db`.
//!
//! `session` names each one, `message` carries the role, model and tokens of every turn, and
//! `part` the text and the files each step patched. A child session (a subagent's) spends tokens
//! but is not listed.

use super::{iso_from_ms, sqlite, Found, Resume};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;

fn database() -> Option<PathBuf> {
    let data = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| super::home().map(|home| home.join(".local/share")))?;
    Some(data.join("opencode").join("opencode.db")).filter(|path| path.is_file())
}

pub(super) fn sessions(days: u64, texts: bool) -> Result<Vec<Found>, String> {
    let Some(path) = database() else {
        return Ok(Vec::new());
    };
    let db = sqlite(&path)?;
    let cutoff = super::cutoff_ms(days);
    let error = |error: rusqlite::Error| error.to_string();

    let mut found: HashMap<String, Found> = HashMap::new();
    let mut order = Vec::new();
    let mut query = db
        .prepare("SELECT id, parent_id, directory, title, time_created, time_updated FROM session WHERE time_updated >= ?1")
        .map_err(error)?;
    let rows = query
        .query_map([cutoff], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
            ))
        })
        .map_err(error)?;
    for (id, parent, directory, title, created, updated) in rows.flatten() {
        let mut session = Found::new("opencode", Resume::Exact);
        session.summary.id = id.clone();
        session.summary.cwd = directory;
        session.summary.title = title;
        session.saw(&iso_from_ms(created));
        session.saw(&iso_from_ms(updated));
        session.listed = parent.is_none();
        order.push(id.clone());
        found.insert(id, session);
    }

    let mut roles: HashMap<String, bool> = HashMap::new();
    let mut query = db
        .prepare(
            "SELECT m.id, m.session_id, m.time_created, m.data FROM message m
             JOIN session s ON s.id = m.session_id WHERE s.time_updated >= ?1",
        )
        .map_err(error)?;
    let rows = query
        .query_map([cutoff], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?, row.get::<_, String>(3)?))
        })
        .map_err(error)?;
    for (id, session, at, data) in rows.flatten() {
        let Ok(data) = serde_json::from_str::<Value>(&data) else { continue };
        roles.insert(id, data["role"] == "user");
        let Some(session) = found.get_mut(&session) else { continue };
        if data["role"] != "assistant" {
            continue;
        }
        let tokens = &data["tokens"];
        let count = |value: &Value| value.as_u64().unwrap_or(0);
        let spent = [
            count(&tokens["input"]),
            count(&tokens["output"]) + count(&tokens["reasoning"]),
            count(&tokens["cache"]["read"]),
            count(&tokens["cache"]["write"]),
            0,
        ];
        if spent.iter().any(|count| *count > 0) {
            session.add_tokens(data["modelID"].as_str().unwrap_or("opencode"), &iso_from_ms(at), spent);
        }
    }

    // Text parts give prompts and replies; patch parts name the files written.
    let mut query = db
        .prepare(
            "SELECT p.message_id, p.session_id, p.time_created, p.data FROM part p
             JOIN session s ON s.id = p.session_id
             WHERE s.time_updated >= ?1 AND json_extract(p.data, '$.type') IN ('text', 'patch')
             ORDER BY p.time_created",
        )
        .map_err(error)?;
    let rows = query
        .query_map([cutoff], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?, row.get::<_, String>(3)?))
        })
        .map_err(error)?;
    for (message, session, at, data) in rows.flatten() {
        let Some(session) = found.get_mut(&session) else { continue };
        let Ok(data) = serde_json::from_str::<Value>(&data) else { continue };
        if data["type"] == "patch" {
            for file in data["files"].as_array().into_iter().flatten() {
                session.wrote(file.as_str().unwrap_or_default());
            }
            continue;
        }
        if data["synthetic"] == true || data["ignored"] == true {
            continue;
        }
        let mine = roles.get(&message).copied().unwrap_or(false);
        session.push_text(&iso_from_ms(at), mine, data["text"].as_str().unwrap_or_default());
    }

    Ok(order
        .iter()
        .filter_map(|id| found.remove(id))
        .map(|session| session.copy(texts))
        .collect())
}
