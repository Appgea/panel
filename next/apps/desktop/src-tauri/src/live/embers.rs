//! Embers: the report each stopped agent leaves in its room.
//!
//! A report is written the moment an agent that Live saw running is gone, from facts Live already
//! holds: its task, the last thing it said, the files it wrote, its steps and its time. No AI
//! call, so it is ready at once and costs nothing. Reports stay 12 hours and survive a restart in
//! `~/.appgeapanel/state/panel-live-embers.json`.

use super::track::Step;
use super::{Agent, Harness, State};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

const KEEP_MS: u64 = 12 * 60 * 60 * 1000;
const MAX: usize = 300;
/// An agent seen for less than this, with no step, is a blip: a `claude --version`, a quick probe.
const BLIP_MS: u64 = 20_000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    /// It ended between steps, after saying its last word.
    Finished,
    /// It ended in the middle of a step: killed, crashed or cut off.
    Cut,
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
}

fn shelf() -> &'static Mutex<Shelf> {
    static SHELF: OnceLock<Mutex<Shelf>> = OnceLock::new();
    SHELF.get_or_init(Default::default)
}

fn file() -> PathBuf {
    crate::paths::user_root().join("state").join("panel-live-embers.json")
}

/// Compare this scan with the last one. Every agent that is gone becomes an ember. Returns the
/// shelf, newest first.
pub fn update(agents: &[Agent], now: u64) -> Vec<Ember> {
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
            outcome: if last.now.is_some() && last.state != State::Turn { Outcome::Cut } else { Outcome::Finished },
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
    s.embers.extend(gone);
    s.embers.retain(|e| now.saturating_sub(e.ended_ms) < KEEP_MS);
    s.embers.sort_by(|a, b| b.ended_ms.cmp(&a.ended_ms));
    s.embers.truncate(MAX);
    if s.embers.len() != before {
        save(&s.embers);
    }
    s.embers.clone()
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
