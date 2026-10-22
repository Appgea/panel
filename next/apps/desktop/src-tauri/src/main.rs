#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Desktop composition.
//!
//! Panel does not drive agents. It hosts them in a real terminal and watches. Everything
//! the UI knows arrives as a `PanelEvent` from one place — the ingress — whether it came
//! from a session hook, an MCP panel call, or the offline replay fixture. Keeping that
//! single seam is what lets the views be built and trusted independently of any provider.

mod android;
mod code_nav;
mod debug;
mod launch;
mod leases;
mod made;
mod modules;
mod notebook;
mod ops;
mod paths;
mod platform;
mod projects;
mod project_desk;
mod pulse;
mod reports;
mod sim;
mod skills;
mod skill_sessions;
mod sprints;
mod targets;

use panel_core::PanelEvent;
use panel_ingress::{ChangeStep, EventSink, Ingress, ProjectEvent};
use panel_terminal::{SpawnSpec, TerminalChunk, TerminalManager, TerminalSink};
use projects::{GitOverview, GitState, Project, ProjectRole, WorkFile};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;

const AGENT_EVENT: &str = "panel-agent-event";
const TERMINAL_EVENT: &str = "panel-terminal-output";
const RUN_OUTPUT_EVENT: &str = "panel-run-output";
const SHUTDOWN_EVENT: &str = "panel-shutdown-requested";
const PORTFOLIO_EVENT: &str = "panel-portfolio-changed";
/// A sprint file changed under the ops tree — by an agent, by you in another editor, or by the
/// screen itself. The plan is agent-written by design, so the screen must never be the last to
/// know what the plan says.
const SPRINTS_EVENT: &str = "panel-sprints-changed";

/// One live terminal on a project — any coding agent (`claude`, `codex`, `grok`, `kimi`, `glm`,
/// `opencode`, ...), or a plain shell.
///
/// A project used to be allowed exactly ONE of these, and it was always a `claude`: the UI had
/// no way to ask for a shell, so the box at the bottom of the window could never be used as a
/// terminal. You cannot run a build next to the agent that is writing the code, and when the
/// agent exits the box goes dead with nothing to type into.
///
/// So sessions are keyed by their OWN id, not by project. A project has as many as you open, of
/// whatever kind, and they all stay alive while you look at something else.
#[derive(Clone, serde::Serialize)]
struct Session {
    id: String,
    project: String,
    /// "claude" or "shell". The UI colours and labels from this; Rust only branches on it once.
    kind: String,
    title: String,
    terminal_id: String,
    /// Where the PTY was forked. Not where it is standing now — a `cd` inside is invisible to us
    /// (session_cwd asks the OS for that). This is what a restore forks in again.
    cwd: PathBuf,
    /// The agent instance the ingress routes hook events by. Empty for a shell — a shell has
    /// nothing to say to the panel.
    #[serde(skip)]
    instance: String,
}

struct DesktopState {
    terminals: Mutex<TerminalManager>,
    debugger: Arc<debug::DebugManager>,
    ingress: Ingress,
    /// session id -> the session. Several sessions run at once, across several projects; this
    /// is the whole point of a portfolio panel, so nothing is ever torn down just to look
    /// elsewhere. Keyed by session, NOT by project — one project holds many.
    sessions: Mutex<HashMap<String, Session>>,
    /// Live simulator runs, session id -> what device it holds and when it was last active. An Arc
    /// so the PTY reader thread (which stamps activity on reload and cleans up on exit) shares it
    /// with the command layer (which reads it to enforce the booted-sim cap).
    sims: Arc<Mutex<HashMap<String, sim::SimMeta>>>,
    /// The old Panel checkout — it owns config.json and the hook + MCP shims.
    panel_home: PathBuf,
    /// Closing the window and quitting the app converge on one confirmation. Pending prevents a
    /// close request plus an exit request from opening two prompts; approved lets the deliberate
    /// post-cleanup `app.exit()` pass through the same lifecycle guard.
    shutdown_prompt_pending: AtomicBool,
    shutdown_approved: AtomicBool,
    /// Projects with a session open, watched for the media their agents make.
    made: made::MadeWatch,
}

/// The manager's identity.
///
/// It is deliberately NOT a project: it never appears in the portfolio, has no dashboard, no
/// modules and no git surface. The id exists for one reason — a terminal and its reports are
/// addressed by project everywhere in Panel, and inventing a second addressing scheme for one
/// session would cost more than borrowing this one.
///
/// The companion used to be a constrained Codex subprocess with a hard-coded prompt and a JSON
/// output schema. It is now an ordinary agent session in an ordinary PTY, rooted at the ops tree,
/// running whichever CLI you picked. Everything it knows is a file in that folder, and the prompt
/// that shapes it is `AGENTS.md` sitting next to them — editable, and resettable.
const CPO_ID: &str = "appgea";

/// Where the manager runs: the ops tree, the only folder it may write.
fn cpo_root() -> Result<Project, String> {
    let path = ops::ops_dir().ok_or("no ops tree — set opsRoot in config.json")?;
    Ok(Project {
        id: CPO_ID.to_string(),
        name: "appgea".to_string(),
        exists: path.is_dir(),
        path,
        group: String::new(),
        role: ProjectRole::Leaf,
        project_type: "generic".into(),
        parent_id: String::new(),
        extension_id: String::new(),
    })
}

/// The live preprompt, and the shipped one it resets to.
///
/// Both are plain Markdown on disk. `AGENTS.md` is what every CLI reads, Claude included since 2.1.277; a `CLAUDE.md`
/// symlink beside it keeps older Claude builds working, so editing the preprompt is editing the file
/// the agent was already going to read. No second copy, no template rendering, no restart.
fn preprompt_paths() -> Result<(PathBuf, PathBuf), String> {
    let live = ops::ops_dir().ok_or("no ops tree — set opsRoot in config.json")?;
    let default = crate::paths::resources_root().join("ops-template/ops/AGENTS.md");
    Ok((live.join("AGENTS.md"), default))
}

/// The manager as the UI tracks it: one more project state, so its terminal gets the same
/// status, attention, wall seat and restore as every worker. Kept out of `list_projects` because
/// it is not in the portfolio and must not grow a sidebar row, a Home card or a git surface.
#[tauri::command]
fn manager_project() -> Result<Project, String> {
    cpo_root()
}

#[tauri::command]
fn cpo_preprompt() -> Result<String, String> {
    let (live, default) = preprompt_paths()?;
    // A missing live file is the first run, not an error: fall through to the shipped text so the
    // editor opens on something real rather than on emptiness.
    std::fs::read_to_string(&live)
        .or_else(|_| std::fs::read_to_string(&default))
        .map_err(|error| format!("could not read the preprompt: {error}"))
}

#[tauri::command]
fn set_cpo_preprompt(text: String) -> Result<(), String> {
    let (live, _) = preprompt_paths()?;
    std::fs::write(&live, text).map_err(|error| format!("could not save the preprompt: {error}"))
}

/// Restore the shipped preprompt and hand it back, so the editor shows what it reverted to.
#[tauri::command]
fn reset_cpo_preprompt() -> Result<String, String> {
    let (live, default) = preprompt_paths()?;
    let text = std::fs::read_to_string(&default)
        .map_err(|error| format!("no shipped preprompt to reset to: {error}"))?;
    std::fs::write(&live, &text)
        .map_err(|error| format!("could not restore the preprompt: {error}"))?;
    Ok(text)
}

/* ---------------------------------------------------------------- sprints
 * The two-week plan. Files under the ops tree; see sprints.rs. Every call reads the file fresh,
 * because the manager and the human both write it from outside Panel.
 */

#[tauri::command]
async fn sprint_board() -> Result<sprints::Board, String> {
    off_main(sprints::board).await
}

#[tauri::command]
async fn sprint_set_goal(
    sprint: String,
    index: usize,
    text: String,
    state: String,
) -> Result<(), String> {
    off_main(move || sprints::set_goal(&sprint, index, &text, &state)).await
}

#[tauri::command]
async fn sprint_add_goal(
    sprint: String,
    app: String,
    owner: String,
    text: String,
    done_when: String,
) -> Result<(), String> {
    off_main(move || sprints::add_goal(&sprint, &app, &owner, &text, &done_when)).await
}

#[tauri::command]
async fn sprint_log(sprint: String, text: String) -> Result<(), String> {
    off_main(move || sprints::log(&sprint, &text)).await
}

#[tauri::command]
async fn sprint_read(sprint: String) -> Result<String, String> {
    off_main(move || sprints::read_raw(&sprint)).await
}

#[tauri::command]
async fn sprint_write(sprint: String, text: String, expect: String) -> Result<(), String> {
    off_main(move || sprints::write_raw(&sprint, &text, &expect)).await
}

#[tauri::command]
async fn sprint_create(
    id: String,
    title: String,
    starts: String,
    ends: String,
    focus: Vec<String>,
) -> Result<sprints::Sprint, String> {
    off_main(move || sprints::create(&id, &title, &starts, &ends, &focus)).await
}

fn decode_url_path(path: &str) -> Option<String> {
    let bytes = path.trim_start_matches('/').as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = bytes.get(index + 1..index + 3)?;
            let text = std::str::from_utf8(hex).ok()?;
            decoded.push(u8::from_str_radix(text, 16).ok()?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

/// Where an agent's screenshot actually is.
///
/// Agents do not think in project-relative paths. A report carries `/var/folders/…/shot.png` from
/// a simulator grab, or `build/screenshots/1.png` relative to the subdirectory it was working in,
/// or `~/Desktop/shot.png`. The old rule accepted exactly one shape — project root + relative path
/// — so most of what agents actually send rendered as a broken image.
///
/// So try the bases that are actually in play, and accept a hit only if it lands somewhere Panel
/// is already allowed to show you: any registered project, Panel's own home, or the temp dir
/// every screenshot pipeline writes into. Everything else is still a 403.
fn resolve_asset(
    home: &Path,
    project: &Project,
    projects: &[Project],
    path: &str,
) -> Option<PathBuf> {
    let raw = path.trim();
    if raw.is_empty() {
        return None;
    }
    let asked = match raw.strip_prefix("~/") {
        Some(rest) => PathBuf::from(std::env::var_os("HOME")?).join(rest),
        None => PathBuf::from(raw),
    };

    // macOS gives TMPDIR as /var/folders/… and symlinks /tmp to /private/tmp, so both sides are
    // canonicalized — a real file must not be rejected for spelling its own path differently.
    let mut allowed: Vec<PathBuf> = projects.iter().map(|entry| entry.path.clone()).collect();
    allowed.push(home.to_path_buf());
    allowed.push(std::env::temp_dir());
    allowed.push(PathBuf::from("/tmp"));
    // macOS drops screenshots on the Desktop, and agents park working images all over the home
    // directory. Rendering one of those is not a leak — the agent that named the path can already
    // read it, and the picture only ever goes to the human's own window. /etc and every other
    // user stay out, which is what the confinement is actually for.
    if let Some(user_home) = std::env::var_os("HOME") {
        allowed.push(PathBuf::from(user_home));
    }
    let allowed: Vec<PathBuf> = allowed
        .iter()
        .filter_map(|root| root.canonicalize().ok())
        .collect();

    let mut candidates: Vec<PathBuf> = Vec::new();
    if asked.is_absolute() {
        candidates.push(asked.clone());
    } else {
        // The project that posted comes first; a portfolio of sibling repos means "build/x.png"
        // is ambiguous only in theory — in practice the poster's own root is the one that has it.
        candidates.push(project.path.join(&asked));
        for entry in projects {
            if entry.id != project.id {
                candidates.push(entry.path.join(&asked));
            }
        }
        // "tavla/build/shot.png" written from the portfolio root while the post belongs to Tavla.
        if let Some(parent) = project.path.parent() {
            candidates.push(parent.join(&asked));
        }
        candidates.push(home.join(&asked));
        candidates.push(std::env::temp_dir().join(&asked));
    }

    candidates.into_iter().find_map(|candidate| {
        let file = candidate.canonicalize().ok()?;
        if !file.is_file() {
            return None;
        }
        allowed
            .iter()
            .any(|root| file.starts_with(root))
            .then_some(file)
    })
}

type ProtocolRequest = tauri::http::Request<Vec<u8>>;
type ProtocolResponse = tauri::http::Response<Vec<u8>>;

/// `project-icon://panel/<id>`: the app's own artwork, found inside its folder.
fn project_icon_response(request: &ProtocolRequest) -> ProtocolResponse {
    let id = decode_url_path(request.uri().path()).unwrap_or_default();
    // Resolve on every request. App icon generators may replace the source path, and a
    // running Panel must follow the project rather than retain its startup choice.
    let project = all_projects().into_iter().find(|project| project.id == id);
    let icon = project.as_ref().and_then(projects::cached_app_icon);

    let Some(path) = icon else {
        return tauri::http::Response::builder()
            .status(404)
            .body(Vec::new())
            .expect("empty icon response");
    };
    let Ok(metadata) = path.metadata() else {
        return tauri::http::Response::builder()
            .status(404)
            .body(Vec::new())
            .expect("unreadable icon response");
    };
    let etag = file_etag(&metadata);
    if request
        .headers()
        .get("if-none-match")
        .and_then(|value| value.to_str().ok())
        == Some(etag.as_str())
    {
        return tauri::http::Response::builder()
            .status(304)
            .header("ETag", etag)
            .body(Vec::new())
            .expect("unchanged icon response");
    }
    let Ok(body) = std::fs::read(&path) else {
        return tauri::http::Response::builder()
            .status(404)
            .body(Vec::new())
            .expect("unreadable icon response");
    };
    tauri::http::Response::builder()
        .status(200)
        .header("Content-Type", image_content_type(&path))
        .header("Content-Length", body.len())
        .header("Cache-Control", "no-cache")
        .header("ETag", etag)
        .body(body)
        .expect("project icon response")
}

/// `project-asset://panel/<id>/<path>`: read-only project media, range requests included.
fn project_asset_response(panel_home: &Path, request: &ProtocolRequest) -> ProtocolResponse {
    let decoded = decode_url_path(request.uri().path()).unwrap_or_default();
    let relative = decoded.trim_start_matches('/');
    let Some((id, path)) = relative.split_once('/') else {
        return tauri::http::Response::builder()
            .status(400)
            .body(Vec::new())
            .expect("bad project asset response");
    };
    let projects = all_projects();
    let Some(project) = projects.iter().find(|project| project.id == id) else {
        return tauri::http::Response::builder()
            .status(404)
            .body(Vec::new())
            .expect("unknown project asset response");
    };
    let Some(file) = resolve_asset(panel_home, project, &projects, path) else {
        return tauri::http::Response::builder()
            .status(403)
            .body(Vec::new())
            .expect("confined project asset response");
    };
    let Ok(metadata) = file.metadata() else {
        return tauri::http::Response::builder()
            .status(404)
            .body(Vec::new())
            .expect("missing project asset response");
    };
    let etag = file_etag(&metadata);
    if request
        .headers()
        .get("if-none-match")
        .and_then(|value| value.to_str().ok())
        == Some(etag.as_str())
    {
        return tauri::http::Response::builder()
            .status(304)
            .header("ETag", etag)
            .body(Vec::new())
            .expect("unchanged project asset response");
    }
    let total = metadata.len();
    let range_header = request
        .headers()
        .get("range")
        .and_then(|value| value.to_str().ok());
    let if_range_matches = request
        .headers()
        .get("if-range")
        .and_then(|value| value.to_str().ok())
        .is_none_or(|value| value == etag);
    let range = byte_range(if if_range_matches { range_header } else { None }, total);
    if matches!(range, Some(Err(()))) {
        return tauri::http::Response::builder()
            .status(416)
            .header("Accept-Ranges", "bytes")
            .header("Content-Range", format!("bytes */{total}"))
            .header("ETag", etag)
            .body(Vec::new())
            .expect("invalid project asset range response");
    }
    let partial = range.and_then(Result::ok);
    let (start, end) = partial.unwrap_or((0, total.saturating_sub(1)));
    let length = if total == 0 { 0 } else { end - start + 1 };
    let body = if request.method() == tauri::http::Method::HEAD {
        Ok(Vec::new())
    } else if partial.is_some() {
        read_file_range(&file, start, end)
    } else {
        std::fs::read(&file)
    };
    let Ok(body) = body else {
        return tauri::http::Response::builder()
            .status(404)
            .body(Vec::new())
            .expect("unreadable project asset response");
    };
    let mut response = tauri::http::Response::builder()
        .status(if partial.is_some() { 206 } else { 200 })
        .header("Content-Type", image_content_type(&file))
        .header("Content-Length", length)
        .header("Accept-Ranges", "bytes")
        .header("Cache-Control", "no-cache")
        .header("ETag", etag);
    if partial.is_some() {
        response = response.header(
            "Content-Range",
            format!("bytes {start}-{end}/{total}"),
        );
    }
    if let Some(origin) = request
        .headers()
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .filter(|origin| app_origin(origin))
    {
        response = response
            .header("Access-Control-Allow-Origin", origin)
            .header("Vary", "Origin");
    }
    response.body(body).expect("project asset response")
}

/// `module://panel/m/<name>/<sub>`: one request to a module's one-shot host.
fn module_response(panel_home: &Path, request: &ProtocolRequest) -> ProtocolResponse {
    let uri = request.uri();
    let path = match uri.query() {
        Some(query) => format!("{}?{}", uri.path(), query),
        None => uri.path().to_string(),
    };
    let response = modules::serve(
        panel_home,
        &path,
        request.method().as_str(),
        request.body().clone(),
    );
    tauri::http::Response::builder()
        .status(response.status)
        .header("Content-Type", response.content_type)
        .body(response.body)
        .unwrap_or_else(|_| {
            tauri::http::Response::builder()
                .status(500)
                .body(Vec::new())
                .expect("empty response")
        })
}

/// The app's own page, which may read a project file with `fetch` (Review draws a sound's
/// waveform from its bytes). Module iframes and anything else stay limited to `<img>`/`<audio>`.
fn app_origin(origin: &str) -> bool {
    origin == "tauri://localhost"
        || origin == "http://tauri.localhost"
        || origin.starts_with("http://localhost:")
        || origin.starts_with("http://127.0.0.1:")
}

fn image_content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "heic" => "image/heic",
        "aiff" | "aif" => "audio/aiff",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "m4a" | "aac" => "audio/mp4",
        "flac" => "audio/flac",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "pdf" => "application/pdf",
        "json" => "application/json",
        "md" | "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn byte_range(value: Option<&str>, total: u64) -> Option<Result<(u64, u64), ()>> {
    let value = value?;
    let Some(spec) = value.strip_prefix("bytes=") else {
        return Some(Err(()));
    };
    if spec.contains(',') || total == 0 {
        return Some(Err(()));
    }
    let Some((start, end)) = spec.split_once('-') else {
        return Some(Err(()));
    };
    if start.is_empty() {
        let Ok(suffix) = end.parse::<u64>() else {
            return Some(Err(()));
        };
        if suffix == 0 {
            return Some(Err(()));
        }
        return Some(Ok((total.saturating_sub(suffix), total - 1)));
    }
    let Ok(start) = start.parse::<u64>() else {
        return Some(Err(()));
    };
    if start >= total {
        return Some(Err(()));
    }
    let end = if end.is_empty() {
        total - 1
    } else {
        match end.parse::<u64>() {
            Ok(end) => end.min(total - 1),
            Err(_) => return Some(Err(())),
        }
    };
    Some((start <= end).then_some((start, end)).ok_or(()))
}

fn read_file_range(path: &Path, start: u64, end: u64) -> std::io::Result<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let length = end - start + 1;
    let mut file = std::fs::File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let mut body = Vec::with_capacity(length.min(usize::MAX as u64) as usize);
    file.take(length).read_to_end(&mut body)?;
    Ok(body)
}

