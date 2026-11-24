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
