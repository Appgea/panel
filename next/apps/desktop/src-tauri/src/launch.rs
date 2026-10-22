//! How a terminal-hosted `claude` learns to talk back to Panel.
//!
//! Two files, generated per launch and handed to the agent as flags:
//!
//!   --settings    registers `session_hook.py` on the session lifecycle. THIS is the
//!                 reliability backbone: the hook fires because the tool ran, not because
//!                 the model chose to mention it. Without this the panel goes quiet and
//!                 starts lying by omission.
//!   --mcp-config  registers `panel_mcp.py`, giving the agent `panel_emit` (show
//!                 this) and `ask_user` (block on a human answer).
//!
//! Both shims are the ones the old Python Panel already shipped and already speak our
//! loopback contract, so they are reused verbatim — we only replaced the listener.
//!
//! Everything degrades: if a shim is missing we simply omit its flag and launch a plain
//! `claude`. A missing panel must never mean a broken agent.

use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};

/// Tools whose PostToolUse we care about — the edit family plus Bash (for git moments).
const EDIT_MATCHER: &str = "Edit|Write|MultiEdit|NotebookEdit";

pub struct AgentLaunch {
    pub args: Vec<String>,
}

/// Claude's per-process settings overlay keeps skill visibility local to this PTY.
pub fn apply_skill_overrides(launch: &mut AgentLaunch, instance: &str,
    overrides: serde_json::Value) -> Result<(), String> {
    if overrides.as_object().is_none_or(|map| map.is_empty()) { return Ok(()); }
    let index = launch.args.iter().position(|arg| arg == "--settings");
    let path = index.map(|i| PathBuf::from(&launch.args[i + 1]))
        .unwrap_or_else(|| std::env::temp_dir().join(format!("appgea-panel-skills-{instance}.json")));
    let mut settings: serde_json::Value = if index.is_some() {
        serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?
    } else { json!({}) };
    settings["skillOverrides"] = overrides;
    fs::write(&path, serde_json::to_vec(&settings).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if index.is_none() {
        launch.args.extend(["--settings".into(), path.to_string_lossy().into_owned()]);
    }
    Ok(())
}

const PANEL_RULE: &str = "You are a worker inside Panel. TALK TO THE HUMAN IN THIS TERMINAL — \
the only conversation. send_to_user is not a message: it files a report to the human's Inbox. Call it only \
when done, blocked, needing a decision, or you made something to see or hear. Never per turn, never \
for progress. Send a short title, ONE sentence `text`, an `outcome` (progress|done|blocked|\
needs_decision), and `flow` code refs {ref, label, detail}. Every screenshot goes in `images`, \
CAPTIONED; clips in `audio`; video in `video`, shown as a link. To point the human at a place \
in Panel, in `links` or in this terminal, write panel:review (your work in Review; \
panel:review:<path> for one file), panel:work:<path>:<line> (the code in Work), panel:git or \
panel:manager — paths relative to the project. Report media already gets a Review button.";

/// Which agent this is. Workers build a project and report to the Inbox. The manager is the one
/// agent that does neither, and the worker rule told it it was a worker: it filed reports to
/// itself and had no idea what the Manager screen was.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Role {
    Worker,
    Manager,
}

impl Role {
    /// `PANEL_ROLE` for the panel MCP. Only the manager is offered the team tools; the UI checks
    /// the asking session's project as well, so a worker setting this itself gets nothing.
    fn env(self) -> &'static str {
        match self {
            Role::Worker => "worker",
            Role::Manager => "manager",
        }
    }
}

fn manager_rule() -> String {
    let reports = crate::paths::brain_dir().join("reports");
    format!(
        "You are the Manager inside Panel, the human's admin app for the Appgea portfolio. You are \
not a worker. You do not change app code and you do not file reports, so never call send_to_user \
or panel_send.py. TALK TO THE HUMAN IN THIS TERMINAL: it is Panel's Manager screen, opened with \
{}+Shift+M. Your folder is the ops tree, the company brain. Its AGENTS.md is your standing \
instructions, and the human edits it from that screen. Workers are separate agents, one or more per \
project, each in its own Panel terminal. What they report lands in {} as one Markdown log per \
project, newest entry last. If the appgea-panel tools are available, list_workers shows every live \
terminal with its status, read_worker shows what is on one's screen right now, and brief_worker \
types a prompt into one after the human approves it in Panel. Read before you brief, and never \
brief a worker that is mid-turn or waiting on the human. Your job: tell the human where things \
stand, plan the work, keep ops current, and brief workers.",
        if cfg!(target_os = "macos") { "Cmd" } else { "Ctrl" },
        reports.display()
    )
}

