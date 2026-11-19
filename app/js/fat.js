// Retro486 - FAT12/FAT16 su immagini disco grezze (floppy e hard disk con MBR).
//
// Lo stesso modulo gira in Node (strumenti di preparazione dei dischi) e nel
// browser (esplora-disco, installazione dei giochi dalla libreria). Lavora su
// un Uint8Array che contiene l'intera immagine: le modifiche sono in memoria e
// il chiamante decide quando riscriverle sul file.
//
// Solo nomi 8.3, come MS-DOS 6.22: le voci LFN (Windows 95) vengono saltate in
// lettura e cancellate insieme alla voce corta a cui appartengono.

const SECTOR = 512;

export const ATTR = { RO: 0x01, HIDDEN: 0x02, SYSTEM: 0x04, LABEL: 0x08, DIR: 0x10, ARCHIVE: 0x20, LFN: 0x0f };

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const w16 = (b, o, v) => { b[o] = v & 0xff; b[o + 1] = (v >> 8) & 0xff; };
const w32 = (b, o, v) => { b[o] = v & 0xff; b[o + 1] = (v >> 8) & 0xff; b[o + 2] = (v >> 16) & 0xff; b[o + 3] = (v >>> 24) & 0xff; };

// ---------------------------------------------------------------------------
// Nomi DOS

const VALID = /^[A-Z0-9!#$%&'()\-@^_`{}~\x80-\xff]+$/;

export function toShortName(name) {
  const up = String(name).toUpperCase();
  if (up === '.' || up === '..') return up.padEnd(11, ' ');
  const dot = up.lastIndexOf('.');
  const base = dot > 0 ? up.slice(0, dot) : up;
  const ext = dot > 0 ? up.slice(dot + 1) : '';
  if (!base || base.length > 8 || ext.length > 3 || !VALID.test(base) || (ext && !VALID.test(ext)))
    throw new Error(`Nome non valido per MS-DOS (8.3): ${name}`);
  return base.padEnd(8, ' ') + ext.padEnd(3, ' ');
}

function rawToName(raw) {
  const base = raw.slice(0, 8).trimEnd();
  const ext = raw.slice(8, 11).trimEnd();
  return ext ? `${base}.${ext}` : base;
}

// Da un nome qualsiasi a un nome 8.3 plausibile (per importare file con nomi lunghi).
export function sanitizeName(name, taken = new Set()) {
  let up = String(name).toUpperCase().replace(/\s+/g, '');
  const dot = up.lastIndexOf('.');
  let base = (dot > 0 ? up.slice(0, dot) : up).replace(/\./g, '');
  let ext = dot > 0 ? up.slice(dot + 1) : '';
  base = [...base].filter((c) => VALID.test(c)).join('') || 'FILE';
  ext = [...ext].filter((c) => VALID.test(c)).join('').slice(0, 3);
  let cand = (base.slice(0, 8) + (ext ? '.' + ext : ''));
  for (let n = 1; taken.has(cand); n++) {
    const tail = `~${n}`;
    cand = base.slice(0, 8 - tail.length) + tail + (ext ? '.' + ext : '');
  }
  return cand;
}

const cp437 = (() => {
  const hi = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
  const t = [];
  for (let i = 0; i < 128; i++) t.push(String.fromCharCode(i));
  return t.concat([...hi]);
})();
const cp437rev = new Map(cp437.map((c, i) => [c, i]));

export function decode437(bytes) {
  let s = '';
  for (const b of bytes) s += cp437[b];
  return s;
}
export function encode437(str) {
  const out = new Uint8Array(str.length);
  let i = 0;
  for (const c of str) out[i++] = cp437rev.get(c) ?? 0x3f;
  return out.subarray(0, i);
}

function dosDateTime(d = new Date()) {
  const y = Math.max(1980, d.getFullYear());
  return {
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  };
}
function fromDos(date, time) {
  if (!date) return null;
  return new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2);
}

function splitPath(path) {
  return String(path).replace(/^[A-Za-z]:/, '').split(/[\\/]+/).filter(Boolean);
}

// ---------------------------------------------------------------------------
// MBR

