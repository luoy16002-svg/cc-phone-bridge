// One Runner per Claude Code session the phone drives: the same binary and settings as `claude code` on the PC,
// run with --resume on the session's own id, so the conversation is the very same one the PC shows.
import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { describeTool } from './describe.mjs';
import { configDir } from './transcripts.mjs';
import { CONFIG } from './config.mjs';

const FORCE_STOP_MS = 8000;

export const PHONE_NOTE = 'The user is sending these messages from a phone and reads your replies on a phone screen. '
  + 'Keep the final message short and easy to scan: lead with the outcome, short paragraphs, small tables only when they help.';

export const MODELS = CONFIG.models;
export const EFFORTS = CONFIG.efforts;

export function modelName(id) {
  const m = MODELS.find((x) => x.id === id);
  if (m) return m.name;
  const g = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(String(id || ''));
  return g ? `${g[1][0].toUpperCase()}${g[1].slice(1)} ${g[2]}.${g[3]}` : String(id || '');
}

// What a session uses when nothing is chosen: the PC's own settings.json.
export function defaults() {
  let s = {};
  try {
    s = JSON.parse(fs.readFileSync(path.join(configDir(), 'settings.json'), 'utf8'));
  } catch { /* none */ }
  const alias = String(s.model || 'opus').toLowerCase();
  const model = MODELS.find((m) => m.id === alias || m.id.includes(`-${alias}-`))?.id || MODELS[0].id;
  const effort = s.modelSettings?.[model]?.effortLevel || s.effortLevel || 'high';
  return { model, effort: EFFORTS.includes(effort) ? effort : 'high' };
}

// The Claude Code executable: a test stand-in, a pinned release (releaseFile), or the configured command.
export function claudeCommand() {
  if (process.env.CCPB_CLAUDE_CMD) {
    const [bin, ...pre] = JSON.parse(process.env.CCPB_CLAUDE_CMD);
    return { bin, pre, version: 'test' };
  }
  const c = CONFIG.claude;
  if (c.releaseFile) {
    try {
      const rel = JSON.parse(fs.readFileSync(c.releaseFile, 'utf8'));
      return { bin: rel.binary, pre: c.args, version: rel.version || '' };
    } catch { /* fall back to the command */ }
  }
  return { bin: c.command, pre: c.args, version: detected };
}

// The version shown in Settings when Claude Code is started by command: asked once, at start.
let detected = '';
export function detectVersion() {
  const { bin, pre, version } = claudeCommand();
  if (version) return;
  execFile(bin, [...pre, '--version'], { timeout: 15000, windowsHide: true, env: claudeEnv() }, (err, out) => {
    if (!err) detected = (/\d+\.\d+\.\d+/.exec(String(out)) || [''])[0];
  });
}

const globToRegex = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');

// The same environment the user's own Claude Code sees, minus variables that would switch accounts or providers.
export function claudeEnv() {
  const env = { ...process.env };
  const clear = CONFIG.claude.clearEnv.map(globToRegex);
  for (const k of Object.keys(env)) if (clear.some((r) => r.test(k))) delete env[k];
  env.CLAUDE_CONFIG_DIR = configDir();
  Object.assign(env, CONFIG.claude.env);
  return env;
}

const cut = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c.type === 'text' ? c.text : c.type === 'image' ? '[image]' : '')).join('\n');
  return '';
}

// Stops Claude Code and everything it started: the process tree on Windows, the process group elsewhere.
export function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
      return;
    }
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch { /* already gone */ }
    }
    resolve();
  });
}

// A branch is a runner without an id and with `fork: { from, at }`: its first message resumes `from` as a new
// session (--fork-session) that keeps the conversation up to and including the entry `at` (all of it when at is
// empty); `name` titles a new session.
export class Runner extends EventEmitter {
  constructor({ id = null, cwd, model, effort, phoneNote = false, idleMinutes = 20, fork = null, name = '' }, log) {
    super();
    Object.assign(this, { id, cwd, model, effort, phoneNote, idleMinutes, fork, name, log });
    this.proc = null;
    this.retiring = null;
    this.state = 'idle';
    this.queue = [];
    this.live = [];          // what the phone sees of the current turn until the transcript has it
    this.notes = [];         // the bridge's own notes (errors, stops): not in the transcript, kept here
    this.buf = '';
    this.stderr = '';
    this.turn = null;
    this.liveText = '';
    this.activity = null;
    this.n = 0;
    this.lastUsed = Date.now();
  }

  nid(p) {
    this.n += 1;
    return `${p}-${Date.now().toString(36)}-${this.n}`;
  }

  get live_() {
    return !!this.proc;
  }

  push(ev) {
    const i = this.live.findIndex((e) => e.id === ev.id);
    if (i >= 0) this.live[i] = ev;
    else this.live.push(ev);
    this.emit('event', ev);
    return ev;
  }

  // A note from the bridge. `key` is the Chinese wording with {placeholders}; the phone shows it in its own language.
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

