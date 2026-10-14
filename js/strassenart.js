// strassenart.js – Straßenart und Straßennummer entlang der Route aus OpenStreetMap
//
// Ablauf: Die Route wird in Stücken von 20 km bei Overpass abgefragt (alle Straßen
// im Umkreis des Tracks). Der Track wird alle 100 m abgetastet; jeder Abtastpunkt
// bekommt die nächstgelegene Straße. Gespeichert wird je 100 m nur die Straßenart
// ('b' Autobahn, 'l' Bundes-/Landstraße, 'o' Ortschaft, 'x' unbekannt) und ein
// Verweis auf die Straßennummer. Aus diesem „Arten“-Profil rechnen Fahrplan und
// Karte, wie viele Kilometer eines beliebigen Abschnitts auf welche Straßenart
// fallen – es bleibt gültig, wenn Kontrollpunkte verschoben werden.
//
// Das Ergebnis ist ein Vorschlag. „Ortschaft“ wird aus Straßenklasse und
// Höchstgeschwindigkeit geschlossen (OSM kennt keine Ortsgrenze als Straßen-
// eigenschaft).

import { punktBeiKm, trackLaengeM, teilTrack, vereinfachen } from './geo.js';

export const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];

const STRASSEN = 'motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street';
const RANG = { motorway: 6, trunk: 5, primary: 4, secondary: 3, tertiary: 2, unclassified: 1, residential: 0, living_street: 0 };
const MAX_ABSTAND_M = 40;       // weiter weg gilt ein Abtastpunkt als ohne Straße
const GLEICHSTAND_M = 6;        // bei fast gleichem Abstand gewinnt die höherrangige Straße
const SCHRITT_KM = 0.1;
const STUECK_KM = 20;
const RAD = Math.PI / 180;
const M_PRO_GRAD = 111195;

export const ZEICHEN = { bab: 'b', bul: 'l', ort: 'o' };
const KLASSE = { b: 'bab', l: 'bul', o: 'ort' };

/** Overpass-Abfrage für alle Straßen im Umkreis des Tracks */
export function abfrage(track, radiusM = 30) {
  let toleranz = 25, grob = vereinfachen(track, toleranz);
  while (grob.length > 1500 && toleranz < 400) { toleranz *= 2; grob = vereinfachen(track, toleranz); }
  const koord = grob.map(p => `${p[0].toFixed(5)},${p[1].toFixed(5)}`).join(',');
  return `[out:json][timeout:90];way["highway"~"^(${STRASSEN})$"](around:${radiusM},${koord});out tags geom;`;
}

/**
 * Ruft Overpass ab und gibt die Wege mit Geometrie zurück. Die öffentlichen
 * Server sind zeitweise überlastet (429/504) oder liefern eine Fehlerseite statt
 * JSON; deshalb abwechselnd beide Server, insgesamt bis zu vier Versuche.
 */
