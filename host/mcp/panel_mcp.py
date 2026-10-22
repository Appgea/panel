#!/usr/bin/env python3
"""appgea-panel — the ONE intentional channel from an agent to Panel's companion panel.

Two deliberately generic tools:

  panel_emit(type, payload)    fire-and-forget visual event (an "animation")
  send_to_user(...)            durable-looking rich handoff: text, images, files and links
  ask_user(kind, prompt, ...)  a blocking question — the tool RESULT is the user's answer

`type` and `kind` are free strings routed to a frontend renderer registry, so new animation
and question types need no change to this server. This process runs no server of its own; it
forwards to the Panel port (PANEL_PORT) for one instance (PANEL_INSTANCE), matching
Panel's "the port is the whole integration surface" design.

Stdio transport, newline-delimited JSON-RPC (MCP 2024-11-05). No third-party deps.

WHEN TO USE:
  * Deterministic visuals — file edits, git commit/push, turn start/stop — ALREADY animate
    from Panel's session hooks. Don't re-emit those; they fire whether you call a tool or not.
  * Use panel_emit for things hooks can't see: a phase you're entering, a plan, a milestone.
  * Use ask_user when you genuinely need a human decision before continuing. It BLOCKS until
    the user answers in Panel's ask tray, then returns their answer as the tool result.
"""
import json
import os
import sys
import urllib.request

PORT = os.environ.get("PANEL_PORT", "7391")
INSTANCE = os.environ.get("PANEL_INSTANCE", "")
BASE = "http://127.0.0.1:%s" % PORT

PROTOCOL_VERSION = "2024-11-05"

