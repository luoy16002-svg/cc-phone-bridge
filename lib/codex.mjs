// Codex on this computer, through its own app server (`codex app-server`: JSON-RPC over stdio). The threads are the
// ones the Codex app and the codex CLI keep in CODEX_HOME: the phone lists, reads, continues and starts them, and
// replies stream in word by word. One app server serves every thread; a CodexRunner per thread has the same face as
// the Claude Runner (lib/claude.mjs), so server.mjs treats both agents alike.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG } from './config.mjs';
import { shortPath } from './describe.mjs';
import { killTree, PHONE_NOTE } from './claude.mjs';

const CALL_MS = 30000;
const FORCE_STOP_MS = 8000;
const cut = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

export function codexHome() {
  return CONFIG.codex.home || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

// The executable: a test stand-in, or the configured command found on PATH (spawned directly, never by a shell).
export function codexCommand() {
  if (process.env.CCPB_CODEX_CMD) {
    const [bin, ...pre] = JSON.parse(process.env.CCPB_CODEX_CMD);
    return { bin, pre };
  }
  return { bin: findOnPath(CONFIG.codex.command), pre: CONFIG.codex.args };
}

function findOnPath(cmd) {
  if (!cmd || /[\\/]/.test(cmd)) return cmd;
  const exts = process.platform === 'win32' ? ['.exe', '.com', ''] : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch { /* not here */ }
    }
  }
  return '';
}

// ---------------------------------------------------------------- items -> the events the phone shows
// Items come from the app server (camelCase types and fields) and from rollout files (PascalCase types, snake_case
// fields); both are read here. Ids are the items' own, so a live event and the same one in history are one event.
const lowerFirst = (s) => (s ? s[0].toLowerCase() + s.slice(1) : '');
const get = (o, ...keys) => {
  for (const k of keys) if (o && o[k] != null) return o[k];
  return undefined;
};

function inputParts(content) {
  let text = '';
  let images = 0;
  for (const c of Array.isArray(content) ? content : []) {
    const k = lowerFirst(c?.type || '');
    if (k === 'text' || k === 'inputText' || k === 'input_text') text += (text ? '\n' : '') + String(c.text || '');
    else if (/image/i.test(k)) images += 1;
  }
  return { text: text.trim(), images };
}

function textOf(content) {
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : []).map((c) => (typeof c === 'string' ? c : c?.text || '')).filter(Boolean).join('\n');
}

function argSummary(args) {
  let a = args;
  if (typeof a === 'string') {
    try {
      a = JSON.parse(a);
    } catch {
      return a;
    }
  }
  if (!a || typeof a !== 'object') return String(a ?? '');
  const k = ['description', 'command', 'cmd', 'query', 'path', 'file_path', 'url', 'pattern', 'prompt', 'name'].find((x) => typeof a[x] === 'string' && a[x]);
  return k ? a[k] : JSON.stringify(a);
}

function resultText(r) {
  if (r == null) return '';
  if (typeof r === 'string') return r;
  if (Array.isArray(r)) return r.map(resultText).filter(Boolean).join('\n');
  if (Array.isArray(r.content)) return r.content.map((c) => c?.text || (c?.type ? `[${c.type}]` : '')).join('\n');
  if (typeof r.text === 'string') return r.text;
  return JSON.stringify(r);
}

const KIND_WORD = { add: '新建', delete: '删除', update: '修改' };

export function toolName(raw) {
  const k = lowerFirst(raw?.type || '');
  return { commandExecution: 'Bash', fileChange: 'Edit', webSearch: 'WebSearch', imageView: 'Read', collabAgentToolCall: 'Agent', subAgentActivity: 'Agent', imageGeneration: 'Image' }[k]
    || (k === 'mcpToolCall' ? `${get(raw, 'server') || 'mcp'}.${get(raw, 'tool') || ''}` : k === 'dynamicToolCall' ? String(get(raw, 'tool') || 'tool') : k);
}

