// Screenshots of every screen at phone and desktop size, in each theme, on conversations seeded as Claude Code
// transcripts. Usage: node test/shots.mjs [outdir] [--lang zh|en]
// Needs Playwright with WebKit (npm i -D playwright && npx playwright install webkit), or PLAYWRIGHT_PATH set to a copy.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

const require = createRequire(import.meta.url);
const { webkit } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const LANG = args.includes('--lang') ? args[args.indexOf('--lang') + 1] : 'zh';
const outArg = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--lang');
const OUT = path.resolve(outArg || path.join(ROOT, 'build', 'out', `shots-${LANG}`));
const PORT = 18062;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpb-shots-'));
const CONF = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpb-shots-conf-'));
const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpb-shots-proj-'));
const ROOTDIR = path.join(PROJ, 'Projects');
for (const d of ['notes-app', 'english', 'blog', 'cafe-site', 'photo-tools', 'scripts']) fs.mkdirSync(path.join(ROOTDIR, d), { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ roots: [ROOTDIR], timeZone: 'America/Los_Angeles', lang: LANG }));
fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ pushOnFinish: true }));
fs.writeFileSync(path.join(CONF, 'settings.json'), JSON.stringify({ model: 'opus', modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' } } }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = Date.now();

// ---------------------------------------------------------------- what the sample conversations say
const W = {
  zh: {
    build: '看一下现在能不能构建', buildDesc: '构建网页版', built: '能构建，2.1 秒完成，没有警告。',
    close: '把 reminders.json 里已经过期的提醒关掉，告诉我关了哪些',
    list: '列出时间早于今天、还没关的提醒', check: '检查 JSON 还能正常读',
    closed: '关掉了 3 个已经过期的提醒，其余 19 个照常。\n\n| 提醒 | 原定时间 | 处理 |\n|---|---|---|\n| 续订域名 | 10月11日 21:00 | 关闭，已经续好 |\n| 交房租 | 10月13日 20:59 | 关闭，已经交了 |\n| 牙医复诊 | 10月11日 23:59 | 关闭，改约到 10月19日 |\n\n文件是 `data/reminders.json`，格式检查通过。',
    error: '这个报错是什么意思？', errorReply: '截图里是 **npm install** 在解析依赖时失败：`left-pad` 锁定的版本太旧。\n\n要我直接把版本改到 `1.3.0` 再装一次吗？',
    cards: '把第三课的单词表整理成卡片', cardsReply: '整理好了，42 张卡片，存在 `cards/lesson3.json`。',
    photos: '首页的菜单图片换成新拍的那组', photosReply: '换好了，6 张图都压到了 200 KB 以下。',
    more: '把第四课的例句也做成卡片，顺便检查一遍拼写', moreReply: '先读了第四课，找到 12 个例句，正在逐条做卡片。',
    slow: '跑一遍 slow 的全量测试，跑完告诉我结果', also: '另外看一下日志里有没有警告',
    other: '别的文件夹', newBtn: '新建', moreLabel: '更多', folder: 'english-cards',
  },
  en: {
    build: 'Can you check whether it builds now?', buildDesc: 'Build the web app', built: 'It builds: 2.1 s, no warnings.',
    close: 'Close the reminders in reminders.json that are past due, and tell me which ones',
    list: 'List open reminders dated before today', check: 'Check the JSON still parses',
    closed: 'Closed 3 past-due reminders; the other 19 are unchanged.\n\n| Reminder | Was due | Done |\n|---|---|---|\n| Renew the domain | Oct 11, 21:00 | Closed, renewed |\n| Pay the rent | Oct 13, 20:59 | Closed, paid |\n| Dentist check-up | Oct 11, 23:59 | Closed, moved to Oct 19 |\n\nThe file is `data/reminders.json` and it still parses.',
    error: 'What does this error mean?', errorReply: 'The screenshot shows **npm install** failing while it resolves dependencies: the locked `left-pad` version is too old.\n\nShall I bump it to `1.3.0` and install again?',
    cards: 'Turn the lesson 3 word list into flash cards', cardsReply: 'Done: 42 cards in `cards/lesson3.json`.',
    photos: 'Swap the menu photos on the home page for the new set', photosReply: 'Swapped. All 6 photos are now under 200 KB.',
    more: 'Make cards from the lesson 4 example sentences too, and check the spelling', moreReply: 'Read lesson 4 and found 12 example sentences; making the cards one by one.',
    slow: 'Run the full slow test suite and tell me the result', also: 'Also check the log for warnings',
    other: 'Another folder', newBtn: 'New', moreLabel: 'More', folder: 'flash-cards',
  },
}[LANG];

function transcript(cwd, minutesAgo, turns) {
  const id = crypto.randomUUID();
  const dir = path.join(CONF, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const lines = [];
  let t = now - minutesAgo * 60000 - turns.length * 120000;
  const add = (o) => {
    t += 9000;
    lines.push({ uuid: crypto.randomUUID(), cwd, sessionId: id, isSidechain: false, timestamp: new Date(t).toISOString(), ...o });
  };
  for (const turn of turns) {
    add({ type: 'user', message: { role: 'user', content: turn.images ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }, { type: 'text', text: turn.user }] : turn.user } });
    for (const tool of turn.tools || []) {
      const tid = `toolu_${crypto.randomBytes(5).toString('hex')}`;
      add({ type: 'assistant', message: { role: 'assistant', model: turn.model || 'claude-opus-5-5', content: [{ type: 'tool_use', id: tid, name: tool[0], input: tool[1] }] } });
      add({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, is_error: !!tool[3], content: tool[2] || 'ok' }] } });
    }
    add({ type: 'assistant', message: { role: 'assistant', model: turn.model || 'claude-opus-5-5', content: [{ type: 'text', text: turn.reply }] } });
  }
  lines.push({ type: 'last-prompt', lastPrompt: turns[turns.length - 1].user, sessionId: id });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  const at = new Date(now - minutesAgo * 60000);
  fs.utimesSync(file, at, at);
  return id;
}

