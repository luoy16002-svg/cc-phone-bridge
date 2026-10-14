// End-to-end checks against a real server on a test port, with the fake Claude Code writing real transcript files
// into a temporary Claude config folder. Usage: node test/smoke.mjs
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPrivate, hostAllowed } from '../lib/net.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 18061;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpb-test-'));
const CONF = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpb-conf-'));
const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpb-projects-'));
const CWD = path.join(PROJ, 'demo');
fs.mkdirSync(CWD);
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpb-outside-'));
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ roots: [PROJ], timeZone: 'America/Los_Angeles' }));
fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ pushOnFinish: false }));
fs.writeFileSync(path.join(CONF, 'settings.json'), JSON.stringify({ model: 'opus', modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' } } }));
process.env.CCPB_CONFIG_DIR = CONF;
process.env.CCPB_SHOW_TEMP = '1';
const FAKE = path.join(ROOT, 'test', 'fake-claude.mjs');
let server = null;
let token = null;
let failures = 0;
let count = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, extra = '') {
  count++;
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

function startServer() {
  server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, CCPB_PORT: String(PORT), CCPB_DATA: DATA, CCPB_CONFIG_DIR: CONF, CCPB_SHOW_TEMP: '1', CCPB_CLAUDE_CMD: JSON.stringify([process.execPath, FAKE]) },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/api/ping`)).ok) return true;
    } catch { /* not yet */ }
    await sleep(100);
  }
  return false;
}

async function api(method, p, body, tk = token) {
  const r = await fetch(BASE + p, { method, headers: { ...(tk ? { Authorization: `Bearer ${tk}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch { data = text; }
  return { status: r.status, data };
}

function listen(sid) {
  const got = [];
  const ctrl = new AbortController();
  (async () => {
    try {
      const r = await fetch(`${BASE}/api/sessions/${sid}/stream`, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal });
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /event: (\w+)/.exec(chunk)?.[1];
          const data = /data: (.*)/.exec(chunk)?.[1];
          if (ev && data) got.push({ ev, ...JSON.parse(data) });
        }
      }
    } catch { /* aborted */ }
  })();
  return {
    got,
    stop: () => ctrl.abort(),
    async until(pred, ms = 8000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const hit = got.find(pred);
        if (hit) return hit;
        await sleep(30);
      }
      return null;
    },
    count: (pred) => got.filter(pred).length,
  };
}

const png1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const results = (L) => L.count((e) => e.k === 'result');

// A session made "on the PC" before the phone ever saw it, with a long history.
function seedPcSession() {
  const id = crypto.randomUUID();
  const dir = path.join(CONF, 'projects', CWD.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const lines = [];
  let parent = null;
  for (let i = 1; i <= 220; i++) {
    const u = crypto.randomUUID();
    lines.push({ type: 'user', uuid: u, parentUuid: parent, cwd: CWD, sessionId: id, timestamp: new Date(Date.now() - (300 - i) * 60000).toISOString(), message: { role: 'user', content: `电脑上的第 ${i} 个问题` } });
    const a = crypto.randomUUID();
    lines.push({ type: 'assistant', uuid: a, parentUuid: u, cwd: CWD, sessionId: id, timestamp: new Date(Date.now() - (300 - i) * 60000 + 1000).toISOString(), message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: `echo ${i}`, description: `第 ${i} 步` } }] } });
    const r = crypto.randomUUID();
    lines.push({ type: 'user', uuid: r, parentUuid: a, cwd: CWD, sessionId: id, timestamp: new Date(Date.now() - (300 - i) * 60000 + 2000).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: String(i) }] } });
    const b = crypto.randomUUID();
    lines.push({ type: 'assistant', uuid: b, parentUuid: r, cwd: CWD, sessionId: id, timestamp: new Date(Date.now() - (300 - i) * 60000 + 3000).toISOString(), message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: `电脑上的第 ${i} 个回答` }] } });
    parent = b;
  }
  lines.push({ type: 'user', uuid: crypto.randomUUID(), cwd: CWD, sessionId: id, timestamp: new Date().toISOString(), message: { role: 'user', content: '<command-name>/model</command-name>\n<command-args>opus</command-args>' } });
  lines.push({ type: 'user', isMeta: true, uuid: crypto.randomUUID(), cwd: CWD, sessionId: id, timestamp: new Date().toISOString(), message: { role: 'user', content: '<local-command-stdout>Set model</local-command-stdout>' } });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return id;
}