export function itemEvents(raw, t = 0, cwd = '', model = '') {
  if (!raw || typeof raw !== 'object') return [];
  const k = lowerFirst(raw.type || '');
  const id = String(raw.id || '');
  const out = [];
  const tool = (name, summary, detail = '') => out.push({ k: 'tool', id, tool: id, t, name, summary: cut(oneLine(summary), 160), detail: cut(detail, 1500) });
  const done = (ok, text = '') => out.push({ k: 'tool_result', id: `${id}:r`, tool: id, t, ok, text: cut(text, 1200) });
  const finished = (st) => !st || !/progress/i.test(String(st));
  switch (k) {
    case 'userMessage': {
      const { text, images } = inputParts(raw.content);
      if (text || images) out.push({ k: 'user', id, t, text, images });
      break;
    }
    case 'agentMessage': {
      const text = typeof raw.text === 'string' ? raw.text : textOf(raw.content);
      if (text && text.trim()) out.push({ k: 'text', id, t, text, model });
      break;
    }
    case 'reasoning': {
      const s = get(raw, 'summary', 'summary_text');
      const text = Array.isArray(s) ? s.map((x) => (typeof x === 'string' ? x : x?.text || '')).join('\n') : String(s || '');
      if (text.trim()) out.push({ k: 'think', id, t, text: cut(text.trim(), 1500) });
      break;
    }
    case 'commandExecution': {
      const cmd = get(raw, 'command');
      const line = Array.isArray(cmd) ? cmd.join(' ') : String(cmd || '');
      tool('Bash', line, line);
      const st = get(raw, 'status');
      if (finished(st)) {
        const code = get(raw, 'exitCode', 'exit_code');
        done(code === 0 || (code == null && !/fail|declin/i.test(String(st))), String(get(raw, 'aggregatedOutput', 'aggregated_output', 'stdout') || ''));
      }
      break;
    }
    case 'fileChange': {
      const ch = get(raw, 'changes');
      const list = Array.isArray(ch) ? ch : ch && typeof ch === 'object' ? Object.entries(ch).map(([p, v]) => ({ path: p, kind: v?.type || v })) : [];
      const files = list.map((c) => ({ path: shortPath(c.path, cwd), kind: typeof c.kind === 'object' ? c.kind?.type : c.kind }));
      tool('Edit', files.length ? `${files[0].path}${files.length > 1 ? `  +${files.length - 1}` : ''}` : '', files.map((f) => `${KIND_WORD[f.kind] || f.kind || ''} ${f.path}`.trim()).join('\n'));
      const st = get(raw, 'status');
      if (finished(st)) done(!/fail|declin/i.test(String(st)), String(get(raw, 'stderr') || ''));
      break;
    }
    case 'mcpToolCall':
    case 'dynamicToolCall': {
      const args = get(raw, 'arguments');
      tool(toolName(raw), argSummary(args), typeof args === 'string' ? args : JSON.stringify(args ?? {}, null, 1));
      const st = get(raw, 'status');
      if (finished(st)) {
        const err = get(raw, 'error');
        done(!err && !/fail/i.test(String(st)) && raw.success !== false, err ? resultText(err.message || err) : resultText(get(raw, 'result', 'contentItems')));
      }
      break;
    }
    case 'webSearch':
    case 'extension': {
      const q = get(raw, 'query') || get(raw.action || {}, 'query') || (Array.isArray(get(raw.action || {}, 'queries')) ? raw.action.queries.join(' · ') : '') || get(raw.action || {}, 'url') || '';
      tool('WebSearch', q);
      done(true, '');
      break;
    }
    case 'imageView':
      tool('Read', shortPath(get(raw, 'path') || '', cwd));
      done(true, '');
      break;
    case 'imageGeneration':
      tool('Image', get(raw, 'revisedPrompt', 'revised_prompt') || '');
      if (finished(get(raw, 'status'))) done(!get(raw, 'failure'), '');
      break;
    case 'collabAgentToolCall':
      tool('Agent', get(raw, 'prompt') || get(raw, 'tool') || '', get(raw, 'prompt') || '');
      if (finished(get(raw, 'status'))) done(true, '');
      break;
    case 'subAgentActivity':
      tool('Agent', `${get(raw, 'agentPath', 'agent_path') || ''} ${get(raw, 'kind') || ''}`.trim());
      done(true, '');
      break;
    case 'plan': {
      const text = String(get(raw, 'text') || '');
      if (text.trim()) out.push({ k: 'think', id, t, text: cut(text.trim(), 1500) });
      break;
    }
    case 'contextCompaction':
      out.push({ k: 'note', id, t, tone: 'info', text: '上下文自动压缩了一次' });
      break;
    default:
      break;
  }
  return out;
}

