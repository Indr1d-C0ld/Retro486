// Retro486 - il portale: un'interfaccia in stile BIOS/DOS attorno a 86Box.
//
//   SISTEMA     riassunto della macchina, accensione
//   CONFIGURA   profili hardware (scheda madre, CPU, RAM, video, audio, MIDI...)
//               e il dialogo completo delle impostazioni di 86Box
//   HARD DISK   esplora-disco del C: (FAT16) a macchina spenta
//   LIBRERIA    giochi e programmi installati, con avvio diretto
//   MEDIA       immagini di floppy e CD-ROM
//   MONITOR     il CRT emulato
//
// La macchina accesa usa la finestra di Web86Box (menu, barra di stato, supporti)
// con il monitor CRT sovrapposto.

import { Emulator, State } from '../emulator.js';
import { Catalog } from '../catalog.js';
import { MainWindow } from '../mainwindow.js';
import { Ini } from '../ini.js';
import { openSettings } from '../settings.js';
import * as storage from '../storage.js';
import { h, dialog, messageBox, confirm, prompt, pickFiles, downloadBlob, progressDialog, formatSize } from '../ui.js';
import { decode437, encode437, sanitizeName, ATTR } from '../fat.js';
import * as P from './profili.js';
import * as S from './server.js';
import { Disco, preparaAvvio } from './disco.js';
import { readZip, writeZip } from '../zip.js';
import { Rumori } from './rumori.js';
import { creaCrt, PARAMS, PRESETS, loadCrtSettings, saveCrtSettings } from './crt.js';

const root = document.getElementById('app');
const STATO = 'retro486.stato'; // { profilo, media: { a, b, cd }, scheda }

const app = {
  emu: null, catalog: null, srv: null, profili: [], stato: { profilo: 'dx33', media: {}, scheda: 'sistema' },
  disco: null, crt: loadCrtSettings(),
};

function loadStato() {
  try { Object.assign(app.stato, JSON.parse(localStorage.getItem(STATO) || '{}')); } catch (e) { /* vuoto */ }
}
function saveStato() { try { localStorage.setItem(STATO, JSON.stringify(app.stato)); } catch (e) { /* privato */ } }

const profilo = () => app.profili.find((p) => p.id === app.stato.profilo) || app.profili[0];
const ora = () => new Date().toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const esc = (s) => String(s ?? '');

// ---------------------------------------------------------------- avvio

function hasMemory64() {
  try { return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 1])); } catch (e) { return false; }
}

function schermataMessaggio(titolo, testo, { errore = false, barra = false } = {}) {
  const bar = barra ? h('div.r-bar', null, h('div')) : null;
  root.replaceChildren(h('div.r-boot', null,
    h('div.r-box' + (errore ? '.r-err' : ''), null, h('div.r-box-title', null, titolo), h('pre', null, testo || ''), bar)));
  return bar?.firstChild;
}

function waitFor(emu, type, pred = () => true) {
  return new Promise((resolve) => {
    const fn = (e) => { if (pred(e.detail)) { emu.removeEventListener(type, fn); resolve(e.detail); } };
    emu.addEventListener(type, fn);
  });
}

async function main() {
  loadStato();
  const problemi = [];
  if (!window.crossOriginIsolated) problemi.push('La pagina non è isolata (COOP/COEP): SharedArrayBuffer non è disponibile. Ricarica la pagina; se il problema resta, il server deve inviare le intestazioni Cross-Origin-Opener-Policy e Cross-Origin-Embedder-Policy.');
  // la build a 32 bit non richiede memory64 (funziona anche in Safari)
  if (!storage.isSupported()) problemi.push('Questo browser non offre l\'Origin Private File System.');
  if (problemi.length) { schermataMessaggio('RETRO486 NON PUO\' PARTIRE', problemi.join('\n\n'), { errore: true }); return; }

  const bar = schermataMessaggio('RETRO486', 'Carico l\'emulatore 86Box (WebAssembly)...', { barra: true });
  bar.style.width = '20%';
  await storage.requestPersistence();
  const [srv] = await Promise.all([S.stato()]);
  app.srv = srv;
  bar.style.width = '40%';

  const emu = new Emulator({ canvas: document.createElement('canvas') });
  app.emu = emu;
  window.retro486 = app;
  window.web86box = emu;
  emu.addEventListener('msgbox', (e) => {
    if (app.window) app.window.handleMsgbox(e.detail);
    else messageBox({ title: '86Box', text: e.detail.message, kind: 'warning' }).then(() => emu.msgboxReply(e.detail.id, 1));
  });
  const waiting = waitFor(emu, 'state', (s) => Number(s) === State.WAITING || Number(s) === State.ERROR);
  try { await emu.load(); } catch (e) { schermataMessaggio('ERRORE', `86Box non si carica:\n${e?.message || e}`, { errore: true }); return; }
  bar.style.width = '70%';
  if (emu.state !== State.WAITING && Number(await waiting) === State.ERROR) return;
  const cat = waitFor(emu, 'catalog');
  emu.command('catalog');
  app.catalog = new Catalog(await cat);
  bar.style.width = '100%';

  app.profili = [...P.PREDEFINITI.map((p) => ({ ...p, predefinito: true })), ...(srv.profili || [])];
  if (!app.profili.some((p) => p.id === app.stato.profilo)) app.stato.profilo = app.profili[0].id;

  if (new URLSearchParams(location.search).get('accendi')) {
    history.replaceState(null, '', location.pathname);
    const voce = app.stato.avvioVoce ? (srv.libreria || []).find((v) => v.id === app.stato.avvioVoce) : null;
    delete app.stato.avvioVoce; saveStato();
    await accendi({ voce });
    return;
  }
  portale();
}

// ---------------------------------------------------------------- struttura del portale

const SCHEDE = [
  ['sistema', 'SISTEMA', 'F1', 'power'], ['configura', 'CONFIGURA', 'F2', 'cpu'], ['disco', 'HARD DISK', 'F3', 'hdd'],
  ['libreria', 'LIBRERIA', 'F4', 'library'], ['media', 'MEDIA', 'F5', 'floppy'], ['monitor', 'MONITOR', 'F6', 'crt'],
];

function portale() {
  const tabs = h('nav.r-tabs');
  const corpo = h('main.r-body');
  const stato = h('div.r-status');
  const orologio = h('span.r-clock', null, ora());
  setInterval(() => { orologio.textContent = ora(); }, 15000);

  const mostra = async (id) => {
    app.stato.scheda = id; saveStato();
    tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.id === id));
    corpo.replaceChildren(h('div.r-loading', null, 'Attendere...'));
    try {
      corpo.replaceChildren(await PANNELLI[id]());
    } catch (e) {
      console.error(e);
      corpo.replaceChildren(h('div.r-box.r-err', null, h('div.r-box-title', null, 'ERRORE'), h('pre', null, String(e?.stack || e))));
    }
  };
  app.mostra = mostra;
  for (const [id, nome, f, ic] of SCHEDE) tabs.append(h('button', { type: 'button', dataset: { id }, onclick: () => mostra(id) }, pix(ic), h('span.k', null, f), ` ${nome}`));

  stato.append(
    h('span', null, h('span.k', null, 'F10'), ' Accendi'),
    h('span', null, h('span.k', null, 'F1-F6'), ' Sezioni'),
    h('span.r-grow', null, app.srv.offline ? 'Server non raggiungibile: modalità locale' : `Server Balthasar collegato · ${app.srv.versione || ''}`),
    orologio,
  );

  root.replaceChildren(h('div.r-screen', null,
    h('header.r-head', null,
      h('div.r-logo', null, h('img', { src: 'assets/pixel/logo-chip.png', alt: '', onerror: (e) => e.target.remove() }), h('span', null, 'RETRO', h('b', null, '486'))),
      h('div.r-sub', null, 'Laboratorio PC virtuale · 86Box · MS-DOS 6.22')),
    tabs, corpo, stato));

  document.onkeydown = (e) => {
    if (app.window || e.target.closest?.('input,textarea,select,.dialog')) return;
    const i = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6'].indexOf(e.key);
    if (i >= 0) { e.preventDefault(); mostra(SCHEDE[i][0]); }
    if (e.key === 'F10') { e.preventDefault(); accendi(); }
  };
  mostra(SCHEDE.some(([id]) => id === app.stato.scheda) ? app.stato.scheda : 'sistema');
}

