// Retro486 - profili hardware: dalla descrizione di una macchina al file 86box.cfg.
//
// Un profilo è { id, nome, anno, descrizione, hw: {...}, extra: 'testo ini' }.
// `hw` contiene le scelte del pannello CONFIGURA; `extra` le sezioni che il
// dialogo avanzato di 86Box ha aggiunto (configurazioni dei dispositivi ecc.).
// Le unità (hard disk C:, CD-ROM, floppy) le aggiunge sempre il portale.

import { Ini } from '../ini.js';
import { deviceSection } from '../catalog.js';

export const VM = 'retro486';          // nome della macchina nello storage del browser
export const HDD = { file: 'c.img', spt: 63, heads: 16, cyl: 500 };

export const PREDEFINITI = [
  {
    id: 'dx33', nome: 'IBM compatibile 1992', anno: 1992,
    descrizione: 'Il 486 di riferimento: gira in tempo reale nel browser.',
    hw: { machine: 'vli486sv2g', cpu_family: 'i486dx', cpu_speed: 33333333, jit: true, ram: 8, video: 's3_86c805_vlb',
      sound: 'sb16', midi: 'mt32', mpu: true, mouse: 'ps2', fdd_a: '35_2hd', fdd_b: '525_2hd', cdrom: true },
  },
  {
    id: 'dx2-66', nome: 'Gaming Rig 1994', anno: 1994,
    descrizione: 'DX2-66 su VLB con S3 Trio64: il PC di Doom. In tempo reale con il ricompilatore dinamico.',
    hw: { machine: 'vli486sv2g', cpu_family: 'i486dx2', cpu_speed: 66666666, jit: true, ram: 16, video: 's3_trio64_vlb',
      sound: 'sb16', midi: 'mt32', mpu: true, mouse: 'ps2', fdd_a: '35_2hd', fdd_b: 'none', cdrom: true },
  },
  {
    id: 'dx4-100', nome: 'Top di gamma 1995', anno: 1995,
    descrizione: 'Intel DX4 a 100 MHz, 32 MB: il massimo del Socket 3. Richiede il ricompilatore dinamico.',
    hw: { machine: 'vli486sv2g', cpu_family: 'idx4', cpu_speed: 100000000, jit: true, ram: 32, video: 's3_trio64_vlb',
      sound: 'sb16', midi: 'mt32', mpu: true, mouse: 'ps2', fdd_a: '35_2hd', fdd_b: 'none', cdrom: true },
  },
  {
    id: 'sx25', nome: 'PC economico 1991', anno: 1991,
    descrizione: '486SX a 25 MHz senza coprocessore, 4 MB, Sound Blaster Pro e musica AdLib.',
    hw: { machine: 'vli486sv2g', cpu_family: 'i486sx', cpu_speed: 25000000, ram: 4, video: 'et4000ax',
      sound: 'sbprov2', midi: 'none', mpu: false, mouse: 'ps2', fdd_a: '35_2hd', fdd_b: '525_2hd', cdrom: false },
  },
  {
    id: 'win31', nome: 'Postazione Windows 3.11', anno: 1994,
    descrizione: 'DX2-66, 16 MB e S3 Trio64 per Windows per Workgroups 3.11.',
    hw: { machine: 'vli486sv2g', cpu_family: 'i486dx2', cpu_speed: 66666666, ram: 16, video: 's3_trio64_vlb',
      sound: 'sb16', midi: 'none', mpu: false, mouse: 'ps2', fdd_a: '35_2hd', fdd_b: 'none', cdrom: true },
  },
];

// Frequenza leggibile: 33333333 -> "33 MHz"
export function mhz(hz) { return `${Math.floor(hz / 1e6 + 0.01)} MHz`; }

