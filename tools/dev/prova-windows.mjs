#!/usr/bin/env node
// Retro486 - prova Windows 3.11: lo installa dal portale (LIBRERIA, "Installa su C:"), lo avvia
// e guarda che cosa succede: schermate a intervalli, velocità e livello dell'audio
// (all'avvio Windows suona un file .WAV: se il livello sale, il driver Sound Blaster funziona).
//   node tools/dev/prova-windows.mjs [url] [secondi]
//   VARIANTI='[{"nome":"s3","profilo":"dx2-66"},{"nome":"interprete","hw":{"jit":false}}]'  FOTO=cartella  LOG=1
//   in una variante: "profilo" (predefinito win31), "hw" (modifiche al profilo win31), "comando" (al posto di WIN), "tasti" (codici di scansione premuti dopo "dopo" secondi, es. [57] = spazio)
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const URL0 = process.argv[2] || 'http://127.0.0.1:8486/';
const ATTESA = Number(process.argv[3] || 90);
const VARIANTI = process.env.VARIANTI ? JSON.parse(process.env.VARIANTI) : [{ nome: 'win31' }];
const FOTO = process.env.FOTO || '/tmp/retro486-windows';
const LOG = !!process.env.LOG;
const PORTA = Number(process.env.PORTA || 9430);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const [n, v] of VARIANTI.entries()) {
  const PORT = PORTA + n;
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'r486-p-'));
  const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--window-size=1280,900', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
  let ws, id = 0; const pend = new Map();
  try {
    for (let i = 0; i < 50 && !ws; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); const p = l.find((t) => t.type === 'page' && t.url === 'about:blank'); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); } catch {} if (!ws) await sleep(200); }
    if (!ws) throw new Error('browser non raggiungibile'); if (ws.readyState !== 1) await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
      else if (LOG && m.method === 'Runtime.consoleAPICalled') console.error('  [console]', m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 900));
      else if (LOG && m.method === 'Runtime.exceptionThrown') console.error('  [eccezione]', (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 600)); });
    const cdp = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const js = async (e) => { const r = await cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) console.error('  [js]', r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text); return r.result?.result?.value; };
    const nomeFile = v.nome.replace(/[^a-z0-9]+/gi, '-');
    const foto = async (quando) => { fs.mkdirSync(FOTO, { recursive: true }); const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(FOTO, `${nomeFile}-${quando}.png`), Buffer.from(r.result.data, 'base64')); };
    const portale = async () => { await cdp('Page.navigate', { url: URL0 }); for (let i = 0; i < 120; i++) { if (await js('!!(window.retro486 && retro486.catalog && retro486.mostra && retro486.srv)')) break; await sleep(500); }
      await js(`(() => { const p = retro486.profili.find((x) => x.id === 'win31'); Object.assign(p.hw, ${JSON.stringify(v.hw || {})}); retro486.stato.profilo = ${JSON.stringify(v.profilo || 'win31')}; retro486.crt.enabled = false; retro486.stato.rumori = false; retro486.stato.soloSchermo = true; retro486.srv.libreria[0].profilo = 'win31'; })()`); };
    const avvia = async () => { await js(`retro486.mostra('libreria')`); await sleep(6000); await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Avvia'))?.click()`); };
    await cdp('Page.enable'); if (LOG) await cdp('Runtime.enable');
    await portale(); await avvia();
    for (let i = 0; i < 90; i++) { await sleep(2000); if ((await js('web86box.speedPercent')) > 0) break; }
    await sleep(3000);
    await portale();
    // installa dal portale: LIBRERIA, scheda "Windows 3.11", "Installa su C:"
    await js(`retro486.mostra('libreria')`); await sleep(6000);
    const premi = (titolo, testo) => js(`(() => { const a = [...document.querySelectorAll('article')].find((x) => x.querySelector('h3')?.textContent === ${JSON.stringify(titolo)}); const b = a && [...a.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(testo)}); if (b) b.click(); return !!b; })()`);
    if (!(await premi('Windows 3.11', 'Installa su C:'))) throw new Error('scheda di Windows 3.11 o pulsante "Installa su C:" non trovati');
    let esito = '';
    for (let i = 0; i < 120 && !esito; i++) { await sleep(1000); esito = await js(`[...document.querySelectorAll('.dialog, dialog, .r-dialog, [role=dialog]')].map((d) => d.textContent).find((t) => /è in C:|non riuscita/.test(t)) || ''`); }
    console.error(`${v.nome}: ${esito.replace(/\s+/g, ' ').slice(0, 110) || 'nessun esito dall\'installazione'}`);
    await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'OK')?.click()`); await sleep(5000);
    await js(`(() => { retro486.stato.profilo = ${JSON.stringify(v.profilo || 'win31')}; })()`);
    const ini = await js(`(async () => { const { Disco } = await import('./js/retro/disco.js'); const d = await Disco.apri(); return d.vol.exists('\\\\WINDOWS\\\\WIN.COM') ? d.vol.list('\\\\WINDOWS').length : 0; })()`);
    console.error(`${v.nome}: C:\\WINDOWS ha ${ini} voci`);
    if (v.comando) { await js(`(() => { const x = retro486.srv.libreria[0]; x.titolo = 'Prova'; x.cartella = 'C:\\\\WINDOWS'; x.avvio = ${JSON.stringify(v.comando)}; x.audio = null; x.profilo = null; })()`);
      await js(`retro486.mostra('libreria')`); await sleep(6000); await premi('Prova', 'Avvia');
    } else { await js(`retro486.mostra('libreria')`); await sleep(6000); if (!(await premi('Windows 3.11', 'Avvia'))) throw new Error('pulsante "Avvia" di Windows non trovato'); }
    const rms = () => js(`(async () => { const au = web86box.audio; if (!au?.node) return -1; await au.context.resume();
      if (!window.__an) { window.__an = au.context.createAnalyser(); window.__an.fftSize = 2048; au.node.connect(window.__an); }
      const b = new Float32Array(2048); let m = 0;
      for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 50)); window.__an.getFloatTimeDomainData(b); let q = 0; for (const x of b) q += x * x; m = Math.max(m, Math.sqrt(q / b.length)); }
      return Math.round(m * 10000) / 10000; })()`);
    const inizio = Date.now(); let massimo = 0, quando = 0, k = 0, battuto = false; const vel = [], serie = [];
    while ((Date.now() - inizio) / 1000 < ATTESA) {
      const r = await rms(); const t = Math.round((Date.now() - inizio) / 1000);
      serie.push(`${t}:${r}`); if (t >= 20 && r > massimo) { massimo = r; quando = t; } // i primi secondi sono il bip del BIOS
      vel.push(await js('web86box.speedPercent'));
      if (++k % 5 === 0) await foto(`${String(t).padStart(3, '0')}s`);
      if (v.tasti && !battuto && t >= (v.dopo || 60)) { battuto = true; for (const c of v.tasti) { await js(`web86box.key(true, ${c})`); await sleep(120); await js(`web86box.key(false, ${c})`); await sleep(400); } }
    }
    await foto('fine');
    const ult = vel.slice(-10); const media = Math.round(ult.reduce((a, b) => a + b, 0) / ult.length);
    if (LOG || process.env.SERIE) console.error('  audio (secondi:livello) ' + serie.join(' '));
    console.log(`${v.nome.padEnd(14)} audio massimo dopo 20 s ${massimo} (a ${quando} s)  velocità finale ${media}%  ${await js(`document.querySelector('.statusbar, .status-bar')?.textContent?.trim().slice(-60) || ''`)}`);
  } finally { ws?.close(); chrome.kill('SIGKILL'); fs.rmSync(prof, { recursive: true, force: true }); }
}
