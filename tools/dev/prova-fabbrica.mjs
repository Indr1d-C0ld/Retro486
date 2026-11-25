#!/usr/bin/env node
// Retro486 - prova "Ripristina il disco di fabbrica": scrive un file su C:, preme il pulsante in
// HARD DISK e controlla che il file non ci sia più e che il disco risulti da salvare sul server.
//   node tools/dev/prova-fabbrica.mjs [url]     FOTO=cartella  LOG=1
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const URL0 = process.argv[2] || 'http://127.0.0.1:8486/';
const FOTO = process.env.FOTO || '/tmp/retro486-fabbrica';
const LOG = !!process.env.LOG;
const PORT = 9470;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'r486-p-'));
const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
let ws, id = 0; const pend = new Map(); let esito = 1;
try {
  for (let i = 0; i < 50 && !ws; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); const p = l.find((t) => t.type === 'page' && t.url === 'about:blank'); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); } catch {} if (!ws) await sleep(200); }
  if (!ws) throw new Error('browser non raggiungibile'); if (ws.readyState !== 1) await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    else if (LOG && m.method === 'Runtime.consoleAPICalled') console.error('  [console]', m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 900)); });
  const cdp = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const js = async (e) => { const r = await cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) console.error('  [js]', r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text); return r.result?.result?.value; };
  const foto = async (nome) => { fs.mkdirSync(FOTO, { recursive: true }); const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(FOTO, `${nome}.png`), Buffer.from(r.result.data, 'base64')); };
  const premi = (testo) => js(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(testo)}); if (b) b.click(); return !!b; })()`);
  await cdp('Page.enable'); if (LOG) await cdp('Runtime.enable');
  await cdp('Page.navigate', { url: URL0 });
  for (let i = 0; i < 120; i++) { if (await js('!!(window.retro486 && retro486.catalog && retro486.mostra && retro486.srv)')) break; await sleep(500); }
  // HARD DISK scarica il disco dal server; poi un file di prova
  await js(`retro486.mostra('disco')`);
  for (let i = 0; i < 90; i++) { await sleep(1000); if (await js(`!!document.querySelector('.r-file')`)) break; }
  await js(`(async () => { const { Disco } = await import('./js/retro/disco.js'); const d = await Disco.apri(); d.vol.writeFile('\\\\PROVA.TXT', 'da cancellare'); await d.salva(); })()`);
  await js(`retro486.disco = null; retro486.mostra('libreria')`); await sleep(6000); await foto('libreria');
  await js(`retro486.mostra('disco')`); await sleep(6000);
  const prima = await js(`(async () => { const { Disco } = await import('./js/retro/disco.js'); return (await Disco.apri()).vol.exists('\\\\PROVA.TXT'); })()`);
  if (!(await premi('Ripristina il disco di fabbrica'))) throw new Error('pulsante "Ripristina il disco di fabbrica" non trovato');
  await sleep(800); await foto('conferma');
  if (!(await premi('Ripristina'))) throw new Error('conferma non trovata');
  for (let i = 0; i < 120; i++) { await sleep(1000); if (!(await js(`!!document.querySelector('.modal-backdrop')`))) break; }
  await sleep(6000); await foto('dopo');
  const dopo = await js(`(async () => { const { Disco } = await import('./js/retro/disco.js'); const v = (await Disco.apri()).vol; return { prova: v.exists('\\\\PROVA.TXT'), dos: v.exists('\\\\DOS\\\\COMMAND.COM') || v.exists('\\\\COMMAND.COM'), info: JSON.parse(localStorage.getItem('retro486.disco')) }; })()`);
  console.log(`prima: PROVA.TXT ${prima ? 'c\'è' : 'manca'}; dopo il ripristino: PROVA.TXT ${dopo.prova ? 'c\'è ANCORA' : 'non c\'è più'}, MS-DOS ${dopo.dos ? 'presente' : 'ASSENTE'}, da salvare sul server: ${dopo.info?.modificato}`);
  esito = prima && !dopo.prova && dopo.dos && dopo.info?.modificato ? 0 : 1;
} finally { ws?.close(); chrome.kill('SIGKILL'); fs.rmSync(prof, { recursive: true, force: true }); }
process.exit(esito);