export async function ladeWege(track) {
  const daten = 'data=' + encodeURIComponent(abfrage(track));
  let letzter = null;
  for (let versuch = 0; versuch < 4; versuch++) {
    const url = OVERPASS_URLS[versuch % OVERPASS_URLS.length];
    try {
      const r = await fetch(url, {
        method: 'POST', body: daten, signal: AbortSignal.timeout(45000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      if (!r.ok) throw new Error(`${new URL(url).host} antwortet mit ${r.status}`);
      let json;
      try { json = JSON.parse(await r.text()); } catch { throw new Error(`${new URL(url).host} lieferte keine Daten (überlastet?)`); }
      return (json.elements || []).filter(x => x.type === 'way' && Array.isArray(x.geometry) && x.geometry.length > 1);
    } catch (err) {
      letzter = err.name === 'TimeoutError' ? new Error(`${new URL(url).host} antwortet nicht`) : err;
      if (versuch < 3) await new Promise(res => setTimeout(res, 3000 * (versuch + 1)));
    }
  }
  throw letzter || new Error('Overpass nicht erreichbar.');
}

function hoechstgeschwindigkeit(tags) {
  const m = String(tags.maxspeed ?? '').trim();
  if (/urban/i.test(m) || /urban/i.test(tags['zone:maxspeed'] ?? '')) return 50;
  const n = parseInt(m, 10);
  return Number.isFinite(n) ? n : null;
}

/** 'bab' | 'bul' | 'ort' für die Tags einer OSM-Straße */
export function klasseVon(tags) {
  const hw = String(tags.highway || '').replace(/_link$/, '');
  const ref = String(tags.ref || '');
  const v = hoechstgeschwindigkeit(tags);
  if (hw === 'motorway') return 'bab';
  if (hw === 'trunk') return /(^|;)\s*A\s?\d/.test(ref) ? 'bab' : (v !== null && v <= 50 ? 'ort' : 'bul');
  if (hw === 'residential' || hw === 'living_street') return 'ort';
  return v !== null && v <= 50 ? 'ort' : 'bul';
}

/** Straßennummern einer Straße: "B 28;B 27" → ['B 28', 'B 27'] */
export function referenzen(tags) {
  return String(tags.ref || '').split(';').map(s => s.trim()).filter(Boolean);
}

/* ---------- Raster für die Suche nach der nächsten Straße ---------- */

const ZELLE_LAT = 0.002, ZELLE_LON = 0.003;

function indexAufbauen(wege) {
  const zellen = new Map();
  const kopf = [];
  wege.forEach((w, wi) => {
    kopf.push({ tags: w.tags || {}, rang: RANG[String(w.tags?.highway || '').replace(/_link$/, '')] ?? 0 });
    for (let i = 1; i < w.geometry.length; i++) {
      const a = w.geometry[i - 1], b = w.geometry[i];
      const seg = [a.lat, a.lon, b.lat, b.lon, wi];
      const y0 = Math.floor(Math.min(a.lat, b.lat) / ZELLE_LAT), y1 = Math.floor(Math.max(a.lat, b.lat) / ZELLE_LAT);
      const x0 = Math.floor(Math.min(a.lon, b.lon) / ZELLE_LON), x1 = Math.floor(Math.max(a.lon, b.lon) / ZELLE_LON);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const k = y * 100003 + x;
        let l = zellen.get(k);
        if (!l) zellen.set(k, l = []);
        l.push(seg);
      }
    }
  });
  return { zellen, kopf };
}

function naechsteStrasse(idx, p) {
  const cy = Math.floor(p[0] / ZELLE_LAT), cx = Math.floor(p[1] / ZELLE_LON);
  const kx = Math.cos(p[0] * RAD) * M_PRO_GRAD;
  let beste = null, bestD = Infinity;
  for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) {
    for (const s of idx.zellen.get(y * 100003 + x) || []) {
      const ax = (s[1] - p[1]) * kx, ay = (s[0] - p[0]) * M_PRO_GRAD;
      const bx = (s[3] - p[1]) * kx, by = (s[2] - p[0]) * M_PRO_GRAD;
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / l2)) : 0;
      const d = Math.hypot(ax + dx * t, ay + dy * t);
      const k = idx.kopf[s[4]];
      if (d < bestD - GLEICHSTAND_M || (Math.abs(d - bestD) <= GLEICHSTAND_M && beste && k.rang > beste.rang)) {
        beste = k; bestD = Math.min(d, bestD);
      }
    }
  }
  return bestD <= MAX_ABSTAND_M ? beste : null;
}

/**
 * Tastet den Track zwischen `vonKm` und `bisKm` im Raster von 100 m ab.
 * Der Abtastpunkt Nummer i liegt bei (i + 0,5) · 100 m.
 * @returns {{i:number, klasse:string|null, label:string}[]}
 */
export function abtasten(track, wege, vonKm = 0, bisKm = trackLaengeM(track) / 1000) {
  const idx = indexAufbauen(wege);
  const aus = [];
  const i0 = Math.round(vonKm / SCHRITT_KM);
  const i1 = Math.min(Math.ceil(bisKm / SCHRITT_KM - 1e-9), Math.ceil(trackLaengeM(track) / 1000 / SCHRITT_KM));
  for (let i = i0; i < i1; i++) {
    const s = naechsteStrasse(idx, punktBeiKm(track, (i + 0.5) * SCHRITT_KM));
    aus.push(s
      ? { i, klasse: klasseVon(s.tags), label: referenzen(s.tags).join(' / ') || s.tags.name || '' }
      : { i, klasse: null, label: '' });
  }
  return aus;
}

