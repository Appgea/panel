//! Jobs: the scripts, builds, tests and renders running on this Mac, beside the agents.
//!
//! A job is the topmost process of a tree that runs a known tool or a script from the company
//! folder. Its children fold into it: a render is one job, not forty Chrome helpers. A job knows
//! the agent above it, so the view ties it to that dot. Without one, the job is a launcher (it
//! started agents), a service (it has run for hours under launchd), or left behind (its parent
//! died and it idles).
//!
//! Labels carry only tool and script names, never arguments. Secrets live in arguments.

use super::{base, launcher_label, Proc};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// Tools that are work in their own right wherever they run.
const TOOLS: &[&str] = &[
    "flutter", "dart", "cargo", "xcodebuild", "gradle", "gradlew", "vite", "vitest", "ffmpeg", "blender", "npm", "npx", "pnpm",
    "yarn", "tsc", "playwright", "simctl", "emulator", "swift", "swiftc", "go", "make", "uv", "pytest", "remotion", "testlock",
];
/// Parts of a command line that mark a helper of something else, never a job of its own.
const NOT_JOBS: &[&str] = &["mcp", "chrome-native-host", "code-mode-host", "caffeinate", "appgea-panel", "--type=", "crashpad", "/ps ", "lsof"];
const SERVICE_S: u64 = 6 * 3600;
const LEFT_S: u64 = 10 * 60;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum JobKind {
    /// Runs for an agent, or for a person in a terminal.
    Job,
    /// Started agents of its own, like a board fleet.
    Launcher,
    /// Has run for hours under launchd: a mirror, a bot, a watcher.
    Service,
    /// Its parent is gone and it idles. It holds memory and nobody will stop it.
    Left,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub pid: u32,
    pub label: String,
    pub kind: JobKind,
    /// The agent above it, when there is one.
    pub agent: Option<String>,
    /// A path in its command line names its project. The agent's room wins.
    pub path_hint: Option<String>,
    pub started_ms: Option<u64>,
    /// The whole tree's CPU, in percent of one core.
    pub cpu: f32,
    /// Processes in its tree.
    pub procs: u32,
    /// It runs inside a testlock bay.
    pub bay: bool,
    pub room: String,
    pub room_name: String,
}

/// `in_project` says whether a folder belongs to a portfolio project.
pub fn read(procs: &HashMap<u32, Proc>, agents: &HashMap<u32, String>, in_project: &dyn Fn(&Path) -> bool, now_ms: u64) -> Vec<Job> {
    let candidate = |pid: u32, p: &Proc| -> bool {
        if agents.contains_key(&pid) || NOT_JOBS.iter().any(|n| p.args.contains(n)) {
            return false;
        }
        // A bare shell or `zsh -c …` is plumbing. `bash script.sh` is a script.
        let second = p.args.split_whitespace().nth(1).unwrap_or("-");
        if super::is_plumbing(&p.args) && second.starts_with('-') {
            return false;
        }
        let first = p.args.split_whitespace().next().unwrap_or("");
        // App bundles are apps, except the script runners that live in one.
        if first.contains(".app/Contents/") && !first.contains("Python.app") {
            return false;
        }
        let tool = base(first);
        TOOLS.contains(&tool) || p.args.contains("/.local/bin/") || path_in(&p.args, in_project).is_some()
    };
    let kids: HashMap<u32, Vec<u32>> = procs.iter().fold(HashMap::new(), |mut m, (&pid, p)| {
        m.entry(p.ppid).or_default().push(pid);
        m
    });
    let agent_pids: HashSet<u32> = agents.keys().copied().collect();
    let cands: HashSet<u32> = procs.iter().filter(|(pid, p)| candidate(**pid, p)).map(|(pid, _)| *pid).collect();
    let mut out = Vec::new();
    for &pid in &cands {
        let p = &procs[&pid];
        // Topmost only: a candidate below another candidate is part of that job.
        let mut owner = None;
        let mut covered = false;
        let mut cur = p.ppid;
        for _ in 0..64 {
            if cur <= 1 {
                break;
            }
            if let Some(id) = agents.get(&cur) {
                owner = Some(id.clone());
                break;
            }
            let Some(up) = procs.get(&cur) else { break };
            if cands.contains(&cur) {
                covered = true;
                break;
            }
            cur = up.ppid;
        }
        if covered {
            continue;
        }
        let (cpu, count, starts_agents) = tree(pid, procs, &kids, &agent_pids);
        let age_s = p.age_s;
        let kind = if starts_agents {
            JobKind::Launcher
        } else if owner.is_none() && p.ppid == 1 && age_s.is_some_and(|a| a > SERVICE_S) && is_script(&p.args) {
            JobKind::Service
        } else if owner.is_none() && p.ppid == 1 && age_s.is_some_and(|a| a > LEFT_S) && cpu < 1.0 {
            JobKind::Left
        } else {
            JobKind::Job
        };
        out.push(Job {
            id: format!("job:{pid}"),
            pid,
            label: label(&p.args),
            kind,
            agent: owner,
            path_hint: path_in(&p.args, in_project),
            started_ms: age_s.map(|a| now_ms.saturating_sub(a * 1000)),
            cpu,
            procs: count,
            bay: base(p.args.split_whitespace().next().unwrap_or("")) == "testlock" || p.args.contains("/testlock "),
            room: String::new(),
            room_name: String::new(),
        });
    }
    out.sort_by(|a, b| a.started_ms.cmp(&b.started_ms).then(a.pid.cmp(&b.pid)));
    out
}

