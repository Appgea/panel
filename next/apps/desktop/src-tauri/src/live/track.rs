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
/// Claude writes a failed tool result's flag right before its id, in every transcript checked.
const ERROR_ID: &[u8] = b"\"is_error\":true,\"tool_use_id\":\"";
/// How a failed command's result starts. Checked over 80 transcripts on 2026-11-06: the other
/// error results were hook blocks, tool refusals and the owner's denials.
const RAN_AND_FAILED: &[u8] = b"\"content\":\"Exit code ";
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
    /// How a finished step went: false when its tool result was an error. None while it runs,
    /// and for harnesses that do not say (Codex, opencode).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ok: Option<bool>,
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
    /// Paths the agent read, wrote or named in a command, newest last. They place it in the
    /// project it works on (mod.rs `Rooms::area`). Never sent to the view.
    pub paths: VecDeque<String>,
    /// The transcript this was read from. Its subagents sit in a folder beside it.
    pub path: PathBuf,
    /// A subagent's own transcript, where every record is a sidechain.
    side: bool,
    read_len: u64,
}

/// Paths kept per agent for placing it.
const PATHS: usize = 30;

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
        if record["isSidechain"] == true && !self.side {
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
                    let input = &block["input"];
                    for p in input["command"].as_str().map(path_hints).unwrap_or_default().into_iter().chain(input["file_path"].as_str().map(str::to_string)) {
                        self.saw_path(p);
                    }
                    let Some(step) = step(block["name"].as_str().unwrap_or_default(), input, at) else { continue };
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

    pub(crate) fn saw_path(&mut self, p: String) {
        self.paths.retain(|x| *x != p);
        if self.paths.len() >= PATHS {
            self.paths.pop_front();
        }
        self.paths.push_back(p);
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
                        self.finish(Step { at_ms: at, label: clip(&label, 90), station, file: None, helper: false, asks: false, verb: "think".into(), ok: None });
                    }
                }
            }
            ("response_item", "custom_tool_call" | "function_call" | "local_shell_call") => {
                let id = p["call_id"].as_str().unwrap_or_default().to_string();
                let station = self.done.back().map(|s| s.station).unwrap_or(Station::Build);
                let command = codex_command(p);
                for hint in command.as_deref().map(path_hints).unwrap_or_default() {
                    self.saw_path(hint);
                }
                let verb = super::verbs::of_tool(p["name"].as_str().unwrap_or("shell"), command.as_deref());
                let step = Step { at_ms: at, label: CODEX_COMMAND.into(), station, file: None, helper: false, asks: false, verb, ok: None };
                if !id.is_empty() && !self.open.iter().any(|(o, _)| *o == id) {
                    self.open.push((id, step));
                }
            }
            _ => {}
        }
    }

    fn close(&mut self, tool_id: &str, ok: Option<bool>) {
        if let Some(i) = self.open.iter().position(|(id, _)| id == tool_id) {
            let (_, mut step) = self.open.remove(i);
            step.ok = ok;
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
    Some(Step { at_ms, label: clip(&label, 90), station, file, helper, asks, verb, ok: None })
}

/// The absolute paths a shell command names, like `cd ~/x/tavla && …`. Only the paths are kept,
/// never the command, so no secret rides along.
pub(crate) fn path_hints(command: &str) -> Vec<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    command
        .split(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | ';' | '&' | '|' | '(' | ')' | '=' | '`'))
        .filter_map(|t| {
            let t = t.trim_end_matches([',', ':']);
            if let Some(rest) = t.strip_prefix("~/") {
                Some(format!("{home}/{rest}"))
            } else {
                (t.starts_with('/') && t.len() > 1 && !t.starts_with("/dev/")).then(|| t.to_string())
            }
        })
        .take(4)
        .collect()
}

/// A subagent that still runs, read from `<session>/subagents/agent-<id>.jsonl` and its meta file.
#[derive(Debug, Clone)]
pub struct Sub {
    pub id: String,
    /// The agent type, like `Explore` or `general-purpose`.
    pub kind: Option<String>,
    /// What the parent asked it to do, in the parent's own words.
    pub what: Option<String>,
    pub model: Option<String>,
    pub started_ms: Option<u64>,
    pub track: Track,
}

