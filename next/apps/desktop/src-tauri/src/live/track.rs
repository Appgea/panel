//! What one agent is doing, read from its transcript as it grows.
//!
//! Claude's `~/.claude/projects/<folder>/<session>.jsonl` and Codex's
//! `~/.codex/sessions/<y>/<m>/<d>/rollout-…-<session>.jsonl` are read once, then only the bytes
//! added since. The fold keeps what Live shows: the task, the model, the step running now, the
//! steps before it and the last thing the agent said. Tool results are skipped on their first
//! bytes, except for the id that closes their step.
//!
//! No command text, prompt or file content leaves this module. A step is a plain label: Claude's
//! own description of a command, or "Edited main.dart". Secrets live in the raw text.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Steps kept per agent. The panel shows these, newest first.
const STEPS: usize = 40;
/// A transcript larger than this is read from its last part only. The task then comes from the
/// session's title, which Claude rewrites as it goes.
const TAIL_BYTES: u64 = 8 << 20;
const HEAD_BYTES: usize = 400;
const CODEX_COMMAND: &str = "Running a command";
/// A Codex line longer than this is a tool's output or a context blob, never a step.
const CODEX_LINE_MAX: usize = 256 << 10;

/// How far along its work a step puts an agent. The dot stands in that part of its room.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Station {
    #[default]
    Plan,
    Build,
    Check,
    Ship,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub at_ms: u64,
    pub label: String,
    pub station: Station,
    /// The full path of a file the step read or wrote, so the panel can open it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    /// A helper the agent started, which counts as a subagent while it runs.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub helper: bool,
    /// The agent asked the owner a question and waits for the answer.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub asks: bool,
    /// The kind of work, like `git.push`, which picks its animation (verbs.rs).
    #[serde(default)]
    pub verb: String,
}

/// One transcript folded so far.
#[derive(Debug, Clone, Default)]
pub struct Track {
    pub title: Option<String>,
    pub first_prompt: Option<String>,
    pub model: Option<String>,
    /// Steps still running, by tool id, in the order they started.
    pub open: Vec<(String, Step)>,
    /// Finished steps, newest last.
    pub done: VecDeque<Step>,
    pub last_text: Option<String>,
    /// Counts every step that ever started, so the view can pulse once per new one.
    pub steps: u32,
    pub files: Vec<String>,
    pub last_ms: u64,
    /// The board issue the agent last named, like `#1162`. The view looks its title up.
    pub issue: Option<u32>,
    read_len: u64,
}

/// Which transcript format a session writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Claude,
    Codex,
}

impl Track {
    /// The step running now: the newest open one. A Codex command is named by what Codex last
    /// said it was doing.
    pub fn now(&self) -> Option<Step> {
        let (_, s) = self.open.last()?;
        let mut s = s.clone();
        if s.label == CODEX_COMMAND {
            if let Some(said) = self.done.back() {
                s.label = said.label.clone();
                s.station = said.station;
            }
        }
        Some(s)
    }

    pub fn helpers(&self) -> u32 {
        self.open.iter().filter(|(_, s)| s.helper).count() as u32
    }

    pub fn asks(&self) -> bool {
        self.open.iter().any(|(_, s)| s.asks)
    }

    /// Newest first, the running ones on top.
    pub fn recent(&self, n: usize) -> Vec<Step> {
        let open = self.open.iter().rev().filter(|(_, s)| s.label != CODEX_COMMAND).map(|(_, s)| s.clone());
        open.chain(self.done.iter().rev().cloned()).take(n).collect()
    }

    pub fn task(&self) -> Option<String> {
        self.title.clone().or_else(|| self.first_prompt.clone())
    }

