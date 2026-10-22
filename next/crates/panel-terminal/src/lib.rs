use anyhow::{anyhow, Context, Result};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use uuid::Uuid;

pub type TerminalSink = Arc<dyn Fn(TerminalChunk) + Send + Sync + 'static>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalChunk {
    pub terminal_id: String,
    pub data: String,
    pub closed: bool,
}

/// How much of each PTY's output is kept so the screen can be put back after a restart.
///
/// This is raw stream, escape sequences and all — replaying it into a fresh xterm reproduces the
/// colours and the layout, which a plain-text transcript cannot. 192 KB is about two thousand
/// lines of a talkative agent: enough to recognise where you were, small enough that nine of them
/// cost under two megabytes of a process that is mostly waiting.
const SCREEN_CAP: usize = 192 * 1024;

struct TerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Box<dyn Child + Send + Sync>,
    /// The tail of everything this PTY has printed. Written by the reader thread, read by
    /// whoever is saving the wall — hence the lock the thread already holds a handle to.
    screen: Arc<Mutex<String>>,
    /// Windows only: the job holding this PTY's whole process tree. Dropping it ends them all.
    #[cfg(windows)]
    job: Option<job::Job>,
}

/// Drop the front of a kept screen until it fits, then move the cut forward to the next newline.
///
/// Cutting at an arbitrary byte would slice a colour escape in half and the replay would open
/// with one garbled line. Cutting at a line boundary cannot: an escape sequence never spans one.
fn trim_screen(screen: &mut String) {
    // Headroom, not a hard cap. Trimming at exactly the cap shifted the whole 192 KB buffer on
    // every read once it was full: a busy agent paid for a full copy per 8 KB chunk.
    if screen.len() > SCREEN_CAP * 2 {
        trim_to_cap(screen);
    }
}

/// Cut to at most `SCREEN_CAP`, starting on a character and, where one exists, a line boundary.
fn trim_to_cap(screen: &mut String) {
    if screen.len() <= SCREEN_CAP {
        return;
    }
    let over = screen.len() - SCREEN_CAP;
    let mut cut = screen
        .char_indices()
        .map(|(at, _)| at)
        .find(|at| *at >= over)
        .unwrap_or(screen.len());
    if let Some(newline) = screen[cut..].find('\n') {
        cut += newline + 1;
    }
    screen.drain(..cut);
}

/// What to run in a new PTY.
///
/// `env` is how an agent learns to talk back to Panel: we inject `PANEL_PORT` and
/// `PANEL_INSTANCE`, and the hook/MCP shims already read exactly those. The agent itself
/// is launched plain — no wrapper, no side protocol — so it behaves in Panel exactly as it
/// does in a normal terminal, which is the entire point of hosting it this way.
pub struct SpawnSpec {
    pub cwd: PathBuf,
    /// `None` runs the user's login shell.
    pub command: Option<String>,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
    /// Answer the cursor-position query (`ESC[6n`) ourselves. Windows' ConPTY asks it before it
    /// prints a single byte and holds all output until someone replies. A terminal pane replies
    /// through xterm; a build/run PTY has no pane, so without this it sits silent forever.
    pub answer_cursor_query: bool,
}

impl SpawnSpec {
    pub fn shell(cwd: impl Into<PathBuf>, cols: u16, rows: u16) -> Self {
        Self {
            cwd: cwd.into(),
            command: None,
            args: Vec::new(),
            env: Vec::new(),
            cols,
            rows,
            answer_cursor_query: false,
        }
    }

    pub fn answering_cursor_query(mut self) -> Self {
        self.answer_cursor_query = true;
        self
    }

    pub fn run(mut self, command: impl Into<String>, args: Vec<String>) -> Self {
        self.command = Some(command.into());
        self.args = args;
        self
    }

    pub fn with_env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.push((key.into(), value.into()));
        self
    }
}

#[derive(Default)]
pub struct TerminalManager {
    sessions: HashMap<String, TerminalSession>,
}

impl TerminalManager {
    /// Open a PTY running the user's login shell.
    pub fn open(
        &mut self,
        cwd: impl AsRef<Path>,
        cols: u16,
        rows: u16,
        sink: TerminalSink,
    ) -> Result<String> {
        self.spawn(SpawnSpec::shell(cwd.as_ref(), cols, rows), sink)
    }

