"""A report keeps its own copy of every file it shows.

Panel reads a report's images, audio, video and files by path, later, whenever the report is opened. An agent
cleaning up its shots after sending left reports with dead images (2026-10-29). So each file goes into
~/.appgeapanel/reports/<day>/<id>/ first: a hard link where it can (no space, no time), a copy where it cannot.
Folders stay as they are. Reports older than KEEP_DAYS are pruned on the next send.
"""

import datetime
import os
import shutil
import uuid

ROOT = os.path.expanduser("~/.appgeapanel/reports")
KEEP_DAYS = 30


def _keep_one(path, into):
    if not isinstance(path, str) or not os.path.isfile(path):
        return path
    os.makedirs(into, exist_ok=True)
    name = os.path.basename(path)
    kept = os.path.join(into, name)
    n = 1
    # two shots of one report can share a name from different folders, or be the same file twice
    while os.path.exists(kept):
        if os.path.samefile(path, kept):
            return kept
        n += 1
        kept = os.path.join(into, "%d-%s" % (n, name))
    try:
        os.link(path, kept)
    except OSError:
        shutil.copy2(path, kept)
    return kept


def _prune(today):
    try:
        days = os.listdir(ROOT)
    except OSError:
        return
    cutoff = (today - datetime.timedelta(days=KEEP_DAYS)).isoformat()
    for day in days:
        if day < cutoff:
            shutil.rmtree(os.path.join(ROOT, day), ignore_errors=True)


def keep_media(payload):
    """Point every file of a report's payload at a kept copy. Returns the payload."""
    today = datetime.date.today()
    into = os.path.join(ROOT, today.isoformat(), uuid.uuid4().hex[:12])
    for key in ("images", "audio", "video", "attachments"):
        items = payload.get(key)
        if not isinstance(items, list):
            continue
        for i, item in enumerate(items):
            if isinstance(item, str):
                items[i] = _keep_one(item, into)
            elif isinstance(item, dict) and item.get("kind") != "folder" and "path" in item:
                item["path"] = _keep_one(item["path"], into)
    _prune(today)
    return payload