function riquadro(titolo, ...contenuto) {
  return h('section.r-box', null, h('div.r-box-title', null, titolo), ...contenuto);
}

function pulsante(testo, onclick, cls = '') {
  return h(`button.r-btn${cls}`, { type: 'button', onclick }, testo);
}

// ---------------------------------------------------------------- SISTEMA

async function pannelloSistema() {
  const p = profilo();
  const righe = P.riassunto(app.catalog, p);
  const c = P.costo(p.hw.cpu_speed, p.hw.jit);
  const locale = await S.discoLocalePresente();
  const info = S.infoLocale();
  const disco = (app.srv.dischi || []).find((d) => d.nome === 'c');
  const discoStato = !locale ? (disco ? 'da scaricare dal server' : 'assente: nessuna immagine sul server')
    : info?.modificato ? 'copia locale con modifiche non salvate sul server' : 'copia locale allineata';

  const ICONE_SPEC = { CPU: 'cpu', 'SCHEDA MADRE': 'bios', RAM: 'ram', VIDEO: 'video', AUDIO: 'sound', MIDI: 'midi', DISCHI: 'hdd' };
  const tab = h('table.r-spec', null, ...righe.map(([k, v]) => h('tr', null, h('th', null, pix(ICONE_SPEC[k]), k), h('td', null, v))));
  const media = app.stato.media || {};
  const mhz = Math.floor(p.hw.cpu_speed / 1e6 + 0.01);
  return h('div', null,
    h('div.r-banner', null, h('img', { src: 'assets/pixel/banner.png', alt: '', onerror: (e) => e.target.parentNode.remove() })),
    h('div.r-grid', null,
      riquadro(`SISTEMA · ${p.nome}`,
        tab,
        h('p.r-note', null, p.descrizione || ''),
        h('p', null, 'Velocità nel browser: ', h(`span.r-cost.c${c.livello}`, null, c.testo)),
        h('div.r-actions', null,
          pulsante([pix('power'), 'ACCENDI'], () => accendi(), '.r-big'),
          pulsante([pix('cpu'), 'Cambia configurazione'], () => app.mostra('configura')),
          pulsante([pix('library'), 'Libreria giochi'], () => app.mostra('libreria')))),
      h('div', null,
        h('div.r-case', null, casePixel(mhz, () => caseCss(p)),
          p.hw.midi && p.hw.midi !== 'none' ? h('div.r-periferica', null, h('img', { src: 'assets/pixel/mt32.png', alt: '', onerror: (e) => e.target.parentNode.remove() }), h('span', null, app.catalog.find('midi_out', p.hw.midi)?.n || 'MIDI')) : null),
        riquadro('UNITA\'',
          h('table.r-spec', null,
            h('tr', null, h('th', null, pix('hdd'), 'C:'), h('td', null, `${discoStato}${info?.server ? ` · server ${new Date(info.server * 1000).toLocaleString('it-IT')}` : ''}`)),
            h('tr', null, h('th', null, pix('floppy'), 'A:'), h('td', null, media.a || '(vuoto)')),
            h('tr', null, h('th', null, pix('floppy'), 'B:'), h('td', null, media.b || '(vuoto)')),
            h('tr', null, h('th', null, pix('cdrom'), 'D:'), h('td', null, p.hw.cdrom ? (media.cd || '(vuoto)') : '(nessun lettore)'))),
          h('div.r-actions', null, pulsante([pix('floppy'), 'Supporti...'], () => app.mostra('media')), pulsante([pix('folder'), 'Esplora C:'], () => app.mostra('disco')))))));
}

// Icona pixel art del set (app/assets/pixel), sparisce se il file manca.
function pix(nome, cls = 'r-pix') {
  if (!nome) return null;
  return h(`img.${cls}`, { src: `assets/pixel/${nome}.png`, alt: '', draggable: false, onerror: (e) => e.target.remove() });
}

// Case pixel art con i MHz della CPU sul display a 7 segmenti
let caseInfo = null;
function casePixel(mhz, ripiego) {
  const box = h('div.r-case-pix');
  const img = h('img', { src: 'assets/pixel/case.png', alt: '', onerror: () => box.replaceWith(ripiego()) });
  const led = h('span.r-case-led', null, String(mhz).padStart(3, ' '));
  box.append(img, led);
  const posa = (m) => {
    const l = m?.case?.led;
    if (!l) { led.remove(); return; }
    Object.assign(led.style, { left: `${(l.x / m.case.width) * 100}%`, top: `${(l.y / m.case.height) * 100}%`, width: `${(l.w / m.case.width) * 100}%`, height: `${(l.h / m.case.height) * 100}%` });
  };
  if (caseInfo) posa(caseInfo);
  else fetch('assets/pixel/manifest.json').then((r) => r.json()).then((m) => { caseInfo = m; posa(m); }).catch(() => led.remove());
  return box;
}

// Case disegnato in CSS (finché non c'è l'immagine pixel art)
function caseCss(p) {
  return h('div.r-case-css', null,
    h('div.bay'), h('div.bay.small'),
    h('div.leds', null, h('span.led.on'), h('span.led.hdd'), h('span.mhz', null, String(Math.floor(p.hw.cpu_speed / 1e6 + 0.01)).padStart(3, ' '))),
    h('div.btns', null, h('span.turbo', null, 'TURBO'), h('span', null, 'RESET')),
    h('div.brand', null, '486'));
}

// ---------------------------------------------------------------- CONFIGURA

// I joystick più usati dai giochi DOS, in cima all'elenco di CONFIGURA (gli altri di 86Box seguono).
const JOYSTICK = [['2axis_2button', 'Joystick a 2 pulsanti'], ['2axis_4button', 'Joystick a 4 pulsanti'], ['gravis_gamepad', 'Gravis GamePad'],
  ['4button_gamepad', 'Gamepad a 4 pulsanti'], ['ch_flightstick_pro', 'CH Flightstick Pro'], ['thrustmaster_fcs', 'Thrustmaster FCS'], ['sidewinder_pad', 'Microsoft SideWinder Pad']];
function padCollegati() {
  const n = [...(navigator.getGamepads?.() || [])].filter(Boolean).length;
  return n ? `${n} pad collegat${n === 1 ? 'o' : 'i'}` : 'premi un pulsante del pad';
}