  // A message from the phone. It shows at once; it goes to Claude Code when the session is free.
  enqueue(content, shown) {
    const ev = { k: 'user', id: this.nid('pending'), t: Date.now(), text: shown.text, images: shown.images || [], pending: true, state: 'queued' };
    const busy = this.state === 'running';
    this.queue.push({ ev, content });
    this.push(ev);
    this.lastUsed = Date.now();
    this.pump();
    return { id: ev.id, queued: busy };
  }

  pump() {
    if (this.state === 'running' || !this.queue.length) {
      this.emit('state');
      return;
    }
    const next = this.queue.shift();
    clearTimeout(this.idleTimer);
    if (!this.proc) {
      try {
        this.spawn();
      } catch (e) {
        for (const q of [next, ...this.queue]) this.push({ ...q.ev, state: 'canceled' });
        this.queue = [];
        this.note('error', '没能启动 Claude Code：{msg}', { msg: e.message });
        this.setState('error');
        this.emit('finished', { ok: false, reason: 'spawn', ms: 0 });
        return;
      }
    }
    // the last turn is in the transcript now: keep only prompts still waiting and the bridge's notes
    this.live = this.live.filter((e) => (e.k === 'user' && e.state === 'queued' && e.id !== next.ev.id) || e.bridge);
    this.turn = { start: Date.now() };
    this.liveText = '';
    this.activity = null;
    this.write({ type: 'user', message: { role: 'user', content: next.content } });
    this.push({ ...next.ev, state: 'sent' });
    this.setState('running');
  }

  spawn() {
    const { bin, pre } = claudeCommand();
    if (!fs.existsSync(this.cwd)) throw new Error(`folder not found: ${this.cwd}`);
    const args = [...pre, '-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose',
      '--include-partial-messages'];
    if (CONFIG.claude.permissionMode) args.push('--permission-mode', CONFIG.claude.permissionMode);
    if (this.model) args.push('--model', this.model);
    if (this.effort) args.push('--effort', this.effort);
    if (this.id) args.push('--resume', this.id);
    else if (this.fork) {
      args.push('--resume', this.fork.from, '--fork-session');
      if (this.fork.at) args.push('--resume-session-at', this.fork.at);
    }
    if (!this.id && this.name) args.push('--name', this.name);
    if (this.phoneNote) args.push('--append-system-prompt', PHONE_NOTE);
    const p = spawn(bin, args, { cwd: this.cwd, env: claudeEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    this.proc = p;
    this.buf = '';
    this.stderr = '';
    this.log(`session ${this.id || '(new)'}: Claude Code pid ${p.pid}, ${this.model} ${this.effort}, ${this.cwd}`);
    this.emit('pid', p.pid);
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', (d) => this.onData(d));
    p.stderr.on('data', (d) => {
      this.stderr = (this.stderr + d).slice(-4000);
    });
    p.stdin.on('error', (e) => this.log(`session ${this.id}: stdin ${e.code || e.message}`));
    p.on('error', (e) => this.log(`session ${this.id}: process error ${e.message}`));
    p.on('exit', (code, signal) => this.onExit(p, code, signal));
  }

  write(obj) {
    if (!this.proc) return;
    try {
      this.proc.stdin.write(`${JSON.stringify(obj)}\n`);
    } catch (e) {
      this.log(`session ${this.id}: write failed ${e.message}`);
    }
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
        this.log(`session ${this.id}: unparsed output ${cut(line, 200)}`);
        continue;
      }
      try {
        this.onMessage(o);
      } catch (e) {
        this.log(`session ${this.id}: handler error ${e.stack || e.message}`);
      }
    }
  }

