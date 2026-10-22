# Build Appgea Panel for Windows and install it onto the Desktop, with a Rebuild shortcut.
#
#   powershell -ExecutionPolicy Bypass -File launcher\build-app.ps1              -> the Desktop
#   powershell -ExecutionPolicy Bypass -File launcher\build-app.ps1 -Dest D:\x   -> another folder
#
# The Windows twin of build-app.sh. It installs the bare exe: with no host\ beside it, Panel
# reads host\ from this checkout, so keep the checkout where it is. "Rebuild Appgea Panel" next to
# the exe runs this script again. The NSIS installer (build-windows.sh) ships host\ inside instead.
# Needs Git for Windows (for bash), Rust with `cargo tauri`, Node, and Python.
param([string]$Dest = [Environment]::GetFolderPath('Desktop'))
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

# Check what Panel needs at run time, not only to build. Panel calls `python` on Windows, and the
# Store stub under WindowsApps opens a download page instead of running, which silently breaks the
# session hook, the panel MCP, report fallback and every module.
function Need($Name, $Hint) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) { throw "$Name not found on PATH. $Hint" }
}
Need git 'Install Git for Windows: https://git-scm.com/download/win'
Need cargo 'Install Rust with the MSVC toolchain: https://rustup.rs'
Need node 'Install Node 22.12+: https://nodejs.org'
& cargo tauri --version *> $null
if ($LASTEXITCODE) { throw 'Tauri CLI missing. Run: cargo install tauri-cli --version "^2" --locked' }
$Python = Get-Command python -ErrorAction SilentlyContinue
if (-not $Python -or $Python.Source -like '*\WindowsApps\*') {
    throw 'Panel needs a real `python` (3.9+) on PATH, not the Microsoft Store stub. Install from https://python.org, tick "Add to PATH", and turn off the python.exe App execution alias in Settings.'
}
& python -c 'import sys; sys.exit(sys.version_info < (3, 9))'
if ($LASTEXITCODE) { throw "Panel needs Python 3.9+; $($Python.Source) is older." }
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Write-Warning 'claude not found on PATH. Panel still builds; install an agent CLI to use it: npm install -g @anthropic-ai/claude-code'
}

# The shared staging scripts are bash; igncr tolerates a CRLF checkout. Git's own bash, found
# next to git.exe — a bare `bash` is WSL's, or nothing at all.
$Git = (Get-Command git -ErrorAction Stop).Source
# git.exe sits in cmd\ or mingw64\bin\ depending on which PATH entry wins, so try both depths.
$GitRoot = Split-Path -Parent (Split-Path -Parent $Git)
$Bash = @($GitRoot, (Split-Path -Parent $GitRoot)) | ForEach-Object { Join-Path $_ 'bin\bash.exe' } |
    Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Bash) { throw 'Git for Windows bash.exe was not found' }
& $Bash -o igncr "$Root/launcher/stage-resources.sh"; if ($LASTEXITCODE) { exit $LASTEXITCODE }
& $Bash -o igncr "$Root/launcher/prepare-ui.sh"; if ($LASTEXITCODE) { exit $LASTEXITCODE }

Push-Location "$Root\apps\desktop\src-tauri"
try {
    # .cargo/config.toml names a Homebrew sccache that does not exist here; build without one.
    & cargo tauri build --no-bundle -- --locked --config "build.rustc-wrapper=''"
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
} finally { Pop-Location }

# A running copy holds the exe open. Bring it back afterwards, so a rebuild is one click.
$Running = @(Get-Process -Name 'Appgea Panel' -ErrorAction SilentlyContinue)
if ($Running) {
    Write-Host 'closing the running Panel to replace it'
    $Running | Stop-Process -Force
    Start-Sleep -Milliseconds 500
}

New-Item -ItemType Directory -Force $Dest | Out-Null
$Exe = Join-Path $Dest 'Appgea Panel.exe'
Copy-Item "$Root\target\release\appgea-panel-desktop.exe" $Exe -Force

$Shell = New-Object -ComObject WScript.Shell
$Link = $Shell.CreateShortcut((Join-Path $Dest 'Rebuild Appgea Panel.lnk'))
$Link.TargetPath = Join-Path $PSHOME 'powershell.exe'
# -NoExit keeps the window up, so a failed build stays readable.
$Link.Arguments = "-NoExit -ExecutionPolicy Bypass -Command `"& '$PSCommandPath' -Dest '$Dest'`""
$Link.WorkingDirectory = $Root
$Link.Description = 'Rebuild Appgea Panel from its checkout'
$Link.Save()

if ($Running) { Start-Process $Exe -WorkingDirectory $env:USERPROFILE }
Write-Host "installed: $Exe"
Write-Host "rebuild:   $(Join-Path $Dest 'Rebuild Appgea Panel.lnk')"
