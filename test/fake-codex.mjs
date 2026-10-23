// Stands in for `codex app-server` in tests: the JSON-RPC methods Duty Desk uses, the same notification shapes, and
// like the real one it keeps threads in CODEX_HOME (an index file plus a rollout file per thread) and lets one
// process at a time write a thread: CODEX_HOME/thread-writer-locks/<id>.lock, held open without sharing on Windows
// (so other programs cannot read it, as with Codex's own lock) and holding the writer's pid elsewhere.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

if (process.argv[2] !== 'app-server') process.exit(2);
const HOME = process.env.CODEX_HOME;
const INDEX = path.join(HOME, 'fake-threads.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (o) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...o })}\n`);
const notify = (method, params) => send({ method, params });
const readIndex = () => {
  try {
    return JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  } catch {
    return {};
  }
};
const writeIndex = (x) => fs.writeFileSync(INDEX, JSON.stringify(x, null, 1));

const EXLOCK = 0x10000000;                         // libuv on Windows: open with no sharing
const lockOf = (id) => path.join(HOME, 'thread-writer-locks', `${id}.lock`);
const conflict = (id) => Object.assign(new Error(`thread-store conflict: thread ${id} already has an active writer`), { code: -32600 });
const held = new Map();                             // thread id -> fd (Windows) or true
function hold(id) {
  if (held.has(id)) return;
  const lf = lockOf(id);
  fs.mkdirSync(path.dirname(lf), { recursive: true });
  if (process.platform === 'win32') {
    try {
      held.set(id, fs.openSync(lf, fs.constants.O_RDWR | fs.constants.O_CREAT | EXLOCK));
    } catch (e) {
      throw e.code === 'EBUSY' ? conflict(id) : e;
    }
    return;
  }
  if (fs.existsSync(lf)) {
    const pid = Number(fs.readFileSync(lf, 'utf8'));
    let alive = pid !== process.pid;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (alive) throw conflict(id);
  }
  fs.writeFileSync(lf, String(process.pid));
  held.set(id, true);
}
const release = () => {
  for (const [id, fd] of held) {
    try {
      if (typeof fd === 'number') fs.closeSync(fd);
      fs.unlinkSync(lockOf(id));
    } catch { /* gone */ }
  }
  held.clear();
};
process.on('exit', release);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

const roll = (th, o) => fs.appendFileSync(th.path, `${JSON.stringify({ timestamp: new Date().toISOString(), ...o })}\n`);
function newThread(cwd, model, from = '') {
  const id = crypto.randomUUID();
  const day = new Date().toISOString().slice(0, 10).split('-');
  const dir = path.join(HOME, 'sessions', ...day);
  fs.mkdirSync(dir, { recursive: true });
  const th = { id, cwd, model, reasoningEffort: 'medium', preview: '', name: '', createdAt: Math.floor(Date.now() / 1000), updatedAt: Math.floor(Date.now() / 1000), path: path.join(dir, `rollout-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}-${id}.jsonl`), items: [], forkedFromId: from || null };
  fs.writeFileSync(th.path, `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: { id, cwd, ...(from ? { forked_from_id: from } : {}) } })}\n`);
  return th;
}
const pub = (th) => ({ id: th.id, cwd: th.cwd, model: th.model, reasoningEffort: th.reasoningEffort, preview: th.preview, name: th.name, createdAt: th.createdAt, updatedAt: th.updatedAt, path: th.path, status: { type: 'idle' }, originator: 'fake', source: 'cli', forkedFromId: th.forkedFromId || null });
// a thread's turns in order, from its items
const turnsOf = (th) => [...new Set(th.items.map((x) => x.turnId))];

const running = new Map();     // thread id -> { turnId, stop }

async function runTurn(th, turnId, input) {
  const text = (input.find((i) => i.type === 'text') || {}).text || '';
  const started = Date.now();
  let stopped = false;
  running.set(th.id, { turnId, stop: () => { stopped = true; } });
  notify('turn/started', { threadId: th.id, turn: { id: turnId, status: 'inProgress', items: [] } });
  roll(th, { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } });
  const user = { type: 'userMessage', id: crypto.randomUUID(), content: [{ type: 'text', text }] };
  th.items.push({ turnId, item: user, startedAtMs: started, completedAtMs: started });
  if (!th.preview) th.preview = text;
  roll(th, { type: 'event_msg', payload: { type: 'item_completed', turn_id: turnId, item: { type: 'UserMessage', id: user.id, content: [{ type: 'text', text }] } } });
  notify('item/completed', { threadId: th.id, turnId, item: user, completedAtMs: Date.now() });
  const think = { type: 'reasoning', id: crypto.randomUUID(), summary: ['**Reading the request**'], content: [] };
  notify('item/started', { threadId: th.id, turnId, item: think, startedAtMs: Date.now() });
  notify('item/completed', { threadId: th.id, turnId, item: think, completedAtMs: Date.now() });
  th.items.push({ turnId, item: think, startedAtMs: Date.now(), completedAtMs: Date.now() });
  const cmd = { type: 'commandExecution', id: crypto.randomUUID(), command: 'echo hi', cwd: th.cwd, status: 'completed', exitCode: 0, aggregatedOutput: 'hi', commandActions: [] };
  notify('item/started', { threadId: th.id, turnId, item: { ...cmd, status: 'inProgress' }, startedAtMs: Date.now() });
  notify('item/completed', { threadId: th.id, turnId, item: cmd, completedAtMs: Date.now() });
  th.items.push({ turnId, item: cmd, startedAtMs: Date.now(), completedAtMs: Date.now() });
  // what the conversation said before, so a branch can show what it kept
  const before = th.items.filter((x) => x.item.type === 'userMessage' && x.turnId !== turnId).map((x) => x.item.content[0].text);
  const reply = /single word: (\w+)/.exec(text)?.[1] || (/what came before/.test(text) ? `before: ${before.join(' | ') || 'nothing'}` : `done: ${text.slice(0, 40)}`);
  const words = /slow/.test(text) ? Array.from({ length: 60 }, (_, i) => `w${i} `) : reply.match(/.{1,3}/g);
  const msgId = crypto.randomUUID();
  notify('item/started', { threadId: th.id, turnId, item: { type: 'agentMessage', id: msgId, text: '' }, startedAtMs: Date.now() });
  let said = '';
  for (const w of words) {
    if (stopped) break;
    said += w;
    notify('item/agentMessage/delta', { threadId: th.id, turnId, itemId: msgId, delta: w });
    await sleep(/slow/.test(text) ? 120 : 15);
  }
  running.delete(th.id);
  if (!stopped) {
    const msg = { type: 'agentMessage', id: msgId, text: said };
    th.items.push({ turnId, item: msg, startedAtMs: Date.now(), completedAtMs: Date.now() });
    roll(th, { type: 'event_msg', payload: { type: 'item_completed', turn_id: turnId, item: { type: 'AgentMessage', id: msgId, content: [{ type: 'Text', text: said }] } } });
    notify('item/completed', { threadId: th.id, turnId, item: msg, completedAtMs: Date.now() });
  }
  roll(th, { type: 'event_msg', payload: { type: stopped ? 'turn_aborted' : 'task_complete', turn_id: turnId } });
  th.updatedAt = Math.floor(Date.now() / 1000);
  const idx = readIndex();
  idx[th.id] = { ...th, name: idx[th.id]?.name || th.name };
  writeIndex(idx);
  notify('turn/completed', { threadId: th.id, turn: { id: turnId, status: stopped ? 'interrupted' : 'completed', items: [], durationMs: Date.now() - started } });
}

