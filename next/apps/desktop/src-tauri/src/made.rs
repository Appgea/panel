//! What agents make: new pictures, sounds and videos in a project where a session is open.
//!
//! Agents hand back renders, screenshots and audio as files: a `.shots` folder, a TTS take, an
//! export. Unless the agent also sent a report, nothing told you, and reviewing meant Finder. So
//! while a project has a session, its folder is watched (FSEvents, recursive, cheap) and every
//! finished media file is announced to the UI's Review inbox.
//!
//! "Finished" is a quiet period: a render or a recording is written in many chunks, and showing
//! it half-written would play a cut-off sound. Build output is skipped; a Flutter or Xcode build
//! writes hundreds of icons nobody asked to review.

use notify::event::ModifyKind;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

pub const MADE_EVENT: &str = "panel-made";

/// How long a file must stay unchanged before it counts as made.
const SETTLE: Duration = Duration::from_millis(1200);

/// Folders that only ever hold generated build output, caches, dependencies or test baselines.
/// `goldens` and `failures` are Flutter golden tests: one run writes dozens of them.
const SKIP: &[&str] = &[
    ".git", "node_modules", "build", "target", "dist", ".dart_tool", "Pods", "DerivedData",
    ".gradle", ".build", ".next", ".venv", "venv", "__pycache__", ".idea", ".symlinks",
    "xcuserdata", ".cache", "goldens", "failures",
];

#[derive(Clone, Serialize)]
pub struct Made {
    pub project: String,
    /// Absolute. The asset protocol and Reveal both take it as is.
    pub path: String,
    pub kind: &'static str,
    pub size: u64,
    /// Milliseconds since the epoch.
    pub modified: u64,
}

pub fn media_kind(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "avif" | "heic" => "image",
        "mp3" | "wav" | "m4a" | "aac" | "ogg" | "oga" | "flac" | "aiff" | "aif" => "audio",
        "mp4" | "m4v" | "mov" | "webm" => "video",
        _ => return None,
    })
}

/// Inside a build or dependency folder, a temp file mid-write, or a tool's private state.
///
/// A hidden folder at the top of a project is a place someone means to look: `.shots`, an art
/// export. One deeper down belongs to a tool: a backup before a fix, a cache, a copy per platform.
/// A video pipeline writes those by the hundred next to the work itself.
pub fn skipped(root: &Path, path: &Path) -> bool {
    let Ok(inside) = path.strip_prefix(root) else {
        return true;
    };
    let name = path.file_name().and_then(|name| name.to_str()).unwrap_or_default();
    if name.starts_with("._") || name.ends_with(".tmp") || name.ends_with(".part") {
        return true;
    }
    inside.parent().into_iter().flat_map(Path::components).enumerate().any(|(depth, part)| {
        let part = part.as_os_str();
        SKIP.iter().any(|skip| part == *skip) || (depth > 0 && part.to_string_lossy().starts_with('.'))
    })
}

#[derive(Default)]
pub struct MadeWatch {
    watchers: Mutex<HashMap<String, RecommendedWatcher>>,
}

impl MadeWatch {
    /// Start watching a project's folder. A second call for the same project does nothing.
    pub fn watch(&self, app: &AppHandle, project: &str, root: &Path) {
        let mut watchers = self.watchers.lock().unwrap();
        if watchers.contains_key(project) {
            return;
        }
        let (tx, rx) = mpsc::channel();
        let Ok(mut watcher) = notify::recommended_watcher(tx) else {
            return;
        };
        if watcher.watch(root, RecursiveMode::Recursive).is_err() {
            return;
        }
        watchers.insert(project.to_string(), watcher);
        let app = app.clone();
        let project = project.to_string();
        let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        // The thread ends on its own when the watcher is dropped and the channel closes.
        std::thread::spawn(move || {
            let mut pending: HashMap<PathBuf, Instant> = HashMap::new();
            loop {
                match rx.recv_timeout(Duration::from_millis(300)) {
                    Ok(Ok(event)) => {
                        // Metadata is Finder, Quick Look, Spotlight or a chmod touching a file
                        // that is already there: nobody made anything. The UI still drops a
                        // version it has seen, because macOS repeats "created" on those touches.
                        if matches!(
                            event.kind,
                            EventKind::Access(_) | EventKind::Remove(_) | EventKind::Modify(ModifyKind::Metadata(_))
                        ) {
                            continue;
                        }
                        for path in event.paths {
                            if media_kind(&path).is_some() && !skipped(&root, &path) {
                                pending.insert(path, Instant::now());
                            }
                        }
                    }
                    Ok(Err(_)) => {}
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => return,
                }
                let settled: Vec<PathBuf> = pending
                    .iter()
                    .filter(|(_, at)| at.elapsed() >= SETTLE)
                    .map(|(path, _)| path.clone())
                    .collect();
                for path in settled {
                    pending.remove(&path);
                    if let Some(made) = describe(&project, &path) {
                        let _ = app.emit(MADE_EVENT, made);
                    }
                }
            }
        });
    }

