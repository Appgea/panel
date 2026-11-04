//! Live's animation catalog: one JSON script per verb in `~/.appgeapanel/state/live-catalog/`.
//! The script language and its player are ui/src/features/live_script.ts.
//!
//! A verb Live sees with no script gets one written by a headless Sonnet run, untested. The owner
//! deletes the bad ones in the catalog view, and the next sighting writes a new one.
//! Owner, 2026-11-04: "Untested is fine, current models don't need testing on everything. And if
//! it is bad, I will delete ofc. So we will need a catalog of animations."
//! A script is data made of fixed moves, never code, so a bad one only looks bad.

use serde_json::Value;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

/// The player and its language, handed to the writer as the spec. One source for both.
const PLAYER: &str = include_str!("../../../ui/src/features/live_script.ts");
/// The first scripts, by verb. Written once, when the catalog folder is made, so a delete sticks.
const SEEDS: &str = include_str!("../../../ui/src/features/live_seeds.json");
/// A writer that failed or hangs is tried again after this.
const RETRY: Duration = Duration::from_secs(3600);
/// New scripts per hour at most, so a burst of new tools cannot drain the quota.
const PER_HOUR: usize = 6;

pub fn dir() -> PathBuf {
    crate::paths::user_root().join("state").join("live-catalog")
}

/// A verb is also a file name: only the characters verbs.rs makes.
fn valid(verb: &str) -> bool {
    !verb.is_empty() && verb.len() <= 40 && verb.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '-'))
}

/// Makes the catalog folder. The first time, it also writes the seed scripts.
fn ensure() -> Option<PathBuf> {
    let dir = dir();
    if dir.is_dir() {
        return Some(dir);
    }
    std::fs::create_dir_all(&dir).ok()?;
    if let Ok(Value::Object(seeds)) = serde_json::from_str::<Value>(SEEDS) {
        for (verb, script) in seeds {
            if valid(&verb) {
                let _ = std::fs::write(dir.join(format!("{verb}.json")), serde_json::to_vec_pretty(&script).unwrap_or_default());
            }
        }
    }
    Some(dir)
}

/// Every script, with its verb and when it was written, and every verb still being written as
/// `{verb, pending: true}`. A file that is not JSON is skipped.
pub fn read() -> Vec<Value> {
    let Ok(entries) = std::fs::read_dir(dir()) else { return Vec::new() };
    let files: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    let pending = files.iter().filter_map(|p| {
        let verb = p.file_name()?.to_str()?.strip_suffix(".pending")?;
        (!files.iter().any(|f| f.file_name().and_then(|n| n.to_str()) == Some(&format!("{verb}.json")))).then(|| serde_json::json!({ "verb": verb, "pending": true }))
    });
    let mut out: Vec<Value> = files
        .iter()
        .filter_map(|path| {
            let verb = path.file_name()?.to_str()?.strip_suffix(".json")?.to_string();
            let mut v: Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
            let made = path.metadata().ok()?.modified().ok()?.duration_since(SystemTime::UNIX_EPOCH).ok()?.as_millis() as u64;
            let o = v.as_object_mut()?;
            o.insert("verb".into(), verb.into());
            o.entry("madeMs").or_insert(made.into());
            Some(v)
        })
        .chain(pending)
        .collect();
    out.sort_by(|a, b| a["verb"].as_str().cmp(&b["verb"].as_str()));
    out
}

