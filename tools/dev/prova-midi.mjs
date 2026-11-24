#!/usr/bin/env node
// Retro486 - prova il sintetizzatore MIDI: tools/dev/miditest/MIDITEST.COM suona un accordo sulla MPU-401
// a 330h e la pagina misura il livello dell'audio in uscita (RMS su un secondo) prima e durante.
// Con "midi":"none" il livello deve restare a zero; con MT-32 o OPL4-ML deve salire.
//   node tools/dev/prova-midi.mjs [url] [secondi di attesa]
//   VARIANTI='[{"nome":"gm","hw":{"midi":"opl4-ml","mpu":true}}]'  FOTO=cartella  LOG=1
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const URL0 = process.argv[2] || 'http://127.0.0.1:8486/';
const ATTESA = Number(process.argv[3] || 45);
const VARIANTI = process.env.VARIANTI ? JSON.parse(process.env.VARIANTI) : [{ nome: 'senza', hw: { midi: 'none', mpu: true } }, { nome: 'mt32', hw: { midi: 'mt32', mpu: true } }, { nome: 'opl4-ml', hw: { midi: 'opl4-ml', mpu: true } }];
const FOTO = process.env.FOTO || '/tmp/retro486-midi';
const JITPARAM = process.env.JITPARAM || '';
const LOG = !!process.env.LOG;
const COM = fs.readFileSync(new URL('./miditest/MIDITEST.COM', import.meta.url)).toString('base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const [n, v] of VARIANTI.entries()) {
  const PORT = 9400 + n;
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
    // 2: a macchina spenta scrive il programma sul disco e lo mette al posto del gioco in libreria
    await portale();
    const scritto = await js(`(async () => { const { Disco } = await import('./js/retro/disco.js'); const d = await Disco.apri();
      const b = Uint8Array.from(atob('${COM}'), (c) => c.charCodeAt(0));
      if (!d.vol.exists('\\\\PROVA')) d.vol.mkdir('\\\\PROVA'); d.vol.writeFile('\\\\PROVA\\\\MIDITEST.COM', b); await d.salva();
      const x = retro486.srv.libreria[0]; x.cartella = 'C:\\\\PROVA'; x.avvio = 'MIDITEST.COM'; x.audio = null; x.prima = ['ECHO MIDITEST:']; return b.length; })()`);
    console.error(`${v.nome}: MIDITEST.COM scritto (${scritto} byte)`);
    await avvia();
    // livello dell'uscita audio: un AnalyserNode sul nodo di 86Box, RMS massimo in un secondo
    const rms = () => js(`(async () => { const au = web86box.audio; if (!au?.node) return -1; await au.context.resume();
      if (!window.__an) { window.__an = au.context.createAnalyser(); window.__an.fftSize = 2048; au.node.connect(window.__an); }
      const b = new Float32Array(2048); let m = 0;
      for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 50)); window.__an.getFloatTimeDomainData(b); let q = 0; for (const x of b) q += x * x; m = Math.max(m, Math.sqrt(q / b.length)); }
      return Math.round(m * 10000) / 10000; })()`);
    await sleep(8000);
    const prima = await rms();
    await sleep(Math.max(0, ATTESA - 9) * 1000);
    const durante = await rms();
    fs.mkdirSync(FOTO, { recursive: true });
    const r = await cdp('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(FOTO, `${v.nome.replace(/[^a-z0-9]+/gi, '-')}.png`), Buffer.from(r.result.data, 'base64'));
    console.log(`${v.nome.padEnd(10)} livello prima ${prima}  con l'accordo ${durante}  stato audio ${await js('web86box.audio.context?.state')}`);
  } finally { ws?.close(); chrome.kill('SIGKILL'); fs.rmSync(prof, { recursive: true, force: true }); }
}
