#!/usr/bin/env node
// Retro486 - prepara l'hard disk C: con MS-DOS 6.22 già installato.
//
//   node tools/crea-disco.mjs [--cilindri 500] [--senza-giochi] [--uscita data/dischi/c.img]
//
// Fa quello che farebbero FDISK, FORMAT C: /S e SETUP: tabella delle partizioni
// con una partizione FAT16 attiva, settore di avvio di MS-DOS (preso dal disco 1),
// IO.SYS e MSDOS.SYS come prime voci e contigui, tutti i file dei quattro dischi
// espansi in C:\DOS, CONFIG.SYS e AUTOEXEC.BAT. Poi i driver liberi in C:\DRIVERS
// e i giochi di tools/libreria.json in C:\GIOCHI.
//
// Geometria: 16 testine, 63 settori per traccia, N cilindri (500 = 258 MB),
// da riportare nel profilo di 86Box (hdd_01_parameters = 63, 16, N, 0, ide).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FatVolume, openImage, writeMbr, ATTR, sanitizeName } from '../app/js/fat.js';
import { expandAny } from '../app/js/expand.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const CYL = Number(opt('--cilindri', 500));
const OUT = path.resolve(ROOT, opt('--uscita', 'data/dischi/c.img'));
const DOSDIR = path.resolve(ROOT, opt('--dos', 'media/os/msdos-6.22-ita'));
const CON_GIOCHI = !args.includes('--senza-giochi');

const HEADS = 16, SPT = 63, START = SPT;
const totalSectors = CYL * HEADS * SPT;
const partSectors = totalSectors - START;
const img = new Uint8Array(totalSectors * 512);

const read = (p) => new Uint8Array(fs.readFileSync(p));
const floppies = [1, 2, 3, 4].map((n) => openImage(read(path.join(DOSDIR, `Disk0${n}.img`))));
const disk1 = floppies[0];
const log = (...a) => console.log(...a);

// ---- MBR e settore di avvio -------------------------------------------------

const mbrCode = read(path.join(ROOT, 'tools/mbr/mbr.bin'));
writeMbr(img, { code: mbrCode, geometry: { heads: HEADS, spt: SPT }, startLba: START, sectors: partSectors, type: partSectors < 65536 ? 0x04 : 0x06 });

const floppyBoot = disk1.img.subarray(0, 512);
const vol = FatVolume.format(img, {
  offset: START * 512, sectors: partSectors, bootSector: floppyBoot, label: 'RETRO486',
  hidden: START, heads: HEADS, spt: SPT, media: 0xf8, drive: 0x80, labelEntry: false,
});
log(`Partizione FAT${vol.fat16 ? 16 : 12}: ${(vol.totalBytes / 1048576).toFixed(1)} MB, cluster da ${vol.clusterBytes} byte`);

// ---- file di sistema (FORMAT /S) -----------------------------------------------

const SYS = ATTR.RO | ATTR.HIDDEN | ATTR.SYSTEM;
const when = new Date(1994, 4, 31, 6, 22, 0); // data dei file di MS-DOS 6.22
vol.writeFile('\\IO.SYS', disk1.readFile('IO.SYS'), { attr: SYS, when: disk1.lookup('IO.SYS').mtime, contiguous: true });
vol.writeFile('\\MSDOS.SYS', disk1.readFile('MSDOS.SYS'), { attr: SYS, when: disk1.lookup('MSDOS.SYS').mtime, contiguous: true });
vol.setLabel('RETRO486');
vol.writeFile('\\COMMAND.COM', disk1.readFile('COMMAND.COM'), { when: disk1.lookup('COMMAND.COM').mtime });

// ---- C:\DOS (SETUP) ---------------------------------------------------------

