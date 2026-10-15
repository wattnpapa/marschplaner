// strassenart.js – Straßenart und Straßennummer entlang der Route aus OpenStreetMap
//
// Ablauf: Die Route wird in Stücken von 10 km bei Overpass abgefragt (alle Straßen
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
const STUECK_KM = 10;
const PAUSE_MS = 2500;          // Abstand zwischen zwei Abfragen (Kontingent je IP)
const RAD = Math.PI / 180;
const M_PRO_GRAD = 111195;

export const ZEICHEN = { bab: 'b', bul: 'l', ort: 'o' };
const KLASSE = { b: 'bab', l: 'bul', o: 'ort' };

/** Koordinatenliste "lat,lon,lat,lon,…" für `around:` – so grob, dass die Abfrage leicht bleibt */
export function polylinie(track, maxPunkte = 300) {
  let toleranz = 25, grob = vereinfachen(track, toleranz);
  while (grob.length > maxPunkte && toleranz < 400) { toleranz *= 2; grob = vereinfachen(track, toleranz); }
  return grob.map(p => `${p[0].toFixed(5)},${p[1].toFixed(5)}`).join(',');
}

/** Overpass-Abfrage für alle Straßen im Umkreis des Tracks */
export function abfrage(track, radiusM = 30) {
  return `[out:json][timeout:25][maxsize:50000000];way["highway"~"^(${STRASSEN})$"](around:${radiusM},${polylinie(track)});out tags geom;`;
}

/** Fehler, der einen Lauf bewusst beendet (Nutzer bricht ab, Planung gewechselt) – wird nie als Stückfehler weitergezählt */
export function abbruchFehler(text = 'Abgebrochen.') {
  const err = new Error(text);
  err.name = 'Abbruch';
  return err;
}

/** Wartet `ms`; endet vorzeitig mit einem Abbruch, wenn `signal` ausgelöst wird */
export function schlafen(ms, signal) {
  return new Promise((ok, nein) => {
    if (signal?.aborted) { nein(abbruchFehler()); return; }
    const t = setTimeout(() => { signal?.removeEventListener('abort', ab); ok(); }, ms);
    const ab = () => { clearTimeout(t); nein(abbruchFehler()); };
    signal?.addEventListener('abort', ab, { once: true });
  });
}

/** Zeitgrenze für eine Anfrage; löst zusätzlich aus, wenn der Nutzer abbricht */
export function zeitgrenze(ms, signal) {
  const zeit = AbortSignal.timeout(ms);
  return signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([zeit, signal]) : zeit;
}

/** Erklärt einen Netz- oder Dienstfehler so, dass man weiß, was zu tun ist (keine Hostnamen, keine Statuscodes) */
export function fehlerText(err) {
  const t = String(err?.message ?? err ?? '');
  if (err?.name === 'Abbruch') return t || 'Abgebrochen.';
  if (err?.name === 'TypeError' || /Failed to fetch|NetworkError|Load failed|network/i.test(t)) {
    return 'Keine Verbindung zum Kartendienst – bitte Netz prüfen und erneut versuchen.';
  }
  if (/Anfragekontingent|429/.test(t)) return 'Der Kartendienst begrenzt gerade die Anfragen – in einigen Minuten erneut versuchen.';
  if (/antwortet nicht|überlastet|antwortet mit|lieferte keine|TimeoutError|timed out/i.test(t)) {
    return 'Der Kartendienst ist überlastet oder antwortet nicht – später erneut versuchen.';
  }
  return `Der Kartendienst meldet einen Fehler (${t}).`;
}

/**
 * Schickt eine Overpass-Abfrage ab und gibt die Elemente zurück. Die öffentlichen
 * Server begrenzen Anfragen je IP (429 „rate_limited“), sind zeitweise überlastet
 * (504) oder liefern eine Fehlerseite statt JSON. Bei 429 wird geduldig gewartet,
 * sonst wechseln sich beide Server ab.
 * @param {(sek:number, grund:string)=>void} [warte] meldet, dass gewartet wird
 */