/// The rule for this role, in the one place every engine's flags read it from.
fn rule_for(panel_home: &Path, role: Role) -> String {
    match role {
        Role::Worker => rule_with_fallback(panel_home),
        Role::Manager => manager_rule(),
    }
}

/// Appended for every engine: the panel MCP is the good path, and this is what to do when it is
/// not there. Codex sandboxes, engines with no session-scoped MCP flag, and anything new all fall
/// back to the same script, so "the pictures never showed up" stops being per-engine luck.
fn rule_with_fallback(panel_home: &Path) -> String {
    let sender = panel_home.join("panel_send.py");
    if !sender.is_file() {
        return PANEL_RULE.to_string();
    }
    format!(
        "{PANEL_RULE} If the appgea-panel MCP tool is unavailable or errors, do the same thing by \
running `{} {}` with --title, --text, --outcome, one or more '--flow ref|label|detail' \
values, one --image per screenshot, --audio per clip and --video per film (plus any useful --file, \
--folder, --link). Never silently skip a report you owed.",
        crate::platform::python(),
        shell_quote(&sender.to_string_lossy())
    )
}

/// Build the argv for `claude`, wiring whichever shims actually exist on disk.
pub fn agent_args(panel_home: &Path, port: u16, instance: &str, role: Role) -> AgentLaunch {
    let mut args = vec![
        "--append-system-prompt".into(),
        rule_for(panel_home, role),
    ];

    if let Some(settings) = write_settings(panel_home, instance) {
        args.push("--settings".into());
        args.push(settings.to_string_lossy().into_owned());
    }
    if let Some(mcp) = write_mcp(panel_home, port, instance, role) {
        args.push("--mcp-config".into());
        args.push(mcp.to_string_lossy().into_owned());
    }

    AgentLaunch { args }
}

/// Codex accepts arbitrary config as per-process `-c` overrides. This keeps Panel's MCP and
/// instruction scoped to the hosted terminal instead of modifying the user's global config.
pub fn codex_args(panel_home: &Path, port: u16, instance: &str, role: Role) -> AgentLaunch {
    let rule = rule_for(panel_home, role);
    let Some(server) = panel_server(panel_home) else {
        // No MCP to wire, but the instruction (and its script fallback) is still worth having —
        // an engine with no panel used to launch completely mute.
        let quote = |value: &str| serde_json::to_string(value).unwrap();
        return AgentLaunch {
            args: vec![
                "-c".into(),
                format!("developer_instructions={}", quote(&rule)),
            ],
        };
    };
    let quote = |value: &str| serde_json::to_string(value).unwrap();
    // Codex hands the MCP server exactly the env map it is given — nothing is inherited. Without
    // PATH the server process cannot find `python3`'s own toolchain, the panel never starts, and
    // Codex looks like an agent that simply refuses to show you anything.
    let path = std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin:/usr/local/bin".into());
    AgentLaunch {
        args: vec![
            // Panel's MCP only talks to this app over loopback. Approve its tools here instead
            // of disabling Codex's reviewer for the whole session: reports with attachments then
            // reach the Inbox, while shell commands and every other tool keep their normal gate.
            "-c".into(),
            format!(
                "mcp_servers.appgea-panel.default_tools_approval_mode={}",
                quote("approve")
            ),
            "-c".into(),
            format!("mcp_servers.appgea-panel.command={}", quote(crate::platform::python())),
            "-c".into(),
            format!(
                "mcp_servers.appgea-panel.args=[{}]",
                quote(&server.to_string_lossy())
            ),
            "-c".into(),
            format!("mcp_servers.appgea-panel.env.PATH={}", quote(&path)),
            "-c".into(),
            format!("mcp_servers.appgea-panel.env.HOME={}", quote(&home_dir())),
            "-c".into(),
            format!(
                "mcp_servers.appgea-panel.env.PANEL_PORT={}",
                quote(&port.to_string())
            ),
            "-c".into(),
            format!(
                "mcp_servers.appgea-panel.env.PANEL_INSTANCE={}",
                quote(instance)
            ),
            "-c".into(),
            format!("mcp_servers.appgea-panel.env.PANEL_ROLE={}", quote(role.env())),
            "-c".into(),
            format!("developer_instructions={}", quote(&rule)),
        ],
    }
}

