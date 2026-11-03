// The phone page in a real browser engine (WebKit, as on an iPhone) against a real server on made-up conversations:
// a message typed into a window whose "taken in" notice the phone missed while its connection was down, a step
// dated yesterday arriving after today's, many redraws, and an effort set in the window on the computer.
// Between the page and the server sits a small proxy that can cut the live connection, as a phone asleep does.
// Usage: node test/page.mjs [shot.png]   (needs Playwright with WebKit, or PLAYWRIGHT_PATH set to a copy)
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { webkit } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 18065;
const PROXY = 18066;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpb-page-'));
const CONF = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpb-page-conf-'));
const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpb-page-proj-'));
const CWD = path.join(PROJ, 'notes-app');
fs.mkdirSync(CWD);
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ roots: [PROJ], timeZone: 'America/Los_Angeles', lang: 'zh', codex: { enabled: false }, dsh: { enabled: false } }));
fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ pushOnFinish: false }));
fs.writeFileSync(path.join(CONF, 'settings.json'), JSON.stringify({ model: 'opus', modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' } } }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
let count = 0;
const check = (name, ok, extra = '') => {
  count++;
  if (!ok) fails++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` ${extra}`}`);
};

// ---------------------------------------------------------------- a conversation from yesterday into today (Los Angeles)
const LA = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
const day = (ts) => LA.format(ts);
const now = Date.now();
const today = day(now);
const midnight = [7, 8].map((h) => Date.parse(`${today}T00:00:00Z`) + h * 3600000).find((ts) => day(ts) === today && day(ts - 1) !== today);
const yest = midnight - 3 * 3600000;
const todayAt = (f) => midnight + Math.floor((now - midnight) * f);
const id = crypto.randomUUID();
const file = path.join(CONF, 'projects', CWD.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
fs.mkdirSync(path.dirname(file), { recursive: true });
let parent = null;
const entry = (o, ts) => {
  const uuid = crypto.randomUUID();
  const line = `${JSON.stringify({ parentUuid: parent, uuid, cwd: CWD, sessionId: id, timestamp: new Date(ts).toISOString(), ...o })}\n`;
  parent = uuid;
  return line;
};
const user = (text, ts) => entry({ type: 'user', message: { role: 'user', content: text } }, ts);
const reply = (text, ts) => entry({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }] } }, ts);
const tool = (n, ts) => entry({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: `tool-${n}`, name: 'Bash', input: { command: `echo step ${n}`, description: `Step ${n}` } }] } }, ts);
const toolResult = (n, ts) => entry({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tool-${n}`, content: `step ${n}` }] } }, ts);
fs.writeFileSync(file, [
  user('把提醒列表整理一下', yest), tool(1, yest + 1000), toolResult(1, yest + 2000), reply('整理好了，22 条。', yest + 3000),
  user('再检查一遍日期', todayAt(0.2)), tool(2, todayAt(0.2) + 1000), toolResult(2, todayAt(0.2) + 2000), reply('日期都对。', todayAt(0.2) + 3000),
].join(''));

// a window on the computer holding the conversation (a stand-in process; typing goes to the fake helper)
const win = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
const reg = path.join(CONF, 'sessions', `${win.pid}.json`);
fs.mkdirSync(path.dirname(reg), { recursive: true });
const regWin = (status) => fs.writeFileSync(reg, JSON.stringify({ pid: win.pid, sessionId: id, cwd: CWD, kind: 'interactive', entrypoint: 'cli', status, startedAt: now - 3600000, updatedAt: Date.now() }));
regWin('idle');

// ---------------------------------------------------------------- the server, and a proxy that can cut live connections
const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  cwd: ROOT,
  env: { ...process.env, CCPB_PORT: String(PORT), CCPB_DATA: DATA, CCPB_CONFIG_DIR: CONF, CCPB_SHOW_TEMP: '1', CCPB_CLAUDE_CMD: JSON.stringify([process.execPath, path.join(ROOT, 'test', 'fake-claude.mjs')]), CCPB_TYPEIN_CMD: JSON.stringify([process.execPath, path.join(ROOT, 'test', 'fake-typein.mjs')]), CCPB_DELIVER_MS: '30000' },
  stdio: ['ignore', 'inherit', 'inherit'],
});
let asleep = false;
let fakeVersion = '';                                  // set: the server seems to have been updated
const streams = new Set();
const proxy = http.createServer((req, res) => {
  const live = /\/stream$/.test(req.url.split('?')[0]);
  if (live && asleep) {
    res.writeHead(503);
    res.end();
    return;
  }
  const up = http.request({ host: '127.0.0.1', port: PORT, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${PORT}` } }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    if (live && fakeVersion) r.on('data', (c) => res.write(String(c).replace(/("version":")[^"]+"/, `$1${fakeVersion}"`))).on('end', () => res.end());
    else r.pipe(res);
    if (live) {
      const s = { req, res, up: r };
      streams.add(s);
      res.on('close', () => streams.delete(s));
    }
  });
  up.on('error', () => res.destroy());
  req.pipe(up);
});
const sleepPhone = () => {
  asleep = true;
  for (const s of streams) {
    s.up.destroy();
    s.res.destroy();
  }
  streams.clear();
};

