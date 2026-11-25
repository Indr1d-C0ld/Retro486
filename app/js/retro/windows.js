// Retro486 - Windows 3.11 sull'hard disk C:: adatta SYSTEM.INI all'hardware del profilo con cui si
// accende, come farebbero Setup e il Pannello di controllo, usando solo i driver del CD originale.
//
//  schermo  Tseng ET4000 (AX, W32): Super VGA a 256 colori (svga256.drv); ogni altra scheda: VGA a 16 colori.
//           Un driver diverso da questi due (installato a mano, es. S3) non viene toccato.
//  audio    Sound Blaster: driver "Sound Blaster 1.5" (8 bit mono, lo capiscono anche SB Pro e SB16)
//           e sintesi FM Ad Lib; MPU-401 Roland a 330h se il profilo ha un sintetizzatore MIDI.
//
// Senza dipendenze dal browser: lo usa anche tools/win311/pacchetto.mjs.

// File .INI di Windows: si lavora sulle righe, perché in [386Enh] "device=" si ripete.
export class IniWin {
  constructor(testo) { this.righe = testo.split(/\r?\n/); }
  toString() { return this.righe.join('\r\n'); }
  _sez(nome, crea = false) {
    const i = this.righe.findIndex((r) => r.trim().toLowerCase() === `[${nome.toLowerCase()}]`);
    if (i >= 0 || !crea) return i;
    while (this.righe.length && this.righe.at(-1).trim() === '') this.righe.pop();
    this.righe.push('', `[${nome}]`, '');
    return this.righe.length - 2;
  }
  _fine(i) {
    let j = i + 1;
    while (j < this.righe.length && !/^\s*\[/.test(this.righe[j])) j++;
    while (j > i + 1 && this.righe[j - 1].trim() === '') j--;
    return j;
  }
  _riga(sez, chiave) {
    const i = this._sez(sez);
    if (i < 0) return -1;
    for (let j = i + 1, f = this._fine(i); j < f; j++) if (this.righe[j].split('=')[0].trim().toLowerCase() === chiave.toLowerCase()) return j;
    return -1;
  }
  get(sez, chiave) { const j = this._riga(sez, chiave); return j < 0 ? null : this.righe[j].slice(this.righe[j].indexOf('=') + 1).trim(); }
  set(sez, chiave, valore) {
    const j = this._riga(sez, chiave);
    if (j >= 0) this.righe[j] = `${chiave}=${valore}`;
    else this.righe.splice(this._fine(this._sez(sez, true)), 0, `${chiave}=${valore}`);
  }
  // imposta solo se manca: non si calpesta una scelta fatta dentro Windows
  predefinito(sez, chiave, valore) { if (this.get(sez, chiave) === null) this.set(sez, chiave, valore); }
  togli(sez, chiave, seVale = null) {
    const j = this._riga(sez, chiave);
    if (j >= 0 && (seVale === null || this.get(sez, chiave).toLowerCase() === seVale.toLowerCase())) this.righe.splice(j, 1);
  }
  // righe ripetute, es. device=vsbd.386
  haRiga(sez, riga) { const i = this._sez(sez); if (i < 0) return false; for (let j = i + 1, f = this._fine(i); j < f; j++) if (this.righe[j].replace(/\s/g, '').toLowerCase() === riga.toLowerCase()) return true; return false; }
  aggiungiRiga(sez, riga) { if (!this.haRiga(sez, riga)) this.righe.splice(this._fine(this._sez(sez, true)), 0, riga); }
  togliRiga(sez, riga) { const i = this._sez(sez); if (i < 0) return; for (let j = this._fine(i) - 1; j > i; j--) if (this.righe[j].replace(/\s/g, '').toLowerCase() === riga.toLowerCase()) this.righe.splice(j, 1); }
}

export const SVGA = { 1: 'Super VGA 640x480 256 colors', 2: 'Super VGA 800x600 256 colors Small Fonts', 3: 'Super VGA 1024x768 256 colors Small Fonts' };

// Quello che Windows userà con questo hardware (per dirlo nel portale).
export function sceltePerHw(hw) {
  return {
    svga: /^et4000/.test(hw.video || ''),
    sb: /^sb/.test(hw.sound || ''),
    mpu: !!hw.mpu && !!hw.midi && hw.midi !== 'none',
  };
}

// testo: SYSTEM.INI; hw: l'hardware del profilo; ha(nome): il file c'è in WINDOWS\SYSTEM.
// risoluzione: 1, 2 o 3 per imporla, altrimenti resta quella scritta in SYSTEM.INI (di serie 800x600).
export function adattaSystemIni(testo, hw, ha, { risoluzione = null } = {}) {
  const ini = new IniWin(testo);
  const s = sceltePerHw(hw);

  const drv = (ini.get('boot', 'display.drv') || '').toLowerCase();
  if (drv === 'vga.drv' || drv === 'svga256.drv') {
    if (s.svga && ha('SVGA256.DRV') && ha('VDDSVGA.386') && ha('VGADIB.3GR')) {
      const ris = [1, 2, 3].includes(Number(risoluzione)) ? Number(risoluzione) : (Number(ini.get('svga256.drv', 'resolution')) || 2);
      ini.set('boot', 'display.drv', 'svga256.drv');
      ini.set('boot', '386grabber', 'vgadib.3gr');
      ini.set('boot.description', 'display.drv', SVGA[ris] || SVGA[2]);
      ini.set('386Enh', 'display', 'vddsvga.386');
      ini.set('386Enh', 'SysVMIn2ndBank', 'FALSE');
      ini.set('svga256.drv', 'resolution', String(ris));
      ini.predefinito('svga256.drv', 'dpi', '96');
    } else if (ha('VGA.DRV') && ha('VGA.3GR')) {
      ini.set('boot', 'display.drv', 'vga.drv');
      ini.set('boot', '386grabber', 'vga.3gr');
      ini.set('boot.description', 'display.drv', 'VGA');
      ini.set('386Enh', 'display', '*vddvga');
    }
  }

  if (s.sb && ha('SNDBLST2.DRV') && ha('VSBD.386')) {
    ini.aggiungiRiga('386Enh', 'device=vsbd.386');
    ini.set('drivers', 'Wave', 'sndblst2.drv');
    ini.predefinito('sndblst.drv', 'port', '220');
    ini.predefinito('sndblst.drv', 'int', '5');
  } else {
    ini.togli('drivers', 'Wave', 'sndblst2.drv');
    ini.togliRiga('386Enh', 'device=vsbd.386');
  }
  if (s.sb && ha('MSADLIB.DRV') && ha('VADLIBD.386')) {
    ini.aggiungiRiga('386Enh', 'device=vadlibd.386');
    ini.set('drivers', 'MIDI', 'msadlib.drv');
  } else {
    ini.togli('drivers', 'MIDI', 'msadlib.drv');
    ini.togliRiga('386Enh', 'device=vadlibd.386');
  }
  if (s.mpu && ha('MPU401.DRV')) {
    ini.set('drivers', 'MIDI1', 'mpu401.drv');
    ini.set('mpu401.drv', 'port', '330');
    ini.set('mpu401.drv', 'int', '2');
  } else {
    ini.togli('drivers', 'MIDI1', 'mpu401.drv');
  }
  return ini.toString();
}

// SYSTEM.INI è in codepage di Windows: lo si legge e scrive byte per byte (latin1), senza conversioni.
export const daByte = (b) => { let t = ''; for (let i = 0; i < b.length; i += 32768) t += String.fromCharCode.apply(null, b.subarray(i, i + 32768)); return t; };
export const inByte = (t) => { const b = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) b[i] = t.charCodeAt(i) & 255; return b; };

// Sul volume FAT (fat.js): adatta C:\WINDOWS\SYSTEM.INI. Restituisce le scelte, o null se Windows non c'è.
export function adattaWindows(vol, hw, opzioni = {}) {
  const f = '\\WINDOWS\\SYSTEM.INI';
  if (!vol.exists(f)) return null;
  const prima = daByte(vol.readFile(f));
  const dopo = adattaSystemIni(prima, hw, (n) => vol.exists(`\\WINDOWS\\SYSTEM\\${n}`), opzioni);
  if (dopo !== prima) vol.writeFile(f, inByte(dopo));
  return sceltePerHw(hw);
}
