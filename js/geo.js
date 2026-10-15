// geo.js – Strecken entlang eines Tracks: Längen, Positionen, Vereinfachen

const R = 6371008.8;                       // mittlerer Erdradius in m
const RAD = Math.PI / 180;

/** Entfernung zweier Punkte [lat, lon] in Metern (Haversine) */
export function abstandM(a, b) {
  const dLat = (b[0] - a[0]) * RAD;
  const dLon = (b[1] - a[1]) * RAD;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

const speicher = new WeakMap();

/** Kumulierte Länge in Metern je Trackpunkt; für denselben Track nur einmal gerechnet */
export function kumuliert(track) {
  let k = speicher.get(track);
  if (k) return k;
  k = new Float64Array(track.length);
  for (let i = 1; i < track.length; i++) k[i] = k[i - 1] + abstandM(track[i - 1], track[i]);
  speicher.set(track, k);
  return k;
}

export function trackLaengeM(track) {
  if (!track || track.length < 2) return 0;
  const k = kumuliert(track);
  return k[k.length - 1];
}

/** Punkt [lat, lon] bei `km` Kilometern vom Trackanfang; außerhalb wird begrenzt */
export function punktBeiKm(track, km) {
  if (!track || track.length === 0) return null;
  if (track.length === 1) return track[0];
  const k = kumuliert(track);
  const m = Math.min(Math.max(km * 1000, 0), k[k.length - 1]);
  let lo = 0, hi = k.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (k[mid] <= m) lo = mid; else hi = mid;
  }
  const seg = k[hi] - k[lo];
  const t = seg > 0 ? (m - k[lo]) / seg : 0;
  return [
    track[lo][0] + (track[hi][0] - track[lo][0]) * t,
    track[lo][1] + (track[hi][1] - track[lo][1]) * t
  ];
}

/** Teilstück des Tracks zwischen zwei Kilometerständen (inklusive Randpunkten) */
export function teilTrack(track, vonKm, bisKm) {
  if (!track || track.length < 2) return [];
  const k = kumuliert(track);
  const a = Math.max(vonKm * 1000, 0), b = Math.min(bisKm * 1000, k[k.length - 1]);
  if (b <= a) return [];
  const aus = [punktBeiKm(track, vonKm)];
  for (let i = 0; i < track.length; i++) if (k[i] > a && k[i] < b) aus.push(track[i]);
  aus.push(punktBeiKm(track, bisKm));
  return aus;
}

/**
 * Nächster Punkt des Tracks zu `p`. Liefert die Position in Kilometern entlang des
 * Tracks und den Abstand in Metern. Gerechnet wird je Teilstück in einer lokalen
 * ebenen Näherung – auf Marschabschnitten von wenigen Kilometern genau genug.
 */
export function naechsterKm(track, p) {
  if (!track || track.length === 0) return null;
  if (track.length === 1) return { km: 0, abstandM: abstandM(track[0], p) };
  const k = kumuliert(track);
  const cosLat = Math.cos(p[0] * RAD);
  let beste = Infinity, bestM = 0;
  for (let i = 1; i < track.length; i++) {
    const ax = (track[i - 1][1] - p[1]) * cosLat, ay = track[i - 1][0] - p[0];
    const bx = (track[i][1] - p[1]) * cosLat, by = track[i][0] - p[0];
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? -(ax * dx + ay * dy) / l2 : 0;
    t = Math.min(1, Math.max(0, t));
    const px = ax + dx * t, py = ay + dy * t;
    const d2 = px * px + py * py;
    if (d2 < beste) { beste = d2; bestM = k[i - 1] + (k[i] - k[i - 1]) * t; }
  }
  return { km: bestM / 1000, abstandM: Math.sqrt(beste) * RAD * R };
}

/** Douglas-Peucker ohne Rekursion; `toleranzM` in Metern */
export function vereinfachen(track, toleranzM) {
  const n = track.length;
  if (n < 3 || !(toleranzM > 0)) return track.slice();
  const lat0 = track[0][0] * RAD, cosLat = Math.cos(lat0);
  const xy = track.map(p => [p[1] * RAD * R * cosLat, p[0] * RAD * R]);
  const behalten = new Uint8Array(n);
  behalten[0] = behalten[n - 1] = 1;
  const stapel = [[0, n - 1]];
  while (stapel.length) {
    const [a, b] = stapel.pop();
    let dMax = 0, idx = -1;
    const [ax, ay] = xy[a], [bx, by] = xy[b];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      let t = l2 > 0 ? ((xy[i][0] - ax) * dx + (xy[i][1] - ay) * dy) / l2 : 0;
      t = Math.min(1, Math.max(0, t));
      const d = Math.hypot(xy[i][0] - (ax + dx * t), xy[i][1] - (ay + dy * t));
      if (d > dMax) { dMax = d; idx = i; }
    }
    if (idx >= 0 && dMax > toleranzM) {
      behalten[idx] = 1;
      stapel.push([a, idx], [idx, b]);
    }
  }
  const aus = [];
  for (let i = 0; i < n; i++) if (behalten[i]) aus.push(track[i]);
  return aus;
}

/** Auf fünf Nachkommastellen (≈ 1 m) runden – hält den Speicherstand klein */
export function runden(track) {
  return track.map(p => [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5]);
}

/* ---------- Maßstab und Koordinaten für die Blätter ---------- */

const UMFANG_M = 40075016.686;             // Erdumfang am Äquator (Web-Mercator)

/** Meter, die in der Web-Mercator-Karte (Weltbreite = 1) einer Einheit in der Breite `lat` entsprechen */
export function meterProMercatorEinheit(lat) {
  return UMFANG_M * Math.cos(Math.max(-85, Math.min(85, lat)) * RAD);
}

/** Größte „runde“ Länge (1, 2 oder 5 × 10ⁿ m), die höchstens `maxM` lang ist; 0 bei ungültiger Eingabe */
export function schoenerMassstab(maxM) {
  if (!(maxM > 0) || !Number.isFinite(maxM)) return 0;
  const e = 10 ** Math.floor(Math.log10(maxM));
  for (const f of [5, 2, 1]) if (f * e <= maxM) return f * e;
  return e;
}

/** „500 m“ bzw. „2 km“ */
export function laengeText(m) {
  const z = (x) => String(+x.toFixed(2)).replace('.', ',');
  return m >= 1000 ? `${z(m / 1000)} km` : `${z(m)} m`;
}

/** Position als Dezimalgrad mit Referenzsystem: „49,4123° N, 8,6941° E“ */
export function koordText(lat, lon, stellen = 4) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '';
  const g = (x, plus, minus) => `${Math.abs(x).toFixed(stellen).replace('.', ',')}° ${x >= 0 ? plus : minus}`;
  return `${g(lat, 'N', 'S')}, ${g(lon, 'E', 'W')}`;
}
