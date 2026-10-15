// plaetze.js – Rast-, Park- und Tankplätze entlang der Strecke vorschlagen
//
// Ablauf: Die Route wird stückweise (wie bei den Straßenarten) bei Overpass nach
// Rastplätzen, Parkplätzen und Tankstellen im Suchradius abgefragt. Fertige Stücke
// werden gemerkt. Aus den Treffern schlägt `vorschlagen` für jede geplante Pause
// (alle N Minuten Fahrzeit) den besten Platz im Zeitfenster vor. Liegt der Platz
// abseits der Strecke, kostet das einen Umweg, den der Fahrplan mitrechnet.

import { naechsterKm, trackLaengeM, teilTrack } from './geo.js';
import { polylinie, ladeElemente } from './strassenart.js';
import { fahrplan } from './rechnen.js';

export const STUECK_KM = 10;
export const PAUSE_MS = 2500;
const UMWEG_FAKTOR = 1.3;          // Straße ist länger als die Luftlinie zum Platz

export const ART_NAME = { rast: 'Rastplatz / Raststätte', parkplatz: 'Parkplatz', tank: 'Tankstelle' };

/** Overpass-Abfrage nach Plätzen im Umkreis des Tracks */
export function abfrage(track, radiusM) {
  const p = polylinie(track);
  const um = `(around:${radiusM},${p})`;
  return `[out:json][timeout:25][maxsize:50000000];(`
    + `nwr["highway"~"^(rest_area|services)$"]${um};`
    + `nwr["amenity"="fuel"]${um};`
    + `nwr["amenity"="parking"]["access"!~"^(private|customers|no|permit|delivery)$"]`
    + `["parking"!~"^(street_side|lane|on_kerb|half_on_kerb|underground|multi-storey|rooftop)$"]${um};`
    + `);out tags center;`;
}

function artVon(tags) {
  if (tags.highway === 'rest_area' || tags.highway === 'services') return 'rast';
  if (tags.amenity === 'fuel') return 'tank';
  if (tags.amenity === 'parking') return 'parkplatz';
  return null;
}

/** Zusatzweg in km für Hin- und Rückfahrt zu einem Platz `abstandM` neben der Strecke */
export function umwegKm(abstandM) {
  if (!(abstandM >= 50)) return 0;
  return Math.round(2 * abstandM * UMWEG_FAKTOR / 100) / 10;
}