export function geometryFor(bytes) {
  // CHS adatta a 86Box: 16 testine, 63 settori, cilindri quanti ne servono.
  const sectors = Math.floor(bytes / SECTOR);
  return { heads: 16, spt: 63, cyl: Math.floor(sectors / (16 * 63)) };
}

function lbaToChs(lba, g) {
  const cyl = Math.floor(lba / (g.heads * g.spt));
  const tmp = lba % (g.heads * g.spt);
  const head = Math.floor(tmp / g.spt);
  const sec = (tmp % g.spt) + 1;
  const c = Math.min(cyl, 1023);
  return [head, sec | ((c >> 2) & 0xc0), c & 0xff];
}

export function readPartitions(img) {
  if (img[510] !== 0x55 || img[511] !== 0xaa) return [];
  const out = [];
  for (let i = 0; i < 4; i++) {
    const o = 446 + i * 16;
    const type = img[o + 4];
    if (!type) continue;
    out.push({ index: i, active: img[o] === 0x80, type, lba: u32(img, o + 8), sectors: u32(img, o + 12) });
  }
  return out;
}

export function writeMbr(img, { code, geometry, startLba = 63, sectors, type }) {
  img.fill(0, 0, 512);
  if (code) img.set(code.subarray(0, 446), 0);
  const o = 446;
  img[o] = 0x80;
  img.set(lbaToChs(startLba, geometry), o + 1);
  img[o + 4] = type;
  img.set(lbaToChs(startLba + sectors - 1, geometry), o + 5);
  w32(img, o + 8, startLba);
  w32(img, o + 12, sectors);
  img[510] = 0x55; img[511] = 0xaa;
}

// Apre il primo volume FAT di un'immagine: floppy (BPB al settore 0) o disco con MBR.
export function openImage(img) {
  const looksBpb = (b) => (b[0] === 0xeb || b[0] === 0xe9) && u16(b, 11) === 512 && b[13] && b[16];
  if (looksBpb(img)) return new FatVolume(img, 0);
  const part = readPartitions(img).find((p) => [0x01, 0x04, 0x06, 0x0e].includes(p.type));
  if (!part) throw new Error('Nessuna partizione FAT12/FAT16 trovata nell\'immagine');
  return new FatVolume(img, part.lba * SECTOR);
}

// ---------------------------------------------------------------------------
// Volume FAT

export class FatVolume {
  constructor(img, offset = 0) {
    this.img = img;
    this.off = offset;
    const b = img.subarray(offset, offset + SECTOR);
    this.bps = u16(b, 11);
    this.spc = b[13];
    this.reserved = u16(b, 14);
    this.nfats = b[16];
    this.rootEntries = u16(b, 17);
    const total16 = u16(b, 19);
    this.totalSectors = total16 || u32(b, 32);
    this.media = b[21];
    this.spf = u16(b, 22);
    if (this.bps !== SECTOR || !this.spc || !this.spf) throw new Error('Settore di avvio FAT non valido');
    this.fatStart = offset + this.reserved * SECTOR;
    this.rootStart = this.fatStart + this.nfats * this.spf * SECTOR;
    this.rootSectors = Math.ceil((this.rootEntries * 32) / SECTOR);
    this.dataStart = this.rootStart + this.rootSectors * SECTOR;
    this.clusterBytes = this.spc * SECTOR;
    const dataSectors = this.totalSectors - (this.reserved + this.nfats * this.spf + this.rootSectors);
    this.clusters = Math.floor(dataSectors / this.spc);
    this.fat16 = this.clusters >= 4085;
    this.eoc = this.fat16 ? 0xfff8 : 0xff8;
    this.label = decode437(b.subarray(43, 54)).trimEnd();
    this._hint = 2;
  }

  // ---- tabella FAT --------------------------------------------------------

  fatGet(n) {
    const img = this.img;
    if (this.fat16) return u16(img, this.fatStart + n * 2);
    const o = this.fatStart + Math.floor(n * 1.5);
    const v = u16(img, o);
    return n & 1 ? v >> 4 : v & 0xfff;
  }

