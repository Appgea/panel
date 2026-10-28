//! Claude sessions, read from `~/.claude/projects/<folder>/<id>.jsonl`: titles, prompts, the last
//! thing Claude said, the files it wrote, and the tokens it spent.
//!
//! The transcripts are large (gigabytes in a busy fortnight), but they are append-only. Each file
//! is read once, and after that only the bytes added since. Lines that can hold nothing this
//! module wants — request blobs, file snapshots, tool results — are rejected on their first bytes,
//! before any JSON is parsed.

use super::{clip, Found, Resume};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// A tool result announces itself in its first bytes; looking further only costs time.
const HEAD_BYTES: usize = 400;

/// One transcript, read up to `read_len`. Kept between scans so a grown file is read from where
/// the last scan stopped.
struct Scan {
    read_len: u64,
    /// The session so far; its usage includes every subagent file under it.
    found: Found,
    /// One assistant message is written as several lines, each repeating its usage.
    counted: HashSet<String>,
    /// Subagent transcripts read so far, by path, for the same resume-from-offset reason.
    subagents: HashMap<PathBuf, u64>,
}

impl Default for Scan {
    fn default() -> Self {
        Scan {
            read_len: 0,
            found: Found::new("claude", Resume::Exact),
            counted: HashSet::new(),
            subagents: HashMap::new(),
        }
    }
}

fn cache() -> &'static Mutex<HashMap<PathBuf, Scan>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Scan>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// `~/.claude/projects`, honouring `CLAUDE_CONFIG_DIR` the way Claude does.
fn transcripts_root() -> Option<PathBuf> {
    let base = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".claude")))?;
    Some(base.join("projects"))
}

/// Every main transcript touched within `days`. Subagent files are found from their session.
fn recent_transcripts(days: u64) -> Vec<PathBuf> {
    let Some(root) = transcripts_root() else {
        return Vec::new();
    };
    let cutoff = super::cutoff(days);
    let Ok(folders) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    folders
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .flat_map(|entry| std::fs::read_dir(entry.path()).into_iter().flatten().flatten())
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "jsonl"))
        .filter(|path| super::modified_within(path, cutoff))
        .collect()
}

