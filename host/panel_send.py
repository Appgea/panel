#!/usr/bin/env python3
"""Send one rich, fire-and-forget message from a hosted agent to Panel."""

import argparse
import json
import os
import urllib.request


def main():
    parser = argparse.ArgumentParser(description="Send a rich message to Panel")
    parser.add_argument("--title", required=True)
    parser.add_argument("--text", required=True)
    parser.add_argument(
        "--outcome",
        required=True,
        choices=["progress", "done", "blocked", "needs_decision"],
    )
    parser.add_argument(
        "--flow",
        action="append",
        required=True,
        metavar="REF|LABEL|DETAIL",
        help="repeatable code-backed flow step",
    )
    parser.add_argument("--image", action="append", default=[], metavar="PATH[|CAPTION]")
    parser.add_argument("--audio", action="append", default=[])
    parser.add_argument("--video", action="append", default=[])
    parser.add_argument("--file", action="append", default=[])
    parser.add_argument("--folder", action="append", default=[])
    parser.add_argument(
        "--link",
        action="append",
        default=[],
        help="web URL, or a Panel place: panel:review[:<path>], panel:work:<path>[:<line>], "
        "panel:git, panel:manager (paths project-relative)",
    )
    args = parser.parse_args()

    flow = []
    for raw in args.flow:
        parts = raw.split("|", 2)
        if len(parts) != 3 or not all(part.strip() for part in parts):
            parser.error("--flow must be REF|LABEL|DETAIL")
        flow.append({"ref": parts[0].strip(), "label": parts[1].strip(), "detail": parts[2].strip()})
    payload = {
        "title": args.title,
        "text": args.text,
        "outcome": args.outcome,
        "flow": flow,
    }
    if args.image:
        # PATH|CAPTION, so a report's screenshots can say what they show.
        payload["images"] = [
            {"path": p, "caption": c} if c else p
            for p, _, c in (raw.partition("|") for raw in args.image)
        ]
    if args.audio:
        payload["audio"] = args.audio
    if args.video:
        payload["video"] = args.video
    attachments = (
        [{"path": path, "kind": "file"} for path in args.file]
        + [{"path": path, "kind": "folder"} for path in args.folder]
    )
    if attachments:
        payload["attachments"] = attachments
    if args.link:
        payload["links"] = args.link

    # A session Panel did not launch has no PANEL_PORT. Panel writes its live port to this file,
    # and the old fixed default sent those reports nowhere.
    port = os.environ.get("PANEL_PORT")
    if not port:
        try:
            with open(os.path.expanduser("~/.appgeapanel/ingress-port")) as f:
                port = f.read().strip()
        except OSError:
            port = "7391"
    body = json.dumps({
        "instance": os.environ.get("PANEL_INSTANCE", ""),
        # Second way home. An engine that never got PANEL_INSTANCE (a plain shell, a CLI with no
        # session-scoped config) is still standing inside a registered project, and Panel can
        # route on that instead of dropping the report.
        "cwd": os.getcwd(),
        "type": "message",
        "payload": payload,
    }).encode()
    request = urllib.request.Request(
        "http://127.0.0.1:%s/panel/emit" % port,
        data=body,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        result = json.loads(response.read().decode() or "{}")
    print("sent message %s" % (result.get("id") or "?"))


if __name__ == "__main__":
    main()
