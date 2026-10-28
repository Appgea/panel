#!/usr/bin/env python3
"""git-manager module host — CGI-argv protocol.

argv: <METHOD> <PATH[?query]>
stdin: request body (POST/PUT only)
stdout: "<status>\\n<content-type>\\n\\n<body>"

Panel builds argv as [execPath, method, path] + manifest args and spawns this one-shot per
request (panel.py: module_call). No long-lived process, no shared state between requests.
"""
import html
import json
import os
import sys
from urllib.parse import urlsplit, parse_qs

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))
import gitops  # noqa: E402


def _respond(status, body, ctype="application/json"):
    if isinstance(body, (dict, list)):
        payload = json.dumps(body).encode()
    elif isinstance(body, str):
        payload = body.encode()
    else:
        payload = body
    sys.stdout.buffer.write(("%d\n%s\n\n" % (status, ctype)).encode())
    sys.stdout.buffer.write(payload)


def _esc(s):
    return html.escape(str(s if s is not None else ""))


def _card(project_path):
    """Overview glance fragment for the project dashboard: branch, ahead/behind,
    uncommitted count, and the last three commits (HEAD). HTML only — the dashboard
    supplies the card shell and the 'open git' door."""
    repos = gitops.detect_repos(project_path or "")
    root = repos[0]["root"] if repos else (project_path or "")
    st = gitops.git_status(root)
    if st.get("error"):
        return _respond(200, '<div class="ov-empty">No git repository in this project.</div>',
                        "text/html; charset=utf-8")
    dirty = len(st.get("staged", [])) + len(st.get("unstaged", [])) + len(st.get("untracked", []))
    branch = st.get("branch") or ("detached" if st.get("detached") else "—")
    ahead, behind = st.get("ahead", 0), st.get("behind", 0)
    chips = ['<span class="ov-chip mono">&#9099; %s</span>' % _esc(branch)]
    if ahead:
        chips.append('<span class="ov-chip mono good">&#8593;%d</span>' % ahead)
    if behind:
        chips.append('<span class="ov-chip mono warn">&#8595;%d</span>' % behind)
    chips.append('<span class="ov-chip mono warn">&#9679; %d uncommitted</span>' % dirty
                 if dirty else '<span class="ov-chip mono good">&#10003; clean</span>')
    ok, out, _ = gitops._git(root, "log", "-3", "--pretty=format:%h\x1f%s\x1f%ar")
    rows = []
    if ok:
        for line in out.splitlines():
            p = line.split("\x1f")
            if len(p) >= 3:
                rows.append('<div class="ov-commit"><span class="sha mono">%s</span>'
                            '<span class="msg">%s</span><span class="ago mono">%s</span></div>'
                            % (_esc(p[0]), _esc(p[1]), _esc(p[2])))
    body = ('<div class="ov-chips">%s</div><div class="ov-commits">%s</div>'
            % ("".join(chips), "".join(rows) or '<div class="ov-empty">No commits yet.</div>'))
    return _respond(200, body, "text/html; charset=utf-8")


