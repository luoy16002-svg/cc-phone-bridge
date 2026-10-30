// DeepSeek Harness: the conversations are its own session logs, turns run in its own SDK runtime (`--profile sdk`,
// JSON-RPC over stdio), started for a turn and let go right after, because a session has one writer at a time.
//
// <home>/sessions/--<folder>--/<encoded id>/session.v<N>.jsonl.zstd: a JSON header line, then one JSON event per line.
// Each batch is one zstd frame, so a log is read frame by frame and a followed one only from where it was left.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { CONFIG } from './config.mjs';
import { killTree } from './claude.mjs';
import { describeTool } from './describe.mjs';
import { keepFile } from './images.mjs';
import { preview } from './transcripts.mjs';

const RESULT_CHARS = 1200;
const RELEASE_MS = 3000;         // the session goes back to the computer this soon after a turn
const KEPT = 4;                  // conversations whose events stay in memory
const BUSY_MS = 15 * 60000;      // an open turn in a log that has not moved for this long is not running any more

const cut = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const one = (s, n) => cut(String(s ?? '').replace(/\s+/g, ' ').trim(), n);

export const dshHome = () => process.env.CCPB_DSH_HOME || CONFIG.dsh.home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const sessionsRoot = () => path.join(dshHome(), 'sessions');

