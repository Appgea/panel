//! Ingress — the one channel between a terminal-hosted agent and Panel.
//!
//! The agent runs in a real PTY. It is never driven over a side protocol, so it cannot be
//! broken by one. Panel only ever *observes* it, through two deliberately unequal channels:
//!
//!   * hooks (`POST /hook/<event>`) — the reliability backbone. Claude Code fires these
//!     whether or not the model remembers to report anything, so file/git/turn activity
//!     animates because the hook FIRED, not because the model chose to narrate.
//!   * panel (`POST /panel/emit`, `POST /panel/ask`) — the model speaking on purpose:
//!     a visual it wants shown, or a question it needs answered.
//!
//! Both arrive over loopback HTTP on `PANEL_PORT`, which is exactly the contract the
//! existing `session_hook.py` and `mcp/panel_mcp.py` already speak — so those two
//! Python shims keep working untouched against this Rust listener.
//!
//! `/panel/ask` BLOCKS its request thread until the human answers, then returns the answer
//! as the MCP tool's return value. That is the whole round-trip: the agent asks, the human
//! answers in the UI, the agent's tool call returns. Thread-per-request is therefore not an
//! implementation detail — it is the feature.

use anyhow::{Context, Result};
use panel_core::{ActivityState, PanelEvent};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tiny_http::{Header, Request, Response, Server};
use uuid::Uuid;

pub type EventSink = Arc<dyn Fn(ProjectEvent) + Send + Sync + 'static>;

const MAX_TRACKED_FILE: u64 = 1_000_000;
const MAX_FILE_STEPS: usize = 24;
const MAX_CHANGE_STEPS: usize = 512;
const MAX_CHANGE_BYTES: usize = 32 * 1024 * 1024;
const MAX_PENDING_EDITS: usize = 16;

/// One exact, locally captured edit. Full text makes replay deterministic and keeps diff policy
/// in the UI, where context size and presentation belong. The log is memory-only and bounded.
#[derive(Debug, Clone, Serialize)]
pub struct ChangeStep {
    pub id: u64,
    pub path: String,
    pub before: String,
    pub after: String,
    pub tool: String,
    pub at_ms: u64,
}

impl ChangeStep {
    fn memory_bytes(&self) -> usize {
        self.path.len() + self.before.len() + self.after.len() + self.tool.len()
    }
}

#[derive(Default)]
struct ChangeLog {
    next_id: u64,
    /// project + agent session + absolute path -> content before the tool runs.
    pending: HashMap<String, String>,
    pending_order: VecDeque<String>,
    /// project + absolute path -> ordered steps.
    files: HashMap<String, Vec<ChangeStep>>,
    /// Oldest step first, across every project and file.
    step_order: BTreeMap<u64, String>,
    step_bytes: usize,
}

impl ChangeLog {
    fn insert_pending(&mut self, key: String, before: String) {
        self.pending_order.retain(|old| old != &key);
        self.pending.insert(key.clone(), before);
        self.pending_order.push_back(key);
        while self.pending.len() > MAX_PENDING_EDITS {
            if let Some(oldest) = self.pending_order.pop_front() {
                self.pending.remove(&oldest);
            }
        }
    }

    fn take_pending(&mut self, key: &str) -> Option<String> {
        self.pending_order.retain(|old| old != key);
        self.pending.remove(key)
    }

    fn clear_project(&mut self, project: &str) {
        let prefix = format!("{project}\0");
        self.pending.retain(|key, _| !key.starts_with(&prefix));
        self.pending_order.retain(|key| !key.starts_with(&prefix));
        let keys: Vec<_> = self.files.keys().filter(|key| key.starts_with(&prefix)).cloned().collect();
        for key in keys {
            if let Some(steps) = self.files.remove(&key) {
                for step in steps {
                    self.step_order.remove(&step.id);
                    self.step_bytes -= step.memory_bytes();
                }
            }
        }
    }

    fn push(&mut self, project: &str, path: &str, before: &str, after: &str, tool: &str) {
        self.next_id += 1;
        let step = ChangeStep {
            id: self.next_id,
            path: path.to_string(),
            before: before.to_string(),
            after: after.to_string(),
            tool: tool.to_string(),
            at_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        };
        let key = format!("{project}\0{path}");
        self.step_bytes += step.memory_bytes();
        self.step_order.insert(step.id, key.clone());
        let history = self.files.entry(key).or_default();
        history.push(step);
        if history.len() > MAX_FILE_STEPS {
            let old = history.remove(0);
            self.step_order.remove(&old.id);
            self.step_bytes -= old.memory_bytes();
        }
        while self.step_bytes > MAX_CHANGE_BYTES || self.step_order.len() > MAX_CHANGE_STEPS {
            let Some((id, key)) = self.step_order.pop_first() else { break };
            let Some(history) = self.files.get_mut(&key) else { continue };
            if let Some(at) = history.iter().position(|step| step.id == id) {
                self.step_bytes -= history.remove(at).memory_bytes();
            }
            if history.is_empty() {
                self.files.remove(&key);
            }
        }
    }
}

