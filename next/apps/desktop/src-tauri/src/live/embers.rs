//! Embers: the report each stopped agent leaves in its room.
//!
//! A report is written the moment an agent that Live saw running is gone, from facts Live already
//! holds: its task, the last thing it said, the files it wrote, its steps and its time. No AI
//! call, so it is ready at once and costs nothing. Reports stay 12 hours and survive a restart in
//! `~/.appgeapanel/state/panel-live-embers.json`.

use super::track::{Step, Track};
use super::{Agent, Harness, State};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

const KEEP_MS: u64 = 12 * 60 * 60 * 1000;
const MAX: usize = 300;
/// An agent seen for less than this, with no step, is a blip: a `claude --version`, a quick probe.
const BLIP_MS: u64 = 20_000;

/// How an agent ended. `Failed` comes from a board result that says failed, which this scan does
/// not read yet, so nothing sets it here.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    /// It ended waiting for its owner, after saying its last word.
    #[serde(alias = "finished")]
    Done,
    Failed,
    /// Live's hold-to-stop ended it.
    Stopped,
    /// It vanished with no last message, or in the middle of a step.
    #[serde(alias = "cut")]
    Crashed,
    /// It ended while Live showed it stuck.
    Stuck,
}

/// What the last scan knew of an agent at its end. The order of the checks is the rule.
fn outcome(last: &Agent, stopped: bool) -> Outcome {
    if stopped {
        Outcome::Stopped
    } else if last.state == State::Stuck {
        Outcome::Stuck
    } else if last.last_text.is_none() || (last.now.is_some() && last.state != State::Turn) {
        Outcome::Crashed
    } else {
        Outcome::Done
    }
}

/// Live's Stop asked this process to end. Its ember then says Stopped, not Crashed.
pub fn stopped_by_owner(pid: u32) {
    let mut s = shelf().lock().unwrap_or_else(|p| p.into_inner());
    s.stopped.push(pid);
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ember {
    pub id: String,
    pub name: Option<String>,
    pub harness: Harness,
    pub headless: bool,
    pub room: String,
    pub room_name: String,
    pub model: Option<String>,
    pub session: Option<String>,
    pub cwd: String,
    pub task: Option<String>,
    /// The first line of the last thing it said.
    pub result: Option<String>,
    pub outcome: Outcome,
    pub files: Vec<String>,
    pub steps: Vec<Step>,
    pub step_count: u32,
    pub parent_name: Option<String>,
    pub via: Option<String>,
    pub started_ms: Option<u64>,
    pub ended_ms: u64,
}

#[derive(Default)]
struct Shelf {
    loaded: bool,
    seen: HashMap<String, (Agent, u64)>,
    embers: Vec<Ember>,
    /// Pids Live's Stop signalled, until their ember is written.
    stopped: Vec<u32>,
}

fn shelf() -> &'static Mutex<Shelf> {
    static SHELF: OnceLock<Mutex<Shelf>> = OnceLock::new();
    SHELF.get_or_init(Default::default)
}

fn file() -> PathBuf {
    crate::paths::user_root().join("state").join("panel-live-embers.json")
}

/// The agent as its transcript ended, when that was read after the last scan saw it. The scan
/// before an exit misses the final answer and still shows the last step open.
fn at_end(last: &Agent, ended: &HashMap<String, Track>) -> Agent {
    let mut a = last.clone();
    let Some(t) = a.session.as_ref().and_then(|s| ended.get(s)) else { return a };
    if t.last_text.is_some() {
        a.last_text = t.last_text.clone();
    }
    a.now = t.now();
    a.steps = t.recent(30);
    a.step_count = a.step_count.max(t.steps);
    a.files = t.files.iter().rev().take(40).cloned().collect();
    a
}

