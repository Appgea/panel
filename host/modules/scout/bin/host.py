#!/usr/bin/env python3
"""Scout module host — one CGI-argv request or record command per process."""
import argparse
import base64
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


WEEKDAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")


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
    with (state / "runs.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        records = read_json(state / "runs.json", {})
        previous = records.get(scout_id) or {}
        if when and not when(records.get(scout_id)):
            return None
        stamp = now().isoformat()
        fails = previous.get("fails", 0) + 1 if status == "failed" else 0 if status == "done" else previous.get("fails", 0)
        result = {"at": stamp, "started": stamp if status == "running" else previous.get("started", stamp),
                  "status": status, "found": found, "note": note, "fails": fails,
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
    if every not in ("daily", "manual", "routine", *WEEKDAYS) and not re.fullmatch(r"[1-9][0-9]*h", every):
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


def round_since():
    """When the current round of routines began. `ops/runbooks/routines.py` starts the next one."""
    return read_json(state_path() / "routine-round.json", {}).get("since", "1970-01-01T00:00:00+00:00")


def schedule(scout, last, current):
    if scout["error"] or scout["every"] == "manual":
        return False, None
    began = last and (last.get("started") or last["at"])
    if scout["every"] == "routine":
        return (not began or datetime.fromisoformat(began) < datetime.fromisoformat(round_since())), None
    at = datetime.fromisoformat(began).astimezone(current.tzinfo) if began else None
    every = scout["every"]
    if every.endswith("h"):
        target = at + timedelta(hours=int(every[:-1])) if at else current
        return target <= current, target.isoformat() if target > current else None
    ran_today = at is not None and at.date() == current.date()
    target = current.replace(hour=scout["after"], minute=0, second=0, microsecond=0)
    day = WEEKDAYS.index(every) if every in WEEKDAYS else None
    eligible = every == "daily" or current.weekday() == day
    if eligible and not ran_today and current >= target:
        return True, None
    if day is not None and at is not None:
        last_day = target - timedelta(days=(current.weekday() - day) % 7)
        if last_day > current:
            last_day -= timedelta(days=7)
        if at < last_day:
            return True, None
    if every == "daily":
        if ran_today or current >= target:
            target += timedelta(days=1)
    else:
        days = (day - current.weekday()) % 7
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
    with tempfile.TemporaryFile(dir=state_path()) as out, tempfile.TemporaryFile(dir=state_path()) as err:
        process = subprocess.Popen(args, cwd=ops_path(), env=env, stdin=subprocess.DEVNULL,
                                   stdout=out, stderr=err, start_new_session=True)
        timed_out = False
        try:
            process.wait(timeout=max(0.001, timeout))
        except subprocess.TimeoutExpired:
            timed_out = True
        finally:
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


def file_finding(scout_id, title, body, labels, deadline):
    """`board file` one finding. Returns why it failed, or None."""
    body = re.sub(r"(?<=[.!?`)])[ \t]+(Why|Checked):", r"\n\1:", body.strip())
    body = (body + "\n" if body else "") + "Found by scout %s.\nScout: %s" % (scout_id, scout_id)
    flags = [arg for label in labels if label.strip() for arg in ("--label", label.strip())]
    filed, _, error, expired = command(
        board_command() + ["file", title.strip(), "--body", body, *flags], deadline - time.monotonic())
    if filed or expired:
        return "timed out after 50 s" if expired else last_line(error) or "board exited %d" % filed
    return None


def report_broken(scout, last, deadline):
    """A failed run counts as a run, so a broken scout waits for its next slot and its checks file nothing.
    On 2026-10-31 `mac` had failed on one long title and nobody knew. Two failures in a row become one issue,
    filed before the next try. `board file` skips the title while it is open, so this never piles up.
    Returns why the issue could not be filed, or None. It gets 10 s, so a slow board still leaves the scout its run."""
    if (last or {}).get("fails", 0) < 2:
        return None
    try:
        return file_finding(scout["id"], "Scout %s keeps failing" % scout["id"],
                            "Problem: the %s scout failed %d runs in a row. Last error: %s "
                            "Why: a failed run counts as done, so its checks stop filing work and nobody hears. "
                            "Checked: %s `cd ~/.appgeapanel/ops && %s`"
                            % (scout["id"], last["fails"], last.get("note") or "none",
                               now().date().isoformat(), scout["run"]),
                            ["P1", "app:ops"], min(deadline, time.monotonic() + 10))
    except (OSError, ValueError) as error:
        return str(error)


def run_scout(scout):
    deadline = time.monotonic() + 49.5
    scout_id = scout["id"]
    unreported = report_broken(scout, read_json(state_path() / "runs.json", {}).get(scout_id), deadline)
    record(scout_id, "running")
    found, note, status = 0, "", "done"
    try:
        code, stdout, stderr, expired = command(
            ["bash", "-lc", "export PATH=/opt/homebrew/bin:$PATH; " + scout["run"]], deadline - time.monotonic(),
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
            title, _, rest = finding.partition("|")
            body, _, labels = rest.partition("|")
            if error := file_finding(scout_id, title, body, labels.split(","), deadline):
                status, note = "failed", error
                break
    except (OSError, ValueError) as error:
        status, note = "failed", str(error)
    if unreported:
        note = "keeps-failing issue not filed: %s. %s" % (unreported, note)
    return record(scout_id, status, found, note)


def board(fresh):
    cache = state_path() / "board.json"
    try:
        if not fresh and cache.exists() and time.time() - cache.stat().st_mtime < 60:
            return read_json(cache, {})
        code, stdout, stderr, expired = command(board_command() + ["json"], 40)
        if code or expired:
            return {"error": last_line(stderr) or ("board timed out" if expired else "board exited %d" % code)}
        result = json.loads(stdout)
        atomic_write(cache, result)
        return result
    except (OSError, ValueError) as error:
        return {"error": str(error)}


def live_answer(d):
    """`board answer N K --via live`, or `--say WORDS`. The board cache is dropped, so Live's next
    read no longer shows the answered card."""
    number, pick, words = d.get("number"), d.get("pick"), (d.get("say") or "").strip()
    if not isinstance(number, int) or number <= 0:
        raise ValueError("number is required")
    if pick is not None and (not isinstance(pick, int) or pick < 0):
        raise ValueError("pick is an option number")
    if pick is None and not words:
        raise ValueError("give an option or words")
    args = board_command() + ["answer", str(number)]
    if pick is not None:
        args.append(str(pick))
    if words:
        args += ["--say", words]
    args += ["--via", "Panel Live"]
    code, stdout, stderr, expired = command(args, 60)
    if code or expired:
        raise ValueError(last_line(stderr) or last_line(stdout) or ("board timed out" if expired else "board exited %d" % code))
    try:
        (state_path() / "board.json").unlink()
    except OSError:
        pass
    return {"ok": True, "said": last_line(stdout)}


PICTURE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}
PICTURE_LIMIT = 3 * 1024 * 1024


def picture(raw):
    """A card's picture as a data URL. Only an image inside the ops folder, so this route reads nothing else."""
    try:
        file = Path(raw).expanduser().resolve()
        root = ops_path().resolve()
        kind = PICTURE_TYPES.get(file.suffix.lower())
        if not kind or root not in file.parents or not file.is_file():
            return 400, {"error": "not a picture in ops"}
        if file.stat().st_size > PICTURE_LIMIT:
            return 413, {"error": "picture too large"}
        return 200, {"src": "data:%s;base64,%s" % (kind, base64.b64encode(file.read_bytes()).decode("ascii"))}
    except OSError as error:
        return 400, {"error": str(error)}


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
    if method == "GET" and path == "/routines":
        code, stdout, stderr, expired = command(["python3", str(ops_path() / "runbooks/routines.py"), "json"], 30)
        if code or expired:
            return _respond(200, {"error": last_line(stderr) or ("routines timed out" if expired else "routines exited %d" % code)})
        return _respond(200, json.loads(stdout))
    if method == "GET" and path == "/builds":
        return _respond(200, builds())
    if method == "GET" and path == "/picture":
        return _respond(*picture(qs("path")))
    if method == "GET" and path == "/prompt":
        scout = next((s for s in scouts() if s["id"] == qs("id")), None)
        if not scout:
            return _respond(400, {"error": "unknown id"})
        scout_id = scout["id"]
        close = ('`python3 %s done %s --note "<one Turkish line: what you looked at and found>"`' %
                 (shlex.quote(str(ops_path() / "runbooks/routines.py")), shlex.quote(scout_id))
                 if scout["every"] == "routine" else
                 '`python3 %s record %s --found <N> --note "<one line>"`' %
                 ("'" + str(Path(__file__).resolve()).replace("'", "'\"'\"'") + "'", shlex.quote(scout_id)))
        prompt = ('Scout `%s`: read `%s`, then `%s`, and do what it says. When done, run %s.' %
                  (scout_id, ops_path() / "scouts/_rules.md", ops_path() / ("scouts/%s.md" % scout_id), close))
        return _respond(200, {"prompt": prompt.replace("\n", " ").replace("\r", " ")})
    if path.startswith("/review/"):
        import review
        try:
            if method == "GET" and path == "/review/deck":
                return _respond(200, review.deck(state_path(), qs("hours") or None))
            if method == "GET" and path == "/review/overview":
                return _respond(200, review.overview(qs("hours") or None))
            if method == "GET" and path == "/review/history":
                return _respond(200, review.history(state_path()))
            if method == "GET" and path == "/review/picture":
                return _respond(200, review.picture(qs("path")))
            body = json.loads(sys.stdin.buffer.read() or b"{}")
            if not isinstance(body, dict):
                raise ValueError("body must be an object")
            if method == "POST" and path == "/review/voice":
                return _respond(200, review.voice(state_path(), body))
            if method == "POST" and path == "/review/send":
                return _respond(200, review.send(state_path(), body))
            if method == "POST" and path == "/review/agent":
                return _respond(200, review.agent(state_path(), body))
        except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as error:
            return _respond(400, {"error": str(error)})
        return _respond(404, {"error": "no route"})
    if method == "POST" and path == "/live/answer":
        try:
            d = json.loads(sys.stdin.buffer.read() or b"{}")
            return _respond(200, live_answer(d if isinstance(d, dict) else {}))
        except ValueError as error:
            return _respond(400, {"error": str(error)})
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