// ---------------------------------------------------------------- reading a rollout file (the PC side)
function readSlice(file, start, len) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

const TURN_END = new Set(['task_complete', 'turn_aborted', 'task_failed', 'turn_complete']);

// The tail of a rollout: the last prompt and reply, the model, and whether a turn is running (started, not ended).
const rolloutCache = new Map();
export function rolloutInfo(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const key = `${file}|${st.mtimeMs}|${st.size}`;
  const hit = rolloutCache.get(file);
  if (hit && hit.key === key) return hit.info;
  const len = Math.min(st.size, 384 * 1024);
  const lines = readSlice(file, st.size - len, len).toString('utf8').split('\n');
  if (st.size > len) lines.shift();
  const info = { lastPrompt: '', lastReply: '', model: '', effort: '', busy: false, mtime: st.mtimeMs, size: st.size };
  for (const l of lines) {
    if (!l.trim()) continue;
    let o;
    try {
      o = JSON.parse(l);
    } catch {
      continue;
    }
    const p = o.payload || {};
    if (o.type === 'turn_context') {
      info.model = p.model || info.model;
      info.effort = p.collaboration_mode?.settings?.reasoning_effort || p.effort || info.effort;
    } else if (o.type === 'event_msg') {
      if (p.type === 'task_started') info.busy = true;
      else if (TURN_END.has(p.type)) info.busy = false;
      else if (p.type === 'item_completed') {
        const k = lowerFirst(p.item?.type || '');
        if (k === 'userMessage') info.lastPrompt = inputParts(p.item.content).text || info.lastPrompt;
        else if (k === 'agentMessage') info.lastReply = (typeof p.item.text === 'string' ? p.item.text : textOf(p.item.content)) || info.lastReply;
      }
    }
  }
  rolloutCache.set(file, { key, info });
  if (rolloutCache.size > 400) rolloutCache.delete(rolloutCache.keys().next().value);
  return info;
}

// New lines of a rollout since a byte offset, as phone events and turn boundaries.
export function rolloutLineEvents(o, cwd, out) {
  const p = o?.payload || {};
  if (o?.type !== 'event_msg') return null;
  if (p.type === 'task_started') return 'start';
  if (TURN_END.has(p.type)) return 'end';
  if (p.type === 'item_completed') {
    for (const ev of itemEvents(p.item, Date.parse(o.timestamp || '') || Date.now(), cwd)) out.push(ev);
  }
  return null;
}

// The newest rollout file of a thread, found by its id in the file names under CODEX_HOME/sessions (newest days first).
export function findRollout(id) {
  const root = path.join(codexHome(), 'sessions');
  const key = String(id).toLowerCase();
  const kids = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  for (const y of kids(root).filter((d) => d.isDirectory()).map((d) => d.name).sort().reverse()) {
    for (const m of kids(path.join(root, y)).filter((d) => d.isDirectory()).map((d) => d.name).sort().reverse()) {
      for (const d of kids(path.join(root, y, m)).filter((x) => x.isDirectory()).map((x) => x.name).sort().reverse()) {
        const dir = path.join(root, y, m, d);
        const hit = kids(dir).filter((f) => f.isFile() && f.name.toLowerCase().includes(key) && f.name.endsWith('.jsonl'))
          .map((f) => path.join(dir, f.name));
        if (hit.length) return hit.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
      }
    }
  }
  return '';
}