/// One open question: the request thread parks on the condvar, the UI fills the slot.
#[derive(Default)]
struct AskSlot {
    answer: Mutex<Option<Value>>,
    ready: Condvar,
}

/// An event, already resolved to the project it belongs to.
///
/// Panel runs an agent per project at once, so "which project" is the first thing the UI
/// needs and the last thing it should have to work out for itself.
#[derive(Debug, Clone, Serialize)]
pub struct ProjectEvent {
    pub project: String,
    #[serde(flatten)]
    pub event: PanelEvent,
}

/// One running agent: which project it serves, and where it is working.
struct Route {
    project: String,
    cwd: PathBuf,
}

/// Resolve an inbound message to a project.
///
/// Both shims carry our own `PANEL_INSTANCE`, so hosted agents resolve exactly even when two
/// terminals share a project. Older hook forwarders do not carry it, so `cwd` remains a safe
/// compatibility fallback. Deepest-wins matters because a project nested inside another must
/// not steal its parent's events.
#[derive(Default)]
struct Router {
    routes: HashMap<String, Route>,
    projects: HashMap<String, PathBuf>,
}

impl Router {
    fn resolve(&self, instance: &str, cwd: &str) -> Option<String> {
        if let Some(route) = self.routes.get(instance) {
            return Some(route.project.clone());
        }
        let cwd = PathBuf::from(cwd);
        if cwd.as_os_str().is_empty() {
            return None;
        }
        self.routes
            .values()
            .filter(|route| cwd.starts_with(&route.cwd))
            .max_by_key(|route| route.cwd.components().count())
            .map(|route| route.project.clone())
            .or_else(|| {
                self.projects
                    .iter()
                    .filter(|(_, root)| cwd.starts_with(root))
                    .max_by_key(|(_, root)| root.components().count())
                    .map(|(project, _)| project.clone())
            })
    }

    fn root_for(&self, project: &str) -> Option<PathBuf> {
        self.projects.get(project).cloned().or_else(|| self.routes
            .values()
            .filter(|route| route.project == project)
            .map(|route| route.cwd.clone())
            .max_by_key(|root| root.components().count()))
    }
}

#[derive(Clone)]
pub struct Ingress {
    port: u16,
    asks: Arc<Mutex<HashMap<String, Arc<AskSlot>>>>,
    router: Arc<Mutex<Router>>,
    changes: Arc<Mutex<ChangeLog>>,
    skill_uses: Arc<Mutex<HashMap<String, Vec<String>>>>,
    sink: EventSink,
}

