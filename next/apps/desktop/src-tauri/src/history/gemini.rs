//! Gemini sessions, read from `~/.gemini/tmp/<folder>/chats/session-*.json[l]`.
//!
//! The folder is a SHA-256 of the session's working directory, or a short name kept in
//! `projects.json`, so the directory is found by hashing the folders it could be: every project
//! root and the folders directly inside one. A session started anywhere else has no known
//! directory and counts as outside every project.
//!
//! Older chats are one JSON document; newer ones are JSONL, a metadata line and then patches that
//! `$set` fields. Gemini cannot resume a session by id, and Panel has no Gemini engine, so these
//! sessions are for reading only.

use super::{cached, clip, human_text, store, FileCache, Found, Resume};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

static CACHE: FileCache = FileCache::new();

/// Folder name → working directory, for every directory a project session can run in.
fn folders(home: &Path, roots: &[(String, PathBuf)]) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut add = |path: &Path| {
        let text = path.to_string_lossy().into_owned();
        out.insert(format!("{:x}", Sha256::digest(text.as_bytes())), text);
    };
    for (_, root) in roots {
        add(root);
        for entry in std::fs::read_dir(root).into_iter().flatten().flatten() {
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                add(&entry.path());
            }
        }
    }
    let projects: Value = std::fs::read(home.join("projects.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    for (path, name) in projects["projects"].as_object().into_iter().flatten() {
        if let Some(name) = name.as_str() {
            out.insert(name.to_string(), path.clone());
        }
    }
    out
}

/// The chat as one object, whichever format it was written in.
fn document(path: &Path) -> Option<Map<String, Value>> {
    let text = std::fs::read_to_string(path).ok()?;
    if path.extension().is_some_and(|ext| ext == "json") {
        return serde_json::from_str::<Value>(&text).ok()?.as_object().cloned();
    }
    let mut doc = Map::new();
    let mut messages = Vec::new();
    for line in text.lines() {
        let Ok(Value::Object(record)) = serde_json::from_str::<Value>(line) else { continue };
        if let Some(Value::Object(set)) = record.get("$set") {
            for (key, value) in set {
                if key == "messages" {
                    messages = value.as_array().cloned().unwrap_or_default();
                } else {
                    doc.insert(key.clone(), value.clone());
                }
            }
        } else if record.contains_key("type") && record.contains_key("content") {
            messages.push(Value::Object(record));
        } else {
            doc.extend(record);
        }
    }
    doc.insert("messages".into(), Value::Array(messages));
    Some(doc)
}

