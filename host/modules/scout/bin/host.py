#!/usr/bin/env python3
"""Scout module host — one CGI-argv request or record command per process."""
import argparse
from datetime import datetime, timedelta
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import signal
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit, parse_qs


def now():
    return datetime.now().astimezone()


def ops_path():
    return Path(os.environ.get("SCOUT_OPS") or
                Path(os.environ.get("PANEL_USER_HOME") or
                     Path.home() / ".appgeapanel") / "ops").resolve()


def state_path():
    return Path(os.environ.get("PANEL_STATE_DIR") or
                Path.home() / ".appgeapanel/state/scout")


def read_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def atomic_write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def record(scout_id, status, found=0, note="", session=None, when=None):
    if not isinstance(scout_id, str) or not scout_id:
        raise ValueError("id is required")
    if status not in ("running", "done", "failed"):
        raise ValueError("status must be running, done or failed")
    if type(found) is not int or found < 0 or not isinstance(note, str):
        raise ValueError("found must be a non-negative integer and note must be text")
    state = state_path()
    state.mkdir(parents=True, exist_ok=True)
    # A short lock, waited for, so two writers never lose each other's result.
    with (state / "runs.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        records = read_json(state / "runs.json", {})
        previous = records.get(scout_id) or {}
        # `when` checks the last run under the lock, so two sessions never both take one scout.
        if when and not when(records.get(scout_id)):
            return None
        stamp = now().isoformat()
        # `started` is when the run began. The due rules read it, so a run that ends after
        # midnight still counts for the day it started, not the next one.
        result = {"at": stamp, "started": stamp if status == "running" else previous.get("started", stamp),
                  "status": status, "found": found, "note": note,
                  "session": session if status == "running" else previous.get("session")}
        records[scout_id] = result
        atomic_write(state / "runs.json", records)
        (state / "board.json").unlink(missing_ok=True)
    return result


def read_scout(path):
    lines = path.read_text(encoding="utf-8").splitlines()
    fields, body, errors = {}, [], []
    if lines and lines[0].strip() == "---":
        end = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
        if end is not None:
            for line in lines[1:end]:
                key, separator, value = line.partition(":")
                if separator:
                    fields[key.strip()] = value.strip()
            body = lines[end + 1:]
        else:
            errors.append("unclosed frontmatter")
    else:
        errors.append("missing frontmatter")
    if not fields.get("title"):
        errors.append("title is required")
    if ("run" in fields) == ("agent" in fields):
        errors.append("exactly one of run or agent is required")
    elif not fields.get("run", fields.get("agent")):
        errors.append("run or agent must not be empty")
    every = fields.get("every", "manual")
    if every not in ("daily", "sunday", "manual") and not re.fullmatch(r"[1-9][0-9]*h", every):
        errors.append("invalid every")
    try:
        after = int(fields.get("after", "8"))
        if not 0 <= after <= 23:
            raise ValueError()
    except ValueError:
        after = 8
        errors.append("after must be an hour from 0 to 23")
    summary = next((line.strip() for line in body
                    if line.strip() and not line.lstrip().startswith("#")), "")[:140]
    return {"id": path.stem, "title": fields.get("title", path.stem),
            "every": every, "after": after,
            "kind": "script" if "run" in fields else "agent",
            "agent": fields.get("agent"), "model": fields.get("model"), "needs": fields.get("needs"),
            "summary": summary, "error": "; ".join(errors) or None,
            "run": fields.get("run")}


def scouts():
    return [read_scout(path) for path in sorted((ops_path() / "scouts").glob("*.md"))
            if not path.name.startswith("_") and path.is_file()]


def schedule(scout, last, current):
    if scout["error"] or scout["every"] == "manual":
        return False, None
    began = last and (last.get("started") or last["at"])
    at = datetime.fromisoformat(began).astimezone(current.tzinfo) if began else None
    every = scout["every"]
    if every.endswith("h"):
        target = at + timedelta(hours=int(every[:-1])) if at else current
        return target <= current, target.isoformat() if target > current else None
    ran_today = at is not None and at.date() == current.date()
    target = current.replace(hour=scout["after"], minute=0, second=0, microsecond=0)
    eligible = every == "daily" or current.weekday() == 6
    if eligible and not ran_today and current >= target:
        return True, None
    if every == "sunday" and at is not None:
        # Missed Sunday because Panel was closed: catch up on the next open, not a week later.
        sunday = target - timedelta(days=(current.weekday() + 1) % 7)
        if sunday > current:
            sunday -= timedelta(days=7)
        if at < sunday:
            return True, None
    if every == "daily":
        if ran_today or current >= target:
            target += timedelta(days=1)
    else:
        days = (6 - current.weekday()) % 7
        if days == 0 and (ran_today or current >= target):
            days = 7
        target += timedelta(days=days)
    return False, target.isoformat()


def listing():
    current = now()
    records = read_json(state_path() / "runs.json", {})
    items = scouts()
    for scout in items:
        scout.pop("run")
        last = records.get(scout["id"])
        scout["due"], scout["next_at"] = schedule(scout, last, current)
        if last and last["status"] == "running":
            # A script cannot outlive Panel's 60 s call. An agent gets two hours.
            limit = 120 if scout["kind"] == "script" else 7200
            if current.timestamp() - datetime.fromisoformat(last["at"]).timestamp() > limit:
                last = dict(last, status="stale")
        scout["last"] = last
    upcoming = [s["next_at"] for s in items if s["next_at"]]
    return {"now": current.isoformat(), "next_due_at": min(upcoming) if upcoming else None,
            "scouts": items}


def board_command():
    command = os.environ.get("SCOUT_BOARD")
    return shlex.split(command) if command else ["python3", str(ops_path() / "runbooks/board.py")]


def command(args, timeout, env=None):
    state_path().mkdir(parents=True, exist_ok=True)
    # Files avoid pipe deadlocks when a shell leaves descendants holding stdout.
    with tempfile.TemporaryFile(dir=state_path()) as out, tempfile.TemporaryFile(dir=state_path()) as err:
        process = subprocess.Popen(args, cwd=ops_path(), env=env, stdin=subprocess.DEVNULL,
                                   stdout=out, stderr=err, start_new_session=True)
        timed_out = False
        try:
            process.wait(timeout=max(0.001, timeout))
        except subprocess.TimeoutExpired:
            timed_out = True
        finally:
            # Scouts are one-shot jobs; descendants must not outlive the request.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
        out.seek(0)
        err.seek(0)
        return process.returncode, out.read().decode("utf-8", "replace"), err.read().decode("utf-8", "replace"), timed_out


def last_line(text):
    return next((line.strip() for line in reversed(text.splitlines()) if line.strip()), "")


def run_scout(scout):
    # Board filing shares the budget so Panel never kills us before saving the result.
    deadline = time.monotonic() + 49.5
    scout_id = scout["id"]
    record(scout_id, "running")
    found, note, status = 0, "", "done"
    try:
        code, stdout, stderr, expired = command(
            ["bash", "-lc", scout["run"]], deadline - time.monotonic(),
            dict(os.environ, SCOUT_ID=scout_id))
        findings = [line[6:] for line in stdout.splitlines() if line.startswith("FOUND ")]
        found = len(findings)
        note = last_line("\n".join(line for line in stdout.splitlines() if not line.startswith("FOUND ")))
        if code or expired:
            status = "failed"
            note = "timed out after 50 s" if expired else last_line(stderr) or "script exited %d" % code
        for finding in findings:
            if time.monotonic() >= deadline:
                status, note = "failed", "timed out after 50 s"
                break
            # FOUND <title> | <body> | <labels, comma separated>
            title, _, rest = finding.partition("|")
            body, _, labels = rest.partition("|")
            body = (body.strip() + "\n" if body.strip() else "") + "Found by scout %s." % scout_id
            flags = [arg for label in labels.split(",") if label.strip() for arg in ("--label", label.strip())]
            filed, _, error, expired = command(
                board_command() + ["file", title.strip(), "--body", body, *flags], deadline - time.monotonic())
            if filed or expired:
                status = "failed"
                note = "timed out after 50 s" if expired else last_line(error) or "board exited %d" % filed
                break
    except (OSError, ValueError) as error:
        status, note = "failed", str(error)
    return record(scout_id, status, found, note)


def board(fresh):
    cache = state_path() / "board.json"
    try:
        if not fresh and cache.exists() and time.time() - cache.stat().st_mtime < 60:
            return read_json(cache, {})
        # One gh call per claimed issue, so this grows with the board. Panel's limit is 60 s.
        code, stdout, stderr, expired = command(board_command() + ["json"], 40)
        if code or expired:
            return {"error": last_line(stderr) or ("board timed out" if expired else "board exited %d" % code)}
        result = json.loads(stdout)
        atomic_write(cache, result)
        return result
    except (OSError, ValueError) as error:
        return {"error": str(error)}


BUILD_COLUMNS = ["date", "builder", "effort", "repo", "minutes", "exit", "session", "kind", "verdict", "task"]


def builds_dir():
    return Path(os.environ.get("SCOUT_BUILDS") or
                Path(os.environ.get("PANEL_USER_HOME") or Path.home() / ".appgeapanel") / "state/builds")


def pid_alive(pid):
    if type(pid) is not int or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def builds():
    """Builder runs: live markers (oldest first) and the last 12 finished rows (newest first)."""
    running = []
    for path in builds_dir().glob("*.json"):
        try:
            marker = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(marker, dict) and pid_alive(marker.get("pid")):
            running.append(marker)
    running.sort(key=lambda m: str(m.get("started", "")))
    recent = []
    try:
        lines = (ops_path() / "reviews/builds.tsv").read_text(encoding="utf-8").splitlines()
    except OSError:
        lines = []
    for line in lines[1:]:
        if not line.strip():
            continue
        cells = line.split("\t")
        # Old rows stop at 7 columns. A missing cell reads as "-".
        cells += ["-"] * (len(BUILD_COLUMNS) - len(cells))
        recent.append(dict(zip(BUILD_COLUMNS, cells[:len(BUILD_COLUMNS)])))
    return {"running": running, "recent": recent[-12:][::-1], "at": now().isoformat()}


def _respond(status, body, ctype="application/json"):
    payload = json.dumps(body, ensure_ascii=False).encode()
    sys.stdout.buffer.write(("%d\n%s\n\n" % (status, ctype)).encode())
    sys.stdout.buffer.write(payload)


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "record":
        parser = argparse.ArgumentParser()
        parser.add_argument("id")
        parser.add_argument("--status", choices=("done", "failed"), default="done")
        parser.add_argument("--found", type=int, default=0)
        parser.add_argument("--note", default="")
        args = parser.parse_args(sys.argv[2:])
        record(args.id, args.status, args.found, args.note)
        print("recorded " + args.id)
        return
    if len(sys.argv) < 3:
        return _respond(400, {"error": "usage: host.py METHOD PATH | host.py record <id>"})
    method, raw_path = sys.argv[1], sys.argv[2]
    parsed = urlsplit(raw_path)
    path, q = parsed.path, parse_qs(parsed.query)

    def qs(name, default=""):
        v = q.get(name)
        return v[0] if v else default

    if method == "GET" and path == "/scouts":
        return _respond(200, listing())
    if method == "GET" and path == "/board":
        return _respond(200, board(qs("fresh") == "1"))
    if method == "GET" and path == "/builds":
        return _respond(200, builds())
    if method == "GET" and path == "/prompt":
        scout = next((s for s in scouts() if s["id"] == qs("id")), None)
        if not scout:
            return _respond(400, {"error": "unknown id"})
        scout_id = scout["id"]
        prompt = ('Scout `%s`: read `%s`, then `%s`, and do what it says. '
                  'When done, run `python3 %s record %s --found <N> --note "<one line>"`.' %
                  (scout_id, ops_path() / "scouts/_rules.md", ops_path() / ("scouts/%s.md" % scout_id),
                   "'" + str(Path(__file__).resolve()).replace("'", "'\"'\"'") + "'", shlex.quote(scout_id)))
        return _respond(200, {"prompt": prompt.replace("\n", " ").replace("\r", " ")})
    if method == "POST" and path in ("/run", "/start", "/record"):
        try:
            d = json.loads(sys.stdin.buffer.read() or b"{}")
            if not isinstance(d, dict):
                raise ValueError("body must be an object")
            scout = next((s for s in scouts() if s["id"] == d.get("id")), None)
            if not scout:
                raise ValueError("unknown id")
            if path == "/record":
                return _respond(200, record(scout["id"], d.get("status"), d.get("found", 0), d.get("note", "")))
            if scout["error"]:
                raise ValueError(scout["error"])
            if path == "/run":
                if scout["kind"] != "script":
                    raise ValueError("agent scouts must use /start")
                last = read_json(state_path() / "runs.json", {}).get(scout["id"])
                if last and last["status"] == "running" and \
                        now().timestamp() - datetime.fromisoformat(last["at"]).timestamp() < 60:
                    return _respond(409, {"error": "already running"})
                return _respond(200, run_scout(scout))
            if scout["kind"] != "agent" or not isinstance(d.get("session"), str) or not d["session"].strip():
                raise ValueError("/start requires an agent scout and session")
            # `board next` sends if_due: of two sessions asking at once, only the first gets it.
            due = (lambda last: schedule(scout, last, now())[0]) if d.get("if_due") else None
            began = record(scout["id"], "running", session=d["session"], when=due)
            return _respond(200, began) if began else _respond(409, {"error": "not due"})
        except ValueError as error:
            return _respond(400, {"error": str(error)})
    return _respond(404, {"error": "no route"})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        if len(sys.argv) >= 2 and sys.argv[1] == "record":
            sys.stderr.write(str(error) + "\n")
            sys.exit(1)
        _respond(500, {"error": "%s: %s" % (type(error).__name__, error)})