// The runtime: a test stand-in, the configured command, or the desktop app's own executable in Node mode.
export function dshCommand() {
  if (process.env.CCPB_DSH_CMD) {
    const [bin, ...pre] = JSON.parse(process.env.CCPB_DSH_CMD);
    return { bin, pre, env: {} };
  }
  if (CONFIG.dsh.command) return { bin: CONFIG.dsh.command, pre: [], env: {} };
  const app = CONFIG.dsh.app || path.join(process.env.LOCALAPPDATA || os.homedir(), 'Programs', 'DeepSeek Harness');
  const bin = path.join(app, 'DeepSeek Harness.exe');
  if (!fs.existsSync(bin)) return null;
  const cli = path.join(app, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
  return { bin, pre: ['--expose-internals', cli], env: { ELECTRON_RUN_AS_NODE: '1', DSH_DESKTOP_NODE_EXECUTABLE: bin } };
}

export function dshVersion() {
  const c = dshCommand();
  if (!c || !c.env.DSH_DESKTOP_NODE_EXECUTABLE) return '';
  try {
    const app = path.dirname(c.bin);
    return JSON.parse(fs.readFileSync(path.join(app, 'resources', 'runtime', 'primary-runtime', 'runtime.json'), 'utf8')).desktopVersion || '';
  } catch {
    return '';
  }
}

export const dshAvailable = () => CONFIG.dsh.enabled !== false && typeof zlib.zstdDecompress === 'function' && !!dshCommand();

export const MODELS = () => CONFIG.dsh.models;
export const EFFORTS = () => CONFIG.dsh.efforts;
export const dshModelName = (id) => MODELS().find((m) => m.id === id)?.name || String(id || '').replace(/^deepseek-/, '');

// ---------------------------------------------------------------- reading a log
// Complete zstd frames in `b` from `from`, and where the first incomplete one starts.
export function zstdFrames(b, from = 0) {
  const out = [];
  let i = from;
  for (;;) {
    const start = i;
    if (i + 8 > b.length) return { frames: out, end: start };
    const magic = b.readUInt32LE(i);
    if ((magic & 0xfffffff0) === 0x184d2a50) {           // a skippable frame
      i += 8 + b.readUInt32LE(i + 4);
      if (i > b.length) return { frames: out, end: start };
      continue;
    }
    if (magic !== 0xfd2fb528) throw new Error(`not a zstd frame at byte ${i}`);
    i += 4;
    const desc = b[i++];
    const single = (desc >> 5) & 1;
    if (!single) i += 1;
    i += [0, 1, 2, 4][desc & 3];
    i += [single ? 1 : 0, 2, 4, 8][desc >> 6];
    for (;;) {
      if (i + 3 > b.length) return { frames: out, end: start };
      const h = b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
      i += 3 + (((h >> 1) & 3) === 1 ? 1 : h >> 3);      // a repeated byte takes one byte, whatever its count
      if (h & 1) break;
    }
    if ((desc >> 2) & 1) i += 4;
    if (i > b.length) return { frames: out, end: start };
    out.push(b.subarray(start, i));
  }
}

const unzstd = (frame) => new Promise((resolve, reject) => {
  zlib.zstdDecompress(frame, (err, out) => (err ? reject(err) : resolve(out)));
});

function readFrom(file, pos, size) {
  const len = size - pos;
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try {
    return buf.subarray(0, fs.readSync(fd, buf, 0, len, pos));
  } finally {
    fs.closeSync(fd);
  }
}

// The log with the highest generation in a session's folder.
function logIn(dir) {
  let best = null;
  let bestN = -1;
  for (const f of fs.readdirSync(dir)) {
    const m = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/.exec(f);
    if (!m) continue;
    const n = Number(m[1] || 0);
    if (n > bestN) {
      bestN = n;
      best = { file: path.join(dir, f), zstd: !!m[2] };
    }
  }
  return best;
}

// ---------------------------------------------------------------- what the phone shows of a log event
const TOOL_NAMES = { pwsh: 'PowerShell', bash: 'Bash', shell: 'Bash', read: 'Read', read_image: 'Read', write: 'Write', edit: 'Edit', grep: 'Grep', glob: 'Glob', web_fetch: 'WebFetch', web_search: 'WebSearch', subagent: 'Agent', todo_write: 'TodoWrite', skill: 'Skill' };

function textIn(content) {
  if (typeof content === 'string') return content;
  return (content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

// Pictures sit in the harness's own store under their sha256; log entries only name them.
function pictures(content) {
  const blocks = Array.isArray(content) ? content.filter((c) => c.type === 'image') : [];
  if (!blocks.length) return 0;
  const refs = blocks.map((c) => {
    const hash = /^sha256:([0-9a-f]{64})$/.exec(String(c.attachment?.attachmentId || ''))?.[1];
    return hash ? keepFile(path.join(dshHome(), 'attachments', 'v1', 'objects', hash.slice(0, 2), hash), true) : null;
  }).filter(Boolean);
  return refs.length === blocks.length ? refs : blocks.length;
}

function toolEvent(callId, name, argsText, t, id, cwd) {
  let args = {};
  try {
    args = JSON.parse(argsText || '{}');
  } catch { /* still shown by name */ }
  const shown = TOOL_NAMES[name] || name;
  const input = { ...args, file_path: args.file_path || args.path };
  return { k: 'tool', id, tool: callId, t, name: shown, ...describeTool(shown, input, cwd) };
}

// One log event -> the events the phone shows. `turns` remembers when each turn began.
export function logEvents(o, ctx, out) {
  const t = o.time || 0;
  const d = o.data || {};
  switch (o.type) {
    case 'user/message': {
      if (d.source?.kind !== 'user') return;
      const parts = Array.isArray(d.content) ? d.content : [];
      out.push({ k: 'user', id: d.id || `u${o.seq}`, t, text: textIn(parts), images: pictures(parts), seq: o.seq });
      return;
    }
    case 'assistant/message':
      for (const [i, c] of (d.message?.content || []).entries()) {
        if (c.type === 'text' && c.text?.trim()) out.push({ k: 'text', id: `${o.seq}:${i}`, t, text: c.text, model: d.message.source?.model || '', seq: o.seq });
        else if (c.type === 'reasoning' && c.text?.trim()) out.push({ k: 'think', id: `${o.seq}:${i}`, t, text: c.text, seq: o.seq });
      }
      return;
    case 'tool/call':
      out.push({ ...toolEvent(d.callId, d.name, d.arguments, t, `c${o.seq}`, ctx.cwd), seq: o.seq });
      return;
    case 'tool/result': {
      const m = d.message || {};
      const seen = pictures(m.content);
      out.push({ k: 'tool_result', id: `r${o.seq}`, tool: m.toolCallId, t, ok: !m.isError, text: cut(textIn(m.content), RESULT_CHARS), ...(seen ? { images: seen } : {}), seq: o.seq });
      return;
    }
    case 'turn/start':
      ctx.turns.set(d.turn, t);
      return;
    case 'turn/end': {
      const kind = d.reason?.kind || '';
      const from = ctx.turns.get(d.turn);
      ctx.turns.delete(d.turn);
      out.push({ k: 'result', id: `x${o.seq}`, t, ok: kind === 'completed', ms: from ? t - from : 0, reason: kind === 'interrupted' ? 'stopped' : kind, seq: o.seq });
      return;
    }
    case 'compaction/end':
      out.push({ k: 'note', id: `n${o.seq}`, t, tone: 'info', text: '上下文自动压缩了一次', seq: o.seq });
      return;
    default:
  }
}

// ---------------------------------------------------------------- the conversations on disk
const WANTED = new Set(['user/message', 'assistant/message', 'tool/call', 'tool/result', 'turn/start', 'turn/end', 'compaction/end', 'session/title']);
const LINE_TYPE = /^\{"type":"([^"]+)"/;
const ROUTE = /"config":\{"provider":"([^"]+)","model":"([^"]+)"/;
const EFFORT = /"reasoningEffort":"([^"]+)"/;

class Log {
  constructor(dir, file, zstd) {
    Object.assign(this, { dir, file, zstd, pos: 0, carry: '', decoder: new TextDecoder(), header: null, title: '', lastPrompt: '', lastReply: '', model: '', provider: '', effort: '', turnOpen: 0, created: 0, moved: 0, size: 0, mtime: 0 });
    this.ctx = { cwd: '', turns: new Map() };
    this.events = null;          // what the phone shows, kept only for conversations in use
    this.queue = Promise.resolve();
  }

  get id() {
    return this.header?.id;
  }

  get updatedAt() {
    return Math.max(this.moved, this.mtime);
  }

  // An open turn counts only while the log still moves: a crash leaves one open for good.
  get busy() {
    return !!this.turnOpen && Date.now() - this.mtime < BUSY_MS;
  }

  meta() {
    return {
      id: this.id, cwd: this.header?.cwd || '', title: one(this.title || this.lastPrompt, 80), lastPrompt: one(this.lastPrompt, 160),
      lastReply: one(preview(this.lastReply), 200), model: this.model, effort: this.effort, provider: this.provider, updatedAt: this.updatedAt, busy: this.busy,
    };
  }

  line(l) {
    if (!l.trim()) return;
    const type = LINE_TYPE.exec(l)?.[1];
    if (type === 'request/header') {
      const head = l.slice(0, 500);
      const m = ROUTE.exec(head);
      if (m) [, this.provider, this.model] = m;
      this.effort = EFFORT.exec(head)?.[1] || '';
      return;
    }
    if (type !== 'session' && type && !WANTED.has(type)) return;
    let o;
    try {
      o = JSON.parse(l);
    } catch {
      return;                                            // a torn last line after a crash
    }
    if (o.type === 'session') {
      this.header = o;
      this.ctx.cwd = o.cwd || '';
      this.created = o.createdAt || 0;
      return;
    }
    if (o.time) this.moved = Math.max(this.moved, o.time);
    if (o.type === 'session/title') this.title = o.data?.title || this.title;
    if (o.type === 'turn/start') this.turnOpen = o.data?.turn || 1;
    if (o.type === 'turn/end') this.turnOpen = 0;
    const evs = [];
    logEvents(o, this.ctx, evs);
    for (const ev of evs) {
      if (ev.k === 'user') this.lastPrompt = ev.text || this.lastPrompt;
      if (ev.k === 'text') {
        this.lastReply = ev.text;
        this.model = ev.model || this.model;
      }
      this.events?.push(ev);
    }
  }

  feed(text) {
    const lines = (this.carry + text).split('\n');
    this.carry = lines.pop();
    for (const l of lines) this.line(l);
  }

  // Reads what was added since the last time. One at a time per log.
  catchUp() {
    this.queue = this.queue.then(() => this.read()).catch(() => null);
    return this.queue;
  }

  async read() {
    const st = fs.statSync(this.file);
    if (st.size < this.pos) this.rewind();
    this.size = st.size;
    this.mtime = st.mtimeMs;
    if (st.size === this.pos) return;
    const buf = readFrom(this.file, this.pos, st.size);
    if (!this.zstd) {
      this.pos += buf.length;
      this.feed(this.decoder.decode(buf, { stream: true }));
      return;
    }
    const { frames, end } = zstdFrames(buf);
    for (const f of frames) this.feed((await unzstd(f)).toString('utf8'));
    this.pos += end;
  }

  rewind() {
    Object.assign(this, { pos: 0, carry: '', decoder: new TextDecoder(), turnOpen: 0 });
    this.ctx.turns = new Map();
    if (this.events) this.events = [];
  }
}

export class DshSessions {
  constructor() {
    this.logs = new Map();       // by folder
    this.byId = new Map();
    this.used = [];
  }

  // Finds the logs on disk and reads what changed. Subagents' sessions stay out of the list.
  async refresh() {
    const root = sessionsRoot();
    const seen = new Set();
    let projects = [];
    try {
      projects = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      return;
    }
    for (const p of projects) {
      let dirs = [];
      try {
        dirs = fs.readdirSync(path.join(root, p.name), { withFileTypes: true }).filter((d) => d.isDirectory());
      } catch {
        continue;
      }
      for (const d of dirs) {
        const dir = path.join(root, p.name, d.name);
        seen.add(dir);
        let log = this.logs.get(dir);
        if (!log) {
          let found = null;
          try {
            found = logIn(dir);
          } catch { /* going away */ }
          if (!found) continue;
          log = new Log(dir, found.file, found.zstd);
          this.logs.set(dir, log);
        }
        await log.catchUp();
        if (log.id) this.byId.set(log.id, log);
      }
    }
    for (const dir of [...this.logs.keys()]) {
      if (seen.has(dir)) continue;
      this.byId.delete(this.logs.get(dir).id);
      this.logs.delete(dir);
    }
  }

  has(id) {
    return this.byId.has(id);
  }

  get(id) {
    return this.byId.get(id) || null;
  }

  logOf(dirName) {
    for (const [dir, log] of this.logs) if (path.basename(dir) === dirName) return log;
    return null;
  }

  list(limit = 80) {
    return [...this.byId.values()]
      .filter((l) => l.header && l.header.origin !== 'subagent' && !l.header.delegationDepth && (l.lastPrompt || l.lastReply))
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit)
      .map((l) => l.meta());
  }

  // The events of one conversation, read in full the first time it is opened.
  async open(id) {
    const log = this.byId.get(id);
    if (!log) return null;
    if (!log.events) {
      await (log.queue = log.queue.then(() => {
        log.rewind();
        log.events = [];
        return log.read();
      }).catch(() => null));
    } else await log.catchUp();
    this.used = [log, ...this.used.filter((l) => l !== log)];
    for (const old of this.used.splice(KEPT)) old.events = null;
    return log;
  }

  // Newest first in pages, cut only before a message of the person's; `before` is an event's seq.
  async history(id, { before = null, want = 140 } = {}) {
    const log = await this.open(id);
    if (!log) return null;
    const all = log.events || [];
    let end = all.length;
    if (before !== null) {
      end = all.findIndex((e) => e.seq >= before);
      if (end < 0) end = all.length;
    }
    let start = Math.max(0, end - want);
    while (start > 0 && all[start].k !== 'user') start--;
    const events = all.slice(start, end);
    return { events, cursor: start > 0 ? String(all[start].seq) : null, hasMore: start > 0 };
  }
}

