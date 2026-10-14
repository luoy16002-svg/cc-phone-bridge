// Who may talk to the bridge: only this PC, the home network and the tailnet.
import os from 'node:os';

function v4(addr) {
  const m = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(String(addr || ''));
  return m ? m.slice(1, 5).map(Number) : null;
}

export function isLoopback(addr) {
  const a = v4(addr);
  return a ? a[0] === 127 : String(addr) === '::1';
}

// Loopback, RFC 1918, the tailnet (100.64.0.0/10), IPv6 loopback, unique-local and link-local.
export function isPrivate(addr) {
  const a = v4(addr);
  if (a) {
    return a[0] === 127 || a[0] === 10 || (a[0] === 172 && a[1] >= 16 && a[1] <= 31) || (a[0] === 192 && a[1] === 168)
      || (a[0] === 100 && a[1] >= 64 && a[1] <= 127);
  }
  const s = String(addr || '').toLowerCase();
  return s === '::1' || /^f[cd][0-9a-f]{2}:/.test(s) || /^fe[89ab][0-9a-f]:/.test(s);
}

// The Host header must name this machine, so a web page elsewhere cannot rebind a name of its own onto the bridge.
export function hostAllowed(host, extra = []) {
  if (!host) return false;
  let h = String(host).trim().toLowerCase();
  if (h.startsWith('[')) h = h.slice(1, h.indexOf(']'));
  else if ((h.match(/:/g) || []).length === 1) h = h.replace(/:\d+$/, '');
  if (v4(h) || h.includes(':')) return isPrivate(h);
  const name = os.hostname().toLowerCase();
  return h === 'localhost' || h === name || h === `${name}.local` || h.endsWith('.ts.net') || extra.includes(h);
}

// Addresses a phone can use, home network first; the proxy's virtual adapter and WSL are left out.
export function addresses() {
  const out = [];
  for (const [iface, list] of Object.entries(os.networkInterfaces())) {
    if (/vEthernet|WSL|Hyper-V|VirtualBox|VMware|Docker|Mihomo|Clash|Meta Tunnel/i.test(iface)) continue;
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const p = v4(a.address);
      if (!p || (p[0] === 198 && (p[1] === 18 || p[1] === 19))) continue;
      const kind = p[0] === 100 && p[1] >= 64 && p[1] <= 127 ? 'tailscale' : isPrivate(a.address) ? 'lan' : null;
      if (kind) out.push({ iface, address: a.address, kind });
    }
  }
  return out.sort((x, y) => (x.kind === 'lan' ? 0 : 1) - (y.kind === 'lan' ? 0 : 1));
}
