// 值班台 (cc-phone-bridge): use Claude Code on this computer from a phone on the same network.
// The conversations are Claude Code's own: the phone lists, reads and continues the sessions this computer has,
// sees runs started in a terminal as they happen, and starts new ones with the same program and settings.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { CONFIG, DATA_DIR, CONFIG_FILE } from './lib/config.mjs';
import { Store } from './lib/store.mjs';
import { Pairing, newDevice, findDevice } from './lib/pair.mjs';
import { Runner, claudeCommand, detectVersion, killTree, MODELS, EFFORTS, modelName, defaults } from './lib/claude.mjs';
import { isLoopback, isPrivate, hostAllowed, addresses } from './lib/net.mjs';
import { configDir, projectKey, listSessions, sessionFile, sessionMeta, historyPage, lineEvents, preview, parentOf } from './lib/transcripts.mjs';
import { CodexHub, CodexRunner, rolloutInfo, rolloutLineEvents, rolloutId, codexHome, findRollout, threadLock, lockDir } from './lib/codex.mjs';
import { push, hasPush } from './lib/push.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')).version;
const MAX_BODY = 24 * 1024 * 1024;
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const SID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TLS = !!(CONFIG.tls.cert && CONFIG.tls.key);

const store = new Store(DATA_DIR);
const pairing = new Pairing();
const runners = new Map();
const subs = new Map();
const deskSubs = new Set();
const tails = new Map();

const LOG = path.join(DATA_DIR, 'server.log');
function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > CONFIG.limits.logKB * 1024) fs.renameSync(LOG, `${LOG}.1`);
    fs.appendFileSync(LOG, line);
  } catch { /* logging must never take the server down */ }
  if (process.env.CCPB_VERBOSE) process.stdout.write(line);
}

// Codex: one app server for every Codex thread the phone touches, started on first use.
const hub = new CodexHub(log);
hub.clientVersion = VERSION;
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => {
  const t = oneLine(s);
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

// ---------------------------------------------------------------- housekeeping
function imageName(pid) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      execFile('ps', ['-p', String(pid), '-o', 'comm='], (err, out) => resolve(err ? '' : path.basename(String(out).trim()).toLowerCase()));
      return;
    }
    execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true }, (err, out) => {
      const m = /^"([^"]+)"/.exec(String(out || '').trim());
      resolve(err || !m ? '' : m[1].toLowerCase());
    });
  });
}

async function reapOrphans() {
  const want = path.basename(claudeCommand().bin).toLowerCase();
  for (const pid of store.read('pids.json', [])) {
    if ((await imageName(pid)) === want) {
      log(`stopping Claude Code ${pid} left by a previous run`);
      await killTree(pid);
    }
  }
  store.write('pids.json', []);
}

let lastPids = '';
function savePids() {
  const pids = [];
  for (const r of new Set(runners.values())) {
    if (r.proc?.pid) pids.push(r.proc.pid);
    if (r.retiring?.pid) pids.push(r.retiring.pid);
  }
  const key = pids.join(',');
  if (key === lastPids) return;
  lastPids = key;
  store.write('pids.json', pids);
}

// Pictures sent from the phone are kept a few days for the phone's own thumbnails, within a size cap.
function cleanUploads() {
  const dir = path.join(DATA_DIR, 'uploads');
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => {
      const full = path.join(dir, d.name);
      let size = 0;
      for (const f of fs.readdirSync(full)) size += fs.statSync(path.join(full, f)).size;
      return { full, size, mtime: fs.statSync(full).mtimeMs };
    });
  } catch {
    return;
  }
  entries.sort((a, b) => a.mtime - b.mtime);
  const maxAge = Date.now() - CONFIG.limits.uploadDays * 86400000;
  let total = entries.reduce((s, e) => s + e.size, 0);
  let removed = 0;
  for (const e of entries) {
    if (e.mtime < maxAge || total > CONFIG.limits.uploadMB * 1024 * 1024) {
      fs.rmSync(e.full, { recursive: true, force: true });
      total -= e.size;
      removed++;
    }
  }
  if (removed) log(`removed ${removed} old upload folder(s)`);
}

// ---------------------------------------------------------------- sessions
function pcSettings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(configDir(), 'settings.json'), 'utf8'));
  } catch {
    return {};
  }
}

function effortFor(model) {
  const s = pcSettings();
  const e = s.modelSettings?.[model]?.effortLevel || s.effortLevel || 'high';
  return EFFORTS.includes(e) ? e : 'high';
}

// Sessions open in a Claude Code window on this computer right now, and whether each is busy.
function pcWindows() {
  const out = new Map();
  const dir = path.join(configDir(), 'sessions');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (s.kind !== 'interactive' || !s.sessionId) continue;
      try {
        process.kill(s.pid, 0);
      } catch (e) {
        if (e.code !== 'EPERM') continue;
      }
      out.set(s.sessionId, { busy: s.status === 'busy' });
    } catch { /* being rewritten */ }
  }
  return out;
}

// Like `claude --resume` on the computer: its current model and effort, unless the phone chose others.
function effective(id) {
  const p = store.prefs[id] || {};
  const model = p.model || defaults().model;
  return { model, effort: p.effort || effortFor(model) };
}

const folderOf = (cwd) => String(cwd || '').split(/[\\/]/).filter(Boolean).pop() || cwd;

function summary(meta, windows = pcWindows()) {
  const r = runners.get(meta.id);
  const eff = effective(meta.id);
  const w = windows.get(meta.id);
  return {
    agent: 'claude', id: meta.id, title: meta.title, cwd: meta.cwd, folder: folderOf(meta.cwd), lastPrompt: meta.lastPrompt,
    lastReply: meta.lastReply, lastModel: meta.model ? modelName(meta.model) : '',
    updatedAt: Math.max(meta.updatedAt || 0, r && r.state === 'running' ? Date.now() : 0),
    model: eff.model, modelName: modelName(eff.model), effort: eff.effort,
    state: r?.state || 'idle', queue: r?.queue.length || 0, openOnPc: !!w, pcBusy: !!w?.busy,
  };
}

function metaFor(id) {
  const file = sessionFile(id);
  if (!file) return null;
  const st = fs.statSync(file);
  return sessionMeta({ id, file, key: path.basename(path.dirname(file)), mtime: st.mtimeMs, size: st.size });
}

// ---- Codex threads: the same summary, from the app server's thread list and the tail of the thread's rollout file
function codexEffective(id, meta) {
  const p = store.prefs[id] || {};
  const d = hub.defaults();
  const info = meta?.path ? rolloutInfo(meta.path) : null;
  const model = p.model || meta?.model || info?.model || d.model;
  return { model, effort: p.effort || meta?.effort || info?.effort || d.effort };
}

// A turn counts as running on the computer while its rollout says started-not-ended and the file still moves.
function codexPcBusy(meta, info) {
  const t = tails.get(meta.id);
  if (t && t.agent === 'codex') return !!t.busy;
  return !!(info?.busy && Date.now() - info.mtime < 15 * 60000);
}