fn file_etag(metadata: &std::fs::Metadata) -> String {
    let changed = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("\"{:x}-{changed:x}\"", metadata.len())
}

/// The Rust side is authoritative: the UI may retain an ended terminal's scrollback, but that is
/// not a live process and must not make quitting look dangerous. Clone session metadata first,
/// then inspect PTYs so we never hold the two mutexes in opposite order.
fn live_sessions(state: &DesktopState) -> Vec<Session> {
    let sessions: Vec<Session> = state.sessions.lock().unwrap().values().cloned().collect();
    let mut terminals = state.terminals.lock().unwrap();
    sessions
        .into_iter()
        .filter(|session| terminals.is_running(&session.terminal_id))
        .collect()
}

/// Returns true when this shutdown request must be prevented. Every human close/quit request is
/// confirmed, even with no live session. Safety is fail-closed: if the webview cannot receive the
/// warning, Panel stays open and any sessions keep running.
fn guard_shutdown(app: &AppHandle) -> bool {
    let state = app.state::<DesktopState>();
    if state.shutdown_approved.load(Ordering::SeqCst) {
        return false;
    }
    let sessions = live_sessions(&state);
    if !state.shutdown_prompt_pending.swap(true, Ordering::SeqCst)
        && app.emit(SHUTDOWN_EVENT, sessions).is_err()
    {
        state.shutdown_prompt_pending.store(false, Ordering::SeqCst);
    }
    true
}

/// Resolve a project by id. This READS config.json off disk, so it belongs inside whatever
/// blocking task needs it — never on the main thread ahead of one. There is deliberately no
/// `DesktopState::project` convenience method: it would be a main-thread disk read waiting to
/// happen, and every caller here is already inside a blocking task.
fn find_project(id: &str) -> Result<Project, String> {
    // The manager is not in the portfolio, so it resolves from the ops tree. Every per-project
    // command (sessions, file changes, Work) then serves it like any other project.
    if id == CPO_ID {
        return cpo_root();
    }
    all_projects()
        .into_iter()
        .find(|project| project.id == id)
        .ok_or_else(|| format!("unknown project: {id}"))
}

/// `--project <path>` turns the portfolio host into a single-project host. The same binary and
/// feature code serve both shapes; standalone is presentation, never a fork.
fn standalone_project() -> Option<Project> {
    let args: Vec<String> = std::env::args().collect();
    let from_args = args
        .windows(2)
        .find(|pair| pair[0] == "--project")
        .map(|pair| PathBuf::from(&pair[1]));
    let path =
        from_args.or_else(|| std::env::var_os("PANEL_SINGLE_PROJECT").map(PathBuf::from))?;
    let path = path.canonicalize().ok()?;
    let id = path.file_name()?.to_string_lossy().into_owned();
    Some(Project {
        name: id.replace(['_', '-'], " "),
        id,
        exists: path.is_dir(),
        path,
        // A one-project Panel has no portfolio to divide, so it has no group.
        group: String::new(),
        role: ProjectRole::Leaf,
        project_type: "generic".into(),
        parent_id: String::new(),
        extension_id: String::new(),
    })
}

fn all_projects() -> Vec<Project> {
    standalone_project()
        .map(|project| vec![project])
        .unwrap_or_else(projects::load)
}

#[derive(serde::Serialize)]
struct LaunchContext {
    single_project: Option<String>,
}

/// Pure process arguments. Sync on purpose.
#[tauri::command]
fn launch_context() -> LaunchContext {
    let single = standalone_project();
    LaunchContext {
        single_project: single.map(|project| project.id),
    }
}

/*
 * ------------------------------------------------------------------ THE MAIN THREAD RULE
 *
 * A SYNC `#[tauri::command] fn` runs ON THE MAIN THREAD — the same thread that paints the
 * window. So any command that touches the world (disk, git, a subprocess, a PTY) freezes the
 * entire UI for exactly as long as the world takes to answer.
 *
 * That is not theoretical here. `module_request` shells out to a PYTHON INTERPRETER per call
 * ("one request, one process" — see modules::call). Product Spine still uses that path. As a
 * sync command it held the window hostage for an interpreter startup on every request.
 *
 * The rule, therefore:
 *
 *   TOUCHES THE WORLD (fs, git, subprocess, PTY spawn)  ->  `async fn` + `spawn_blocking`
 *   PURE IN-MEMORY (a mutex, a map lookup, a channel)   ->  sync `fn` is fine and cheaper
 *
 * The in-memory ones are marked as such below so nobody "fixes" them into async for symmetry.
 */

/// Hand blocking work to the blocking pool and flatten the join error away.
async fn off_main<T, F>(work: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())?
}

/// The portfolio — the app's main navigation. Reads config.json and stats every project folder.
#[tauri::command]
async fn list_projects() -> Result<Vec<Project>, String> {
    off_main(move || Ok(all_projects())).await
}

/// The portfolio's groups, in the order `config.json` lists them. That order is the sidebar's and
/// the terminal strip's, so rearranging companies is an edit to the file and nothing else.
#[tauri::command]
async fn list_groups() -> Result<Vec<projects::Group>, String> {
    off_main(|| Ok(projects::groups())).await
}

/// File a project under a group, or under none when `group` is empty. Writes `config.json`, which
/// every other reader picks up on its next read — nothing here needs a relaunch.
#[tauri::command]
async fn set_project_group(project: String, group: String) -> Result<(), String> {
    off_main(move || projects::set_group(&project, &group)).await
}

/// Make a new group and return the full list, so the caller never has to re-read it.
#[tauri::command]
async fn add_group(name: String) -> Result<Vec<projects::Group>, String> {
    off_main(move || projects::add_group(&name)).await
}

#[tauri::command]
async fn project_modules(project: String) -> Result<projects::ProjectModules, String> {
    off_main(move || {
        let project = find_project(&project)?;
        projects::modules(&project.path)
    })
    .await
}

#[tauri::command]
async fn add_project(
    state: State<'_, DesktopState>,
    path: String,
    name: Option<String>,
) -> Result<Project, String> {
    let project = off_main(move || projects::add(Path::new(path.trim()), name)).await?;
    state.ingress.register_project(&project.id, &project.path);
    Ok(project)
}

/// Native folder picker for Add Project. Typing a path was the old way and it was wrong: the
/// human already has the folder in front of them. `None` means they cancelled.
#[tauri::command]
async fn pick_project_folder(app: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_title("Add a project")
        .pick_folder(move |picked| {
            let _ = tx.send(picked);
        });
    let picked = rx.recv().map_err(|error| error.to_string())?;
    Ok(picked.map(|path| path.to_string()))
}

/// `config.json` is a SHARED file: the old Panel writes it, an agent writes it, and the folder
/// picker writes it. Watch it so any of those lands in the rail without a relaunch.
fn watch_portfolio(app: AppHandle) {
    let file = projects::config_path();
    let Some(dir) = file.parent().map(Path::to_path_buf) else {
        return;
    };
    std::thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        let Ok(mut watcher) = notify::recommended_watcher(tx) else {
            return;
        };
        // The file itself is replaced by atomic writes, so the DIRECTORY is what stays watchable.
        if notify::Watcher::watch(&mut watcher, &dir, notify::RecursiveMode::NonRecursive).is_err()
        {
            return;
        }
        while let Ok(event) = rx.recv() {
            let Ok(event) = event else { continue };
            if !event.paths.iter().any(|path| path == &file) {
                continue;
            }
            // One save is several events. Drain the burst so the rail repaints once.
            while rx
                .recv_timeout(std::time::Duration::from_millis(200))
                .is_ok()
            {}
            let _ = app.emit(PORTFOLIO_EVENT, ());
        }
    });
}

/// `ops/sprints/` is written by the manager's agent far more often than by Panel. Watch the
/// folder so the Sprint screen repaints on an agent's write without anyone pressing anything.
fn watch_sprints(app: AppHandle) {
    let Some(dir) = ops::ops_dir().map(|ops| ops.join("sprints")) else {
        return;
    };
    std::thread::spawn(move || {
        if std::fs::create_dir_all(&dir).is_err() {
            return;
        }
        let (tx, rx) = std::sync::mpsc::channel();
        let Ok(mut watcher) = notify::recommended_watcher(tx) else {
            return;
        };
        if notify::Watcher::watch(&mut watcher, &dir, notify::RecursiveMode::NonRecursive).is_err()
        {
            return;
        }
        while let Ok(event) = rx.recv() {
            let Ok(event) = event else { continue };
            if !event
                .paths
                .iter()
                .any(|path| path.extension().and_then(|e| e.to_str()) == Some("md"))
            {
                continue;
            }
            // An atomic save is several events, and an agent rewriting the file is more. Drain
            // the burst so one plan lands as one repaint.
            while rx
                .recv_timeout(std::time::Duration::from_millis(200))
                .is_ok()
            {}
            let _ = app.emit(SPRINTS_EVENT, ());
        }
    });
}

/// Open a project-owned directory in the platform file manager. `path = null` means the project
/// root; feature workspaces may pass a relative child folder. The same
/// canonical confinement used by the editor prevents the webview from opening arbitrary paths.
#[tauri::command]
async fn open_project_folder(project: String, path: Option<String>) -> Result<(), String> {
    off_main(move || {
        let project = find_project(&project)?;
        let folder = match path
            .as_deref()
            .map(str::trim)
            .filter(|path| !path.is_empty())
        {
            Some(path) => confine(&project.path, path)?,
            None => project
                .path
                .canonicalize()
                .map_err(|error| error.to_string())?,
        };
        if !folder.is_dir() {
            return Err(format!("not a folder: {}", folder.display()));
        }
        open_folder(&folder)
    })
    .await
}

fn open_folder(folder: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = crate::platform::command("open");
    #[cfg(target_os = "windows")]
    let mut command = crate::platform::command("explorer");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = crate::platform::command("xdg-open");

    command
        .arg(folder)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("could not open {}: {error}", folder.display()))
}

#[tauri::command]
fn open_revenuecat_setup(project_id: Option<String>) -> Result<(), String> {
    let project_id = project_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(value) = project_id {
        if !value.starts_with("proj")
            || !value.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '_' | '-')
            })
        {
            return Err("invalid RevenueCat project id".to_string());
        }
    }
    let url = project_id
        .map(|value| format!("https://app.revenuecat.com/projects/{value}/overview"))
        .unwrap_or_else(|| "https://app.revenuecat.com/projects/".to_string());

    #[cfg(target_os = "macos")]
    let mut command = crate::platform::command("open");
    #[cfg(target_os = "windows")]
    let mut command = crate::platform::command("explorer");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = crate::platform::command("xdg-open");
    command
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("could not open RevenueCat: {error}"))
}

/// One `git status` process answers branch, drift and dirt off the main thread.
#[tauri::command]
async fn project_dashboard(project: String) -> Result<GitState, String> {
    off_main(move || Ok(projects::git_state(&find_project(&project)?.path))).await
}

/// Each project's row in its company's `portfolio.yaml`, for the sidebar's lanes.
#[tauri::command]
async fn project_standings() -> Result<Vec<pulse::Standing>, String> {
    off_main(|| Ok(pulse::standings())).await
}

/// Two weeks of commits in one project's folder, for the sidebar's activity bars.
#[tauri::command]
async fn project_activity(project: String) -> Result<pulse::Activity, String> {
    off_main(move || Ok(pulse::activity(&find_project(&project)?.path))).await
}

/// One native snapshot replaces the Git tab's former status and graph module processes.
#[tauri::command]
async fn git_overview(repo: String, limit: Option<usize>) -> Result<GitOverview, String> {
    off_main(move || projects::git_overview(Path::new(&repo), limit.unwrap_or(160))).await
}

/// Debug profiles are read from the project, then automatic Dart and Flutter profiles are added.
/// Adapter discovery may touch the filesystem, so it stays off the window thread.
#[tauri::command]
async fn debug_profiles(project: String) -> Result<Vec<debug::DebugProfile>, String> {
    off_main(move || {
        let found = find_project(&project)?;
        debug::profiles(&found.path)
    })
    .await
}

#[tauri::command]
async fn debug_targets(project: String) -> Result<Vec<targets::Target>, String> {
    off_main(move || {
        let found = find_project(&project)?;
        let kind = sim::kind_of(&found.path)
            .ok_or_else(|| "this project has no runnable target".to_string())?;
        Ok(targets::list_for(
            &found.path,
            kind,
            &format!("debug:{project}"),
        ).into_iter().filter(|target| kind != "native" || target.family != "ios").collect())
    })
    .await
}