pub fn delete(verb: &str) -> Result<(), String> {
    if !valid(verb) {
        return Err(format!("{verb} is not a verb"));
    }
    let path = dir().join(format!("{verb}.json"));
    std::fs::remove_file(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    // A fresh sighting writes a new one at once, not after the retry wait.
    let _ = std::fs::remove_file(dir().join(format!("{verb}.pending")));
    Ok(())
}

/// Starts one writer per verb that has no script, none running, and room in the hourly cap.
/// `seen` pairs a verb with a step label that shows it, which the writer gets as an example.
pub fn write_missing(seen: &[(String, String)]) {
    let Some(dir) = ensure() else { return };
    let now = SystemTime::now();
    let age = |p: &PathBuf| p.metadata().and_then(|m| m.modified()).ok().and_then(|t| now.duration_since(t).ok());
    // The cap counts starts, kept in their own log, so deleting a script never frees room.
    let log = dir.join(".writers");
    let unix = now.duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let recent: Vec<u64> = std::fs::read_to_string(&log).unwrap_or_default().lines().filter_map(|l| l.trim().parse().ok()).filter(|t| unix.saturating_sub(*t) < 3600).collect();
    let mut room = PER_HOUR.saturating_sub(recent.len());
    let mut started = recent;
    let mut done = std::collections::HashSet::new();
    for (verb, example) in seen {
        if room == 0 {
            break;
        }
        if !valid(verb) || !done.insert(verb.clone()) || dir.join(format!("{verb}.json")).exists() {
            continue;
        }
        let mark = dir.join(format!("{verb}.pending"));
        match age(&mark) {
            Some(d) if d < RETRY => continue,
            Some(_) => {
                let _ = std::fs::remove_file(&mark);
            }
            None => {}
        }
        // Made only if absent: of two scans at once, one wins and starts the writer.
        let Ok(mut f) = std::fs::OpenOptions::new().write(true).create_new(true).open(&mark) else { continue };
        let _ = std::io::Write::write_all(&mut f, example.as_bytes());
        room -= 1;
        started.push(unix);
        spawn_writer(&dir, verb, example);
    }
    let _ = std::fs::write(&log, started.iter().map(|t| format!("{t}\n")).collect::<String>());
}

/// A script the player can run: an object with a list of moves.
fn playable(text: &str) -> bool {
    serde_json::from_str::<Value>(text).is_ok_and(|v| v.get("steps").is_some_and(Value::is_array))
}

/// A writer that runs longer than this is killed.
const WRITER_LIMIT: Duration = Duration::from_secs(300);

/// Runs one writer in its own scratch folder. Its file moves into the catalog only if it is a
/// playable script and the verb still has none, so a writer can never overwrite another script.
fn spawn_writer(dir: &PathBuf, verb: &str, example: &str) {
    let work = dir.join(".writing").join(verb);
    let _ = std::fs::remove_dir_all(&work);
    if let Err(e) = std::fs::create_dir_all(&work) {
        eprintln!("[live] catalog writer for {verb}: {e}");
        return;
    }
    let examples: Vec<String> = ["git.push", "search", "spawn"]
        .iter()
        .filter_map(|v| std::fs::read_to_string(dir.join(format!("{v}.json"))).ok().map(|s| format!("{v}.json:\n{s}")))
        .collect();
    let prompt = format!(
        "You write one animation script for Panel Live, a dark map where coding agents are small glowing electrons.\n\
         An agent just did a step with the verb `{verb}`. Example step: \"{example}\".\n\
         Write the file `{verb}.json` in the current folder: a JSON object in the language described at the top of the player below.\n\
         Make it show what this kind of work is, at a glance, in 2 to 6 seconds. Use the places and moves the player knows. Nothing else.\n\
         Write only that one file, then stop.\n\n\
         Scripts already in the catalog:\n{}\n\nThe player, ui/src/features/live_script.ts:\n{PLAYER}",
        examples.join("\n\n")
    );
    let child = crate::platform::command("claude")
        .args(["-p", &prompt, "--model", "sonnet", "--allowedTools", "Write", "--permission-mode", "acceptEdits"])
        .current_dir(&work)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[live] catalog writer for {verb} did not start: {e}");
            return;
        }
    };
    let (dir, verb) = (dir.clone(), verb.to_string());
    // Waited on its own thread, so a finished writer leaves no zombie and a hung one is killed.
    std::thread::spawn(move || {
        let start = std::time::Instant::now();
        while matches!(child.try_wait(), Ok(None)) {
            if start.elapsed() > WRITER_LIMIT {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
            std::thread::sleep(Duration::from_secs(2));
        }
        let text = std::fs::read_to_string(work.join(format!("{verb}.json"))).unwrap_or_default();
        if playable(&text) {
            let dest = dir.join(format!("{verb}.json"));
            if let Ok(mut f) = std::fs::OpenOptions::new().write(true).create_new(true).open(&dest) {
                let _ = std::io::Write::write_all(&mut f, text.as_bytes());
            }
        } else {
            eprintln!("[live] catalog writer for {verb} left no playable script");
        }
        let _ = std::fs::remove_dir_all(&work);
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_a_list_of_moves_enters_the_catalog() {
        assert!(super::playable(r#"{"title":"x","steps":[{"do":"wait"}]}"#));
        assert!(!super::playable("[1,2]") && !super::playable(r#"{"steps":"walk"}"#) && !super::playable("not json"));
    }

    #[test]
    fn a_verb_is_a_safe_file_name() {
        assert!(super::valid("git.push") && super::valid("cmd.magick") && super::valid("mcp.slack"));
        assert!(!super::valid("../x") && !super::valid("a/b") && !super::valid(""));
    }
}
