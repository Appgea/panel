#!/usr/bin/env python3
"""standards.py — derive the conformance grid. Never store it.

A standard is one markdown file in ops/standards/<id>.md. It is written by hand or by an agent,
in prose, with a small frontmatter block. The grid is computed on every run from those files plus
portfolio.yaml. There is no second copy of the truth anywhere.

  python3 ops/_system/standards.py              # the grid
  python3 ops/_system/standards.py <id>         # one standard, per app, with notes
  python3 ops/_system/standards.py --json
  python3 ops/_system/standards.py --fix <id>   # run the standard's fix: on every failing app
"""
import json, os, re, subprocess, sys
import xml.etree.ElementTree as ET

OPS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def _root(hint=None):
    """The folder that holds the apps. Each app's `dir:` in portfolio.yaml is relative to it.

    APPGEA_ROOT wins. Then a project path Panel passes, or the first project in Panel's config.json,
    whose parent folder holds the apps. Last, the parent of this ops tree.
    """
    if os.environ.get("APPGEA_ROOT"):
        return os.path.abspath(os.environ["APPGEA_ROOT"])
    if hint:
        return os.path.dirname(os.path.abspath(hint))
    try:
        cfg = json.load(open(os.path.expanduser("~/.appgeapanel/config.json"), encoding="utf-8"))
        for entry in cfg.get("projects") or []:
            if entry.get("path"):
                return os.path.dirname(os.path.abspath(str(entry["path"])))
    except Exception:
        pass
    return os.path.dirname(OPS)

ROOT = _root()

def use_root(hint):
    """Point the grid at the portfolio that contains `hint`. Panel calls this with a project path."""
    global ROOT
    ROOT = _root(hint)
STD = os.path.join(OPS, "standards")

def apps():
    """key -> abs path, from portfolio.yaml, read the way Panel's `sprints::portfolio` reads it.

    An entry is any key at indent 2 under `apps:`, inline `{ dir: X }` or with an indented `dir:` line.
    """
    out, key = {}, None
    inside = False
    for line in open(os.path.join(OPS, "portfolio.yaml"), encoding="utf-8"):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        if indent == 0:
            inside, key = stripped.startswith("apps:"), None
            continue
        if not inside:
            continue
        if indent == 2:
            key, _, rest = stripped.partition(":")
            key, rest = key.strip(), rest.strip()
            if rest.startswith("{"):
                d = re.search(r"\bdir:\s*(\"[^\"]*\"|'[^']*'|[^,}\s]+)", rest)
                if d:
                    out[key] = os.path.join(ROOT, d.group(1).strip("\"'"))
                key = None
            continue
        if key and stripped.startswith("dir:"):
            value = stripped[4:].split(" #")[0].strip().strip("\"'")
            if value:
                out[key] = os.path.join(ROOT, value)
    return out

def standards():
    for name in sorted(os.listdir(STD)):
        if not name.endswith(".md") or name.startswith("_"):
            continue
        text = open(os.path.join(STD, name), encoding="utf-8").read()
        m = re.match(r"^---\n(.*?)\n---\n(.*)$", text, re.S)
        if not m:
            continue
        yield parse_front(m.group(1), name[:-3]), m.group(2)

def parse_front(block, fallback_id):
    """Tiny frontmatter reader: scalars, one inline list, and `key: |` shell blocks."""
    d, key, buf = {"id": fallback_id}, None, []
    for raw in block.split("\n"):
        m = re.match(r"^(\w+):\s*(\|?)\s*(.*)$", raw)
        if m and (m.group(2) or not raw.startswith(" ")):
            if key:
                d[key] = "\n".join(buf).strip(); buf = []
            k, pipe, val = m.groups()
            if pipe:
                key = k
            else:
                key = None
                d[k] = val.split("#")[0].strip()
        elif key:
            buf.append(raw.strip())
    if key:
        d[key] = "\n".join(buf).strip()
    if d.get("applies", "all").startswith("["):
        d["applies"] = [x.strip() for x in d["applies"].strip("[]").split(",") if x.strip()]
    return d

def manual(body):
    """`- <key>: pass|fail|n/a — note` lines under ## Manual state."""
    out = {}
    for line in body.split("\n"):
        m = re.match(r"^\s*-\s*(\w[\w_]*)\s*:\s*(pass|fail|n/a)\b\s*[—-]?\s*(.*)$", line, re.I)
        if m:
            out[m.group(1)] = (m.group(2).lower(), m.group(3).strip())
    return out

