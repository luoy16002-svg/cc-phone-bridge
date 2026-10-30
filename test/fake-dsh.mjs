// Stands in for DeepSeek Harness's SDK runtime (`--profile sdk`) in tests: the same JSON-RPC over stdio, and like the real
// one it writes the conversation to <DSH_HOME>/sessions/--<folder>--/<id>/session.v4.jsonl.zstd, one zstd frame per batch.
// A file named `held` in a session's folder plays the computer's app holding it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';

const home = process.env.DSH_HOME;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (o) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...o })}\n`);
const folder = (cwd) => `--${String(cwd).replace(/[^a-zA-Z0-9]/g, '-')}--`;
const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : []);
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let cwd = process.cwd();
let model = 'deepseek-v4-pro';
const sessions = new Map();

function open(id) {
  if (sessions.has(id)) return sessions.get(id);
  let file = walk(path.join(home, 'sessions')).find((f) => path.basename(path.dirname(f)) === id && /session\.v\d+\.jsonl\.zstd$/.test(f));
  let seq = 0;
  let turn = 0;
  if (!file) {
    const dir = path.join(home, 'sessions', folder(cwd), id);
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'session.v4.jsonl.zstd');
    fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', version: 4, id, createdAt: Date.now(), cwd, isSeeded: false, delegationDepth: 0 })}\n`)));
  } else {
    const raw = fs.readFileSync(file);
    const text = process.env.FAKE_SEQ ? '' : '';
    seq = 100000 + (raw.length % 1000) + text.length;
    turn = 1000;
  }
  const s = { id, file, seq, turn, busy: false };
  sessions.set(id, s);
  return s;
}

function emit(s, list) {
  const lines = list.map(([type, data]) => ({ type, seq: s.seq++, time: Date.now(), data }));
  fs.appendFileSync(s.file, zlib.zstdCompressSync(Buffer.from(lines.map((l) => `${JSON.stringify(l)}\n`).join(''))));
  for (const event of lines) send({ method: 'session.event', params: { sessionId: s.id, event } });
}

const asks = new Map();
let rpc = 1000;
const askApproval = (s, toolName, reason) => new Promise((resolve) => {
  const id = ++rpc;
  asks.set(id, resolve);
  send({ id, method: 'approval/request', params: { sessionId: s.id, toolName, reason } });
});

const assistant = (s, text) => ['assistant/message', { turn: s.turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'deepseek-official', model } } }];

async function run(s, messageId, blocks) {
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  s.turn += 1;
  send({ method: 'session.status', params: { sessionId: s.id, status: 'running' } });
  const header = ['request/header', { header: { config: { provider: 'deepseek-official', model, reasoningEffort: 'high' }, adapterDefaults: { reasoningEffort: true } } }];
  const pics = blocks.filter((b) => b.type === 'image').map((b) => {
    const data = Buffer.from(b.data, 'base64');
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    const dir = path.join(home, 'attachments', 'v1', 'objects', hash.slice(0, 2));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, hash), data);
    return { type: 'image', attachment: { attachmentId: `sha256:${hash}`, mediaType: b.mimeType } };
  });
  emit(s, [['turn/start', { turn: s.turn }], ['step/start', { turn: s.turn, step: 1 }], ['user/message', { role: 'user', id: messageId, source: { kind: 'user' }, content: [{ type: 'text', text }, ...pics] }],
    ['user/message', { role: 'user', source: { kind: 'context' }, content: [{ type: 'text', text: '<system-reminder>不该显示</system-reminder>' }] }], header]);
  emit(s, [['session/title', { title: text.slice(0, 20), source: { kind: 'fallback' } }]]);
  if (/慢/.test(text)) await sleep(60000);
  if (/确认/.test(text)) {
    const answer = await askApproval(s, 'pwsh', 'echo hi');
    emit(s, [['tool/call', { turn: s.turn, step: 1, callId: 'call_a', name: 'pwsh', arguments: JSON.stringify({ command: 'echo hi' }) }],
      ['tool/result', { turn: s.turn, step: 1, message: { role: 'tool', toolCallId: 'call_a', isError: answer.outcome !== 'allowed-once', source: { kind: 'tool', callId: 'call_a' }, content: [{ type: 'text', text: answer.outcome }] } }]]);
  }
  if (/看图/.test(text)) {
    const data = Buffer.from(PNG, 'base64');
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    const dir = path.join(home, 'attachments', 'v1', 'objects', hash.slice(0, 2));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, hash), data);
    emit(s, [['tool/call', { turn: s.turn, step: 1, callId: 'call_i', name: 'read_image', arguments: JSON.stringify({ path: 'a.png' }) }],
      ['tool/result', { turn: s.turn, step: 1, message: { role: 'tool', toolCallId: 'call_i', source: { kind: 'tool', callId: 'call_i' }, content: [{ type: 'image', attachment: { attachmentId: `sha256:${hash}`, mediaType: 'image/png' } }] } }]]);
  }
  emit(s, [assistant(s, `收到：${text}`), ['step/end', { turn: s.turn, step: 1 }], ['turn/end', { turn: s.turn, reason: { kind: 'completed' } }]]);
  send({ method: 'session.status', params: { sessionId: s.id, status: 'idle' } });
}

const heldBy = (id) => walk(path.join(home, 'sessions')).some((f) => path.basename(f) === 'held' && path.basename(path.dirname(f)) === id);

readline.createInterface({ input: process.stdin }).on('line', (l) => {
  if (!l.trim()) return;
  const o = JSON.parse(l);
  if (o.method === undefined && asks.has(o.id)) {
    asks.get(o.id)(o.result || {});
    asks.delete(o.id);
    return;
  }
  const { id, method, params = {} } = o;
  if (method === 'initialize') {
    cwd = params.cwd;
    model = params.model;
    send({ id, result: { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0' } } });
  } else if (method === 'session/resume') {
    if (heldBy(params.sessionId)) send({ id, error: { code: -32603, message: `session "${params.sessionId}" is already owned by an active write handle` } });
    else {
      open(params.sessionId);
      send({ id, result: {} });
    }
  } else if (method === 'session/prompt') {
    const messageId = crypto.randomUUID();
    send({ id, result: { messageId } });
    run(open(params.sessionId), messageId, params.contentBlocks);
  } else if (method === 'shutdown') {
    send({ id, result: {} });
    process.exit(0);
  } else send({ id, error: { code: -32601, message: `unknown method ${method}` } });
});
