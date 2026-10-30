"""A report keeps its own copy of every file it shows.

Panel reads a report's images, audio, video and files by path, later, whenever the report is opened. An agent
cleaning up its shots after sending left reports with dead images (2026-10-29). So each file is copied into
~/.appgeapanel/reports/<day>/<id>/ first. A copy, not a hard link: a shot tool rewrites the same path in place,
which would change an old report's picture. Folders stay as they are. Nothing is pruned by age: a report opened
later must still find its pictures. A file that cannot be copied keeps its own path: a report is never lost to its copy.
"""

import datetime
import os
import shutil
import uuid

ROOT = os.path.expanduser("~/.appgeapanel/reports")


def _keep_one(path, into, seen):
    if not isinstance(path, str) or not os.path.isfile(path):
        return path
    if path in seen:
        return seen[path]
    seen[path] = kept = _copy(path, into)
    return kept


def _copy(path, into):
    try:
        os.makedirs(into, exist_ok=True)
    except OSError:
        return path
    name = os.path.basename(path)
    kept = os.path.join(into, name)
    n = 1
    # two shots of one report can share a name from different folders
    while os.path.exists(kept):
        n += 1
        kept = os.path.join(into, "%d-%s" % (n, name))
    try:
        shutil.copy2(path, kept)
    except OSError:
        return path
    return kept


def keep_media(payload):
    """Point every file of a report's payload at a kept copy. Returns the payload."""
    today = datetime.date.today()
    into = os.path.join(ROOT, today.isoformat(), uuid.uuid4().hex[:12])
    seen = {}
    for key in ("images", "audio", "video", "attachments"):
        items = payload.get(key)
        if not isinstance(items, list):
            continue
        for i, item in enumerate(items):
            if isinstance(item, str):
                items[i] = _keep_one(item, into, seen)
            elif isinstance(item, dict) and item.get("kind") != "folder" and "path" in item:
                item["path"] = _keep_one(item["path"], into, seen)
    return payload