const find = (id) => {
  const th = readIndex()[id];
  if (!th) throw Object.assign(new Error(`thread not found: ${id}`), { code: -32600 });
  return th;
};

const handlers = {
  initialize: () => ({ userAgent: 'fake_codex/9.9.9 (test)', codexHome: HOME, platformFamily: 'test', platformOs: 'test' }),
  'model/list': () => ({ data: [
    { id: 'fake-sol', model: 'fake-sol', displayName: 'Fake-Sol', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }, { reasoningEffort: 'medium', description: '' }, { reasoningEffort: 'max', description: '' }], defaultReasoningEffort: 'medium', isDefault: true },
    { id: 'fake-luna', model: 'fake-luna', displayName: 'Fake-Luna', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }, { reasoningEffort: 'high', description: '' }], defaultReasoningEffort: 'low', isDefault: false },
    { id: 'fake-hidden', model: 'fake-hidden', displayName: 'Hidden', hidden: true, supportedReasoningEfforts: [], defaultReasoningEffort: 'low', isDefault: false },
  ], nextCursor: null }),
  'thread/list': (p) => {
    // like the real list, it does not say what a thread was forked from
    const all = Object.values(readIndex()).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, p.limit || 50);
    return { data: all.map((th) => ({ ...pub(th), forkedFromId: null })), nextCursor: null };
  },
  'thread/read': (p) => ({ thread: pub(find(p.threadId)) }),
  'thread/items/list': (p) => {
    const th = find(p.threadId);
    const items = th.items.slice().reverse();                 // desc
    const start = p.cursor ? Number(p.cursor) : 0;
    const page = items.slice(start, start + (p.limit || 50));
    const next = start + page.length < items.length ? String(start + page.length) : null;
    return { data: page, nextCursor: next, backwardsCursor: null };
  },
  'thread/turns/list': (p) => {
    const th = find(p.threadId);
    const live = running.get(th.id)?.turnId;
    const all = turnsOf(th).map((id) => ({ id, status: id === live ? 'inProgress' : 'completed', items: [], itemsView: 'notLoaded' }));
    if (p.sortDirection !== 'asc') all.reverse();
    const start = p.cursor ? Number(p.cursor) : 0;
    const page = all.slice(start, start + (p.limit || 50));
    const next = start + page.length < all.length ? String(start + page.length) : null;
    return { data: page, nextCursor: next, backwardsCursor: null };
  },
  'thread/start': (p) => {
    const th = newThread(p.cwd, p.model || 'fake-sol');
    hold(th.id);
    const idx = readIndex();
    idx[th.id] = th;
    writeIndex(idx);
    return { thread: pub(th) };
  },
  'thread/resume': (p) => {
    const th = find(p.threadId);
    hold(th.id);
    return { thread: pub(th) };
  },
  // reads the source from disk, so it works while another program writes the source
  'thread/fork': (p) => {
    const src = find(p.threadId);
    const order = turnsOf(src);
    const keep = p.lastTurnId ? order.slice(0, order.indexOf(p.lastTurnId) + 1) : order;
    if (p.lastTurnId && !order.includes(p.lastTurnId)) throw Object.assign(new Error(`turn not found: ${p.lastTurnId}`), { code: -32600 });
    const th = newThread(src.cwd, p.model || src.model, src.id);
    th.items = src.items.filter((x) => keep.includes(x.turnId));
    hold(th.id);
    const idx = readIndex();
    idx[th.id] = th;
    writeIndex(idx);
    return { thread: pub(th) };
  },
  'thread/name/set': (p) => {
    const idx = readIndex();
    if (!idx[p.threadId]) throw Object.assign(new Error('thread not found'), { code: -32600 });
    idx[p.threadId].name = p.name;
    writeIndex(idx);
    return {};
  },
  'turn/start': (p) => {
    const th = find(p.threadId);
    if (!held.has(th.id)) throw Object.assign(new Error(`thread ${th.id} is not loaded`), { code: -32600 });
    if (p.model) th.model = p.model;
    if (p.effort) th.reasoningEffort = p.effort;
    const turnId = crypto.randomUUID();
    setTimeout(() => runTurn(th, turnId, p.input || []), 30);
    return { turn: { id: turnId, status: 'inProgress', items: [] } };
  },
  'turn/interrupt': (p) => {
    running.get(p.threadId)?.stop();
    return {};
  },
  'thread/unsubscribe': () => ({ status: 'unsubscribed' }),
  'thread/archive': (p) => {
    const idx = readIndex();
    delete idx[p.threadId];
    writeIndex(idx);
    return {};
  },
};

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return;
  }
  if (o.id == null) return;                                   // notifications (initialized)
  const h = handlers[o.method];
  if (!h) return send({ id: o.id, error: { code: -32601, message: `unknown method ${o.method}` } });
  try {
    send({ id: o.id, result: await h(o.params || {}) });
  } catch (e) {
    send({ id: o.id, error: { code: e.code || -32000, message: e.message } });
  }
});
rl.on('close', () => process.exit(0));
