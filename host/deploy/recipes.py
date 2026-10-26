"""One command for a whole release: every platform in parallel, on click-paths that have worked.

  python appgea_deploy.py post <deploy.json> [--only youtube,x] [--publish]

Each platform: open → verify the account (switch it if YouTube shows another channel) → upload → fill → publish
(only with --publish) → confirm. Files over 1.2 GB get a ~5 Mbps copy first: Instagram refused a 2.4 GB cut and
X dropped one. A step that does not find its element within its wait stops that platform with a screenshot,
and an agent finishes it by hand with the single commands. Labels are regexes over `snap` lines, TR and EN.
"""
import json, os, re, subprocess, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))


class Stop(Exception):
    pass


def uploadable(path):
    """A copy small enough for web uploaders, made once and reused."""
    if os.path.getsize(path) < 1.2e9:
        return path
    out = path[:-4] + '_upload.mp4'
    if not os.path.exists(out) or os.path.getmtime(out) < os.path.getmtime(path):
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', path, '-c:v', 'h264_nvenc', '-preset', 'p6', '-b:v', '5M',
                        '-maxrate', '6M', '-bufsize', '10M', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
                        '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out], check=True)
    return out


class Tab:
    def __init__(self, cmd, platform, start, log):
        self.cmd, self.p, self.log = cmd, platform, log
        r = cmd('open', url=start)
        if 'tab' not in r:
            raise Stop(f'open failed: {r}')
        self.id = r['tab']

    def say(self, s):
        self.log(f'{self.p}: {s}')

    def lines(self):
        return self.cmd('snap', tab=self.id).get('elements', '').splitlines()

    def find(self, pat, wait=30, enabled=True, quiet=False):
        end = time.time() + wait
        while True:
            for ln in self.lines():
                if re.search(pat, ln) and (not enabled or ' disabled' not in ln):
                    m = re.match(r'\[(\d+)\]', ln)
                    if m:
                        return int(m.group(1)), ln
            if time.time() > end:
                if quiet:
                    return None, None
                raise Stop(f'not found in {wait}s: {pat}')
            time.sleep(2)

    def has(self, pat):
        return self.find(pat, wait=0, enabled=False, quiet=True)[0] is not None

    def _do(self, op, **a):
        r = self.cmd(op, tab=self.id, **a)
        if 'locked' in str(r.get('error', '')):  # a page load re-locked the tab
            self.verify()
            r = self.cmd(op, tab=self.id, **a)
        if r.get('error'):
            raise Stop(f'{op}: {r["error"]}')
        return r

    def click(self, pat, wait=30, publish=False):
        i, ln = self.find(pat, wait)
        self._do('click', el=i, publish=publish)
        time.sleep(1.2)
        return ln

    def type(self, pat, text, wait=30):
        i, _ = self.find(pat, wait)
        self._do('type', el=i, text=text)
        time.sleep(0.8)

    def upload(self, pat, path, wait=30):
        i = 0 if pat is None else self.find(pat, wait, enabled=False)[0]
        self._do('upload', el=i, path=path)
        time.sleep(2)

    def key(self, k):
        self.cmd('key', tab=self.id, key=k)

    def verify(self):
        r = self.cmd('verify', tab=self.id, platform=self.p)
        if not r.get('ok'):
            raise Stop(f'account: {r.get("error")}')
        return r['account']

    def shot(self):
        return self.cmd('shot', tab=self.id).get('path')