  fatSet(n, val) {
    for (let f = 0; f < this.nfats; f++) {
      const base = this.fatStart + f * this.spf * SECTOR;
      if (this.fat16) { w16(this.img, base + n * 2, val); continue; }
      const o = base + Math.floor(n * 1.5);
      const v = u16(this.img, o);
      w16(this.img, o, n & 1 ? (v & 0x000f) | (val << 4) : (v & 0xf000) | (val & 0xfff));
    }
  }

  isEnd(v) { return v >= this.eoc || v < 2; }

  chain(start) {
    const out = [];
    const seen = new Set();
    for (let c = start; c >= 2 && !this.isEnd(c) && c < this.clusters + 2; c = this.fatGet(c)) {
      if (seen.has(c)) throw new Error('Catena FAT circolare');
      seen.add(c);
      out.push(c);
    }
    return out;
  }

  freeClusters() {
    let n = 0;
    for (let c = 2; c < this.clusters + 2; c++) if (this.fatGet(c) === 0) n++;
    return n;
  }

  get freeBytes() { return this.freeClusters() * this.clusterBytes; }
  get totalBytes() { return this.clusters * this.clusterBytes; }

  // Alloca `count` cluster, contigui se possibile, e li concatena.
  allocate(count, { contiguousFrom = null } = {}) {
    if (!count) return [];
    const got = [];
    const max = this.clusters + 2;
    // prima prova: una corsa contigua
    let run = 0, runStart = 2;
    for (let c = contiguousFrom ?? 2; c < max && run < count; c++) {
      if (this.fatGet(c) === 0) { if (!run) runStart = c; run++; } else run = 0;
    }
    if (run >= count) for (let i = 0; i < count; i++) got.push(runStart + i);
    else {
      for (let c = this._hint; got.length < count && c < max; c++) if (this.fatGet(c) === 0) got.push(c);
      for (let c = 2; got.length < count && c < this._hint; c++) if (this.fatGet(c) === 0 && !got.includes(c)) got.push(c);
    }
    if (got.length < count) throw new Error('Disco pieno');
    for (let i = 0; i < got.length; i++) this.fatSet(got[i], i + 1 < got.length ? got[i + 1] : (this.fat16 ? 0xffff : 0xfff));
    this._hint = got[got.length - 1] + 1;
    return got;
  }

  freeChain(start) {
    for (const c of this.chain(start)) this.fatSet(c, 0);
  }

  clusterOffset(c) { return this.dataStart + (c - 2) * this.clusterBytes; }

  // ---- directory -----------------------------------------------------------

  // Restituisce gli "slot" (offset dei 32 byte) di una directory; cluster 0 = root.
  _dirSlots(cluster) {
    const slots = [];
    if (!cluster) {
      for (let i = 0; i < this.rootEntries; i++) slots.push(this.rootStart + i * 32);
    } else {
      for (const c of this.chain(cluster)) {
        const base = this.clusterOffset(c);
        for (let i = 0; i < this.clusterBytes / 32; i++) slots.push(base + i * 32);
      }
    }
    return slots;
  }

  _entryAt(o) {
    const img = this.img;
    const raw = decode437(img.subarray(o, o + 11));
    const attr = img[o + 11];
    return {
      slot: o,
      raw,
      name: rawToName(raw[0] === '\u0005' ? '\xe5' + raw.slice(1) : raw),
      attr,
      isDir: !!(attr & ATTR.DIR),
      cluster: u16(img, o + 26),
      size: u32(img, o + 28),
      mtime: fromDos(u16(img, o + 24), u16(img, o + 22)),
    };
  }

  readDir(cluster = 0, { all = false } = {}) {
    const out = [];
    for (const o of this._dirSlots(cluster)) {
      const first = this.img[o];
      if (first === 0) break;
      if (first === 0xe5) continue;
      const attr = this.img[o + 11];
      if ((attr & ATTR.LFN) === ATTR.LFN) continue;
      if (!all && (attr & ATTR.LABEL)) continue;
      const e = this._entryAt(o);
      if (!all && (e.name === '.' || e.name === '..')) continue;
      out.push(e);
    }
    return out;
  }

