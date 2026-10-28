//! The ops tree as one packet, for the Ops map screen.
//!
//! Everything here is a read of files the manager and the human write by hand: `now.md` for what
//! is open, `log/<year>.md` and the decisions index for what finished, `rollouts/` for the changes
//! that span many apps, `portfolio.yaml` for the apps themselves. Nothing is stored and nothing is
//! judged. Which line is stuck, which app is quiet, which date has passed: the screen decides that
//! from these facts, so the rule lives in one place.
//!
//! The one fact the files cannot give is how long a line has sat unchanged. Git can, so each
//! `now.md` line carries the time its text last changed, from `git blame`.

use crate::sprints::{portfolio, resolve_apps};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
pub struct OpsMap {
    /// Local `YYYY-MM-DD`, so the screen measures ages against the same day the files use.
    pub today: String,
    pub ops: String,
    pub apps: Vec<MapApp>,
    pub open: Vec<OpenItem>,
    pub rollouts: Vec<Rollout>,
    pub done: Vec<Done>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MapApp {
    pub key: String,
    pub name: String,
    pub kind: String,
    /// The Panel project that holds the app's folder, when one is registered.
    pub project: Option<String>,
    pub depends_on: Vec<String>,
    pub serves: Vec<String>,
}

/// One `now.md` bullet.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct OpenItem {
    /// blocked | flight | rollout | parked, or the heading itself for a section Panel does not
    /// know.
    pub section: String,
    /// The line's first column: app keys, a rollout id, or nothing for `-`.
    pub tags: Vec<String>,
    pub owner: String,
    pub text: String,
    /// 1-based line in `now.md`.
    pub line: usize,
    /// Unix seconds when this line's text last changed. 0 when git cannot say.
    pub edited: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Rollout {
    pub id: String,
    /// The file's first sentence of prose.
    pub summary: String,
    /// The `| app | needs |` table's first column.
    pub apps: Vec<String>,
    pub done_when: String,
    pub path: String,
}

/// A finished thing: a log line or a decision.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Done {
    pub date: String,
    /// log | decision
    pub kind: String,
    /// What the line names before its text: app keys, rollout ids, owners. Unresolved tags are
    /// the screen's to drop.
    pub tags: Vec<String>,
    pub text: String,
    pub path: String,
    pub line: usize,
}

pub fn read() -> Result<OpsMap, String> {
    let ops = crate::ops::ops_dir().ok_or("No ops tree. Set opsRoot in config.json.")?;
    let today = crate::sprints::today();
    let projects: HashMap<String, Option<String>> =
        resolve_apps(&ops).into_iter().map(|app| (app.key, app.project)).collect();
    let apps = portfolio(&ops)
        .into_iter()
        .map(|app| MapApp {
            project: projects.get(&app.key).cloned().flatten(),
            name: if app.name.is_empty() { app.key.clone() } else { app.name },
            key: app.key,
            kind: app.kind,
            depends_on: app.depends_on,
            serves: app.serves,
        })
        .collect();

    let now = fs::read_to_string(ops.join("now.md")).unwrap_or_default();
    let edited = blame_times(&ops, "now.md");
    let open = now_items(&now, &edited);

    let mut done = Vec::new();
    // The window can reach back across New Year, so last year's bin is read too.
    if let Ok(year) = today.get(..4).unwrap_or("").parse::<i32>() {
        for year in [year - 1, year] {
            let path = ops.join("log").join(format!("{year}.md"));
            if let Ok(text) = fs::read_to_string(&path) {
                done.extend(log_entries(&text, &path.to_string_lossy()));
            }
        }
    }
    let index = ops.join("decisions").join("index.md");
    if let Ok(text) = fs::read_to_string(&index) {
        done.extend(decision_entries(&text, &index.to_string_lossy()));
    }

    let mut rollouts = Vec::new();
    if let Ok(entries) = fs::read_dir(ops.join("rollouts")) {
        for path in entries.flatten().map(|entry| entry.path()) {
            let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            if path.extension().and_then(|e| e.to_str()) != Some("md") || stem.starts_with('_') {
                continue;
            }
            if let Ok(text) = fs::read_to_string(&path) {
                rollouts.push(rollout(&stem, &text, &path.to_string_lossy()));
            }
        }
    }
    rollouts.sort_by(|a, b| a.id.cmp(&b.id));

    Ok(OpsMap {
        today,
        ops: ops.to_string_lossy().into_owned(),
        apps,
        open,
        rollouts,
        done,
    })
}