def run(cmd, cwd):
    try:
        p = subprocess.run(["bash", "-c", cmd], cwd=cwd, capture_output=True, text=True, timeout=60,
                           env={**os.environ, "APPGEA_OPS": OPS})
    except subprocess.TimeoutExpired:
        return "fail", "timeout"
    note = (p.stdout + p.stderr).strip().split("\n")[-1][:200] if (p.stdout or p.stderr) else ""
    return {0: "pass", 2: "n/a"}.get(p.returncode, "fail"), note

def evaluate():
    paths = apps()
    grid = {}
    for front, body in standards():
        scope = front.get("applies", "all")
        keys = list(paths) if scope == "all" else [k for k in scope if k in paths]
        hand = manual(body)
        row = {}
        for k in keys:
            if not os.path.isdir(paths[k]):
                row[k] = ("n/a", "no repo on disk"); continue
            if front.get("check"):
                row[k] = run(front["check"], paths[k])
            else:
                row[k] = hand.get(k, ("?", "unrecorded"))
        grid[front["id"]] = {"front": front, "row": row}
    return grid

MARK = {"pass": "·", "fail": "X", "n/a": " ", "?": "?"}


def code_lines(body):
    """Source lines with comments blanked, so a note points at code and keeps its line number."""
    out, block = [], False
    for line in body.split("\n"):
        s = line
        if block:
            end = s.find("*/")
            if end < 0:
                out.append("")
                continue
            s, block = s[end + 2:], False
        s = re.sub(r"(?<!:)//[^\n]*", "", s)
        while True:
            start = s.find("/*")
            if start < 0:
                break
            end = s.find("*/", start + 2)
            if end < 0:
                s, block = s[:start], True
                break
            s = s[:start] + s[end + 2:]
        out.append(s)
    return out


def app_kit_check(sid, root):
    """Conservative source checks. A pass is evidence to inspect, not runtime certification."""
    ignored = {".git", "build", ".dart_tool", "Pods", "node_modules", "output", "DerivedData",
               ".build", ".gradle", ".symlinks", "ephemeral", "Carthage", "vendor", "SourcePackages", ".venv"}
    sources = {}
    for directory, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in ignored and d.lower() not in {"test", "tests", "androidtest", "integration_test"} and not d.endswith("Tests")]
        for name in files:
            if name.endswith((".dart", ".swift", ".kt", ".plist", ".xml")):
                path = os.path.join(directory, name)
                with open(path, encoding="utf-8", errors="replace") as source:
                    sources[path] = source.read()
    code = {p: t for p, t in sources.items() if p.endswith((".dart", ".swift", ".kt"))}
    if not code:
        return 2, "no mobile app source"
    clean = {p: re.sub(r"/\*[\s\S]*?\*/|(?<!:)//[^\n]*", "", t) for p, t in code.items()}
    text = "\n".join(clean.values())
    if sid == "review-prompt":
        calls = re.sub(r"\b(?:func|fun|void|Future<void>)\s+(?:requestReview|launchReviewFlow)\s*\(", "", text)
        hit = re.search(r"\b(?:requestReview|launchReviewFlow)\s*\(", calls)
        return (0, "review request call found") if hit else (1, "no review request call")
    if sid == "crashlytics-wired":
        hit = any(re.search("crashlytics", t, re.I) and re.search(r"(?:recordFlutterFatalError|recordFlutterError|recordError|recordException|record\(error:)", t) for t in clean.values())
        return (0, "crash reporting hook found") if hit else (1, "no Crashlytics reporting hook")
    if sid == "consent-before-analytics":
        if not re.search(r"FirebaseAnalytics|firebase_analytics|Analytics\.logEvent", text):
            return 2, "no supported analytics SDK found"
        platforms = {name for name in ("ios", "android") if os.path.isdir(os.path.join(root, name))}
        if not platforms:
            platforms = {"ios"} if any(p.endswith(".swift") for p in code) else {"android"}
        disabled = set()
        for path, config in sources.items():
            if not path.endswith((".plist", ".xml")):
                continue
            try:
                tree = ET.fromstring(config)
            except ET.ParseError:
                continue
            for node in tree.iter():
                children = list(node)
                if path.endswith("Info.plist") and any(c.tag == "key" and c.text == "FIREBASE_ANALYTICS_COLLECTION_ENABLED" and children[i + 1].tag == "false" for i, c in enumerate(children[:-1])):
                    disabled.add("ios")
                android = "{http://schemas.android.com/apk/res/android}"
                if path.endswith("AndroidManifest.xml") and node.tag == "meta-data" and node.get(android + "name") == "firebase_analytics_collection_enabled" and node.get(android + "value") == "false":
                    disabled.add("android")
        gate = re.search(r"(?:setAnalyticsCollectionEnabled|setConsent)\s*\(", text)
        consent = re.search(r"consent", text, re.I)
        return (0, "all platform defaults off; consent API found; inspect ordering") if platforms <= disabled and gate and consent else (1, "missing platform default-off config or consent API")
    if sid == "settings-links":
        files = {p: t for p, t in code.items() if re.search(r"settings|preferences|ayar", os.path.relpath(p, root), re.I)}
        if not files:
            return 2, "no settings screen source"
        # The word alone, not inside a camelCase name: any hump would also count `HapticFeedback` and `debugResetIncludingSupport`.
        # The four names the check took before 2026-11-18 stay, spelled out.
        privacy = re.compile(r"(?<![A-Za-z])(?:privacy|gizlilik)(?![a-z])|privacyUrl|privacyPolicyURL", re.I)
        support = re.compile(r"(?<![A-Za-z])(?:support|destek|contact|feedback|yardım)(?![a-z])|mailto:|sorun mu|supportUrl", re.I)
        call = re.compile(r"Link\(|openURL|launchUrl|url_launcher|Uri\.parse|startActivity|NSWorkspace")

        def where(pattern):
            named = re.compile(r"settings|preferences|ayar", re.I)
            order = sorted(files, key=lambda p: (not named.search(os.path.basename(p)), p))
            for path in order:
                for n, line in enumerate(code_lines(files[path]), 1):
                    if pattern.search(line):
                        return "%s:%d" % (os.path.relpath(path, root), n)
            return None

        p_at, s_at, c_at = where(privacy), where(support), where(call)
        if p_at and s_at and c_at:
            return 0, "privacy %s, support %s" % (p_at, s_at)
        missing = [label for label, at in (("no privacy link", p_at), ("no support link", s_at), ("no link call", c_at)) if not at]
        return 1, ", ".join(missing)
    raise ValueError(sid)


