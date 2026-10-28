//! Sprints — the two-week plan, as Markdown in the ops tree.
//!
//! One file per sprint under `ops/sprints/<id>.md`: frontmatter for the window and the focus
//! order, a `## Goals` checklist, a `## Log`. The manager reads and writes the same file from its
//! terminal, and the human can edit it in any editor, so this module is a parser and a line
//! rewriter — never a second store. Whether a sprint is active is derived from its dates, and
//! whether a goal is being worked on is derived from a live session Panel itself started; the
//! only states written to disk are the ones a human or the manager decides: done, blocked, todo.

use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
pub struct Goal {
    /// Line number in the file. Stable between reads as long as nothing above it is edited, which
    /// is why mutations re-read the file and match the line text as well as the index.
    pub index: usize,
    pub app: String,
    pub app_name: String,
    /// Portfolio project id the app maps to, so a goal can start an agent. None for `-` or an app
    /// with no folder in the portfolio.
    pub project: Option<String>,
    pub owner: String,
    pub text: String,
    pub done_when: String,
    /// `todo` | `done` | `blocked`.
    pub state: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Sprint {
    pub id: String,
    pub title: String,
    pub starts: String,
    pub ends: String,
    pub focus: Vec<String>,
    /// `active` | `planned` | `past` — from the dates against today, never stored.
    pub phase: String,
    pub goals: Vec<Goal>,
    /// The `## Log` bullets, oldest first.
    pub log: Vec<String>,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AppRef {
    pub key: String,
    pub name: String,
    pub project: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Report {
    pub project: String,
    pub project_name: String,
    pub at: String,
    pub title: String,
    pub outcome: String,
    /// The agent stopped and wants a human. This is the whole reason to read the Inbox, so the
    /// screen promotes it instead of leaving it in a list to be scanned.
    pub waiting: bool,
    /// Reports filed for this project since the running sprint started.
    pub since_start: u32,
}

/// What actually happened in an app's repository during the sprint.
///
/// Every field is read live from git and the report log. Nothing here is stored, because a
/// second hand-kept copy of "did this move" is wrong within a day — the same reason `ops/`
/// refuses to write down a branch name.
#[derive(Debug, Clone, Serialize)]
pub struct Activity {
    pub app: String,
    pub project: String,
    pub project_name: String,
    pub branch: String,
    /// Commits on the checked-out branch since the sprint started.
    pub commits: u32,
    /// The newest commit in that window, or the last one ever when the window is empty.
    pub last_subject: String,
    pub last_when: String,
    /// True when `last_*` predates the sprint — the app has not moved in this window.
    pub last_is_older: bool,
    pub dirty: u32,
    pub ahead: u32,
    pub reports: u32,
}

/// Everything the Sprint screen paints, in one read.
#[derive(Debug, Clone, Serialize)]
pub struct Board {
    pub today: String,
    pub sprints: Vec<Sprint>,
    pub apps: Vec<AppRef>,
    /// The `## Blocked on you` lines of `now.md`, verbatim minus the bullet.
    pub blocked: Vec<String>,
    /// The latest agent report per project, newest first.
    pub reports: Vec<Report>,
    /// Per-app movement during the RUNNING sprint. Measured for one window only: computing it
    /// for every sprint on the disk would spawn git for each, and a past sprint's movement is
    /// history, not something you act on.
    pub measured_for: String,
    pub activity: Vec<Activity>,
}

fn ops_dir() -> Result<PathBuf, String> {
    crate::ops::ops_dir().ok_or_else(|| "no ops tree — set opsRoot in config.json".to_string())
}

fn sprints_dir() -> Result<PathBuf, String> {
    Ok(ops_dir()?.join("sprints"))
}

/// Local `YYYY-MM-DD`. No chrono in this tree; the `date` binary is on every Mac.
pub fn today() -> String {
    crate::platform::command("date")
        .arg("+%Y-%m-%d")
        .output()
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|text| text.trim().to_string())
        .unwrap_or_default()
}

/* ------------------------------------------------------------ the portfolio */

/// One `portfolio.yaml` row: the fields Panel reads. Everything else stays the CPO's.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct PortfolioApp {
    pub key: String,
    pub name: String,
    /// Folder relative to the company root, the folder that holds `ops/`.
    pub dir: String,
    /// idea | building | review | releasing | live | paused | archived | unknown.
    pub status: String,
    pub notes: String,
    /// flutter-app | ios-native | server | tool | …, as written.
    pub kind: String,
    /// Keys of the shared services this app needs, and of the apps a service backs.
    pub depends_on: Vec<String>,
    pub serves: Vec<String>,
}

impl PortfolioApp {
    fn set(&mut self, field: &str, value: String) {
        match field {
            "name" => self.name = value,
            "dir" => self.dir = value,
            "status" => self.status = value,
            "notes" => self.notes = value,
            "kind" => self.kind = value,
            "depends_on" => self.depends_on = list_field(&value),
            "serves" => self.serves = list_field(&value),
            _ => {}
        }
    }
}

/// Every `portfolio.yaml` app. Hand-parsed: the file is hand-written YAML with two shapes,
/// `key: { name: X, dir: Y, … }` on one line and `key:` with indented fields, and the fields in
/// `PortfolioApp` are the only ones read.
pub(crate) fn portfolio(ops: &Path) -> Vec<PortfolioApp> {
    let Ok(raw) = fs::read_to_string(ops.join("portfolio.yaml")) else {
        return Vec::new();
    };
    let mut apps: Vec<PortfolioApp> = Vec::new();
    let mut in_apps = false;
    let mut current: Option<usize> = None;
    for line in raw.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with('#') || trimmed.is_empty() {
            continue;
        }
        let indent = line.len() - trimmed.len();
        if indent == 0 {
            in_apps = trimmed.starts_with("apps:");
            current = None;
            continue;
        }
        if !in_apps {
            continue;
        }
        if indent == 2 {
            let Some((key, rest)) = trimmed.split_once(':') else {
                continue;
            };
            apps.push(PortfolioApp {
                key: key.trim().to_string(),
                ..PortfolioApp::default()
            });
            current = Some(apps.len() - 1);
            let rest = rest.trim();
            if let Some(inline) = rest.strip_prefix('{') {
                let at = apps.len() - 1;
                for (name, value) in inline_fields(inline.trim_end_matches('}')) {
                    apps[at].set(&name, value);
                }
            }
            continue;
        }
        if let (Some(at), Some((name, value))) = (current, trimmed.split_once(':')) {
            let value = strip_comment(value.trim()).trim_matches('"').to_string();
            apps[at].set(name.trim(), value);
        }
    }
    apps
}