/// Final line number → author time, from `git blame --line-porcelain`. A line not committed yet
/// carries the time of the blame itself, which is the honest answer: it changed just now.
///
/// Rewording a line is not progress. Commits listed in the tree's `.git-blame-ignore-revs`, git's
/// own convention for that, are skipped, so a line keeps the age of its last real change.
fn blame_times(repo: &Path, file: &str) -> HashMap<usize, i64> {
    let ignore = repo.join(".git-blame-ignore-revs");
    let ignore_path = ignore.to_string_lossy().into_owned();
    let mut args = vec!["blame", "--line-porcelain"];
    if ignore.is_file() {
        args.extend(["--ignore-revs-file", ignore_path.as_str()]);
    }
    args.extend(["--", file]);
    let Some(text) = crate::projects::git(repo, &args) else {
        return HashMap::new();
    };
    let mut out = HashMap::new();
    let mut line = 0usize;
    for row in text.lines() {
        let mut words = row.split(' ');
        let first = words.next().unwrap_or("");
        if first.len() == 40 && first.bytes().all(|b| b.is_ascii_hexdigit()) {
            line = words.nth(1).and_then(|n| n.parse().ok()).unwrap_or(0);
        } else if let Some(time) = row.strip_prefix("author-time ") {
            if let Ok(time) = time.trim().parse() {
                out.insert(line, time);
            }
        }
    }
    out
}

fn section_of(heading: &str) -> String {
    match heading.trim().to_lowercase().as_str() {
        "blocked on you" => "blocked".into(),
        "in flight" => "flight".into(),
        "rollouts" => "rollout".into(),
        "parked" => "parked".into(),
        other => other.to_string(),
    }
}

/// `now.md` bullets. `- <apps|-> | <owner> | <what>`, or `- <rollout> | <what>` under Rollouts.
fn now_items(text: &str, edited: &HashMap<usize, i64>) -> Vec<OpenItem> {
    let mut section = String::new();
    let mut out = Vec::new();
    for (at, row) in text.lines().enumerate() {
        if let Some(heading) = row.strip_prefix("## ") {
            section = section_of(heading);
            continue;
        }
        let Some(entry) = row.strip_prefix("- ") else {
            continue;
        };
        if section.is_empty() {
            continue;
        }
        let fields: Vec<&str> = entry.split(" | ").map(str::trim).collect();
        let (tags, owner, text) = match fields.as_slice() {
            [only] => ("", "", only.to_string()),
            [tag, what] => (*tag, "", what.to_string()),
            [tag, owner, rest @ ..] => (*tag, *owner, rest.join(" | ")),
            [] => continue,
        };
        out.push(OpenItem {
            section: section.clone(),
            tags: split_tags(tags),
            owner: owner.to_string(),
            text,
            line: at + 1,
            edited: edited.get(&(at + 1)).copied().unwrap_or(0),
        });
    }
    out
}

/// `tavla, pisti` → both; `-` → none. ` and ` splits too, as the log writes it in prose.
fn split_tags(field: &str) -> Vec<String> {
    field
        .split(',')
        .flat_map(|part| part.split(" and "))
        .map(|tag| tag.trim().trim_matches('`').to_string())
        .filter(|tag| !tag.is_empty() && tag != "-")
        .collect()
}

fn leading_date(text: &str) -> Option<&str> {
    let date = text.get(..10)?;
    let bytes = date.as_bytes();
    let shaped = bytes.iter().enumerate().all(|(i, b)| if i == 4 || i == 7 { *b == b'-' } else { b.is_ascii_digit() });
    shaped.then_some(date)
}

/// The log's lines. It has been written in three shapes over the year, and all three stay:
///
///   `2026-09-07 | you | tavla_skor | P2 | text`        the pipe ledger
///   `- 2026-10-19 — keymaster, clearday: text`         the current shape
///   `### cardly` then `- 2026-08-01 — text`            relocated per-app logs
///
/// An indented line under an entry continues it.
fn log_entries(text: &str, path: &str) -> Vec<Done> {
    let mut out: Vec<Done> = Vec::new();
    let mut context: Option<String> = None;
    let mut open = false;
    for (at, row) in text.lines().enumerate() {
        if let Some(heading) = row.strip_prefix("### ") {
            context = Some(heading.trim().to_string());
            open = false;
            continue;
        }
        if row.starts_with("## ") || row.starts_with("# ") {
            context = None;
            open = false;
            continue;
        }
        let trimmed = row.trim();
        if trimmed.is_empty() {
            // A relocated block ends at its blank line. The bin goes on below it at top level.
            context = None;
            open = false;
            continue;
        }
        let body = trimmed.strip_prefix("- ").unwrap_or(trimmed);
        let Some(date) = leading_date(body) else {
            if open && row.starts_with(' ') {
                if let Some(last) = out.last_mut() {
                    last.text.push(' ');
                    last.text.push_str(trimmed);
                }
            }
            continue;
        };
        let rest = body[10..].trim_start();
        let (mut tags, text) = if let Some(rest) = rest.strip_prefix('|') {
            let fields: Vec<&str> = rest.split(" | ").map(str::trim).collect();
            let (text, head) = fields.split_last().map(|(t, h)| (*t, h)).unwrap_or(("", &[]));
            (head.iter().flat_map(|field| split_tags(field)).collect(), text.to_string())
        } else {
            let rest = rest.trim_start_matches(['—', '–', '-', ':']).trim_start();
            match rest.split_once(": ") {
                // A short head with no sentence in it names what the line is about.
                Some((head, text)) if head.chars().count() <= 48 && !head.contains(". ") => {
                    (split_tags(head), text.to_string())
                }
                _ => (Vec::new(), rest.to_string()),
            }
        };
        if let (Some(app), true) = (&context, tags.is_empty()) {
            tags.push(app.clone());
        }
        out.push(Done {
            date: date.to_string(),
            kind: "log".into(),
            tags,
            text: text.trim().to_string(),
            path: path.to_string(),
            line: at + 1,
        });
        open = true;
    }
    out
}

