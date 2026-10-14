// A short "done" note to the phone through ntfy. By default it says only that a turn finished and how long it took;
// the conversation's title is sent only when push.includeTitle is on, because it passes through ntfy's server.
import fs from 'node:fs';
import { CONFIG } from './config.mjs';

function topic() {
  const p = CONFIG.push;
  if (p.ntfyTopic) return p.ntfyTopic;
  if (!p.ntfyTopicFile) return '';
  try {
    const re = new RegExp(`^\\s*${p.ntfyTopicKey}\\s*=\\s*(.+?)\\s*$`, 'm');
    const m = re.exec(fs.readFileSync(p.ntfyTopicFile, 'utf8'));
    return m ? m[1].replace(/^["']|["']$/g, '') : '';
  } catch {
    return '';
  }
}

const rfc2047 = (s) => `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;

export function hasPush() {
  return !!topic();
}

export async function push(settings, title, body, log) {
  const t = topic();
  if (!t || !settings.pushOnFinish) return false;
  try {
    const r = await fetch(`${CONFIG.push.ntfyServer.replace(/\/$/, '')}/${encodeURIComponent(t)}`, {
      method: 'POST', body, headers: { Title: rfc2047(title), Priority: 'default' }, signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) log?.(`push failed: HTTP ${r.status}`);
    return r.ok;
  } catch (e) {
    log?.(`push failed: ${e.message}`);
    return false;
  }
}