/// `name: X, notes: "a, b", serves: [a, b], dir: Y` → pairs. A comma inside quotes, a list or a
/// nested map belongs to the value.
fn inline_fields(body: &str) -> Vec<(String, String)> {
    let mut parts = Vec::new();
    let mut part = String::new();
    let mut quoted = false;
    let mut depth = 0usize;
    for ch in body.chars() {
        match ch {
            '"' => {
                quoted = !quoted;
                part.push(ch);
            }
            '[' | '{' if !quoted => {
                depth += 1;
                part.push(ch);
            }
            ']' | '}' if !quoted => {
                depth = depth.saturating_sub(1);
                part.push(ch);
            }
            ',' if !quoted && depth == 0 => parts.push(std::mem::take(&mut part)),
            _ => part.push(ch),
        }
    }
    parts.push(part);
    parts
        .into_iter()
        .filter_map(|field| {
            let (name, value) = field.split_once(':')?;
            let value = strip_comment(value.trim()).trim_matches('"').to_string();
            Some((name.trim().to_string(), value))
        })
        .collect()
}

fn strip_comment(value: &str) -> &str {
    value.split("  #").next().unwrap_or(value).trim()
}

/// Which portfolio project holds an app's folder. `dir` is relative to the folder that holds the
/// ops tree (the company root), and a project path that ends with those components is the one.
pub(crate) fn resolve_apps(ops: &Path) -> Vec<AppRef> {
    let root = ops.parent().map(Path::to_path_buf);
    let projects = crate::projects::load();
    portfolio(ops)
        .into_iter()
        .map(|PortfolioApp { key, name, dir, .. }| {
            let project = if dir.is_empty() {
                None
            } else {
                let absolute = root.as_ref().map(|r| r.join(&dir));
                projects
                    .iter()
                    .find(|p| {
                        absolute.as_ref().is_some_and(|a| same_folder(a, &p.path))
                            || p.path.ends_with(&dir)
                    })
                    .map(|p| p.id.clone())
            };
            AppRef {
                name: if name.is_empty() { key.clone() } else { name },
                key,
                project,
            }
        })
        .collect()
}