#[tauri::command]
fn debug_status(state: State<'_, DesktopState>, project: String) -> debug::DebugStatus {
    state.debugger.status(&project)
}

/// Breakpoints belong to Panel's user state, never to the repository.
#[tauri::command]
async fn debug_breakpoints(
    project: String,
) -> Result<std::collections::BTreeMap<String, Vec<u32>>, String> {
    off_main(move || {
        let _ = find_project(&project)?;
        Ok(debug::breakpoints(&project))
    })
    .await
}

#[tauri::command]
async fn debug_set_breakpoints(
    state: State<'_, DesktopState>,
    project: String,
    path: String,
    lines: Vec<u32>,
) -> Result<(), String> {
    let debugger = state.debugger.clone();
    off_main(move || {
        let found = find_project(&project)?;
        debugger.set_breakpoints(&project, &found.path, &path, lines)
    })
    .await
}

#[tauri::command]
async fn debug_start(
    app: AppHandle,
    state: State<'_, DesktopState>,
    project: String,
    profile: String,
    target: Option<String>,
) -> Result<debug::DebugProfile, String> {
    let debugger = state.debugger.clone();
    off_main(move || {
        let found = find_project(&project)?;
        debugger.start(app, &project, &found.path, &profile, target.as_deref())
    })
    .await
}

#[tauri::command]
async fn debug_request(
    state: State<'_, DesktopState>,
    project: String,
    command: String,
    arguments: Value,
) -> Result<Value, String> {
    let debugger = state.debugger.clone();
    off_main(move || debugger.request(&project, &command, arguments)).await
}

#[tauri::command]
async fn debug_stop(state: State<'_, DesktopState>, project: String) -> Result<(), String> {
    let debugger = state.debugger.clone();
    off_main(move || debugger.stop(&project)).await
}

/// The git-derived working set — the fallback when the agent has declared no worklist.
#[tauri::command]
async fn project_working_set(project: String) -> Result<Vec<WorkFile>, String> {
    off_main(move || Ok(projects::git_working_set(&find_project(&project)?.path))).await
}

/// Every live session, for every project. IN-MEMORY — a map read behind a mutex. Sync on
/// purpose; an async hop would cost more than the work.
#[tauri::command]
fn list_sessions(state: State<'_, DesktopState>) -> Vec<Session> {
    state.sessions.lock().unwrap().values().cloned().collect()
}

#[tauri::command]
async fn skills_catalog(
    state: State<'_, DesktopState>,
    session: Option<String>,
) -> Result<Vec<skills::SkillEntry>, String> {
    let cwd = match session {
        Some(id) => Some(state.sessions.lock().unwrap().get(&id)
            .ok_or("Session has ended. Select another session")?.cwd.clone()),
        None => None,
    };
    off_main(move || skills::catalog(cwd)).await
}

#[tauri::command]
async fn skills_read(path: String) -> Result<String, String> {
    off_main(move || skills::read(path)).await
}

#[tauri::command]
async fn skills_read_document(path: String) -> Result<skills::SkillDocument, String> {
    off_main(move || skills::read_document(path)).await
}

#[tauri::command]
async fn skills_session_policy(state: State<'_, DesktopState>, session: String)
    -> Result<skill_sessions::Policy, String> {
    if !state.sessions.lock().unwrap().contains_key(&session) {
        return Err("Session has ended".into());
    }
    off_main(move || skill_sessions::policy(&session)).await
}

#[tauri::command]
async fn skills_session_set(state: State<'_, DesktopState>, session: String,
    path: String, enabled: Option<bool>) -> Result<skill_sessions::Policy, String> {
    let found = state.sessions.lock().unwrap().get(&session).cloned().ok_or("Session has ended")?;
    off_main(move || {
        let entries = skills::catalog(Some(found.cwd))?;
        let entry = entries.iter().find(|entry| entry.path == path).ok_or("Skill is no longer available")?;
        let native = entry.provider == found.kind || entry.source == "panel" ||
            (found.kind == "codex" && entry.provider == "shared");
        if !matches!(found.kind.as_str(), "claude" | "codex") || !native || entry.source == "plugin" || entry.archived {
            return Err("This skill uses its provider's native controls".into());
        }
        if found.kind == "claude" && entries.iter().filter(|other|
            (other.provider == "claude" || other.source == "panel") && other.name == entry.name).count() > 1 {
            return Err("Several Claude skills share this name. Use the native skills menu".into());
        }
        skill_sessions::set(&session, &path, enabled)
    }).await
}

/// The UI confirms this explicit restart. The provider's picker chooses the conversation;
/// never use --last when two agents can occupy the same working directory.
#[tauri::command]
async fn skills_session_restart(app: AppHandle, state: State<'_, DesktopState>,
    session: String, cols: u16, rows: u16) -> Result<Session, String> {
    let found = state.sessions.lock().unwrap().get(&session).cloned().ok_or("Session has ended")?;
    if !matches!(found.kind.as_str(), "claude" | "codex") {
        return Err("Skill controls support Claude and Codex sessions".into());
    }
    // Validate config before stopping the terminal, so malformed files leave it running.
    skill_sessions::launch_args(&session, &found.kind, &found.cwd)?;
    if found.kind == "claude" {
        skill_sessions::claude_overrides(&session, &found.cwd)?;
    }
    stop_session(state.clone(), session.clone()).await?;
    let result = open_session(app, state.clone(), found.project.clone(), found.kind.clone(),
        cols, rows, Some(found.cwd.to_string_lossy().into_owned()), Reopen {
            id: Some(session.clone()), title: Some(found.title.clone()),
            resume: vec![if found.kind == "claude" { "--resume" } else { "resume" }.into()],
        }).await;
    if result.is_err() {
        // Keep the ended seat addressable so the user can retry the launch.
        state.sessions.lock().unwrap().insert(session, found);
    }
    result
}

#[tauri::command]
async fn skills_save(path: Option<String>, name: String, description: String,
    body: String, expected: Option<String>, department: Option<String>) -> Result<skills::SkillEntry, String> {
    off_main(move || skills::save(path, name, description, body, expected, department)).await
}

#[tauri::command]
async fn skills_resources(path: String) -> Result<Vec<String>, String> {
    off_main(move || skills::resources(path)).await
}

#[tauri::command]
async fn skills_resource_read(path: String, relative: String) -> Result<String, String> {
    off_main(move || skills::resource_read(path, relative)).await
}

#[tauri::command]
async fn skills_resource_save(path: String, relative: String, content: String, expected: Option<String>) -> Result<(), String> {
    off_main(move || skills::resource_save(path, relative, content, expected)).await
}

#[tauri::command]
async fn skills_archive(path: String) -> Result<(), String> {
    off_main(move || skills::archive(path)).await
}

#[tauri::command]
fn skills_usage(state: State<'_, DesktopState>, session: String) -> Result<Value, String> {
    let sessions = state.sessions.lock().unwrap();
    let found = sessions.get(&session).ok_or("Session has ended")?;
    Ok(serde_json::json!({
        "supported": found.kind == "claude",
        "used": state.ingress.skill_uses(&found.instance),
    }))
}

/// Open a session on a project: a coding agent of any kind, or a plain shell.
///
/// It ADDS one. It does not replace what is already running — that was the old behaviour, and
/// with a single slot per project it meant "open a shell" and "kill the agent" were the same
/// gesture. A build and the agent that broke it need to be open at the same time.
///
/// An agent is bound to the project in the ingress BEFORE the PTY spawns — a hook can fire
/// within milliseconds, and an event that arrives before its route is an event that is silently
/// dropped.
///
/// It resolves the project off disk and forks a PTY, so it does not belong on the main thread
/// either — a fork/exec is not free, and this is the click the user is watching.
#[tauri::command]
async fn start_session(
    app: AppHandle,
    state: State<'_, DesktopState>,
    project: String,
    kind: String,
    cols: u16,
    rows: u16,
    // `cwd` is where to fork: None means the project root, the usual case. A path is how
    // "another shell, right here" works — the caller passes the live cwd of the terminal it came
    // from, and a stale or vanished folder falls back to the root instead of failing the launch.
    cwd: Option<String>,
) -> Result<Session, String> {
    open_session(
        app,
        state,
        project,
        kind,
        cols,
        rows,
        cwd,
        Reopen::default(),
    )
    .await
}

/// What a RESTORED session needs that a fresh one does not.
///
/// A restore is the same launch with two things pinned. The id, because everything the UI
/// remembers about a terminal — which tab it sits in, what you renamed it to — is keyed by it,
/// and a new id would restore the terminal while losing the terminal's identity. And a resume
/// flag, which is the difference between the agent picking the conversation back up and it
/// starting over with amnesia.
#[derive(Default)]
struct Reopen {
    /// Keep this session id instead of minting one.
    id: Option<String>,
    /// Extra argv handed to the engine, ahead of its Panel wiring.
    resume: Vec<String>,
    /// Use this title rather than numbering a fresh seat.
    title: Option<String>,
}

/// The executable a kind execs, plus fixed args. Kinds name the binary directly — except the
/// opencode model variants, which all run `opencode --model <model>` so the plain opencode kind
/// stays the default model.
fn kind_program(kind: &str) -> (&str, Vec<String>) {
    match kind {
        "opencode-kimi-k3" => ("opencode", vec!["--model".into(), "kimi/kimi-k3".into()]),
        "opencode-deepseek-v4-flash" => (
            "opencode",
            vec!["--model".into(), "deepseek/deepseek-v4-flash".into()],
        ),
        other => (other, Vec::new()),
    }
}

#[allow(clippy::too_many_arguments)]
async fn open_session(
    app: AppHandle,
    state: State<'_, DesktopState>,
    project: String,
    kind: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    reopen: Reopen,
) -> Result<Session, String> {
    let id = project.clone();
    let found = off_main(move || find_project(&id)).await?;
    if found.role == ProjectRole::Collection {
        return Err(format!("project {} is a collection", found.id));
    }
    if !found.exists {
        return Err(format!(
            "project folder is missing: {}",
            found.path.display()
        ));
    }
    let start_in = cwd
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .unwrap_or_else(|| found.path.clone());
    let event_app = app.clone();
    let sink: TerminalSink = Arc::new(move |chunk: TerminalChunk| {
        let _ = event_app.emit(TERMINAL_EVENT, chunk);
    });

    // Every coding agent receives a routable Panel identity. Providers differ only in how the
    // "send this to the human" behavior is injected: Claude uses its settings/MCP flags, Codex
    // gets per-process config overrides, and Grok gets a session rule plus the local sender.
    // Unknown/new agent kinds still inherit the HTTP coordinates and can call the sender.
    let mut spec = SpawnSpec::shell(&start_in, cols, rows);
    let instance = if kind == "shell" {
        String::new()
    } else {
        reopen.id.clone().unwrap_or_else(uuid_v4)
    };
    let (program, model_args) = kind_program(&kind);
    let session_id = reopen.id.clone().unwrap_or_else(|| {
        if instance.is_empty() { uuid_v4() } else { instance.clone() }
    });

    if kind != "shell" {
        let port = state.ingress.port();
        let role = if project == CPO_ID { launch::Role::Manager } else { launch::Role::Worker };
        let mut wiring = match kind.as_str() {
            "claude" => launch::agent_args(&state.panel_home, port, &instance, role),
            "codex" => launch::codex_args(&state.panel_home, port, &instance, role),
            "grok" => launch::grok_args(&state.panel_home, role),
            _ => launch::AgentLaunch { args: Vec::new() },
        };
        wiring.args.extend(skill_sessions::launch_args(&session_id, &kind, &start_in)?);
        if kind == "claude" {
            let overrides = skill_sessions::claude_overrides(&session_id, &start_in)?;
            launch::apply_skill_overrides(&mut wiring, &instance, overrides)?;
        }
        state.ingress.register_agent(&instance, &project, &found.path);
        // The resume flag goes FIRST: every one of these CLIs reads it as a mode, and a mode
        // argument buried behind config overrides is a mode argument some of them ignore.
        let mut args = reopen.resume.clone();
        args.extend(model_args);
        args.extend(wiring.args);
        spec = spec
            .run(program, args)
            // These also make the fallback panel_send.py usable by any hosted process.
            .with_env("PANEL_PORT", port.to_string())
            .with_env("PANEL_INSTANCE", instance.clone())
            // Kimi, GLM, opencode and anything added tomorrow get no session-scoped flags at all.
            // Naming the sender in the environment is the one thing that works for every engine:
            // whatever it is, it can read an env var and run a script, so its screenshots reach
            // the Inbox instead of dying in a terminal nobody was watching.
            .with_env(
                "PANEL_SEND",
                state
                    .panel_home
                    .join("panel_send.py")
                    .to_string_lossy()
                    .into_owned(),
            );
    }

    let terminal_id = state
        .terminals
        .lock()
        .unwrap()
        .spawn(spec, sink)
        .map_err(|error| {
            if !instance.is_empty() {
                state.ingress.unregister_agent(&instance);
            }
            // Surface the real reason on the dev terminal — a swallowed spawn error is exactly
            // why "the terminal just resets" with no explanation.
            eprintln!(
                "[panel] start_session failed: kind={kind} project={project} cwd={} PATH={:?} — {error:#}",
                start_in.display(),
                std::env::var("PATH").unwrap_or_default(),
            );
            error.to_string()
        })?;

    // Sessions of a kind are numbered in the order they were opened, so two shells on one
    // project are tellable apart without anyone having to name them.
    let seat = 1 + state
        .sessions
        .lock()
        .unwrap()
        .values()
        .filter(|s| s.project == project && s.kind == kind)
        .count();
    let title = reopen.title.unwrap_or(if seat == 1 {
        kind.clone()
    } else {
        format!("{kind} {seat}")
    });

    let session = Session {
        // Agent events already use the ingress instance id. Sharing that id with the terminal
        // lets the UI scope each prompt and its touched files to the selected terminal.
        //
        // A restore overrides both: it is the SAME terminal coming back, and the tab it lives in
        // and the name you gave it are both filed under the old id.
        id: session_id,
        project,
        kind,
        title,
        terminal_id,
        cwd: start_in,
        instance,
    };
    state
        .sessions
        .lock()
        .unwrap()
        .insert(session.id.clone(), session.clone());
    if session.project != CPO_ID {
        state.made.watch(&app, &session.project, &found.path);
    }
    if let Err(error) = skill_sessions::mark_applied(&session.id) {
        eprintln!("[panel] could not record applied skill settings: {error}");
    }
    Ok(session)
}

/* ------------------------------------------------------------------ the wall, across a restart

Quitting Panel kills every PTY. That is deliberate and it stays that way — a coding agent
left running in a process nobody can see is worse than one that stopped. What was NOT
deliberate is that quitting also erased the wall: which terminals you had, on what, showing
what. Coming back meant rebuilding six terminals by hand and re-explaining yourself to each
agent.

So the wall is written down on the way out and put back on the way in. Three things are saved
per terminal: what it was (project, kind, cwd), what you called it, and the tail of its screen.
On the next launch each one is forked again in the same folder, its old screen is replayed into
it, and agents that can resume are launched resuming.

What this is NOT: the processes do not survive. A build that was running is gone, and a turn
that was in flight when you quit is gone with it. The agent comes back with its conversation,
not mid-sentence. Anything more than that needs the PTYs to outlive the app, which is a
different design and a much bigger one. */

/// One terminal, written down.
#[derive(serde::Serialize, serde::Deserialize)]
struct SavedSession {
    id: String,
    project: String,
    kind: String,
    title: String,
    cwd: PathBuf,
    /// Raw PTY tail, escape sequences and all — see TerminalManager::screen.
    screen: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct SavedWall {
    /// Unix seconds. Shown in the banner the restored screen opens with, because a screen with
    /// no date on it reads as live output and that is the one thing it is not.
    saved_at: u64,
    sessions: Vec<SavedSession>,
}

/// A restored terminal, handed to the UI: the live session plus the screen to paint into it.
#[derive(serde::Serialize)]
struct RestoredSession {
    session: Session,
    screen: String,
}

/// Everything the UI needs to put the wall back. `saved_at` rides along because the banner each
/// restored pane opens with states the date, and the UI must not guess it from the clock.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RestoredWall {
    saved_at: u64,
    sessions: Vec<RestoredSession>,
}

/// The snapshot lives in the OS app-data folder, NOT in `panel_home` — that is a checked-in
/// source tree, and last night's terminal scrollback is not source. Created on demand; a failure
/// to create it just means the wall is not saved this time.
fn wall_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_local_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("wall.json"))
}

