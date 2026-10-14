import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abstandM, trackLaengeM, punktBeiKm, naechsterKm, vereinfachen, teilTrack } from '../js/geo.js';
import { leseGpx } from '../js/gpx.js';

// Rund 11,12 km nach Norden: je 0,05° Breite ≈ 5,56 km
const TRACK = [[48.00, 8.00], [48.05, 8.00], [48.10, 8.00]];

test('Abstand: 0,1° Breite ≈ 11,1 km', () => {
  assert.ok(Math.abs(abstandM([48, 8], [48.1, 8]) - 11119) < 20);
});

test('Tracklänge und Punkt bei km', () => {
  const l = trackLaengeM(TRACK);
  assert.ok(Math.abs(l - 11119) < 20);
  const mitte = punktBeiKm(TRACK, l / 2000);
  assert.ok(Math.abs(mitte[0] - 48.05) < 1e-4);
  assert.deepEqual(punktBeiKm(TRACK, -5), TRACK[0]);
  assert.ok(Math.abs(punktBeiKm(TRACK, 999)[0] - 48.10) < 1e-9);
});

test('Nächster Punkt auf dem Track liefert Kilometer und Abstand', () => {
  const r = naechsterKm(TRACK, [48.025, 8.001]);        // ≈ 74 m seitlich
  assert.ok(Math.abs(r.km - 2.78) < 0.05);
  assert.ok(r.abstandM > 60 && r.abstandM < 90);
});

test('Vereinfachen behält Ecken, wirft Gerade weg', () => {
  const gerade = [[48, 8], [48.01, 8], [48.02, 8], [48.03, 8]];
  assert.equal(vereinfachen(gerade, 5).length, 2);
  const ecke = [[48, 8], [48.01, 8], [48.01, 8.02]];
  assert.equal(vereinfachen(ecke, 5).length, 3);
});

test('Teilstück zwischen zwei Kilometerständen', () => {
  const t = teilTrack(TRACK, 2, 8);
  assert.ok(t.length >= 3);
  assert.ok(Math.abs(trackLaengeM(t) - 6000) < 30);
});

const GPX = `<?xml version="1.0"?>
<gpx version="1.1" creator="TomTom" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Marsch Test</name></metadata>
  <wpt lat="48.05" lon="8.00"><name>Rast &amp; Tanken</name></wpt>
  <rte><name>Route</name>
    <rtept lat="48.00" lon="8.00"><name>Start</name></rtept>
    <rtept lat="48.10" lon="8.00"><name>Ziel</name></rtept>
  </rte>
  <trk><name>Verlauf</name><trkseg>
    <trkpt lat="48.00" lon="8.00"><ele>400</ele></trkpt>
    <trkpt lat="48.05" lon="8.00"/>
    <trkpt lat="48.10" lon="8.00"></trkpt>
  </trkseg></trk>
</gpx>`;

test('GPX: Track bevorzugt, benannte Routenpunkte werden Wegpunkte', () => {
  const g = leseGpx(GPX);
  assert.equal(g.quelle, 'trk');
  assert.equal(g.track.length, 3);
  assert.equal(g.name, 'Verlauf');
  const namen = g.wegpunkte.map(w => w.name);
  assert.deepEqual(namen, ['Rast & Tanken', 'Start', 'Ziel']);
});

test('GPX: nur Route → Route ist der Verlauf', () => {
  const g = leseGpx(GPX.replace(/<trk>[\s\S]*<\/trk>/, ''));
  assert.equal(g.quelle, 'rte');
  assert.equal(g.track.length, 2);
});

test('GPX: Attribute in beliebiger Reihenfolge, Apostroph-Quotes, ungültige Werte', () => {
  const g = leseGpx(`<gpx><trk><trkseg>
    <trkpt lon='8.5' lat='48.5'/><trkpt lon="8.6" lat="48.6"/><trkpt lat="999" lon="1"/><trkpt lat="x" lon="y"/>
  </trkseg></trk></gpx>`);
  assert.deepEqual(g.track, [[48.5, 8.5], [48.6, 8.6]]);
});

test('GPX: kein GPX wirft', () => {
  assert.throws(() => leseGpx('<html></html>'), /keine GPX/);
  assert.throws(() => leseGpx(null));
});
