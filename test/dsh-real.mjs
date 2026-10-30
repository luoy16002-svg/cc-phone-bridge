// The real DeepSeek Harness runtime (from the installed desktop app) through a real server, in a throwaway home, against a
// local stand-in for the model API: real logs, real locks, nothing from your own conversations and no model cost.
// Usage: node test/dsh-real.mjs
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 18064;
const MOCK = 18076;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpb-dshr-'));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpb-dshrhome-'));
const CONF = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpb-dshrconf-'));
const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpb-dshrproj-'));
const CWD = path.join(PROJ, 'demo');
fs.mkdirSync(CWD);
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpb-dshrout-'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
fs.writeFileSync(path.join(CWD, 'a.png'), PNG);
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ roots: [PROJ], timeZone: 'America/Los_Angeles', codex: { enabled: false }, dsh: { home: HOME, models: [{ id: 'deepseek-flash', name: 'Flash' }] } }));
fs.writeFileSync(path.join(CONF, 'settings.json'), '{}');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
let count = 0;
let token = null;
let server = null;
function check(name, ok, extra = '') {
  count++;
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

let round = 0;
const sse = (res, events) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [type, data] of events) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  res.end();
};
const open = () => ['message_start', { message: { id: `msg_${round}`, type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } }];
const say = (text) => [open(), ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }], ['content_block_delta', { index: 0, delta: { type: 'text_delta', text } }], ['content_block_stop', { index: 0 }], ['message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }], ['message_stop', {}]];
const use = (name, input) => [open(), ['content_block_start', { index: 0, content_block: { type: 'tool_use', id: `call_${round}`, name, input: {} } }], ['content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }], ['content_block_stop', { index: 0 }], ['message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }], ['message_stop', {}]];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (/\/files/.test(req.url)) {                        // the Files API takes pictures before a request uses them
      if (req.method === 'POST') return res.end(JSON.stringify({ id: `file-${Date.now()}`, object: 'file', bytes: 70, created_at: Math.floor(Date.now() / 1000), filename: 'a.png', purpose: 'vision', status: 'processed', expires_at: Math.floor(Date.now() / 1000) + 86400 }));
      return res.end(JSON.stringify({ object: 'list', data: [], has_more: false }));
    }
    if (req.method === 'GET') return res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash', object: 'model' }] }));
    round++;
    const b = JSON.parse(body);
    const all = JSON.stringify(b.messages);
    const tail = JSON.stringify(b.messages.at(-1));
    const asked = ['请跑命令', '请写外面', '请看图'].map((w) => [all.lastIndexOf(w), w]).sort((x, y) => y[0] - x[0])[0];
    if (asked[0] >= 0 && !/tool_result/.test(tail)) {
      if (asked[1] === '请跑命令') return sse(res, use('pwsh', { command: 'Write-Output hi', description: 'Say hi' }));
      if (asked[1] === '请写外面') return sse(res, use('write', { file_path: path.join(OUTSIDE, 'x.txt'), content: 'x' }));
      return sse(res, use('read_image', { file_path: 'a.png' }));
    }
    return sse(res, say(`回答 ${round}`));
  });
});
await new Promise((r) => mock.listen(MOCK, '127.0.0.1', r));

const stripped = () => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|ANTHROPIC_)/.test(k)) delete env[k];
  return env;
};

function startServer() {
  server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    cwd: ROOT,
    env: { ...stripped(), CCPB_PORT: String(PORT), CCPB_DATA: DATA, CCPB_CONFIG_DIR: CONF, DEEPSEEK_API_KEY: 'sk-test', DEEPSEEK_BASE_URL: `http://127.0.0.1:${MOCK}` },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

async function api(method, p, body) {
  const r = await fetch(BASE + p, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch { /* plain */ }
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
    async until(pred, ms = 30000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const hit = got.find(pred);
        if (hit) return hit;
        await sleep(40);
      }
      return null;
    },
  };
}