// Who writes a Codex thread right now: the phone (a turn of its own, or the moment after one), a program on the
// computer (the Codex app, the codex CLI), nobody, or 'unknown' where the lock cannot be read. Where it cannot be
// read beforehand, a refusal Codex gave the phone counts until the lock file goes.
const conflicts = new Set();
function codexLock(id) {
  const r = runners.get(id);
  if (r?.agent === 'codex' && (r.proc || r.state === 'running')) return 'phone';
  const s = threadLock(id);
  if (s === 'free') conflicts.delete(id);
  return s === 'held' || (s === 'unknown' && conflicts.has(id)) ? 'pc' : s;
}

function codexSummary(meta) {
  const r = runners.get(meta.id);
  const info = meta.path ? rolloutInfo(meta.path) : null;
  const eff = codexEffective(meta.id, meta);
  const running = r?.state === 'running';
  const held = codexLock(meta.id) === 'pc';
  return {
    agent: 'codex', id: meta.id, title: clip(meta.name || meta.preview || info?.lastPrompt || '', 80), cwd: meta.cwd, folder: folderOf(meta.cwd),
    lastPrompt: clip(info?.lastPrompt || meta.preview, 160), lastReply: clip(preview(info?.lastReply || ''), 200),
    lastModel: hub.modelName(info?.model || meta.model || ''),
    updatedAt: Math.max(meta.updatedAt || 0, info?.mtime || 0, running ? Date.now() : 0),
    model: eff.model, modelName: hub.modelName(eff.model), effort: eff.effort,
    state: r?.state || 'idle', queue: r?.queue.length || 0, openOnPc: held, held, pcBusy: !running && codexPcBusy(meta, info),
  };
}

// What the phone shows about the computer's side of a Codex thread: a turn running there, or the thread held open.
function codexPc(id) {
  const r = runners.get(id);
  return { k: 'pc', open: false, busy: r?.state === 'running' ? false : !!tails.get(id)?.busy, held: codexLock(id) === 'pc' };
}

// The conversation a branch came from, with its title, for the line at the top of the branch.
async function branchOrigin(id, forkedFrom = '') {
  const src = store.prefs[id]?.from || forkedFrom;
  if (!src) return null;
  const claude = metaFor(src);
  if (claude) return { id: src, title: claude.title };
  const cm = hub.available ? await hub.lookup(src) : null;
  return { id: src, title: cm ? clip(cm.name || cm.preview, 80) : '' };
}

// Which agent a session id belongs to: a Claude Code transcript, or a Codex thread.
async function agentOf(id) {
  const r = runners.get(id);
  if (r) return r.agent === 'codex' ? 'codex' : 'claude';
  if (sessionFile(id)) return 'claude';
  if (hub.available && await hub.lookup(id)) return 'codex';
  return null;
}

async function codexModels() {
  if (!hub.available) return [];
  try {
    return await hub.models();
  } catch (e) {
    log(`codex models: ${e.message}`);
    return hub.modelsNow();
  }
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(id, event, data) {
  for (const res of subs.get(id) || []) sse(res, event, data);
}

const deskPending = new Set();
let deskTimer = null;
function deskUpdate(id) {
  if (!deskSubs.size) return;
  deskPending.add(id);
  if (deskTimer) return;
  deskTimer = setTimeout(async () => {
    deskTimer = null;
    const windows = pcWindows();
    const ids = [...deskPending];
    deskPending.clear();
    for (const sid of ids) {
      const meta = metaFor(sid);
      if (meta && !meta.empty) {
        for (const res of deskSubs) sse(res, 'session', summary(meta, windows));
        continue;
      }
      if (!hub.available) continue;
      const cm = hub.threads.has(sid) ? await hub.refresh(sid) : await hub.lookup(sid);
      if (cm && !cm.sub) for (const res of deskSubs) sse(res, 'session', codexSummary(cm));
    }
  }, 600);
}

// Runs started on the computer show on the phone as they happen: follow the transcript of every open session.
function startTail(id) {
  if (tails.has(id)) return;
  const file = sessionFile(id);
  if (!file) return;
  const t = { file, pos: fs.statSync(file).size, dec: new StringDecoder('utf8'), rest: '', busy: null };
  t.timer = setInterval(() => pollTail(id, t), CONFIG.limits.tailMs);
  tails.set(id, t);
}

function pollTail(id, t) {
  const w = pcWindows().get(id);
  const busy = !!w?.busy;
  if (busy !== t.busy) {
    t.busy = busy;
    broadcast(id, 'tr', { k: 'pc', open: !!w, busy });
  }
  let size;
  try {
    size = fs.statSync(t.file).size;
  } catch {
    return;
  }
  if (size < t.pos) {
    t.pos = size;
    t.rest = '';
    return;
  }
  if (size === t.pos) return;
  const len = Math.min(size - t.pos, 8 * 1024 * 1024);
  const fd = fs.openSync(t.file, 'r');
  const buf = Buffer.alloc(len);
  try {
    fs.readSync(fd, buf, 0, len, t.pos);
  } finally {
    fs.closeSync(fd);
  }
  t.pos += len;
  const lines = (t.rest + t.dec.write(buf)).split('\n');
  t.rest = lines.pop();
  if (runners.get(id)?.state === 'running') return;      // the bridge's own stream already shows this turn
  const evs = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    try {
      lineEvents(JSON.parse(l), evs);
    } catch { /* a half-written line */ }
  }
  for (const ev of evs) broadcast(id, 'ev', { ...ev, pc: true });
}

function stopTail(id) {
  if ((subs.get(id) || new Set()).size) return;
  const t = tails.get(id);
  if (t) clearInterval(t.timer);
  tails.delete(id);
}

// Codex turns that run on the computer (the Codex app, the codex CLI) show on the phone as they happen: follow the
// thread's rollout file; its task_started / task_complete lines say whether a turn is running there.
function startCodexTail(id, meta) {
  if (tails.has(id) || !meta) return;
  const file = meta.path || findRollout(id);          // a thread started a moment ago may not say where it writes yet
  if (!file) return;
  meta.path = file;
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return;
  }
  const info = rolloutInfo(file);
  const t = { agent: 'codex', file, cwd: meta.cwd, pos: size, dec: new StringDecoder('utf8'), rest: '', busy: !!(info?.busy && Date.now() - info.mtime < 15 * 60000) };
  t.timer = setInterval(() => pollCodexTail(id, t), CONFIG.limits.tailMs);
  tails.set(id, t);
}

