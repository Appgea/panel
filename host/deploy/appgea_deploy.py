"""Appgea Deploy: a browser tool any agent harness can drive. No model inside.

The extension runs in your own logged-in Chrome and executes commands. This relay passes them
between the harness and the extension. The harness (Claude Code on a subscription, or anything with
a shell or MCP) does the thinking: it reads the page snapshot, then clicks, types and uploads.

  python appgea_deploy.py serve                   relay on 127.0.0.1:8765 (every other command starts it when needed)
  python appgea_deploy.py mcp                     the same commands as an MCP server over stdio

  python appgea_deploy.py post <deploy.json> [--only a,b] [--check|--publish]   every platform in parallel (recipes.py); --check = preflight
  python appgea_deploy.py open <platform|url>     new window, returns tab id; platforms: youtube facebook instagram tiktok x
  python appgea_deploy.py verify <tab> <platform>  confirm the logged-in account (accounts.json); upload/type stay locked until it passes
  python appgea_deploy.py snap <tab>              url, title and the numbered interactive elements
  python appgea_deploy.py shot <tab>              screenshot to a .jpg, prints its path
  python appgea_deploy.py click <tab> <id> [--publish]
  python appgea_deploy.py type <tab> <id> <text|@file>
  python appgea_deploy.py upload <tab> <id> <path>
  python appgea_deploy.py key <tab> <Enter|Escape|Tab|...>
  python appgea_deploy.py scroll <tab> <dy>
  python appgea_deploy.py mark <tab> <id>         outline an element red (the publish button, for the human)
  python appgea_deploy.py clickxy <tab> <x> <y>   click at page coordinates (CSS px, as on the screenshot)
  python appgea_deploy.py reload                   reload the extension from disk after editing it
  python appgea_deploy.py tabs | close <tab>

A click on the platform's final button (Publish, Post, Share, Yayınla, Paylaş...) is refused unless
--publish is given. Pass it when the user asked for the post.
"""
import json, os, sys, time, uuid, threading, base64
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.request import Request, urlopen

HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(HERE, '.state')
PORT = int(os.environ.get('APPGEA_DEPLOY_PORT', '8765'))
START = {
    'youtube': 'https://studio.youtube.com/',
    'facebook': 'https://business.facebook.com/latest/home',
    'instagram': 'https://www.instagram.com/',
    'tiktok': 'https://www.tiktok.com/tiktokstudio/upload',
    'x': 'https://x.com/compose/post',
}




# ---------- relay: harness -> queue -> extension -> result ----------
COND = threading.Condition()
QUEUE, RESULTS = [], {}
SEEN = {'t': 0.0}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        b = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'content-type, x-appgea')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.end_headers()

    def _ok(self, who):
        """No pairing code. Web pages are kept out instead: they always send an http(s) Origin with a request
        that carries a custom header, and they cannot reach us under another Host name (DNS rebinding)."""
        origin = self.headers.get('Origin') or ''
        host = (self.headers.get('Host') or '').split(':')[0]
        ok = (host in ('127.0.0.1', 'localhost') and self.headers.get('x-appgea') == who
              and (not origin or (who == 'ext' and origin.startswith('chrome-extension://'))))
        if not ok:
            self._json({'error': 'forbidden'}, 403)
        return ok

    def _body(self):
        n = int(self.headers.get('Content-Length', 0))
        return json.loads(self.rfile.read(n) or b'{}')

    def do_GET(self):
        path = self.path.partition('?')[0]
        if not self._ok('ext' if path == '/poll' or self.headers.get('x-appgea') == 'ext' else 'cli'):
            return
        if path == '/ping':
            return self._json({'ok': True, 'extension_seen': round(time.time() - SEEN['t'], 1) if SEEN['t'] else None})
        if path == '/poll':  # the extension long-polls here
            SEEN['t'] = time.time()
            with COND:
                COND.wait_for(lambda: QUEUE, timeout=20)
                cmd = QUEUE.pop(0) if QUEUE else None
            return self._json({'cmd': cmd})
        self._json({'error': 'unknown'}, 404)

    def do_POST(self):
        path = self.path.partition('?')[0]
        if not self._ok('ext' if path == '/result' else 'cli'):
            return
        body = self._body()
        if path == '/result':  # the extension answers a command
            with COND:
                RESULTS[body['id']] = body
                COND.notify_all()
            return self._json({'ok': True})
        if path == '/cmd':  # a harness sends a command and waits for its answer
            cid = uuid.uuid4().hex[:8]
            body['id'] = cid
            with COND:
                QUEUE.append(body)
                COND.notify_all()
                ok = COND.wait_for(lambda: cid in RESULTS, timeout=body.get('timeout', 120))
                res = RESULTS.pop(cid, None)
            if not ok:
                with COND:
                    if body in QUEUE:
                        QUEUE.remove(body)
                stale = time.time() - SEEN['t'] if SEEN['t'] else None
                return self._json({'error': 'extension did not answer' + (
                    '' if stale is not None and stale < 30 else ' (extension not connected: is Chrome open with Appgea Deploy loaded?)')})
            if res.get('shot'):
                os.makedirs(os.path.join(STATE, 'shots'), exist_ok=True)
                p = os.path.join(STATE, 'shots', time.strftime('%H%M%S-') + cid + '.jpg')
                open(p, 'wb').write(base64.b64decode(res.pop('shot')))
                res['path'] = p
            return self._json(res)
        self._json({'error': 'unknown'}, 404)


