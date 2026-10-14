// A short real run through the bridge with this computer's Claude Code (Haiku, low effort, a scratch folder):
// a new session, a tool call, a server restart and the same session carried on, an interrupt.
// Uses the bridge's own config file (how Claude Code is started, where its config lives) with a temporary data folder.
// Usage: node test/real.mjs   (spends a little usage)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 18064;
const BASE = `http://127.0.0.1:${PORT}`;
const { CONFIG_FILE } = await import('../lib/config.mjs');
process.env.CCPB_CONFIG ||= CONFIG_FILE;
const { CONFIG } = await import('../lib/config.mjs');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpb-real-'));
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpb-real-cwd-'));
const CONF = CONFIG.claude.configDir;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server = null;
let token = null;
let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name} ${ok ? '' : extra}`); };

const start = async () => {
  server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { cwd: ROOT, env: { ...process.env, CCPB_PORT: String(PORT), CCPB_DATA: DATA, CCPB_ROOTS: os.tmpdir(), CCPB_SHOW_TEMP: '1' }, stdio: 'inherit' });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/api/ping`)).ok) return; } catch { /* starting */ }
    await sleep(100);
  }
};
const api = (m, p, b) => fetch(BASE + p, { method: m, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json());
const history = async (id) => (await api('GET', `/api/sessions/${id}`)).events || [];
async function waitFor(id, pred, ms = 120000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = (await api('GET', `/api/sessions/${id}`)).session;
    const ev = await history(id);
    if (s?.state !== 'running' && pred(ev)) return ev;
    await sleep(1000);
  }
  return null;
}

try {
  await start();
  const { code } = await (await fetch(`${BASE}/pc/state`)).json();
  ({ token } = await (await fetch(`${BASE}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name: 'test' }) })).json());
  await api('PUT', '/api/settings', { pushOnFinish: false });

  console.log('1. a new session from the phone');
  const t0 = Date.now();
  const made = await api('POST', '/api/sessions', { cwd: CWD, model: 'claude-haiku-5-5', effort: 'low', text: '只回复这几个字：值班台收到' });
  check('session started, id returned', /^[0-9a-f-]{36}$/.test(made.id || ''), JSON.stringify(made));
  const id = made.id;
  const h1 = await waitFor(id, (ev) => ev.some((e) => e.k === 'text' && e.text.includes('值班台收到')));
  check(`reply in the session's own history (${((Date.now() - t0) / 1000).toFixed(1)} s)`, !!h1);
  check('the turn was run by Haiku', h1 && h1.filter((e) => e.k === 'text').pop()?.model === 'claude-haiku-5-5');
  const listed = (await api('GET', '/api/sessions')).sessions.find((s) => s.id === id);
  check('listed with folder, model and effort', listed && listed.modelName === 'Haiku 5.5' && listed.effort === 'low', JSON.stringify(listed));

  console.log('2. a tool call');
  await api('POST', `/api/sessions/${id}/messages`, { text: 'Use your Bash tool to run `echo bridge-check` and tell me what it printed, in one line.' });
  const h2 = await waitFor(id, (ev) => ev.some((e) => e.k === 'tool_result' && /bridge-check/.test(e.text)));
  const tool = h2 && h2.find((e) => e.k === 'tool' && e.name === 'Bash');
  check('Bash call and its output in the history, linked', tool && h2.some((e) => e.k === 'tool_result' && e.tool === tool.tool && /bridge-check/.test(e.text)));

  console.log('3. restart the bridge, carry on the same session');
  server.kill();
  await sleep(1500);
  await start();
  await api('POST', `/api/sessions/${id}/messages`, { text: '只回复：还在' });
  const h3 = await waitFor(id, (ev) => ev.some((e) => e.k === 'text' && e.text.includes('还在')));
  check('the same session answers after a restart, history intact', h3 && h3.some((e) => e.text?.includes('值班台收到')) && h3.some((e) => e.k === 'tool' && e.name === 'Bash'));
  const files = fs.readdirSync(path.join(CONF, 'projects', CWD.replace(/[^a-zA-Z0-9]/g, '-')));
  check('one transcript only: no copy was made', files.filter((f) => f.endsWith('.jsonl')).length === 1, files.join(','));

  console.log('4. interrupt a long command');
  await api('POST', `/api/sessions/${id}/messages`, { text: 'Run `ping -n 40 127.0.0.1` with your Bash tool in the foreground and wait for it to finish, then say done.' });
  let started = false;
  for (let i = 0; i < 60 && !started; i++) {
    await sleep(1000);
    started = (await history(id)).some((e) => e.k === 'tool' && /ping/.test(e.summary + (e.detail || '')));
  }
  check('the long command started', started);
  const intr = await api('POST', `/api/sessions/${id}/interrupt`);
  check('interrupt accepted', intr.ok === true);
  const h4 = await waitFor(id, (ev) => ev.some((e) => e.k === 'note' && e.text === '已打断'), 40000);
  check('the turn stopped and the history says so', !!h4);
} catch (e) {
  fails++;
  console.log('ERROR', e.stack || e);
} finally {
  server?.kill();
  await sleep(1500);
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(CWD, { recursive: true, force: true });
  fs.rmSync(path.join(CONF, 'projects', CWD.replace(/[^a-zA-Z0-9]/g, '-')), { recursive: true, force: true });
  console.log(fails ? `${fails} failed` : 'all real checks passed');
  process.exit(fails ? 1 : 0);
}