# ---------- platforms ----------
def youtube(t, j, publish, accounts):
    try:
        t.verify()
    except Stop:  # the Studio shows another channel: switch to ours
        t.click(r'button "Account"')
        t.click(r'"(Switch account|Hesap değiştir)"')
        t.click(re.escape(accounts['youtube'][0]))
        time.sleep(6)
        t.verify()
    t.click(r'"(Upload videos|Video yükle)"')
    t.upload(r'input:file "Filedata"', j['video'])
    t.type(r'editable role=textbox "(Add a title|Videonuzu açıklayan)', j['title'], wait=60)
    t.type(r'editable role=textbox "(Tell viewers|İzleyicilere)', j.get('description', ''))
    if j.get('cover'):
        t.upload(r'input:file "" accept=image', j['cover'])
    for _ in range(3):
        t.click(r"role=radio \"(No, it.s not made for kids|Hayır, çocuklara özel değil)")
        if t.has(r"role=radio \"(No, it.s not made for kids|Hayır, çocuklara özel değil).*checked"):
            break
    else:
        raise Stop('made-for-kids radio did not stick')
    nxt = r'button "(Next|İleri)"'
    t.click(nxt)
    if t.has(r'"Edit video monetization status"') and j.get('monetize', True):
        t.click(r'"Edit video monetization status"')
        t.click(r'role=radio "(On|Açık)"')
        t.click(r'button "(Done|Bitti)"')
        t.click(nxt)
    if t.has(r'"(None of the above|Yukarıdakilerin hiçbiri)"'):
        t.click(r'"(None of the above|Yukarıdakilerin hiçbiri)"')
        t.click(r'button "(Submit rating|Derecelendirmeyi gönder)"')
        t.click(nxt)
    for _ in range(3):  # video elements, checks: until the visibility step shows
        if t.has(r'role=radio "(Public|Herkese açık)"'):
            break
        t.click(nxt)
    t.click(r'role=radio "(Public|Herkese açık)"')
    if publish:
        t.click(r'button "(Publish|Yayınla|Save|Kaydet)"', publish=True)
        time.sleep(4)


def tiktok(t, j, publish, accounts):
    t.verify()  # the lock needs the account on the page before any upload
    t.upload(r'input:file .*accept=video', j['video'])
    t.find(r'"Replace"', wait=900, enabled=False)  # upload finished
    t.verify()
    cap = j['caption']
    for _ in range(3):  # the editor resets once the upload completes; retype until it sticks
        t.type(r'^\[\d+\] editable role=combobox', cap)
        if t.has(re.escape(cap[:25])):
            break
    if j.get('cover'):
        t.click(r'clickable "(Edit cover|Kapağı düzenle)"')
        t.upload(r'input:file "Upload cover"', j['cover'])
        time.sleep(2)
        t.click(r'role=button "(Save|Kaydet)"')
    if publish:
        t.click(r'role=button "(Post|Paylaş|Yayınla)"', wait=120, publish=True)
        time.sleep(5)


def facebook(t, j, publish, accounts):
    t.verify()
    if t.has(r'button "Kapat"$'):
        t.click(r'button "Kapat"$')
    t.click(r'"(Gönderi oluştur|Create post)"')
    time.sleep(4)
    t.verify()
    ig = [re.escape(n) for n in accounts.get('instagram', [])]
    i, share_to = t.find(r'role=combobox "(Şurada paylaş|Share to)', enabled=False)
    if ig and re.search('|'.join(ig), share_to):  # Instagram is ticked too: untick it, it has its own cut
        t._do('click', el=i)
        time.sleep(1)
        t.click(r'role=option "(' + '|'.join(ig) + ')" selected')
        t.key('Escape')
    t.click(r'"(Fotoğraf/video ekle|Add photo/video)"')
    t.upload(None, j['video'])
    t.type(r'editable role=combobox "(Metni gönderine|Write)', j.get('text', ''))
    t.find(r'"(Videoyu kaldır|Remove video)', wait=900, enabled=False)
    if publish:
        t.click(r'role=button "(Yayınla|Publish|Şimdi paylaş|Share now)"', wait=300, publish=True)
        time.sleep(6)


