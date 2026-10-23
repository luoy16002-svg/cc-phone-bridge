// Copies the vendor files the phone page needs, builds the icon sprite from Tabler, and renders the app icons.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NM = path.join(ROOT, 'node_modules');
const PUB = path.join(ROOT, 'public');
for (const d of ['vendor', 'fonts']) fs.mkdirSync(path.join(PUB, d), { recursive: true });

const copy = (from, to) => fs.copyFileSync(path.join(NM, from), path.join(PUB, to));
copy('marked/lib/marked.umd.js', 'vendor/marked.js');
copy('dompurify/dist/purify.min.js', 'vendor/purify.js');
copy('@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2', 'fonts/mono-400.woff2');
copy('@fontsource/jetbrains-mono/files/jetbrains-mono-latin-600-normal.woff2', 'fonts/mono-600.woff2');

// One icon family (Tabler outline), one stroke width.
const ICONS = ['arrow-left', 'plus', 'settings', 'send-2', 'player-stop-filled', 'photo', 'x', 'check', 'alert-triangle',
  'info-circle', 'terminal-2', 'file-text', 'pencil', 'file-plus', 'search', 'world', 'list-check', 'subtask', 'tool',
  'chevron-down', 'chevron-right', 'lamp-2', 'plug-connected-x', 'refresh', 'device-mobile', 'folder', 'history',
  'archive', 'dots', 'arrow-down', 'copy', 'link', 'brain', 'clock', 'arrow-back-up', 'bolt', 'cpu', 'trash', 'device-desktop', 'folder-plus',
  'folder-open', 'home', 'git-branch'];
const symbols = ICONS.map((name) => {
  const file = path.join(NM, '@tabler/icons/icons/outline', `${name}.svg`);
  const filled = path.join(NM, '@tabler/icons/icons/filled', `${name.replace(/-filled$/, '')}.svg`);
  const src = fs.existsSync(file) ? file : filled;
  if (!fs.existsSync(src)) throw new Error(`icon missing: ${name}`);
  const svg = fs.readFileSync(src, 'utf8');
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<path stroke="none" d="M0 0h24v24H0z" fill="none"\s*\/>/g, '').trim();
  const isFilled = src === filled;
  return `<symbol id="${name}" viewBox="0 0 24 24"${isFilled ? ' fill="currentColor" stroke="none"' : ' fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"'}>${inner}</symbol>`;
});
fs.writeFileSync(path.join(PUB, 'icons.svg'), `<svg xmlns="http://www.w3.org/2000/svg">${symbols.join('')}</svg>\n`);

// The text face: LXGW WenKai Screen, split by character ranges so a page loads only the pieces it shows.
const WK = path.join(NM, 'lxgw-wenkai-screen-web', 'lxgwwenkaiscreen');
const WKOUT = path.join(PUB, 'fonts', 'wenkai');
fs.rmSync(WKOUT, { recursive: true, force: true });
fs.mkdirSync(WKOUT, { recursive: true });
for (const f of fs.readdirSync(WK)) if (f.endsWith('.woff2')) fs.copyFileSync(path.join(WK, f), path.join(WKOUT, f));
// Each piece first asks for an installed copy (local()); WebKit marks some pieces failed on that and then never
// reports the fonts as loaded, so the pieces load from here only.
const css = fs.readFileSync(path.join(WK, 'result.css'), 'utf8').replace(/src:local\("[^"]*"\),/g, 'src:');
fs.writeFileSync(path.join(WKOUT, 'wenkai.css'), css);
// The app icons and the notebook art come from build/notebook_art.py.
console.log(`built: ${ICONS.length} icons, vendor scripts, fonts`);
