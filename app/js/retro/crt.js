// Retro486 - monitor CRT emulato (WebGL2).
//
// Legge il canvas 2D su cui l'emulatore disegna ogni fotogramma e lo ridisegna
// su un canvas WebGL sovrapposto, con: curvatura, scanline, maschera dei
// fosfori (griglia di apertura, maschera a punti, a fessure), bloom, persistenza
// dei fosfori, sfarfallio, separazione RGB, rumore analogico, vignettatura,
// luminosità/contrasto/saturazione/nitidezza, allungamento e posizione
// dell'immagine, overscan e fosfori monocromatici (verde, ambra, bianco).
//
// Il canvas originale resta sotto, trasparente, e continua a ricevere mouse e
// tastiera: il CRT è solo una lente.

export const PARAMS = [
  // chiave, etichetta, min, max, passo, gruppo
  ['curvature', 'Curvatura', 0, 0.25, 0.005, 'Geometria'],
  ['cornerRadius', 'Angoli arrotondati', 0, 0.12, 0.005, 'Geometria'],
  ['stretchX', 'Allungamento orizzontale', 0.85, 1.15, 0.005, 'Geometria'],
  ['stretchY', 'Allungamento verticale', 0.85, 1.15, 0.005, 'Geometria'],
  ['offsetX', 'Posizione orizzontale', -0.08, 0.08, 0.002, 'Geometria'],
  ['offsetY', 'Posizione verticale', -0.08, 0.08, 0.002, 'Geometria'],
  ['overscan', 'Overscan', 0.9, 1.1, 0.005, 'Geometria'],
  ['scanlines', 'Scanline', 0, 1, 0.01, 'Fosfori'],
  ['scanlineSharp', 'Scanline: definizione', 0.5, 4, 0.05, 'Fosfori'],
  ['mask', 'Maschera dei fosfori', 0, 1, 0.01, 'Fosfori'],
  ['maskType', 'Tipo di maschera (0 griglia, 1 punti, 2 fessure)', 0, 2, 1, 'Fosfori'],
  ['maskSize', 'Passo della maschera (pixel)', 2, 6, 1, 'Fosfori'],
  ['persistence', 'Persistenza', 0, 0.9, 0.01, 'Fosfori'],
  ['bloom', 'Bloom', 0, 1.5, 0.01, 'Fosfori'],
  ['phosphor', 'Fosfori (0 colore, 1 verde, 2 ambra, 3 bianco)', 0, 3, 1, 'Fosfori'],
  ['brightness', 'Luminosità', 0.5, 1.6, 0.01, 'Immagine'],
  ['contrast', 'Contrasto', 0.5, 1.6, 0.01, 'Immagine'],
  ['saturation', 'Saturazione', 0, 1.6, 0.01, 'Immagine'],
  ['sharpness', 'Nitidezza', 0, 1, 0.01, 'Immagine'],
  ['gamma', 'Gamma', 1.6, 2.8, 0.01, 'Immagine'],
  ['vignette', 'Vignettatura', 0, 1, 0.01, 'Immagine'],
  ['rgbShift', 'Separazione RGB (convergenza)', 0, 3, 0.05, 'Segnale'],
  ['noise', 'Rumore analogico', 0, 0.15, 0.002, 'Segnale'],
  ['flicker', 'Sfarfallio', 0, 0.1, 0.002, 'Segnale'],
  ['jitter', 'Instabilità orizzontale', 0, 1, 0.01, 'Segnale'],
  ['glass', 'Riflesso del vetro', 0, 1, 0.01, 'Segnale'],
];

const BASE = {
  enabled: true, curvature: 0.06, cornerRadius: 0.04, stretchX: 1, stretchY: 1, offsetX: 0, offsetY: 0, overscan: 1,
  scanlines: 0.45, scanlineSharp: 1.6, mask: 0.35, maskType: 0, maskSize: 3, persistence: 0.15, bloom: 0.35, phosphor: 0,
  brightness: 1.08, contrast: 1.05, saturation: 1.05, sharpness: 0.6, gamma: 2.2, vignette: 0.35,
  rgbShift: 0.4, noise: 0.015, flicker: 0.01, jitter: 0, glass: 0.25,
};