def for_root(path):
    """One app's standards, keyed by its repo path. Returns (key, [{id,title,state,note}, ...])."""
    use_root(path)
    target = os.path.realpath(path)
    key = next((k for k, p in apps().items() if os.path.realpath(p) == target), None)
    if not key:
        return None, []
    rows = []
    for sid, g in sorted(evaluate().items()):
        state, note = g["row"].get(key, ("n/a", ""))
        if state == "n/a":
            continue
        rows.append({"id": sid, "title": g["front"].get("title", sid), "state": state,
                     "note": note, "fixable": bool(g["front"].get("fix"))})
    return key, rows

def main():
    args = sys.argv[1:]
    if args[:1] == ["--check"]:
        status, note = app_kit_check(args[1], os.getcwd())
        print(note)
        sys.exit(status)
    if "--fix" in args:
        sid = args[args.index("--fix") + 1]
        g = evaluate().get(sid)
        if not g or not g["front"].get("fix"):
            sys.exit(f"no fix: script on {sid}")
        paths = apps()
        for k, (state, _) in sorted(g["row"].items()):
            if state == "fail":
                st, note = run(g["front"]["fix"], paths[k])
                print(f"{k:20} {st} {note}")
        return
    grid = evaluate()
    if "--json" in args:
        print(json.dumps({k: {kk: vv[0] for kk, vv in v["row"].items()} for k, v in grid.items()}, indent=2))
        return
    only = [a for a in args if not a.startswith("-")]
    if only:
        sid = only[0]
        g = grid.get(sid) or sys.exit(f"no standard {sid}")
        print(f"{sid} — {g['front'].get('title','')}")
        for k, (state, note) in sorted(g["row"].items()):
            print(f"  {state:5} {k:20} {note}")
        return
    ids = sorted(grid)
    keys = sorted({k for g in grid.values() for k in g["row"]})
    w = max((len(k) for k in keys), default=4)
    for i, sid in enumerate(ids, 1):
        title = grid[sid]["front"].get("title", "")
        print(f"{i}. {sid} — {title}")
    print()
    print(f"{'':<{w}} " + "".join(str(i % 10) for i in range(1, len(ids) + 1)))
    for k in keys:
        cells = "".join(MARK[grid[s]["row"].get(k, ("n/a", ""))[0]] for s in ids)
        open_n = sum(1 for s in ids if grid[s]["row"].get(k, ("n/a", ""))[0] in ("fail", "?"))
        print(f"{k:<{w}} {cells}   {open_n if open_n else ''}")
    print("\nX = fails, ? = unrecorded, · = passes. Right column is what is open per app.")

if __name__ == "__main__":
    main()