/** Verdichtet Abtastpunkte zum gespeicherten Profil */
export function baueArten(proben, laengeKm) {
  const n = Math.ceil(laengeKm / SCHRITT_KM - 1e-9);
  const k = new Array(n).fill('x');
  const r = new Array(n).fill(-1);
  const tab = [];
  for (const q of proben) {
    if (q.i < 0 || q.i >= n) continue;
    k[q.i] = q.klasse ? ZEICHEN[q.klasse] : 'x';
    if (q.label) {
      let j = tab.indexOf(q.label);
      if (j < 0) { tab.push(q.label); j = tab.length - 1; }
      r[q.i] = j;
    }
  }
  return { schritt: SCHRITT_KM, k: k.join(''), tab, r };
}

/**
 * Fragt die ganze Route ab, in Stücken, damit auch lange Strecken gehen.
 * @param {(fertig:number, gesamt:number)=>void} [fortschritt]
 */
export async function analysiere(track, fortschritt = () => {}) {
  const laenge = trackLaengeM(track) / 1000;
  const stuecke = Math.max(1, Math.ceil(laenge / STUECK_KM));
  const proben = [];
  for (let s = 0; s < stuecke; s++) {
    fortschritt(s, stuecke);
    const von = s * STUECK_KM, bis = Math.min(laenge, (s + 1) * STUECK_KM);
    const sub = teilTrack(track, Math.max(0, von - 0.1), Math.min(laenge, bis + 0.1));
    if (sub.length < 2) continue;
    const wege = await ladeWege(sub);
    proben.push(...abtasten(track, wege, von, bis));
    if (s < stuecke - 1) await new Promise(r => setTimeout(r, 800));       // dem Dienst Luft lassen
  }
  fortschritt(stuecke, stuecke);
  return baueArten(proben, laenge);
}

/* ---------- Auswerten ---------- */

function zelle(arten, i) { return i >= 0 && i < arten.k.length ? arten.k[i] : 'x'; }

/**
 * Kilometer je Straßenart zwischen `von` und `bis` (km). Unbekannte Stücke
 * zählen zur häufigsten bekannten Art des Abschnitts, ohne Bezug zur Bundesstraße.
 */
export function anteileImAbschnitt(arten, von, bis) {
  const aus = { bab: 0, bul: 0, ort: 0 };
  let unbekannt = 0;
  if (!(bis > von)) return { anteile: aus, unbekannt, dominant: 'bul' };
  const s = arten.schritt;
  for (let i = Math.floor(von / s); i * s < bis; i++) {
    const l = Math.min(bis, (i + 1) * s) - Math.max(von, i * s);
    if (l <= 0) continue;
    const c = KLASSE[zelle(arten, i)];
    if (c) aus[c] += l; else unbekannt += l;
  }
  const dominant = Object.keys(aus).reduce((a, b) => (aus[b] > aus[a] ? b : a), 'bul');
  const bekannt = aus.bab + aus.bul + aus.ort;
  aus[bekannt > 0 ? dominant : 'bul'] += unbekannt;
  return { anteile: aus, unbekannt, dominant: bekannt > 0 ? dominant : 'bul' };
}

/** Straßennummern bzw. -namen, die den Abschnitt prägen, in Fahrtrichtung, höchstens drei */
export function strasseImAbschnitt(arten, von, bis) {
  const s = arten.schritt;
  const menge = new Map(), folge = [];
  let summe = 0;
  for (let i = Math.floor(von / s); i * s < bis; i++) {
    const j = arten.r[i];
    if (j === undefined || j < 0) continue;
    const l = Math.min(bis, (i + 1) * s) - Math.max(von, i * s);
    if (l <= 0) continue;
    if (!menge.has(j)) folge.push(j);
    menge.set(j, (menge.get(j) || 0) + l);
    summe += l;
  }
  return folge.filter(j => menge.get(j) >= summe * 0.1).slice(0, 3).map(j => arten.tab[j]).join(' / ');
}

/** Zusammenhängende Läufe gleicher Straßenart im Abschnitt – für die Karte */
export function klassenLaeufe(arten, von, bis) {
  const s = arten.schritt;
  const laeufe = [];
  let vorher = 'bul';
  for (let i = Math.floor(von / s); i * s < bis; i++) {
    const c = KLASSE[zelle(arten, i)] || vorher;
    const a = Math.max(von, i * s), b = Math.min(bis, (i + 1) * s);
    if (b <= a) continue;
    const letzter = laeufe[laeufe.length - 1];
    if (letzter && letzter.klasse === c) letzter.bis = b; else laeufe.push({ klasse: c, von: a, bis: b });
    vorher = c;
  }
  return laeufe;
}
