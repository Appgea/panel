#!/usr/bin/env python3
"""Open an agent session in Panel, or turn on Remote Control in this one. Any engine, no MCP.

    panel_session.py open [--kind claude] [--project ID] [--cwd DIR] [--title T] [--rc] [--prompt TEXT | --prompt-file F]
    panel_session.py rc

`open` starts a session the way the owner's click does: a normal tab on its project, kept across a
restart. No --project: the deepest project holding --cwd, else the main folder. --rc starts claude
with Remote Control on, named after the title, and prints its link.
`rc` types /remote-control into the claude this script runs under and prints the link. It works
mid-turn, and a second run changes nothing. Only a claude in a Panel terminal can be reached.
Text half-typed in that prompt box would be sent with it, so use it when the owner is not typing there.
Prints Panel's JSON reply. Exits 1 when Panel refused or is not running.
Why: owner, 2026-11-17, "in case of need I want you to be able to run /rc", and sessions opened for him.
"""
import argparse
import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path


def port():
    if os.environ.get("PANEL_PORT"):
        return os.environ["PANEL_PORT"]
    try:
        return (Path.home() / ".appgeapanel/ingress-port").read_text().strip()
    except OSError:
        return None


def claude_pid():
    """The claude above this script. A plain Panel shell knows it only as its foreground job."""
    pid = os.getppid()
    for _ in range(8):
        comm = subprocess.run(["ps", "-o", "comm=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
        if os.path.basename(comm) in ("claude", "node"):
            return pid
        ppid = subprocess.run(["ps", "-o", "ppid=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
        if not ppid.isdigit() or int(ppid) <= 1:
            break
        pid = int(ppid)
    return 0


def ask(op, body):
    where = port()
    if not where:
        return {"error": "Panel is not running: no PANEL_PORT and no ~/.appgeapanel/ingress-port"}
    request = urllib.request.Request(f"http://127.0.0.1:{where}/panel/session/{op}", json.dumps(body).encode(),
                                     {"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=45) as reply:
            return json.loads(reply.read() or b"{}")
    except (OSError, ValueError) as error:
        return {"error": f"Panel did not answer: {error}"}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ops = parser.add_subparsers(dest="op", required=True)
    start = ops.add_parser("open", help="open an agent session in Panel")
    start.add_argument("--kind", default="claude", help="the agent: claude, codex, grok, ...")
    start.add_argument("--project", help="a Panel project id")
    start.add_argument("--cwd", help="the folder to start in")
    start.add_argument("--title", help="the tab's name, one line")
    start.add_argument("--rc", action="store_true", help="start claude with Remote Control on")
    first = start.add_mutually_exclusive_group()
    first.add_argument("--prompt", help="the first prompt")
    first.add_argument("--prompt-file", help="a file holding the first prompt")
    ops.add_parser("rc", help="turn on Remote Control in this claude")
    args = parser.parse_args()

    if args.op == "rc":
        body = {"instance": os.environ.get("PANEL_INSTANCE"), "pid": claude_pid()}
        body = {key: value for key, value in body.items() if value}
    else:
        prompt = Path(args.prompt_file).read_text() if args.prompt_file else args.prompt
        body = {"kind": args.kind, "project": args.project, "title": args.title, "remote_control": args.rc,
                "cwd": os.path.abspath(args.cwd) if args.cwd else None, "prompt": prompt.strip() if prompt else None}
        body = {key: value for key, value in body.items() if value not in (None, "")}
    reply = ask(args.op, body)
    print(json.dumps(reply))
    sys.exit(1 if reply.get("error") else 0)


if __name__ == "__main__":
    main()