const X = path.join(ROOTDIR, 'notes-app');
const TODO = path.join(X, 'data', 'reminders.json');
const A = transcript(X, 3, [
  { user: W.build, tools: [['Bash', { command: 'npm run build', description: W.buildDesc }, 'built in 2.1s']], reply: W.built },
  { user: W.close, tools: [
    ['Read', { file_path: TODO }, '{ "items": [ ... ] }'],
    ['Bash', { command: 'node scripts/due.js --before today', description: W.list }, 'renew-domain 2026-10-11\npay-rent 2026-10-13'],
    ['Edit', { file_path: TODO, old_string: '"done": false', new_string: '"done": true' }, 'The file has been updated.'],
    ['Bash', { command: 'node -e "JSON.parse(require(\'fs\').readFileSync(\'data/reminders.json\'))"', description: W.check }, 'ok'],
    ['Grep', { pattern: 'dentist', path: path.join(X, 'data') }, '3 matches']],
    reply: W.closed },
]);
transcript(X, 52, [{ user: W.error, images: true, reply: W.errorReply }]);
transcript(path.join(ROOTDIR, 'english'), 190, [{ user: W.cards, model: 'claude-sonnet-5-5', reply: W.cardsReply }]);
transcript(path.join(ROOTDIR, 'cafe-site'), 60 * 26, [{ user: W.photos, model: 'claude-sonnet-5-5', reply: W.photosReply }]);
const B = transcript(path.join(ROOTDIR, 'english'), 1, [{ user: W.more, tools: [
  ['Read', { file_path: path.join(ROOTDIR, 'english', 'lesson4.md') }, '# Lesson 4 ...'],
  ['Grep', { pattern: 'example', path: path.join(ROOTDIR, 'english') }, '12 matches']], reply: W.moreReply }]);
fs.mkdirSync(path.join(CONF, 'sessions'), { recursive: true });
fs.writeFileSync(path.join(CONF, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: A, cwd: X, kind: 'interactive', status: 'idle' }));
fs.writeFileSync(path.join(CONF, 'sessions', `${process.ppid}.json`), JSON.stringify({ pid: process.ppid, sessionId: B, cwd: path.join(ROOTDIR, 'english'), kind: 'interactive', status: 'busy' }));
for (const d of ['api', 'web', 'docs']) fs.mkdirSync(path.join(X, d));