/// How to make each engine pick its last conversation back up.
///
/// Only verified resume flows are listed. dshline opens its saved-session picker.
/// An engine whose resume flag we are not sure of
/// launches plain — a terminal that opens fresh is a small loss, and a terminal that fails to
/// launch because we guessed a flag is the whole terminal. New engines are opt-in here, not
/// opt-out, for that reason.
fn resume_args(kind: &str) -> Vec<String> {
    match kind {
        "claude" => vec!["--continue".into()],
        "codex" => vec!["resume".into(), "--last".into()],
        "dshline" => vec!["--resume".into()],
        _ => Vec::new(),
    }
}

/// Write the wall down. Called on the way out, while the PTYs are still open — their screens are
/// read from the live sessions, so this must run BEFORE anything is closed.
///
/// Sim runs and task sessions are deliberately left out. A sim run is a build on a device, not a
/// terminal you work in, and restoring one would boot a simulator you did not ask for on launch.
fn save_wall(app: &AppHandle, state: &DesktopState) {
    let Some(path) = wall_path(app) else {
        eprintln!("[panel] no app-data folder — the wall was not saved");
        return;
    };
    let sessions: Vec<Session> = state.sessions.lock().unwrap().values().cloned().collect();
    let saved: Vec<SavedSession> = {
        let terminals = state.terminals.lock().unwrap();
        sessions
            .into_iter()
            .filter(|session| session.kind != "sim" && session.kind != "task")
            .filter(|session| session.cwd.is_dir())
            .map(|session| SavedSession {
                screen: terminals.screen(&session.terminal_id).unwrap_or_default(),
                id: session.id,
                project: session.project,
                kind: session.kind,
                title: session.title,
                cwd: session.cwd,
            })
            .collect()
    };
    let wall = SavedWall {
        saved_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|since| since.as_secs())
            .unwrap_or(0),
        sessions: saved,
    };
    // A failed save must never block the quit it is part of. Losing the wall is a nuisance;
    // refusing to close is a hung app.
    match serde_json::to_vec_pretty(&wall) {
        Ok(bytes) => {
            if let Err(error) = std::fs::write(&path, bytes) {
                eprintln!(
                    "[panel] could not save the wall to {}: {error}",
                    path.display()
                );
            }
        }
        Err(error) => eprintln!("[panel] could not encode the wall: {error}"),
    }
}

/// Put the wall back. Forks every saved terminal again and returns each one with the screen it
/// had, for the UI to replay.
///
/// The file is consumed: read once, deleted, then the sessions are opened. A snapshot left on
/// disk is a snapshot a crash mid-restore would replay a second time, and two live claudes where
/// there was one is worse than none.
#[tauri::command]
async fn restore_wall(
    app: AppHandle,
    state: State<'_, DesktopState>,
    cols: u16,
    rows: u16,
) -> Result<RestoredWall, String> {
    let empty = || RestoredWall {
        saved_at: 0,
        sessions: Vec::new(),
    };
    let Some(path) = wall_path(&app) else {
        return Ok(empty());
    };
    let Ok(bytes) = std::fs::read(&path) else {
        return Ok(empty()); // no snapshot: a first run, or a wall that was empty
    };
    let _ = std::fs::remove_file(&path);
    let wall: SavedWall = match serde_json::from_slice(&bytes) {
        Ok(parsed) => parsed,
        Err(error) => {
            eprintln!("[panel] the saved wall could not be read: {error}");
            return Ok(empty());
        }
    };
    let saved_at = wall.saved_at;

    // `claude --continue` resumes the most recent conversation IN A FOLDER. Two claudes on one
    // folder would therefore both resume the same one — the same transcript open twice, each
    // unaware of the other. So the flag goes to the first of each (kind, cwd) only; the rest
    // come back as fresh prompts in the right place, which is honest.
    let mut resumed: HashSet<(String, PathBuf)> = HashSet::new();
    let mut out = Vec::new();
    for saved in wall.sessions {
        let key = (saved.kind.clone(), saved.cwd.clone());
        let resume = if resumed.insert(key) {
            resume_args(&saved.kind)
        } else {
            Vec::new()
        };
        let reopen = Reopen {
            id: Some(saved.id.clone()),
            resume,
            title: Some(saved.title.clone()),
        };
        match open_session(
            app.clone(),
            state.clone(),
            saved.project.clone(),
            saved.kind.clone(),
            cols,
            rows,
            Some(saved.cwd.to_string_lossy().into_owned()),
            reopen,
        )
        .await
        {
            Ok(session) => out.push(RestoredSession {
                session,
                screen: saved.screen,
            }),
            // One terminal that cannot come back (its folder moved, its engine is gone from PATH)
            // must not take the other five with it.
            Err(error) => eprintln!(
                "[panel] could not restore {} on {}: {error}",
                saved.kind, saved.project
            ),
        }
    }
    Ok(RestoredWall {
        saved_at,
        sessions: out,
    })
}

/// Where this session's shell is standing RIGHT NOW — not where it was forked. Asking the OS is
/// the only honest answer: a `cd` inside the PTY is invisible to us, and remembering the launch
/// folder would open "another shell here" in the wrong place the moment anyone moved.
///
/// Returns `None` rather than an error when the pid is gone or the platform has no cheap way to
/// answer — the caller then falls back to the project root, which is never wrong, only less kind.
#[tauri::command]
async fn session_cwd(
    state: State<'_, DesktopState>,
    session: String,
) -> Result<Option<String>, String> {
    let terminal_id = state
        .sessions
        .lock()
        .unwrap()
        .get(&session)
        .map(|found| found.terminal_id.clone());
    let Some(terminal_id) = terminal_id else {
        return Ok(None);
    };
    let pid = state.terminals.lock().unwrap().pid(&terminal_id);
    let Some(pid) = pid else { return Ok(None) };
    // lsof forks a process, so it does not belong on the main thread with a click waiting on it.
    Ok(off_main(move || process_cwd(pid)).await?)
}

/// Is anything actually GOING ON in this terminal, or is it sitting at a prompt?
///
/// "Is the session live" is the wrong question to gate a destructive close on: the PTY's own
/// child — the shell, or the agent binary — is alive by definition until the terminal is closed.
/// What matters is whether that process is doing something, and the answer differs by kind:
///
///   shell / agent — busy when the terminal's FOREGROUND process group is no longer the process
///           we spawned, which is exactly "a command is running in there". Deliberately not "has
///           any child": a modern shell keeps async helpers alive (prompt workers, gitstatusd)
///           and an agent keeps stdio MCP servers, so counting children would report every idle
///           terminal as busy. The cost is that a job put in the BACKGROUND reads as idle.
///   sim / task — the process IS the work. Alive means busy; when it finishes, the session is
///           marked exited and never reaches this question.
///
/// An agent that is merely thinking has forked nothing either, so the mid-turn half of the
/// answer belongs to the UI, which hears it from the agent's own status events.
///
/// Errs toward `true`: an unknown state must still be asked about, never closed silently. An
/// unknown SESSION is the exception — there is nothing left to lose.
#[tauri::command]
async fn session_busy(state: State<'_, DesktopState>, session: String) -> Result<bool, String> {
    let found = state
        .sessions
        .lock()
        .unwrap()
        .get(&session)
        .map(|found| (found.terminal_id.clone(), found.kind.clone()));
    let Some((terminal_id, kind)) = found else {
        return Ok(false);
    };
    if kind == "sim" || kind == "task" {
        return Ok(true);
    }
    let (pid, foreground) = {
        let terminals = state.terminals.lock().unwrap();
        (
            terminals.pid(&terminal_id),
            terminals.foreground_pid(&terminal_id),
        )
    };
    let Some(pid) = pid else { return Ok(false) };
    // No foreground answer at all (not a unix pty) — nothing left to reason with, so ask.
    let Some(foreground) = foreground else {
        return Ok(true);
    };
    Ok(foreground != pid)
}

/// The live working directory of a pid, or None if it cannot be read.
#[cfg(target_os = "macos")]
fn process_cwd(pid: u32) -> Result<Option<String>, String> {
    // `lsof -Fn` is the one interface that needs no entitlement and no extra crate: -d cwd asks
    // for exactly one descriptor, so this is a single short read, not a scan of every open file.
    let out = crate::platform::command("/usr/sbin/lsof")
        .args(["-a", "-d", "cwd", "-Fn", "-p", &pid.to_string()])
        .output()
        .map_err(|error| error.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout);
    let path = text
        .lines()
        .find(|line| line.starts_with('n'))
        .map(|line| line[1..].to_string())
        .filter(|path| Path::new(path).is_dir());
    Ok(path)
}