fn text_of(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts.iter().filter_map(|part| part["text"].as_str()).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

/// Read without a folder: which folder a hash means depends on the projects at scan time, and the
/// cache must not keep an old answer. Files stay absolute until [`sessions`] places them.
fn read(path: &Path) -> Option<Found> {
    let doc = document(path)?;
    let mut found = Found::new("gemini", Resume::None);
    found.summary.id = doc.get("sessionId")?.as_str()?.to_string();
    found.saw(doc.get("startTime").and_then(Value::as_str).unwrap_or_default());
    found.saw(doc.get("lastUpdated").and_then(Value::as_str).unwrap_or_default());
    for message in doc.get("messages").and_then(Value::as_array).into_iter().flatten() {
        let at = message["timestamp"].as_str().unwrap_or_default();
        found.saw(at);
        match message["type"].as_str().unwrap_or_default() {
            "user" => {
                let text = text_of(&message["content"]);
                // `@file` prompts carry the files after this line; the ask is above it.
                let ask = text.split("\n--- Content from referenced files ---").next().unwrap_or_default();
                if let Some(prompt) = human_text(ask) {
                    found.push_text(at, true, &prompt);
                }
            }
            "gemini" => {
                found.push_text(at, false, &text_of(&message["content"]));
                for call in message["toolCalls"].as_array().into_iter().flatten() {
                    if matches!(call["name"].as_str(), Some("write_file" | "replace")) {
                        found.wrote(call["args"]["file_path"].as_str().unwrap_or_default());
                    }
                }
                let tokens = &message["tokens"];
                let count = |key: &str| tokens[key].as_u64().unwrap_or(0);
                let cached = count("cached");
                let spent = [count("input").saturating_sub(cached), count("output") + count("thoughts"), cached, 0, 0];
                if spent.iter().any(|count| *count > 0) {
                    found.add_tokens(message["model"].as_str().unwrap_or("gemini"), at, spent);
                }
            }
            _ => {}
        }
    }
    if found.summary.title.is_empty() {
        found.summary.title = clip(&found.summary.first_prompt, 80);
    }
    found.listed = found.summary.prompts > 0;
    Some(found)
}

pub(super) fn sessions(days: u64, roots: &[(String, PathBuf)], texts: bool) -> Vec<Found> {
    let Some(home) = store("GEMINI_HOME", ".gemini") else {
        return Vec::new();
    };
    let since = super::cutoff(days);
    let names = folders(&home, roots);
    let mut paths = Vec::new();
    let mut cwd_of = HashMap::new();
    for folder in std::fs::read_dir(home.join("tmp")).into_iter().flatten().flatten() {
        let name = folder.file_name().to_string_lossy().into_owned();
        let cwd = names.get(&name).cloned().unwrap_or_default();
        for chat in std::fs::read_dir(folder.path().join("chats")).into_iter().flatten().flatten() {
            let path = chat.path();
            let file = chat.file_name().to_string_lossy().into_owned();
            if file.starts_with("session-")
                && (file.ends_with(".json") || file.ends_with(".jsonl"))
                && super::modified_within(&path, since)
            {
                cwd_of.insert(path.clone(), cwd.clone());
                paths.push(path);
            }
        }
    }
    cached(&CACHE, &paths, texts, read)
        .into_iter()
        .map(|(path, mut session)| {
            session.summary.cwd = cwd_of.get(&path).cloned().unwrap_or_default();
            for file in std::mem::take(&mut session.files) {
                session.wrote(&file);
            }
            session
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_chat_formats_read_the_same() {
        let dir = crate::history::scratch();
        let messages = r#"[{"type":"user","timestamp":"2026-10-20T10:00:00Z","content":"@lib/** add a button\n--- Content from referenced files ---\nlots"},
            {"type":"gemini","timestamp":"2026-10-20T10:01:00Z","content":"Added.","model":"gemini-3-pro",
             "tokens":{"input":100,"output":5,"cached":40,"thoughts":3},
             "toolCalls":[{"name":"replace","args":{"file_path":"/work/app/lib/b.dart"}}]}]"#;
        let json = dir.join("session-1.json");
        std::fs::write(&json, format!(r#"{{"sessionId":"s1","startTime":"2026-10-20T10:00:00Z","messages":{messages}}}"#)).unwrap();
        let jsonl = dir.join("session-2.jsonl");
        std::fs::write(&jsonl, format!("{{\"sessionId\":\"s1\",\"startTime\":\"2026-10-20T10:00:00Z\"}}\n{{\"$set\":{{\"messages\":{}}}}}\n", messages.replace('\n', ""))).unwrap();
        for path in [json, jsonl] {
            let mut found = read(&path).unwrap();
            found.summary.cwd = "/work/app".into();
            for file in std::mem::take(&mut found.files) {
                found.wrote(&file);
            }
            assert_eq!(found.summary.first_prompt, "@lib/** add a button", "{path:?}");
            assert_eq!(found.summary.last_text, "Added.");
            assert_eq!(found.files.iter().collect::<Vec<_>>(), vec!["lib/b.dart"]);
            assert_eq!(found.usage[&("gemini-3-pro".to_string(), "2026-10-20T10".to_string())], [60, 8, 40, 0, 0]);
        }
        std::fs::remove_dir_all(dir).ok();
    }
}
