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
    Mac { load, cores, hot: hot(&therm), bays: bays(procs, agent_pids) }
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
}
