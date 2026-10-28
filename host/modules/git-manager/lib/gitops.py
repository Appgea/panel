"""Pure git subprocess logic for the git-manager module — no Panel deps.

Everything shells out to `git` (stdlib only). Nothing here raises to the caller: failures
come back as {"error": ...} dicts so the HTTP layer can surface them inline instead of 500ing.
Conflict resolution shells out to whatever agent CLI (claude/codex) is on PATH directly —
it doesn't reach into Panel's AGENTS/CONFIG, so this stays a self-contained git-tool ability.
"""
import json
import concurrent.futures
import os
import re
import shlex
import shutil
import subprocess
import time

# Panel's project registry lives outside the signed bundle. The environment override is shared
# with Rust; a bare module run resolves the same default itself.
_PANEL_USER_HOME = os.environ.get("PANEL_USER_HOME") or os.path.join(
    os.path.expanduser("~"), ".appgeapanel"
)
_PANEL_CONFIG = os.path.join(_PANEL_USER_HOME, "config.json")

GIT_PRUNE = {"node_modules", "build", ".dart_tool", "Pods", "DerivedData", ".gradle",
             ".git", ".next", "dist", ".venv", "venv", "__pycache__", ".idea", "vendor"}
# a local branch whose last commit is older than this is flagged "old" in the UI
OLD_BRANCH_DAYS = 60
# distinct, readable lane colors — reused by the client palette so server lane == client color
LANE_COLORS = ["#7c5cff", "#3fb950", "#f0883e", "#58a6ff", "#db61a2", "#e3b341",
               "#39c5cf", "#f85149", "#a371f7", "#56d364"]

# Non-interactive git: never block on a credential/passphrase prompt (no TTY here, so a prompt
# would just hang the request until timeout). Keychain/agent-backed auth still works — this only
# kills the *interactive* fallback.
_GIT_ENV = dict(os.environ)
_GIT_ENV["GIT_TERMINAL_PROMPT"] = "0"
_GIT_ENV.setdefault("GIT_SSH_COMMAND", "ssh -oBatchMode=yes -oConnectTimeout=10")

# ---- bulk-pull live progress ----
# The 'pull all' sweep and the dashboard's progress poll are SEPARATE one-shot subprocesses (this
# module is CGI-argv), so they can't share memory. Phases go through a small JSON file keyed by
# repo path; the poll GET reads it. Writes are atomic (temp + rename) so a concurrent read never
# sees a torn file, and everything here is best-effort — a progress hiccup never breaks the git op.
# Not beside this file: installed, that directory is inside a read-only app bundle. Panel hands
# the writable one over as PANEL_STATE_DIR, and a bare CLI run resolves the same path itself.
_STATE_DIR = os.environ.get("PANEL_STATE_DIR") or os.path.join(
    os.path.expanduser("~"), ".appgeapanel", "state", "git-manager"
)
_PULL_PROGRESS = os.path.join(_STATE_DIR, "pull-progress.json")

def _progress_read():
    try:
        with open(_PULL_PROGRESS) as fh:
            return json.load(fh)
    except Exception:
        return {}

def _progress_set(repo, phase, note=""):
    try:
        os.makedirs(_STATE_DIR, exist_ok=True)
        data = _progress_read()
        data[os.path.realpath(repo)] = {"phase": phase, "note": note, "at": time.time()}
        tmp = _PULL_PROGRESS + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(data, fh)
        os.replace(tmp, _PULL_PROGRESS)
    except Exception:
        pass

def sync_progress(repo=""):
    """Live phase of an in-flight pull or push. With a repo -> that repo's {phase,note,at} (or
    {}); without -> the whole map. Polled by the bulk sync UI to animate each row's real step."""
    data = _progress_read()
    return data.get(os.path.realpath(repo), {}) if repo else data


# The sweep UI polls one route per direction; both read the same file.
pull_progress = sync_progress


def _git(repo, *args, timeout=20):
    """Run `git -C repo <args>`. Returns (ok, stdout, stderr) — never raises, never prompts."""
    try:
        r = subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True,
                           timeout=timeout, env=_GIT_ENV)
        return r.returncode == 0, r.stdout, r.stderr
    except subprocess.TimeoutExpired:
        return False, "", "git %s timed out after %ss" % (args[0] if args else "", timeout)
    except Exception as e:
        return False, "", str(e)


def _git_input(repo, args, value, timeout=20):
    """Run Git with a patch on stdin. Kept separate so ordinary reads stay allocation-free."""
    try:
        r = subprocess.run(["git", "-C", repo, *args], input=value, capture_output=True,
                           text=True, timeout=timeout, env=_GIT_ENV)
        return r.returncode == 0, r.stdout, r.stderr
    except subprocess.TimeoutExpired:
        return False, "", "git %s timed out after %ss" % (args[0] if args else "", timeout)
    except Exception as e:
        return False, "", str(e)


def _is_repo(path):
    ok, out, _ = _git(path, "rev-parse", "--is-inside-work-tree")
    return ok and out.strip() == "true"


def _repo_toplevel(path):
    ok, out, _ = _git(path, "rev-parse", "--show-toplevel")
    return os.path.realpath(out.strip()) if ok and out.strip() else None


def _ahead_behind(repo):
    ok, out, _ = _git(repo, "rev-list", "--left-right", "--count", "@{upstream}...HEAD")
    if ok and out.strip():
        try:
            behind, ahead = out.split()
            return int(ahead), int(behind)
        except Exception:
            pass
    return 0, 0


def _current_branch(repo):
    ok, out, _ = _git(repo, "rev-parse", "--abbrev-ref", "HEAD")
    b = out.strip() if ok else ""
    return ("" if b == "HEAD" else b)  # detached


def _git_path(repo, name):
    """Resolve one of Git's state markers (MERGE_HEAD, rebase-merge, …)."""
    ok, out, _ = _git(repo, "rev-parse", "--git-path", name)
    if not ok or not out.strip():
        return ""
    path = out.strip()
    return path if os.path.isabs(path) else os.path.join(repo, path)


