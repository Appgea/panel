"""A report keeps its own small copy of every file it shows.

Panel reads a report's images, audio, video and files by path, later, whenever the report is opened. An agent
cleaning up its shots after sending left reports with dead images (2026-10-29). So each file is copied into
~/.appgeapanel/reports/<day>/<id>/ first. A copy, not a hard link: a shot tool rewrites the same path in place,
which would change an old report's picture. Folders stay as they are. A file that cannot be copied keeps its
own path: a report is never lost to its copy.

The copies must not bloat the disk. They were 3.2 GB after 17 days, nearly all of it video (one clip 772 MB).
Owner, 2026-11-15: "memory must not bloat". So a file over MAX_COPY is not copied: it keeps its own path, and the
Inbox opens it where it lies. Panel drops each day folder a month on, with the messages (src-tauri inbox.rs).

Owner, 2026-11-16: "Agents must reduce quality, merge images or sounds before sending." An agent sent a render
run of 2000 images, and the Inbox stuck. So the send does it, not the agent's goodwill: a picture is kept as a
JPEG no wider or taller than IMAGE_EDGE, more than SHEET_AT pictures become contact sheets, and more than one
sound becomes one track with short gaps. A captioned list says what is where. Without ffmpeg, or when it fails,
the files are copied as they are: a report is never lost to its shrinking.
"""

import datetime
import os
import shutil
import subprocess
import uuid

ROOT = os.path.expanduser("~/.appgeapanel/reports")
MAX_COPY = 25 * 1024 * 1024
# Attachments are copied as they are. A report of hundreds keeps the rest at their own path.
MAX_FILES = 48

IMAGE_EDGE = 1600
# Up to this many pictures stay apart, so each opens in the lightbox. More become sheets.
SHEET_AT = 6
CELL = 480
GUTTER = 6
COLUMNS = 4
PER_SHEET = 24
MAX_SHEETS = 2
# Sounds merged into one track, and the silence between them.
MAX_SOUNDS = 12
GAP_S = 0.7
LOSSLESS = (".wav", ".aif", ".aiff", ".flac", ".caf")
AUDIO_SMALL = 2 * 1024 * 1024
FFMPEG_TIMEOUT = 120


def _ffmpeg():
    return shutil.which("ffmpeg") or next(
        (p for p in ("/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg") if os.path.isfile(p)), None)


def _run(args):
    ffmpeg = _ffmpeg()
    if not ffmpeg:
        return False
    try:
        done = subprocess.run([ffmpeg, "-v", "error", "-y", *args], capture_output=True, timeout=FFMPEG_TIMEOUT)
    except (OSError, subprocess.SubprocessError):
        return False
    return done.returncode == 0 and os.path.isfile(args[-1]) and os.path.getsize(args[-1]) > 0


def _free_name(into, name):
    kept = os.path.join(into, name)
    n = 1
    # two shots of one report can share a name from different folders
    while os.path.exists(kept):
        n += 1
        kept = os.path.join(into, "%d-%s" % (n, name))
    return kept


def _copy(path, into):
    try:
        if os.path.getsize(path) > MAX_COPY:
            return path
        os.makedirs(into, exist_ok=True)
    except OSError:
        return path
    kept = _free_name(into, os.path.basename(path))
    try:
        shutil.copy2(path, kept)
    except OSError:
        return path
    return kept


def _keep_one(path, into, seen):
    if not isinstance(path, str) or not os.path.isfile(path):
        return path
    if path in seen:
        return seen[path]
    if len(seen) >= MAX_FILES:
        return path
    seen[path] = kept = _copy(path, into)
    return kept


def _small_image(path, into):
    """One picture as a JPEG that fits IMAGE_EDGE. A GIF keeps its motion, so it is only copied."""
    if path.lower().endswith(".gif"):
        return _copy(path, into)
    os.makedirs(into, exist_ok=True)
    out = _free_name(into, os.path.splitext(os.path.basename(path))[0] + ".jpg")
    fit = "scale=w='min(%d,iw)':h='min(%d,ih)':force_original_aspect_ratio=decrease" % (IMAGE_EDGE, IMAGE_EDGE)
    return out if _run(["-i", path, "-vf", fit, "-frames:v", "1", "-q:v", "4", out]) else _copy(path, into)


