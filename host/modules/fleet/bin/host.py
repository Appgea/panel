#!/usr/bin/env python3
"""Fleet module host: one CGI-argv request per process. `GET /view` is what `fleet view` prints.

The fleet itself lives in ops (`runbooks/fleet.py`) and runs without Panel. This module only reads it,
so Panel holds no terminal and no memory per unit."""
import json
import os
from pathlib import Path
import subprocess
import sys


def ops_path():
    return Path(os.environ.get("FLEET_OPS") or
                Path(os.environ.get("PANEL_USER_HOME") or Path.home() / ".appgeapanel") / "ops")


def respond(status, body):
    sys.stdout.buffer.write(("%d\napplication/json\n\n" % status).encode())
    sys.stdout.buffer.write(json.dumps(body, ensure_ascii=False).encode())


def view():
    script = ops_path() / "runbooks/fleet.py"
    if not script.exists():
        return 200, {"error": f"{script} is missing"}
    try:
        ran = subprocess.run([sys.executable, str(script), "view"], capture_output=True, text=True, timeout=20)
        return 200, json.loads(ran.stdout)
    except subprocess.TimeoutExpired:
        return 200, {"error": "`fleet view` did not answer in 20 seconds"}
    except ValueError:
        return 200, {"error": (ran.stderr or ran.stdout).strip()[-300:] or "`fleet view` printed nothing"}


def main():
    if len(sys.argv) < 3:
        return respond(400, {"error": "usage: host.py METHOD PATH"})
    method, path = sys.argv[1], sys.argv[2].split("?")[0]
    if method == "GET" and path == "/view":
        return respond(*view())
    respond(404, {"error": f"no route {method} {path}"})


if __name__ == "__main__":
    main()
