#!/usr/bin/env python3
"""Fleet module host: one CGI-argv request per process. `GET /view` is what `fleet view` prints.

The fleet itself lives in ops (`runbooks/fleet.py`) and runs without Panel. This module only reads it,
so Panel holds no terminal and no memory per unit. `GET /design` is what `fleet map` prints, and
`GET /design/trust` is `fleet trust 7 --json`, kept in Panel's state for TRUST_HOURS because it reads
GitHub for about a minute: an old answer comes back at once while a new one is measured."""
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import time

TRUST_HOURS = 6


def ops_path():
    return Path(os.environ.get("FLEET_OPS") or
                Path(os.environ.get("PANEL_USER_HOME") or Path.home() / ".appgeapanel") / "ops")


def state_path():
    return Path(os.environ.get("PANEL_STATE_DIR") or Path.home() / ".appgeapanel/state") / "fleet-design"


def respond(status, body):
    sys.stdout.buffer.write(("%d\napplication/json\n\n" % status).encode())
    sys.stdout.buffer.write(json.dumps(body, ensure_ascii=False).encode())


def fleet(*args, timeout=20):
    script = ops_path() / "runbooks/fleet.py"
    if not script.exists():
        return 200, {"error": f"{script} is missing"}
    name = " ".join(("fleet",) + args)
    try:
        ran = subprocess.run([sys.executable, str(script), *args], capture_output=True, text=True, timeout=timeout)
        return 200, json.loads(ran.stdout)
    except subprocess.TimeoutExpired:
        return 200, {"error": f"`{name}` did not answer in {timeout} seconds"}
    except ValueError:
        return 200, {"error": (ran.stderr or ran.stdout).strip()[-300:] or f"`{name}` printed nothing"}


def trust():
    """The last measure, and a new one started in the background when it is older than TRUST_HOURS."""
    state = state_path()
    state.mkdir(parents=True, exist_ok=True)
    saved, running = state / "trust.json", state / "trust.running"
    try:
        last = json.loads(saved.read_text())
    except (OSError, ValueError):
        last = None
    failed = state / "trust.err"
    fresh = last and time.time() - saved.stat().st_mtime < TRUST_HOURS * 3600
    if running.exists() and time.time() - running.stat().st_mtime >= 600:
        running.unlink(missing_ok=True)
    gave_up = failed.exists() and failed.stat().st_size and time.time() - failed.stat().st_mtime < 600
    busy = running.exists()
    if not fresh and not busy and not gave_up:
        try:
            os.close(os.open(running, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
        except FileExistsError:
            busy = True
        else:
            q = {k: shlex.quote(str(v)) for k, v in
                 {"py": sys.executable, "script": ops_path() / "runbooks/fleet.py", "out": saved, "err": failed,
                  "run": running}.items()}
            job = (f"new={q['out']}.$$; {q['py']} {q['script']} trust 7 --json > \"$new\" 2> {q['err']} "
                   f"&& mv \"$new\" {q['out']} && : > {q['err']}; rm -f \"$new\" {q['run']}")
            subprocess.Popen(["/bin/sh", "-c", job], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, start_new_session=True)
            busy = True
    if not last:
        if gave_up and not busy:
            return 200, {"error": failed.read_text().strip()[-300:] or "`fleet trust` failed"}
        return 200, {"pending": True}
    made = time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(saved.stat().st_mtime))
    return 200, {**last, "made": made}


def main():
    if len(sys.argv) < 3:
        return respond(400, {"error": "usage: host.py METHOD PATH"})
    method, path = sys.argv[1], sys.argv[2].split("?")[0]
    if method == "GET" and path == "/view":
        return respond(*fleet("view"))
    if method == "GET" and path == "/changes":
        return respond(*fleet("changes"))
    if method == "GET" and path == "/design":
        return respond(*fleet("map"))
    if method == "GET" and path == "/design/trust":
        return respond(*trust())
    respond(404, {"error": f"no route {method} {path}"})


if __name__ == "__main__":
    main()
