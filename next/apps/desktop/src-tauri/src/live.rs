//! Live: every agent running on this Mac, who started it, and the project it works in.
//!
//! Read fresh on each call from what the agents already leave behind. Claude writes
//! `~/.claude/sessions/<pid>.json`. The process table gives parents and the other harnesses.
//! Codex rollouts cover sessions that live inside the Codex app server, which have no process of
//! their own. Nothing is stored, so a stale answer never outlives one poll.

use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Harness {
    Claude,
    Codex,
    Grok,
    Opencode,
    Gemini,
    Kimi,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    /// `pid:<pid>`, or `codex:<session>` for a Codex session with no process of its own.
    pub id: String,
    pub pid: Option<u32>,
    pub harness: Harness,
    /// Runs with nobody at it: `claude -p`, `codex exec`, `opencode run`.
    pub headless: bool,
    /// The folk name Panel and the board gave the session, when it has one.
    pub name: Option<String>,
    pub session: Option<String>,
    pub cwd: String,
    /// A portfolio key, or `hq`, `home` or `elsewhere`.
    pub room: String,
    pub room_name: String,
    /// The id of the nearest agent above it in the process tree.
    pub parent: Option<String>,
    /// The nearest launcher above it that is neither a shell nor an agent, like `board.py work`.
    pub via: Option<String>,
    pub started_ms: Option<u64>,
    pub busy: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct World {
    pub agents: Vec<Agent>,
    pub scanned_ms: u64,
}

/// A Codex session counts as running while its rollout was written this recently.
const CODEX_FRESH: Duration = Duration::from_secs(120);
/// CPU share above which a process counts as working rather than waiting.
const BUSY_CPU: f32 = 1.0;
/// The main process of the Grok Bot app. Its helpers live under `Contents/Frameworks`.
const GROK_BOT: &str = "Grok Bot.app/Contents/MacOS/";

struct Proc {
    ppid: u32,
    cpu: f32,
    args: String,
}

pub fn scan() -> World {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let procs = processes();
    let people = session_people(&home);
    let rooms = Rooms::load(&home);
    let mut agents: Vec<Agent> = Vec::new();

    for (pid, session, cwd, started) in claude_sessions(&home) {
        let Some(p) = procs.get(&pid) else { continue };
        if !p.args.contains("claude") {
            continue; // the pid was reused after that session ended
        }
        agents.push(agent(pid, p, Harness::Claude, headless_args(&p.args), Some(session), cwd, started));
    }
    let others: Vec<(u32, Harness, bool)> = procs
        .iter()
        .filter_map(|(&pid, p)| classify(&p.args).filter(|(h, _)| *h != Harness::Claude).map(|(h, headless)| (pid, h, headless)))
        .collect();
    let cwds = process_cwds(others.iter().map(|o| o.0));
    for (pid, harness, headless) in others {
        let p = &procs[&pid];
        let mut a = agent(pid, p, harness, headless, None, cwds.get(&pid).cloned().unwrap_or_default(), None);
        if p.args.contains(GROK_BOT) {
            // The Grok Bot app is Mahmut Hoca, the chief who runs the board's routine.
            a.name = Some("Mahmut Hoca".into());
            a.room = "hq".into();
            a.room_name = "HQ".into();
        }
        agents.push(a);
    }
    fold_wrappers(&mut agents, &procs);
    for (session, cwd, started, headless, busy) in codex_rollouts(&home) {
        if agents.iter().any(|a| a.harness == Harness::Codex && a.cwd == cwd) {
            continue;
        }
        agents.push(Agent {
            id: format!("codex:{session}"),
            pid: None,
            harness: Harness::Codex,
            headless,
            name: None,
            session: Some(session),
            cwd,
            room: String::new(),
            room_name: String::new(),
            parent: None,
            via: Some("Codex app".into()),
            started_ms: started,
            busy,
        });
    }

    let by_pid: HashMap<u32, String> = agents.iter().filter_map(|a| Some((a.pid?, a.id.clone()))).collect();
    for a in &mut agents {
        if let Some(pid) = a.pid {
            let (parent, via) = lineage(pid, &procs, &by_pid);
            a.parent = parent;
            a.via = via;
        }
        if a.name.is_none() {
            a.name = a
                .session
                .as_ref()
                .and_then(|s| people.by_session.get(s))
                .or_else(|| a.pid.and_then(|p| people.by_pid.get(&p)))
                .cloned();
        }
        if a.room.is_empty() {
            (a.room, a.room_name) = rooms.room_for(Path::new(&a.cwd));
        }
    }
    agents.sort_by(|a, b| a.room.cmp(&b.room).then(a.started_ms.cmp(&b.started_ms)).then(a.id.cmp(&b.id)));
    World { agents, scanned_ms: now_ms() }
}

fn agent(pid: u32, p: &Proc, harness: Harness, headless: bool, session: Option<String>, cwd: String, started: Option<u64>) -> Agent {
    Agent {
        id: format!("pid:{pid}"),
        pid: Some(pid),
        harness,
        headless,
        name: None,
        session,
        cwd,
        room: String::new(),
        room_name: String::new(),
        parent: None,
        via: None,
        started_ms: started,
        busy: p.cpu >= BUSY_CPU,
    }
}

/// The harness a command line runs, and whether nobody sits at it. Servers and helpers that
/// host agents without being one, like `codex app-server`, are not agents.
fn classify(args: &str) -> Option<(Harness, bool)> {
    let mut words: Vec<&str> = args.split_whitespace().collect();
    if words.is_empty() {
        return None;
    }
    if args.contains(GROK_BOT) {
        return Some((Harness::Grok, false));
    }
    let mut tool = base(words.remove(0));
    if matches!(tool, "node" | "bun" | "deno") {
        if words.is_empty() {
            return None;
        }
        tool = base(words.remove(0));
    }
    let sub = words.first().copied().unwrap_or("");
    let harness = match tool {
        "claude" if !args.contains("--chrome-native-host") => Harness::Claude,
        "codex" if !matches!(sub, "app-server" | "mcp" | "mcp-server" | "login") => Harness::Codex,
        "opencode" if !matches!(sub, "serve" | "web" | "acp") => Harness::Opencode,
        "gemini" => Harness::Gemini,
        "kimi" => Harness::Kimi,
        "grok" => Harness::Grok,
        _ => return None,
    };
    Some((harness, headless_args(args) || matches!(sub, "exec" | "run")))
}

fn headless_args(args: &str) -> bool {
    args.split_whitespace().any(|w| w == "-p" || w == "--print")
}

fn base(word: &str) -> &str {
    word.rsplit('/').next().unwrap_or(word)
}

/// A script wrapper and the binary it starts are one agent: `node …/codex` runs the native
/// `codex`. Only a parent run by a script runner folds, so a real `codex exec` that a Codex
/// agent starts still shows as its own agent.
fn fold_wrappers(agents: &mut Vec<Agent>, procs: &HashMap<u32, Proc>) {
    let wrapper = |pid: u32| {
        let first = procs.get(&pid).and_then(|p| p.args.split_whitespace().next()).unwrap_or("");
        matches!(base(first), "node" | "bun" | "deno")
    };
    let harness_of: HashMap<u32, Harness> = agents.iter().filter_map(|a| Some((a.pid?, a.harness))).collect();
    let mut busy_parents: Vec<u32> = Vec::new();
    agents.retain(|a| {
        let Some(pid) = a.pid else { return true };
        let ppid = procs.get(&pid).map(|p| p.ppid).unwrap_or(0);
        if harness_of.get(&ppid) == Some(&a.harness) && a.session.is_none() && wrapper(ppid) {
            if a.busy {
                busy_parents.push(ppid);
            }
            return false;
        }
        true
    });
    for a in agents.iter_mut() {
        if a.pid.is_some_and(|p| busy_parents.contains(&p)) {
            a.busy = true;
        }
    }
}

/// The nearest agent above `pid`, and the nearest launcher below that agent which is neither a
/// shell nor an agent. A fleet started by `board.py work` under launchd has no agent parent,
/// so the launcher is the only lineage the process tree can give.
fn lineage(pid: u32, procs: &HashMap<u32, Proc>, agents: &HashMap<u32, String>) -> (Option<String>, Option<String>) {
    let mut via = None;
    let mut cur = procs.get(&pid).map(|p| p.ppid).unwrap_or(0);
    for _ in 0..64 {
        if cur <= 1 {
            break;
        }
        if let Some(id) = agents.get(&cur) {
            return (Some(id.clone()), via);
        }
        let Some(p) = procs.get(&cur) else { break };
        if via.is_none() && !is_plumbing(&p.args) {
            via = Some(launcher_label(&p.args));
        }
        cur = p.ppid;
    }
    (None, via)
}

fn is_plumbing(args: &str) -> bool {
    let first = args.split_whitespace().next().unwrap_or("");
    let tool = base(first).trim_start_matches('-');
    matches!(tool, "zsh" | "bash" | "sh" | "fish" | "login" | "tmux" | "screen" | "sudo" | "env" | "nohup" | "testlock" | "caffeinate")
}

/// A script runner names its script, even when the runner is an app bundle like Python.app.
fn launcher_label(args: &str) -> String {
    let words: Vec<&str> = args.split_whitespace().collect();
    let first = base(words.first().copied().unwrap_or(""));
    if first.to_ascii_lowercase().starts_with("python") || matches!(first, "node" | "bun" | "deno") {
        let mut rest = words.iter().skip(1).filter(|w| !w.starts_with('-'));
        if let Some(script) = rest.next() {
            let script = base(script);
            return match rest.next() {
                Some(sub) if !sub.contains('/') => format!("{script} {sub}"),
                _ => script.to_string(),
            };
        }
    }
    if let Some(at) = args.find(".app/Contents/") {
        let app = &args[..at];
        return app.rsplit('/').next().unwrap_or(app).to_string();
    }
    first.to_string()
}

fn processes() -> HashMap<u32, Proc> {
    let Ok(out) = Command::new("ps").args(["-ax", "-o", "pid=,ppid=,pcpu=,args="]).output() else {
        return HashMap::new();
    };
    String::from_utf8_lossy(&out.stdout).lines().filter_map(parse_ps_line).collect()
}

fn parse_ps_line(line: &str) -> Option<(u32, Proc)> {
    let (pid, rest) = field(line)?;
    let (ppid, rest) = field(rest)?;
    let (cpu, rest) = field(rest)?;
    Some((pid.parse().ok()?, Proc { ppid: ppid.parse().ok()?, cpu: cpu.parse().unwrap_or(0.0), args: rest.trim().to_string() }))
}

fn field(s: &str) -> Option<(&str, &str)> {
    let s = s.trim_start();
    let end = s.find(char::is_whitespace)?;
    Some((&s[..end], &s[end..]))
}

/// The working folders of the non-Claude agents, in one `lsof` call. Claude's come from its own
/// session files. Where `lsof` is missing, those rooms stay unknown.
fn process_cwds(pids: impl Iterator<Item = u32>) -> HashMap<u32, String> {
    let list: Vec<String> = pids.map(|p| p.to_string()).collect();
    if list.is_empty() {
        return HashMap::new();
    }
    let Ok(out) = Command::new("lsof").args(["-a", "-d", "cwd", "-Fpn", "-p", &list.join(",")]).output() else {
        return HashMap::new();
    };
    let mut cwds = HashMap::new();
    let mut pid = 0;
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        if let Some(p) = line.strip_prefix('p') {
            pid = p.parse().unwrap_or(0);
        } else if let Some(path) = line.strip_prefix('n') {
            cwds.insert(pid, path.to_string());
        }
    }
    cwds
}

