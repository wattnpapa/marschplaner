// state.js – Projekte, Speicher, Rückgängig
//
// Alle Änderungen am Projekt laufen durch `aendern(fn, schluessel)`. Nur so
// greifen Speichern, Rückgängig und Neuzeichnen. Die Projekte liegen im
// localStorage des Browsers – es gibt keinen Server und kein Konto.
//
// Wird das Datenschema erweitert: `SCHEMA` in daten.js hochzählen und den alten
// Stand in `migrieren()` umsetzen. Im Speicher der Nutzer liegen echte Planungen.

import { neuesProjekt, SCHEMA, neueId } from './daten.js';

const KEY_PROJEKTE = 'mp.projekte.v1';
const KEY_AKTIV = 'mp.aktiv.v1';
const UNDO_MAX = 60;
const ZUSAMMENFASSEN_MS = 1200;

let projekte = {};
let aktivId = null;
let undo = [];
let redo = [];
let letzteAenderung = { schluessel: null, zeit: 0 };
let speicherTimer = null;
let speicherFehler = false;
const lauscher = new Set();

/* ---------- Speicher ---------- */

function lesen(key) {
  try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; }
}

function schreiben(key, wert) {
  try { globalThis.localStorage?.setItem(key, wert); return true; } catch { return false; }
}

/** Ergänzt fehlende Felder aus den Vorgaben und setzt ältere Stände um */
export function migrieren(p) {
  const vorlage = neuesProjekt(p?.name || 'Marschplanung');
  const aus = zusammenfuehren(vorlage, p || {});
  aus.id = p?.id || vorlage.id;
  aus.schema = SCHEMA;
  if (!Array.isArray(aus.kolonnen) || !aus.kolonnen.length) aus.kolonnen = vorlage.kolonnen;
  return aus;
}

/** Vorgaben unter die vorhandenen Werte legen; Listen bleiben unverändert */
function zusammenfuehren(vorgabe, wert) {
  if (Array.isArray(vorgabe) || Array.isArray(wert)) return wert === undefined ? vorgabe : wert;
  if (vorgabe && typeof vorgabe === 'object') {
    const aus = {};
    for (const k of new Set([...Object.keys(vorgabe), ...Object.keys(wert || {})])) {
      aus[k] = k in (wert || {}) ? zusammenfuehren(vorgabe[k], wert[k]) : vorgabe[k];
    }
    return aus;
  }
  return wert === undefined || wert === null ? vorgabe : wert;
}

function laden() {
  try {
    const roh = JSON.parse(lesen(KEY_PROJEKTE) || '{}');
    for (const [id, p] of Object.entries(roh)) projekte[id] = migrieren(p);
  } catch { projekte = {}; }
  const gemerkt = lesen(KEY_AKTIV);
  aktivId = gemerkt && projekte[gemerkt] ? gemerkt : Object.keys(projekte)[0] ?? null;
  if (!aktivId) neu('Meine erste Marschplanung', { stumm: true });
}

function speichernSofort() {
  clearTimeout(speicherTimer);
  speicherTimer = null;
  const ok = schreiben(KEY_PROJEKTE, JSON.stringify(projekte)) && schreiben(KEY_AKTIV, aktivId);
  if (ok === speicherFehler) { speicherFehler = !ok; benachrichtigen('speicher'); }
}

function speichern() {
  if (speicherTimer) return;
  speicherTimer = setTimeout(speichernSofort, 350);
}

/** Beim Schließen der Seite nichts Ungespeichertes zurücklassen */
if (typeof addEventListener === 'function') {
  addEventListener('pagehide', () => { if (speicherTimer) speichernSofort(); });
}

/* ---------- Lauscher ---------- */

function benachrichtigen(art) {
  for (const fn of lauscher) fn(art);
}

/** `fn(art)` mit art = 'projekt' (Inhalt geändert), 'wechsel' (anderes Projekt), 'speicher' */
export function auf(fn) {
  lauscher.add(fn);
  return () => lauscher.delete(fn);
}

/* ---------- Zugriff ---------- */

export function aktuell() { return projekte[aktivId]; }
export function speicherProbleme() { return speicherFehler; }

export function liste() {
  return Object.values(projekte)
    .map(p => ({ id: p.id, name: p.name, geaendert: p.geaendert }))
    .sort((a, b) => (b.geaendert || '').localeCompare(a.geaendert || ''));
}

export function kannRueckgaengig() { return undo.length > 0; }
export function kannWiederholen() { return redo.length > 0; }

/**
 * Ändert das aktive Projekt. `fn` bekommt das Projekt und verändert es.
 * Aufeinanderfolgende Änderungen mit demselben `schluessel` (z. B. Tippen in
 * einem Feld) werden zu einem Rückgängig-Schritt zusammengefasst.
 */