fn same_folder(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/* ------------------------------------------------------------------ parsing */

fn frontmatter(text: &str) -> (HashMap<String, String>, usize) {
    let mut fields = HashMap::new();
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (fields, 0);
    }
    let mut consumed = 1;
    for line in lines {
        consumed += 1;
        if line.trim() == "---" {
            return (fields, consumed);
        }
        if let Some((key, value)) = line.split_once(':') {
            fields.insert(key.trim().to_string(), strip_comment(value.trim()).to_string());
        }
    }
    (fields, 0)
}

fn list_field(value: &str) -> Vec<String> {
    value
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .split(',')
        .map(|item| item.trim().trim_matches('"').to_string())
        .filter(|item| !item.is_empty())
        .collect()
}

/// `- [ ] app | owner | text  [done-when: …]`. Returns None for a line that is not a goal.
fn parse_goal(line: &str) -> Option<(String, String, String, String, String, String)> {
    let rest = line.trim_start().strip_prefix("- [")?;
    let mark = rest.chars().next()?;
    let rest = rest.get(1..)?.strip_prefix(']')?.trim();
    let state = match mark {
        'x' | 'X' => "done",
        '!' => "blocked",
        _ => "todo",
    };
    let (body, done_when) = match rest.rfind("[done-when:") {
        Some(at) => (
            rest[..at].trim(),
            rest[at + "[done-when:".len()..]
                .trim()
                .trim_end_matches(']')
                .trim()
                .to_string(),
        ),
        None => (rest, String::new()),
    };
    let mut parts = body.splitn(3, '|').map(str::trim);
    let (app, owner, text) = match (parts.next(), parts.next(), parts.next()) {
        (Some(app), Some(owner), Some(text)) => (app, owner, text),
        (Some(text), None, None) => ("-", "you", text),
        (Some(app), Some(text), None) => (app, "you", text),
        _ => return None,
    };
    Some((
        state.to_string(),
        app.to_string(),
        owner.to_string(),
        text.to_string(),
        done_when,
        body.to_string(),
    ))
}

fn parse_sprint(path: &Path, today: &str, apps: &[AppRef]) -> Option<Sprint> {
    let text = fs::read_to_string(path).ok()?;
    let (fields, _) = frontmatter(&text);
    let stem = path.file_stem()?.to_string_lossy().into_owned();
    let id = fields.get("id").cloned().unwrap_or_else(|| stem.clone());
    let starts = fields.get("starts").cloned().unwrap_or_default();
    let ends = fields.get("ends").cloned().unwrap_or_default();
    let phase = if !starts.is_empty() && starts.as_str() > today {
        "planned"
    } else if !ends.is_empty() && ends.as_str() < today {
        "past"
    } else {
        "active"
    };
    let by_key: HashMap<&str, &AppRef> = apps.iter().map(|app| (app.key.as_str(), app)).collect();

    let mut section = String::new();
    let mut goals = Vec::new();
    let mut log = Vec::new();
    for (index, line) in text.lines().enumerate() {
        if let Some(heading) = line.strip_prefix("## ") {
            section = heading.trim().to_lowercase();
            continue;
        }
        if section == "goals" {
            if let Some((state, app, owner, text, done_when, _)) = parse_goal(line) {
                let known = by_key.get(app.as_str());
                goals.push(Goal {
                    index,
                    app_name: known.map(|a| a.name.clone()).unwrap_or_else(|| app.clone()),
                    project: known.and_then(|a| a.project.clone()),
                    app,
                    owner,
                    text,
                    done_when,
                    state,
                });
            }
        } else if section == "log" {
            if let Some(entry) = line.trim_start().strip_prefix("- ") {
                log.push(entry.trim().to_string());
            }
        }
    }

    Some(Sprint {
        title: fields.get("title").cloned().unwrap_or_else(|| id.clone()),
        id,
        starts,
        ends,
        focus: fields.get("focus").map(|v| list_field(v)).unwrap_or_default(),
        phase: phase.to_string(),
        goals,
        log,
        path: path.to_string_lossy().into_owned(),
    })
}

