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
const KEY_PAPIERKORB = 'mp.papierkorb.v1';
const KEY_GESICHERT = 'mp.gesichert.v1';
const KEY_DEFEKT = 'mp.projekte.defekt.v1';
const UNDO_MAX = 60;
const UNDO_ZEICHEN = 30e6;           // Obergrenze für alle Schnappschüsse einer Planung (lange Tracks)
const PAPIERKORB_MAX = 5;
const ZUSAMMENFASSEN_MS = 1200;

let projekte = {};
let aktivId = null;
let undo = [];                       // je Schritt { s: Schnappschuss (JSON), t: Bezeichnung }
let redo = [];
const stapel = new Map();            // Rückgängig-Stapel der übrigen Planungen: der Wechsel verwirft sie nicht
const geloescht = new Set();         // hier gelöschte Planungen: ein anderer Tab bringt sie nicht zurück
let papierkorb = [];                 // zuletzt gelöschte Planungen, neueste zuerst
let gesichert = {};                  // id → ISO-Zeit der letzten Dateisicherung
let ladeProblem = null;              // { anzahl, schluessel, ... } wenn beim Start etwas nicht lesbar war
let letzterRoh = null;               // zuletzt gelesener oder geschriebener Speicherinhalt
let schreibSperre = false;           // Rohsicherung misslungen: den Speicher nicht überschreiben
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

/** Prüft, ob eine Planung so aufgebaut ist, dass die Oberfläche sie zeichnen kann */
function pruefeStruktur(p) {
  const objekt = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
  const r = p.route;
  if (!objekt(r) || !Array.isArray(r.track) || !Array.isArray(r.kontrollpunkte)) throw new Error('Route');
  if (!r.track.every(q => Array.isArray(q) && Number.isFinite(q[0]) && Number.isFinite(q[1]))) throw new Error('Streckenverlauf');
  if (!r.kontrollpunkte.every(k => objekt(k) && Number.isFinite(+k.km))) throw new Error('Kontrollpunkte');
  if (!Array.isArray(p.kolonnen) || !p.kolonnen.every(objekt)) throw new Error('Kolonnen');
  for (const k of ['kopf', 'parameter', 'auftrag', 'unterlagen', 'hilfsmittel', 'suche', 'druck']) {
    if (!objekt(p[k])) throw new Error(k);
  }
}

/** Legt den ungelesenen Rohtext zur Seite, bevor etwas den Speicher überschreibt */
function rohSichern(text) {
  const schluessel = `${KEY_DEFEKT}.${Date.now()}`;
  if (!schreiben(schluessel, text)) schreibSperre = true;
  return schluessel;
}

function laden() {
  const text = lesen(KEY_PROJEKTE);
  letzterRoh = text;
  let roh = {};
  let defekt = 0, ganz = false;
  if (text) {
    try {
      roh = JSON.parse(text);
      if (!roh || typeof roh !== 'object' || Array.isArray(roh)) throw new Error('kein Objekt');
    } catch { roh = {}; ganz = true; }
  }
  for (const [id, p] of Object.entries(roh)) {
    try { const m = migrieren(p); pruefeStruktur(m); projekte[id] = m; } catch { defekt++; }
  }
  if (ganz || defekt) {
    ladeProblem = { anzahl: ganz ? null : defekt, schluessel: rohSichern(text), text };
  }
  try { papierkorb = JSON.parse(lesen(KEY_PAPIERKORB) || '[]'); if (!Array.isArray(papierkorb)) papierkorb = []; } catch { papierkorb = []; }
  try { gesichert = JSON.parse(lesen(KEY_GESICHERT) || '{}') || {}; } catch { gesichert = {}; }
  const gemerkt = lesen(KEY_AKTIV);
  aktivId = gemerkt && projekte[gemerkt] ? gemerkt : Object.keys(projekte)[0] ?? null;
  if (!aktivId) neu('Meine erste Marschplanung', { stumm: true });
  if (schreibSperre) speicherFehler = true;
}

/**
 * Übernimmt, was ein anderer Tab inzwischen gespeichert hat: unbekannte Planungen
 * und solche, die dort später geändert wurden. So überschreibt der zuletzt
 * speichernde Tab nicht stillschweigend die Arbeit des anderen.
 */
