// gpx.js – GPX lesen (TomTom MyDrive, Garmin, Komoot, GPX Studio …)
//
// Ein eigener, kleiner Leser statt DOMParser: so läuft er ohne Browser im Test,
// und GPX ist flach genug dafür. Verstanden werden
//   <trk>/<trkseg>/<trkpt>  – der gefahrene Verlauf (bevorzugt),
//   <rte>/<rtept>           – die Route; Verlauf, wenn kein Track da ist,
//   <wpt>                   – benannte Punkte,
// und benannte <rtept> neben einem Track gelten als Wegpunkte (so schreibt es
// der TomTom-Planer: Haltepunkte als rtept, Verlauf als trk).

function entschluesseln(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .trim();
}

function attribut(tag, name) {
  const m = new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', 'i').exec(tag);
  return m ? (m[1] ?? m[2]) : null;
}

function kind(inhalt, name) {
  if (!inhalt) return '';
  const m = new RegExp('<' + name + '\\b[^>]*>([\\s\\S]*?)</' + name + '>', 'i').exec(inhalt);
  return m ? entschluesseln(m[1]) : '';
}

function punkte(text, tagName) {
  const re = new RegExp('<' + tagName + '\\b([^>]*?)(?:/>|>([\\s\\S]*?)</' + tagName + '>)', 'gi');
  const aus = [];
  for (const m of text.matchAll(re)) {
    const lat = parseFloat(attribut(m[1], 'lat'));
    const lon = parseFloat(attribut(m[1], 'lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    aus.push({ lat, lon, name: kind(m[2], 'name') || kind(m[2], 'desc') });
  }
  return aus;
}

/**
 * @returns {{name:string, track:number[][], wegpunkte:{name:string,lat:number,lon:number}[], quelle:'trk'|'rte'|null}}
 */
export function leseGpx(text) {
  if (typeof text !== 'string' || !/<gpx\b/i.test(text)) {
    throw new Error('Das ist keine GPX-Datei.');
  }
  const trk = punkte(text, 'trkpt');
  const rte = punkte(text, 'rtept');
  const wpt = punkte(text, 'wpt');

  const track = trk.length >= 2 ? trk : rte;
  const quelle = trk.length >= 2 ? 'trk' : (rte.length >= 2 ? 'rte' : null);

  let wege = wpt.slice();
  if (quelle === 'trk') wege = wege.concat(rte.filter(p => p.name));

  const gesehen = new Set();
  wege = wege.filter(p => {
    const k = `${p.name}|${p.lat.toFixed(4)}|${p.lon.toFixed(4)}`;
    if (gesehen.has(k)) return false;
    gesehen.add(k);
    return true;
  });

  const trkBlock = /<trk\b[\s\S]*?<\/trk>/i.exec(text)?.[0];
  const rteBlock = /<rte\b[\s\S]*?<\/rte>/i.exec(text)?.[0];
  const meta = /<metadata\b[\s\S]*?<\/metadata>/i.exec(text)?.[0];
  const name = kind(trkBlock?.replace(/<trkseg\b[\s\S]*$/i, ''), 'name')
    || kind(rteBlock?.replace(/<rtept\b[\s\S]*$/i, ''), 'name')
    || kind(meta, 'name');

  return {
    name,
    track: track.map(p => [p.lat, p.lon]),
    wegpunkte: wege.map(p => ({ name: p.name, lat: p.lat, lon: p.lon })),
    quelle
  };
}

/* ---------- Schreiben ---------- */

function maskieren(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Schreibt Verlauf und benannte Punkte als GPX 1.1 (für Navigationsgeräte und andere Planer).
 * @param {{name?:string, track:number[][], punkte?:{name:string, lat:number, lon:number, text?:string}[]}} d
 */
export function schreibeGpx({ name = '', track, punkte = [] }) {
  const wpt = punkte.map(p => `  <wpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"><name>${maskieren(p.name)}</name>${p.text ? `<desc>${maskieren(p.text)}</desc>` : ''}</wpt>`);
  const trkpt = track.map(q => `      <trkpt lat="${q[0].toFixed(6)}" lon="${q[1].toFixed(6)}"/>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Marschplaner" xmlns="http://www.topografix.com/GPX/1/1">
${wpt.join('\n')}${wpt.length ? '\n' : ''}  <trk>
    <name>${maskieren(name)}</name>
    <trkseg>
${trkpt.join('\n')}
    </trkseg>
  </trk>
</gpx>
`;
}