export const PRESETS = {
  spento: { nome: 'Spento (pixel nitidi)', enabled: false },
  vga14: { nome: 'VGA 14" 1992', ...BASE },
  trinitron: { nome: 'Trinitron 15"', ...BASE, curvature: 0.025, cornerRadius: 0.02, maskType: 0, mask: 0.45, scanlines: 0.35, rgbShift: 0.2, glass: 0.15, vignette: 0.2 },
  svga17: { nome: 'SVGA 17" (fine)', ...BASE, curvature: 0.03, scanlines: 0.15, mask: 0.2, maskType: 1, maskSize: 2, bloom: 0.2, rgbShift: 0.15, noise: 0.005, sharpness: 0.85 },
  economico: { nome: 'Monitor economico usurato', ...BASE, curvature: 0.1, scanlines: 0.55, mask: 0.45, maskType: 2, rgbShift: 1.4, noise: 0.05, flicker: 0.04, jitter: 0.35, bloom: 0.6, sharpness: 0.3, saturation: 0.85 },
  verde: { nome: 'Monocromatico fosfori verdi', ...BASE, phosphor: 1, mask: 0.1, persistence: 0.45, bloom: 0.6, rgbShift: 0 },
  ambra: { nome: 'Monocromatico ambra', ...BASE, phosphor: 2, mask: 0.1, persistence: 0.4, bloom: 0.55, rgbShift: 0 },
};