function pollCodexTail(id, t) {
  let size;
  try {
    size = fs.statSync(t.file).size;
  } catch {
    return;
  }
  if (size < t.pos) {
    t.pos = size;
    t.rest = '';
    return;
  }
  if (size === t.pos) return;
  const len = Math.min(size - t.pos, 8 * 1024 * 1024);
  const fd = fs.openSync(t.file, 'r');
  const buf = Buffer.alloc(len);
  try {
    fs.readSync(fd, buf, 0, len, t.pos);
  } finally {
    fs.closeSync(fd);
  }
  t.pos += len;
  const lines = (t.rest + t.dec.write(buf)).split('\n');
  t.rest = lines.pop();
  const ours = runners.get(id)?.state === 'running';    // the bridge's own stream already shows this turn
  const evs = [];
  let busy = t.busy;
  for (const l of lines) {
    if (!l.trim()) continue;
    let o;
    try {
      o = JSON.parse(l);
    } catch {
      continue;
    }
    const mark = rolloutLineEvents(o, t.cwd, ours ? [] : evs);
    if (mark === 'start' && !ours) busy = true;
    else if (mark === 'end') busy = false;
  }
  for (const ev of evs) broadcast(id, 'ev', { ...ev, pc: true });
  if (busy !== t.busy) {                                // after the events, so a reload on "done" finds them
    t.busy = busy;
    broadcast(id, 'tr', codexPc(id));
    deskUpdate(id);
  }
}

// A followed file that changes is read at once; the timer in startTail / startCodexTail is the fallback.
const soon = new Map();
function pollSoon(id) {
  if (soon.has(id)) return;
  soon.set(id, setTimeout(() => {
    soon.delete(id);
    const t = tails.get(id);
    if (!t) return;
    if (t.agent === 'codex') pollCodexTail(id, t);
    else pollTail(id, t);
  }, 80));
}

// The desk follows Codex threads too: a rollout file written anywhere under CODEX_HOME/sessions updates its card,
// and an open conversation reads what was written at once.
function watchCodex() {
  if (!hub.available) return;
  const root = path.join(codexHome(), 'sessions');
  try {
    fs.mkdirSync(root, { recursive: true });
    const seen = new Map();
    fs.watch(root, { recursive: true }, (_, name) => {
      const id = rolloutId(name);
      if (!id) return;
      if (tails.has(id)) pollSoon(id);
      if (!deskSubs.size) return;
      const last = seen.get(id) || 0;
      if (Date.now() - last < 1500) return;
      seen.set(id, Date.now());
      deskUpdate(id);
    });
  } catch (e) {
    log(`watching ${root} failed (${e.message}); Codex cards refresh with the list`);
  }
}

// The computer opening or letting go of a Codex thread shows on the phone at once: Codex creates
// CODEX_HOME/thread-writer-locks/<id>.lock when a program loads a thread to write it, and deletes it after.
const lockSeen = new Map();
function lockChanged(id) {
  const now = codexLock(id);
  if (lockSeen.get(id) === now) return;
  lockSeen.set(id, now);
  if (lockSeen.size > 2000) lockSeen.delete(lockSeen.keys().next().value);
  if (subs.get(id)?.size) broadcast(id, 'tr', codexPc(id));
  deskUpdate(id);
}

function watchCodexLocks() {
  if (!hub.available) return;
  const dir = lockDir();
  const timers = new Map();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.watch(dir, (_, name) => {
      const m = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.lock$/i.exec(String(name || ''));
      if (!m) return;
      const id = m[1].toLowerCase();
      clearTimeout(timers.get(id));
      timers.set(id, setTimeout(() => {
        timers.delete(id);
        lockChanged(id);
      }, 120));
    });
  } catch (e) {
    log(`watching ${dir} failed (${e.message}); the phone sees who holds a Codex thread when it opens it`);
  }
}

// The session list on open phones follows changes to any transcript, and to which sessions are open or busy
// in a Claude Code window on this computer.
function watchProjects() {
  const root = path.join(configDir(), 'projects');
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.watch(root, { recursive: true }, (_, name) => {
      const m = /([0-9a-f-]{36})\.jsonl$/i.exec(String(name || ''));
      if (!m || String(name).includes(`${path.sep}subagents`)) return;
      if (tails.has(m[1])) pollSoon(m[1]);
      deskUpdate(m[1]);
    });
  } catch (e) {
    log(`watching ${root} failed (${e.message}); the list refreshes on its own timer`);
  }
  const dir = path.join(configDir(), 'sessions');
  let last = pcWindows();
  let timer = null;
  const check = () => {
    timer = null;
    const now = pcWindows();
    for (const id of new Set([...now.keys(), ...last.keys()])) {
      if (now.get(id)?.busy !== last.get(id)?.busy || !now.has(id) || !last.has(id)) deskUpdate(id);
    }
    last = now;
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.watch(dir, () => { if (!timer) timer = setTimeout(check, 300); });
  } catch (e) {
    log(`watching ${dir} failed (${e.message})`);
  }
}

function ensureCapacity(except) {
  const live = [...new Set(runners.values())].filter((r) => r.proc && r !== except);
  const max = Math.max(1, CONFIG.limits.maxLive);
  if (live.length < max) return;
  const idle = live.filter((r) => r.state !== 'running').sort((a, b) => a.lastUsed - b.lastUsed);
  for (const r of idle.slice(0, live.length - max + 1)) r.close('making room');
}

