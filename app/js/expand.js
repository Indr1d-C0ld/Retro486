// Retro486 - decompressione dei file "_" dei dischi Microsoft (COMPRESS.EXE / EXPAND.EXE).
//
//   SZDD: LZSS (MS-DOS 5, Windows 3.x)
//   KWAJ: metodi 0 (nessuna), 1 (XOR 0xFF), 2 (LZSS), 3 (LZ + Huffman, MS-DOS 6.x)
//
// Il metodo 3 segue la descrizione del formato di libmspack (kwajd.c).

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

export function isSzdd(b) {
  return b.length > 14 && b[0] === 0x53 && b[1] === 0x5a && b[2] === 0x44 && b[3] === 0x44 && b[4] === 0x88;
}

export function expandSzdd(b) {
  if (!isSzdd(b)) throw new Error('Non è un file SZDD');
  const missing = String.fromCharCode(b[9]);
  const size = u32(b, 10);
  const out = new Uint8Array(size);
  const win = new Uint8Array(4096).fill(0x20);
  let pos = 4096 - 16, o = 0, i = 14;
  while (i < b.length && o < size) {
    const ctl = b[i++];
    for (let bit = 0; bit < 8 && i < b.length && o < size; bit++) {
      if (ctl & (1 << bit)) {
        const c = b[i++];
        out[o++] = c; win[pos] = c; pos = (pos + 1) & 4095;
      } else {
        const b1 = b[i++], b2 = b[i++];
        const mpos = b1 | ((b2 & 0xf0) << 4);
        const len = (b2 & 0x0f) + 3;
        for (let k = 0; k < len && o < size; k++) {
          const c = win[(mpos + k) & 4095];
          out[o++] = c; win[pos] = c; pos = (pos + 1) & 4095;
        }
      }
    }
  }
  return { data: out, missing };
}

// Nome espanso: EMM386.EX_ + 'E' -> EMM386.EXE
export function expandedName(name, missing) {
  if (!name.endsWith('_')) return name;
  return name.slice(0, -1) + (missing && missing !== '\0' ? missing.toUpperCase() : '');
}

// ---------------------------------------------------------------------------
// KWAJ

export function isKwaj(b) {
  return b.length > 14 && b[0] === 0x4b && b[1] === 0x57 && b[2] === 0x41 && b[3] === 0x4a && b[4] === 0x88;
}

class MsbBits {
  constructor(b, pos) { this.b = b; this.pos = pos; this.buf = 0; this.n = 0; }
  _fill() {
    while (this.n <= 24) {
      const byte = this.pos < this.b.length ? this.b[this.pos] : 0;
      this.pos++;
      this.buf = (this.buf | (byte << (24 - this.n))) >>> 0;
      this.n += 8;
    }
  }
  peek(k) { this._fill(); return this.buf >>> (32 - k); }
  skip(k) { this.buf = (this.buf << k) >>> 0; this.n -= k; }
  read(k) { const v = this.peek(k); this.skip(k); return v; }
  get exhausted() { return this.pos - Math.floor(this.n / 8) > this.b.length; }
}

// Huffman canonico (MSB): codici assegnati per lunghezza crescente, poi per simbolo.
function buildHuff(lens) {
  const max = Math.max(0, ...lens);
  const codes = new Map(); // "len:code" -> simbolo
  let code = 0;
  for (let len = 1; len <= max; len++) {
    for (let s = 0; s < lens.length; s++) if (lens[s] === len) codes.set(len * 65536 + code++, s);
    code <<= 1;
  }
  return { max, codes };
}
function readSym(bits, h) {
  let code = 0;
  for (let len = 1; len <= h.max; len++) {
    code = (code << 1) | bits.read(1);
    const s = h.codes.get(len * 65536 + code);
    if (s !== undefined) return s;
  }
  throw new Error('KWAJ: codice Huffman non valido');
}

function readLens(bits, type, n) {
  const lens = new Array(n).fill(0);
  let c;
  switch (type) {
    case 0:
      lens.fill(n === 16 ? 4 : n === 32 ? 5 : n === 64 ? 6 : 8);
      break;
    case 1:
      c = bits.read(4); lens[0] = c;
      for (let i = 1; i < n; i++) {
        if (bits.read(1) === 0) lens[i] = c;
        else if (bits.read(1) === 0) lens[i] = ++c;
        else { c = bits.read(4); lens[i] = c; }
      }
      break;
    case 2:
      c = bits.read(4); lens[0] = c;
      for (let i = 1; i < n; i++) {
        const sel = bits.read(2);
        if (sel === 3) c = bits.read(4); else c += sel - 1;
        lens[i] = c;
      }
      break;
    case 3:
      for (let i = 0; i < n; i++) lens[i] = bits.read(4);
      break;
    default:
      throw new Error(`KWAJ: tipo di tabella ${type} sconosciuto`);
  }
  return lens;
}