  // Risolve un percorso: restituisce la voce (o la root, come pseudo-voce).
  lookup(path) {
    const parts = splitPath(path);
    let cur = { name: '\\', isDir: true, cluster: 0, attr: ATTR.DIR, root: true };
    for (const p of parts) {
      if (!cur.isDir) return null;
      const want = toShortName(p);
      const next = this.readDir(cur.cluster, { all: true }).find((e) => e.raw === want && !(e.attr & ATTR.LABEL));
      if (!next) return null;
      if (next.name === '..' && next.cluster === 0) cur = { name: '\\', isDir: true, cluster: 0, attr: ATTR.DIR, root: true };
      else cur = next;
    }
    return cur;
  }

  exists(path) { return !!this.lookup(path); }

  list(path = '\\') {
    const d = this.lookup(path);
    if (!d) throw new Error(`Percorso inesistente: ${path}`);
    if (!d.isDir) throw new Error(`Non è una directory: ${path}`);
    return this.readDir(d.cluster).sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
  }

  // Albero completo { name, path, isDir, size, children }
  tree(path = '\\', depth = Infinity) {
    const walk = (dirEntry, p, d) => {
      const children = d <= 0 ? null : this.readDir(dirEntry.cluster)
        .sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name))
        .map((e) => {
          const cp = (p === '\\' ? '\\' : p + '\\') + e.name;
          return e.isDir ? walk(e, cp, d - 1) : { name: e.name, path: cp, isDir: false, size: e.size, attr: e.attr, mtime: e.mtime };
        });
      return { name: dirEntry.root ? '\\' : dirEntry.name, path: p, isDir: true, attr: dirEntry.attr, mtime: dirEntry.mtime, children };
    };
    const d = this.lookup(path);
    if (!d) throw new Error(`Percorso inesistente: ${path}`);
    return walk(d, path === '' ? '\\' : path, depth);
  }

  readFile(path) {
    const e = typeof path === 'string' ? this.lookup(path) : path;
    if (!e) throw new Error(`File inesistente: ${path}`);
    if (e.isDir) throw new Error(`È una directory: ${path}`);
    const out = new Uint8Array(e.size);
    let pos = 0;
    for (const c of this.chain(e.cluster)) {
      if (pos >= e.size) break;
      const n = Math.min(this.clusterBytes, e.size - pos);
      const o = this.clusterOffset(c);
      out.set(this.img.subarray(o, o + n), pos);
      pos += n;
    }
    return out;
  }

  readText(path) { return decode437(this.readFile(path)); }

  // Trova uno slot libero nella directory (estendendola se serve).
  _freeSlot(cluster) {
    for (const o of this._dirSlots(cluster)) {
      const f = this.img[o];
      if (f === 0 || f === 0xe5) return o;
    }
    if (!cluster) throw new Error('Directory principale piena');
    const chain = this.chain(cluster);
    const [nc] = this.allocate(1);
    this.fatSet(chain[chain.length - 1], nc);
    const base = this.clusterOffset(nc);
    this.img.fill(0, base, base + this.clusterBytes);
    return base;
  }

  _writeEntry(o, { raw, attr, cluster, size, when }) {
    const img = this.img;
    img.fill(0, o, o + 32);
    img.set(encode437(raw), o);
    if (img[o] === 0xe5) img[o] = 0x05;
    img[o + 11] = attr;
    const { date, time } = dosDateTime(when);
    w16(img, o + 14, time); w16(img, o + 16, date); w16(img, o + 18, date);
    w16(img, o + 22, time); w16(img, o + 24, date);
    w16(img, o + 26, cluster);
    w32(img, o + 28, size);
  }

  _parentOf(path) {
    const parts = splitPath(path);
    if (!parts.length) throw new Error('Percorso vuoto');
    const name = parts.pop();
    const parent = this.lookup('\\' + parts.join('\\'));
    if (!parent || !parent.isDir) throw new Error(`Directory inesistente: \\${parts.join('\\')}`);
    return { parent, name, raw: toShortName(name) };
  }

  writeFile(path, data, { attr = ATTR.ARCHIVE, when = new Date(), contiguous = false } = {}) {
    if (typeof data === 'string') data = encode437(data.replace(/\r?\n/g, '\r\n'));
    const { parent, raw } = this._parentOf(path);
    const existing = this.readDir(parent.cluster).find((e) => e.raw === raw);
    if (existing?.isDir) throw new Error(`Esiste già una directory con questo nome: ${path}`);
    if (existing) { if (existing.cluster) this.freeChain(existing.cluster); }
    const need = Math.ceil(data.length / this.clusterBytes);
    if (need > this.freeClusters()) {
      if (existing) this._writeEntry(existing.slot, { raw, attr: existing.attr, cluster: 0, size: 0, when });
      throw new Error(`Spazio insufficiente per ${path}`);
    }
    const clusters = this.allocate(need, { contiguousFrom: contiguous ? 2 : null });
    clusters.forEach((c, i) => {
      const o = this.clusterOffset(c);
      const part = data.subarray(i * this.clusterBytes, (i + 1) * this.clusterBytes);
      this.img.set(part, o);
      if (part.length < this.clusterBytes) this.img.fill(0, o + part.length, o + this.clusterBytes);
    });
    const slot = existing ? existing.slot : this._freeSlot(parent.cluster);
    this._writeEntry(slot, { raw, attr, cluster: clusters[0] || 0, size: data.length, when });
    return clusters;
  }

  mkdir(path, { when = new Date() } = {}) {
    const { parent, raw } = this._parentOf(path);
    const existing = this.readDir(parent.cluster).find((e) => e.raw === raw);
    if (existing) { if (existing.isDir) return existing; throw new Error(`Esiste già un file con questo nome: ${path}`); }
    const [c] = this.allocate(1);
    const base = this.clusterOffset(c);
    this.img.fill(0, base, base + this.clusterBytes);
    this._writeEntry(base, { raw: '.'.padEnd(11), attr: ATTR.DIR, cluster: c, size: 0, when });
    this._writeEntry(base + 32, { raw: '..'.padEnd(11), attr: ATTR.DIR, cluster: parent.cluster, size: 0, when });
    const slot = this._freeSlot(parent.cluster);
    this._writeEntry(slot, { raw, attr: ATTR.DIR, cluster: c, size: 0, when });
    return this.lookup(path);
  }

  mkdirp(path) {
    const parts = splitPath(path);
    for (let i = 1; i <= parts.length; i++) {
      const p = '\\' + parts.slice(0, i).join('\\');
      if (!this.exists(p)) this.mkdir(p);
    }
  }

  _clearSlot(cluster, slot) {
    this.img[slot] = 0xe5;
    // le eventuali voci LFN subito prima
    const slots = this._dirSlots(cluster);
    for (let i = slots.indexOf(slot) - 1; i >= 0; i--) {
      const o = slots[i];
      if ((this.img[o + 11] & ATTR.LFN) !== ATTR.LFN || this.img[o] === 0xe5) break;
      this.img[o] = 0xe5;
    }
  }

  remove(path, { recursive = false } = {}) {
    const { parent, raw } = this._parentOf(path);
    const e = this.readDir(parent.cluster).find((x) => x.raw === raw);
    if (!e) throw new Error(`Inesistente: ${path}`);
    if (e.isDir) {
      const kids = this.readDir(e.cluster);
      if (kids.length && !recursive) throw new Error(`Directory non vuota: ${path}`);
      for (const k of kids) this.remove(`${path}\\${k.name}`, { recursive: true });
    }
    if (e.cluster) this.freeChain(e.cluster);
    this._clearSlot(parent.cluster, e.slot);
  }

  rename(path, newName) {
    const { parent, raw } = this._parentOf(path);
    const e = this.readDir(parent.cluster).find((x) => x.raw === raw);
    if (!e) throw new Error(`Inesistente: ${path}`);
    const nraw = toShortName(newName);
    if (this.readDir(parent.cluster).some((x) => x.raw === nraw)) throw new Error(`Esiste già: ${newName}`);
    this.img.set(encode437(nraw), e.slot);
  }

  setAttr(path, attr) {
    const e = this.lookup(path);
    if (!e || e.root) throw new Error(`Inesistente: ${path}`);
    this.img[e.slot + 11] = (attr & ~ATTR.DIR) | (e.attr & ATTR.DIR);
  }

  setLabel(label) {
    const raw = label.toUpperCase().padEnd(11).slice(0, 11);
    const cur = this.readDir(0, { all: true }).find((e) => e.attr & ATTR.LABEL && (e.attr & ATTR.LFN) !== ATTR.LFN);
    this._writeEntry(cur ? cur.slot : this._freeSlot(0), { raw, attr: ATTR.LABEL, cluster: 0, size: 0, when: new Date() });
    this.img.set(encode437(raw), this.off + 43);
    this.label = raw.trimEnd();
  }

  // Scrive un intero albero { 'DIR\\FILE.EXT': Uint8Array } creando le directory.
  writeTree(base, files) {
    for (const [rel, data] of Object.entries(files)) {
      const parts = splitPath(rel);
      if (parts.length > 1) this.mkdirp(`${base}\\${parts.slice(0, -1).join('\\')}`);
      this.writeFile(`${base}\\${parts.join('\\')}`, data);
    }
  }

  // ---- formattazione ---------------------------------------------------------

  // Formatta un volume FAT12/16 a `offset`, lungo `sectors` settori.
  // bootCode: un settore di avvio da cui prendere il codice (byte 62..509).
  static format(img, { offset = 0, sectors, bootSector = null, label = 'NO NAME', hidden = 0,
    heads = 16, spt = 63, media = 0xf8, drive = 0x80, rootEntries = 512, spc = null, serial = null,
    labelEntry = true } = {}) {
    let fat16 = sectors >= 32680;
    if (!spc) {
      if (!fat16) spc = sectors <= 2880 ? 1 : 4;
      else if (sectors <= 262144) spc = 4;
      else if (sectors <= 524288) spc = 8;
      else if (sectors <= 1048576) spc = 16;
      else if (sectors <= 2097152) spc = 32;
      else spc = 64;
    }
    const reserved = 1, nfats = 2;
    const rootSectors = Math.ceil(rootEntries * 32 / SECTOR);
    let spf = 1;
    for (;;) {
      const clusters = Math.floor((sectors - reserved - rootSectors - nfats * spf) / spc);
      const need = Math.ceil(((clusters + 2) * (fat16 ? 2 : 1.5)) / SECTOR);
      if (need <= spf) break;
      spf = need;
    }
    const b = new Uint8Array(SECTOR);
    if (bootSector) b.set(bootSector.subarray(0, SECTOR));
    else { b[0] = 0xeb; b[1] = 0x3c; b[2] = 0x90; b[62] = 0xf4; b[63] = 0xeb; b[64] = 0xfd; }
    b.set(encode437('MSDOS5.0'), 3);
    w16(b, 11, SECTOR); b[13] = spc; w16(b, 14, reserved); b[16] = nfats; w16(b, 17, rootEntries);
    w16(b, 19, sectors < 65536 ? sectors : 0); b[21] = media; w16(b, 22, spf);
    w16(b, 24, spt); w16(b, 26, heads); w32(b, 28, hidden); w32(b, 32, sectors < 65536 ? 0 : sectors);
    b[36] = drive; b[37] = 0; b[38] = 0x29;
    w32(b, 39, serial ?? ((Math.random() * 0xffffffff) >>> 0));
    b.set(encode437(label.toUpperCase().padEnd(11).slice(0, 11)), 43);
    b.set(encode437(fat16 ? 'FAT16   ' : 'FAT12   '), 54);
    b[510] = 0x55; b[511] = 0xaa;

    const sysBytes = (reserved + nfats * spf + rootSectors) * SECTOR;
    img.fill(0, offset, offset + sysBytes);
    img.set(b, offset);
    const vol = new FatVolume(img, offset);
    vol.fatSet(0, fat16 ? 0xff00 | media : 0xf00 | media);
    vol.fatSet(1, fat16 ? 0xffff : 0xfff);
    // Con /S i file di sistema devono essere le prime voci della root: l'etichetta
    // si aggiunge dopo, con setLabel().
    if (labelEntry && label && label !== 'NO NAME') vol.setLabel(label);
    return vol;
  }
}