const LANG = CONFIG.lang;
const duration = (ms) => {
  const sec = Math.round((ms || 0) / 1000);
  const m = Math.floor(sec / 60);
  if (LANG === 'zh') return sec < 60 ? `${sec} 秒` : m < 60 ? `${m} 分 ${sec % 60} 秒` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
  return sec < 60 ? `${sec}s` : m < 60 ? `${m}m ${sec % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

// The notification says only that a turn ended and how long it took, unless push.includeTitle names the conversation.
function pushText(how, name, took) {
  if (LANG === 'zh') {
    const what = { done: '做完了', stopped: '停下了', failed: '没做完' }[how];
    return `${name ? `「${name}」` : '一个对话'}${what}，用时 ${took}`;
  }
  const what = { done: 'finished', stopped: 'was stopped', failed: 'did not finish' }[how];
  return `${name ? `“${name}”` : 'A conversation'} ${what} after ${took}`;
}

function wire(r) {
  r.on('event', (ev) => r.id && broadcast(r.id, 'ev', ev));
  r.on('transient', (ev) => r.id && broadcast(r.id, 'tr', ev));
  r.on('state', () => {
    if (!r.id) return;
    broadcast(r.id, 'tr', { k: 'state', state: r.state, queue: r.queue.length });
    deskUpdate(r.id);
  });
  r.on('pid', savePids);
  r.on('exit', () => {
    savePids();
    if (r.agent === 'codex' && r.id) setTimeout(() => lockChanged(r.id), 150);   // the phone let go of the thread
  });
  r.on('conflict', () => {
    if (!r.id) return;
    conflicts.add(r.id);
    setTimeout(() => lockChanged(r.id), 150);
  });
  r.on('init', (id) => {
    runners.set(id, r);
    store.prefs[id] = { model: r.model, effort: r.effort, ...(r.from ? { from: r.from } : {}) };
    store.savePrefs();
    log(`new session ${id}${r.from ? ` (a branch of ${r.from})` : ''}`);
  });
  r.on('finished', (ev) => {
    const t = r.id && tails.get(r.id);
    if (t) {                                          // skip what the stream already showed
      try {
        t.pos = fs.statSync(t.file).size;
        t.rest = '';
      } catch { /* gone */ }
    }
    if (r.prefsChanged) {
      r.prefsChanged = false;
      r.close('model or effort changed');
    }
    if (!r.id || (subs.get(r.id) || new Set()).size > 0) return;
    const how = ev.ok ? 'done' : ['aborted_tools', 'aborted_streaming', 'stopped', 'interrupted'].includes(ev.reason) ? 'stopped' : 'failed';
    const cm = r.agent === 'codex' ? hub.threads.get(r.id) : null;
    const name = CONFIG.push.includeTitle ? String((cm ? cm.name || cm.preview : metaFor(r.id)?.title) || '').slice(0, 24) : '';
    push(store.settings, LANG === 'zh' ? '值班台' : 'Duty Desk', pushText(how, name, duration(ev.ms)), log);
  });
}

function runnerFor(id, meta, agent = 'claude') {
  let r = runners.get(id);
  if (r) return r;
  if (agent === 'codex') {
    const eff = codexEffective(id, meta);
    r = new CodexRunner({ id, cwd: meta.cwd, model: eff.model, effort: eff.effort, phoneNote: store.settings.phoneNote, idleMinutes: CONFIG.limits.idleMinutes }, hub, log);
  } else {
    const eff = effective(id);
    r = new Runner({ id, cwd: meta.cwd, model: eff.model, effort: eff.effort, phoneNote: store.settings.phoneNote, idleMinutes: CONFIG.limits.idleMinutes }, log);
  }
  wire(r);
  runners.set(id, r);
  return r;
}

const uploadPaths = (names) => names.map((n) => path.join(DATA_DIR, 'uploads', ...n.split('/')));

function takeImages(list) {
  const key = crypto.randomBytes(6).toString('hex');
  const names = [];
  const blocks = [];
  for (const [i, im] of (Array.isArray(list) ? list.slice(0, 6) : []).entries()) {
    const ext = IMAGE_TYPES[im?.type];
    const data = Buffer.from(String(im?.data || ''), 'base64');
    if (!ext || !data.length || data.length > 8 * 1024 * 1024) throw Object.assign(new Error('bad_image'), { status: 400 });
    const name = `${i}.${ext}`;
    fs.writeFileSync(path.join(store.uploadsDir(key), name), data);
    names.push(`${key}/${name}`);
    blocks.push({ type: 'image', source: { type: 'base64', media_type: im.type, data: data.toString('base64') } });
  }
  return { names, blocks };
}

const messageContent = (text, blocks) => [...blocks, { type: 'text', text: text || (LANG === 'zh' ? '（见图）' : '(see the picture)') }];

// ---------------------------------------------------------------- folders: only inside the configured roots
// Links are followed before the check, so a link inside a root cannot lead the phone outside it.
const real = (p) => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
};
const cmpPath = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
const ROOTS = CONFIG.roots.map(real);
const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function inRoots(p) {
  const abs = cmpPath(real(path.resolve(p)));
  return ROOTS.some((r) => abs === cmpPath(r) || abs.startsWith(cmpPath(r.endsWith(path.sep) ? r : r + path.sep)));
}

function browse(p) {
  const target = path.resolve(p || CONFIG.roots[0]);
  if (!isDir(target) || !inRoots(target)) return null;
  const isRoot = ROOTS.some((r) => cmpPath(real(target)) === cmpPath(r));
  const known = new Set();
  try {
    for (const k of fs.readdirSync(path.join(configDir(), 'projects'))) known.add(k.toLowerCase());
  } catch { /* none */ }
  let dirs = [];
  try {
    dirs = fs.readdirSync(target, { withFileTypes: true })
      .filter((d) => !/^[.$]/.test(d.name) && !['node_modules', 'System Volume Information'].includes(d.name))
      .map((d) => ({ d, full: path.join(target, d.name) }))
      .filter(({ d, full }) => d.isDirectory() || (d.isSymbolicLink() && isDir(full) && inRoots(full)))
      .map(({ d, full }) => ({ name: d.name, path: full, cc: known.has(projectKey(full).toLowerCase()) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  } catch { /* unreadable */ }
  return { path: target, name: folderOf(target), parent: isRoot ? null : path.dirname(target), roots: CONFIG.roots.map((r) => ({ name: folderOf(r) || r, path: r })), dirs };
}

// ---------------------------------------------------------------- suggestions from other tools
// Another program on this computer (a job watcher, a build bot) writes a JSON file of things worth starting; the
// desk shows them and a tap starts the conversation with the prompt the program wrote. Nothing starts by itself.
function readSuggestions() {
  const file = CONFIG.suggestions?.file;
  if (!file) return [];
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const raw = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
  const now = Date.now() / 1000;
  const gone = new Set(store.dismissed);
  return raw
    .filter((x) => x && typeof x.id === 'string' && /^[\w.:-]{1,80}$/.test(x.id) && typeof x.prompt === 'string' && x.prompt.trim()
      && !gone.has(x.id) && (!x.expires || Number(x.expires) > now) && typeof x.cwd === 'string' && isDir(x.cwd) && inRoots(x.cwd))
    .slice(0, 12)
    .map((x) => ({
      id: x.id,
      title: String(x.title || '').slice(0, 160),
      detail: String(x.detail || '').slice(0, 300),
      link: /^https:\/\/[^\s]+$/.test(String(x.link || '')) ? String(x.link).slice(0, 600) : '',
      cwd: path.resolve(x.cwd),
      folder: folderOf(path.resolve(x.cwd)),
      prompt: String(x.prompt).slice(0, 8000),
      created: Number(x.created) || 0,
      expires: Number(x.expires) || 0,
    }));
}

function sendSuggestions() {
  if (!deskSubs.size) return;
  const items = readSuggestions();
  for (const res of deskSubs) sse(res, 'suggestions', { items });
}

if (CONFIG.suggestions?.file) {
  fs.watchFile(CONFIG.suggestions.file, { interval: 3000 }, () => sendSuggestions());
}

function recentFolders() {
  const out = [];
  const seen = new Set();
  for (const s of listSessions(60)) {
    const key = String(s.cwd).toLowerCase();
    if (seen.has(key) || !isDir(s.cwd) || !inRoots(s.cwd)) continue;
    seen.add(key);
    out.push({ name: folderOf(s.cwd), path: s.cwd });
    if (out.length >= 6) break;
  }
  return out;
}

// ---------------------------------------------------------------- themes: public/themes/<id>/theme.json + theme.css
const THEME_ID = /^[a-z0-9_-]+$/i;

function themeInfo(id) {
  if (!THEME_ID.test(String(id))) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(PUBLIC, 'themes', id, 'theme.json'), 'utf8'));
  } catch {
    return null;
  }
}

function themes() {
  const dir = path.join(PUBLIC, 'themes');
  const out = [];
  for (const id of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const t = themeInfo(id);
    if (!t || !fs.existsSync(path.join(dir, id, 'theme.css'))) continue;
    const c = t.colors || {};
    out.push({ id, name: t.name || id, names: t.names || {}, scheme: t.scheme || 'light', color: t.color || c.bg, swatch: [c.bg, c.surface, c.accent] });
  }
  return out.sort((a, b) => (a.scheme === b.scheme ? a.name.localeCompare(b.name, 'zh-CN') : a.scheme === 'light' ? -1 : 1));
}

// The theme a device shows when it has not chosen one: the configured theme, or the auto pair's light or dark one.
const themeFor = (scheme) => (CONFIG.theme === 'auto' ? CONFIG.autoThemes[scheme] : CONFIG.theme);

// ---------------------------------------------------------------- HTTP plumbing
const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; "
    + "connect-src 'self'; font-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  ...(TLS ? { 'Strict-Transport-Security': 'max-age=15552000' } : {}),
};

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('bad json'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function deviceFor(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
  const d = findDevice(store.devices, m && m[1]);
  if (d && Date.now() - d.lastSeenAt > 10 * 60000) {       // a write every ten minutes at most
    d.lastSeenAt = Date.now();
    d.lastIp = req.socket.remoteAddress;
    store.saveDevices();
  }
  return d;
}

function openSse(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', ...SECURITY });
  res.write(': open\n\n');
  const hb = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => clearInterval(hb));
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
  '.json': 'application/json', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
};

function sendFile(req, res, file, extra = {}) {
  let st;
  try {
    st = fs.statSync(file);
    if (!st.isFile()) throw new Error('not a file');
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY });
    return res.end('not found');
  }
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const immutable = /[\\/]fonts[\\/]/.test(file);
  const headers = { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', ETag: etag, 'Cache-Control': immutable ? 'public, max-age=31536000' : 'no-cache', ...SECURITY, ...extra };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

function serveStatic(req, res, url) {
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  if (rel === '/' || rel === '/index.html') rel = '/index.html';
  if (rel === '/pc.html') {
    res.writeHead(404);
    return res.end();
  }
  const auto = /^\/theme\/(light|dark)\.css$/.exec(rel);
  if (auto) {
    const id = themeFor(auto[1]);
    rel = `/themes/${THEME_ID.test(String(id)) ? id : 'missing'}/theme.css`;
  }
  if (rel === '/manifest.webmanifest') {
    // the home-screen name in the phone's language, the colours of the light theme
    const zh = /^zh/i.test(String(req.headers['accept-language'] || ''));
    const m = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'manifest.webmanifest'), 'utf8'));
    const bg = themeInfo(themeFor('light'))?.colors?.bg;
    Object.assign(m, zh ? { name: '值班台', short_name: '值班台', description: '在手机上把要求交给电脑上的 Claude Code', lang: 'zh-CN' }
      : { name: 'Duty Desk', short_name: 'Duty Desk', description: 'Hand work to Claude Code on your computer from your phone', lang: 'en' });
    if (bg) Object.assign(m, { background_color: bg, theme_color: bg });
    res.writeHead(200, { 'Content-Type': TYPES['.webmanifest'], 'Cache-Control': 'no-cache', Vary: 'Accept-Language', ...SECURITY });
    return res.end(JSON.stringify(m));
  }
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  return sendFile(req, res, file);
}

// ---------------------------------------------------------------- the computer's own page (loopback only)
function pcState() {
  const { code, expires } = pairing.current();
  const all = [...new Set(runners.values())];
  return {
    code, expires, port: CONFIG.port, scheme: TLS ? 'https' : 'http', addresses: addresses(), timeZone: CONFIG.timeZone,
    devices: store.devices.map(({ id, name, createdAt, lastSeenAt }) => ({ id, name, createdAt, lastSeenAt })),
    running: all.filter((r) => r.state === 'running').length,
    live: all.filter((r) => r.proc).length,
    version: VERSION, claude: claudeCommand().version, codex: hub.version, push: hasPush(),
  };
}

async function handlePc(req, res, url) {
  if (!isLoopback(req.socket.remoteAddress)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Open this page on the computer itself. 只能在这台电脑上打开。');
  }
  if (req.method === 'POST') {
    const origin = req.headers.origin;
    if (req.headers['x-pc'] !== '1' || (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin))) return json(res, 403, { error: 'forbidden' });
  }
  const p = url.pathname;
  if (req.method === 'GET' && (p === '/pc' || p === '/pc/')) return sendFile(req, res, path.join(PUBLIC, 'pc.html'));
  if (req.method === 'GET' && p === '/pc/state') return json(res, 200, pcState());
  if (req.method === 'GET' && p === '/pc/qr.svg') {
    const lan = addresses()[0];
    const { code } = pairing.current();
    const target = `${TLS ? 'https' : 'http'}://${lan ? lan.address : '127.0.0.1'}:${CONFIG.port}/#pair=${code}`;
    // dark squares on a light ground in every theme: phone cameras read that way round most reliably
    const on = url.searchParams.get('on') === 'dark' ? 'dark' : 'light';
    const c = themeInfo(themeFor(on))?.colors || {};
    const color = on === 'dark' ? { dark: c.bg || '#000000', light: c.ink || '#ffffff' } : { dark: c.ink || '#000000', light: '#00000000' };
    const svg = await QRCode.toString(target, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color });
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store', ...SECURITY });
    return res.end(svg);
  }
  if (req.method === 'POST' && p === '/pc/rotate') {
    pairing.rotate();
    return json(res, 200, pcState());
  }
  const m = /^\/pc\/revoke\/([0-9a-f]+)$/.exec(p);
  if (req.method === 'POST' && m) {
    store.devices = store.devices.filter((d) => d.id !== m[1]);
    store.saveDevices();
    log(`device ${m[1]} removed`);
    return json(res, 200, pcState());
  }
  return json(res, 404, { error: 'not found' });
}

