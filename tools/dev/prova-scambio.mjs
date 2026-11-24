#!/usr/bin/env node
// Retro486 - prova lo scambio di file del pannello HARD DISK: trascina un file sull'elenco (evento drop
// sintetico), controlla che sia finito su C:, poi usa «Scarica ZIP» su C:\GIOCHI e legge l'archivio prodotto.
//   node tools/dev/prova-scambio.mjs [url]     FOTO=cartella  LOG=1
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const URL0 = process.argv[2] || 'http://127.0.0.1:8486/';
const ATTESA = Number(process.argv[3] || 90);
const VARIANTI = [{ nome: 'scambio', hw: {} }];
const FOTO = process.env.FOTO || '/tmp/retro486-scambio';
const JITPARAM = process.env.JITPARAM || '';
const LOG = !!process.env.LOG;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const [n, v] of VARIANTI.entries()) {
  const PORT = 9410 + n;
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'r486-p-'));
  const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--window-size=1280,800', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
  let ws, id = 0; const pend = new Map();
  try {
    for (let i = 0; i < 50 && !ws; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); const p = l.find((t) => t.type === 'page' && t.url === 'about:blank'); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); } catch {} if (!ws) await sleep(200); }
    if (!ws) throw new Error('browser non raggiungibile'); if (ws.readyState !== 1) await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
      else if (LOG && m.method === 'Runtime.consoleAPICalled') console.error('  [console]', m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 900));
      else if (LOG && m.method === 'Runtime.exceptionThrown') console.error('  [eccezione]', (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 600)); });
    const cdp = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const js = async (e) => { const r = await cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) console.error('  [js]', r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text); return r.result?.result?.value; };
    const portale = async () => { await cdp('Page.navigate', { url: URL0 }); for (let i = 0; i < 120; i++) { if (await js('!!(window.retro486 && retro486.catalog && retro486.mostra && retro486.srv)')) break; await sleep(500); }
      await js(`(() => { const p = retro486.profili.find((x) => x.id === 'dx33'); Object.assign(p.hw, ${JSON.stringify(v.hw)}); retro486.stato.profilo = 'dx33'; retro486.crt.enabled = false; })()`); };
    const avvia = async () => { await js(`retro486.mostra('libreria')`); await sleep(6000); await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Avvia'))?.click()`); };
    await cdp('Page.enable'); if (LOG) await cdp('Runtime.enable');
    // 1: una prima accensione scarica l'hard disk nello storage del browser
    await portale(); await avvia();
    for (let i = 0; i < 60; i++) { await sleep(2000); if ((await js('web86box.speedPercent')) > 0) break; }
    await sleep(3000);
    // 2: a macchina spenta apre HARD DISK, entra in GIOCHI e lascia cadere un file sull'elenco
    await portale(); await js(`retro486.stato.cwd = '\\\\GIOCHI'; retro486.mostra('disco')`); await sleep(8000);
    console.log('drop:', await js(`(async () => { const dt = new DataTransfer(); dt.items.add(new File(['salvataggio di prova'], 'Partita salvata 1.sav'));
      document.querySelector('.r-files').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 1500));
      const en = dt.items[0].webkitGetAsEntry?.(); return 'entry=' + (en ? en.isFile + '/' + en.name : en) + ' files=' + dt.files.length + ' :: ' + [...document.querySelectorAll('.r-file .n')].map((e) => e.textContent).join(' | ') + ' // ' + (document.querySelector('.dialog .dialog-body')?.textContent || '').slice(0, 80); })()`));
    await js(`[...document.querySelectorAll('.dialog button')].find((b) => b.textContent.trim() === 'OK')?.click()`); await sleep(500);
    // 3: «Scarica ZIP» della cartella aperta: l'archivio viene intercettato e riletto
    console.log('zip:', await js(`(async () => { let blob = null; const orig = URL.createObjectURL; URL.createObjectURL = (b) => { blob = b; return orig.call(URL, b); };
      [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Scarica ZIP')?.click();
      await new Promise((r) => setTimeout(r, 3000)); URL.createObjectURL = orig;
      if (!blob) return 'nessun archivio';
      const { readZip } = await import('./js/zip.js'); const v = readZip(await blob.arrayBuffer());
      const sav = v.find((x) => x.name.endsWith('.SAV')); const t = sav ? new TextDecoder().decode(await sav.read()) : '';
      return v.length + ' file, ' + blob.size + ' byte; ' + v.slice(0, 3).map((x) => x.name).join(', ') + ' ...; ' + (sav ? sav.name + ' = ' + t : 'SAV assente'); })()`));
    fs.mkdirSync(FOTO, { recursive: true });
    const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(FOTO, 'disco.png'), Buffer.from(r.result.data, 'base64'));
  } finally { ws?.close(); chrome.kill('SIGKILL'); fs.rmSync(prof, { recursive: true, force: true }); }
}
