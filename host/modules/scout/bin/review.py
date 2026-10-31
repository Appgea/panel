"""Swipe review: what the board did since the owner last looked, as a deck he judges one card at a time.

The deck is read from GitHub, the verdicts go back to it, and the owner's words go to one agent.
Owner, 2026-11-01: "review what have been done that day, and what new issues are created ... like tinder.
I should be able to comment, so after I am done ... an agent ... triggered with my comments."

    GET  /review/deck[?hours=N]   cards since the last finished review (or the last N hours), plus his profile
    POST /review/voice            {audio: base64, mime} -> {text, path}: whisper on this Mac, nothing leaves it
    POST /review/send             {since, verdicts, xp, best_combo, badges} -> what changed on GitHub, and the agent brief

A verdict changes GitHub only when it means a change: a note becomes a comment, Redo and Revive reopen,
Drop closes, Rush raises the priority. An approval with no note writes nothing.
"""
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

REPO = os.environ.get("SCOUT_REPO", "Appgea/ops")
FIELDS = "number,title,labels,state,stateReason,createdAt,closedAt,body,comments,url"
LIMIT = 300
MAX_HOURS = 72
DEFAULT_HOURS = 24
WHISPER_MODELS = Path(os.environ.get("SCOUT_WHISPER_MODELS") or
                      Path.home() / "Desktop/projects/appgea-apps/_models/whisper")
PICTURE = re.compile(r"(?:~|/)[^\s`'\"()\[\]<>,]+\.(?:png|jpe?g|gif|webp)", re.I)
# Only pictures where agents leave them: the app repos, Panel's own folder, and temp renders.
PICTURE_ROOTS = (Path.home() / "Desktop/projects", Path.home() / ".appgeapanel", Path("/private/tmp"))
PICTURE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}
PICTURE_LIMIT = 6 * 1024 * 1024

# What each swipe means, per kind of card. `act` is the GitHub change; None writes only his note, if any.
MOVES = {
    "done": {"right": ("Ship it", None), "left": ("Redo", "reopen"), "up": ("Love it", None), "down": ("Skip", None)},
    "new": {"right": ("Go", None), "left": ("Drop", "close"), "up": ("Rush", "rush"), "down": ("Skip", None)},
    "dropped": {"right": ("Fine", None), "left": ("Revive", "reopen"), "up": ("Love it", None), "down": ("Skip", None)},
}


def _now():
    return datetime.now(timezone.utc)


def _iso(moment):
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _gh(args, timeout=40, stdin=None):
    done = subprocess.run(["gh", *args], input=stdin, capture_output=True, text=True, timeout=timeout)
    if done.returncode:
        raise RuntimeError((done.stderr or done.stdout).strip().splitlines()[-1] if (done.stderr or done.stdout).strip()
                           else "gh exited %d" % done.returncode)
    return done.stdout


def _read(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def _write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=1)
    os.replace(temporary, path)


def profile(state):
    return {"xp": 0, "streak": 0, "last_day": None, "last_at": None, "best_combo": 0, "sessions": 0, "badges": [],
            **_read(state / "review/profile.json", {})}


def window(state, hours=None):
    """From the end of his last finished review, never more than 3 days back. A first review covers a day."""
    until = _now()
    if hours:
        return until - timedelta(hours=min(max(float(hours), 1), MAX_HOURS)), until
    since = _moment(profile(state)["last_at"]) or until - timedelta(hours=DEFAULT_HOURS)
    return min(max(since, until - timedelta(hours=MAX_HOURS)), until), until