function fremdesUebernehmen() {
  const text = lesen(KEY_PROJEKTE);
  if (text === null || text === letzterRoh) return { neu: false, aktiv: false };
  let roh;
  try { roh = JSON.parse(text); } catch { return { neu: false, aktiv: false }; }
  letzterRoh = text;
  let neuer = false, aktiv = false;
  for (const [id, p] of Object.entries(roh || {})) {
    if (geloescht.has(id)) continue;
    if (projekte[id] && (p?.geaendert || '') <= (projekte[id].geaendert || '')) continue;
    try {
      const m = migrieren(p);
      pruefeStruktur(m);
      projekte[id] = m;
      neuer = true;
      if (id === aktivId) aktiv = true;
    } catch { /* eine unlesbare fremde Planung bleibt dort liegen */ }
  }
  return { neu: neuer, aktiv };
}

function speichernSofort() {
  clearTimeout(speicherTimer);
  speicherTimer = null;
  if (!schreibSperre) {
    const fremd = fremdesUebernehmen();
    if (fremd.aktiv) { undo = []; redo = []; benachrichtigen('fremd'); }
  }
  const roh = JSON.stringify(projekte);
  const ok = !schreibSperre && schreiben(KEY_PROJEKTE, roh) && schreiben(KEY_AKTIV, aktivId);
  if (ok) letzterRoh = roh;
  if (ok === speicherFehler) { speicherFehler = !ok; benachrichtigen('speicher'); }
}

function speichern() {
  if (speicherTimer) return;
  speicherTimer = setTimeout(speichernSofort, 350);
}

/** Beim Schließen der Seite nichts Ungespeichertes zurücklassen */
if (typeof addEventListener === 'function') {
  addEventListener('pagehide', () => { if (speicherTimer) speichernSofort(); });
  addEventListener('storage', ev => {
    if (ev.key !== KEY_PROJEKTE) return;
    const fremd = fremdesUebernehmen();
    if (fremd.aktiv) { undo = []; redo = []; benachrichtigen('fremd'); }
  });
}

/* ---------- Lauscher ---------- */

function benachrichtigen(art) {
  for (const fn of lauscher) fn(art);
}

/** `fn(art)` mit art = 'projekt' (Inhalt geändert), 'wechsel' (anderes Projekt), 'speicher', 'fremd' (ein anderer Tab hat die aktive Planung geändert) */
export function auf(fn) {
  lauscher.add(fn);
  return () => lauscher.delete(fn);
}

/* ---------- Zugriff ---------- */

export function aktuell() { return projekte[aktivId]; }
export function speicherProbleme() { return speicherFehler; }

/** Was beim Start nicht lesbar war: { anzahl (null = alles), schluessel, text } oder null */
export function ladeProbleme() { return ladeProblem; }

export function liste() {
  return Object.values(projekte)
    .map(p => ({ id: p.id, name: p.name, geaendert: p.geaendert, punkte: p.route?.kontrollpunkte?.length ?? 0 }))
    .sort((a, b) => (b.geaendert || '').localeCompare(a.geaendert || ''));
}

export function kannRueckgaengig() { return undo.length > 0; }
export function kannWiederholen() { return redo.length > 0; }
/** Bezeichnung des Schritts, den „Rückgängig“ bzw. „Wiederholen“ als Nächstes umkehrt */
export function rueckgaengigText() { return undo[undo.length - 1]?.t || ''; }
export function wiederholenText() { return redo[redo.length - 1]?.t || ''; }

/**
 * Ändert das aktive Projekt. `fn` bekommt das Projekt und verändert es.
 * Aufeinanderfolgende Änderungen mit demselben `schluessel` (z. B. Tippen in
 * einem Feld) werden zu einem Rückgängig-Schritt zusammengefasst. `text` benennt
 * den Schritt für die Anzeige („Punkt 3 entfernt“).
 */
