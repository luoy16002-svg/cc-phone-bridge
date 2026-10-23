// End-to-end checks of the Codex side against a real server on a test port, with the fake Codex app server keeping
// threads and rollout files in a temporary CODEX_HOME. Usage: node test/codex.mjs
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 18062;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const DATA = tmp('ccpb-cx-data-');
const CONF = tmp('ccpb-cx-claude-');
const HOME = tmp('ccpb-cx-home-');
const PROJ = tmp('ccpb-cx-projects-');
const CWD = path.join(PROJ, 'demo');
fs.mkdirSync(CWD);
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ roots: [PROJ], timeZone: 'America/Los_Angeles', codex: { home: HOME } }));
fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ pushOnFinish: false }));
fs.writeFileSync(path.join(HOME, 'config.toml'), 'model = "fake-sol"\nmodel_reasoning_effort = "max"\n\n[profiles.x]\nmodel = "other"\n');

// one thread made "on the computer" before the server starts
const SEED = crypto.randomUUID();
const day = new Date().toISOString().slice(0, 10).split('-');
fs.mkdirSync(path.join(HOME, 'sessions', ...day), { recursive: true });
const SEED_FILE = path.join(HOME, 'sessions', ...day, `rollout-2026-10-23T07-00-00-${SEED}.jsonl`);
const line = (o) => `${JSON.stringify({ timestamp: new Date().toISOString(), ...o })}\n`;
fs.writeFileSync(SEED_FILE, line({ type: 'session_meta', payload: { id: SEED, cwd: CWD } })
  + line({ type: 'turn_context', payload: { model: 'fake-luna', collaboration_mode: { settings: { reasoning_effort: 'low' } } } })
  + line({ type: 'event_msg', payload: { type: 'task_started' } })
  + line({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'Tidy the readme' }] } } })
  + line({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'a1', content: [{ type: 'Text', text: 'The readme is tidy now.' }] } } })
  + line({ type: 'event_msg', payload: { type: 'task_complete' } }));
const now = Math.floor(Date.now() / 1000);
fs.writeFileSync(path.join(HOME, 'fake-threads.json'), JSON.stringify({
  [SEED]: {
    id: SEED, cwd: CWD, model: 'fake-luna', reasoningEffort: 'low', preview: 'Tidy the readme', name: '', createdAt: now - 600, updatedAt: now - 300, path: SEED_FILE,
    items: [
      { turnId: 't1', item: { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'Tidy the readme' }] }, startedAtMs: Date.now() - 400000, completedAtMs: Date.now() - 400000 },
      { turnId: 't1', item: { type: 'reasoning', id: 'r1', summary: ['**Looking at the file**'], content: [] }, startedAtMs: Date.now() - 399000, completedAtMs: Date.now() - 399000 },
      { turnId: 't1', item: { type: 'commandExecution', id: 'c1', command: 'cat README.md', cwd: CWD, status: 'completed', exitCode: 0, aggregatedOutput: '# Demo', commandActions: [] }, startedAtMs: Date.now() - 398000, completedAtMs: Date.now() - 397000 },
      { turnId: 't1', item: { type: 'fileChange', id: 'f1', status: 'completed', changes: [{ path: path.join(CWD, 'README.md'), kind: { type: 'update' }, diff: '' }] }, startedAtMs: Date.now() - 396000, completedAtMs: Date.now() - 396000 },
      { turnId: 't1', item: { type: 'agentMessage', id: 'a1', text: 'The readme is tidy now.' }, startedAtMs: Date.now() - 395000, completedAtMs: Date.now() - 395000 },
    ],
  },
}));

const FAKE_CLAUDE = path.join(ROOT, 'test', 'fake-claude.mjs');
const FAKE_CODEX = path.join(ROOT, 'test', 'fake-codex.mjs');
let server = null;
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
    env: { ...process.env, CCPB_PORT: String(PORT), CCPB_DATA: DATA, CCPB_CONFIG_DIR: CONF, CODEX_HOME: HOME,
      CCPB_CLAUDE_CMD: JSON.stringify([process.execPath, FAKE_CLAUDE]), CCPB_CODEX_CMD: JSON.stringify([process.execPath, FAKE_CODEX]) },
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
        if (data) evs.push({ ev, d: JSON.parse(data) });
      }
    }
  })().catch(() => null);
  return {
    evs,
    async until(pred, ms = 15000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const hit = evs.find(pred);
        if (hit) return hit;
        await sleep(50);
      }
      return null;
    },
    stop() { ctrl.abort(); },
  };
}

