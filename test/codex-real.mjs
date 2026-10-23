// End-to-end with the real Codex: Duty Desk on a test port, a throwaway CODEX_HOME, a local stand-in for the model
// (test/mock-responses.mjs, so no account or quota is used), and a second `codex app-server` playing the Codex app
// on the computer. It checks that the phone and the computer stay connected: the computer's turns show on the phone
// as they happen, a thread the computer holds is seen as held and the phone goes on in a branch, branches carry the
// right history, and the computer sees what the phone wrote. Skipped when codex is not installed.
// Usage: node test/codex-real.mjs   (CCPB_REAL_CODEX=<path> picks the executable)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { startMockModel, mockConfig } from './mock-responses.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 18063;
const BASE = `http://127.0.0.1:${PORT}`;

function findCodex() {
  if (process.env.CCPB_REAL_CODEX) return process.env.CCPB_REAL_CODEX;
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    for (const ext of exts) {
      const full = path.join(dir, `codex${ext}`);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch { /* not here */ }
    }
  }
  return '';
}
const CODEX = findCodex();
if (!CODEX) {
  console.log('codex is not installed: real Codex checks skipped');
  process.exit(0);
}

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const DATA = tmp('ccpb-real-data-');
const CONF = tmp('ccpb-real-claude-');
const HOME = tmp('ccpb-real-home-');
const PROJ = tmp('ccpb-real-projects-');
const CWD = path.join(PROJ, 'demo');
fs.mkdirSync(CWD);
const mock = await startMockModel();
fs.writeFileSync(path.join(HOME, 'config.toml'), mockConfig(mock.port));
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ roots: [PROJ], timeZone: 'America/Los_Angeles', codex: { home: HOME, command: CODEX } }));
fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ pushOnFinish: false }));

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

