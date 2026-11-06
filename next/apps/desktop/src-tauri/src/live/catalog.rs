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

/// The verb a dotted verb falls back to: `cmd.echo` → `cmd`.
fn family(verb: &str) -> Option<&str> {
    verb.rsplit_once('.').map(|(f, _)| f)
}

/// A verb is also a file name: only the characters verbs.rs makes.
fn valid(verb: &str) -> bool {
    !verb.is_empty() && verb.len() <= 40 && verb.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '-'))
}

/// Makes the catalog folder. The first time, it also writes the seed scripts. Once per run it
/// brings older seeds up to date.
fn ensure() -> Option<PathBuf> {
    let dir = dir();
    if dir.is_dir() {
        static UPGRADED: std::sync::Once = std::sync::Once::new();
        UPGRADED.call_once(|| upgrade_seeds(&dir));
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

/// A seed with a higher `rev` replaces an older copy of itself in the catalog: a file with an
/// older rev, the seed's own title, and no owner's improvement. A deleted seed stays deleted.
/// The old file is kept beside it as `<verb>.json.v<rev>`, which the catalog never reads, so a
/// writer's script that only looked like a seed can be put back. Seeds got `rev` 2 when green and
/// red became result colours.
fn upgrade_seeds(dir: &std::path::Path) {
    let Ok(Value::Object(seeds)) = serde_json::from_str::<Value>(SEEDS) else { return };
    let rev = |v: &Value| v.get("rev").and_then(Value::as_u64).unwrap_or(1);
    for (verb, seed) in seeds {
        let path = dir.join(format!("{verb}.json"));
        let Some(have) = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) else { continue };
        let old = rev(&have);
        if !valid(&verb) || old >= rev(&seed) || have.get("title") != seed.get("title") || have.get("improved").is_some() {
            continue;
        }
        if std::fs::copy(&path, dir.join(format!("{verb}.json.v{old}"))).is_ok() {
            let _ = std::fs::write(&path, serde_json::to_vec_pretty(&seed).unwrap_or_default());
        }
    }
}

/// Every script, with its verb and when it was written, every verb still being written as
/// `{verb, pending: true}`, and `improving: true` on a script being rewritten. A file that is not
/// JSON is skipped.
pub fn read() -> Vec<Value> {
    let Ok(entries) = std::fs::read_dir(dir()) else { return Vec::new() };
    let files: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    // A marker past the writer's limit is only a retry wait: no writer runs, so it is not
    // "being written". Listed, it read so forever in the catalog.
    let pending = files.iter().filter_map(|p| {
        let young = p.metadata().and_then(|m| m.modified()).ok().and_then(|t| SystemTime::now().duration_since(t).ok()).is_some_and(|d| d < WRITER_LIMIT);
        let verb = p.file_name()?.to_str()?.strip_suffix(".pending").filter(|_| young)?;
        (!files.iter().any(|f| f.file_name().and_then(|n| n.to_str()) == Some(&format!("{verb}.json")))).then(|| serde_json::json!({ "verb": verb, "pending": true }))
    });
    let mut out: Vec<Value> = files
        .iter()
        .filter_map(|path| {
            let verb = path.file_name()?.to_str()?.strip_suffix(".json")?.to_string();
            let mut v: Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
            let made = path.metadata().ok()?.modified().ok()?.duration_since(SystemTime::UNIX_EPOCH).ok()?.as_millis() as u64;
            let o = v.as_object_mut()?;
            let busy = path.with_extension("improving").metadata().and_then(|m| m.modified()).ok().and_then(|t| SystemTime::now().duration_since(t).ok()).is_some_and(|d| d < WRITER_LIMIT);
            if busy {
                o.insert("improving".into(), true.into());
            }
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
        // `cmd.echo` plays its family's `cmd` script (live.ts `scriptFor`). A Sonnet run per shell
        // word spent quota on `ls`, `echo` and `for` for a look no one could tell apart.
        if family(verb).is_some_and(|f| dir.join(format!("{f}.json")).exists()) {
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
        // A writer that did not start keeps its marker: the retry wait stops a launch loop.
        let _ = spawn_writer(&dir, verb, Ask::New { example: example.clone() });
    }
    let _ = std::fs::write(&log, started.iter().map(|t| format!("{t}\n")).collect::<String>());
}

/// The owner's "make this one better": a writer rewrites the script with the owner's note and
/// the new one replaces it. The old one stays until a playable rewrite exists.
/// Owner, 2026-11-06: "Agents must be able to improve the dots on Live, come up with new kinds
/// of animations."
pub fn improve(verb: &str, note: &str) -> Result<(), String> {
    if !valid(verb) {
        return Err(format!("{verb} is not a verb"));
    }
    let dir = ensure().ok_or("the catalog folder could not be made")?;
    let old = std::fs::read_to_string(dir.join(format!("{verb}.json"))).map_err(|_| format!("{verb} has no animation to improve"))?;
    let mark = dir.join(format!("{verb}.improving"));
    if mark.metadata().and_then(|m| m.modified()).ok().and_then(|t| SystemTime::now().duration_since(t).ok()).is_some_and(|d| d < WRITER_LIMIT) {
        return Err(format!("{verb} is already being improved"));
    }
    std::fs::write(&mark, note).map_err(|e| e.to_string())?;
    if !spawn_writer(&dir, verb, Ask::Improve { old, note: note.trim().chars().take(400).collect() }) {
        // No writer runs, so nothing is being improved and a retry must not wait.
        let _ = std::fs::remove_file(&mark);
        return Err(format!("the writer for {verb} did not start"));
    }
    Ok(())
}

enum Ask {
    New { example: String },
    Improve { old: String, note: String },
}

/// A script the player can run: an object with a list of moves.
fn playable(text: &str) -> bool {
    serde_json::from_str::<Value>(text).is_ok_and(|v| v.get("steps").is_some_and(Value::is_array))
}

/// A writer that runs longer than this is killed.
const WRITER_LIMIT: Duration = Duration::from_secs(300);

/// Runs one writer in its own scratch folder. A new script moves into the catalog only if it is
/// playable and the verb still has none. An improvement replaces its script only when playable.
/// False when the writer did not start.
fn spawn_writer(dir: &PathBuf, verb: &str, ask: Ask) -> bool {
    let work = dir.join(".writing").join(verb);
    let _ = std::fs::remove_dir_all(&work);
    if let Err(e) = std::fs::create_dir_all(&work) {
        eprintln!("[live] catalog writer for {verb}: {e}");
        return false;
    }
    let examples: Vec<String> = ["git.push", "search", "spawn"]
        .iter()
        .filter_map(|v| std::fs::read_to_string(dir.join(format!("{v}.json"))).ok().map(|s| format!("{v}.json:\n{s}")))
        .collect();
    let job = match &ask {
        Ask::New { example } => format!("An agent just did a step with the verb `{verb}`. Example step: \"{example}\".\nWrite the file `{verb}.json` in the current folder."),
        Ask::Improve { old, note } => format!(
            "The owner wants the animation for the verb `{verb}` improved. The owner's note: \"{note}\".\n\
             The current script:\n{old}\n\
             Write a better one as the file `{verb}.json` in the current folder. Keep what works, fix what the note asks. \
             If no glyph fits, draw a new one under \"glyphs\"."
        ),
    };
    let prompt = format!(
        "You write one animation script for Panel Live, a dark map where coding agents are small glowing electrons.\n\
         {job}\n\
         It is a JSON object in the language described at the top of the player below. Follow WHAT A GOOD SCRIPT DOES there: \
         the owner must read what kind of work this is at a glance, so show one thing moving from where it is to where it goes, \
         name it with a glyph and at most one short tag, and keep green and red out of it. Use the places, moves and glyphs the player knows. Nothing else.\n\
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
            return false;
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
        let dest = dir.join(format!("{verb}.json"));
        match (&ask, playable(&text)) {
            (_, false) => eprintln!("[live] catalog writer for {verb} left no playable script"),
            (Ask::New { .. }, true) => {
                if let Ok(mut f) = std::fs::OpenOptions::new().write(true).create_new(true).open(&dest) {
                    let _ = std::io::Write::write_all(&mut f, text.as_bytes());
                }
                // Done: the marker only holds back a retry, and a stale one read as "being written".
                let _ = std::fs::remove_file(dir.join(format!("{verb}.pending")));
            }
            (Ask::Improve { note, .. }, true) => {
                // Marked, so a seed upgrade never puts the old look back.
                let mut v: Value = serde_json::from_str(&text).unwrap_or_default();
                if let Some(o) = v.as_object_mut() {
                    o.insert("improved".into(), note.clone().into());
                }
                let tmp = work.join("improved.json");
                if std::fs::write(&tmp, serde_json::to_vec_pretty(&v).unwrap_or_default()).is_ok() {
                    let _ = std::fs::rename(&tmp, &dest);
                }
            }
        }
        if matches!(ask, Ask::Improve { .. }) {
            let _ = std::fs::remove_file(dir.join(format!("{verb}.improving")));
        }
        let _ = std::fs::remove_dir_all(&work);
    });
    true
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
