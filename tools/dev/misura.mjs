#!/usr/bin/env node
// Retro486 - misura la velocità di emulazione in un gioco della libreria, per varianti.
//   node tools/dev/misura.mjs [url] [secondi di attesa] [secondi di misura]
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const [n, v] of VARIANTI.entries()) {
  const PORT = 9340 + n;
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'r486-m-'));
  const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--window-size=1280,800', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
  let ws, id = 0; const pend = new Map();
  try {
    for (let i = 0; i < 50 && !ws; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); const p = l.find((t) => t.type === 'page' && t.url === 'about:blank'); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); } catch {} if (!ws) await sleep(200); }
    if (!ws) throw new Error('browser non raggiungibile'); if (ws.readyState !== 1) await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
    const cdp = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const js = async (e) => (await cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
    console.error('connesso'); await cdp('Page.enable'); console.error('page.enable');
    await cdp('Page.navigate', { url: URL0 });
    for (let i = 0; i < 120; i++) { if (await js('!!(window.retro486 && retro486.catalog && retro486.mostra)')) break; await sleep(500); }
    await js(`(() => { const p = retro486.profili.find((x) => x.id === 'dx33'); Object.assign(p.hw, ${JSON.stringify(v.hw)}); retro486.stato.profilo = 'dx33'; retro486.crt.enabled = ${v.crt}; })()`);
    console.error('portale pronto'); await js(`retro486.mostra('libreria')`); await sleep(9000); console.error('libreria');
    await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Avvia'))?.click()`);
    await sleep(ATTESA * 1000);
    const s = [];
    for (let i = 0; i < MISURA; i++) { await sleep(1000); s.push(await js('web86box.speedPercent')); }
    const media = Math.round(s.reduce((a, b) => a + b, 0) / s.length);
    console.log(`${v.nome.padEnd(28)} media ${String(media).padStart(3)}%  min ${Math.min(...s)}%  max ${Math.max(...s)}%   ${await js('document.title.split(" - ").slice(3,5).join(" ")')}`);
  } finally { ws?.close(); chrome.kill('SIGKILL'); fs.rmSync(prof, { recursive: true, force: true }); }
}