const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main() { uv = p * 0.5 + 0.5; uv.y = 1.0 - uv.y; gl_Position = vec4(p, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o;
uniform sampler2D src, prev;
uniform vec2 srcSize, outSize;
uniform float time, frame;
uniform float curvature, cornerRadius, stretchX, stretchY, offsetX, offsetY, overscan;
uniform float scanlines, scanlineSharp, mask, maskType, maskSize, persistence, bloom, phosphor;
uniform float brightness, contrast, saturation, sharpness, gamma, vignette, rgbShift, noise, flicker, jitter, glass;

float rnd(vec2 c) { return fract(sin(dot(c, vec2(12.9898, 78.233))) * 43758.5453); }

vec2 warp(vec2 q) {
  q = q * 2.0 - 1.0;
  vec2 off = q.yx * q.yx * curvature;
  q += q * off;
  q.x = (q.x - offsetX * 2.0) / stretchX;
  q.y = (q.y - offsetY * 2.0) / stretchY;
  q *= overscan;
  return q * 0.5 + 0.5;
}

vec3 lin(vec3 c) { return pow(max(c, 0.0), vec3(gamma)); }

// Campionamento nitido in orizzontale (interpolazione con bordo regolabile).
vec3 fetch(vec2 q) {
  vec2 px = q * srcSize;
  vec2 i = floor(px) + 0.5;
  vec2 f = px - i;
  float k = mix(1.0, 12.0, sharpness);
  f.x = clamp(f.x * k, -0.5, 0.5);
  vec2 s = (i + vec2(f.x, f.y)) / srcSize;
  return lin(texture(src, s).rgb);
}

void main() {
  vec2 q = warp(uv);
  float jit = jitter * (rnd(vec2(floor(q.y * srcSize.y), floor(time * 30.0))) - 0.5) * 0.8 / srcSize.x;
  q.x += jit;
  if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }

  float sh = rgbShift / srcSize.x;
  vec3 col;
  col.r = fetch(q + vec2(sh, 0.0)).r;
  col.g = fetch(q).g;
  col.b = fetch(q - vec2(sh, 0.0)).b;

  // bloom: media pesata dei vicini
  if (bloom > 0.0) {
    vec3 b = vec3(0.0);
    vec2 d = 1.5 / srcSize;
    b += fetch(q + vec2(d.x, 0.0)) + fetch(q - vec2(d.x, 0.0)) + fetch(q + vec2(0.0, d.y)) + fetch(q - vec2(0.0, d.y));
    b += 0.5 * (fetch(q + d * 2.0) + fetch(q - d * 2.0) + fetch(q + vec2(d.x, -d.y) * 2.0) + fetch(q + vec2(-d.x, d.y) * 2.0));
    col += b / 6.0 * bloom * 0.6;
  }

  // scanline: profilo gaussiano per riga della sorgente
  float lines = srcSize.y;
  if (srcSize.y < 300.0) lines = srcSize.y; // 200/240 righe: un fascio per riga
  float y = fract(q.y * lines) - 0.5;
  float luma = dot(col, vec3(0.299, 0.587, 0.114));
  float beam = exp(-pow(abs(y) * (scanlineSharp * 2.5) / (0.6 + luma * 0.6), 2.0));
  col *= mix(1.0, beam * 1.6, scanlines);

  // maschera dei fosfori sui pixel di uscita
  vec2 fc = gl_FragCoord.xy;
  float ms = maskSize;
  vec3 m = vec3(1.0);
  if (maskType < 0.5) {
    float c = mod(floor(fc.x), ms) / ms;
    m = vec3(c < 0.34 ? 1.0 : 0.25, (c >= 0.34 && c < 0.67) ? 1.0 : 0.25, c >= 0.67 ? 1.0 : 0.25);
  } else if (maskType < 1.5) {
    float off = mod(floor(fc.y / ms), 2.0) * ms * 0.5;
    float c = mod(floor(fc.x + off), ms) / ms;
    m = vec3(c < 0.34 ? 1.0 : 0.3, (c >= 0.34 && c < 0.67) ? 1.0 : 0.3, c >= 0.67 ? 1.0 : 0.3);
  } else {
    float row = mod(floor(fc.y), ms * 2.0) < 1.0 ? 0.5 : 1.0;
    float c = mod(floor(fc.x), ms) / ms;
    m = row * vec3(c < 0.34 ? 1.0 : 0.3, (c >= 0.34 && c < 0.67) ? 1.0 : 0.3, c >= 0.67 ? 1.0 : 0.3);
  }
  col *= mix(vec3(1.0), m * 1.35, mask);

  // fosfori monocromatici
  if (phosphor > 0.5) {
    float l = dot(col, vec3(0.299, 0.587, 0.114));
    vec3 tint = phosphor < 1.5 ? vec3(0.2, 1.0, 0.35) : phosphor < 2.5 ? vec3(1.0, 0.62, 0.12) : vec3(0.92, 0.95, 1.0);
    col = l * tint * 1.25;
  }

  // immagine
  col = pow(max(col, 0.0), vec3(1.0 / gamma));
  float l2 = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(l2), col, saturation);
  col = (col - 0.5) * contrast + 0.5;
  col *= brightness;
  col *= 1.0 - flicker * (0.5 + 0.5 * sin(time * 377.0));
  col += (rnd(uv * outSize + fract(time) * 91.0) - 0.5) * noise;

  // vignettatura e angoli
  vec2 v = q * (1.0 - q);
  col *= mix(1.0, pow(clamp(v.x * v.y * 15.0, 0.0, 1.0), 0.35), vignette);
  vec2 cq = abs(q - 0.5) * 2.0;
  vec2 cr = max(cq - (1.0 - cornerRadius * 2.0), 0.0) / max(cornerRadius * 2.0, 1e-4);
  float corner = 1.0 - smoothstep(0.85, 1.0, length(cr));
  col *= cornerRadius > 0.0 ? corner : 1.0;

  // riflesso del vetro
  vec2 g = uv - vec2(0.3, 0.2);
  col += glass * 0.06 * exp(-dot(g, g) * 9.0);

  // persistenza: mescola con il fotogramma precedente
  vec3 pr = texture(prev, vec2(uv.x, 1.0 - uv.y)).rgb; // il buffer precedente è salvato capovolto
  col = max(col, pr * persistence);

  o = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

const COPY = `#version 300 es
precision highp float; in vec2 uv; out vec4 o; uniform sampler2D img;
void main() { o = texture(img, vec2(uv.x, 1.0 - uv.y)); }`;

export class Crt {
  constructor(sourceCanvas, settings) {
    this.src = sourceCanvas;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'crt-canvas';
    this.s = { ...PRESETS.vga14, ...settings };
    this.gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: false });
    this.ok = !!this.gl;
    this.t0 = performance.now();
    this.frame = 0;
    if (this.ok) this._init();
  }

  _shader(type, text) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, text);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  }

  _program(fs) {
    const gl = this.gl;
    const p = gl.createProgram();
    gl.attachShader(p, this._shader(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, this._shader(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'p');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const a = gl.getActiveUniform(p, i); u[a.name] = gl.getUniformLocation(p, a.name); }
    return { p, u };
  }

  _tex() {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  _init() {
    const gl = this.gl;
    try {
      this.main = this._program(FS);
      this.copy = this._program(COPY);
    } catch (e) {
      console.warn('[CRT] shader non compilato:', e);
      this.ok = false;
      return;
    }
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.srcTex = this._tex();
    this.fb = [0, 1].map(() => ({ tex: this._tex(), fbo: gl.createFramebuffer(), w: 0, h: 0 }));
    this.cur = 0;
  }

  set(settings) { this.s = { ...this.s, ...settings }; }

  _resizeTargets(w, h) {
    const gl = this.gl;
    for (const f of this.fb) {
      if (f.w === w && f.h === h) continue;
      gl.bindTexture(gl.TEXTURE_2D, f.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, f.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, f.tex, 0);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      f.w = w; f.h = h;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // Da chiamare dopo ogni fotogramma dell'emulatore e a ogni ridimensionamento.
  draw() {
    if (!this.ok || !this.s.enabled) return;
    const gl = this.gl;
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    if (!this.src.width || !this.src.height) return;
    this._resizeTargets(w, h);

    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.src);

    const prev = this.fb[this.cur];
    const next = this.fb[1 - this.cur];
    gl.bindFramebuffer(gl.FRAMEBUFFER, next.fbo);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.main.p);
    const u = this.main.u;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.srcTex); gl.uniform1i(u.src, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, prev.tex); gl.uniform1i(u.prev, 1);
    gl.uniform2f(u.srcSize, this.src.width, this.src.height);
    gl.uniform2f(u.outSize, w, h);
    gl.uniform1f(u.time, (performance.now() - this.t0) / 1000);
    gl.uniform1f(u.frame, this.frame++);
    for (const [k] of PARAMS) if (u[k]) gl.uniform1f(u[k], Number(this.s[k]) || 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.copy.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, next.tex); gl.uniform1i(this.copy.u.img, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.cur = 1 - this.cur;
  }
}

const KEY = 'retro486.crt';
export function loadCrtSettings() {
  try { const s = JSON.parse(localStorage.getItem(KEY) || 'null'); if (s) return s; } catch (e) { /* vuoto */ }
  return { preset: 'vga14', ...PRESETS.vga14 };
}
export function saveCrtSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* privato */ }
}