# ---------- client ----------
def start_relay():
    """Start the relay in the background if nothing answers on the port."""
    import subprocess
    try:
        urlopen(Request(f'http://127.0.0.1:{PORT}/ping', headers={'x-appgea': 'cli'}), timeout=2)
        return
    except OSError:
        pass
    os.makedirs(STATE, exist_ok=True)
    flags = 0x00000008 | 0x00000200 if os.name == 'nt' else 0  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    subprocess.Popen([sys.executable, os.path.abspath(__file__), 'serve'], creationflags=flags,
                     stdout=open(os.path.join(STATE, 'relay.log'), 'a'), stderr=subprocess.STDOUT,
                     stdin=subprocess.DEVNULL, start_new_session=os.name != 'nt')
    for _ in range(20):
        time.sleep(0.25)
        try:
            urlopen(Request(f'http://127.0.0.1:{PORT}/ping', headers={'x-appgea': 'cli'}), timeout=1)
            return
        except OSError:
            pass


def cmd(op, **args):
    body = dict(op=op, **args)
    req = Request(f'http://127.0.0.1:{PORT}/cmd', data=json.dumps(body).encode(),
                  headers={'x-appgea': 'cli', 'content-type': 'application/json'})
    try:
        return json.load(urlopen(req, timeout=args.get('timeout', 120) + 10))
    except OSError:
        start_relay()
        try:
            return json.load(urlopen(req, timeout=args.get('timeout', 120) + 10))
        except OSError as e:
            return {'error': f'relay did not start ({e}); see .state/relay.log'}


def from_argv(a):
    """CLI words -> (op, args). Shared by the CLI and the MCP tool table."""
    op = a[0]
    if op == 'open':
        return 'open', {'url': START.get(a[1], a[1])}
    if op == 'verify':
        return 'verify', {'tab': int(a[1]), 'platform': a[2]}
    if op in ('snap', 'shot', 'close'):
        return op, {'tab': int(a[1])}
    if op == 'click':
        return 'click', {'tab': int(a[1]), 'el': int(a[2]), 'publish': '--publish' in a}
    if op == 'type':
        text = a[3]
        if text.startswith('@') and os.path.exists(text[1:]):
            text = open(text[1:], encoding='utf-8').read()
        return 'type', {'tab': int(a[1]), 'el': int(a[2]), 'text': text}
    if op == 'upload':
        path = os.path.abspath(a[3])
        if not os.path.exists(path):
            raise SystemExit(f'no such file: {path}')
        return 'upload', {'tab': int(a[1]), 'el': int(a[2]), 'path': path}
    if op == 'clickxy':
        return 'clickxy', {'tab': int(a[1]), 'x': float(a[2]), 'y': float(a[3])}
    if op == 'reload':
        return 'reload', {}
    if op in ('key', 'mark', 'scroll'):
        v = a[2] if op == 'key' else int(a[2])
        return op, {'tab': int(a[1]), ('key' if op == 'key' else 'el' if op == 'mark' else 'dy'): v}
    if op == 'tabs':
        return 'tabs', {}
    raise SystemExit(__doc__)


def show(res):
    if 'elements' in res:
        print(f"{res.get('url')}\n{res.get('title')}\n{res['elements']}")
    else:
        print(json.dumps(res, ensure_ascii=False))


