//! Live: every agent running on this Mac, who started it, and the project it works in.
//!
//! Read fresh on each call from what the agents already leave behind. Claude writes
//! `~/.claude/sessions/<pid>.json`. The process table gives parents and the other harnesses.
//! Codex rollouts cover sessions that live inside the Codex app server, which have no process of
//! their own. Claude transcripts say what each agent does (track.rs). Only the reports of
//! stopped agents are stored (embers.rs). The rest is read fresh, so it never outlives a poll.

pub mod catalog;
mod embers;
pub use embers::stopped_by_owner;
mod jobs;
mod mac;
mod opencode;
mod track;
mod verbs;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub use track::Step;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Harness {
    Claude,
    Codex,
    Grok,
    Opencode,
    Gemini,
    Kimi,
}

/// What a dot's colour says. One state per agent, decided in [`state_of`].
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum State {
    /// A step is running.
    Work,
    /// Busy between steps: the model is thinking or writing.
    Think,
    /// A person sits at it and it waits for that person: its turn ended, or it asked a question.
    Turn,
    /// Nobody waits on it and it does nothing.
    Idle,
    /// One step has run far longer than any step should, with the process quiet.
    Stuck,
}

impl Agent {
    fn harness_name(&self) -> &'static str {
        match self.harness {
            Harness::Claude => "Claude",
            Harness::Codex => "Codex",
            Harness::Grok => "Grok",
            Harness::Opencode => "OpenCode",
            Harness::Gemini => "Gemini",
            Harness::Kimi => "Kimi",
        }
    }
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
    pub state: State,
    /// Since when it has been in `state`, as far as the logs say.
    pub state_ms: Option<u64>,
    pub model: Option<String>,
    /// The session title, or the first line of the first prompt.
    pub task: Option<String>,
    /// The step running now.
    pub now: Option<Step>,
    /// Newest first, the running step on top.
    pub steps: Vec<Step>,
    /// Every step it started, so the view pulses once per new one.
    pub step_count: u32,
    pub last_text: Option<String>,
    /// Helpers it runs now, drawn as small dots circling it.
    pub helpers: u32,
    /// Files it wrote, full paths.
    pub files: Vec<String>,
    /// The Panel terminal that hosts it. Filled by the command in main.rs, which holds the hooks.
    pub panel: Option<String>,
    /// The board issue it last named.
    pub issue: Option<u32>,
    /// Set on a subagent: its type, like `Explore`. Its `parent` is the agent that started it.
    pub helper_kind: Option<String>,
}

/// A room is a project, or HQ, the home folder or Elsewhere.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Room {
    pub key: String,
    pub name: String,
    /// The portfolio's order, so rooms keep their places and never reshuffle.
    pub order: u32,
    /// 3 for an app that earns, 2 for a store app, 1 for the rest. A card's stake starts here.
    pub weight: u8,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct World {
    pub agents: Vec<Agent>,
    /// Scripts, builds, tests and renders, each with the agent that started it.
    pub jobs: Vec<jobs::Job>,
    pub embers: Vec<embers::Ember>,
    pub rooms: Vec<Room>,
    pub mac: mac::Mac,
    /// The animation scripts, one per verb (catalog.rs).
    pub catalog: Vec<serde_json::Value>,
    pub scanned_ms: u64,
}

/// A step running this long, with the process quiet, is stuck. testlock queues and long builds
/// stay under it.
const STUCK_MS: u64 = 30 * 60 * 1000;

/// A Codex session counts as running while its rollout was written this recently.
const CODEX_FRESH: Duration = Duration::from_secs(120);
/// CPU share above which a process counts as working rather than waiting.
const BUSY_CPU: f32 = 1.0;
/// The main process of the Grok Bot app. Its helpers live under `Contents/Frameworks`.
const GROK_BOT: &str = "Grok Bot.app/Contents/MacOS/";

struct Proc {
    ppid: u32,
    cpu: f32,
    /// Seconds since it started, from `ps` etime.
    age_s: Option<u64>,
    args: String,
}