/* ------------------------------------------------------------------ reads */

/// `now.md` → the bullets under `## Blocked on you`.
fn blocked_on_you(ops: &Path) -> Vec<String> {
    let Ok(text) = fs::read_to_string(ops.join("now.md")) else {
        return Vec::new();
    };
    let mut inside = false;
    let mut out = Vec::new();
    for line in text.lines() {
        if let Some(heading) = line.strip_prefix("## ") {
            inside = heading.trim().eq_ignore_ascii_case("blocked on you");
            continue;
        }
        if inside {
            if let Some(entry) = line.trim_start().strip_prefix("- ") {
                out.push(entry.trim().to_string());
            }
        }
    }
    out
}

/// The last entry of every `brain/reports/<project>.md`, newest first, plus how many landed
/// since `since` (a `YYYY-MM-DD`; empty counts nothing).
fn latest_reports(since: &str) -> Vec<Report> {
    let dir = crate::paths::brain_dir().join("reports");
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let projects = crate::projects::load();
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let mut last: Option<(String, String, String)> = None;
        let mut since_start = 0u32;
        let mut lines = text.lines().peekable();
        while let Some(line) = lines.next() {
            let Some(head) = line.strip_prefix("## ") else {
                continue;
            };
            let (at, title) = head.split_once(" — ").unwrap_or((head, "report"));
            let at = at.trim();
            let outcome = lines
                .peek()
                .and_then(|next| next.strip_prefix("outcome: "))
                .map(|rest| rest.split(" · ").next().unwrap_or(rest).trim().to_string())
                .unwrap_or_default();
            // The stamp is `YYYY-MM-DD HH:MM`, so its first ten characters sort as a date.
            if !since.is_empty() && at.len() >= 10 && &at[..10] >= since {
                since_start += 1;
            }
            last = Some((at.to_string(), title.trim().to_string(), outcome));
        }
        let Some((at, title, outcome)) = last else {
            continue;
        };
        let project = projects.iter().find(|p| crate::reports::safe_key(&p.id) == stem);
        out.push(Report {
            project: project.map(|p| p.id.clone()).unwrap_or_else(|| stem.clone()),
            project_name: project.map(|p| p.name.clone()).unwrap_or(stem),
            at,
            waiting: matches!(outcome.as_str(), "blocked" | "needs_decision"),
            title,
            outcome,
            since_start,
        });
    }
    out.sort_by(|a, b| b.at.cmp(&a.at));
    out
}

/// One app's movement. Two git processes in the busy case, three in the quiet one — the extra
/// call only runs when nothing landed in the window, which is exactly when "last touched three
/// weeks ago" is the line worth paying for.
fn app_activity(app: &AppRef, project_id: &str, sprint: &Sprint, reports: &[Report]) -> Option<Activity> {
    let projects = crate::projects::load();
    let found = projects.iter().find(|p| p.id == project_id)?;
    if !found.path.is_dir() {
        return None;
    }
    let state = crate::projects::git_state(&found.path);
    let mut commits = 0;
    let mut last_subject = String::new();
    let mut last_when = String::new();
    let mut last_is_older = false;
    if state.is_repo {
        let since = format!("--since={}", if sprint.starts.is_empty() { "30 days ago" } else { &sprint.starts });
        let window = crate::projects::git(&found.path, &["log", &since, "--pretty=%s%x1f%cr"]);
        if let Some(window) = window {
            let lines: Vec<&str> = window.lines().collect();
            commits = lines.len() as u32;
            if let Some((subject, when)) = lines.first().and_then(|line| line.split_once('\u{1f}')) {
                last_subject = subject.trim().to_string();
                last_when = when.trim().to_string();
            }
        }
        if commits == 0 {
            if let Some(line) = crate::projects::git(&found.path, &["log", "-1", "--pretty=%s%x1f%cr"]) {
                if let Some((subject, when)) = line.split_once('\u{1f}') {
                    last_subject = subject.trim().to_string();
                    last_when = when.trim().to_string();
                    last_is_older = true;
                }
            }
        }
    }
    Some(Activity {
        app: app.key.clone(),
        project: project_id.to_string(),
        project_name: found.name.clone(),
        branch: state.branch,
        commits,
        last_subject,
        last_when,
        last_is_older,
        dirty: state.dirty,
        ahead: state.ahead,
        reports: reports
            .iter()
            .find(|report| report.project == project_id)
            .map(|report| report.since_start)
            .unwrap_or(0),
    })
}

