//! This Mac, at the base of the Live stage: how loaded and how hot it is, and who holds the
//! testlock bays. Every session shares one Mac, and a hot one slows all of them.

use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Mac {
    /// The one-minute load average.
    pub load: f32,
    pub cores: u32,
    /// macOS recorded a thermal or performance warning, or slowed the CPU.
    pub hot: bool,
    pub bays: Vec<Bay>,
    /// Each harness's weekly quota, where this Mac keeps a local record of it.
    pub quota: Vec<Quota>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Quota {
    pub harness: String,
    /// Percent of the week's limit used.
    pub used: f32,
}

/// A record older than this may sit across a weekly reset, so it is not shown.
const QUOTA_FRESH_S: f64 = 6.0 * 3600.0;

/// Claude Code's status line writes the session's `seven_day` use to `quota.jsonl` once a
/// minute (ops/runbooks/sinks.py `quota_tick`). Codex keeps no local record, so it has none.
fn quota(now_s: f64) -> Vec<Quota> {
    let path = crate::paths::user_root().join("state").join("quota.jsonl");
    use std::io::{Read, Seek, SeekFrom};
    // Only the tail: the file grows by a line a minute per session, and this runs every poll.
    let Ok(mut f) = std::fs::File::open(&path) else { return Vec::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let mut raw = Vec::new();
    if f.seek(SeekFrom::Start(len.saturating_sub(64 * 1024))).and_then(|_| f.read_to_end(&mut raw)).is_err() {
        return Vec::new();
    }
    let tail = String::from_utf8_lossy(&raw).into_owned();
    claude_week(&tail, now_s).map(|used| vec![Quota { harness: "Claude".into(), used }]).unwrap_or_default()
}

fn claude_week(lines: &str, now_s: f64) -> Option<f32> {
    lines.lines().rev().find_map(|l| {
        let v: serde_json::Value = serde_json::from_str(l).ok()?;
        let ts = v.get("ts")?.as_f64()?;
        let used = v.get("seven_day")?.as_f64()?;
        (now_s - ts < QUOTA_FRESH_S).then_some(used as f32)
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bay {
    /// The Live agent whose process tree holds the bay, when one does.
    pub agent: Option<String>,
    /// What runs in it, like `flutter test`, when something does.
    pub holder: Option<String>,
}

pub fn read(procs: &HashMap<u32, super::Proc>, agent_pids: &HashMap<u32, String>) -> Mac {
    let sysctl = |key: &str| Command::new("sysctl").args(["-n", key]).output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    let load = sysctl("vm.loadavg")
        .and_then(|s| s.trim_matches(|c| c == '{' || c == '}').split_whitespace().next().and_then(|v| v.parse().ok()))
        .unwrap_or(0.0);
    let cores = sysctl("hw.ncpu").and_then(|s| s.parse().ok()).unwrap_or(0);
    let therm = Command::new("pmset").args(["-g", "therm"]).output().map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
    let now_s = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0);
    Mac { load, cores, hot: hot(&therm), bays: bays(procs, agent_pids), quota: quota(now_s) }
}

fn hot(therm: &str) -> bool {
    therm.lines().any(|l| {
        let l = l.trim();
        if let Some(v) = l.strip_prefix("CPU_Speed_Limit").and_then(|r| r.trim_start_matches([' ', '=']).trim().parse::<u32>().ok()) {
            return v < 100;
        }
        l.contains("warning level") && !l.contains("No ")
    })
}

/// The bays `testlock` keeps as `slot-N/pid` folders. Its own script names the folder.
fn bays(procs: &HashMap<u32, super::Proc>, agent_pids: &HashMap<u32, String>) -> Vec<Bay> {
    let dir = std::env::var_os("INTERBELLUM_TEST_QUEUE")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache/interbellum-tests")))
        .unwrap_or_default();
    let slots: usize = std::env::var("TESTLOCK_SLOTS").ok().and_then(|v| v.parse().ok()).filter(|&n| n > 0).unwrap_or(2);
    (0..slots)
        .map(|i| {
            let pid: Option<u32> = std::fs::read_to_string(dir.join(format!("slot-{i}/pid")))
                .ok()
                .and_then(|s| s.lines().next().and_then(|l| l.trim().parse().ok()))
                .filter(|p| procs.contains_key(p));
            let Some(pid) = pid else { return Bay { agent: None, holder: None } };
            let mut agent = None;
            let mut cur = pid;
            for _ in 0..64 {
                if let Some(id) = agent_pids.get(&cur) {
                    agent = Some(id.clone());
                    break;
                }
                match procs.get(&cur) {
                    Some(p) if p.ppid > 1 => cur = p.ppid,
                    _ => break,
                }
            }
            // The bay's own pid is testlock's shell. What it runs is its child.
            let child = procs.iter().find(|(_, p)| p.ppid == pid).map(|(_, p)| p.args.as_str());
            let holder = child.or_else(|| procs.get(&pid).map(|p| p.args.as_str())).map(super::launcher_label);
            Bay { agent, holder }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_quiet_mac_is_not_hot() {
        assert!(!super::hot("Note: No thermal warning level has been recorded\nNote: No performance warning level has been recorded"));
        assert!(super::hot("CPU_Speed_Limit = 70"));
    }

    #[test]
    fn the_newest_fresh_week_reading_wins() {
        let lines = "{\"ts\": 1000, \"seven_day\": 40}\n{\"ts\": 2000, \"seven_day\": 46}\n{\"ts\": 2100, \"seven_day\": null}\n";
        assert_eq!(super::claude_week(lines, 2200.0), Some(46.0));
        // Older than six hours: it may be from before the weekly reset.
        assert_eq!(super::claude_week(lines, 2000.0 + 7.0 * 3600.0), None);
    }
}