TOOLS = [
    {
        "name": "panel_emit",
        "description": (
            "Show a visual event ('animation') in the Panel companion panel. Fire-and-forget. "
            "`type` is a free string routed to a renderer; built-ins include 'note', 'progress', "
            "'milestone', 'git-commit', 'git-push', 'tool', 'card' (unknown types render as a card). "
            "Prefer this ONLY for things Panel's hooks can't already see (a phase you're starting, "
            "a plan, a result) — file/git activity already animates deterministically."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "type": {"type": "string",
                         "description": "renderer key, e.g. 'note' | 'progress' | 'milestone' | 'card'"},
                "payload": {"type": "object",
                            "description": "renderer-specific fields, e.g. {text, pct, title, target}"},
            },
            "required": ["type"],
        },
    },
    {
        "name": "send_to_user",
        "description": (
            "File a report to the appgea brain, for the CPO/CTO read. This is NOT a message to the "
            "human: the text is written to the project's agent log, and the Inbox shows only the "
            "headline plus whatever media you attach. Talk to the human in the terminal; report "
            "here. Call it at REAL checkpoints only — work finished, work blocked, a decision "
            "needed, or media worth looking at. Not every turn, not for progress narration. "
            "Attach `images` for anything visual, `audio` for a clip to hear, `video` for a file "
            "or URL the human opens outside Panel. Fire-and-forget."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "short message title"},
                "text": {
                    "type": "string",
                    "description": "one brief explanation of what changed and why it matters"
                },
                "outcome": {
                    "type": "string",
                    "enum": ["progress", "done", "blocked", "needs_decision"],
                    "description": (
                        "where the work stands. 'progress' mid-task, 'done' when the turn's work "
                        "is finished, 'blocked' when you cannot continue without something, "
                        "'needs_decision' when only the human can choose. Set it on every report: "
                        "it is what lets the CPO count the portfolio instead of re-reading it."
                    )
                },
                "flow": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "ref": {
                                "type": "string",
                                "description": "exact project-relative code ref, preferably path:line"
                            },
                            "label": {"type": "string", "description": "short step title"},
                            "detail": {
                                "type": "string",
                                "description": "one plain sentence explaining this code step"
                            }
                        },
                        "required": ["ref", "label", "detail"]
                    },
                    "description": "2-5 code-backed steps showing what the agent did"
                },
                "images": {
                    "type": "array",
                    "items": {
                        "oneOf": [
                            {"type": "string"},
                            {"type": "object", "properties": {
                                "path": {"type": "string"},
                                "caption": {"type": "string"}
                            }, "required": ["path"]}
                        ]
                    },
                    "description": (
                        "every screenshot/render this turn produced, one entry per shot. Paths may "
                        "be project-relative or absolute — Panel resolves both. REQUIRED for any "
                        "visual work: the human opens the Inbox to look at what you made, and a "
                        "report about a screen with no picture of it is a report they cannot use. "
                        "Caption each one — a shot with no caption is a shot they have to decode."
                    )
                },
                "audio": {
                    "type": "array",
                    "items": {
                        "oneOf": [
                            {"type": "string"},
                            {"type": "object", "properties": {
                                "path": {"type": "string"},
                                "caption": {"type": "string"}
                            }, "required": ["path"]}
                        ]
                    },
                    "description": (
                        "audio clips the human should hear — a generated voice line, a mixed sound "
                        "effect. Plays inline in the Inbox, so keep it short."
                    )
                },
                "video": {
                    "type": "array",
                    "items": {
                        "oneOf": [
                            {"type": "string"},
                            {"type": "object", "properties": {
                                "path": {"type": "string"},
                                "url": {"type": "string"},
                                "caption": {"type": "string"}
                            }}
                        ]
                    },
                    "description": (
                        "video the human may want to watch. NEVER played inline — Panel shows a "
                        "link that opens it in a real player. Give `path` for a file or `url` for "
                        "a hosted clip."
                    )
                },
                "attachments": {
                    "type": "array",
                    "items": {
                        "oneOf": [
                            {"type": "string"},
                            {"type": "object", "properties": {
                                "path": {"type": "string"},
                                "label": {"type": "string"},
                                "kind": {"type": "string", "enum": ["file", "folder"]}
                            }, "required": ["path"]}
                        ]
                    },
                    "description": "project files or folders the human can open"
                },
                "links": {
                    "type": "array",
                    "items": {
                        "oneOf": [
                            {"type": "string"},
                            {"type": "object", "properties": {
                                "url": {"type": "string"},
                                "label": {"type": "string"}
                            }, "required": ["url"]}
                        ]
                    },
                    "description": (
                        "web URLs, or Panel places the human can open with one click: "
                        "'panel:review' (this work in Review), 'panel:review:<path>' (one "
                        "file), 'panel:work:<path>:<line>' (the code in Work), 'panel:git', "
                        "'panel:manager'. Paths are project-relative. images/audio/video "
                        "already get a Review button; do not repeat them here."
                    )
                }
            },
            "required": ["title", "text", "outcome", "flow"]
        }
    },
    {
        "name": "ask_user",
        "description": (
            "Ask the human a question in Panel and BLOCK until they answer; the tool "
            "result IS their answer. Use for real decisions you need before continuing. `kind` "
            "selects the widget: 'choice' (options -> one), 'multi' (options -> many), 'confirm' "
            "(yes/no), 'text' (free text), or 'document' (open an existing file or editable draft "
            "in Panel's Work editor). Unknown kinds render as a "
            "text prompt. Returns a JSON object; on no answer it returns {\"timeout\": true}, "
            "and {\"skipped\": true} when the human chose not to answer."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "kind": {"type": "string",
                         "description": "'choice' | 'multi' | 'confirm' | 'text' | 'document'"},
                "prompt": {"type": "string", "description": "the question shown to the user"},
                "title": {"type": "string", "description": "optional short header"},
                "options": {"type": "array", "items": {
                    "oneOf": [
                        {"type": "string"},
                        {"type": "object", "properties": {
                            "id": {"type": "string"},
                            "title": {"type": "string"},
                            "desc": {"type": "string"},
                            "recommended": {"type": "boolean"}
                        }, "required": ["id", "title"]}
                    ]},
                    "description": "plain labels or {id,title,desc,recommended} choices"},
                "fields": {"type": "array", "items": {"type": "object"},
                           "description": "for kind 'form': [{name,label,placeholder?}]"},
                "path": {"type": "string",
                         "description": "for document: project-relative existing file or new text/Markdown draft"},
                "draft": {"type": "string",
                          "description": "for document: initial contents, used only when path does not exist"},
                "why": {"type": "string",
                        "description": "short reason this document needs the human"},
                "handoff": {"type": "object",
                            "description": "optional new-session action: {task,provider?,button?}"},
                "timeout": {"type": "number",
                            "description": "seconds to wait for an answer (default 280)"},
            },
            "required": ["prompt"],
        },
    },
]


