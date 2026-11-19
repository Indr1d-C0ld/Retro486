#!/usr/bin/env python3
"""Retro486 - porta il set grafico da tools/pixellab/uscita/ ad app/assets/pixel/.

- case e monitor: sfondo pieno tolto con un riempimento dagli angoli; nel monitor
  anche lo schermo nero diventa trasparente (ci si vede l'emulatore). Le zone utili
  (schermo, display dei MHz) finiscono in <nome>.json.
- file.png: disegnato qui (PixelLab ci metteva una faccia).
"""
import json, os, shutil
from collections import deque
from PIL import Image, ImageDraw

QUI = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(QUI, 'uscita')
DST = os.path.join(QUI, '../../app/assets/pixel')
os.makedirs(DST, exist_ok=True)
S = json.load(open(os.path.join(QUI, 'set.json')))
manifest = {}

def vicino(a, b, tol):
    return all(abs(x - y) <= tol for x, y in zip(a[:3], b[:3]))

def riempi(im, starts, cond):
    """Rende trasparenti i pixel connessi ai punti di partenza che soddisfano cond(rgb)."""
    px = im.load(); w, h = im.size
    seen = set(); q = deque(s for s in starts if cond(px[s]))
    box = [w, h, 0, 0]
    while q:
        x, y = q.popleft()
        if (x, y) in seen: continue
        seen.add((x, y))
        if not cond(px[x, y]): continue
        r, g, b, _ = px[x, y]; px[x, y] = (r, g, b, 0)
        box = [min(box[0], x), min(box[1], y), max(box[2], x), max(box[3], y)]
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h and (nx, ny) not in seen: q.append((nx, ny))
    return box, len(seen)

def angoli(im):
    w, h = im.size
    return [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)] + [(x, 0) for x in range(0, w, 8)] + [(x, h - 1) for x in range(0, w, 8)] + [(0, y) for y in range(0, h, 8)] + [(w - 1, y) for y in range(0, h, 8)]

def salva(nome, im, desc, extra=None):
    p = os.path.join(DST, f'{nome}.png'); im.save(p, optimize=True)
    manifest[nome] = {'file': f'{nome}.png', 'width': im.width, 'height': im.height, 'descrizione': desc, **(extra or {})}

# icone
for n, d in S['icone'].items():
    if n == 'file': continue
    salva(n, Image.open(os.path.join(SRC, f'{n}.png')).convert('RGBA'), d)
f = Image.new('RGBA', (48, 48), (0, 0, 0, 0)); g = ImageDraw.Draw(f)
g.polygon([(10, 4), (30, 4), (39, 13), (39, 44), (10, 44)], fill=(255, 255, 255), outline=(0, 0, 0))
g.polygon([(30, 4), (30, 13), (39, 13)], fill=(170, 170, 170), outline=(0, 0, 0))
for y in range(18, 41, 4): g.line([(14, y), (35 if y % 8 else 31, y)], fill=(85, 85, 85))
salva('file', f, 'documento (disegnato a mano)')

# case: sfondo nero
im = Image.open(os.path.join(SRC, 'case.png')).convert('RGBA')
riempi(im, angoli(im), lambda c: c[3] and max(c[:3]) < 40)
px = im.load(); rossi = [(x, y) for y in range(im.height) for x in range(im.width) if px[x, y][3] and px[x, y][0] > 170 and px[x, y][1] < 90 and px[x, y][2] < 90 and y < im.height * 0.72]
led = None
if rossi:
    xs, ys = [p[0] for p in rossi], [p[1] for p in rossi]
    led = {'x': min(xs), 'y': min(ys), 'w': max(xs) - min(xs) + 1, 'h': max(ys) - min(ys) + 1}
salva('case', im.crop(im.getbbox()) if im.getbbox() else im, S['decorazioni']['case']['descrizione'], {'led': led})
if led and im.getbbox():
    bx = im.getbbox(); led['x'] -= bx[0]; led['y'] -= bx[1]
    manifest['case']['led'] = led

# monitor: sfondo magenta, schermo nero trasparente
im = Image.open(os.path.join(SRC, 'monitor.png')).convert('RGBA')
riempi(im, angoli(im), lambda c: c[3] and c[0] > 120 and c[2] > 120 and c[1] < 110)
bb = im.getbbox(); im = im.crop(bb)
w, h = im.size
box, n = riempi(im, [(w // 2, h // 2)], lambda c: c[3] and max(c[:3]) < 60)
schermo = {'x': box[0], 'y': box[1], 'w': box[2] - box[0] + 1, 'h': box[3] - box[1] + 1}
# apertura pulita: rettangolo con angoli arrotondati al posto del bordo frastagliato
maschera = Image.new('L', im.size, 0)
ImageDraw.Draw(maschera).rounded_rectangle([box[0], box[1], box[2], box[3]], radius=10, fill=255)
a = im.getchannel('A'); a.paste(0, mask=maschera); im.putalpha(a)
salva('monitor', im, S['decorazioni']['monitor']['descrizione'], {'screen': schermo})
json.dump({'width': w, 'height': h, 'screen': schermo}, open(os.path.join(DST, 'monitor.json'), 'w'), indent=2)

for n in ('banner', 'logo-chip', 'copertina', 'mt32'):
    salva(n, Image.open(os.path.join(SRC, f'{n}.png')).convert('RGBA'), S['decorazioni'][n]['descrizione'])

json.dump(manifest, open(os.path.join(DST, 'manifest.json'), 'w'), indent=2, ensure_ascii=False)
print(json.dumps({k: (v['width'], v['height'], v.get('screen') or v.get('led')) for k, v in manifest.items() if k in ('case', 'monitor')}))
print(len(manifest), 'file in app/assets/pixel')