// Il "costo" per il browser, misurato: l'interprete di 86Box in WebAssembly regge
// circa un 486 a 33-40 MHz in tempo reale su un desktop moderno; con il ricompilatore
// dinamico (jit) si arriva al DX4 a 100 MHz e all'Am5x86 a 133 MHz.
export function costo(hz, jit = false) {
  const m = hz / 1e6;
  if (jit) {
    if (m <= 100) return { livello: 0, testo: 'tempo reale' };
    if (m <= 133) return { livello: 1, testo: 'esigente' };
    return { livello: 2, testo: 'molto esigente' };
  }
  if (m <= 40) return { livello: 0, testo: 'tempo reale' };
  if (m <= 66) return { livello: 1, testo: 'esigente' };
  return { livello: 2, testo: 'molto esigente' };
}

// CPU idonee per una scheda madre: [{ family, famIndex, cpu, cpuIndex, label, speed }]
export function cpuChoices(catalog, machine) {
  const out = [];
  for (const { fam, cpus } of catalog.eligibleCpus(machine)) {
    const f = catalog.cpu_families[fam];
    if (!f) continue;
    for (const ci of cpus) {
      const c = f.cpus[ci];
      if (!c) continue;
      out.push({ family: f.i, famIndex: fam, cpuIndex: ci, speed: Number(c.s), multi: Number(c.x) || 1,
        label: `${f.m} ${f.n} ${c.n} MHz`, fpus: c.fpus || [] });
    }
  }
  return out;
}

export function machines486(catalog) {
  return catalog.machines.filter((m) => m.a && m.t >= 8 && m.t <= 13);
}

export function ramChoices(machine) {
  const [min, max, step] = (machine?.ram || [1024, 65536, 1024]).map(Number);
  const out = [];
  for (const mb of [1, 2, 4, 8, 12, 16, 20, 24, 32, 48, 64, 96, 128, 256]) {
    const kb = mb * 1024;
    if (kb >= min && kb <= max && (kb - min) % step === 0) out.push(mb);
  }
  return out;
}

// Controlla un profilo contro il catalogo: restituisce l'elenco dei problemi.
export function verifica(catalog, hw) {
  const errs = [];
  const m = catalog.machine(hw.machine);
  if (!m || !m.a) { errs.push(`Scheda madre non disponibile: ${hw.machine}`); return errs; }
  if (!cpuChoices(catalog, m).some((c) => c.family === hw.cpu_family && c.speed === hw.cpu_speed))
    errs.push('CPU non supportata da questa scheda madre');
  const dev = (key, id) => !id || id === 'none' || catalog.list(key, m).some((d) => d.i === id);
  if (!dev('video', hw.video)) errs.push(`Scheda video non compatibile: ${hw.video}`);
  if (!dev('sound', hw.sound)) errs.push(`Scheda audio non compatibile: ${hw.sound}`);
  return errs;
}

