#!/usr/bin/env node
// Retro486 - rifinisce l'installazione di Windows 3.11 lasciata da SETUP (tools/win311/installa.mjs)
// e produce data/pacchetti/windows311.zip, il pacchetto che il portale copia in C:\WINDOWS.
//
//   node tools/win311/pacchetto.mjs [--risoluzione 1|2|3] [--uscita file.zip]
//
// Aggiunge i driver video e audio del CD che SETUP non copia, adatta SYSTEM.INI al profilo
// "Postazione Windows 3.11" (lo stesso codice che il portale usa a ogni accensione) e toglie i residui.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IniWin, adattaSystemIni, SVGA } from '../../app/js/retro/windows.js';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const RIS = Number(opt('--risoluzione', 2)); // 1 = 640x480, 2 = 800x600, 3 = 1024x768
const PAC = path.join(ROOT, 'data/pacchetti');
const OUT = path.resolve(opt('--uscita', path.join(PAC, 'windows311.zip')));
const ISO = path.join(ROOT, 'media/os/win311-ita/WIN311ITA.iso');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r486-pac-'));
execFileSync('7z', ['x', '-y', '-bd', `-o${tmp}/cd`, ISO], { stdio: 'ignore' });
execFileSync('7z', ['x', '-y', '-bd', `-o${tmp}/w`, path.join(PAC, 'windows311-grezzo.zip')], { stdio: 'ignore' });
const W = path.join(tmp, 'w/WINDOWS'), CD = path.join(tmp, 'cd/SETUP');
const dalCd = (...nomi) => { for (const n of nomi) fs.copyFileSync(path.join(CD, n), path.join(W, 'SYSTEM', n)); };

// Tutti i driver del CD che il portale può scegliere all'accensione (app/js/retro/windows.js)
dalCd('SVGA256.DRV', 'VDDSVGA.386', 'VGADIB.3GR', 'SNDBLST2.DRV', 'VSBD.386', 'MSADLIB.DRV', 'VADLIBD.386', 'MPU401.DRV');
const HW = { video: 'et4000w32_vlb', sound: 'sb16', midi: 'opl4-ml', mpu: true }; // il profilo "Postazione Windows 3.11"
const fsys = path.join(W, 'SYSTEM.INI');
fs.writeFileSync(fsys, adattaSystemIni(fs.readFileSync(fsys, 'latin1'), HW, (n) => fs.existsSync(path.join(W, 'SYSTEM', n)), { risoluzione: RIS }), 'latin1');
// sul CD manca TADA.WAV: all'avvio suona CHIMES.WAV
const win = new IniWin(fs.readFileSync(path.join(W, 'WIN.INI'), 'latin1'));
win.set('Sounds', 'SystemStart', 'chimes.wav, Avvio di Windows');
win.set('Sounds', 'SystemExit', 'chord.wav, Uscita da Windows');
fs.writeFileSync(path.join(W, 'WIN.INI'), win.toString(), 'latin1');

// ---- residui dell'installazione ------------------------------------------------------
for (const f of ['BOOTLOG.TXT', 'WINMATIC.SHH', 'CONFIG.WIN', 'AUTOEXEC.WIN']) fs.rmSync(path.join(W, f), { force: true });

fs.rmSync(OUT, { force: true });
execFileSync('7z', ['a', '-tzip', '-mx=9', '-bd', OUT, 'WINDOWS'], { cwd: path.join(tmp, 'w'), stdio: 'ignore' });
const n = fs.readdirSync(W, { recursive: true }).length;
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${path.relative(ROOT, OUT)}: ${n} voci, ${(fs.statSync(OUT).size / 1048576).toFixed(1)} MB, schermo predefinito ${SVGA[RIS]}`);
