"""Themes for the phone page. For every public/themes/<id>/theme.json this writes, into that folder:
theme.css (the colours as CSS variables, nothing else), paper.webp (a seamless watercolour-paper tile with tooth and
fibres) and frame-*.png (9-slice inked frames for border-image: a line with pen pressure, finer on the lit side, and
washes that pool at the edge). The drawing follows the culture-book manner: materials only, no pictures of things.
It also writes the app icons from the first light theme.

Usage: python build/notebook_art.py [theme-id ...]
"""
import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
THEMES = ROOT / 'public' / 'themes'
CHECK = ROOT / 'build' / 'out'
CHECK.mkdir(parents=True, exist_ok=True)
LIGHT = np.array([-1.0, -1.0]) / math.sqrt(2)       # light from the top left (screen coordinates, y down)


def rgb(hex_color):
    h = hex_color.lstrip('#')
    return np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], np.float32)


def periodic_noise(n, beta, seed):
    r = np.random.default_rng(seed)
    f = np.fft.fftfreq(n)
    fx, fy = np.meshgrid(f, f)
    k = np.sqrt(fx * fx + fy * fy)
    k[0, 0] = 1.0
    spec = (r.normal(size=(n, n)) + 1j * r.normal(size=(n, n))) / k ** beta
    spec[0, 0] = 0
    out = np.real(np.fft.ifft2(spec))
    return (out - out.min()) / (out.max() - out.min())


def band(n, lo, hi, seed):
    r = np.random.default_rng(seed)
    f = np.fft.fftfreq(n) * n
    fx, fy = np.meshgrid(f, f)
    k = np.sqrt(fx * fx + fy * fy)
    mask = np.exp(-((np.log(k + 1e-6) - np.log((lo * hi) ** 0.5)) ** 2) / (2 * (np.log(hi / lo) / 2.5) ** 2))
    spec = (r.normal(size=(n, n)) + 1j * r.normal(size=(n, n))) * mask
    out = np.real(np.fft.ifft2(spec))
    return (out - out.min()) / (out.max() - out.min())


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def over(base, color, alpha):
    """Lay a colour over the base with the given coverage (works for dark ink on light paper and the reverse)."""
    a = np.clip(alpha, 0, 1)[..., None]
    return base * (1 - a) + color[None, None, :] * a


# ---------------------------------------------------------------- the page: cold-press paper, tooth and fibres
def paper_tile(art, out, seed=20261014):
    T = 1536
    rng = np.random.default_rng(seed)
    tooth = 0.55 * band(T, 27, 90, 11) + 0.3 * band(T, 90, 240, 12) + 0.15 * periodic_noise(T, 1.1, 13)
    tooth = (tooth - tooth.min()) / (tooth.max() - tooth.min())
    mottle = band(T, 6, 16, 14)
    dark = np.zeros((T, T), np.float32)
    light = np.zeros((T, T), np.float32)

    def stamp(acc, x, y, sigma, a):
        r = max(1, int(math.ceil(sigma * 2.5)))
        ax = np.arange(-r, r + 1, dtype=np.float32)
        g = np.exp(-(ax[:, None] ** 2 + ax[None, :] ** 2) / (2 * sigma * sigma))
        xs = (np.arange(int(x) - r, int(x) + r + 1) % T)
        ys = (np.arange(int(y) - r, int(y) + r + 1) % T)
        acc[np.ix_(ys, xs)] += g * a

    def fibre(acc, length, width, alpha):
        x, y = rng.uniform(0, T, 2)
        ang = rng.uniform(0, math.tau)
        turn = rng.normal(0, 0.02)
        n = max(3, int(length / 1.4))
        for i in range(n):
            t = i / (n - 1)
            taper = math.sin(math.pi * t) ** 0.7
            stamp(acc, x, y, max(0.45, width * (0.45 + 0.55 * taper)), alpha * (0.35 + 0.65 * taper))
            ang += turn + rng.normal(0, 0.03)
            x += math.cos(ang) * 1.4
            y += math.sin(ang) * 1.4

    for _ in range(1300):
        fibre(dark, rng.uniform(8, 42), rng.uniform(0.5, 1.0), rng.uniform(0.04, 0.09))
    for _ in range(800):
        fibre(light, rng.uniform(6, 32), rng.uniform(0.6, 1.2), rng.uniform(0.08, 0.18))
    specks = np.zeros((T, T), np.float32)
    for _ in range(300):
        stamp(specks, *rng.uniform(0, T, 2), rng.uniform(0.6, 1.3), rng.uniform(0.04, 0.10))
    dark, light, specks = np.clip(dark, 0, 1), np.clip(light, 0, 1), np.clip(specks, 0, 1)

    base = rgb(art['paper'])
    shade = 1 + 0.05 * (tooth - 0.5) + 0.016 * (mottle - 0.5)
    img = base[None, None, :] * shade[..., None]
    img = over(img, rgb(art['fibreLight']), 0.45 * light)
    img = over(img, rgb(art['fibreDark']), 0.30 * dark)
    img = over(img, rgb(art['speck']), 0.30 * specks)
    Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).save(out / 'paper.webp', quality=90, method=6)