// ---------------------------------------------------------------- Codex sessions from the phone
async function codexChoice(b, meta) {
  const models = await codexModels();
  const cur = meta ? codexEffective(meta.id, meta) : hub.defaults();
  const model = models.some((x) => x.id === b.model) ? b.model : cur.model;
  const efforts = models.find((x) => x.id === model)?.efforts || [];
  const effort = typeof b.effort === 'string' && (efforts.includes(b.effort) || (!efforts.length && /^[a-z]+$/.test(b.effort))) ? b.effort : cur.effort;
  return { model, effort };
}

// A runner without an id gets one with its first message: wait for it (or for the start to fail).
function startRunner(r, content, shown) {
  wire(r);
  ensureCapacity(r);
  return new Promise((resolve) => {
    let timer = null;
    const done = (v) => { clearTimeout(timer); resolve(v); };
    timer = setTimeout(() => done({ error: 'timeout' }), 60000);
    r.once('init', (id) => done({ id }));
    r.once('failed', () => done({ error: 'failed' }));
    r.once('finished', (ev) => { if (!r.id) done({ error: ev.reason || 'failed' }); });
    r.enqueue(content, shown);
  });
}

const codexContent = (text, names) => ({ text: text || (LANG === 'zh' ? '（见图）' : '(see the picture)'), images: uploadPaths(names) });