impl Ingress {
    /// Bind loopback on an ephemeral port and serve until the process exits.
    ///
    /// Ephemeral (not the legacy fixed 7391) so Appgea Panel can run alongside the old
    /// Python Panel without a port fight. The real port is handed to each agent via
    /// `PANEL_PORT` in its PTY environment, which is how the shims find us.
    pub fn serve(sink: EventSink) -> Result<Self> {
        let server = Server::http("127.0.0.1:0")
            .map_err(|error| anyhow::anyhow!("bind ingress: {error}"))?;
        let port = server
            .server_addr()
            .to_ip()
            .context("ingress bound to a non-ip address")?
            .port();

        let ingress = Self {
            port,
            asks: Arc::new(Mutex::new(HashMap::new())),
            router: Arc::new(Mutex::new(Router::default())),
            changes: Arc::new(Mutex::new(ChangeLog::default())),
            skill_uses: Arc::new(Mutex::new(HashMap::new())),
            sink,
        };

        let acceptor = ingress.clone();
        thread::spawn(move || {
            for request in server.incoming_requests() {
                let handler = acceptor.clone();
                // Thread per request: `/panel/ask` parks for minutes, and must not stall
                // the hook traffic that keeps the panel honest while it waits.
                thread::spawn(move || handler.handle(request));
            }
        });

        Ok(ingress)
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Bind a running agent to a project. Called when its PTY is spawned; without this its
    /// events have nowhere to land and are dropped.
    pub fn register_agent(&self, instance: &str, project: &str, cwd: impl Into<PathBuf>) {
        self.router.lock().unwrap().routes.insert(
            instance.to_string(),
            Route {
                project: project.to_string(),
                cwd: cwd.into(),
            },
        );
    }

    pub fn unregister_agent(&self, instance: &str) {
        self.router.lock().unwrap().routes.remove(instance);
        self.skill_uses.lock().unwrap().remove(instance);
    }

    /// Successful Skill calls, isolated by Panel instance. This is usage evidence,
    /// not a claim that the model still holds these instructions after compaction.
    pub fn skill_uses(&self, instance: &str) -> Vec<String> {
        self.skill_uses.lock().unwrap().get(instance).cloned().unwrap_or_default()
    }

    /// Register a project even when it has no agent session. Background modules can then route
    /// a portfolio alert without inventing a terminal instance.
    pub fn register_project(&self, project: &str, root: impl Into<PathBuf>) {
        self.router
            .lock()
            .unwrap()
            .projects
            .insert(project.to_string(), root.into());
    }

    /// Exact edit history for a station. A UI path may be relative while hooks report absolute;
    /// suffix matching joins those two spellings without exposing arbitrary filesystem reads.
    pub fn file_changes(&self, project: &str, path: &str) -> Vec<ChangeStep> {
        // Keys are native paths; Windows writes them with `\` while callers ask with `/`.
        let needle = path.trim().replace('\\', "/");
        let needle = needle.trim_start_matches('/');
        let changes = self.changes.lock().unwrap();
        changes
            .files
            .iter()
            .find(|(key, _)| {
                let Some((owner, file)) = key.split_once('\0') else {
                    return false;
                };
                owner == project
                    && (file == path || file.replace('\\', "/").trim_start_matches('/').ends_with(needle))
            })
            .map(|(_, steps)| steps.clone())
            .unwrap_or_default()
    }

    /// Resolve an open question from the UI. Returns false if it already closed.
    pub fn answer(&self, qid: &str, value: Value) -> bool {
        let slot = self.asks.lock().unwrap().get(qid).cloned();
        let Some(slot) = slot else {
            return false;
        };
        *slot.answer.lock().unwrap() = Some(value);
        slot.ready.notify_all();
        true
    }

    fn handle(&self, mut request: Request) {
        let url = request.url().to_string();
        let mut raw = String::new();
        let _ = std::io::Read::read_to_string(request.as_reader(), &mut raw);
        let body: Value = serde_json::from_str(&raw).unwrap_or_else(|_| json!({}));

        let reply = if let Some(event) = url.strip_prefix("/hook/") {
            self.on_hook(event, &body)
        } else {
            match url.as_str() {
                "/panel/emit" => self.on_emit(&body),
                "/panel/ask" => self.on_ask(&body),
                "/panel/answer" => self.on_answer(&body),
                _ => json!({"error": "unknown endpoint"}),
            }
        };

        let json_header = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
            .expect("static header");
        let payload = serde_json::to_string(&reply).unwrap_or_else(|_| "{}".into());
        let _ = request.respond(Response::from_string(payload).with_header(json_header));
    }

    /// Claude session hooks -> deterministic panel events.
    ///
    /// This is the reliability backbone. It maps only what the hook actually proves
    /// happened; it never infers intent. The empty reply is a valid reply — the shim is
    /// fail-open, so a slow or silent Panel can never block or corrupt the agent's turn.
    fn on_hook(&self, event: &str, body: &Value) -> Value {
        let instance = body["instance"].as_str().unwrap_or_default();
        // UI session ids and panel event ids use Panel's instance. Claude's own session id is
        // only a fallback for older forwarders that did not include PANEL_INSTANCE.
        let session_id = if instance.is_empty() {
            body["session_id"].as_str().unwrap_or_default()
        } else {
            instance
        }
        .to_string();
        let tool = body["tool_name"].as_str().unwrap_or_default();
        let input = &body["tool_input"];

        // Exact instance routing keeps simultaneous agents in one repo separate. `cwd` keeps
        // older forwarders working. A session we did not launch still resolves to nothing.
        let Some(project) = self.resolve(instance, body["cwd"].as_str().unwrap_or_default()) else {
            return json!({});
        };
        let project = project.as_str();

        match event {
            "PreToolUse" => {
                if matches!(tool, "Edit" | "Write" | "MultiEdit" | "NotebookEdit") {
                    let path = input["file_path"]
                        .as_str()
                        .or_else(|| input["notebook_path"].as_str())
                        .unwrap_or_default();
                    self.capture_before(project, &session_id, body, path);
                }
            }
            "PostToolUse" => match tool {
                "Skill" => {
                    let name = input["skill"].as_str().unwrap_or_default();
                    // Never guess a session from cwd for usage: several agents can share it.
                    if !name.is_empty() && self.router.lock().unwrap().routes.contains_key(instance) {
                        let mut uses = self.skill_uses.lock().unwrap();
                        let list = uses.entry(instance.to_string()).or_default();
                        if list.len() < 1000 && !list.iter().any(|used| used == name) {
                            list.push(name.chars().take(256).collect());
                        }
                        drop(uses);
                        self.emit(project, PanelEvent::Activity {
                            session_id,
                            activity_id: Uuid::new_v4().to_string(),
                            state: ActivityState::Finished,
                            label: "Skill".into(),
                            detail: Some(name.chars().take(256).collect()),
                            success: Some(true),
                        });
                    }
                }
                "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => {
                    let path = input["file_path"]
                        .as_str()
                        .or_else(|| input["notebook_path"].as_str())
                        .unwrap_or_default();
                    if !path.is_empty() {
                        self.capture_after(project, &session_id, body, path, tool);
                        self.emit(
                            project,
                            PanelEvent::FileChanged {
                                session_id,
                                path: path.into(),
                                summary: Some(tool.to_string()),
                            },
                        );
                    }
                }
                "Bash" => {
                    let command = input["command"].as_str().unwrap_or_default();
                    if let Some(kind) = git_kind(command) {
                        self.emit(
                            project,
                            PanelEvent::VisualRequested {
                                session_id,
                                view: format!("git-{kind}"),
                                title: None,
                                payload: json!({
                                    "kind": kind,
                                    "command": command.chars().take(200).collect::<String>(),
                                    "cwd": body["cwd"].as_str().unwrap_or_default(),
                                }),
                            },
                        );
                    } else if let Some(kind) = work_checkpoint(command) {
                        self.emit(
                            project,
                            PanelEvent::Activity {
                                session_id,
                                activity_id: Uuid::new_v4().to_string(),
                                state: ActivityState::Finished,
                                label: kind.to_string(),
                                detail: Some(command.chars().take(200).collect::<String>()),
                                // PostToolUse is the successful hook. Failures have their own
                                // lifecycle event and must not be guessed from shell prose.
                                success: Some(true),
                            },
                        );
                    }
                }
                other => {
                    self.emit(
                        project,
                        PanelEvent::Activity {
                            session_id,
                            activity_id: Uuid::new_v4().to_string(),
                            state: ActivityState::Finished,
                            label: other.to_string(),
                            detail: None,
                            success: Some(true),
                        },
                    );
                }
            },
            "UserPromptSubmit" => {
                // The workshop is one prompt's scene, not an ever-growing activity ledger.
                // A new turn gets a clean replay timeline while the filesystem remains truth.
                self.changes.lock().unwrap().clear_project(project);
                let prompt = body["prompt"].as_str().unwrap_or_default();
                let summary = prompt
                    .lines()
                    .find(|line| !line.trim().is_empty())
                    .map(|line| line.trim().chars().take(96).collect::<String>());
                self.emit(
                    project,
                    PanelEvent::AgentStatus {
                        session_id,
                        status: "thinking".into(),
                        detail: summary,
                    },
                )
            }
            "Stop" => self.emit(
                project,
                PanelEvent::TurnFinished {
                    session_id,
                    success: true,
                    summary: None,
                },
            ),
            // The agent is parked on a prompt in its own terminal. Only the waits that need a
            // human count; `idle_prompt` follows a finished turn, which `Stop` already reported.
            "Notification" => {
                let kind = body["notification_type"].as_str().unwrap_or_default();
                let message = body["message"].as_str().unwrap_or_default();
                let parked = match kind {
                    "permission_prompt" | "elicitation_dialog" => true,
                    // Older Claude builds send no type; their permission sentence says so.
                    "" => message.to_ascii_lowercase().contains("permission"),
                    _ => false,
                };
                if parked {
                    self.emit(
                        project,
                        PanelEvent::AgentStatus {
                            session_id,
                            status: "waiting".into(),
                            detail: Some(message.chars().take(160).collect()),
                        },
                    );
                }
            }
            _ => {}
        }

        // We inject nothing back into the model's context — Panel watches, it does not steer.
        json!({})
    }