    /// Open a PTY running whatever the spec says, with its environment injected.
    pub fn spawn(&mut self, spec: SpawnSpec, sink: TerminalSink) -> Result<String> {
        let SpawnSpec {
            cwd,
            command: program,
            args,
            env,
            cols,
            rows,
            answer_cursor_query,
        } = spec;
        if !cwd.is_dir() {
            return Err(anyhow!("terminal folder does not exist: {}", cwd.display()));
        }

        let pair = native_pty_system().openpty(PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let program = program.unwrap_or_else(default_shell);
        #[cfg(windows)]
        let terminal_path = windows_terminal_path();
        #[cfg(windows)]
        let (launch, prefix) = windows_launch(&program, &terminal_path);
        #[cfg(not(windows))]
        let (launch, prefix) = (program.clone(), Vec::<String>::new());
        let mut command = CommandBuilder::new(&launch);
        for arg in prefix.into_iter().chain(args) {
            command.arg(arg);
        }
        command.cwd(&cwd);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        #[cfg(windows)]
        command.env("PATH", &terminal_path);
        for (key, value) in env {
            command.env(key, value);
        }
        let child = pair
            .slave
            .spawn_command(command)
            .with_context(|| format!("start {program}"))?;
        drop(pair.slave);
        #[cfg(windows)]
        let job = child.process_id().and_then(job::Job::holding);

        let terminal_id = Uuid::new_v4().to_string();
        let reader_id = terminal_id.clone();
        let mut reader = pair.master.try_clone_reader()?;
        let writer = Arc::new(Mutex::new(pair.master.take_writer()?));
        let reader_writer = Arc::clone(&writer);
        let screen = Arc::new(Mutex::new(String::new()));
        let reader_screen = Arc::clone(&screen);
        thread::spawn(move || {
            let mut buffer = [0_u8; 8192];
            // Holds the tail of a multi-byte character that a read stopped in the middle of, so
            // it can be finished by the next read instead of being decoded — and corrupted — early.
            let mut carry: Vec<u8> = Vec::new();
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => {
                        sink(TerminalChunk {
                            terminal_id: reader_id.clone(),
                            data: String::new(),
                            closed: true,
                        });
                        break;
                    }
                    Ok(read) => {
                        let data = decode_stream(&mut carry, &buffer[..read]);
                        if answer_cursor_query && data.contains("[6n") {
                            if let Ok(mut out) = reader_writer.lock() {
                                let _ = out.write_all(b"[1;1R");
                                let _ = out.flush();
                            }
                        }
                        if data.is_empty() {
                            continue; // the whole read was an unfinished character; wait for more
                        }
                        // Kept before it is sent: the UI may not be listening yet, and a screen
                        // that starts at "whenever the window opened" is not the screen.
                        if let Ok(mut kept) = reader_screen.lock() {
                            kept.push_str(&data);
                            trim_screen(&mut kept);
                        }
                        sink(TerminalChunk {
                            terminal_id: reader_id.clone(),
                            data,
                            closed: false,
                        });
                    }
                }
            }
        });