/// `- D-0042 | 2026-10-22 | active | title | ref | file`.
fn decision_entries(text: &str, path: &str) -> Vec<Done> {
    text.lines()
        .enumerate()
        .filter_map(|(at, row)| {
            let entry = row.strip_prefix("- ")?;
            let fields: Vec<&str> = entry.split(" | ").map(str::trim).collect();
            let [id, date, _status, title, reference, ..] = fields.as_slice() else {
                return None;
            };
            leading_date(date)?;
            Some(Done {
                date: date.to_string(),
                kind: "decision".into(),
                tags: split_tags(reference),
                text: format!("{id} · {title}"),
                path: path.to_string(),
                line: at + 1,
            })
        })
        .collect()
}

fn rollout(id: &str, text: &str, path: &str) -> Rollout {
    let mut summary = String::new();
    let mut done_when = String::new();
    let mut apps = Vec::new();
    let mut in_table = false;
    for row in text.lines() {
        let trimmed = row.trim();
        if let Some(rest) = trimmed.strip_prefix("**Done when:**") {
            done_when = rest.trim().to_string();
            continue;
        }
        if trimmed.starts_with('|') {
            let first = trimmed.trim_matches('|').split('|').next().unwrap_or("").trim();
            if first.eq_ignore_ascii_case("app") {
                in_table = true;
            } else if in_table && !first.is_empty() && !first.starts_with('-') {
                apps.push(first.trim_matches('`').to_string());
            }
            continue;
        }
        in_table = false;
        if summary.is_empty() && !trimmed.is_empty() && !trimmed.starts_with('#') {
            summary = trimmed.to_string();
        }
    }
    Rollout {
        id: id.to_string(),
        summary,
        apps,
        done_when,
        path: path.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn now_lines_keep_their_section_tags_and_age() {
        let text = "# Now\n\n## Blocked on you\n\n- - | you | Renew the certificate.\n- tavla, pisti | you | A | B\n\n## Rollouts\n- billing-8 | Play Billing 8.\n";
        let edited = HashMap::from([(5, 100)]);
        let items = now_items(text, &edited);
        assert_eq!(items.len(), 3);
        assert_eq!((items[0].section.as_str(), items[0].tags.len(), items[0].edited), ("blocked", 0, 100));
        assert_eq!(items[1].tags, vec!["tavla", "pisti"]);
        assert_eq!(items[1].text, "A | B", "a pipe inside the text stays text");
        assert_eq!((items[2].section.as_str(), items[2].tags[0].as_str(), items[2].owner.as_str()), ("rollout", "billing-8", ""));
    }

    #[test]
    fn every_log_shape_is_read() {
        let text = "# Log\n\n2026-09-07 | you | tavla_skor | P2 | Reel shared.\n\n- 2026-10-19 — keymaster, clearday: iOS on sale.\n- 2026-10-14 — gunun_hadisi: 1.1.0 on sale. Store text: four languages.\n- 2026-10-12 — Key art built for all apps.\n\n## Relocated\n### cardly\n- 2026-08-01 — submitted to both stores.\n  Waiting on reviewers.\n\n- 2026-09-21 — streams closed.\n";
        let done = log_entries(text, "log.md");
        assert_eq!(done.len(), 6);
        assert_eq!(done[0].tags, vec!["you", "tavla_skor", "P2"]);
        assert_eq!(done[0].text, "Reel shared.");
        assert_eq!(done[1].tags, vec!["keymaster", "clearday"]);
        assert_eq!(done[2].tags, vec!["gunun_hadisi"]);
        assert!(done[3].tags.is_empty(), "a sentence is not a head");
        assert_eq!((done[4].tags[0].as_str(), done[4].text.as_str()), ("cardly", "submitted to both stores. Waiting on reviewers."));
        assert_eq!(done[4].line, 11);
        assert!(done[5].tags.is_empty(), "the blank line ended the cardly block");
    }

    #[test]
    fn rollout_apps_come_from_its_table() {
        let text = "# billing-8\n\nPlay needs BL 8 from **31 Aug 2026**.\n\n**Done when:** live in production.\n\n| app | needs |\n|---|---|\n| pisti | 10.7.0 |\n| `sagar` | |\n\nAfter.\n";
        let found = rollout("billing-8", text, "r.md");
        assert_eq!(found.apps, vec!["pisti", "sagar"]);
        assert_eq!(found.summary, "Play needs BL 8 from **31 Aug 2026**.");
        assert_eq!(found.done_when, "live in production.");
    }
}