async function pannelloConfigura() {
  const cat = app.catalog;
  const wrap = h('div.r-grid.r-grid-conf');
  const elenco = h('div.r-list');
  const form = h('div');

  const disegnaElenco = () => {
    elenco.replaceChildren(...app.profili.map((p) => h('div.r-item' + (p.id === app.stato.profilo ? '.on' : ''), {
      onclick: () => { app.stato.profilo = p.id; saveStato(); disegnaElenco(); disegnaForm(); },
    }, h('b', null, p.nome), h('small', null, ` ${p.anno || ''} · ${P.mhz(p.hw.cpu_speed)}${p.predefinito ? '' : ' · personale'}`))));
  };

  const disegnaForm = () => {
    const p = profilo();
    const hw = { ...p.hw };
    const m = cat.machine(hw.machine);
    const sel = (label, value, options, onchange, extra) => h('label.r-field', null, h('span', null, label),
      h('select', { onchange: (e) => onchange(e.target.value) }, ...options.map(([v, t]) => h('option', { value: v, selected: String(v) === String(value) }, t))), extra);
    const ridisegna = () => { modificato = true; disegnaCampi(); };
    let modificato = false;
    const campi = h('div.r-fields');
    const disegnaCampi = () => {
      const mm = cat.machine(hw.machine);
      const cpus = P.cpuChoices(cat, mm);
      if (!cpus.some((c) => c.family === hw.cpu_family && c.speed === hw.cpu_speed)) { hw.cpu_family = cpus[0]?.family; hw.cpu_speed = cpus[0]?.speed; }
      const rams = P.ramChoices(mm);
      if (!rams.includes(hw.ram)) hw.ram = rams.reduce((a, b) => (Math.abs(b - hw.ram) < Math.abs(a - hw.ram) ? b : a), rams[0]);
      const devs = (key) => cat.list(key, mm).map((d) => [d.i, d.n]);
      const c = P.costo(hw.cpu_speed, hw.jit);
      campi.replaceChildren(
        sel('Scheda madre', hw.machine, P.machines486(cat).map((x) => [x.i, `${cat.machine_types[x.t]?.name?.replace(/^\[\d+\]\s*/, '') || ''} · ${x.n}`]), (v) => { hw.machine = v; ridisegna(); }),
        sel('Processore', `${hw.cpu_family}|${hw.cpu_speed}`, cpus.map((x) => [`${x.family}|${x.speed}`, x.label]), (v) => { const [f, s] = v.split('|'); hw.cpu_family = f; hw.cpu_speed = Number(s); ridisegna(); },
          h(`span.r-cost.c${c.livello}`, null, c.testo)),
        h('label.r-field', null, h('span', null, 'Esecuzione'), h('label.r-check', null,
          h('input', { type: 'checkbox', checked: !!hw.jit, onchange: (e) => { hw.jit = e.target.checked; ridisegna(); } }),
          ' Ricompilatore dinamico (JIT): più veloce dell\'interprete')),
        sel('Memoria RAM', hw.ram, rams.map((r) => [r, `${r} MB`]), (v) => { hw.ram = Number(v); ridisegna(); }),
        sel('Scheda video', hw.video, [['internal', '(integrata nella scheda madre)'], ...devs('video')], (v) => { hw.video = v; ridisegna(); }),
        sel('Scheda audio', hw.sound, [['none', 'Nessuna'], ...devs('sound')], (v) => { hw.sound = v; ridisegna(); }),
        sel('Sintetizzatore MIDI', hw.midi, cat.midi_out.filter((d) => d.a).map((d) => [d.i, d.i === 'none' ? 'Nessuno' : d.i === 'opl4-ml' ? 'General MIDI (Yamaha OPL4-ML, wavetable)' : d.n]), (v) => { hw.midi = v; if (v !== 'none' && hw.mpu === false && !/^sb16|^sbawe/.test(hw.sound)) hw.mpu = true; ridisegna(); }),
        h('label.r-field', null, h('span', null, 'Interfaccia MIDI'), h('label.r-check', null,
          h('input', { type: 'checkbox', checked: !!hw.mpu, onchange: (e) => { hw.mpu = e.target.checked; ridisegna(); } }),
          ' Roland MPU-401 a 330h (modalità intelligente, per i giochi Sierra e MT-32)')),
        sel('Mouse', hw.mouse, cat.mouse.filter((d) => d.a !== 0).map((d) => [d.i, d.n]), (v) => { hw.mouse = v; ridisegna(); }),
        sel('Joystick', hw.joystick || 'none', [['none', 'Nessuno'], ...JOYSTICK.filter(([i]) => cat.joysticks.some((j) => j.i === i)),
          ...cat.joysticks.filter((j) => j.i !== 'none' && !JOYSTICK.some(([i]) => i === j.i)).map((j) => [j.i, j.n])], (v) => { hw.joystick = v; ridisegna(); },
          h('span.r-cost.c0', { title: 'I pad compaiono al browser dopo la pressione di un pulsante' }, padCollegati())),
        sel('Floppy A:', hw.fdd_a, [['35_2hd', '3½" 1,44 MB'], ['35_2dd', '3½" 720 KB'], ['525_2hd', '5¼" 1,2 MB'], ['525_2dd', '5¼" 360 KB'], ['35_2ed', '3½" 2,88 MB']], (v) => { hw.fdd_a = v; ridisegna(); }),
        sel('Floppy B:', hw.fdd_b, [['none', 'Nessuno'], ['525_2hd', '5¼" 1,2 MB'], ['35_2hd', '3½" 1,44 MB'], ['525_2dd', '5¼" 360 KB']], (v) => { hw.fdd_b = v; ridisegna(); }),
        h('label.r-field', null, h('span', null, 'CD-ROM'), h('label.r-check', null,
          h('input', { type: 'checkbox', checked: !!hw.cdrom, onchange: (e) => { hw.cdrom = e.target.checked; ridisegna(); } }), ' Lettore ATAPI sul canale IDE secondario (D:)')),
      );
      const err = P.verifica(cat, hw);
      if (err.length) campi.append(h('p.r-warn', null, err.join(' · ')));
      if (mm.i !== 'vli486sv2g')
        campi.append(h('p.r-note', null, 'Primo avvio con questa scheda madre: entra nel SETUP del BIOS con CANC e imposta il disco C: (500 cilindri, 16 testine, 63 settori) o usa IDE HDD AUTO DETECTION.'));
    };
    disegnaCampi();

    const salva = async (comeNuovo) => {
      let target = p;
      if (p.predefinito || comeNuovo) {
        const nome = await prompt('Nome del nuovo profilo:', comeNuovo ? `${p.nome} (copia)` : `${p.nome} personalizzato`, { title: 'Salva profilo' });
        if (!nome) return;
        target = { ...p, id: `p${Date.now().toString(36)}`, nome, predefinito: false };
        app.profili.push(target);
      }
      target.hw = { ...hw };
      app.stato.profilo = target.id; saveStato();
      await salvaProfiliServer();
      disegnaElenco(); disegnaForm();
    };

    const avanzate = async () => {
      const cfg = P.cfgPerProfilo(cat, { ...p, hw }, { hddPath: S.hddPath() });
      const res = await openSettings({ catalog: cat, ini: new Ini(cfg), vm: P.VM, files: null });
      if (!res) return;
      const nuovo = P.profiloDaCfg(cat, { ...p, hw }, res.toString());
      Object.assign(hw, nuovo.hw);
      p._extraTemp = nuovo.extra;
      modificato = true;
      disegnaCampi();
      messageBox({ title: 'Retro486', text: 'Impostazioni avanzate applicate al profilo. Salvalo per conservarle.' });
    };

    form.replaceChildren(riquadro(`CONFIGURA · ${p.nome}`,
      h('p.r-note', null, p.descrizione || ''),
      campi,
      h('div.r-actions', null,
        pulsante(p.predefinito ? 'Salva come profilo personale' : 'Salva', async () => { if (p._extraTemp) { p.extra = p._extraTemp; delete p._extraTemp; } await salva(false); }),
        pulsante('Duplica', () => salva(true)),
        pulsante('Impostazioni avanzate 86Box...', avanzate),
        p.predefinito ? null : pulsante('Elimina', async () => {
          if (!(await confirm(`Eliminare il profilo "${p.nome}"?`, { title: 'Retro486', yes: 'Elimina', no: 'Annulla' }))) return;
          app.profili = app.profili.filter((x) => x !== p);
          app.stato.profilo = app.profili[0].id; saveStato();
          await salvaProfiliServer(); disegnaElenco(); disegnaForm();
        }, '.r-danger'),
        pulsante([pix('power'), 'Accendi con questa configurazione'], async () => {
          if (modificato && !(await confirm('Le modifiche non salvate valgono solo per questa accensione. Accendere?', { title: 'Retro486', yes: 'Accendi', no: 'Annulla' }))) return;
          accendi({ hwTemp: modificato ? { ...p, hw: { ...hw }, extra: p._extraTemp ?? p.extra } : null });
        }, '.r-big'))));
  };

  disegnaElenco(); disegnaForm();
  wrap.append(riquadro('PROFILI', elenco, h('p.r-note', null, 'I profili personali sono salvati sul server.')), form);
  return wrap;
}

async function salvaProfiliServer() {
  const personali = app.profili.filter((p) => !p.predefinito).map(({ _extraTemp, ...p }) => p);
  try { await S.salvaProfili(personali); } catch (e) { messageBox({ title: 'Retro486', kind: 'warning', text: `Profilo salvato solo in questa pagina: il server non risponde.\n${e.message}` }); }
}

// ---------------------------------------------------------------- HARD DISK

const TESTO = /\.(BAT|SYS|TXT|INI|CFG|DOC|ME|LST|NFO|ASC|LOG|DIZ|1ST|BAS|C|H|PAS|ASM|INF)$/i;

