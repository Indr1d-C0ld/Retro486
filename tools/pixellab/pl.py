#!/usr/bin/env python3
"""Retro486 - client MCP minimo per PixelLab (come tools/prove_pixellab/pl.py del 688).

Il connettore PixelLab dell'app parte senza token; questo client lo legge dalla voce
`pixellab` di ~/.claude.json (la prima che trova fra i progetti, o R486_PIXELLAB_PROGETTO)
e non lo stampa mai.

  python3 -I tools/pixellab/pl.py get_balance
  python3 -I tools/pixellab/pl.py create_image_pixen '{"description": "...", "width": 32, "height": 32}'

"file:percorso.png" negli argomenti diventa un data URL. Le immagini base64 della
risposta finiscono in tools/pixellab/uscita/.
"""
import base64, json, os, re, sys, urllib.request

cfg = json.load(open(os.path.expanduser('~/.claude.json')))
progetti = cfg.get('projects', {})
scelto = os.environ.get('R486_PIXELLAB_PROGETTO')
voci = [(p, v['mcpServers']['pixellab']) for p, v in progetti.items() if 'pixellab' in v.get('mcpServers', {})]
if scelto: voci = [x for x in voci if x[0] == scelto]
if not voci: sys.exit('Nessuna voce pixellab in ~/.claude.json')
srv = voci[0][1]
URL, HDR = srv['url'], dict(srv.get('headers', {}))
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'uscita')
sess = None

def rpc(method, params=None, notify=False, _id=[0]):
    global sess
    msg = {'jsonrpc': '2.0', 'method': method}
    if params is not None: msg['params'] = params
    if not notify: _id[0] += 1; msg['id'] = _id[0]
    h = {**HDR, 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'}
    if sess: h['Mcp-Session-Id'] = sess
    req = urllib.request.Request(URL, json.dumps(msg).encode(), h)
    with urllib.request.urlopen(req, timeout=600) as r:
        sess = r.headers.get('Mcp-Session-Id', sess)
        body = r.read().decode()
    if notify or not body.strip(): return None
    if body.lstrip().startswith('{'): return json.loads(body)
    out = None
    for line in body.splitlines():
        if line.startswith('data:'):
            d = json.loads(line[5:])
            if 'id' in d: out = d
    return out

def in_dati(o):
    if isinstance(o, str) and o.startswith('file:'):
        return 'data:image/png;base64,' + base64.b64encode(open(o[5:], 'rb').read()).decode()
    if isinstance(o, dict): return {k: in_dati(v) for k, v in o.items()}
    if isinstance(o, list): return [in_dati(v) for v in o]
    return o

rpc('initialize', {'protocolVersion': '2025-03-26', 'capabilities': {}, 'clientInfo': {'name': 'retro486', 'version': '1'}})
rpc('notifications/initialized', notify=True)
nome = sys.argv[1] if len(sys.argv) > 1 else 'get_balance'
args = in_dati(json.loads(sys.argv[2]) if len(sys.argv) > 2 else {})
for k in list(args):
    if k.endswith('_base64') and isinstance(args[k], str) and args[k].startswith('data:'): args[k] = args[k].split(',', 1)[1]
r = rpc('tools/call', {'name': nome, 'arguments': args})
if not r: sys.exit('Nessuna risposta')
if 'error' in r: sys.exit(json.dumps(r['error'], ensure_ascii=False))
os.makedirs(OUT, exist_ok=True)
n = 0
for c in r.get('result', {}).get('content', []):
    if c.get('type') == 'text': print(c['text'])
    elif c.get('type') == 'image':
        n += 1
        p = os.path.join(OUT, f'{nome}-{n}.png')
        open(p, 'wb').write(base64.b64decode(c['data']))
        print('immagine:', p)
