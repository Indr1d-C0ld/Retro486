#!/usr/bin/env node
// Retro486 - prova l'aggiunta di un gioco dalla LIBRERIA: prepara uno ZIP (una cartella in cima, un nome
// lungo, JOYTEST.COM), lo carica dal dialogo «Aggiungi un gioco», poi avvia la voce nuova e fotografa.
// Alla fine toglie la voce dal server di sviluppo. Serve python3 per creare lo ZIP.
//   node tools/dev/prova-libreria.mjs [url] [secondi di attesa]     FOTO=cartella  LOG=1
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const URL0 = process.argv[2] || 'http://127.0.0.1:8486/';
const ATTESA = Number(process.argv[3] || 45);
const VARIANTI = [{ nome: 'libreria', hw: {} }];
const FOTO = process.env.FOTO || '/tmp/retro486-libreria';
const JITPARAM = process.env.JITPARAM || '';
const LOG = !!process.env.LOG;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'r486-zip-'));
const ZIP = path.join(TMP, 'Prova Joystick.zip');
execFileSync('python3', ['-c', `
import zipfile, sys
z = zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED)
z.write(sys.argv[2], 'Prova Joystick v1.0/JOYTEST.COM')
z.writestr('Prova Joystick v1.0/Leggimi subito.txt', 'File con un nome lungo.\\r\\n' * 200)
z.writestr('Prova Joystick v1.0/Dati di gioco/livello uno.dat', bytes(range(256)) * 64)
z.close()`, ZIP, new URL('./joytest/JOYTEST.COM', import.meta.url).pathname]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const [n, v] of VARIANTI.entries()) {
  const PORT = 9390 + n;
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
    // 2: a macchina spenta aggiunge il gioco dal dialogo della LIBRERIA
    await portale(); await js(`retro486.mostra('libreria')`); await sleep(6000);
    const clic = (testo, dove = 'document') => js(`(() => { const b = [...${dove}.querySelectorAll('button')].filter((x) => x.textContent.trim().startsWith(${JSON.stringify(testo)})); const e = b[b.length - 1]; if (e) e.click(); return !!e; })()`);
    const foto = async (nome) => { fs.mkdirSync(FOTO, { recursive: true }); const r = await cdp('Page.captureScreenshot', { format: 'png' }); const f = path.join(FOTO, `${nome}.png`); fs.writeFileSync(f, Buffer.from(r.result.data, 'base64')); console.log(`${nome.padEnd(22)} ${f}`); };
    await clic('Aggiungi un gioco'); await sleep(1500);
    await js(`document.querySelector('.dialog .form button').click()`); await sleep(500);   // «Scegli...» dell'archivio
    const doc = await cdp('DOM.getDocument'); const q = await cdp('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: 'input[type=file]' });
    await cdp('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: [ZIP] }); await sleep(2500);
    await foto('1-dialogo');
    await clic('Aggiungi', `document.querySelector('.dialog')`); await sleep(6000);
    await foto('2-dopo-aggiungi');
    await clic('OK'); await sleep(4000);
    await foto('3-libreria');
    console.log('voci sul server:', await js(`fetch('api/stato.php').then((r) => r.json()).then((s) => JSON.stringify(s.libreria.filter((x) => x.utente)))`));
    console.log('file su C:', await js(`(async () => { const { Disco } = await import('./js/retro/disco.js'); const d = await Disco.apri(); return JSON.stringify(d.vol.tree('\\\\GIOCHI\\\\PROVAJOY')); })()`));
    // 3: avvia la voce nuova (l'ultimo pulsante «Avvia»)
    await clic('Avvia'); await sleep(ATTESA * 1000);
    await foto('4-avviato');
    // pulizia: la voce di prova non resta sul server di sviluppo
    await portale();
    console.log('pulizia:', await js(`fetch('api/libreria.php', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Retro486': '1' }, body: '[]' }).then((r) => r.text())`));
  } finally { ws?.close(); chrome.kill('SIGKILL'); fs.rmSync(prof, { recursive: true, force: true }); fs.rmSync(TMP, { recursive: true, force: true }); }
}