// Genera il testo di 86box.cfg per un profilo.
export function cfgPerProfilo(catalog, profilo, { hddPath, cdromImage = '' } = {}) {
  const hw = profilo.hw;
  const ini = new Ini(profilo.extra || '');
  const m = catalog.machine(hw.machine);
  const cpu = cpuChoices(catalog, m).find((c) => c.family === hw.cpu_family && c.speed === hw.cpu_speed)
    || cpuChoices(catalog, m)[0];

  ini.set('General', 'vid_renderer', 'web');
  ini.set('Machine', 'machine', hw.machine);
  ini.set('Machine', 'cpu_family', cpu.family);
  ini.set('Machine', 'cpu_speed', String(cpu.speed));
  ini.set('Machine', 'cpu_multi', String(cpu.multi));
  ini.set('Machine', 'cpu_use_dynarec', hw.jit ? '1' : '0'); // ricompilatore dinamico (backend WebAssembly)
  const fpu = cpu.fpus.find((f) => f[1] === 'internal') || cpu.fpus[0];
  ini.set('Machine', 'fpu_type', hw.fpu || (fpu ? fpu[1] : 'none'));
  ini.set('Machine', 'mem_size', String(hw.ram * 1024));

  ini.set('Video', 'gfxcard', hw.video || 'internal');
  ini.set('Input devices', 'mouse_type', hw.mouse || 'ps2');
  ini.set('Input devices', 'keyboard_type', 'keyboard_ps2');
  // Joystick sulla porta giochi: il primo pad visto dal browser diventa il joystick 1.
  // I tipi a due joystick (es. due pad a 2 pulsanti) prendono anche il secondo pad.
  const joy = hw.joystick && hw.joystick !== 'none' ? hw.joystick : 'none';
  ini.set('Input devices', 'joystick_type', joy);
  if (joy !== 'none') {
    const quanti = Math.max(1, Math.min(4, Number(catalog.joysticks?.find((j) => j.i === joy)?.max) || 1));
    for (let j = 0; j < quanti; j++) if (!ini.has('Input devices', `joystick_${j}_nr`)) ini.set('Input devices', `joystick_${j}_nr`, String(j + 1));
  }

  ini.set('Sound', 'sndcard', hw.sound || 'none');
  ini.set('Sound', 'midi_device', hw.midi || 'none');
  ini.set('Sound', 'mpu401_standalone', hw.mpu ? '1' : '0');
  if (!ini.has('Sound', 'fm_driver')) ini.set('Sound', 'fm_driver', 'nuked');
  // Con l'MPU-401 Roland (modalità intelligente) a 330h, quello UART della SB16 si spegne.
  const sb = catalog.find('sound', hw.sound);
  if (sb && /^sb16|^sbawe/.test(hw.sound)) {
    ini.set(deviceSection(sb, 1), 'base401', hw.mpu ? '0' : '816');
  }
  // La porta giochi (200h) è quella della Sound Blaster: accesa solo se c'è un joystick.
  if (sb && /^sb|^ess|^adgold/.test(hw.sound || '')) ini.set(deviceSection(sb, 1), 'gameport', joy !== 'none' ? '1' : '0');

  // Controller e unità
  if (!ini.has('Storage controllers', 'hdc_1')) {
    ini.set('Storage controllers', 'hdc_1', catalog.hasFlag(m, 'MACHINE_HDC') ? 'internal'
      : catalog.hasBus(m, 'MACHINE_BUS_PCI') ? 'ide_pci_2ch' : catalog.hasBus(m, 'MACHINE_BUS_VLB') ? 'ide_vlb_2ch' : 'ide_isa_2ch');
  }
  ini.set('Hard disks', 'hdd_01_parameters', `${HDD.spt}, ${HDD.heads}, ${HDD.cyl}, 0, ide`);
  ini.set('Hard disks', 'hdd_01_fn', hddPath);
  ini.set('Hard disks', 'hdd_01_ide_channel', '0:0');
  if (!ini.has('Hard disks', 'hdd_01_speed')) ini.set('Hard disks', 'hdd_01_speed', '1995_5400rpm');

  const F = 'Floppy and CD-ROM drives';
  ini.set(F, 'fdd_01_type', hw.fdd_a || '35_2hd');
  ini.set(F, 'fdd_02_type', hw.fdd_b || 'none');
  if (hw.cdrom) {
    ini.set(F, 'cdrom_01_parameters', '1, atapi');
    ini.set(F, 'cdrom_01_ide_channel', '1:0');
    if (!ini.has(F, 'cdrom_01_type')) ini.set(F, 'cdrom_01_type', '86cd');
    if (cdromImage) ini.set(F, 'cdrom_01_image_path', cdromImage);
  } else {
    ini.delete?.(F, 'cdrom_01_parameters');
    ini.set(F, 'cdrom_01_parameters', '0, none');
  }
  return ini.toString();
}

