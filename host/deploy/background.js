// Appgea Deploy: a browser tool with no model inside. It long-polls the local relay for commands
// (open, snap, shot, click, type, upload, key, scroll, mark) sent by any agent harness, and runs them
// through the DevTools protocol so sites see trusted input. Files go in straight from disk.

// The platform's final button. Refused unless the command carries publish (the user's go).
// Per site, because the same word means different things: "Post" is Instagram's create-menu item but TikTok's
// publish button; "Save" publishes on YouTube's visibility step but only closes TikTok's cover dialog.
const word = (alts) => new RegExp(`^(${alts})(?![\\p{L}\\p{N}])`, 'iu');
const FINAL = {
  'studio.youtube.com': word('publish|save|schedule|yayınla|yayımla|kaydet|planla'),
  'www.tiktok.com': word('post|post now|paylaş|yayınla|schedule|planla'),
  'www.instagram.com': word('share|paylaş|yayınla'),
  'business.facebook.com': word('publish|share|share now|yayınla|yayımla|paylaş|şimdi paylaş|schedule|planla'),
  'www.facebook.com': word('publish|post|share|share now|yayınla|yayımla|paylaş|şimdi paylaş|gönder|schedule|planla'),
  'x.com': word('post|post all|tweet|gönder|yayınla|paylaş|schedule|planla'),
};
const ANY_FINAL = word('publish|post|post now|share|share now|save|schedule|tweet|yayınla|yayımla|paylaş|şimdi paylaş|gönder|kaydet|planla');
function isFinal(url, label) {
  let host = '';
  try { host = new URL(url).host; } catch (e) {}
  return (FINAL[host] || ANY_FINAL).test(label || '');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cfg() {
  return chrome.storage.local.get({ server: 'http://127.0.0.1:8765' });
}

async function api(path, body) {
  const c = await cfg();
  const r = await fetch(c.server + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-appgea': 'ext', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return r.json();
}

// ---------- page side (runs inside the tab) ----------
function pageSnapshot() {
  const SEL = 'input, textarea, select, button, a[href], [contenteditable="true"], [contenteditable=""], [role=button], [role=textbox], [role=radio], [role=checkbox], [role=combobox], [role=option], [role=menuitem], [role=tab], [role=switch], [role=link]';
  const out = [];
  let n = 0;
  const vis = (el, r) => {
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.05;
  };
  const label = (el) => {
    let t = el.getAttribute('aria-label') || '';
    const lb = el.getAttribute('aria-labelledby');
    if (!t && lb) t = lb.split(/\s+/).map((i) => el.getRootNode().getElementById?.(i)?.innerText || '').join(' ');
    if (!t && el.labels && el.labels[0]) t = el.labels[0].innerText;
    t = t || el.getAttribute('placeholder') || el.getAttribute('aria-placeholder') || el.getAttribute('title') || '';
    if (!t && !el.isContentEditable && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') t = el.innerText || '';
    if (!t) t = el.getAttribute('name') || '';
    return t.replace(/\s+/g, ' ').trim().slice(0, 70);
  };
  const dialogs = [];
  const walk = (root, dx, dy, depth) => {
    if (depth > 6) return;
    root.querySelectorAll('[role=dialog], dialog[open], [aria-modal=true]').forEach((d) => dialogs.push(d));
    root.querySelectorAll(SEL).forEach((el) => {
      const r = el.getBoundingClientRect();
      const isFile = el.tagName === 'INPUT' && el.type === 'file';
      if (!isFile && !vis(el, r)) return;
      if (el.tagName === 'INPUT' && el.type === 'hidden') return;
      el.setAttribute('data-appgea-id', String(++n));
      let st = [];
      const tag = el.isContentEditable ? 'editable' : el.tagName.toLowerCase() + (el.type && el.tagName === 'INPUT' ? ':' + el.type : '');
      const role = el.getAttribute('role');
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') st.push('disabled');
      if (el.checked || el.getAttribute('aria-checked') === 'true') st.push('checked');
      if (el.getAttribute('aria-selected') === 'true') st.push('selected');
      if (isFile) st.push('accept=' + (el.accept || '*'));
      let val = '';
      if (el.isContentEditable) val = (el.innerText || '').trim();
      else if ('value' in el && el.type !== 'file') val = String(el.value || '');
      out.push({ n, el, line: `[${n}] ${tag}${role ? ' role=' + role : ''} "${label(el)}"${val ? ' value="' + val.replace(/\s+/g, ' ').slice(0, 50) + '"' : ''}${st.length ? ' ' + st.join(' ') : ''}` });
    });
    // Plain divs and spans that act as buttons ("Edit cover"): pointer cursor, short own text, not inside a listed element.
    root.querySelectorAll('div, span, li, label, p, img, svg').forEach((el) => {
      if (el.hasAttribute('data-appgea-id') || el.closest('[data-appgea-id]') || el.querySelector('[data-appgea-id]')) return;
      const s = getComputedStyle(el);
      if (s.cursor !== 'pointer') return;
      const pc = el.parentElement && getComputedStyle(el.parentElement).cursor === 'pointer';
      if (pc && el.parentElement.closest('div, span, li, label, p')) return; // keep the outermost clickable
      const t = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('alt') || '').replace(/\s+/g, ' ').trim();
      const r = el.getBoundingClientRect();
      if (!t || t.length > 40 || !vis(el, r)) return;
      el.setAttribute('data-appgea-id', String(++n));
      out.push({ n, el, line: `[${n}] clickable "${t}"` });
    });
    root.querySelectorAll('*').forEach((el) => {
      if (el.shadowRoot) walk(el.shadowRoot, dx, dy, depth + 1);
      if (el.tagName === 'IFRAME') {
        try { if (el.contentDocument) walk(el.contentDocument, 0, 0, depth + 1); } catch (e) {}
      }
    });
  };
  document.querySelectorAll('[data-appgea-id]').forEach((e) => e.removeAttribute('data-appgea-id'));
  walk(document, 0, 0, 0);
  const top = dialogs.filter((d) => d.getBoundingClientRect().width > 50).pop();
  let items = out;
  if (top) items = out.filter((o) => top.contains(o.el)).concat(out.filter((o) => !top.contains(o.el)));
  const lines = items.slice(0, 260).map((o) => o.line);
  if (items.length > 260) lines.push(`... ${items.length - 260} more not shown`);
  return { url: location.href, title: document.title, elements: (top ? 'A dialog is open; its elements come first.\n' : '') + lines.join('\n') };
}

function pageFind(id) {
  // returns center + label of a tagged element, scrolled into view; walks shadow roots and same-origin frames
  const find = (root, ox, oy) => {
    const el = root.querySelector(`[data-appgea-id="${id}"]`);
    if (el) return { el, ox, oy };
    for (const h of root.querySelectorAll('*')) {
      if (h.shadowRoot) { const f = find(h.shadowRoot, ox, oy); if (f) return f; }
      if (h.tagName === 'IFRAME') {
        try {
          if (h.contentDocument) { const r = h.getBoundingClientRect(); const f = find(h.contentDocument, ox + r.left, oy + r.top); if (f) return f; }
        } catch (e) {}
      }
    }
    return null;
  };
  const f = find(document, 0, 0);
  if (!f) return null;
  f.el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = f.el.getBoundingClientRect();
  const lab = (f.el.getAttribute('aria-label') || f.el.innerText || f.el.value || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return { x: f.ox + r.left + r.width / 2, y: f.oy + r.top + r.height / 2, label: lab, file: f.el.tagName === 'INPUT' && f.el.type === 'file' };
}

function pageLabelAt(x, y) {
  // the clickable thing under a point, through open shadow roots and same-origin frames
  let doc = document, el = null, ox = 0, oy = 0;
  for (let i = 0; i < 8; i++) {
    el = doc.elementFromPoint(x - ox, y - oy);
    while (el && el.shadowRoot) { const inner = el.shadowRoot.elementFromPoint(x - ox, y - oy); if (!inner || inner === el) break; el = inner; }
    if (el && el.tagName === 'IFRAME') {
      try { const r = el.getBoundingClientRect(); ox += r.left; oy += r.top; doc = el.contentDocument; continue; } catch (e) {}
    }
    break;
  }
  if (!el) return '';
  const hit = el.closest('button, a, [role=button], [role=menuitem], [role=link], [role=option]') || el;
  return (hit.getAttribute('aria-label') || hit.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

function pageMark(id) {
  const find = (root) => {
    const el = root.querySelector(`[data-appgea-id="${id}"]`);
    if (el) return el;
    for (const h of root.querySelectorAll('*')) if (h.shadowRoot) { const f = find(h.shadowRoot); if (f) return f; }
    return null;
  };
  const el = find(document);
  if (el) { el.scrollIntoView({ block: 'center' }); el.style.outline = '4px solid #e0245e'; el.style.outlineOffset = '3px'; }
}

// ---------- tab plumbing ----------
async function inPage(tabId, func, args = []) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return r && r.result;
}

const cdp = (tabId, method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params);

async function click(tabId, x, y) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
    await cdp(tabId, 'Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
}

async function typeText(tabId, x, y, text) {
  await click(tabId, x, y);
  await sleep(150);
  const mod = navigator.platform.includes('Mac') ? 4 : 2; // Meta on mac, Ctrl elsewhere
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: mod });
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: mod });
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  // line by line, so editors that eat "\n" in insertText still get paragraphs
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) await cdp(tabId, 'Input.insertText', { text: lines[i] });
    if (i < lines.length - 1) {
      await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', modifiers: 8 });
      await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 });
    }
  }
}