pub fn board() -> Result<Board, String> {
    let ops = ops_dir()?;
    let today = today();
    let apps = resolve_apps(&ops);
    let mut sprints = Vec::new();
    if let Ok(entries) = fs::read_dir(sprints_dir()?) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            if !name.ends_with(".md") || name.starts_with('_') {
                continue;
            }
            if let Some(sprint) = parse_sprint(&path, &today, &apps) {
                sprints.push(sprint);
            }
        }
    }
    // Active first, then planned soonest-first, then past newest-first.
    let rank = |phase: &str| match phase {
        "active" => 0,
        "planned" => 1,
        _ => 2,
    };
    sprints.sort_by(|a, b| {
        rank(&a.phase).cmp(&rank(&b.phase)).then_with(|| match a.phase.as_str() {
            "planned" => a.starts.cmp(&b.starts),
            _ => b.starts.cmp(&a.starts),
        })
    });
    // Movement is measured for the sprint you are actually in. With none running there is no
    // window to measure, and a made-up one would put numbers on the screen that mean nothing.
    let running = sprints.iter().find(|s| s.phase == "active").cloned();
    let reports = latest_reports(running.as_ref().map(|s| s.starts.as_str()).unwrap_or(""));
    let activity = match running.as_ref() {
        None => Vec::new(),
        Some(sprint) => {
            // Focus order first, then any app a goal names — the focus list is the ranking, and a
            // goal on an app outside it still deserves its movement shown.
            let mut keys: Vec<&str> = sprint.focus.iter().map(String::as_str).collect();
            for goal in &sprint.goals {
                if goal.app != "-" && !keys.contains(&goal.app.as_str()) {
                    keys.push(&goal.app);
                }
            }
            keys.iter()
                .filter_map(|key| apps.iter().find(|app| app.key == **key))
                .filter_map(|app| {
                    let project = app.project.clone()?;
                    app_activity(app, &project, sprint, &reports)
                })
                .collect()
        }
    };

    Ok(Board {
        today,
        sprints,
        apps,
        blocked: blocked_on_you(&ops),
        reports,
        measured_for: running.map(|s| s.id).unwrap_or_default(),
        activity,
    })
}

/* ----------------------------------------------------------------- writes */

fn sprint_path(id: &str) -> Result<PathBuf, String> {
    let safe: String = id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        .collect();
    if safe.is_empty() || safe.starts_with('_') {
        return Err(format!("not a sprint id: {id}"));
    }
    Ok(sprints_dir()?.join(format!("{safe}.md")))
}

fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let parent = path.parent().ok_or("sprint path has no parent")?;
    fs::create_dir_all(parent).map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    let temp = path.with_extension(format!("md.save-{}", uuid::Uuid::new_v4()));
    fs::write(&temp, text).map_err(|e| format!("could not write {}: {e}", path.display()))?;
    if let Err(error) = fs::rename(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(format!("could not save {}: {error}", path.display()));
    }
    Ok(())
}

fn read_sprint(id: &str) -> Result<(PathBuf, String), String> {
    let path = sprint_path(id)?;
    let text = fs::read_to_string(&path).map_err(|e| format!("no sprint {id}: {e}"))?;
    Ok((path, text))
}

