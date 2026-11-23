
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

const READERS: &[&str] = &["cat", "sed", "head", "tail", "less", "ls", "wc", "grep", "rg", "find", "fd", "awk", "jq", "echo", "cd", "git log", "git diff", "git status", "git show"];

pub fn of_command(command: &str) -> String {
    let lower = command.to_lowercase().replace("testlock ", "");
    let strongest = lower
        .split(['|', ';', '\n'])
        .flat_map(|s| s.split("&&"))
        .filter_map(|part| {
            let c = format!(" {} ", part.trim());
            let reads = READERS.iter().any(|r| c.starts_with(&format!(" {r} ")));
            RULES.iter().position(|(verb, words)| (!reads || matches!(*verb, "search" | "read")) && words.iter().any(|w| c.contains(&format!(" {w}")) || c.contains(&format!("/{w}"))))
        })
        .min();
    if let Some(i) = strongest {
        return RULES[i].0.into();
    }
    match program(command) {
        Some(p) => format!("cmd.{p}"),
        None => "cmd".into(),
    }
}

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
            ("testlock npm run build", "build"),
            ("rg -n foo src/", "search"),
            ("sed -n 1,40p a.rs", "read"),
            ("sed -n 1,40p src/test/paywall_test.dart", "read"),
            ("grep -rn build lib/ | head -5", "search"),
            ("cat tests/notes.txt && flutter test", "test"),
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