/// A subagent whose meta never said `finished` counts as gone once its transcript is this quiet,
/// so a crashed one does not haunt the map.
const SUB_QUIET_MS: u64 = 15 * 60 * 1000;

fn subs_cache() -> &'static Mutex<HashMap<PathBuf, Track>> {
    static SUBS: OnceLock<Mutex<HashMap<PathBuf, Track>>> = OnceLock::new();
    SUBS.get_or_init(Default::default)
}

/// The running subagents of each transcript in `parents`. A finished one costs one small meta
/// read. A running one's transcript is followed like any other, from the bytes added since.
pub fn subs(parents: &[PathBuf], now_ms: u64) -> HashMap<PathBuf, Vec<Sub>> {
    let mut cache = subs_cache().lock().unwrap_or_else(|p| p.into_inner());
    let mut live = std::collections::HashSet::new();
    let mut out = HashMap::new();
    let ms = |t: std::time::SystemTime| t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).ok();
    for parent in parents {
        let Ok(entries) = std::fs::read_dir(parent.with_extension("").join("subagents")) else { continue };
        let mut found = Vec::new();
        for e in entries.flatten() {
            let path = e.path();
            let Some(id) = path.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_prefix("agent-")).and_then(|n| n.strip_suffix(".jsonl")).map(str::to_string) else { continue };
            let Ok(meta_fs) = e.metadata() else { continue };
            if now_ms.saturating_sub(meta_fs.modified().ok().and_then(ms).unwrap_or(0)) > SUB_QUIET_MS {
                continue;
            }
            let meta: Value = std::fs::read(path.with_extension("meta.json")).ok().and_then(|raw| serde_json::from_slice(&raw).ok()).unwrap_or(Value::Null);
            if meta["finished"] == true {
                continue;
            }
            let track = cache.entry(path.clone()).or_insert_with(|| Track { side: true, ..Track::default() });
            refresh(track, &path, Kind::Claude);
            live.insert(path.clone());
            let text = |k: &str| meta[k].as_str().map(str::to_string).filter(|s| !s.is_empty());
            found.push(Sub {
                kind: text("agentType"),
                what: text("description"),
                model: track.model.clone().or_else(|| text("model")),
                started_ms: meta_fs.created().ok().and_then(ms),
                track: track.clone(),
                id,
            });
        }
        found.sort_by(|a, b| a.started_ms.cmp(&b.started_ms).then(a.id.cmp(&b.id)));
        out.insert(parent.clone(), found);
    }
    cache.retain(|p, _| live.contains(p));
    out
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