        self.sessions.insert(
            terminal_id.clone(),
            TerminalSession {
                master: pair.master,
                writer,
                child,
                screen,
                #[cfg(windows)]
                job,
            },
        );
        Ok(terminal_id)
    }

    /// The tail of what this PTY has printed, escape sequences intact. Replaying it into a fresh
    /// terminal is how a restored session opens on the screen it had rather than on a blank one.
    pub fn screen(&self, terminal_id: &str) -> Option<String> {
        self.sessions
            .get(terminal_id)
            .and_then(|session| session.screen.lock().ok())
            .map(|kept| {
                let mut tail = kept.clone();
                trim_to_cap(&mut tail);
                tail
            })
    }

    pub fn write(&mut self, terminal_id: &str, data: &str) -> Result<()> {
        let session = self
            .sessions
            .get_mut(terminal_id)
            .ok_or_else(|| anyhow!("terminal is not open"))?;
        let mut writer = session.writer.lock().map_err(|_| anyhow!("terminal writer is poisoned"))?;
        writer.write_all(data.as_bytes())?;
        writer.flush()?;
        Ok(())
    }

    pub fn resize(&mut self, terminal_id: &str, cols: u16, rows: u16) -> Result<()> {
        let session = self
            .sessions
            .get_mut(terminal_id)
            .ok_or_else(|| anyhow!("terminal is not open"))?;
        session.master.resize(PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    pub fn close(&mut self, terminal_id: &str) -> Result<()> {
        if let Some(closing) = self.take(terminal_id) {
            closing.end();
        }
        Ok(())
    }

    /// Detach a session without ending it. The manager sits behind one lock that every keystroke
    /// takes, and ending a session can take a second or more (a `ps` scan, the agent's own exit,
    /// a grace period for its children). So callers take under the lock and `end()` outside it.
    pub fn take(&mut self, terminal_id: &str) -> Option<ClosingTerminal> {
        self.sessions.remove(terminal_id).map(ClosingTerminal)
    }

    /// The pid of the process this PTY forked — the login shell, or the agent. Its live cwd is
    /// what "open another shell here" means, so the caller can read it off the OS.
    pub fn pid(&self, terminal_id: &str) -> Option<u32> {
        self.sessions
            .get(terminal_id)
            .and_then(|session| session.child.process_id())
    }

    /// The pid of the process group sitting in the FOREGROUND of this PTY — the one a keystroke
    /// would reach. It equals `pid()` while the spawned process is at its own prompt, and is a
    /// different pid whenever that process is running something (a build, an editor, a command).
    /// That difference is the only honest "is this terminal busy" signal: it ignores background
    /// helpers a program keeps alive for its own reasons, which no user thinks of as running.
    pub fn foreground_pid(&self, terminal_id: &str) -> Option<u32> {
        #[cfg(unix)]
        {
            self.sessions
                .get(terminal_id)
                .and_then(|session| session.master.process_group_leader())
                .filter(|pid| *pid > 0)
                .map(|pid| pid as u32)
        }
        #[cfg(not(unix))]
        {
            let _ = terminal_id;
            None
        }
    }

    /// Whether this PTY still owns a process. Non-blocking: shutdown guards can inspect every
    /// session without waiting on one that is busy compiling, prompting, or running an agent.
    pub fn is_running(&mut self, terminal_id: &str) -> bool {
        self.sessions
            .get_mut(terminal_id)
            .map(|session| !matches!(session.child.try_wait(), Ok(Some(_))))
            .unwrap_or(false)
    }
}

/// A session already out of the manager, waiting to be ended. See `TerminalManager::take`.
pub struct ClosingTerminal(TerminalSession);

impl ClosingTerminal {
    /// Kill the process and every descendant. Blocks until they are gone or SIGKILLed.
    pub fn end(self) {
        let mut session = self.0;
        // Read before the kill: once the agent dies its children belong to launchd, and
        // nothing links a dev server an agent started back to the tab that started it.
        let tree = session.child.process_id().map(descendants).unwrap_or_default();
        #[cfg(windows)]
        {
            // The job first: Git Bash's `exec` re-parents through a helper that exits, so
            // the parent links taskkill walks are already cut below a dev server's shell.
            drop(session.job.take());
            if let Some(pid) = session.child.process_id() {
                kill_tree(pid);
            }
        }
        let _ = session.child.kill();
        let _ = session.child.wait();
        end_all(&tree);
    }
}

impl Drop for TerminalManager {
    fn drop(&mut self) {
        let ids: Vec<_> = self.sessions.keys().cloned().collect();
        for id in ids {
            let _ = self.close(&id);
        }
    }
}

/// Turn raw PTY bytes into text without ever splitting a UTF-8 character across the seam
/// between two reads.
///
/// A fixed-size read can land in the middle of a multi-byte glyph — a box-drawing rule, the `❯`
/// prompt, an emoji, a spinner frame. Decoding each read on its own then turns that half into a
/// `` on both sides of the boundary, which is exactly the "the terminal is garbled" look. So an
/// unfinished tail is carried into the next read instead of being decoded early; only genuinely
/// invalid bytes (never a normal `claude` stream) still collapse to one replacement char.
fn decode_stream(carry: &mut Vec<u8>, chunk: &[u8]) -> String {
    carry.extend_from_slice(chunk);
    let mut out = String::new();
    loop {
        match std::str::from_utf8(carry) {
            Ok(text) => {
                out.push_str(text);
                carry.clear();
                break;
            }
            Err(err) => {
                let valid = err.valid_up_to();
                if valid > 0 {
                    out.push_str(std::str::from_utf8(&carry[..valid]).expect("prefix is valid"));
                }
                match err.error_len() {
                    // Real garbage mid-stream: emit one replacement and keep decoding past it.
                    Some(bad) => {
                        out.push('\u{FFFD}');
                        carry.drain(..valid + bad);
                    }
                    // Just an unfinished character at the very end: hold it for the next read.
                    None => {
                        carry.drain(..valid);
                        break;
                    }
                }
            }
        }
    }
    out
}

/// Every process below `root`, whatever its process group. An agent runs its commands in groups
/// of their own with no terminal, so the SIGHUP a closing PTY sends never reaches them.
fn descendants(root: u32) -> Vec<u32> {
    // Windows has no `ps`; `kill_tree` ends the whole tree through the OS's own parent links.
    if cfg!(windows) {
        let _ = root;
        return Vec::new();
    }
    let Ok(out) = std::process::Command::new("ps").args(["-A", "-o", "pid=,ppid="]).output() else {
        return Vec::new();
    };
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let mut fields = line.split_whitespace().filter_map(|field| field.parse::<u32>().ok());
        if let (Some(pid), Some(ppid)) = (fields.next(), fields.next()) {
            children.entry(ppid).or_default().push(pid);
        }
    }
    let mut found = Vec::new();
    let mut queue = vec![root];
    while let Some(pid) = queue.pop() {
        for &child in children.get(&pid).map(Vec::as_slice).unwrap_or_default() {
            found.push(child);
            queue.push(child);
        }
    }
    found
}

