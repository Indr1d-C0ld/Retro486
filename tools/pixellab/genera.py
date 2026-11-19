#!/usr/bin/env python3
"""Retro486 - genera il set grafico di set.json con PixelLab (8 lavori alla volta).

  python3 -I tools/pixellab/genera.py [nome ...]     # senza nomi: tutto quello che manca

I PNG grezzi vanno in tools/pixellab/uscita/; tools/pixellab/rifinisci.py li porta in app/assets/pixel/.
"""
import json, os, sys, time, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pixellab as pl

QUI = os.path.dirname(os.path.abspath(__file__))
S = json.load(open(os.path.join(QUI, 'set.json')))
lavori = []
for n, d in S['icone'].items():
    lavori.append((n, {'description': f"{S['stile_icone']}, {d}", 'width': 48, 'height': 48, 'no_background': True,
                       'outline': 'single color black outline', 'detail': 'medium detail'}))
for n, d in S['decorazioni'].items():
    lavori.append((n, {'description': f"pixel art, 1990s MS-DOS PC era, EGA VGA palette, {d['descrizione']}", 'width': d['w'], 'height': d['h'],
                       'no_background': d['trasparente'], 'detail': 'highly detailed'}))
voluti = set(sys.argv[1:])
os.makedirs(pl.OUT, exist_ok=True)
coda = [(n, a) for n, a in lavori if (n in voluti) if voluti] or [(n, a) for n, a in lavori if not voluti and not os.path.exists(os.path.join(pl.OUT, f'{n}.png'))]
print(f'{len(coda)} immagini da generare')
attivi = {}
fatti = 0
while coda or attivi:
    while coda and len(attivi) < 8:
        n, a = coda.pop(0)
        try:
            t = pl.testo(pl.tool('create_image_pixen', a))
        except RuntimeError as e:
            if 'rate' in str(e).lower(): coda.insert(0, (n, a)); break
            print(f'!  {n}: {e}'); continue
        jid = next(l.split(':', 1)[1].strip() for l in t.splitlines() if l.startswith('job_id:'))
        attivi[n] = (jid, time.time())
        print(f'-> {n} ({jid[:8]})')
    time.sleep(6)
    for n, (jid, t0) in list(attivi.items()):
        try:
            with urllib.request.urlopen(f'https://api.pixellab.ai/mcp/images/{jid}/download', timeout=60) as r:
                open(os.path.join(pl.OUT, f'{n}.png'), 'wb').write(r.read())
            del attivi[n]; fatti += 1
            print(f'ok {n} ({fatti})')
        except urllib.error.HTTPError as e:
            if e.code != 423: print(f'!  {n}: HTTP {e.code}'); del attivi[n]
            elif time.time() - t0 > 300: print(f'!  {n}: troppo lento, salto'); del attivi[n]
print(pl.testo(pl.tool('get_balance')).splitlines()[1])