  onMessage(o) {
    const sub = !!o.parent_tool_use_id;
    const t = Date.now();
    switch (o.type) {
      case 'system':
        if (o.subtype === 'init') {
          if (o.session_id && o.session_id !== this.id) {
            const was = this.id;
            this.id = o.session_id;
            this.fork = null;                       // from now on the branch resumes as itself
            this.emit('init', this.id, was);
          }
          if (o.model) this.modelSeen = o.model;
        } else if (o.subtype === 'compact_boundary') {
          this.push({ k: 'note', id: o.uuid || this.nid('note'), t, tone: 'info', text: '上下文自动压缩了一次' });
        }
        break;
      case 'stream_event': {
        if (sub) break;
        const e = o.event || {};
        if (e.type === 'content_block_start') {
          const b = e.content_block || {};
          if (b.type === 'text') this.transient({ k: 'activity', what: 'writing' });
          else if (b.type === 'thinking') this.transient({ k: 'activity', what: 'thinking' });
          else if (b.type === 'tool_use') this.transient({ k: 'activity', what: 'tool', name: b.name });
        } else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
          this.transient({ k: 'delta', text: e.delta.text });
        }
        break;
      }
      case 'assistant':
        if (sub) break;
        (o.message?.content || []).forEach((c, i) => {
          if (c.type === 'text' && c.text && c.text.trim()) {
            this.liveText = '';
            this.push({ k: 'text', id: `${o.uuid}:${i}`, t, text: c.text, model: o.message.model || '' });
          } else if (c.type === 'tool_use') {
            this.push({ k: 'tool', id: `${o.uuid}:${i}`, tool: c.id, t, name: c.name, ...describeTool(c.name, c.input, this.cwd) });
          }
        });
        break;
      case 'user': {
        if (sub) break;
        const content = o.message?.content;
        if (!Array.isArray(content)) break;
        for (const c of content) {
          if (c.type === 'tool_result') {
            const text = resultText(c.content).replace(/<\/?tool_use_error>/g, '');
            this.push({ k: 'tool_result', id: `${o.uuid}:${c.tool_use_id}`, tool: c.tool_use_id, t, ok: !c.is_error, text: cut(text, 1200) });
          } else if (c.type === 'text' && /Request interrupted/i.test(c.text || '')) {
            this.push({ k: 'note', id: o.uuid || this.nid('note'), t, tone: 'warn', text: '已打断' });
          }
        }
        break;
      }
      case 'result':
        this.finishTurn({
          ok: !o.is_error,
          ms: o.duration_ms,
          reason: o.terminal_reason || o.stop_reason || '',
          error: o.is_error && o.subtype !== 'error_during_execution' ? cut(o.result || (o.errors || []).join('\n'), 600) : '',
        });
        break;
      case 'rate_limit_event': {
        const r = o.rate_limit_info || {};
        if (r.status && r.status !== 'allowed') {
          const when = r.resetsAt ? new Date(r.resetsAt * 1000).toLocaleString('en-CA', { timeZone: CONFIG.timeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', '') : '';
          if (when) this.note('warn', '用量提醒：{status}，{when} 重置', { status: r.status, when });
          else this.note('warn', '用量提醒：{status}', { status: r.status });
        }
        break;
      }
      default:
        break;
    }
  }

  finishTurn(res) {
    clearTimeout(this.stopTimer);
    this.stopTimer = null;
    if (res.error) this.note('error', '{text}', { text: res.error });
    const ms = res.ms ?? (this.turn ? Date.now() - this.turn.start : 0);
    const ev = this.push({ k: 'result', id: this.nid('result'), t: Date.now(), ok: res.ok, ms, reason: res.reason });
    this.turn = null;
    this.liveText = '';
    this.activity = null;
    this.lastUsed = Date.now();
    this.setState('idle');
    this.emit('finished', ev);
    if (this.queue.length) this.pump();
    else this.armIdle();
  }

  armIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close('idle'), Math.max(1, this.idleMinutes) * 60 * 1000);
  }

  // Stop the running turn; prompts still waiting are dropped.
  interrupt() {
    if (this.queue.length) {
      for (const q of this.queue) this.push({ ...q.ev, state: 'canceled' });
      this.queue = [];
      this.emit('state');
    }
    if (this.state !== 'running' || !this.proc) return false;
    this.write({ type: 'control_request', request_id: this.nid('int'), request: { subtype: 'interrupt' } });
    clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => {
      if (this.state === 'running') this.forceStop('打断没有及时生效，已强制停止');
    }, FORCE_STOP_MS);
    return true;
  }

  async forceStop(why) {
    const p = this.proc;
    if (!p) return;
    this.forced = why;
    await killTree(p.pid);
  }

  // Let an idle process go; it is detached at once, so a message that arrives meanwhile starts a fresh one.
  close(reason) {
    clearTimeout(this.idleTimer);
    if (!this.proc || this.state === 'running') return;
    const p = this.proc;
    this.proc = null;
    this.retiring = p;
    this.log(`session ${this.id}: closing process ${p.pid} (${reason})`);
    try {
      p.stdin.end();
    } catch { /* already gone */ }
    setTimeout(() => {
      if (p.exitCode === null && p.signalCode === null) killTree(p.pid);
    }, 15000);
  }

  onExit(p, code, signal) {
    if (p === this.retiring) {
      this.retiring = null;
      this.emit('exit', p.pid);
      return;
    }
    if (this.proc !== p) return;
    this.proc = null;
    clearTimeout(this.idleTimer);
    this.emit('exit', p.pid);
    const wasRunning = this.state === 'running';
    this.log(`session ${this.id}: process ${p.pid} exited code ${code} signal ${signal || ''}${wasRunning ? ' during a turn' : ''}`);
    if (wasRunning) {
      if (this.forced) this.note('warn', this.forced);
      else {
        const tail = this.stderr.trim().split('\n').slice(-3).join('\n');
        this.note('error', 'Claude Code 中途退出（代码 {code}）{tail}', { code: code ?? signal, tail: tail ? `\n${cut(tail, 500)}` : '' });
      }
      this.finishTurn({ ok: false, reason: this.forced ? 'stopped' : 'exit' });
    } else if (code && !this.id) {
      const tail = this.stderr.trim().split('\n').slice(-3).join('\n');
      this.note('error', 'Claude Code 没能启动（代码 {code}）{tail}', { code, tail: tail ? `\n${cut(tail, 500)}` : '' });
      this.emit('failed');
    }
    this.forced = null;
  }
}