/// SIGTERM, a second's grace to shut down cleanly, then SIGKILL for whatever is left.
fn end_all(pids: &[u32]) {
    if pids.is_empty() {
        return;
    }
    let signal = |flag: &str, pids: &[u32]| {
        std::process::Command::new("kill")
            .arg(flag)
            .args(pids.iter().map(u32::to_string))
            .output()
    };
    let _ = signal("-TERM", pids);
    for _ in 0..20 {
        thread::sleep(std::time::Duration::from_millis(50));
        // `kill -0` fails as soon as any pid in the list is gone, so each is asked on its own.
        if !pids.iter().any(|pid| signal("-0", &[*pid]).is_ok_and(|out| out.status.success())) {
            return;
        }
    }
    let _ = signal("-KILL", pids);
}

/// `taskkill /T` walks the parent links Windows keeps, so an agent's dev servers and builds go
/// down with its tab exactly as the Unix process-group sweep takes them.
#[cfg(windows)]
fn kill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = std::process::Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

/// Explorer (or an already-running Panel) can retain the PATH from before npm was installed.
/// Give both shell terminals and direct agent launches access to npm's per-user CLI shims.
/// Keep the inherited order so explicitly selected installations still win.
#[cfg(windows)]
fn windows_terminal_path() -> std::ffi::OsString {
    let current = std::env::var_os("PATH").unwrap_or_default();
    let Some(appdata) = std::env::var_os("APPDATA") else { return current };
    let npm = PathBuf::from(appdata).join("npm");
    let mut paths: Vec<PathBuf> = std::env::split_paths(&current).collect();
    if npm.is_dir() && !paths.iter().any(|path| {
        path.to_string_lossy().eq_ignore_ascii_case(&npm.to_string_lossy())
    }) {
        paths.push(npm);
    }
    std::env::join_paths(paths).unwrap_or(current)
}