try {
  startServer();
  check('server starts', await waitUp());
  const st = await (await fetch(`${BASE}/pc/state`)).json();
  const pair = await (await fetch(`${BASE}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: st.code, name: 'test' }) })).json();
  H = { Authorization: `Bearer ${pair.token}`, 'Content-Type': 'application/json' };

  const state = await api('GET', '/api/state');
  const cx = state.body.agents?.codex || {};
  check('state: Codex available with its visible models', cx.available === true && cx.models?.length === 2 && !cx.models.some((m) => m.id === 'fake-hidden'), JSON.stringify(cx).slice(0, 200));
  check('state: Codex efforts per model', JSON.stringify(cx.models?.[0]?.efforts) === '["low","medium","max"]');
  check('state: Codex defaults come from its config.toml', cx.defaults?.model === 'fake-sol' && cx.defaults?.effort === 'max' && cx.defaults?.modelName === 'Fake-Sol', JSON.stringify(cx.defaults));
  check('state: version and resume command', state.body.server.codex === '9.9.9' && cx.resume === 'codex resume {id}');
  check('state: Claude keeps its fields', Array.isArray(state.body.models) && state.body.agents?.claude?.available === true);

  const list = await api('GET', '/api/sessions');
  const seeded = list.body.sessions.find((s) => s.id === SEED);
  check('list: the computer\'s Codex thread shows with agent codex', seeded?.agent === 'codex' && seeded.title === 'Tidy the readme', JSON.stringify(seeded));
  check('list: last reply and model from the rollout', seeded?.lastReply === 'The readme is tidy now.' && seeded?.lastModel === 'Fake-Luna' && seeded?.effort === 'low');
  check('list: not busy after a finished turn', seeded?.pcBusy === false);
  const onlyClaude = await api('GET', '/api/sessions?agent=claude');
  check('list: agent filter', !onlyClaude.body.sessions.some((s) => s.agent === 'codex'));

  const one = await api('GET', `/api/sessions/${SEED}`);
  const kinds = (one.body.events || []).map((e) => e.k).join(',');
  check('history: prompt, thinking, tools and reply in order', kinds === 'user,think,tool,tool_result,tool,tool_result,text', kinds);
  check('history: every event says which turn it belongs to', (one.body.events || []).every((e) => e.turn === 't1'));
  const edit = (one.body.events || []).find((e) => e.k === 'tool' && e.name === 'Edit');
  check('history: a file change reads as an edit of a path relative to the folder', edit?.summary === 'README.md', JSON.stringify(edit));
  check('history: session summary for Codex', one.body.session?.agent === 'codex' && one.body.session?.folder === 'demo');

  // a new Codex conversation, streamed
  const nw = await api('POST', '/api/sessions', { agent: 'codex', cwd: CWD, model: 'fake-luna', effort: 'high', text: 'Reply with the single word: ready' });
  check('new Codex conversation starts', nw.status === 200 && nw.body.agent === 'codex' && !!nw.body.id, JSON.stringify(nw.body));
  const id = nw.body.id;
  let f = follow(id);
  const r1 = await f.until((x) => x.ev === 'ev' && x.d.k === 'result');
  check('first turn: deltas, a reply and a result', !!r1 && r1.d.ok && f.evs.some((x) => x.d.k === 'delta') && f.evs.some((x) => x.ev === 'ev' && x.d.k === 'text' && x.d.text === 'ready'), JSON.stringify(f.evs.map((x) => x.d.k)));
  check('first turn: a thinking line and a command', f.evs.some((x) => x.d.k === 'think') && f.evs.some((x) => x.d.k === 'tool' && x.d.name === 'Bash'));
  f.stop();
  const s1 = await api('GET', `/api/sessions/${id}`);
  check('new conversation: model and effort as chosen', s1.body.session?.model === 'fake-luna' && s1.body.session?.effort === 'high', JSON.stringify(s1.body.session));

  // the bridge lets go of the thread right after a turn
  const lockFile = (tid) => path.join(HOME, 'thread-writer-locks', `${tid}.lock`);
  let freed = false;
  for (let i = 0; i < 80 && !freed; i++) {
    freed = !fs.existsSync(lockFile(id));
    if (!freed) await sleep(100);
  }
  check('the thread is let go after the turn, lock file and all (the computer can open it)', freed);

  // two messages: the second waits for the first
  f = follow(id);
  await sleep(200);
  const seen = new Set(f.evs.filter((x) => x.d.k === 'result').map((x) => x.d.id));
  const m2 = await api('POST', `/api/sessions/${id}/messages`, { text: 'Reply with the single word: two' });
  const m3 = await api('POST', `/api/sessions/${id}/messages`, { text: 'Reply with the single word: three' });
  check('a second message while busy is queued', m2.status === 200 && m3.body.queued === true, JSON.stringify([m2.body, m3.body]));
  const fresh = (x) => x.ev === 'ev' && x.d.k === 'result' && !seen.has(x.d.id);
  const r2 = await f.until(fresh);
  seen.add(r2?.d.id);
  const r3 = await f.until(fresh);
  const texts = f.evs.filter((x) => x.ev === 'ev' && x.d.k === 'text').map((x) => x.d.text);
  check('queued message runs after the first', r2?.d.ok && r3?.d.ok && texts.includes('two') && texts.includes('three') && texts.indexOf('two') < texts.indexOf('three'), JSON.stringify(texts));
  f.stop();

  // interrupt
  f = follow(id);
  await sleep(300);
  for (const x of f.evs) if (x.d.k === 'result') seen.add(x.d.id);
  await sleep(2600);                                           // the writer from the last turn has let go
  await api('POST', `/api/sessions/${id}/messages`, { text: 'please be slow' });
  await f.until((x) => x.d.k === 'delta');
  const it = await api('POST', `/api/sessions/${id}/interrupt`);
  const r4 = await f.until(fresh);
  check('interrupt stops the turn', it.body.ok === true && r4?.d.ok === false && r4?.d.reason === 'interrupted', JSON.stringify(r4?.d));
  f.stop();

  // a turn running on the computer: the phone follows the rollout and holds its own messages
  f = follow(SEED);
  await sleep(500);
  const wrote = Date.now();
  fs.appendFileSync(SEED_FILE, line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 't2' } }));
  const busy = await f.until((x) => x.ev === 'tr' && x.d.k === 'pc' && x.d.busy, 8000);
  check('a turn on the computer shows as busy', !!busy);
  check('and shows within a moment of being written (the file is watched)', !!busy && Date.now() - wrote < 1200, `${Date.now() - wrote} ms`);
  const held = await api('POST', `/api/sessions/${SEED}/messages`, { text: 'hello' });
  check('the phone does not write while the computer does', held.status === 409 && held.body.error === 'pc_busy', JSON.stringify(held));
  fs.appendFileSync(SEED_FILE, line({ type: 'event_msg', payload: { type: 'item_completed', turn_id: 't2', item: { type: 'AgentMessage', id: 'a2', content: [{ type: 'Text', text: 'Done on the computer.' }] } } })
    + line({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 't2' } }));
  const pcText = await f.until((x) => x.ev === 'ev' && x.d.pc && x.d.k === 'text', 8000);
  const idle = await f.until((x) => x.ev === 'tr' && x.d.k === 'pc' && !x.d.busy && f.evs.indexOf(x) > f.evs.indexOf(busy), 8000);
  check('the computer\'s reply streams to the phone, then it is free', pcText?.d.text === 'Done on the computer.' && !!idle && f.evs.indexOf(pcText) < f.evs.indexOf(idle));
  check('the computer\'s events carry their turn too', pcText?.d.turn === 't2');
  f.stop();

  // The Codex app holds a thread open (as it does with any it has shown, for hours): the phone sees it at once, and
  // what it sends goes on in a branch. Codex's lock is an OS lock, which the fake (and this test) take on Windows.
  const replyOf = async (sid, re) => {
    for (let i = 0; i < 100; i++) {
      const r = await api('GET', `/api/sessions/${sid}`);
      const hit = (r.body.events || []).find((e) => e.k === 'text' && re.test(e.text));
      if (hit) return { said: hit.text, events: r.body.events, session: r.body.session };
      await sleep(100);
    }
    return { said: null, events: [], session: null };
  };
  if (process.platform === 'win32') {
    f = follow(SEED);
    await sleep(400);
    fs.mkdirSync(path.dirname(lockFile(SEED)), { recursive: true });
    const fd = fs.openSync(lockFile(SEED), fs.constants.O_RDWR | fs.constants.O_CREAT | 0x10000000);
    const heldEv = await f.until((x) => x.ev === 'tr' && x.d.k === 'pc' && x.d.held === true, 5000);
    check('the computer opening a thread shows on the phone at once', !!heldEv, JSON.stringify(f.evs.filter((x) => x.d.k === 'pc').map((x) => x.d)));
    const sh = await api('GET', `/api/sessions/${SEED}`);
    check('the thread reads as held by the computer', sh.body.session?.held === true && sh.body.session?.openOnPc === true, JSON.stringify(sh.body.session));
    check('and so it shows in the list', (await api('GET', '/api/sessions')).body.sessions.find((s) => s.id === SEED)?.held === true);
    const refused = await api('POST', `/api/sessions/${SEED}/messages`, { text: 'Reply with the single word: x' });
    check('a message for a held thread is turned back, so the phone branches instead', refused.status === 409 && refused.body.error === 'pc_holds', JSON.stringify(refused));
    const bw = await api('POST', `/api/sessions/${SEED}/fork`, { text: 'what came before?' });
    check('a branch starts while the computer holds the thread', bw.status === 200 && bw.body.agent === 'codex' && bw.body.from === SEED && bw.body.id !== SEED, JSON.stringify(bw.body));
    const b1 = await replyOf(bw.body.id, /^before:/);
    check('the branch carries the conversation so far', b1.said === 'before: Tidy the readme', b1.said);
    check('the branch says where it came from, and its name says it is a branch', b1.session?.from?.id === SEED && /^(分支|Branch) · Tidy the readme$/.test(b1.session?.title || ''), JSON.stringify(b1.session));
    const srcUsers = (await api('GET', `/api/sessions/${SEED}`)).body.events.filter((e) => e.k === 'user').map((e) => e.text);
    check('the thread it came from is untouched', JSON.stringify(srcUsers) === '["Tidy the readme"]', JSON.stringify(srcUsers));
    fs.closeSync(fd);
    fs.unlinkSync(lockFile(SEED));
    const freeEv = await f.until((x) => x.ev === 'tr' && x.d.k === 'pc' && x.d.held === false && f.evs.indexOf(x) > f.evs.indexOf(heldEv), 5000);
    check('the computer letting go shows on the phone too', !!freeEv);
    const inPlace = await api('POST', `/api/sessions/${SEED}/messages`, { text: 'Reply with the single word: inplace' });
    const ip = await f.until((x) => x.ev === 'ev' && x.d.k === 'text' && x.d.text === 'inplace', 10000);
    check('then the phone writes the same thread again', inPlace.status === 200 && !!ip, JSON.stringify(inPlace.body));
    f.stop();
  } else {
    console.log('  skip: the Codex lock checks need Windows');
  }

  // a branch from one of the phone's own messages: the turns before it, and the new message
  const hist = (await api('GET', `/api/sessions/${id}`)).body.events;
  const uReady = hist.find((e) => e.k === 'user' && e.text === 'Reply with the single word: ready');
  const uTwo = hist.find((e) => e.k === 'user' && e.text === 'Reply with the single word: two');
  check('the phone\'s own messages carry their turns once in the record', !!uReady?.turn && !!uTwo?.turn && uReady.turn !== uTwo.turn);
  const bt = await api('POST', `/api/sessions/${id}/fork`, { turn: uTwo.turn, text: 'what came before?' });
  const b2 = await replyOf(bt.body.id, /^before:/);
  check('a branch from a message keeps the turns before it, and only those', bt.status === 200 && b2.said === 'before: Reply with the single word: ready', b2.said);
  const b0 = await api('POST', `/api/sessions/${id}/fork`, { turn: uReady.turn, text: 'what came before?' });
  const b3 = await replyOf(b0.body.id, /^before:/);
  check('a branch from the first message is a new thread in the same folder', b0.status === 200 && b3.said === 'before: nothing' && b3.session?.cwd === CWD && b3.session?.from?.id === id, JSON.stringify([b3.said, b3.session?.cwd, b3.session?.from]));
  check('a turn that is not in the thread is refused', (await api('POST', `/api/sessions/${id}/fork`, { turn: 'nope', text: 'x' })).status === 400);

  // prefs
  const pf = await api('PUT', `/api/sessions/${id}/prefs`, { model: 'fake-sol', effort: 'max' });
  check('prefs change model and effort', pf.body.session?.model === 'fake-sol' && pf.body.session?.effort === 'max', JSON.stringify(pf.body));
  const bad = await api('PUT', `/api/sessions/${id}/prefs`, { model: 'nope', effort: 'ultra' });
  check('prefs refuse unknown model and effort', bad.body.session?.model === 'fake-sol' && bad.body.session?.effort === 'max');
  const older = await api('GET', `/api/sessions/${SEED}/history?before=2`);
  check('older history pages with an opaque cursor', older.status === 200 && Array.isArray(older.body.events));

  const nope = await api('GET', `/api/sessions/${crypto.randomUUID()}`);
  check('unknown ids are 404', nope.status === 404);
} catch (e) {
  failures++;
  console.log(`  FAIL ${e.stack || e.message}`);
} finally {
  server?.kill();
  await sleep(500);
  for (const d of [DATA, CONF, HOME, PROJ]) fs.rmSync(d, { recursive: true, force: true });
  console.log(`\n${count - failures}/${count} Codex checks passed`);
  process.exit(failures ? 1 : 0);
}