    fn fold(&mut self, record: &Value) {
        match record["type"].as_str().unwrap_or_default() {
            "ai-title" => {
                if let Some(t) = record["aiTitle"].as_str().map(one_line).filter(|t| !t.is_empty()) {
                    self.title = Some(t);
                }
                return;
            }
            "user" | "assistant" => {}
            _ => return,
        }
        if record["isSidechain"] == true {
            return;
        }
        let at = record["timestamp"].as_str().and_then(parse_ms).unwrap_or(self.last_ms);
        self.last_ms = self.last_ms.max(at);
        let message = &record["message"];
        if record["type"] == "user" {
            if record["isMeta"] == true || self.first_prompt.is_some() {
                return;
            }
            let text = match &message["content"] {
                Value::String(t) => t.clone(),
                Value::Array(blocks) => blocks.iter().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n"),
                _ => return,
            };
            let text = one_line(&text);
            if !text.is_empty() && !text.starts_with('<') && !text.starts_with("[Request interrupted") {
                self.first_prompt = Some(text);
            }
            return;
        }
        if let Some(model) = message["model"].as_str().filter(|m| m.starts_with("claude") || !m.starts_with('<')) {
            if !model.is_empty() && !model.starts_with('<') {
                self.model = Some(model.to_string());
            }
        }
        for block in message["content"].as_array().into_iter().flatten() {
            match block["type"].as_str().unwrap_or_default() {
                "text" => self.said(block["text"].as_str().unwrap_or_default()),
                "tool_use" => {
                    let id = block["id"].as_str().unwrap_or_default().to_string();
                    let Some(step) = step(block["name"].as_str().unwrap_or_default(), &block["input"], at) else { continue };
                    if let Some(f) = step.file.as_ref().filter(|_| step.station == Station::Build) {
                        if !self.files.contains(f) {
                            self.files.push(f.clone());
                        }
                    }
                    self.steps += 1;
                    if id.is_empty() {
                        self.finish(step);
                    } else if !self.open.iter().any(|(open, _)| *open == id) {
                        self.open.push((id, step));
                    }
                }
                _ => {}
            }
        }
    }

    fn said(&mut self, text: &str) {
        let t = one_line(text);
        if t.is_empty() {
            return;
        }
        if let Some(n) = issue_in(text) {
            self.issue = Some(n);
        }
        self.last_text = Some(t);
    }

    /// One Codex rollout record. Codex writes no description for a command, but it narrates
    /// between commands, so each thing it says is a step and each command keeps it working.
    fn fold_codex(&mut self, record: &Value) {
        let at = record["timestamp"].as_str().and_then(parse_ms).unwrap_or(self.last_ms);
        self.last_ms = self.last_ms.max(at);
        let p = &record["payload"];
        match (record["type"].as_str().unwrap_or_default(), p["type"].as_str().unwrap_or_default()) {
            ("turn_context", _) => {
                if let Some(m) = p["model"].as_str().filter(|m| !m.is_empty()) {
                    self.model = Some(m.to_string());
                }
            }
            ("response_item", "message") => {
                let text: String = p["content"].as_array().into_iter().flatten().filter_map(|c| c["text"].as_str()).collect::<Vec<_>>().join("\n");
                if p["role"] == "user" {
                    if self.first_prompt.is_none() {
                        let line = one_line(&text);
                        // Codex sends the folder's AGENTS.md as the first user message.
                        if !line.is_empty() && !line.starts_with('<') && !line.contains("AGENTS.md instructions") {
                            self.first_prompt = Some(line);
                        }
                    }
                } else if p["role"] == "assistant" {
                    self.said(&text);
                    if let Some(label) = self.last_text.clone() {
                        self.steps += 1;
                        let station = station_of(&label);
                        self.finish(Step { at_ms: at, label: clip(&label, 90), station, file: None, helper: false, asks: false, verb: "think".into() });
                    }
                }
            }
            ("response_item", "custom_tool_call" | "function_call" | "local_shell_call") => {
                let id = p["call_id"].as_str().unwrap_or_default().to_string();
                let station = self.done.back().map(|s| s.station).unwrap_or(Station::Build);
                let verb = super::verbs::of_tool(p["name"].as_str().unwrap_or("shell"), codex_command(p).as_deref());
                let step = Step { at_ms: at, label: CODEX_COMMAND.into(), station, file: None, helper: false, asks: false, verb };
                if !id.is_empty() && !self.open.iter().any(|(o, _)| *o == id) {
                    self.open.push((id, step));
                }
            }
            _ => {}
        }
    }

    fn close(&mut self, tool_id: &str) {
        if let Some(i) = self.open.iter().position(|(id, _)| id == tool_id) {
            let (_, step) = self.open.remove(i);
            // A Codex command says nothing on its own. Its narration is the step.
            if step.label != CODEX_COMMAND {
                self.finish(step);
            }
        }
    }