/// Compare this scan with the last one. Every agent that is gone becomes an ember, judged on its
/// transcript's last read in `ended` where there is one. Returns the shelf, newest first.
pub fn update(agents: &[Agent], ended: &HashMap<String, Track>, now: u64) -> Vec<Ember> {
    let mut s = shelf().lock().unwrap_or_else(|p| p.into_inner());
    if !s.loaded {
        s.loaded = true;
        s.embers = std::fs::read(file()).ok().and_then(|raw| serde_json::from_slice(&raw).ok()).unwrap_or_default();
    }
    let before = s.embers.len();
    let names: HashMap<&str, Option<String>> = agents.iter().map(|a| (a.id.as_str(), a.name.clone())).collect();
    let mut gone: Vec<Ember> = Vec::new();
    for (id, (last, first_seen)) in &s.seen {
        if names.contains_key(id.as_str()) {
            continue;
        }
        if last.step_count == 0 && now.saturating_sub(*first_seen) < BLIP_MS {
            continue;
        }
        let last = &at_end(last, ended);
        let parent_name = last.parent.as_ref().and_then(|p| s.seen.get(p)).map(|(p, _)| p.name.clone().unwrap_or_else(|| p.harness_name().into()));
        gone.push(Ember {
            id: format!("{id}@{now}"),
            name: last.name.clone(),
            harness: last.harness,
            headless: last.headless,
            room: last.room.clone(),
            room_name: last.room_name.clone(),
            model: last.model.clone(),
            session: last.session.clone(),
            cwd: last.cwd.clone(),
            task: last.task.clone(),
            result: last.last_text.clone(),
            outcome: outcome(last, last.pid.is_some_and(|p| s.stopped.contains(&p))),
            files: last.files.clone(),
            steps: last.steps.clone(),
            step_count: last.step_count,
            parent_name,
            via: last.via.clone(),
            started_ms: last.started_ms,
            ended_ms: now,
        });
    }
    let firsts: HashMap<String, u64> = s.seen.iter().map(|(id, (_, t))| (id.clone(), *t)).collect();
    s.seen = agents.iter().map(|a| (a.id.clone(), (a.clone(), firsts.get(&a.id).copied().unwrap_or(now)))).collect();
    let alive: std::collections::HashSet<u32> = agents.iter().filter_map(|a| a.pid).collect();
    s.stopped.retain(|p| alive.contains(p));
    s.embers.extend(gone);
    s.embers.retain(|e| now.saturating_sub(e.ended_ms) < KEEP_MS);
    s.embers.sort_by(|a, b| b.ended_ms.cmp(&a.ended_ms));
    s.embers.truncate(MAX);
    if s.embers.len() != before {
        save(&s.embers);
    }
    s.embers.clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::live::track::Station;

    fn agent(state: State, said: Option<&str>, mid_step: bool) -> Agent {
        Agent {
            id: "pid:7".into(),
            pid: Some(7),
            harness: Harness::Claude,
            headless: false,
            name: None,
            session: None,
            cwd: String::new(),
            room: "hq".into(),
            room_name: "HQ".into(),
            parent: None,
            via: None,
            started_ms: None,
            busy: false,
            state,
            state_ms: None,
            model: None,
            task: None,
            now: mid_step.then(|| Step { at_ms: 0, label: "Run the tests".into(), station: Station::Check, file: None, helper: false, asks: false, verb: "test".into() }),
            steps: Vec::new(),
            step_count: 3,
            last_text: said.map(Into::into),
            helpers: 0,
            files: Vec::new(),
            panel: None,
            issue: None,
        }
    }

    #[test]
    fn an_ending_gets_one_of_five_outcomes() {
        assert_eq!(outcome(&agent(State::Turn, Some("Shipped."), false), false), Outcome::Done);
        assert_eq!(outcome(&agent(State::Work, Some("Running"), true), true), Outcome::Stopped);
        assert_eq!(outcome(&agent(State::Stuck, Some("Running"), true), false), Outcome::Stuck);
        assert_eq!(outcome(&agent(State::Work, None, false), false), Outcome::Crashed);
        assert_eq!(outcome(&agent(State::Work, Some("Running"), true), false), Outcome::Crashed);
        // A shelf saved before the five outcomes still reads.
        assert_eq!(serde_json::from_str::<Outcome>("\"finished\"").unwrap(), Outcome::Done);
        assert_eq!(serde_json::from_str::<Outcome>("\"cut\"").unwrap(), Outcome::Crashed);
    }

    #[test]
    fn a_run_that_answered_after_the_last_scan_is_done() {
        // The last scan saw it mid-step with nothing said. Its transcript ends with an answer.
        let mut last = agent(State::Work, None, true);
        last.session = Some("s1".into());
        let mut t = Track::default();
        t.last_text = Some("Wrote the script.".into());
        let ended = HashMap::from([("s1".to_string(), t)]);
        assert_eq!(outcome(&last, false), Outcome::Crashed);
        assert_eq!(outcome(&at_end(&last, &ended), false), Outcome::Done);
    }
}

fn save(embers: &[Ember]) {
    let path = file();
    let Ok(raw) = serde_json::to_vec(embers) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, raw).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}