async function assicuraDisco() {
  if (await S.discoLocalePresente()) return true;
  const d = (app.srv.dischi || []).find((x) => x.nome === 'c');
  if (!d) { await messageBox({ title: 'Retro486', kind: 'warning', text: 'Nessun hard disk né in questo browser né sul server.\nPreparalo su Melchior con: node tools/crea-disco.mjs' }); return false; }
  const pd = progressDialog('Hard disk C:', `Scarico l'hard disk dal server (${formatSize(d.byte)})...`);
  try {
    await S.scaricaDisco(d, (done, tot, fase) => pd.update(tot ? done / tot : 0, fase === 'scarico' ? `Scarico dal server: ${formatSize(done)} di ${formatSize(tot)} (compresso)` : `Scrivo nello storage del browser: ${formatSize(done)}`));
  } finally { pd.close(); }
  return true;
}

async function pannelloDisco() {
  if (!(await assicuraDisco())) return h('div');
  if (!app.disco) app.disco = await Disco.apri();
  const disco = app.disco;
  const v = disco.vol;
  let cwd = app.stato.cwd && v.exists(app.stato.cwd) ? app.stato.cwd : '\\';
  let selezione = null;
  const lista = h('div.r-files');
  const intestazione = h('div.r-path');
  const piede = h('div.r-note');
  const azioni = h('div.r-actions');
  const anteprima = h('div.r-preview');

  const join = (dir, n) => (dir === '\\' ? `\\${n}` : `${dir}\\${n}`);
  const attrs = (a) => `${a & ATTR.RO ? 'R' : '-'}${a & ATTR.HIDDEN ? 'H' : '-'}${a & ATTR.SYSTEM ? 'S' : '-'}${a & ATTR.ARCHIVE ? 'A' : '-'}`;
  const data = (d) => (d ? `${d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit' })} ${d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}` : '');

  const aggiorna = () => {
    app.stato.cwd = cwd; saveStato();
    intestazione.textContent = `C:${cwd}`;
    const voci = v.list(cwd);
    const righe = [];
    if (cwd !== '\\') righe.push({ name: '..', isDir: true, su: true });
    righe.push(...voci);
    lista.replaceChildren(...righe.map((e) => {
      const el = h('div.r-file' + (e.isDir ? '.dir' : '') + (selezione === e.name ? '.on' : ''), {
        onclick: () => { selezione = e.name; aggiorna(); mostraAnteprima(e); },
        ondblclick: () => apri(e),
      },
      h('span.n', null, pix(e.su ? 'folder' : e.isDir ? 'folder' : /\.(EXE|COM|BAT)$/i.test(e.name) ? 'exe' : 'file', 'r-pix-s'), e.name),
      h('span.s', null, e.isDir ? (e.su ? '' : '<DIR>') : e.size.toLocaleString('it-IT')),
      h('span.d', null, data(e.mtime)),
      h('span.a', null, e.su ? '' : attrs(e.attr)));
      return el;
    }));
    const liberi = v.freeBytes;
    piede.textContent = `${voci.length} voci · liberi ${formatSize(liberi)} di ${formatSize(v.totalBytes)} · etichetta ${v.label}${disco.modificato ? ' · MODIFICHE NON SALVATE' : ''}`;
    disegnaAzioni();
  };

  const apri = (e) => {
    if (e.su) { cwd = cwd.split('\\').slice(0, -1).join('\\') || '\\'; selezione = null; aggiorna(); anteprima.replaceChildren(); return; }
    if (e.isDir) { cwd = join(cwd, e.name); selezione = null; aggiorna(); anteprima.replaceChildren(); return; }
    if (TESTO.test(e.name) || e.size < 64 * 1024) modifica(join(cwd, e.name));
  };

  const mostraAnteprima = (e) => {
    if (e.isDir || e.su) { anteprima.replaceChildren(); return; }
    const p = join(cwd, e.name);
    const bytes = v.readFile(p);
    const testo = TESTO.test(e.name) || [...bytes.subarray(0, 512)].every((b) => b === 9 || b === 10 || b === 13 || b === 26 || (b >= 32));
    anteprima.replaceChildren(h('div.r-box-title', null, e.name),
      testo ? h('pre.r-text', null, decode437(bytes.subarray(0, 8192)).replace(/\x1a.*$/s, ''))
        : h('pre.r-hex', null, hexdump(bytes.subarray(0, 512))));
  };

  const modifica = async (path) => {
    const ta = h('textarea.r-editor', { spellcheck: false }, decode437(v.readFile(path)).replace(/\r\n/g, '\n').replace(/\x1a$/, ''));
    const ok = await dialog({ title: `EDIT · C:${path}`, className: 'r-dialog', width: 'min(900px, 96vw)', body: [ta],
      buttons: [{ label: 'Salva', value: true, default: true }, { label: 'Annulla', value: false }] });
    if (!ok) return;
    v.writeFile(path, encode437(ta.value.replace(/\n/g, '\r\n')), { attr: v.lookup(path).attr });
    aggiorna();
  };

  const disegnaAzioni = () => {
    const e = selezione ? v.lookup(join(cwd, selezione)) : null;
    azioni.replaceChildren(...[
      pulsante('Carica file qui...', async () => {
        const files = await pickFiles({ multiple: true });
        await caricaFile(files);
      }),
      pulsante('Carica cartella...', async () => {
        const input = h('input', { type: 'file', webkitdirectory: true, multiple: true, style: { display: 'none' } });
        input.onchange = () => caricaFile([...input.files], true);
        document.body.append(input); input.click(); setTimeout(() => input.remove(), 60000);
      }),
      pulsante('Nuova cartella', async () => {
        const n = await prompt('Nome della cartella (8.3):', '', { title: 'MD', validate: (x) => { try { sanitizeName(x); return x && /^[^.]{1,8}(\.[^.]{0,3})?$/.test(x) ? null : 'Massimo 8 caratteri + 3 di estensione'; } catch (er) { return er.message; } } });
        if (!n) return;
        try { v.mkdir(join(cwd, n)); } catch (er) { messageBox({ title: 'MD', kind: 'warning', text: er.message }); }
        aggiorna();
      }),
      e && !e.isDir ? pulsante('Modifica', () => modifica(join(cwd, selezione))) : null,
      e && !e.isDir ? pulsante('Scarica', () => downloadBlob(new Blob([v.readFile(join(cwd, selezione))]), selezione)) : null,
      (e && e.isDir) || (!e && cwd !== '\\') ? pulsante('Scarica ZIP', () => {
        const base = e ? join(cwd, selezione) : cwd;
        const file = [];
        const visita = (dir, rel) => { for (const x of v.list(dir)) { const p = join(dir, x.name); if (x.isDir) visita(p, `${rel}${x.name}/`); else file.push({ name: `${rel}${x.name}`, data: v.readFile(p), mtime: x.mtime }); } };
        const nome = base.split('\\').pop();
        visita(base, `${nome}/`);
        if (!file.length) return messageBox({ title: 'Retro486', text: 'La cartella è vuota.' });
        downloadBlob(writeZip(file), `${nome}.zip`);
      }) : null,
      e ? pulsante('Rinomina', async () => {
        const n = await prompt('Nuovo nome:', selezione, { title: 'REN' });
        if (!n) return;
        try { v.rename(join(cwd, selezione), n); selezione = n.toUpperCase(); } catch (er) { messageBox({ title: 'REN', kind: 'warning', text: er.message }); }
        aggiorna();
      }) : null,
      e ? pulsante('Elimina', async () => {
        if (!(await confirm(`Eliminare ${e.isDir ? 'la cartella (con tutto il contenuto)' : 'il file'} C:${join(cwd, selezione)}?`, { title: 'DEL', yes: 'Elimina', no: 'Annulla' }))) return;
        v.remove(join(cwd, selezione), { recursive: true }); selezione = null; anteprima.replaceChildren(); aggiorna();
      }, '.r-danger') : null,
      h('span.r-grow'),
      pulsante('Salva modifiche sul disco', async () => {
        const n = await disco.salva();
        messageBox({ title: 'Retro486', text: n ? `Hard disk aggiornato (${n} blocchi da 64 KB).` : 'Nessuna modifica da salvare.' });
        aggiorna();
      }, disco.modificato ? '.r-big' : ''),
      pulsante('Annulla modifiche', async () => { app.disco = await Disco.apri(); app.mostra('disco'); }),
    ].filter(Boolean));
  };

  const caricaFile = async (files, cartella = false) => {
    if (!files.length) return;
    const errori = [];
    let n = 0;
    for (const f of files) {
      const rel = cartella ? (f.webkitRelativePath || f.name) : f.name;
      const parts = rel.split('/');
      let dir = cwd;
      try {
        for (const p of parts.slice(0, -1)) {
          const taken = new Set(v.list(dir).map((x) => x.name));
          const name = taken.has(p.toUpperCase()) ? p.toUpperCase() : sanitizeName(p, taken);
          if (!v.exists(join(dir, name))) v.mkdir(join(dir, name));
          dir = join(dir, name);
        }
        const taken = new Set(v.list(dir).map((x) => x.name));
        const up = parts[parts.length - 1].toUpperCase();
        let name;
        try { sanitizeName(up); name = /^[^.]{1,8}(\.[^.]{0,3})?$/.test(up) ? up : sanitizeName(up, taken); } catch (er) { name = sanitizeName(up, taken); }
        v.writeFile(join(dir, name), new Uint8Array(await f.arrayBuffer()), { when: new Date(f.lastModified) });
        n++;
      } catch (er) { errori.push(`${rel}: ${er.message}`); }
    }
    aggiorna();
    messageBox({ title: 'COPY', kind: errori.length ? 'warning' : 'info', text: `${n} file copiati in C:${cwd}.${errori.length ? `\n\nNon copiati:\n${errori.slice(0, 12).join('\n')}` : ''}\n\nPremi "Salva modifiche sul disco" per scriverli sull'hard disk.` });
  };

  // Trascinare file o cartelle dal computer sull'elenco li copia nella cartella aperta.
  const daVoce = (voce, rel = '') => new Promise((res) => {
    if (voce.isFile) voce.file((f) => { Object.defineProperty(f, 'webkitRelativePath', { value: rel + f.name }); res([f]); }, () => res([]));
    else if (voce.isDirectory) {
      const r = voce.createReader(); const tutti = [];
      const leggi = () => r.readEntries(async (voci) => {
        if (!voci.length) return res((await Promise.all(tutti)).flat());
        for (const x of voci) tutti.push(daVoce(x, `${rel}${voce.name}/`));
        leggi();
      }, () => res([]));
      leggi();
    } else res([]);
  });
  lista.addEventListener('dragover', (ev) => { ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; lista.classList.add('r-drop'); });
  lista.addEventListener('dragleave', () => lista.classList.remove('r-drop'));
  lista.addEventListener('drop', async (ev) => {
    ev.preventDefault(); lista.classList.remove('r-drop');
    const voci = [...(ev.dataTransfer.items || [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
    const files = voci.length ? (await Promise.all(voci.map((x) => daVoce(x)))).flat() : [...ev.dataTransfer.files];
    await caricaFile(files, true);
  });

  aggiorna();
  const info = S.infoLocale();
  return h('div.r-grid.r-grid-disk', null,
    riquadro('HARD DISK C:', intestazione,
      h('div.r-file.r-file-head', null, h('span.n', null, 'NOME'), h('span.s', null, 'BYTE'), h('span.d', null, 'DATA'), h('span.a', null, 'ATTR')),
      lista, piede, azioni),
    h('div', null, anteprima,
      riquadro('SERVER',
        h('p.r-note', null, info?.modificato ? 'La copia in questo browser ha modifiche che il server non ha.' : 'La copia in questo browser è allineata al server.'),
        h('div.r-actions', null,
          pulsante([pix('save'), 'Salva l\'hard disk sul server'], async () => {
            if (app.disco?.modificato && !(await confirm('Ci sono modifiche non ancora scritte sul disco: salvarle prima?', { title: 'Retro486', yes: 'Sì', no: 'No' }))) return;
            if (app.disco?.modificato) await app.disco.salva();
            const pd = progressDialog('Salvataggio sul server', 'Comprimo...');
            try { await S.caricaDisco('c', (d, t, f) => pd.update(t ? d / t : 0, f === 'invio' ? `Invio: ${formatSize(d)} di ${formatSize(t)}` : 'Comprimo...')); }
            catch (er) { pd.close(); messageBox({ title: 'Retro486', kind: 'error', text: er.message }); return; }
            pd.close(); app.srv = await S.stato(); app.mostra('disco');
          }),
          pulsante('Riscarica dal server', async () => {
            if (!(await confirm('Sostituire l\'hard disk di questo browser con quello del server? Le modifiche locali si perdono.', { title: 'Retro486', yes: 'Sostituisci', no: 'Annulla' }))) return;
            await storage.removeFile(S.hddRel()); app.disco = null; app.mostra('disco');
          }, '.r-danger'),
          pulsante('Scarica l\'immagine (.img)', async () => downloadBlob(await storage.getFile(S.hddRel()), 'retro486-c.img'))))));
}

function hexdump(b) {
  let s = '';
  for (let o = 0; o < b.length; o += 16) {
    const row = b.subarray(o, o + 16);
    s += `${o.toString(16).padStart(4, '0')}  ${[...row].map((x) => x.toString(16).padStart(2, '0')).join(' ').padEnd(48)}  ${decode437(row).replace(/[\x00-\x1f]/g, '.')}\n`;
  }
  return s;
}

// ---------------------------------------------------------------- LIBRERIA

async function pannelloLibreria() {
  const voci = app.srv.libreria || [];
  let installati = null;
  try {
    if (await S.discoLocalePresente()) {
      if (!app.disco) app.disco = await Disco.apri();
      installati = new Set(voci.filter((x) => app.disco.vol.exists(x.cartella.replace(/^C:/i, ''))).map((x) => x.id));
    }
  } catch (e) { console.warn(e); }

  const barra = h('div.r-actions', { style: { marginBottom: '24px' } },
    pulsante([pix('library'), 'Aggiungi un gioco...'], () => schedaGioco(), '.r-big'),
    h('span.r-note', null, 'Da un archivio ZIP con i file del gioco, o da una cartella già presente in C:\\GIOCHI.'));
  const carte = h('div.r-cards', null, ...voci.map((x) => {
    const consigliato = app.profili.find((p) => p.id === x.profilo);
    const inst = installati ? installati.has(x.id) : null;
    return h('article.r-card', null,
      h('div.r-card-cover', null, h('img', { src: x.copertina ? `dati/libreria/${x.copertina}` : 'assets/pixel/copertina.png', alt: '', onerror: (e) => e.target.replaceWith(h('span', null, x.titolo.slice(0, 1))) }), h('span.r-card-title', null, x.titolo)),
      h('div.r-card-body', null,
        h('h3', null, x.titolo), x.sottotitolo ? h('div.r-sub', null, x.sottotitolo) : null,
        h('div.r-meta', null, [x.editore, x.anno, x.genere].filter(Boolean).join(' · ')),
        h('p', null, x.note || ''),
        h('div.r-meta', null, `${x.cartella}\\${x.avvio}`, inst === false ? ' · NON INSTALLATO su questo disco' : ''),
        h('div.r-actions', null,
          pulsante([pix('power'), 'Avvia'], () => accendi({ voce: x }), '.r-big'),
          consigliato && consigliato.id !== app.stato.profilo ? pulsante(`Avvia con "${consigliato.nome}"`, () => { app.stato.profilo = consigliato.id; saveStato(); accendi({ voce: x }); }) : null,
          pulsante('Apri cartella', () => { app.stato.cwd = x.cartella.replace(/^C:/i, ''); saveStato(); app.mostra('disco'); }),
          x.utente ? pulsante('Modifica', () => schedaGioco(x)) : null,
          x.utente ? pulsante('Rimuovi', () => rimuoviGioco(x), '.r-danger') : null)));
  }));
  return h('div', null, barra, voci.length ? carte : riquadro('LIBRERIA', h('p', null, 'La libreria è vuota o il server non risponde.')));
}

// Le voci aggiunte dal portale stanno sul server in dati/libreria-utente.json.
async function salvaLibreria() {
  await S.salvaLibreriaUtente((app.srv.libreria || []).filter((x) => x.utente));
}

// Nomi 8.3 per un albero di file con nomi qualsiasi: { 'DIR\\FILE.EXT': voce dello ZIP }.
function albero83(file) {
  const dirs = new Map(); // percorso originale -> { nome83, presi }
  dirs.set('', { p: '', presi: new Set() });
  const out = {};
  for (const f of file) {
    const parti = f.rel.split('/').filter(Boolean);
    let chiave = '';
    for (const [i, seg] of parti.entries()) {
      const d = dirs.get(chiave);
      const ultima = i === parti.length - 1;
      const sotto = `${chiave}/${seg}`;
      if (!ultima && dirs.has(sotto)) { chiave = sotto; continue; }
      const n = sanitizeName(seg, d.presi);
      d.presi.add(n);
      const p = d.p ? `${d.p}\\${n}` : n;
      if (ultima) out[p] = f; else { dirs.set(sotto, { p, presi: new Set() }); chiave = sotto; }
    }
  }
  return out;
}

// Aggiunge un gioco (da un archivio ZIP o da una cartella già presente su C:) o ne modifica la scheda.
async function schedaGioco(voce = null) {
  if (!(await assicuraDisco())) return;
  if (!app.disco) app.disco = await Disco.apri();
  const v = app.disco.vol;
  const nuovo = !voce;
  let zip = null;          // { nome, file: [{ rel, size, read }] }
  let copertina = null;    // File
  let copiato = false;     // i file dello ZIP sono già su C: (se il server poi non risponde si riprova senza ricopiare)
  const campo = (val = '', attr = {}) => h('input', { type: 'text', value: val ?? '', ...attr });
  const titolo = campo(voce?.titolo, { maxLength: 80 });
  const sottotitolo = campo(voce?.sottotitolo, { maxLength: 160 });
  const editore = campo(voce?.editore, { maxLength: 60 });
  const anno = h('input', { type: 'number', min: 1975, max: 2100, value: voce?.anno ?? '' });
  const genere = campo(voce?.genere, { maxLength: 40 });
  const cartella = campo(voce ? voce.cartella.replace(/^C:\\GIOCHI\\/i, '') : '', { maxLength: 8, style: { textTransform: 'uppercase' }, disabled: !nuovo });
  const avvio = h('select');
  const argomenti = campo(voce ? voce.avvio.split(' ').slice(1).join(' ') : '', { maxLength: 60, placeholder: '(facoltativi)' });
  const profiloSel = h('select', null, h('option', { value: '' }, '(quello selezionato)'), ...app.profili.map((p) => h('option', { value: p.id, selected: voce?.profilo === p.id }, p.nome)));
  const note = h('textarea', { rows: 3, maxLength: 600, style: { width: '100%' } }, voce?.note || '');
  const statoZip = h('span.muted', null, nuovo ? 'nessun archivio: userò una cartella già presente in C:\\GIOCHI' : '');
  const statoCop = h('span.muted', null, voce?.copertina ? voce.copertina : 'copertina predefinita');
  const errore = h('div', { style: { color: '#c00000', minHeight: '1.3em' } });

  const eseguibili = () => {
    let nomi = [];
    if (zip) nomi = Object.keys(albero83(zip.file)).filter((n) => !n.includes('\\'));
    else { const d = `\\GIOCHI\\${cartella.value.toUpperCase()}`; if (cartella.value && v.exists(d)) nomi = v.list(d).filter((e) => !e.isDir).map((e) => e.name); }
    nomi = nomi.filter((n) => /\.(EXE|COM|BAT)$/.test(n));
    const peso = (n) => (/^(SETUP|INSTALL|CONFIG|SETSOUND|SOUND|README|UNINSTAL)/.test(n) ? 2 : /\.BAT$/.test(n) ? 1 : 0);
    nomi.sort((a, b) => peso(a) - peso(b) || a.localeCompare(b));
    const attuale = voce?.avvio.split(' ')[0] || avvio.value;
    avvio.replaceChildren(...nomi.map((n) => h('option', { value: n, selected: n === attuale }, n)));
  };
  cartella.addEventListener('input', eseguibili);

  const scegliZip = async () => {
    const [f] = await pickFiles({ accept: '.zip,application/zip' });
    if (!f) return;
    try {
      let file = readZip(await f.arrayBuffer()).map((e) => ({ ...e, rel: e.name }));
      // una sola cartella in cima all'archivio: si entra dentro
      const cime = new Set(file.map((e) => e.rel.split('/')[0]));
      if (cime.size === 1 && file.every((e) => e.rel.includes('/'))) file = file.map((e) => ({ ...e, rel: e.rel.slice(e.rel.indexOf('/') + 1) }));
      if (!file.length) throw new Error('archivio vuoto');
      zip = { nome: f.name, file };
      const byte = file.reduce((a, e) => a + e.size, 0);
      statoZip.textContent = `${f.name}: ${file.length} file, ${formatSize(byte)} (liberi su C: ${formatSize(v.freeBytes)})`;
      const base = f.name.replace(/\.zip$/i, '');
      if (!cartella.value) cartella.value = sanitizeName(base).split('.')[0];
      if (!titolo.value) titolo.value = base.replace(/[_.]+/g, ' ');
      errore.textContent = '';
      eseguibili();
    } catch (e) { zip = null; errore.textContent = `Archivio non leggibile: ${e.message}`; }
  };
  const scegliCopertina = async () => {
    const [f] = await pickFiles({ accept: 'image/png,image/jpeg,image/webp,image/gif' });
    if (!f) return;
    if (f.size > 2 << 20) { errore.textContent = 'Copertina oltre 2 MB'; return; }
    copertina = f; statoCop.textContent = f.name;
  };
  eseguibili();

  const riga = (et, ...el) => [h('label', null, et), h('div.span2', null, ...el)];
  const conferma = async () => {
    errore.textContent = '';
    const dir = cartella.value.toUpperCase();
    if (!titolo.value.trim()) { errore.textContent = 'Manca il titolo'; return false; }
    if (!/^[A-Z0-9_-]{1,8}$/.test(dir)) { errore.textContent = 'Cartella: da 1 a 8 lettere, cifre, _ o -'; return false; }
    const percorso = `\\GIOCHI\\${dir}`;
    if (nuovo && zip && !copiato && v.exists(percorso)) { errore.textContent = `C:${percorso} esiste già: scegli un altro nome di cartella`; return false; }
    if (nuovo && !zip && !v.exists(percorso)) { errore.textContent = `C:${percorso} non esiste: scegli un archivio ZIP o una cartella presente`; return false; }
    if (!avvio.value) { errore.textContent = 'Nessun programma (.EXE, .COM, .BAT) nella cartella del gioco'; return false; }
    if (!/^[ -~]*$/.test(argomenti.value)) { errore.textContent = 'Argomenti: solo caratteri ASCII'; return false; }
    const x = voce || { id: `u${Date.now().toString(36)}`, utente: true };
    if (nuovo && zip && !copiato) {
      const byte = zip.file.reduce((a, e) => a + e.size, 0);
      if (byte + zip.file.length * v.clusterBytes > v.freeBytes) { errore.textContent = `Spazio insufficiente su C: servono ${formatSize(byte)}, liberi ${formatSize(v.freeBytes)}`; return false; }
      const pd = progressDialog('Retro486', 'Copio il gioco sull\'hard disk...');
      try {
        const tree = albero83(zip.file);
        const nomi = Object.keys(tree);
        v.mkdirp(percorso);
        for (const [i, n] of nomi.entries()) {
          pd.update(i / nomi.length, `${n} (${i + 1} di ${nomi.length})`);
          v.writeTree(percorso, { [n]: await tree[n].read() });
        }
        pd.update(1, 'Scrivo sul disco...');
        await app.disco.salva();
        copiato = true; cartella.disabled = true;
      } catch (e) {
        try { if (v.exists(percorso)) v.remove(percorso, { recursive: true }); await app.disco.salva(); } catch (e2) { console.warn(e2); }
        errore.textContent = `Copia non riuscita: ${e.message}`;
        return false;
      } finally { pd.close(); }
    }
    Object.assign(x, { titolo: titolo.value.trim(), sottotitolo: sottotitolo.value.trim(), editore: editore.value.trim(), genere: genere.value.trim(),
      anno: Number(anno.value) || undefined, cartella: `C:${percorso}`, avvio: `${avvio.value}${argomenti.value.trim() ? ` ${argomenti.value.trim()}` : ''}`,
      profilo: profiloSel.value || undefined, note: note.value.trim() });
    for (const k of Object.keys(x)) if (x[k] === '' || x[k] === undefined) delete x[k];
    try {
      if (copertina) x.copertina = (await S.caricaCopertina(x.id, copertina)).file;
      if (nuovo) app.srv.libreria = [...(app.srv.libreria || []), x];
      await salvaLibreria();
    } catch (e) {
      if (nuovo) app.srv.libreria = (app.srv.libreria || []).filter((y) => y !== x);
      errore.textContent = `Il server non ha salvato la scheda: ${e.message}`;
      return false;
    }
    return true;
  };

  const ok = await dialog({
    title: nuovo ? 'Aggiungi un gioco alla libreria' : `Scheda di ${voce.titolo}`,
    width: '640px',
    body: [h('div.form', null,
      ...(nuovo ? riga('Archivio ZIP:', h('button.btn', { type: 'button', onclick: scegliZip }, 'Scegli...'), ' ', statoZip) : []),
      ...riga('Titolo:', titolo), ...riga('Sottotitolo:', sottotitolo),
      ...riga('Editore:', editore), ...riga('Anno:', anno), ...riga('Genere:', genere),
      ...riga('Cartella in C:\\GIOCHI:', cartella), ...riga('Programma:', avvio), ...riga('Argomenti:', argomenti),
      ...riga('Profilo consigliato:', profiloSel),
      ...riga('Copertina:', h('button.btn', { type: 'button', onclick: scegliCopertina }, 'Scegli...'), ' ', statoCop),
      ...riga('Note:', note)), errore],
    buttons: [{ label: nuovo ? 'Aggiungi' : 'Salva', default: true, value: true, onClick: conferma }, { label: 'Annulla', value: false }],
  });
  if (!ok) return;
  if (nuovo && zip) await messageBox({ title: 'Retro486', text: 'Gioco copiato sull\'hard disk di questo browser. Per ritrovarlo dagli altri dispositivi salva il disco sul server dal pannello HARD DISK.' });
  app.mostra('libreria');
}

async function rimuoviGioco(x) {
  const dir = x.cartella.replace(/^C:/i, '');
  const scelta = await dialog({
    title: 'Retro486',
    body: h('p', null, `Togliere "${x.titolo}" dalla libreria? Si possono cancellare anche i file in ${x.cartella}.`),
    buttons: [{ label: 'Solo dalla libreria', value: 'voce', default: true }, { label: 'Anche i file', value: 'file' }, { label: 'Annulla', value: null }],
  });
  if (!scelta) return;
  const prima = app.srv.libreria;
  app.srv.libreria = prima.filter((y) => y !== x);
  try { await salvaLibreria(); } catch (e) {
    app.srv.libreria = prima;
    return messageBox({ title: 'Retro486', kind: 'warning', text: `Il server non ha salvato la libreria: ${e.message}` });
  }
  if (scelta === 'file' && /^\\GIOCHI\\[^\\]+$/i.test(dir) && await S.discoLocalePresente()) {
    if (!app.disco) app.disco = await Disco.apri();
    if (app.disco.vol.exists(dir)) { app.disco.vol.remove(dir, { recursive: true }); await app.disco.salva(); }
  }
  app.mostra('libreria');
}

// ---------------------------------------------------------------- MEDIA

async function pannelloMedia() {
  const media = app.srv.media || [];
  const st = app.stato.media || (app.stato.media = {});
  const p = profilo();
  const unita = [['a', 'Floppy A:', /floppy/], ['b', 'Floppy B:', /floppy/], ['cd', 'CD-ROM D:', /cdrom/]];
  const box = h('div.r-grid');
  const elenco = h('div.r-files.r-media');
  const disegna = () => {
    elenco.replaceChildren(...media.map((m) => h('div.r-file', null,
      h('span.n', null, m.nome), h('span.s', null, formatSize(m.byte)), h('span.d', null, m.tipo === 'cdrom' ? 'CD' : 'FLOPPY'),
      h('span.a', null, ...unita.filter(([, , re]) => re.test(m.tipo)).filter(([k]) => k !== 'b' || p.hw.fdd_b !== 'none').filter(([k]) => k !== 'cd' || p.hw.cdrom)
        .map(([k, n]) => h('button.r-mini' + (st[k] === m.file ? '.on' : ''), { type: 'button', onclick: () => { st[k] = st[k] === m.file ? null : m.file; saveStato(); disegna(); } }, n.split(' ')[1]))))));
  };
  disegna();
  box.append(
    riquadro('SUPPORTI SUL SERVER', h('p.r-note', null, 'Scegli cosa inserire nelle unità all\'accensione. A macchina accesa si cambiano dal menu Media.'), elenco),
    riquadro('UNITA\'', h('table.r-spec', null, ...unita.map(([k, n]) => h('tr', null, h('th', null, n), h('td', null, st[k] || '(vuoto)')))),
      h('p.r-note', null, 'Floppy di MS-DOS 6.22: per reinstallare il sistema o usare FDISK e FORMAT. Windows 3.11: l\'ISO va inserito nel CD-ROM, poi D:\\SETUP da DOS.'),
      h('div.r-actions', null, pulsante('Svuota tutte', () => { app.stato.media = {}; saveStato(); app.mostra('media'); }))));
  return box;
}

// ---------------------------------------------------------------- MONITOR

async function pannelloMonitor() {
  const s = app.crt;
  const prova = document.createElement('canvas');
  prova.width = 640; prova.height = 400;
  disegnaProva(prova);
  const crt = creaCrt(prova, s);
  const vista = h('div.r-crt-preview.r-monitor-frame', null, crt.ok ? crt.canvas : h('div.r-crt-wrap', null, prova, h('div.crt-css')));
  const draw = () => { crt.set(app.crt); crt.draw(); };
  let raf = 0;
  const loop = () => { draw(); raf = requestAnimationFrame(loop); if (!vista.isConnected) cancelAnimationFrame(raf); };
  setTimeout(loop, 0);

  const sliders = h('div.r-fields');
  const gruppi = {};
  for (const [k, label, min, max, step, g] of PARAMS) {
    const val = h('span.r-val', null, String(s[k]));
    const inp = h('input', { type: 'range', min, max, step, value: s[k], oninput: (e) => { app.crt[k] = Number(e.target.value); app.crt.preset = 'personale'; val.textContent = e.target.value; saveCrtSettings(app.crt); } });
    (gruppi[g] ||= []).push(h('label.r-field', null, h('span', null, label), inp, val));
  }
  for (const [g, els] of Object.entries(gruppi)) sliders.append(h('div.r-group', null, g.toUpperCase()), ...els);

  const presets = h('select', { onchange: (e) => { app.crt = { preset: e.target.value, ...PRESETS.vga14, ...PRESETS[e.target.value] }; saveCrtSettings(app.crt); app.mostra('monitor'); } },
    ...Object.entries(PRESETS).map(([id, p]) => h('option', { value: id, selected: s.preset === id }, p.nome)),
    s.preset === 'personale' ? h('option', { value: 'personale', selected: true, disabled: true }, 'Personalizzato') : null);

  return h('div.r-grid', null,
    riquadro('MONITOR CRT', h('label.r-field', null, h('span', null, 'Modello'), presets), vista,
      h('p.r-note', null, crt.software ? 'Questo browser non ha WebGL (accelerazione GPU): il CRT usa il motore Canvas 2D, con le stesse regolazioni e la curvatura approssimata. In Chrome, Edge o Firefox con GPU si usa lo shader WebGL2.' : 'Shader WebGL2: lo stesso della macchina accesa.')),
    riquadro('REGOLAZIONI', sliders));
}

function disegnaProva(c) {
  const g = c.getContext('2d');
  const pal = ['#000000', '#0000AA', '#00AA00', '#00AAAA', '#AA0000', '#AA00AA', '#AA5500', '#AAAAAA', '#555555', '#5555FF', '#55FF55', '#55FFFF', '#FF5555', '#FF55FF', '#FFFF55', '#FFFFFF'];
  g.fillStyle = '#0000AA'; g.fillRect(0, 0, 640, 400);
  pal.forEach((col, i) => { g.fillStyle = col; g.fillRect(20 + i * 37.5, 250, 37.5, 60); });
  g.font = '16px "Retro486 VGA", monospace';
  g.fillStyle = '#FFFF55';
  g.fillText('C:\\>MEM', 24, 40);
  g.fillStyle = '#AAAAAA';
  ['Memoria convenzionale   640K', 'Memoria estesa (XMS)  15.360K', 'MS-DOS è residente nell\'area di memoria alta.', 'C:\\GIOCHI\\LARRY3>SIERRA'].forEach((t, i) => g.fillText(t, 24, 72 + i * 20));
  g.strokeStyle = '#FFFFFF';
  for (let x = 20; x < 620; x += 40) { g.beginPath(); g.moveTo(x, 330); g.lineTo(x, 380); g.stroke(); }
  g.fillStyle = '#55FFFF'; g.fillText('████ ▓▓▓▓ ▒▒▒▒ ░░░░  Retro486', 24, 226);
}

const PANNELLI = { sistema: pannelloSistema, configura: pannelloConfigura, disco: pannelloDisco, libreria: pannelloLibreria, media: pannelloMedia, monitor: pannelloMonitor };

// ---------------------------------------------------------------- accensione

async function accendi({ voce = null, hwTemp = null } = {}) {
  const emu = app.emu;
  if (emu.state !== State.WAITING) {
    // 86Box si avvia una sola volta per pagina: ricarico e riparto.
    app.stato.avvioVoce = voce?.id || null; saveStato();
    location.href = `${location.pathname}?accendi=1`;
    return;
  }
  const p = hwTemp || profilo();
  const errs = P.verifica(app.catalog, p.hw);
  if (errs.length) { await messageBox({ title: 'Retro486', kind: 'warning', text: `Configurazione non valida:\n${errs.join('\n')}` }); portale(); return; }
  if (!(await assicuraDisco())) { portale(); return; }

  schermataMessaggio('ACCENSIONE', `${p.nome}\n${voce ? `Avvio di ${voce.titolo}` : 'Avvio di MS-DOS'}...`, { barra: true });
  if (app.disco?.modificato && await confirm('L\'esplora-disco ha modifiche non salvate. Scriverle sul disco prima di accendere?', { title: 'Retro486', yes: 'Scrivi', no: 'Scarta' })) await app.disco.salva();
  app.disco = null;
  await preparaAvvio({ voce, profilo: p });
  await S.preparaNvr(p.hw.machine, app.srv);

  // supporti
  const media = app.stato.media || {};
  const m = (k) => (app.srv.media || []).find((x) => x.file === media[k]);
  const percorsi = {};
  for (const k of ['a', 'b', 'cd']) {
    if (!m(k)) continue;
    if (k === 'b' && p.hw.fdd_b === 'none') continue;
    if (k === 'cd' && !p.hw.cdrom) continue;
    try { percorsi[k] = await S.preparaMedia(m(k)); } catch (e) { console.warn(e); }
  }
  let cfg = P.cfgPerProfilo(app.catalog, p, { hddPath: S.hddPath(), cdromImage: percorsi.cd || '' });
  const ini = new Ini(cfg);
  if (percorsi.a) ini.set('Floppy and CD-ROM drives', 'fdd_01_fn', percorsi.a);
  if (percorsi.b) ini.set('Floppy and CD-ROM drives', 'fdd_02_fn', percorsi.b);
  cfg = ini.toString();
  await storage.writeFile(`vms/${P.VM}/86box.cfg`, cfg);
  macchina(p, voce);
}

function macchina(p, voce) {
  document.onkeydown = null;
  let rumori = null;
  const host = h('div.r-machine-host');
  const barra = h('div.r-machine-bar', null,
    h('span.r-logo.small', null, 'RETRO', h('b', null, '486')),
    h('span.r-machine-title', null, `${p.nome}${voce ? ` · ${voce.titolo}` : ''}`),
    h('span.r-grow'),
    h('label.r-check', { title: 'Ventola, hard disk, floppy e CD-ROM' }, h('input', { type: 'checkbox', checked: !!app.stato.rumori, onchange: (e) => { app.stato.rumori = e.target.checked; saveStato(); rumori.imposta({ attivo: e.target.checked }); } }), ' Rumori'),
    h('label.r-check', { title: 'Nasconde menu e barre di 86Box: resta solo lo schermo' }, h('input', { type: 'checkbox', checked: !!app.stato.soloSchermo, onchange: (e) => { app.stato.soloSchermo = e.target.checked; saveStato(); host.classList.toggle('solo', e.target.checked); } }), ' Solo schermo'),
    h('label.r-check', null, h('input', { type: 'checkbox', checked: app.crt.enabled !== false, onchange: (e) => { app.crt.enabled = e.target.checked; saveCrtSettings(app.crt); applicaCrt(); } }), ' CRT'),
    pulsante('Schermo intero', () => app.window.fullscreen()),
    pulsante('Torna al portale', async () => {
      if (await confirm('Spegnere il PC e tornare al portale? Il disco resta come lo ha lasciato MS-DOS: meglio uscire dai programmi prima.', { title: 'Retro486', yes: 'Spegni', no: 'Annulla' })) app.emu.command('power_off');
    }));
  const bezel = h('div.r-bezel.r-monitor-frame', null, host);
  // il monitor resta 4:3 qualunque sia la finestra: il palco lo centra e gli dà la misura (vedi .r-stage)
  const palco = h('div.r-stage', null, bezel);
  root.replaceChildren(h('div.r-machine', null, barra, palco));

  const win = new MainWindow({
    root: host, emu: app.emu, vm: P.VM, catalog: app.catalog,
    onExit: () => { location.href = location.pathname; },
  });
  app.window = win;
  host.classList.toggle('solo', !!app.stato.soloSchermo);
  rumori = new Rumori(app.emu, win, { volume: app.stato.rumoriVolume ?? 0.5 });
  if (app.stato.rumori) rumori.accendi();

  // monitor CRT sovrapposto al canvas di 86Box
  const crt = creaCrt(win.canvas, app.crt);
  // senza WebGL: scanline e vignettatura in CSS sopra il canvas originale
  const velo = h('div.crt-css', { hidden: true });
  win.screen.append(crt.canvas, velo);
  const posiziona = () => {
    const c = win.canvas;
    const box = { left: `${c.offsetLeft}px`, top: `${c.offsetTop}px`, width: `${c.offsetWidth}px`, height: `${c.offsetHeight}px` };
    Object.assign(crt.canvas.style, box);
    Object.assign(velo.style, box);
    crt.draw();
  };
  const applicaCrt = () => {
    const vuole = app.crt.enabled !== false;
    const on = crt.ok && vuole;
    crt.set(app.crt);
    crt.canvas.hidden = !on;
    velo.hidden = !(vuole && !crt.ok);
    win.canvas.style.opacity = on ? '0' : '1';
    win.canvas.style.borderRadius = vuole && !crt.ok ? '12px' : '';
    posiziona();
  };
  // altezza di menu, barra strumenti e barra di stato di 86Box: serve al CSS perché lo schermo, non la finestra, sia 4:3
  const cromo = () => { const c = host.clientHeight - win.screen.clientHeight; if (c >= 0) palco.style.setProperty('--cromo', `${c}px`); };
  new ResizeObserver(cromo).observe(host);
  new ResizeObserver(cromo).observe(win.screen);
  cromo();
  new ResizeObserver(posiziona).observe(win.canvas);
  new ResizeObserver(posiziona).observe(win.screen);
  app.emu.addEventListener('frame', () => { if (!crt.canvas.hidden) crt.draw(); });
  applicaCrt();

  win.reloadIni().then(() => {
    app.emu.start(storage.vmPath(P.VM));
    win.canvas.focus();
  });
}

main().catch((e) => {
  console.error(e);
  schermataMessaggio('ERRORE IMPREVISTO', String(e?.stack || e), { errore: true });
});