def _operation_state(repo):
    """The interrupted operation the human can sensibly continue or abort, if any."""
    markers = [
        ("rebase", ("rebase-merge", "rebase-apply")),
        ("merge", ("MERGE_HEAD",)),
        ("cherry-pick", ("CHERRY_PICK_HEAD",)),
        ("revert", ("REVERT_HEAD",)),
    ]
    for kind, names in markers:
        if any(os.path.exists(_git_path(repo, name)) for name in names):
            return kind
    return ""


def _stash_state(repo):
    ok, out, _ = _git(repo, "stash", "list", "--format=%gd%x1f%s", timeout=10)
    if not ok or not out.strip():
        return 0, ""
    rows = out.splitlines()
    first = rows[0].split("\x1f", 1)
    return len(rows), (first[1] if len(first) > 1 else first[0])


def repo_summary(root, enclosing=False):
    branch = _current_branch(root) or "(detached)"
    ok, out, _ = _git(root, "status", "--porcelain")
    dirty = bool(ok and out.strip())
    ahead, behind = _ahead_behind(root)
    return {"root": root, "name": os.path.basename(root.rstrip("/")) or root,
            "branch": branch, "dirty": dirty, "ahead": ahead, "behind": behind,
            "enclosing": enclosing}


def detect_repos(project, max_depth=4):
    """Smart detection: the enclosing repo (root may live ABOVE the project) plus any nested
    repos inside the project, deduped. Handles 0, 1, or many gits per project folder."""
    project = os.path.realpath(os.path.expanduser(project or ""))
    if not os.path.isdir(project):
        return []
    found, seen = [], set()
    def add(root, enclosing=False):
        root = os.path.realpath(root)
        if root in seen:
            return
        seen.add(root)
        found.append(repo_summary(root, enclosing))
    # enclosing (or at-root) repo
    top = _repo_toplevel(project)
    if top:
        add(top, enclosing=not (os.path.realpath(top) == project))
    # nested repos: bounded walk for `.git` markers
    base_depth = project.rstrip("/").count("/")
    for dirpath, dirnames, _files in os.walk(project):
        depth = dirpath.rstrip("/").count("/") - base_depth
        if depth >= max_depth:
            dirnames[:] = []
            continue
        if ".git" in dirnames or os.path.exists(os.path.join(dirpath, ".git")):
            tl = _repo_toplevel(dirpath)
            if tl:
                add(tl, enclosing=False)
        dirnames[:] = [d for d in dirnames if d not in GIT_PRUNE]
    # sort: at-root / inside-project first, enclosing last, then by name
    found.sort(key=lambda r: (r["enclosing"], r["name"].lower()))
    return found


def _tracked_projects():
    """Panel's project list, read straight off config.json — a data file, not a panellib
    import. Best-effort: an unreadable/missing config just means nothing to fan out over."""
    try:
        with open(_PANEL_CONFIG) as f:
            data = json.load(f)
        return [p for p in (data.get("projects") or []) if isinstance(p, dict) and p.get("path")]
    except Exception:
        return []


