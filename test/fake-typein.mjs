// Stands in for lib/win/typein.exe in tests: writes what would have been typed into the window to <data>/typed.jsonl,
// one JSON object per run, so the test can play the window's part.
// With <data>/typein-echo.json ({ file, sessionId, cwd }) it also plays a quick window: what Enter sends is written
// into that transcript before this helper returns, as a real window often does, and the /effort slider moved with
// the arrows and closed with "s" writes the output Claude Code writes for it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const pid = Number(process.argv[2]);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', async () => {
  const steps = input.split('\n').filter(Boolean);
  const text = (kind) => steps.filter((s) => s.startsWith(`${kind} `)).map((s) => Buffer.from(s.slice(2), 'base64').toString('utf8'));
  const pasted = text('P');
  const keys = steps.filter((s) => s.startsWith('K ')).map((s) => s.slice(2));
  if (process.env.FAKE_TYPEIN_FAIL) process.exit(2);
  fs.appendFileSync(path.join(process.env.CCPB_DATA, 'typed.jsonl'), `${JSON.stringify({ pid, pasted, typed: text('T'), keys })}\n`);
  let echo = null;
  try {
    echo = JSON.parse(fs.readFileSync(path.join(process.env.CCPB_DATA, 'typein-echo.json'), 'utf8'));
  } catch { /* the test plays the window itself */ }
  const sent = pasted.join('').trim();
  if (echo && sent && keys.includes('enter')) {
    const line = (o) => `${JSON.stringify({ uuid: crypto.randomUUID(), cwd: echo.cwd, sessionId: echo.sessionId, timestamp: new Date().toISOString(), ...o })}\n`;
    const cmd = /^\/(\w+)\s*(.*)$/.exec(sent);
    if (cmd) {
      fs.appendFileSync(echo.file, line({ type: 'user', message: { role: 'user', content: `<command-name>/${cmd[1]}</command-name>\n            <command-message>${cmd[1]}</command-message>\n            <command-args>${cmd[2]}</command-args>` } }));
      // the slider: from the far left, one level per right arrow; "s" sets it for this session only
      const level = cmd[1] === 'effort' && !cmd[2] && text('T').includes('s') ? LEVELS[Math.min(LEVELS.length - 1, keys.filter((k) => k === 'right').length)] : cmd[2];
      if (cmd[1] === 'effort') fs.appendFileSync(echo.file, line({ type: 'user', message: { role: 'user', content: `<local-command-stdout>Set effort level to ${level} (this session only): a test level</local-command-stdout>` } }));
    } else {
      fs.appendFileSync(echo.file, line({ type: 'user', message: { role: 'user', content: sent } }));
    }
    await new Promise((r) => setTimeout(r, 400));      // the helper returns after the window wrote it down
  }
});
