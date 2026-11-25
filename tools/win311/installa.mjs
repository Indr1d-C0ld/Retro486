#!/usr/bin/env node
// Retro486 - installa Windows 3.11 dentro l'emulatore, senza intervento, e ne ricava il pacchetto
// che il portale copia su C:.
//
//   node tools/win311/installa.mjs [url]      FOTO=cartella  LOG=1  MINUTI=40  PROFILO=win31
//
// 1. prepara data/pacchetti/winsetup.zip con la cartella SETUP del CD e il file di risposte AUTO.SHH
// 2. apre il portale in un Chromium senza finestra, copia lo ZIP in C:\WINSETUP e accende il PC
//    con "SETUP /H:AUTO.SHH" al posto di un gioco
// 3. aspetta che l'hard disk resti fermo (SETUP finito), spegne e rilegge C:\WINDOWS
// 4. scrive data/pacchetti/windows311-grezzo.zip: l'installazione così come l'ha lasciata SETUP.
//    tools/win311/pacchetto.mjs la rifinisce (driver audio, video) e produce windows311.zip.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const URL0 = process.argv[2] || 'http://127.0.0.1:8486/';
const FOTO = process.env.FOTO || '/tmp/retro486-win311';
const MINUTI = Number(process.env.MINUTI || 40);
const PROFILO = process.env.PROFILO || 'win31';
const LOG = !!process.env.LOG;
const ISO = path.join(ROOT, 'media/os/win311-ita/WIN311ITA.iso');
const PAC = path.join(ROOT, 'data/pacchetti');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 1: lo ZIP con i file di installazione ---------------------------------------
fs.mkdirSync(PAC, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r486-win-'));
execFileSync('7z', ['x', '-y', '-bd', `-o${tmp}`, ISO], { stdio: 'ignore' });
fs.renameSync(path.join(tmp, 'SETUP'), path.join(tmp, 'WINSETUP'));
for (const f of fs.readdirSync(path.join(tmp, 'WINSETUP'))) if (!/^[^.]{1,8}(\.[^.]{0,3})?$/.test(f)) fs.rmSync(path.join(tmp, 'WINSETUP', f), { recursive: true }); // file estranei al CD originale, con nomi non 8.3
fs.copyFileSync(path.join(ROOT, 'tools/win311/AUTO.SHH'), path.join(tmp, 'WINSETUP/AUTO.SHH'));
fs.rmSync(path.join(PAC, 'winsetup.zip'), { force: true });
execFileSync('7z', ['a', '-tzip', '-mx=1', '-bd', path.join(PAC, 'winsetup.zip'), 'WINSETUP'], { cwd: tmp, stdio: 'ignore' });
fs.rmSync(tmp, { recursive: true, force: true });
console.error(`winsetup.zip: ${(fs.statSync(path.join(PAC, 'winsetup.zip')).size / 1048576).toFixed(1)} MB`);

// ---- 2: il browser ----------------------------------------------------------------
const PORT = 9420;
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
  const foto = async (nome) => { fs.mkdirSync(FOTO, { recursive: true }); const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(FOTO, `${nome}.png`), Buffer.from(r.result.data, 'base64')); };
  const portale = async () => { await cdp('Page.navigate', { url: URL0 }); for (let i = 0; i < 120; i++) { if (await js('!!(window.retro486 && retro486.catalog && retro486.mostra && retro486.srv)')) break; await sleep(500); }
    await js(`(() => { retro486.stato.profilo = '${PROFILO}'; retro486.crt.enabled = false; retro486.stato.rumori = false; })()`); };
  const avvia = async () => { await js(`retro486.mostra('libreria')`); await sleep(6000); await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Avvia'))?.click()`); };
  await cdp('Page.enable'); if (LOG) await cdp('Runtime.enable');
  // una prima accensione scarica l'hard disk nello storage del browser
  await portale(); await js(`retro486.srv.libreria[0].profilo = '${PROFILO}'`); await avvia();
  for (let i = 0; i < 90; i++) { await sleep(2000); if ((await js('web86box.speedPercent')) > 0) break; }
  await sleep(3000);
  // a macchina spenta: C:\WINSETUP
  await portale();
  const scritto = await js(`(async () => { const { Disco } = await import('./js/retro/disco.js'); const { readZip } = await import('./js/zip.js');
    const d = await Disco.apri(); const v = d.vol;
    if (v.exists('\\\\WINDOWS')) return 'C:\\\\WINDOWS esiste già';
    const voci = await readZip(await (await fetch('dati/pacchetti/winsetup.zip')).arrayBuffer());
    let n = 0;
    for (const f of voci) { if (f.name.endsWith('/')) continue; const parti = f.name.split('/'); let dir = '';
      for (const p of parti.slice(0, -1)) { dir += '\\\\' + p; if (!v.exists(dir)) v.mkdir(dir); }
      v.writeFile(dir + '\\\\' + parti[parti.length - 1], await f.read()); n++; }
    await d.salva();
    const x = retro486.srv.libreria[0]; x.titolo = 'Installazione di Windows 3.11'; x.cartella = 'C:\\\\WINSETUP'; x.avvio = 'SETUP /H:C:\\\\WINSETUP\\\\AUTO.SHH'; x.audio = null; x.profilo = '${PROFILO}';
    return n + ' file'; })()`);
  console.error(`C:\\WINSETUP: ${scritto}`);
  if (!/file$/.test(String(scritto))) throw new Error('copia non riuscita');
  await avvia();
  // ---- 3: SETUP lavora; finito quando l'hard disk resta fermo per due minuti ----------
  const inizio = Date.now(); let fermo = 0, n = 0;
  const attivita = () => js(`(() => { try { const s = web86box.statusIcons(); let a = 0; for (let i = 0; i < 256; i++) a += s.active[i] + s.write[i]; return a; } catch (e) { return -1; } })()`);
  while ((Date.now() - inizio) / 60000 < MINUTI) {
    let att = 0;
    for (let i = 0; i < 40; i++) { await sleep(500); if ((await attivita()) > 0) att++; }
    fermo = att ? 0 : fermo + 20;
    const min = ((Date.now() - inizio) / 60000).toFixed(1);
    await foto(`setup-${String(++n).padStart(3, '0')}`);
    console.error(`  ${min} min  attività disco ${att}/40  velocità ${await js('web86box.speedPercent')}%  fermo da ${fermo} s`);
    if (fermo >= 120 && Date.now() - inizio > 180000) break;
  }
  await foto('setup-fine');
  // ---- 4: spegne e rilegge il disco ---------------------------------------------------
  await portale();
  const info = await js(`(async () => { const { Disco } = await import('./js/retro/disco.js'); const { writeZip } = await import('./js/zip.js');
    const d = await Disco.apri(); const v = d.vol;
    if (!v.exists('\\\\WINDOWS\\\\WIN.COM')) return { errore: 'C:\\\\WINDOWS\\\\WIN.COM non c\\'è: SETUP non ha finito' };
    const file = [];
    const visita = (dir, rel) => { for (const x of v.list(dir)) { const p = dir + '\\\\' + x.name; if (x.isDir) visita(p, rel + x.name + '/'); else file.push({ name: rel + x.name, data: v.readFile(p), mtime: x.mtime }); } };
    visita('\\\\WINDOWS', 'WINDOWS/');
    const b = new Uint8Array(await writeZip(file).arrayBuffer());
    window.__zip = b; return { file: file.length, byte: b.length }; })()`);
  if (!info || info.errore) throw new Error(info?.errore || 'lettura del disco non riuscita');
  const out = fs.openSync(path.join(PAC, 'windows311-grezzo.zip'), 'w');
  const PEZZO = 3 << 20;
  for (let o = 0; o < info.byte; o += PEZZO) {
    const b64 = await js(`(() => { const s = window.__zip.subarray(${o}, ${Math.min(o + PEZZO, info.byte)}); let t = ''; for (let i = 0; i < s.length; i += 32768) t += String.fromCharCode.apply(null, s.subarray(i, i + 32768)); return btoa(t); })()`);
    fs.writeSync(out, Buffer.from(b64, 'base64'));
  }
  fs.closeSync(out);
  console.log(`windows311-grezzo.zip: ${info.file} file, ${(info.byte / 1048576).toFixed(1)} MB`);
} finally { ws?.close(); chrome.kill('SIGKILL'); fs.rmSync(prof, { recursive: true, force: true }); }
