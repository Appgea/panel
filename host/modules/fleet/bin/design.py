"""Fleet Design: the fleet's bots, scout lenses, scout abilities and builder kinds, read and written as the files
the fleet already runs on. Panel's AI fleet > Fleet Design is its only caller.

- A lens or a routine is `ops/scouts/<id>.md`. A lens has `who:`. An ability is `ops/scouts/abilities/<id>.md`,
  its lens in `family:`. Both are frontmatter and a body.
- A builder kind is a `## <id>` section of `skills/fleet/kinds.md`, a bot one of `skills/fleet/bots.md`. Leading
  `Key: value` lines are its fields, the rest its body.

Every change is a list of whole-file writes kept in the module's state, so one Undo puts all of them back. A change
whose file moved on disk since the screen read it is refused, so another session's edit is never overwritten.
Ids never change: a kind is a `kind:` label on issues, a lens a key in fleet.py and scout.json, a bot a key of KINDS."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import time

HOME = Path(os.environ.get("PANEL_USER_HOME") or Path.home() / ".appgeapanel")
OPS = Path(os.environ.get("FLEET_OPS") or HOME / "ops")
SKILLS = Path(os.environ.get("FLEET_SKILLS") or HOME / "skills")
STATE = Path(os.environ.get("PANEL_STATE_DIR") or HOME / "state/fleet")
SCOUTS = OPS / "scouts"
ABILITIES = SCOUTS / "abilities"
KINDS_MD = SKILLS / "fleet/kinds.md"
BOTS_MD = SKILLS / "fleet/bots.md"
HISTORY = STATE / "design-history.json"
KEEP = 200
ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,60}$")
FIELDS = {"kind": ("When", "Read", "Pick"), "bot": ("Character", "Angle", "Limits", "Engine", "Plays", "Colour")}
SECTION_FILE = {"kind": KINDS_MD, "bot": BOTS_MD}
LIST_HEAD = re.compile(r"^Abilities, in `scouts/abilities/`:\s*$", re.M)


class Refused(Exception):
    pass


def sig(text):
    return hashlib.sha1((text or "").encode()).hexdigest()[:12]


def read(path):
    try:
        return Path(path).read_text()
    except FileNotFoundError:
        return None


def split_front(text):
    """([[key, value]...], body) of a lens, routine or ability. A line that is no `key:` continues the value above it."""
    if not text.startswith("---\n"):
        return [], text
    end = text.find("\n---\n", 3)
    if end < 0:
        return [], text
    meta = []
    for line in text[4:end].split("\n"):
        m = re.match(r"^([A-Za-z][\w-]*):(?: (.*))?$", line)
        if m:
            meta.append([m.group(1), m.group(2) or ""])
        elif meta:
            meta[-1][1] += "\n" + line
    return meta, text[end + 5:]


def join_front(meta, body):
    if not meta:
        return body
    return "---\n" + "\n".join(f"{k}: {v}".rstrip() for k, v in meta if k) + "\n---\n" + body


def front_item(kind, path):
    text = path.read_text()
    meta, body = split_front(text)
    get = dict(meta)
    item = {"type": kind, "id": path.stem, "title": get.get("title", ""), "meta": meta, "body": body,
            "path": str(path), "sig": sig(text)}
    if kind == "ability":
        item["family"] = get.get("family", "")
        item["paused"] = get.get("paused", "")
        learned = body.split("\n## Learned", 1)
        item["learned"] = len(re.findall(r"^- ", learned[1], re.M)) if len(learned) > 1 else 0
    else:
        item["type"] = "lens" if get.get("who") else "routine"
        item["script"] = bool(get.get("run"))
    return item


def split_sections(text):
    """(head, [[id, block]...]) of kinds.md or bots.md. A block is everything after its `## id` line, up to the next."""
    parts = re.split(r"^## ", text, flags=re.M)
    sections = []
    for part in parts[1:]:
        name, _, block = part.partition("\n")
        sections.append([name.strip(), block])
    return parts[0], sections


def join_sections(head, sections):
    return head + "".join(f"## {name}\n{block}" for name, block in sections)


def section_fields(kind, block):
    lines = block.split("\n")
    meta, i = [], 0
    while i < len(lines):
        m = re.match(rf"^({'|'.join(FIELDS[kind])}): ?(.*)$", lines[i])
        if not m:
            break
        meta.append([m.group(1), m.group(2)])
        i += 1
    return meta, "\n".join(lines[i:]).strip("\n")


def section_block(meta, body):
    lines = [f"{k}: {' '.join(v.split())}" for k, v in meta if k and v.strip()]
    body = body.strip("\n")
    return "\n".join(lines + ([body] if body else [])) + "\n\n"


def section_items(kind):
    path = SECTION_FILE[kind]
    text = read(path)
    if text is None:
        return []
    items = []
    for name, block in split_sections(text)[1]:
        meta, body = section_fields(kind, block)
        get = dict(meta)
        items.append({"type": kind, "id": name, "title": get.get("Character" if kind == "bot" else "When", ""),
                      "meta": meta, "body": body, "path": str(path), "sig": sig(block)})
    return items


def fleet_kinds():
    """The unit kinds `fleet.py` can start: the keys of its KINDS table."""
    text = read(OPS / "runbooks/fleet.py") or ""
    m = re.search(r"^KINDS = \{\n(.*?)^\}", text, re.M | re.S)
    return re.findall(r'^    "([\w-]+)":', m.group(1), re.M) if m else []


def everything():
    def files(folder):
        return sorted(p for p in folder.glob("*.md") if not p.name.startswith("_")) if folder.is_dir() else []
    scouts = [front_item("scout", p) for p in files(SCOUTS) if p.read_text().startswith("---\n")]
    return {
        "bots": section_items("bot"),
        "runnable": fleet_kinds(),
        "lenses": [s for s in scouts if s["type"] == "lens"],
        "routines": [s for s in scouts if s["type"] == "routine"],
        "abilities": [front_item("ability", p) for p in files(ABILITIES)],
        "kinds": section_items("kind"),
        "undo": last_change(),
        "files": {"scouts": str(SCOUTS), "abilities": str(ABILITIES), "kinds": str(KINDS_MD), "bots": str(BOTS_MD)},
    }


def history():
    try:
        return json.loads(HISTORY.read_text())
    except (OSError, ValueError):
        return []


def last_change():
    h = history()
    return {"what": h[-1]["what"], "at": h[-1]["at"]} if h else None


def write(path, text):
    path = Path(path)
    if text is None:
        path.unlink(missing_ok=True)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.design")
    tmp.write_text(text)
    tmp.replace(path)


def commit(what, writes):
    """Write each (path, before, after) and keep them, so Undo puts the change back as one."""
    writes = [list(w) for w in writes if w[1] != w[2]]
    if not writes:
        return
    for path, _, after in writes:
        write(path, after)
    STATE.mkdir(parents=True, exist_ok=True)
    HISTORY.write_text(json.dumps((history() + [{"what": what, "at": time.time(), "writes": writes}])[-KEEP:],
                                  ensure_ascii=False))


def undo():
    h = history()
    if not h:
        raise Refused("Nothing to undo.")
    change = h[-1]
    for path, _, after in change["writes"]:
        if read(path) != after:
            raise Refused(f"{Path(path).name} changed after that edit, so Undo would lose newer work.")
    for path, before, _ in reversed(change["writes"]):
        write(path, before)
    HISTORY.write_text(json.dumps(h[:-1], ensure_ascii=False))
    return change["what"]


def clean_meta(meta):
    out = []
    for pair in meta or []:
        k, v = str(pair[0]).strip(), str(pair[1]).replace("\r", "").strip()
        if re.match(r"^[A-Za-z][\w-]*$", k):
            out.append([k, v])
    return out


def ability_lines(text, ability, title, add):
    """A lens file with `- `ability`: title` added to or dropped from its abilities list. No list: unchanged."""
    meta, body = split_front(text)
    head = LIST_HEAD.search(body)
    if not head:
        return text
    lines = body.split("\n")
    start = body[:head.end()].count("\n") + 1
    end = start
    while end < len(lines) and lines[end].startswith("- "):
        end += 1
    kept = [line for line in lines[start:end] if not line.startswith(f"- `{ability}`")]
    if add:
        kept.append(f"- `{ability}`: {title}")
    return join_front(meta, "\n".join(lines[:start] + kept + lines[end:]))


def lens_write(lens, ability, title, add):
    text = read(SCOUTS / f"{lens}.md") if lens else None
    return [] if text is None else [(str(SCOUTS / f"{lens}.md"), text, ability_lines(text, ability, title, add))]


def save_section(kind, ident, meta, body, new, want):
    path = SECTION_FILE[kind]
    text = read(path) or ("# Bots\n\n" if kind == "bot" else None)
    if text is None:
        raise Refused(f"{path} is missing.")
    head, sections = split_sections(text)
    names = [n for n, _ in sections]
    if new and ident in names:
        raise Refused(f"`{ident}` already exists.")
    if not new and ident not in names:
        raise Refused(f"`{ident}` is gone from {path.name}. Reload.")
    block = section_block(meta, body)
    if new:
        if sections:
            sections[-1][1] = sections[-1][1].rstrip("\n") + "\n\n"
        sections.append([ident, block.rstrip("\n") + "\n"])
    else:
        i = names.index(ident)
        if sig(sections[i][1]) != want:
            raise Refused(f"`{ident}` changed on disk since you opened it. Reload, then edit again.")
        sections[i][1] = block if i < len(sections) - 1 else block.rstrip("\n") + "\n"
    commit(f"{'Added' if new else 'Saved'} {kind} {ident}", [(str(path), text, join_sections(head, sections))])


def save(req):
    kind, ident = req.get("type"), str(req.get("id", "")).strip()
    if not ID.match(ident):
        raise Refused("An id is lower case letters, digits and dashes, like `paywall-moment`.")
    meta, body, new = clean_meta(req.get("meta")), str(req.get("body", "")).replace("\r", ""), bool(req.get("new"))
    if kind in SECTION_FILE:
        return save_section(kind, ident, meta, body, new, req.get("sig"))
    if kind not in ("lens", "routine", "ability"):
        raise Refused(f"Unknown type {kind}.")
    path = (ABILITIES if kind == "ability" else SCOUTS) / f"{ident}.md"
    before = read(path)
    if new and (before is not None or (SCOUTS / f"{ident}.md").exists() or (ABILITIES / f"{ident}.md").exists()):
        raise Refused(f"`{ident}` already exists.")
    if not new and before is None:
        raise Refused(f"{path.name} is gone. Reload.")
    if not new and sig(before) != req.get("sig"):
        raise Refused(f"{path.name} changed on disk since you opened it. Reload, then edit again.")
    writes = [(str(path), before, join_front(meta, body if body.endswith("\n") else body + "\n"))]
    if kind == "ability":
        family = dict(meta).get("family", "")
        if not ID.match(family) or not (SCOUTS / f"{family}.md").exists():
            raise Refused(f"An ability needs a lens in `family:`. `{family or 'nothing'}` is no lens.")
        old = dict(split_front(before)[0]).get("family", "") if before else ""
        if family != old:
            writes += lens_write(old, ident, "", False) + lens_write(family, ident, dict(meta).get("title", ident), True)
    commit(f"{'Added' if new else 'Saved'} {kind} {ident}", writes)


def delete(req):
    kind, ident = req.get("type"), str(req.get("id", ""))
    if kind in SECTION_FILE:
        path = SECTION_FILE[kind]
        text = read(path) or ""
        head, sections = split_sections(text)
        match = [block for name, block in sections if name == ident]
        if not match:
            raise Refused(f"`{ident}` is gone. Reload.")
        if sig(match[0]) != req.get("sig"):
            raise Refused(f"`{ident}` changed on disk since you opened it. Reload first.")
        rest = [s for s in sections if s[0] != ident]
        if rest:
            rest[-1][1] = rest[-1][1].rstrip("\n") + "\n"
        commit(f"Removed {kind} {ident}", [(str(path), text, join_sections(head.rstrip("\n") + "\n" if not rest else head, rest))])
        return
    path = (ABILITIES if kind == "ability" else SCOUTS) / f"{ident}.md"
    text = read(path) if ID.match(ident) else None
    if text is None:
        raise Refused(f"`{ident}` is gone. Reload.")
    if sig(text) != req.get("sig"):
        raise Refused(f"{path.name} changed on disk since you opened it. Reload first.")
    writes = [(str(path), text, None)]
    if kind == "ability":
        writes += lens_write(dict(split_front(text)[0]).get("family", ""), ident, "", False)
    else:
        owned = [p.stem for p in ABILITIES.glob("*.md") if dict(split_front(p.read_text())[0]).get("family") == ident]
        if owned:
            raise Refused(f"`{ident}` still has {len(owned)} abilities: {', '.join(owned)}. Move or remove them first.")
    commit(f"Removed {kind} {ident}", writes)


def handle(method, path, body):
    """(status, reply) for a /design route. A refusal is a 200 with `refused`, so the screen shows why."""
    try:
        if method == "GET" and path == "/design":
            return 200, everything()
        req = json.loads(body or "{}")
        act = {"/design/save": save, "/design/delete": delete, "/design/undo": lambda _: undo()}.get(path)
        if method != "POST" or not act:
            return 404, {"error": f"no route {method} {path}"}
        STATE.mkdir(parents=True, exist_ok=True)
        with open(STATE / "design.lock", "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            done = act(req)
            reply = everything()
        return 200, {**reply, "undone": done} if path == "/design/undo" else reply
    except Refused as why:
        return 200, {"refused": str(why)}
    except (OSError, ValueError) as why:
        return 200, {"refused": f"Could not write: {why}"}
