// DeepSeek Harness on the phone, end to end against a real server: logs in the real on-disk format (zstd frames) in a
// temporary home, and a stand-in for the SDK runtime. Usage: node test/dsh.mjs
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 18063;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpb-dsh-'));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpb-dshhome-'));
const CONF = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpb-dshconf-'));
const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpb-dshproj-'));
const CWD = path.join(PROJ, 'demo');
fs.mkdirSync(CWD);
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ roots: [PROJ], timeZone: 'America/Los_Angeles', codex: { enabled: false } }));
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

const FOLDER = path.join(HOME, 'sessions', `--${CWD.replace(/[^a-zA-Z0-9]/g, '-')}--`);

function seedLog(id, { turns = 2, extra = {} } = {}) {
  const dir = path.join(FOLDER, id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  let seq = 0;
  const t0 = Date.now() - 3600000;
  const add = (type, data) => JSON.stringify({ type, seq: seq++, time: t0 + seq * 1000, data });
  const frame = (lines) => fs.appendFileSync(file, zlib.zstdCompressSync(Buffer.from(lines.map((l) => `${l}\n`).join(''))));
  frame([JSON.stringify({ type: 'session', version: 4, id, createdAt: t0, cwd: CWD, isSeeded: false, delegationDepth: 0, ...extra })]);
  for (let turn = 1; turn <= turns; turn++) {
    frame([add('turn/start', { turn }), add('step/start', { turn, step: 1 }),
      add('user/message', { role: 'user', id: crypto.randomUUID(), source: { kind: 'user' }, content: [{ type: 'text', text: `第 ${turn} 个问题` }] }),
      add('user/message', { role: 'user', source: { kind: 'context' }, content: [{ type: 'text', text: '<system-reminder>不该显示</system-reminder>' }] }),
      add('request/header', { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-pro', maxTokens: 1000, reasoningEffort: 'max' }, adapterDefaults: { maxTokens: true } } })]);
    frame([add('session/title', { title: '测试对话', source: { kind: 'fallback' } }),
      add('assistant/message', { turn, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: '想一下' }, { type: 'text', text: `第 ${turn} 个回答` }], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-pro' } } }),
      add('tool/call', { turn, step: 1, callId: `c${turn}`, name: 'read', arguments: JSON.stringify({ path: 'a.txt' }) }),
      add('tool/result', { turn, step: 1, message: { role: 'tool', toolCallId: `c${turn}`, source: { kind: 'tool', callId: `c${turn}` }, content: [{ type: 'text', text: 'hello' }] } }),
      add('step/end', { turn, step: 1 }), add('turn/end', { turn, reason: { kind: 'completed' } })]);
  }
  return { file, add, frame, nextTurn: turns + 1 };
}

function startServer() {
  server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, CCPB_PORT: String(PORT), CCPB_DATA: DATA, CCPB_CONFIG_DIR: CONF, CCPB_DSH_HOME: HOME, CCPB_DSH_CMD: JSON.stringify([process.execPath, path.join(ROOT, 'test', 'fake-dsh.mjs')]) },
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
  return { status: r.status, data, headers: r.headers };
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
  };
}

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function main() {
  const idA = `session-${crypto.randomUUID()}`;
  const idSub = `session-${crypto.randomUUID()}`;
  const A = seedLog(idA, { turns: 60 });
  seedLog(idSub, { turns: 1, extra: { origin: 'subagent', delegationDepth: 1 } });
  startServer();
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/api/ping`)).ok) break;
    } catch { /* not yet */ }
    await sleep(100);
  }
  const code = (await (await fetch(`${BASE}/pc/rotate`, { method: 'POST', headers: { 'x-pc': '1' } })).json()).code;
  token = (await api('POST', '/api/pair', { code, name: 'test' })).data.token;

  console.log('reading conversations');
  const st = await api('GET', '/api/state');
  check('the agent is offered, with the models in use', st.data.agents.dsh?.available === true && st.data.agents.dsh.models[0]?.id === 'deepseek-v4-pro' && st.data.agents.dsh.models[0].provider === 'deepseek-official', JSON.stringify(st.data.agents.dsh));
  const list = (await api('GET', '/api/sessions')).data.sessions;
  const card = list.find((s) => s.id === idA);
  check('a conversation is listed', card?.agent === 'dsh' && card.title === '测试对话' && card.lastReply === '第 60 个回答' && card.lastPrompt === '第 60 个问题', JSON.stringify(card));
  check('its model comes from the log', card?.model === 'deepseek-v4-pro' && card.effort === 'max' && card.folder === 'demo', JSON.stringify(card));
  check('a subagent\'s session is not', !list.some((s) => s.id === idSub));
  const page = await api('GET', `/api/sessions/${idA}`);
  const evs = page.data.events;
  check('history reads frames in order', evs.at(-1).k === 'result' && evs.some((e) => e.k === 'text' && e.text === '第 60 个回答'));
  check('only the person\'s messages show as theirs', evs.filter((e) => e.k === 'user').every((e) => /个问题/.test(e.text)));
  check('thinking and tools are there', evs.some((e) => e.k === 'think') && evs.some((e) => e.k === 'tool' && e.name === 'Read' && e.summary === 'a.txt') && evs.some((e) => e.k === 'tool_result' && e.tool === 'c60'));
  check('turn time comes from the log', evs.find((e) => e.k === 'result').ms > 0 && evs.find((e) => e.k === 'result').ok === true);
  check('long history comes in pages', page.data.hasMore === true && !!page.data.cursor);
  const older = await api('GET', `/api/sessions/${idA}/history?before=${page.data.cursor}`);
  check('older pages join up', older.data.events.length > 0 && !older.data.events.some((e) => evs.some((x) => x.id === e.id)) && older.data.events.at(-1).seq < evs[0].seq);
  let seen = evs.length + older.data.events.length;
  let cur = older.data.cursor;
  while (cur) {
    const p = await api('GET', `/api/sessions/${idA}/history?before=${cur}`);
    seen += p.data.events.length;
    cur = p.data.hasMore ? p.data.cursor : null;
  }
  check('every event once', seen === 60 * 6, String(seen));

  console.log('a turn on the computer shows as it happens');
  const L = listen(idA);
  await L.until((e) => e.k === 'state');
  await sleep(200);
  const { add, frame, file } = A;
  const turn = 61;
  frame([add('turn/start', { turn }), add('step/start', { turn, step: 1 }), add('user/message', { role: 'user', id: crypto.randomUUID(), source: { kind: 'user' }, content: [{ type: 'text', text: '电脑上打的' }] })]);
  check('its message reaches the phone', !!(await L.until((e) => e.k === 'user' && e.pc && e.text === '电脑上打的', 5000)));
  check('and the phone knows the computer is working', !!(await L.until((e) => e.k === 'pc' && e.busy === true, 5000)));
  check('the list says so too', (await api('GET', '/api/sessions')).data.sessions.find((s) => s.id === idA)?.pcBusy === true);
  // half a frame on disk: nothing is lost, the rest comes with the next read
  const last = zlib.zstdCompressSync(Buffer.from(`${add('assistant/message', { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '电脑上的回答' }], source: { kind: 'model', model: 'deepseek-v4-pro' } } })}\n${add('turn/end', { turn, reason: { kind: 'completed' } })}\n`));
  fs.appendFileSync(file, last.subarray(0, 12));
  await sleep(500);
  check('half a frame is left for later', !L.got.some((e) => e.text === '电脑上的回答'));
  fs.appendFileSync(file, last.subarray(12));
  check('the reply arrives whole', !!(await L.until((e) => e.k === 'text' && e.pc && e.text === '电脑上的回答', 5000)));
  check('and the end of the turn', !!(await L.until((e, i) => e.k === 'pc' && e.busy === false && i > 0, 5000)));

  console.log('sending from the phone');
  const m1 = await api('POST', `/api/sessions/${idA}/messages`, { text: '手机上接着说' });
  check('accepted', m1.status === 200, JSON.stringify(m1.data));
  const reply = await L.until((e) => e.k === 'text' && e.text === '收到：手机上接着说');
  check('the reply comes back', !!reply && !reply.pc);
  const res = await L.until((e) => e.k === 'result' && !e.pc && e.ms > 0);
  check('the turn ends', !!res && res.ok === true, JSON.stringify(res));
  await sleep(600);
  check('one result for the turn, once the phone has joined what it heard', new Set(L.got.filter((e) => e.k === 'result').map((e) => e.id)).size === 2);
  check('one message for the turn', (await api('GET', `/api/sessions/${idA}`)).data.events.filter((e) => e.k === 'user' && e.text === '手机上接着说').length === 1);

  console.log('the computer holds a session');
  const idH = `session-${crypto.randomUUID()}`;
  seedLog(idH, { turns: 1 });
  fs.writeFileSync(path.join(FOLDER, idH, 'held'), '');
  const LH = listen(idH);
  await LH.until((e) => e.k === 'state');
  const h1 = await api('POST', `/api/sessions/${idH}/messages`, { text: '发不出去' });
  check('the phone is told', h1.status === 409 && h1.data.error === 'dsh_held', JSON.stringify(h1.data));
  check('the page says so', !!(await LH.until((e) => e.k === 'pc' && e.held === true, 3000)));
  check('the list too', (await api('GET', '/api/sessions')).data.sessions.find((s) => s.id === idH)?.held === true);
  check('nothing was written', !(await api('GET', `/api/sessions/${idH}`)).data.events.some((e) => e.text === '发不出去'));
  fs.rmSync(path.join(FOLDER, idH, 'held'));
  const h2 = await api('POST', `/api/sessions/${idH}/messages`, { text: '现在可以了' });
  check('once it lets go, the phone can write', h2.status === 200, JSON.stringify(h2.data));
  check('and the note goes away', !!(await LH.until((e) => e.k === 'pc' && e.held === false, 3000)));
  await LH.until((e) => e.k === 'result' && !e.pc);
  LH.stop();

  console.log('a new conversation');
  const n = await api('POST', '/api/sessions', { agent: 'dsh', cwd: CWD, model: 'deepseek-flash', effort: 'high', text: '新开一个' });
  check('it starts', n.status === 200 && /^session-/.test(n.data.id) && n.data.agent === 'dsh', JSON.stringify(n.data));
  const LN = listen(n.data.id);
  check('and replies', !!(await LN.until((e) => e.k === 'text' && e.text === '收到：新开一个')));
  await sleep(4200);
  check('the runtime lets go of the session right after', (await api('GET', '/pc/state').catch(() => null))?.status !== 500 && (await (await fetch(`${BASE}/pc/state`, { headers: { 'x-pc': '1' } })).json()).live === 0);

  console.log('asking before a step');
  const a1 = await api('POST', `/api/sessions/${n.data.id}/messages`, { text: '要确认' });
  check('resumes after the runtime went', a1.status === 200, JSON.stringify(a1.data));
  const ask = await LN.until((e) => e.k === 'ask' && e.state === 'open');
  check('the phone is asked', ask?.name === 'PowerShell' && ask.reason === 'echo hi', JSON.stringify(ask));
  check('and sees it when it comes back to the page', (await api('GET', `/api/sessions/${n.data.id}`)).data.events.some((e) => e.k === 'ask' && e.id === ask?.id));
  check('the answer gets through', (await api('POST', `/api/sessions/${n.data.id}/answer`, { ask: ask.id, allow: true })).data.ok === true);
  check('the card closes', !!(await LN.until((e) => e.k === 'ask' && e.state === 'allowed')));
  check('and the step ran', !!(await LN.until((e) => e.k === 'tool_result' && e.ok && e.text === 'allowed-once')));

  console.log('stopping');
  await LN.until((e) => e.k === 'result' && e.ok);
  await api('POST', `/api/sessions/${n.data.id}/messages`, { text: '慢一点' });
  await LN.until((e) => e.k === 'user' && e.text === '慢一点' && !e.state);
  const stop = await api('POST', `/api/sessions/${n.data.id}/interrupt`);
  check('a turn can be stopped', stop.data.ok === true);
  check('and says so', !!(await LN.until((e) => e.k === 'result' && e.reason === 'stopped')));
  const after = await api('POST', `/api/sessions/${n.data.id}/messages`, { text: '接着来' });
  check('and carries on', after.status === 200 && !!(await LN.until((e) => e.k === 'text' && e.text === '收到：接着来')), JSON.stringify(after.data));

  console.log('pictures');
  await LN.until((e) => e.k === 'result' && e.ok && e.t > Date.now() - 5000);
  await api('POST', `/api/sessions/${n.data.id}/messages`, { text: '发图', images: [{ type: 'image/png', data: png }] });
  await LN.until((e) => e.k === 'text' && e.text === '收到：发图');
  await api('POST', `/api/sessions/${n.data.id}/messages`, { text: '看图' });
  const shot = await LN.until((e) => e.k === 'tool_result' && Array.isArray(e.images));
  check('a picture the agent looked at reaches the phone', /^img\/[0-9a-f]{32}\.png$/.test(shot?.images?.[0] || ''), JSON.stringify(shot));
  await LN.until((e) => e.k === 'text' && e.text === '收到：看图');
  const ph = (await api('GET', `/api/sessions/${n.data.id}`)).data.events;
  const sent = ph.find((e) => e.k === 'user' && e.text === '发图');
  check('so does one the person sent', Array.isArray(sent?.images) && sent.images[0] === shot?.images?.[0], JSON.stringify(sent));
  const pic = await fetch(`${BASE}/api/files/${shot.images[0]}`, { headers: { Authorization: `Bearer ${token}` } });
  const bytes = Buffer.from(await pic.arrayBuffer());
  check('and can be fetched, for good', pic.status === 200 && bytes.equals(Buffer.from(png, 'base64')) && /immutable/.test(pic.headers.get('cache-control')) && pic.headers.get('content-type') === 'image/png');
  check('only with a paired phone', (await fetch(`${BASE}/api/files/${shot.images[0]}`)).status === 401);
  check('and only pictures', (await api('GET', '/api/files/img/..%2F..%2Fdevices.json')).status === 400);
  LN.stop();
  L.stop();

  console.log(`\n${count - failures}/${count} DeepSeek Harness checks passed`);
}

try {
  await main();
} catch (e) {
  failures++;
  console.log('ERROR', e.stack || e);
} finally {
  server?.kill();
  await sleep(500);
  for (const d of [DATA, HOME, CONF, PROJ]) fs.rmSync(d, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