/// `(pid, session, cwd, startedAt)` from each `~/.claude/sessions/<pid>.json`.
fn claude_sessions(home: &Path) -> Vec<(u32, String, String, Option<u64>)> {
    let Ok(dir) = fs::read_dir(home.join(".claude/sessions")) else { return Vec::new() };
    dir.flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| {
            let v: serde_json::Value = serde_json::from_str(&fs::read_to_string(e.path()).ok()?).ok()?;
            Some((
                u32::try_from(v.get("pid")?.as_u64()?).ok()?,
                v.get("sessionId")?.as_str()?.to_string(),
                v.get("cwd").and_then(|c| c.as_str()).unwrap_or("").to_string(),
                v.get("startedAt").and_then(|s| s.as_u64()),
            ))
        })
        .collect()
}

/// `(session, cwd, started, headless, busy)` for each Codex rollout written in the last
/// `CODEX_FRESH`. Only the two newest day folders can hold one.
fn codex_rollouts(home: &Path) -> Vec<(String, String, Option<u64>, bool, bool)> {
    let root = home.join(".codex/sessions");
    let Some(year) = newest(&root, 1).pop() else { return Vec::new() };
    let Some(month) = newest(&year, 1).pop() else { return Vec::new() };
    let now = SystemTime::now();
    newest(&month, 2)
        .iter()
        .filter_map(|day| fs::read_dir(day).ok())
        .flatten()
        .flatten()
        .filter_map(|e| {
            let age = now.duration_since(e.metadata().ok()?.modified().ok()?).unwrap_or_default();
            if age > CODEX_FRESH {
                return None;
            }
            let mut first = String::new();
            BufReader::new(fs::File::open(e.path()).ok()?).read_line(&mut first).ok()?;
            let meta: serde_json::Value = serde_json::from_str(&first).ok()?;
            let p = meta.get("payload")?;
            Some((
                p.get("id")?.as_str()?.to_string(),
                p.get("cwd").and_then(|c| c.as_str()).unwrap_or("").to_string(),
                None,
                p.get("originator").and_then(|o| o.as_str()) == Some("codex_exec"),
                age < Duration::from_secs(20),
            ))
        })
        .collect()
}