async function upload(tabId, id, path) {
  const expr = `(() => { const f = (r) => { const e = r.querySelector('[data-appgea-id="${id}"]'); if (e) return e;
    for (const h of r.querySelectorAll('*')) { if (h.shadowRoot) { const x = f(h.shadowRoot); if (x) return x; }
      if (h.tagName === 'IFRAME') { try { if (h.contentDocument) { const x = f(h.contentDocument); if (x) return x; } } catch (e) {} } }
    return null; }; return f(document); })()`;
  const { result } = await cdp(tabId, 'Runtime.evaluate', { expression: expr });
  if (!result || !result.objectId) throw new Error('file input not found');
  await cdp(tabId, 'DOM.setFileInputFiles', { files: [path], objectId: result.objectId });
}

async function screenshot(tabId) {
  try {
    const { data } = await cdp(tabId, 'Page.captureScreenshot', { format: 'jpeg', quality: 60 });
    return data;
  } catch (e) { return null; }
}

async function settle(tabId) {
  for (let i = 0; i < 20; i++) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === 'complete') break;
    await sleep(500);
  }
  await sleep(1200);
}

// A click that opens the OS file picker never shows it: the picker waits here, and upload with el 0 fills it.
const chooser = {};
chrome.debugger.onEvent.addListener((src, method, params) => {
  if (method === 'Page.fileChooserOpened') chooser[src.tabId] = params.backendNodeId;
});
chrome.debugger.onDetach.addListener((src) => { attached.delete(src.tabId); });