async function newCodexSession(res, b, cwd) {
  if (!hub.available) return json(res, 400, { error: 'codex_unavailable' });
  const { model, effort } = await codexChoice(b, null);
  const text = String(b.text || '').slice(0, 20000).trim();
  const { names } = takeImages(b.images);
  if (!text && !names.length) return json(res, 400, { error: 'empty' });
  const r = new CodexRunner({ id: null, cwd, model, effort, phoneNote: store.settings.phoneNote, idleMinutes: CONFIG.limits.idleMinutes }, hub, log);
  const started = await startRunner(r, codexContent(text, names), { text, images: names });
  if (started.error) {
    log(`a new Codex thread failed to start: ${started.error}`);
    return json(res, 502, { error: started.error, detail: r.notes.map((n) => n.text).join('\n') });
  }
  return json(res, 200, { id: started.id, agent: 'codex' });
}

// ---------------------------------------------------------------- branches
// A branch is a new conversation that keeps this one up to a point, and goes on with the message sent now: all of
// it (b.turn and b.at empty), or what came before one of its messages (Codex: b.turn, the turn that message opened;
// Claude Code: b.at, the message's id). The conversation it came from stays as it was. When the chosen message was
// the first one, nothing is kept: the branch is a new conversation in the same folder.
async function branchFrom(req, res, id, agent, meta) {
  const b = await readBody(req);
  const text = String(b.text || '').slice(0, 20000).trim();
  const { names, blocks } = takeImages(b.images);
  if (!text && !names.length) return json(res, 400, { error: 'empty' });
  if (!fs.existsSync(meta.cwd)) return json(res, 400, { error: 'no_such_dir', cwd: meta.cwd });
  const title = clip(agent === 'codex' ? meta.name || meta.preview : meta.title, 50);
  const name = title ? (LANG === 'zh' ? `分支 · ${title}` : `Branch · ${title}`) : '';
  const common = { id: null, cwd: meta.cwd, phoneNote: store.settings.phoneNote, idleMinutes: CONFIG.limits.idleMinutes, name };
  let r;
  let content;
  if (agent === 'codex') {
    let through = null;
    try {
      const turns = await hub.turnList(id);
      if (b.turn) {
        const i = turns.findIndex((x) => x.id === b.turn);
        if (i < 0) return json(res, 400, { error: 'bad_turn' });
        through = turns[i + 1]?.id || null;                  // newest first: the next one is the turn before
      } else {
        through = turns.find((x) => !/progress/i.test(x.status))?.id || null;
      }
    } catch (e) {
      return json(res, 502, { error: 'codex', detail: e.message });
    }
    const { model, effort } = await codexChoice(b, meta);
    r = new CodexRunner({ ...common, model, effort, fork: through ? { from: id, through } : null }, hub, log);
    content = codexContent(text, names);
  } else {
    let at = '';
    if (b.at) {
      const file = sessionFile(id);
      const parent = file ? await parentOf(file, String(b.at)) : undefined;
      if (parent === undefined) return json(res, 400, { error: 'bad_message' });
      at = parent;
    }
    const cur = effective(id);
    const model = MODELS.some((x) => x.id === b.model) ? b.model : cur.model;
    const effort = EFFORTS.includes(b.effort) ? b.effort : cur.effort;
    r = new Runner({ ...common, model, effort, fork: b.at && !at ? null : { from: id, at } }, log);
    content = messageContent(text, blocks);
  }
  r.from = id;
  const started = await startRunner(r, content, { text, images: names });
  if (started.error) {
    log(`a branch of ${id} failed to start: ${started.error}`);
    return json(res, 502, { error: started.error, detail: r.notes.map((n) => n.text).join('\n') });
  }
  return json(res, 200, { id: started.id, agent, from: id });
}

async function handleCodexSession(req, res, url, id, sub) {
  const method = req.method;
  const r0 = runners.get(id);
  let meta = hub.threads.get(id) || (await hub.lookup(id));
  if (meta && !meta.path) meta = (await hub.refresh(id)) || meta;
  meta = meta
    || (r0 ? { id, cwd: r0.cwd, name: '', preview: '', model: r0.model, effort: r0.effort, path: '', updatedAt: Date.now() } : null);
  if (!meta) return json(res, 404, { error: 'no_session' });

  if (method === 'GET' && sub === '') {
    let page = { events: [], cursor: null, hasMore: false };
    try {
      page = await hub.history(id, { want: 140 });
    } catch (e) {
      log(`codex history ${id}: ${e.message}`);
    }
    meta = (await hub.refresh(id)) || meta;                 // the list leaves out what a thread was forked from
    const r = runners.get(id);
    const since = page.events.length ? page.events[0].t : 0;
    const notes = r ? r.notes.filter((n) => n.t >= since && !r.live.includes(n)) : [];
    const events = [...page.events, ...notes].sort((a, b) => (a.t || 0) - (b.t || 0));
    return json(res, 200, { session: { ...codexSummary(meta), from: await branchOrigin(id, meta.forkedFrom) }, events, cursor: page.cursor, hasMore: page.hasMore });
  }
  if (method === 'GET' && sub === '/history') {
    const before = url.searchParams.get('before');
    if (!before) return json(res, 400, { error: 'bad_cursor' });
    try {
      return json(res, 200, await hub.history(id, { cursor: before, want: 140 }));
    } catch (e) {
      return json(res, 502, { error: 'codex', detail: e.message });
    }
  }
  if (method === 'GET' && sub === '/stream') {
    openSse(req, res);
    const r = runners.get(id);
    startCodexTail(id, meta);
    sse(res, 'tr', { k: 'state', state: r?.state || 'idle', queue: r?.queue.length || 0 });
    sse(res, 'tr', codexPc(id));
    lockSeen.set(id, codexLock(id));
    if (r) {
      for (const ev of r.live) sse(res, 'ev', ev);
      if (r.state === 'running') sse(res, 'tr', { k: 'live', text: r.liveText || '', activity: r.activity || null, since: r.turn?.start || Date.now() });
    }
    if (!subs.has(id)) subs.set(id, new Set());
    subs.get(id).add(res);
    req.on('close', () => {
      subs.get(id)?.delete(res);
      stopTail(id);
    });
    return undefined;
  }
  if (method === 'POST' && sub === '/messages') {
    const b = await readBody(req);
    const text = String(b.text || '').slice(0, 20000).trim();
    const { names } = takeImages(b.images);
    if (!text && !names.length) return json(res, 400, { error: 'empty' });
    if (!fs.existsSync(meta.cwd)) return json(res, 400, { error: 'no_such_dir', cwd: meta.cwd });
    const r = runnerFor(id, meta, 'codex');
    if (r.state !== 'running' && tails.get(id)?.busy) return json(res, 409, { error: 'pc_busy' });
    // the Codex app has the thread open: only it can write the thread now, so the phone goes on in a branch
    if (codexLock(id) === 'pc') return json(res, 409, { error: 'pc_holds' });
    if (!r.proc) ensureCapacity(r);
    const out = r.enqueue({ text: text || (LANG === 'zh' ? '（见图）' : '(see the picture)'), images: uploadPaths(names) }, { text, images: names });
    deskUpdate(id);
    return json(res, 200, out);
  }
  if (method === 'POST' && sub === '/fork') return branchFrom(req, res, id, 'codex', meta);
  if (method === 'POST' && sub === '/interrupt') {
    const r = runners.get(id);
    return json(res, 200, { ok: r ? r.interrupt() : false });
  }
  if (method === 'PUT' && sub === '/prefs') {
    const b = await readBody(req);
    const next = await codexChoice(b, meta);
    store.prefs[id] = { ...store.prefs[id], ...next };
    store.savePrefs();
    const r = runners.get(id);
    if (r) {
      r.model = next.model;
      r.effort = next.effort;
    }
    return json(res, 200, { session: codexSummary(meta) });
  }
  return json(res, 404, { error: 'not_found' });
}

