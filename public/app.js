// 值班台 on the phone: type a request, the PC runs it in Claude Code, progress and replies come back here.
'use strict';
(() => {
  // ---------------------------------------------------------------- small helpers
  const SVGNS = 'http://www.w3.org/2000/svg';
  const XLINK = 'http://www.w3.org/1999/xlink';
  const t = I18N.t;
  document.title = t('值班台');
  document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute('content', t('值班台'));
  const app = document.getElementById('app');
  const layer = document.getElementById('layer');

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'value') el.value = v;
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      }
    }
    for (const kid of kids.flat(3)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
    return el;
  }

  function icon(name, cls = '') {
    const s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('class', `i ${cls}`);
    s.setAttribute('aria-hidden', 'true');
    const u = document.createElementNS(SVGNS, 'use');
    u.setAttribute('href', `/icons.svg#${name}`);
    u.setAttributeNS(XLINK, 'xlink:href', `/icons.svg#${name}`);
    s.append(u);
    return s;
  }

  const LS = {
    get(k, d) {
      try {
        const v = localStorage.getItem(`ccpb.${k}`);
        return v == null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(`ccpb.${k}`, JSON.stringify(v));
      } catch { /* private mode */ }
    },
    del(k) {
      try {
        localStorage.removeItem(`ccpb.${k}`);
      } catch { /* private mode */ }
    },
  };

  let toastTimer;
  function toast(text) {
    layer.querySelector('.toast')?.remove();
    const t = h('div', { class: 'toast', role: 'status' }, text);
    layer.append(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), 2600);
  }

  const go = (hash) => {
    if (location.hash === hash) route();
    else location.hash = hash;
  };

  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  const coarse = matchMedia('(pointer: coarse)').matches;
  const base = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || p;
  const parentOf = (p) => String(p || '').replace(/[\\/]+[^\\/]+[\\/]?$/, '');
  const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

  // ---------------------------------------------------------------- time, in the computer's time zone
  let TZ;
  let F;
  function useTZ(tz) {
    if (F && tz === TZ) return;
    let zone = tz || undefined;
    try {
      new Intl.DateTimeFormat(I18N.locale, { timeZone: zone });
    } catch {
      zone = undefined;
    }
    TZ = tz;
    const f = (o) => new Intl.DateTimeFormat(I18N.locale, { timeZone: zone, ...o });
    let name = '';
    try {
      name = f({ timeZoneName: 'shortGeneric' }).formatToParts(Date.now()).find((p) => p.type === 'timeZoneName')?.value || '';
    } catch { /* old browser */ }
    F = {
      day: f(I18N.lang === 'zh' ? { month: 'long', day: 'numeric' } : { month: 'short', day: 'numeric' }),
      week: f({ weekday: 'short' }),
      time: f({ hour: '2-digit', minute: '2-digit', hour12: false }),
      key: new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }),
      name,
    };
  }
  useTZ(LS.get('tz', undefined));

  const dayKey = (ts) => F.key.format(ts);
  function dayLabel(ts) {
    const k = dayKey(ts);
    if (k === dayKey(Date.now())) return t('今天');
    if (k === dayKey(Date.now() - 86400000)) return t('昨天');
    return I18N.lang === 'zh' ? `${F.day.format(ts)} ${F.week.format(ts)}` : `${F.week.format(ts)}, ${F.day.format(ts)}`;
  }
  function ago(ts) {
    if (!ts) return '';
    const s = (Date.now() - ts) / 1000;
    if (s < 50) return t('刚刚');
    if (s < 3600) return t('{n} 分钟前', { n: Math.round(s / 60) });
    if (s < 6 * 3600 && dayKey(ts) === dayKey(Date.now())) return t('{n} 小时前', { n: Math.round(s / 3600) });
    return dayKey(ts) === dayKey(Date.now()) ? F.time.format(ts) : `${F.day.format(ts)} ${F.time.format(ts)}`;
  }
  function dur(ms) {
    const sec = Math.max(0, Math.round((ms || 0) / 1000));
    if (sec < 60) return t('{n} 秒', { n: sec });
    const m = Math.floor(sec / 60);
    if (m < 60) return t('{m} 分 {s} 秒', { m, s: sec % 60 });
    return t('{h} 小时 {m} 分', { h: Math.floor(m / 60), m: m % 60 });
  }

  // ---------------------------------------------------------------- state
  const S = {
    token: LS.get('token', null),
    server: null,
    settings: null,
    device: null,
    online: true,
    streams: [],
    timers: [],
    resume: null,
    pairCode: null,
  };

  // ---------------------------------------------------------------- network
  class Unpaired extends Error {}

  async function api(method, path, body) {
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: { Authorization: `Bearer ${S.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
      });
    } catch (e) {
      setOnline(false);
      throw e;
    }
    setOnline(true);
    if (res.status === 401) {
      unpair();
      throw new Unpaired('unpaired');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || String(res.status)), { status: res.status, data });
    return data;
  }

  // Server-sent events over fetch, so the token travels in a header. Reconnects by itself.
  function stream(urlFn, { onEvent, onOpen }) {
    let stopped = false;
    let ctrl = null;
    let wait = 700;
    async function run() {
      if (stopped) return;
      ctrl = new AbortController();
      try {
        const res = await fetch(urlFn(), { headers: { Authorization: `Bearer ${S.token}` }, signal: ctrl.signal, cache: 'no-store' });
        if (res.status === 401) {
          unpair();
          return;
        }
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        setOnline(true);
        wait = 700;
        onOpen?.();
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            let ev = 'message';
            let data = '';
            for (const line of chunk.split('\n')) {
              if (line.startsWith('event: ')) ev = line.slice(7);
              else if (line.startsWith('data: ')) data += line.slice(6);
            }
            if (data) {
              try {
                onEvent(ev, JSON.parse(data));
              } catch (e) {
                console.error(e);
              }
            }
          }
        }
        throw new Error('ended');
      } catch (e) {
        if (stopped) return;
        if (e.name !== 'AbortError') setOnline(false);
        setTimeout(run, wait);
        wait = Math.min(wait * 2, 8000);
      }
    }
    run();
    const handle = { stop() { stopped = true; ctrl?.abort(); } };
    S.streams.push(handle);
    return handle;
  }

  function stopAll() {
    for (const s of S.streams) s.stop();
    S.streams = [];
    for (const t of S.timers) clearInterval(t);
    S.timers = [];
    S.resume = null;
  }

  function unpair() {
    S.token = null;
    LS.del('token');
    stopAll();
    go('#/');
  }

  function setOnline(on) {
    if (S.online === on) return;
    S.online = on;
    const b = document.querySelector('[data-banner]');
    if (b) b.replaceWith(banner());
  }

  function banner() {
    if (S.online) return h('div', { 'data-banner': '' });   // an empty row keeps the grid in place
    return h('div', { class: 'banner', 'data-banner': '', role: 'alert' },
      icon('plug-connected-x', 'sm'),
      h('div', { class: 'grow' }, t('连不上电脑'), h('small', null, t('手机要和电脑在同一个网络里，电脑要开着'))),
      h('button', { onclick: () => route() }, t('重试')));
  }

  // ---------------------------------------------------------------- the keyboard (iOS)
  // The page itself never scrolls: the app is sized and moved to the part of the screen the keyboard leaves free,
  // so the header stays at the top and the box being typed in stays in sight.
  function syncViewport() {
    const vv = window.visualViewport;
    if (vv && Math.abs(vv.scale - 1) > 0.01) return;          // the person is zooming: leave the layout alone
    const root = document.documentElement.style;
    root.setProperty('--app-h', `${Math.round(vv ? vv.height : window.innerHeight)}px`);
    root.setProperty('--vv-top', `${Math.round(vv ? Math.max(0, vv.offsetTop) : 0)}px`);
  }
  function revealFocused() {
    const el = document.activeElement;
    if (!el || !/^(INPUT|TEXTAREA)$/.test(el.tagName)) return;
    const sc = el.closest('.scroll');
    if (!sc) return;
    const r = el.getBoundingClientRect();
    const s = sc.getBoundingClientRect();
    if (r.bottom > s.bottom - 12) sc.scrollTop += r.bottom - s.bottom + 24;
    else if (r.top < s.top + 12) sc.scrollTop -= s.top - r.top + 24;
  }
  let revealTimer = 0;
  const onViewport = () => {
    syncViewport();
    clearTimeout(revealTimer);
    revealTimer = setTimeout(revealFocused, 60);
  };
  window.visualViewport?.addEventListener('resize', onViewport);
  window.visualViewport?.addEventListener('scroll', syncViewport);
  window.addEventListener('resize', onViewport);
  document.addEventListener('focusin', () => setTimeout(revealFocused, 350));
  syncViewport();

  // ---------------------------------------------------------------- markdown
  function md(text) {
    const div = h('div', { class: 'md' });
    div.innerHTML = DOMPurify.sanitize(marked.parse(String(text || ''), { gfm: true, breaks: true }), { FORBID_TAGS: ['style', 'form', 'input'], FORBID_ATTR: ['style'] });
    for (const t of div.querySelectorAll('table')) {
      const w = h('div', { class: 'tw' });
      t.replaceWith(w);
      w.append(t);
    }
    for (const a of div.querySelectorAll('a')) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
    return div;
  }

  // ---------------------------------------------------------------- shared pieces
  function top({ back, title, sub, right = [] }) {
    return h('header', { class: `top${back ? '' : ' home'}` },
      back ? h('button', { class: 'ib', 'aria-label': t('返回'), onclick: () => go(back) }, icon('arrow-left')) : null,
      h('div', { class: 'titles' }, h('h1', null, title), sub ? h('div', { class: 'sub' }, sub) : null),
      h('div', { class: 'acts' }, right));
  }

  function mount(node) {
    for (const el of [...layer.children]) if (!el.classList.contains('toast')) el.remove();
    app.replaceChildren(node);
    app.scrollTop = 0;
  }

  async function toJpeg(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = reject;
        i.src = url;
      });
      const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k);
      c.height = Math.round(img.naturalHeight * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
      const data = await new Promise((r) => {
        const fr = new FileReader();
        fr.onload = () => r(String(fr.result).split(',')[1]);
        fr.readAsDataURL(blob);
      });
      return { type: 'image/jpeg', data, preview: URL.createObjectURL(blob) };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // The writing area used on the conversation page and on the new-conversation page.
  function composer({ placeholder, draftKey, onSend, onStop }) {
    const images = [];
    const ta = h('textarea', { rows: 1, placeholder, 'aria-label': t('要求'), enterkeyhint: coarse ? 'enter' : 'send' });
    ta.value = draftKey ? LS.get(`draft.${draftKey}`, '') : '';
    const file = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
    const thumbs = h('div', { class: 'thumbs', hidden: true });
    const send = h('button', { class: 'send', 'aria-label': t('发出'), type: 'button' }, icon('send-2'));
    const stop = h('button', { class: 'stop', 'aria-label': t('停下'), type: 'button', hidden: true }, icon('player-stop-filled'));
    const hint = h('div', { class: 'hint', hidden: true });
    let busy = false;
    let blocked = '';
    let queueText = '';

    const fit = () => {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight + 2, Math.round(window.innerHeight * 0.38))}px`;
    };
    const refresh = () => {
      send.disabled = busy || !!blocked || (!ta.value.trim() && !images.length);
      thumbs.hidden = !images.length;
      thumbs.replaceChildren(...images.map((im, i) => h('div', { class: 'thumb' },
        h('img', { src: im.preview, alt: '' }),
        h('button', { type: 'button', 'aria-label': t('去掉这张图'), onclick: () => { URL.revokeObjectURL(im.preview); images.splice(i, 1); refresh(); } }, icon('x', 'xs')))));
      const text = blocked || queueText;
      hint.hidden = !text;
      hint.textContent = text;
    };
    ta.addEventListener('input', () => {
      fit();
      refresh();
      if (draftKey) LS.set(`draft.${draftKey}`, ta.value);
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing && (e.metaKey || e.ctrlKey || (!coarse && !e.shiftKey))) {
        e.preventDefault();
        doSend();
      }
    });
    file.addEventListener('change', async () => {
      for (const f of [...file.files].slice(0, 6 - images.length)) {
        try {
          images.push(await toJpeg(f));
        } catch {
          toast(t('这张图读不出来'));
        }
      }
      file.value = '';
      refresh();
    });
    async function doSend() {
      const text = ta.value.trim();
      if (busy || blocked || (!text && !images.length)) return;
      busy = true;
      refresh();
      try {
        await onSend(text, images.map(({ type, data }) => ({ type, data })));
        ta.value = '';
        if (draftKey) LS.del(`draft.${draftKey}`);
        for (const im of images) URL.revokeObjectURL(im.preview);
        images.length = 0;
        fit();
      } catch (e) {
        if (!(e instanceof Unpaired)) toast(e.message === 'Failed to fetch' ? t('没发出去：连不上电脑') : e.shown || t('没发出去，再试一次'));
      } finally {
        busy = false;
        refresh();
      }
    }
    send.addEventListener('click', doSend);
    stop.addEventListener('click', () => onStop?.());

    const el = h('div', { class: 'composer' },
      thumbs,
      h('div', { class: 'row' },
        h('button', { class: 'ib', type: 'button', 'aria-label': t('附图片'), onclick: () => file.click() }, icon('photo')),
        ta,
        h('div', { class: 'btns' }, stop, send)),
      hint, file);
    setTimeout(() => { fit(); refresh(); }, 0);
    return {
      el,
      ta,
      setRunning(running, text) {
        stop.hidden = !running || !onStop;
        ta.placeholder = running ? t('接着写，这轮做完再发') : placeholder;
        queueText = text || '';
        refresh();
      },
      setBlocked(text) {
        if (blocked === (text || '')) return;
        blocked = text || '';
        refresh();
      },
    };
  }

  // ---------------------------------------------------------------- pairing
  function showPair({ prefill = null, here = false } = {}) {
    stopAll();
    const fromLink = prefill || S.pairCode;
    if (fromLink && isIOS && !standalone() && !here) return showInstall(fromLink);
    const code = h('input', { class: 'input code-in', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, placeholder: '······', 'aria-label': t('配对数字'), value: fromLink || '' });
    const name = h('input', { class: 'input', value: LS.get('deviceName', isIOS ? 'iPhone' : t('这台设备')), maxlength: 40, 'aria-label': t('设备名') });
    const err = h('div', { class: 'err', role: 'alert' });
    const btn = h('button', { class: 'btn wide', type: 'button' }, t('配对'));
    async function submit() {
      const c = code.value.replace(/\D/g, '');
      if (c.length !== 6) {
        err.textContent = t('要 6 位数字');
        return;
      }
      btn.disabled = true;
      err.textContent = '';
      try {
        const res = await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: c, name: name.value.trim() }) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          err.textContent = { bad_code: t('数字不对，或者已经换过了'), expired: t('这个数字已经失效，请在电脑上换一个'), too_many: t('试错太多次，十分钟后再试') }[data.error] || t('配对没成功');
          return;
        }
        S.token = data.token;
        LS.set('token', data.token);
        LS.set('deviceName', name.value.trim());
        S.pairCode = null;
        toast(t('配好了'));
        go('#/');
      } catch {
        err.textContent = t('连不上电脑：手机要和电脑在同一个网络里');
      } finally {
        btn.disabled = false;
      }
    }
    btn.addEventListener('click', submit);
    code.addEventListener('input', () => {
      code.value = code.value.replace(/\D/g, '').slice(0, 6);
      if (code.value.length === 6) name.focus();
    });
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) submit(); });
    const port = location.port || (location.protocol === 'https:' ? '443' : '80');
    mount(h('div', { class: 'center' },
      h('div', { class: 'stack' },
        h('div', { class: 'brand' }, h('img', { src: '/icon-180.png', alt: '' }), h('div', null, h('b', null, t('值班台')), h('small', null, t('在手机上把要求交给电脑上的 Claude Code')))),
        h('div', { class: 'form' },
          h('h2', null, t('和电脑配对')),
          h('p', null, t('在电脑上打开 127.0.0.1:{port}/pc，把那里显示的 6 位数字填进来。', { port })),
          h('label', { class: 'field' }, h('span', null, t('配对数字')), code),
          h('label', { class: 'field' }, h('span', null, t('这台设备叫')), name),
          err,
          btn))));
    if (!fromLink && !coarse) setTimeout(() => code.focus(), 50);
  }

  // Safari on iPhone: the home-screen app keeps its own storage, so it is installed first and paired there.
  function showInstall(code) {
    mount(h('div', { class: 'center' },
      h('div', { class: 'stack' },
        h('div', { class: 'brand' }, h('img', { src: '/icon-180.png', alt: '' }), h('div', null, h('b', null, t('值班台')), h('small', null, t('先放到主屏幕，用起来和 App 一样')))),
        h('div', { class: 'form' },
          h('h2', null, t('三步装好')),
          h('ol', { class: 'steps' },
            h('li', null, t('点 Safari 底部的分享按钮')),
            h('li', null, t('选“添加到主屏幕”，再点“添加”')),
            h('li', null, t('从主屏幕打开值班台，填这个数字'))),
          h('div', { class: 'bigcode' }, code.replace(/(\d{3})(\d{3})/, '$1 $2')),
          h('p', null, t('数字十分钟内有效。过期了就在电脑上换一个。'))),
        h('button', { class: 'linkbtn', type: 'button', onclick: () => showPair({ prefill: code, here: true }) }, t('不装，就在 Safari 里用')))));
  }

  // ---------------------------------------------------------------- what the computer told us
  function modelName(id) {
    const m = (S.models || []).find((x) => x.id === id);
    if (m) return m.name;
    const r = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(id || '');
    return r ? `${r[1][0].toUpperCase()}${r[1].slice(1)} ${r[2]}${r[3] ? `.${r[3]}` : ''}` : (id || '');
  }
  const modelLine = (s) => [s.modelName || modelName(s.model), s.effort].filter(Boolean).join(' · ');

  const themeName = (x) => (I18N.lang !== 'zh' && x.names?.[I18N.lang]) || x.name;

  async function loadState() {
    const st = await api('GET', '/api/state');
    S.server = st.server;
    S.settings = st.settings;
    S.device = st.device;
    S.models = st.models;
    S.efforts = st.efforts;
    S.defaults = st.defaults;
    S.themes = st.themes || [];
    S.theme = st.server.theme || {};
    if (st.server.timeZone && st.server.timeZone !== TZ) {
      LS.set('tz', st.server.timeZone);
      useTZ(st.server.timeZone);
    }
    LS.set('themeInfo', { ...S.theme, list: S.themes.map(({ id, color }) => ({ id, color })) });
    window.ccpbTheme?.();
    return st;
  }

  function seg(options, value, onPick, label, cls = '') {
    const box = h('div', { class: `seg ${cls}`, role: 'radiogroup', 'aria-label': label });
    const draw = (v) => box.replaceChildren(...options.map((o) => h('button', { type: 'button', class: o.value === v ? 'on' : '', role: 'radio', 'aria-checked': String(o.value === v), onclick: () => { onPick(o.value); draw(o.value); } }, o.label)));
    draw(value);
    return box;
  }

  const modelOptions = () => (S.models || []).map((m) => ({ value: m.id, label: m.name }));
  const effortOptions = () => (S.efforts || ['low', 'medium', 'high', 'xhigh', 'max']).map((e) => ({ value: e, label: e }));

  // ---------------------------------------------------------------- the list: every Claude Code conversation on the PC
  const busyNow = (s) => s.state === 'running' || s.pcBusy;

  function statusOf(s) {
    const bits = [];
    if (s.state === 'running') bits.push(h('span', { class: 'st' }, h('span', { class: 'dot run' }), s.queue ? t('在做，还有 {n} 条排队', { n: s.queue }) : t('在做')));
    else if (s.pcBusy) bits.push(h('span', { class: 'st pc' }, h('span', { class: 'dot run' }), t('电脑上在做')));
    else if (s.state === 'error') bits.push(h('span', { class: 'st err' }, t('没能启动')));
    if (s.openOnPc && !s.pcBusy) bits.push(h('span', { class: 'st pc' }, icon('device-desktop', 'xs'), t('电脑上开着')));
    return bits;
  }

  function showDesk() {
    stopAll();
    const cards = h('div', { class: 'cards' }, h('div', { class: 'hint-row' }, t('在读电脑上的对话…')));
    const suggest = h('div', { class: 'suggest' });
    const sub = h('span', { class: 'status' });
    mount(h('div', { class: 'view' },
      top({ title: t('值班台'), sub, right: [h('button', { class: 'ib', 'aria-label': t('设置'), type: 'button', onclick: () => go('#/settings') }, icon('settings'))] }),
      banner(),
      h('main', { class: 'scroll page' },
        h('button', { class: 'btn wide', type: 'button', onclick: () => go('#/new') }, icon('plus', 'sm'), t('新对话')),
        suggest,
        cards),
      h('div')));

    let list = [];
    // suggestions other tools on the computer wrote: a tap starts the conversation, nothing starts by itself
    const drawSuggest = (items) => {
      if (!items || !items.length) {
        suggest.replaceChildren();
        return;
      }
      const dismiss = (x) => api('POST', '/api/suggestions/dismiss', { id: x.id }).catch(() => null);
      suggest.replaceChildren(h('div', { class: 'day' }, t('建议')), ...items.map((x) => {
        const startBtn = h('button', { class: 'btn small', type: 'button' }, t('开始'));
        startBtn.onclick = async () => {
          startBtn.disabled = true;
          toast(t('正在开始…'));
          try {
            const r = await api('POST', '/api/sessions', { cwd: x.cwd, text: x.prompt });
            await dismiss(x);
            go(`#/s/${r.id}`);
          } catch (e) {
            startBtn.disabled = false;
            toast(e.status === 403 ? t('这个文件夹不在电脑允许的范围里') : t('Claude Code 没能启动'));
          }
        };
        return h('div', { class: 'card sugg' },
          h('div', { class: 't' }, x.title || x.id),
          x.detail ? h('div', { class: 'p' }, x.detail) : null,
          h('div', { class: 'acts' },
            startBtn,
            x.link ? h('a', { class: 'btn small quiet', href: x.link, target: '_blank', rel: 'noopener noreferrer' }, t('看看')) : null,
            h('button', { class: 'btn small quiet', type: 'button', onclick: async () => { await dismiss(x); } }, t('不用了')),
            h('span', { class: 'm' }, h('span', null, x.folder), x.created ? h('span', null, ago(x.created * 1000)) : null)));
      }));
    };
    api('GET', '/api/suggestions').then((r) => drawSuggest(r.items)).catch(() => null);
    const card = (s) => h('button', { class: 'card', type: 'button', onclick: () => go(`#/s/${s.id}`) },
      h('div', { class: 't' }, s.title || t('新对话')),
      h('div', { class: 'p' }, s.state === 'running' ? (s.lastPrompt ? t('在做：{text}', { text: s.lastPrompt }) : t('在做…')) : (s.lastReply || s.lastPrompt || t('还没有回复'))),
      h('div', { class: 'm' }, ...statusOf(s), h('span', null, s.folder), h('span', null, s.lastModel || s.modelName), h('span', null, ago(s.updatedAt))));
    const draw = () => {
      const running = list.filter(busyNow).length;
      sub.replaceChildren(h('span', { class: `dot ${running ? 'run' : 'ok'}` }), running ? t('{n} 个对话在做', { n: running }) : (S.server ? t('已连上 {host}', { host: S.server.host }) : t('已连上电脑')));
      if (!list.length) {
        cards.replaceChildren(h('div', { class: 'empty' }, h('b', null, t('还没有对话')), t('点上面的“新对话”，写下要电脑做的事。')));
        return;
      }
      const out = [];
      const now = list.filter(busyNow);
      if (now.length) out.push(h('div', { class: 'day now' }, t('正在做')), ...now.map(card));
      let day = '';
      for (const s of list) {
        if (busyNow(s)) continue;
        const k = dayKey(s.updatedAt);
        if (k !== day) {
          day = k;
          out.push(h('div', { class: 'day' }, dayLabel(s.updatedAt)));
        }
        out.push(card(s));
      }
      cards.replaceChildren(...out);
    };
    const refresh = async () => {
      try {
        const r = await api('GET', '/api/sessions?limit=80');
        list = r.sessions;
        draw();
      } catch (e) {
        if (!(e instanceof Unpaired) && !list.length) cards.replaceChildren(h('div', { class: 'empty' }, t('读不到电脑上的对话')));
      }
    };
    loadState().catch(() => null).then(refresh);
    let pending = false;
    stream(() => '/api/stream', {
      onEvent: (ev, d) => {
        if (ev === 'suggestions') return drawSuggest(d.items);
        if (ev !== 'session') return;
        const i = list.findIndex((s) => s.id === d.id);
        if (i >= 0) list[i] = d;
        else list.unshift(d);
        list.sort((a, b) => b.updatedAt - a.updatedAt);
        if (!pending) {
          pending = true;
          requestAnimationFrame(() => { pending = false; draw(); });
        }
      },
    });
    S.timers.push(setInterval(refresh, 30000));
    S.resume = () => showDesk();
  }

  // ---------------------------------------------------------------- choosing a folder: tap through, make one in place
  function pickFolder(start, onPick) {
    let cur = null;
    const crumbs = h('nav', { class: 'crumbs', 'aria-label': t('位置') });
    const list = h('div', { class: 'dirs' });
    const name = h('input', { class: 'input', placeholder: t('新文件夹的名字'), maxlength: 60, 'aria-label': t('新文件夹的名字'), enterkeyhint: 'done', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false' });
    const mkErr = h('div', { class: 'err', role: 'alert' });
    const mkBtn = h('button', { class: 'btn', type: 'button' }, t('建好'));
    const mk = h('div', { class: 'form', hidden: true }, h('h2', null, t('在这里新建文件夹')), h('div', { class: 'mkdir' }, name, mkBtn), mkErr);
    const scroller = h('main', { class: 'scroll page' }, mk, h('div', { class: 'form' }, list));
    const useLabel = h('span', { class: 'ell' }, t('用这个文件夹'));
    const useBtn = h('button', { class: 'btn wide', type: 'button' }, icon('check', 'sm'), useLabel);
    const newBtn = h('button', { class: 'btn quiet', type: 'button' }, icon('folder-plus', 'sm'), t('新建'));
    const close = () => box.remove();
    const box = h('div', { class: 'picker', role: 'dialog', 'aria-label': t('选文件夹') },
      h('div', { class: 'view' },
        h('header', { class: 'top' },
          h('button', { class: 'ib', type: 'button', 'aria-label': t('关上'), onclick: close }, icon('x')),
          h('div', { class: 'titles' }, h('h1', null, t('选文件夹')), h('div', { class: 'sub' }, t('点进去找，在哪一层就用哪一层'))),
          h('div', { class: 'acts' })),
        crumbs, scroller,
        h('div', { class: 'pickbar' }, newBtn, useBtn)));

    const sepOf = (p) => (String(p).includes('\\') ? '\\' : '/');
    function drawCrumbs() {
      const roots = cur.roots || [];
      const root = roots.filter((r) => same(cur.path, r.path) || String(cur.path).toLowerCase().startsWith(String(r.path).toLowerCase().replace(/[\\/]$/, '') + sepOf(r.path)))
        .sort((a, b) => b.path.length - a.path.length)[0] || { name: base(cur.path), path: cur.path };
      const parts = [{ name: root.name || root.path, path: root.path }];
      const rest = String(cur.path).slice(String(root.path).replace(/[\\/]$/, '').length).split(/[\\/]/).filter(Boolean);
      let acc = String(root.path).replace(/[\\/]$/, '');
      for (const seg of rest) {
        acc += sepOf(root.path) + seg;
        parts.push({ name: seg, path: acc });
      }
      const out = [];
      if (roots.length > 1) out.push(h('button', { type: 'button', 'aria-label': t('所有位置'), onclick: showRoots }, icon('home', 'xs')), icon('chevron-right', 'sep'));
      parts.forEach((p, i) => {
        if (i) out.push(icon('chevron-right', 'sep'));
        out.push(h('button', { type: 'button', class: i === parts.length - 1 ? 'cur' : '', onclick: () => open(p.path) }, p.name));
      });
      crumbs.replaceChildren(...out);
      requestAnimationFrame(() => { crumbs.scrollLeft = crumbs.scrollWidth; });
    }
    function row(d, onclick) {
      const chosen = start && same(d.path, start);
      return h('button', { class: `dir${chosen ? ' on' : ''}`, type: 'button', onclick },
        icon(chosen ? 'folder-open' : 'folder', 'sm'), h('span', { class: 'nm' }, d.name),
        chosen ? h('small', null, t('现在选的')) : d.cc ? h('small', null, t('用过')) : h('span'), icon('chevron-right', 'xs go'));
    }
    function draw() {
      drawCrumbs();
      list.replaceChildren(...(cur.dirs.length ? cur.dirs.map((d) => row(d, () => open(d.path))) : [h('div', { class: 'none' }, t('这里面没有文件夹了'))]));
      useLabel.textContent = t('用 {name}', { name: cur.name || cur.path });
      useBtn.disabled = false;
      newBtn.disabled = false;
    }
    function showRoots() {
      cur = { ...cur, path: '', name: '' };
      crumbs.replaceChildren(h('button', { type: 'button', class: 'cur' }, t('所有位置')));
      list.replaceChildren(...(cur.roots || []).map((r) => row({ name: r.path }, () => open(r.path))));
      useLabel.textContent = t('先选一个位置');
      useBtn.disabled = true;
      newBtn.disabled = true;
    }
    async function open(p) {
      try {
        cur = await api('GET', `/api/browse${p ? `?path=${encodeURIComponent(p)}` : ''}`);
        mk.hidden = true;
        mkErr.textContent = '';
        draw();
        scroller.scrollTop = 0;
      } catch (e) {
        if (e instanceof Unpaired) return;
        if (p && !cur) open(null);
        else toast(t('打不开这个文件夹'));
      }
    }
    async function make() {
      const n = name.value.trim();
      mkErr.textContent = '';
      if (!n || !cur?.path) return;
      mkBtn.disabled = true;
      try {
        const r = await api('POST', '/api/dirs', { parent: cur.path, name: n });
        name.value = '';
        name.blur();
        toast(t('建好了：{name}', { name: r.name }));
        await open(r.path);
      } catch (e) {
        mkErr.textContent = { exists: t('已经有这个文件夹了'), bad_name: t('名字里不能有 \\ / : * ? " < > | 这些符号，也不能以点结尾'), outside_roots: t('这里不能新建') }[e.message] || t('没建成');
      } finally {
        mkBtn.disabled = false;
      }
    }
    newBtn.addEventListener('click', () => {
      mk.hidden = false;
      scroller.scrollTop = 0;
      name.focus();
    });
    mkBtn.addEventListener('click', make);
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) make(); });
    useBtn.addEventListener('click', () => {
      if (!cur?.path) return;
      onPick(cur.path);
      close();
    });
    layer.append(box);
    open(start ? parentOf(start) : null);                    // open where the chosen folder sits, next to its neighbours
  }

  // ---------------------------------------------------------------- new conversation
  async function showNew() {
    stopAll();
    if (!S.defaults) await loadState().catch(() => null);
    let cwd = LS.get('lastCwd', '');
    let model = S.defaults?.model || '';
    let effort = S.defaults?.effort || 'high';
    let recent = [];
    let roots = [];
    // where a folder sits, said from the root that holds it: "Projects" or "Projects/site/docs"
    const placeOf = (p) => {
      const par = parentOf(p);
      const trim = (r) => r.replace(/[\\/]+$/, '');
      const root = roots.filter((r) => same(par, r.path) || par.toLowerCase().startsWith(`${trim(r.path).toLowerCase()}${r.path.includes('\\') ? '\\' : '/'}`))
        .sort((a, b) => b.path.length - a.path.length)[0];
      if (!root) return par;
      const rest = par.slice(trim(root.path).length).split(/[\\/]/).filter(Boolean).join('/');
      return rest ? `${root.name}/${rest}` : root.name;
    };
    const where = h('div', { class: 'choices' });
    const choose = (p) => {
      cwd = p;
      LS.set('lastCwd', p);
      drawWhere();
    };
    const other = h('button', { type: 'button', class: 'choice', onclick: () => pickFolder(cwd, choose) },
      icon('folder-open', 'sm'), h('span', { class: 'tx' }, h('b', null, t('别的文件夹，或新建一个'))), icon('chevron-right', 'xs'));
    function drawWhere() {
      const rows = recent.slice(0, 4);
      if (cwd && !rows.some((d) => same(d.path, cwd))) rows.unshift({ name: base(cwd), path: cwd });
      if (!cwd && rows[0]) cwd = rows[0].path;
      where.replaceChildren(...rows.map((d) => h('button', { type: 'button', class: `choice${same(d.path, cwd) ? ' on' : ''}`, onclick: () => choose(d.path) },
        h('span', { class: 'mark' }), h('span', { class: 'tx one' }, h('b', null, d.name), h('small', null, placeOf(d.path))))), other);
    }
    drawWhere();
    api('GET', '/api/browse').then((r) => { recent = r.recent || []; roots = r.roots || []; drawWhere(); }).catch(() => null);

    const comp = composer({
      placeholder: t('要电脑上的 Claude Code 做什么？'),
      draftKey: 'new',
      onSend: async (text, images) => {
        if (!cwd) throw Object.assign(new Error('no folder'), { shown: t('先选一个文件夹') });
        toast(t('正在开始…'));
        try {
          const r = await api('POST', '/api/sessions', { cwd, model, effort, text, images });
          go(`#/s/${r.id}`);
        } catch (e) {
          if (e.message === 'outside_roots') e.shown = t('这个文件夹不在电脑允许的范围里');
          else if (e.message === 'no_such_dir') e.shown = t('这个文件夹已经不在了');
          else if (e.status === 502) e.shown = t('Claude Code 没能启动');
          throw e;
        }
      },
    });
    mount(h('div', { class: 'view' },
      top({ back: '#/', title: t('新对话') }),
      banner(),
      h('main', { class: 'scroll page' },
        h('div', { class: 'form' }, h('h2', null, t('在哪个文件夹里做')), where),
        h('div', { class: 'form' }, h('h2', null, t('模型')), seg(modelOptions(), model, (v) => { model = v; }, t('模型'), 'grid2'),
          h('h2', null, t('思考强度')), seg(effortOptions(), effort, (v) => { effort = v; }, t('思考强度'), 'mono'),
          h('p', null, S.defaults ? t('默认和电脑上一样：{model} · {effort}', { model: S.defaults.modelName, effort: S.defaults.effort }) : ''))),
      comp.el));
  }

  // ---------------------------------------------------------------- a conversation
  const TOOL_ICONS = { Bash: 'terminal-2', PowerShell: 'terminal-2', Read: 'file-text', Edit: 'pencil', MultiEdit: 'pencil', Write: 'file-plus', NotebookEdit: 'pencil', Grep: 'search', Glob: 'search', WebFetch: 'world', WebSearch: 'world', Agent: 'subtask', Task: 'subtask', TodoWrite: 'list-check', Skill: 'bolt' };
  const TOOL_KIND = { Bash: t('命令'), PowerShell: t('命令'), Read: t('读'), Write: t('写'), Edit: t('改'), MultiEdit: t('改'), NotebookEdit: t('改'), Grep: t('查'), Glob: t('查'), WebFetch: t('网页'), WebSearch: t('搜索'), Agent: t('子任务'), Task: t('子任务'), TodoWrite: t('待办'), Skill: t('技能') };
  const ACT = { thinking: t('在想'), writing: t('在写回复') };
  const runningTool = (name) => t('在执行 {name}', { name });
  const STOPPED = ['aborted_tools', 'aborted_streaming', 'stopped', 'interrupted'];
  const blobs = new Map();

  async function authedImage(ref, img) {
    if (!blobs.has(ref)) {
      blobs.set(ref, fetch(`/api/files/${ref}`, { headers: { Authorization: `Bearer ${S.token}` } })
        .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('img')))).then((b) => URL.createObjectURL(b)));
    }
    try {
      img.src = await blobs.get(ref);
    } catch {
      blobs.delete(ref);
    }
  }

  async function showSession(id) {
    stopAll();
    if (!S.models) loadState().catch(() => null);
    const C = { id, hist: [], live: new Map(), cursor: 0, hasMore: false, state: 'idle', queue: 0, liveText: '', activity: null, since: 0, expanded: new Set(), open: new Set(), session: null, pc: { open: false, busy: false }, pcSince: 0 };
    const timeline = h('div', { class: 'timeline', 'aria-live': 'polite' });
    const liveBox = h('div', { class: 'a live', hidden: true });
    const activity = h('div', { class: 'activity', hidden: true });
    const pcNote = h('div', { class: 'pcnote', hidden: true });
    const scroller = h('main', { class: 'scroll' }, pcNote, timeline);
    const jump = h('button', { class: 'jump', type: 'button', hidden: true }, icon('arrow-down', 'xs'), t('最新'));
    const title = h('h1', null, '');
    const sub = h('button', { class: 'sub subbtn', type: 'button', 'aria-label': t('模型和思考强度') });
    const menuBtn = h('button', { class: 'ib', type: 'button', 'aria-label': t('更多') }, icon('dots'));
    const header = h('header', { class: 'top' },
      h('button', { class: 'ib', type: 'button', 'aria-label': t('返回'), onclick: () => go('#/') }, icon('arrow-left')),
      h('div', { class: 'titles' }, title, sub),
      h('div', { class: 'acts' }, menuBtn));
    const comp = composer({
      placeholder: t('接着说…'),
      draftKey: `s.${id}`,
      onSend: (text, images) => api('POST', `/api/sessions/${id}/messages`, { text, images }),
      onStop: async () => {
        try {
          await api('POST', `/api/sessions/${id}/interrupt`);
        } catch {
          toast(t('没能停下，再试一次'));
        }
      },
    });
    mount(h('div', { class: 'view' }, header, banner(), h('div', { class: 'body-wrap' }, scroller, jump), comp.el));

    const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140;
    const toBottom = () => { scroller.scrollTop = scroller.scrollHeight; jump.hidden = true; };
    jump.addEventListener('click', toBottom);
    scroller.addEventListener('scroll', () => { if (nearBottom()) jump.hidden = true; }, { passive: true });

    const pcBusy = () => C.pc.busy && C.state !== 'running';

    function drawHeader() {
      const s = C.session || {};
      const running = C.state === 'running' || pcBusy();
      title.textContent = s.title || t('新对话');
      sub.replaceChildren(h('span', { class: `dot ${running ? 'run' : C.state === 'error' ? 'err' : 'ok'}` }),
        `${s.folder ? `${s.folder} · ` : ''}${modelLine(s)}${C.state === 'running' ? ` · ${t('在做')}` : pcBusy() ? ` · ${t('电脑上在做')}` : ''}`, icon('chevron-down', 'xs'));
      comp.setRunning(C.state === 'running', C.queue ? t('还有 {n} 条排队，这一轮做完就发', { n: C.queue }) : '');
      comp.setBlocked(pcBusy() ? t('电脑上正在做这个对话，做完再发') : '');
      pcNote.hidden = !C.pc.open && !pcBusy();
      pcNote.replaceChildren(...(pcBusy()
        ? [h('span', { class: 'dot run' }), h('span', null, t('电脑上正在做这个对话，这里跟着实时显示。等它做完，手机上就能接着发。'))]
        : [icon('device-desktop', 'xs'), h('span', null, t('这个对话在电脑上也开着。手机上发的会接在后面，电脑那个窗口要重新打开才看得到。'))]));
    }

    // events (history, then live ones the history does not have yet) -> blocks -> DOM, reusing unchanged elements
    function events() {
      const ids = new Set(C.hist.map((e) => e.id));
      return [...C.hist, ...[...C.live.values()].filter((e) => !ids.has(e.id))];
    }

    function blocks() {
      const out = [];
      let group = null;
      const tools = new Map();
      let day = '';
      let turn = null;
      const add = (b, ts) => {
        if (ts) {
          const k = dayKey(ts);
          if (k !== day) {
            day = k;
            out.push({ key: `d${k}`, type: 'day', t: ts });
          }
        }
        out.push(b);
      };
      const endTurn = () => {
        if (turn && !turn.result && turn.last - turn.start >= 1000 && turn.replied) out.push({ key: `e${turn.id}`, type: 'turn', ms: turn.last - turn.start, model: turn.model });
        turn = null;
      };
      const all = events();
      for (const e of all) {
        if (turn && e.t && e.k !== 'user') turn.last = Math.max(turn.last, e.t);
        switch (e.k) {
          case 'user':
            group = null;
            if (e.state !== 'queued' && e.state !== 'canceled') {
              endTurn();
              if (!e.command) turn = { id: e.id, start: e.t || 0, last: e.t || 0, model: '', replied: false, result: false };
            }
            add({ key: `u${e.id}`, type: 'user', e }, e.t);
            break;
          case 'text':
            group = null;
            if (turn) {
              turn.model = e.model || turn.model;
              turn.replied = true;
            }
            add({ key: `t${e.id}`, type: 'text', e }, e.t);
            break;
          case 'tool': {
            if (turn) turn.replied = true;
            if (!group) {
              group = { key: `g${e.id}`, type: 'tools', lines: [] };
              add(group, e.t);
            }
            const line = { e, res: null };
            group.lines.push(line);
            tools.set(e.tool, line);
            break;
          }
          case 'tool_result':
            if (tools.has(e.tool)) tools.get(e.tool).res = e;
            break;
          case 'note':
            group = null;
            add({ key: `n${e.id}`, type: 'note', e }, e.t);
            break;
          case 'result':
            group = null;
            add({ key: `x${e.id}`, type: 'result', e, model: turn?.model || '' }, e.t);
            if (turn) turn.result = true;
            break;
          default:
            break;
        }
      }
      if (C.state !== 'running' && !pcBusy()) endTurn();
      else {
        // the tools slip still being added to: the last block, apart from messages waiting their turn
        const lastReal = [...out].reverse().find((b) => !(b.type === 'user' && (b.e.state === 'queued' || b.e.state === 'canceled')));
        if (lastReal?.type === 'tools') lastReal.working = true;
      }
      for (const b of out) {
        if (b.type === 'user') b.ver = `${b.e.state || ''}${C.state}`;
        else if (b.type === 'tools') b.ver = `${b.lines.length}.${b.lines.filter((l) => l.res).length}.${!!b.working}.${C.expanded.has(b.key)}.${b.lines.filter((l) => C.open.has(l.e.id)).map((l) => l.e.id).join()}`;
        else if (b.type === 'day') b.ver = dayLabel(b.t);
        else if (b.type === 'turn') b.ver = `${b.ms}${b.model}`;
        else b.ver = `1${b.model || ''}`;
      }
      return out;
    }

    function drawUser(b) {
      const e = b.e;
      const st = e.state === 'canceled' ? t('已取消') : e.state === 'queued' ? (C.state === 'running' ? t('排队中') : t('发送中')) : '';
      const imgs = Array.isArray(e.images) ? e.images : [];
      return h('div', { class: `u${e.state === 'canceled' ? ' canceled' : ''}${e.command ? ' cmd' : ''}` },
        imgs.length ? h('div', { class: 'imgs' }, imgs.map((ref) => {
          const img = h('img', { alt: t('附图') });
          authedImage(ref, img);
          return h('button', { type: 'button', 'aria-label': t('看大图'), onclick: () => viewImage(img.src) }, img);
        })) : null,
        typeof e.images === 'number' && e.images > 0 ? h('div', { class: 'imgchip' }, icon('photo', 'xs'), e.images > 1 ? t('{n} 张图', { n: e.images }) : t('图片')) : null,
        e.text ? h('div', { class: 'tx' }, e.text) : null,
        h('div', { class: 'ft' }, st ? h('span', { class: 'q' }, st) : null, e.pending || e.state ? icon('device-mobile', 'xs') : null, e.t ? F.time.format(e.t) : ''));
    }

    function stepTime(l) {
      if (!l.res?.t || !l.e.t) return '';
      const ms = l.res.t - l.e.t;
      return ms >= 1000 ? dur(ms) : '';
    }

    // Collapsed: one step reads as itself; several read as a count by kind. The time they took sits on the right.
    function drawTools(b) {
      const n = b.lines.length;
      const expanded = C.expanded.has(b.key);
      const failed = b.lines.filter((l) => l.res && !l.res.ok).length;
      const last = b.lines[n - 1].e;
      const counts = new Map();
      for (const l of b.lines) {
        const k = TOOL_KIND[l.e.name] || l.e.name;
        counts.set(k, (counts.get(k) || 0) + 1);
      }
      const kinds = [...counts].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k, c]) => `${k} ${c}`).join(' · ');
      const lastRes = [...b.lines].reverse().find((l) => l.res)?.res;
      const span = !b.working && lastRes?.t && b.lines[0].e.t ? lastRes.t - b.lines[0].e.t : 0;
      const what = b.working || n === 1
        ? [h('span', { class: 'count' }, n > 1 ? `${t('第 {n} 步', { n })}  ` : ''), h('span', { class: 'lastline' }, `${last.name} ${last.summary || ''}`)]
        : [h('span', { class: 'count' }, t('{n} 步', { n })), h('span', { class: 'kinds' }, ` · ${kinds}`)];
      const hd = h('button', { class: 'hd', type: 'button', 'aria-expanded': String(expanded) },
        icon('tool', 'xs'),
        h('span', { class: 'grow' }, ...what),
        failed ? h('span', { class: 'bad' }, t('{n} 步出错', { n: failed })) : null,
        span >= 1000 ? h('span', { class: 'took' }, dur(span)) : null,
        icon(expanded ? 'chevron-down' : 'chevron-right', 'xs'));
      hd.addEventListener('click', () => { if (C.expanded.has(b.key)) C.expanded.delete(b.key); else C.expanded.add(b.key); render(false); });
      const box = h('div', { class: 'tools' }, hd);
      if (!expanded) return box;
      for (const l of b.lines) {
        const e = l.e;
        const status = l.res ? (l.res.ok ? icon('check', 'xs') : icon('x', 'xs bad')) : h('span');
        const ln = h('button', { class: 'ln', type: 'button', 'aria-expanded': String(C.open.has(e.id)) },
          icon(TOOL_ICONS[e.name] || 'tool', 'xs'), h('span', { class: 'n' }, e.name), h('span', { class: 's' }, e.summary || ''), h('span', { class: 'd' }, stepTime(l)), status);
        ln.addEventListener('click', () => { if (C.open.has(e.id)) C.open.delete(e.id); else C.open.add(e.id); render(false); });
        box.append(ln);
        if (C.open.has(e.id)) box.append(h('div', { class: 'dt' }, e.detail || e.summary || '', l.res?.text ? h('span', { class: 'o' }, l.res.text) : null));
      }
      return box;
    }

    function drawResult(b) {
      const e = b.e;
      const time = dur(e.ms);
      const mdl = b.model ? h('span', null, modelName(b.model)) : null;
      if (e.ok) return h('div', { class: 'res' }, h('span', null, t('用时 {time}', { time })), mdl);
      const why = STOPPED.includes(e.reason) ? t('已停下') : { exit: t('没做完：Claude Code 中途退出'), spawn: t('没能启动 Claude Code') }[e.reason] || t('没做完');
      return h('div', { class: 'res bad' }, h('span', null, e.ms ? t('{why}，用时 {time}', { why, time }) : why), mdl);
    }

    function drawBlock(b) {
      if (b.type === 'user') return drawUser(b);
      if (b.type === 'text') return h('div', { class: 'a' }, md(b.e.text));
      if (b.type === 'tools') return drawTools(b);
      if (b.type === 'note') return h('div', { class: `note ${b.e.tone || ''}` }, icon(b.e.tone === 'error' ? 'alert-triangle' : 'info-circle', 'xs'), b.e.key ? t(b.e.key, b.e.vars) : t(b.e.text));
      if (b.type === 'day') return h('div', { class: 'daysep' }, dayLabel(b.t));
      if (b.type === 'turn') return h('div', { class: 'res' }, h('span', null, t('用时 {time}', { time: dur(b.ms) })), b.model ? h('span', null, modelName(b.model)) : null);
      return drawResult(b);
    }

    let firstRender = true;
    function render(stick = true) {
      const wasNear = nearBottom();
      const list = blocks();
      const old = new Map();
      for (const el of timeline.children) if (el.dataset.key) old.set(el.dataset.key, el);
      let prev = null;
      let more = timeline.querySelector('.more');
      if (C.hasMore) {
        if (!more) more = h('button', { class: 'more', type: 'button', onclick: loadOlder }, t('更早的记录'));
        if (timeline.firstChild !== more) timeline.prepend(more);
        prev = more;
      } else if (more) more.remove();
      for (const b of list) {
        let el = old.get(b.key);
        if (!el || el.dataset.ver !== b.ver) {
          const fresh = drawBlock(b);
          fresh.dataset.key = b.key;
          fresh.dataset.ver = b.ver;
          if (!el && !firstRender) fresh.classList.add('fresh');
          if (el) el.replaceWith(fresh);
          el = fresh;
        }
        const want = prev ? prev.nextSibling : timeline.firstChild;
        if (want !== el) timeline.insertBefore(el, want);
        old.delete(b.key);
        prev = el;
      }
      for (const el of old.values()) el.remove();
      liveBox.hidden = !C.liveText;
      if (C.liveText) liveBox.replaceChildren(md(C.liveText));
      timeline.append(liveBox);
      drawActivity();
      timeline.append(activity);
      drawHeader();
      if (firstRender || (stick && wasNear)) toBottom();
      else if (stick && !wasNear) jump.hidden = false;
      firstRender = false;
    }

    function lastWork() {
      return events().reverse().find((e) => ['tool', 'tool_result', 'text', 'user'].includes(e.k) && e.state !== 'queued');
    }

    function drawActivity() {
      const running = C.state === 'running';
      activity.hidden = !running && !pcBusy();
      if (activity.hidden) return;
      const lastEv = lastWork();
      let what;
      if (running && C.activity) what = C.activity.what === 'tool' ? runningTool(C.activity.name) : ACT[C.activity.what] || t('在做');
      else what = !lastEv || lastEv.k === 'user' ? (running ? t('在启动') : t('在想')) : lastEv.k === 'tool' ? runningTool(lastEv.name) : t('在想');
      const since = running ? C.since : C.pcSince;
      activity.replaceChildren(h('span', { class: 'dot run' }), h('b', null, running ? what : t('电脑上{what}', { what })), t('已用 {time}', { time: dur(Date.now() - (since || Date.now())) }));
    }

    let raf = 0;
    const schedule = (stick = true) => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; render(stick); });
    };

    async function loadOlder() {
      if (!C.cursor) return;
      const before = scroller.scrollHeight;
      try {
        const r = await api('GET', `/api/sessions/${id}/history?before=${C.cursor}`);
        const ids = new Set(C.hist.map((e) => e.id));
        C.hist = [...r.events.filter((e) => !ids.has(e.id)), ...C.hist];
        C.cursor = r.cursor;
        C.hasMore = r.hasMore;
        render(false);
        scroller.scrollTop += scroller.scrollHeight - before;
      } catch {
        toast(t('读不到更早的记录'));
      }
    }

    // After a turn the transcript holds everything: take the latest page, keep only what is still waiting.
    async function reload() {
      try {
        const r = await api('GET', `/api/sessions/${id}`);
        C.session = r.session;
        const ids = new Set(r.events.map((e) => e.id));
        const firstT = r.events.length ? r.events[0].t : Infinity;
        C.hist = [...C.hist.filter((e) => e.t < firstT && !ids.has(e.id)), ...r.events];
        if (!C.cursor || C.hist.length === r.events.length) {
          C.cursor = r.cursor;
          C.hasMore = r.hasMore;
        }
        let lastResult = null;
        for (const [k, e] of C.live) {
          if (e.k === 'result') lastResult = k;
        }
        for (const [k, e] of [...C.live]) {
          const keep = (e.k === 'user' && e.state === 'queued') || k === lastResult;
          if (!keep) C.live.delete(k);
        }
        schedule();
      } catch { /* the stream will catch up */ }
    }
    let reloadTimer = 0;

    function onEvent(kind, d) {
      if (kind === 'ev') {
        C.live.set(d.id, d);
        if (d.k === 'text' && !d.pc) C.liveText = '';
        if (d.k === 'result') {
          C.liveText = '';
          C.activity = null;
          clearTimeout(reloadTimer);
          reloadTimer = setTimeout(reload, 400);
        }
        schedule();
      } else if (kind === 'tr') {
        if (d.k === 'state') {
          if (d.state === 'running' && C.state !== 'running') C.since = Date.now();
          C.state = d.state;
          C.queue = d.queue || 0;
        } else if (d.k === 'live') {
          C.liveText = d.text || '';
          C.activity = d.activity;
          C.since = d.since || C.since;
        } else if (d.k === 'delta') {
          C.liveText += d.text;
        } else if (d.k === 'activity') {
          C.activity = d;
          if (d.what === 'writing') C.liveText = '';
        } else if (d.k === 'pc') {
          const was = C.pc.busy;
          C.pc = { open: !!d.open, busy: !!d.busy };
          if (d.busy && !was) {
            const u = events().reverse().find((e) => e.k === 'user' && !e.state);
            C.pcSince = u && u.t && Date.now() - u.t < 3600000 ? u.t : Date.now();
          }
          if (!d.busy && was) {
            clearTimeout(reloadTimer);
            reloadTimer = setTimeout(reload, 500);
          }
        }
        schedule();
      }
    }

    C.redraw = drawHeader;
    menuBtn.addEventListener('click', () => openMenu(C));
    sub.addEventListener('click', () => openPrefs(C, drawHeader));

    try {
      const r = await api('GET', `/api/sessions/${id}`);
      C.session = r.session;
      C.hist = r.events;
      C.cursor = r.cursor;
      C.hasMore = r.hasMore;
      C.state = r.session.state;
      C.queue = r.session.queue;
      C.pc = { open: !!r.session.openOnPc, busy: !!r.session.pcBusy };
      if (C.pc.busy) {
        const u = [...r.events].reverse().find((e) => e.k === 'user');
        C.pcSince = u?.t || Date.now();
      }
    } catch (e) {
      if (e.status === 404) {
        toast(t('找不到这个对话'));
        go('#/');
        return;
      }
      if (e instanceof Unpaired) return;
    }
    render();
    const connect = () => {
      stream(() => `/api/sessions/${id}/stream`, { onEvent, onOpen: () => { if (!firstRender) reload(); } });
      S.timers.push(setInterval(() => { if (C.state === 'running' || pcBusy()) drawActivity(); }, 1000));
    };
    const resume = () => {
      stopAll();
      connect();
      S.resume = resume;
    };
    connect();
    S.resume = resume;
  }

  function viewImage(src) {
    if (!src) return;
    const v = h('div', { class: 'viewer', role: 'dialog', 'aria-label': t('大图'), onclick: () => v.remove() }, h('img', { src, alt: '' }));
    layer.append(v);
  }

  function sheet(content) {
    const close = () => { box.remove(); shade.remove(); };
    const shade = h('div', { class: 'shade', onclick: () => close() });
    const box = h('div', { class: 'menu', role: 'dialog' }, content);
    layer.append(shade, box);
    return close;
  }

  async function openPrefs(C, redraw) {
    const s = C.session;
    if (!s) return;
    if (!S.models) await loadState().catch(() => null);
    let model = s.model;
    let effort = s.effort;
    let close = null;
    const save = h('button', { class: 'btn wide', type: 'button' }, t('用这个设置'));
    save.addEventListener('click', async () => {
      try {
        const r = await api('PUT', `/api/sessions/${s.id}/prefs`, { model, effort });
        C.session = r.session;
        redraw();
        close();
        toast(C.state === 'running' ? t('这一轮做完后换上') : t('下一条消息起生效'));
      } catch {
        toast(t('没保存上'));
      }
    });
    close = sheet(h('div', { class: 'prefs' },
      h('h2', null, t('模型')), seg(modelOptions(), model, (v) => { model = v; }, t('模型'), 'grid2'),
      h('h2', null, t('思考强度')), seg(effortOptions(), effort, (v) => { effort = v; }, t('思考强度'), 'mono'),
      save));
  }

  function openMenu(C) {
    const s = C.session;
    if (!s) return;
    const cmd = (S.server?.resume || 'claude --resume {id}').replace('{id}', s.id);
    const copyBox = h('div', { class: 'cmd' }, cmd);
    let close = null;
    close = sheet(h('div', null,
      h('button', { type: 'button', onclick: () => { close(); openPrefs(C, () => C.redraw?.()); } }, icon('cpu', 'sm'), t('模型和思考强度')),
      h('button', { type: 'button', onclick: async () => {
        let ok = false;
        try {
          await navigator.clipboard.writeText(cmd);
          ok = true;
        } catch {
          const range = document.createRange();
          range.selectNodeContents(copyBox);
          const sel = getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          try {
            ok = document.execCommand('copy');
          } catch { /* older browsers */ }
        }
        toast(ok ? t('已复制。在电脑的终端里，进到下面的文件夹再粘贴') : t('长按下面这行复制'));
      } }, icon('copy', 'sm'), t('在电脑上接着这个对话')),
      copyBox,
      h('div', { class: 'cmd dim' }, t('文件夹：{path}', { path: s.cwd }))));
  }

  // ---------------------------------------------------------------- settings
  async function showSettings() {
    stopAll();
    try {
      await loadState();
    } catch (e) {
      if (e instanceof Unpaired) return;
    }
    const st = S.settings || {};
    const sw = (on, label, note, key, disabled) => {
      const b = h('button', { class: `switch${on ? ' on' : ''}`, type: 'button', role: 'switch', 'aria-checked': String(on), 'aria-label': label, disabled });
      b.addEventListener('click', async () => {
        const next = !b.classList.contains('on');
        b.classList.toggle('on', next);
        b.setAttribute('aria-checked', String(next));
        try {
          S.settings = await api('PUT', '/api/settings', { [key]: next });
        } catch {
          b.classList.toggle('on', !next);
          toast(t('没保存上'));
        }
      });
      return h('div', { class: 'sw-row' }, h('div', null, h('b', null, label), h('small', null, note)), b);
    };

    const themes = S.themes || [];
    const themeBox = h('div', { class: 'choices' });
    const swatch = (colors) => {
      const box = h('span', { class: 'sw', 'aria-hidden': 'true' });
      for (const c of colors) {
        const s = h('span');
        s.style.background = c;
        box.append(s);
      }
      return box;
    };
    const drawThemes = () => {
      const pick = LS.get('theme', null) || S.theme?.default || 'auto';
      const light = themes.find((x) => x.id === S.theme?.light);
      const dark = themes.find((x) => x.id === S.theme?.dark);
      const opts = [];
      if (light && dark) opts.push({ id: 'auto', name: t('跟着手机的深浅色'), note: t('浅色时用{light}，深色时用{dark}', { light: themeName(light), dark: themeName(dark) }), colors: [light.swatch[0], light.swatch[2], dark.swatch[0], dark.swatch[2]] });
      for (const x of themes) opts.push({ id: x.id, name: themeName(x), note: x.scheme === 'dark' ? t('深色') : t('浅色'), colors: x.swatch });
      themeBox.replaceChildren(...opts.map((o) => h('button', { type: 'button', class: `choice${o.id === pick ? ' on' : ''}`, role: 'radio', 'aria-checked': String(o.id === pick), onclick: () => {
        LS.set('theme', o.id);
        window.ccpbTheme?.(o.id);
        drawThemes();
      } }, h('span', { class: 'mark' }), h('span', { class: 'tx' }, h('b', null, o.name), h('small', null, o.note)), swatch(o.colors))));
    };
    drawThemes();

    // the language of this device's screens; a change reloads the page so every word is redrawn
    const langBox = h('div', { class: 'choices' });
    for (const [id, name] of [['auto', t('跟着手机')], ['zh', '中文'], ['en', 'English']]) {
      const on = (I18N.pick || 'auto') === id;
      langBox.append(h('button', { type: 'button', class: `choice${on ? ' on' : ''}`, role: 'radio', 'aria-checked': String(on), onclick: () => {
        if (on) return;
        LS.set('lang', id);
        location.reload();
      } }, h('span', { class: 'mark' }), h('span', { class: 'tx' }, h('b', null, name))));
    }

    const codeBox = h('div', { hidden: true });
    const pairOther = h('button', { class: 'btn quiet wide', type: 'button' }, icon('device-mobile', 'sm'), t('给另一台设备配对'));
    pairOther.addEventListener('click', async () => {
      try {
        const r = await api('POST', '/api/pair/code');
        codeBox.hidden = false;
        codeBox.replaceChildren(h('div', { class: 'bigcode' }, r.code.replace(/(\d{3})(\d{3})/, '$1 $2')), h('p', null, t('在另一台设备上打开值班台，填这个数字。十分钟内有效。')));
      } catch {
        toast(t('没拿到数字'));
      }
    });
    const sure = h('button', { class: 'btn danger wide', type: 'button', hidden: true }, t('确定取消配对'));
    sure.addEventListener('click', async () => {
      try {
        await api('DELETE', '/api/me');
      } catch { /* forget locally anyway */ }
      unpair();
    });
    const leave = h('button', { class: 'linkbtn', type: 'button' }, t('取消这台设备的配对'));
    leave.addEventListener('click', () => { sure.hidden = false; leave.hidden = true; });
    const srv = S.server || {};
    const pushNote = !st.push ? t('电脑上还没有设置推送，暂时用不了')
      : t('一轮做完而你没在看时，推一条提醒到手机（经 ntfy）。') + (st.pushTitle ? t('提醒里带对话的标题') : t('提醒里只有“做完了”和用时，不带对话内容'));
    mount(h('div', { class: 'view' },
      top({ back: '#/', title: t('设置') }),
      banner(),
      h('main', { class: 'scroll page' },
        h('div', { class: 'form' },
          sw(!!st.pushOnFinish && !!st.push, t('做完提醒'), pushNote, 'pushOnFinish', !st.push),
          sw(!!st.phoneNote, t('回复写短一点'), t('告诉 Claude 你在手机上看，结论先说。关着时和电脑上完全一样'), 'phoneNote')),
        h('div', { class: 'form' },
          h('h2', null, t('主题')),
          themeBox,
          h('h2', null, t('语言')),
          langBox),
        h('div', { class: 'form' },
          h('h2', null, t('默认')),
          h('p', null, S.defaults ? t('新对话默认用 {model} · {effort}，和电脑上的设置一样。', { model: S.defaults.modelName, effort: S.defaults.effort }) : '')),
        h('div', { class: 'form' },
          h('h2', null, t('这台设备')),
          h('dl', { class: 'kv' }, h('dt', null, t('名字')), h('dd', { class: 'plain' }, S.device?.name || ''), h('dt', null, t('时间')), h('dd', { class: 'plain' }, t('按{zone}显示', { zone: F.name || t('电脑的时区') }))),
          pairOther, codeBox),
        h('div', { class: 'form' },
          h('h2', null, t('电脑')),
          h('dl', { class: 'kv' },
            h('dt', null, t('名字')), h('dd', null, srv.host || ''),
            ...(srv.addresses || []).flatMap((a) => [h('dt', null, a.kind === 'tailscale' ? 'Tailscale' : t('局域网')), h('dd', null, `${a.address}:${srv.port}`)]),
            h('dt', null, t('连接')), h('dd', { class: 'plain' }, srv.scheme === 'https' ? t('HTTPS 加密') : t('HTTP，只在局域网里')),
            h('dt', null, 'Claude Code'), h('dd', null, srv.claude || ''),
            h('dt', null, t('值班台')), h('dd', null, srv.version || ''))),
        h('div', { class: 'form' }, leave, sure)),
      h('div')));
  }

  // ---------------------------------------------------------------- routing
  function route() {
    const hash = location.hash || '#/';
    const pm = /[#&]pair=(\d{6})/.exec(hash);
    if (pm) {
      S.pairCode = pm[1];
      history.replaceState(null, '', location.pathname + (S.token ? '#/' : '#/pair'));
    }
    if (!S.token) return showPair();
    const m = /^#\/s\/([0-9a-f-]{36})/.exec(location.hash);
    if (m) return showSession(m[1]);
    if (location.hash.startsWith('#/new')) return showNew();
    if (location.hash.startsWith('#/settings')) return showSettings();
    return showDesk();
  }

  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      for (const s of S.streams) s.stop();
      S.streams = [];
    } else if (S.token && S.resume) {
      S.resume();
    }
  });
  route();
})();