/// CPU and size of the tree under `pid`, and whether an agent runs inside it.
fn tree(pid: u32, procs: &HashMap<u32, Proc>, kids: &HashMap<u32, Vec<u32>>, agents: &HashSet<u32>) -> (f32, u32, bool) {
    let mut stack = vec![pid];
    let (mut cpu, mut count, mut starts) = (0.0, 0, false);
    let mut seen = HashSet::new();
    while let Some(p) = stack.pop() {
        if !seen.insert(p) || count > 2000 {
            continue;
        }
        if agents.contains(&p) {
            starts = true;
            continue; // the agent's own tree is the agent's
        }
        count += 1;
        cpu += procs.get(&p).map(|x| x.cpu).unwrap_or(0.0);
        stack.extend(kids.get(&p).into_iter().flatten());
    }
    (cpu, count, starts)
}

fn is_script(args: &str) -> bool {
    let first = base(args.split_whitespace().next().unwrap_or("")).to_ascii_lowercase();
    first.starts_with("python") || matches!(first.as_str(), "bash" | "sh" | "zsh" | "node" | "uv" | "deno" | "bun")
}

/// `testlock vk make …` is the `vk make` job in a bay. Everything else is named as a launcher is.
fn label(args: &str) -> String {
    let words: Vec<&str> = args.split_whitespace().collect();
    if let Some(at) = words.iter().position(|w| base(w) == "testlock") {
        let rest: Vec<&str> = words[at + 1..].iter().copied().filter(|w| !w.starts_with('-')).collect();
        if let Some(first) = rest.first() {
            let tool = base(first);
            if words[at + 1..].iter().any(|w| matches!(*w, "-e" | "--eval" | "-c")) {
                return format!("{tool} inline script");
            }
            let sub = rest.get(1).map(|s| base(s)).filter(|s| plain_word(s) || s.ends_with(".mjs") || s.ends_with(".py") || s.ends_with(".sh"));
            return sub.map(|s| format!("{tool} {s}")).unwrap_or_else(|| tool.to_string());
        }
    }
    let first = base(words.first().copied().unwrap_or(""));
    if TOOLS.contains(&first) {
        if let Some(sub) = words.iter().skip(1).find(|w| !w.starts_with('-')).map(|s| base(s)).filter(|s| plain_word(s)) {
            return format!("{first} {sub}");
        }
        return first.to_string();
    }
    launcher_label(args)
}

fn plain_word(s: &str) -> bool {
    !s.is_empty() && s.len() <= 24 && s.chars().all(|c| c.is_ascii_lowercase() || c == '-' || c == '_' || c == ':')
}

/// The first full path inside a project or the ops tree, which names the job's room.
fn path_in(args: &str, in_project: &dyn Fn(&Path) -> bool) -> Option<String> {
    const SYSTEM: &[&str] = &["/System/", "/usr/", "/bin/", "/sbin/", "/opt/", "/Applications/", "/Library/", "/private/var/", "/dev/"];
    args.split_whitespace()
        .map(|w| w.trim_matches(|c| c == '"' || c == '\'' || c == '(' || c == ')' || c == ','))
        .filter(|w| w.starts_with('/') && !SYSTEM.iter().any(|s| w.starts_with(s)))
        .find(|w| w.contains("/.appgeapanel/") || in_project(Path::new(w)))
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    #[test]
    fn labels_name_the_tool_and_never_the_arguments() {
        assert_eq!(super::label("/bin/bash /Users/a/.local/bin/testlock vk make . portrait"), "vk make");
        assert_eq!(super::label("/bin/bash /Users/a/.local/bin/testlock node tools/shots/clicks.mjs --runs 3"), "node clicks.mjs");
        assert_eq!(super::label("/opt/bin/flutter test test/a_test.dart"), "flutter test");
        assert_eq!(super::label("/x/ffmpeg -r 30 -i - out.mp4"), "ffmpeg");
    }
}
