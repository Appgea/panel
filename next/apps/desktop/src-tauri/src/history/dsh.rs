//! DeepSeek Harness (`dshline`) sessions, read from
//! `~/.dsh/sessions/<folder>/<id>/session.v4.jsonl.zstd`.
//!
//! One zstd stream of event records: `session` opens it with the folder, `user/message` and
//! `assistant/message` carry the turns (the assistant's with its usage and model), `tool/call`
//! the tools it ran, and `session/title` the name. Only messages whose source is `user` were
//! typed by a person; the harness splices in skill catalogs and runtime context the same way.
//! The log is appended a frame at a time, so the file is many zstd frames back to back. A session
//! still being written can end mid-frame; everything before that point still counts.
//!
//! `dshline --resume <id>` reopens one session; with no id it opens the harness's own picker.

use super::{cached, iso_from_ms, session_files, store, FileCache, Found, Resume};
use serde_json::Value;
use std::io::Read;
use std::path::Path;

static CACHE: FileCache = FileCache::new();

fn text_of(content: &Value) -> String {
    content
        .as_array()
        .into_iter()
        .flatten()
        .filter(|block| block["type"] == "text")
        .filter_map(|block| block["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

/// Every frame decoded, in order, up to the first one that does not decode whole.
fn decode(bytes: &[u8]) -> Vec<u8> {
    let mut rest = bytes;
    let mut out = Vec::new();
    while !rest.is_empty() {
        let Ok(mut frame) = ruzstd::decoding::StreamingDecoder::new(rest) else { break };
        let mut chunk = Vec::new();
        if frame.read_to_end(&mut chunk).is_err() {
            break;
        }
        out.extend(chunk);
        let left = frame.into_inner();
        if left.len() == rest.len() {
            break;
        }
        rest = left;
    }
    out
}

fn read(path: &Path) -> Option<Found> {
    let text = decode(&std::fs::read(path).ok()?);
    let mut found = Found::new("dshline", Resume::Exact);
    let mut nested = false;
    for line in text.split(|byte| *byte == b'\n') {
        let Ok(record) = serde_json::from_slice::<Value>(line) else { continue };
        let at = record["time"].as_i64().map(iso_from_ms).unwrap_or_default();
        found.saw(&at);
        let data = &record["data"];
        match record["type"].as_str().unwrap_or_default() {
            "session" => {
                found.summary.id = record["id"].as_str().unwrap_or_default().to_string();
                found.summary.cwd = record["cwd"].as_str().unwrap_or_default().to_string();
                nested = record["delegationDepth"].as_u64().unwrap_or(0) > 0;
                if let Some(created) = record["createdAt"].as_i64() {
                    found.saw(&iso_from_ms(created));
                }
            }
            "session/title" => {
                found.summary.title = data["title"].as_str().unwrap_or_default().to_string();
            }
            "user/message" if data["source"]["kind"] == "user" => {
                found.push_text(&at, true, &text_of(&data["content"]));
            }
            "assistant/message" => {
                let message = &data["message"];
                found.push_text(&at, false, &text_of(&message["content"]));
                let usage = &data["usage"];
                let count = |key: &str| usage[key].as_u64().unwrap_or(0);
                let spent = [
                    count("inputTokens"),
                    count("outputTokens"),
                    count("cacheReadTokens"),
                    count("cacheWriteTokens"),
                    0,
                ];
                if spent.iter().any(|count| *count > 0) {
                    found.add_tokens(message["source"]["model"].as_str().unwrap_or("deepseek"), &at, spent);
                }
            }
            "tool/call" if matches!(data["name"].as_str(), Some("write" | "edit")) => {
                let args: Value = serde_json::from_str(data["arguments"].as_str().unwrap_or("{}")).unwrap_or_default();
                found.wrote(args["file_path"].as_str().unwrap_or_default());
            }
            _ => {}
        }
    }
    if found.summary.id.is_empty() {
        return None;
    }
    found.listed = !nested && found.summary.prompts > 0;
    Some(found)
}

pub(super) fn sessions(days: u64, texts: bool) -> Vec<Found> {
    let Some(root) = store("DSH_HOME", ".dsh").map(|home| home.join("sessions")) else {
        return Vec::new();
    };
    let paths = session_files(&root, days, |name| name.starts_with("session.v") && name.ends_with(".jsonl.zstd"));
    cached(&CACHE, &paths, texts, read).into_iter().map(|(_, found)| found).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ruzstd::encoding::{compress_to_vec, CompressionLevel};

    fn frame(lines: &[&str]) -> Vec<u8> {
        compress_to_vec(format!("{}\n", lines.join("\n")).as_bytes(), CompressionLevel::Fastest)
    }

    #[test]
    fn every_appended_frame_is_read_and_a_torn_one_is_dropped() {
        let dir = crate::history::scratch();
        let mut bytes = frame(&[
            r#"{"type":"session","id":"dshline-1","createdAt":1791578473067,"cwd":"/work/app","delegationDepth":0}"#,
            r#"{"type":"user/message","time":1791578498559,"data":{"content":[{"type":"text","text":"why do soldiers idle"}],"source":{"kind":"user"}}}"#,
        ]);
        bytes.extend(frame(&[
            r#"{"type":"user/message","time":1791578498560,"data":{"content":[{"type":"text","text":"skills"}],"source":{"kind":"skill-catalog"}}}"#,
            r#"{"type":"assistant/message","time":1791578500142,"data":{"message":{"content":[{"type":"text","text":"Found it."}],"source":{"model":"deepseek-v4-pro"}},"usage":{"inputTokens":8,"outputTokens":2,"cacheReadTokens":4,"cacheWriteTokens":0}}}"#,
            r#"{"type":"tool/call","time":1791578500144,"data":{"name":"edit","arguments":"{\"file_path\":\"/work/app/src/army.ts\"}"}}"#,
        ]));
        let torn = frame(&[r#"{"type":"user/message","time":1791578600000,"data":{"content":[{"type":"text","text":"lost"}],"source":{"kind":"user"}}}"#]);
        bytes.extend(&torn[..torn.len() / 2]);
        let path = dir.join("session.v4.jsonl.zstd");
        std::fs::write(&path, bytes).unwrap();
        let found = read(&path).unwrap();
        assert_eq!(found.summary.prompts, 1, "a spliced skill catalog is not a prompt; the torn frame is gone");
        assert_eq!(found.summary.last_text, "Found it.");
        assert_eq!(found.files.iter().collect::<Vec<_>>(), vec!["src/army.ts"]);
        assert_eq!(found.usage.values().next(), Some(&[8, 2, 4, 0, 0]));
        assert!(found.listed);
        std::fs::remove_dir_all(dir).ok();
    }
}