    fn on_emit(&self, body: &Value) -> Value {
        let id = Uuid::new_v4().to_string();
        let instance = body["instance"].as_str().unwrap_or_default();
        // An engine Panel never handed an instance to — a shell, a CLI with no session-scoped
        // config, an agent that lost the env — can still say where it is standing. Falling back to
        // the working directory is what makes `panel_send.py` a real universal path instead of a
        // script that silently drops every report it sends.
        let cwd = body["cwd"].as_str().unwrap_or_default();
        let explicit = body["project"].as_str().unwrap_or_default();
        let project = if explicit.is_empty() {
            self.resolve(instance, cwd)
        } else {
            self.router
                .lock()
                .unwrap()
                .projects
                .contains_key(explicit)
                .then(|| explicit.to_string())
        };
        let Some(project) = project else {
            return json!({ "id": id, "routed": false });
        };
        let mut payload = body["payload"].clone();
        if let Some(object) = payload.as_object_mut() {
            object.insert("_panel_project".into(), Value::String(project.clone()));
            // Every list that can name a file on disk. A path an agent reports is usually
            // absolute; the UI addresses assets project-relative, so they are normalised here
            // once rather than in each renderer.
            for key in ["images", "audio", "video", "attachments", "shots"] {
                let Some(items) = object.get_mut(key).and_then(Value::as_array_mut) else {
                    continue;
                };
                for item in items {
                    if let Some(path) = item.as_str().map(str::to_string) {
                        *item = Value::String(self.project_relative_path(&project, &path));
                    } else if let Some(item) = item.as_object_mut() {
                        if let Some(path) = item.get("path").and_then(Value::as_str) {
                            item.insert(
                                "path".into(),
                                Value::String(self.project_relative_path(&project, path)),
                            );
                        }
                    }
                }
            }
        }
        self.emit(
            &project,
            PanelEvent::VisualRequested {
                session_id: instance.to_string(),
                view: body["type"].as_str().unwrap_or("card").to_string(),
                title: payload["title"].as_str().map(str::to_string),
                payload,
            },
        );
        json!({ "id": id, "routed": true })
    }