    fn finish(&mut self, step: Step) {
        if self.done.len() >= STEPS {
            self.done.pop_front();
        }
        self.done.push_back(step);
    }
}

/// A tool call as a plain step, or None for bookkeeping the owner has no use for.
fn step(name: &str, input: &Value, at_ms: u64) -> Option<Step> {
    let s = |key: &str| input[key].as_str().map(str::trim).filter(|v| !v.is_empty());
    let file = s("file_path").or_else(|| s("notebook_path")).map(str::to_string);
    let base = file.as_deref().map(|f| f.rsplit('/').next().unwrap_or(f).to_string()).unwrap_or_default();
    let mut helper = false;
    let mut asks = false;
    let (label, station) = match name {
        "Bash" => {
            let what = s("description").map(one_line).unwrap_or_else(|| "Ran a command".into());
            let station = station_of(&what);
            (what, station)
        }
        "Edit" | "MultiEdit" | "NotebookEdit" => (format!("Edited {base}"), Station::Build),
        "Write" => (format!("Wrote {base}"), Station::Build),
        "Read" => (format!("Read {base}"), Station::Plan),
        "Grep" | "Glob" | "LSP" => ("Searched the code".into(), Station::Plan),
        "WebSearch" | "WebFetch" => ("Read the web".into(), Station::Plan),
        "Agent" | "Task" => {
            helper = true;
            let what = s("description").map(one_line).unwrap_or_else(|| "a task".into());
            (format!("Helper: {what}"), Station::Plan)
        }
        "Skill" => (format!("Loaded the {} skill", s("skill").unwrap_or("a")), Station::Plan),
        "AskUserQuestion" => {
            asks = true;
            ("Asked you a question".into(), Station::Plan)
        }
        "SendMessage" => ("Messaged another session".into(), Station::Plan),
        "Artifact" => ("Published a page".into(), Station::Ship),
        "Workflow" => ("Ran a workflow of agents".into(), Station::Build),
        n if n.starts_with("mcp__") => {
            let server = n.trim_start_matches("mcp__").split("__").next().unwrap_or("a tool");
            let server = server.trim_start_matches("claude_ai_").replace('_', " ");
            (format!("Used {server}"), Station::Build)
        }
        // Planning notes and tool loading say nothing about the work.
        "TodoWrite" | "ToolSearch" | "TaskCreate" | "TaskUpdate" | "TaskList" | "TaskGet" | "TaskOutput" | "TaskStop"
        | "ScheduleWakeup" | "EnterPlanMode" | "ExitPlanMode" | "Monitor" | "ListAgents" => return None,
        other => (other.to_string(), Station::Build),
    };
    let verb = super::verbs::of_tool(name, s("command"));
    Some(Step { at_ms, label: clip(&label, 90), station, file, helper, asks, verb })
}

/// The shell text of a Codex call: `arguments` is a JSON string with `cmd` or a `command`
/// list, and a local shell call keeps the list under `action`.
fn codex_command(p: &Value) -> Option<String> {
    let args: Value = p["arguments"].as_str().and_then(|a| serde_json::from_str(a).ok()).unwrap_or(Value::Null);
    let join = |v: &Value| v.as_array().map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" "));
    args["cmd"].as_str().map(str::to_string).or_else(|| join(&args["command"])).or_else(|| join(&p["action"]["command"]))
}

/// Where a command's own description puts the work. Checked words first: "build and test" is a check.
pub(crate) fn station_of(what: &str) -> Station {
    let w = what.to_lowercase();
    let has = |words: &[&str]| words.iter().any(|k| w.contains(k));
    if has(&["commit", "push", "land", "release", "deploy", "publish", "upload", "carry", "board done", "ship"]) {
        Station::Ship
    } else if has(&["test", "typecheck", "type-check", "lint", "check", "verify", "review", "build", "compile", "screenshot", "render"]) {
        Station::Check
    } else if has(&["list", "find", "read", "show", "search", "inspect", "look", "status", "log", "fetch", "sync", "pull"]) {
        Station::Plan
    } else {
        Station::Build
    }
}

fn one_line(text: &str) -> String {
    let line = text.trim().lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or_default();
    // Markdown marks read as noise on a one-line label.
    clip(line.trim_start_matches(['#', '*', '-', '>', ' ']).replace("**", "").replace('`', "").trim(), 160)
}

