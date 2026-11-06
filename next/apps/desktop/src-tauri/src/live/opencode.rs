//! What a running OpenCode agent does, read from `~/.local/share/opencode/opencode.db`.
//!
//! `session_v2` names each session and its parent, `session_message` holds each assistant turn
//! with its tool calls. Only the newest turns of the sessions running now are read. As in
//! track.rs, no command text leaves this module: a shell call becomes "Ran git", plus the paths it
//! names for placing the agent.

use super::track::{path_hints, station_of, Station, Step, Track};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;

/// Turns read per session. The view shows a few steps and the newest words.
const TURNS: u32 = 20;
/// A child session (a subagent) counts as running while it was written this recently.
const CHILD_FRESH_MS: i64 = 90_000;

fn database() -> Option<PathBuf> {
    let data = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))?;
    Some(data.join("opencode").join("opencode.db")).filter(|p| p.is_file())
}

/// One running OpenCode agent to read: its id in Live and the session its command line names.
pub struct Want {
    pub agent: String,
    pub session: Option<String>,
}

pub struct Read {
    pub session: String,
    pub title: Option<String>,
    pub track: Track,
    /// Running child sessions: (id, title, track).
    pub subs: Vec<(String, Option<String>, Track)>,
}

/// The session named on an `opencode -s <id>` command line.
pub fn session_in_args(args: &str) -> Option<String> {
    let mut words = args.split_whitespace();
    while let Some(w) = words.next() {
        if w == "-s" || w == "--session" {
            return words.next().map(str::to_string);
        }
        if let Some(id) = w.strip_prefix("--session=") {
            return Some(id.to_string());
        }
    }
    None
}

/// Reads every wanted agent that names its session.
pub fn read(wants: &[Want], now_ms: u64) -> HashMap<String, Read> {
    let mut out = HashMap::new();
    if !wants.iter().any(|w| w.session.is_some()) {
        return out;
    }
    let Some(db) = database().and_then(|p| crate::history::sqlite(&p).ok()) else { return out };
    for w in wants {
        // Matching an `opencode run` to a session by folder and time put a Cardly worker on an
        // Interbellum session. A guess that looks sure is worse than a blank, so only a session the
        // command line names is read. Fleet workers say their issue through the board log instead.
        let Some(session) = w.session.clone() else { continue };
        let title: Option<String> = db.query_row("SELECT title FROM session_v2 WHERE id = ?1", [&session], |r| r.get(0)).ok().flatten();
        let track = fold(&db, &session);
        let mut subs = Vec::new();
        if let Ok(mut q) = db.prepare("SELECT id, title FROM session_v2 WHERE parent_id = ?1 AND time_updated >= ?2 ORDER BY time_created") {
            let rows: Vec<(String, Option<String>)> = q.query_map(rusqlite::params![session, now_ms as i64 - CHILD_FRESH_MS], |r| Ok((r.get(0)?, r.get(1)?))).map(|rows| rows.flatten().collect()).unwrap_or_default();
            for (id, t) in rows {
                let track = fold(&db, &id);
                subs.push((id, t, track));
            }
        }
        out.insert(w.agent.clone(), Read { session, title, track, subs });
    }
    out
}

/// The newest turns of one session as a Track: the steps, the one running, the last words.
fn fold(db: &rusqlite::Connection, session: &str) -> Track {
    let mut t = Track::default();
    let Ok(mut q) = db.prepare("SELECT data FROM session_message WHERE session_id = ?1 AND type = 'assistant' ORDER BY seq DESC LIMIT ?2") else { return t };
    let turns: Vec<String> = q.query_map(rusqlite::params![session, TURNS], |r| r.get(0)).map(|rows| rows.flatten().collect()).unwrap_or_default();
    let mut stalled = None;
    // Oldest first, so the fold reads like the transcript.
    for raw in turns.iter().rev() {
        let Ok(turn) = serde_json::from_str::<Value>(raw) else { continue };
        let at = turn["time"]["created"].as_u64().unwrap_or(0);
        t.last_ms = t.last_ms.max(at);
        if let Some(m) = turn["model"]["id"].as_str() {
            t.model = Some(m.to_string());
        }
        // A turn that only holds a retry means the model's provider failed and OpenCode waits.
        // Only the newest turn says whether it still waits.
        stalled = turn["retry"]["error"]["message"].as_str().map(|e| {
            let n = turn["retry"]["attempt"].as_u64().unwrap_or(1);
            let why = if e.to_lowercase().contains("timed out") { "timed out" } else { "failed" };
            format!("The model provider {why}. Retry {n} is waiting.")
        });
        for c in turn["content"].as_array().into_iter().flatten() {
            match c["type"].as_str().unwrap_or_default() {
                "text" => {
                    if let Some(line) = c["text"].as_str().and_then(|x| x.lines().map(str::trim).find(|l| !l.is_empty())) {
                        t.last_text = Some(line.chars().take(160).collect());
                    }
                }
                "tool" => {
                    let input = &c["state"]["input"];
                    let command = input["command"].as_str();
                    for p in command.map(path_hints).unwrap_or_default().into_iter().chain(file_of(input)) {
                        t.saw_path(p);
                    }
                    let Some(step) = step(c["name"].as_str().unwrap_or_default(), input, command, at) else { continue };
                    if let Some(f) = step.file.as_ref().filter(|_| step.station == Station::Build) {
                        if !t.files.contains(f) {
                            t.files.push(f.clone());
                        }
                    }
                    t.steps += 1;
                    let running = matches!(c["state"]["status"].as_str(), Some("running" | "pending"));
                    if running {
                        t.open.push((c["id"].as_str().unwrap_or_default().to_string(), step));
                    } else {
                        if t.done.len() >= 40 {
                            t.done.pop_front();
                        }
                        t.done.push_back(step);
                    }
                }
                _ => {}
            }
        }
    }
    if stalled.is_some() {
        t.last_text = stalled;
    }
    t
}

