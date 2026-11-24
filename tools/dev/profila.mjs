#!/usr/bin/env node
// Retro486 - profilo CPU dei thread di 86Box (worker) mentre gira un gioco della libreria.
//   node tools/dev/profila.mjs [url] [attesa s] [profilo s]
// Serve una build con i nomi delle funzioni (LINK_FLAGS=--profiling-funcs).
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const URL0 = process.argv[2] || 'http://127.0.0.1:8486/';
const ATTESA = Number(process.argv[3] || 45), DURATA = Number(process.argv[4] || 15);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 9360;
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'r486-p-'));
const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--window-size=1280,800', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
let ws, id = 0; const pend = new Map(); const workers = new Map();
try {
  for (let i = 0; i < 50 && !ws; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); const p = l.find((t) => t.type === 'page' && t.url === 'about:blank'); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); } catch {} if (!ws) await sleep(200); }
  if (ws.readyState !== 1) await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Target.attachedToTarget') workers.set(m.params.sessionId, m.params.targetInfo);
    if (m.method === 'Target.detachedFromTarget') workers.delete(m.params.sessionId);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  });
  const cdp = (method, params = {}, sessionId) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const js = async (e) => (await cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
  await cdp('Page.enable');
  await cdp('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await cdp('Page.navigate', { url: URL0 });
  for (let i = 0; i < 120; i++) { if (await js('!!(window.retro486 && retro486.catalog && retro486.mostra)')) break; await sleep(500); }
  await js(`retro486.crt.enabled = false; retro486.mostra('libreria')`); await sleep(9000);
  await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Avvia'))?.click()`);
  await sleep(ATTESA * 1000);
  console.log('velocità prima:', await js('web86box.speedPercent'), '% · worker:', workers.size);
  const sess = [...workers.keys()];
  await Promise.all(sess.map(async (s) => { await cdp('Profiler.enable', {}, s); await cdp('Profiler.setSamplingInterval', { interval: 500 }, s); await cdp('Profiler.start', {}, s); }));
  await sleep(DURATA * 1000);
  const res = await Promise.all(sess.map(async (s) => (await cdp('Profiler.stop', {}, s)).result?.profile));
  console.log('velocità durante il profilo:', await js('web86box.speedPercent'), '%');
  const tot = [];
  for (const p of res) {
    if (!p) continue;
    const self = new Map(); const byId = new Map(p.nodes.map((n) => [n.id, n]));
    const dt = p.timeDeltas || []; let all = 0;
    p.samples.forEach((sid, i) => { const n = byId.get(sid); const name = n.callFrame.functionName || '(anon)'; const d = dt[i] || 0; self.set(name, (self.get(name) || 0) + d); all += d; });
    let idle = 0; for (const [n, v] of self) if (/^\((idle|program)\)$|futex|timedwait|_emscripten_yield|emscripten_thread_sleep|Atomics/.test(n)) idle += v;
    tot.push({ busy: all - idle, all, self });
  }
  tot.sort((a, b) => b.busy - a.busy);
  for (const [k, t] of tot.slice(0, 4).entries()) {
    console.log(`\n== thread ${k + 1}: occupato ${(100 * t.busy / t.all).toFixed(0)}% di ${(t.all / 1e6).toFixed(1)} s`);
    [...t.self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 28).forEach(([n, v]) => console.log(`${(100 * v / t.all).toFixed(1).padStart(5)}%  ${n.slice(0, 90)}`));
  }
} finally { ws?.close(); chrome.kill('SIGKILL'); fs.rmSync(prof, { recursive: true, force: true }); }
