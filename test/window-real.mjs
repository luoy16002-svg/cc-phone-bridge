// A real Claude Code window on this computer, in a pseudo console so no window shows on the screen, driven through
// the bridge the way the phone does, with a draft sitting in the window's box all along: a message typed into the
// idle window, the effort set from the phone (for that window only), then while the window is busy an effort change
// and a message. At the end the draft must still be in the box and Claude Code's settings untouched.
// Haiku, a scratch folder; the bridge's own config file with a temporary data folder (the typing helper is built there).
// Usage: node test/window-real.mjs   (Windows; spends a little usage)
import { spawn, execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 18067;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpb-win-'));
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpb-win-cwd-'));
const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
process.env.CCPB_CONFIG ||= path.join(process.env.CCPB_DATA || path.join(LOCAL, 'cc-phone-bridge'), 'config.json');
process.env.CCPB_DATA = DATA;
const { CONFIG } = await import('../lib/config.mjs');
const { claudeCommand, claudeEnv } = await import('../lib/claude.mjs');
const { typeInto } = await import('../lib/pcwindow.mjs');
const CONF = CONFIG.claude.configDir;
const SETTINGS = path.join(CONF, 'settings.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = '') => {
  if (!ok) fails++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` ${extra}`}`);
};
const until = async (pred, ms, step = 250) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await pred();
    if (v) return v;
    await sleep(step);
  }
  return null;
};
const settingsBefore = fs.readFileSync(SETTINGS);
const settingsSame = () => fs.readFileSync(SETTINGS).equals(settingsBefore);
const b64 = (s) => Buffer.from(s).toString('base64');

// the pseudo console launcher and the screen reader for the test window, built with the C# compiler of Windows
const csc = ['Framework64', 'Framework'].map((d) => path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', d, 'v4.0.30319', 'csc.exe')).find((p) => fs.existsSync(p));
const build = (name) => {
  const exe = path.join(DATA, `${name}.exe`);
  execFileSync(csc, ['-nologo', '-optimize', `-out:${exe}`, path.join(ROOT, 'test', 'win', `${name}.cs`)], { windowsHide: true });
  return exe;
};
const CONPTY = build('conpty');
const SCREEN = build('screen');

let win = null;
let pid = 0;
let server = null;
let stream = null;
const got = [];
const hard = setTimeout(() => { console.log('  FAIL took too long'); fails++; finish(); }, 330000);
try {
  const env = claudeEnv();
  for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_EFFORT|ANTHROPIC_)/i.test(k)) delete env[k];
  Object.assign(env, CONFIG.claude.env, { CLAUDE_CONFIG_DIR: CONF });
  const cmd = `"${claudeCommand().bin}" --model claude-haiku-5-5 --permission-mode bypassPermissions "Reply with exactly one word: ready"`;
  win = spawn(CONPTY, [CWD, '-', cmd], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  pid = Number(await Promise.race([new Promise((r) => win.stdout.once('data', (d) => r(String(d).trim()))), sleep(10000).then(() => 0)]));
  check('a window in a pseudo console', pid > 0);
  const screen = () => {
    try {
      return execFileSync(SCREEN, [String(pid)], { windowsHide: true, encoding: 'utf8' });
    } catch {
      return '';
    }
  };
  const box = () => {
    const lines = screen().split('\n');
    const i = lines.map((l) => l.trimStart().startsWith('❯')).lastIndexOf(true);
    return i < 0 ? '' : lines[i].trim().replace(/^❯\s?/, '');
  };
  // a new folder asks first whether to trust it, "no" marked: down to "yes", as a person would
  if (await until(() => /trust/i.test(screen()), 15000)) {
    await sleep(400);
    await typeInto(pid, ['K down', 'W 250', 'K enter']);
  }
  const regFile = path.join(CONF, 'sessions', `${pid}.json`);
  const reg = () => {
    try {
      return JSON.parse(fs.readFileSync(regFile, 'utf8'));
    } catch {
      return null;
    }
  };
  check('it registers as an interactive window', !!(await until(() => reg()?.sessionId && reg().kind === 'interactive' && reg().entrypoint === 'cli', 30000)), JSON.stringify(reg()));
  const sid = reg()?.sessionId;
  const file = path.join(CONF, 'projects', CWD.replace(/[^a-zA-Z0-9]/g, '-'), `${sid}.jsonl`);
  check('it answers its first prompt', !!(await until(() => fs.existsSync(file) && /"ready/i.test(fs.readFileSync(file, 'utf8')) && reg()?.status === 'idle', 90000, 500)));
  await sleep(800);
  await typeInto(pid, [`T ${b64('draft stays')}`, 'K left', 'K left']);   // half a sentence typed on the computer
  await sleep(500);
  check('a draft sits in the window\'s box', box() === 'draft stays', JSON.stringify(box()));

  server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { cwd: ROOT, env: { ...process.env, CCPB_PORT: String(PORT), CCPB_DATA: DATA, CCPB_ROOTS: os.tmpdir(), CCPB_SHOW_TEMP: '1' }, stdio: ['ignore', 'ignore', 'inherit'] });
  await until(async () => (await fetch(`${BASE}/api/ping`).catch(() => null))?.ok, 20000, 100);
  const { code } = await (await fetch(`${BASE}/pc/state`)).json();
  const { token } = await (await fetch(`${BASE}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name: 'window test' }) })).json();
  const api = (m, p, b) => fetch(BASE + p, { method: m, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
  await api('PUT', '/api/settings', { pushOnFinish: false });
  const ctrl = new AbortController();
  stream = ctrl;
  (async () => {
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
        if (ev && data) got.push({ ev, at: Date.now(), ...JSON.parse(data) });
      }
    }
  })().catch(() => null);
  await sleep(1000);
  const s0 = (await api('GET', `/api/sessions/${sid}`)).data?.session;
  check('the bridge sees the window, can type into it, and shows its model', s0?.openOnPc && s0?.pcTypable && s0?.model === 'claude-haiku-5-5', JSON.stringify(s0));

  console.log('a message typed into the idle window');
  const sent1 = Date.now();
  const m1 = await api('POST', `/api/sessions/${sid}/messages`, { text: 'Reply with exactly one word: two' });
  check('typed into the window', m1.data?.via === 'pc', JSON.stringify(m1.data));
  const drop1 = await until(() => got.find((e) => e.k === 'drop' && e.id === m1.data?.id), 15000);
  check(`taken back once the window has it (${drop1 ? ((drop1.at - sent1) / 1000).toFixed(1) : '-'} s after sending)`, !!drop1);
  check('the reply reaches the phone', !!(await until(() => got.find((e) => e.k === 'text' && /two/i.test(e.text || '')), 60000, 300)));
  await sleep(Math.max(0, sent1 + 13500 - Date.now()));          // past the 12 s a window is given
  check('never reported as not delivered', !got.some((e) => e.id === m1.data?.id && e.state === 'pc_failed'));

  console.log('the effort from the phone, for this window only');
  await until(() => reg()?.status === 'idle', 30000);
  const p1 = await api('PUT', `/api/sessions/${sid}/prefs`, { model: 'claude-haiku-5-5', effort: 'medium' });
  check('set in the window', p1.data?.via === 'pc' && p1.data?.session?.effort === 'medium', JSON.stringify(p1.data));
  check('the window says medium, for this session only, and the phone hears it', !!(await until(() => got.find((e) => e.k === 'tune' && e.effort === 'medium'), 10000))
    && /Set effort level to medium \(this session only\)/.test(fs.readFileSync(file, 'utf8')), JSON.stringify(got.filter((e) => e.k === 'tune')));
  check('Claude Code\'s settings untouched', settingsSame());

  console.log('while the window is busy');
  const m2 = await api('POST', `/api/sessions/${sid}/messages`, { text: 'Use your Bash tool to run `ping -n 12 127.0.0.1` in the foreground and wait for it, then reply with exactly one word: pinged' });
  check('typed into the window', m2.data?.via === 'pc');
  check('the window gets busy with the command', !!(await until(() => got.some((e) => e.k === 'tool' && /ping/.test(`${e.summary} ${e.detail || ''}`)), 40000)));
  const p2 = await api('PUT', `/api/sessions/${sid}/prefs`, { effort: 'high' });
  check('an effort change goes in mid-turn', p2.data?.via === 'pc', JSON.stringify(p2.data));
  const t2 = await until(() => got.find((e) => e.k === 'tune' && e.effort === 'high'), 10000);
  check('and the window takes it at once', !!t2 && ['busy', 'shell'].includes(reg()?.status), `${!!t2} ${reg()?.status}`);
  const m3 = await api('POST', `/api/sessions/${sid}/messages`, { text: 'Also add the word: extra' });
  check('a message while busy is typed in', m3.data?.via === 'pc');
  check('it waits in the window\'s queue', !!(await until(() => got.find((e) => e.id === m3.data?.id && e.state === 'pc_queued'), 14000)), JSON.stringify(got.filter((e) => e.id === m3.data?.id)));
  check('and is taken back once the window takes it in', !!(await until(() => got.find((e) => e.k === 'drop' && e.id === m3.data?.id), 90000, 500)));
  check('never reported as not delivered', !got.some((e) => [m2.data?.id, m3.data?.id].includes(e.id) && e.state === 'pc_failed'));
  await until(() => reg()?.status === 'idle', 90000, 500);
  await sleep(1500);
  check('the draft is still in the window\'s box, as it was', box() === 'draft stays', JSON.stringify(box()));
  check('Claude Code\'s settings still untouched', settingsSame());
  const s1 = (await api('GET', `/api/sessions/${sid}`)).data;
  check('the history has each message once, nothing left on its way', !s1.events.some((e) => e.k === 'user' && e.state) && s1.events.filter((e) => e.k === 'user' && /exactly one word: two/.test(e.text)).length === 1);
} catch (e) {
  fails++;
  console.log('ERROR', e.stack || e);
}
await finish();

async function finish() {
  clearTimeout(hard);
  stream?.abort();
  server?.kill();
  if (pid) await new Promise((r) => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => r()));
  try { win?.kill(); } catch { /* gone */ }
  await sleep(1500);
  for (const f of fs.readdirSync(path.join(CONF, 'sessions')).filter((f) => pid && f.startsWith(`${pid}.`))) fs.rmSync(path.join(CONF, 'sessions', f), { force: true });
  fs.rmSync(path.join(CONF, 'projects', CWD.replace(/[^a-zA-Z0-9]/g, '-')), { recursive: true, force: true });
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(CWD, { recursive: true, force: true });
  if (!settingsSame()) {
    fs.writeFileSync(`${SETTINGS}.tmp-ccpb`, settingsBefore);
    fs.renameSync(`${SETTINGS}.tmp-ccpb`, SETTINGS);
    console.log('  NOTE settings.json had changed and was put back');
  }
  console.log(fails ? `${fails} failed` : 'all window checks passed');
  process.exit(fails ? 1 : 0);
}
