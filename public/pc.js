// The PC page: the pairing code, a QR code for the phone, paired devices and the bridge's state.
'use strict';
(() => {
  const { t } = I18N;
  const $ = (id) => document.getElementById(id);
  let fmt = null;
  let zone = '';
  let zoneLabel = '';
  let state = null;
  let shownQr = null;

  document.title = t('值班台 · 电脑');
  for (const el of document.querySelectorAll('[data-t]')) el.textContent = t(el.textContent.trim());
  for (const el of document.querySelectorAll('[data-t-alt]')) el.alt = t(el.alt);

  const post = (path) => fetch(path, { method: 'POST', headers: { 'X-PC': '1' } }).then((r) => r.json());

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function useZone(tz) {
    if (fmt && zone === tz) return;
    fmt = new Intl.DateTimeFormat(I18N.locale, { timeZone: tz, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    const part = new Intl.DateTimeFormat(I18N.locale, { timeZone: tz, timeZoneName: 'shortGeneric' }).formatToParts(Date.now()).find((p) => p.type === 'timeZoneName');
    zone = tz;
    zoneLabel = part ? part.value : tz;
  }

  function draw() {
    if (!state) return;
    useZone(state.timeZone);
    $('code').textContent = state.code.replace(/(\d{3})(\d{3})/, '$1 $2');
    const dark = getComputedStyle(document.documentElement).colorScheme === 'dark';
    const qr = `/pc/qr.svg?c=${state.code}&on=${dark ? 'dark' : 'light'}`;
    if (shownQr !== qr) {
      $('qr').src = qr;
      shownQr = qr;
    }
    const lan = state.addresses[0];
    $('url').textContent = lan ? `${state.scheme}://${lan.address}:${state.port}` : t('没找到局域网地址');
    tick();

    const devs = $('devices');
    devs.replaceChildren();
    if (!state.devices.length) devs.append(el('p', 'none', t('还没有配对的设备')));
    for (const d of state.devices) {
      const row = el('div', 'dev');
      const info = el('div');
      info.append(el('b', null, d.name), el('small', null, t('配对于 {created}，最近 {seen}（{zone}）', { created: fmt.format(d.createdAt), seen: fmt.format(d.lastSeenAt), zone: zoneLabel })));
      const btn = el('button', null, t('移除'));
      btn.type = 'button';
      btn.addEventListener('click', async () => {
        state = await post(`/pc/revoke/${d.id}`);
        draw();
      });
      row.append(info, btn);
      devs.append(row);
    }

    const kv = $('status');
    kv.replaceChildren();
    const rows = [
      [t('手机发起的'), t('在做 {running} 个，开着的进程 {live} 个', { running: state.running, live: state.live })],
      ...state.addresses.map((a) => [a.kind === 'tailscale' ? 'Tailscale' : t('局域网'), `${a.address}:${state.port}`]),
      [t('连接'), state.scheme === 'https' ? t('HTTPS 加密') : t('HTTP（只在局域网里）')],
      ['Claude Code', state.claude],
      [t('做完提醒'), state.push ? t('可用（ntfy）') : t('没有设置推送')],
      [t('值班台'), state.version],
    ];
    for (const [k, v] of rows) kv.append(el('dt', null, k), el('dd', /^[\d.]+:\d+$/.test(v) ? 'ip' : null, v));
  }

  function tick() {
    if (!state) return;
    const left = Math.max(0, state.expires - Date.now());
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    $('left').textContent = left ? t('还有 {m} 分 {s} 秒失效，用过一次也会失效', { m, s: String(s).padStart(2, '0') }) : t('已失效，正在换新的');
    if (!left) refresh();
  }

  async function refresh() {
    try {
      state = await fetch('/pc/state', { cache: 'no-store' }).then((r) => r.json());
      draw();
    } catch {
      $('left').textContent = t('连不上值班台服务');
    }
  }

  $('rotate').addEventListener('click', async () => {
    state = await post('/pc/rotate');
    draw();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => setTimeout(draw, 300));
  refresh();
  setInterval(tick, 1000);
  setInterval(refresh, 5000);
})();