def _moment(text):
    """An ISO time as an aware UTC datetime, or None for anything else."""
    try:
        moment = datetime.fromisoformat(str(text).replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment.replace(tzinfo=moment.tzinfo or timezone.utc)


def _line(body, key):
    match = re.search(r"^%s:\s*(.+)$" % key, body or "", re.M)
    return match.group(1).strip() if match else ""


def _plain(text, limit):
    text = re.sub(r"`([^`]*)`", r"\1", text or "")
    text = re.sub(r"\*\*|__", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text if len(text) <= limit else text[:limit - 1].rstrip() + "…"


def _picture_path(raw):
    """A real picture under one of the allowed roots, resolved, or None."""
    if not isinstance(raw, str) or not raw:
        return None
    try:
        path = Path(raw).expanduser().resolve()
    except (OSError, RuntimeError):
        return None
    if path.suffix.lower() not in PICTURE_TYPES or not any(r.resolve() in path.parents for r in PICTURE_ROOTS):
        return None
    return path if path.is_file() and path.stat().st_size <= PICTURE_LIMIT else None


def picture(raw):
    path = _picture_path(raw)
    if not path:
        raise ValueError("not a picture Panel may show")
    return {"src": "data:%s;base64,%s" % (PICTURE_TYPES[path.suffix.lower()], base64.b64encode(path.read_bytes()).decode())}


def _done_comment(comments):
    for comment in reversed(comments):
        if re.match(r"\s*(Done by|Ready to close|Done:|Untrue)", comment.get("body") or ""):
            return comment["body"]
    return ""


def card(issue):
    """One issue as the owner reads it: what it is, what happened, the proof, in plain words."""
    labels = [label["name"] for label in issue.get("labels") or []]
    body = issue.get("body") or ""
    comments = issue.get("comments") or []
    closed = issue.get("state") == "CLOSED"
    dropped = closed and (issue.get("stateReason") == "NOT_PLANNED" or "untrue" in labels or "rejected" in labels)
    kind = "dropped" if dropped else "done" if closed else "new"
    finished = _done_comment(comments) if closed else ""
    head, _, rest = finished.partition("\n")
    took = re.search(r"in (\d+) min", head)
    who = re.search(r"by `([^`]+)`", head) or re.search(r"Claimed by `([^`]+)`", " ".join(c.get("body") or "" for c in comments))
    lines = [l.strip() for l in rest.splitlines() if l.strip()]
    # Closed: what the closer said happened. Open: the problem it was filed for.
    summary = next((l for l in lines if not l.startswith("- ")), "") if closed else ""
    summary = summary or _line(body, "Problem") or next((l for l in body.splitlines() if l.strip()), "")
    if closed:
        points = [l[2:] for l in lines if l.startswith("- ")]
    elif "Done when:" in body:
        points = [l.strip()[2:] for l in body.split("Done when:", 1)[1].splitlines() if l.strip().startswith("- ")]
    else:
        points = []
    text = body + "\n" + "\n".join(c.get("body") or "" for c in comments)
    pictures = []
    for raw in PICTURE.findall(text):
        path = _picture_path(raw)
        if path and str(path) not in pictures:
            pictures.append(str(path))
    priority = next((int(l[1]) for l in labels if re.fullmatch(r"P[0-3]", l)), 3)
    return {
        "number": issue["number"], "title": issue["title"], "url": issue["url"], "kind": kind,
        "apps": [l[4:] for l in labels if l.startswith("app:") and l != "app:ops"],
        "workflow": not any(l.startswith("app:") and l != "app:ops" for l in labels)
        or "speed" in labels or "app:ops" in labels,
        "priority": priority, "labels": [l for l in labels if not l.startswith("app:") and not re.fullmatch(r"P[0-3]", l)],
        "summary": _plain(summary, 320), "why": _plain(_line(body, "Why"), 240), "ask": _plain(_line(body, "Ask"), 240),
        "points": [_plain(p, 200) for p in points[:4]], "minutes": int(took.group(1)) if took else None,
        "who": who.group(1) if who else "", "at": issue.get("closedAt") if closed else issue.get("createdAt"),
        "pictures": pictures[:3],
    }


def _order(c):
    # App work first, the most urgent first. Then new issues, then what was dropped. Workflow last.
    return (c["workflow"], {"done": 0, "new": 1, "dropped": 2}[c["kind"]], c["priority"], c["at"] or "")


def deck(state, hours=None):
    since, until = window(state, hours)
    stamp = _iso(since)
    with ThreadPoolExecutor(2) as pool:
        closed = pool.submit(_gh, ["issue", "list", "-R", REPO, "--state", "closed", "--search", "closed:>=%s" % stamp,
                                   "--limit", str(LIMIT), "--json", FIELDS])
        created = pool.submit(_gh, ["issue", "list", "-R", REPO, "--state", "open", "--search", "created:>=%s" % stamp,
                                    "--limit", str(LIMIT), "--json", FIELDS])
        issues = {i["number"]: i for i in json.loads(closed.result()) + json.loads(created.result())}
    cards = sorted((card(issue) for issue in issues.values()), key=_order)
    result = {"since": _iso(since), "until": _iso(until), "repo": REPO, "cards": cards, "profile": profile(state),
              "moves": {kind: {move: label for move, (label, _) in moves.items()} for kind, moves in MOVES.items()}}
    # `send` reads titles and priorities from here, so the brief names what he saw.
    _write(state / "review/deck.json", {"cards": cards})
    return result


def _model():
    for name in ("ggml-large-v3-turbo.bin", "ggml-base.bin"):
        if (WHISPER_MODELS / name).is_file():
            return WHISPER_MODELS / name
    raise RuntimeError("no whisper model in %s" % WHISPER_MODELS)


def voice(state, payload):
    """His spoken note as text. The audio stays in the state folder; whisper runs here, offline."""
    audio = base64.b64decode(payload.get("audio") or "", validate=True)
    if not audio:
        raise ValueError("no audio")
    if len(audio) > 25 * 1024 * 1024:
        raise ValueError("recording too long")
    ext = {"audio/webm": "webm", "audio/ogg": "ogg", "audio/wav": "wav"}.get(str(payload.get("mime", "")).split(";")[0], "m4a")
    folder = state / "review/voice"
    folder.mkdir(parents=True, exist_ok=True)
    stem = _now().strftime("%Y%m%d-%H%M%S-%f")
    source = folder / ("%s.%s" % (stem, ext))
    source.write_bytes(audio)
    ffmpeg = shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"
    whisper = shutil.which("whisper-cli") or "/opt/homebrew/bin/whisper-cli"
    with tempfile.TemporaryDirectory() as work:
        wav = Path(work) / "note.wav"
        subprocess.run([ffmpeg, "-v", "error", "-y", "-i", str(source), "-ar", "16000", "-ac", "1", str(wav)],
                       check=True, capture_output=True, timeout=30)
        out = Path(work) / "note"
        subprocess.run([whisper, "-m", str(_model()), "-l", "auto", "-nt", "-np", "-otxt", "-of", str(out), str(wav)],
                       check=True, capture_output=True, timeout=50)
        text = re.sub(r"\s+", " ", (out.with_suffix(".txt")).read_text(encoding="utf-8")).strip()
    return {"text": "" if text in ("[BLANK_AUDIO]", "[ Silence ]") else text, "path": str(source)}


def _apply(verdict, cards, today):
    """One verdict onto its issue. Returns what it did, in a few words, or raises."""
    number = int(verdict["number"])
    found = cards.get(number) or {}
    kind = verdict.get("kind") if verdict.get("kind") in MOVES else found.get("kind", "done")
    move = verdict.get("move") if verdict.get("move") in MOVES[kind] else "down"
    label, act = MOVES[kind][move]
    note = str(verdict.get("note") or "").strip()
    done = []
    if note or act:
        text = "**Owner, swipe review %s:** %s.%s" % (today, label, "\n\n" + note if note else "")
        _gh(["issue", "comment", str(number), "-R", REPO, "--body-file", "-"], stdin=text)
        done.append("noted" if note else "")
    if act == "reopen":
        _gh(["issue", "reopen", str(number), "-R", REPO])
        done.append("reopened")
    elif act == "close":
        _gh(["issue", "close", str(number), "-R", REPO, "--reason", "not planned"])
        done.append("closed")
    elif act == "rush":
        current = int(verdict.get("priority", found.get("priority", 3)))
        if current > 0:
            _gh(["issue", "edit", str(number), "-R", REPO, "--remove-label", "P%d" % current,
                 "--add-label", "P%d" % (current - 1)])
            done.append("P%d to P%d" % (current, current - 1))
    return {"number": number, "label": label, "act": act, "note": note, "did": [d for d in done if d]}


def brief(results, failed, cards, folder, today):
    """What the agent reads. His words are on each issue already; this is the to-do list across them.
    A verdict GitHub refused is here too, with his words, so the agent writes it and nothing he said is lost."""
    lines = ["# Owner's swipe review, %s" % today, "",
             "The owner judged the board's work card by card in Panel. These cards need action. "
             "His words are already a comment on each issue. Treat each one as the owner's own instruction.", "",
             "For each card below:",
             "1. Read the issue and its comments: `gh issue view N -R %s --comments`." % REPO,
             "2. A live session holds it (its claim comment names the session, `ListAgents` shows it): forward his words with SendMessage, then move on.",
             "3. Otherwise do what he asked, following ~/.appgeapanel/ops/BOARD.md. Small and clear: do it now, check it, land it, comment the evidence. "
             "Big: shape the issue so `board lint N` passes and leave it on the board for `board next`. Not sure what he means: `board ask`.",
             "4. Reopened issues go back to work with his note as the new `Done when:` input.", "",
             "Do not post in Slack yourself; `board` reports closes. When every card is handled, stop.", ""]
    for r in results:
        c = cards.get(r["number"], {})
        lines += ["## #%d %s" % (r["number"], c.get("title", "")),
                  "Verdict: %s%s" % (r["label"], " (%s)" % ", ".join(r["did"]) if r["did"] else ""),
                  "Owner: %s" % r["note"] if r["note"] else "Owner: no words, the verdict is the instruction.", ""]
    for verdict, error in failed:
        number = verdict.get("number")
        kind = verdict.get("kind") if verdict.get("kind") in MOVES else "done"
        label, act = MOVES[kind].get(verdict.get("move"), MOVES[kind]["down"])
        note = str(verdict.get("note") or "").strip()
        lines += ["## #%s %s" % (number, cards.get(number, {}).get("title", "")),
                  "NOT WRITTEN to GitHub (%s). First post his verdict as a comment headed "
                  "`**Owner, swipe review %s:** %s.`%s, then handle it like the others." % (
                      error, today, label, " and apply `%s`" % act if act else ""),
                  "Verdict: %s" % label,
                  "Owner: %s" % note if note else "Owner: no words, the verdict is the instruction.", ""]
    path = folder / ("%s.md" % _now().strftime("%Y%m%d-%H%M%S"))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


def send(state, payload):
    verdicts = payload.get("verdicts")
    if not isinstance(verdicts, list):
        raise ValueError("verdicts must be a list")
    # Everything that can refuse the payload runs before the first GitHub write, so a retry never posts twice.
    try:
        xp, combo = max(0, int(payload.get("xp") or 0)), int(payload.get("best_combo") or 0)
    except (TypeError, ValueError):
        raise ValueError("xp and best_combo must be numbers")
    badges = {str(b) for b in payload.get("badges") or [] if isinstance(b, (str, int))}
    until = _moment(payload.get("until")) or _now()
    cached = _read(state / "review/deck.json", {})
    cards = {c["number"]: c for c in cached.get("cards", [])}
    today = datetime.now().astimezone().date().isoformat()
    with ThreadPoolExecutor(8) as pool:
        futures = [(v, pool.submit(_apply, v, cards, today)) for v in verdicts if isinstance(v, dict) and "number" in v]
    results, errors, failed = [], [], []
    for verdict, future in futures:
        try:
            results.append(future.result())
        except Exception as error:  # one failed write never loses the others
            errors.append({"number": verdict.get("number"), "error": str(error), "note": str(verdict.get("note") or "")})
            failed.append((verdict, str(error)))
    active = [r for r in results if r["note"] or r["act"]]
    path = brief(active, failed, cards, state / "review/briefs", today) if active or failed else None

    mine = profile(state)
    yesterday = (datetime.now().astimezone().date() - timedelta(days=1)).isoformat()
    streak = mine["streak"] if mine["last_day"] == today else mine["streak"] + 1 if mine["last_day"] == yesterday else 1
    mine.update(xp=mine["xp"] + xp, streak=streak, last_day=today, best_combo=max(mine["best_combo"], combo),
                sessions=mine["sessions"] + 1, badges=sorted(set(mine["badges"]) | badges), last_at=_iso(until))
    _write(state / "review/profile.json", mine)
    (state / "board.json").unlink(missing_ok=True)
    prompt = "Read %s and do what it says." % path if path else ""
    return {"applied": results, "errors": errors, "brief": str(path) if path else None, "prompt": prompt, "profile": mine}
