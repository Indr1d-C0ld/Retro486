// Retro486 - dialogo con il backend su Balthasar (api/*.php) e con lo storage
// del browser (OPFS), dove vive la copia di lavoro della macchina.
//
// Sul server: dati/dischi/<nome>.img.gz (hard disk compressi), dati/libreria.json,
// dati/profili.json (profili personalizzati), dati/nvr/<scheda>.nvr (CMOS),
// dati/media/* (immagini di floppy e CD).

import * as storage from '../storage.js';
import { VM } from './profili.js';

const API = 'api/';

async function json(url, opts) {
  const r = await fetch(url, { cache: 'no-store', ...opts });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status} ${await r.text().catch(() => '')}`.trim());
  return r.json();
}

export async function stato() {
  try { return await json(`${API}stato.php`); } catch (e) {
    console.warn('[Retro486] backend non raggiungibile:', e.message);
    return { offline: true, dischi: [], libreria: [], profili: [], media: [], nvr: [] };
  }
}

export async function salvaProfili(profili) {
  return json(`${API}profili.php`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Retro486': '1' }, body: JSON.stringify(profili) });
}

// ---- hard disk ----------------------------------------------------------------

const LOCALE = 'retro486.disco'; // { nome, server: mtime della copia scaricata, modificato: bool }

export function infoLocale() {
  try { return JSON.parse(localStorage.getItem(LOCALE) || 'null'); } catch (e) { return null; }
}
function setInfoLocale(v) { try { localStorage.setItem(LOCALE, JSON.stringify(v)); } catch (e) { /* privato */ } }
export function segnaModificato() { const i = infoLocale(); if (i) setInfoLocale({ ...i, modificato: true }); }

export const hddRel = (nome = 'c') => `vms/${VM}/${nome}.img`;
export const hddPath = (nome = 'c') => `${storage.vmPath(VM)}${nome}.img`;

export async function discoLocalePresente(nome = 'c') {
  try { return (await storage.getFile(hddRel(nome))).size > 0; } catch (e) { return false; }
}

// Scarica l'hard disk dal server (gzip) e lo decomprime in streaming nello storage del browser.
export async function scaricaDisco(disco, onProgress) {
  const r = await fetch(`dati/dischi/${disco.file}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`Download dell'hard disk: HTTP ${r.status}`);
  const total = Number(r.headers.get('Content-Length')) || disco.byte_gz || 0;
  let done = 0;
  const counted = r.body.pipeThrough(new TransformStream({
    transform(chunk, ctl) { done += chunk.byteLength; onProgress?.(done, total, 'scarico'); ctl.enqueue(chunk); },
  }));
  const raw = disco.file.endsWith('.gz') ? counted.pipeThrough(new DecompressionStream('gzip')) : counted;
  const blob = await new Response(raw).blob();
  onProgress?.(0, blob.size, 'scrivo');
  await storage.writeFile(hddRel(disco.nome), blob, (d, t) => onProgress?.(d, t, 'scrivo'));
  setInfoLocale({ nome: disco.nome, server: disco.mtime, modificato: false });
}

// Carica la copia di lavoro sul server, compressa.
export async function caricaDisco(nome = 'c', onProgress) {
  const f = await storage.getFile(hddRel(nome));
  onProgress?.(0, f.size, 'comprimo');
  const gz = await new Response(f.stream().pipeThrough(new CompressionStream('gzip'))).blob();
  onProgress?.(0, gz.size, 'invio');
  const res = await new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', `${API}disco.php?nome=${encodeURIComponent(nome)}`);
    x.upload.onprogress = (e) => onProgress?.(e.loaded, e.total, 'invio');
    x.onload = () => (x.status >= 200 && x.status < 300 ? resolve(JSON.parse(x.responseText)) : reject(new Error(`HTTP ${x.status}: ${x.responseText}`)));
    x.onerror = () => reject(new Error('Errore di rete durante l\'invio'));
    x.setRequestHeader('Content-Type', 'application/gzip');
    x.setRequestHeader('X-Retro486', '1');
    x.setRequestHeader('X-Dimensione-Originale', String(f.size));
    x.send(gz);
  });
  setInfoLocale({ nome, server: res.mtime, modificato: false });
  return res;
}

// ---- CMOS (NVRAM) --------------------------------------------------------------------

export async function nvrLocale(machine) {
  try { return await storage.fileExists(`vms/${VM}/nvr/${machine}.nvr`); } catch (e) { return false; }
}

// Prima accensione di una scheda madre: usa la CMOS del server, poi quella predefinita del portale.
export async function preparaNvr(machine, srv) {
  if (await nvrLocale(machine)) return 'locale';
  for (const url of [srv?.nvr?.includes(machine) ? `dati/nvr/${machine}.nvr` : null, `profili/nvr/${machine}.nvr`]) {
    if (!url) continue;
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) continue;
    await storage.writeFile(`vms/${VM}/nvr/${machine}.nvr`, await r.arrayBuffer());
    return url;
  }
  return null;
}

export async function salvaNvrSulServer(machine) {
  const f = await storage.getFile(`vms/${VM}/nvr/${machine}.nvr`);
  return json(`${API}nvr.php?macchina=${encodeURIComponent(machine)}`, { method: 'PUT', headers: { 'X-Retro486': '1' }, body: f });
}

// ---- media (floppy, CD) ----------------------------------------------------------------

export async function preparaMedia(m, onProgress) {
  const rel = `vms/${VM}/media/${m.file}`;
  if (await storage.fileExists(rel)) {
    const f = await storage.getFile(rel);
    if (f.size === m.byte) return `${storage.vmPath(VM)}media/${m.file}`;
  }
  const r = await fetch(`dati/media/${encodeURIComponent(m.file)}`);
  if (!r.ok) throw new Error(`Download di ${m.nome}: HTTP ${r.status}`);
  const blob = await r.blob();
  await storage.writeFile(rel, blob, onProgress);
  return `${storage.vmPath(VM)}media/${m.file}`;
}