// The folder of a change the file watcher reported: <project>/<session folder>/<file>.
export const changedFolder = (name) => String(name || '').split(/[\\/]/)[1] || '';
export const sessionsDir = sessionsRoot;

// ---------------------------------------------------------------- a turn from the phone
export class DshRunner extends EventEmitter {
  constructor({ id = null, cwd, model, effort, provider = '' }, log) {
    super();
    Object.assign(this, { id, cwd, model, effort, provider, log });
    this.agent = 'dsh';
    this.fresh = !id;            // a new session: there is nothing to resume
    this.proc = null;
    this.retiring = null;
    this.state = 'idle';
    this.queue = [];
    this.live = [];
    this.notes = [];
    this.turn = null;
    this.liveText = '';
    this.activity = null;
    this.n = 0;
    this.rpc = 0;
    this.calls = new Map();
    this.asks = new Map();
    this.jobs = new Set();
    this.ready = null;
    this.buf = '';
    this.stderr = '';
    this.ctx = { cwd, turns: new Map() };
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
    if (ev.k === 'activity') this.activity = ev;
    this.emit('transient', ev);
  }

  setState(state) {
    this.state = state;
    this.emit('state');
  }

  enqueue(content, shown) {
    const ev = { k: 'user', id: crypto.randomUUID(), t: Date.now(), text: shown.text, images: shown.images || [], pending: true, state: 'queued' };
    const busy = this.state === 'running';
    this.queue.push({ ev, content });
    this.push(ev);
    this.lastUsed = Date.now();
    clearTimeout(this.releaseTimer);
    this.pump();
    return { id: ev.id, queued: busy };
  }