    fn project_relative_path(&self, project: &str, path: &str) -> String {
        let candidate = PathBuf::from(path);
        if !candidate.is_absolute() {
            return path.trim_start_matches("./").to_string();
        }
        let Some(root) = self.router.lock().unwrap().root_for(project) else {
            return path.to_string();
        };
        candidate
            .strip_prefix(root)
            // `/` on every platform: the UI and file_changes speak forward slashes.
            .map(|relative| {
                relative
                    .components()
                    .map(|part| part.as_os_str().to_string_lossy())
                    .collect::<Vec<_>>()
                    .join("/")
            })
            .unwrap_or_else(|_| path.to_string())
    }

    /// Register a question, wake the UI, then BLOCK this thread until it is answered or
    /// the timeout elapses. The return value becomes the agent's MCP tool result.
    fn on_ask(&self, body: &Value) -> Value {
        let session_id = body["instance"].as_str().unwrap_or_default().to_string();
        let spec = body["spec"].clone();
        let timeout = Duration::from_secs_f64(body["timeout"].as_f64().unwrap_or(280.0).max(1.0));

        // An unroutable ask would park an agent thread on a question no UI will ever show.
        // Fail it fast instead — a refused answer is recoverable, a silent hang is not.
        let Some(project) = self.resolve(&session_id, "") else {
            return json!({"error": "no project is bound to this agent"});
        };

        let qid = Uuid::new_v4().to_string();
        let slot = Arc::new(AskSlot::default());
        self.asks.lock().unwrap().insert(qid.clone(), slot.clone());

        self.emit(
            &project,
            PanelEvent::AskRequested {
                session_id: session_id.clone(),
                qid: qid.clone(),
                spec,
            },
        );

        let answer = {
            let mut slot_answer = slot.answer.lock().unwrap();
            while slot_answer.is_none() {
                let (next, timed_out) = slot.ready.wait_timeout(slot_answer, timeout).unwrap();
                slot_answer = next;
                if timed_out.timed_out() {
                    break;
                }
            }
            slot_answer.take()
        };
        self.asks.lock().unwrap().remove(&qid);

        self.emit(
            &project,
            PanelEvent::AskResolved {
                session_id,
                qid,
                answered: answer.is_some(),
            },
        );

        answer.unwrap_or_else(|| json!({"timeout": true}))
    }

    fn on_answer(&self, body: &Value) -> Value {
        let qid = body["qid"].as_str().unwrap_or_default();
        json!({ "ok": self.answer(qid, body["value"].clone()) })
    }

    fn emit(&self, project: &str, event: PanelEvent) {
        (self.sink)(ProjectEvent {
            project: project.to_string(),
            event,
        });
    }

    fn resolve(&self, instance: &str, cwd: &str) -> Option<String> {
        self.router.lock().unwrap().resolve(instance, cwd)
    }

    fn tracked_path(&self, project: &str, body: &Value, path: &str) -> Option<PathBuf> {
        if path.trim().is_empty() {
            return None;
        }
        let root = self.router.lock().unwrap().root_for(project)?;
        let candidate = PathBuf::from(path);
        let candidate = if candidate.is_absolute() {
            candidate
        } else {
            PathBuf::from(body["cwd"].as_str().unwrap_or_default()).join(candidate)
        };
        let root = root.canonicalize().ok()?;
        let resolved = if candidate.exists() {
            candidate.canonicalize().ok()?
        } else {
            let parent = candidate.parent()?.canonicalize().ok()?;
            parent.join(candidate.file_name()?)
        };
        resolved.starts_with(&root).then_some(resolved)
    }

    fn read_tracked(path: &PathBuf) -> Option<String> {
        if !path.exists() {
            return Some(String::new());
        }
        let meta = path.metadata().ok()?;
        if !meta.is_file() || meta.len() > MAX_TRACKED_FILE {
            return None;
        }
        std::fs::read_to_string(path).ok()
    }

    fn capture_before(&self, project: &str, session: &str, body: &Value, path: &str) {
        let Some(path) = self.tracked_path(project, body, path) else {
            return;
        };
        let Some(before) = Self::read_tracked(&path) else {
            return;
        };
        let key = format!("{project}\0{session}\0{}", path.display());
        self.changes.lock().unwrap().insert_pending(key, before);
    }

    fn capture_after(&self, project: &str, session: &str, body: &Value, path: &str, tool: &str) {
        let Some(path) = self.tracked_path(project, body, path) else {
            return;
        };
        let Some(after) = Self::read_tracked(&path) else {
            return;
        };
        let pending = format!("{project}\0{session}\0{}", path.display());
        let before = {
            let mut log = self.changes.lock().unwrap();
            log.take_pending(&pending)
        };
        let before = before.or_else(|| {
            self.file_changes(project, &path.to_string_lossy())
                .last()
                .map(|step| step.after.clone())
        });
        if let Some(before) = before {
            self.store_change(project, &path.to_string_lossy(), &before, &after, tool);
        }
    }