fn clip(text: &str, chars: usize) -> String {
    match text.char_indices().nth(chars) {
        Some((at, _)) => format!("{}…", text[..at].trim_end()),
        None => text.to_string(),
    }
}

/// `2026-11-04T19:01:59.063Z` → Unix milliseconds. Only the UTC form Claude writes.
pub(crate) fn parse_ms(iso: &str) -> Option<u64> {
    let b = iso.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[10] != b'T' {
        return None;
    }
    let n = |from: usize, len: usize| iso.get(from..from + len)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, s) = (n(0, 4)?, n(5, 2)?, n(8, 2)?, n(11, 2)?, n(14, 2)?, n(17, 2)?);
    let ms = if b.get(19) == Some(&b'.') { n(20, 3).unwrap_or(0) } else { 0 };
    // Days from the civil date, after Howard Hinnant's algorithm.
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * ((mo + 9) % 12) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    u64::try_from(((days * 86_400 + h * 3600 + mi * 60 + s) * 1000) + ms).ok()
}

/// The newest `#1234` in a text: the issue an agent works on usually comes up as it reports.
fn issue_in(text: &str) -> Option<u32> {
    let b = text.as_bytes();
    let mut found = None;
    for (i, _) in text.match_indices('#') {
        let digits: String = text[i + 1..].chars().take_while(|c| c.is_ascii_digit()).collect();
        let before_ok = i == 0 || !b[i - 1].is_ascii_alphanumeric();
        if before_ok && (3..=5).contains(&digits.len()) {
            found = digits.parse().ok();
        }
    }
    found
}

/// Tracks by session id, with the file each one reads.
type Tracks = HashMap<String, (PathBuf, Kind, Track)>;

fn tracks() -> &'static Mutex<Tracks> {
    static TRACKS: OnceLock<Mutex<Tracks>> = OnceLock::new();
    TRACKS.get_or_init(Default::default)
}

/// The folded transcript of each running session, brought up to date. Sessions no longer in
/// `sessions` fall out, so the cache holds only what runs now.
pub fn read(home: &Path, sessions: &[(String, Kind)]) -> HashMap<String, Track> {
    let mut all = tracks().lock().unwrap_or_else(|p| p.into_inner());
    all.retain(|s, _| sessions.iter().any(|(id, _)| id == s));
    let mut out = HashMap::new();
    for (session, kind) in sessions {
        if !all.contains_key(session) {
            let found = match kind {
                Kind::Claude => find_claude(home, session),
                Kind::Codex => find_codex(home, session),
            };
            let Some(path) = found else { continue };
            all.insert(session.clone(), (path, *kind, Track::default()));
        }
        let (path, kind, track) = all.get_mut(session).expect("inserted above");
        refresh(track, path, *kind);
        out.insert(session.clone(), track.clone());
    }
    out
}

fn find_claude(home: &Path, session: &str) -> Option<PathBuf> {
    let root = std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).unwrap_or_else(|| home.join(".claude")).join("projects");
    let name = format!("{session}.jsonl");
    std::fs::read_dir(root).ok()?.flatten().map(|e| e.path().join(&name)).find(|p| p.is_file())
}

/// A rollout's name ends in its session id. Only the newest days can hold a running one.
fn find_codex(home: &Path, session: &str) -> Option<PathBuf> {
    let tail = format!("{session}.jsonl");
    let root = home.join(".codex/sessions");
    let newest = |dir: &Path| -> Vec<PathBuf> {
        let mut d: Vec<PathBuf> = std::fs::read_dir(dir).map(|r| r.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect()).unwrap_or_default();
        d.sort();
        d.reverse();
        d
    };
    for year in newest(&root).into_iter().take(1) {
        for month in newest(&year).into_iter().take(2) {
            for day in newest(&month).into_iter().take(3) {
                let hit = std::fs::read_dir(&day).ok()?.flatten().map(|e| e.path()).find(|p| p.to_string_lossy().ends_with(&tail));
                if hit.is_some() {
                    return hit;
                }
            }
        }
    }
    None
}

