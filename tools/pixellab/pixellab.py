"""Retro486 - client MCP minimo per PixelLab (modulo).

Il connettore PixelLab dell'app parte senza token; qui il token si legge dalla voce
`pixellab` di ~/.claude.json (la prima fra i progetti, o quella di R486_PIXELLAB_PROGETTO)
e non viene mai stampato. Stesso metodo di tools/prove_pixellab/pl.py del 688.
"""
import base64, json, os, urllib.request

_cfg = json.load(open(os.path.expanduser('~/.claude.json')))
_voci = [(p, v['mcpServers']['pixellab']) for p, v in _cfg.get('projects', {}).items() if 'pixellab' in v.get('mcpServers', {})]
if os.environ.get('R486_PIXELLAB_PROGETTO'):
    _voci = [x for x in _voci if x[0] == os.environ['R486_PIXELLAB_PROGETTO']]
if not _voci:
    raise SystemExit('Nessuna voce pixellab in ~/.claude.json')
URL, _HDR = _voci[0][1]['url'], dict(_voci[0][1].get('headers', {}))
del _cfg
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'uscita')
_sess = None
_id = 0
_init = False


def rpc(method, params=None, notify=False):
    global _sess, _id
    msg = {'jsonrpc': '2.0', 'method': method}
    if params is not None:
        msg['params'] = params
    if not notify:
        _id += 1
        msg['id'] = _id
    h = {**_HDR, 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'}
    if _sess:
        h['Mcp-Session-Id'] = _sess
    req = urllib.request.Request(URL, json.dumps(msg).encode(), h)
    with urllib.request.urlopen(req, timeout=600) as r:
        _sess = r.headers.get('Mcp-Session-Id', _sess)
        body = r.read().decode()
    if notify or not body.strip():
        return None
    if body.lstrip().startswith('{'):
        return json.loads(body)
    out = None
    for line in body.splitlines():
        if line.startswith('data:'):
            d = json.loads(line[5:])
            if 'id' in d:
                out = d
    return out


def in_dati(o):
    """'file:percorso.png' -> data URL, ricorsivamente."""
    if isinstance(o, str) and o.startswith('file:'):
        return 'data:image/png;base64,' + base64.b64encode(open(o[5:], 'rb').read()).decode()
    if isinstance(o, dict):
        return {k: in_dati(v) for k, v in o.items()}
    if isinstance(o, list):
        return [in_dati(v) for v in o]
    return o


def tool(nome, args=None):
    """Chiama uno strumento PixelLab e restituisce il risultato MCP."""
    global _init
    if not _init:
        rpc('initialize', {'protocolVersion': '2025-03-26', 'capabilities': {}, 'clientInfo': {'name': 'retro486', 'version': '1'}})
        rpc('notifications/initialized', notify=True)
        _init = True
    r = rpc('tools/call', {'name': nome, 'arguments': in_dati(args or {})})
    if not r:
        raise RuntimeError('Nessuna risposta')
    if 'error' in r:
        raise RuntimeError(json.dumps(r['error'], ensure_ascii=False))
    return r['result']


def testo(res):
    return '\n'.join(c.get('text', '') for c in res.get('content', []) if c.get('type') == 'text')
