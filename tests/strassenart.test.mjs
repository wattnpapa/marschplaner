import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  abfrage, klasseVon, referenzen, abtasten, baueArten, anteileImAbschnitt, strasseImAbschnitt, klassenLaeufe
} from '../js/strassenart.js';
import { trackLaengeM } from '../js/geo.js';
import { fahrplan } from '../js/rechnen.js';

const TRACK = [[48.00, 8.0], [48.05, 8.0], [48.10, 8.0]];
const LAENGE = trackLaengeM(TRACK) / 1000;
const MITTE = LAENGE / 2;
const weg = (tags, ...punkte) => ({ type: 'way', tags, geometry: punkte.map(([lat, lon]) => ({ lat, lon })) });
const profil = (wege) => baueArten(abtasten(TRACK, wege), LAENGE);

const AUTOBAHN_DANN_BUNDESSTRASSE = [
  weg({ highway: 'motorway', ref: 'A 8' }, [48.0, 8.0001], [48.05, 8.0001]),
  weg({ highway: 'primary', ref: 'B 28', maxspeed: '100' }, [48.05, 7.9999], [48.10, 7.9999]),
  weg({ highway: 'residential', name: 'Weitweg' }, [48.0, 8.01], [48.1, 8.01])       // zu weit weg
];

test('Klassifizierung nach Straßentyp, Nummer und Tempo', () => {
  assert.equal(klasseVon({ highway: 'motorway', ref: 'A 8' }), 'bab');
  assert.equal(klasseVon({ highway: 'motorway_link' }), 'bab');
  assert.equal(klasseVon({ highway: 'trunk', ref: 'A 5' }), 'bab');
  assert.equal(klasseVon({ highway: 'trunk', ref: 'B 31' }), 'bul');
  assert.equal(klasseVon({ highway: 'primary', ref: 'B 28' }), 'bul');
  assert.equal(klasseVon({ highway: 'primary', maxspeed: '50' }), 'ort');
  assert.equal(klasseVon({ highway: 'secondary', maxspeed: 'DE:urban' }), 'ort');
  assert.equal(klasseVon({ highway: 'secondary', 'zone:maxspeed': 'DE:urban' }), 'ort');
  assert.equal(klasseVon({ highway: 'secondary', maxspeed: '100' }), 'bul');
  assert.equal(klasseVon({ highway: 'residential' }), 'ort');
  assert.equal(klasseVon({ highway: 'unclassified' }), 'bul');
  assert.deepEqual(referenzen({ ref: 'B 28; B 27' }), ['B 28', 'B 27']);
});

test('Abfrage enthält den Umkreis und die Stützpunkte', () => {
  const q = abfrage(TRACK);
  assert.match(q, /around:30,48\.00000,8\.00000,48\.10000,8\.00000/);
  assert.match(q, /out tags geom/);
});

test('Profil: Autobahn dann Bundesstraße, Straßennummern je Abschnitt', () => {
  const arten = profil(AUTOBAHN_DANN_BUNDESSTRASSE);
  const gesamt = anteileImAbschnitt(arten, 0, LAENGE);
  assert.ok(Math.abs(gesamt.anteile.bab - MITTE) < 0.15, `bab ${gesamt.anteile.bab}`);
  assert.ok(Math.abs(gesamt.anteile.bul - MITTE) < 0.15, `bul ${gesamt.anteile.bul}`);
  assert.equal(gesamt.anteile.ort, 0);
  assert.equal(strasseImAbschnitt(arten, 0, MITTE - 0.5), 'A 8');
  assert.equal(strasseImAbschnitt(arten, MITTE + 0.5, LAENGE), 'B 28');
  assert.equal(strasseImAbschnitt(arten, 0, LAENGE), 'A 8 / B 28');
});

test('Anteile eines Teilabschnitts summieren sich zur Strecke', () => {
  const arten = profil(AUTOBAHN_DANN_BUNDESSTRASSE);
  const a = anteileImAbschnitt(arten, 2.03, 8.47).anteile;
  assert.ok(Math.abs(a.bab + a.bul + a.ort - (8.47 - 2.03)) < 1e-9);
  assert.equal(anteileImAbschnitt(arten, 3, 3).dominant, 'bul');
});

test('Ohne Straßen in der Nähe: unbekannt, Abschnitt zählt als Bundesstraße', () => {
  const arten = profil([]);
  const r = anteileImAbschnitt(arten, 0, 5);
  assert.equal(r.dominant, 'bul');
  assert.ok(Math.abs(r.unbekannt - 5) < 1e-9);
  assert.ok(Math.abs(r.anteile.bul - 5) < 1e-9);
  assert.equal(strasseImAbschnitt(arten, 0, 5), '');
});

test('Parallele Fahrbahn: bei fast gleichem Abstand gewinnt die Autobahn', () => {
  const arten = profil([
    weg({ highway: 'residential' }, [48.0, 8.00005], [48.1, 8.00005]),
    weg({ highway: 'motorway', ref: 'A 81' }, [48.0, 8.00007], [48.1, 8.00007])
  ]);
  assert.equal(anteileImAbschnitt(arten, 0, 5).dominant, 'bab');
});

test('Läufe für die Karte fassen gleiche Straßenart zusammen', () => {
  const l = klassenLaeufe(profil(AUTOBAHN_DANN_BUNDESSTRASSE), 0, LAENGE);
  assert.deepEqual(l.map(x => x.klasse), ['bab', 'bul']);
  assert.ok(Math.abs(l[0].bis - MITTE) < 0.15);
});

test('Fahrplan rechnet Abschnitte mit Straßenart „auto“ anteilig', () => {
  const arten = profil(AUTOBAHN_DANN_BUNDESSTRASSE);
  const p = {
    kopf: { ablaufzeit: '08:00' },
    parameter: { v: { bab: 60, bul: 50, ort: 30 }, abstand: { bab: 100, bul: 50, ort: 25 }, laengeEinzel: 7, laengeGespann: 15, halt: {} },
    kolonnen: [{ id: 'k', name: 'K1', einzel: 4, gespanne: 0, versatzMin: 0 }],
    route: {
      arten,
      kontrollpunkte: [
        { id: 'a', typ: 'ablauf', km: 0, klasse: 'bul' },
        { id: 'b', typ: 'ziel', km: LAENGE, klasse: 'auto', strasse: '' }
      ]
    }
  };
  const fp = fahrplan(p, p.kolonnen[0]);
  const leg = fp.zeilen[1].leg;
  const erwartet = MITTE / 60 * 60 + MITTE / 50 * 60;              // ≈ 12,2 min
  assert.ok(Math.abs(leg.fahrMin - Math.round(erwartet)) <= 1, `fahrMin ${leg.fahrMin}`);
  assert.equal(leg.auto, true);
  assert.equal(leg.strasse, 'A 8 / B 28');
  assert.ok(leg.v > 50 && leg.v < 60);
  assert.equal(leg.gemischt, true);
  // von Hand festgelegt: ganze Strecke als Bundesstraße
  p.route.kontrollpunkte[1].klasse = 'bul';
  assert.equal(fahrplan(p, p.kolonnen[0]).zeilen[1].leg.fahrMin, Math.round(LAENGE / 50 * 60));
  // ohne Profil fällt „auto“ auf Bundesstraße zurück
  p.route.kontrollpunkte[1].klasse = 'auto';
  delete p.route.arten;
  assert.equal(fahrplan(p, p.kolonnen[0]).zeilen[1].leg.auto, false);
});