/// What the human typed, or None for everything Claude Code writes as a user turn on its own:
/// command echoes, caveats, reminders, task notifications, interruptions.
fn prompt_text(message: &Value) -> Option<String> {
    let text = match &message["content"] {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|block| block["type"] == "text")
            .filter_map(|block| block["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    let text = text.trim();
    if text.is_empty() || text.starts_with('<') || text.starts_with("[Request interrupted") {
        return None;
    }
    Some(text.to_string())
}

/// Lines worth parsing. Everything that starts `{"type":` is bookkeeping except the two small
/// records that carry the session's title and last prompt; a user line whose content opens with a
/// tool result is Claude's own tool output, often megabytes, and holds no prompt.
fn wanted(line: &[u8]) -> bool {
    if line.starts_with(b"{\"type\":") {
        return line.starts_with(b"{\"type\":\"ai-title\"")
            || line.starts_with(b"{\"type\":\"last-prompt\"");
    }
    let head = &line[..line.len().min(HEAD_BYTES)];
    !head.windows(13).any(|window| window == b"\"tool_use_id\"")
}

fn count_usage(scan: &mut Scan, message: &Value, timestamp: &str) {
    let id = message["id"].as_str().unwrap_or_default();
    let model = message["model"].as_str().unwrap_or_default();
    if id.is_empty() || model.is_empty() || model.starts_with('<') || !scan.counted.insert(id.into()) {
        return;
    }
    let usage = &message["usage"];
    let tokens = |key: &str| usage[key].as_u64().unwrap_or(0);
    let spent = [
        tokens("input_tokens"),
        tokens("output_tokens"),
        tokens("cache_read_input_tokens"),
        tokens("cache_creation_input_tokens"),
        0,
    ];
    scan.found.add_tokens(model, timestamp, spent);
}

fn read_line(scan: &mut Scan, record: &Value) {
    let found = &mut scan.found;
    match record["type"].as_str().unwrap_or_default() {
        "ai-title" => {
            if let Some(title) = record["aiTitle"].as_str() {
                found.summary.title = title.trim().to_string();
            }
            return;
        }
        "last-prompt" => {
            if let Some(prompt) = record["lastPrompt"].as_str() {
                found.summary.last_prompt = clip(prompt, 400);
            }
            return;
        }
        _ => {}
    }
    if record["isSidechain"] == true {
        return;
    }
    let timestamp = record["timestamp"].as_str().unwrap_or_default();
    if found.summary.id.is_empty() {
        found.summary.id = record["sessionId"].as_str().unwrap_or_default().to_string();
    }
    if found.summary.cwd.is_empty() {
        found.summary.cwd = record["cwd"].as_str().unwrap_or_default().to_string();
    }
    if let Some(entry) = record["entrypoint"].as_str() {
        // `claude -p` and the SDKs write `sdk-*`; the interactive CLI writes `cli`.
        found.summary.headless = entry.starts_with("sdk");
    }
    found.saw(timestamp);
    let message = &record["message"];
    match record["type"].as_str().unwrap_or_default() {
        "user" if record["isMeta"] != true => {
            if let Some(prompt) = prompt_text(message) {
                found.push_text(timestamp, true, &prompt);
            }
        }
        "assistant" => {
            for block in message["content"].as_array().into_iter().flatten() {
                match block["type"].as_str().unwrap_or_default() {
                    "text" => found.push_text(timestamp, false, block["text"].as_str().unwrap_or_default()),
                    "tool_use" => {
                        let name = block["name"].as_str().unwrap_or_default();
                        let path = block["input"]["file_path"]
                            .as_str()
                            .or_else(|| block["input"]["notebook_path"].as_str());
                        if matches!(name, "Edit" | "Write" | "MultiEdit" | "NotebookEdit") {
                            found.wrote(path.unwrap_or_default());
                        }
                    }
                    _ => {}
                }
            }
            count_usage(scan, message, timestamp);
        }
        _ => {}
    }
}

/// Read `path` from `from`, handing each wanted record to `each`. Returns the new length read.
/// A last line still being written (no newline yet) is left for the next scan.
fn read_from(path: &Path, from: u64, mut each: impl FnMut(&Value)) -> u64 {
    let Ok(mut file) = File::open(path) else {
        return from;
    };
    if file.seek(SeekFrom::Start(from)).is_err() {
        return from;
    }
    let mut reader = BufReader::with_capacity(1 << 20, file);
    let mut line = Vec::new();
    let mut at = from;
    loop {
        line.clear();
        let Ok(read) = reader.read_until(b'\n', &mut line) else {
            break;
        };
        if read == 0 || line.last() != Some(&b'\n') {
            break;
        }
        at += read as u64;
        if wanted(&line) {
            if let Ok(record) = serde_json::from_slice::<Value>(&line) {
                each(&record);
            }
        }
    }
    at
}

/// Bring one transcript's scan up to date: new bytes of the main file, and of every subagent file
/// beside it (their tokens are the session's tokens; their prompts are not the human's).
fn refresh(scan: &mut Scan, path: &Path) {
    let len = path.metadata().map(|meta| meta.len()).unwrap_or(0);
    if len < scan.read_len {
        // Rewritten, not appended: start over.
        *scan = Scan::default();
    }
    if len > scan.read_len {
        let from = scan.read_len;
        scan.read_len = read_from(path, from, |record| read_line(scan, record));
    }

    let subagents = path.with_extension("").join("subagents");
    let Ok(entries) = std::fs::read_dir(&subagents) else {
        return;
    };
    for entry in entries.flatten() {
        let sub = entry.path();
        if sub.extension().is_none_or(|ext| ext != "jsonl") {
            continue;
        }
        let len = sub.metadata().map(|meta| meta.len()).unwrap_or(0);
        let from = scan.subagents.get(&sub).copied().unwrap_or(0).min(len);
        if len == from {
            continue;
        }
        let read = read_from(&sub, from, |record| {
            if record["type"] == "assistant" {
                count_usage(scan, &record["message"], record["timestamp"].as_str().unwrap_or_default());
            }
        });
        scan.subagents.insert(sub, read);
    }
}

/// Every Claude session touched within `days`. A session that never got a real prompt — opened
/// and closed, or only slash commands like /pace — has nothing to review, but its tokens were
/// still spent, so it comes back unlisted.
pub(super) fn sessions(days: u64, texts: bool) -> Vec<Found> {
    let paths = recent_transcripts(days);
    let mut cache = cache().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let keep: HashSet<&PathBuf> = paths.iter().collect();
    cache.retain(|path, _| keep.contains(path));
    let mut out = Vec::new();
    for path in &paths {
        let scan = cache.entry(path.clone()).or_default();
        refresh(scan, path);
        if scan.found.summary.id.is_empty() {
            continue;
        }
        let mut found = scan.found.copy(texts);
        found.listed = found.summary.prompts > 0;
        out.push(found);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::scratch;
    use std::io::Write as _;

    fn line(value: Value) -> String {
        format!("{}\n", value)
    }

    fn transcript(dir: &Path, name: &str, lines: &[String]) -> PathBuf {
        let path = dir.join(name);
        let mut file = File::create(&path).unwrap();
        for text in lines {
            file.write_all(text.as_bytes()).unwrap();
        }
        path
    }

    fn user(text: &str, at: &str) -> String {
        line(serde_json::json!({"parentUuid": null, "isSidechain": false, "type": "user",
            "message": {"role": "user", "content": text}, "timestamp": at,
            "cwd": "/work/app", "sessionId": "abc-1"}))
    }

    fn assistant(id: &str, blocks: Value, at: &str) -> String {
        line(serde_json::json!({"parentUuid": "x", "isSidechain": false,
            "message": {"model": "claude-opus-5-5", "id": id, "type": "message", "role": "assistant",
                "content": blocks, "usage": {"input_tokens": 3, "output_tokens": 10,
                "cache_read_input_tokens": 100, "cache_creation_input_tokens": 20}},
            "type": "assistant", "timestamp": at, "cwd": "/work/app", "sessionId": "abc-1"}))
    }

    #[test]
    fn reads_prompts_replies_files_and_counts_each_message_once() {
        let dir = scratch();
        let path = transcript(&dir, "abc-1.jsonl", &[
            line(serde_json::json!({"type": "mode", "mode": "normal"})),
            user("<command-name>/clear</command-name>", "2026-10-23T07:00:00Z"),
            user("fix the paywall crash", "2026-10-23T07:01:00Z"),
            // The same message id on two lines: its usage must count once.
            assistant("m1", serde_json::json!([{"type": "text", "text": "Looking."}]), "2026-10-23T07:02:00Z"),
            assistant("m1", serde_json::json!([{"type": "tool_use", "name": "Edit",
                "input": {"file_path": "/work/app/lib/paywall.dart"}}]), "2026-10-23T07:02:01Z"),
            line(serde_json::json!({"parentUuid": "y", "type": "user", "message": {"role": "user",
                "content": [{"tool_use_id": "t1", "type": "tool_result", "content": "fix the paywall crash"}]}})),
            assistant("m2", serde_json::json!([{"type": "text", "text": "Fixed. Tests pass."}]), "2026-10-23T08:05:00Z"),
            line(serde_json::json!({"type": "ai-title", "aiTitle": "Paywall crash fix", "sessionId": "abc-1"})),
        ]);
        let mut scan = Scan::default();
        refresh(&mut scan, &path);
        assert_eq!(scan.found.summary.prompts, 1);
        assert_eq!(scan.found.summary.first_prompt, "fix the paywall crash");
        assert_eq!(scan.found.summary.last_text, "Fixed. Tests pass.");
        assert_eq!(scan.found.summary.title, "Paywall crash fix");
        assert_eq!(scan.found.files.iter().collect::<Vec<_>>(), vec!["lib/paywall.dart"]);
        // The tool result repeating the prompt is not a second prompt or a search hit.
        assert_eq!(scan.found.texts.iter().filter(|text| text.mine).count(), 1);
        let hour7 = scan.found.usage[&("claude-opus-5-5".to_string(), "2026-10-23T07".to_string())];
        assert_eq!(hour7, [3, 10, 100, 20, 0]);
        assert_eq!(scan.found.usage.len(), 2);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_grown_transcript_is_read_from_where_it_stopped() {
        let dir = scratch();
        let path = transcript(&dir, "abc-1.jsonl", &[user("first", "2026-10-23T07:00:00Z")]);
        let mut scan = Scan::default();
        refresh(&mut scan, &path);
        let mut file = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        // A half-written last line waits for its newline.
        file.write_all(user("second", "2026-10-23T09:00:00Z").as_bytes()).unwrap();
        file.write_all(b"{\"parentUuid\":").unwrap();
        refresh(&mut scan, &path);
        assert_eq!(scan.found.summary.prompts, 2);
        assert_eq!(scan.found.summary.last_prompt, "second");
        assert_eq!(scan.found.summary.ended_at, "2026-10-23T09:00:00Z");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn subagent_tokens_count_toward_their_session() {
        let dir = scratch();
        let path = transcript(&dir, "abc-1.jsonl", &[user("go", "2026-10-23T07:00:00Z")]);
        let subs = dir.join("abc-1").join("subagents");
        std::fs::create_dir_all(&subs).unwrap();
        transcript(&subs, "agent-1.jsonl", &[
            user("subagent brief", "2026-10-23T07:10:00Z"),
            assistant("s1", serde_json::json!([{"type": "text", "text": "done"}]), "2026-10-23T07:11:00Z"),
        ]);
        let mut scan = Scan::default();
        refresh(&mut scan, &path);
        assert_eq!(scan.found.summary.prompts, 1, "a subagent's brief is not the human's prompt");
        assert_eq!(scan.found.usage[&("claude-opus-5-5".to_string(), "2026-10-23T07".to_string())][1], 10);
        std::fs::remove_dir_all(dir).ok();
    }
}
