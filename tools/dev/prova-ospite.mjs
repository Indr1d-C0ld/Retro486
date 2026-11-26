#!/usr/bin/env node
// Retro486 - prova i due ruoli del portale: l'ospite (sito pubblico) non vede le scritture sul server
// e tiene i profili nel browser; l'admin vede tutto. Poi l'ospite accende un gioco.
//   node tools/dev/prova-ospite.mjs [url]     FOTO=cartella  LOG=1
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const URL0 = process.argv[2] || 'http://127.0.0.1:8486/';
const FOTO = process.env.FOTO || '/tmp/retro486-ospite';
const LOG = !!process.env.LOG;
const PORT = 9490;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'r486-p-'));
const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--window-size=1280,800', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
let ws, id = 0; const pend = new Map(); let falliti = 0;
const verifica = (cosa, ok) => { console.log(`${ok ? 'ok  ' : 'NO  '} ${cosa}`); if (!ok) falliti++; };
try {
  for (let i = 0; i < 50 && !ws; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); const p = l.find((t) => t.type === 'page' && t.url === 'about:blank'); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); } catch {} if (!ws) await sleep(200); }
  if (!ws) throw new Error('browser non raggiungibile'); if (ws.readyState !== 1) await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    else if (LOG && m.method === 'Runtime.consoleAPICalled') console.error('  [console]', m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 900)); });
  const cdp = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const js = async (e) => { const r = await cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) console.error('  [js]', r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text); return r.result?.result?.value; };
  const foto = async (nome) => { fs.mkdirSync(FOTO, { recursive: true }); const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(FOTO, `${nome}.png`), Buffer.from(r.result.data, 'base64')); };
  const testo = () => js('document.body.innerText');
  const portale = async (ruolo) => {
    await cdp('Page.navigate', { url: URL0 }); await sleep(1500);
    await js(`localStorage.setItem('retro486.ruolo', JSON.stringify('${ruolo}'))`);
    await cdp('Page.navigate', { url: URL0 });
    for (let i = 0; i < 120; i++) { if (await js('!!(window.retro486 && retro486.catalog && retro486.mostra)')) break; await sleep(500); }
    await sleep(1500);
  };
  const scheda = async (s, ms = 4000) => { await js(`retro486.mostra('${s}')`); await sleep(ms); return testo(); };
  await cdp('Page.enable'); if (LOG) await cdp('Runtime.enable');
  const profiliServer = async () => (await (await fetch(`${URL0}api/stato.php`)).json()).profili.length;
  const prima = await profiliServer();

  // ---- ospite
  await portale('ospite');
  verifica('ospite: ruolo', (await js('retro486.admin')) === false);
  verifica('ospite: "Accedi" nella barra di stato', (await testo()).includes('Accedi'));
  let t = await scheda('disco', 9000); await foto('ospite-disco');
  verifica('ospite: niente "Salva l\'hard disk sul server"', !t.includes('Salva l\'hard disk sul server'));
  verifica('ospite: "Scarica l\'immagine" c\'è', t.includes('Scarica l\'immagine'));
  t = await scheda('libreria'); await foto('ospite-libreria');
  verifica('ospite: niente "Aggiungi un gioco"', !t.includes('Aggiungi un gioco'));
  verifica('ospite: "Installa su C:" di Windows c\'è', t.includes('Installa su C:'));
  t = await scheda('configura');
  verifica('ospite: profili personali nel browser', t.includes('restano in questo browser'));
  await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Salva come profilo personale')?.click()`); await sleep(800);
  await js(`(() => { const i = document.querySelector('.dialog input'); if (i) { i.value = 'Profilo ospite di prova'; } [...document.querySelectorAll('.dialog button')].find((b) => /^(OK|Salva)$/.test(b.textContent.trim()))?.click(); })()`); await sleep(1500);
  const locali = await js(`JSON.parse(localStorage.getItem('retro486.profili') || '[]').map((p) => p.nome)`);
  verifica(`ospite: profilo salvato nel browser (${JSON.stringify(locali)})`, Array.isArray(locali) && locali.length === 1);
  verifica('ospite: nessun profilo scritto sul server', (await profiliServer()) === prima);
  await portale('ospite');
  verifica('ospite: il profilo resta dopo la ricarica', (await js(`retro486.profili.some((p) => p.nome === ${JSON.stringify(locali?.[0] || '?')} && !p.predefinito)`)) === true);

  // ---- admin
  await portale('admin');
  verifica('admin: ruolo', (await js('retro486.admin')) === true);
  verifica('admin: "ADMIN · Esci" nella barra di stato', (await testo()).includes('ADMIN · Esci'));
  t = await scheda('disco', 6000); await foto('admin-disco');
  verifica('admin: "Salva l\'hard disk sul server" c\'è', t.includes('Salva l\'hard disk sul server'));
  t = await scheda('libreria');
  verifica('admin: "Aggiungi un gioco" c\'è', t.includes('Aggiungi un gioco'));

  // ---- ospite che gioca
  await portale('ospite');
  await scheda('libreria'); await js(`[...document.querySelectorAll('article')].find((a) => a.querySelector('h3')?.textContent.includes('Larry'))?.querySelector('button')?.click()`);
  let vel = 0; for (let i = 0; i < 60 && !vel; i++) { await sleep(2000); vel = await js('window.web86box?.speedPercent || 0'); }
  await sleep(20000); await foto('ospite-gioco');
  verifica(`ospite: Larry 3 si accende (velocità ${await js('web86box.speedPercent')}%)`, vel > 0);
} finally { ws?.close(); chrome.kill('SIGKILL'); fs.rmSync(prof, { recursive: true, force: true }); }
console.log(falliti ? `${falliti} verifiche fallite` : 'tutte le verifiche passate');
process.exit(falliti ? 1 : 0);
