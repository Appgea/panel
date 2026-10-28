//! Session history — what every coding agent did, read from each agent's own store.
//!
//! Reports only cover what an agent chose to file. A session that finished at 3am without a
//! word, or one started in a plain terminal outside Panel, left no trace anywhere Panel looked.
//! Every agent CLI keeps its own record regardless, so that is what this reads — one reader per
//! agent, each turning its store into the same [`Found`]:
//!
//! | agent | store |
//! |---|---|
//! | Claude | `~/.claude/projects/<folder>/<id>.jsonl`, append-only ([`claude`]) |
//! | Codex | `~/.codex/state_<n>.sqlite`, the `threads` table ([`codex`]) |
//! | Grok | `~/.grok/sessions/<folder>/<id>/` ([`grok`]) |
//! | opencode | `~/.local/share/opencode/opencode.db` ([`opencode`]) |
//! | Gemini | `~/.gemini/tmp/<folder>/chats/session-*.json[l]` ([`gemini`]) |
//! | DeepSeek Harness | `~/.dsh/sessions/<folder>/<id>/session.v4.jsonl.zstd` ([`dsh`]) |
//!
//! Every store is opened read-only. Each one records less or more than the others — Codex keeps
//! no reply text on disk, Grok no token counts — and a reader fills what its store has and leaves
//! the rest empty rather than guessing.

mod claude;
mod codex;
mod dsh;
mod gemini;
mod grok;
mod opencode;

use serde::Serialize;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// How far back a scan looks by default. Two weeks matches the rail's sense of "recent".
pub const DAYS: u64 = 14;
const TEXTS_PER_SESSION: usize = 600;
const TEXT_CHARS: usize = 2_000;

/// How a session can be picked back up from History.
#[derive(Debug, Clone, Copy, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Resume {
    /// The agent reopens exactly this conversation by id.
    Exact,
    /// Panel cannot host this agent, so there is nothing to resume into.
    #[default]
    None,
}

/// One session, as the History screen lists it.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    /// The agent's own session id: what its resume flag takes.
    pub id: String,
    /// `claude`, `codex`, `grok`, `opencode`, `gemini`, `dshline`. The Panel engine names.
    pub agent: String,
    /// Registered project the session ran in, or empty when it ran outside every project.
    pub project: String,
    pub cwd: String,
    pub title: String,
    pub first_prompt: String,
    pub last_prompt: String,
    /// The last thing the agent said. Empty when its store does not keep replies.
    pub last_text: String,
    /// ISO-8601 UTC.
    pub started_at: String,
    pub ended_at: String,
    /// Real prompts the human typed; 0 when the store does not say.
    pub prompts: u32,
    /// Files the agent wrote, relative to `cwd` when inside it.
    pub files: Vec<String>,
    /// Run without a human at the keyboard (`codex exec`, `grok -p`, …).
    pub headless: bool,
    pub resume: Resume,
}

/// Tokens one session spent with one model in one UTC hour. The UI buckets hours into its own
/// local days; the backend has no time zone to do that with.
#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub session: String,
    pub agent: String,
    pub project: String,
    pub model: String,
    /// `YYYY-MM-DDTHH`, UTC.
    pub hour: String,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    /// A total the store does not break down (Codex keeps one number per thread).
    pub unsplit: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    pub sessions: Vec<Summary>,
    pub usage: Vec<Usage>,
    /// Sessions that ran outside every registered project: scratch folders, blind judges, temp
    /// runs. Counted so the list can say they exist without listing them.
    pub outside: u32,
    /// Agents whose store could not be read, with the reason. A missing store is not listed;
    /// an unreadable one is, so an empty History never hides a broken reader.
    pub problems: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub session: String,
    pub agent: String,
    pub project: String,
    pub cwd: String,
    pub title: String,
    pub at: String,
    /// `you` or `agent`.
    pub role: String,
    pub snippet: String,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct Text {
    pub at: String,
    pub mine: bool,
    pub text: String,
}

/// input, output, cache read, cache write, unsplit.
pub(crate) type Tokens = [u64; 5];