// PACKING.LST: nome sul disco -> nome espanso
const packing = new Map();
for (const line of disk1.readText('PACKING.LST').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_$~!#%&'()@^`{}-]+\.[A-Z0-9_$]{1,3})\s+([A-Z0-9_$~!#%&'()@^`{}-]+\.[A-Z0-9_$]{1,3})\s*$/);
  if (m) packing.set(m[1], m[2]);
}
const EXT = { EX_: 'EXE', CO_: 'COM', SY_: 'SYS', CP_: 'CPI', HL_: 'HLP', DL_: 'DLL', TX_: 'TXT', OV_: 'OVL',
  GR_: 'GRB', VI_: 'VID', BA_: 'BAS', PR_: 'PRO', LS_: 'LST', DO_: 'DOS', '38_': '386', IN_: 'INI' };
const expandedName = (n) => packing.get(n) ?? (n.endsWith('_') ? n.slice(0, n.lastIndexOf('.') + 1) + (EXT[n.slice(-3)] ?? n.slice(-3)) : n);

// File del programma di installazione, che su un disco già installato non servono.
const SKIP = new Set(['IO.SYS', 'MSDOS.SYS', 'AUTOEXEC.BAT', 'CONFIG.SYS', 'SETUP.EXE', 'SETUP.MSG', 'DOSSETUP.INI',
  'SETUP.BAT', 'SD6COPY.BAT', '720ID01.BAT', '720ID02.BAT', 'DRVSPACE.BIN', 'KBDBUF.SYS']);

vol.mkdir('\\DOS', { when });
let count = 0, bytes = 0;
const done = new Set();
floppies.forEach((fl, i) => {
  for (const e of fl.list('\\')) {
    if (e.isDir || SKIP.has(e.name)) continue;
    const name = expandedName(e.name);
    if (done.has(name)) continue;
    let data = fl.readFile(e);
    try { data = expandAny(data); } catch (err) { throw new Error(`Disco ${i + 1}, ${e.name}: ${err.message}`); }
    vol.writeFile(`\\DOS\\${name}`, data, { when: e.mtime ?? when });
    done.add(name); count++; bytes += data.length;
  }
});
log(`C:\\DOS: ${count} file, ${(bytes / 1048576).toFixed(1)} MB espansi`);

// ---- driver liberi ---------------------------------------------------------------

vol.mkdir('\\DRIVERS');
for (const f of ['CTMOUSE.EXE', 'UDVD2.SYS', 'CTMOUSE.LSM', 'UDVD2.LSM'])
  vol.writeFile(`\\DRIVERS\\${f}`, read(path.join(ROOT, 'tools/disco/driver', f)));

vol.mkdir('\\TEMP');
vol.mkdir('\\RETRO486');

// ---- CONFIG.SYS e AUTOEXEC.BAT --------------------------------------------------

vol.writeFile('\\CONFIG.SYS', `[MENU]
MENUITEM=GIOCHI, Giochi: memoria estesa ed espansa (XMS + EMS)
MENUITEM=XMS, Giochi: solo memoria estesa (XMS)
MENUITEM=MINIMO, Configurazione minima (nessun driver)
MENUDEFAULT=GIOCHI, 3
MENUCOLOR=15, 1

[COMMON]
FILES=40
BUFFERS=20
LASTDRIVE=Z
COUNTRY=039,437,C:\\DOS\\COUNTRY.SYS

[GIOCHI]
DEVICE=C:\\DOS\\HIMEM.SYS /TESTMEM:OFF
DEVICE=C:\\DOS\\EMM386.EXE RAM
DOS=HIGH,UMB
DEVICEHIGH=C:\\DRIVERS\\UDVD2.SYS /D:CDROM001

[XMS]
DEVICE=C:\\DOS\\HIMEM.SYS /TESTMEM:OFF
DOS=HIGH
DEVICE=C:\\DRIVERS\\UDVD2.SYS /D:CDROM001

[MINIMO]
`);

