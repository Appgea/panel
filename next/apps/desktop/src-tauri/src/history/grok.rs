//! Grok sessions, read from `~/.grok/sessions/<folder>/<id>/`.
//!
//! `summary.json` names the session, `chat_history.jsonl` holds the turns and `usage.json` the
//! session's token totals. Lines carry no time of their own, so every text is dated by the
//! session's last update. A user turn Grok wrote itself carries `synthetic_reason`.

use super::{cached, human_text, session_files, store, FileCache, Found, Resume};
use serde_json::Value;
use std::path::Path;

static CACHE: FileCache = FileCache::new();

fn text_of(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|block| block["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn json(path: &Path) -> Value {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null)
}

fn read(chat: &Path) -> Option<Found> {
    let dir = chat.parent()?;
    let summary = json(&dir.join("summary.json"));
    let mut found = Found::new("grok", Resume::Exact);
    found.summary.id = summary["info"]["id"].as_str()?.to_string();
    found.summary.cwd = summary["info"]["cwd"].as_str().unwrap_or_default().to_string();
    found.summary.title = summary["session_summary"].as_str().unwrap_or_default().to_string();
    found.summary.headless = summary["session_kind"] == "headless";
    let started = summary["created_at"].as_str().unwrap_or_default();
    let ended = summary["updated_at"].as_str().unwrap_or_default();
    found.saw(started);
    found.saw(ended);

    let text = std::fs::read_to_string(chat).ok()?;
    for line in text.lines() {
        let Ok(record) = serde_json::from_str::<Value>(line) else { continue };
        match record["type"].as_str().unwrap_or_default() {
            "user" if record.get("synthetic_reason").is_none() => {
                if let Some(prompt) = human_text(&text_of(&record["content"])) {
                    found.push_text(ended, true, &prompt);
                }
            }
            "assistant" => {
                found.push_text(ended, false, &text_of(&record["content"]));
                for call in record["tool_calls"].as_array().into_iter().flatten() {
                    let name = call["name"].as_str().unwrap_or_default();
                    if matches!(name, "write" | "edit" | "search_replace" | "edit_file") {
                        let args: Value = serde_json::from_str(call["arguments"].as_str().unwrap_or("{}")).unwrap_or_default();
                        found.wrote(args["file_path"].as_str().or(args["target_file"].as_str()).unwrap_or_default());
                    }
                }
            }
            _ => {}
        }
    }

    let usage = json(&dir.join("usage.json"));
    let session = &usage["session"];
    let tokens = |key: &str| session[key].as_u64().unwrap_or(0);
    let cache_read = tokens("cachedReadTokens");
    let spent = [
        // Grok's input count includes the cached part.
        tokens("inputTokens").saturating_sub(cache_read),
        tokens("outputTokens"),
        cache_read,
        tokens("cacheCreationTokens"),
        0,
    ];
    if spent.iter().any(|count| *count > 0) {
        let model = session["primaryModelId"]
            .as_str()
            .or(summary["current_model_id"].as_str())
            .unwrap_or("grok");
        let at = usage["updatedAt"].as_str().unwrap_or(ended);
        found.add_tokens(model, at, spent);
    }
    found.listed = found.summary.prompts > 0;
    Some(found)
}

pub(super) fn sessions(days: u64, texts: bool) -> Vec<Found> {
    let Some(root) = store("GROK_HOME", ".grok").map(|home| home.join("sessions")) else {
        return Vec::new();
    };
    let paths = session_files(&root, days, |name| name == "chat_history.jsonl");
    cached(&CACHE, &paths, texts, read).into_iter().map(|(_, found)| found).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_grok_session_without_its_own_scaffolding() {
        let dir = crate::history::scratch();
        std::fs::write(dir.join("summary.json"), r#"{"info":{"id":"01a1","cwd":"/work/app"},
            "session_summary":"Portrait","created_at":"2026-10-21T19:34:11Z","updated_at":"2026-10-21T19:40:00Z"}"#).unwrap();
        std::fs::write(dir.join("usage.json"), r#"{"updatedAt":"2026-10-21T19:40:00Z","session":{"inputTokens":100,
            "outputTokens":7,"cachedReadTokens":60,"cacheCreationTokens":0,"primaryModelId":"grok-4.7"}}"#).unwrap();
        let lines = [
            r#"{"type":"system","content":"You are Grok"}"#,
            r#"{"type":"user","content":[{"type":"text","text":"<user_info>\nOS: mac\n</user_info>\n\npaint the officer"}]}"#,
            r#"{"type":"user","content":"continue","synthetic_reason":"resume"}"#,
            r#"{"type":"assistant","content":"Done.","tool_calls":[{"name":"write","arguments":"{\"file_path\":\"/work/app/a.png\"}"}]}"#,
        ];
        std::fs::write(dir.join("chat_history.jsonl"), lines.join("\n")).unwrap();
        let found = read(&dir.join("chat_history.jsonl")).unwrap();
        assert_eq!(found.summary.prompts, 1);
        assert_eq!(found.summary.first_prompt, "paint the officer");
        assert_eq!(found.summary.last_text, "Done.");
        assert_eq!(found.files.iter().collect::<Vec<_>>(), vec!["a.png"]);
        assert_eq!(found.usage[&("grok-4.7".to_string(), "2026-10-21T19".to_string())], [40, 7, 60, 0, 0]);
        std::fs::remove_dir_all(dir).ok();
    }
}