export function aendern(fn, schluessel = null) {
  const p = aktuell();
  const jetzt = Date.now();
  const zusammen = schluessel !== null
    && letzteAenderung.schluessel === schluessel
    && jetzt - letzteAenderung.zeit < ZUSAMMENFASSEN_MS;
  if (!zusammen) {
    undo.push(JSON.stringify(p));
    if (undo.length > UNDO_MAX) undo.shift();
    redo = [];
  }
  letzteAenderung = { schluessel, zeit: jetzt };
  fn(p);
  p.geaendert = new Date().toISOString();
  speichern();
  benachrichtigen('projekt');
}

/**
 * Wie `aendern`, aber ohne Rückgängig-Schritt: für Zwischenstände, die im
 * Hintergrund einlaufen (z. B. abgefragte Straßenstücke) und nicht einzeln
 * zurückgenommen werden sollen.
 */
export function aendernStill(fn) {
  const p = aktuell();
  fn(p);
  p.geaendert = new Date().toISOString();
  speichern();
  benachrichtigen('projekt');
}

function stand(json) {
  projekte[aktivId] = migrieren(JSON.parse(json));
  letzteAenderung = { schluessel: null, zeit: 0 };
  speichern();
  benachrichtigen('wechsel');
}

export function rueckgaengig() {
  if (!undo.length) return;
  redo.push(JSON.stringify(aktuell()));
  stand(undo.pop());
}

export function wiederholen() {
  if (!redo.length) return;
  undo.push(JSON.stringify(aktuell()));
  stand(redo.pop());
}

/* ---------- Projekte verwalten ---------- */

function wechseln(id) {
  aktivId = id;
  undo = []; redo = [];
  letzteAenderung = { schluessel: null, zeit: 0 };
  speichernSofort();
  benachrichtigen('wechsel');
}

export function neu(name = 'Neue Marschplanung', { stumm = false } = {}) {
  const p = neuesProjekt(name);
  projekte[p.id] = p;
  if (stumm) { aktivId = p.id; speichern(); } else wechseln(p.id);
  return p;
}

export function oeffnen(id) {
  if (projekte[id]) wechseln(id);
}

export function duplizieren() {
  const kopie = migrieren(JSON.parse(JSON.stringify(aktuell())));
  kopie.id = neueId('mp');
  kopie.name = `${aktuell().name} (Kopie)`;
  kopie.erstellt = kopie.geaendert = new Date().toISOString();
  projekte[kopie.id] = kopie;
  wechseln(kopie.id);
}

export function loeschen(id = aktivId) {
  delete projekte[id];
  if (id === aktivId) {
    const rest = Object.keys(projekte);
    if (rest.length) wechseln(rest[0]); else neu('Neue Marschplanung');
  } else {
    speichern();
    benachrichtigen('wechsel');
  }
}

/* ---------- Dateien ---------- */

export function alsJson(id = aktivId) {
  return JSON.stringify({ app: 'marschplaner', schema: SCHEMA, projekt: projekte[id] }, null, 2);
}

/** Liest eine zuvor gespeicherte Planung als neues Projekt */
export function ausJson(text) {
  let obj;
  try { obj = JSON.parse(text); } catch { throw new Error('Die Datei ist kein gültiges JSON.'); }
  const roh = obj?.app === 'marschplaner' ? obj.projekt : null;
  if (!roh || typeof roh !== 'object') throw new Error('Das ist keine Marschplaner-Datei.');
  if ((roh.schema ?? 0) > SCHEMA) throw new Error('Die Planung stammt aus einer neueren Version des Marschplaners.');
  const p = migrieren(roh);
  p.id = neueId('mp');
  p.name = `${p.name || 'Planung'} (importiert)`;
  projekte[p.id] = p;
  wechseln(p.id);
  return p;
}

/* ---------- Pfadzugriff für Formularfelder ---------- */

/**
 * Setzt `wert` am Pfad `a.b.@id.c`. Ein Segment `@id` wählt das Listenelement
 * mit dieser `id` – so bleibt der Zugriff stabil, wenn sich die Reihenfolge ändert.
 */
export function setzePfad(obj, pfad, wert) {
  const teile = pfad.split('.');
  let o = obj;
  for (let i = 0; i < teile.length - 1; i++) o = schritt(o, teile[i]);
  const letzte = teile[teile.length - 1];
  if (o) o[letzte] = wert;
}

export function lesePfad(obj, pfad) {
  let o = obj;
  for (const t of pfad.split('.')) { o = schritt(o, t); if (o === undefined || o === null) return undefined; }
  return o;
}

function schritt(o, teil) {
  if (o === undefined || o === null) return undefined;
  if (teil.startsWith('@')) return o.find?.(x => x.id === teil.slice(1));
  return o[teil];
}

laden();