// Dal cfg modificato nel dialogo avanzato ricava di nuovo hw + extra.
export function profiloDaCfg(catalog, base, cfgText) {
  const ini = new Ini(cfgText);
  const g = (s, k, d = '') => ini.get(s, k, d);
  const hw = {
    ...base.hw,
    machine: g('Machine', 'machine', base.hw.machine),
    cpu_family: g('Machine', 'cpu_family', base.hw.cpu_family),
    cpu_speed: Number(g('Machine', 'cpu_speed', base.hw.cpu_speed)),
    jit: g('Machine', 'cpu_use_dynarec', base.hw.jit ? '1' : '0') === '1',
    fpu: g('Machine', 'fpu_type', ''),
    ram: Math.round(Number(g('Machine', 'mem_size', base.hw.ram * 1024)) / 1024),
    video: g('Video', 'gfxcard', base.hw.video),
    sound: g('Sound', 'sndcard', base.hw.sound),
    midi: g('Sound', 'midi_device', base.hw.midi),
    mpu: g('Sound', 'mpu401_standalone', '0') === '1',
    mouse: g('Input devices', 'mouse_type', base.hw.mouse),
    joystick: g('Input devices', 'joystick_type', base.hw.joystick || 'none'),
    fdd_a: g('Floppy and CD-ROM drives', 'fdd_01_type', base.hw.fdd_a),
    fdd_b: g('Floppy and CD-ROM drives', 'fdd_02_type', base.hw.fdd_b),
    cdrom: !g('Floppy and CD-ROM drives', 'cdrom_01_parameters', '0, none').startsWith('0'),
  };
  // Tutto il resto (sezioni dei dispositivi, opzioni avanzate) resta in extra.
  for (const [s, k] of [['Machine', 'machine'], ['Machine', 'cpu_family'], ['Machine', 'cpu_speed'], ['Machine', 'cpu_multi'], ['Machine', 'cpu_use_dynarec'],
    ['Machine', 'mem_size'], ['Video', 'gfxcard'], ['Sound', 'sndcard'], ['Sound', 'midi_device'], ['Sound', 'mpu401_standalone'],
    ['Hard disks', 'hdd_01_fn'], ['Hard disks', 'hdd_01_parameters'], ['Hard disks', 'hdd_01_ide_channel'],
    ['Floppy and CD-ROM drives', 'fdd_01_fn'], ['Floppy and CD-ROM drives', 'fdd_02_fn'], ['Floppy and CD-ROM drives', 'cdrom_01_image_path']]) {
    ini.delete?.(s, k);
  }
  return { ...base, hw, extra: ini.toString() };
}

// Riassunto per la schermata principale
export function riassunto(catalog, p) {
  const hw = p.hw;
  const m = catalog?.machine(hw.machine);
  const cpu = m ? cpuChoices(catalog, m).find((c) => c.family === hw.cpu_family && c.speed === hw.cpu_speed) : null;
  const nome = (key, id) => (id && id !== 'none' ? catalog?.find(key, id)?.n?.replace(/^\[[^\]]+\]\s*/, '') : null) || '—';
  return [
    ['CPU', cpu ? cpu.label : `${hw.cpu_family} ${mhz(hw.cpu_speed)}`],
    ['SCHEDA MADRE', m ? m.n.replace(/^\[([^\]]+)\]\s*/, '$1 · ') : hw.machine],
    ['RAM', `${hw.ram} MB`],
    ['VIDEO', nome('video', hw.video)],
    ['AUDIO', nome('sound', hw.sound)],
    ['MIDI', hw.midi && hw.midi !== 'none' ? `${nome('midi_out', hw.midi)}${hw.mpu ? ' · MPU-401 Roland' : ''}` : '—'],
    ...(hw.joystick && hw.joystick !== 'none' ? [['JOYSTICK', catalog?.joysticks?.find((j) => j.i === hw.joystick)?.n || hw.joystick]] : []),
    ['DISCHI', `C: ${Math.round(HDD.spt * HDD.heads * HDD.cyl * 512 / 1048576)} MB IDE${hw.cdrom ? ' · D: CD-ROM' : ''} · A: ${floppyName(hw.fdd_a)}${hw.fdd_b && hw.fdd_b !== 'none' ? ` · B: ${floppyName(hw.fdd_b)}` : ''}`],
  ];
}

export function floppyName(t) {
  return { '35_2hd': '3½" 1,44 MB', '35_2dd': '3½" 720 KB', '35_2ed': '3½" 2,88 MB', '525_2hd': '5¼" 1,2 MB', '525_2dd': '5¼" 360 KB', none: '—' }[t] || t;
}
