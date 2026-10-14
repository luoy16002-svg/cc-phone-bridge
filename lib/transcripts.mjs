// Claude Code's own conversation files are the history: every session on this PC, in every folder.
// configDir/projects/<folder key>/<session id>.jsonl, one JSON object per line.
import fs from 'node:fs';
import path from 'node:path';
import { describeTool } from './describe.mjs';
import { CONFIG } from './config.mjs';

const HEAD = 96 * 1024;
const TAIL = 160 * 1024;
const CHUNK = 1024 * 1024;

export function configDir() {
  return CONFIG.claude.configDir;
}

export const projectKey = (cwd) => String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
const cut = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

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

function parseLines(buf, dropFirst) {
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  if (dropFirst) lines.shift();
  const out = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      // a line cut at the edge of the slice
    }
  }
  return out;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return '';
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c.type === 'text' ? c.text : c.type === 'image' ? '[image]' : '')).join('\n');
  return '';
}

// What the person typed, with the wrappers Claude Code puts around commands and reminders taken off.
export function cleanPrompt(raw) {
  const t = String(raw || '').trim();
  if (!t) return null;
  const cmd = /<command-name>\s*([^<]+?)\s*<\/command-name>/.exec(t);
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t);
    return { text: `${cmd[1].startsWith('/') ? '' : '/'}${cmd[1]}${args && args[1].trim() ? ` ${args[1].trim()}` : ''}`, command: true };
  }
  if (/^<(local-command-|system-reminder|bash-|task-notification|user-memory-input)/.test(t) || t.startsWith('Caveat:')) return null;
  if (t.startsWith('This session is being continued from a previous conversation')) return null;
  return { text: t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim() };
}

// One transcript line -> the events the phone shows.
export function lineEvents(o, out) {
  if (!o || o.isSidechain) return;
  const t = Date.parse(o.timestamp || '') || 0;
  if (o.type === 'user') {
    if (o.isCompactSummary) {
      out.push({ k: 'note', id: o.uuid, t, tone: 'info', text: '上下文压缩过，之前的内容由摘要接续' });
      return;
    }
    if (o.isMeta) return;
    const c = o.message?.content;
    const parts = Array.isArray(c) ? c : [{ type: 'text', text: String(c ?? '') }];
    for (const x of parts) {
      if (x.type === 'tool_result') {
        out.push({ k: 'tool_result', id: `${o.uuid}:${x.tool_use_id}`, tool: x.tool_use_id, t, ok: !x.is_error, text: cut(resultText(x.content).replace(/<\/?tool_use_error>/g, ''), 1200) });
      }
    }
    const text = textOf(parts);
    const images = parts.filter((x) => x.type === 'image').length;
    if (/^\[Request interrupted by user/.test(text.trim())) {
      out.push({ k: 'note', id: o.uuid, t, tone: 'warn', text: '已打断' });
      return;
    }
    const p = cleanPrompt(text);
    if (p || images) out.push({ k: 'user', id: o.uuid, t, text: p ? p.text : '', images, command: !!p?.command });
  } else if (o.type === 'assistant') {
    if (o.isApiErrorMessage) {
      out.push({ k: 'note', id: o.uuid, t, tone: 'error', text: cut(textOf(o.message?.content), 400) });
      return;
    }
    (o.message?.content || []).forEach((x, i) => {
      if (x.type === 'text' && x.text && x.text.trim()) out.push({ k: 'text', id: `${o.uuid}:${i}`, t, text: x.text, model: o.message.model || '' });
      else if (x.type === 'tool_use') out.push({ k: 'tool', id: `${o.uuid}:${i}`, tool: x.id, t, name: x.name, ...describeTool(x.name, x.input, o.cwd) });
    });
  } else if (o.type === 'system' && o.subtype === 'compact_boundary') {
    out.push({ k: 'note', id: o.uuid, t, tone: 'info', text: '上下文自动压缩了一次' });
  }
}

// ---------------------------------------------------------------- the list of sessions
const metaCache = new Map();
const idIndex = new Map();

export function sessionFiles() {
  const root = path.join(configDir(), 'projects');
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const d of dirs) {
    if (/AppData-Local-Temp/i.test(d.name) && !process.env.CCPB_SHOW_TEMP) continue;
    const dir = path.join(root, d.name);
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const full = path.join(dir, f);
      try {
        const st = fs.statSync(full);
        const id = f.slice(0, -6);
        idIndex.set(id, full);
        out.push({ id, file: full, key: d.name, mtime: st.mtimeMs, size: st.size });
      } catch { /* removed meanwhile */ }
    }
  }
  return out;
}

export function sessionFile(id) {
  if (idIndex.has(id) && fs.existsSync(idIndex.get(id))) return idIndex.get(id);
  sessionFiles();
  return idIndex.get(id) || null;
}