/// Append one bullet under `## Log`, creating the section at the end when it is missing.
fn with_log(text: &str, entry: &str) -> String {
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    let bullet = format!("- {} — {}", today(), entry);
    let log_at = lines.iter().position(|line| line.trim().eq_ignore_ascii_case("## log"));
    match log_at {
        Some(at) => {
            // Past the last bullet of the section, before the next heading or the end.
            let mut insert = at + 1;
            for (offset, line) in lines[at + 1..].iter().enumerate() {
                if line.starts_with("## ") {
                    break;
                }
                if !line.trim().is_empty() {
                    insert = at + 2 + offset;
                }
            }
            lines.insert(insert, bullet);
        }
        None => {
            if lines.last().is_some_and(|l| !l.trim().is_empty()) {
                lines.push(String::new());
            }
            lines.push("## Log".into());
            lines.push(bullet);
        }
    }
    let mut out = lines.join("\n");
    out.push('\n');
    out
}

pub fn log(id: &str, entry: &str) -> Result<(), String> {
    let (path, text) = read_sprint(id)?;
    write_atomic(&path, &with_log(&text, entry))
}

/// Rewrite one goal's checkbox. `index` and `text` both have to match: the file may have been
/// edited by hand since the screen read it, and ticking the wrong line is worse than refusing.
pub fn set_goal(id: &str, index: usize, text: &str, state: &str) -> Result<(), String> {
    let mark = match state {
        "done" => 'x',
        "blocked" => '!',
        "todo" => ' ',
        other => return Err(format!("not a goal state: {other}")),
    };
    let (path, raw) = read_sprint(id)?;
    let mut lines: Vec<String> = raw.lines().map(str::to_string).collect();
    let line = lines
        .get(index)
        .ok_or_else(|| format!("goal {index} is gone from {id}"))?;
    let parsed = parse_goal(line).ok_or_else(|| format!("line {index} is not a goal any more"))?;
    if parsed.3 != text {
        return Err("the sprint file changed underneath — reopen the screen".into());
    }
    let open = line.find("- [").ok_or("malformed goal line")?;
    let mut rewritten = line.clone();
    rewritten.replace_range(open + 3..open + 4, &mark.to_string());
    lines[index] = rewritten;
    let mut out = lines.join("\n");
    out.push('\n');
    let verb = match state {
        "done" => "done",
        "blocked" => "blocked",
        _ => "reopened",
    };
    write_atomic(&path, &with_log(&out, &format!("{verb}: {text}")))
}

/// Append a goal line at the end of `## Goals`.
pub fn add_goal(id: &str, app: &str, owner: &str, text: &str, done_when: &str) -> Result<(), String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("a goal needs text".into());
    }
    let app = if app.trim().is_empty() { "-" } else { app.trim() };
    let owner = if owner.trim().is_empty() { "you" } else { owner.trim() };
    let mut line = format!("- [ ] {app} | {owner} | {text}");
    if !done_when.trim().is_empty() {
        line.push_str(&format!("  [done-when: {}]", done_when.trim()));
    }
    let (path, raw) = read_sprint(id)?;
    let mut lines: Vec<String> = raw.lines().map(str::to_string).collect();
    let goals_at = lines.iter().position(|l| l.trim().eq_ignore_ascii_case("## goals"));
    match goals_at {
        Some(at) => {
            let mut insert = at + 1;
            for (offset, existing) in lines[at + 1..].iter().enumerate() {
                if existing.starts_with("## ") {
                    break;
                }
                if !existing.trim().is_empty() {
                    insert = at + 2 + offset;
                }
            }
            lines.insert(insert, line);
        }
        None => {
            lines.push(String::new());
            lines.push("## Goals".into());
            lines.push(line);
        }
    }
    let mut out = lines.join("\n");
    out.push('\n');
    write_atomic(&path, &out)
}

/// The file exactly as it sits on disk. The screen's hand-edit mode opens this, so what you
/// type is the same Markdown the manager wrote and the same one it will read back.
pub fn read_raw(id: &str) -> Result<String, String> {
    Ok(read_sprint(id)?.1)
}

/// Save a hand edit, but only over the text the editor was handed.
///
/// Two writers share this file: you in the editor, an agent in its terminal. A blind write is
/// how one of you silently loses a plan. `expect` is what the editor loaded, so a write that
/// would clobber someone else's is refused instead of applied.
pub fn write_raw(id: &str, text: &str, expect: &str) -> Result<(), String> {
    let (path, current) = read_sprint(id)?;
    if current.trim_end() != expect.trim_end() {
        return Err("the sprint changed on disk while you were editing — reload before saving".into());
    }
    let mut text = text.to_string();
    if !text.ends_with('\n') {
        text.push('\n');
    }
    write_atomic(&path, &text)
}