export async function ladeElemente(abfrageText, warte = () => {}, { versuche = 7, tempo = 1, signal = null } = {}) {
  const daten = 'data=' + encodeURIComponent(abfrageText);
  let letzter = null;
  for (let versuch = 0; versuch < versuche; versuch++) {
    const url = OVERPASS_URLS[versuch % OVERPASS_URLS.length];
    let pause = 2 * (versuch + 1);
    try {
      const r = await fetch(url, {
        method: 'POST', body: daten, signal: zeitgrenze(45000, signal),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      if (r.status === 429) { pause = 15; throw new Error(`${new URL(url).host}: Anfragekontingent erschöpft`); }
      if (!r.ok) throw new Error(`${new URL(url).host} antwortet mit ${r.status}`);
      const text = await r.text();
      let json;
      try { json = JSON.parse(text); } catch {
        if (/rate_limited/.test(text)) { pause = 15; throw new Error(`${new URL(url).host}: Anfragekontingent erschöpft`); }
        throw new Error(`${new URL(url).host} lieferte keine Daten (überlastet?)`);
      }
      return json.elements || [];
    } catch (err) {
      if (signal?.aborted) throw abbruchFehler();
      letzter = err.name === 'TimeoutError' ? new Error(`${new URL(url).host} antwortet nicht`) : err;
      if (versuch < versuche - 1) { warte(pause, letzter.message); await schlafen(pause * 1000 * tempo, signal); }
    }
  }
  throw letzter || new Error('Overpass nicht erreichbar.');
}

/** Straßen mit Geometrie im Umkreis des Tracks */
export async function ladeWege(track, warte = () => {}, opt = {}) {
  const el = await ladeElemente(abfrage(track), warte, opt);
  return el.filter(x => x.type === 'way' && Array.isArray(x.geometry) && x.geometry.length > 1);
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

/**
 * Leeres Profil für eine Strecke. `fertig` merkt sich je Streckenstück, ob es
 * schon abgefragt ist – so setzt ein neuer Lauf nach Abbruch dort fort.
 */
export function leereArten(laengeKm) {
  const n = Math.ceil(laengeKm / SCHRITT_KM - 1e-9);
  return {
    schritt: SCHRITT_KM, k: 'x'.repeat(n), tab: [], r: new Array(n).fill(-1),
    laenge: Math.round(laengeKm * 1000) / 1000, stueckKm: STUECK_KM,
    fertig: new Array(Math.max(1, Math.ceil(laengeKm / STUECK_KM))).fill(false), luecken: 0
  };
}

/** Trägt Abtastpunkte in das Profil ein (verändert `arten`) */
export function schreibeProben(arten, proben) {
  const k = arten.k.split('');
  for (const q of proben) {
    if (q.i < 0 || q.i >= k.length) continue;
    k[q.i] = q.klasse ? ZEICHEN[q.klasse] : 'x';
    if (q.label) {
      let j = arten.tab.indexOf(q.label);
      if (j < 0) { arten.tab.push(q.label); j = arten.tab.length - 1; }
      arten.r[q.i] = j;
    }
  }
  arten.k = k.join('');
  return arten;
}

/** Verdichtet Abtastpunkte zum gespeicherten Profil */
export function baueArten(proben, laengeKm) {
  return schreibeProben(leereArten(laengeKm), proben);
}

/** Wie viele Streckenstücke noch nicht abgefragt sind (ohne Merker: 0) */
export function offeneStuecke(arten) {
  return arten?.fertig ? arten.fertig.filter(x => !x).length : 0;
}

/** Gehört das gespeicherte Profil zu diesem Track? */
export function passtZu(arten, laengeKm) {
  return !!arten?.fertig && Math.abs(arten.laenge - laengeKm) < 0.01 && arten.stueckKm === STUECK_KM;
}

/**
 * Fragt die Route stückweise ab. Bereits fertige Stücke eines passenden
 * Profils (`vorhanden`) werden übersprungen; nach jedem Stück ruft
 * `beiStueck(arten)` auf, damit der Aufrufer den Stand sichert.
 * @param {{fortschritt?:Function, vorhanden?:object, beiStueck?:Function, versuche?:number, tempo?:number}} [opt]
 */
export async function analysiere(track, opt = {}) {
  const { fortschritt = () => {}, vorhanden = null, beiStueck = () => {}, versuche, tempo = 1, signal = null } = opt;
  const laenge = trackLaengeM(track) / 1000;
  const arten = passtZu(vorhanden, laenge) ? structuredClone(vorhanden) : leereArten(laenge);
  const stuecke = arten.fertig.length;
  let hinweis = '', letzterFehler = null, geholt = 0;
  for (let s = 0; s < stuecke; s++) {
    if (arten.fertig[s]) continue;                       // schon vorhanden – nicht noch einmal fragen
    if (signal?.aborted) throw abbruchFehler();
    fortschritt(s, stuecke, hinweis);
    hinweis = '';
    const von = s * STUECK_KM, bis = Math.min(laenge, (s + 1) * STUECK_KM);
    const sub = teilTrack(track, Math.max(0, von - 0.1), Math.min(laenge, bis + 0.1));
    if (sub.length < 2) { arten.fertig[s] = true; continue; }
    try {
      const wege = await ladeWege(sub, (sek, grund) => fortschritt(s, stuecke, `${grund} – neuer Versuch in ${sek} s`), { versuche, tempo, signal });
      schreibeProben(arten, abtasten(track, wege, von, bis));
      arten.fertig[s] = true;
      arten.luecken = offeneStuecke(arten);
      geholt++;
      beiStueck(arten);
    } catch (err) {                                      // ein Stück darf fehlen, der Rest zählt
      if (err.name === 'Abbruch') throw err;             // Nutzer bricht ab oder Planung gewechselt: nicht weiterfragen
      letzterFehler = err;
      arten.luecken = offeneStuecke(arten);
    }
    if (s < stuecke - 1) await schlafen(PAUSE_MS * tempo, signal);
  }
  fortschritt(stuecke, stuecke);
  arten.luecken = offeneStuecke(arten);
  if (arten.luecken > 0 && geholt === 0 && letzterFehler) throw letzterFehler;
  return arten;
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
