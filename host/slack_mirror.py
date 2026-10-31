"""A report with pictures also goes to Slack #desk, as one message with the pictures inside it.

Owner, 2026-10-30: "The sending images must be one flow in 2 channels." Panel is the better place to read a report,
but it is not always open, and he reads Slack on his phone. So every report with images goes to both, from the one
call that sends it. Only reports with images: text-only reports stay in Panel, so Slack carries no status noise.
The post speaks as the session's person from ~/.appgeapanel/state/session-people.json. Never raises: a report is
never lost to its Slack copy.
"""

import importlib.util
import json
import os
import subprocess
import sys

SLACK = os.path.expanduser("~/.appgeapanel/ops/runbooks/slack.py")
PEOPLE = os.path.expanduser("~/.appgeapanel/state/session-people.json")
KINDS = {"done": "done", "progress": "work", "blocked": "warn", "needs_decision": "ask"}


def _person():
    try:
        with open(PEOPLE) as f:
            name = json.load(f)[os.environ["CLAUDE_CODE_SESSION_ID"]]["name"]
        return name.rstrip("0123456789")
    except (OSError, ValueError, KeyError):
        return "maya"


def _area():
    """The project the report is about: the git repo's folder name, else the current folder's."""
    try:
        top = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True, timeout=10).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        top = ""
    return os.path.basename(top or os.getcwd().rstrip("/")) or "Panel"


def _paths(payload):
    paths = [i if isinstance(i, str) else i.get("path") for i in payload.get("images") or []
             if isinstance(i, (str, dict))]
    return [p for p in paths if isinstance(p, str) and os.path.isfile(p)]


def _post_text(payload):
    head = " ".join(str(payload.get("title") or "New pictures").split())
    lines = [line.strip() for line in str(payload.get("text") or "").splitlines() if line.strip()]
    detail = lines[0] if lines else "Pictures below."
    if len(detail) > 200:
        detail = detail[:199].rstrip() + "…"
    return head + "\n" + detail


def voice_problems(payload):
    """Why slack.py would refuse this report's Slack copy. Run before Panel gets it: a refusal found only after
    the Panel post made every corrected retry a duplicate in Panel (3 copies of one report, 2026-10-31)."""
    if not _paths(payload):
        return []
    try:
        spec = importlib.util.spec_from_file_location("appgea_slack", SLACK)
        slack = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(slack)
        return slack.problems(_post_text(payload))
    except Exception as error:  # a broken check never blocks a report
        print("Slack voice check skipped: %s" % error, file=sys.stderr)
        return []


def slack_mirror(payload):
    """Post the payload's images to #desk under its title. Returns True only when Slack has them."""
    paths = _paths(payload)
    if not paths:
        return False
    cmd = [sys.executable, SLACK, "say", "--as", _person(), "--to", "desk", "--about", _area(),
           "--kind", KINDS.get(payload.get("outcome"), "info")]
    for path in paths:
        cmd += ["--file", path]
    cmd += ["--", _post_text(payload)]  # a title starting with "-" is still text
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as error:
        print("Slack copy failed: %s" % error, file=sys.stderr)
        return False
    if out.returncode:
        print("Slack copy failed: %s" % (out.stderr.strip() or out.stdout.strip()), file=sys.stderr)
        return False
    return True
