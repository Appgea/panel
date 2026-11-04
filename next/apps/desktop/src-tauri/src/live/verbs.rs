//! The verb of a step: what kind of thing an agent is doing, in one short key like `git.push`,
//! `search` or `spawn`. Live's animation catalog holds one script per verb, and a verb with no
//! script gets one written (catalog.rs). So a verb names a kind of work, never one instance of
//! it: `cmd.ffmpeg`, not the file it renders.

/// A tool call's verb. `command` is the shell text for Bash and Codex commands.
pub fn of_tool(name: &str, command: Option<&str>) -> String {
    match name {
        "Bash" | "shell" | "exec_command" | "local_shell" => command.map(of_command).unwrap_or_else(|| "cmd".into()),
        "Edit" | "MultiEdit" | "NotebookEdit" | "Write" | "apply_patch" => "edit".into(),
        "Read" => "read".into(),
        "Grep" | "Glob" | "LSP" => "search".into(),
        "WebSearch" | "WebFetch" => "web".into(),
        "Agent" | "Task" | "Workflow" => "spawn".into(),
        "SendMessage" => "message".into(),
        "AskUserQuestion" => "ask".into(),
        "Skill" => "skill".into(),
        "Artifact" => "publish".into(),
        n if n.starts_with("mcp__") => {
            let server = n.trim_start_matches("mcp__").split("__").next().unwrap_or("tool");
            format!("mcp.{}", key(server.trim_start_matches("claude_ai_")))
        }
        other => format!("tool.{}", key(other)),
    }
}

/// Words that name a verb when they show up in a command, strongest first: `land` commits and
/// pushes, so it is a push, and "build and test" is a test.
const RULES: &[(&str, &[&str])] = &[
    ("git.push", &["git push", "land", "carry"]),
    ("release", &["fastlane", "altool", "release.sh", "upload", "publish"]),
    ("git.commit", &["git commit"]),
    ("review", &["review.sh", "judge"]),
    ("test", &["test", "pytest", "vitest", "jest"]),
    ("typecheck", &["tsc", "typecheck", "cargo check", "flutter analyze", "lint", "clippy"]),
    ("build", &["build", "xcodebuild", "gradlew", "cargo run", "vite", "wasm-bindgen"]),
    ("shot", &["screenshot", "shoot", "playwright", "simctl io"]),
    ("render", &["ffmpeg", "render", "vk make", "blender"]),
    ("message", &["slack.py", "panel_send", "send_to_user"]),
    ("board", &["board ", "gh issue", "gh pr"]),
    ("git.pull", &["git pull", "git fetch", "git clone"]),
    ("web", &["curl", "wget"]),
    ("search", &["rg ", "grep", "find ", "fd "]),
    ("read", &["cat ", "sed -n", "head ", "tail ", "less ", "ls ", "wc ", "git log", "git diff", "git status", "git show"]),
];

/// A shell command's verb. Unknown programs get `cmd.<program>`, so each new tool gets its own
/// animation the first time an agent runs it.
pub fn of_command(command: &str) -> String {
    // `testlock` only queues the command after it, and its name would read as a test.
    let c = format!(" {} ", command.to_lowercase().replace("testlock ", ""));
    for (verb, words) in RULES {
        if words.iter().any(|w| c.contains(&format!(" {w}")) || c.contains(&format!("/{w}"))) {
            return (*verb).into();
        }
    }
    match program(command) {
        Some(p) => format!("cmd.{p}"),
        None => "cmd".into(),
    }
}

/// The program a command runs: past `cd x &&`, env settings, `testlock` and `time`, and the
/// script's name for `python3 x.py` or `node x.mjs`.
fn program(command: &str) -> Option<String> {
    let first = command.split(['|', ';', '\n']).flat_map(|s| s.split("&&")).map(str::trim).find(|s| !s.is_empty() && !s.starts_with("cd "))?;
    let mut words = first.split_whitespace().filter(|w| !w.contains('=') && !matches!(*w, "testlock" | "time" | "sudo" | "exec" | "nohup" | "env"));
    let mut p = words.next()?;
    if matches!(p.rsplit('/').next().unwrap_or(p), "python" | "python3" | "node" | "bash" | "sh" | "zsh" | "npx" | "uv" | "bun" | "deno") {
        p = words.find(|w| !w.starts_with('-')).unwrap_or(p);
    }
    let name = p.rsplit('/').next().unwrap_or(p);
    let name = name.split('.').next().unwrap_or(name);
    let k = key(name);
    (!k.is_empty()).then_some(k)
}

/// A verb part: lowercase letters, digits and dashes, at most 24 characters. The catalog uses
/// it as a file name.
fn key(s: &str) -> String {
    s.chars().map(|c| c.to_ascii_lowercase()).map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect::<String>().trim_matches('-').chars().take(24).collect()
}

#[cfg(test)]
mod tests {
    use super::{of_command, of_tool};

    #[test]
    fn commands_get_the_verb_of_their_strongest_word() {
        let table = [
            ("git push origin develop", "git.push"),
            ("cd ~/x && land --now", "git.push"),
            ("git add a.rs && git commit -m 'x'", "git.commit"),
            ("testlock cargo test live::", "test"),
            ("npx tsc --noEmit", "typecheck"),
            ("testlock node scripts/build-live.mjs", "build"),
            ("rg -n foo src/", "search"),
            ("sed -n 1,40p a.rs", "read"),
            ("ffmpeg -i a.webm b.mp4", "render"),
            ("python3 ~/.appgeapanel/ops/runbooks/slack.py say --to news", "message"),
            ("FOO=1 python3 tools/frobnicate.py --x", "cmd.frobnicate"),
            ("cd /tmp && magick in.png out.png", "cmd.magick"),
        ];
        for (command, verb) in table {
            assert_eq!(of_command(command), verb, "{command}");
        }
        assert_eq!(of_tool("Agent", None), "spawn");
        assert_eq!(of_tool("mcp__claude_ai_Slack__slack_send_message", None), "mcp.slack");
    }
}