def main():
    if len(sys.argv) < 3:
        return _respond(400, {"error": "usage: host.py METHOD PATH"})
    method, raw_path = sys.argv[1], sys.argv[2]
    parsed = urlsplit(raw_path)
    path = parsed.path
    q = parse_qs(parsed.query)
    def qs(name, default=""):
        v = q.get(name)
        return v[0] if v else default

    if method == "GET":
        if path == "/card":
            return _card(qs("root") or qs("repo") or qs("path"))
        if path == "/repos":
            return _respond(200, {"repos": gitops.detect_repos(qs("path"))})
        if path == "/pullable":
            # fetch=1 (what the dashboard opens with) refreshes remotes first so `behind` is live.
            return _respond(200, {"pullable": gitops.pullable_repos(
                qs("fetch") in ("1", "true"))})
        if path == "/pushable":
            # The other direction of the same sweep: no fetch by default — `ahead` is local
            # knowledge, so the push list opens instantly.
            return _respond(200, {"pushable": gitops.pushable_repos(
                qs("fetch") in ("1", "true"))})
        if path == "/syncable":
            # 'Sync all' needs both directions at once, measured against a live remote.
            return _respond(200, {"syncable": gitops.pushable_repos(True)})
        if path in ("/pull/progress", "/push/progress", "/sync/progress"):
            return _respond(200, gitops.sync_progress(qs("repo")))
        if path == "/status":
            return _respond(200, gitops.git_status(qs("repo")))
        if path == "/graph":
            return _respond(200, gitops.git_graph(qs("repo"), int(qs("limit", "150"))))
        if path == "/commit":
            return _respond(200, gitops.commit_detail(qs("repo"), qs("sha")))
        if path == "/compare":
            return _respond(200, gitops.compare_refs(qs("repo"), qs("a"), qs("b")))
        if path == "/diff":
            return _respond(200, gitops.git_diff(qs("repo"), qs("path"),
                                                  qs("staged", "0") in ("1", "true"), qs("sha"),
                                                  qs("untracked", "0") in ("1", "true")))
        return _respond(404, {"error": "no such route: GET " + path})

    if method == "POST":
        raw = sys.stdin.buffer.read()
        try:
            d = json.loads(raw or b"{}")
        except Exception:
            d = {}
        repo = (d.get("repo") or "").strip()

        if path == "/stage-hunk":
            return _respond(200, gitops.stage_hunk(repo, d.get("path") or "", d.get("line") or 1))
        if path == "/stage":
            if d.get("all"):
                return _respond(200, gitops._git_then_status(repo, "add", "-A"))
            return _respond(200, gitops._git_then_status(repo, "add", "--", *(d.get("paths") or [])))
        if path == "/unstage":
            return _respond(200, gitops._git_then_status(repo, "restore", "--staged", "--",
                                                          *(d.get("paths") or [])))
        if path == "/discard":
            return _respond(200, gitops._git_then_status(repo, "checkout", "--",
                                                          *(d.get("paths") or [])))
        if path == "/commit":
            msg = (d.get("message") or "").strip()
            if not msg:
                return _respond(400, {"error": "empty commit message"})
            return _respond(200, gitops._git_then_status(repo, "commit", "-m", msg))
        if path == "/undo-last":
            return _respond(200, gitops.undo_last_commit(repo))
        if path == "/stash":
            return _respond(200, gitops.stash_push(repo, d.get("message") or ""))
        if path == "/stash/pop":
            return _respond(200, gitops.stash_pop(repo))
        if path == "/operation/continue":
            return _respond(200, gitops.finish_operation(repo, abort=False))
        if path == "/operation/abort":
            return _respond(200, gitops.finish_operation(repo, abort=True))
        if path == "/branch":
            name = (d.get("name") or "").strip()
            if not name:
                return _respond(400, {"error": "branch name required"})
            args = (["switch", "-c", name] if d.get("checkout") else ["branch", name])
            return _respond(200, gitops._git_then_status(repo, *args))
        if path == "/branch/delete":
            name = (d.get("name") or "").strip()
            if not name:
                return _respond(400, {"error": "branch name required"})
            return _respond(200, gitops.delete_branch(repo, name, bool(d.get("force"))))
        if path == "/branches/delete":
            names = d.get("names") or []
            if not names:
                return _respond(400, {"error": "no branches given"})
            return _respond(200, gitops.delete_branches(repo, names, bool(d.get("force"))))
        if path == "/checkout":
            ref = (d.get("ref") or "").strip()
            if not ref:
                return _respond(400, {"error": "ref required"})
            return _respond(200, gitops._git_then_status(repo, "checkout", ref))
        if path == "/merge":
            ref = (d.get("ref") or "").strip()
            if not ref:
                return _respond(400, {"error": "ref required"})
            args = ["merge"] + (["--no-ff"] if d.get("noff") else []) + [ref]
            return _respond(200, gitops._git_then_status(repo, *args))
        if path == "/rebase":
            onto = (d.get("onto") or "").strip()
            if not onto:
                return _respond(400, {"error": "onto ref required"})
            return _respond(200, gitops._git_then_status(repo, "rebase", onto))
        if path == "/cherry-pick":
            sha = (d.get("sha") or "").strip()
            if not sha:
                return _respond(400, {"error": "sha required"})
            return _respond(200, gitops._git_then_status(repo, "cherry-pick", sha))
        if path == "/revert":
            sha = (d.get("sha") or "").strip()
            if not sha:
                return _respond(400, {"error": "sha required"})
            return _respond(200, gitops._git_then_status(repo, "revert", "--no-edit", sha))
        if path == "/verb/plan":
            return _respond(200, gitops.verb_plan(repo, d.get("text") or ""))
        if path == "/verb/run":
            return _respond(200, gitops.verb_run(repo, d.get("steps") or []))
        if path == "/undo":
            return _respond(200, gitops.undo_to(repo, d.get("sha") or ""))
        if path == "/push":
            if d.get("smart"):
                # bulk 'push all': upstream handled for us, phases streamed to the progress file
                return _respond(200, gitops.smart_push(repo, d.get("remote") or "",
                                                        (d.get("branch") or "").strip()))
            remote = (d.get("remote") or "origin").strip()
            branch = (d.get("branch") or "").strip() or gitops._current_branch(repo)
            args = ["push"] + (["-u"] if d.get("setUpstream") else []) + [remote, branch]
            return _respond(200, gitops._git_then_status(repo, *args, timeout=60))
        if path == "/pull":
            # smart pull: rebase on the remote; a conflict is left in progress and reported —
            # the "pull all" UI then offers the human a choice (AI resolve or abort).
            return _respond(200, gitops.smart_pull(repo, d.get("remote") or "",
                                                    (d.get("branch") or "").strip()))
        if path == "/pull/resolve-all":
            # "Resolve all with AI" — one shot over every repo the bulk pull left conflicted.
            return _respond(200, gitops.resolve_all_conflicts(d.get("repos") or []))
        if path == "/pull/resolve":
            # "solve with AI" — resolves the in-progress rebase and lets it finish.
            return _respond(200, gitops.resolve_pull_conflict(repo))
        if path == "/pull/abort":
            # "I'll deal with it" — abort the rebase, back to the clean pre-pull state.
            return _respond(200, gitops.abort_pull_conflict(repo))
        if path == "/remote":
            op = d.get("op") or ""
            name, url = (d.get("name") or "").strip(), (d.get("url") or "").strip()
            if op == "add":
                return _respond(200, gitops._git_then_status(repo, "remote", "add", name, url))
            if op == "remove":
                return _respond(200, gitops._git_then_status(repo, "remote", "remove", name))
            if op == "seturl":
                return _respond(200, gitops._git_then_status(repo, "remote", "set-url", name, url))
            return _respond(400, {"error": "bad remote op"})
        return _respond(404, {"error": "no such route: POST " + path})

    return _respond(405, {"error": "unsupported method: " + method})


if __name__ == "__main__":
    main()
