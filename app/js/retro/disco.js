// Retro486 - l'hard disk C: a macchina spenta: lettura e modifica del file system
// FAT direttamente sull'immagine nello storage del browser.
//
// L'immagine viene letta tutta in memoria (258 MB), modificata con fat.js e
// riscritta solo nei blocchi da 64 KB che sono cambiati.

import * as storage from '../storage.js';
import { openImage } from '../fat.js';
import { hddRel, segnaModificato } from './server.js';

const BLOCK = 65536;

export class Disco {
  static async apri(nome = 'c') {
    const f = await storage.getFile(hddRel(nome));
    const img = new Uint8Array(await f.arrayBuffer());
    return new Disco(nome, img);
  }

  constructor(nome, img) {
    this.nome = nome;
    this.img = img;
    this.orig = img.slice();
    this.vol = openImage(img);
  }

  blocchiModificati() {
    const out = [];
    const a = this.img, b = this.orig;
    for (let o = 0; o < a.length; o += BLOCK) {
      const end = Math.min(o + BLOCK, a.length);
      // confronto a parole da 32 bit dove possibile
      let diff = false;
      if (o % 4 === 0 && end % 4 === 0) {
        const wa = new Uint32Array(a.buffer, a.byteOffset + o, (end - o) / 4);
        const wb = new Uint32Array(b.buffer, b.byteOffset + o, (end - o) / 4);
        for (let i = 0; i < wa.length; i++) if (wa[i] !== wb[i]) { diff = true; break; }
      } else {
        for (let i = o; i < end; i++) if (a[i] !== b[i]) { diff = true; break; }
      }
      if (diff) out.push([o, end]);
    }
    return out;
  }

  get modificato() { return this.blocchiModificati().length > 0; }

  async salva() {
    const ranges = this.blocchiModificati();
    if (!ranges.length) return 0;
    const root = await navigator.storage.getDirectory();
    let d = root;
    const parts = hddRel(this.nome).split('/');
    for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p);
    const fh = await d.getFileHandle(parts[parts.length - 1]);
    if (fh.createWritable) {
      const w = await fh.createWritable({ keepExistingData: true });
      for (const [s, e] of ranges) await w.write({ type: 'write', position: s, data: this.img.subarray(s, e) });
      await w.close();
    } else {
      await storage.writeFile(hddRel(this.nome), new Blob([this.img]));
    }
    this.orig = this.img.slice();
    segnaModificato();
    return ranges.length;
  }
}

// Comando di avvio di un gioco della libreria, eseguito da AUTOEXEC.BAT.
export function avvioBat(voce, profilo) {
  const dir = voce.cartella.replace(/^C:/i, '');
  const righe = ['@ECHO OFF', 'REM Scritto dal portale Retro486', 'C:', `CD ${dir}`];
  for (const r of voce.prima || []) righe.push(r);
  righe.push(voce.avvio);
  righe.push('CD \\');
  if (voce.spegni) righe.push('ECHO.', 'ECHO Puoi spegnere il computer.');
  return righe.join('\r\n') + '\r\n';
}

// Prepara il disco per l'accensione: AVVIO.BAT per un gioco, oppure niente.
export async function preparaAvvio({ voce = null, profilo = null } = {}) {
  const d = await Disco.apri();
  const v = d.vol;
  const path = '\\RETRO486\\AVVIO.BAT';
  if (!v.exists('\\RETRO486')) v.mkdir('\\RETRO486');
  if (voce) {
    v.writeFile(path, avvioBat(voce, profilo));
    // driver audio del gioco in base alla scheda MIDI del profilo
    const scelta = voce.audio && (profilo?.hw?.midi && profilo.hw.midi !== 'none' ? voce.audio.mt32 : voce.audio.adlib);
    if (scelta) {
      const f = `${voce.cartella.replace(/^C:/i, '')}\\${scelta.file}`;
      if (v.exists(f)) {
        const t = v.readText(f);
        const re = new RegExp(`^(\\s*${scelta.chiave}\\s*=\\s*).*$`, 'mi');
        if (re.test(t)) v.writeFile(f, t.replace(re, `$1${scelta.valore}`));
      }
    }
  } else if (v.exists(path)) {
    v.remove(path);
  }
  await d.salva();
}
