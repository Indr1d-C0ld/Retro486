// Retro486 - lettore di archivi ZIP nel browser, per importare un gioco sull'hard disk.
// Legge la directory centrale e decomprime con DecompressionStream('deflate-raw'):
// metodi 0 (memorizzato) e 8 (deflate), niente ZIP64, niente cifratura.

import { decode437 } from './fat.js';

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

async function inflate(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

// Elenco dei file: [{ name: 'DIR/FILE.EXT', size, read(): Promise<Uint8Array> }] (le cartelle sono escluse).
export function readZip(buffer) {
  const b = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let e = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (u32(b, i) === 0x06054b50) { e = i; break; }
  }
  if (e < 0) throw new Error('Non è un archivio ZIP');
  const n = u16(b, e + 10);
  let o = u32(b, e + 16);
  if (n === 0xffff || o === 0xffffffff) throw new Error('Archivio ZIP64 non supportato');
  const out = [];
  for (let i = 0; i < n; i++) {
    if (u32(b, o) !== 0x02014b50) throw new Error('Directory dello ZIP danneggiata');
    const flags = u16(b, o + 8), method = u16(b, o + 10);
    const csize = u32(b, o + 20), size = u32(b, o + 24);
    const nl = u16(b, o + 28), xl = u16(b, o + 30), cl = u16(b, o + 32), lho = u32(b, o + 42);
    const raw = b.subarray(o + 46, o + 46 + nl);
    const name = (flags & 0x800 ? new TextDecoder().decode(raw) : decode437(raw)).replace(/\\/g, '/');
    o += 46 + nl + xl + cl;
    if (name.endsWith('/')) continue;
    out.push({ name, size, read: async () => {
      if (flags & 1) throw new Error(`${name}: archivio protetto da password`);
      const start = lho + 30 + u16(b, lho + 26) + u16(b, lho + 28);
      const data = b.subarray(start, start + csize);
      if (method === 0) return data.slice();
      if (method === 8) return inflate(data);
      throw new Error(`${name}: metodo di compressione ${method} non supportato`);
    } });
  }
  return out;
}

// ---- scrittura ----------------------------------------------------------------

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

// Crea un archivio ZIP senza compressione da [{ name: 'DIR/FILE.EXT', data: Uint8Array, mtime?: Date }].
export function writeZip(files) {
  const enc = new TextEncoder();
  const parti = [], centrale = [];
  let pos = 0;
  for (const f of files) {
    const nome = enc.encode(f.name);
    const d = f.mtime instanceof Date && !isNaN(f.mtime) ? f.mtime : new Date();
    const ora = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const giorno = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const crc = crc32(f.data);
    const comune = new Uint8Array(26); // da "version needed" alla lunghezza del campo extra
    const v = new DataView(comune.buffer);
    v.setUint16(0, 20, true); v.setUint16(2, 0x800, true); v.setUint16(4, 0, true); v.setUint16(6, ora, true); v.setUint16(8, giorno, true);
    v.setUint32(10, crc, true); v.setUint32(14, f.data.length, true); v.setUint32(18, f.data.length, true); v.setUint16(22, nome.length, true); v.setUint16(24, 0, true);
    const locale = new Uint8Array(30 + nome.length);
    new DataView(locale.buffer).setUint32(0, 0x04034b50, true); locale.set(comune, 4); locale.set(nome, 30);
    const c = new Uint8Array(46 + nome.length);
    const cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); c.set(comune, 6); cv.setUint32(42, pos, true); c.set(nome, 46);
    parti.push(locale, f.data); centrale.push(c);
    pos += locale.length + f.data.length;
  }
  const dimC = centrale.reduce((a, x) => a + x.length, 0);
  const fine = new Uint8Array(22);
  const fv = new DataView(fine.buffer);
  fv.setUint32(0, 0x06054b50, true); fv.setUint16(8, files.length, true); fv.setUint16(10, files.length, true); fv.setUint32(12, dimC, true); fv.setUint32(16, pos, true);
  return new Blob([...parti, ...centrale, fine], { type: 'application/zip' });
}
