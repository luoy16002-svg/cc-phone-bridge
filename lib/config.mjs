// Configuration: built-in defaults, then <data dir>/config.json (or the file named by CCPB_CONFIG), then a few env vars.
// Paths may use ~ and %VARS%. Nothing machine-specific lives in the code.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const expand = (p) => String(p || '')
  .replace(/^~(?=$|[\\/])/, os.homedir())
  .replace(/%([A-Za-z0-9_]+)%/g, (_, k) => process.env[k] ?? '')
  .replace(/\$\{([A-Za-z0-9_]+)\}/g, (_, k) => process.env[k] ?? '');

export const DATA_DIR = expand(process.env.CCPB_DATA
  || path.join(process.env.LOCALAPPDATA || process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'cc-phone-bridge'));

const DEFAULTS = {
  port: 8060,
  host: '0.0.0.0',
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  // words the computer writes itself (notifications): "zh", "en", or "auto" for this computer's language
  lang: 'auto',
  // a folder in public/themes, or "auto": autoThemes.light or .dark, following each device's light or dark mode
  theme: 'auto',
  autoThemes: { light: 'sky', dark: 'night' },
  // folders the phone may browse and create in; the first one is where browsing starts
  roots: [os.homedir()],
  claude: {
    command: 'claude',
    releaseFile: '',          // optional: a JSON file whose "binary" names the executable (a pinned install)
    args: [],
    configDir: '',            // Claude Code's config folder; default CLAUDE_CONFIG_DIR or ~/.claude
    env: {},                  // extra environment for Claude Code
    clearEnv: ['ANTHROPIC_*', 'CLAUDE_CODE_OAUTH_*', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT'],
    resumeCommand: 'claude --resume {id}',   // shown on the phone, to pick a conversation up in a terminal
    // empty: the mode set in Claude Code's own settings, as in a terminal. The phone cannot answer permission
    // prompts, so a tool that would ask is refused unless the mode or the allowed tools let it run.
    permissionMode: '',
  },
  models: [
    { id: 'claude-opus-5-5', name: 'Opus 5.5' },
    { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' },
    { id: 'claude-haiku-5-5', name: 'Haiku 5.5' },
    { id: 'claude-fable-5-1', name: 'Fable 5.1' },
  ],
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  limits: { idleMinutes: 20, maxLive: 3, uploadDays: 7, uploadMB: 200, logKB: 1024, tailMs: 1500 },
  push: { ntfyServer: 'https://ntfy.sh', ntfyTopic: '', ntfyTopicFile: '', ntfyTopicKey: 'NTFY_TOPIC', includeTitle: false },
  tls: { cert: '', key: '' },
  // a JSON file other tools write ({ items: [{ id, title, detail, link, cwd, prompt, expires }] }); each item shows
  // on the desk and starts a conversation in its folder when tapped. Empty: no suggestions.
  suggestions: { file: '' },
  extraHosts: [],
};

function merge(a, b) {
  if (Array.isArray(a) || typeof a !== 'object' || a === null) return b === undefined ? a : b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) out[k] = k in a ? merge(a[k], v) : v;
  return out;
}

export const CONFIG_FILE = expand(process.env.CCPB_CONFIG || path.join(DATA_DIR, 'config.json'));

function load() {
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`config: ${CONFIG_FILE}: ${e.message}`);
  }
  const c = merge(DEFAULTS, user);
  if (process.env.CCPB_PORT) c.port = Number(process.env.CCPB_PORT);
  if (process.env.CCPB_CONFIG_DIR) c.claude.configDir = process.env.CCPB_CONFIG_DIR;
  if (process.env.CCPB_ROOTS) c.roots = process.env.CCPB_ROOTS.split(path.delimiter);
  c.roots = c.roots.map((r) => path.resolve(expand(r))).filter((r) => fs.existsSync(r));
  if (!c.roots.length) c.roots = [os.homedir()];
  c.claude.configDir = path.resolve(expand(c.claude.configDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')));
  c.claude.releaseFile = expand(c.claude.releaseFile);
  c.claude.command = expand(c.claude.command);
  for (const [k, v] of Object.entries(c.claude.env)) c.claude.env[k] = expand(v);
  c.push.ntfyTopicFile = expand(c.push.ntfyTopicFile);
  if (c.lang === 'auto') c.lang = /^zh/i.test(Intl.DateTimeFormat().resolvedOptions().locale) ? 'zh' : 'en';
  c.lang = /^zh/i.test(c.lang) ? 'zh' : 'en';
  c.tls.cert = expand(c.tls.cert);
  c.tls.key = expand(c.tls.key);
  return c;
}

export const CONFIG = load();