# ---------- MCP over stdio (JSON-RPC, one message per line) ----------
TOOLS = [
    ('deploy_open', 'Open a new Chrome window on a platform upload start page (youtube, facebook, instagram, tiktok, x) or a URL. Returns the tab id.',
     {'target': {'type': 'string'}}, ['target']),
    ('deploy_verify', 'Confirm the logged-in account on the tab against accounts.json. Upload and type are locked on a tab until this passes; any page load locks it again.',
     {'tab': {'type': 'integer'}, 'platform': {'type': 'string', 'enum': ['youtube', 'facebook', 'instagram', 'tiktok', 'x']}}, ['tab', 'platform']),
    ('deploy_snapshot', 'Numbered list of the interactive elements on the tab (inputs, buttons, editable boxes, hidden file inputs), with labels and state. Use the numbers in the other tools. Re-snapshot after each change.',
     {'tab': {'type': 'integer'}}, ['tab']),
    ('deploy_screenshot', 'Screenshot of the tab, saved as a JPEG. Returns its path; read the file to see it.',
     {'tab': {'type': 'integer'}}, ['tab']),
    ('deploy_click', 'Click an element by its snapshot number. A final publish button is refused unless publish is true, and publish is true once the user asked for the post and every field is checked.',
     {'tab': {'type': 'integer'}, 'el': {'type': 'integer'}, 'publish': {'type': 'boolean'}}, ['tab', 'el']),
    ('deploy_type', 'Replace the whole content of an input or editable box with text (newlines become line breaks).',
     {'tab': {'type': 'integer'}, 'el': {'type': 'integer'}, 'text': {'type': 'string'}}, ['tab', 'el', 'text']),
    ('deploy_upload', 'Put a local file into a file input (hidden inputs work), by snapshot number and absolute path.',
     {'tab': {'type': 'integer'}, 'el': {'type': 'integer'}, 'path': {'type': 'string'}}, ['tab', 'el', 'path']),
    ('deploy_key', 'Press a key on the tab: Enter, Escape, Tab, ArrowDown...',
     {'tab': {'type': 'integer'}, 'key': {'type': 'string'}}, ['tab', 'key']),
    ('deploy_scroll', 'Scroll the tab by dy pixels (negative is up).',
     {'tab': {'type': 'integer'}, 'dy': {'type': 'integer'}}, ['tab', 'dy']),
    ('deploy_mark', 'Outline an element red so the human can find it (use on the final publish button).',
     {'tab': {'type': 'integer'}, 'el': {'type': 'integer'}}, ['tab', 'el']),
]
MCP_OP = {'deploy_verify': 'verify', 'deploy_open': 'open', 'deploy_snapshot': 'snap', 'deploy_screenshot': 'shot', 'deploy_click': 'click',
          'deploy_type': 'type', 'deploy_upload': 'upload', 'deploy_key': 'key', 'deploy_scroll': 'scroll', 'deploy_mark': 'mark'}


def mcp():
    out = lambda m: (sys.stdout.write(json.dumps(m, ensure_ascii=False) + '\n'), sys.stdout.flush())
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            m = json.loads(line.lstrip('﻿'))
        except ValueError:
            continue
        mid, meth = m.get('id'), m.get('method')
        if meth == 'initialize':
            out({'jsonrpc': '2.0', 'id': mid, 'result': {
                'protocolVersion': m['params'].get('protocolVersion', '2025-06-18'),
                'capabilities': {'tools': {}}, 'serverInfo': {'name': 'appgea-deploy', 'version': '0.2.0'},
                'instructions': 'Browser tool for uploading videos in the user\'s logged-in Chrome. Platform notes: README.md next to appgea_deploy.py. Publish only when the user asked for the post.'}})
        elif meth == 'tools/list':
            out({'jsonrpc': '2.0', 'id': mid, 'result': {'tools': [
                {'name': n, 'description': d, 'inputSchema': {'type': 'object', 'properties': p, 'required': r}}
                for n, d, p, r in TOOLS]}})
        elif meth == 'tools/call':
            name, a = m['params']['name'], dict(m['params'].get('arguments') or {})
            if name == 'deploy_open':
                a = {'url': START.get(a['target'], a['target'])}
            if name == 'deploy_upload' and not os.path.exists(a.get('path', '')):
                res = {'error': 'no such file: ' + a.get('path', '')}
            else:
                res = cmd(MCP_OP[name], **a)
            text = res['elements'] if 'elements' in res else json.dumps(res, ensure_ascii=False)
            if 'elements' in res:
                text = f"{res.get('url')}\n{res.get('title')}\n{text}"
            out({'jsonrpc': '2.0', 'id': mid, 'result': {'content': [{'type': 'text', 'text': text}],
                                                         'isError': 'error' in res}})
        elif mid is not None:
            out({'jsonrpc': '2.0', 'id': mid, 'result': {}} if meth == 'ping' else
                {'jsonrpc': '2.0', 'id': mid, 'error': {'code': -32601, 'message': 'unknown method'}})


if __name__ == '__main__':
    a = sys.argv[1:] or ['serve']
    for st in (sys.stdin, sys.stdout):
        st.reconfigure(encoding='utf-8')  # MCP is UTF-8; Windows consoles default to a code page
    if a[0] == 'serve':
        print(f'Appgea Deploy relay on http://127.0.0.1:{PORT}', flush=True)
        ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
    elif a[0] == 'mcp':
        mcp()
    elif a[0] == 'post':
        import recipes
        job = json.load(open(a[1], encoding='utf-8'))
        only = a[a.index('--only') + 1].split(',') if '--only' in a else None
        if '--check' in a:
            res = recipes.check(cmd, START, only or list(job['tasks']))
        else:
            res = recipes.post(cmd, START, job, publish='--publish' in a, only=only)
        print(json.dumps(res, ensure_ascii=False, indent=1))
    else:
        op, args = from_argv(a)
        show(cmd(op, **args))