async function main() {
  console.log('unit: who may connect');
  check('LAN address is private', isPrivate('192.168.1.30') && isPrivate('::ffff:10.0.0.7') && isPrivate('100.64.1.2'));
  check('public address is not private', !isPrivate('8.8.8.8') && !isPrivate('::ffff:1.2.3.4') && !isPrivate('198.18.0.1'));
  check('host header checks', hostAllowed('192.168.1.20:8060') && hostAllowed('localhost:8060') && !hostAllowed('evil.example') && !hostAllowed('1.2.3.4:8060'));

  const pcId = seedPcSession();
  startServer();
  check('server starts', await waitUp());

  console.log('pairing and access');
  const pc = await api('GET', '/pc/state', null, null);
  check('PC page state readable from this machine', pc.status === 200 && /^\d{6}$/.test(pc.data.code));
  check('PC actions need the X-PC header', (await api('POST', '/pc/rotate', null, null)).status === 403);
  check('wrong code refused', (await api('POST', '/api/pair', { code: pc.data.code === '000000' ? '111111' : '000000' }, null)).status === 403);
  const ok = await api('POST', '/api/pair', { code: pc.data.code, name: '测试手机' }, null);
  check('right code gives a token', ok.status === 200 && ok.data.token?.length > 30);
  token = ok.data.token;
  check('a code works once', (await api('POST', '/api/pair', { code: pc.data.code }, null)).status === 403);
  check('no token: 401', (await api('GET', '/api/sessions', null, null)).status === 401);
  const evil = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: PORT, path: '/api/ping', headers: { Host: 'evil.example' } }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', () => resolve(0));
  });
  check('foreign Host header refused', evil === 421);

  console.log('state and the PC session');
  const st = await api('GET', '/api/state');
  check('defaults come from the PC settings', st.data.defaults?.model === 'claude-opus-5-5' && st.data.defaults?.effort === 'xhigh' && st.data.defaults?.modelName === 'Opus 5.5', JSON.stringify(st.data.defaults));
  const list1 = await api('GET', '/api/sessions');
  const pcS = list1.data.sessions.find((s) => s.id === pcId);
  check('the PC session is listed with its title, folder, the model it used last and the one it will use', pcS && pcS.title === '电脑上的第 1 个问题' && pcS.lastModel === 'Sonnet 5.5' && pcS.modelName === 'Opus 5.5' && pcS.effort === 'xhigh' && pcS.folder === 'demo', JSON.stringify(pcS));
  const page1 = await api('GET', `/api/sessions/${pcId}`);
  const ev1 = page1.data.events;
  check('history: latest page only, with more before', page1.data.hasMore === true && ev1.length >= 140 && ev1.length < 260, `${ev1.length} ${page1.data.hasMore}`);
  check('history: newest prompt and reply are there', ev1.some((e) => e.k === 'user' && e.text === '电脑上的第 220 个问题') && ev1.some((e) => e.k === 'text' && e.text === '电脑上的第 220 个回答'));
  check('history: a slash command reads as the command', ev1.some((e) => e.k === 'user' && e.command && e.text === '/model opus'));
  check('history: command output lines are left out', !ev1.some((e) => /local-command-stdout/.test(e.text || '')));
  const t220 = ev1.find((e) => e.k === 'tool' && e.tool === 't220');
  check('history: tool calls with their summary', t220 && t220.name === 'Bash' && t220.summary === '第 220 步');
  check('history: page starts at a prompt', ev1[0].k === 'user');
  const page2 = await api('GET', `/api/sessions/${pcId}/history?before=${page1.data.cursor}`);
  const ids1 = new Set(ev1.map((e) => e.id));
  check('older page: no overlap, ends right before the first page', page2.data.events.length > 50 && !page2.data.events.some((e) => ids1.has(e.id)));
  let cursor = page2.data.cursor;
  let all = page2.data.events.length + ev1.length;
  while (cursor) {
    const more = await api('GET', `/api/sessions/${pcId}/history?before=${cursor}`);
    all += more.data.events.length;
    cursor = more.data.hasMore ? more.data.cursor : 0;
  }
  check('paging reaches the start: every event once', all === 220 * 4 + 1, String(all));

  console.log('continue the PC session from the phone');
  fs.mkdirSync(path.join(CONF, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(CONF, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: pcId, cwd: CWD, kind: 'interactive' }));
  check('open on the PC is flagged', (await api('GET', '/api/sessions')).data.sessions.find((s) => s.id === pcId)?.openOnPc === true);
  const L = listen(pcId);
  await sleep(150);
  const m1 = await api('POST', `/api/sessions/${pcId}/messages`, { text: 'hello from the phone' });
  check('message accepted', m1.status === 200 && m1.data.queued === false);
  const r1 = await L.until((e) => e.k === 'result');
  check('turn finished ok', r1 && r1.ok === true);
  check('reply streamed with the effort passed on', !!L.got.find((e) => e.k === 'text' && e.text === '收到：hello from the phone (xhigh)'), JSON.stringify(L.got.filter((e) => e.k === 'text')));
  check('live deltas streamed', L.count((e) => e.ev === 'tr' && e.k === 'delta') >= 2);
  const after = await api('GET', `/api/sessions/${pcId}`);
  const evA = after.data.events;
  check('same session: the old history and the new turn together', evA.some((e) => e.text === '电脑上的第 220 个回答') && evA.some((e) => e.k === 'user' && e.text === 'hello from the phone') && evA.some((e) => e.k === 'text' && e.text === '收到：hello from the phone (xhigh)'), JSON.stringify(evA.slice(-6).map((e) => [e.k, e.text || e.summary || ''])));
  const summ = (await api('GET', '/api/sessions')).data.sessions.find((s) => s.id === pcId);
  check('model shown is the one the turn used', summ.model === 'claude-opus-5-5' && (await api('GET', `/api/sessions/${pcId}`)).data.events.filter((e) => e.k === 'text').pop()?.model === 'claude-opus-5-5');

  console.log('tools, queue, interrupt');
  await api('POST', `/api/sessions/${pcId}/messages`, { text: 'please use a tool' });
  await L.until(() => results(L) >= 2);
  const h2 = (await api('GET', `/api/sessions/${pcId}`)).data.events;
  const read = h2.find((e) => e.k === 'tool' && e.name === 'Read');
  check('tool call in history with a short path', read && read.summary === 'README.md');
  check('tool result linked to the call', h2.some((e) => e.k === 'tool_result' && read && e.tool === read.tool && e.ok));
  const slow = await api('POST', `/api/sessions/${pcId}/messages`, { text: 'slow job' });
  const queued = await api('POST', `/api/sessions/${pcId}/messages`, { text: 'after slow' });
  check('second message queued while busy', slow.data.queued === false && queued.data.queued === true);
  await L.until((e) => e.k === 'tool' && e.tool === 'tool-slow');
  check('interrupt accepted', (await api('POST', `/api/sessions/${pcId}/interrupt`)).data.ok === true);
  const r3 = await L.until((e) => e.k === 'result' && e.reason === 'aborted_tools');
  check('turn ends as stopped', r3 && r3.ok === false);
  check('queued message canceled', !!L.got.find((e) => e.k === 'user' && e.id === queued.data.id && e.state === 'canceled'));
  await api('POST', `/api/sessions/${pcId}/messages`, { text: 'still there' });
  check('answers after an interrupt', !!(await L.until((e) => e.k === 'text' && /收到：still there/.test(e.text))));

  console.log('images');
  const im = await api('POST', `/api/sessions/${pcId}/messages`, { text: 'look', images: [{ type: 'image/png', data: png1x1 }] });
  check('image message accepted', im.status === 200);
  check('image reached Claude Code as an image block', !!(await L.until((e) => e.k === 'text' && e.text === 'got 1 image')));
  const ue = L.got.find((e) => e.k === 'user' && e.id === im.data.id);
  const ref = ue && ue.images[0];
  const f = await fetch(`${BASE}/api/files/${ref}`, { headers: { Authorization: `Bearer ${token}` } });
  check('the phone can read its picture back', f.status === 200 && f.headers.get('content-type') === 'image/png');
  check('picture needs the token', (await fetch(`${BASE}/api/files/${ref}`)).status === 401);
  check('bad image type refused', (await api('POST', `/api/sessions/${pcId}/messages`, { text: 'x', images: [{ type: 'text/html', data: 'PGI+' }] })).status === 400);
  const hImg = (await api('GET', `/api/sessions/${pcId}`)).data.events;
  check('history shows a picture was sent', hImg.some((e) => e.k === 'user' && e.text === 'look' && e.images === 1));

  console.log('model and effort');
  const pr = await api('PUT', `/api/sessions/${pcId}/prefs`, { model: 'claude-haiku-5-5', effort: 'low' });
  check('prefs saved', pr.data.session?.modelName === 'Haiku 5.5' && pr.data.session?.effort === 'low', JSON.stringify(pr.data));
  await api('POST', `/api/sessions/${pcId}/messages`, { text: 'which effort' });
  check('next turn runs with the new effort', !!(await L.until((e) => e.k === 'text' && e.text === '收到：which effort (low)')));
  check('and the new model', (await api('GET', `/api/sessions/${pcId}`)).data.events.filter((e) => e.k === 'text').pop()?.model === 'claude-haiku-5-5');

  console.log('crash');
  await api('POST', `/api/sessions/${pcId}/messages`, { text: 'crash now' });
  const r6 = await L.until((e) => e.k === 'result' && e.reason === 'exit');
  check('a crash ends the turn with a note', r6 && !!L.got.find((e) => e.k === 'note' && /中途退出/.test(e.text) && /boom/.test(e.text)));
  await api('POST', `/api/sessions/${pcId}/messages`, { text: 'hello again' });
  check('the next message resumes the same session', !!(await L.until((e) => e.k === 'text' && /收到：hello again/.test(e.text))));
  await sleep(300);

  console.log('a turn run on the PC shows up live');
  const reg = path.join(CONF, 'sessions', `${process.pid}.json`);
  fs.writeFileSync(reg, JSON.stringify({ pid: process.pid, sessionId: pcId, cwd: CWD, kind: 'interactive', status: 'busy' }));
  check('busy on the PC is pushed to the open page', !!(await L.until((e) => e.ev === 'tr' && e.k === 'pc' && e.busy === true, 5000)));
  check('and shown in the list', (await api('GET', '/api/sessions')).data.sessions.find((s) => s.id === pcId)?.pcBusy === true);
  const tfile = path.join(CONF, 'projects', CWD.replace(/[^a-zA-Z0-9]/g, '-'), `${pcId}.jsonl`);
  const line = (o) => fs.appendFileSync(tfile, `${JSON.stringify({ uuid: crypto.randomUUID(), cwd: CWD, sessionId: pcId, timestamp: new Date().toISOString(), ...o })}\n`);
  line({ type: 'user', message: { role: 'user', content: '在电脑上打的' } });
  line({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'pc-tool-1', name: 'Grep', input: { pattern: 'todo' } }] } });
  line({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: '电脑上的回答' }] } });
  check('the PC turn streams to the phone as it is written', !!(await L.until((e) => e.ev === 'ev' && e.pc && e.k === 'text' && e.text === '电脑上的回答', 6000))
    && L.got.some((e) => e.ev === 'ev' && e.pc && e.k === 'user' && e.text === '在电脑上打的') && L.got.some((e) => e.ev === 'ev' && e.pc && e.k === 'tool' && e.name === 'Grep'));
  const n0 = L.got.length;
  fs.writeFileSync(reg, JSON.stringify({ pid: process.pid, sessionId: pcId, cwd: CWD, kind: 'interactive', status: 'idle' }));
  check('and the end of it', !!(await L.until((e, i) => i >= n0 && e.ev === 'tr' && e.k === 'pc' && e.busy === false, 5000)));
  L.stop();

  console.log('themes');
  const st2 = (await api('GET', '/api/state')).data;
  check('themes listed with the auto pair', st2.themes?.length >= 2 && st2.server.theme?.light && st2.server.theme?.dark && st2.themes.every((t) => t.swatch?.length === 3), JSON.stringify(st2.server.theme));
  check('time zone from the config', st2.server.timeZone === 'America/Los_Angeles');
  const lightCss = await (await fetch(`${BASE}/theme/light.css`)).text();
  const darkCss = await (await fetch(`${BASE}/theme/dark.css`)).text();
  check('the light and dark theme sheets are served', /color-scheme: light/.test(lightCss) && /--paper/.test(lightCss) && /color-scheme: dark/.test(darkCss));
  check('every theme colour lives in the theme', !/#[0-9a-f]{3,8}\b|rgba?\(/i.test(fs.readFileSync(path.join(ROOT, 'public', 'app.css'), 'utf8')));
  check('a theme id cannot climb out', (await fetch(`${BASE}/themes/..%2F..%2Fpackage.json`)).status !== 200);

  console.log('a new conversation and folders');
  const top = await api('GET', '/api/browse');
  check('browsing starts at the first root, with recent folders', top.status === 200 && top.data.path === PROJ && top.data.parent === null && top.data.dirs.some((d) => d.name === 'demo' && d.cc === true) && top.data.recent?.some((d) => d.path === CWD), JSON.stringify(top.data));
  fs.mkdirSync(path.join(CWD, 'src', 'deep'), { recursive: true });
  const inner = await api('GET', `/api/browse?path=${encodeURIComponent(path.join(CWD, 'src'))}`);
  check('a folder inside can be opened, with its parent', inner.status === 200 && inner.data.parent === CWD && inner.data.dirs.some((d) => d.name === 'deep'));
  check('a folder outside the roots cannot be opened', (await api('GET', `/api/browse?path=${encodeURIComponent(OUTSIDE)}`)).status === 403);
  check('nor climbed to', (await api('GET', `/api/browse?path=${encodeURIComponent(path.join(PROJ, '..'))}`)).status === 403);
  try {
    fs.symlinkSync(OUTSIDE, path.join(PROJ, 'link-out'), process.platform === 'win32' ? 'junction' : 'dir');
    const viaLink = await api('GET', `/api/browse?path=${encodeURIComponent(path.join(PROJ, 'link-out'))}`);
    const listed = (await api('GET', '/api/browse')).data.dirs.some((d) => d.name === 'link-out');
    check('a link pointing outside is neither listed nor opened', viaLink.status === 403 && !listed);
  } catch (e) {
    console.log(`  skip link check (${e.code})`);
  }
  const mk = await api('POST', '/api/dirs', { parent: PROJ, name: '新项目 1' });
  check('a new folder can be made', mk.status === 200 && fs.existsSync(path.join(PROJ, '新项目 1')));
  const mk2 = await api('POST', '/api/dirs', { parent: path.join(CWD, 'src'), name: 'more' });
  check('also deeper down', mk2.status === 200 && fs.existsSync(path.join(CWD, 'src', 'more')));
  check('a folder name cannot climb out', (await api('POST', '/api/dirs', { parent: PROJ, name: '../escape' })).status === 400);
  check('reserved device names are refused', (await api('POST', '/api/dirs', { parent: PROJ, name: 'con' })).status === 400);
  check('nothing can be made outside the roots', (await api('POST', '/api/dirs', { parent: OUTSIDE, name: 'x' })).status === 403);
  check('an existing folder is not made twice', (await api('POST', '/api/dirs', { parent: PROJ, name: '新项目 1' })).status === 409);
  check('a conversation cannot start outside the roots', (await api('POST', '/api/sessions', { cwd: OUTSIDE, text: 'x' })).status === 403);
  const ns = await api('POST', '/api/sessions', { cwd: mk.data.path, model: 'claude-sonnet-5-5', effort: 'high', text: '第一句话' });
  check('a new session starts and has its own id', ns.status === 200 && /^[0-9a-f-]{36}$/.test(ns.data.id), JSON.stringify(ns.data));
  await sleep(500);
  const nl = (await api('GET', '/api/sessions')).data.sessions.find((s) => s.id === ns.data.id);
  check('it is listed with its folder, title, model and effort', nl && nl.folder === '新项目 1' && nl.title === '第一句话' && nl.modelName === 'Sonnet 5.5' && nl.effort === 'high', JSON.stringify(nl));
  const nh = (await api('GET', `/api/sessions/${ns.data.id}`)).data.events;
  check('its reply is in its history', nh.some((e) => e.k === 'text' && e.text === '收到：第一句话 (high)'));
  check('a bad folder is refused', (await api('POST', '/api/sessions', { cwd: path.join(PROJ, 'nope'), text: 'x' })).status === 400);

  console.log('restart while a turn runs');
  const L3 = listen(ns.data.id);
  await api('POST', `/api/sessions/${ns.data.id}/messages`, { text: 'slow again' });
  await L3.until((e) => e.k === 'tool' && e.tool === 'tool-slow');
  L3.stop();
  const gone = new Promise((r) => server.once('exit', r));
  server.kill();
  await Promise.race([gone, sleep(8000)]);
  startServer();
  check('server comes back', await waitUp());
  const L4 = listen(ns.data.id);
  await sleep(200);
  await api('POST', `/api/sessions/${ns.data.id}/messages`, { text: 'after restart' });
  check('works after the restart (resume)', !!(await L4.until((e) => e.k === 'text' && /收到：after restart/.test(e.text))));
  L4.stop();

  console.log(`\n${count - failures}/${count} checks passed`);
}

try {
  await main();
} catch (e) {
  failures++;
  console.log('ERROR', e.stack || e);
} finally {
  server?.kill();
  await sleep(500);
  for (const d of [DATA, CONF, PROJ, OUTSIDE]) fs.rmSync(d, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