pub fn scan() -> World {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let procs = processes();
    let people = session_people(&home);
    let rooms = Rooms::load(&home);
    let mut agents: Vec<Agent> = Vec::new();
    let mut status: HashMap<String, ClaudeSession> = HashMap::new();

    for c in claude_sessions(&home) {
        let Some(p) = procs.get(&c.pid) else { continue };
        if !p.args.contains("claude") {
            continue; // the pid was reused after that session ended
        }
        let headless = headless_args(&p.args) || c.kind.as_deref().is_some_and(|k| k != "interactive");
        let mut a = agent(c.pid, p, Harness::Claude, headless, Some(c.session.clone()), c.cwd.clone(), c.started);
        a.name = c.name.clone();
        agents.push(a);
        status.insert(c.session.clone(), c);
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
    let fleet = fleet_workers(&home);
    let mut producers: HashMap<String, u32> = HashMap::new();
    let mut claims: HashMap<String, (u32, String)> = HashMap::new();
    for a in &mut agents {
        let Some(w) = a.pid.and_then(|p| fleet.get(&p)) else { continue };
        if a.session.is_none() {
            a.session = w.session.clone();
        }
        if a.name.is_none() {
            let tail: String = w.session.as_deref().unwrap_or_default().chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
            a.name = Some(format!("{} {tail}", title_case(&w.kind)).trim().to_string());
        }
        if let Some(p) = w.producer {
            producers.insert(a.id.clone(), p);
        }
        if let Some((n, title)) = &w.claim {
            claims.insert(a.id.clone(), (*n, title.clone()));
        }
    }
    let rollouts = codex_rollouts(&home);
    for (session, cwd, started, headless, busy) in rollouts.iter().cloned() {
        if agents.iter().any(|a| a.harness == Harness::Codex && a.session.as_deref() == Some(session.as_str())) {
            continue;
        }
        // A Codex process names no session. When it is the only one in its folder and the folder
        // has only this fresh rollout, that rollout is its transcript. Anything less is a guess.
        let bare = |a: &Agent| a.harness == Harness::Codex && a.session.is_none() && a.cwd == cwd;
        if agents.iter().filter(|a| bare(a)).count() == 1 && rollouts.iter().filter(|r| r.1 == cwd).count() == 1 {
            if let Some(a) = agents.iter_mut().find(|a| bare(a)) {
                a.session = Some(session);
            }
            continue;
        }
        if agents.iter().any(|a| a.harness == Harness::Codex && a.cwd == cwd) {
            continue;
        }
        let mut a = blank(format!("codex:{session}"), None, Harness::Codex, headless, Some(session), cwd, started, busy);
        a.via = Some("Codex app".into());
        agents.push(a);
    }

    let by_pid: HashMap<u32, String> = agents.iter().filter_map(|a| Some((a.pid?, a.id.clone()))).collect();
    let sessions: Vec<(String, track::Kind)> = agents
        .iter()
        .filter_map(|a| {
            let kind = match a.harness {
                Harness::Claude => track::Kind::Claude,
                Harness::Codex => track::Kind::Codex,
                _ => return None,
            };
            Some((a.session.clone()?, kind))
        })
        .collect();
    let (tracks, ended) = track::read(&home, &sessions);
    let now = now_ms();
    let wants: Vec<opencode::Want> = agents
        .iter()
        .filter(|a| a.harness == Harness::Opencode)
        .map(|a| opencode::Want {
            agent: a.id.clone(),
            session: a.pid.and_then(|p| procs.get(&p)).and_then(|p| opencode::session_in_args(&p.args)),
        })
        .collect();
    let oc = opencode::read(&wants, now);
    let parents: Vec<PathBuf> = agents.iter().filter(|a| a.harness == Harness::Claude).filter_map(|a| tracks.get(a.session.as_ref()?)).map(|t| t.path.clone()).collect();
    let subs = track::subs(&parents, now);
    let mut helpers: Vec<Agent> = Vec::new();
    for a in &mut agents {
        if let Some(pid) = a.pid {
            let (parent, via) = lineage(pid, &procs, &by_pid);
            // A fleet runs under launchd. Its state file names the process that started it.
            a.parent = parent.or_else(|| producers.get(&a.id).and_then(|p| ancestor_agent(*p, &procs, &by_pid)));
            a.via = via;
        }
        // The board's folk name wins over Claude's derived one, like `appgea-54`.
        let folk = a.session.as_ref().and_then(|s| people.by_session.get(s)).or_else(|| a.pid.and_then(|p| people.by_pid.get(&p))).cloned();
        if folk.is_some() {
            a.name = folk;
        }
        let read = oc.get(&a.id);
        let t = a.session.as_ref().and_then(|s| tracks.get(s)).or(read.map(|r| &r.track));
        let s = a.session.as_ref().and_then(|s| status.get(s));
        if let Some(t) = t {
            a.model = t.model.clone();
            a.task = t.task();
            a.now = t.now();
            a.steps = t.recent(30);
            a.step_count = t.steps;
            a.last_text = t.last_text.clone();
            a.helpers = t.helpers();
            a.files = t.files.iter().rev().take(40).cloned().collect();
            a.issue = t.issue;
        }
        if let Some(r) = read {
            a.session.get_or_insert_with(|| r.session.clone());
            a.task = a.task.take().or_else(|| r.title.clone());
        }
        if let Some((n, title)) = claims.get(&a.id) {
            // The claimed issue says more than a fleet session's stock title.
            a.issue = Some(*n);
            a.task = Some(title.clone());
        }
        if a.room.is_empty() {
            (a.room, a.room_name) = rooms.area(a, t);
        }
        (a.state, a.state_ms) = state_of(a, t, s, now);
        let mine: Vec<(String, Option<String>, Option<String>, Option<String>, Option<u64>, &track::Track)> = match (t, read) {
            (_, Some(r)) => r.subs.iter().map(|(id, title, st)| (id.clone(), None, title.clone(), st.model.clone(), None, st)).collect(),
            (Some(t), None) => subs.get(&t.path).into_iter().flatten().map(|x| (x.id.clone(), x.kind.clone(), x.what.clone(), x.model.clone(), x.started_ms, &x.track)).collect(),
            _ => Vec::new(),
        };
        // A foreground helper is an open step and a subagent file at once. Count it once.
        a.helpers = a.helpers.saturating_sub(mine.len() as u32);
        for (id, kind, what, model, started, st) in mine {
            helpers.push(helper(a, id, kind, what, model, started, st, now));
        }
    }
    agents.extend(helpers);
    agents.sort_by(|a, b| a.room.cmp(&b.room).then(a.started_ms.cmp(&b.started_ms)).then(a.id.cmp(&b.id)));
    // A subagent that ends is part of its parent's work, not news of its own.
    let tops: Vec<Agent> = agents.iter().filter(|a| a.helper_kind.is_none()).cloned().collect();
    let embers = embers::update(&tops, &ended, now);
    let pids: HashMap<u32, String> = agents.iter().filter_map(|a| Some((a.pid?, a.id.clone()))).collect();
    let mac = mac::read(&procs, &pids);
    let in_project = |p: &Path| crate::pulse::owning_app(p, &rooms.root, &rooms.apps).is_some();
    let mut jobs = jobs::read(&procs, &pids, &in_project, now);
    let room_of: HashMap<&str, (&str, &str)> = agents.iter().map(|a| (a.id.as_str(), (a.room.as_str(), a.room_name.as_str()))).collect();
    for j in &mut jobs {
        let owned = j.agent.as_deref().and_then(|a| room_of.get(a));
        (j.room, j.room_name) = match (owned, &j.path_hint) {
            (Some((k, n)), _) => (k.to_string(), n.to_string()),
            (None, Some(path)) => rooms.room_for(Path::new(path)),
            (None, None) => ("elsewhere".into(), "Elsewhere".into()),
        };
    }
    let rooms = rooms.rooms();
    // The steps of the last poll window, newest first: any verb among them without a script gets one.
    let seen: Vec<(String, String)> = agents.iter().flat_map(|a| a.now.iter().chain(a.steps.iter().take(5))).map(|s| (s.verb.clone(), s.label.clone())).collect();
    catalog::write_missing(&seen);
    World { agents, jobs, embers, rooms, mac, catalog: catalog::read(), scanned_ms: now }
}

/// One worker a `board work --fleet` run started, from its `board-work-fleet-<pid>.json`.
struct FleetWorker {
    /// The model kind, like `terra` or `sol`.
    kind: String,
    /// Read from the worker's own log, where Codex prints `session id: …`.
    session: Option<String>,
    /// The process that started the fleet, when it says.
    producer: Option<u32>,
    /// The issue it claimed, from the `#1068 claimed by …: <title>` line board prints in its log.
    claim: Option<(u32, String)>,
}

/// The last issue a fleet worker's log says it claimed. Board prints the line near the top.
fn claim_in_log(log: &Path) -> Option<(u32, String)> {
    let mut head = String::new();
    BufReader::new(fs::File::open(log).ok()?).take(64 << 10).read_to_string(&mut head).ok()?;
    head.lines().rev().find_map(|l| {
        let rest = l.trim().strip_prefix('#')?;
        let (n, after) = rest.split_once(" claimed by ")?;
        let title = after.split_once(": ").map(|(_, t)| t.trim().to_string()).filter(|t| !t.is_empty())?;
        Some((n.parse().ok()?, title))
    })
}

/// Running fleet workers by pid. Board writes these files. Without them, workers still show,
/// only nameless and without their parent.
fn fleet_workers(home: &Path) -> HashMap<u32, FleetWorker> {
    let mut out = HashMap::new();
    let Ok(dir) = fs::read_dir(home.join(".appgeapanel/state")) else { return out };
    for e in dir.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if !(name.starts_with("board-work-fleet-") && name.ends_with(".json")) {
            continue;
        }
        let Some(v) = fs::read(e.path()).ok().and_then(|raw| serde_json::from_slice::<serde_json::Value>(&raw).ok()) else { continue };
        if !v["ended"].is_null() && v["ended"] != false {
            continue;
        }
        let producer = v["producer_pid"].as_u64().and_then(|p| u32::try_from(p).ok());
        for w in v["workers"].as_array().into_iter().flatten().filter(|w| w["active"] == true) {
            let Some(pid) = w["pid"].as_u64().and_then(|p| u32::try_from(p).ok()) else { continue };
            let log = w["log"].as_str().map(Path::new);
            let session = log.and_then(codex_session_in_log).or_else(|| w["session"].as_str().map(str::to_string));
            let claim = log.and_then(claim_in_log);
            out.insert(pid, FleetWorker { kind: w["kind"].as_str().unwrap_or_default().to_string(), session, producer, claim });
        }
    }
    out
}