// The thread id in a rollout file name: rollout-<time>-<thread id>[_<more>].jsonl
export function rolloutId(name) {
  const m = /rollout-[0-9T:-]+?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : null;
}

// ---------------------------------------------------------------- Codex's own settings
function topLevelToml(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;                       // tables start: top-level keys are over
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*"([^"]*)"/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// ---------------------------------------------------------------- one `codex app-server` process
// JSON-RPC 2.0 as JSON lines over stdio. Requests from Codex (approvals, questions) are refused: the phone cannot
// answer them, and with the usual approval policy ("never") none come.
const REFUSALS = {
  'item/commandExecution/requestApproval': { decision: 'decline' },
  'item/fileChange/requestApproval': { decision: 'decline' },
  applyPatchApproval: { decision: 'abort' },
  execCommandApproval: { decision: 'abort' },
  'mcpServer/elicitation/request': { action: 'decline' },
  'item/tool/requestUserInput': { answers: {} },
};

export class AppServer extends EventEmitter {
  constructor(log, label, clientVersion = '') {
    super();
    Object.assign(this, { log, label, clientVersion });
    this.proc = null;
    this.ready = null;
    this.pending = new Map();
    this.n = 0;
    this.buf = '';
    this.stderr = '';
    this.version = '';
    this.stopping = false;
  }

  get pid() {
    return this.proc?.pid || null;
  }

  ensure() {
    if (!this.ready) {
      this.ready = this.start().catch((e) => {
        this.ready = null;
        throw e;
      });
    }
    return this.ready;
  }

