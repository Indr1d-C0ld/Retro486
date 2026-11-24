#!/usr/bin/env node
// Retro486 - prova di PCem-WebAssembly: stessa scena (Larry 3 dal nostro C:) con interprete e JIT.
//   CPU=6 DYN=0 node tools/dev/misura-pcem.mjs [attesa s] [misura s]     (CPU: 6=DX/33 10=DX2/66 12=DX4/100)
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const ATTESA = Number(process.argv[2] || 60), MISURA = Number(process.argv[3] || 25);
const CPU = Number(process.env.CPU || 6), DYN = process.env.DYN === '1';
const FOTO = process.env.FOTO || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 9370;
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'r486-pc-'));
const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--window-size=1280,900', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
let ws, id = 0; const pend = new Map();
try {
  for (let i = 0; i < 50 && !ws; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); const p = l.find((t) => t.type === 'page' && t.url === 'about:blank'); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); } catch {} if (!ws) await sleep(200); }
  if (ws.readyState !== 1) await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const errs = [];
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails?.exception?.description?.slice(0, 200)); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const cdp = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const js = async (e) => { const r = await cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) return 'ECCEZIONE ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).slice(0, 300); return r.result?.result?.value; };
  const foto = async (n) => { if (!FOTO) return; const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`${FOTO}-${n}.png`, Buffer.from(r.result.data, 'base64')); };
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Page.navigate', { url: `http://127.0.0.1:8171/?system=media/c${CPU}-j${DYN ? 1 : 0}.json` });
  for (let i = 0; i < 120; i++) { if (await js('window.__pcem?.ready === true')) break; await sleep(500); }
  for (const t of [ATTESA]) { await sleep((t - (globalThis.__t || 0)) * 1000); globalThis.__t = t; await foto(t); }
  const s = [];
  for (let i = 0; i < MISURA; i++) { await sleep(1000); s.push(await js('window.__pcem.emu.speedPct()')); }
  await foto('fine');
  const media = Math.round(s.reduce((a, b) => a + b, 0) / s.length);
  console.log(`PCem cpu=${CPU} jit=${DYN}  media ${media}%  min ${Math.min(...s)}%  max ${Math.max(...s)}%`, DYN ? JSON.stringify(await js('window.__pcem.emu.Module.jitStats ? window.__pcem.emu.Module.jitStats() : null')) : '', errs.slice(0, 3).join(' | '));
} finally { ws?.close(); chrome.kill('SIGKILL'); fs.rmSync(prof, { recursive: true, force: true }); }
