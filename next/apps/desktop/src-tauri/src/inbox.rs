//! The Inbox's memory: what agents sent the human, kept for a month.
//!
//! Messages lived only in the window, so a restart emptied the Inbox. Their pictures and videos
//! under `reports/` were kept for ever: 3.2 GB in 17 days on 2026-11-15. Both share one window
//! now. A message older than [`KEEP_DAYS`] goes, and so does the media folder of its day.
//! Owner, 2026-11-15: "memory must not bloat". The written log in `brain/reports` is text, and
//! stays.
//!
//! A message is the window's own JSON, opaque here apart from `id` and `at`: a new field or a
//! new kind of message needs no change in Rust.

use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const KEEP_DAYS: u64 = 30;
/// A month of a busy portfolio is under this. It bounds what the window loads at boot.
const KEEP_MAX: usize = 500;
const DAY_MS: u64 = 86_400_000;

/// The window keeps messages and reads them back on one thread each. One writer at a time.
static WRITER: Mutex<()> = Mutex::new(());

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn log(root: &Path) -> PathBuf {
    root.join("inbox").join("messages.jsonl")
}

fn at(message: &Value) -> u64 {
    message["at"].as_f64().unwrap_or(0.0) as u64
}

/// Messages still inside the window, oldest first. No log yet is an empty Inbox. A log that
/// cannot be read is an error: saving over it would lose the month it holds.
fn kept(root: &Path, now: u64) -> Result<Vec<Value>, String> {
    let floor = now.saturating_sub(KEEP_DAYS * DAY_MS);
    let text = match fs::read_to_string(log(root)) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("could not read the inbox: {error}")),
    };
    let mut all: Vec<Value> = text
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|message| at(message) >= floor)
        .collect();
    if all.len() > KEEP_MAX {
        all.drain(..all.len() - KEEP_MAX);
    }
    Ok(all)
}

fn write(root: &Path, messages: &[Value]) -> Result<(), String> {
    let file = log(root);
    let dir = file.parent().ok_or("the inbox log has no folder")?;
    fs::create_dir_all(dir).map_err(|error| format!("could not create {}: {error}", dir.display()))?;
    let text: String = messages.iter().map(|message| format!("{message}\n")).collect();
    let temp = file.with_extension(format!("save-{}", uuid::Uuid::new_v4()));
    fs::write(&temp, text).map_err(|error| format!("could not save the inbox: {error}"))?;
    fs::rename(&temp, &file).map_err(|error| {
        let _ = fs::remove_file(&temp);
        format!("could not save the inbox: {error}")
    })
}

/// A `YYYY-MM-DD` folder name as the start of that day. Anything else is not a day folder.
fn day_ms(name: &str) -> Option<u64> {
    if name.len() != 10 {
        return None;
    }
    let mut parts = name.splitn(3, '-').map(|part| part.parse::<i64>().ok());
    let (y, m, d) = (parts.next()??, parts.next()??, parts.next()??);
    if y < 1970 || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    // Days from the civil date, after Howard Hinnant. No chrono in this tree.
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era * 146_097 + doe - 719_468) as u64 * DAY_MS)
}

/// Drop the kept media of days no message can still point at. `host/keep_media.py` files each
/// message's copies under `reports/<day>/`. One day of slack: the folder is named in local time.
fn prune_media(root: &Path, now: u64) {
    let Ok(days) = fs::read_dir(root.join("reports")) else {
        return;
    };
    for day in days.flatten() {
        let Some(start) = day.file_name().to_str().and_then(day_ms) else {
            continue;
        };
        if start + (KEEP_DAYS + 1) * DAY_MS < now {
            if let Err(error) = fs::remove_dir_all(day.path()) {
                eprintln!("[panel] inbox: could not drop {}: {error}", day.path().display());
            }
        }
    }
}

fn keep_in(root: &Path, message: Value, now: u64) -> Result<(), String> {
    let mut all = kept(root, now)?;
    // The same id again is the same message: a retry replaces it.
    all.retain(|known| known["id"] != message["id"]);
    all.push(message);
    write(root, &all)?;
    prune_media(root, now);
    Ok(())
}

/// Every kept message, oldest first. The window reads this once, at boot.
#[tauri::command]
pub fn inbox_messages() -> Result<Vec<Value>, String> {
    let _writer = WRITER.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let root = crate::paths::user_root();
    let now = now_ms();
    prune_media(&root, now);
    kept(&root, now)
}

/// Keep one message the window just showed.
#[tauri::command]
pub fn inbox_keep(message: Value) -> Result<(), String> {
    if message["id"].as_str().is_none_or(str::is_empty) {
        return Err("a message needs an id".into());
    }
    let _writer = WRITER.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    keep_in(&crate::paths::user_root(), message, now_ms())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_month_old_message_and_its_media_are_dropped() {
        let root = std::env::temp_dir().join(format!("panel-inbox-test-{}", uuid::Uuid::new_v4()));
        let now = day_ms("2026-11-15").unwrap() + DAY_MS / 2;
        for day in ["2026-10-01", "2026-11-14", "not-a-day"] {
            fs::create_dir_all(root.join("reports").join(day).join("abc")).unwrap();
        }

        keep_in(&root, json!({ "id": "old", "at": now - 31 * DAY_MS }), now - 31 * DAY_MS).unwrap();
        keep_in(&root, json!({ "id": "new", "at": now - DAY_MS, "title": "first" }), now).unwrap();
        keep_in(&root, json!({ "id": "new", "at": now - DAY_MS, "title": "again" }), now).unwrap();

        let all = kept(&root, now).unwrap();
        assert_eq!(all.len(), 1, "the old message is gone and the retry replaced its first copy");
        assert_eq!(all[0]["title"], "again");
        assert!(!root.join("reports/2026-10-01").exists());
        assert!(root.join("reports/2026-11-14/abc").exists());
        assert!(root.join("reports/not-a-day").exists());
        let _ = fs::remove_dir_all(&root);
    }
}
