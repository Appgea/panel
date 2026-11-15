//! Agent reports — filed to the appgea brain, for the manager's read.
//!
//! Each message an agent sends is appended here, one append-only markdown log per project. The
//! human reads the same message whole in the Inbox. For two weeks the Inbox showed only its
//! headline, and the owner could not find what agents told him (2026-11-15, `inbox.rs`).
//!
//! It sits beside [`crate::brain`] under `~/.appgea/brain/` for the same three reasons that
//! module gives: outside every git tree, append-only, and read under a cap rather than written
//! under one. The difference is who writes: `brain` harvests the HUMAN's intent, this files the
//! AGENT's account of what it did. Both are the same brain to the companion reading them.

use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::PathBuf;

/// `~/.appgea/brain/reports`, created on first file.
fn dir() -> Option<PathBuf> {
    let dir = crate::paths::brain_dir().join("reports");
    fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

pub(crate) fn safe_key(project: &str) -> String {
    let key: String = project
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .take(64)
        .collect();
    let key = key.trim_matches('-').to_string();
    if key.is_empty() {
        "unfiled".into()
    } else {
        key
    }
}

/// Local wall clock as `YYYY-MM-DD HH:MM`. No chrono in this tree, and a log entry only needs to
/// be sortable and readable — not a timestamp anything parses back.
fn now_local() -> String {
    let out = crate::platform::command("date")
        .args(["+%Y-%m-%d %H:%M"])
        .output()
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok());
    out.map(|text| text.trim().to_string()).unwrap_or_default()
}

fn text_of(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().trim().to_string()
}

/// Every path-ish entry of a list that holds either strings or `{path|url, …}` objects.
fn paths(value: &Value, key: &str, field: &str) -> Vec<String> {
    value[key]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    item.as_str()
                        .map(str::to_string)
                        .or_else(|| item[field].as_str().map(str::to_string))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Append one report. Returns the log file so the Inbox message can point at it.
///
/// Best-effort by design: a failed write must never break the agent's turn, so every error path
/// returns `None` and the report simply is not filed.
pub fn file(project: &str, session: &str, payload: &Value) -> Option<PathBuf> {
    let title = text_of(payload, "title");
    let body = {
        let text = text_of(payload, "text");
        if text.is_empty() {
            text_of(payload, "report")
        } else {
            text
        }
    };
    if title.is_empty() && body.is_empty() {
        return None;
    }

    let path = dir()?.join(format!("{}.md", safe_key(project)));
    let mut entry = String::new();
    if !path.exists() {
        entry.push_str(&format!(
            "# {project} — agent log\n\nAppend-only. Panel writes one entry per agent report.\n",
        ));
    }
    let outcome = text_of(payload, "outcome");
    entry.push_str(&format!(
        "\n## {} — {}\n",
        now_local(),
        if title.is_empty() { "report" } else { &title },
    ));
    let stamp = [
        (!outcome.is_empty()).then(|| format!("outcome: {outcome}")),
        (!session.is_empty()).then(|| format!("session: {session}")),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" · ");
    if !stamp.is_empty() {
        entry.push_str(&format!("{stamp}\n"));
    }
    if !body.is_empty() {
        entry.push_str(&format!("\n{body}\n"));
    }

    // The code flow is the part a later reader cannot reconstruct from git alone — it says which
    // line mattered and why, in the agent's own words.
    if let Some(steps) = payload["flow"].as_array().filter(|steps| !steps.is_empty()) {
        entry.push_str("\n");
        for step in steps {
            let reference = text_of(step, "ref");
            let label = text_of(step, "label");
            let detail = text_of(step, "detail");
            entry.push_str(&format!("- `{reference}` — **{label}** {detail}\n"));
        }
    }

    let media: Vec<String> = [
        ("images", "path"),
        ("audio", "path"),
        ("video", "path"),
        ("attachments", "path"),
        ("links", "url"),
    ]
    .iter()
    .flat_map(|(key, field)| {
        paths(payload, key, field)
            .into_iter()
            .map(move |value| format!("{key}: {value}"))
    })
    .collect();
    if !media.is_empty() {
        entry.push_str("\n");
        for line in media {
            entry.push_str(&format!("- {line}\n"));
        }
    }

    let mut handle = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .ok()?;
    handle.write_all(entry.as_bytes()).ok()?;
    Some(path)
}