pub fn create(id: &str, title: &str, starts: &str, ends: &str, focus: &[String]) -> Result<Sprint, String> {
    let path = sprint_path(id)?;
    if path.exists() {
        return Err(format!("sprint {id} already exists"));
    }
    let title = if title.trim().is_empty() { id } else { title.trim() };
    let focus_line = focus
        .iter()
        .map(|k| k.trim())
        .filter(|k| !k.is_empty())
        .collect::<Vec<_>>()
        .join(", ");
    let text = format!(
        "---\nid: {id}\ntitle: {title}\nstarts: {starts}\nends: {ends}\nfocus: [{focus_line}]\n---\n\n# {title}\n\n## Goals\n\n## Log\n- {} — opened\n",
        today()
    );
    write_atomic(&path, &text)?;
    let ops = ops_dir()?;
    let apps = resolve_apps(&ops);
    parse_sprint(&path, &today(), &apps).ok_or_else(|| "wrote the sprint but could not read it back".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn goal_line_parses_all_shapes() {
        let (state, app, owner, text, when, _) =
            parse_goal("- [x] sagar | cpo | Release to Play  [done-when: BL 8.3.0 live]").unwrap();
        assert_eq!((state.as_str(), app.as_str(), owner.as_str()), ("done", "sagar", "cpo"));
        assert_eq!(text, "Release to Play");
        assert_eq!(when, "BL 8.3.0 live");

        let (state, app, owner, text, _, _) = parse_goal("- [!] Decide the penalty").unwrap();
        assert_eq!((state.as_str(), app.as_str(), owner.as_str()), ("blocked", "-", "you"));
        assert_eq!(text, "Decide the penalty");

        assert!(parse_goal("- plain bullet").is_none());
    }

    #[test]
    fn log_lands_after_the_last_bullet() {
        let text = "# t\n\n## Goals\n- [ ] a\n\n## Log\n- 2026-01-01 — opened\n";
        let out = with_log(text, "done: a");
        let at = out.find("done: a").unwrap();
        assert!(at > out.find("opened").unwrap());
        assert!(out.ends_with('\n'));
    }

    #[test]
    fn portfolio_reads_both_yaml_shapes() {
        let dir = std::env::temp_dir().join(format!("sprints-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("portfolio.yaml"),
            "focus: []\n\napps:\n  notes_app:\n    name: Notes App\n    dir: apps/notes_app   # moved\n    kind: social\n    status: live\n\n  # --- Flutter apps ---\n  tavla:          { name: Tavla,              dir: Tavla,              kind: flutter-app, status: review, revenuecat: { project: \"p\", offerings: [default] }, depends_on: [flame_server], notes: \"a, b\" }\n  flame_server:   { name: Flame Appgea Server, dir: flame-appgea-server, kind: server, serves: [tavla, pisti] }\n",
        )
        .unwrap();
        let apps: Vec<(String, String, String, String, String)> = portfolio(&dir)
            .into_iter()
            .map(|app| (app.key, app.name, app.dir, app.status, app.notes))
            .collect();
        let row = |key: &str, name: &str, dir: &str, status: &str, notes: &str| {
            (key.into(), name.into(), dir.into(), status.into(), notes.into())
        };
        assert_eq!(
            apps,
            vec![
                row("notes_app", "Notes App", "apps/notes_app", "live", ""),
                row("tavla", "Tavla", "Tavla", "review", "a, b"),
                row("flame_server", "Flame Appgea Server", "flame-appgea-server", "", ""),
            ]
        );
        let apps = portfolio(&dir);
        assert_eq!(apps[1].depends_on, vec!["flame_server".to_string()]);
        assert_eq!(apps[2].serves, vec!["tavla".to_string(), "pisti".to_string()]);
        assert_eq!((apps[0].kind.as_str(), apps[2].kind.as_str()), ("social", "server"));
        let _ = fs::remove_dir_all(dir);
    }
}