    fn store_change(&self, project: &str, path: &str, before: &str, after: &str, tool: &str) {
        if before == after {
            return;
        }
        let mut log = self.changes.lock().unwrap();
        log.push(project, path, before, after, tool);
    }
}

/// Classify a shell command as a git moment worth animating, or not at all.
fn git_kind(command: &str) -> Option<&'static str> {
    let kinds = [
        "commit", "push", "pull", "merge", "rebase", "checkout", "branch", "stash", "reset",
        "revert", "tag", "fetch", "clone", "add",
    ];
    let mut found = None;
    // A Bash tool call commonly scopes Git with `-C`, prefixes it with `cd … &&`, or performs
    // commit+push together. Classify the last completed Git moment in the command—the state the
    // UI should settle on—without mistaking words later in a quoted commit message for commands.
    for segment in command.split([';', '\n']).flat_map(|part| part.split("&&")) {
        let words: Vec<_> = segment.split_whitespace().collect();
        let Some(mut index) = words
            .iter()
            .position(|word| word.trim_matches(|c| c == '(' || c == ')') == "git")
            .map(|position| position + 1)
        else {
            continue;
        };
        while index < words.len() {
            let word = words[index].trim_matches(|c: char| c == '(' || c == ')' || c == ';');
            if matches!(word, "-C" | "-c" | "--git-dir" | "--work-tree" | "--namespace") {
                index += 2;
                continue;
            }
            if word.starts_with('-') {
                index += 1;
                continue;
            }
            if let Some(kind) = kinds.iter().copied().find(|kind| *kind == word) {
                found = Some(kind);
            }
            break;
        }
    }
    found
}

