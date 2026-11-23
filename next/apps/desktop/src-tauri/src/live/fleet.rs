
use super::Proc;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

const COMMANDER_FRESH_S: f64 = 45.0 * 60.0;

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct Unit {
    pub id: String,
    pub kind: String,
    pub sid: Option<String>,
    pub oc: Option<String>,
    pub log: Option<String>,
    pub scout: String,
    pub build: String,
    pub shape: String,
    pub held: Vec<u32>,
    pub titles: HashMap<String, String>,
    pub budget: Option<u32>,
    pub started: f64,
    pub flags: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub unit: String,
    pub kind: String,
    pub scout: Option<String>,
    pub role: &'static str,
    pub ability: Option<String>,
    pub question: Option<String>,
    pub issues: Vec<Mission>,
    pub budget: u32,
    pub started_ms: u64,
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
    for lead in ["You are fleet builder ", "You are fleet scout ", "You are fleet checker "] {
        if let Some(rest) = args.split_once(lead).map(|(_, r)| r) {
            return id(rest);
        }
    }
    let (_, rest) = args.split_once("/state/fleet/")?;
    let (stem, ext) = rest.split_once('.')?;
    ext.starts_with("sh").then(|| id(stem)).flatten().filter(|i| i.len() == stem.len())
}

impl Unit {
    pub fn tag(&self, home: &Path) -> Tag {
        let title = |n: u32| self.titles.get(&n.to_string()).cloned().unwrap_or_default();
        let sent: Vec<u32> = [&self.build, &self.shape].iter().flat_map(|s| s.split(',')).filter_map(|n| n.trim().parse().ok()).collect();
        let numbers = if self.held.is_empty() { sent } else { self.held.clone() };
        let scouts = home.join(".appgeapanel/ops/scouts");
        let ability = Some(&self.scout).filter(|s| !s.is_empty()).and_then(|run| ability_of(home, run));
        let lens = self.scout.split('@').next().unwrap_or_default();
        let question = match &ability {
            Some(a) => title_of(&scouts.join("abilities").join(format!("{a}.md"))),
            None => Some(lens).filter(|l| !l.is_empty()).and_then(|l| title_of(&scouts.join(format!("{l}.md")))),
        };
        Tag {
            unit: self.id.clone(),
            kind: self.kind.clone(),
            scout: Some(self.scout.clone()).filter(|s| !s.is_empty()),
            role: if !self.scout.is_empty() { "scout" } else if !self.shape.is_empty() { "checker" } else { "builder" },
            ability,
            question,
            issues: numbers.into_iter().map(|number| Mission { number, title: title(number) }).collect(),
            budget: self.budget.unwrap_or(30),
            started_ms: (self.started * 1000.0) as u64,
            flags: self.flags.clone(),
        }
    }

    pub fn target(&self) -> Option<&str> {
        self.scout.split_once('@').map(|(_, app)| app).filter(|a| !a.is_empty())
    }

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

fn ability_of(home: &Path, run: &str) -> Option<String> {
    let raw = fs::read(home.join(".appgeapanel/state/scout/runs.json")).ok()?;
    let log: serde_json::Value = serde_json::from_slice(&raw).ok()?;
    log[run]["ability"].as_str().filter(|a| *a != "own" && a.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')).map(str::to_string)
}

fn title_of(page: &Path) -> Option<String> {
    let raw = fs::read_to_string(page).ok()?;
    raw.lines().skip(1).take_while(|l| l.trim() != "---").find_map(|l| l.strip_prefix("title:")).map(|t| t.trim().trim_matches('"').to_string()).filter(|t| !t.is_empty())
}

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