fn home_dir() -> String {
    std::env::var("HOME").unwrap_or_default()
}

/// Grok has a session-scoped rules flag but no session-scoped MCP flag. Give it the same behavior
/// through the tiny sender script; PANEL_PORT/INSTANCE arrive through the PTY environment.
pub fn grok_args(panel_home: &Path, role: Role) -> AgentLaunch {
    // A worker's rule is only worth sending with the sender it names. The manager's never needs it.
    if role == Role::Worker && !panel_home.join("panel_send.py").is_file() {
        return AgentLaunch { args: Vec::new() };
    }
    AgentLaunch {
        args: vec!["--rules".into(), rule_for(panel_home, role)],
    }
}

fn panel_server(panel_home: &Path) -> Option<PathBuf> {
    let server = panel_home.join("mcp").join("panel_mcp.py");
    server.is_file().then_some(server)
}

/// Hook registration. The forwarder reads `PANEL_PORT` from its own environment, which it
/// inherits from the agent, which inherits it from the PTY — so no port is baked in here.
/// Single-quote a path for /bin/sh. Any embedded quote is closed, escaped, and reopened.
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

fn write_settings(panel_home: &Path, instance: &str) -> Option<PathBuf> {
    let forwarder = panel_home.join("session_hook.py");
    if !forwarder.is_file() {
        return None;
    }
    // The hook command is a SHELL line. Panel installs to "…/Appgea Panel.app", so an unquoted
    // path splits at the space and every prompt dies on "can't open file '/Users/…/Panel'".
    let forwarder = shell_quote(&forwarder.to_string_lossy());
    let run = json!([{ "type": "command", "command": format!("{} {forwarder}", crate::platform::python()) }]);

    let settings = json!({
        "hooks": {
            // Replay needs the real before-image. This hook returns immediately after Panel
            // captures it; it never injects context or decides whether the edit may proceed.
            "PreToolUse": [
                { "matcher": EDIT_MATCHER, "hooks": run }
            ],
            // Edits and Bash are separate matchers: the edit family drives the file rail,
            // Bash is where git moments come from. Matching "*" would flood the panel.
            "PostToolUse": [
                { "matcher": EDIT_MATCHER, "hooks": run },
                { "matcher": "Bash", "hooks": run },
                { "matcher": "Skill", "hooks": run },
            ],
            "UserPromptSubmit": [{ "hooks": run }],
            // Stop only. A subagent finishing is mid-turn for the agent that spawned it, and
            // calling it a finished turn would tell you it is your move while it still works.
            "Stop": [{ "hooks": run }],
            // A permission prompt parks the agent in its own terminal. Nothing else proves it:
            // without this the rail says "working" while the turn waits on a keypress.
            "Notification": [{ "hooks": run }],
        },
        // Pre-allow the panel tools. An approval prompt for "may I show you something"
        // is friction with no security value — the tools only draw in our own window.
        "permissions": {
            "allow": [
                "mcp__appgea-panel__panel_emit",
                "mcp__appgea-panel__send_to_user",
                "mcp__appgea-panel__ask_user",
                // The manager's team tools. Only its MCP lists them, and Panel already shows
                // the human every brief before typing it, so a second prompt here adds nothing.
                "mcp__appgea-panel__list_workers",
                "mcp__appgea-panel__read_worker",
                "mcp__appgea-panel__brief_worker"
            ]
        }
    });

    write_temp(&format!("appgea-panel-settings-{instance}.json"), &settings)
}

fn write_mcp(panel_home: &Path, port: u16, instance: &str, role: Role) -> Option<PathBuf> {
    let server = panel_server(panel_home)?;
    let config = json!({
        "mcpServers": {
            "appgea-panel": {
                "command": crate::platform::python(),
                "args": [server.to_string_lossy()],
                "env": {
                    "PANEL_PORT": port.to_string(),
                    "PANEL_INSTANCE": instance,
                    "PANEL_ROLE": role.env(),
                },
            }
        }
    });

    write_temp(&format!("appgea-panel-mcp-{instance}.json"), &config)
}

