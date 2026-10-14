import path from 'node:path';
import { CONFIG } from './config.mjs';

// One line about a tool call, plus the longer text the phone can open.
const cut = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

// A path inside the conversation's folder is shown relative to it; one inside a configured root, relative to the root.
export function shortPath(p, cwd = '') {
  if (!p) return '';
  const s = String(p);
  const low = s.toLowerCase();
  for (const dir of [cwd, ...[...CONFIG.roots].sort((a, b) => b.length - a.length)]) {
    if (!dir) continue;
    const d = String(dir).replace(/[\\/]+$/, '');
    if (low.startsWith(`${d.toLowerCase()}${path.sep}`) || low.startsWith(`${d.toLowerCase()}/`)) return s.slice(d.length + 1).replace(/\\/g, '/');
  }
  return s.replace(/\\/g, '/');
}

export function describeTool(name, input = {}, cwd = '') {
  const i = input || {};
  let summary;
  let detail = '';
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      summary = i.description || i.command;
      detail = i.command || '';
      break;
    case 'Read':
    case 'Write':
    case 'NotebookEdit':
      summary = shortPath(i.file_path || i.notebook_path, cwd);
      break;
    case 'Edit':
      summary = shortPath(i.file_path, cwd);
      detail = i.old_string ? `- ${cut(i.old_string, 500)}\n+ ${cut(i.new_string, 500)}` : '';
      break;
    case 'Grep':
      summary = `${i.pattern}${i.path ? `  · ${shortPath(i.path, cwd) || '.'}` : ''}`;
      break;
    case 'Glob':
      summary = i.pattern;
      break;
    case 'WebFetch':
      summary = i.url;
      detail = i.prompt || '';
      break;
    case 'WebSearch':
      summary = i.query;
      break;
    case 'Agent':
    case 'Task':
      summary = i.description || i.prompt;
      detail = i.prompt || '';
      break;
    case 'TodoWrite':
      summary = `${(i.todos || []).filter((x) => x.status === 'completed').length}/${(i.todos || []).length}`;
      detail = (i.todos || []).map((t) => `${t.status === 'completed' ? '[x]' : '[ ]'} ${t.content}`).join('\n');
      break;
    case 'Skill':
      summary = i.skill || i.command;
      break;
    default: {
      const k = ['description', 'command', 'file_path', 'path', 'url', 'query', 'pattern', 'prompt', 'action'].find((x) => typeof i[x] === 'string' && i[x]);
      summary = k ? i[k] : JSON.stringify(i);
      detail = JSON.stringify(i, null, 1);
    }
  }
  return { summary: cut(String(summary || '').replace(/\s+/g, ' ').trim(), 160), detail: cut(detail, 1500) };
}

