import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analysiere, offeneStuecke, passtZu, leereArten, abfrage, klasseVon, referenzen, abtasten, baueArten, anteileImAbschnitt, strasseImAbschnitt, klassenLaeufe
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

/* ---- Fortsetzen nach Timeout: schon Abgefragtes wird nicht noch einmal angefragt ---- */

// 25 km nach Norden → drei Stücke (10 + 10 + 5 km)
const LANG = [[48.0, 8.0], [48.225, 8.0]];
const A8 = { type: 'way', tags: { highway: 'motorway', ref: 'A 8' }, geometry: [{ lat: 47.99, lon: 8.0001 }, { lat: 48.24, lon: 8.0001 }] };

function mitFetch(verhalten, fn) {
  const alt = globalThis.fetch;
  const aufrufe = [];
  globalThis.fetch = async (url, opt) => {
    const nr = aufrufe.push(decodeURIComponent(String(opt.body))) - 1;
    return verhalten(nr);
  };
  return fn(aufrufe).finally(() => { globalThis.fetch = alt; });
}
const antwort = (elements) => ({ ok: true, status: 200, text: async () => JSON.stringify({ elements }) });
const abgelehnt = () => ({ ok: false, status: 504, text: async () => '' });

test('Timeout mitten drin: fertige Stücke bleiben, der nächste Lauf holt nur die Lücke', async () => {
  const gesichert = [];
  // Lauf 1: Stück 0 klappt, Stück 1 scheitert (alle Versuche), Stück 2 klappt
  const erster = await mitFetch(
    (nr) => (nr === 0 || nr >= 3 ? antwort([A8]) : abgelehnt()),            // Aufruf 1–2 = Stück 1 (2 Versuche)
    () => analysiere(LANG, { versuche: 2, tempo: 0, beiStueck: a => gesichert.push(structuredClone(a)) })
  );
  assert.deepEqual(erster.fertig, [true, false, true]);
  assert.equal(erster.luecken, 1);
  assert.equal(offeneStuecke(erster), 1);
  assert.equal(gesichert.length, 2);                       // nach jedem fertigen Stück gesichert
  assert.ok(passtZu(erster, trackLaengeM(LANG) / 1000));
  assert.equal(anteileImAbschnitt(erster, 0, 9).anteile.bab > 8.9, true);

  // Lauf 2 mit dem gespeicherten Stand: genau EINE Anfrage, nur für das fehlende Stück
  const zweiter = await mitFetch(() => antwort([A8]), async (aufrufe) => {
    const r = await analysiere(LANG, { vorhanden: erster, versuche: 2, tempo: 0 });
    assert.equal(aufrufe.length, 1);
    return r;
  });
  assert.deepEqual(zweiter.fertig, [true, true, true]);
  assert.equal(zweiter.luecken, 0);
  assert.ok(Math.abs(anteileImAbschnitt(zweiter, 0, 24.9).anteile.bab - 24.9) < 0.2);
});

test('Ist alles fertig, wird nichts mehr angefragt; ein anderer Track beginnt neu', async () => {
  const fertig = await mitFetch(() => antwort([A8]), () => analysiere(LANG, { versuche: 1, tempo: 0 }));
  await mitFetch(() => antwort([A8]), async (aufrufe) => {
    await analysiere(LANG, { vorhanden: fertig, versuche: 1, tempo: 0 });
    assert.equal(aufrufe.length, 0);
  });
  const kuerzer = [[48.0, 8.0], [48.12, 8.0]];
  assert.equal(passtZu(fertig, trackLaengeM(kuerzer) / 1000), false);
});

test('Scheitern alle Stücke, wird der Fehler gemeldet; Teilerfolg nicht', async () => {
  await assert.rejects(
    mitFetch(() => abgelehnt(), () => analysiere(LANG, { versuche: 1, tempo: 0 })),
    /504/
  );
  assert.equal(offeneStuecke(leereArten(25)), 3);
});
