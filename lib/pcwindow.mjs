// Claude Code windows open on this computer, read from Claude Code's own session registry
// (configDir/sessions/<pid>.json), and typing into one of them: when a conversation is open in a window, a message
// from the phone is typed into that window, so the window runs the turn and shows it as it happens, exactly as if
// it had been typed on the keyboard. Windows only; elsewhere the phone runs the conversation on its own as before.
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG, DATA_DIR } from './config.mjs';
import { configDir } from './transcripts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(HERE, 'win', 'typein.cs');

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

// Whether the window's editor is the plain one: in vim mode the keys below would mean something else.
function vimMode() {
  for (const f of [path.join(configDir(), 'settings.json'), path.join(configDir(), '.claude.json')]) {
    try {
      if (/vim/i.test(String(JSON.parse(fs.readFileSync(f, 'utf8')).editorMode || ''))) return true;
    } catch { /* none */ }
  }
  return false;
}

// Every conversation open in a Claude Code window, by session id: { pid, busy, waiting, waitingFor, typable }.
// Runs started with -p (the phone's own, scripts) register too, with an sdk entrypoint: they are not windows, and
// neither are the pids in `own`. Two windows on one conversation: the one used last.
export function windows(own = new Set()) {
  const out = new Map();
  const dir = path.join(configDir(), 'sessions');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f));
  } catch {
    return out;
  }
  const typing = typingEnabled();
  for (const f of files) {
    let s;
    try {
      s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch {
      continue;                                      // being rewritten
    }
    if (s.kind !== 'interactive' || !s.sessionId || !Number.isInteger(s.pid)) continue;
    const entry = String(s.entrypoint || '');
    if (entry.startsWith('sdk') || own.has(s.pid) || !alive(s.pid)) continue;
    const status = String(s.status || 'idle');
    const w = {
      pid: s.pid,
      busy: status === 'busy',
      waiting: status === 'waiting' || !!s.waitingFor,
      waitingFor: String(s.waitingFor || ''),
      typable: typing && entry === 'cli',
      updatedAt: Number(s.updatedAt) || 0,
    };
    const prev = out.get(s.sessionId);
    if (!prev || w.updatedAt > prev.updatedAt) out.set(s.sessionId, w);
  }
  return out;
}

export function typingEnabled() {
  return process.platform === 'win32' && CONFIG.claude.typeIntoWindows !== false && !vimMode();
}

// ---------------------------------------------------------------- the typing helper
// lib/win/typein.cs, built once with the C# compiler that comes with Windows into <data>/bin (never in the repo).
const CSC = ['Framework64', 'Framework'].map((d) => path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', d, 'v4.0.30319', 'csc.exe'));
let built = null;

export function helper() {
  if (process.env.CCPB_TYPEIN_CMD) return Promise.resolve(JSON.parse(process.env.CCPB_TYPEIN_CMD));
  if (process.platform !== 'win32') return Promise.resolve(null);
  if (!built) built = build().catch(() => null);
  return built;
}

async function build() {
  const code = fs.readFileSync(SOURCE);
  const tag = crypto.createHash('sha256').update(code).digest('hex').slice(0, 12);
  const dir = path.join(DATA_DIR, 'bin');
  const exe = path.join(dir, `typein-${tag}.exe`);
  if (fs.existsSync(exe)) return [exe];
  const csc = CSC.find((p) => fs.existsSync(p));
  if (!csc) return null;
  fs.mkdirSync(dir, { recursive: true });
  await new Promise((resolve) => {
    execFile(csc, ['-nologo', '-optimize', `-out:${exe}`, SOURCE], { windowsHide: true, timeout: 120000 }, () => resolve());
  });
  if (!fs.existsSync(exe)) return null;
  for (const f of fs.readdirSync(dir)) {
    if (/^typein-[0-9a-f]{12}\.exe$/.test(f) && f !== path.basename(exe)) fs.rmSync(path.join(dir, f), { force: true });
  }
  return [exe];
}

// Types `steps` (see typein.cs) into the console of `pid`. Resolves { ok, code, detail }.
export async function typeInto(pid, steps) {
  const cmd = await helper();
  if (!cmd) return { ok: false, code: 'no_helper' };
  const [bin, ...pre] = cmd;
  return new Promise((resolve) => {
    let err = '';
    const p = spawn(bin, [...pre, String(pid)], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    const timer = setTimeout(() => {
      try {
        p.kill();
      } catch { /* gone */ }
    }, 30000);
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (d) => { err = (err + d).slice(-300); });
    p.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: 'spawn', detail: e.message });
    });
    p.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code: code === 0 ? 0 : ({ 2: 'attach', 3: 'no_input', 4: 'write', 5: 'bad_step' }[code] || `exit ${code}`), detail: err.trim() });
    });
    p.stdin.on('error', () => {});
    p.stdin.end(`${steps.join('\n')}\n`);
  });
}

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

// A message typed the way a person would, keeping whatever is in the window's box: one letter makes the box
// non-empty, Ctrl+S stashes it (Claude Code puts a stash back once the next message is sent), pictures and text go
// in as pastes (a pasted picture path becomes the picture itself), Enter sends, and Backspace takes the letter
// off what came back. A slash command does not bring the stash back, so `after` fetches it when the command is done.
export function messageSteps(text, images = []) {
  const steps = [`T ${b64('x')}`, 'W 80', 'K ctrl+s', 'W 80'];
  for (const p of images) steps.push(`P ${b64(p)}`, 'W 400');
  if (text) steps.push(`P ${b64(images.length ? ` ${text}` : text)}`, 'W 150');
  steps.push('K enter');
  const command = !images.length && /^\//.test(text.trim());
  if (!command) steps.push('W 700', 'K backspace');
  return { steps, after: command ? ['K ctrl+s', 'W 100', 'K backspace'] : null };
}

export const stopSteps = () => ['K esc'];

// What a person typed, compared loosely: the box may write [Image #1] for a picture and trims the ends.
export const normPrompt = (s) => String(s || '').replace(/\[Image #\d+\]/g, ' ').replace(/\s+/g, ' ').trim();
