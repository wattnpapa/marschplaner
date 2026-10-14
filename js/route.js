// route.js – Route und Kontrollpunkte eines Projekts bearbeiten
//
// Die Route ist der Track (Liste von [lat, lon]) und die Kontrollpunkte darauf.
// Ein Kontrollpunkt kennt seine Lage nur als Kilometerstand `km` entlang des
// Tracks; Breite und Länge werden daraus abgeleitet. So bleibt ein Punkt auf
// der Strecke, wenn man ihn verschiebt, und die Tabelle braucht keine Karte.

import { neuerKp } from './daten.js';
import { naechsterKm, punktBeiKm, trackLaengeM, vereinfachen, runden } from './geo.js';
import { sortierteKp } from './rechnen.js';

const GLEICH_M = 60;        // Wegpunkte näher als das gelten als derselbe Punkt
const RAND_KM = 0.35;       // Wegpunkt so nah am Trackende ist Ablauf- bzw. Zielpunkt
const MAX_ABSTAND_M = 3000; // weiter neben dem Track gilt ein Wegpunkt als nicht zur Route gehörig

export function trackKm(route) {
  return trackLaengeM(route.track) / 1000;
}

/** [lat, lon] eines Kontrollpunkts auf dem Track, sonst null */
export function kpPosition(route, kp) {
  if (!route.track?.length) return null;
  return punktBeiKm(route.track, kp.km);
}

/**
 * Übernimmt eine gelesene GPX-Datei: vereinfachter Track, Kontrollpunkte aus den
 * Wegpunkten. Gibt zurück, was nicht verwendet werden konnte.
 */
export function routeAusGpx(p, gpx, { toleranzM = 6 } = {}) {
  if (!gpx.track || gpx.track.length < 2) throw new Error('Die Datei enthält keinen Streckenverlauf.');
  const track = runden(vereinfachen(gpx.track, toleranzM));
  const laenge = trackLaengeM(track) / 1000;

  let verworfen = 0;
  const wege = [];
  for (const w of gpx.wegpunkte) {
    const r = naechsterKm(track, [w.lat, w.lon]);
    if (!r || r.abstandM > MAX_ABSTAND_M) { verworfen++; continue; }
    wege.push({ name: w.name, km: r.km });
  }
  wege.sort((a, b) => a.km - b.km);
  const eindeutig = [];
  for (const w of wege) {
    const letzter = eindeutig[eindeutig.length - 1];
    if (letzter && (w.km - letzter.km) * 1000 < GLEICH_M) {
      if (!letzter.name && w.name) letzter.name = w.name;
      continue;
    }
    eindeutig.push({ ...w });
  }

  const kps = [];
  const erster = eindeutig[0], letzter = eindeutig[eindeutig.length - 1];
  const startIstWeg = erster && erster.km < RAND_KM;
  const zielIstWeg = letzter && eindeutig.length > 1 && laenge - letzter.km < RAND_KM;

  kps.push(neuerKp('ablauf', { ort: startIstWeg ? erster.name : '', km: 0 }));
  eindeutig.forEach((w, i) => {
    if (i === 0 && startIstWeg) return;
    if (i === eindeutig.length - 1 && zielIstWeg) return;
    kps.push(neuerKp('kp', { ort: w.name, km: w.km }));
  });
  kps.push(neuerKp('ziel', { ort: zielIstWeg ? letzter.name : '', km: laenge }));

  p.route.track = track;
  p.route.name = gpx.name || '';
  p.route.quelle = 'gpx';
  p.route.kontrollpunkte = kps;
  p.route.arten = null;                       // gehört zum alten Track
  if (!p.kopf.von && kps[0].ort) p.kopf.von = kps[0].ort;
  if (!p.kopf.nach && kps[kps.length - 1].ort) p.kopf.nach = kps[kps.length - 1].ort;
  return { laengeKm: laenge, punkte: kps.length, verworfen };
}

/** Fügt einen Kontrollpunkt bei `km` ein; die Straßenart erbt er vom Abschnitt, in den er fällt */
export function kpHinzufuegen(p, km, typ = 'kp', extra = {}) {
  const sortiert = sortierteKp(p.route);
  const folgender = sortiert.find(k => k.km > km);
  const kp = neuerKp(typ, { km: Math.max(0, km), klasse: folgender?.klasse || 'bul', ...extra });
  p.route.kontrollpunkte.push(kp);
  kpOrdnen(p);
  return kp;
}

export function kpEntfernen(p, id) {
  p.route.kontrollpunkte = p.route.kontrollpunkte.filter(k => k.id !== id);
}

/** Hält die Liste nach Kilometerstand sortiert; der erste Punkt bleibt der Ablaufpunkt */
export function kpOrdnen(p) {
  p.route.kontrollpunkte = sortierteKp(p.route);
}

/** Setzt einen Punkt auf den Track-Punkt, der `lage` am nächsten liegt */
export function kpAnTrackSetzen(p, id, lage) {
  const kp = p.route.kontrollpunkte.find(k => k.id === id);
  const r = naechsterKm(p.route.track, lage);
  if (!kp || !r) return null;
  kp.km = r.km;
  kpOrdnen(p);
  return kp;
}

export function routeLoeschen(p) {
  p.route.track = [];
  p.route.name = '';
  p.route.quelle = '';
  p.route.arten = null;
  p.route.kontrollpunkte = [];
}

/** Übernimmt das OSM-Profil der Straßenarten; alle Abschnitte rechnen danach anteilig („auto“) */
export function artenUebernehmen(p, arten) {
  p.route.arten = arten;
  for (const kp of p.route.kontrollpunkte) kp.klasse = 'auto';
}