export function aendern(fn, schluessel = null, text = '') {
  const p = aktuell();
  const jetzt = Date.now();
  const zusammen = schluessel !== null
    && letzteAenderung.schluessel === schluessel
    && jetzt - letzteAenderung.zeit < ZUSAMMENFASSEN_MS;
  if (!zusammen) {
    undo.push({ s: JSON.stringify(p), t: text });
    stapelKuerzen();
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

/** Begrenzt die Schnappschüsse nach Anzahl und Gesamtgröße (lange Tracks sind groß) */
function stapelKuerzen() {
  let summe = undo.reduce((n, x) => n + x.s.length, 0);
  while (undo.length > 1 && (undo.length > UNDO_MAX || summe > UNDO_ZEICHEN)) summe -= undo.shift().s.length;
}

function stand(json) {
  projekte[aktivId] = migrieren(JSON.parse(json));
  letzteAenderung = { schluessel: null, zeit: 0 };
  speichern();
  benachrichtigen('wechsel');
}

export function rueckgaengig() {
  if (!undo.length) return;
  const schritt = undo.pop();
  redo.push({ s: JSON.stringify(aktuell()), t: schritt.t });
  stand(schritt.s);
}

export function wiederholen() {
  if (!redo.length) return;
  const schritt = redo.pop();
  undo.push({ s: JSON.stringify(aktuell()), t: schritt.t });
  stand(schritt.s);
}

/* ---------- Projekte verwalten ---------- */

function wechseln(id) {
  stapel.set(aktivId, { undo, redo });          // der Rückgängig-Verlauf bleibt bei seiner Planung
  aktivId = id;
  const alt = stapel.get(id);
  undo = alt?.undo ?? []; redo = alt?.redo ?? [];
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
  const p = projekte[id];
  if (p) {                                       // nicht endgültig: der Papierkorb hält die letzten Planungen
    papierkorb.unshift({ id, name: p.name, geloeschtAm: new Date().toISOString(), projekt: p });
    papierkorbSpeichern();
  }
  delete projekte[id];
  geloescht.add(id);
  stapel.delete(id);
  if (id === aktivId) {
    const rest = Object.keys(projekte);
    if (rest.length) wechseln(rest[0]); else neu('Neue Marschplanung');
  } else {
    speichern();
    benachrichtigen('wechsel');
  }
}

function papierkorbSpeichern() {
  papierkorb.length = Math.min(papierkorb.length, PAPIERKORB_MAX);
  while (!schreiben(KEY_PAPIERKORB, JSON.stringify(papierkorb)) && papierkorb.length > 1) papierkorb.pop();
}

/** Gelöschte Planungen, neueste zuerst */
export function papierkorbListe() {
  return papierkorb.map(x => ({ id: x.id, name: x.name, geloeschtAm: x.geloeschtAm, punkte: x.projekt?.route?.kontrollpunkte?.length ?? 0 }));
}

export function wiederherstellen(id) {
  const i = papierkorb.findIndex(x => x.id === id);
  if (i < 0) return null;
  const [eintrag] = papierkorb.splice(i, 1);
  papierkorbSpeichern();
  const p = migrieren(eintrag.projekt);
  if (projekte[p.id]) p.id = neueId('mp');
  geloescht.delete(p.id);
  projekte[p.id] = p;
  wechseln(p.id);
  return p;
}

/* ---------- Dateisicherung ---------- */

/** Merkt, dass die Planung gerade als Datei gesichert wurde */
export function gesichertMarkieren(id = aktivId) {
  gesichert[id] = new Date().toISOString();
  schreiben(KEY_GESICHERT, JSON.stringify(gesichert));
  benachrichtigen('speicher');
}

/** ISO-Zeit der letzten Dateisicherung dieser Planung oder null */
export function gesichertAm(id = aktivId) { return gesichert[id] || null; }

/* ---------- Dateien ---------- */

export function alsJson(id = aktivId) {
  return JSON.stringify({ app: 'marschplaner', schema: SCHEMA, projekt: projekte[id] }, null, 2);
}

/** Liest eine zuvor gespeicherte Planung als neues Projekt; die bisherige bleibt unberührt */
export function ausJson(text) {
  let obj;
  try { obj = JSON.parse(text); } catch { throw new Error('Die Datei ist kein gültiges JSON.'); }
  const roh = obj?.app === 'marschplaner' ? obj.projekt : null;
  if (!roh || typeof roh !== 'object') throw new Error('Das ist keine Marschplaner-Datei.');
  if ((roh.schema ?? 0) > SCHEMA) throw new Error('Die Planung stammt aus einer neueren Version des Marschplaners.');
  let p;
  try { p = migrieren(roh); pruefeStruktur(p); } catch (err) {
    throw new Error(`Die Planungsdatei ist beschädigt (${err.message}) und wurde nicht geladen. Die aktuelle Planung bleibt unverändert.`);
  }
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