const attached = new Set();
async function ensure(tabId) {
  if (attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, '1.3');
  attached.add(tabId);
  await cdp(tabId, 'Page.enable');
  await cdp(tabId, 'Page.setInterceptFileChooserDialog', { enabled: true });
}

// ---------- account lock ----------
// upload and type are refused on a tab until `verify` finds the expected account name on the page.
// The names come from accounts.json in this folder, never from the caller. Any page load clears the lock.
const PLATFORM_HOSTS = { youtube: ['studio.youtube.com', 'www.youtube.com'], facebook: ['business.facebook.com', 'www.facebook.com'],
  instagram: ['www.instagram.com'], tiktok: ['www.tiktok.com'], x: ['x.com'] };

async function verified() { return (await chrome.storage.session.get({ verified: {} })).verified; }
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'loading') return;
  const v = await verified();
  if (v[tabId]) { delete v[tabId]; await chrome.storage.session.set({ verified: v }); }
});

function pageText() {
  // visible text plus account-ish attributes (avatar alt, aria-label), through open shadow roots
  const parts = [document.body ? document.body.innerText : ''];
  const walk = (root) => root.querySelectorAll('*').forEach((el) => {
    for (const a of ['alt', 'aria-label', 'title']) { const v = el.getAttribute && el.getAttribute(a); if (v) parts.push(v); }
    if (el.shadowRoot) { parts.push(el.shadowRoot.textContent || ''); walk(el.shadowRoot); }
  });
  walk(document);
  return parts.join('\n');
}

async function verify(tabId, platform) {
  const accounts = await (await fetch(chrome.runtime.getURL('accounts.json'))).json();
  const want = accounts[platform] || [];
  if (!want.length) return { error: `no ${platform} account in accounts.json: copy accounts.example.json and fill it in` };
  const host = new URL((await chrome.tabs.get(tabId)).url).host;
  if (!(PLATFORM_HOSTS[platform] || []).includes(host)) return { error: `tab is on ${host}, not ${platform}` };
  const norm = (s) => s.toLocaleLowerCase('tr').replace(/\s+/g, ' ');
  const text = norm(await inPage(tabId, pageText) || '');
  const hit = want.find((n) => text.includes(norm(n)));
  const wrong = (accounts._never || []).find((n) => text.includes(norm(n)));
  if (!hit) return { error: `account not confirmed: none of ${JSON.stringify(want)} is on the page. Switch account first.` };
  if (wrong) return { error: `"${wrong}" is on the page (accounts.json _never). Switch account first.` };
  const v = await verified();
  v[tabId] = platform;
  await chrome.storage.session.set({ verified: v });
  return { ok: true, account: hit };
}

const KEYS = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Space: 32 };