#[cfg(all(test, windows))]
mod windows_opencode_tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    // Run alone: this deliberately simulates a GUI app whose inherited PATH predates npm.
    #[test]
    #[ignore = "requires OpenCode installed with npm; run with --test-threads=1"]
    fn opencode_starts_in_shell_and_direct_terminals_with_a_stale_path() {
        let original_path = std::env::var_os("PATH");
        let system = PathBuf::from(std::env::var_os("SystemRoot").unwrap());
        std::env::set_var("PATH", std::env::join_paths([
            system.join("System32"),
            system.join("System32/WindowsPowerShell/v1.0"),
        ]).unwrap());
        for (program, args, marker) in [
            ("powershell.exe", vec!["-NoProfile", "-Command",
                "& opencode --version; if ($LASTEXITCODE -ne 0) { exit 1 }; Write-Output PANEL_OPENCODE_OK"],
                "PANEL_OPENCODE_OK"),
            ("opencode", vec!["--version"], ""),
        ] {
            let (tx, rx) = mpsc::channel();
            let sink: TerminalSink = Arc::new(move |chunk| { let _ = tx.send(chunk); });
            let mut terminals = TerminalManager::default();
            let spec = SpawnSpec::shell(std::env::temp_dir(), 100, 30)
                .run(program, args.into_iter().map(str::to_owned).collect())
                .answering_cursor_query();
            let id = terminals.spawn(spec, sink).unwrap();
            let deadline = Instant::now() + Duration::from_secs(20);
            let mut output = String::new();
            while Instant::now() < deadline {
                if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(100)) {
                    output.push_str(&chunk.data);
                    let version = output.split(|c: char| !c.is_ascii_digit() && c != '.')
                        .any(|word| word.split('.').count() == 3
                            && word.split('.').all(|part| !part.is_empty()));
                    // ConPTY may keep its output handle open after the command has finished.
                    if chunk.closed || (version && output.contains(marker)) { break; }
                }
            }
            terminals.close(&id).unwrap();
            let version = output.split(|c: char| !c.is_ascii_digit() && c != '.')
                .any(|word| word.split('.').count() == 3
                    && word.split('.').all(|part| !part.is_empty()));
            assert!(version, "{program} did not print an OpenCode version: {output}");
            assert!(output.contains(marker), "{program} did not run OpenCode: {output}");
            assert!(!output.contains("CommandNotFoundException"), "{output}");
            eprintln!("{program}: {output}");
        }
        match original_path {
            Some(path) => std::env::set_var("PATH", path),
            None => std::env::remove_var("PATH"),
        }
    }
}

/// What to actually start for `program` on Windows. CreateProcess runs only real executables,
/// but npm installs agents (codex, opencode) as `.cmd` shims. Rather than route them through
/// cmd.exe, whose quoting mangles the long instruction arguments agents get, the shim is read
/// for the target it wraps: a native exe, or a Node script run by node.
#[cfg(windows)]
fn windows_launch(program: &str, terminal_path: &std::ffi::OsStr) -> (String, Vec<String>) {
    use std::path::{Path, PathBuf};
    let unchanged = (program.to_string(), Vec::new());
    if Path::new(program).extension().is_some_and(|ext| ext.eq_ignore_ascii_case("exe")) {
        return unchanged;
    }
    let candidates: Vec<PathBuf> = if program.contains(['\\', '/']) {
        vec![PathBuf::from(program)]
    } else {
        std::env::split_paths(terminal_path).map(|dir| dir.join(program)).collect()
    };
    for base in candidates {
        if base.with_extension("exe").is_file() || base.with_extension("com").is_file() {
            return unchanged;
        }
        let shim = base.with_extension("cmd");
        let Ok(text) = std::fs::read_to_string(&shim) else { continue };
        let dir = shim.parent().unwrap_or(Path::new("."));
        // Every quoted "%dp0%\…" path in the shim; the last one that is not node.exe is the target.
        let target = text
            .split('"')
            .filter_map(|part| part.strip_prefix("%dp0%\\"))
            .filter(|part| !part.eq_ignore_ascii_case("node.exe"))
            .last()
            .map(|relative| dir.join(relative));
        let Some(target) = target else {
            return ("cmd.exe".into(), vec!["/C".into(), shim.to_string_lossy().into_owned()]);
        };
        let target_text = target.to_string_lossy().into_owned();
        let is_script = matches!(
            target.extension().and_then(|ext| ext.to_str()),
            Some("js" | "cjs" | "mjs")
        );
        if !is_script {
            return (target_text, Vec::new());
        }
        let local_node = dir.join("node.exe");
        let node = if local_node.is_file() {
            local_node.to_string_lossy().into_owned()
        } else {
            "node".into()
        };
        return (node, vec![target_text]);
    }
    unchanged
}

