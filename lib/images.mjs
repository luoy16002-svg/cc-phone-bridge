// Pictures the conversations hold, for the phone: an agent's own record keeps them inline or in its own store, so each
// is copied once into <data>/images under the hash of its bytes, and events only carry that name. The page fetches a
// picture when it scrolls into view, and the name never changes, so the phone's cache answers from then on.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';

const DIR = path.join(DATA_DIR, 'images');
const MAX_BYTES = 40 * 1024 * 1024;
const NAME = /^[0-9a-f]{32}\.(png|jpg|gif|webp)$/;
const known = new Set();

// By the first bytes, whatever the record calls it: only real pictures reach the phone.
function kindOf(b) {
  if (b.length < 12) return '';
  if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return '';
}

// Returns the reference the phone asks for, "img/<hash>.<type>", or null when these are not a picture's bytes.
export function keepBytes(buf) {
  const kind = kindOf(buf);
  if (!kind || buf.length > MAX_BYTES) return null;
  const name = `${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32)}.${kind}`;
  if (!known.has(name)) {
    const file = path.join(DIR, name);
    try {
      if (fs.existsSync(file)) fs.utimesSync(file, new Date(), new Date());
      else {
        fs.mkdirSync(DIR, { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, file);
      }
    } catch {
      return null;
    }
    known.add(name);
  }
  return `img/${name}`;
}

export const keepBase64 = (data) => (typeof data === 'string' && data ? keepBytes(Buffer.from(data, 'base64')) : null);

export function keepDataUrl(url) {
  const m = /^data:image\/[\w.+-]+;base64,(.+)$/s.exec(String(url || ''));
  return m ? keepBase64(m[1]) : null;
}

// A picture an agent looked at on disk. Files are read only for a name that says picture, unless the caller knows.
export function keepFile(file, isPicture = false) {
  if (!isPicture && !/\.(png|jpe?g|gif|webp)$/i.test(String(file || ''))) return null;
  try {
    const st = fs.statSync(file);
    return st.isFile() && st.size <= MAX_BYTES ? keepBytes(fs.readFileSync(file)) : null;
  } catch {
    return null;
  }
}

export const imageFile = (name) => (NAME.test(name) ? path.join(DIR, name) : null);

// The oldest copies go first; a conversation opened again copies its pictures back.
export function cleanImages(maxMB, log) {
  let files = [];
  try {
    files = fs.readdirSync(DIR).filter((f) => NAME.test(f)).map((f) => {
      const full = path.join(DIR, f);
      const st = fs.statSync(full);
      return { f, full, size: st.size, mtime: st.mtimeMs };
    });
  } catch {
    return;
  }
  let total = files.reduce((s, x) => s + x.size, 0);
  const cap = maxMB * 1024 * 1024;
  if (total <= cap) return;
  let removed = 0;
  for (const x of files.sort((a, b) => a.mtime - b.mtime)) {
    if (total <= cap * 0.8) break;
    try {
      fs.rmSync(x.full, { force: true });
      known.delete(x.f);
      total -= x.size;
      removed++;
    } catch { /* in use: next time */ }
  }
  if (removed) log?.(`removed ${removed} old picture(s)`);
}