    pub fn unwatch(&self, project: &str) {
        self.watchers.lock().unwrap().remove(project);
    }
}

pub fn describe(project: &str, path: &Path) -> Option<Made> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() == 0 {
        return None;
    }
    let modified = metadata
        .modified()
        .ok()
        .and_then(|at| at.duration_since(UNIX_EPOCH).ok())
        .map(|at| at.as_millis() as u64)
        .unwrap_or_default();
    Some(Made {
        project: project.to_string(),
        path: path.to_string_lossy().into_owned(),
        kind: media_kind(path)?,
        size: metadata.len(),
        modified,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_and_sounds_count_but_build_output_does_not() {
        let root = Path::new("/p/app");
        assert_eq!(media_kind(Path::new("/p/app/.shots/home.PNG")), Some("image"));
        assert_eq!(media_kind(Path::new("/p/app/voice/take.m4a")), Some("audio"));
        assert_eq!(media_kind(Path::new("/p/app/lib/main.dart")), None);
        assert!(!skipped(root, Path::new("/p/app/.shots/home.png")));
        assert!(!skipped(root, Path::new("/p/app/docs/build-notes/flow.png")));
        assert!(skipped(root, Path::new("/p/app/build/ios/icon.png")));
        assert!(!skipped(root, Path::new("/p/app/ios/Runner/Assets.xcassets/AppIcon.appiconset/a.png")));
        assert!(skipped(root, Path::new("/p/app/node_modules/x/logo.png")));
        assert!(skipped(root, Path::new("/p/app/test/features/today/goldens/today.png")));
        assert!(skipped(root, Path::new("/p/app/test/features/today/failures/today_isolatedDiff.png")));
        assert!(!skipped(root, Path::new("/p/app/screenshots/e2e_01_welcome.png")));
        assert!(skipped(root, Path::new("/p/app/.shots/home.png.tmp")));
        assert!(skipped(root, Path::new("/elsewhere/a.png")));
    }

    #[test]
    fn a_hidden_folder_counts_only_at_the_top() {
        let root = Path::new("/p/show");
        assert!(!skipped(root, Path::new("/p/show/.art-out/card.png")));
        assert!(skipped(root, Path::new("/p/show/ep/1/segments/.pre_qc/s01.mp4")));
        assert!(skipped(root, Path::new("/p/show/ep/.editions/ep_yt/segments/s01.mp4")));
        assert!(!skipped(root, Path::new("/p/show/ep/1/.cover.jpg")));
    }

    #[test]
    fn a_finished_file_is_announced_once_it_settles() {
        let dir = std::env::temp_dir().join(format!("made-{}", std::process::id()));
        std::fs::create_dir_all(dir.join(".shots")).unwrap();
        let file = dir.join(".shots/one.png");
        std::fs::write(&file, b"png").unwrap();
        let made = describe("app", &file).unwrap();
        assert_eq!((made.kind, made.size), ("image", 3));
        std::fs::write(&file, b"").unwrap();
        assert!(describe("app", &file).is_none(), "an empty file is not made yet");
        let _ = std::fs::remove_dir_all(dir);
    }
}