# The manager's eyes and hands on the workers. They ride the ask channel because the answers live
# in Panel's window: which terminal is mid-turn, which waits on the human, and the rendered screen
# (the raw PTY tail is cursor moves, not text). Panel answers list/read at once, refuses all three
# for any session that is not its manager, and shows the human every brief before it is typed.
TEAM_TOOLS = [
    {
        "name": "list_workers",
        "description": (
            "List every live terminal in Panel across the portfolio: session id, project, agent, "
            "and status (working | waiting_on_human | finished_unseen | idle | shell). Call this "
            "first to see where things stand."
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "read_worker",
        "description": (
            "Read what is on one worker terminal's screen right now, as plain text, plus its "
            "status and its current prompt. Use the session id from list_workers."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "session": {"type": "string", "description": "session id from list_workers"},
                "lines": {"type": "number", "description": "screen lines to return (default 60, max 400)"},
            },
            "required": ["session"],
        },
    },
    {
        "name": "brief_worker",
        "description": (
            "Type a prompt into a worker's terminal and submit it. Panel shows the human the "
            "exact text and the target first; nothing is sent unless they approve. Refused while "
            "the worker is mid-turn or waiting on the human. Returns {sent: true} or why not."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "session": {"type": "string", "description": "session id from list_workers"},
                "text": {"type": "string", "description": "the brief, as the worker should read it"},
            },
            "required": ["session", "text"],
        },
    },
]

if os.environ.get("PANEL_ROLE") == "manager":
    TOOLS = TOOLS + TEAM_TOOLS


def _post(path, body, timeout):
    data = json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode() or "{}")


def _call(name, args):
    if name == "panel_emit":
        r = _post("/panel/emit",
                  {"instance": INSTANCE, "type": args.get("type"),
                   "payload": args.get("payload") or {}}, 10)
        return "emitted event %s" % (r.get("id") or "?")
    if name == "send_to_user":
        payload = {k: args[k] for k in
                   ("title", "text", "outcome", "flow", "images", "audio", "video",
                    "attachments", "links")
                   if k in args and args[k] is not None}
        r = _post("/panel/emit",
                  {"instance": INSTANCE, "type": "message", "payload": payload}, 10)
        return "sent message %s" % (r.get("id") or "?")
    if name == "ask_user":
        timeout = float(args.get("timeout") or 280)
        spec = {k: args[k] for k in ("kind", "prompt", "title", "options", "fields", "handoff",
                                     "path", "draft", "why")
                if k in args and args[k] is not None}
        r = _post("/panel/ask",
                  {"instance": INSTANCE, "spec": spec, "timeout": timeout}, timeout + 20)
        return json.dumps(r)
    if name in ("list_workers", "read_worker", "brief_worker"):
        spec = {"kind": "team:" + name.split("_")[0]}
        for key in ("session", "lines", "text"):
            if args.get(key) is not None:
                spec[key] = args[key]
        # A brief waits on the human's approval; list and read answer at once.
        timeout = 600 if name == "brief_worker" else 20
        r = _post("/panel/ask",
                  {"instance": INSTANCE, "spec": spec, "timeout": timeout}, timeout + 20)
        return json.dumps(r)
    raise ValueError("unknown tool: %s" % name)


def _reply(mid, result=None, error=None):
    msg = {"jsonrpc": "2.0", "id": mid}
    if error is not None:
        msg["error"] = error
    else:
        msg["result"] = result
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def _handle(req):
    method = req.get("method")
    mid = req.get("id")
    is_notification = "id" not in req
    if method == "initialize":
        return _reply(mid, {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "appgea-panel", "version": "1.0.0"},
        })
    if method == "notifications/initialized" or is_notification:
        return  # notifications get no response
    if method == "ping":
        return _reply(mid, {})
    if method == "tools/list":
        return _reply(mid, {"tools": TOOLS})
    if method == "tools/call":
        params = req.get("params") or {}
        name = params.get("name")
        args = params.get("arguments") or {}
        try:
            text = _call(name, args)
            return _reply(mid, {"content": [{"type": "text", "text": text}]})
        except Exception as e:
            return _reply(mid, {"content": [{"type": "text", "text": "error: %s" % e}],
                                "isError": True})
    return _reply(mid, error={"code": -32601, "message": "method not found: %s" % method})


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        try:
            _handle(req)
        except Exception as e:
            sys.stderr.write("appgea-panel handler error: %s\n" % e)


if __name__ == "__main__":
    main()