def _sheet(paths, into, n):
    """Pictures in a grid of CELL squares, COLUMNS wide, left to right then down."""
    os.makedirs(into, exist_ok=True)
    out = _free_name(into, "sheet-%d.jpg" % n)
    args, chains, labels, layout = [], [], [], []
    for i, path in enumerate(paths):
        args += ["-i", path]
        # A gutter round each picture, so two screenshots never read as one.
        inner = CELL - 2 * GUTTER
        chains.append("[%d:v]scale=%d:%d:force_original_aspect_ratio=decrease,"
                      "pad=%d:%d:(ow-iw)/2:(oh-ih)/2:color=0x16161a,setsar=1,format=yuv420p[c%d]"
                      % (i, inner, inner, CELL, CELL, i))
        labels.append("[c%d]" % i)
        layout.append("%d_%d" % (i % COLUMNS * CELL, i // COLUMNS * CELL))
    if len(paths) == 1:
        graph = chains[0].replace("[c0]", "[out]")
    else:
        graph = ";".join(chains) + ";%sxstack=inputs=%d:layout=%s:fill=0x16161a[out]" % (
            "".join(labels), len(paths), "|".join(layout))
    return out if _run([*args, "-filter_complex", graph, "-map", "[out]", "-frames:v", "1", "-q:v", "4", out]) else None


def _label(item, path):
    caption = item.get("caption") if isinstance(item, dict) else None
    return (caption or os.path.basename(path)).strip()


def _images(items, into):
    """Every picture shrunk. Past SHEET_AT, contact sheets with a caption that names each cell."""
    found = [(item, item if isinstance(item, str) else item.get("path")) for item in items]
    found = [(item, path) for item, path in found if isinstance(path, str) and os.path.isfile(path)]
    if len(found) <= SHEET_AT or not _ffmpeg():
        out = []
        for item in items:
            path = item if isinstance(item, str) else item.get("path") if isinstance(item, dict) else None
            if not isinstance(path, str) or not os.path.isfile(path):
                out.append(item)
            elif isinstance(item, dict):
                out.append({**item, "path": _small_image(path, into)})
            else:
                out.append(_small_image(path, into))
        return out
    shown = found[: PER_SHEET * MAX_SHEETS]
    sheets = []
    for n, start in enumerate(range(0, len(shown), PER_SHEET), 1):
        part = shown[start:start + PER_SHEET]
        sheet = _sheet([path for _, path in part], into, n)
        if not sheet:
            # A sheet that fails leaves its pictures apart, shrunk: the report still shows them.
            sheets += [{"path": _small_image(path, into), "caption": _label(item, path)} for item, path in part]
            continue
        names = "; ".join("%d %s" % (i, _label(item, path)) for i, (item, path) in enumerate(part, start + 1))
        sheets.append({"path": sheet, "caption": "Left to right, then down: " + names})
    if len(found) > len(shown):
        sheets[-1]["caption"] += ". %d more pictures not shown." % (len(found) - len(shown))
    return sheets


def _small_sound(path, into):
    """A lossless or large clip as AAC. A small compressed one is only copied."""
    try:
        small = os.path.getsize(path) <= AUDIO_SMALL and not path.lower().endswith(LOSSLESS)
    except OSError:
        return path
    if small:
        return _copy(path, into)
    os.makedirs(into, exist_ok=True)
    out = _free_name(into, os.path.splitext(os.path.basename(path))[0] + ".m4a")
    return out if _run(["-i", path, "-vn", "-c:a", "aac", "-b:a", "128k", out]) else _copy(path, into)


def _sounds(items, into):
    """Every clip shrunk. More than one become one track, in order, with a short gap between."""
    found = [(item, item if isinstance(item, str) else item.get("path")) for item in items]
    found = [(item, path) for item, path in found if isinstance(path, str) and os.path.isfile(path)]
    if len(found) <= 1 or not _ffmpeg():
        out = []
        for item in items:
            path = item if isinstance(item, str) else item.get("path") if isinstance(item, dict) else None
            if not isinstance(path, str) or not os.path.isfile(path):
                out.append(item)
            else:
                out.append({**item, "path": _small_sound(path, into)} if isinstance(item, dict) else _small_sound(path, into))
        return out
    part = found[:MAX_SOUNDS]
    os.makedirs(into, exist_ok=True)
    out = _free_name(into, "sounds.m4a")
    args, chains = [], []
    for i, (_, path) in enumerate(part):
        args += ["-i", path]
        pad = "" if i == len(part) - 1 else ",apad=pad_dur=%s" % GAP_S
        chains.append("[%d:a]aresample=44100,aformat=channel_layouts=stereo%s[a%d]" % (i, pad, i))
    graph = ";".join(chains) + ";%sconcat=n=%d:v=0:a=1[out]" % ("".join("[a%d]" % i for i in range(len(part))), len(part))
    if not _run([*args, "-filter_complex", graph, "-map", "[out]", "-c:a", "aac", "-b:a", "128k", out]):
        return [({**item, "path": _small_sound(path, into)} if isinstance(item, dict) else _small_sound(path, into))
                for item, path in part]
    caption = "In order: " + "; ".join("%d %s" % (i, _label(item, path)) for i, (item, path) in enumerate(part, 1))
    if len(found) > len(part):
        caption += ". %d more clips left out." % (len(found) - len(part))
    return [{"path": out, "caption": caption}]


def keep_media(payload):
    """Point every file of a report's payload at a kept, shrunk copy. Returns the payload."""
    today = datetime.date.today()
    into = os.path.join(ROOT, today.isoformat(), uuid.uuid4().hex[:12])
    if isinstance(payload.get("images"), list):
        payload["images"] = _images(payload["images"], into)
    if isinstance(payload.get("audio"), list):
        payload["audio"] = _sounds(payload["audio"], into)
    seen = {}
    for key in ("video", "attachments"):
        items = payload.get(key)
        if not isinstance(items, list):
            continue
        for i, item in enumerate(items):
            if isinstance(item, str):
                items[i] = _keep_one(item, into, seen)
            elif isinstance(item, dict) and item.get("kind") != "folder" and "path" in item:
                item["path"] = _keep_one(item["path"], into, seen)
    return payload