/// One session from one reader, before it is placed in a project.
#[derive(Debug, Clone, Default)]
pub(crate) struct Found {
    pub summary: Summary,
    pub texts: Vec<Text>,
    pub files: BTreeSet<String>,
    /// (model, hour) → tokens.
    pub usage: HashMap<(String, String), Tokens>,
    /// False for a session that only spends tokens — a subagent thread, a prompt-less run.
    pub listed: bool,
}

impl Found {
    pub fn new(agent: &str, resume: Resume) -> Self {
        let mut found = Found { listed: true, ..Default::default() };
        found.summary.agent = agent.to_string();
        found.summary.resume = resume;
        found
    }

    /// A copy for one scan's answer. The list needs no search text, and that is most of the bytes.
    pub fn copy(&self, texts: bool) -> Found {
        Found {
            summary: self.summary.clone(),
            texts: if texts { self.texts.clone() } else { Vec::new() },
            files: self.files.clone(),
            usage: self.usage.clone(),
            listed: self.listed,
        }
    }

    pub fn push_text(&mut self, at: &str, mine: bool, text: &str) {
        let text = text.trim();
        if text.is_empty() {
            return;
        }
        if self.texts.len() >= TEXTS_PER_SESSION {
            self.texts.remove(0);
        }
        self.texts.push(Text { at: at.to_string(), mine, text: clip(text, TEXT_CHARS) });
        if mine {
            self.summary.prompts += 1;
            if self.summary.first_prompt.is_empty() {
                self.summary.first_prompt = clip(text, 400);
            }
            self.summary.last_prompt = clip(text, 400);
        } else {
            self.summary.last_text = clip(text, 600);
        }
    }

    pub fn add_tokens(&mut self, model: &str, at: &str, tokens: Tokens) {
        let hour = at.get(..13).unwrap_or_default().to_string();
        let entry = self.usage.entry((model.to_string(), hour)).or_default();
        for (sum, add) in entry.iter_mut().zip(tokens) {
            *sum += add;
        }
    }

    pub fn wrote(&mut self, path: &str) {
        if !path.is_empty() {
            let file = relative_to(path, &self.summary.cwd);
            self.files.insert(file);
        }
    }

    pub fn saw(&mut self, at: &str) {
        if at.is_empty() {
            return;
        }
        if self.summary.started_at.is_empty() || at < self.summary.started_at.as_str() {
            self.summary.started_at = at.to_string();
        }
        if at > self.summary.ended_at.as_str() {
            self.summary.ended_at = at.to_string();
        }
    }

    fn title(&self) -> String {
        [&self.summary.title, &self.summary.first_prompt, &self.summary.last_prompt]
            .into_iter()
            .find(|text| !text.trim().is_empty())
            .map(|text| clip(text, 80))
            .unwrap_or_default()
    }
}

pub(crate) fn clip(text: &str, chars: usize) -> String {
    let text = text.trim();
    match text.char_indices().nth(chars) {
        Some((at, _)) => format!("{}…", &text[..at]),
        None => text.to_string(),
    }
}

fn relative_to(path: &str, cwd: &str) -> String {
    if cwd.is_empty() {
        return path.to_string();
    }
    Path::new(path)
        .strip_prefix(cwd)
        .map(|rest| rest.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string())
}

pub(crate) fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// An env override for a store's home, else a folder under `~`.
pub(crate) fn store(var: &str, under_home: &str) -> Option<PathBuf> {
    std::env::var_os(var)
        .map(PathBuf::from)
        .or_else(|| home().map(|home| home.join(under_home)))
}

pub(crate) fn cutoff(days: u64) -> SystemTime {
    SystemTime::now() - Duration::from_secs(days * 86_400)
}

