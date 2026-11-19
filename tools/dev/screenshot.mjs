#!/usr/bin/env node
// Retro486 - screenshot del portale per il README, con Chromium headless e WebGL software.
//
//   node tools/dev/screenshot.mjs [http://127.0.0.1:8486/] [docs/img]
//
// Serve il server di sviluppo acceso (php -S ... tools/dev/router.php) e /usr/bin/chromium.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL0 = process.argv[2] || 'http://127.0.0.1:8486/';
const OUT = path.resolve(process.argv[3] || 'docs/img');
const W = 1280, H = 800;
fs.mkdirSync(OUT, { recursive: true });
const profilo = fs.mkdtempSync(path.join(os.tmpdir(), 'r486-chrome-'));
const PORT = 9333;

const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profilo}`, `--window-size=${W},${H}`,
  '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws, id = 0;
const pending = new Map();
async function connetti() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
    } catch { /* non ancora */ }
    await sleep(200);
  }
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
}
const cdp = (method, params = {}) => new Promise((resolve) => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
async function js(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
}
async function foto(nome) {
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, `${nome}.png`), Buffer.from(r.result.data, 'base64'));
  console.log('  ', nome);
}
async function vai(url) { await cdp('Page.navigate', { url }); await sleep(1500); }
async function pronto() { for (let i = 0; i < 120; i++) { if (await js('!!(window.retro486 && retro486.catalog && retro486.mostra)')) return; await sleep(500); } throw new Error('portale non pronto'); }
async function scheda(id, attesa = 1500) { await js(`retro486.mostra(${JSON.stringify(id)})`); await sleep(attesa); }
const clic = (testo) => js(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes(${JSON.stringify(testo)})); b?.click(); return !!b; })()`);

try {
  await connetti();
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await vai(URL0); await pronto();
  console.log('webgl2:', await js(`!!document.createElement('canvas').getContext('webgl2')`));

  await scheda('sistema'); await foto('01-sistema');
  await scheda('configura'); await foto('02-configura');
  // scarica il disco (prima volta) e apre C:\GIOCHI\LARRY3 con RESOURCE.CFG
  await js(`retro486.stato.cwd = '\\\\GIOCHI\\\\LARRY3'`);
  await scheda('disco', 8000);
  await js(`(() => { const f = [...document.querySelectorAll('.r-file')].find((e) => e.textContent.includes('RESOURCE.CFG')); f?.click(); })()`);
  await sleep(500); await foto('03-hard-disk');
  await scheda('libreria', 2500); await foto('04-libreria');
  await scheda('media'); await foto('05-media');
  await scheda('monitor', 2500); await foto('06-monitor-crt');

  // accensione: BIOS, menu di MS-DOS
  await scheda('sistema'); await clic('ACCENDI');
  const t0 = Date.now();
  const scatti = [[6000, '07-bios-post'], [30000, '08-ms-dos']];
  for (const [ms, nome] of scatti) { await sleep(Math.max(0, ms - (Date.now() - t0))); await foto(nome); }
  console.log('velocità emulazione:', await js('web86box.speedPercent'), '%');

  // Larry 3 dalla libreria
  await vai(URL0); await pronto();
  await scheda('libreria', 2500); await clic('Avvia');
  await sleep(4000); await pronto().catch(() => {});
  await sleep(45000); await foto('09-larry3');
} finally {
  ws?.close(); chrome.kill('SIGKILL');
  fs.rmSync(profilo, { recursive: true, force: true });
}