// ---------- commands from the relay ----------
async function run(c) {
  const tabId = c.tab;
  if (c.op === 'open') {
    const win = await chrome.windows.create({ url: c.url, focused: true, width: 1400, height: 950 });
    const id = win.tabs[0].id;
    await settle(id);
    await ensure(id);
    return { tab: id };
  }
  if (c.op === 'tabs') {
    const ts = await chrome.tabs.query({});
    return { tabs: ts.map((t) => ({ tab: t.id, url: t.url, title: t.title })) };
  }
  if (c.op === 'close') { await chrome.tabs.remove(tabId); return { ok: true }; }
  if (c.op === 'reload') { setTimeout(() => chrome.runtime.reload(), 300); return { ok: true, note: 'extension reloading from disk' }; }
  await ensure(tabId);
  await settle(tabId);
  if (c.op === 'verify') return verify(tabId, c.platform);
  if ((c.op === 'upload' || c.op === 'type') && !(await verified())[tabId])
    return { error: 'locked: run verify <tab> <platform> first. Uploads and typing need a confirmed account.' };
  if (c.op === 'snap') {
    const s = await inPage(tabId, pageSnapshot);
    if (chooser[tabId]) s.elements = 'A file picker is waiting: upload with el 0.\n' + s.elements;
    return s;
  }
  if (c.op === 'shot') {
    const data = await screenshot(tabId);
    return data ? { shot: data } : { error: 'screenshot failed' };
  }
  if (c.op === 'key') {
    const k = c.key, code = KEYS[k] || k.toUpperCase().charCodeAt(0);
    await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: code, text: k === 'Enter' ? '\r' : undefined });
    await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: code });
    return { ok: true };
  }
  if (c.op === 'scroll') {
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: 600, y: 450, deltaX: 0, deltaY: c.dy });
    return { ok: true };
  }
  if (c.op === 'upload' && c.el === 0) {
    if (!chooser[tabId]) return { error: 'no file picker is waiting' };
    await cdp(tabId, 'DOM.setFileInputFiles', { files: [c.path], backendNodeId: chooser[tabId] });
    delete chooser[tabId];
    return { ok: true };
  }
  if (c.op === 'mark') { await inPage(tabId, pageMark, [c.el]); return { ok: true }; }
  if (c.op === 'clickxy') {
    // the guard applies here too: read what sits under the point first
    const label = await inPage(tabId, pageLabelAt, [c.x, c.y]);
    if (isFinal((await chrome.tabs.get(tabId)).url, label) && !c.publish)
      return { error: `refused: "${label}" at that point is the publish button. Pass publish only on the user's explicit go.` };
    await click(tabId, c.x, c.y);
    return { ok: true, clicked: label };
  }
  const el = await inPage(tabId, pageFind, [c.el]);
  if (!el) return { error: `element ${c.el} not found: snapshot again` };
  if (c.op === 'click') {
    const isPublish = isFinal((await chrome.tabs.get(tabId)).url, el.label);
    if (isPublish && !c.publish) {
      await inPage(tabId, pageMark, [c.el]);
      return { error: `refused: "${el.label}" is the publish button. It is outlined red for the human. Pass publish only on the user's explicit go.` };
    }
    await click(tabId, el.x, el.y);
    return { ok: true, clicked: el.label };
  }
  if (c.op === 'type') { await typeText(tabId, el.x, el.y, c.text || ''); return { ok: true }; }
  if (c.op === 'upload') { await upload(tabId, c.el, c.path); return { ok: true }; }
  return { error: 'unknown op ' + c.op };
}

let polling = false;
const lanes = {};
async function loop() {
  if (polling) return;
  polling = true;
  try {
    for (;;) {
      const r = await api('/poll');
      if (r.error) throw new Error(r.error); // refused: stop until the next alarm
      const cmd = r.cmd;
      if (!cmd) continue;
      // Tabs run in parallel; commands for the same tab keep their order.
      const key = cmd.tab ?? 'global';
      lanes[key] = (lanes[key] || Promise.resolve()).then(async () => {
        let res;
        try { res = await run(cmd); } catch (e) { res = { error: String(e.message || e) }; }
        try { await api('/result', { id: cmd.id, ...res }); } catch (e) {}
      });
    }
  } catch (e) {
    // relay down; the alarm retries
  } finally {
    polling = false;
  }
}

chrome.alarms.create('wake', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => loop());
chrome.runtime.onStartup.addListener(() => loop());
chrome.runtime.onInstalled.addListener(() => loop());
chrome.runtime.onMessage.addListener((m, _s, reply) => {
  if (m === 'ping') { loop(); api('/ping').then(reply, (e) => reply({ error: String(e) })); }
  return true;
});
loop();