// ---------------------------------------------------------------------------
// CRT senza GPU (Canvas 2D): per i browser senza WebGL, come il pannello
// integrato dell'app Claude. Stesse regolazioni, ottenute componendo livelli
// precalcolati (scanline, maschera, vignettatura, rumore) e i filtri del canvas.
// La curvatura è approssimata disegnando l'immagine a fasce orizzontali e
// verticali di larghezza variabile. Al massimo 30 fotogrammi al secondo.

export class Crt2D {
  constructor(sourceCanvas, settings) {
    this.src = sourceCanvas;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'crt-canvas';
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.ok = !!this.ctx;
    this.software = true;
    this.s = { ...PRESETS.vga14, ...settings };
    this.t0 = performance.now();
    this.last = 0;
    this.layers = null;     // livelli precalcolati per la dimensione corrente
    this.prev = document.createElement('canvas');
    this.work = document.createElement('canvas');
  }

  set(settings) { this.s = { ...this.s, ...settings }; } // i livelli si rifanno solo se cambia la loro chiave

  _layers(w, h, srcH) {
    const s = this.s;
    const key = [w, h, srcH, s.scanlines, s.scanlineSharp, s.mask, s.maskType, s.maskSize, s.vignette, s.cornerRadius, s.glass].join('|');
    if (this.layers?.key === key) return this.layers;
    const mk = () => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

    // scanline + maschera dei fosfori, in un unico livello da moltiplicare
    const ov = mk(); const g = ov.getContext('2d');
    const img = g.createImageData(w, h); const d = img.data;
    const rows = Math.max(1, srcH);
    const ms = Math.max(2, Math.round(s.maskSize));
    for (let y = 0; y < h; y++) {
      const fy = ((y + 0.5) * rows / h) % 1 - 0.5;
      const beam = Math.exp(-Math.pow(Math.abs(fy) * s.scanlineSharp * 2.2, 2));
      const sl = 1 - s.scanlines + s.scanlines * Math.min(1, beam * 1.35);
      for (let x = 0; x < w; x++) {
        let cx = x;
        let rowK = 1;
        if (s.maskType >= 0.5 && s.maskType < 1.5) cx = x + (Math.floor(y / ms) % 2) * (ms >> 1);
        if (s.maskType >= 1.5) rowK = (y % (ms * 2)) < 1 ? 0.6 : 1;
        const c = (cx % ms) / ms;
        const lo = 1 - s.mask * 0.65;
        const m = [c < 0.34 ? 1 : lo, c >= 0.34 && c < 0.67 ? 1 : lo, c >= 0.67 ? 1 : lo];
        const i = (y * w + x) * 4;
        d[i] = Math.min(255, 255 * sl * m[0] * rowK * (1 + s.mask * 0.3));
        d[i + 1] = Math.min(255, 255 * sl * m[1] * rowK * (1 + s.mask * 0.3));
        d[i + 2] = Math.min(255, 255 * sl * m[2] * rowK * (1 + s.mask * 0.3));
        d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);

    // vignettatura e angoli arrotondati
    const vg = mk(); const v = vg.getContext('2d');
    v.fillStyle = '#fff'; v.fillRect(0, 0, w, h);
    const rg = v.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) * 0.55);
    rg.addColorStop(0, 'rgba(255,255,255,1)');
    rg.addColorStop(1, `rgba(${Math.round(255 * (1 - s.vignette))},${Math.round(255 * (1 - s.vignette))},${Math.round(255 * (1 - s.vignette))},1)`);
    v.fillStyle = rg; v.fillRect(0, 0, w, h);
    const r = s.cornerRadius * Math.min(w, h) * 1.2;
    if (r > 0) {
      v.globalCompositeOperation = 'destination-in';
      v.beginPath(); v.roundRect(0, 0, w, h, r); v.fill();
      v.globalCompositeOperation = 'destination-over'; v.fillStyle = '#000'; v.fillRect(0, 0, w, h);
    }

