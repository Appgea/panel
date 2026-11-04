//! What the sidebar knows about a project beyond its terminals and its git status: where the app
//! stands in the company's portfolio, and how much it has moved lately.
//!
//! Both are cheap reads that the rail asks for once per project and caches. Neither is a source of
//! truth of its own. `portfolio.yaml` stays the CPO's file, and history stays git's.

use crate::sprints::PortfolioApp;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Days of history the rail draws. Two weeks tells "moving" from "quiet" without a calendar.
pub const DAYS: usize = 14;

/// One project's row in its company's portfolio.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Standing {
    pub project: String,
    pub key: String,
    /// idea | building | review | releasing | live | paused | archived | unknown, as written.
    pub status: String,
    pub notes: String,
}

/// Commits that touched the project's folder.
#[derive(Debug, Clone, Serialize, Default, PartialEq)]
pub struct Activity {
    /// Unix seconds of the newest commit, 0 when there is none.
    pub last_commit: i64,
    /// Commits per day, oldest first, today last.
    pub days: Vec<u32>,
}

/// Every project that has a portfolio row. A project with none is simply absent.
pub fn standings() -> Vec<Standing> {
    let projects = crate::projects::load();
    let mut cache: HashMap<PathBuf, Vec<PortfolioApp>> = HashMap::new();
    projects
        .iter()
        .filter_map(|project| {
            // A group whose opsRoot points nowhere still has the global tree to answer from.
            let ops = crate::ops::ops_dir_for(Some(project)).or_else(crate::ops::ops_dir)?;
            let apps = cache
                .entry(ops.clone())
                .or_insert_with(|| crate::sprints::portfolio(&ops));
            let root = ops.parent().unwrap_or(&ops).to_path_buf();
            let app = owning_app(&project.path, &root, apps)?;
            Some(Standing {
                project: project.id.clone(),
                key: app.key.clone(),
                status: app.status.clone(),
                notes: app.notes.clone(),
            })
        })
        .collect()
}

/// The app whose folder holds this path. The nearest folder wins, so `KeyMaster/android` is
/// KeyMaster's unless the portfolio gives the Android folder a row of its own.
///
/// `dir` is relative to the company root. The suffix match covers an ops tree that lives
/// somewhere else, the same fallback the sprint board uses.
pub(crate) fn owning_app<'a>(path: &Path, root: &Path, apps: &'a [PortfolioApp]) -> Option<&'a PortfolioApp> {
    path.ancestors().find_map(|folder| {
        apps.iter().find(|app| {
            !app.dir.is_empty() && (folder == root.join(&app.dir) || folder.ends_with(&app.dir))
        })
    })
}

/// Commit history for one folder. Scoped with `-- .`, so a project that is a subfolder of a
/// bigger repository counts only its own commits.
pub fn activity(path: &Path) -> Activity {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let last_commit = crate::projects::git(path, &["log", "-1", "--format=%ct", "--", "."])
        .and_then(|text| text.trim().parse::<i64>().ok())
        .unwrap_or(0);
    let since = format!("--since={DAYS}.days.ago");
    let stamps: Vec<i64> = crate::projects::git(path, &["log", &since, "--format=%ct", "--", "."])
        .map(|text| text.lines().filter_map(|line| line.trim().parse().ok()).collect())
        .unwrap_or_default();
    Activity {
        last_commit,
        days: bucket(&stamps, now),
    }
}

/// Commit stamps into per-day counts, oldest first. Days are 24-hour steps back from now.
fn bucket(stamps: &[i64], now: i64) -> Vec<u32> {
    let mut days = vec![0; DAYS];
    for stamp in stamps {
        let age = (now - stamp).div_euclid(86_400);
        if (0..DAYS as i64).contains(&age) {
            days[DAYS - 1 - age as usize] += 1;
        }
    }
    days
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(key: &str, dir: &str) -> PortfolioApp {
        PortfolioApp {
            key: key.into(),
            dir: dir.into(),
            ..PortfolioApp::default()
        }
    }

    #[test]
    fn nearest_folder_owns_the_project() {
        let apps = [app("keymaster", "KeyMaster"), app("km_android", "KeyMaster/android")];
        let root = Path::new("/co");
        let found = |path: &str| owning_app(Path::new(path), root, &apps).map(|a| a.key.as_str());
        assert_eq!(found("/co/KeyMaster/android"), Some("km_android"));
        assert_eq!(found("/co/KeyMaster/ios"), Some("keymaster"));
        // The ops tree lives elsewhere: the folder name still finds it.
        assert_eq!(found("/elsewhere/KeyMaster"), Some("keymaster"));
        assert_eq!(found("/co/Other"), None);
    }

    #[test]
    fn commits_land_on_their_day() {
        let now = 100 * 86_400;
        let days = bucket(&[now - 10, now - 86_400 - 10, now - 13 * 86_400, now - 14 * 86_400], now);
        assert_eq!(days.len(), DAYS);
        assert_eq!(days[DAYS - 1], 1);
        assert_eq!(days[DAYS - 2], 1);
        assert_eq!(days[0], 1);
        assert_eq!(days.iter().sum::<u32>(), 3);
    }
}