/** Rohe Overpass-Elemente → Plätze mit Kilometerstand und Abstand zur Strecke */
export function normalisiere(elemente, track, radiusM) {
  const aus = [];
  for (const el of elemente) {
    const t = el.tags || {};
    const art = artVon(t);
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    if (!art || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const r = naechsterKm(track, [lat, lon]);
    if (!r || r.abstandM > radiusM) continue;
    const kap = parseInt(t['capacity:hgv'] ?? t.capacity, 10);
    aus.push({
      id: `${(el.type || 'n')[0]}${el.id}`,
      art,
      name: t.name || t.brand || t.operator || '',
      lat, lon,
      km: r.km,
      abstandM: Math.round(r.abstandM),
      kapazitaet: Number.isFinite(kap) ? kap : null,
      lkw: t.hgv === 'yes' || t.hgv === 'designated' || Number.isFinite(parseInt(t['capacity:hgv'], 10)),
      wc: t.toilets === 'yes' || t.toilets === 'customers' ? true : (art === 'rast' && t.toilets !== 'no' ? null : false)
    });
  }
  return aus;
}

/* ---------- stückweise Suche mit Fortsetzen ---------- */

export function leerePlaetze(laengeKm, radiusM) {
  return {
    radius: radiusM, laenge: Math.round(laengeKm * 1000) / 1000, stueckKm: STUECK_KM,
    fertig: new Array(Math.max(1, Math.ceil(laengeKm / STUECK_KM))).fill(false), luecken: 0, liste: []
  };
}

export function offeneStuecke(plaetze) {
  return plaetze?.fertig ? plaetze.fertig.filter(x => !x).length : 0;
}

/** Reicht der gespeicherte Stand für diesen Track und diesen Radius? */
export function passtZu(plaetze, laengeKm, radiusM) {
  return !!plaetze?.fertig && Math.abs(plaetze.laenge - laengeKm) < 0.01
    && plaetze.stueckKm === STUECK_KM && plaetze.radius >= radiusM;
}

/**
 * Sucht Plätze entlang der ganzen Strecke. Bereits fertige Stücke eines
 * passenden Standes (`vorhanden`) werden nicht noch einmal abgefragt.
 */
export async function sucheEntlang(track, radiusM, opt = {}) {
  const { fortschritt = () => {}, vorhanden = null, beiStueck = () => {}, versuche, tempo = 1 } = opt;
  const laenge = trackLaengeM(track) / 1000;
  const stand = passtZu(vorhanden, laenge, radiusM) ? structuredClone(vorhanden) : leerePlaetze(laenge, radiusM);
  const stuecke = stand.fertig.length;
  let hinweis = '', letzterFehler = null, geholt = 0;
  for (let s = 0; s < stuecke; s++) {
    if (stand.fertig[s]) continue;
    fortschritt(s, stuecke, hinweis);
    hinweis = '';
    const von = s * STUECK_KM, bis = Math.min(laenge, (s + 1) * STUECK_KM);
    const sub = teilTrack(track, Math.max(0, von - 0.1), Math.min(laenge, bis + 0.1));
    if (sub.length < 2) { stand.fertig[s] = true; continue; }
    try {
      const el = await ladeElemente(abfrage(sub, radiusM),
        (sek, grund) => fortschritt(s, stuecke, `${grund} – neuer Versuch in ${sek} s`), { versuche, tempo });
      const bekannt = new Set(stand.liste.map(x => x.id));
      for (const platz of normalisiere(el, track, radiusM)) {
        if (!bekannt.has(platz.id)) { stand.liste.push(platz); bekannt.add(platz.id); }
      }
      stand.liste.sort((a, b) => a.km - b.km);
      stand.fertig[s] = true;
      stand.luecken = offeneStuecke(stand);
      geholt++;
      beiStueck(stand);
    } catch (err) {
      letzterFehler = err;
      stand.luecken = offeneStuecke(stand);
    }
    if (s < stuecke - 1) await new Promise(r => setTimeout(r, PAUSE_MS * tempo));
  }
  fortschritt(stuecke, stuecke);
  stand.luecken = offeneStuecke(stand);
  if (stand.luecken > 0 && geholt === 0 && letzterFehler) throw letzterFehler;
  return stand;
}

/* ---------- Vorschläge ---------- */

/** Reine Fahrzeit (min) bis zum Kilometerstand `km` entlang der Strecke */
export function zeitBeiKm(fp, km) {
  const z = fp.zeilen;
  if (!z.length || km <= z[0].kp.km) return 0;
  for (let i = 1; i < z.length; i++) {
    if (km <= z[i].kp.km) {
      const l = z[i].kp.km - z[i - 1].kp.km;
      const f = l > 0 ? (km - z[i - 1].kp.km) / l : 1;
      return z[i - 1].fahrGesamt + f * (z[i].fahrGesamt - z[i - 1].fahrGesamt);
    }
  }
  return z[z.length - 1].fahrGesamt;
}

/** Kilometerstand, bei dem die reine Fahrzeit `t` (min) erreicht ist */
export function kmBeiZeit(fp, t) {
  const z = fp.zeilen;
  if (!z.length) return 0;
  for (let i = 1; i < z.length; i++) {
    if (t <= z[i].fahrGesamt) {
      const dt = z[i].fahrGesamt - z[i - 1].fahrGesamt;
      const f = dt > 0 ? (t - z[i - 1].fahrGesamt) / dt : 1;
      return z[i - 1].kp.km + f * (z[i].kp.km - z[i - 1].kp.km);
    }
  }
  return z[z.length - 1].kp.km;
}

const ART_PUNKTE = { rast: 3, tank: 1.5, parkplatz: 1 };

/** Bewertung eines Platzes; je höher, desto besser */
export function bewerte(p, { radiusM, fensterMin, zeitAbweichungMin, kapMin }) {
  let s = ART_PUNKTE[p.art] ?? 0;
  if (p.kapazitaet === null) s += 0.5; else if (p.kapazitaet >= kapMin) s += 2;
  if (p.wc) s += 1;
  if (p.lkw) s += 1;
  s -= (p.abstandM / Math.max(radiusM, 1)) * 2;
  s -= (Math.abs(zeitAbweichungMin) / Math.max(fensterMin, 1)) * 1.5;
  return Math.round(s * 100) / 100;
}

/**
 * Für jede geplante Pause (alle `intervallMin` Fahrzeit) die passenden Plätze im
 * Zeitfenster ±`fensterMin`, beste zuerst.
 * @returns {{n:number, tMin:number, km:number, kandidaten:object[], bester:object|null}[]}
 */
export function vorschlagen(projekt, liste, { intervallMin = 120, fensterMin = 30, radiusM = 1000, kapMin = 0, arten = ['rast', 'parkplatz', 'tank'] } = {}) {
  const fp = fahrplan(projekt, projekt.kolonnen[0] ?? null);
  if (fp.zeilen.length < 2 || !(intervallMin > 0)) return [];
  const aus = [];
  for (let n = 1; n * intervallMin < fp.fahrMin - intervallMin * 0.4; n++) {
    const T = n * intervallMin;
    const kandidaten = [];
    for (const p of liste) {
      if (!arten.includes(p.art)) continue;
      if (p.kapazitaet !== null && p.kapazitaet < kapMin) continue;
      const dt = zeitBeiKm(fp, p.km) - T;
      if (Math.abs(dt) > fensterMin) continue;
      kandidaten.push({ ...p, zeitAbweichungMin: Math.round(dt), punkte: bewerte(p, { radiusM, fensterMin, zeitAbweichungMin: dt, kapMin }), umwegKm: umwegKm(p.abstandM) });
    }
    kandidaten.sort((a, b) => b.punkte - a.punkte);
    aus.push({ n, tMin: T, km: kmBeiZeit(fp, T), kandidaten, bester: kandidaten[0] ?? null });
  }
  return aus;
}
