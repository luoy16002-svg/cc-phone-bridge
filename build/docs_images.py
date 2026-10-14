"""The README pictures: a row of phone screens and the computer's page, from the screenshots test/shots.mjs takes.

Usage: node test/shots.mjs --lang en && node test/shots.mjs --lang zh && python build/docs_images.py
Needs Pillow.
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / 'build' / 'out'
DOCS = ROOT / 'docs'
DOCS.mkdir(exist_ok=True)
ROW = ['03-list', '05-tools-open', '17-picker', '20-night-conversation']
GAP = 28


def phone_row(lang):
    shots = [Image.open(SHOTS / f'shots-{lang}' / f'{n}.png').convert('RGB') for n in ROW]
    w, h = 390, 844
    shots = [s.resize((w, h), Image.LANCZOS) for s in shots]
    out = Image.new('RGBA', (len(shots) * w + (len(shots) - 1) * GAP, h), (0, 0, 0, 0))
    for i, s in enumerate(shots):
        mask = Image.new('L', (w, h), 0)
        from PIL import ImageDraw
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, w - 1, h - 1), radius=34, fill=255)
        out.paste(s, (i * (w + GAP), 0), mask)
    path = DOCS / f'phone-{lang}.webp'
    out.save(path, 'WEBP', quality=88, method=6)
    print(path.name, f'{path.stat().st_size // 1024} KB')


def pc_page(lang):
    img = Image.open(SHOTS / f'shots-{lang}' / '12-pc-page.png').convert('RGB')
    path = DOCS / f'pc-{lang}.webp'
    img.save(path, 'WEBP', quality=88, method=6)
    print(path.name, f'{path.stat().st_size // 1024} KB')


for lang in ('en', 'zh'):
    phone_row(lang)
    pc_page(lang)