# ---------------------------------------------------------------- inked frames (drawn at 2x, 9-slice 40 px)
def sd_round_box(px, py, hw, hh, r):
    qx, qy = np.abs(px) - (hw - r), np.abs(py) - (hh - r)
    return np.sqrt(np.maximum(qx, 0) ** 2 + np.maximum(qy, 0) ** 2) + np.minimum(np.maximum(qx, qy), 0) - r


def frame(out, name, fill, ink, width=2.4, wash=None, radius=30, seed=1, strength=0.85, lost=True):
    W, H, PAD = 360, 240, 4
    tooth = band(512, 20, 80, 30 + seed)[:H, :W] * 0.5 + 0.25
    ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
    px, py = xs - W / 2, ys - H / 2
    wob = 1.15 * (band(512, 2, 7, 40 + seed)[:H, :W] - 0.5)
    d = sd_round_box(px, py, W / 2 - PAD - width, H / 2 - PAD - width, radius) + wob
    inside = smoothstep(-0.8, 0.8, -d)
    img = np.broadcast_to(fill[None, None, :], (H, W, 3)).astype(np.float32).copy()
    if wash is not None:                            # a wash that pools at the edge and granulates, flat in the middle
        pooled = np.exp(-np.clip(-d, 0, None) / 7.0)
        img = over(img, wash, inside * (0.55 + 0.45 * pooled) * (0.88 + 0.2 * (1 - tooth)) * 0.9)
    th = np.arctan2(py / H, px / W)
    lit = (np.cos(th) * LIGHT[0] + np.sin(th) * LIGHT[1] + 1) / 2
    press = 1.0 - 0.38 * lit                        # finer where the line faces the light
    if lost:                                        # the pen lifts once, near a top corner
        rng = np.random.default_rng(seed)
        gx, gy = (W / 2 - radius * 0.7) * (1 if rng.random() < 0.5 else -1), -(H / 2 - radius * 0.7)
        press *= 1 - 0.8 * np.exp(-((px - gx) ** 2 + (py - gy) ** 2) / (2 * 7.0 ** 2))
    w = width * press
    line = 1 - smoothstep(w / 2 - 0.7, w / 2 + 0.7, np.abs(d))
    img = over(img, ink, line * (0.84 + 0.2 * tooth) * strength)
    alpha = np.clip(np.maximum(inside, np.clip(line * 1.2, 0, 1)), 0, 1)
    Image.fromarray(np.dstack([np.clip(img, 0, 255), alpha * 255]).astype(np.uint8)).save(out / f'frame-{name}.png', optimize=True)


# ---------------------------------------------------------------- the stylesheet: only variables
def theme_css(tid, t):
    c = t['colors']
    names = {'surface2': 'surface-2', 'line2': 'line-2', 'ink2': 'ink-2'}
    lines = [f'/* generated from theme.json by build/notebook_art.py: edit theme.json, not this file */', ':root {',
             f"  color-scheme: {t.get('scheme', 'light')};"]
    for k, v in c.items():
        lines.append(f'  --{names.get(k, k)}: {v};')
    lines.append(f'  --paper: url("/themes/{tid}/paper.webp");')
    for f in ('card', 'bubble', 'btn', 'quiet', 'input', 'alert'):
        lines.append(f'  --frame-{f}: url("/themes/{tid}/frame-{f}.png");')
    lines.append('}')
    return '\n'.join(lines) + '\n'


def build(tid):
    out = THEMES / tid
    t = json.loads((out / 'theme.json').read_text(encoding='utf-8'))
    a = t['art']
    paper_tile(a, out)
    frame(out, 'card', rgb(a['cardFill']), rgb(a['inkLight']), width=2.6, seed=1)
    frame(out, 'bubble', rgb(a['bubbleFill']), rgb(a['bubbleInk']), width=2.8, wash=rgb(a['bubbleWash']), seed=2)
    frame(out, 'btn', rgb(a['buttonFill']), rgb(a['ink']), width=3.0, wash=rgb(a['buttonWash']), seed=3, strength=0.95)
    frame(out, 'quiet', rgb(a['quietFill']), rgb(a['inkLight']), width=2.4, seed=4)
    frame(out, 'input', rgb(a['inputFill']), rgb(a['inputInk']), width=2.4, seed=5, lost=False)
    frame(out, 'alert', rgb(a['cardFill']), rgb(a['alertInk']), width=2.6, seed=6)
    (out / 'theme.css').write_text(theme_css(tid, t), encoding='utf-8')
    tile = Image.open(out / 'paper.webp').convert('RGB')
    big = Image.new('RGB', (tile.width * 2, tile.height * 2))
    for i in range(2):
        for j in range(2):
            big.paste(tile, (i * tile.width, j * tile.height))
    big.resize((tile.width, tile.height), Image.LANCZOS).save(CHECK / f'theme-{tid}-paper-2x2.png')
    print(f'theme {tid}: written')