// The first readable lines of a reply: no table rows, rules, code or markdown marks.
function preview(md) {
  const out = [];
  let code = false;
  for (const line of String(md || '').split('\n')) {
    if (/^\s*```/.test(line)) { code = !code; continue; }
    if (code || /^\s*\|/.test(line) || /^\s*[-=*_]{3,}\s*$/.test(line)) continue;
    const clean = line.replace(/[#*`>_]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();
    if (clean) out.push(clean);
    if (out.join(' ').length > 200) break;
  }
  return out.join(' ');
}

export function sessionMeta(info) {
  const key = `${info.file}|${info.mtime}|${info.size}`;
  if (metaCache.has(key)) return metaCache.get(key);
  const head = parseLines(readSlice(info.file, 0, Math.min(HEAD, info.size)), false);
  const tail = info.size > HEAD ? parseLines(readSlice(info.file, Math.max(0, info.size - TAIL), TAIL), true) : head;
  let cwd = '';
  let title = '';
  let first = '';
  let created = 0;
  for (const o of head) {
    if (!cwd && o.cwd) cwd = o.cwd;
    if (!created && o.timestamp) created = Date.parse(o.timestamp) || 0;
    if ((o.type === 'custom-title' && o.customTitle) || (o.type === 'summary' && o.summary)) title = o.customTitle || o.summary;
    if (!first && o.type === 'user' && !o.isMeta && !o.isSidechain) {
      const p = cleanPrompt(textOf(o.message?.content));
      if (p && !p.command) first = p.text;
    }
  }
  let lastPrompt = '';
  let lastReply = '';
  let model = '';
  let last = 0;
  for (const o of tail) {
    if (!cwd && o.cwd) cwd = o.cwd;
    if (o.timestamp) last = Math.max(last, Date.parse(o.timestamp) || 0);
    if (o.type === 'custom-title' && o.customTitle) title = o.customTitle;
    if (o.type === 'last-prompt' && o.lastPrompt) lastPrompt = o.lastPrompt;
    if (o.type === 'assistant' && !o.isSidechain && !o.isApiErrorMessage) {
      if (o.message?.model && o.message.model !== '<synthetic>') model = o.message.model;
      const t = textOf(o.message?.content).trim();
      if (t) lastReply = t;
    }
    if (o.type === 'user' && !o.isMeta && !o.isSidechain) {
      const p = cleanPrompt(textOf(o.message?.content));
      if (p && !p.command && !lastPrompt) lastPrompt = p.text;
    }
  }
  const one = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const meta = {
    id: info.id,
    cwd: cwd || info.key,
    title: one(title || first || lastPrompt, 80),
    lastPrompt: one(lastPrompt, 160),
    lastReply: one(preview(lastReply), 200),
    model,
    created,
    updatedAt: Math.max(last, info.mtime),
    sizeKb: Math.round(info.size / 1024),
  };
  if (!first && !lastPrompt && !lastReply) meta.empty = true;
  metaCache.set(key, meta);
  return meta;
}

export function listSessions(limit = 80) {
  return sessionFiles().sort((a, b) => b.mtime - a.mtime).slice(0, limit * 2)
    .map((f) => sessionMeta(f)).filter((m) => !m.empty).slice(0, limit);
}

// ---------------------------------------------------------------- history, read from the end in pages
// Reads backwards from `before` (a byte offset at a line start) until about `want` events are found. Every event
// remembers where its line starts, so a page is cut only before a prompt and the next page starts exactly there.
export function historyPage(file, { before = null, want = 140 } = {}) {
  const total = fs.statSync(file).size;
  let start = before === null ? total : Math.min(before, total);
  let items = [];
  let size = CHUNK;
  while (start > 0 && items.length < want) {
    const from = Math.max(0, start - size);
    const buf = readSlice(file, from, start - from);
    let skip = 0;
    if (from > 0) {
      const nl = buf.indexOf(0x0a);
      if (nl < 0 || nl + 1 >= buf.length) {
        size *= 2;                                   // one very long line (an image, a big tool result): look further back
        if (size > 512 * 1024 * 1024) break;
        continue;
      }
      skip = nl + 1;
    }
    const page = [];
    let i = skip;
    while (i < buf.length) {
      let j = buf.indexOf(0x0a, i);
      if (j < 0) j = buf.length;
      if (j > i) {
        try {
          const evs = [];
          lineEvents(JSON.parse(buf.subarray(i, j).toString('utf8')), evs);
          for (const ev of evs) page.push({ pos: from + i, ev });
        } catch { /* not a complete line */ }
      }
      i = j + 1;
    }
    items = page.concat(items);
    start = from + skip;
    size = CHUNK;
  }
  let cursor = start;
  if (items.length > want * 1.5) {
    let at = items.length - want;
    while (at > 0 && items[at].ev.k !== 'user') at--;
    cursor = items[at].pos;
    items = items.slice(at);
  }
  return { events: items.map((x) => x.ev), cursor, hasMore: cursor > 0 };
}