pub(crate) fn refresh(track: &mut Track, path: &Path, kind: Kind) {
    let len = path.metadata().map(|m| m.len()).unwrap_or(0);
    if len < track.read_len {
        *track = Track::default();
    }
    if len == track.read_len {
        return;
    }
    let tail = track.read_len == 0 && len > TAIL_BYTES;
    let from = if tail { len - TAIL_BYTES } else { track.read_len };
    let Ok(mut file) = File::open(path) else { return };
    if file.seek(SeekFrom::Start(from)).is_err() {
        return;
    }
    let mut reader = BufReader::with_capacity(1 << 20, file);
    let mut line = Vec::new();
    let mut at = from;
    // A first read of a long file's tail lands inside a line. That first piece is dropped.
    let mut first = tail;
    loop {
        line.clear();
        let Ok(n) = reader.read_until(b'\n', &mut line) else { break };
        if n == 0 || line.last() != Some(&b'\n') {
            break;
        }
        at += n as u64;
        if std::mem::take(&mut first) {
            continue;
        }
        let head = &line[..line.len().min(HEAD_BYTES)];
        if kind == Kind::Codex {
            if contains(head, b"_call_output\"") {
                if let Some(id) = quoted_after(head, b"\"call_id\":\"") {
                    track.close(&id);
                }
                continue;
            }
            if line.len() <= CODEX_LINE_MAX {
                if let Ok(record) = serde_json::from_slice::<Value>(&line) {
                    track.fold_codex(&record);
                }
            }
            continue;
        }
        if let Some(id) = quoted_after(head, b"\"tool_use_id\":\"") {
            track.close(&id);
            continue;
        }
        if line.starts_with(b"{\"type\":") && !line.starts_with(b"{\"type\":\"ai-title\"") {
            continue;
        }
        if let Ok(record) = serde_json::from_slice::<Value>(&line) {
            track.fold(&record);
        }
    }
    track.read_len = at;
}

fn contains(head: &[u8], needle: &[u8]) -> bool {
    head.windows(needle.len()).any(|w| w == needle)
}

/// The id a tool result line closes, read from its first bytes without parsing the whole line,
/// which can be megabytes.
fn quoted_after(head: &[u8], key: &[u8]) -> Option<String> {
    let at = head.windows(key.len()).position(|w| w == key)? + key.len();
    let rest = &head[at..];
    let end = rest.iter().position(|&c| c == b'"')?;
    String::from_utf8(rest[..end].to_vec()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    #[test]
    fn a_step_runs_until_its_result_and_labels_carry_no_command_text() {
        let dir = std::env::temp_dir().join(format!("panel-live-track-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.jsonl");
        let line = |v: Value| format!("{v}\n");
        let mut f = File::create(&path).unwrap();
        for l in [
            line(serde_json::json!({"type": "user", "timestamp": "2026-11-04T10:00:00.000Z", "message": {"content": "Fix the dice sound\nmore detail"}})),
            line(serde_json::json!({"type": "assistant", "timestamp": "2026-11-04T10:00:05.000Z", "message": {"model": "claude-opus-5-5",
                "content": [{"type": "text", "text": "**Looking** at it."}, {"type": "tool_use", "id": "t1", "name": "Bash",
                "input": {"command": "TOKEN=abc flutter test", "description": "Run the dice tests"}}]}})),
        ] {
            f.write_all(l.as_bytes()).unwrap();
        }
        let mut t = Track::default();
        refresh(&mut t, &path, Kind::Claude);
        assert_eq!(t.task().as_deref(), Some("Fix the dice sound"));
        assert_eq!(t.model.as_deref(), Some("claude-opus-5-5"));
        let now = t.now().expect("the command is still running");
        assert_eq!((now.label.as_str(), now.station), ("Run the dice tests", Station::Check));
        assert_eq!(t.last_text.as_deref(), Some("Looking at it."));

        f.write_all(line(serde_json::json!({"type": "user", "message": {"content": [{"tool_use_id": "t1", "type": "tool_result", "content": "ok"}]}})).as_bytes()).unwrap();
        refresh(&mut t, &path, Kind::Claude);
        assert!(t.now().is_none(), "the result closes the step");
        assert_eq!(t.recent(5)[0].label, "Run the dice tests");
        assert!(!format!("{:?}", t.recent(5)).contains("TOKEN"));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn iso_times_become_unix_ms() {
        assert_eq!(parse_ms("1970-01-01T00:00:01.500Z"), Some(1500));
        assert_eq!(parse_ms("2026-11-04T00:00:00Z"), Some(1_793_750_400_000));
    }
}
