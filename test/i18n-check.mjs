// Every Chinese string the screens show has an English entry, and no Chinese is left outside t(...).
// Usage: node test/i18n-check.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const CJK = /[一-鿿]/;

const sandbox = { window: {}, document: { documentElement: {} }, navigator: { language: 'en' }, localStorage: { getItem: () => '"en"' } };
vm.runInNewContext(read('public/i18n.js'), sandbox);
const { t } = sandbox.window.I18N;

const lit = /'((?:[^'\\\n]|\\.)*)'/g;
const unescape = (s) => s.replace(/\\(.)/g, '$1');
const keys = new Set(['上下文自动压缩了一次', '上下文压缩过，之前的内容由摘要接续', '已打断', '打断没有及时生效，已强制停止']);
let loose = 0;
for (const f of ['public/app.js', 'public/pc.js']) {
  const src = read(f).replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  for (const m of src.matchAll(/\bt\('((?:[^'\\\n]|\\.)*)'/g)) keys.add(unescape(m[1]));
  const rest = src.replace(/\bt\('((?:[^'\\\n]|\\.)*)'/g, "t(''");
  rest.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(lit)) {
      if (CJK.test(m[1]) && m[1] !== '中文') {
        loose++;
        console.log(`not translated: ${f}:${i + 1}: ${m[1]}`);
      }
    }
    if (/`[^`]*[一-鿿]/.test(line)) {
      loose++;
      console.log(`Chinese in a template: ${f}:${i + 1}`);
    }
  });
}
for (const f of ['lib/claude.mjs', 'lib/codex.mjs']) {
  for (const m of read(f).matchAll(/note\('(?:warn|error|info)', '((?:[^'\\\n]|\\.)*)'/g)) keys.add(unescape(m[1]));
}
const html = read('public/pc.html');
for (const m of html.matchAll(/data-t>([^<]+)</g)) keys.add(m[1].trim());
for (const m of html.matchAll(/alt="([^"]+)" data-t-alt/g)) keys.add(m[1]);

let missing = 0;
for (const k of keys) {
  if (CJK.test(k) && t(k) === k) {
    missing++;
    console.log(`no English for: ${k}`);
  }
}
console.log(`${keys.size} strings, ${missing} without English, ${loose} outside t()`);
process.exit(missing || loose ? 1 : 0);
