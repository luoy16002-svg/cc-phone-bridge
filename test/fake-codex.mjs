// Stands in for `codex app-server` in tests: the JSON-RPC methods Duty Desk uses, the same notification shapes, and
// like the real one it keeps threads in CODEX_HOME (an index file plus a rollout file per thread) and lets one
// process at a time write a thread (a lock file; a second writer gets "already has an active writer").
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
const held = new Set();
const lockOf = (id) => path.join(HOME, `${id}.lock`);
function hold(id) {
  const lf = lockOf(id);
  if (fs.existsSync(lf)) {
    const pid = Number(fs.readFileSync(lf, 'utf8'));
    let alive = pid !== process.pid;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (alive) throw Object.assign(new Error(`thread-store conflict: thread ${id} already has an active writer`), { code: -32600 });
  }
  fs.writeFileSync(lf, String(process.pid));
  held.add(id);
}
const release = () => {
  for (const id of held) {
    try {
      fs.unlinkSync(lockOf(id));
    } catch { /* gone */ }
  }
};
process.on('exit', release);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

const roll = (th, o) => fs.appendFileSync(th.path, `${JSON.stringify({ timestamp: new Date().toISOString(), ...o })}\n`);
function newThread(cwd, model) {
  const id = crypto.randomUUID();
  const day = new Date().toISOString().slice(0, 10).split('-');
  const dir = path.join(HOME, 'sessions', ...day);
  fs.mkdirSync(dir, { recursive: true });
  const th = { id, cwd, model, reasoningEffort: 'medium', preview: '', name: '', createdAt: Math.floor(Date.now() / 1000), updatedAt: Math.floor(Date.now() / 1000), path: path.join(dir, `rollout-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}-${id}.jsonl`), items: [] };
  fs.writeFileSync(th.path, `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: { id, cwd } })}\n`);
  return th;
}
const pub = (th) => ({ id: th.id, cwd: th.cwd, model: th.model, reasoningEffort: th.reasoningEffort, preview: th.preview, name: th.name, createdAt: th.createdAt, updatedAt: th.updatedAt, path: th.path, status: { type: 'idle' }, originator: 'fake', source: 'cli' });

const running = new Map();     // thread id -> { turnId, stop }

async function runTurn(th, input, model, effort) {
  const text = (input.find((i) => i.type === 'text') || {}).text || '';
  const turnId = crypto.randomUUID();
  const started = Date.now();
  let stopped = false;
  running.set(th.id, { turnId, stop: () => { stopped = true; } });
  notify('turn/started', { threadId: th.id, turn: { id: turnId, status: 'inProgress', items: [] } });
  roll(th, { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } });
  const user = { type: 'userMessage', id: crypto.randomUUID(), content: [{ type: 'text', text }] };
  th.items.push({ turnId, item: user, startedAtMs: started, completedAtMs: started });
  if (!th.preview) th.preview = text;
  roll(th, { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id: user.id, content: [{ type: 'text', text }] } } });
  notify('item/completed', { threadId: th.id, turnId, item: user, completedAtMs: Date.now() });
  const think = { type: 'reasoning', id: crypto.randomUUID(), summary: ['**Reading the request**'], content: [] };
  notify('item/started', { threadId: th.id, turnId, item: think, startedAtMs: Date.now() });
  notify('item/completed', { threadId: th.id, turnId, item: think, completedAtMs: Date.now() });
  th.items.push({ turnId, item: think, startedAtMs: Date.now(), completedAtMs: Date.now() });
  const cmd = { type: 'commandExecution', id: crypto.randomUUID(), command: 'echo hi', cwd: th.cwd, status: 'completed', exitCode: 0, aggregatedOutput: 'hi', commandActions: [] };
  notify('item/started', { threadId: th.id, turnId, item: { ...cmd, status: 'inProgress' }, startedAtMs: Date.now() });
  notify('item/completed', { threadId: th.id, turnId, item: cmd, completedAtMs: Date.now() });
  th.items.push({ turnId, item: cmd, startedAtMs: Date.now(), completedAtMs: Date.now() });
  const reply = /single word: (\w+)/.exec(text)?.[1] || `done: ${text.slice(0, 40)}`;
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
    roll(th, { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', id: msgId, content: [{ type: 'Text', text: said }] } } });
    notify('item/completed', { threadId: th.id, turnId, item: msg, completedAtMs: Date.now() });
  }
  roll(th, { type: 'event_msg', payload: { type: stopped ? 'turn_aborted' : 'task_complete', turn_id: turnId } });
  th.updatedAt = Math.floor(Date.now() / 1000);
  const idx = readIndex();
  idx[th.id] = th;
  writeIndex(idx);
  notify('turn/completed', { threadId: th.id, turn: { id: turnId, status: stopped ? 'interrupted' : 'completed', items: [], durationMs: Date.now() - started } });
}

const handlers = {
  initialize: () => ({ userAgent: 'fake_codex/9.9.9 (test)', codexHome: HOME, platformFamily: 'test', platformOs: 'test' }),
  'model/list': () => ({ data: [
    { id: 'fake-sol', model: 'fake-sol', displayName: 'Fake-Sol', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }, { reasoningEffort: 'medium', description: '' }, { reasoningEffort: 'max', description: '' }], defaultReasoningEffort: 'medium', isDefault: true },
    { id: 'fake-luna', model: 'fake-luna', displayName: 'Fake-Luna', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }, { reasoningEffort: 'high', description: '' }], defaultReasoningEffort: 'low', isDefault: false },
    { id: 'fake-hidden', model: 'fake-hidden', displayName: 'Hidden', hidden: true, supportedReasoningEfforts: [], defaultReasoningEffort: 'low', isDefault: false },
  ], nextCursor: null }),
  'thread/list': (p) => {
    const all = Object.values(readIndex()).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, p.limit || 50);
    return { data: all.map(pub), nextCursor: null };
  },
  'thread/read': (p) => {
    const th = readIndex()[p.threadId];
    if (!th) throw Object.assign(new Error(`thread not found: ${p.threadId}`), { code: -32600 });
    return { thread: pub(th) };
  },
  'thread/items/list': (p) => {
    const th = readIndex()[p.threadId];
    if (!th) throw Object.assign(new Error('thread not found'), { code: -32600 });
    const items = th.items.slice().reverse();                 // desc
    const start = p.cursor ? Number(p.cursor) : 0;
    const page = items.slice(start, start + (p.limit || 50));
    const next = start + page.length < items.length ? String(start + page.length) : null;
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
    const th = readIndex()[p.threadId];
    if (!th) throw Object.assign(new Error('thread not found'), { code: -32600 });
    hold(th.id);
    return { thread: pub(th) };
  },
  'turn/start': (p) => {
    const th = readIndex()[p.threadId];
    if (!th) throw Object.assign(new Error('thread not found'), { code: -32600 });
    if (p.model) th.model = p.model;
    if (p.effort) th.reasoningEffort = p.effort;
    const turnId = crypto.randomUUID();
    setTimeout(() => runTurn(th, p.input || [], p.model, p.effort), 30);
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