fn newest(dir: &Path, n: usize) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = fs::read_dir(dir)
        .map(|d| d.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect())
        .unwrap_or_default();
    dirs.sort();
    dirs.split_off(dirs.len().saturating_sub(n))
}

#[derive(Default)]
struct People {
    by_session: HashMap<String, String>,
    by_pid: HashMap<u32, String>,
}

/// The folk names in `~/.appgeapanel/state/session-people.json`, written by the board's tools.
fn session_people(home: &Path) -> People {
    let mut people = People::default();
    let Ok(raw) = fs::read_to_string(home.join(".appgeapanel/state/session-people.json")) else { return people };
    let Ok(serde_json::Value::Object(map)) = serde_json::from_str(&raw) else { return people };
    let written = written_names();
    for (session, v) in map {
        let Some(name) = v.get("name").and_then(|n| n.as_str()) else { continue };
        let name = display_name(name, &written);
        if let Some(pid) = v.get("pid").and_then(|p| p.as_u64()).and_then(|p| u32::try_from(p).ok()) {
            people.by_pid.insert(pid, name.clone());
        }
        people.by_session.insert(session, name);
    }
    people
}

/// The board stores names as ASCII slugs. Their written form lives once, in the people table of
/// `ops/runbooks/slack.py`, as lines like `"pisekar": ("Pişekar", ...`.
fn written_names() -> HashMap<String, String> {
    let Some(raw) = crate::ops::ops_dir().and_then(|o| fs::read_to_string(o.join("runbooks/slack.py")).ok()) else {
        return HashMap::new();
    };
    raw.lines()
        .filter_map(|line| {
            let rest = line.trim_start().strip_prefix('"')?;
            let (slug, rest) = rest.split_once("\": (\"")?;
            let (shown, _) = rest.split_once('"')?;
            slug.chars().all(|c| c.is_ascii_lowercase() || c == '_' || c == '-').then(|| (slug.to_string(), shown.to_string()))
        })
        .collect()
}