# ---------------------------------------------------------------- the app icon: an inked note on the theme's paper
def stroke(img, xs, ys, pts, width, ink, strength, tooth):
    pts = np.asarray(pts, np.float32)
    seg = np.diff(pts, axis=0)
    lens = np.sqrt((seg ** 2).sum(1))
    total = lens.sum()
    acc = np.zeros(xs.shape, np.float32)
    run = 0.0
    for (ax, ay), (dx, dy), L in zip(pts[:-1], seg, lens):
        t = np.clip(((xs - ax) * dx + (ys - ay) * dy) / max(L * L, 1e-6), 0, 1)
        dist = np.sqrt((xs - ax - t * dx) ** 2 + (ys - ay - t * dy) ** 2)
        s = (run + t * L) / total
        w = width * (0.45 + 0.55 * np.clip(np.sin(np.pi * np.clip(s, 0, 1)), 0, 1) ** 0.6)
        acc = np.maximum(acc, 1 - smoothstep(w / 2 - 0.9, w / 2 + 0.9, dist))
        run += L
    return over(img, ink, acc * strength * (0.86 + 0.2 * tooth))


def app_icon(t):
    a = t['art']
    S = 1024
    tooth = 0.6 * band(S, 18, 70, 61) + 0.4 * band(S, 70, 200, 62)
    tooth = (tooth - tooth.min()) / (tooth.max() - tooth.min())
    ys, xs = np.mgrid[0:S, 0:S].astype(np.float32)
    paper = rgb(a['paper']) * 0.94
    img = np.broadcast_to(paper[None, None, :], (S, S, 3)).astype(np.float32) * (1 + 0.05 * (tooth[..., None] - 0.5))
    ca, sa = math.cos(-0.06), math.sin(-0.06)
    px, py = xs - 512, ys - 520
    qx, qy = ca * px + sa * py, -sa * px + ca * py
    d = sd_round_box(qx, qy, 330, 250, 70) + 3.0 * (band(S, 2, 6, 63) - 0.5)
    inside = smoothstep(-1.2, 1.2, -d)
    pooled = np.exp(-np.clip(-d, 0, None) / 26.0)
    img = over(img, rgb(a['buttonWash']), inside * (0.42 + 0.5 * pooled) * (0.85 + 0.3 * (1 - tooth)) * 0.95)
    th = np.arctan2(qy / 250, qx / 330)
    lit = (np.cos(th) * LIGHT[0] + np.sin(th) * LIGHT[1] + 1) / 2
    w = 15 * (1.0 - 0.42 * lit)
    img = over(img, rgb(a['ink']), (1 - smoothstep(w / 2 - 1.2, w / 2 + 1.2, np.abs(d))) * 0.95 * (0.86 + 0.2 * tooth))
    img = stroke(img, xs, ys, [(330, 402), (412, 470), (334, 540)], 34, rgb(a['ink']), 1.0, tooth)
    img = stroke(img, xs, ys, [(470 + i * 12, 470 + 9 * math.sin(i * 0.9)) for i in range(20)], 20, rgb(a['ink']), 0.75, tooth)
    img = stroke(img, xs, ys, [(330 + i * 12, 610 + 8 * math.sin(i * 0.8 + 1.3)) for i in range(28)], 17, rgb(a['ink']), 0.5, tooth)
    pic = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8))
    for size in (180, 192, 512):
        pic.resize((size, size), Image.LANCZOS).save(ROOT / 'public' / f'icon-{size}.png', optimize=True)
    pic.resize((32, 32), Image.LANCZOS).save(ROOT / 'public' / 'favicon.png')


if __name__ == '__main__':
    wanted = sys.argv[1:] or sorted(p.name for p in THEMES.iterdir() if (p / 'theme.json').exists())
    for tid in wanted:
        build(tid)
    first_light = next((p for p in sorted(THEMES.iterdir()) if (p / 'theme.json').exists()
                        and json.loads((p / 'theme.json').read_text(encoding='utf-8')).get('scheme') == 'light'), None)
    if first_light:
        app_icon(json.loads((first_light / 'theme.json').read_text(encoding='utf-8')))
        print('icons written from', first_light.name)