  pump() {
    if (this.state === 'running' || !this.queue.length) {
      this.emit('state');
      return;
    }
    const next = this.queue.shift();
    this.live = this.live.filter((e) => (e.k === 'user' && e.state === 'queued' && e.id !== next.ev.id) || e.bridge);
    this.turn = { start: Date.now(), message: next.ev.id };
    this.activity = null;
    this.setState('running');
    this.begin(next);
  }

  async begin(next) {
    try {
      await this.ensure();
      const r = await this.call('session/prompt', { sessionId: this.id, contentBlocks: next.content });
      this.fresh = false;
      // the runtime numbers its messages itself: the bubble on the phone takes that id, so the log's copy replaces it
      if (r.messageId && r.messageId !== next.ev.id) this.emit('event', { k: 'drop', id: next.ev.id });
      this.push({ ...next.ev, id: r.messageId || next.ev.id, state: 'sent' });
      this.transient({ k: 'activity', what: 'thinking' });
    } catch (e) {
      this.push({ ...next.ev, state: 'canceled' });
      if (e.held) this.emit('conflict');
      else this.note('error', '没能交给 DeepSeek Harness：{msg}', { msg: cut(e.message, 300) });
      this.finishTurn({ ok: false, reason: 'spawn' });
    }
  }

  // The runtime up and holding this session. A session the computer has open is refused here: { held: true }.
  ensure() {
    if (!this.ready) {
      this.ready = this.start().catch((e) => {
        this.ready = null;
        this.stop();
        throw e;
      });
    }
    return this.ready;
  }