fn display_name(slug: &str, written: &HashMap<String, String>) -> String {
    if let Some(shown) = written.get(slug) {
        return shown.clone();
    }
    let mut out = String::new();
    for (i, part) in slug.split(['-', '_']).enumerate() {
        if i > 0 {
            out.push(' ');
        }
        let mut chars = part.chars();
        if let Some(c) = chars.next() {
            out.extend(c.to_uppercase());
            out.push_str(chars.as_str());
        }
    }
    out
}

struct Rooms {
    home: PathBuf,
    ops: Option<PathBuf>,
    apps: Vec<crate::sprints::PortfolioApp>,
    root: PathBuf,
}

impl Rooms {
    fn load(home: &Path) -> Self {
        let ops = crate::ops::ops_dir();
        let apps = ops.as_deref().map(crate::sprints::portfolio).unwrap_or_default();
        let root = ops.as_deref().and_then(Path::parent).map(Path::to_path_buf).unwrap_or_default();
        Rooms { home: home.to_path_buf(), ops, apps, root }
    }

    /// The room for a working folder. A Claude scratchpad such as
    /// `/private/tmp/claude-502/-Users-appgea-Desktop-projects-appgea-apps-interbellum/<id>/scratchpad`
    /// names its project in the encoded folder, so it belongs to that project's room.
    fn room_for(&self, cwd: &Path) -> (String, String) {
        if let Some(app) = crate::pulse::owning_app(cwd, &self.root, &self.apps) {
            return (app.key.clone(), app.name.clone());
        }
        if let Some(app) = self.scratch_owner(cwd) {
            return (app.key.clone(), app.name.clone());
        }
        let in_hq = self.ops.as_deref().is_some_and(|o| cwd.starts_with(o)) || cwd.starts_with(self.home.join(".appgeapanel"));
        if in_hq {
            return ("hq".into(), "HQ".into());
        }
        if cwd.as_os_str().is_empty() {
            return ("elsewhere".into(), "Elsewhere".into());
        }
        if cwd == self.home {
            return ("home".into(), "Home folder".into());
        }
        ("elsewhere".into(), "Elsewhere".into())
    }

