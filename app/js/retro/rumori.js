// Retro486 - i rumori del PC, sintetizzati con WebAudio (nessun file audio): relè e avvio dei dischi
// all'accensione, ventola dell'alimentatore, testine dell'hard disk, passo-passo del floppy, CD-ROM.
// L'attività delle unità è quella della barra di stato di 86Box (emu.statusIcons()).

export class Rumori {
  constructor(emu, win, { volume = 0.5 } = {}) {
    this.emu = emu; this.win = win; this.volume = volume;
    this.ctx = null; this.acceso = false; this.ultimo = {};
    this._tick = this._tick.bind(this);
  }

  _prepara() {
    if (this.ctx) return;
    const C = window.AudioContext || window.webkitAudioContext;
    this.ctx = new C();
    this.out = this.ctx.createGain();
    this.out.gain.value = this.volume;
    this.out.connect(this.ctx.destination);
    // due secondi di rumore bianco, riusato da tutti i suoni
    const n = this.ctx.sampleRate * 2;
    this.rumore = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = this.rumore.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    const riprendi = () => this.ctx?.resume?.();
    for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, riprendi, { capture: true });
  }

  // un colpo di rumore filtrato: freq e q del passa-banda, durata in secondi, guadagno di picco
  _colpo(freq, q, durata, g, quando = 0) {
    const c = this.ctx, t = c.currentTime + quando;
    const s = c.createBufferSource(); s.buffer = this.rumore; s.loop = true;
    const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
    const a = c.createGain();
    a.gain.setValueAtTime(0, t); a.gain.linearRampToValueAtTime(g, t + 0.002); a.gain.exponentialRampToValueAtTime(0.0001, t + durata);
    s.connect(f).connect(a).connect(this.out);
    s.start(t, Math.random() * 1.5); s.stop(t + durata + 0.02);
  }

  _tono(tipo, f0, f1, durata, g, quando = 0) {
    const c = this.ctx, t = c.currentTime + quando;
    const o = c.createOscillator(); o.type = tipo;
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + durata);
    const a = c.createGain();
    a.gain.setValueAtTime(0, t); a.gain.linearRampToValueAtTime(g, t + Math.min(0.3, durata / 3)); a.gain.linearRampToValueAtTime(0, t + durata);
    o.connect(a).connect(this.out); o.start(t); o.stop(t + durata + 0.02);
  }

  accendi() {
    if (this.acceso) return;
    this._prepara();
    this.acceso = true;
    const c = this.ctx;
    this._colpo(1800, 2, 0.05, 0.9);                 // interruttore e relè dell'alimentatore
    this._colpo(300, 1, 0.12, 0.5, 0.02);
    this._tono('sawtooth', 40, 118, 2.6, 0.035, 0.1); // i piatti dell'hard disk prendono velocità
    this._colpo(2600, 6, 0.03, 0.25, 1.9);            // le testine escono dal parcheggio
    this._colpo(2200, 6, 0.03, 0.25, 2.05);
    // ventola: rumore passa-basso, sempre acceso
    const s = c.createBufferSource(); s.buffer = this.rumore; s.loop = true;
    const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 420; f.Q.value = 0.4;
    const a = c.createGain(); a.gain.setValueAtTime(0, c.currentTime); a.gain.linearRampToValueAtTime(0.11, c.currentTime + 1.8);
    s.connect(f).connect(a).connect(this.out); s.start();
    // ronzio dei piatti
    const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = 118;
    const og = c.createGain(); og.gain.setValueAtTime(0, c.currentTime); og.gain.linearRampToValueAtTime(0.012, c.currentTime + 2.8);
    o.connect(og).connect(this.out); o.start();
    this.fissi = [s, o];
    this.timer = setInterval(this._tick, 40);
  }

  spegni() {
    if (!this.acceso) return;
    this.acceso = false;
    clearInterval(this.timer);
    for (const n of this.fissi || []) { try { n.stop(); } catch (e) { /* già fermo */ } }
    this.fissi = [];
  }

  imposta({ attivo, volume }) {
    if (volume !== undefined) { this.volume = volume; if (this.out) this.out.gain.value = volume; }
    if (attivo === true) this.accendi();
    if (attivo === false) this.spegni();
  }

  // ogni 40 ms: un suono per ogni unità che in questo momento lavora
  _tick() {
    if (!this.emu.sharedPtr || this.emu.paused || this.ctx.state !== 'running') return;
    let s;
    try { s = this.emu.statusIcons(); } catch (e) { return; }
    const ora = performance.now();
    for (const d of this.win.drives()) {
      if (!s.active[d.tag] && !s.write[d.tag]) continue;
      const pausa = { hdd: 45, floppy: 110, cdrom: 160 }[d.kind];
      if (!pausa || ora - (this.ultimo[d.tag] || 0) < pausa * (0.7 + Math.random() * 0.8)) continue;
      this.ultimo[d.tag] = ora;
      if (d.kind === 'hdd') this._colpo(2000 + Math.random() * 1400, 7, 0.018, 0.22);
      else if (d.kind === 'floppy') { this._tono('square', 92, 88, 0.07, 0.05); this._colpo(900, 3, 0.03, 0.2); }
      else this._colpo(500 + Math.random() * 300, 2, 0.09, 0.07);
    }
  }
}