/// The file a tool call names. OpenCode writes `path`; older builds wrote `filePath`.
fn file_of(input: &Value) -> Option<String> {
    input["path"].as_str().or_else(|| input["filePath"].as_str()).map(str::to_string)
}

fn step(name: &str, input: &Value, command: Option<&str>, at_ms: u64) -> Option<Step> {
    let file = file_of(input);
    let base = file.as_deref().map(|f| f.rsplit('/').next().unwrap_or(f).to_string()).unwrap_or_default();
    let mut helper = false;
    let (label, station) = match name {
        "shell" | "bash" => {
            let what = input["description"].as_str().map(str::to_string).unwrap_or_else(|| format!("Ran {}", command.map(program).unwrap_or_else(|| "a command".into())));
            let station = station_of(&format!("{what} {}", command.unwrap_or_default()));
            (what, station)
        }
        "edit" | "patch" | "multiedit" => (format!("Edited {base}"), Station::Build),
        "write" => (format!("Wrote {base}"), Station::Build),
        "read" => (format!("Read {base}"), Station::Plan),
        "grep" | "glob" | "list" => ("Searched the code".into(), Station::Plan),
        "webfetch" | "websearch" => ("Read the web".into(), Station::Plan),
        "task" => {
            helper = true;
            (format!("Helper: {}", input["description"].as_str().unwrap_or("a task")), Station::Plan)
        }
        "todowrite" | "todoread" => return None,
        other => (other.to_string(), Station::Build),
    };
    // Claude's names, so OpenCode's steps play the same scripts and never ask for new ones.
    let like = match name {
        "shell" | "bash" => "Bash",
        "edit" | "patch" | "multiedit" | "write" => "Edit",
        "read" => "Read",
        "grep" | "glob" | "list" => "Grep",
        "webfetch" | "websearch" => "WebFetch",
        "task" => "Task",
        other => other,
    };
    let verb = super::verbs::of_tool(like, command);
    Some(Step { at_ms, label: label.chars().take(90).collect(), station, file, helper, asks: false, verb, ok: None })
}

/// Tools whose first word after the program says what they do: `git show`, `flutter test`.
const VERBED: &[&str] = &["git", "gh", "flutter", "dart", "npm", "pnpm", "cargo", "board", "vk", "xcodebuild", "uv", "make", "testlock"];

/// The program a command runs, past `cd … &&` and env settings, with its subcommand when the
/// program has them: "git show", "flutter test", "python3". Never an argument that could hold data.
fn program(command: &str) -> String {
    let last = command.split(['|', ';']).next().unwrap_or(command);
    let last = last.rsplit("&&").next().unwrap_or(last);
    let mut words = last.split_whitespace().filter(|w| !w.contains('='));
    let Some(first) = words.next().map(|w| w.rsplit('/').next().unwrap_or(w)) else { return "a command".into() };
    match words.next().filter(|w| VERBED.contains(&first) && w.chars().all(|c| c.is_ascii_lowercase() || c == '-')) {
        Some(sub) => format!("{first} {sub}"),
        None => first.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_shell_call_says_only_its_program() {
        assert_eq!(program("cd ~/x/cardly && git show a:b | sed -n 1,9p"), "git show");
        assert_eq!(program("python3 /tmp/x.py --key=secret"), "python3");
        assert_eq!(session_in_args("/u/.opencode/bin/opencode -s ses_abc"), Some("ses_abc".into()));
        assert_eq!(session_in_args("/u/.opencode/bin/opencode run --auto"), None);
    }
}
