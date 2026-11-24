#!/usr/bin/env node
// Retro486 - misura la velocità di emulazione in un gioco della libreria, per varianti.
//   node tools/dev/misura.mjs [url] [secondi di attesa] [secondi di misura]
//   VARIANTI='[{"nome":"jit","hw":{"jit":true},"crt":false}]'  varianti (hw sovrascrive i campi del profilo)
//   FOTO=cartella   salva uno screenshot all'inizio e alla fine della misura (FOTO_SERIE=4,8,12: anche a quei secondi dall'avvio)
//   FINESTRA=2560,1080   dimensione della finestra del browser
//   JITPARAM=soglia,min_istruzioni,max_chiamate   parametri del ricompilatore (build JIT)
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const URL0 = process.argv[2] || 'http://127.0.0.1:8486/';
const ATTESA = Number(process.argv[3] || 45), MISURA = Number(process.argv[4] || 30);
const VARIANTI = (process.env.VARIANTI ? JSON.parse(process.env.VARIANTI) : [
  { nome: 'dx33 mt32 crt', hw: {}, crt: true },
  { nome: 'dx33 mt32 senza crt', hw: {}, crt: false },
  { nome: 'dx33 adlib senza crt', hw: { midi: 'none', mpu: false }, crt: false },
  { nome: 'dx33 muto senza crt', hw: { midi: 'none', mpu: false, sound: 'none' }, crt: false },
]);
const FOTO = process.env.FOTO || '';
const JITPARAM = process.env.JITPARAM || '';
const SERIE = (process.env.FOTO_SERIE || '').split(',').map(Number).filter((x) => x > 0).sort((a, b) => a - b);
const LOG = !!process.env.LOG; // LOG=1: mostra la console della pagina
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const [n, v] of VARIANTI.entries()) {
  const PORT = 9340 + n;
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'r486-m-'));
  const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, `--window-size=${process.env.FINESTRA || '1280,800'}`, '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
  let ws, id = 0; const pend = new Map();
  try {
    for (let i = 0; i < 50 && !ws; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); const p = l.find((t) => t.type === 'page' && t.url === 'about:blank'); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); } catch {} if (!ws) await sleep(200); }
    if (!ws) throw new Error('browser non raggiungibile'); if (ws.readyState !== 1) await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
      else if (LOG && m.method === 'Runtime.consoleAPICalled') console.error('  [console]', m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 400));
      else if (LOG && m.method === 'Runtime.exceptionThrown') console.error('  [eccezione]', (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 600)); });
    const cdp = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const js = async (e) => (await cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
    console.error('connesso'); await cdp('Page.enable'); if (LOG) await cdp('Runtime.enable'); console.error('page.enable');
    await cdp('Page.navigate', { url: URL0 });
    for (let i = 0; i < 120; i++) { if (await js('!!(window.retro486 && retro486.catalog && retro486.mostra)')) break; await sleep(500); }
    await js(`(() => { const p = retro486.profili.find((x) => x.id === 'dx33'); Object.assign(p.hw, ${JSON.stringify(v.hw)}); retro486.stato.profilo = 'dx33'; retro486.crt.enabled = ${v.crt}; })()`);
    console.error('portale pronto'); await js(`retro486.mostra('libreria')`); await sleep(9000); console.error('libreria');
    await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Avvia'))?.click()`);
    const jp = v.jitparam || JITPARAM; // per variante: "jitparam":"16,6,0"
    if (jp) { await sleep(3000); await js(`(() => { const m = web86box.module; if (m && m._wjit_set_params) m._wjit_set_params(${jp}); })()`); }
    const foto = async (quando) => { if (!FOTO) return; const r = await cdp('Page.captureScreenshot', { format: 'png' });
      fs.mkdirSync(FOTO, { recursive: true }); fs.writeFileSync(path.join(FOTO, `${v.nome.replace(/[^a-z0-9]+/gi, '-')}-${quando}.png`), Buffer.from(r.result.data, 'base64')); };
    // FOTO_SERIE=4,8,12: screenshot anche a questi secondi dall'avvio (POST del BIOS, MS-DOS...)
    let passati = jp ? 3 : 0;
    for (const t of SERIE) { if (t > passati && t < ATTESA) { await sleep((t - passati) * 1000); passati = t; await foto(`t${String(t).padStart(3, '0')}`); } }
    await sleep(Math.max(0, ATTESA - passati) * 1000);
    await foto('inizio');
    const s = [];
    for (let i = 0; i < MISURA; i++) { await sleep(1000); s.push(await js('web86box.speedPercent')); }
    const media = Math.round(s.reduce((a, b) => a + b, 0) / s.length);
    await foto('fine');
    console.log(`${v.nome.padEnd(28)} media ${String(media).padStart(3)}%  min ${Math.min(...s)}%  max ${Math.max(...s)}%   ${await js('document.title.split(" - ").slice(3,5).join(" ")')}`);
    // Statistiche del ricompilatore (solo nelle build con il backend WebAssembly).
    const jit = await js('(() => { const m = web86box.module; return m && m._wjit_stats ? m.UTF8ToString(m._wjit_stats()) : ""; })()');
    if (jit) console.log(`${''.padEnd(28)} jit ${jit}`);
  } finally { ws?.close(); chrome.kill('SIGKILL'); fs.rmSync(prof, { recursive: true, force: true }); }
}