  async start() {
    const { bin, pre } = codexCommand();
    if (!bin) throw new Error('codex not found');
    const env = { ...process.env };
    if (CONFIG.codex.home) env.CODEX_HOME = CONFIG.codex.home;
    this.stopping = false;
    const p = spawn(bin, [...pre, 'app-server'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
    this.proc = p;
    this.buf = '';
    this.stderr = '';
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', (d) => this.onData(d));
    p.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-4000); });
    p.stdin.on('error', (e) => this.log(`codex ${this.label}: stdin ${e.code || e.message}`));
    p.on('error', (e) => this.log(`codex ${this.label}: ${e.message}`));
    p.on('exit', (code, signal) => this.onExit(p, code, signal));
    this.emit('pid', p.pid);
    const init = await this.request('initialize', { clientInfo: { name: 'duty-desk', title: 'Duty Desk', version: this.clientVersion } }, 20000);
    this.version = (/(\d+\.\d+\.\d+)/.exec(String(init?.userAgent || '')) || [''])[0];
    this.notify('initialized');
    return this;
  }

  onExit(p, code, signal) {
    if (this.proc !== p) return;
    this.proc = null;
    this.ready = null;
    if (!this.stopping) {
      const tail = this.stderr.trim().split('\n').slice(-2).join(' | ');
      this.log(`codex ${this.label}: app server exited code ${code} signal ${signal || ''}${tail ? `: ${cut(tail, 300)}` : ''}`);
    }
    for (const [, w] of this.pending) w.reject(new Error('codex app server exited'));
    this.pending.clear();
    this.emit('exit', !this.stopping);
  }

  send(obj) {
    if (!this.proc) throw new Error('codex app server not running');
    this.proc.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  request(method, params, ms = CALL_MS) {
    return new Promise((resolve, reject) => {
      const id = ++this.n;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex ${method} timed out`));
      }, ms);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        this.send({ jsonrpc: '2.0', id, method, params: params ?? {} });
      } catch (e) {
        this.pending.get(id)?.reject(e);
        this.pending.delete(id);
      }
    });
  }

  async call(method, params, ms) {
    await this.ensure();
    return this.request(method, params, ms);
  }

  notify(method, params) {
    try {
      this.send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
    } catch { /* gone */ }
  }

  onData(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      try {
        this.onMessage(o);
      } catch (e) {
        this.log(`codex ${this.label}: handler error ${e.stack || e.message}`);
      }
    }
  }

  onMessage(o) {
    if (o.id != null && !o.method) {
      const w = this.pending.get(o.id);
      if (!w) return;
      this.pending.delete(o.id);
      if (o.error) w.reject(Object.assign(new Error(o.error.message || 'codex error'), { code: o.error.code }));
      else w.resolve(o.result);
      return;
    }
    if (o.method && o.id != null) {
      if (o.method in REFUSALS) this.send({ jsonrpc: '2.0', id: o.id, result: REFUSALS[o.method] });
      else this.send({ jsonrpc: '2.0', id: o.id, error: { code: -32601, message: 'not available from the phone' } });
      this.log(`codex ${this.label}: asked ${o.method}; refused`);
      this.emit('refused', o.method, o.params || {});
      return;
    }
    if (o.method) this.emit('notify', o.method, o.params || {});
  }

  stop() {
    const p = this.proc;
    this.ready = null;
    if (!p) return Promise.resolve();
    this.stopping = true;
    try {
      p.stdin.end();
    } catch { /* gone */ }
    return killTree(p.pid);
  }
}

// ---------------------------------------------------------------- reading: threads, history, models
// One long-lived app server reads; it never loads a thread for writing, so the Codex app and the CLI on the computer
// can open any thread at any time.
export class CodexHub extends EventEmitter {
  constructor(log) {
    super();
    this.log = log;
    this.app = new AppServer(log, 'reader');
    this.app.on('pid', (pid) => this.emit('pid', pid));
    this.threads = new Map();         // thread id -> what thread/list or thread/read said
    this.modelCache = null;
    this.reason = !CONFIG.codex.enabled ? 'disabled' : codexCommand().bin ? '' : 'not_found';
  }

  set clientVersion(v) {
    this.app.clientVersion = v;
    this._clientVersion = v;
  }

  get clientVersion() {
    return this._clientVersion || '';
  }

  get available() {
    return !this.reason;
  }

  get version() {
    return this.app.version;
  }

  call(method, params, ms) {
    if (!this.available) return Promise.reject(new Error(`codex ${this.reason}`));
    return this.app.call(method, params, ms);
  }

  defaults() {
    let cfg = {};
    try {
      cfg = topLevelToml(fs.readFileSync(path.join(codexHome(), 'config.toml'), 'utf8'));
    } catch { /* no config */ }
    const models = this.modelCache?.list || [];
    const model = cfg.model || models.find((m) => m.isDefault)?.id || models[0]?.id || '';
    const m = models.find((x) => x.id === model);
    const effort = cfg.model_reasoning_effort || m?.defaultEffort || 'medium';
    return { model, effort };
  }

  async models() {
    if (this.modelCache && Date.now() - this.modelCache.at < 10 * 60000) return this.modelCache.list;
    const r = await this.call('model/list', {});
    const list = (r?.data || []).filter((m) => !m.hidden).map((m) => ({
      id: m.id || m.model,
      name: m.displayName || m.id || m.model,
      efforts: (m.supportedReasoningEfforts || []).map((e) => (typeof e === 'string' ? e : e.reasoningEffort)).filter(Boolean),
      defaultEffort: m.defaultReasoningEffort || '',
      isDefault: !!m.isDefault,
    }));
    this.modelCache = { at: Date.now(), list };
    return list;
  }

  modelsNow() {
    return this.modelCache?.list || [];
  }

  modelName(id) {
    return this.modelsNow().find((m) => m.id === id)?.name || String(id || '');
  }

  meta(th) {
    const id = String(th.id).toLowerCase();
    const old = this.threads.get(id) || {};
    const m = {
      id,
      cwd: th.cwd || old.cwd || '',
      name: th.name || '',
      preview: oneLine(th.preview || old.preview || ''),
      model: th.model || old.model || '',
      effort: th.reasoningEffort || old.effort || '',
      created: (Number(th.createdAt) || 0) * 1000 || old.created || 0,
      updatedAt: (Number(th.updatedAt) || 0) * 1000 || old.updatedAt || 0,
      status: th.status?.type || '',
      path: th.path || old.path || '',
      originator: th.originator || old.originator || '',
      sub: !!(th.parentThreadId || th.agentRole || th.agentNickname),
    };
    this.threads.set(id, m);
    return m;
  }

  async listThreads(limit = 80) {
    const r = await this.call('thread/list', { limit: Math.min(200, limit * 2), sortKey: 'updated_at', sortDirection: 'desc' });
    return (r?.data || []).map((th) => this.meta(th)).filter((m) => !m.sub && (m.preview || m.name)).slice(0, limit);
  }

  async lookup(id) {
    const key = String(id).toLowerCase();
    if (this.threads.has(key)) return this.threads.get(key);
    return this.refresh(key);
  }

  async refresh(id) {
    if (!this.available) return null;
    try {
      const r = await this.call('thread/read', { threadId: id, includeTurns: false }, 10000);
      return r?.thread ? this.meta(r.thread) : this.threads.get(id) || null;
    } catch {
      return this.threads.get(id) || null;
    }
  }

  // A page of history from the end: the newest `want` items before `cursor` (opaque), oldest first.
  async history(id, { cursor = null, want = 140 } = {}) {
    const meta = this.threads.get(id) || {};
    const r = await this.call('thread/items/list', { threadId: id, limit: want, sortDirection: 'desc', ...(cursor ? { cursor } : {}) });
    const entries = (r?.data || []).slice().reverse();
    const events = [];
    for (const e of entries) {
      const t = Number(e.completedAtMs || e.startedAtMs) || 0;
      for (const ev of itemEvents(e.item, t, meta.cwd, meta.model)) events.push(ev);
    }
    return { events, cursor: r?.nextCursor || null, hasMore: !!r?.nextCursor };
  }

  stop() {
    return this.app.stop();
  }
}

// ---------------------------------------------------------------- writing: one thread the phone drives
// While the phone runs a turn, the thread is held by an app server of its own; when the turn ends and nothing is
// waiting, that app server exits, which lets go of the thread (Codex lets one program at a time write a thread).
export class CodexRunner extends EventEmitter {
  constructor({ id = null, cwd, model, effort, phoneNote = false, idleMinutes = 20 }, hub, log) {
    super();
    Object.assign(this, { id, cwd, model, effort, phoneNote, idleMinutes, hub, log });
    this.agent = 'codex';
    this.app = null;
    this.proc = null;              // truthy while our writer holds the thread
    this.retiring = null;
    this.state = 'idle';
    this.queue = [];
    this.live = [];
    this.notes = [];
    this.turn = null;
    this.turnId = null;
    this.liveText = '';
    this.activity = null;
    this.n = 0;
    this.lastUsed = Date.now();
  }

  nid(p) {
    this.n += 1;
    return `${p}-${Date.now().toString(36)}-${this.n}`;
  }

  push(ev) {
    const i = this.live.findIndex((e) => e.id === ev.id);
    if (i >= 0) this.live[i] = ev;
    else this.live.push(ev);
    this.emit('event', ev);
    return ev;
  }

  note(tone, key, vars) {
    const text = vars ? key.replace(/\{(\w+)\}/g, (m, k) => String(vars[k] ?? '')) : key;
    const ev = { k: 'note', id: this.nid('note'), t: Date.now(), tone, text, key, vars, bridge: true };
    this.notes.push(ev);
    if (this.notes.length > 40) this.notes.shift();
    return this.push(ev);
  }

  transient(ev) {
    if (ev.k === 'delta') this.liveText += ev.text;
    if (ev.k === 'activity') {
      this.activity = ev;
      if (ev.what === 'writing') this.liveText = '';
    }
    this.emit('transient', ev);
  }

  setState(state) {
    this.state = state;
    this.emit('state');
  }

  // content: { text, images: [local paths] }
  enqueue(content, shown) {
    const ev = { k: 'user', id: this.nid('pending'), t: Date.now(), text: shown.text, images: shown.images || [], pending: true, state: 'queued' };
    const busy = this.state === 'running';
    this.queue.push({ ev, content });
    this.push(ev);
    this.lastUsed = Date.now();
    this.pump();
    return { id: ev.id, queued: busy };
  }

  writer() {
    if (this.app) return this.app;
    const app = new AppServer(this.log, `writer ${this.id || '(new)'}`, this.hub.clientVersion);
    app.on('notify', (method, p) => {
      if (!p.threadId || !this.id || String(p.threadId).toLowerCase() === this.id) this.onNotify(method, p);
    });
    app.on('refused', (method) => {
      if (/approval|requestUserInput|elicitation/i.test(method)) this.note('warn', 'Codex 请求确认，手机上不能代答，已拒绝。要放行，请在电脑上改 Codex 的审批设置');
    });
    app.on('exit', (unexpected) => {
      if (this.app === app) this.app = null;
      this.proc = null;
      this.emit('exit');
      if (unexpected) this.onHubDown();
    });
    app.on('pid', () => this.emit('pid'));
    this.app = app;
    return app;
  }

  async load() {
    if (this.proc) return;
    const app = this.writer();
    if (!this.id) {
      const r = await app.call('thread/start', {
        cwd: this.cwd,
        ...(this.model ? { model: this.model } : {}),
        ...(this.phoneNote ? { developerInstructions: PHONE_NOTE } : {}),
      });
      const id = String(r?.thread?.id || '').toLowerCase();
      if (!id) throw new Error('Codex did not start a thread');
      this.hub.meta({ ...r.thread, cwd: r.thread.cwd || this.cwd });
      this.id = id;
      app.label = `writer ${id}`;
      this.proc = { thread: id };
      this.emit('init', id, null);
      return;
    }
    await app.call('thread/resume', { threadId: this.id, excludeTurns: true });
    this.proc = { thread: this.id };
  }

  async pump() {
    if (this.state === 'running' || !this.queue.length) {
      this.emit('state');
      return;
    }
    const next = this.queue.shift();
    clearTimeout(this.idleTimer);
    this.live = this.live.filter((e) => (e.k === 'user' && e.state === 'queued' && e.id !== next.ev.id) || e.bridge);
    this.turn = { start: Date.now() };
    this.turnId = null;
    this.liveText = '';
    this.activity = null;
    this.setState('running');
    try {
      await this.load();
      this.push({ ...next.ev, state: 'sent' });
      const input = [];
      if (next.content.text) input.push({ type: 'text', text: next.content.text, text_elements: [] });
      for (const p of next.content.images || []) input.push({ type: 'localImage', path: p });
      const r = await this.app.call('turn/start', {
        threadId: this.id,
        input,
        ...(this.model ? { model: this.model } : {}),
        ...(this.effort ? { effort: this.effort } : {}),
      });
      this.turnId = r?.turn?.id || this.turnId;
      this.log(`codex thread ${this.id}: turn ${this.turnId} started, ${this.model} ${this.effort}`);
    } catch (e) {
      this.push({ ...next.ev, state: 'canceled' });
      if (/active writer|thread-store conflict/i.test(e.message)) {
        // the Codex app or the CLI on the computer has this thread open
        this.note('warn', '这个对话正在电脑上的 Codex 里开着，同一时间只能有一处接着写。先在电脑上关掉它，或等它空闲后再发');
      } else {
        this.note('error', '没能交给 Codex：{msg}', { msg: cut(e.message, 300) });
      }
      if (!this.id) this.emit('failed');
      this.finishTurn({ ok: false, reason: 'spawn' });
    }
  }

  onNotify(method, p) {
    const t = Date.now();
    switch (method) {
      case 'turn/started':
        this.turnId = p.turn?.id || this.turnId;
        break;
      case 'item/started': {
        const k = lowerFirst(p.item?.type || '');
        if (k === 'agentMessage') this.transient({ k: 'activity', what: 'writing' });
        else if (k === 'reasoning' || k === 'plan') this.transient({ k: 'activity', what: 'thinking' });
        else if (k !== 'userMessage') this.transient({ k: 'activity', what: 'tool', name: toolName(p.item) });
        break;
      }
      case 'item/agentMessage/delta':
        if (p.delta) this.transient({ k: 'delta', text: p.delta });
        break;
      case 'item/completed': {
        const k = lowerFirst(p.item?.type || '');
        if (k === 'userMessage') break;                    // the phone already shows what it sent
        for (const ev of itemEvents(p.item, Number(p.completedAtMs) || t, this.cwd, this.model)) {
          if (ev.k === 'text') this.liveText = '';
          this.push(ev);
        }
        break;
      }
      case 'turn/completed': {
        const turn = p.turn || {};
        const status = String(turn.status || '');
        if (turn.error?.message && status !== 'interrupted') this.note('error', '{text}', { text: cut(turn.error.message, 600) });
        this.finishTurn({ ok: status === 'completed', ms: turn.durationMs, reason: status === 'interrupted' ? 'interrupted' : status === 'completed' ? '' : 'failed' });
        break;
      }
      case 'error':
        if (!p.willRetry && p.error?.message) this.note('error', '{text}', { text: cut(p.error.message, 600) });
        break;
      case 'thread/compacted':
        this.push({ k: 'note', id: this.nid('note'), t, tone: 'info', text: '上下文自动压缩了一次' });
        break;
      default:
        break;
    }
  }

  finishTurn(res) {
    if (this.state !== 'running' && !this.turn) return;
    clearTimeout(this.stopTimer);
    this.stopTimer = null;
    const ms = res.ms ?? (this.turn ? Date.now() - this.turn.start : 0);
    const ev = this.push({ k: 'result', id: this.nid('result'), t: Date.now(), ok: res.ok, ms, reason: res.reason });
    this.turn = null;
    this.turnId = null;
    this.liveText = '';
    this.activity = null;
    this.lastUsed = Date.now();
    this.setState('idle');
    this.emit('finished', ev);
    if (this.queue.length) this.pump();
    else this.armIdle();
  }

  // Let go of the thread a moment after a turn, so the computer can pick the same conversation up right away.
  armIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close('done'), 2500);
  }

  interrupt() {
    if (this.queue.length) {
      for (const q of this.queue) this.push({ ...q.ev, state: 'canceled' });
      this.queue = [];
      this.emit('state');
    }
    if (this.state !== 'running') return false;
    if (this.turnId && this.app) this.app.call('turn/interrupt', { threadId: this.id, turnId: this.turnId }).catch((e) => this.log(`codex interrupt failed ${e.message}`));
    clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => {
      if (this.state === 'running') {
        this.note('warn', '打断没有及时生效，已强制停止');
        this.finishTurn({ ok: false, reason: 'stopped' });
        this.app?.stop();
      }
    }, FORCE_STOP_MS);
    return true;
  }

  async forceStop(why) {
    if (this.state === 'running') {
      if (why) this.note('warn', why);
      this.finishTurn({ ok: false, reason: 'stopped' });
    }
    await this.app?.stop();
  }

  close(reason) {
    clearTimeout(this.idleTimer);
    if (this.state === 'running') return;
    if (this.app) {
      this.log(`codex thread ${this.id}: let go (${reason})`);
      this.app.stop();
    }
    this.proc = null;
  }

  onHubDown() {
    this.proc = null;
    if (this.state === 'running') {
      this.note('error', 'Codex 中途退出了');
      this.finishTurn({ ok: false, reason: 'exit' });
    }
  }
}