    fn scratch_owner(&self, cwd: &Path) -> Option<&crate::sprints::PortfolioApp> {
        let encoded = cwd.components().find_map(|c| {
            let s = c.as_os_str().to_str()?;
            s.starts_with("-Users-").then_some(s)
        })?;
        self.apps
            .iter()
            .filter(|app| !app.dir.is_empty() && encoded.ends_with(&format!("-{}", app.dir.replace(['/', '.', '_'], "-"))))
            .max_by_key(|app| app.dir.len())
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_tells_agents_from_their_servers() {
        assert_eq!(classify("claude"), Some((Harness::Claude, false)));
        assert_eq!(classify("/Users/a/.local/bin/claude -p --permission-mode auto"), Some((Harness::Claude, true)));
        assert_eq!(classify("/Users/a/.local/bin/claude --chrome-native-host"), None);
        assert_eq!(classify("/x/bin/codex app-server --listen unix://"), None);
        assert_eq!(classify("node /opt/homebrew/bin/codex exec do it"), Some((Harness::Codex, true)));
        assert_eq!(classify("/Users/a/.opencode/bin/opencode serve --service"), None);
        assert_eq!(classify("/x/Python /Users/a/ops/runbooks/board.py work"), None);
    }

    #[test]
    fn a_launchd_fleet_names_its_launcher() {
        let mut procs = HashMap::new();
        procs.insert(54744, Proc { ppid: 1, cpu: 0.0, args: "/x/Python.app/Contents/MacOS/Python /Users/a/ops/runbooks/board.py work --n 3".into() });
        procs.insert(6526, Proc { ppid: 54744, cpu: 0.6, args: "/Users/a/.local/bin/claude -p".into() });
        let (parent, via) = lineage(6526, &procs, &HashMap::new());
        assert_eq!(parent, None);
        assert_eq!(via.as_deref(), Some("board.py work"));
    }
}