/// Codex prints `session id: <uuid>` in the header of every `codex exec` run.
fn codex_session_in_log(log: &Path) -> Option<String> {
    let mut head = String::new();
    BufReader::new(fs::File::open(log).ok()?).take(4096).read_to_string(&mut head).ok()?;
    head.lines().find_map(|l| l.trim().strip_prefix("session id:")).map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// The agent at `pid` or nearest above it.
fn ancestor_agent(pid: u32, procs: &HashMap<u32, Proc>, agents: &HashMap<u32, String>) -> Option<String> {
    let mut cur = pid;
    for _ in 0..64 {
        if let Some(id) = agents.get(&cur) {
            return Some(id.clone());
        }
        cur = procs.get(&cur).map(|p| p.ppid).filter(|&p| p > 1)?;
    }
    None
}

fn title_case(word: &str) -> String {
    let mut c = word.chars();
    c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
}

/// Whether hold-to-stop may signal `pid`: an agent or a job in a fresh scan, never a service,
/// and never Panel itself.
pub fn stoppable(pid: u32) -> bool {
    if pid == std::process::id() || pid <= 1 {
        return false;
    }
    let w = scan();
    w.agents.iter().any(|a| a.pid == Some(pid)) || w.jobs.iter().any(|j| j.pid == pid && j.kind != jobs::JobKind::Service)
}

/// One state per agent. Claude says busy or idle itself in its session file. A person's session
/// that is idle waits for that person. The rest comes from the transcript and the CPU.
fn state_of(a: &Agent, t: Option<&track::Track>, s: Option<&ClaudeSession>, now: u64) -> (State, Option<u64>) {
    let open_since = a.now.as_ref().map(|n| n.at_ms);
    if t.is_some_and(|t| t.asks()) {
        return (State::Turn, open_since);
    }
    if t.is_none() && s.is_none() {
        // Harnesses Live cannot read yet: only the CPU speaks.
        return (if a.busy { State::Work } else { State::Idle }, None);
    }
    let said = s.and_then(|s| s.status.as_deref());
    let since = s.and_then(|s| s.status_ms);
    match said {
        Some("idle") if !a.headless => (State::Turn, since),
        Some("idle") => (State::Idle, since),
        Some("busy") | None => {
            if let Some(at) = open_since {
                if now.saturating_sub(at) > STUCK_MS && !a.busy {
                    return (State::Stuck, Some(at));
                }
                return (State::Work, Some(at));
            }
            if said.is_none() && !a.busy {
                return (State::Idle, None);
            }
            (State::Think, t.map(|t| t.last_ms).filter(|&m| m > 0).or(since))
        }
        // Anything else Claude may report, like a prompt for a permission, waits on a person.
        Some(_) => (State::Turn, since),
    }
}

fn agent(pid: u32, p: &Proc, harness: Harness, headless: bool, session: Option<String>, cwd: String, started: Option<u64>) -> Agent {
    let started = started.or_else(|| p.age_s.map(|s| now_ms().saturating_sub(s * 1000)));
    blank(format!("pid:{pid}"), Some(pid), harness, headless, session, cwd, started, p.cpu >= BUSY_CPU)
}

/// A running subagent as an agent of its own, riding on `parent` in the parent's room.
/// Its id is `<parent id>/<agent id>`.
#[allow(clippy::too_many_arguments)]
fn helper(parent: &Agent, id: String, kind: Option<String>, what: Option<String>, model: Option<String>, started: Option<u64>, t: &track::Track, now: u64) -> Agent {
    let busy = now.saturating_sub(t.last_ms) < 60_000;
    let mut h = blank(format!("{}/{id}", parent.id), None, parent.harness, true, None, parent.cwd.clone(), started.or(Some(t.last_ms).filter(|&m| m > 0)), busy);
    h.parent = Some(parent.id.clone());
    h.helper_kind = Some(kind.unwrap_or_else(|| "helper".into()));
    h.room = parent.room.clone();
    h.room_name = parent.room_name.clone();
    h.model = model;
    h.task = what.or_else(|| t.task());
    h.now = t.now();
    h.steps = t.recent(12);
    h.step_count = t.steps;
    h.last_text = t.last_text.clone();
    h.helpers = t.helpers();
    h.files = t.files.iter().rev().take(20).cloned().collect();
    // With no session status, a step running means Work, words in the last minute Think.
    (h.state, h.state_ms) = state_of(&h, Some(t), None, now);
    h
}

#[allow(clippy::too_many_arguments)]
fn blank(id: String, pid: Option<u32>, harness: Harness, headless: bool, session: Option<String>, cwd: String, started: Option<u64>, busy: bool) -> Agent {
    Agent {
        id,
        pid,
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
        busy,
        state: if busy { State::Work } else { State::Idle },
        state_ms: None,
        model: None,
        task: None,
        now: None,
        steps: Vec::new(),
        step_count: 0,
        last_text: None,
        helpers: 0,
        files: Vec::new(),
        panel: None,
        issue: None,
        helper_kind: None,
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
    if first.to_ascii_lowercase().starts_with("python") && words.contains(&"-c") {
        // Inline code: name it by the first module it imports past the standard ones, like `fleet`.
        // `ps` prints a newline inside an argument as the four characters `\012`.
        let code = args.replace("\\012", "\n");
        let module = code
            .split(|c: char| c.is_whitespace() || c == ';' || c == ',')
            .collect::<Vec<_>>()
            .windows(2)
            .find(|w| w[0].ends_with("import") && !matches!(w[1], "sys" | "os" | "json" | "time" | "re" | "subprocess" | ""))
            .map(|w| w[1].to_string());
        return module.unwrap_or_else(|| "a Python script".into());
    }
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
    let Ok(out) = Command::new("ps").args(["-ax", "-o", "pid=,ppid=,pcpu=,etime=,args="]).output() else {
        return HashMap::new();
    };
    String::from_utf8_lossy(&out.stdout).lines().filter_map(parse_ps_line).collect()
}

fn parse_ps_line(line: &str) -> Option<(u32, Proc)> {
    let (pid, rest) = field(line)?;
    let (ppid, rest) = field(rest)?;
    let (cpu, rest) = field(rest)?;
    let (etime, rest) = field(rest)?;
    Some((
        pid.parse().ok()?,
        Proc { ppid: ppid.parse().ok()?, cpu: cpu.parse().unwrap_or(0.0), age_s: elapsed(etime), args: rest.trim().to_string() },
    ))
}

/// `ps` etime, `[[dd-]hh:]mm:ss`, in seconds.
fn elapsed(etime: &str) -> Option<u64> {
    let (days, clock) = match etime.split_once('-') {
        Some((d, c)) => (d.parse::<u64>().ok()?, c),
        None => (0, etime),
    };
    let parts: Vec<u64> = clock.split(':').map(|p| p.parse().ok()).collect::<Option<_>>()?;
    let s = parts.iter().fold(0, |acc, p| acc * 60 + p);
    Some(days * 86_400 + s)
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

/// One `~/.claude/sessions/<pid>.json`. Claude keeps `status` (busy or idle) current itself.
struct ClaudeSession {
    pid: u32,
    session: String,
    cwd: String,
    started: Option<u64>,
    /// `interactive` when a person runs it in a terminal.
    kind: Option<String>,
    /// Claude's own name for it, like `appgea-54`.
    name: Option<String>,
    status: Option<String>,
    status_ms: Option<u64>,
}

fn claude_sessions(home: &Path) -> Vec<ClaudeSession> {
    let Ok(dir) = fs::read_dir(home.join(".claude/sessions")) else { return Vec::new() };
    dir.flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| {
            let v: serde_json::Value = serde_json::from_str(&fs::read_to_string(e.path()).ok()?).ok()?;
            let text = |k: &str| v.get(k).and_then(|c| c.as_str()).filter(|s| !s.is_empty()).map(str::to_string);
            Some(ClaudeSession {
                pid: u32::try_from(v.get("pid")?.as_u64()?).ok()?,
                session: v.get("sessionId")?.as_str()?.to_string(),
                cwd: text("cwd").unwrap_or_default(),
                started: v.get("startedAt").and_then(|s| s.as_u64()),
                kind: text("kind"),
                name: text("name"),
                status: text("status"),
                status_ms: v.get("statusUpdatedAt").and_then(|s| s.as_u64()),
            })
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

    /// Where an agent works, judged by its work and not its folder. Owner, 2026-11-05: "We
    /// shouldn't rely on the folders to decide where they are. It is their operational area."
    /// Each recent file it wrote counts 3, each path it read or named in a command 1, newer ones
    /// more. Its folder adds 2, so it decides only a tie. With no path at all, an app named in
    /// its task wins, and the folder comes last.
    fn area(&self, a: &Agent, t: Option<&track::Track>) -> (String, String) {
        let mut score: HashMap<String, (u32, String)> = HashMap::new();
        let mut add = |path: &str, w: u32| {
            // Skills and agent settings are how an agent works, not what it works on.
            if ["/.appgeapanel/skills/", "/.claude/", "/.agents/", "/.codex/"].iter().any(|s| path.contains(s)) {
                return;
            }
            let (key, name) = self.room_for(Path::new(path));
            if key != "home" && key != "elsewhere" {
                score.entry(key).or_insert((0, name)).0 += w;
            }
        };
        if let Some(t) = t {
            for (i, f) in t.files.iter().rev().take(12).enumerate() {
                add(f, if i < 4 { 4 } else { 3 });
            }
            for (i, p) in t.paths.iter().rev().take(20).enumerate() {
                add(p, if i < 6 { 2 } else { 1 });
            }
        }
        add(&a.cwd, 2);
        let worked = t.is_some_and(|t| !t.files.is_empty() || !t.paths.is_empty()) && score.values().any(|(s, _)| *s > 2);
        if worked {
            let best = score.into_iter().max_by(|x, y| x.1 .0.cmp(&y.1 .0).then_with(|| y.0.cmp(&x.0)));
            if let Some((key, (_, name))) = best {
                return (key, name);
            }
        }
        if let Some(app) = a.task.as_deref().and_then(|task| self.named_in(task)) {
            return (app.key.clone(), app.name.clone());
        }
        self.room_for(Path::new(&a.cwd))
    }

    /// The app a task names as a whole word, like "Cardly native iOS: parity pass". Longest name
    /// first, so "Tavla Pro" beats "Tavla".
    fn named_in(&self, task: &str) -> Option<&crate::sprints::PortfolioApp> {
        let words: Vec<String> = task.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(str::to_lowercase).collect();
        self.apps
            .iter()
            .filter(|app| {
                let name: Vec<String> = app.name.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(str::to_lowercase).collect();
                name.first().is_some_and(|n| n.len() >= 4) && words.windows(name.len()).any(|w| w == name.as_slice())
            })
            .max_by_key(|app| app.name.len())
    }

    /// Every room an agent can stand in, in portfolio order: HQ first, the apps as
    /// `portfolio.yaml` lists them, then the home folder and Elsewhere. The view shows the ones
    /// with someone in them. A fleet worker in the company folder moves to its issue's app there.
    fn rooms(&self) -> Vec<Room> {
        let fixed = |key: &str, name: &str, order| Room { key: key.into(), name: name.into(), order, weight: 1 };
        let mut out = vec![fixed("hq", "HQ", 0)];
        out.extend(self.apps.iter().enumerate().map(|(i, a)| Room {
            key: a.key.clone(),
            name: a.name.clone(),
            order: i as u32 + 1,
            weight: if a.earns { 3 } else if a.in_store { 2 } else { 1 },
        }));
        out.push(fixed("home", "Home folder", 9000));
        out.push(fixed("elsewhere", "Elsewhere", 9001));
        out
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

    /// `cargo test dump_live -- --ignored` writes this Mac's live world to /tmp/live.real.json.
    #[test]
    #[ignore]
    fn dump_live() {
        let w = scan();
        std::fs::write("/tmp/live.real.json", serde_json::to_string_pretty(&w).unwrap()).unwrap();
    }

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
        procs.insert(54744, Proc { ppid: 1, cpu: 0.0, age_s: None, args: "/x/Python.app/Contents/MacOS/Python /Users/a/ops/runbooks/board.py work --n 3".into() });
        procs.insert(6526, Proc { ppid: 54744, cpu: 0.6, age_s: None, args: "/Users/a/.local/bin/claude -p".into() });
        let (parent, via) = lineage(6526, &procs, &HashMap::new());
        assert_eq!(parent, None);
        assert_eq!(via.as_deref(), Some("board.py work"));
    }
}