/// The folded transcript of each running session, brought up to date, and of each session that
/// just left `sessions`, read to its end one last time. Those fall out, so the cache holds only
/// what runs now. The last read matters: a `claude -p` run writes its answer and exits inside
/// one poll, and judged on the poll before, every such run looked crashed.
pub fn read(home: &Path, sessions: &[(String, Kind)]) -> (HashMap<String, Track>, HashMap<String, Track>) {
    let mut all = tracks().lock().unwrap_or_else(|p| p.into_inner());
    let gone: Vec<String> = all.keys().filter(|s| !sessions.iter().any(|(id, _)| id == *s)).cloned().collect();
    let mut ended = HashMap::new();
    for session in gone {
        if let Some((path, kind, mut track)) = all.remove(&session) {
            refresh(&mut track, &path, kind);
            ended.insert(session, track);
        }
    }
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
        track.path = path.clone();
        refresh(track, path, *kind);
        out.insert(session.clone(), track.clone());
    }
    (out, ended)
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
        // Rewritten from the start. What says how to read it stays.
        *track = Track { side: track.side, path: std::mem::take(&mut track.path), ..Track::default() };
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
                    track.close(&id, None);
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
        // A failed result writes its id after the error text, which can run past the head:
        // `"content":"Exit code 1…","is_error":true,"tool_use_id":"…"`. Missing it left the
        // step open for good, so the agent read as busy on it.
        let result = contains(head, b"\"tool_result\"");
        if let Some((id, ok)) = result.then(|| quoted_after(&line, ERROR_ID)).flatten().map(|id| (id, Some(false))).or_else(|| quoted_after(head, b"\"tool_use_id\":\"").map(|id| (id, Some(true)))) {
            // A command that ran and failed starts its result with "Exit code N". A call denied by
            // the owner, blocked by a hook or refused by the tool is flagged as an error too, but
            // it never ran, so it gets no result and no red ✗.
            let unrun = ok == Some(false) && !contains(head, RAN_AND_FAILED);
            track.close(&id, if unrun { None } else { ok });
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
        assert_eq!(t.recent(5)[0].ok, Some(true));

        // A failed result puts its id after the error text, past the head.
        f.write_all(line(serde_json::json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "t2", "name": "Bash", "input": {"command": "flutter build ios", "description": "Build the app"}}]}})).as_bytes()).unwrap();
        let error = format!("Exit code 1\\n{}", "x".repeat(600));
        f.write_all(format!("{{\"parentUuid\":\"p\",\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"tool_result\",\"content\":\"{error}\",\"is_error\":true,\"tool_use_id\":\"t2\"}}]}}}}\n").as_bytes()).unwrap();
        refresh(&mut t, &path, Kind::Claude);
        assert!(t.now().is_none(), "a failed result closes its step too");
        assert_eq!((t.recent(5)[0].label.as_str(), t.recent(5)[0].ok), ("Build the app", Some(false)));

        // A call a hook blocked never ran: it closes, with no result.
        f.write_all(line(serde_json::json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "t3", "name": "Bash", "input": {"command": "git push", "description": "Push develop"}}]}})).as_bytes()).unwrap();
        f.write_all(b"{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"content\":\"PreToolUse:Bash hook error: blocked\",\"is_error\":true,\"tool_use_id\":\"t3\"}]}}\n").unwrap();
        refresh(&mut t, &path, Kind::Claude);
        assert_eq!((t.recent(5)[0].label.as_str(), t.recent(5)[0].ok), ("Push develop", None));
        std::fs::remove_dir_all(dir).ok();
    }

    /// A background subagent's launch call returns at once, so only its own transcript shows it.
    #[test]
    fn a_running_subagent_is_read_from_its_own_transcript_and_a_finished_one_is_not() {
        let dir = std::env::temp_dir().join(format!("live-subs-{}", std::process::id()));
        let subs_dir = dir.join("s1").join("subagents");
        std::fs::create_dir_all(&subs_dir).unwrap();
        let parent = dir.join("s1.jsonl");
        std::fs::write(&parent, "").unwrap();
        let line = r#"{"isSidechain":true,"type":"assistant","timestamp":"2026-11-05T10:00:00Z","message":{"model":"claude-haiku-5-5","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"description":"List the live sources","command":"ls ~/x/panel"}}]}}"#;
        for (id, meta) in [("a1", r#"{"agentType":"Explore","description":"Probe Live"}"#), ("a2", r#"{"agentType":"Plan","finished":true}"#)] {
            std::fs::write(subs_dir.join(format!("agent-{id}.jsonl")), format!("{line}\n")).unwrap();
            std::fs::write(subs_dir.join(format!("agent-{id}.meta.json")), meta).unwrap();
        }
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
        let got = subs(&[parent.clone()], now);
        let _ = std::fs::remove_dir_all(&dir);
        let list = &got[&parent];
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].kind.as_deref(), Some("Explore"));
        assert_eq!(list[0].what.as_deref(), Some("Probe Live"));
        assert_eq!(list[0].track.now().map(|s| s.label), Some("List the live sources".into()));
        assert!(list[0].track.paths.iter().any(|p| p.ends_with("/x/panel")));
    }

    #[test]
    fn iso_times_become_unix_ms() {
        assert_eq!(parse_ms("1970-01-01T00:00:01.500Z"), Some(1500));
        assert_eq!(parse_ms("2026-11-04T00:00:00Z"), Some(1_793_750_400_000));
    }
}