fn write_temp(name: &str, value: &serde_json::Value) -> Option<PathBuf> {
    let path = std::env::temp_dir().join(name);
    fs::write(&path, serde_json::to_vec_pretty(value).ok()?).ok()?;
    Some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_panel_home_without_shims_still_launches_with_only_the_reporting_rule() {
        let launch = agent_args(Path::new("/nonexistent"), 1234, "i1", Role::Worker);
        assert_eq!(
            launch.args.first().map(String::as_str),
            Some("--append-system-prompt")
        );
        assert!(!launch.args.iter().any(|arg| arg == "--settings"));
        assert!(!launch.args.iter().any(|arg| arg == "--mcp-config"));
    }

    #[test]
    fn the_real_panel_home_wires_both_shims() {
        // The shims live in `host/`, a sibling of `next/`. If this ever stops being true the panel
        // silently goes dark, so the layout assumption gets a test.
        let home = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../host");
        if !home.join("session_hook.py").is_file() {
            return; // not a full checkout; nothing to assert
        }
        let launch = agent_args(&home, 4321, "i1", Role::Worker);
        assert!(launch.args.iter().any(|arg| arg == "--settings"));
        assert!(launch.args.iter().any(|arg| arg == "--mcp-config"));
        let settings_index = launch
            .args
            .iter()
            .position(|arg| arg == "--settings")
            .unwrap();
        let settings = fs::read_to_string(&launch.args[settings_index + 1]).unwrap();
        assert!(
            settings.contains("PreToolUse"),
            "exact replay needs a before-image hook"
        );
        assert!(
            settings.contains("Notification"),
            "a permission prompt must reach the rail as needs-you"
        );
    }

    #[test]
    fn codex_gets_session_scoped_panel_config_and_instruction() {
        let home = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../host");
        if !home.join("mcp/panel_mcp.py").is_file() {
            return;
        }
        let launch = codex_args(&home, 4321, "codex-1", Role::Worker);
        let joined = launch.args.join(" ");
        assert!(joined.contains("mcp_servers.appgea-panel.command"));
        assert!(joined.contains("PANEL_INSTANCE"));
        assert!(joined.contains("send_to_user"));
        assert!(joined.contains("default_tools_approval_mode=\"approve\""));
        // Codex gives its MCP servers ONLY the env map named here. Without PATH the panel never
        // starts and Codex looks like an engine that refuses to show the human anything.
        assert!(joined.contains("mcp_servers.appgea-panel.env.PATH"));
    }

    #[test]
    fn every_engine_is_told_how_to_report_without_the_mcp_tool() {
        let home = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../host");
        if !home.join("panel_send.py").is_file() {
            return;
        }
        // The fallback is what makes screenshots reach the Inbox from an engine whose MCP is
        // missing, sandboxed, or simply never wired — it must not be grok-only.
        for rule in [
            agent_args(&home, 1, "i", Role::Worker).args.join(" "),
            codex_args(&home, 1, "i", Role::Worker).args.join(" "),
            grok_args(&home, Role::Worker).args.join(" "),
        ] {
            assert!(
                rule.contains("panel_send.py"),
                "missing sender fallback: {rule}"
            );
            assert!(rule.contains("--image"), "missing image guidance: {rule}");
        }
    }

    #[test]
    fn the_manager_is_never_told_it_is_a_worker() {
        let home = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../host");
        for rule in [
            agent_args(&home, 1, "i", Role::Manager).args.join(" "),
            codex_args(&home, 1, "i", Role::Manager).args.join(" "),
            grok_args(Path::new("/nonexistent"), Role::Manager).args.join(" "),
        ] {
            assert!(rule.contains("You are the Manager"), "manager lost its identity: {rule}");
            assert!(!rule.contains("worker inside Panel"), "manager told it is a worker: {rule}");
        }
    }

    #[test]
    fn grok_gets_sender_rule_without_global_config() {
        let home = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../host");
        if !home.join("panel_send.py").is_file() {
            return;
        }
        let launch = grok_args(&home, Role::Worker);
        assert_eq!(launch.args.first().map(String::as_str), Some("--rules"));
        assert!(launch.args.join(" ").contains("panel_send.py"));
    }
}