let browser = null;
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/ping`)).ok) break;
    } catch { /* starting */ }
    await sleep(100);
  }
  await new Promise((r) => proxy.listen(PROXY, '127.0.0.1', r));
  const { code } = await (await fetch(`http://127.0.0.1:${PORT}/pc/state`)).json();
  const { token } = await (await fetch(`http://127.0.0.1:${PORT}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name: 'page test' }) })).json();

  browser = await webkit.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  await ctx.addInitScript((tk) => localStorage.setItem('ccpb.token', JSON.stringify(tk)), token);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { fails++; console.log('  FAIL page error', e.message); });
  await page.goto(`http://127.0.0.1:${PROXY}/#/s/${id}`);
  await page.waitForSelector('.timeline .a');
  await sleep(600);
  const seps = () => page.$$eval('.timeline .daysep', (els) => els.map((e) => e.textContent));
  check('days marked once each, in order', JSON.stringify(await seps()) === JSON.stringify(['昨天', '今天']), JSON.stringify(await seps()));

  console.log('a message typed into the window, its notice missed while the phone slept');
  await page.fill('.composer textarea, textarea', '整理完发我一份清单');
  await page.click('button.send');
  await page.waitForFunction(() => [...document.querySelectorAll('.timeline .u .q')].some((e) => e.textContent.includes('正送到')), null, { timeout: 5000 });
  check('on its way to the window', true);
  sleepPhone();
  await sleep(300);
  fs.appendFileSync(file, user('整理完发我一份清单', Date.now()));    // the window took it in: the phone hears nothing
  await sleep(1200);
  asleep = false;                                                  // the phone wakes: the stream comes back, catches up
  await page.waitForFunction(() => ![...document.querySelectorAll('.timeline .u .q')].length, null, { timeout: 15000 }).catch(() => null);
  const bubbles = await page.$$eval('.timeline .u', (els) => els.map((e) => ({ text: e.querySelector('.tx')?.textContent || '', state: e.querySelector('.q')?.textContent || '' })));
  check('after the catch-up nothing is left "on its way"', !bubbles.some((b) => b.state), JSON.stringify(bubbles));
  check('the message shows once, as the window has it', bubbles.filter((b) => b.text === '整理完发我一份清单').length === 1, JSON.stringify(bubbles));

  console.log('a step dated yesterday arriving after today, then many redraws');
  fs.appendFileSync(file, tool(3, yest + 5000) + toolResult(3, yest + 6000));
  for (let i = 4; i < 16; i++) {
    fs.appendFileSync(file, tool(i, Date.now()) + toolResult(i, Date.now()));
    await sleep(120);
  }
  fs.appendFileSync(file, reply('清单在 notes/list.md。', Date.now()));
  await page.waitForFunction(() => [...document.querySelectorAll('.timeline .a')].some((e) => e.textContent.includes('notes/list.md')), null, { timeout: 8000 });
  await sleep(500);
  check('still one mark per day, none at the bottom', JSON.stringify(await seps()) === JSON.stringify(['昨天', '今天']), JSON.stringify(await seps()));
  const order = await page.$$eval('.timeline > *', (els) => els.map((e) => (e.classList.contains('daysep') ? `[${e.textContent}]` : e.className.split(' ')[0])).join(' '));
  const yesterdayPart = order.slice(order.indexOf('[昨天]'), order.indexOf('[今天]'));
  check('the step dated yesterday sits under yesterday, by its time', (yesterdayPart.match(/\btools\b/g) || []).length === 2, order);
  const keys = await page.$$eval('.timeline [data-key]', (els) => els.map((e) => e.dataset.key));
  check('no block drawn twice', keys.length === new Set(keys).size, `${keys.length} elements, ${new Set(keys).size} keys`);

  console.log('the effort the window runs with');
  check('the header says what the settings give at first', /xhigh/.test(await page.textContent('header .sub')), await page.textContent('header .sub'));
  fs.appendFileSync(file, entry({ type: 'user', message: { role: 'user', content: '<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args></command-args>' } }, Date.now())
    + entry({ type: 'user', message: { role: 'user', content: '<local-command-stdout>Set effort level to max (this session only): Maximum capability</local-command-stdout>' } }, Date.now()));
  await page.waitForFunction(() => /max/.test(document.querySelector('header .sub')?.textContent || ''), null, { timeout: 5000 }).catch(() => null);
  check('/effort max in the window shows in the header at once', /max/.test(await page.textContent('header .sub')), await page.textContent('header .sub'));
  const shot = process.argv[2];
  if (shot) await page.screenshot({ path: shot });

  console.log('the settings sheet of a conversation open in a window');
  await page.click('header .sub');
  await page.waitForSelector('.prefs');
  const sheet = await page.textContent('.prefs');
  check('the model is the window\'s own, with how to change it', /Opus 5\.5/.test(sheet) && /\/model/.test(sheet) && !(await page.$('.prefs .seg.grid2')), sheet);
  check('the effort can be chosen, the window\'s current one marked', (await page.textContent('.prefs .seg.mono .on')) === 'max');
  if (shot) await page.screenshot({ path: shot.replace(/(\.png)?$/, '-prefs.png') });
  await page.click('.shade', { position: { x: 12, y: 740 } });

  console.log('the computer is updated while the page is open');
  let loads = 0;
  page.on('load', () => { loads++; });
  await page.fill('textarea', '一半的草稿');
  await sleep(300);
  fakeVersion = '99.0.0';
  sleepPhone();
  await sleep(500);
  asleep = false;
  await page.waitForEvent('load', { timeout: 15000 }).catch(() => null);
  await page.waitForSelector('textarea', { timeout: 10000 }).catch(() => null);
  await sleep(4000);                                              // its new connections hear the same version again
  check('the page loads again once, by itself', loads === 1, `${loads} loads`);
  check('the draft is still in the box', (await page.inputValue('textarea').catch(() => '')) === '一半的草稿');
} catch (e) {
  fails++;
  console.log('ERROR', e.stack || e);
} finally {
  await browser?.close();
  server.kill();
  proxy.close();
  win.kill();
  await sleep(500);
  for (const d of [DATA, CONF, PROJ]) fs.rmSync(d, { recursive: true, force: true });
  console.log(`${count - fails}/${count} page checks passed`);
  process.exit(fails ? 1 : 0);
}
