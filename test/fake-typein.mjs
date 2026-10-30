// Stands in for lib/win/typein.exe in tests: writes what would have been typed into the window to <data>/typed.jsonl,
// one JSON object per run, so the test can play the window's part.
import fs from 'node:fs';
import path from 'node:path';

const pid = Number(process.argv[2]);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const steps = input.split('\n').filter(Boolean);
  const pasted = steps.filter((s) => s.startsWith('P ')).map((s) => Buffer.from(s.slice(2), 'base64').toString('utf8'));
  if (process.env.FAKE_TYPEIN_FAIL) process.exit(2);
  fs.appendFileSync(path.join(process.env.CCPB_DATA, 'typed.jsonl'), `${JSON.stringify({ pid, pasted, keys: steps.filter((s) => s.startsWith('K ')).map((s) => s.slice(2)) })}\n`);
});