vol.writeFile('\\AUTOEXEC.BAT', `@ECHO OFF
PROMPT $P$G
PATH C:\\DOS;C:\\DRIVERS;C:\\RETRO486
SET TEMP=C:\\TEMP
SET BLASTER=A220 I5 D1 H5 P330 T6
IF "%CONFIG%"=="MINIMO" GOTO TASTIERA
LH C:\\DOS\\SMARTDRV.EXE /X
LH C:\\DOS\\MSCDEX.EXE /D:CDROM001 /L:D
LH C:\\DRIVERS\\CTMOUSE.EXE
:TASTIERA
LH C:\\DOS\\KEYB IT,437,C:\\DOS\\KEYBOARD.SYS
REM Retro486: il portale scrive qui il comando di avvio di un gioco della libreria
IF EXIST C:\\RETRO486\\AVVIO.BAT C:\\RETRO486\\AVVIO.BAT
`);

vol.writeFile('\\RETRO486\\LEGGIMI.TXT', `RETRO486 - PC 486 virtuale

Hard disk C: preparato con MS-DOS 6.22 (italiano).

C:\\DOS        MS-DOS 6.22
C:\\DRIVERS    CuteMouse (mouse) e UDVD2 (CD-ROM ATAPI), da FreeDOS
C:\\GIOCHI     giochi installati dal portale
C:\\RETRO486   file del portale: AVVIO.BAT avvia un gioco all'accensione

Scheda audio: Sound Blaster 16, A220 I5 D1 H5, MPU-401 a 330h
Unita' D: CD-ROM (MSCDEX)
`);

// ---- giochi ---------------------------------------------------------------------------

function copyTree(src, dest) {
  vol.mkdirp(dest);
  const taken = new Set();
  let n = 0;
  for (const ent of fs.readdirSync(src, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    let name;
    try { name = sanitizeName(ent.name, taken); } catch { continue; }
    if (name !== ent.name.toUpperCase()) { log(`   salto ${ent.name} (nome non 8.3)`); continue; }
    taken.add(name);
    const p = path.join(src, ent.name);
    if (ent.isDirectory()) n += copyTree(p, `${dest}\\${name}`);
    else if (ent.isFile()) { vol.writeFile(`${dest}\\${name}`, read(p), { when: fs.statSync(p).mtime }); n++; }
  }
  return n;
}

function setCfg(volPath, key, value) {
  const text = vol.readText(volPath);
  const re = new RegExp(`^(\\s*${key}\\s*=\\s*).*$`, 'mi');
  vol.writeFile(volPath, re.test(text) ? text.replace(re, `$1${value}`) : `${text.trimEnd()}\r\n ${key} = ${value}\r\n`);
}

const libreria = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/libreria.json'), 'utf8'));
const installati = [];
if (CON_GIOCHI) {
  vol.mkdir('\\GIOCHI');
  for (const v of libreria.voci) {
    const src = v.sorgente.replace(/^~/, os.homedir());
    if (!fs.existsSync(src)) { log(`!  ${v.titolo}: sorgente assente (${src}), salto`); continue; }
    const dest = v.cartella.replace(/^C:/i, '');
    const n = copyTree(src, dest);
    if (v.audio?.mt32) setCfg(`${dest}\\${v.audio.mt32.file}`, v.audio.mt32.chiave, v.audio.mt32.valore);
    log(`   ${v.titolo}: ${n} file in ${v.cartella}`);
    installati.push(v.id);
  }
}

// ---- scrittura --------------------------------------------------------------------------

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, img);
const info = {
  file: path.basename(OUT), cilindri: CYL, testine: HEADS, settori: SPT, byte: img.length,
  etichetta: vol.label, liberi: vol.freeBytes, giochi: installati, creato: new Date().toISOString(),
};
fs.writeFileSync(OUT.replace(/\.img$/, '.json'), JSON.stringify(info, null, 2) + '\n');
log(`Scritto ${path.relative(ROOT, OUT)}: ${(img.length / 1048576).toFixed(0)} MB, liberi ${(vol.freeBytes / 1048576).toFixed(1)} MB`);
log(`86Box: hdd_01_parameters = ${SPT}, ${HEADS}, ${CYL}, 0, ide`);