def instagram(t, j, publish, accounts):
    t.verify()
    t.click(r'"(New post|Create|Yeni gönderi|Oluştur)"')
    if t.has(r'"(Post|Gönderi)"$'):
        t.click(r'"(Post|Gönderi)"$')
    t.upload(r'input:file .*video/mp4', j['video'], wait=20)
    for _ in range(2):  # crop: keep the original frame
        if t.has(r'role=button "(Original|Orijinal)"'):
            break
        t.click(r'^\[\d+\] div role=button ""', wait=10)
    if t.has(r'role=button "(Original|Orijinal)"'):
        t.click(r'role=button "(Original|Orijinal)"')
    t.click(r'role=button "(Next|İleri)"')
    if j.get('cover') and t.has(r'input:file "" accept=image/jpeg'):
        t.upload(r'input:file "" accept=image/jpeg', j['cover'])
    t.click(r'role=button "(Next|İleri)"')
    t.type(r'editable role=textbox "(Add a caption|Açıklama yaz)', j['caption'])
    if publish:
        t.click(r'role=button "(Share|Paylaş)"', publish=True)
        t.find(r'.', wait=5, enabled=False)


def x(t, j, publish, accounts):
    t.verify()
    t.upload(r'input:file .*video/mp4', j['video'])
    t.type(r'editable role=textbox "(Metni gönderi olarak yayınla|Post text|What)', j['text'])
    # the composer's own button, never the left-bar link of the same name (a post was lost that way)
    t.find(r'button role=button "(Gönderi yayınla|Post)"', wait=900)
    time.sleep(20)  # enabled is not the same as processed
    if publish:
        t.click(r'button role=button "(Gönderi yayınla|Post)"', publish=True)
        time.sleep(6)


RECIPES = {'youtube': youtube, 'tiktok': tiktok, 'facebook': facebook, 'instagram': instagram, 'x': x}


FIRST = {  # what each platform must show right after open + verify; `post --check` looks for it
    'youtube': r'"(Upload videos|Video yükle)"',
    'tiktok': r'input:file .*accept=video',
    'facebook': r'"(Gönderi oluştur|Create post)"',
    'instagram': r'"(New post|Create|Yeni gönderi|Oluştur)"',
    'x': r'input:file .*video/mp4',
}


def check(cmd, start, platforms):
    """Preflight, nothing uploaded: open, verify the account, find the first control, close."""
    out = {}
    def one(p):
        try:
            t = Tab(cmd, p, start[p], print)
            acc = t.verify()
            t.find(FIRST[p], wait=20, enabled=False)
            out[p] = f'ok ({acc})'
            cmd('close', tab=t.id)
        except Exception as e:
            out[p] = f'FAIL: {e}'[:200]
    ths = [threading.Thread(target=one, args=(p,)) for p in platforms]
    [th.start() for th in ths]
    [th.join() for th in ths]
    return out


def post(cmd, start, job, publish, only=None):
    accounts = json.load(open(os.path.join(HERE, 'accounts.json'), encoding='utf-8'))
    lock = threading.Lock()
    log = lambda s: (lock.acquire(), print(time.strftime('%H:%M:%S'), s, flush=True), lock.release())
    results = {}

    def run(p, j):
        j = dict(j)
        try:
            j['video'] = uploadable(j['video'])
            t = Tab(cmd, p, start[p], log)
            RECIPES[p](t, j, publish, accounts)
            results[p] = {'ok': True, 'published': publish, 'tab': t.id, 'shot': t.shot()}
            log(f'{p}: done{" and published" if publish else ", stopped before publish"}')
        except Exception as e:  # Stop or anything else: report, keep the tab for a manual finish
            shot = None
            try:
                shot = t.shot()
            except Exception:
                pass
            results[p] = {'ok': False, 'error': str(e)[:300], 'shot': shot}
            log(f'{p}: STOPPED: {e}')

    ths = [threading.Thread(target=run, args=(p, j)) for p, j in job['tasks'].items() if not only or p in only]
    for th in ths:
        th.start()
    for th in ths:
        th.join()
    return results