/// The two shell moments that materially change a human's understanding of the work. Reads,
/// greps and package-manager chatter stay out of the scene; verification earns one checkpoint.
fn work_checkpoint(command: &str) -> Option<&'static str> {
    let c = command.trim().to_ascii_lowercase();
    let tests = [
        "cargo test",
        "flutter test",
        "dart test",
        "pytest",
        "python -m pytest",
        "python3 -m pytest",
        "npm test",
        "npm run test",
        "pnpm test",
        "yarn test",
        "go test",
        "swift test",
        "xcodebuild test",
    ];
    if tests.iter().any(|prefix| c.starts_with(prefix)) {
        return Some("Tests passed");
    }
    let builds = [
        "cargo build",
        "flutter build",
        "npm run build",
        "pnpm build",
        "yarn build",
        "go build",
        "swift build",
        "xcodebuild",
        "dart compile",
    ];
    builds
        .iter()
        .any(|prefix| c.starts_with(prefix))
        .then_some("Build completed")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn edit_history_stays_bounded_across_many_files_and_projects() {
        let mut log = ChangeLog::default();
        let before = "a".repeat(300_000);
        let after = "b".repeat(300_000);
        for index in 0..60 {
            log.push("app", &format!("file-{index}.rs"), &before, &after, "Edit");
        }
        assert!(log.step_bytes <= MAX_CHANGE_BYTES);
        assert!(log.step_order.len() <= MAX_CHANGE_STEPS);
        assert!(!log.files.contains_key("app\0file-0.rs"));
        assert!(log.files.contains_key("app\0file-59.rs"));
        log.push("other", "kept.rs", "old", "new", "Edit");

        for index in 0..20 {
            log.insert_pending(format!("app\0session\0file-{index}.rs"), before.clone());
        }
        assert_eq!(log.pending.len(), MAX_PENDING_EDITS);
        assert!(!log.pending.contains_key("app\0session\0file-0.rs"));
        log.clear_project("app");
        assert!(log.pending.is_empty());
        assert!(log.pending_order.is_empty());
        assert!(log.files.contains_key("other\0kept.rs"));
        assert_eq!(log.step_order.len(), 1);
        assert_eq!(log.step_bytes, log.files["other\0kept.rs"][0].memory_bytes());
    }

    /// The fixture project root. Report paths must be absolute to be made project-relative,
    /// and `/tmp` is not absolute on Windows.
    const TAVLA: &str = if cfg!(windows) { "C:/tmp/tavla" } else { "/tmp/tavla" };

    /// An ingress with one agent bound to project "tavla", working in /tmp/tavla.
    fn ingress() -> (Ingress, mpsc::Receiver<ProjectEvent>) {
        let (tx, rx) = mpsc::channel();
        let sink: EventSink = Arc::new(move |event| {
            let _ = tx.send(event);
        });
        let ingress = Ingress::serve(sink).unwrap();
        ingress.register_agent("s1", "tavla", TAVLA);
        (ingress, rx)
    }

    /// A permission prompt parks the agent and must say so. An idle reminder after a finished
    /// turn must not, or every quiet agent would claim to need you a minute after it stopped.
    #[test]
    fn only_a_human_wait_becomes_waiting() {
        let (ingress, rx) = ingress();
        let notify = |kind: &str, message: &str| {
            ingress.on_hook(
                "Notification",
                &json!({
                    "instance": "s1",
                    "cwd": TAVLA,
                    "notification_type": kind,
                    "message": message,
                }),
            );
        };
        notify("idle_prompt", "Claude is waiting for your input");
        notify("permission_prompt", "Claude needs your permission to use Bash");
        match rx.recv().unwrap().event {
            PanelEvent::AgentStatus { session_id, status, detail } => {
                assert_eq!(session_id, "s1");
                assert_eq!(status, "waiting");
                assert_eq!(detail.as_deref(), Some("Claude needs your permission to use Bash"));
            }
            other => panic!("expected a waiting status, got {other:?}"),
        }
        assert!(rx.try_recv().is_err(), "the idle reminder must not have emitted anything");
    }

    #[test]
    fn git_commands_are_classified_and_plain_ones_ignored() {
        assert_eq!(git_kind("git commit -m 'x'"), Some("commit"));
        assert_eq!(git_kind("  git   push --force  "), Some("push"));
        assert_eq!(git_kind("git -C panel commit -m 'x'"), Some("commit"));
        assert_eq!(
            git_kind("cd panel && git commit -m 'x' && git push origin main"),
            Some("push")
        );
        assert_eq!(git_kind("git -c core.editor=true merge feature/a"), Some("merge"));
        assert_eq!(git_kind("cargo test"), None);
        assert_eq!(git_kind("gitk"), None);
    }

    #[test]
    fn only_verification_commands_earn_workshop_checkpoints() {
        assert_eq!(work_checkpoint("flutter test"), Some("Tests passed"));
        assert_eq!(
            work_checkpoint("cargo build --release"),
            Some("Build completed")
        );
        assert_eq!(
            work_checkpoint("xcodebuild test -scheme Panel"),
            Some("Tests passed")
        );
        assert_eq!(work_checkpoint("rg auth src"), None);
        assert_eq!(work_checkpoint("npm install"), None);
    }

    #[test]
    fn pre_and_post_edit_hooks_capture_exact_replay_steps() {
        let root = std::env::temp_dir().join(format!(
            "panel-replay-{}-{}",
            std::process::id(),
            Uuid::new_v4()
        ));
        std::fs::create_dir_all(root.join("lib")).unwrap();
        let file = root.join("lib/auth.dart");
        std::fs::write(&file, "retry = 1;\n").unwrap();

        let (tx, _rx) = mpsc::channel();
        let sink: EventSink = Arc::new(move |event| {
            let _ = tx.send(event);
        });
        let ingress = Ingress::serve(sink).unwrap();
        ingress.register_agent("agent", "app", &root);
        let hook = |event: &str| {
            ingress.on_hook(
                event,
                &json!({
                    "session_id": "claude-session",
                    "cwd": root.join("lib"),
                    "tool_name": "Edit",
                    "tool_input": {"file_path": file},
                }),
            );
        };

        hook("PreToolUse");
        std::fs::write(&file, "retry = 3;\n").unwrap();
        hook("PostToolUse");

        let steps = ingress.file_changes("app", "lib/auth.dart");
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].before, "retry = 1;\n");
        assert_eq!(steps[0].after, "retry = 3;\n");
        assert_eq!(steps[0].tool, "Edit");
        let _ = std::fs::remove_dir_all(root);
    }

    /// A hook carries Claude's own session id, never ours — so it is placed by `cwd`.
    #[test]
    fn an_edit_hook_is_routed_to_its_project_by_cwd() {
        let (ingress, rx) = ingress();
        ingress.on_hook(
            "PostToolUse",
            &json!({
                "session_id": "some-claude-uuid-we-have-never-seen",
                "cwd": format!("{TAVLA}/lib"),
                "tool_name": "Edit",
                "tool_input": {"file_path": format!("{TAVLA}/lib/a.dart")},
            }),
        );
        let event = rx.recv().unwrap();
        assert_eq!(event.project, "tavla");
        match event.event {
            PanelEvent::FileChanged { path, .. } => {
                assert_eq!(path, PathBuf::from(format!("{TAVLA}/lib/a.dart")));
            }
            other => panic!("expected a file change, got {other:?}"),
        }
    }

    #[test]
    fn hosted_hook_keeps_the_panel_terminal_session_id() {
        let (ingress, rx) = ingress();
        ingress.on_hook(
            "UserPromptSubmit",
            &json!({
                "instance": "s1",
                "session_id": "claude-internal-id",
                "cwd": TAVLA,
                "prompt": "Fix only the current request",
            }),
        );
        let event = rx.recv().unwrap();
        match event.event {
            PanelEvent::AgentStatus {
                session_id, detail, ..
            } => {
                assert_eq!(session_id, "s1");
                assert_eq!(detail.as_deref(), Some("Fix only the current request"));
            }
            other => panic!("expected prompt status, got {other:?}"),
        }
    }

    #[test]
    fn rich_messages_are_routed_and_absolute_project_paths_become_previewable() {
        let (ingress, rx) = ingress();
        ingress.on_emit(&json!({
            "instance": "s1",
            "type": "message",
            "payload": {
                "title": "Three widget directions",
                "images": [
                    format!("{TAVLA}/design/one.png"),
                    {"path": format!("{TAVLA}/design/two.png"), "caption": "quiet"}
                ],
                "attachments": [{"path": format!("{TAVLA}/design"), "kind": "folder"}]
            }
        }));
        let event = rx.recv().unwrap();
        assert_eq!(event.project, "tavla");
        match event.event {
            PanelEvent::VisualRequested { view, payload, .. } => {
                assert_eq!(view, "message");
                assert_eq!(payload["_panel_project"], "tavla");
                assert_eq!(payload["images"][0], "design/one.png");
                assert_eq!(payload["images"][1]["path"], "design/two.png");
                assert_eq!(payload["attachments"][0]["path"], "design");
            }
            other => panic!("expected a rich message, got {other:?}"),
        }
    }

    /// An engine that never received PANEL_INSTANCE — a plain shell, a CLI with no
    /// session-scoped config — is still standing inside a registered project. Dropping its report
    /// was how "the agent said nothing" happened for everything that isn't claude or codex.
    #[test]
    fn a_report_with_no_instance_is_routed_by_the_directory_it_was_sent_from() {
        let (ingress, rx) = ingress();
        ingress.on_emit(&json!({
            "instance": "",
            "cwd": format!("{TAVLA}/design"),
            "type": "message",
            "payload": { "title": "shot", "images": [format!("{TAVLA}/design/one.png")] }
        }));
        let event = rx.recv().unwrap();
        assert_eq!(event.project, "tavla");
        match event.event {
            PanelEvent::VisualRequested { payload, .. } => {
                assert_eq!(payload["_panel_project"], "tavla");
                assert_eq!(payload["images"][0], "design/one.png");
            }
            other => panic!("expected a rich message, got {other:?}"),
        }
    }

    /// Panel shows the agents it runs — not every `claude` on the machine.
    #[test]
    fn a_hook_from_an_unknown_project_is_dropped() {
        let (ingress, rx) = ingress();
        ingress.on_hook(
            "PostToolUse",
            &json!({
                "cwd": "/somewhere/else",
                "tool_name": "Edit",
                "tool_input": {"file_path": "/somewhere/else/a.rs"},
            }),
        );
        assert!(
            rx.try_recv().is_err(),
            "an unrouted hook must not reach the UI"
        );
    }

    /// A project nested inside another must not have its events stolen by the parent.
    #[test]
    fn the_deepest_matching_project_wins() {
        let (tx, rx) = mpsc::channel();
        let sink: EventSink = Arc::new(move |event| {
            let _ = tx.send(event);
        });
        let ingress = Ingress::serve(sink).unwrap();
        ingress.register_agent("outer", "monorepo", "/tmp/repo");
        ingress.register_agent("inner", "app", "/tmp/repo/apps/app");

        ingress.on_hook(
            "PostToolUse",
            &json!({
                "cwd": "/tmp/repo/apps/app/lib",
                "tool_name": "Write",
                "tool_input": {"file_path": "/tmp/repo/apps/app/lib/x.dart"},
            }),
        );
        assert_eq!(rx.recv().unwrap().project, "app");
    }

    #[test]
    fn an_ask_blocks_until_the_ui_answers_and_returns_that_answer() {
        let (ingress, rx) = ingress();
        let asker = ingress.clone();
        let asking = thread::spawn(move || {
            asker.on_ask(&json!({
                "instance": "s1",
                "spec": {"kind": "pick", "ask": "ship?"},
                "timeout": 10.0,
            }))
        });

        // The UI learns about the question only through the event stream.
        let requested = rx.recv().unwrap();
        assert_eq!(requested.project, "tavla");
        let qid = match requested.event {
            PanelEvent::AskRequested { qid, .. } => qid,
            other => panic!("expected an ask, got {other:?}"),
        };
        while !ingress.answer(&qid, json!({"choice": "ship"})) {
            thread::yield_now();
        }

        assert_eq!(asking.join().unwrap(), json!({"choice": "ship"}));
        assert!(matches!(
            rx.recv().unwrap().event,
            PanelEvent::AskResolved { answered: true, .. }
        ));
    }

    #[test]
    fn an_unanswered_ask_times_out_rather_than_hanging_the_agent() {
        let (ingress, _rx) = ingress();
        let answer = ingress.on_ask(&json!({
            "instance": "s1",
            "spec": {"kind": "pick"},
            "timeout": 1.0,
        }));
        assert_eq!(answer, json!({"timeout": true}));
    }
}