    // riflesso del vetro
    const gl = mk(); const gx = gl.getContext('2d');
    const gg = gx.createRadialGradient(w * 0.3, h * 0.2, 0, w * 0.3, h * 0.2, Math.max(w, h) * 0.45);
    gg.addColorStop(0, `rgba(255,255,255,${0.09 * s.glass})`); gg.addColorStop(1, 'rgba(255,255,255,0)');
    gx.fillStyle = gg; gx.fillRect(0, 0, w, h);

    // rumore: quattro fotogrammi a rotazione
    const noise = [0, 1, 2, 3].map(() => {
      const c = document.createElement('canvas'); c.width = Math.ceil(w / 2); c.height = Math.ceil(h / 2);
      const x = c.getContext('2d'); const id = x.createImageData(c.width, c.height);
      for (let i = 0; i < id.data.length; i += 4) { const n = Math.random() * 255; id.data[i] = id.data[i + 1] = id.data[i + 2] = n; id.data[i + 3] = 255; }
      x.putImageData(id, 0, 0); return c;
    });
    this.layers = { key, ov, vg, gl, noise };
    return this.layers;
  }

  // Disegna la sorgente con curvatura (fasce) e geometria sul contesto dato.
  _geometry(ctx, src, w, h) {
    const s = this.s;
    const sw = src.width, sh = src.height;
    const k = s.curvature * 1.6;
    const ox = s.offsetX * w, oy = s.offsetY * h;
    const scx = s.stretchX / s.overscan, scy = s.stretchY / s.overscan;
    if (k < 0.002) {
      const dw = w * scx, dh = h * scy;
      ctx.drawImage(src, 0, 0, sw, sh, (w - dw) / 2 + ox, (h - dh) / 2 + oy, dw, dh);
      return;
    }
    // fasce orizzontali: ogni riga si restringe verso l'alto e il basso (barile)
    const bands = Math.min(96, sh);
    for (let i = 0; i < bands; i++) {
      const v0 = i / bands, v1 = (i + 1) / bands, vm = (v0 + v1) / 2 * 2 - 1;
      const shrinkX = 1 - k * 0.5 * vm * vm;
      const dw = w * scx * shrinkX;
      const y0 = h / 2 + (v0 * 2 - 1) * (h * scy / 2) * (1 - k * 0.12);
      const y1 = h / 2 + (v1 * 2 - 1) * (h * scy / 2) * (1 - k * 0.12);
      ctx.drawImage(src, 0, v0 * sh, sw, (v1 - v0) * sh, (w - dw) / 2 + ox, y0 + oy, dw, y1 - y0 + 0.6);
    }
  }

  draw() {
    if (!this.ok || !this.s.enabled) return;
    const now = performance.now();
    if (now - this.last < 32) return;
    this.last = now;
    const s = this.s;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.max(16, Math.round(rect.width * dpr)), h = Math.max(16, Math.round(rect.height * dpr));
    if (!this.src.width || !this.src.height) return;
    for (const c of [this.canvas, this.prev, this.work]) if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const L = this._layers(w, h, this.src.height);
    const ctx = this.ctx;
    const work = this.work.getContext('2d');
    const t = (now - this.t0) / 1000;

    // 1. immagine con geometria, filtri di immagine, nitidezza e jitter
    work.globalCompositeOperation = 'source-over';
    work.fillStyle = '#000'; work.fillRect(0, 0, w, h);
    work.imageSmoothingEnabled = s.sharpness < 0.75;
    const flick = 1 - s.flicker * (0.5 + 0.5 * Math.sin(t * 377));
    const mono = s.phosphor >= 0.5;
    work.filter = `brightness(${s.brightness * flick}) contrast(${s.contrast}) saturate(${mono ? 0 : s.saturation})${s.sharpness < 0.4 ? ` blur(${(0.4 - s.sharpness) * 2}px)` : ''}`;
    work.save();
    if (s.jitter > 0) work.translate((Math.random() - 0.5) * s.jitter * 2 * dpr, 0);
    this._geometry(work, this.src, w, h);
    work.restore();
    work.filter = 'none';

    // convergenza: rosso e blu spostati
    if (s.rgbShift > 0.05 && !mono) {
      const dx = s.rgbShift * w / this.src.width * 0.6;
      work.globalCompositeOperation = 'lighter';
      work.globalAlpha = 0.18;
      work.drawImage(this.work, dx, 0);
      work.drawImage(this.work, -dx, 0);
      work.globalAlpha = 1;
    }

    // fosfori monocromatici
    if (mono) {
      work.globalCompositeOperation = 'multiply';
      work.fillStyle = s.phosphor < 1.5 ? '#40ff70' : s.phosphor < 2.5 ? '#ffa020' : '#eef2ff';
      work.fillRect(0, 0, w, h);
    }

    // 2. scanline e maschera (moltiplica), vignettatura e angoli
    work.globalCompositeOperation = 'multiply';
    work.drawImage(L.ov, 0, 0);
    work.drawImage(L.vg, 0, 0);

    // 3. composizione finale: persistenza, bloom, rumore, vetro
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.drawImage(this.work, 0, 0);
    if (s.persistence > 0.01) { ctx.globalCompositeOperation = 'lighten'; ctx.globalAlpha = s.persistence; ctx.drawImage(this.prev, 0, 0); }
    if (s.bloom > 0.01) {
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = Math.min(0.6, s.bloom * 0.35);
      ctx.filter = `blur(${Math.round(3 * dpr)}px)`; ctx.drawImage(this.work, 0, 0); ctx.filter = 'none';
    }
    if (s.noise > 0.001) {
      ctx.globalCompositeOperation = 'overlay'; ctx.globalAlpha = Math.min(1, s.noise * 4);
      ctx.drawImage(L.noise[Math.floor(t * 30) % 4], 0, 0, w, h);
    }
    if (s.glass > 0.01) { ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 1; ctx.drawImage(L.gl, 0, 0); }
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    // il fotogramma attuale diventa il "precedente" per la persistenza
    this.prev.getContext('2d').drawImage(this.canvas, 0, 0);
  }
}

// WebGL2 se c'è, altrimenti il CRT su Canvas 2D.
export function creaCrt(sourceCanvas, settings) {
  const gl = new Crt(sourceCanvas, settings);
  if (gl.ok) return gl;
  return new Crt2D(sourceCanvas, settings);
}