#[cfg(target_os = "linux")]
fn process_cwd(pid: u32) -> Result<Option<String>, String> {
    Ok(std::fs::read_link(format!("/proc/{pid}/cwd"))
        .ok()
        .filter(|path| path.is_dir())
        .map(|path| path.to_string_lossy().into_owned()))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn process_cwd(_pid: u32) -> Result<Option<String>, String> {
    Ok(None)
}

/// Close ONE session. Killing a PTY reaps a child process — off the main thread with the rest.
#[tauri::command]
async fn stop_session(state: State<'_, DesktopState>, session: String) -> Result<(), String> {
    let Some(found) = state.sessions.lock().unwrap().remove(&session) else {
        return Ok(());
    };
    if !found.instance.is_empty() {
        state.ingress.unregister_agent(&found.instance);
    }
    // The project's last session gone: nobody is making anything there any more.
    if !state.sessions.lock().unwrap().values().any(|other| other.project == found.project) {
        state.made.unwatch(&found.project);
    }
    // Taken under the lock, ended outside it: ending takes up to a second, and every keystroke
    // in every other terminal waits on this lock from the main thread.
    let closing = state.terminals.lock().unwrap().take(&found.terminal_id);
    if let Some(closing) = closing {
        off_main(move || Ok(closing.end())).await?;
    }
    Ok(())
}

/// IN-MEMORY (a write to the PTY master fd, which a reader thread is always draining). Sync on
/// purpose: this runs on every keystroke, and a runtime hop per keypress buys nothing.
#[tauri::command]
fn write_terminal(
    state: State<'_, DesktopState>,
    terminal_id: String,
    data: String,
) -> Result<(), String> {
    state
        .terminals
        .lock()
        .unwrap()
        .write(&terminal_id, &data)
        .map_err(|error| error.to_string())
}

/// A pasted file is not keystrokes. The webview hands us the clipboard bytes; we park them in
/// $TMPDIR/panel-paste and return the path, which the UI types into the PTY — a file path is the
/// one thing every CLI agent already knows how to read, so this works for claude, codex and grok
/// without any of them needing to know Panel exists.
///
/// `name` is the clipboard's own filename when it had one. It is worth keeping: `diff.patch` and
/// `logo.svg` tell the agent what it is holding, and `paste-<uuid>.bin` tells it nothing. Both
/// name and extension are untrusted strings from the clipboard, so the basename is stripped to
/// safe characters and any path separator in it is dropped — nothing may steer the write out of
/// the paste directory.
#[tauri::command]
async fn save_pasted_file(
    data: String,
    name: Option<String>,
    ext: String,
) -> Result<String, String> {
    off_main(move || save_pasted_file_now(data, name, ext)).await
}

fn save_pasted_file_now(
    data: String,
    name: Option<String>,
    ext: String,
) -> Result<String, String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|error| error.to_string())?;
    let dir = std::env::temp_dir().join("panel-paste");
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let safe = |value: &str, cap: usize| -> String {
        value
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or("")
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                    c
                } else {
                    '-'
                }
            })
            .take(cap)
            .collect()
    };
    let suffix: String = ext
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(8)
        .collect();
    let suffix = if suffix.is_empty() {
        "bin".to_string()
    } else {
        suffix.to_lowercase()
    };
    // Same bytes pasted twice must not collide, so the short id stays even when the name survives.
    let id = uuid_v4();
    let short = &id[..8.min(id.len())];
    let cleaned = name.as_deref().map(|n| safe(n, 60)).unwrap_or_default();
    let cleaned = cleaned.trim_matches(['-', '.']).to_string();
    let file = match cleaned.rsplit_once('.') {
        Some((stem, tail)) if !stem.is_empty() && !tail.is_empty() => {
            format!("{stem}-{short}.{tail}")
        }
        _ if !cleaned.is_empty() => format!("{cleaned}-{short}.{suffix}"),
        _ => format!("paste-{short}.{suffix}"),
    };
    let path = dir.join(file);
    std::fs::write(&path, bytes).map_err(|error| error.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn resize_terminal(
    state: State<'_, DesktopState>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state
        .terminals
        .lock()
        .unwrap()
        .resize(&terminal_id, cols, rows)
        .map_err(|error| error.to_string())
}

/// Async and outside the lock for the same reason as `stop_session`: a sync command runs on the
/// main thread, and ending a process tree there froze the whole window for up to a second.
#[tauri::command]
async fn close_terminal(state: State<'_, DesktopState>, terminal_id: String) -> Result<(), String> {
    let closing = state.terminals.lock().unwrap().take(&terminal_id);
    if let Some(closing) = closing {
        off_main(move || Ok(closing.end())).await?;
    }
    Ok(())
}

/// Run the selected project on a target, hosted in a PTY exactly like a session. Leases the
/// target, boots it when it is a simulator, spawns `flutter run` / a native build / the Godot
/// engine, and streams lifecycle as `sim` status events. Hot reload is later just
/// `write_terminal(id, "r")` — the run is a real interactive process, not a thing we signal.
/// Touches simctl + forks a PTY, so async.
///
/// A sim run is deliberately NOT registered with the ingress: it is not an agent and has nothing to
/// say to the panel, so it must never appear on the hook/MCP router.
///
/// **One run per project.** Running an app that is already running means "show me the one I have",
/// not "install a second copy on a second device", so this returns the LIVE session instead of
/// spending another target on it. That guard lives here rather than in the UI because Rust owns
/// the live set: a reloaded webview has forgotten what is running, and it is precisely then that a
/// Run click used to fork a duplicate whose device nobody could give back. Two things override it,
/// both because a human asked out loud: `extra_instance` opens a genuine second copy elsewhere,
/// and `restart` replaces the run in place on the target it already holds.
///
/// **Every run holds a lease.** Not only simulator runs — Chrome and the Mac are single-occupancy
/// too, and the screenshot pipeline leases out of the same file (see `leases.rs`). That is what
/// lets a capture batch run while you debug: it cannot be handed a device you are holding.
#[tauri::command]
async fn start_sim(
    app: AppHandle,
    state: State<'_, DesktopState>,
    project: String,
    // `device` is a target ADDRESS (`ipad:<udid>`, `chrome`, …), not a bare udid — None lets Auto
    // decide. `restart` replaces the live run instead of raising it; that is what ⌘R means.
    device: Option<String>,
    allow_extra: Option<bool>,
    extra_instance: Option<bool>,
    restart: Option<bool>,
    // Wipe the app off the simulator before it is reinstalled, so the run starts from a first
    // launch. Only ⌘⇧R asks for it; a caller that says nothing keeps the app's data.
    fresh: Option<bool>,
    cols: u16,
    rows: u16,
) -> Result<SimStart, String> {
    let id = project.clone();
    let found = off_main(move || find_project(&id)).await?;
    if found.role == ProjectRole::Collection {
        return Err(format!("project {} is a collection", found.id));
    }
    if !found.exists {
        return Err(format!(
            "project folder is missing: {}",
            found.path.display()
        ));
    }
    let allow_extra = allow_extra.unwrap_or(false);
    let extra_instance = extra_instance.unwrap_or(false);
    let restart = restart.unwrap_or(false);
    let fresh = fresh.unwrap_or(false);
    let cap = max_sims();

    // Already live for this app. Three different things can be meant by "run it":
    //   restart  — replace it, on the target it is already on. This is ⌘R.
    //   extra    — leave it alone and open another copy somewhere else.
    //   neither  — show me the one I have, and raise its window.
    // A restart pins the target: the point is to rebuild *this* run, and letting Auto re-pick
    // would silently move the app to another device mid-debug.
    let mut pinned: Option<String> = None;
    // The replaced run's simulator, when Panel booted it: (address, udid). Panel still owes that
    // memory back, so the ownership moves to the new run instead of being lost with the old one.
    let mut inherited: Option<(String, String)> = None;
    if !extra_instance {
        let live = state
            .sims
            .lock()
            .unwrap()
            .iter()
            .find(|(_, meta)| meta.project == project)
            .map(|(session_id, meta)| {
                (
                    session_id.clone(),
                    meta.kind,
                    meta.device.clone(),
                    meta.device_id.clone(),
                    meta.address.clone(),
                )
            });
        if let Some((session_id, run_kind, device_name, device_id, address)) = live {
            // Cloned out of the lock: the kind sniff below awaits, and a guard may not cross that.
            let existing = state.sessions.lock().unwrap().get(&session_id).cloned();
            match existing {
                Some(session) if restart => {
                    // Untrack the old run BEFORE reaping its PTY. The sink cleans up a run it still
                    // tracks, and for a simulator Panel booted that means shutting it down, which
                    // here would cold-boot the same device a second later. When that shutdown lost
                    // the race, the new run saw a booted device, decided somebody else owned it,
                    // and its Stop left the simulator running.
                    let terminal_id = session.terminal_id.clone();
                    let meta = state.sims.lock().unwrap().remove(&session_id);
                    let closing = state.terminals.lock().unwrap().take(&terminal_id);
                    let ended = match closing {
                        Some(closing) => off_main(move || Ok(closing.end())).await,
                        None => Ok(()),
                    };
                    // Handed back only now that the old process is gone: the lease must be free at
                    // the moment we re-take it, and not a moment while the corpse still holds it.
                    // The run is already untracked, so a failed reap still pays what it owed:
                    // nothing else would ever release this lease or shut this device.
                    if let Some(meta) = meta {
                        leases::release_owner(&meta.owner);
                        if meta.booted_by_us && !meta.device_id.is_empty() {
                            if ended.is_err() {
                                release_device(&meta.address, &meta.device_id);
                            } else {
                                inherited = Some((meta.address, meta.device_id));
                            }
                        }
                    }
                    ended?;
                    state.sessions.lock().unwrap().remove(&session_id);
                    event_sink(&app)(sim::status_event(
                        &project,
                        &session_id,
                        &device_name,
                        &address,
                        run_kind,
                        "stopped",
                        None,
                        &terminal_id,
                    ));
                    pinned = Some(address);
                }
                Some(session) => {
                    if !device_id.is_empty() {
                        focus_target(&address);
                    }
                    let root = found.path.clone();
                    let kind =
                        off_main(move || Ok(sim::kind_of(&root).unwrap_or("flutter").to_string()))
                            .await?;
                    return Ok(SimStart {
                        session,
                        adopted: true,
                        device: device_name,
                        address,
                        kind,
                    });
                }
                // A tracked run whose session vanished is bookkeeping, not a run. Drop it, hand
                // the lease back, and launch.
                None => {
                    if let Some(meta) = state.sims.lock().unwrap().remove(&session_id) {
                        leases::release_owner(&meta.owner);
                    }
                }
            }
        }
    }

    // Lease owner. The project id is the address of its one run; an extra instance gets a suffix
    // so the two hold distinct leases and stopping one never releases the other's device.
    let owner = if extra_instance {
        format!("{project}#{}", &uuid_v4()[..8])
    } else {
        project.clone()
    };

    // Resolve the target. An explicit address is honoured as given — an out-loud choice is allowed
    // to do what Auto refuses to guess at. Auto goes back to the device this app is installed on,
    // worked out from the devices at this moment rather than from a remembered list, and only
    // reaches for a free one when the app is nowhere yet.
    let root = found.path.clone();
    let wanted = device.or(pinned);
    let owner_for_pick = owner.clone();
    let (mut target, kind) = off_main(move || {
        let kind = sim::kind_of(&root).ok_or_else(|| {
            "not a Flutter, native iOS, native Android, or Godot project".to_string()
        })?;
        let families = targets::families_for(&root, kind);
        let target = match wanted {
            Some(address) => {
                if !families.contains(&targets::family_of(&address).as_str()) {
                    return Err(format!("this project cannot run on {}", targets::family_of(&address)));
                }
                targets::resolve(&root, &address, &owner_for_pick)?
            }
            None => auto_target(
                &root,
                kind,
                &families,
                &owner_for_pick,
                extra_instance,
                allow_extra,
                cap,
            )?,
        };
        Ok::<_, String>((target, kind))
    })
    .await?;

    // A device Panel starts is a device Panel owes back. One that was already up belongs to
    // whoever had it, and tidying somebody else's desk is not this program's job. A restart on
    // the device the old run booted inherits that debt. A restart that moved elsewhere pays it
    // now, or the old simulator would stay up with nobody owing it.
    let inherited = match inherited {
        Some((address, _)) if address == target.id => true,
        Some((address, device_id)) => {
            let still_used = state
                .sims
                .lock()
                .unwrap()
                .values()
                .any(|other| other.device_id == device_id);
            if !still_used {
                release_device(&address, &device_id);
            }
            false
        }
        None => false,
    };
    let booted_by_us = inherited || (boots_devices(&target.family) && !target.booted);

    // Claim it before anything is booted or spawned. A capture batch asking for a device at this
    // instant must be told this one is taken, not handed it — and an Android cold boot is minutes
    // long, which is a very long window to leave the device unclaimed in.
    leases::take(
        &target.id,
        &owner,
        "interactive",
        &target.family,
        &target.name,
        booted_by_us,
    )?;

    // Bring the device up. This happens BEFORE the run plan is built, because a powered-off AVD
    // has no serial to hand `flutter -d` — its address names the AVD, and `android::boot` is what
    // turns that into the id the toolchain wants. Booting can fail, and a failure here must hand
    // the lease straight back or the device stays claimed by a run that never started.
    let boot = match target.family.as_str() {
        "iphone" | "ipad" => {
            let udid = target.device.clone();
            off_main(move || sim::ensure_booted(&udid))
                .await
                .map(|()| None)
        }
        "android" => {
            let address = target.id.clone();
            off_main(move || android::boot(&address)).await.map(Some)
        }
        _ => Ok(None),
    };
    match boot {
        Ok(Some(serial)) => target.device = serial,
        Ok(None) => {}
        Err(error) => {
            abandon_start(&owner, booted_by_us, &target.id, &target.device);
            return Err(error);
        }
    }

    // Fresh run: throw the old container away now that the device is up and before the run
    // installs over it. Only for simulators — a real phone or somebody's Chrome profile is not
    // ours to wipe — and only for the app being run, never the whole device.
    if fresh && matches!(target.family.as_str(), "iphone" | "ipad") {
        let root = found.path.clone();
        let udid = target.device.clone();
        let _ = off_main(move || {
            sim::uninstall_app(&udid, &root);
            Ok::<_, String>(())
        })
        .await;
    }

    let plan_root = found.path.clone();
    let plan_device = target.device.clone();
    let plan_family = target.family.clone();
    let run = match off_main(move || sim::plan(&plan_root, &plan_device, &plan_family)).await {
        Ok(run) => run,
        Err(error) => {
            abandon_start(&owner, booted_by_us, &target.id, &target.device);
            return Err(error);
        }
    };

    // No raise here. The device comes forward once, when the app is running on it (the sink
    // below). Raising at the start too pulled the device in front of the human for the whole
    // build, and on Xcode 27 it was the wrong device.

    let session_id = uuid_v4();
    let run_kind = run.kind;
    let device_name = target.name.clone();
    let _ = kind;
    // A server run's payoff is a page, not a window. Work the URL out now, while the manifest is
    // already in hand, so the sink only has to decide WHEN to open it.
    let serve_url = if target.family == "localhost" {
        let root = found.path.clone();
        off_main(move || Ok(sim::server_spec(&root).map(|spec| sim::server_url(&spec)))).await?
    } else {
        None
    };

    // The sink mirrors bytes, emits lifecycle state, raises Simulator after reload/restart, and
    // releases the device when the process exits.
    let term_app = app.clone();
    let status_sink = event_sink(&app);
    let sims = state.sims.clone();
    let proj = project.clone();
    let sid = session_id.clone();
    // The child can print before `spawn` returns its terminal id. Hold those first chunks until the
    // initial lifecycle event has taught the UI which project owns that terminal; otherwise the
    // beginning of every build log is silently discarded.
    let startup_output = Arc::new(Mutex::new((false, Vec::<TerminalChunk>::new())));
    let sink_startup_output = startup_output.clone();
    // One raise per run, ever. `running` re-prints on a hot restart ("Syncing files to device"),
    // and a second raise there is the focus theft this flag exists to prevent.
    let raised = Arc::new(AtomicBool::new(false));
    let sink_url = serve_url.clone();
    let sink_address = target.id.clone();
    let sink: TerminalSink = Arc::new(move |chunk: TerminalChunk| {
        {
            let mut startup = sink_startup_output.lock().unwrap();
            if !startup.0 {
                startup.1.push(chunk);
                return;
            }
        }
        let data = chunk.data.clone();
        let tid = chunk.terminal_id.clone();
        let closed = chunk.closed;
        let _ = term_app.emit(RUN_OUTPUT_EVENT, chunk);
        if closed {
            // Natural end (crash, `q`, or Stop): report it, hand the lease back, and shut the
            // simulator down when no other run uses it AND we were the ones who booted it. That
            // release is what advances the UI's oldest queued project — and what lets a capture
            // batch that queued behind this run finally get a device.
            let gone = sims.lock().ok().and_then(|mut map| map.remove(&sid));
            if let Some(meta) = gone {
                status_sink(sim::status_event(
                    &proj,
                    &sid,
                    &meta.device,
                    &meta.address,
                    run_kind,
                    "stopped",
                    None,
                    &tid,
                ));
                leases::release_owner(&meta.owner);
                let still_used = sims
                    .lock()
                    .map(|map| map.values().any(|other| other.device_id == meta.device_id))
                    .unwrap_or(false);
                if meta.booted_by_us && !still_used {
                    release_device(&meta.address, &meta.device_id);
                }
            }
            return;
        }
        if let Some((next, ms)) = sim::parse_status(&data) {
            // The first "running" of an explicitly started run puts its result in front of the
            // human — the Simulator window for a device run, the page for a server. A hot reload
            // or restart must never do it again: the human is typing somewhere else, and a window
            // that jumps in front on every file save is a hijack, not a courtesy.
            if next == "running" && !raised.swap(true, Ordering::SeqCst) {
                if let Some(url) = sink_url.as_deref() {
                    open_url(url);
                } else {
                    focus_target(&sink_address);
                }
            }
            status_sink(sim::status_event(
                &proj,
                &sid,
                &device_name,
                &sink_address,
                run_kind,
                next,
                ms,
                &tid,
            ));
        }
    });

    // A run has no terminal pane to answer ConPTY's cursor query, so the PTY answers it itself.
    let spec = SpawnSpec::shell(&run.cwd, cols, rows)
        .run(run.program.clone(), run.args.clone())
        .answering_cursor_query();
    let spawned = state.terminals.lock().unwrap().spawn(spec, sink.clone());
    let terminal_id = match spawned {
        Ok(terminal_id) => terminal_id,
        Err(error) => {
            abandon_start(&owner, booted_by_us, &target.id, &target.device);
            return Err(error.to_string());
        }
    };

    // Track the run so its device can be released when the PTY ends, and so a later Run on this
    // app finds it instead of opening a second device.
    state.sims.lock().unwrap().insert(
        session_id.clone(),
        sim::SimMeta {
            project: project.clone(),
            kind: run_kind,
            device: target.name.clone(),
            // Empty for a run with no device behind it. Cleanup keys the shutdown off this, so
            // Chrome and Godot correctly have nothing to shut down.
            device_id: if boots_devices(&target.family) {
                target.device.clone()
            } else {
                String::new()
            },
            address: target.id.clone(),
            owner: owner.clone(),
            booted_by_us,
        },
    );

    // Seat numbers count LIVE runs, not every sim session this project has ever had. Ended runs
    // linger in `sessions` as transcripts, and counting those is what used to label a project's
    // one and only run "sim 4".
    let seat = 1 + state
        .sims
        .lock()
        .unwrap()
        .iter()
        .filter(|(id, meta)| meta.project == project && id.as_str() != session_id.as_str())
        .count();
    let title = if seat == 1 {
        "sim".to_string()
    } else {
        format!("sim {seat}")
    };

    let session = Session {
        id: session_id,
        project: project.clone(),
        kind: "sim".to_string(),
        title,
        terminal_id,
        cwd: run.cwd.clone(),
        instance: String::new(),
    };
    state
        .sessions
        .lock()
        .unwrap()
        .insert(session.id.clone(), session.clone());

    // Paint the card immediately, before the first build line arrives.
    event_sink(&app)(sim::status_event(
        &project,
        &session.id,
        &target.name,
        &target.id,
        run_kind,
        "launching",
        None,
        &session.terminal_id,
    ));

    // Flip atomically with taking the backlog, then replay through the normal sink so terminal
    // output, status parsing, and close cleanup all keep one code path.
    let buffered = {
        let mut startup = startup_output.lock().unwrap();
        startup.0 = true;
        std::mem::take(&mut startup.1)
    };
    for chunk in buffered {
        sink(chunk);
    }
    Ok(SimStart {
        session,
        adopted: false,
        device: target.name,
        address: target.id,
        kind: run_kind.to_string(),
    })
}

/// A start that failed after taking its lease. The lease goes back, and so does a device this
/// start booted: nothing will ever run on it, so nothing would ever shut it down. The PTY spawn
/// failing used to skip both, holding the lease until Panel quit.
fn abandon_start(owner: &str, booted_by_us: bool, address: &str, device_id: &str) {
    leases::release_owner(owner);
    if booted_by_us {
        release_device(address, device_id);
    }
}

/// Does this family have a device Panel turns on and off? The three questions that used to be
/// spelled `matches!(family, "iphone" | "ipad")` all over this file are now these three helpers,
/// because Android answers each of them differently and a literal repeated in three places is a
/// literal that gets updated in two.
fn boots_devices(family: &str) -> bool {
    matches!(family, "iphone" | "ipad" | "android")
}

/// Put the device a run lands on in front of the human: Simulator.app for iOS, the emulator
/// window for an Android emulator. A phone is already in front of them, and Chrome, the Mac and
/// Godot each raise their own window — raising anything for those would shove the thing the human
/// asked to see behind something unrelated.
fn focus_target(address: &str) {
    match targets::family_of(address).as_str() {
        "iphone" | "ipad" => {
            sim::focus_simulator(address.split_once(':').map(|(_, udid)| udid).unwrap_or(""))
        }
        "android" if android::is_emulator_address(address) => android::focus(),
        _ => {}
    }
}

/// Hand a device's memory back. Only ever called for a device Panel itself booted, and never for
/// a phone — `android::shutdown_now` refuses a serial that is not an emulator's, so an actual
/// handset cannot be powered down by this path even by mistake.
fn release_device(address: &str, device_id: &str) {
    match targets::family_of(address).as_str() {
        "iphone" | "ipad" => sim::shutdown_device(device_id),
        "android" => android::shutdown(device_id),
        _ => {}
    }
}

/// What a Run request produced. `adopted` means nothing was started: the app was already running
/// on its own device, and this is that run — which is also how a reloaded UI recovers the truth
/// about what it is looking at.
#[derive(serde::Serialize)]
struct SimStart {
    session: Session,
    adopted: bool,
    device: String,
    /// The target address this run holds. The UI needs it to know whether raising a window is a
    /// courtesy (a simulator, an emulator) or a no-op (a phone, Chrome, the Mac).
    address: String,
    kind: String,
}

/// Which target this project runs on when the human did not name one.
///
/// 1. **The device it is already installed on.** Same device, same login, same simulated photo
///    library. An app keeps its simulator, and that is derived from the installs rather than from
///    a stored binding, so it stops being true the moment the app is no longer there.
/// 2. Otherwise a free target of the project's first family — a phone for an app, the desktop for
///    a Godot game. `free_in_family` prefers a powered-off device, because taking an idle one
///    costs nobody their session.
/// 3. Otherwise, over the cap, a decision rather than an eviction: report capacity so the UI can
///    offer Queue or an explicit "Open another".
///
/// An extra instance skips step 1 on purpose. Landing on the app's own device would install over
/// the instance already there, which is the opposite of what a second copy is for.
fn auto_target(
    root: &std::path::Path,
    kind: &str,
    families: &[&'static str],
    owner: &str,
    extra_instance: bool,
    allow_extra: bool,
    cap: usize,
) -> Result<targets::Target, String> {
    let home_family = families.first().copied().unwrap_or("iphone");
    // A dev server has exactly one address, pinned by its manifest. There is nothing to pick and
    // nothing to clone; if the port is taken, that is a real collision and the caller must hear it.
    if home_family == "localhost" {
        return targets::resolve(root, "localhost", owner);
    }
    if !extra_instance {
        for candidate in targets::list_for(root, kind, owner) {
            if candidate.owns && candidate.held_by.is_none() {
                return Ok(candidate);
            }
        }
    }
    if let Some(free) = targets::free_in_family(home_family, owner) {
        // Only a cold VIRTUAL device costs a seat. Chrome, the Mac, an already-booted device and a
        // phone on the desk do not spin up a virtual machine, so the ceiling has no business
        // stopping them.
        let costs_a_seat = !free.booted && virtual_device(&free.id);
        if costs_a_seat && !allow_extra {
            capacity_check(cap)?;
        }
        return Ok(free);
    }
    if !matches!(home_family, "iphone" | "ipad") {
        // Only the iOS families can be widened by cloning a device. Everywhere else, nothing free
        // means either "somebody has it" or "there is nothing to have", and those are different
        // problems: one is solved by stopping a run, the other by creating a device.
        if home_family == "android" && targets::android_devices().is_empty() {
            return Err(
                "no Android device or emulator is available — plug a phone in, or create an AVD \
                 in Android Studio's Device Manager"
                    .to_string(),
            );
        }
        return Err(format!("{home_family} is already in use"));
    }
    if !allow_extra {
        capacity_check(cap)?;
    }
    // Every device of the family is leased and the human has said yes to another. Clone one
    // rather than evict somebody.
    let device = sim::clone_device()?;
    Ok(targets::Target {
        id: format!("{home_family}:{}", device.udid),
        family: home_family.to_string(),
        name: device.name.clone(),
        runtime: device.runtime.clone(),
        booted: device.booted,
        device: device.udid,
        held_by: None,
        held_kind: None,
        owns: false,
    })
}

/// Is this address a virtual machine's worth of memory? An iOS simulator always is. Android is
/// the family where it depends: `android:@Pixel_7` is an emulator, `android:R5CT30ABCDE` is a
/// phone on the desk, and rationing somebody's phone would be absurd.
fn virtual_device(address: &str) -> bool {
    match targets::family_of(address).as_str() {
        "iphone" | "ipad" => true,
        "android" => android::is_emulator_address(address),
        _ => false,
    }
}

/// Refuse a new virtual device when the machine already has `cap` of them open, naming how many
/// of those nobody is using. The UI turns `SIM_CAPACITY|open|cap|idle` into the capacity row,
/// whose first answer is to shut the idle ones down.
///
/// Open means leased OR booted. Leases cover runs, debug sessions and capture batches, including
/// a device leased and still booting. A booted simulator with no lease is usually one an agent
/// booted for a screenshot and left up. Counting only leases let those pile up unseen: two of
/// them held five gigabytes while the cap still said there was room for four more.
///
/// Emulators count through their leases. They are the heaviest thing Run can start, and a
/// ceiling that ignored them would let two simulators and four emulators all be within the cap.
fn capacity_check(cap: usize) -> Result<(), String> {
    let held = leases::held();
    let leased = held.keys().filter(|address| virtual_device(address)).count();
    let idle = targets::idle_simulators(&sim::list_devices(), &held).len();
    if leased + idle >= cap {
        return Err(format!("SIM_CAPACITY|{}|{cap}|{idle}", leased + idle));
    }
    Ok(())
}

/// The number of simulator leases Panel recommends at once. It is a soft ceiling: reaching it
/// offers Queue or an explicit Open another choice instead of killing somebody else's run.
/// Four fits because runs slim their simulator on first boot (`sim::slim_preamble`), ~1.2GB each.
fn max_sims() -> usize {
    std::env::var("PANEL_MAX_SIMS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|n| *n >= 1)
        .unwrap_or(4)
}

/// Shut down every simulator nobody holds — the Run screen's "Shut down idle", and the capacity
/// row's answer to "too many open". Waited on, so the inventory read right after it is true.
///
/// The lease file is read again per device, just before its shutdown, so a capture batch that
/// took one a moment ago keeps it.
#[tauri::command]
async fn close_idle_sims() -> Result<usize, String> {
    off_main(|| {
        let idle = targets::idle_simulators(&sim::list_devices(), &leases::held());
        let closing: Vec<_> = idle
            .into_iter()
            .map(|device| {
                std::thread::spawn(move || {
                    let still_idle = targets::idle_simulators(
                        std::slice::from_ref(&device),
                        &leases::held(),
                    );
                    if still_idle.is_empty() {
                        return false;
                    }
                    sim::shutdown_device_now(&device.udid);
                    true
                })
            })
            .collect();
        // One thread per device: a shutdown takes a second or two, and they do not share one.
        Ok(closing
            .into_iter()
            .filter_map(|thread| thread.join().ok())
            .filter(|closed| *closed)
            .count())
    })
    .await
}

/// Simulator inventory for the Run screen. simctl subprocess -> off the main thread.
#[tauri::command]
async fn list_simulators() -> Result<Vec<sim::SimDevice>, String> {
    off_main(|| Ok(sim::list_devices())).await
}

/// Who holds what, across every family. The workspace build bar reads this to say why a device is
/// unavailable — "Tavla is capturing on it" beats a greyed-out row with no explanation.
#[tauri::command]
async fn device_leases() -> Result<std::collections::BTreeMap<String, leases::Lease>, String> {
    off_main(|| Ok(leases::held())).await
}

/// Attached Android devices and running emulators, portfolio-wide.
///
/// Separate from `list_simulators` because it shells out to `adb`, which is not installed on every
/// machine and answers in its own time. The Run screen asks for both together and merges them; it
/// cannot run `adb` itself, and a family offered with nothing in it is a dead row.
#[tauri::command]
async fn android_targets() -> Result<Vec<targets::Target>, String> {
    off_main(|| Ok(targets::android_devices())).await
}

/// One project Run can actually launch, how, and which simulator it is currently on.
#[derive(serde::Serialize)]
struct SimTarget {
    project: String,
    kind: String,
    /// The name of the simulator this app is installed on right now, empty when it is on none.
    /// Auto says this out loud so it reads as "back to its device" rather than "some free device" —
    /// and because it is derived, it stops saying it the moment the app is no longer there.
    device: String,
    /// The Android device or emulator this app is installed on right now, by ADDRESS, empty when
    /// it is on none. An address rather than a name because that is what the picker keys on, and
    /// because two emulators can share a model name where they cannot share an AVD.
    #[serde(rename = "androidDevice")]
    android_device: String,
    /// Which families this project can be launched on: `iphone`, `ipad`, `chrome`, `macos`,
    /// `android`, `desktop`. The picker offers exactly these and nothing else.
    families: Vec<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RunInventory {
    devices: Vec<sim::SimDevice>,
    leases: std::collections::BTreeMap<String, leases::Lease>,
    android_devices: Vec<targets::Target>,
    ios_devices: Vec<targets::Target>,
    targets: Vec<SimTarget>,
    /// Udids of booted simulators nobody holds (`targets::idle_simulators`). The Run screen
    /// offers to shut these down; it never decides for itself which devices are idle.
    idle: Vec<String>,
}

fn sim_targets_from(
    devices: &[sim::SimDevice],
    android_targets: &[targets::Target],
) -> Vec<SimTarget> {
    let installed: Vec<(String, std::collections::HashSet<String>)> = android_targets
        .iter()
        .filter(|target| target.booted && !target.device.is_empty())
        .map(|target| (target.id.clone(), android::packages(&target.device)))
        .collect();
    let runnable: Vec<_> = all_projects()
        .into_iter()
        .filter(|project| project.exists && project.role == ProjectRole::Leaf)
        .filter_map(|project| {
            let kind = sim::kind_of(&project.path)?;
            let families = targets::families_for(&project.path, kind);
            let ios_bundle = families
                .iter()
                .any(|family| matches!(*family, "iphone" | "ipad"))
                .then(|| sim::bundle_id(&project.path))
                .flatten();
            let android_package = families
                .contains(&"android")
                .then(|| android::application_id(&project.path))
                .flatten();
            Some((
                project.id,
                kind.to_string(),
                families.into_iter().map(str::to_string).collect::<Vec<_>>(),
                ios_bundle,
                android_package,
            ))
        })
        .collect();
    let bundles = runnable
        .iter()
        .filter_map(|(_, _, _, bundle, _)| bundle.clone())
        .collect();
    let owners = sim::device_owners(devices, &bundles);

    runnable
        .into_iter()
        .map(|(project, kind, families, ios_bundle, android_package)| {
            let device = ios_bundle
                .and_then(|bundle| owners.get(&bundle))
                .map(|device| device.name.clone())
                .unwrap_or_default();
            let android_device = android_package
                .and_then(|package| {
                    installed
                        .iter()
                        .find(|(_, packages)| packages.contains(&package))
                        .map(|(address, _)| address.clone())
                })
                .unwrap_or_default();
            SimTarget {
                project,
                kind,
                device,
                android_device,
                families,
            }
        })
        .collect()
}

/// One portfolio scan for the Run screen. Devices, leases, and project bindings describe one
/// moment and share their expensive inventories instead of starting four overlapping commands.
#[tauri::command]
async fn run_inventory() -> Result<RunInventory, String> {
    off_main(|| {
        let devices = sim::list_devices();
        let android_devices = targets::android_devices();
        let ios_devices = targets::ios_devices();
        let targets = sim_targets_from(&devices, &android_devices);
        let leases = leases::held();
        let idle = targets::idle_simulators(&devices, &leases)
            .into_iter()
            .map(|device| device.udid)
            .collect();
        Ok(RunInventory {
            devices,
            leases,
            android_devices,
            ios_devices,
            targets,
            idle,
        })
    })
    .await
}

/// Which projects the Run screen may show. Most of the portfolio is not an iOS app, and a card
/// that can only fail is worse than no card — so runnability is decided here, by the same
/// detection that builds the run plan, rather than guessed at in the UI.
#[tauri::command]
async fn sim_targets() -> Result<Vec<SimTarget>, String> {
    off_main(move || {
        let devices = sim::list_devices();
        let android_devices = targets::android_devices();
        Ok(sim_targets_from(&devices, &android_devices))
    })
    .await
}

/// Bring a run's device window to the front on demand — the Focus button, and the header's
/// "Show device". Given a target address it raises the right thing for that family; given none it
/// falls back to Simulator.app, which is what a caller with no run in hand means.
///
/// Both paths dispatch their subprocess to a throwaway thread, so this returns instantly and
/// stays a cheap in-memory sync command.
#[tauri::command]
fn sim_focus(address: Option<String>) {
    match address {
        Some(address) if !address.is_empty() => focus_target(&address),
        _ => sim::focus_simulator(""),
    }
}

/// Open a URL in the human's default browser. `open` respects whatever they actually use; hard
/// coding Chrome would be Panel deciding on their behalf. Fire-and-forget on a throwaway thread,
/// so a slow browser launch never stalls the PTY reader that asked for it.
fn open_url(url: &str) {
    // Only ever our own localhost URLs, but the guard is cheap and the alternative is a shell
    // argument built from a file somebody edited.
    if !url.starts_with("http://localhost:") && !url.starts_with("http://127.0.0.1:") {
        return;
    }
    let url = url.to_string();
    std::thread::spawn(move || {
        let _ = platform::open(&url).status();
    });
}

/// A web link the human clicked: ⌘-click in a terminal, a link in a report. The URL is untrusted
/// (any program can print one), and `open` would just as happily launch a file:// path or an
/// app's own scheme, so only plain http(s) with no spaces or control characters gets through.
/// One argument, no shell, so nothing in it can become an option or a command.
fn web_link(url: &str) -> bool {
    let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"));
    rest.is_some_and(|host| !host.is_empty())
        && url.len() <= 4096
        && !url.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// The clipboard's text, for the terminal's right-click Paste. A page reading the clipboard
/// itself gets WebKit's own "Paste" bubble in the way, one extra click per paste.
#[tauri::command]
async fn clipboard_text() -> Result<String, String> {
    off_main(|| {
        let out = crate::platform::command("pbpaste")
            .output()
            .map_err(|error| format!("could not read the clipboard: {error}"))?;
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    })
    .await
}

#[tauri::command]
fn open_link(url: String) -> Result<(), String> {
    if !web_link(&url) {
        return Err("Only web links open from here.".into());
    }
    std::thread::spawn(move || {
        let _ = platform::open(&url).status();
    });
    Ok(())
}

/// Open the page a running server is serving, on demand. The card's "Open" button — the same door
/// the first "running" line opens automatically, for when the human closed the tab.
#[tauri::command]
async fn open_server(project: String) -> Result<(), String> {
    let found = off_main(move || find_project(&project)).await?;
    let spec = off_main(move || Ok(sim::server_spec(&found.path))).await?;
    let spec = spec.ok_or_else(|| "this project has no server block in appgea.json".to_string())?;
    open_url(&sim::server_url(&spec));
    Ok(())
}

/// Hand a file to the OS. Video is the reason this exists: Panel will not play a clip inline,
/// so "watch it" has to mean the real player, with a scrubber and a volume control.
/// The files a report names, as Review keeps them — so its Review button opens exactly those,
/// including one the watcher has not settled yet or one made before any session was open.
/// Anything missing, outside the project, or not a picture, sound or video is left out.
#[tauri::command]
async fn made_entries(project: String, paths: Vec<String>) -> Result<Vec<made::Made>, String> {
    off_main(move || {
        let root = find_project(&project)?.path;
        Ok(paths
            .iter()
            .filter_map(|path| confine(&root, path).ok())
            .filter_map(|file| made::describe(&project, &file))
            .collect())
    })
    .await
}

#[tauri::command]
async fn open_media(project: String, path: String) -> Result<(), String> {
    off_main(move || {
        let file = confine(&find_project(&project)?.path, &path)?;
        if !file.is_file() {
            return Err(format!("not a file: {}", file.display()));
        }
        #[cfg(target_os = "macos")]
        let mut command = crate::platform::command("open");
        #[cfg(target_os = "windows")]
        let mut command = crate::platform::command("explorer");
        #[cfg(all(unix, not(target_os = "macos")))]
        let mut command = crate::platform::command("xdg-open");
        command
            .arg(&file)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map(|_| ())
            .map_err(|error| error.to_string())
    })
    .await
}

/// The human declined the shutdown warning. A later close attempt must be allowed to ask again.
#[tauri::command]
fn cancel_shutdown(state: State<'_, DesktopState>) {
    state.shutdown_prompt_pending.store(false, Ordering::SeqCst);
}

/// The only guarded exit path. Remove routing first, reap every PTY, then mark the subsequent
/// programmatic exit as approved. There is no interval where Panel is gone but its session map
/// still claims the children are usable.
#[tauri::command]
async fn shutdown_panel(app: AppHandle, state: State<'_, DesktopState>) -> Result<(), String> {
    // First, while every PTY is still open and its screen still readable. Nothing below this
    // line can be undone, so nothing below this line is a place to remember things from.
    save_wall(&app, &state);
    let sessions: Vec<Session> = state.sessions.lock().unwrap().values().cloned().collect();
    for session in &sessions {
        if !session.instance.is_empty() {
            state.ingress.unregister_agent(&session.instance);
        }
    }
    // Taken under the lock, then ended all at once. One at a time, each session's grace period
    // stacked: quitting with nine agents open could take nine seconds.
    let closing: Vec<_> = {
        let mut terminals = state.terminals.lock().unwrap();
        sessions
            .iter()
            .filter_map(|session| terminals.take(&session.terminal_id))
            .collect()
    };
    off_main(move || {
        let ending: Vec<_> = closing
            .into_iter()
            .map(|closing| std::thread::spawn(move || closing.end()))
            .collect();
        for thread in ending {
            let _ = thread.join();
        }
        Ok(())
    })
    .await?;
    state.sessions.lock().unwrap().clear();

    // DAP adapters are pipe-hosted rather than PTYs. Stop them through their own owner before
    // device cleanup, so no debugger survives Panel or keeps a simulator lease behind.
    let debugger = state.debugger.clone();
    off_main(move || debugger.stop_all()).await?;

    // Give the devices back, and WAIT for it. Each run's own cleanup fires on a throwaway thread
    // that `app.exit` below would kill mid-`simctl`, which is how quitting Panel used to leave a
    // booted device per app behind, holding gigabytes for nobody. Emulators go the same way, and
    // an emulator is the more expensive one to forget.
    //
    // Only devices Panel booted: a simulator or emulator the human already had up is theirs, and
    // quitting Panel is not a reason to close somebody else's window.
    let devices: Vec<(String, String)> = {
        let mut sims = state.sims.lock().unwrap();
        let mut owed: Vec<(String, String)> = sims
            .values()
            .filter(|meta| meta.booted_by_us && !meta.device_id.is_empty())
            .map(|meta| (meta.address.clone(), meta.device_id.clone()))
            .collect();
        sims.clear();
        owed.sort();
        owed.dedup();
        owed
    };
    if !devices.is_empty() {
        off_main(move || {
            for (address, device_id) in devices {
                match targets::family_of(&address).as_str() {
                    "android" => android::shutdown_now(&device_id),
                    _ => sim::shutdown_device_now(&device_id),
                }
            }
            Ok::<(), String>(())
        })
        .await?;
    }

    state.shutdown_approved.store(true, Ordering::SeqCst);
    state.shutdown_prompt_pending.store(false, Ordering::SeqCst);
    app.exit(0);
    Ok(())
}

/// Answer an open question. This unblocks the agent's MCP tool call, which is still parked
/// on a request thread inside the ingress waiting for exactly this.
#[tauri::command]
fn answer_ask(state: State<'_, DesktopState>, qid: String, value: Value) -> bool {
    state.ingress.answer(&qid, value)
}

/// One new reason to look at Panel. `urgent` is an agent parked on you; a finished turn is not.
#[derive(serde::Deserialize)]
struct Attention {
    title: String,
    body: String,
    urgent: bool,
}

/// The dock badge always tracks the count. The alert fires only when Panel is not the window
/// you are looking at: a banner about the screen in front of you is noise.
#[tauri::command]
fn set_attention(app: AppHandle, count: u32, alert: Option<Attention>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.set_badge_count((count > 0).then_some(i64::from(count)));
    let Some(alert) = alert else {
        return;
    };
    if window.is_focused().unwrap_or(false) {
        return;
    }
    if alert.urgent {
        let _ = window.request_user_attention(Some(tauri::UserAttentionType::Informational));
    }
    let _ = app.notification().builder().title(alert.title).body(alert.body).show();
}

/// Memory-only replay history. Reading it must be cheaper than opening the file it describes.
#[tauri::command]
fn file_changes(state: State<'_, DesktopState>, project: String, path: String) -> Vec<ChangeStep> {
    state.ingress.file_changes(&project, &path)
}

/// Files connected to the open file by an import/path edge or a type-use edge. This is computed
/// off the UI thread and confined to the selected project like every editor file operation.
#[tauri::command]
async fn file_relationships(
    project: String,
    path: String,
) -> Result<Vec<code_nav::FileRelation>, String> {
    off_main(move || {
        let root = find_project(&project)?.path;
        let file = confine(&root, &path)?;
        code_nav::relationships(&root, &file)
    })
    .await
}

/// Parse the project for the Related row before the first file opens. Cheap to repeat: only
/// changed files are read again.
#[tauri::command]
async fn warm_code_nav(project: String) -> Result<(), String> {
    off_main(move || {
        let root = find_project(&project)?.path;
        code_nav::warm(&root)
    })
    .await
}

/// Every file in the project, relative paths, for ⌘P and the navigator filter.
#[tauri::command]
async fn project_files(project: String) -> Result<Vec<String>, String> {
    off_main(move || {
        let root = find_project(&project)?.path;
        Ok(code_nav::list_files(&root))
    })
    .await
}

/// Best-effort cross-language definition lookup for Command-click navigation. Exact definition
/// syntax is preferred; ambiguous matches are returned for the UI picker instead of guessed.
#[tauri::command]
async fn symbol_locations(
    project: String,
    path: String,
    symbol: String,
) -> Result<Vec<code_nav::SymbolLocation>, String> {
    off_main(move || {
        let root = find_project(&project)?.path;
        let file = confine(&root, &path)?;
        code_nav::symbol_locations(&root, &file, &symbol)
    })
    .await
}

/// Every name the project declares, for the editor's project-symbol colouring and Open Quickly.
#[tauri::command]
async fn project_symbols(project: String) -> Result<Vec<code_nav::ProjectSymbol>, String> {
    off_main(move || {
        let root = find_project(&project)?.path;
        code_nav::project_symbols(&root)
    })
    .await
}

/// Every dirty path in the selected project, so the file tree can mark what changed. Cheap
/// enough to re-ask whenever an agent writes; one `git status` and no file reads.
#[tauri::command]
async fn git_file_states(project: String) -> Result<HashMap<String, String>, String> {
    off_main(move || Ok(projects::git_file_states(&find_project(&project)?.path))).await
}

/// One file as HEAD has it, for the editor's change gutter. `None` when untracked or unborn.
#[tauri::command]
async fn git_head_file(project: String, path: String) -> Result<Option<String>, String> {
    off_main(move || {
        let root = find_project(&project)?.path;
        confine(&root, &path)?; // the path must belong to the selected project, blob or not
        Ok(projects::git_head_file(&root, &path))
    })
    .await
}

/// Plain-text search across the selected project. Off the UI thread and confined to the project
/// like every other editor file operation — a query cannot reach a repository you did not select.
#[tauri::command]
async fn search_project(
    project: String,
    query: String,
    case_sensitive: bool,
    whole_word: bool,
) -> Result<code_nav::SearchResult, String> {
    off_main(move || {
        let root = find_project(&project)?.path;
        code_nav::search(&root, &query, case_sensitive, whole_word)
    })
    .await
}

/// Up to 2MB off disk, and the editor calls it on every file you click.
#[tauri::command]
async fn read_file(project: String, path: String) -> Result<String, String> {
    off_main(move || {
        let file = confine(&find_project(&project)?.path, &path)?;
        if file.metadata().map(|meta| meta.len()).unwrap_or(0) > 2_000_000 {
            return Err("file is too large to open".into());
        }
        std::fs::read_to_string(&file).map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
async fn write_file(project: String, path: String, contents: String) -> Result<(), String> {
    off_main(move || {
        let file = confine(&find_project(&project)?.path, &path)?;
        std::fs::write(&file, contents).map_err(|error| error.to_string())
    })
    .await
}

/// Create an editable text handoff without overwriting anything already on disk. Existing files
/// use the normal editor path; this is only for an agent-supplied plan/draft that needs a home.
#[tauri::command]
async fn ensure_document(
    project: String,
    path: String,
    contents: String,
) -> Result<String, String> {
    off_main(move || {
        let root = find_project(&project)?
            .path
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let relative = PathBuf::from(path.trim());
        if relative.is_absolute()
            || relative.components().any(|part| {
                matches!(
                    part,
                    std::path::Component::ParentDir
                        | std::path::Component::RootDir
                        | std::path::Component::Prefix(_)
                )
            })
        {
            return Err("document path must stay inside the selected project".into());
        }
        let file = root.join(&relative);
        let parent = file.parent().ok_or("document has no parent folder")?;
        // Validate the nearest existing ancestor BEFORE creating directories. A symlink inside
        // the project may point outside it; checking only after create_dir_all would already
        // have written folders through that link before noticing the escape.
        let mut ancestor = parent;
        while !ancestor.exists() {
            ancestor = ancestor.parent().ok_or("document has no existing parent")?;
        }
        let ancestor = ancestor.canonicalize().map_err(|error| error.to_string())?;
        if !ancestor.starts_with(&root) {
            return Err("document path escaped the selected project".into());
        }
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let parent = parent.canonicalize().map_err(|error| error.to_string())?;
        if !parent.starts_with(&root) {
            return Err("document path escaped the selected project".into());
        }
        if !file.exists() {
            let allowed = ["md", "markdown", "txt", "json", "yaml", "yml", "csv"];
            let extension = relative
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            if !allowed.contains(&extension.as_str()) {
                return Err(
                    "new handoff documents must be text, Markdown, JSON, YAML, or CSV".into(),
                );
            }
            std::fs::write(&file, contents).map_err(|error| error.to_string())?;
        }
        Ok(relative.to_string_lossy().into_owned())
    })
    .await
}

#[derive(serde::Serialize)]
struct DirEntry {
    name: String,
    is_dir: bool,
}

/// One directory level for the lazy file tree. Sandboxed through `confine` like every other
/// file command, one level per call so the frontend expands folders on demand, and filtered
/// (dotfiles, build junk) so the tree reads like a project navigator, not a raw dump.
#[tauri::command]
async fn read_dir(project: String, path: String) -> Result<Vec<DirEntry>, String> {
    off_main(move || {
        let relative = if path.trim().is_empty() {
            "."
        } else {
            path.as_str()
        };
        let dir = confine(&find_project(&project)?.path, relative)?;
        const DENYLIST: [&str; 8] = [
            "node_modules",
            "target",
            "build",
            "dist",
            "Pods",
            "DerivedData",
            "__pycache__",
            "venv",
        ];
        let mut entries = Vec::new();
        for entry in std::fs::read_dir(&dir).map_err(|error| error.to_string())? {
            let Ok(entry) = entry else { continue };
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            if name.starts_with('.') || DENYLIST.contains(&name.as_str()) {
                continue;
            }
            let is_dir = entry
                .file_type()
                .map(|kind| kind.is_dir())
                .unwrap_or_else(|_| entry.path().is_dir());
            entries.push(DirEntry { name, is_dir });
        }
        entries.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(entries)
    })
    .await
}

/// A path that may not exist yet, kept inside the project. `confine` canonicalizes and so
/// needs the file on disk; a new file or a rename target has no inode yet, so this checks the
/// nearest EXISTING ancestor instead, the same way `ensure_document` does.
fn confine_new(root: &Path, path: &str) -> Result<PathBuf, String> {
    let relative = PathBuf::from(path.trim());
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || relative.components().any(|part| {
            matches!(
                part,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return Err("path must stay inside the selected project".into());
    }
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let target = root.join(&relative);
    let mut ancestor = target.parent().ok_or("path has no parent folder")?;
    while !ancestor.exists() {
        ancestor = ancestor.parent().ok_or("path has no existing parent")?;
    }
    let ancestor = ancestor.canonicalize().map_err(|error| error.to_string())?;
    if !ancestor.starts_with(&root) {
        return Err("path escaped the selected project".into());
    }
    Ok(target)
}

/// New file or folder from the navigator. Refuses to overwrite: a name that already exists is a
/// mistake, not a request to blank it. Returns the project-relative path.
#[tauri::command]
async fn create_entry(project: String, path: String, is_dir: bool) -> Result<String, String> {
    off_main(move || {
        let root = find_project(&project)?.path;
        let target = confine_new(&root, &path)?;
        if target.exists() {
            return Err(format!("{} already exists", path.trim()));
        }
        if is_dir {
            std::fs::create_dir_all(&target).map_err(|error| error.to_string())?;
        } else {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            std::fs::write(&target, "").map_err(|error| error.to_string())?;
        }
        Ok(path.trim().trim_start_matches("./").to_string())
    })
    .await
}

/// Rename or move inside the project. Both ends are confined; the target must not exist.
#[tauri::command]
async fn rename_entry(project: String, from: String, to: String) -> Result<String, String> {
    off_main(move || {
        let root = find_project(&project)?.path;
        let source = confine(&root, &from)?;
        let target = confine_new(&root, &to)?;
        if target.exists() {
            return Err(format!("{} already exists", to.trim()));
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        std::fs::rename(&source, &target).map_err(|error| error.to_string())?;
        Ok(to.trim().trim_start_matches("./").to_string())
    })
    .await
}

/// Delete a file or a whole folder. The frontend confirms first; this only refuses the root.
#[tauri::command]
async fn delete_entry(project: String, path: String) -> Result<(), String> {
    off_main(move || {
        let root = find_project(&project)?.path;
        let target = confine(&root, &path)?;
        let root = root.canonicalize().map_err(|error| error.to_string())?;
        if target == root {
            return Err("refusing to delete the project itself".into());
        }
        if target.is_dir() {
            std::fs::remove_dir_all(&target).map_err(|error| error.to_string())
        } else {
            std::fs::remove_file(&target).map_err(|error| error.to_string())
        }
    })
    .await
}

/// Show the file in Finder (or the platform equivalent), selected.
#[tauri::command]
async fn reveal_entry(project: String, path: String) -> Result<(), String> {
    off_main(move || {
        let target = confine(&find_project(&project)?.path, &path)?;
        #[cfg(target_os = "macos")]
        {
            crate::platform::command("open")
                .arg("-R")
                .arg(&target)
                .spawn()
                .map(|_| ())
                .map_err(|error| format!("could not reveal {}: {error}", target.display()))
        }
        #[cfg(target_os = "windows")]
        {
            let mut select = std::ffi::OsString::from("/select,");
            select.push(&target);
            crate::platform::command("explorer")
                .arg(select)
                .spawn()
                .map(|_| ())
                .map_err(|error| format!("could not reveal {}: {error}", target.display()))
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            open_folder(target.parent().unwrap_or(&target))
        }
    })
    .await
}

/// Resolve a path against its project root, and refuse anything outside it.
///
/// Worklists and git both speak repo-relative paths, so a relative path resolves against the
/// project. Nothing else is a reason to hand the webview arbitrary filesystem access: the
/// path is canonicalized BEFORE the check, so `../../..` cannot walk out of the project.
fn confine(root: &Path, path: &str) -> Result<PathBuf, String> {
    let candidate = PathBuf::from(path.trim());
    let candidate = if candidate.is_absolute() {
        candidate
    } else {
        root.join(candidate)
    };
    let resolved = candidate
        .canonicalize()
        .map_err(|error| format!("{}: {error}", candidate.display()))?;
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    if !resolved.starts_with(&root) {
        return Err(format!("outside the project: {}", resolved.display()));
    }
    Ok(resolved)
}

/// The Panel modules, with their chat assets inlined. The UI injects those and gets the
/// module's own renderers and animations back — the git graph included. Reads every manifest
/// and every asset off disk.
#[tauri::command]
async fn list_modules(state: State<'_, DesktopState>) -> Result<Vec<modules::Module>, String> {
    let home = state.panel_home.clone();
    off_main(move || Ok(modules::describe(&home))).await
}

/// Every extension this Panel carries, installed or not.
///
/// The public ones all ship inside the app, so installing is a local record and nothing is
/// downloaded. What the screen adds is honesty about cost: each row says what the module needs
/// and which of those are missing from this machine.
#[tauri::command]
async fn module_catalog(
    state: State<'_, DesktopState>,
) -> Result<Vec<modules::CatalogEntry>, String> {
    let home = state.panel_home.clone();
    off_main(move || Ok(modules::catalog(&home))).await
}

#[tauri::command]
async fn install_module(
    state: State<'_, DesktopState>,
    name: String,
) -> Result<Vec<modules::CatalogEntry>, String> {
    let home = state.panel_home.clone();
    off_main(move || modules::install(&home, &name)).await
}

#[tauri::command]
async fn uninstall_module(
    state: State<'_, DesktopState>,
    name: String,
) -> Result<Vec<modules::CatalogEntry>, String> {
    let home = state.panel_home.clone();
    off_main(move || modules::uninstall(&home, &name)).await
}

/// A JSON call into a module, e.g. `/m/git-manager/graph?repo=…`.
///
/// THE EXPENSIVE ONE. A module call is "one request, one process" (modules::call) — it spawns a
/// PYTHON INTERPRETER and waits for it. Product Spine and Git mutations still use this route.
#[tauri::command]
async fn module_request(
    state: State<'_, DesktopState>,
    path: String,
    method: Option<String>,
    body: Option<String>,
) -> Result<Value, String> {
    let home = state.panel_home.clone();
    off_main(move || {
        let response = modules::serve(
            &home,
            &path,
            method.as_deref().unwrap_or("GET"),
            body.unwrap_or_default().into_bytes(),
        );
        let text = String::from_utf8_lossy(&response.body).into_owned();
        if response.status >= 400 {
            return Err(text);
        }
        // Not every module route speaks JSON. `release-manager/card` answers with an HTML
        // fragment — it is built to be dropped straight into the dashboard's card grid. A 200
        // is a 200: hand the body back as a string rather than calling a successful response
        // an error because it did not happen to parse as JSON.
        Ok(serde_json::from_str(&text).unwrap_or(Value::String(text)))
    })
    .await
}

/// Every ProjectEvent passes here on its way to the UI, which makes it the one honest place to
/// file an agent's report. Filing in the sink rather than the frontend means a report is written
/// whether or not anyone had the Inbox open, and whether or not the window exists at all.
fn event_sink(app: &AppHandle) -> EventSink {
    let app = app.clone();
    Arc::new(move |mut event: ProjectEvent| {
        if let PanelEvent::VisualRequested {
            view,
            session_id,
            payload,
            ..
        } = &mut event.event
        {
            if view == "message" {
                // The prose goes to the brain. The Inbox gets the headline and the media, plus
                // the path to the filed note so the human can read the rest on purpose.
                if let Some(note) = reports::file(&event.project, session_id, payload) {
                    if let Some(object) = payload.as_object_mut() {
                        object.insert(
                            "_panel_note".into(),
                            Value::String(note.to_string_lossy().into_owned()),
                        );
                    }
                }
            }
        }
        let _ = app.emit(AGENT_EVENT, event);
    })
}

fn uuid_v4() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Make a Finder-launched Panel see the same PATH as the user's terminal.
///
/// A GUI app started from the Dock/Finder inherits only launchd's minimal PATH
/// (`/usr/bin:/bin:/usr/sbin:/sbin`). Every coding agent this app hosts lives outside that —
/// `claude` in `~/.local/bin`, `opencode`/`grok` in their own `~/.*/bin`, `codex` in Homebrew.
/// Because a terminal execs the agent binary DIRECTLY in the PTY (a plain shell would find it by
/// sourcing the user's rc, but an agent kind does not), a minimal PATH means `claude`/`codex`
/// "won't start" while a shell still does. Doing this once, at the process level, fixes every
/// spawn uniformly.
///
/// It must be an INTERACTIVE login shell (`-ilc`): those agent dirs are exported from `~/.zshrc`,
/// which a non-interactive `-lc` shell never sources — so `-lc` recovers Homebrew but still
/// misses `~/.local/bin`. The reported PATH is fenced with markers because an interactive shell
/// can print a banner or plugin noise on stdout.
///
/// Best-effort: on any failure the existing PATH is kept untouched. Login-shell entries are
/// prepended, and current entries are appended if not already present, so nothing is ever lost.
#[cfg(not(windows))]
fn ensure_login_path() {
    const OPEN: &str = "__PANEL_PATH__";
    const CLOSE: &str = "__END_PANEL_PATH__";
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let Ok(output) = crate::platform::command(&shell)
        .args(["-ilc", &format!("printf '{OPEN}%s{CLOSE}' \"$PATH\"")])
        .output()
    else {
        return;
    };
    if !output.status.success() {
        return;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let login_path = match (stdout.find(OPEN), stdout.find(CLOSE)) {
        (Some(start), Some(end)) if end > start => stdout[start + OPEN.len()..end].trim(),
        _ => return,
    };
    if login_path.is_empty() {
        return;
    }

    // Keep the current PATH order intact; only APPEND login-shell dirs that are genuinely
    // missing. Reordering an already-complete PATH would be a pointless (and surprising) change,
    // so a dev-from-terminal run — which already has everything — is left untouched and silent.
    let current = std::env::var("PATH").unwrap_or_default();
    let have: Vec<&str> = current.split(':').filter(|e| !e.is_empty()).collect();
    let gained: Vec<&str> = login_path
        .split(':')
        .filter(|entry| !entry.is_empty() && !have.contains(entry))
        .collect();
    if gained.is_empty() {
        return;
    }
    // Missing dirs go first so a user-preferred tool shadows a system one, matching the login shell.
    let merged: Vec<&str> = gained.iter().copied().chain(have.iter().copied()).collect();
    eprintln!(
        "[panel] PATH augmented from login shell (+{} dirs) — agents will resolve",
        gained.len()
    );
    std::env::set_var("PATH", merged.join(":"));
}

/// Prove a PTY terminal starts for each agent kind, through the SAME `panel_terminal::spawn`
/// path start_session uses. Returns a process exit code: 0 if every agent launched, 1 otherwise.
/// A "shell" always uses the login shell (which sources the user's rc), so it is the baseline;
/// the agents exec their binary directly, which is where a minimal Finder PATH bites.
fn selftest() -> i32 {
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    eprintln!(
        "[selftest] PATH={}",
        std::env::var("PATH").unwrap_or_default()
    );
    let dir = std::env::temp_dir();
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let shell_case: (&str, &[&str]) = if cfg!(windows) {
        ("powershell.exe", &["-NoProfile", "-Command", "echo PANEL_SHELL_OK"])
    } else {
        (&shell, &["-lc", "echo PANEL_SHELL_OK"])
    };

    // (label, program, args). Empty program = baseline shell running a marker echo.
    let cases: [(&str, &str, &[&str]); 8] = [
        ("shell", shell_case.0, shell_case.1),
        ("claude", "claude", &["--version"]),
        ("codex", "codex", &["--version"]),
        ("grok", "grok", &["--version"]),
        ("deepseek harness", "dshline", &["--version"]),
        ("opencode", "opencode", &["--version"]),
        (
            "opencode kimi k3",
            "opencode",
            &["--model", "kimi/kimi-k3", "--version"],
        ),
        (
            "opencode deepseek v4 flash",
            "opencode",
            &["--model", "deepseek/deepseek-v4-flash", "--version"],
        ),
    ];

    let mut failures = 0;
    for (label, program, args) in cases {
        let (tx, rx) = mpsc::channel();
        let sink: TerminalSink = Arc::new(move |chunk: TerminalChunk| {
            let _ = tx.send(chunk);
        });
        let mut manager = TerminalManager::default();
        let spec = SpawnSpec::shell(&dir, 80, 24)
            .run(program, args.iter().map(|a| a.to_string()).collect());

        match manager.spawn(spec, sink) {
            Ok(id) => {
                let deadline = Instant::now() + Duration::from_secs(4);
                let mut out = String::new();
                while Instant::now() < deadline {
                    match rx.recv_timeout(Duration::from_millis(200)) {
                        Ok(chunk) => {
                            out.push_str(&chunk.data);
                            if chunk.closed {
                                break;
                            }
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            if !out.is_empty() {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
                let _ = manager.close(&id);
                let head: String = out.split_whitespace().take(6).collect::<Vec<_>>().join(" ");
                eprintln!("[selftest] {label:>9}: STARTED — output: {head:?}");
            }
            Err(error) => {
                // This is the exact failure behind "the terminal just resets".
                eprintln!("[selftest] {label:>9}: FAILED  — {error:#}");
                if label != "shell" {
                    failures += 1;
                }
            }
        }
    }
    if failures == 0 {
        eprintln!("[selftest] RESULT: all terminals start ✓");
        0
    } else {
        eprintln!("[selftest] RESULT: {failures} agent terminal(s) failed to start ✗");
        1
    }
}

fn main() {
    // Runs before the Tauri event loop, so every PTY/subprocess spawned later inherits the fix.
    // PANEL_NO_PATHFIX skips it — used only by the self-test to show the before/after.
    #[cfg(not(windows))]
    if std::env::var_os("PANEL_NO_PATHFIX").is_none() {
        ensure_login_path();
    }
    // Windows names the home folder USERPROFILE and leaves HOME unset outside Git Bash. Every
    // path Panel owns hangs off HOME, so without this `~/.appgeapanel` lands in whatever
    // directory the app was started from.
    #[cfg(windows)]
    if std::env::var_os("HOME").is_none() {
        if let Some(profile) = std::env::var_os("USERPROFILE") {
            std::env::set_var("HOME", profile);
        }
    }

    // Headless confirmation that a terminal actually spawns, driving the real PTY path
    // (panel_terminal) exactly as start_session does — no window, no clicking. Prints one line
    // per kind and exits non-zero if any agent failed to launch.
    if std::env::var_os("PANEL_SELFTEST").is_some() {
        std::process::exit(selftest());
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        // Restore the app artwork from the old Panel sidebar. The scheme resolves only project
        // ids from the shared registry and only files discovered inside that project's folder.
        .register_asynchronous_uri_scheme_protocol("project-icon", |_ctx, request, responder| {
            // Off the window thread: the first lookup per project can walk a native source tree.
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(project_icon_response(&request));
            });
        })
        // Read-only project media for domain workspaces. The first path component is a registered
        // project id; the remainder is canonicalized and must remain under that project's root.
        .register_asynchronous_uri_scheme_protocol("project-asset", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                let state = app.state::<DesktopState>();
                responder.respond(project_asset_response(&state.panel_home, &request));
            });
        })
        // `module://panel/m/<name>/<sub>` -> the module's one-shot host.
        //
        // Product Spine is a full web app rendered by its own Python (`html_view.py`), and
        // it emits absolute links under `/m/product-spine/…`. Serving it on this scheme at that
        // exact path shape is what lets those links — and its CSS, and its JS — resolve inside
        // the iframe with no origin, no port, and nothing listening off-machine.
        .register_asynchronous_uri_scheme_protocol("module", |ctx, request, responder| {
            // A module answers from a Python subprocess; the window keeps painting meanwhile.
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                let state = app.state::<DesktopState>();
                responder.respond(module_response(&state.panel_home, &request));
            });
        })
        .setup(|app| {
            // The Python runtime bits Panel shells out to — the session hook, the panel MCP, the
            // schemas and the `modules/` hosts — ship as `host/`. Inside a bundle that is
            // `Contents/Resources/host` and it is READ-ONLY; everything the human owns lives in
            // `~/.appgeapanel` instead. `paths` is the only place that distinction is decided.
            if let Ok(resource_dir) = app.path().resource_dir() {
                let bundled = resource_dir.join("host");
                if bundled.is_dir() {
                    paths::init_resources(bundled);
                }
            }
            let upgraded = paths::migrate();
            let panel_home = paths::resources_root();
            // Extensions ship dormant. An existing setup keeps everything it already had; a fresh
            // one starts with the few that need no credential and no toolchain.
            modules::seed_installed(&panel_home, upgraded);
            let ingress = Ingress::serve(event_sink(&app.handle().clone()))?;
            for project in all_projects().into_iter().filter(|project| project.exists) {
                ingress.register_project(&project.id, &project.path);
            }
            let _ = std::fs::write(
                paths::user_root().join("ingress-port"),
                ingress.port().to_string(),
            );
            app.manage(DesktopState {
                terminals: Mutex::new(TerminalManager::default()),
                debugger: Arc::new(debug::DebugManager::default()),
                ingress,
                sessions: Mutex::new(HashMap::new()),
                sims: Arc::new(Mutex::new(HashMap::new())),
                panel_home,
                shutdown_prompt_pending: AtomicBool::new(false),
                shutdown_approved: AtomicBool::new(false),
                made: made::MadeWatch::default(),
            });
            watch_portfolio(app.handle().clone());
            watch_sprints(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            launch_context,
            manager_project,
            cpo_preprompt,
            set_cpo_preprompt,
            reset_cpo_preprompt,
            project_desk::project_desk,
            project_desk::project_desk_overview,
            project_desk::project_desk_save,
            sprint_board,
            sprint_set_goal,
            sprint_add_goal,
            sprint_log,
            sprint_create,
            sprint_read,
            sprint_write,
            notebook::read_notebook,
            notebook::save_notebook,
            list_projects,
            list_groups,
            set_project_group,
            add_group,
            project_modules,
            add_project,
            pick_project_folder,
            open_project_folder,
            open_revenuecat_setup,
            project_dashboard,
            project_standings,
            project_activity,
            git_overview,
            debug_profiles,
            debug_targets,
            debug_status,
            debug_breakpoints,
            debug_set_breakpoints,
            debug_start,
            debug_request,
            debug_stop,
            project_working_set,
            list_sessions,
            skills_catalog,
            skills_read,
            skills_read_document,
            skills_session_policy,
            skills_session_set,
            skills_session_restart,
            skills_save,
            skills_resources,
            skills_resource_read,
            skills_resource_save,
            skills_archive,
            skills_usage,
            restore_wall,
            start_session,
            stop_session,
            session_cwd,
            session_busy,
            write_terminal,
            save_pasted_file,
            resize_terminal,
            close_terminal,
            start_sim,
            list_simulators,
            run_inventory,
            close_idle_sims,
            sim_targets,
            device_leases,
            android_targets,
            sim_focus,
            open_server,
            open_link,
            clipboard_text,
            open_media,
            made_entries,
            cancel_shutdown,
            shutdown_panel,
            answer_ask,
            set_attention,
            file_changes,
            file_relationships,
            symbol_locations,
            project_symbols,
            search_project,
            git_file_states,
            git_head_file,
            read_file,
            write_file,
            ensure_document,
            read_dir,
            create_entry,
            rename_entry,
            delete_entry,
            reveal_entry,
            project_files,
            warm_code_nav,
            list_modules,
            module_catalog,
            install_module,
            uninstall_module,
            module_request,
        ])
        .build(tauri::generate_context!())
        .expect("Panel desktop failed")
        .run(|app, event| match event {
            tauri::RunEvent::WindowEvent {
                event: tauri::WindowEvent::CloseRequested { api, .. },
                ..
            } => {
                if guard_shutdown(app) {
                    api.prevent_close();
                }
            }
            tauri::RunEvent::ExitRequested { api, .. } => {
                if guard_shutdown(app) {
                    api.prevent_exit();
                } else {
                    let _ = std::fs::remove_file(paths::user_root().join("ingress-port"));
                }
            }
            _ => {}
        });
}

#[cfg(test)]
mod origin_tests {
    use super::app_origin;

    #[test]
    fn only_the_app_page_may_fetch_project_files() {
        assert!(app_origin("tauri://localhost"));
        assert!(app_origin("http://localhost:1421"));
        assert!(!app_origin("module://panel"));
        assert!(!app_origin("http://module.localhost"));
        assert!(app_origin("http://tauri.localhost"));
        assert!(!app_origin("https://example.com"));
        assert!(!app_origin("http://localhost.evil.com"));
    }
}

#[cfg(test)]
mod link_tests {
    use super::web_link;

    #[test]
    fn only_plain_web_links_may_be_opened() {
        assert!(web_link("https://github.com/appgea/panel/pull/12"));
        assert!(web_link("http://localhost:3000/"));
        for bad in [
            "file:///etc/passwd",
            "vscode://open?x",
            "javascript:alert(1)",
            "-a Terminal",
            "https://",
            "https://example.com/a b",
            "https://example.com/\nopen -a Calculator",
        ] {
            assert!(!web_link(bad), "{bad}");
        }
    }
}
