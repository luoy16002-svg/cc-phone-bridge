// What a Claude Code window runs with right now. /effort in a window sets that window only ("this session only")
// and Claude Code writes the command's output into the transcript; a model change shows as the window's model note
// and in its replies. So the transcript, read from where the window started, tells the effort and model the window
// uses. It is read once in slices without holding the server up, then only what the file gains.
import fs from 'node:fs';

const LEVEL = /^(low|medium|high|xhigh|max)$/;
// Lines worth parsing: the outputs of /effort and the model note, all of them; of the replies only the last one.
const HINTS = ['Set effort level to', 'Effort level set to auto', 'Effort set to auto', 'exceeds the cap for', 'Cleared effort from settings', '"type":"model"'].map((s) => Buffer.from(s));
const REPLY = Buffer.from('"type":"assistant"');
const SLICE = 4 * 1024 * 1024;

const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x?.type === 'text').map((x) => x.text).join('') : '');

// The effort a transcript entry set: a level, 'auto' (back to what the settings give), or null.
export function effortSet(o) {
  if (o?.type !== 'user' || o.isSidechain) return null;
  const m = /^\s*<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(textOf(o.message?.content));
  if (!m) return null;
  const out = m[1].trim();
  const g = /^Set effort level to ([a-z]+)/.exec(out)
    || /^Effort '[^']*' exceeds the cap for .*? set to '([a-z]+)' instead/.exec(out)
    || /CLAUDE_CODE_EFFORT_LEVEL=([a-z]+) still controls this session/.exec(out);
  if (g) return LEVEL.test(g[1]) ? g[1] : null;
  if (/^Effort (level )?set to auto/.test(out) || /^Cleared effort from settings/.test(out)) return 'auto';
  return null;
}

// The model an entry says the window uses: its model note, or the model a reply came from.
export function modelSeen(o) {
  if (!o || o.isSidechain) return '';
  if (o.type === 'attachment' && o.attachment?.type === 'model') return String(o.attachment.identity?.modelId || '');
  if (o.type === 'assistant' && !o.isApiErrorMessage) {
    const m = o.message?.model;
    return m && m !== '<synthetic>' ? m : '';
  }
  return '';
}

const stamp = (o) => Date.parse(o?.timestamp || '') || 0;

// Where the window's own lines begin, near enough: timestamps only grow, so halve the file until the slice is small.
async function startOf(fd, size, startedAt) {
  if (!startedAt) return 0;
  let lo = 0;
  let hi = size;
  const buf = Buffer.alloc(64 * 1024);
  while (hi - lo > SLICE) {
    const mid = Math.floor((lo + hi) / 2);
    const { bytesRead } = await fd.read(buf, 0, buf.length, mid);
    let t = 0;
    let i = buf.indexOf(0x0a);
    while (i >= 0 && i < bytesRead && !t) {
      const j = buf.indexOf(0x0a, i + 1);
      if (j < 0 || j > bytesRead) break;
      try {
        t = stamp(JSON.parse(buf.subarray(i + 1, j).toString('utf8')));
      } catch { /* not a whole line */ }
      i = j;
    }
    if (!t) break;                                    // one very long line: read from here on, it is still right
    if (t < startedAt) lo = mid;
    else hi = mid;
  }
  return lo;
}

const tunes = new Map();

// The window's tune for a session: { effort, model } as far as read; reading on goes on by itself and `onChange`
// hears when either changes. `startedAt` is when the window started, from Claude Code's own session registry.
export function windowTune(id, file, startedAt, onChange) {
  let t = tunes.get(id);
  if (!t || t.file !== file || t.startedAt !== startedAt) {
    t = { file, startedAt, pos: null, size: -1, effort: '', model: '', reading: null, again: false };
    tunes.set(id, t);
    if (tunes.size > 200) tunes.delete(tunes.keys().next().value);
  }
  let size = -1;
  try {
    size = fs.statSync(file).size;
  } catch { /* gone */ }
  if (size !== t.size) {
    t.size = size;
    readOn(t, onChange);
  }
  return t;
}

export function forgetTune(id) {
  tunes.delete(id);
}

function readOn(t, onChange) {
  if (t.reading) {
    t.again = true;
    return;
  }
  t.reading = read(t).then((changed) => {
    t.reading = null;
    if (changed) onChange?.(t);
    if (t.again) {
      t.again = false;
      readOn(t, onChange);
    }
  }, () => { t.reading = null; });
}

async function read(t) {
  const before = `${t.effort}|${t.model}`;
  const fd = await fs.promises.open(t.file, 'r');
  try {
    const size = (await fd.stat()).size;
    if (t.pos === null || size < t.pos) t.pos = await startOf(fd, size, t.startedAt);
    let pos = t.pos;
    while (pos < size) {
      let len = Math.min(SLICE, size - pos);
      let buf = Buffer.alloc(len);
      await fd.read(buf, 0, len, pos);
      let end = buf.lastIndexOf(0x0a);
      while (end < 0 && pos + len < size) {             // a line longer than a slice: take more of it
        len = Math.min(len * 2, size - pos);
        buf = Buffer.alloc(len);
        await fd.read(buf, 0, len, pos);
        end = buf.lastIndexOf(0x0a);
      }
      if (end < 0) break;                               // the last line is still being written
      const lines = new Set();
      for (const h of HINTS) {
        for (let i = buf.indexOf(h); i >= 0 && i < end; i = buf.indexOf(h, i + 1)) {
          const s = buf.lastIndexOf(0x0a, i) + 1;
          lines.add(s);
          const e = buf.indexOf(0x0a, i);
          i = e < 0 ? end : e;
        }
      }
      // the last reply of the slice that says its model (replies within one turn all do)
      for (let i = buf.lastIndexOf(REPLY, end); i >= 0; i = buf.lastIndexOf(REPLY, i - 1)) {
        const s = buf.lastIndexOf(0x0a, i) + 1;
        let o = null;
        try {
          o = JSON.parse(buf.subarray(s, buf.indexOf(0x0a, i)).toString('utf8'));
        } catch { /* a hint inside some other line */ }
        if (modelSeen(o)) {
          lines.add(s);
          break;
        }
        if (s === 0) break;
        i = s;
      }
      for (const s of [...lines].sort((a, b) => a - b)) {
        const e = buf.indexOf(0x0a, s);
        let o;
        try {
          o = JSON.parse(buf.subarray(s, e).toString('utf8'));
        } catch {
          continue;
        }
        // an effort set before this window started was another window's; a model seen then is still a fair guess
        const effort = effortSet(o);
        if (effort && !(t.startedAt && stamp(o) && stamp(o) < t.startedAt - 2000)) t.effort = effort;
        const model = modelSeen(o);
        if (model) t.model = model;
      }
      pos += end + 1;
      if (pos < size) await new Promise((r) => setImmediate(r));
    }
    t.pos = pos;
  } finally {
    await fd.close();
  }
  return `${t.effort}|${t.model}` !== before;
}