// a second program holding a session, the way the desktop app does
function holder(sid) {
  const app = path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness');
  const exe = path.join(app, 'DeepSeek Harness.exe');
  const cli = path.join(app, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
  const p = spawn(exe, ['--expose-internals', cli, '--profile', 'sdk'], { cwd: CWD, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: { ...stripped(), ELECTRON_RUN_AS_NODE: '1', DSH_HOME: HOME, DSH_DESKTOP_NODE_EXECUTABLE: exe, DEEPSEEK_API_KEY: 'sk-test', DEEPSEEK_BASE_URL: `http://127.0.0.1:${MOCK}` } });
  const waits = new Map();
  let n = 0;
  readline.createInterface({ input: p.stdout }).on('line', (l) => {
    try {
      const o = JSON.parse(l);
      if (waits.has(o.id)) waits.get(o.id)(o);
    } catch { /* not ours */ }
  });
  const call = (method, params) => new Promise((r) => {
    const id = ++n;
    waits.set(id, r);
    p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  return (async () => {
    await call('initialize', { cwd: CWD, provider: 'deepseek-official', model: 'deepseek-flash' });
    const r = await call('session/resume', { sessionId: sid });
    return { ok: !r.error, stop: () => new Promise((res) => { p.once('exit', res); p.stdin.end(); setTimeout(() => p.kill(), 3000); }) };
  })();
}

async function main() {
  startServer();
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/api/ping`)).ok) break;
    } catch { /* not yet */ }
    await sleep(100);
  }
  const code = (await (await fetch(`${BASE}/pc/rotate`, { method: 'POST', headers: { 'x-pc': '1' } })).json()).code;
  token = (await api('POST', '/api/pair', { code, name: 'test' })).data.token;

  const st = await api('GET', '/api/state');
  console.log(`  desktop version ${st.data.server.dsh}`);
  check('the installed app is found', st.data.agents.dsh?.available === true);
  const t0 = Date.now();
  const n = await api('POST', '/api/sessions', { agent: 'dsh', cwd: CWD, model: 'deepseek-flash', text: '你好' });
  check('a new conversation starts', n.status === 200, JSON.stringify(n.data));
  const id = n.data.id;
  const L = listen(id);
  const first = await L.until((e) => e.k === 'text' && /^回答/.test(e.text));
  check('the real runtime replies', !!first, JSON.stringify(L.got.slice(-3)));
  console.log(`  first reply after ${Date.now() - t0} ms`);
  const result = await L.until((e) => e.k === 'result');
  check('the turn ends', result?.ok === true, JSON.stringify(result));
  await sleep(600);
  const list = (await api('GET', '/api/sessions')).data.sessions;
  check('the log is read back into the list', list.some((s) => s.id === id && s.agent === 'dsh' && s.title && /^回答/.test(s.lastReply)), JSON.stringify(list.map((s) => [s.id, s.title])));
  const hist = (await api('GET', `/api/sessions/${id}`)).data.events;
  check('and the history', hist.filter((e) => e.k === 'user').length === 1 && hist.some((e) => e.k === 'text') && hist.some((e) => e.k === 'result'), JSON.stringify(hist.map((e) => e.k)));

  await sleep(4200);
  const m2 = await api('POST', `/api/sessions/${id}/messages`, { text: '接着说' });
  check('the next turn resumes the same session', m2.status === 200, JSON.stringify(m2.data));
  check('and replies', !!(await L.until((e) => e.k === 'text' && !e.pc && e.t > first.t + 1, 30000)));
  await L.until((e) => e.k === 'result' && e.t > result.t + 1);
  await sleep(600);
  check('one message, not two', (await api('GET', `/api/sessions/${id}`)).data.events.filter((e) => e.k === 'user' && e.text === '接着说').length === 1);

  console.log('asking first');
  await api('POST', `/api/sessions/${id}/messages`, { text: '请跑命令' });
  check('a command inside the folder just runs', !!(await L.until((e) => e.k === 'tool_result' && e.ok && /hi/.test(e.text), 20000)));
  await L.until((e) => e.k === 'result' && e.t > Date.now() - 4000, 20000);
  await sleep(300);
  await api('POST', `/api/sessions/${id}/messages`, { text: '请写外面' });
  // whether a step asks first is the session's permission setting: a question, if one comes, must get through
  const ask = await L.until((e) => (e.k === 'ask' && e.state === 'open') || (e.k === 'result' && e.t > Date.now() - 3000), 20000);
  if (ask?.k === 'ask') {
    await api('POST', `/api/sessions/${id}/answer`, { ask: ask.id, allow: true });
    check('a step that asks waits for the phone and runs once allowed', !!(await L.until((e) => e.k === 'tool_result' && e.t > ask.t, 20000)));
  } else check('this setting did not ask, and the turn ended', ask?.ok === true, JSON.stringify(L.got.slice(-3)));
  await sleep(300);
  await L.until((e) => e.k === 'result' && e.t > Date.now() - 4000, 20000);

  console.log('pictures');
  const png64 = PNG.toString('base64');
  await sleep(300);
  const m3 = await api('POST', `/api/sessions/${id}/messages`, { text: '这是图', images: [{ type: 'image/png', data: png64 }] });
  check('a picture from the phone is taken', m3.status === 200, JSON.stringify(m3.data));
  await L.until((e) => e.k === 'text' && e.t > Date.now() - 6000, 20000);
  await sleep(700);
  const withPic = (await api('GET', `/api/sessions/${id}`)).data.events.find((e) => e.k === 'user' && e.text === '这是图');
  check('and comes back as a picture', Array.isArray(withPic?.images) && withPic.images.length === 1, JSON.stringify(withPic));
  await api('POST', `/api/sessions/${id}/messages`, { text: '请看图' });
  const seen = await L.until((e) => e.k === 'tool_result' && Array.isArray(e.images), 20000);
  check('a picture the agent read reaches the phone', !!seen, JSON.stringify(L.got.filter((e) => e.k === 'tool_result').slice(-2)));
  if (seen) {
    const f = await fetch(`${BASE}/api/files/${seen.images[0]}`, { headers: { Authorization: `Bearer ${token}` } });
    check('and is the same bytes', f.status === 200 && Buffer.from(await f.arrayBuffer()).equals(PNG));
  }
  await sleep(300);
  await L.until((e) => e.k === 'result' && e.t > Date.now() - 4000, 20000);

  console.log('one writer at a time');
  await sleep(4500);
  const live0 = (await (await fetch(`${BASE}/pc/state`, { headers: { 'x-pc': '1' } })).json()).live;
  check('the runtime let go after its turn', live0 === 0, String(live0));
  const h = await holder(id);
  check('another program can take the session then', h.ok);
  const refused = await api('POST', `/api/sessions/${id}/messages`, { text: '被占着' });
  check('the phone is told the computer has it', refused.status === 409 && refused.data.error === 'dsh_held', JSON.stringify(refused));
  await h.stop();
  await sleep(500);
  const again = await api('POST', `/api/sessions/${id}/messages`, { text: '放开了' });
  check('and writes once it is let go', again.status === 200, JSON.stringify(again));
  check('the conversation carries on', !!(await L.until((e) => e.k === 'user' && e.text === '放开了' && !e.state, 20000)));
  await L.until((e) => e.k === 'result' && e.t > Date.now() - 4000, 20000);

  console.log('stopping');
  await sleep(300);
  L.stop();
  console.log(`\n${count - failures}/${count} real DeepSeek Harness checks passed`);
}

try {
  await main();
} catch (e) {
  failures++;
  console.log('ERROR', e.stack || e);
} finally {
  server?.kill();
  mock.close();
  await sleep(4000);
  for (const d of [DATA, HOME, CONF, PROJ, OUTSIDE]) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch { /* still in use: the system's temp cleanup takes it */ }
  }
  process.exit(failures ? 1 : 0);
}
