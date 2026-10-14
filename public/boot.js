// Puts this device's theme in place before the first paint. "auto" follows the device's light or dark mode,
// using the pair of themes the computer names; any other value is the id of a folder in /themes.
'use strict';
(() => {
  const get = (k) => {
    try {
      return JSON.parse(localStorage.getItem(`ccpb.${k}`));
    } catch {
      return null;
    }
  };
  const dark = matchMedia('(prefers-color-scheme: dark)');

  function apply(pick) {
    const info = get('themeInfo') || {};
    const p = pick || get('theme') || info.default || 'auto';
    const fixed = p !== 'auto' && /^[a-z0-9_-]+$/i.test(p);
    for (const scheme of ['light', 'dark']) {
      const link = document.getElementById(`theme-${scheme}`);
      if (!link) continue;
      const href = fixed ? `/themes/${p}/theme.css` : `/theme/${scheme}.css`;
      const media = fixed ? 'all' : `(prefers-color-scheme: ${scheme})`;
      if (link.getAttribute('href') !== href) link.setAttribute('href', href);
      if (link.media !== media) link.media = media;
    }
    const id = fixed ? p : dark.matches ? info.dark : info.light;
    const theme = (info.list || []).find((t) => t.id === id);
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'theme-color';
      document.head.append(meta);
    }
    if (theme) meta.content = theme.color;
    document.documentElement.dataset.theme = id || '';
  }

  dark.addEventListener?.('change', () => apply());
  window.ccpbTheme = apply;
  apply();
})();