function kwajLzh(b, pos, size) {
  const out = new Uint8Array(size);
  const win = new Uint8Array(4096).fill(0x20);
  const bits = new MsbBits(b, pos);
  const types = [];
  for (let i = 0; i < 6; i++) types.push(bits.read(4));
  const MATCHLEN1 = buildHuff(readLens(bits, types[0], 16));
  const MATCHLEN2 = buildHuff(readLens(bits, types[1], 16));
  const LITLEN = buildHuff(readLens(bits, types[2], 32));
  const OFFSET = buildHuff(readLens(bits, types[3], 64));
  const LITERAL = buildHuff(readLens(bits, types[4], 256));
  let o = 0, wp = 0, litRun = false;
  while (o < size && !bits.exhausted) {
    let len = readSym(bits, litRun ? MATCHLEN2 : MATCHLEN1);
    if (len > 0) {
      len += 2;
      litRun = false;
      const off = (readSym(bits, OFFSET) << 6) | bits.read(6);
      while (len-- > 0 && o < size) {
        const c = win[(wp + 4096 - off) & 4095];
        win[wp] = c; out[o++] = c; wp = (wp + 1) & 4095;
      }
    } else {
      len = readSym(bits, LITLEN) + 1;
      litRun = len !== 32;
      while (len-- > 0 && o < size) {
        const c = readSym(bits, LITERAL);
        win[wp] = c; out[o++] = c; wp = (wp + 1) & 4095;
      }
    }
  }
  if (o < size) throw new Error(`KWAJ: dati troncati (${o}/${size})`);
  return out;
}

function lzss(b, pos, size, start = 4096 - 16) {
  const out = [];
  const win = new Uint8Array(4096).fill(0x20);
  let wp = start, i = pos;
  while (i < b.length && (size == null || out.length < size)) {
    const ctl = b[i++];
    for (let bit = 0; bit < 8 && i < b.length; bit++) {
      if (ctl & (1 << bit)) { const c = b[i++]; out.push(c); win[wp] = c; wp = (wp + 1) & 4095; }
      else {
        const b1 = b[i++], b2 = b[i++];
        const mpos = b1 | ((b2 & 0xf0) << 4);
        for (let k = 0; k < (b2 & 0x0f) + 3; k++) { const c = win[(mpos + k) & 4095]; out.push(c); win[wp] = c; wp = (wp + 1) & 4095; }
      }
    }
  }
  return Uint8Array.from(size == null ? out : out.slice(0, size));
}

export function expandKwaj(b) {
  if (!isKwaj(b)) throw new Error('Non è un file KWAJ');
  const method = u16(b, 8);
  const dataOff = u16(b, 10);
  const flags = u16(b, 12);
  let p = 14, size = null, name = '', ext = '';
  if (flags & 1) { size = u32(b, p); p += 4; }
  if (flags & 2) p += 2;
  if (flags & 4) p += 2 + u16(b, p);
  if (flags & 8) { while (b[p]) name += String.fromCharCode(b[p++]); p++; }
  if (flags & 16) { while (b[p]) ext += String.fromCharCode(b[p++]); p++; }
  let data;
  switch (method) {
    case 0: data = b.slice(dataOff); break;
    case 1: data = b.slice(dataOff).map((x) => x ^ 0xff); break;
    case 2: data = lzss(b, dataOff, size, 4096 - 18); break;
    case 3: data = kwajLzh(b, dataOff, size ?? 0); break;
    default: throw new Error(`KWAJ: metodo ${method} non supportato`);
  }
  if (size != null && data.length > size) data = data.subarray(0, size);
  return { data, name: name ? (ext ? `${name}.${ext}` : name) : null };
}

// Espande un file compresso qualsiasi; i file non compressi tornano invariati.
export function expandAny(b) {
  if (isKwaj(b)) return expandKwaj(b).data;
  if (isSzdd(b)) return expandSzdd(b).data;
  return b;
}