pub(crate) fn cutoff_ms(days: u64) -> i64 {
    cutoff(days).duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Now, in the milliseconds every store's times are compared in.
pub fn now_ms() -> i64 {
    cutoff_ms(0)
}

pub(crate) fn modified_within(path: &Path, since: SystemTime) -> bool {
    path.metadata()
        .and_then(|meta| meta.modified())
        .map(|at| at >= since)
        .unwrap_or(false)
}

/// File identity for the readers that re-read a changed file whole.
pub(crate) fn stamp(path: &Path) -> Option<(u64, SystemTime)> {
    let meta = path.metadata().ok()?;
    Some((meta.len(), meta.modified().ok()?))
}

pub(crate) type FileCache = OnceLock<Mutex<HashMap<PathBuf, ((u64, SystemTime), Option<Found>)>>>;

/// For stores that rewrite a session file in place: read each file again only when its size or
/// time changed. Files no longer in `paths` fall out of the cache. Each session comes back with
/// the file it was read from.
pub(crate) fn cached(
    cache: &'static FileCache,
    paths: &[PathBuf],
    texts: bool,
    read: impl Fn(&Path) -> Option<Found>,
) -> Vec<(PathBuf, Found)> {
    let mut cache = cache.get_or_init(Default::default).lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let keep: HashSet<&PathBuf> = paths.iter().collect();
    cache.retain(|path, _| keep.contains(path));
    let mut out = Vec::new();
    for path in paths {
        let Some(now) = stamp(path) else { continue };
        if !matches!(cache.get(path), Some((seen, _)) if *seen == now) {
            cache.insert(path.clone(), (now, read(path)));
        }
        if let Some((_, Some(found))) = cache.get(path) {
            out.push((path.clone(), found.copy(texts)));
        }
    }
    out
}

/// `<root>/<folder>/<session>/<file>` for every session folder whose `file` changed within
/// `days`: the layout Grok and DeepSeek Harness share.
pub(crate) fn session_files(root: &Path, days: u64, file: impl Fn(&str) -> bool) -> Vec<PathBuf> {
    let since = cutoff(days);
    let Ok(folders) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    folders
        .flatten()
        .flat_map(|folder| std::fs::read_dir(folder.path()).into_iter().flatten().flatten())
        .flat_map(|session| std::fs::read_dir(session.path()).into_iter().flatten().flatten())
        .filter(|entry| file(&entry.file_name().to_string_lossy()))
        .map(|entry| entry.path())
        .filter(|path| modified_within(path, since))
        .collect()
}

/// Unix milliseconds as `YYYY-MM-DDTHH:MM:SS.mmmZ`, without a date crate. Howard Hinnant's
/// civil-from-days, which is exact for every date a session can have.
pub(crate) fn iso_from_ms(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rest = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

/// What the human typed once the scaffolding an agent wraps around it is cut away. Agents send
/// the prompt inside context blocks (`<user_info>…</user_info>`, `<session_context>`, rules);
/// a `<user_query>` block, when there is one, IS the prompt. Text that is only scaffolding — a
/// slash-command echo, a system reminder — is not a prompt at all.
pub(crate) fn human_text(text: &str) -> Option<String> {
    if let Some(start) = text.find("<user_query>") {
        let body = &text[start + "<user_query>".len()..];
        let body = body.split("</user_query>").next().unwrap_or(body).trim();
        return (!body.is_empty()).then(|| body.to_string());
    }
    let mut rest = text.trim();
    while let Some(tag) = rest.strip_prefix('<').and_then(|after| {
        let name: String = after.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').collect();
        (!name.is_empty()).then_some(name)
    }) {
        let close = format!("</{tag}>");
        match rest.find(&close) {
            Some(end) => rest = rest[end + close.len()..].trim_start(),
            None => return None,
        }
    }
    let rest = rest.trim();
    if rest.is_empty() || rest.starts_with("[Request interrupted") {
        return None;
    }
    Some(rest.to_string())
}

/// The registered project a folder belongs to. Deepest root wins, like the ingress router, so a
/// nested project is not claimed by its parent.
fn owner(cwd: &str, roots: &[(String, PathBuf)]) -> String {
    let cwd = Path::new(cwd);
    roots
        .iter()
        .filter(|(_, root)| cwd.starts_with(root))
        .max_by_key(|(_, root)| root.components().count())
        .map(|(id, _)| id.clone())
        .unwrap_or_default()
}

/// One SQLite store, read-only. The agent may be writing; wait a little rather than fail the scan.
pub(crate) fn sqlite(path: &Path) -> Result<rusqlite::Connection, String> {
    use rusqlite::OpenFlags;
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let db = rusqlite::Connection::open_with_flags(path, flags).map_err(|error| error.to_string())?;
    db.busy_timeout(Duration::from_millis(500)).map_err(|error| error.to_string())?;
    Ok(db)
}

/// Every reader's sessions over `days`, plus a line per reader whose store failed.
/// `texts` asks for the prompts and replies search runs over; the list leaves them behind.
fn collect(days: u64, roots: &[(String, PathBuf)], texts: bool) -> (Vec<Found>, Vec<String>) {
    let mut found = Vec::new();
    let mut problems = Vec::new();
    type Reader<'a> = &'a dyn Fn() -> Result<Vec<Found>, String>;
    let readers: [(&str, Reader); 6] = [
        ("Claude", &|| Ok(claude::sessions(days, texts))),
        ("Codex", &|| codex::sessions(days)),
        ("Grok", &|| Ok(grok::sessions(days, texts))),
        ("opencode", &|| opencode::sessions(days, texts)),
        ("Gemini", &|| Ok(gemini::sessions(days, roots, texts))),
        ("DeepSeek Harness", &|| Ok(dsh::sessions(days, texts))),
    ];
    for (name, read) in readers {
        match read() {
            Ok(mut sessions) => found.append(&mut sessions),
            Err(reason) => problems.push(format!("{name}: {reason}")),
        }
    }
    (found, problems)
}

/// Sessions and their usage over the last `days`, newest first. `roots` maps project ids to
/// their folders.
pub fn history(days: u64, roots: &[(String, PathBuf)]) -> History {
    let (found, problems) = collect(days, roots, false);
    let mut sessions = Vec::new();
    let mut usage = Vec::new();
    let mut outside = 0;
    for found in found {
        let project = owner(&found.summary.cwd, roots);
        if project.is_empty() {
            if found.listed {
                outside += 1;
            }
            continue;
        }
        let mut summary = found.summary.clone();
        summary.project = project.clone();
        summary.title = found.title();
        summary.files = found.files.iter().cloned().collect();
        for ((model, hour), tokens) in &found.usage {
            usage.push(Usage {
                session: summary.id.clone(),
                agent: summary.agent.clone(),
                project: project.clone(),
                model: model.clone(),
                hour: hour.clone(),
                input: tokens[0],
                output: tokens[1],
                cache_read: tokens[2],
                cache_write: tokens[3],
                unsplit: tokens[4],
            });
        }
        if found.listed {
            sessions.push(summary);
        }
    }
    sessions.sort_by(|a, b| b.ended_at.cmp(&a.ended_at));
    History { sessions, usage, outside, problems }
}

/// A short window of `text` around byte offset `at`, cut on character boundaries.
fn snippet(text: &str, at: usize, len: usize) -> String {
    let mut start = at.saturating_sub(70).min(text.len());
    while !text.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = (at + len + 110).min(text.len());
    while !text.is_char_boundary(end) {
        end += 1;
    }
    let body = text[start..end].split_whitespace().collect::<Vec<_>>().join(" ");
    format!("{}{}{}", if start > 0 { "…" } else { "" }, body, if end < text.len() { "…" } else { "" })
}

/// Prompts and replies that contain every word of `query`, newest first.
pub fn search(query: &str, days: u64, roots: &[(String, PathBuf)], limit: usize) -> Vec<Hit> {
    let words: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
    if words.is_empty() {
        return Vec::new();
    }
    let (found, _) = collect(days, roots, true);
    let mut hits = Vec::new();
    for found in found.iter().filter(|found| found.listed) {
        let project = owner(&found.summary.cwd, roots);
        if project.is_empty() {
            continue;
        }
        for text in &found.texts {
            let lower = text.text.to_lowercase();
            if !words.iter().all(|word| lower.contains(word.as_str())) {
                continue;
            }
            // Lowercasing can change byte lengths outside ASCII; fall back to the start.
            let at = lower.find(words[0].as_str()).filter(|_| lower.len() == text.text.len()).unwrap_or(0);
            hits.push(Hit {
                session: found.summary.id.clone(),
                agent: found.summary.agent.clone(),
                project: project.clone(),
                cwd: found.summary.cwd.clone(),
                title: found.title(),
                at: text.at.clone(),
                role: if text.mine { "you" } else { "agent" }.into(),
                snippet: snippet(&text.text, at, words[0].len()),
            });
        }
    }
    hits.sort_by(|a, b| b.at.cmp(&a.at));
    hits.truncate(limit);
    hits
}

/// The engine and argv that pick a past session back up, or None when it cannot be.
pub fn resume_args(agent: &str, id: &str) -> Option<(&'static str, Vec<String>)> {
    if !valid_session_id(id) {
        return None;
    }
    let id = id.to_string();
    Some(match agent {
        "claude" => ("claude", vec!["--resume".into(), id]),
        "codex" => ("codex", vec!["resume".into(), id]),
        "grok" => ("grok", vec!["--resume".into(), id]),
        "opencode" => ("opencode", vec!["--session".into(), id]),
        "dshline" => ("dshline", vec!["--resume".into(), id]),
        _ => return None,
    })
}

/// Panel can reopen one of this agent's conversations by id.
pub fn can_resume(agent: &str) -> bool {
    resume_args(agent, "0").is_some()
}

/// Which of its own conversations a live terminal of `agent` is running, read from the agent's
/// store. For agents that do not report their id to Panel (Claude does, through hooks).
///
/// Found the way a person would find it: the agent's newest conversation in that folder that has
/// moved since the terminal started. That follows a `/new` inside the agent too. `resumed` is the
/// one the terminal was started on, which counts though it began earlier. `taken` are held by
/// other terminals. None when the store has nothing that fits, so nothing would be resumed.
///
/// It cannot tell two live terminals of one agent in one folder apart. The caller does not ask
/// then.
pub fn live_conversation(
    agent: &str,
    cwd: &Path,
    since_ms: i64,
    resumed: Option<&str>,
    taken: &HashSet<String>,
) -> Option<String> {
    let age_days = (now_ms() - since_ms).max(0) / 86_400_000;
    let days = (age_days as u64 + 1).clamp(1, 90);
    let found = match agent {
        "codex" => codex::sessions(days).ok()?,
        "grok" => grok::sessions(days, false),
        "opencode" => opencode::sessions(days, false).ok()?,
        "dshline" => dsh::sessions(days, false),
        _ => return None,
    };
    pick_live(&found, cwd, &iso_from_ms(since_ms), resumed, taken)
}

/// The rule behind `live_conversation`, on sessions already read. Times compare to the second:
/// every store writes UTC ISO-8601, and they differ only in the fraction.
fn pick_live(
    found: &[Found],
    cwd: &Path,
    since: &str,
    resumed: Option<&str>,
    taken: &HashSet<String>,
) -> Option<String> {
    let second = |at: &str| at.get(..19).unwrap_or(at).to_string();
    let since = second(since);
    let canonical = |path: &Path| path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let folder = canonical(cwd);
    found
        .iter()
        .filter(|session| !session.summary.headless && !taken.contains(&session.summary.id))
        .filter(|session| canonical(Path::new(&session.summary.cwd)) == folder)
        .filter(|session| {
            resumed == Some(session.summary.id.as_str()) || second(&session.summary.ended_at) >= since
        })
        .max_by_key(|session| second(&session.summary.ended_at))
        .map(|session| session.summary.id.clone())
}

/// Agent session ids are UUIDs or prefixed slugs (`ses_…`, `dshline-…`). Anything else, and
/// anything that could read as a flag, is refused before it reaches an argv.
pub fn valid_session_id(id: &str) -> bool {
    id.len() <= 128
        && id.starts_with(|c: char| c.is_ascii_alphanumeric())
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[cfg(test)]
pub(crate) fn scratch() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("panel-history-{}", crate::uuid_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_deepest_project_owns_a_folder() {
        let roots = vec![
            ("apps".to_string(), PathBuf::from("/work")),
            ("app".to_string(), PathBuf::from("/work/app")),
        ];
        assert_eq!(owner("/work/app/lib", &roots), "app");
        assert_eq!(owner("/work/other", &roots), "apps");
        assert_eq!(owner("/tmp/scratch", &roots), "");
        assert_eq!(owner("/work/application", &roots), "apps", "a prefix is not a parent folder");
    }

    #[test]
    fn ids_that_could_be_flags_never_resume() {
        assert!(valid_session_id("bb941884-24bd-412c-9c60-fc55e78320c6"));
        assert!(valid_session_id("ses_eb4aeb4f4ffeTOvKs03FGaCRAu"));
        assert!(valid_session_id("dshline-2d153f7f-0bba-419e-97c2-e95cda4cd4c3"));
        for bad in ["--dangerously-skip-permissions", "-c", "", "a b", "a;rm"] {
            assert!(!valid_session_id(bad), "{bad}");
        }
        assert_eq!(resume_args("codex", "abc").unwrap().1, vec!["resume", "abc"]);
        assert_eq!(resume_args("dshline", "dshline-1").unwrap().1, vec!["--resume", "dshline-1"]);
        assert!(resume_args("gemini", "abc").is_none(), "Panel has no Gemini engine to resume into");
    }

    #[test]
    fn milliseconds_become_utc_iso() {
        assert_eq!(iso_from_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_ms(1_792_692_464_161), "2026-10-22T18:07:44.161Z");
        assert_eq!(iso_from_ms(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn the_prompt_is_what_is_left_inside_the_scaffolding() {
        assert_eq!(human_text("<user_info>\nOS: mac\n</user_info>\n\n<rules>x</rules>\nfix the build").as_deref(), Some("fix the build"));
        assert_eq!(human_text("<user_info>x</user_info><user_query>\nship it\n</user_query>").as_deref(), Some("ship it"));
        assert_eq!(human_text("<system-reminder>skills…</system-reminder>"), None);
        assert_eq!(human_text("<command-name>/clear</command-name>"), None);
        assert_eq!(human_text("a <b>bold</b> ask").as_deref(), Some("a <b>bold</b> ask"));
    }
}

#[cfg(test)]
mod live_tests {
    use super::{pick_live, Found, Resume};
    use std::collections::HashSet;
    use std::path::Path;

    fn session(id: &str, cwd: &str, ended: &str) -> Found {
        let mut found = Found::new("codex", Resume::Exact);
        found.summary.id = id.into();
        found.summary.cwd = cwd.into();
        found.saw(ended);
        found
    }

    #[test]
    fn the_terminal_runs_the_newest_conversation_that_moved_since_it_started() {
        let found = [
            session("old", "/p", "2026-10-28T08:00:00.000Z"),
            session("first", "/p", "2026-10-28T10:05:00.000Z"),
            // A `/new` inside the agent: the newest one in the folder is the one on screen.
            session("after-new", "/p", "2026-10-28T10:20:00.123456Z"),
            session("elsewhere", "/q", "2026-10-28T10:30:00.000Z"),
        ];
        let none = HashSet::new();
        let since = "2026-10-28T10:00:00.000Z";
        assert_eq!(pick_live(&found, Path::new("/p"), since, None, &none).as_deref(), Some("after-new"));
        // Held by a sleeping neighbour: not this terminal's.
        let taken = HashSet::from(["after-new".to_string()]);
        assert_eq!(pick_live(&found, Path::new("/p"), since, None, &taken).as_deref(), Some("first"));
        // Started on `old` and not touched since: still the one it holds.
        let quiet = [session("old", "/p", "2026-10-28T08:00:00.000Z")];
        assert_eq!(pick_live(&quiet, Path::new("/p"), since, Some("old"), &none).as_deref(), Some("old"));
        assert_eq!(pick_live(&quiet, Path::new("/p"), since, None, &none), None);
    }
}