// ---------------------------------------------------------------- the phone's API
function publicSettings() {
  const s = store.settings;
  return { pushOnFinish: s.pushOnFinish, phoneNote: s.phoneNote, push: hasPush(), pushTitle: CONFIG.push.includeTitle };
}

async function handleApi(req, res, url, ip) {
  const p = url.pathname;
  const method = req.method;

  if (method === 'GET' && p === '/api/ping') return json(res, 200, { ok: true, app: 'cc-phone-bridge', version: VERSION, paired: !!deviceFor(req) });
  if (method === 'POST' && p === '/api/pair') {
    const body = await readBody(req);
    const r = pairing.attempt(ip, body.code);
    if (!r.ok) {
      log(`pairing refused from ${ip}: ${r.error}`);
      return json(res, 403, { error: r.error });
    }
    const { token, device } = newDevice(body.name, ip);
    store.devices.push(device);
    store.saveDevices();
    log(`device ${device.id} paired`);
    return json(res, 200, { token, device: { id: device.id, name: device.name } });
  }

  const device = deviceFor(req);
  if (!device) return json(res, 401, { error: 'unpaired' });

  if (method === 'POST' && p === '/api/pair/code') return json(res, 200, pairing.rotate());
  if (method === 'DELETE' && p === '/api/me') {
    store.devices = store.devices.filter((d) => d.id !== device.id);
    store.saveDevices();
    return json(res, 200, { ok: true });
  }
  if (method === 'GET' && p === '/api/state') {
    const d = defaults();
    const claudeDefaults = { model: d.model, modelName: modelName(d.model), effort: effortFor(d.model) };
    const cmodels = await codexModels();
    const cd = hub.available ? hub.defaults() : null;
    const codex = hub.available && cmodels.length
      ? { available: true, version: hub.version, models: cmodels, defaults: { model: cd.model, modelName: hub.modelName(cd.model), effort: cd.effort }, resume: CONFIG.codex.resumeCommand }
      : { available: false, reason: hub.reason || 'unavailable' };
    return json(res, 200, {
      settings: publicSettings(),
      server: {
        lang: LANG, version: VERSION, host: os.hostname(), port: CONFIG.port, scheme: TLS ? 'https' : 'http', addresses: addresses(), claude: claudeCommand().version,
        codex: codex.available ? codex.version : '',
        timeZone: CONFIG.timeZone, theme: { default: CONFIG.theme, light: themeFor('light'), dark: themeFor('dark') }, resume: CONFIG.claude.resumeCommand,
      },
      device: { id: device.id, name: device.name },
      models: MODELS, efforts: EFFORTS, themes: themes(),
      defaults: claudeDefaults,
      agents: { claude: { available: true, models: MODELS, efforts: EFFORTS, defaults: claudeDefaults, resume: CONFIG.claude.resumeCommand }, codex },
    });
  }
  if (method === 'PUT' && p === '/api/settings') {
    const b = await readBody(req);
    if (typeof b.pushOnFinish === 'boolean') store.settings.pushOnFinish = b.pushOnFinish;
    if (typeof b.phoneNote === 'boolean') {
      store.settings.phoneNote = b.phoneNote;
      for (const r of new Set(runners.values())) r.phoneNote = b.phoneNote;
    }
    store.saveSettings();
    return json(res, 200, publicSettings());
  }
  if (method === 'GET' && p === '/api/browse') {
    const b = browse(url.searchParams.get('path'));
    if (!b) return json(res, 403, { error: 'outside_roots' });
    return json(res, 200, { ...b, recent: url.searchParams.get('path') ? undefined : recentFolders() });
  }
  if (method === 'POST' && p === '/api/dirs') {
    const b = await readBody(req);
    const parent = path.resolve(String(b.parent || CONFIG.roots[0]));
    const name = String(b.name || '').trim();
    if (!isDir(parent) || !inRoots(parent)) return json(res, 403, { error: 'outside_roots' });
    if (!/^[\p{L}\p{N}_][\p{L}\p{N}_ .()-]{0,60}$/u.test(name) || /[. ]$/.test(name) || name.includes('..')
      || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name)) return json(res, 400, { error: 'bad_name' });
    const full = path.join(parent, name);
    if (fs.existsSync(full)) return json(res, 409, { error: 'exists', path: full });
    fs.mkdirSync(full);
    log('folder created from the phone');
    return json(res, 200, { name, path: full });
  }
  if (method === 'GET' && p.startsWith('/api/files/')) {
    const m = /^\/api\/files\/([0-9a-f]{12})\/(\d\.(jpg|png|webp|gif))$/.exec(p);
    if (!m) return json(res, 400, { error: 'bad_name' });
    return sendFile(req, res, path.join(DATA_DIR, 'uploads', m[1], m[2]), { 'Cache-Control': 'private, max-age=86400' });
  }
  if (method === 'GET' && p === '/api/suggestions') return json(res, 200, { items: readSuggestions() });
  if (method === 'POST' && p === '/api/suggestions/dismiss') {
    const b = await readBody(req);
    const id = String(b.id || '');
    if (!/^[\w.:-]{1,80}$/.test(id)) return json(res, 400, { error: 'bad_id' });
    store.dismiss(id);
    sendSuggestions();
    return json(res, 200, { ok: true });
  }
  if (method === 'GET' && p === '/api/sessions') {
    const windows = pcWindows();
    const limit = Math.min(200, Number(url.searchParams.get('limit')) || 80);
    const which = url.searchParams.get('agent') || 'all';
    const out = which === 'codex' ? [] : listSessions(limit).map((m) => summary(m, windows));
    if (which !== 'claude' && hub.available) {
      try {
        for (const m of await hub.listThreads(limit)) out.push(codexSummary(m));
      } catch (e) {
        log(`codex thread list: ${e.message}`);
      }
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return json(res, 200, { sessions: out.slice(0, limit) });
  }
  if (method === 'GET' && p === '/api/stream') {
    openSse(req, res);
    deskSubs.add(res);
    req.on('close', () => deskSubs.delete(res));
    return undefined;
  }
  if (method === 'POST' && p === '/api/sessions') {
    const b = await readBody(req);
    const cwd = path.resolve(String(b.cwd || ''));
    if (!b.cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return json(res, 400, { error: 'no_such_dir' });
    if (!inRoots(cwd)) return json(res, 403, { error: 'outside_roots' });
    if (b.agent === 'codex') return newCodexSession(res, b, cwd);
    const d = defaults();
    const model = MODELS.some((m) => m.id === b.model) ? b.model : d.model;
    const effort = EFFORTS.includes(b.effort) ? b.effort : effortFor(model);
    const text = String(b.text || '').slice(0, 20000).trim();
    const { names, blocks } = takeImages(b.images);
    if (!text && !names.length) return json(res, 400, { error: 'empty' });
    const r = new Runner({ id: null, cwd, model, effort, phoneNote: store.settings.phoneNote, idleMinutes: CONFIG.limits.idleMinutes }, log);
    const started = await startRunner(r, messageContent(text, blocks), { text, images: names });
    if (started.error) {
      const why = r.notes.map((n) => n.text).join('\n');
      log(`a new session failed to start: ${started.error}`);
      return json(res, 502, { error: started.error, detail: why });
    }
    return json(res, 200, { id: started.id });
  }

  const m = /^\/api\/sessions\/([0-9a-f-]{36})(\/[a-z]+)?$/i.exec(p);
  if (!m || !SID.test(m[1])) return json(res, 404, { error: 'not_found' });
  const id = m[1].toLowerCase();
  const sub = m[2] || '';
  if ((await agentOf(id)) === 'codex') return handleCodexSession(req, res, url, id, sub);
  const meta = metaFor(id) || (runners.get(id) ? { id, cwd: runners.get(id).cwd, title: '', model: runners.get(id).model } : null);
  if (!meta) return json(res, 404, { error: 'no_session' });
  const file = sessionFile(id);

  if (method === 'GET' && sub === '') {
    const page = file ? historyPage(file, { want: 140 }) : { events: [], cursor: 0, hasMore: false };
    const r = runners.get(id);
    const since = page.events.length ? page.events[0].t : 0;
    const notes = r ? r.notes.filter((n) => n.t >= since && !r.live.includes(n)) : [];
    const events = [...page.events, ...notes].sort((a, b) => (a.t || 0) - (b.t || 0));
    return json(res, 200, { session: { ...summary(meta), from: await branchOrigin(id) }, events, cursor: page.cursor, hasMore: page.hasMore });
  }
  if (method === 'GET' && sub === '/history') {
    const before = Number(url.searchParams.get('before'));
    if (!file || !Number.isFinite(before)) return json(res, 400, { error: 'bad_cursor' });
    return json(res, 200, historyPage(file, { before, want: 140 }));
  }
  if (method === 'GET' && sub === '/stream') {
    openSse(req, res);
    const r = runners.get(id);
    const w = pcWindows().get(id);
    sse(res, 'tr', { k: 'state', state: r?.state || 'idle', queue: r?.queue.length || 0 });
    sse(res, 'tr', { k: 'pc', open: !!w, busy: !!w?.busy });
    if (r) {
      for (const ev of r.live) sse(res, 'ev', ev);
      if (r.state === 'running') sse(res, 'tr', { k: 'live', text: r.liveText || '', activity: r.activity || null, since: r.turn?.start || Date.now() });
    }
    if (!subs.has(id)) subs.set(id, new Set());
    subs.get(id).add(res);
    startTail(id);
    req.on('close', () => {
      subs.get(id)?.delete(res);
      stopTail(id);
    });
    return undefined;
  }
  if (method === 'POST' && sub === '/messages') {
    const b = await readBody(req);
    const text = String(b.text || '').slice(0, 20000).trim();
    const { names, blocks } = takeImages(b.images);
    if (!text && !names.length) return json(res, 400, { error: 'empty' });
    if (!fs.existsSync(meta.cwd)) return json(res, 400, { error: 'no_such_dir', cwd: meta.cwd });
    const r = runnerFor(id, meta);
    if (!r.proc) ensureCapacity(r);
    const out = r.enqueue(messageContent(text, blocks), { text, images: names });
    deskUpdate(id);
    return json(res, 200, out);
  }
  if (method === 'POST' && sub === '/fork') return branchFrom(req, res, id, 'claude', meta);
  if (method === 'POST' && sub === '/interrupt') {
    const r = runners.get(id);
    return json(res, 200, { ok: r ? r.interrupt() : false });
  }
  if (method === 'PUT' && sub === '/prefs') {
    const b = await readBody(req);
    const cur = effective(id);
    const next = { model: MODELS.some((x) => x.id === b.model) ? b.model : cur.model, effort: EFFORTS.includes(b.effort) ? b.effort : cur.effort };
    store.prefs[id] = { ...store.prefs[id], ...next };
    store.savePrefs();
    const r = runners.get(id);
    if (r && (r.model !== next.model || r.effort !== next.effort)) {
      r.model = next.model;
      r.effort = next.effort;
      if (r.state === 'running') r.prefsChanged = true;
      else r.close('model or effort changed');
    }
    return json(res, 200, { session: summary(meta) });
  }
  return json(res, 404, { error: 'not_found' });
}

// ---------------------------------------------------------------- the server
async function handler(req, res) {
  const ip = req.socket.remoteAddress;
  if (!isPrivate(ip)) {
    res.writeHead(403);
    return res.end();
  }
  if (!hostAllowed(req.headers.host, CONFIG.extraHosts)) {
    res.writeHead(421, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('wrong host');
  }
  let url;
  try {
    url = new URL(req.url, 'http://bridge.local');
  } catch {
    res.writeHead(400);
    return res.end();
  }
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url, ip);
    if (url.pathname === '/pc' || url.pathname.startsWith('/pc/')) return await handlePc(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method' });
    return serveStatic(req, res, url);
  } catch (e) {
    if (e.status) return json(res, e.status, { error: e.message });
    log(`error on ${req.method} ${url.pathname}: ${e.stack || e.message}`);
    if (!res.headersSent) return json(res, 500, { error: 'internal' });
    return res.end();
  }
}

const server = TLS
  ? https.createServer({ cert: fs.readFileSync(CONFIG.tls.cert), key: fs.readFileSync(CONFIG.tls.key) }, handler)
  : http.createServer(handler);
server.keepAliveTimeout = 65000;
server.requestTimeout = 0;
server.headersTimeout = 30000;

server.on('error', (e) => {
  log(`server error ${e.code || e.message}`);
  process.exit(e.code === 'EADDRINUSE' ? 3 : 1);
});

function shutdown(sig) {
  log(`stopping (${sig})`);
  for (const r of new Set(runners.values())) r.close('shutdown');
  setTimeout(async () => {
    for (const r of new Set(runners.values())) if (r.proc?.pid) await killTree(r.proc.pid);
    await hub.stop();
    process.exit(0);
  }, 3000);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => log(`uncaught ${e.stack || e.message}`));

await reapOrphans();
detectVersion();
cleanUploads();
setInterval(cleanUploads, 6 * 3600 * 1000).unref();
watchProjects();
watchCodex();
watchCodexLocks();
server.listen(CONFIG.port, CONFIG.host, () => {
  const where = addresses().map((a) => `${TLS ? 'https' : 'http'}://${a.address}:${CONFIG.port}/`).join('  ');
  log(`cc-phone-bridge ${VERSION} on ${CONFIG.port} (${where}); data ${DATA_DIR}; config ${fs.existsSync(CONFIG_FILE) ? CONFIG_FILE : 'defaults'}; sessions ${configDir()}`);
});
