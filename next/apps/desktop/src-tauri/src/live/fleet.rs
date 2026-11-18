//! The fleet: cheap builders and scouts that ops `runbooks/fleet.py` runs, each an interactive CLI
//! in a tmux session of its own, and the commander who sends them out.
//!
//! fleet.py keeps every running unit in `~/.appgeapanel/state/fleet/units.json`, and each unit's
//! shell runs `<state>/fleet/<id>.sh`, whose prompt starts "You are fleet builder <id>" or "You are
//! fleet scout <id>". So an agent whose own command line or ancestors say so is that unit. Without
//! this every unit showed on Live as a nameless OpenCode dot, idle, in Elsewhere.
//!
//! The commander is the session that last commanded the fleet: fleet.py writes `commander.json`
//! with its agent's pid on every command a unit does not run.

use super::Proc;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

/// A commander quiet this long has handed the fleet back: Live stops crowning it.
const COMMANDER_FRESH_S: f64 = 45.0 * 60.0;

/// One unit as fleet.py writes it. Only the fields Live reads.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct Unit {
    pub id: String,
    pub kind: String,
    /// The Claude session id it was started with.
    pub sid: Option<String>,
    /// The OpenCode session that holds its prompt, once fleet.py found it.
    pub oc: Option<String>,
    /// The Codex or Claude transcript it writes, once fleet.py found it.
    pub log: Option<String>,
    /// A scout's routine, like `legal@TavlaSkor`. Empty for a builder.
    pub scout: String,
    /// The issues `fleet build` gave it, like `1900,1901`.
    pub build: String,
    pub held: Vec<u32>,
    pub titles: HashMap<String, String>,
    pub budget: Option<u32>,
    pub started: f64,
    pub flags: Vec<String>,
}

/// What Live shows of a unit, on the agent it runs as.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub unit: String,
    /// `terra`, `flash`, `sonnet`: its class on the map.
    pub kind: String,
    /// A scout's routine, like `legal@TavlaSkor`. None for a builder.
    pub scout: Option<String>,
    /// What it holds now, else what it was sent for.
    pub issues: Vec<Mission>,
    /// Minutes it may take before it counts as slow.
    pub budget: u32,
    pub started_ms: u64,
    /// `OVER`, `STUCK`, as `fleet status` prints them.
    pub flags: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Mission {
    pub number: u32,
    pub title: String,
}

pub fn units(home: &Path) -> HashMap<String, Unit> {
    fs::read(home.join(".appgeapanel/state/fleet/units.json"))
        .ok()
        .and_then(|raw| serde_json::from_slice::<HashMap<String, Unit>>(&raw).ok())
        .unwrap_or_default()
}

/// The unit an agent's process runs, from its prompt or the unit script an ancestor sources.
pub fn unit_of(pid: u32, procs: &HashMap<u32, Proc>) -> Option<String> {
    let mut cur = pid;
    for _ in 0..12 {
        let p = procs.get(&cur)?;
        if let Some(id) = named_in(&p.args) {
            return Some(id);
        }
        cur = p.ppid;
        if cur <= 1 {
            return None;
        }
    }
    None
}

fn named_in(args: &str) -> Option<String> {
    let id = |s: &str| -> Option<String> {
        let id: String = s.chars().take_while(|c| c.is_ascii_hexdigit()).collect();
        (id.len() == 6).then_some(id)
    };
    for lead in ["You are fleet builder ", "You are fleet scout "] {
        if let Some(rest) = args.split_once(lead).map(|(_, r)| r) {
            return id(rest);
        }
    }
    let (_, rest) = args.split_once("/state/fleet/")?;
    let (stem, ext) = rest.split_once('.')?;
    ext.starts_with("sh").then(|| id(stem)).flatten().filter(|i| i.len() == stem.len())
}

impl Unit {
    pub fn tag(&self) -> Tag {
        let title = |n: u32| self.titles.get(&n.to_string()).cloned().unwrap_or_default();
        let sent: Vec<u32> = self.build.split(',').filter_map(|n| n.trim().parse().ok()).collect();
        let numbers = if self.held.is_empty() { sent } else { self.held.clone() };
        Tag {
            unit: self.id.clone(),
            kind: self.kind.clone(),
            scout: Some(self.scout.clone()).filter(|s| !s.is_empty()),
            issues: numbers.into_iter().map(|number| Mission { number, title: title(number) }).collect(),
            budget: self.budget.unwrap_or(30),
            started_ms: (self.started * 1000.0) as u64,
            flags: self.flags.clone(),
        }
    }

    /// The app a scout was sent to, as its routine names it: `legal@TavlaSkor` is `TavlaSkor`.
    pub fn target(&self) -> Option<&str> {
        self.scout.split_once('@').map(|(_, app)| app).filter(|a| !a.is_empty())
    }

    /// The session id Live reads its steps by. A Codex rollout is named `rollout-<time>-<id>.jsonl`.
    pub fn session(&self) -> Option<String> {
        if let Some(oc) = &self.oc {
            return Some(oc.clone());
        }
        let log = Path::new(self.log.as_deref()?);
        let stem = log.file_stem()?.to_str()?;
        let id: String = stem.rsplitn(6, '-').take(5).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("-");
        (stem.starts_with("rollout-") && id.len() == 36).then_some(id)
    }
}

/// The pid of the agent that commands the fleet, while it commanded lately.
pub fn commander(home: &Path, now_s: f64) -> Option<u32> {
    let raw = fs::read(home.join(".appgeapanel/state/fleet/commander.json")).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&raw).ok()?;
    let at = v["at"].as_f64()?;
    (now_s - at < COMMANDER_FRESH_S).then(|| v["pid"].as_u64().and_then(|p| u32::try_from(p).ok())).flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_unit_is_found_by_its_prompt_or_its_script() {
        assert_eq!(named_in("opencode --auto --prompt You are fleet builder 8ae149. Read it"), Some("8ae149".into()));
        assert_eq!(named_in("claude --session-id x You are fleet scout 39a594. Run"), Some("39a594".into()));
        assert_eq!(named_in("/bin/zsh -lic source /Users/a/.appgeapanel/state/fleet/39a594.sh"), Some("39a594".into()));
        assert_eq!(named_in("cat /Users/a/.appgeapanel/state/fleet/units.json"), None);
        assert_eq!(named_in("claude"), None);
    }

    #[test]
    fn a_codex_rollout_names_its_session() {
        let u = Unit { log: Some("/x/rollout-2026-11-18T21-05-01-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.jsonl".into()), ..Default::default() };
        assert_eq!(u.session().as_deref(), Some("0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"));
    }
}