  async start() {
    const c = dshCommand();
    if (!c) throw new Error('DeepSeek Harness is not installed');
    if (this.retiring) await new Promise((r) => { this.retiring.once('exit', r); });   // it still holds the session
    if (!fs.existsSync(this.cwd)) throw new Error(`folder not found: ${this.cwd}`);
    const env = { ...process.env, ...c.env };
    if (dshHome() !== path.join(os.homedir(), '.dsh')) env.DSH_HOME = dshHome();
    for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|ANTHROPIC_)/.test(k)) delete env[k];
    // what the person set up for the desktop app (a provider of their own, say) holds for these turns too
    const own = path.join(dshHome(), 'profiles', 'desktop', 'cordis.patch.yml');
    const args = [...c.pre, '--profile', 'sdk', ...(fs.existsSync(own) ? ['--patch', own] : [])];
    const p = spawn(c.bin, args, { cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = p;
    this.buf = '';
    this.stderr = '';
    this.jobs.clear();
    this.log(`dsh session ${this.id || '(new)'}: runtime pid ${p.pid}, ${this.model} ${this.effort || ''}, ${this.cwd}`);
    this.emit('pid', p.pid);
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-4000); });
    p.stdin.on('error', (e) => this.log(`dsh session ${this.id}: stdin ${e.code || e.message}`));
    p.on('error', (e) => this.log(`dsh session ${this.id}: process error ${e.message}`));
    p.on('exit', (code, signal) => this.onExit(p, code, signal));
    readline.createInterface({ input: p.stdout }).on('line', (l) => this.onLine(l));
    await this.call('initialize', {
      cwd: this.cwd, provider: this.provider || CONFIG.dsh.provider, model: this.model, approvalRequests: true,
      ...(this.effort ? { reasoningEffort: this.effort } : {}),
    }, 90000);
    if (this.id && !this.fresh) {
      try {
        await this.call('session/resume', { sessionId: this.id }, 90000);
      } catch (e) {
        if (/already owned|writer|active write/i.test(e.message)) throw Object.assign(new Error('held'), { held: true });
        throw e;
      }
    } else if (!this.id) {
      this.id = `session-${crypto.randomUUID()}`;
      this.emit('init', this.id, null);
    }
  }

  write(o) {
    if (!this.proc) return;
    try {
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...o })}\n`);
    } catch (e) {
      this.log(`dsh session ${this.id}: write failed ${e.message}`);
    }
  }

  call(method, params, ms = 60000) {
    return new Promise((resolve, reject) => {
      const id = ++this.rpc;
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new Error(`${method} timed out`));
      }, ms);
      this.calls.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  onLine(l) {
    let o;
    try {
      o = JSON.parse(l);
    } catch {
      return;                                            // the runtime's stdout carries only JSON-RPC, but stay safe
    }
    try {
      if (o.method && o.id !== undefined) this.onRequest(o);
      else if (o.id !== undefined) {
        const c = this.calls.get(o.id);
        if (!c) return;
        this.calls.delete(o.id);
        clearTimeout(c.timer);
        if (o.error) c.reject(new Error(o.error.message || 'runtime error'));
        else c.resolve(o.result || {});
      } else if (o.method === 'session.event') this.onEvent(o.params);
      else if (o.method === 'session.status' && o.params?.sessionId === this.id) this.agentStatus = o.params.status;
    } catch (e) {
      this.log(`dsh session ${this.id}: handler error ${e.stack || e.message}`);
    }
  }

  // The runtime asks before a tool runs where the session's permissions say so: the phone answers.
  onRequest(o) {
    if (o.method !== 'approval/request') {
      this.write({ id: o.id, error: { code: -32601, message: `not handled: ${o.method}` } });
      return;
    }
    const p = o.params || {};
    const ev = { k: 'ask', id: `ask-${o.id}`, t: Date.now(), name: TOOL_NAMES[p.toolName] || p.toolName || '', reason: cut(p.reason || '', 400), state: 'open' };
    this.asks.set(ev.id, { rpc: o.id, ev });
    this.push(ev);
    this.emit('ask', ev);
  }

  answer(id, allow) {
    const a = this.asks.get(id);
    if (!a) return false;
    this.asks.delete(id);
    this.write({ id: a.rpc, result: { outcome: allow ? 'allowed-once' : 'rejected' } });
    this.push({ ...a.ev, state: allow ? 'allowed' : 'rejected' });
    return true;
  }

  onEvent({ sessionId, event: o }) {
    if (sessionId !== this.id || !o) return;
    if (o.type === 'job/registered') this.jobs.add(o.data?.jobId ?? o.seq);
    if (o.type === 'job/settled') this.jobs.delete(o.data?.jobId);
    if (o.type === 'turn/start' && this.state !== 'running') {   // a turn the runtime started itself
      clearTimeout(this.releaseTimer);
      this.turn = { start: Date.now(), self: true };
      this.setState('running');
    }
    if (o.type === 'step/start') this.transient({ k: 'activity', what: 'thinking' });
    if (o.type === 'tool/call') this.transient({ k: 'activity', what: 'tool', name: TOOL_NAMES[o.data?.name] || o.data?.name });
    const evs = [];
    logEvents(o, this.ctx, evs);
    for (const ev of evs) {
      if (ev.k === 'result') this.finishTurn({ ok: ev.ok, reason: ev.reason, id: ev.id });
      else this.push(ev);
    }
  }

  finishTurn(res) {
    clearTimeout(this.stopTimer);
    for (const a of this.asks.values()) this.push({ ...a.ev, state: 'gone' });
    this.asks.clear();
    const ms = this.turn ? Date.now() - this.turn.start : 0;
    const ev = this.push({ k: 'result', id: res.id || this.nid('result'), t: Date.now(), ok: res.ok, ms, reason: res.reason });
    this.turn = null;
    this.activity = null;
    this.lastUsed = Date.now();
    this.setState('idle');
    this.emit('finished', ev);
    if (this.queue.length) this.pump();
    else this.armRelease();
  }

  // The computer can open the session again once the runtime is gone, so it goes as soon as nothing is left to do.
  armRelease() {
    clearTimeout(this.releaseTimer);
    this.releaseTimer = setTimeout(() => {
      if (this.state === 'running' || this.queue.length) return;
      if (this.jobs.size || this.agentStatus === 'running') {   // background work ends with the runtime: let it finish
        this.armRelease();
        return;
      }
      this.close('turn done');
    }, RELEASE_MS);
  }

  hasBackground() {
    return this.jobs.size > 0;
  }

  // Nothing to change on a running process: model and effort apply from the next turn's runtime.
  restartWhenFree() {
    return true;
  }

  // Stops the running turn: the SDK has no stop request, so the runtime goes; its log marks the turn as interrupted
  // on the next resume, and the conversation carries on from there.
  interrupt() {
    if (this.queue.length) {
      for (const q of this.queue) this.push({ ...q.ev, state: 'canceled' });
      this.queue = [];
      this.emit('state');
    }
    if (this.state !== 'running' || !this.proc) return false;
    this.forced = true;
    killTree(this.proc.pid);
    return true;
  }

  stop() {
    const p = this.proc;
    this.proc = null;
    this.ready = null;
    if (p) killTree(p.pid);
  }

  close(reason) {
    clearTimeout(this.releaseTimer);
    if (!this.proc || this.state === 'running') return;
    const p = this.proc;
    this.proc = null;
    this.ready = null;
    this.retiring = p;
    this.log(`dsh session ${this.id}: closing runtime ${p.pid} (${reason})`);
    try {
      p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: ++this.rpc, method: 'shutdown' })}\n`);
      p.stdin.end();
    } catch { /* already gone */ }
    setTimeout(() => {
      if (p.exitCode === null && p.signalCode === null) killTree(p.pid);
    }, 8000);
  }

  onExit(p, code, signal) {
    if (p === this.retiring) {
      this.retiring = null;
      this.emit('exit', p.pid);
      return;
    }
    if (this.proc && this.proc !== p) return;
    this.proc = null;
    this.ready = null;
    for (const c of this.calls.values()) {
      clearTimeout(c.timer);
      c.reject(new Error(`the runtime stopped${this.stderr ? `: ${cut(this.stderr.trim().split('\n').pop(), 200)}` : ''}`));
    }
    this.calls.clear();
    this.emit('exit', p.pid);
    const wasRunning = this.state === 'running';
    this.log(`dsh session ${this.id}: runtime ${p.pid} exited code ${code} signal ${signal || ''}${wasRunning ? ' during a turn' : ''}`);
    if (wasRunning && this.turn) {
      if (this.forced) this.note('warn', '已打断');
      else this.note('error', 'DeepSeek Harness 中途退出（代码 {code}）', { code: code ?? signal });
      this.finishTurn({ ok: false, reason: this.forced ? 'stopped' : 'exit' });
    }
    this.forced = false;
  }
}