def pullable_repos(fetch=False):
    """Every Panel-tracked project that is a git repo carrying at least one remote — the set a
    bulk 'pull all' fans out over. Each carries branch/remote/behind so the UI can animate per
    repo. Detached heads are skipped (nothing sensible to pull into). Read-only: never pulls.
    fetch=True refreshes each repo's remote-tracking refs first so `behind` is LIVE — that's what
    the dashboard opens with, so 'has something to pull' reflects the real remote, not a stale
    last-fetched count. Fetch failures (auth/offline) are swallowed: the repo still lists with
    whatever behind count it last knew."""
    projects = []
    seen = set()
    for project in _tracked_projects():
        path = os.path.realpath(os.path.expanduser(project["path"]))
        if path not in seen:
            seen.add(path)
            projects.append((project, path))

    def inspect(item):
        p, path = item
        if not os.path.isdir(path) or not _is_repo(path):
            return None
        okr, remotes_out, _ = _git(path, "remote")
        remotes = [r for r in remotes_out.split() if r] if okr else []
        if not remotes:
            return None
        branch = _current_branch(path)
        if not branch:
            return None
        oku, ups, _ = _git(path, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")
        upstream = ups.strip() if oku else ""
        remote = (upstream.split("/", 1)[0] if upstream
                  else ("origin" if "origin" in remotes else remotes[0]))
        if fetch:
            _git(path, "fetch", remote, branch, timeout=60)   # refresh @{upstream} -> live `behind`
        return {"path": path, "name": p.get("name") or os.path.basename(path.rstrip("/")),
                "branch": branch, "remote": remote,
                "behind": _ahead_behind(path)[1], "hasUpstream": bool(upstream)}

    with concurrent.futures.ThreadPoolExecutor(max_workers=min(6, len(projects) or 1)) as pool:
        return [result for result in pool.map(inspect, projects) if result is not None]


def _dirty_count(repo):
    """Uncommitted paths (staged + unstaged + untracked). Cheap enough to run per repo."""
    ok, out, _ = _git(repo, "status", "--porcelain=v1", "-z", "--untracked-files=all")
    if not ok:
        return 0
    return len([r for r in out.split("\0") if len(r) >= 4])


def pushable_repos(fetch=False):
    """The mirror of `pullable_repos` for the other direction: every Panel-tracked repo with a
    remote and a checked-out branch, carrying its unsent commit count and how much uncommitted
    work would be LEFT BEHIND by a push. A branch that was never pushed has no @{upstream}, so
    `ahead` is measured against the remote's copy of the branch when it knows it and reported as
    -1 (unknown, first push) when it does not. Read-only: never pushes. It also carries `behind`,
    so with fetch=True it is the scan for the two-way 'sync all' sweep."""
    projects = []
    seen = set()
    for project in _tracked_projects():
        path = os.path.realpath(os.path.expanduser(project["path"]))
        if path not in seen:
            seen.add(path)
            projects.append((project, path))

    def inspect(item):
        p, path = item
        if not os.path.isdir(path) or not _is_repo(path):
            return None
        okr, remotes_out, _ = _git(path, "remote")
        remotes = [r for r in remotes_out.split() if r] if okr else []
        if not remotes:
            return None
        branch = _current_branch(path)
        if not branch:
            return None
        oku, ups, _ = _git(path, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")
        upstream = ups.strip() if oku else ""
        remote = (upstream.split("/", 1)[0] if upstream
                  else ("origin" if "origin" in remotes else remotes[0]))
        if fetch:
            _git(path, "fetch", remote, branch, timeout=60)
        ahead, behind = _ahead_behind(path)
        if not upstream:
            okc, cnt, _ = _git(path, "rev-list", "--count", "HEAD",
                               "^%s/%s" % (remote, branch))
            ahead = int(cnt.strip()) if okc and cnt.strip().isdigit() else -1
        return {"path": path, "name": p.get("name") or os.path.basename(path.rstrip("/")),
                "branch": branch, "remote": remote, "ahead": ahead, "behind": behind,
                "dirty": _dirty_count(path), "hasUpstream": bool(upstream)}

    with concurrent.futures.ThreadPoolExecutor(max_workers=min(6, len(projects) or 1)) as pool:
        return [result for result in pool.map(inspect, projects) if result is not None]


def git_status(repo):
    if not _is_repo(repo):
        return {"error": "not a git repo"}
    branch = _current_branch(repo)
    ahead, behind = _ahead_behind(repo)
    staged, unstaged, untracked, conflicts = [], [], [], []
    # NUL mode leaves spaces, quotes and non-ASCII paths untouched. It also emits a rename's
    # destination first and its old name as the following record, which we skip after retaining
    # it as useful context for the UI.
    ok, out, _ = _git(repo, "status", "--porcelain=v1", "-z", "--untracked-files=all")
    if ok:
        records = out.split("\0")
        i = 0
        unmerged = {"DD", "AU", "UD", "UA", "DU", "AA", "UU"}
        while i < len(records):
            line = records[i]
            i += 1
            if len(line) < 4:
                continue
            x, y, path = line[0], line[1], line[3:]
            old_path = ""
            if (x in ("R", "C") or y in ("R", "C")) and i < len(records):
                old_path = records[i]
                i += 1
            if x == "?" and y == "?":
                untracked.append(path)
                continue
            if x + y in unmerged:
                conflicts.append({"path": path, "code": x + y})
                continue
            if x != " " and x != "?":
                entry = {"path": path, "code": x}
                if old_path:
                    entry["oldPath"] = old_path
                staged.append(entry)
            if y != " " and y != "?":
                entry = {"path": path, "code": y}
                if old_path:
                    entry["oldPath"] = old_path
                unstaged.append(entry)
    branches = []
    okb, outb, _ = _git(repo, "for-each-ref",
                        "--format=%(refname:short)%09%(upstream:short)%09"
                        "%(committerdate:unix)%09%(committerdate:relative)",
                        "refs/heads")
    if okb:
        now = time.time()
        for line in outb.splitlines():
            parts = line.split("\t")
            name = parts[0]
            ts = int(parts[2]) if len(parts) > 2 and parts[2].strip().isdigit() else 0
            age_days = (now - ts) / 86400 if ts else 0
            branches.append({"name": name, "current": name == branch,
                             "upstream": parts[1] if len(parts) > 1 else "",
                             "age": parts[3] if len(parts) > 3 else "",
                             "old": age_days > OLD_BRANCH_DAYS})
    remotes = []
    okr, outr, _ = _git(repo, "remote", "-v")
    if okr:
        seen = {}
        for line in outr.splitlines():
            m = re.match(r"(\S+)\s+(\S+)\s+\((\w+)\)", line)
            if m and m.group(3) == "fetch":
                seen[m.group(1)] = m.group(2)
        remotes = [{"name": n, "url": u} for n, u in seen.items()]
    stash_count, latest_stash = _stash_state(repo)
    return {"branch": branch, "detached": not branch, "ahead": ahead, "behind": behind,
            "branches": branches, "remotes": remotes,
            "staged": staged, "unstaged": unstaged, "untracked": untracked,
            "conflicts": conflicts, "operation": _operation_state(repo),
            "stashCount": stash_count, "latestStash": latest_stash}


def git_graph(repo, limit=150):
    """Parse `git log --all` with parents+refs and assign lanes for a game-like commit tree.
    Lane assignment is a simple active-column algorithm walking newest->oldest."""
    if not _is_repo(repo):
        return {"error": "not a git repo"}
    sep = "\x1f"
    fmt = sep.join(["%H", "%P", "%D", "%s", "%an", "%cr"])
    ok, out, err = _git(repo, "log", "--all", "--date-order", "--parents",
                       "--pretty=" + fmt, "-n", str(int(limit)))
    if not ok:
        return {"error": err.strip() or "git log failed"}
    head_ok, head_out, _ = _git(repo, "rev-parse", "HEAD")
    head = head_out.strip() if head_ok else ""
    commits = []
    for line in out.splitlines():
        f = line.split(sep)
        if len(f) < 6:
            continue
        sha, parents_raw, refs_raw, subject, author, age = f[0], f[1], f[2], f[3], f[4], f[5]
        parents = parents_raw.split() if parents_raw.strip() else []
        refs = []
        for r in (refs_raw.split(", ") if refs_raw.strip() else []):
            r = r.strip()
            if not r:
                continue
            if r.startswith("HEAD -> "):
                refs.append({"name": r[len("HEAD -> "):], "type": "head"})
            elif r == "HEAD":
                refs.append({"name": "HEAD", "type": "head"})
            elif r.startswith("tag: "):
                refs.append({"name": r[len("tag: "):], "type": "tag"})
            elif r.startswith("origin/") or "/" in r:
                refs.append({"name": r, "type": "remote"})
            else:
                refs.append({"name": r, "type": "branch"})
        commits.append({"sha": sha, "short": sha[:7], "parents": parents, "refs": refs,
                        "subject": subject, "author": author, "age": age})
    # lane assignment
    lanes = []  # each entry = sha this lane is currently "waiting for", or None
    def lane_for(sha):
        for i, w in enumerate(lanes):
            if w == sha:
                return i
        for i, w in enumerate(lanes):
            if w is None:
                lanes[i] = sha
                return i
        lanes.append(sha)
        return len(lanes) - 1
    for c in commits:
        col = lane_for(c["sha"])
        c["lane"] = col
        c["color"] = LANE_COLORS[col % len(LANE_COLORS)]
        # this lane now waits for the first parent; extra parents claim free lanes
        if c["parents"]:
            lanes[col] = c["parents"][0]
            for p in c["parents"][1:]:
                if p not in lanes:
                    lane_for(p)
        else:
            lanes[col] = None
    _tag_keywords(commits)
    return {"commits": commits, "head": head,
            "lanes": (max((c["lane"] for c in commits), default=0) + 1)}


def _tag_keywords(commits):
    """Hang a 'keywords' hint on each commit — the rarest word(s) in its subject, measured against
    every other subject in this window. Pure local TF-IDF, no model call: words that show up in lots
    of commits ('battle', 'add', 'screen') carry no signal and score low; a word unique to one commit
    ('voronoi', 'kamikaze', 'rebellion') is what actually tells that commit apart, so it floats up.
    Gives the reader a slight idea of what a commit did without reading the whole message."""
    df, per = {}, []
    for c in commits:
        best = {}  # lowercased word -> its first original-cased spelling in the subject
        for tok in _WORD_RE.findall(c.get("subject") or ""):
            disp = tok.strip("-_+.")
            w = disp.lower()
            if len(w) < 4 or w.isdigit() or w in _WORD_STOP:
                continue
            best.setdefault(w, disp)
        per.append(best)
        for w in best:
            df[w] = df.get(w, 0) + 1
    for c, best in zip(commits, per):
        ranked = sorted(best.items(), key=lambda kv: (df[kv[0]], -len(kv[0])))  # rarest, then longest
        kws = [disp for _w, disp in ranked[:1]]
        if len(ranked) > 1 and df[ranked[1][0]] <= 2:  # a 2nd tag only if it's genuinely rare too
            kws.append(ranked[1][1])
        c["keywords"] = kws


# words that carry no signal about WHAT was built — conventional-commit types, git verbs, English glue
_WORD_STOP = set("""
the a an and or but nor for of to in on at by with from into onto up down over under off out
this that these those it its is are was were be been being as if then than so too very
via use uses using used get gets got set sets new now all also just not no yes can will would
make makes making made add adds adding added remove removes removing removed update updates updating updated
fix fixes fixing fixed feat feature features chore chores refactor refactors refactoring docs doc document
style styles test tests testing perf build builds ci cd revert reverts wip merge merges merged merging
bump bumps bumped rename renames renamed move moves moved tweak tweaks tweaked cleanup clean misc minor
major initial commit commits change changes changed some more less first support handle handles handling
improve improves improved better fixup wip main master branch pull request pr version release releases
replace replaces replaced unify unifies unified reflect skip skips allow allows ensure ensures enable
enables disable disables apply applies applied avoid avoids reduce reduces prevent prevents keep keeps
show shows hide hides unused split splits switch switches convert converts introduce introduces
""".split())
_WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9_+.-]{2,}")


def _parse_refs(refs_raw):
    """Shared decoration parser: `%D` output -> [{name,type}] (head/branch/remote/tag)."""
    refs = []
    for r in (refs_raw.split(", ") if (refs_raw or "").strip() else []):
        r = r.strip()
        if not r:
            continue
        if r.startswith("HEAD -> "):
            refs.append({"name": r[len("HEAD -> "):], "type": "head"})
        elif r == "HEAD":
            refs.append({"name": "HEAD", "type": "head"})
        elif r.startswith("tag: "):
            refs.append({"name": r[len("tag: "):], "type": "tag"})
        elif r.startswith("origin/") or "/" in r:
            refs.append({"name": r, "type": "remote"})
        else:
            refs.append({"name": r, "type": "branch"})
    return refs


def commit_detail(repo, sha):
    """Everything the expanding commit card needs: full body, author/email/date, ref pills,
    and per-file numstat (adds/dels) so the card can show a tappable diffstat."""
    if not _is_repo(repo):
        return {"error": "not a git repo"}
    sha = (sha or "").strip()
    if not sha:
        return {"error": "sha required"}
    sep = "\x1f"
    fmt = sep.join(["%H", "%h", "%P", "%D", "%an", "%ae", "%ad", "%cr", "%s", "%b"])
    ok, out, err = _git(repo, "show", "-s", "--date=format:%Y-%m-%d %H:%M", "--pretty=" + fmt, sha)
    if not ok:
        return {"error": err.strip() or "no such commit"}
    f = out.split(sep)
    if len(f) < 10:
        return {"error": "could not parse commit"}
    files, adds, dels = [], 0, 0
    ok2, ns, _ = _git(repo, "show", "--numstat", "--format=", "-M", sha, timeout=30)
    if ok2:
        for line in ns.splitlines():
            p = line.split("\t")
            if len(p) >= 3 and p[2].strip():
                a = None if p[0] == "-" else int(p[0])
                d = None if p[1] == "-" else int(p[1])
                adds += a or 0
                dels += d or 0
                files.append({"path": p[2], "adds": a, "dels": d})
    return {"sha": f[0], "short": f[1], "parents": f[2].split() if f[2].strip() else [],
            "refs": _parse_refs(f[3]), "author": f[4], "email": f[5], "date": f[6], "age": f[7],
            "subject": f[8], "body": (f[9] or "").strip(), "files": files,
            "adds": adds, "dels": dels}


def compare_refs(repo, a, b):
    """The 'Duel View' payload: for two refs A and B, the commits unique to each side, their
    common merge-base, and the combined diffstat. Answers 'what's actually different?' in one shot."""
    if not _is_repo(repo):
        return {"error": "not a git repo"}
    a, b = (a or "").strip(), (b or "").strip()
    if not a or not b:
        return {"error": "two refs required"}
    okb, base, _ = _git(repo, "merge-base", a, b)
    base = base.strip() if okb else ""

    def _side(range_):
        ok, out, _ = _git(repo, "log", "--pretty=%h\x1f%s\x1f%an\x1f%cr", "-n", "80", range_)
        rows = []
        if ok:
            for line in out.splitlines():
                p = line.split("\x1f")
                if len(p) >= 4:
                    rows.append({"short": p[0], "subject": p[1], "author": p[2], "age": p[3]})
        return rows

    only_a = _side(b + ".." + a)
    only_b = _side(a + ".." + b)
    oks, stat, _ = _git(repo, "diff", "--shortstat", a + "..." + b)
    return {"a": a, "b": b, "base": base[:7], "onlyA": only_a, "onlyB": only_b,
            "stat": (stat.strip() if oks else "")}


# ---------------- AI verb bar: plain words -> previewed git, run, then reflog-backed undo -------
_VERB_BLOCK = re.compile(r"[;&|`$><]|\.\.[\\/]|\$\(")  # shell-injection / traversal guard


def verb_plan(repo, text):
    """Translate a natural-language request into a previewable git plan. The agent NEVER runs
    anything here — it returns JSON steps we show as a ghost, then run ourselves on Run."""
    if not _is_repo(repo):
        return {"error": "not a git repo"}
    text = (text or "").strip()
    if not text:
        return {"error": "say what you want to do"}
    st = git_status(repo)
    ctx = "branch=%s ahead=%s behind=%s staged=%d modified=%d untracked=%d" % (
        st.get("branch"), st.get("ahead"), st.get("behind"),
        len(st.get("staged", [])), len(st.get("unstaged", [])), len(st.get("untracked", [])))
    prompt = (
        "You are a git command planner. Do NOT run anything — only plan.\n"
        "Repo state: " + ctx + "\n"
        "User request: " + text + "\n\n"
        "Reply with STRICT JSON only, no prose, this exact shape:\n"
        '{"summary": "<one plain sentence of what will happen>",'
        ' "steps": [{"cmd": "<a single git subcommand WITHOUT the leading word git>"}],'
        ' "danger": <true if it rewrites history or can lose work, else false>,'
        ' "question": "<only if the request is ambiguous, else empty>"}\n'
        "Rules: prefer the safest command; one step per array entry; no shell operators "
        "(; | & ` $ > <); if you cannot do it safely, return steps: [] and explain in summary.")
    res = _run_agent(prompt, repo, timeout=90)
    if not res.get("ok"):
        return {"error": res.get("error") or "planner unavailable"}
    try:
        plan = json.loads(_strip_fence(res["text"]))
    except Exception:
        return {"error": "planner returned unparseable output", "raw": res["text"][:400]}
    steps = []
    for s in (plan.get("steps") or []):
        cmd = (s.get("cmd") or "").strip()
        if cmd.startswith("git "):
            cmd = cmd[4:].strip()
        if not cmd or _VERB_BLOCK.search(cmd):
            continue
        steps.append({"cmd": cmd})
    return {"summary": plan.get("summary") or "", "steps": steps,
            "danger": bool(plan.get("danger")), "question": plan.get("question") or "",
            "provider": res.get("provider")}


def verb_run(repo, steps):
    """Run a plan the human approved. Snapshots HEAD first so the receipt can offer a real undo."""
    if not _is_repo(repo):
        return {"error": "not a git repo"}
    steps = steps or []
    if not steps:
        return {"error": "nothing to run"}
    okp, prev, _ = _git(repo, "rev-parse", "HEAD")
    prev = prev.strip() if okp else ""
    ran = []
    for s in steps:
        cmd = (s.get("cmd") or "").strip()
        if not cmd or _VERB_BLOCK.search(cmd):
            return {"error": "refused unsafe step: " + cmd, "ran": ran, "undo": prev}
        try:
            parts = shlex.split(cmd)
        except Exception:
            return {"error": "could not parse step: " + cmd, "ran": ran, "undo": prev}
        if not parts or parts[0] != "git":
            parts = ["git"] + parts  # steps are bare subcommands; only ever run git
        ok, out, err = _git(repo, *parts[1:], timeout=120)
        ran.append({"cmd": cmd, "ok": ok, "out": (out or err).strip()[:500]})
        if not ok:
            st = git_status(repo)
            st["ok"] = False
            st["ran"] = ran
            st["undo"] = prev
            st["error"] = (err or out or "step failed").strip()
            return st
    st = git_status(repo)
    st["ok"] = True
    st["ran"] = ran
    st["undo"] = prev  # rev-parse HEAD before the plan ran; undo = reset --hard back to it
    return st


def undo_to(repo, sha):
    """Hard-reset back to a snapshot the verb bar handed out. Reversible via reflog."""
    sha = (sha or "").strip()
    if not sha:
        return {"error": "nothing to undo to"}
    return _git_then_status(repo, "reset", "--hard", sha)


def git_diff(repo, path="", staged=False, sha="", untracked=False):
    if not _is_repo(repo):
        return {"error": "not a git repo"}
    if sha:
        args = ["show", "--patch", "-M", sha] if path else ["show", "--stat", "--patch", sha]
        if path:
            args += ["--", path]
        ok, out, err = _git(repo, *args, timeout=30)
    elif untracked and path:
        # `--no-index` returns 1 when it successfully found differences. `_git` therefore says
        # false, but stdout is still the patch we want. Restrict the path to the repo before
        # invoking it so this endpoint never becomes an arbitrary-file reader.
        full = os.path.realpath(os.path.join(repo, path))
        root = os.path.realpath(repo) + os.sep
        if not full.startswith(root) or not os.path.isfile(full):
            return {"error": "untracked file is unavailable"}
        ok, out, err = _git(repo, "diff", "--no-index", "--", "/dev/null", full, timeout=30)
        if out:
            return {"patch": out[:200000]}
    else:
        args = ["diff"] + (["--cached"] if staged else [])
        if path:
            args += ["--", path]
        ok, out, err = _git(repo, *args, timeout=30)
    if not ok:
        return {"error": err.strip() or "git diff failed"}
    return {"patch": out[:200000]}


_HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


def stage_hunk(repo, path, line):
    """Stage the unified-diff hunk containing one current-file line."""
    full = os.path.realpath(os.path.join(repo, path or ""))
    worktree = _repo_toplevel(os.path.dirname(full))
    if not worktree or not (full == worktree or full.startswith(worktree + os.sep)):
        return {"error": "file is outside a Git working tree"}
    relative = os.path.relpath(full, worktree).replace(os.sep, "/")
    ok, patch, err = _git(worktree, "diff", "--no-ext-diff", "--no-color", "--unified=3",
                          "--", relative, timeout=30)
    if not ok:
        return {"error": (err or "could not read the hunk").strip()}
    if not patch:
        oku, untracked, _ = _git(worktree, "ls-files", "--others", "--exclude-standard", "--", relative)
        if oku and untracked.strip():
            return _git_then_status(worktree, "add", "--", relative)
        # HEAD-based gutter bars remain after staging. A second click is a harmless receipt.
        okc, cached, _ = _git(worktree, "diff", "--cached", "--", relative)
        if okc and cached:
            state = git_status(worktree)
            state["ok"] = True
            state["alreadyStaged"] = True
            return state
        return {"error": "this hunk no longer differs from Git"}

    lines = patch.splitlines(keepends=True)
    starts = [index for index, text in enumerate(lines) if text.startswith("@@ ")]
    if not starts:
        return {"error": "Git did not return a text hunk"}
    header = lines[:starts[0]]
    wanted = max(1, int(line or 1))
    choices = []
    for number, start in enumerate(starts):
        end = starts[number + 1] if number + 1 < len(starts) else len(lines)
        match = _HUNK.match(lines[start])
        if not match:
            continue
        new_start = int(match.group(3))
        new_count = int(match.group(4) or "1")
        new_end = new_start + max(1, new_count) - 1
        distance = 0 if new_start <= wanted <= new_end else min(abs(wanted - new_start), abs(wanted - new_end))
        choices.append((distance, start, end))
    if not choices:
        return {"error": "Git could not locate that hunk"}
    _distance, start, end = min(choices, key=lambda choice: choice[0])
    selected = "".join(header + lines[start:end])
    oka, out, apply_err = _git_input(
        worktree,
        ["apply", "--cached", "--whitespace=nowarn", "-"],
        selected,
        timeout=30,
    )
    if not oka:
        return {"error": (apply_err or out or "could not stage the hunk").strip()}
    state = git_status(worktree)
    state["ok"] = True
    return state


def stash_push(repo, message=""):
    message = (message or "").strip() or "Panel quick stash"
    return _git_then_status(repo, "stash", "push", "--include-untracked", "-m", message)


def stash_pop(repo):
    return _git_then_status(repo, "stash", "pop", timeout=90)


def undo_last_commit(repo):
    """Remove HEAD while keeping every change staged — safe working-tree recovery, not reset hard."""
    return _git_then_status(repo, "reset", "--soft", "HEAD^")


def finish_operation(repo, abort=False):
    operation = _operation_state(repo)
    if not operation:
        return {"error": "no merge, rebase, cherry-pick or revert is in progress"}
    if abort:
        return _git_then_status(repo, operation, "--abort")
    if operation == "merge":
        return _git_then_status(repo, "commit", "--no-edit")
    if operation == "rebase":
        ok, out, err = _git(repo, "-c", "core.editor=true", "rebase", "--continue", timeout=90)
        if not ok:
            return {"error": (err or out or "rebase --continue failed").strip()}
        st = git_status(repo)
        st["ok"] = True
        return st
    return _git_then_status(repo, operation, "--continue", timeout=90)


# the small mutating ops share one shape: run git, then hand back fresh status
def _git_then_status(repo, *args, timeout=60):
    ok, out, err = _git(repo, *args, timeout=timeout)
    if not ok:
        return {"error": (err or out or "git command failed").strip()}
    st = git_status(repo)
    st["ok"] = True
    return st


def delete_branch(repo, name, force=False):
    name = (name or "").strip()
    if not name:
        return {"error": "branch name required"}
    if name == _current_branch(repo):
        return {"error": "can't delete the current branch — checkout something else first"}
    ok, out, err = _git(repo, "branch", "-D" if force else "-d", name)
    if not ok:
        msg = (err or out or "delete failed").strip()
        return {"error": msg, "unmerged": (not force and "not fully merged" in msg)}
    st = git_status(repo)
    st["ok"] = True
    st["deleted"] = name
    return st


def delete_branches(repo, names, force=False):
    cur = _current_branch(repo)
    results = []
    for name in names or []:
        name = (name or "").strip()
        if not name:
            continue
        if name == cur:
            results.append({"name": name, "ok": False, "error": "current branch — skipped"})
            continue
        ok, out, err = _git(repo, "branch", "-D" if force else "-d", name)
        msg = "" if ok else (err or out or "delete failed").strip()
        results.append({"name": name, "ok": ok, "error": msg,
                        "unmerged": (not force and "not fully merged" in msg)})
    st = git_status(repo)
    st["ok"] = True
    st["results"] = results
    return st


# ---------------- smart pull (rebase, conflicts hand back to the human) ----------------
# A pull conflict is never auto-resolved here — smart_pull() just reports it and leaves the
# rebase in progress so the caller can offer the human a choice per repo: resolve_pull_conflict()
# (AI) or abort_pull_conflict() ("I'll deal with it" walks away clean).

def _strip_fence(text):
    """Drop a leading/trailing ``` fence the agent may have wrapped output in."""
    t = (text or "").strip()
    if t.startswith("```"):
        lines = t.split("\n")[1:]              # drop the opening ```lang line
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        t = "\n".join(lines)
    return t


def _run_agent(prompt, cwd, timeout=120):
    """Run whichever agent CLI is on PATH (claude first, then codex) headless, text in/out. We
    never let it touch the repo directly — it just returns text we validate and write ourselves.
    No Panel config read here: PATH discovery only, so this stays a pure git-tool ability."""
    providers = [("claude", ["claude", "-p", prompt, "--output-format", "text"]),
                 ("codex", ["codex", "exec", "--ephemeral", "--sandbox", "read-only",
                            "--skip-git-repo-check", prompt])]
    errors = []
    for name, args in providers:
        if not shutil.which(args[0]):
            continue
        try:
            r = subprocess.run(args, capture_output=True, text=True, timeout=timeout, cwd=cwd)
            out = (r.stdout or "").strip()
            if r.returncode == 0 and out:
                return {"ok": True, "text": out, "provider": name}
            errors.append("%s: %s" % (name, (r.stderr or "no output").strip()))
        except Exception as e:
            errors.append("%s: %s" % (name, e))
    return {"ok": False, "error": "; ".join(errors) or "no supported agent CLI found (claude/codex)"}


def _conflicted_files(repo):
    ok, out, _ = _git(repo, "diff", "--name-only", "--diff-filter=U")
    return [f for f in out.splitlines() if f.strip()] if ok else []


def _rebase_in_progress(repo):
    for name in ("rebase-merge", "rebase-apply"):
        ok, p, _ = _git(repo, "rev-parse", "--git-path", name)
        if ok and p.strip():
            path = p.strip()
            if not os.path.isabs(path):
                path = os.path.join(repo, path)
            if os.path.exists(path):
                return True
    return False


def _ai_resolve_file(repo, path):
    """Ask the agent to resolve one conflicted file's markers. We validate + write it ourselves."""
    full = os.path.join(repo, path)
    try:
        with open(full, "r", errors="replace") as fh:
            content = fh.read()
    except Exception as e:
        return {"ok": False, "error": "read %s: %s" % (path, e)}
    if "<<<<<<<" not in content:
        return {"ok": True}   # no textual conflict (e.g. resolved already / binary handled elsewhere)
    prompt = ("You are resolving a git rebase conflict in ONE file. Below is the full file "
              "content WITH conflict markers (<<<<<<<, =======, >>>>>>>). Resolve EVERY conflict "
              "by correctly combining both sides' intent; keep all non-conflicting code intact. "
              "Output ONLY the fully resolved file content — no markers, no code fences, no "
              "commentary.\n\n--- FILE: %s ---\n%s" % (path, content[:60000]))
    r = _run_agent(prompt, repo, timeout=180)
    if not r.get("ok"):
        return {"ok": False, "error": r["error"]}
    resolved = _strip_fence(r["text"])
    if not resolved.strip():
        return {"ok": False, "error": "agent returned empty content for %s" % path}
    if any(l.startswith("<<<<<<<") or l.startswith(">>>>>>>") or l.startswith("=======")
           for l in resolved.splitlines()):
        return {"ok": False, "error": "agent left conflict markers in %s" % path}
    try:
        with open(full, "w") as fh:
            fh.write(resolved if resolved.endswith("\n") else resolved + "\n")
    except Exception as e:
        return {"ok": False, "error": "write %s: %s" % (path, e)}
    return {"ok": True}


def _ai_resolve_rebase(repo, max_rounds=10):
    """Loop: resolve every conflicted file with the agent, `git add`, `rebase --continue`,
    until the rebase finishes or we can't. core.editor=true keeps the existing commit message."""
    resolved = set()
    for _ in range(max_rounds):
        conflicts = _conflicted_files(repo)
        if not conflicts:
            break
        for f in conflicts:
            res = _ai_resolve_file(repo, f)
            if not res.get("ok"):
                return {"ok": False, "error": res["error"], "conflicts": conflicts}
            _git(repo, "add", "--", f)
            resolved.add(f)
        cok, cout, cerr = _git(repo, "-c", "core.editor=true", "rebase", "--continue", timeout=60)
        if not _rebase_in_progress(repo):
            return {"ok": True, "files": sorted(resolved)}
        if not cok and not _conflicted_files(repo):
            # --continue failed for a reason that isn't a fresh conflict — bail out
            return {"ok": False, "error": (cerr or cout or "rebase --continue failed").strip()}
    if _rebase_in_progress(repo):
        return {"ok": False, "error": "still conflicted after %d rounds" % max_rounds,
                "conflicts": _conflicted_files(repo)}
    return {"ok": True, "files": sorted(resolved)}


def smart_pull(repo, remote="", branch=""):
    """`git pull --rebase --autostash`. Clean or fast-forward: done. Conflicted: the rebase is
    left in progress (nothing auto-resolved) and the conflicted files are reported so the caller
    can decide — hand it to the agent or leave it for the human."""
    if not _is_repo(repo):
        return {"error": "not a git repo"}
    branch = (branch or "").strip() or _current_branch(repo)
    if not branch:
        return {"error": "detached HEAD — checkout a branch first"}
    remote = (remote or "").strip()
    if not remote:
        okr, remotes_out, _ = _git(repo, "remote")
        remotes = [r for r in remotes_out.split() if r] if okr else []
        oku, ups, _ = _git(repo, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")
        upstream = ups.strip() if oku else ""
        remote = (upstream.split("/", 1)[0] if upstream
                  else ("origin" if "origin" in remotes else (remotes[0] if remotes else "origin")))

    # Split the `pull --rebase` into its two real phases (fetch, then rebase) so the UI can show
    # 'fetching' then 'rebasing' as distinct steps rather than one opaque 'pulling'. `git fetch`
    # sets FETCH_HEAD to the remote branch tip; `rebase --autostash FETCH_HEAD` == `pull --rebase`.
    _progress_set(repo, "fetching")
    fok, fout, ferr = _git(repo, "fetch", remote, branch, timeout=90)
    if not fok:
        msg = (ferr or fout or "fetch failed").strip()
        _progress_set(repo, "failed", msg)
        return {"error": msg}
    _progress_set(repo, "rebasing")
    ok, out, err = _git(repo, "rebase", "--autostash", "FETCH_HEAD", timeout=90)
    if ok:
        _progress_set(repo, "done")
        return {"ok": True, "pulled": True, "message": "pulled %s from %s" % (branch, remote)}
    msg = (err or out or "").strip()
    if not _rebase_in_progress(repo):
        _progress_set(repo, "failed", msg)
        return {"error": msg or "pull failed"}
    _progress_set(repo, "conflict")
    return {"ok": False, "conflict": True, "conflicts": _conflicted_files(repo),
            "error": msg or "pull hit conflicts"}


def smart_push(repo, remote="", branch=""):
    """`git push` for one repo of a bulk sweep. Sets the upstream on a branch that has none, so
    a never-pushed branch works from the same button. Phases stream through the progress file
    (pushing → done/failed). A rejected push (the remote moved on) is reported as such rather
    than as a generic failure — the UI turns that into 'pull all first'."""
    if not _is_repo(repo):
        return {"error": "not a git repo"}
    branch = (branch or "").strip() or _current_branch(repo)
    if not branch:
        return {"error": "detached HEAD — checkout a branch first"}
    oku, ups, _ = _git(repo, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")
    upstream = ups.strip() if oku else ""
    remote = (remote or "").strip()
    if not remote:
        okr, remotes_out, _ = _git(repo, "remote")
        remotes = [r for r in remotes_out.split() if r] if okr else []
        remote = (upstream.split("/", 1)[0] if upstream
                  else ("origin" if "origin" in remotes else (remotes[0] if remotes else "origin")))

    _progress_set(repo, "pushing")
    args = ["push"] + ([] if upstream else ["-u"]) + [remote, branch]
    ok, out, err = _git(repo, *args, timeout=90)
    if not ok:
        msg = (err or out or "push failed").strip()
        _progress_set(repo, "failed", msg[:200])
        low = msg.lower()
        return {"error": msg,
                "rejected": "rejected" in low or "fetch first" in low or "non-fast-forward" in low}
    ahead, behind = _ahead_behind(repo)
    _progress_set(repo, "done")
    return {"ok": True, "pushed": True, "branch": branch, "remote": remote,
            "ahead": ahead, "behind": behind,
            "message": "pushed %s to %s" % (branch, remote)}


def resolve_all_conflicts(repos):
    """One shot: for every repo left mid-rebase by a conflicted pull, run the agent resolver and
    let its rebase finish. A repo the agent can't resolve is aborted back to its clean pre-pull
    state and reported as failed; the sweep keeps going. Returns per-repo results so the UI can
    settle each row. Phases stream through the same progress file (resolving → done/failed)."""
    results = []
    for raw in (repos or []):
        repo = (raw or "").strip()
        if not repo:
            continue
        if not _rebase_in_progress(repo):
            results.append({"repo": repo, "ok": False, "error": "no rebase in progress"})
            continue
        _progress_set(repo, "resolving")
        res = _ai_resolve_rebase(repo)
        if not res.get("ok"):
            _git(repo, "rebase", "--abort", timeout=30)
            _progress_set(repo, "failed", (res.get("error") or "resolve failed")[:200])
            results.append({"repo": repo, "ok": False, "error": res.get("error"),
                            "conflicts": res.get("conflicts")})
            continue
        files = res.get("files") or []
        _progress_set(repo, "done", "%d file%s" % (len(files), "" if len(files) == 1 else "s"))
        results.append({"repo": repo, "ok": True, "conflictsResolved": True, "files": files})
    return {"results": results}


def resolve_pull_conflict(repo):
    """Human chose 'solve with AI': resolve the in-progress rebase (from a conflicted pull) file
    by file and let it finish. Aborts back to the pre-pull state if the agent can't finish it."""
    if not _rebase_in_progress(repo):
        return {"error": "no rebase in progress for this repo"}
    resolved = _ai_resolve_rebase(repo)
    if not resolved.get("ok"):
        _git(repo, "rebase", "--abort", timeout=30)
        return {"error": "AI couldn't resolve the conflict (rebase aborted): " + resolved["error"],
                "conflicts": resolved.get("conflicts")}
    files = resolved.get("files") or []
    return {"ok": True, "pulled": True, "conflictsResolved": True, "files": files,
            "message": "AI resolved %d conflicted file%s during pull"
                       % (len(files), "" if len(files) == 1 else "s")}


def abort_pull_conflict(repo):
    """Human chose 'I'll deal with it': abort the in-progress rebase, restoring the clean
    pre-pull state so nothing is left half-merged. They can pull/rebase manually whenever."""
    if not _rebase_in_progress(repo):
        return {"error": "no rebase in progress for this repo"}
    ok, out, err = _git(repo, "rebase", "--abort", timeout=30)
    if not ok:
        return {"error": (err or out or "rebase --abort failed").strip()}
    return {"ok": True, "aborted": True, "message": "rebase aborted — back to pre-pull state"}