const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  cwd: ROOT,
  env: { ...process.env, FAKE_LANG: LANG, CCPB_PORT: String(PORT), CCPB_DATA: DATA, CCPB_CONFIG_DIR: CONF, CCPB_SHOW_TEMP: '1', CCPB_CLAUDE_CMD: JSON.stringify([process.execPath, path.join(ROOT, 'test', 'fake-claude.mjs')]) },
  stdio: 'inherit',
});
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${BASE}/api/ping`)).ok) break;
  } catch { /* starting */ }
  await sleep(100);
}
const pc = await (await fetch(`${BASE}/pc/state`)).json();
const { token } = await (await fetch(`${BASE}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: pc.code, name: 'iPhone' }) })).json();
const api = (m, p, b) => fetch(BASE + p, { method: m, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json());
const live = await api('POST', '/api/sessions', { cwd: path.join(ROOTDIR, 'blog'), model: 'claude-opus-5-5', effort: 'high', text: W.slow });
await api('POST', `/api/sessions/${live.id}/messages`, { text: W.also });
await sleep(800);

// The pictures go into the README, so this computer's name and addresses are swapped for examples, QR code included.
const SAMPLE_URL = 'http://192.168.1.20:8060';
const qrFor = (color) => QRCode.toString(`${SAMPLE_URL}/#pair=482915`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color });
const sampleQr = { light: await qrFor({ dark: '#1d3550', light: '#00000000' }), dark: await qrFor({ dark: '#18222f', light: '#e3ecf6' }) };
async function hidePrivate(page) {
  await page.evaluate(([host, port]) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      n.nodeValue = n.nodeValue
        .split(host).join('my-pc')
        .replace(/\b(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g, '192.168.1.20')
        .replace(/\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/g, '100.64.0.20')
        .split(`:${port}`).join(':8060');
    }
  }, [os.hostname(), String(PORT)]);
}

const browser = await webkit.launch();
const locale = LANG === 'zh' ? 'zh-CN' : 'en-US';
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1', locale };
const desk = (o = {}) => ({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 1, locale, ...o });
async function shot(name, url, { ctx = phone, tk = token, wait = 900, act, theme = null } = {}) {
  const context = await browser.newContext(ctx);
  if (tk) await context.addInitScript((t) => localStorage.setItem('ccpb.token', JSON.stringify(t)), tk);
  if (theme) await context.addInitScript((t) => localStorage.setItem('ccpb.theme', JSON.stringify(t)), theme);
  await context.addInitScript((l) => localStorage.setItem('ccpb.lang', JSON.stringify(l)), LANG);
  const page = await context.newPage();
  await page.route('**/pc/qr.svg*', (route) => route.fulfill({ contentType: 'image/svg+xml', body: sampleQr[/on=dark/.test(route.request().url()) ? 'dark' : 'light'] }));
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE + url);
  await sleep(wait);
  if (act) await act(page);
  await hidePrivate(page);
  const seen = [...errors];
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(`${name}${seen.length ? `  ERRORS: ${seen.join(' | ')}` : ''}`);
  await context.close();
}
const openTools = async (p) => { await p.click('.tools >> nth=1 >> .hd'); await sleep(250); };
await shot('01-pair', '/', { tk: null });
await shot('03-list', '/#/');
await shot('04-conversation', `/#/s/${A}`);
await shot('05-tools-open', `/#/s/${A}`, { act: async (p) => { await openTools(p); await p.click('.tools >> nth=1 >> .ln >> nth=1'); await sleep(250); } });
await shot('06-running', `/#/s/${live.id}`, { wait: 1500 });
await shot('09-new', '/#/new', { wait: 1200 });
await shot('10-settings', '/#/settings');
await shot('13-prefs', `/#/s/${A}`, { act: async (p) => { await p.click('.subbtn'); await sleep(400); } });
await shot('15-menu', `/#/s/${A}`, { act: async (p) => { await p.click(`button[aria-label="${W.moreLabel}"]`); await sleep(300); } });
await shot('11-desktop-list', '/#/', { ctx: desk({ viewport: { width: 1280, height: 820 } }) });
await shot('12-pc-page', '/pc', { ctx: desk(), tk: null });
await shot('14-small-phone', `/#/s/${A}`, { ctx: { ...phone, viewport: { width: 375, height: 667 } } });
await shot('16-pc-busy', `/#/s/${B}`, { wait: 1500 });
await shot('17-picker', '/#/new', { wait: 1000, act: async (p) => { await p.click(`text=${W.other}`); await sleep(500); await p.click('.dir >> text=notes-app'); await sleep(500); } });
await shot('18-picker-new', '/#/new', { wait: 1000, act: async (p) => { await p.click(`text=${W.other}`); await sleep(500); await p.click(`.pickbar >> text=${W.newBtn}`); await sleep(300); await p.keyboard.type(W.folder); await sleep(200); } });
await shot('19-night-list', '/#/', { theme: 'night' });
await shot('20-night-conversation', `/#/s/${A}`, { theme: 'night', act: openTools });
await shot('21-night-new', '/#/new', { theme: 'night', wait: 1200 });
await shot('22-night-settings', '/#/settings', { theme: 'night' });
await shot('23-night-pc-page', '/pc', { ctx: desk({ colorScheme: 'dark' }), tk: null });
await browser.close();
server.kill();
await sleep(500);
for (const d of [DATA, CONF, PROJ]) fs.rmSync(d, { recursive: true, force: true });
console.log('shots in', OUT);