// ---- the computer: a real app server of its own, as the Codex app runs one
function computer() {
  const child = spawn(CODEX, ['app-server'], { env: { ...process.env, CODEX_HOME: HOME }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stderr.on('data', () => {});
  const rl = readline.createInterface({ input: child.stdout });
  let next = 1;
  const waiting = new Map();
  const notes = [];
  const listeners = new Set();
  rl.on('line', (l) => {
    let m;
    try {
      m = JSON.parse(l);
    } catch {
      return;
    }
    if (m.id != null && m.method == null && waiting.has(m.id)) {
      waiting.get(m.id)(m);
      waiting.delete(m.id);
      return;
    }
    if (m.method) {
      notes.push({ ...m, at: Date.now() });
      for (const f of listeners) f(m);
    }
  });
  const exited = new Promise((r) => child.on('exit', r));
  const call = (method, params) => new Promise((res) => {
    const id = next++;
    waiting.set(id, res);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const until = (pred, ms = 30000) => new Promise((res, rej) => {
    const hit = notes.find(pred);
    if (hit) return res(hit);
    const t = setTimeout(() => { listeners.delete(f); rej(new Error('computer: timed out')); }, ms);
    const f = (m) => {
      if (pred(m)) {
        clearTimeout(t);
        listeners.delete(f);
        res({ ...m, at: Date.now() });
      }
    };
    listeners.add(f);
  });
  return {
    notes, call, until, exited,
    async init() {
      await call('initialize', { clientInfo: { name: 'computer', version: '0' } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
    },
    async turn(threadId, text) {
      const r = await call('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] });
      if (r.error) throw new Error(r.error.message);
      const turnId = r.result.turn.id;
      await until((m) => m.method === 'turn/completed' && m.params.turn.id === turnId);
      return turnId;
    },
    async close() {
      child.stdin.end();
      await Promise.race([exited, sleep(5000)]);
    },
  };
}

// ---- the phone
let server = null;
let H = {};
const api = async (method, p, body) => {
  const r = await fetch(`${BASE}${p}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
function follow(id) {
  const ctrl = new AbortController();
  const evs = [];
  (async () => {
    const res = await fetch(`${BASE}/api/sessions/${id}/stream`, { headers: H, signal: ctrl.signal });
    const reader = res.body.getReader();
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
        if (data) evs.push({ ev, d: JSON.parse(data), at: Date.now() });
      }
    }
  })().catch(() => null);
  return {
    evs,
    async until(pred, ms = 20000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const hit = evs.find(pred);
        if (hit) return hit;
        await sleep(25);
      }
      return null;
    },
    stop() { ctrl.abort(); },
  };
}
const replyOf = async (sid, re, ms = 30000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await api('GET', `/api/sessions/${sid}`);
    const hit = (r.body.events || []).find((e) => e.k === 'text' && re.test(e.text));
    if (hit) return { said: hit.text, events: r.body.events, session: r.body.session };
    await sleep(150);
  }
  return { said: null, events: [], session: null };
};
const lockFile = (tid) => path.join(HOME, 'thread-writer-locks', `${tid}.lock`);

let desk = null;
try {
  console.log(`real Codex: ${path.basename(CODEX)} in a throwaway CODEX_HOME, model stand-in on port ${mock.port}`);
  // the computer starts a conversation before the phone looks
  desk = computer();
  await desk.init();
  const st = await desk.call('thread/start', { cwd: CWD });
  const tid = st.result.thread.id;
  await desk.turn(tid, '第一句');
  await desk.turn(tid, '第二句');

  server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, CCPB_PORT: String(PORT), CCPB_DATA: DATA, CCPB_CONFIG_DIR: CONF, CODEX_HOME: HOME,
      CCPB_CLAUDE_CMD: JSON.stringify([process.execPath, path.join(ROOT, 'test', 'fake-claude.mjs')]) },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try {
      up = (await fetch(`${BASE}/api/ping`)).ok;
    } catch { await sleep(100); }
  }
  check('server starts', up);
  const pc = await (await fetch(`${BASE}/pc/state`)).json();
  const pair = await (await fetch(`${BASE}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: pc.code, name: 'test' }) })).json();
  H = { Authorization: `Bearer ${pair.token}`, 'Content-Type': 'application/json' };

  const list = await api('GET', '/api/sessions');
  const card = list.body.sessions?.find((s) => s.id === tid);
  check('the computer\'s conversation is on the phone\'s list', card?.agent === 'codex' && /第一句/.test(card.title || ''), JSON.stringify(card));
  check('and reads as open on the computer (the computer holds it)', card?.held === true && card?.openOnPc === true);
  const one = await api('GET', `/api/sessions/${tid}`);
  const users = (one.body.events || []).filter((e) => e.k === 'user');
  check('its history has both prompts, each with its turn', users.map((e) => e.text).join('|') === '第一句|第二句' && users.every((e) => e.turn), JSON.stringify(users));
  check('and the replies', (one.body.events || []).some((e) => e.k === 'text' && e.text === '收到：第二句 · 之前：第一句'));

  // a turn on the computer shows on the phone as it happens
  const f = follow(tid);
  await sleep(500);
  const deskTurn = desk.turn(tid, '第三句 SLOW');
  const busy = await f.until((x) => x.ev === 'tr' && x.d.k === 'pc' && x.d.busy, 15000);
  check('a turn starting on the computer shows on the phone', !!busy);
  const pcText = await f.until((x) => x.ev === 'ev' && x.d.pc && x.d.k === 'text', 30000);
  const done = await desk.until((m) => m.method === 'item/completed' && m.params.item?.type === 'agentMessage' && /第三句/.test(m.params.item.text || ''));
  await deskTurn;
  check('its reply reaches the phone', pcText?.d.text === '收到：第三句 SLOW · 之前：第一句 | 第二句', pcText?.d.text);
  check('within a moment of the computer having it', !!pcText && Math.abs(pcText.at - done.at) < 1500, pcText ? `${pcText.at - done.at} ms` : '');
  check('with its turn, so the phone can branch from it', !!pcText?.d.turn);
  const idle = await f.until((x) => x.ev === 'tr' && x.d.k === 'pc' && !x.d.busy && f.evs.indexOf(x) > f.evs.indexOf(busy), 10000);
  check('and the end of the turn', !!idle && idle.d.held === true);

  // the computer still holds the thread: the phone goes on in a branch
  const refused = await api('POST', `/api/sessions/${tid}/messages`, { text: '想接着说' });
  check('a message for the held thread is turned back so the phone branches', refused.status === 409 && refused.body.error === 'pc_holds', JSON.stringify(refused));
  const b1 = await api('POST', `/api/sessions/${tid}/fork`, { text: '分支里的话' });
  check('a branch starts while the computer holds the thread', b1.status === 200 && b1.body.id && b1.body.id !== tid, JSON.stringify(b1.body));
  const r1 = await replyOf(b1.body.id, /^收到：分支里的话/);
  check('the branch carries the whole conversation', r1.said === '收到：分支里的话 · 之前：第一句 | 第二句 | 第三句 SLOW', r1.said);
  check('and says where it came from', r1.session?.from?.id === tid, JSON.stringify(r1.session?.from));
  const deskList = await desk.call('thread/list', { limit: 20, sortKey: 'updated_at', useStateDbOnly: true });
  const seen = (deskList.result?.data || []).find((t) => t.id === b1.body.id);
  check('the computer\'s Codex lists the branch, named as one', !!seen && /^(分支|Branch) · /.test(seen.name || ''), JSON.stringify(seen && { name: seen.name }));

  // a branch from a message: what came before it, and the edited message
  const second = users.find((e) => e.text === '第二句');
  const b2 = await api('POST', `/api/sessions/${tid}/fork`, { turn: second.turn, text: '改过的第二句' });
  const r2 = await replyOf(b2.body.id, /^收到：改过的第二句/);
  check('a branch from a message keeps only what came before it', b2.status === 200 && r2.said === '收到：改过的第二句 · 之前：第一句', r2.said);
  const first = users.find((e) => e.text === '第一句');
  const b3 = await api('POST', `/api/sessions/${tid}/fork`, { turn: first.turn, text: '重新开始' });
  const r3 = await replyOf(b3.body.id, /^收到：重新开始/);
  check('a branch from the first message is a fresh thread in the same folder', b3.status === 200 && r3.said === '收到：重新开始' && r3.session?.cwd?.toLowerCase() === CWD.toLowerCase(), JSON.stringify([r3.said, r3.session?.cwd]));

  // the computer lets go: the phone sees it and writes the same thread
  await desk.close();
  desk = null;
  const free = await f.until((x) => x.ev === 'tr' && x.d.k === 'pc' && x.d.held === false, 5000);
  check('the computer letting go shows on the phone', !!free);
  const inPlace = await api('POST', `/api/sessions/${tid}/messages`, { text: '手机接着说' });
  const said = await f.until((x) => x.ev === 'ev' && x.d.k === 'text' && /^收到：手机接着说/.test(x.d.text), 30000);
  check('then the phone continues the very same thread', inPlace.status === 200 && said?.d.text === '收到：手机接着说 · 之前：第一句 | 第二句 | 第三句 SLOW', said?.d.text || JSON.stringify(inPlace.body));
  check('with the reply streamed word by word', f.evs.filter((x) => x.ev === 'tr' && x.d.k === 'delta').length > 3);
  let released = false;
  for (let i = 0; i < 60 && !released; i++) {
    released = !fs.existsSync(lockFile(tid));
    if (!released) await sleep(100);
  }
  check('and lets go of it after the turn, leaving no lock file behind', released);

  // the computer opens it again and finds what the phone wrote
  desk = computer();
  await desk.init();
  const again = await desk.call('thread/resume', { threadId: tid, excludeTurns: true });
  check('the computer can open the thread again', !again.error, again.error?.message);
  const items = await desk.call('thread/items/list', { threadId: tid, limit: 50, sortDirection: 'desc' });
  const texts = (items.result?.data || []).map((e) => e.item).filter((i) => i.type === 'userMessage').map((i) => (i.content || []).map((c) => c.text).join(''));
  check('and sees the phone\'s message in it', texts.includes('手机接着说'), JSON.stringify(texts));
  const heldAgain = await f.until((x) => x.ev === 'tr' && x.d.k === 'pc' && x.d.held === true && f.evs.indexOf(x) > f.evs.indexOf(free), 5000);
  check('and the phone sees the computer holding it again', !!heldAgain);
  f.stop();
  console.log(`  (the model stand-in answered ${mock.calls()} requests)`);
} catch (e) {
  failures++;
  console.log(`  FAIL ${e.stack || e.message}`);
} finally {
  await desk?.close();
  // a stopped server's Codex app servers see their input close and exit on their own; give them a moment
  if (server) {
    const gone = new Promise((r) => server.once('exit', r));
    server.kill();
    await Promise.race([gone, sleep(5000)]);
  }
  mock.server.close();
  await sleep(1500);
  for (const d of [DATA, CONF, HOME, PROJ]) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    } catch (e) {
      console.log(`  (could not remove ${d}: ${e.code})`);
    }
  }
  console.log(`\n${count - failures}/${count} real Codex checks passed`);
  process.exit(failures ? 1 : 0);
}