/// A Windows job object with kill-on-close. Every process the PTY child starts joins it, however
/// its parent links are later rewired, so closing the handle is the one dependable tree kill.
#[cfg(windows)]
mod job {
    use std::ffi::c_void;

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> *mut c_void;
        fn SetInformationJobObject(job: *mut c_void, class: i32, info: *const c_void, len: u32) -> i32;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }

    const EXTENDED_LIMIT_INFORMATION: i32 = 9;
    const KILL_ON_JOB_CLOSE: u64 = 0x2000;
    const PROCESS_SET_QUOTA: u32 = 0x0100;
    const PROCESS_TERMINATE: u32 = 0x0001;

    pub struct Job(isize);

    impl Job {
        pub fn holding(pid: u32) -> Option<Job> {
            unsafe {
                let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
                if job.is_null() {
                    return None;
                }
                let job = Job(job as isize);
                // JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on x64; LimitFlags sits at
                // byte 16, the third u64's low half.
                let mut info = [0u64; 18];
                info[2] = KILL_ON_JOB_CLOSE;
                let size = std::mem::size_of_val(&info) as u32;
                if SetInformationJobObject(job.0 as _, EXTENDED_LIMIT_INFORMATION, info.as_ptr().cast(), size) == 0 {
                    return None;
                }
                let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
                if process.is_null() {
                    return None;
                }
                let assigned = AssignProcessToJobObject(job.0 as _, process) != 0;
                CloseHandle(process);
                assigned.then_some(job)
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0 as _);
            }
        }
    }
}

fn default_shell() -> String {
    #[cfg(windows)]
    {
        // PowerShell, not COMSPEC: cmd.exe is nobody's working shell on a current Windows.
        "powershell.exe".into()
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
    }
}

/// A thread-safe wrapper used by desktop hosts.
pub type SharedTerminalManager = Arc<Mutex<TerminalManager>>;

#[cfg(test)]
mod decode_tests {
    use super::decode_stream;

    #[test]
    fn a_glyph_split_across_two_reads_survives_the_seam() {
        // `─` (U+2500) is three bytes: E2 94 80. Feed the first two, then the last.
        let mut carry = Vec::new();
        assert_eq!(decode_stream(&mut carry, &[0xE2, 0x94]), ""); // held, not corrupted
        assert_eq!(decode_stream(&mut carry, &[0x80]), "─"); // completed cleanly
        assert!(carry.is_empty());
    }

    #[test]
    fn a_read_ending_mid_character_emits_the_finished_part_and_holds_the_rest() {
        // "ab" then the first byte of `❯` (U+276F, E2 9D AF).
        let mut carry = Vec::new();
        assert_eq!(decode_stream(&mut carry, &[b'a', b'b', 0xE2, 0x9D]), "ab");
        assert_eq!(decode_stream(&mut carry, &[0xAF, b'c']), "❯c");
        assert!(carry.is_empty());
    }

    #[test]
    fn genuinely_invalid_bytes_become_one_replacement_and_do_not_eat_what_follows() {
        // 0xFF is never valid UTF-8; the 'A' after it must still come through.
        let mut carry = Vec::new();
        assert_eq!(decode_stream(&mut carry, &[0xFF, b'A']), "\u{FFFD}A");
        assert!(carry.is_empty());
    }

