// beispiel.js – eine kleine Beispielplanung zum Ausprobieren
//
// Die Route ist schematisch: Sie verbindet reale Ortslagen auf Luftlinie mit
// leichter Krümmung und folgt keiner Straße. Sie dient nur dazu, alle Blätter
// einmal gefüllt zu sehen.

import { neuesProjekt, neueKolonne } from './daten.js';
import { routeAusGpx } from './route.js';

const ECKEN = [
  { name: 'Rottenburg am Neckar', lat: 48.4767, lon: 8.9347 },
  { name: 'Tübingen', lat: 48.5216, lon: 9.0576 },
  { name: 'Waldenbuch', lat: 48.6400, lon: 9.1300 },
  { name: 'Stuttgart-Möhringen', lat: 48.7260, lon: 9.1680 }
];

function gpxText() {
  const pkt = [];
  for (let i = 0; i < ECKEN.length - 1; i++) {
    const a = ECKEN[i], b = ECKEN[i + 1];
    for (let s = 0; s < 40; s++) {
      const t = s / 40;
      const bogen = Math.sin(t * Math.PI) * 0.006 * (i % 2 ? -1 : 1);
      pkt.push([a.lat + (b.lat - a.lat) * t + bogen * 0.4, a.lon + (b.lon - a.lon) * t + bogen]);
    }
  }
  const z = ECKEN[ECKEN.length - 1];
  pkt.push([z.lat, z.lon]);
  const wpt = ECKEN.map(o => `<wpt lat="${o.lat}" lon="${o.lon}"><name>${o.name}</name></wpt>`).join('');
  const trk = pkt.map(q => `<trkpt lat="${q[0].toFixed(5)}" lon="${q[1].toFixed(5)}"/>`).join('');
  return `<?xml version="1.0"?><gpx version="1.1">${wpt}<trk><name>Beispielroute (schematisch)</name><trkseg>${trk}</trkseg></trk></gpx>`;
}

/** Füllt `p` mit der Beispielplanung */
export function beispielFuellen(p, leseGpx) {
  routeAusGpx(p, leseGpx(gpxText()));
  const heute = new Date();
  p.name = 'Beispiel: Rottenburg – Stuttgart';
  p.kopf.kennung = 'BEISPIEL';
  p.kopf.verband = 'Marschverband Beispiel';
  p.kopf.datum = `${heute.getFullYear()}-${String(heute.getMonth() + 1).padStart(2, '0')}-${String(heute.getDate()).padStart(2, '0')}`;
  p.kopf.ablaufzeit = '08:00';
  const [ablauf, tue, wald, ziel] = p.route.kontrollpunkte;
  Object.assign(ablauf, { typ: 'ablauf', strasse: '' });
  Object.assign(tue, { typ: 'kp', strasse: 'B 28', klasse: 'bul' });
  Object.assign(wald, { typ: 'th', strasse: 'B 27', klasse: 'bul', halt: 15, bemerkung: 'Parkplatz an der B 27' });
  Object.assign(ziel, { typ: 'ziel', strasse: 'Stadtgebiet', klasse: 'ort' });
  const k1 = Object.assign(neueKolonne(1), { einzel: 8, gespanne: 2, versatzMin: 0, marschfolge: 'Führungsfahrzeug, 8 Kombi, 2 Gespanne, Schließender' });
  const k2 = Object.assign(neueKolonne(2), { einzel: 6, gespanne: 3, versatzMin: 20, marschfolge: '6 Kombi, 3 Gespanne' });
  p.kolonnen = [k1, k2];
  return p;
}

export function neuesBeispiel(leseGpx) {
  return beispielFuellen(neuesProjekt(), leseGpx);
}