    #[test]
    fn plain_ascii_passes_through_untouched() {
        let mut carry = Vec::new();
        assert_eq!(decode_stream(&mut carry, b"hello\r\n"), "hello\r\n");
        assert!(carry.is_empty());
    }
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    #[test]
    fn owns_a_real_pty_without_tmux() {
        let (tx, rx) = mpsc::channel();
        let sink: TerminalSink = Arc::new(move |chunk| {
            let _ = tx.send(chunk);
        });
        let mut manager = TerminalManager::default();
        let id = manager.open(std::env::temp_dir(), 80, 24, sink).unwrap();
        manager.write(&id, "printf 'PANEL_PTY_OK\\n'\n").unwrap();

        let deadline = Instant::now() + Duration::from_secs(5);
        let mut output = String::new();
        while Instant::now() < deadline && !output.contains("PANEL_PTY_OK") {
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(250)) {
                output.push_str(&chunk.data);
            }
        }
        manager.close(&id).unwrap();
        assert!(
            output.contains("PANEL_PTY_OK"),
            "PTY output was {output:?}"
        );
    }

    /// The agent finds Panel only through its environment. If this breaks, the panel goes
    /// silent and the whole observation design quietly stops working — so it gets a test.
    #[test]
    fn the_spawned_process_inherits_the_panel_environment() {
        let (tx, rx) = mpsc::channel();
        let sink: TerminalSink = Arc::new(move |chunk| {
            let _ = tx.send(chunk);
        });
        let mut manager = TerminalManager::default();
        let spec = SpawnSpec::shell(std::env::temp_dir(), 80, 24)
            .run(
                "sh",
                vec!["-c".into(), "printf 'PORT=%s\\n' \"$PANEL_PORT\"".into()],
            )
            .with_env("PANEL_PORT", "54321");
        let id = manager.spawn(spec, sink).unwrap();

        let deadline = Instant::now() + Duration::from_secs(5);
        let mut output = String::new();
        while Instant::now() < deadline && !output.contains("PORT=") {
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(250)) {
                output.push_str(&chunk.data);
            }
        }
        manager.close(&id).unwrap();
        assert!(output.contains("PORT=54321"), "PTY output was {output:?}");
    }

    /// What an agent leaves behind: a server in its own process group that ignores SIGHUP.
    /// Closing the tab must still end it, or it runs until the Mac restarts.
    #[test]
    fn closing_a_terminal_ends_what_its_process_started() {
        let (tx, rx) = mpsc::channel();
        let sink: TerminalSink = Arc::new(move |chunk| {
            let _ = tx.send(chunk);
        });
        let mut manager = TerminalManager::default();
        let spec = SpawnSpec::shell(std::env::temp_dir(), 80, 24).run(
            "sh",
            vec![
                "-c".into(),
                "set -m; nohup sleep 300 >/dev/null 2>&1 & printf 'LEFT=%s\\n' $!; wait".into(),
            ],
        );
        let id = manager.spawn(spec, sink).unwrap();

        let deadline = Instant::now() + Duration::from_secs(5);
        let mut output = String::new();
        while Instant::now() < deadline && !output.contains('\n') {
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(250)) {
                output.push_str(&chunk.data);
            }
        }
        let left: u32 = output
            .split("LEFT=")
            .nth(1)
            .and_then(|rest| rest.split_whitespace().next())
            .and_then(|pid| pid.parse().ok())
            .unwrap_or_else(|| panic!("PTY output was {output:?}"));
        manager.close(&id).unwrap();

        let alive = std::process::Command::new("kill")
            .args(["-0", &left.to_string()])
            .output()
            .is_ok_and(|out| out.status.success());
        assert!(!alive, "background process {left} outlived its terminal");
    }

    #[test]
    fn shutdown_checks_distinguish_a_live_process_from_ended_scrollback() {
        let sink: TerminalSink = Arc::new(|_| {});
        let mut manager = TerminalManager::default();
        let live = manager
            .spawn(
                SpawnSpec::shell(std::env::temp_dir(), 80, 24).run("sh", vec![]),
                sink.clone(),
            )
            .unwrap();
        assert!(manager.is_running(&live));

        let ended = manager
            .spawn(
                SpawnSpec::shell(std::env::temp_dir(), 80, 24)
                    .run("sh", vec!["-c".into(), "exit 0".into()]),
                sink,
            )
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline && manager.is_running(&ended) {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(!manager.is_running(&ended));
        manager.close(&live).unwrap();
        manager.close(&ended).unwrap();
    }
}

#[cfg(test)]
mod screen_tests {
    use super::{trim_screen, trim_to_cap, SCREEN_CAP};

    #[test]
    fn kept_screen_trims_in_batches_but_restores_at_most_the_cap() {
        let line = "x".repeat(99) + "\n";
        let mut kept = String::new();
        let mut trims = 0;
        for _ in 0..(SCREEN_CAP * 5 / line.len()) {
            let before = kept.len();
            kept.push_str(&line);
            trim_screen(&mut kept);
            if kept.len() < before {
                trims += 1;
            }
            assert!(kept.len() <= SCREEN_CAP * 2 + line.len());
        }
        // One cut per cap of output, not one per write.
        assert!(trims <= 5, "trimmed {trims} times");
        let mut tail = kept.clone();
        trim_to_cap(&mut tail);
        assert!(tail.len() <= SCREEN_CAP);
        assert!(tail.starts_with('x') && kept.ends_with(&tail));
    }
}
