import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  abfrage, normalisiere, umwegKm, vorschlagen, sucheEntlang, offeneStuecke, passtZu, zeitBeiKm, kmBeiZeit, uhrBeiKm
} from '../js/plaetze.js';
import { kpAusPlatz, kpZuPlatz, kpEntfernen, handArten, artenUebernehmen } from '../js/route.js';
import { fahrplan } from '../js/rechnen.js';
import { trackLaengeM } from '../js/geo.js';

const KM = 111.195;                                   // km je Breitengrad
const lat = km => 48 + km / KM;
const seitlich = m => m / (111195 * Math.cos(48 * Math.PI / 180));     // Grad Länge für m Meter
const TRACK = [[lat(0), 8.0], [lat(60), 8.0]];
const LAENGE = trackLaengeM(TRACK) / 1000;

const knoten = (id, km, tags, abstandM = 0) => ({ type: 'node', id, lat: lat(km), lon: 8.0 + seitlich(abstandM), tags });

const ELEMENTE = [
  knoten(1, 29, { highway: 'rest_area', name: 'Rastplatz Ost', toilets: 'yes' }, 100),
  knoten(2, 31, { amenity: 'parking', capacity: '50', name: 'P Messe' }, 40),
  knoten(3, 30, { amenity: 'fuel', brand: 'Aral' }, 900),
  knoten(4, 45, { highway: 'rest_area', name: 'Weit weg' }, 50),
  knoten(5, 30, { highway: 'rest_area', capacity: '5', name: 'Winzig' }, 50),
  knoten(6, 30, { shop: 'bakery' }, 10),                                  // keine Platzart
  { type: 'way', id: 7, center: { lat: lat(33), lon: 8.0 + seitlich(60) }, tags: { amenity: 'parking', hgv: 'yes', capacity: '80' } },
  knoten(8, 30, { highway: 'rest_area', name: 'Zu weit' }, 5000)
];

function projekt() {
  return {
    kopf: { ablaufzeit: '08:00' },
    parameter: { v: { bab: 60, bul: 60, ort: 30 }, abstand: { bab: 100, bul: 50, ort: 25 }, laengeEinzel: 7, laengeGespann: 15, halt: {} },
    kolonnen: [{ id: 'k', name: 'K1', einzel: 10, gespanne: 0, versatzMin: 0 }],
    route: { track: TRACK, kontrollpunkte: [{ id: 'a', typ: 'ablauf', km: 0, klasse: 'bul' }, { id: 'b', typ: 'ziel', km: LAENGE, klasse: 'bul' }] }
  };
}

test('Abfrage: Umkreis, Plätze und Filter für Privatparkplätze', () => {
  const q = abfrage(TRACK, 1500);
  assert.match(q, /around:1500,48\.00000,8\.00000,/);
  assert.match(q, /rest_area\|services/);
  assert.match(q, /amenity"="fuel"/);
  assert.match(q, /access"!~"\^\(private\|customers/);
  assert.match(q, /out tags center/);
});

test('Normalisieren: Art, Kilometerstand, Abstand; Fremdes und Zu-Weites fliegt raus', () => {
  const p = normalisiere(ELEMENTE, TRACK, 1000);
  assert.deepEqual(p.map(x => x.id).sort(), ['n1', 'n2', 'n3', 'n4', 'n5', 'w7']);
  const rast = p.find(x => x.id === 'n1');
  assert.equal(rast.art, 'rast');
  assert.ok(Math.abs(rast.km - 29) < 0.05);
  assert.ok(Math.abs(rast.abstandM - 100) < 5);
  assert.equal(rast.wc, true);
  assert.equal(p.find(x => x.id === 'n3').name, 'Aral');
  assert.equal(p.find(x => x.id === 'w7').lkw, true);        // Mittelpunkt von Flächen wird genutzt
  assert.equal(p.find(x => x.id === 'n2').kapazitaet, 50);
});

test('Umweg: Hin und zurück mit Faktor 1,3, unter 50 m kein Umweg', () => {
  assert.equal(umwegKm(0), 0);
  assert.equal(umwegKm(40), 0);
  assert.equal(umwegKm(500), 1.3);
  assert.equal(umwegKm(1000), 2.6);
});

test('Zeit und Kilometer lassen sich ineinander umrechnen', () => {
  const fp = fahrplan(projekt(), projekt().kolonnen[0]);
  assert.ok(Math.abs(zeitBeiKm(fp, 30) - 30) < 0.6);         // 60 km/h → 1 km pro min
  assert.ok(Math.abs(kmBeiZeit(fp, 30) - 30) < 0.6);
  assert.equal(zeitBeiKm(fp, -5), 0);
});

test('Vorschlag: bester Platz im Zeitfenster, zu kleine und zu ferne fallen weg', () => {
  const p = projekt();
  const liste = normalisiere(ELEMENTE, TRACK, 1000);
  const v = vorschlagen(p, liste, { intervallMin: 30, fensterMin: 10, radiusM: 1000, kapMin: 20 });
  assert.equal(v.length, 1);                                  // nur Pause bei 30 min; die bei 60 min liegt am Ziel
  assert.ok(Math.abs(v[0].km - 30) < 0.6);
  const ids = v[0].kandidaten.map(k => k.id);
  assert.ok(!ids.includes('n4'), 'außerhalb des Fensters');
  assert.ok(!ids.includes('n5'), 'Kapazität zu klein');
  assert.equal(v[0].bester.id, 'n1');                         // Rastplatz mit WC schlägt Parkplatz und Tankstelle
  assert.equal(v[0].bester.umwegKm, 0.3);                     // 100 m neben der Strecke → 0,3 km
  assert.ok(v[0].kandidaten[0].punkte >= v[0].kandidaten[1].punkte);
  // nur Tankstellen gewünscht
  const t = vorschlagen(p, liste, { intervallMin: 30, fensterMin: 10, radiusM: 1000, arten: ['tank'] });
  assert.deepEqual(t[0].kandidaten.map(k => k.id), ['n3']);
});

test('Ohne Route oder Intervall gibt es keine Vorschläge', () => {
  const p = projekt();
  assert.deepEqual(vorschlagen(p, [], { intervallMin: 0 }), []);
  p.route.kontrollpunkte = [];
  assert.deepEqual(vorschlagen(p, ELEMENTE, {}), []);
});

/* ---- Suche in Stücken, Fortsetzen nach Ausfall ---- */

function mitFetch(verhalten, fn) {
  const alt = globalThis.fetch;
  const aufrufe = [];
  globalThis.fetch = async () => verhalten(aufrufe.push(1) - 1);
  return fn(aufrufe).finally(() => { globalThis.fetch = alt; });
}
const antwort = (elements) => ({ ok: true, status: 200, text: async () => JSON.stringify({ elements }) });
const abgelehnt = () => ({ ok: false, status: 504, text: async () => '' });

test('Suche: ausgefallenes Stück bleibt offen, der zweite Lauf holt nur dieses nach', async () => {
  const lang = [[lat(0), 8.0], [lat(25), 8.0]];
  const erster = await mitFetch(
    (nr) => (nr === 0 || nr >= 3 ? antwort(ELEMENTE.slice(0, 2)) : abgelehnt()),
    () => sucheEntlang(lang, 1000, { versuche: 2, tempo: 0 })
  );
  assert.deepEqual(erster.fertig, [true, false, true]);
  assert.equal(offeneStuecke(erster), 1);
  assert.ok(passtZu(erster, trackLaengeM(lang) / 1000, 800));
  assert.equal(passtZu(erster, trackLaengeM(lang) / 1000, 2000), false);     // größerer Radius → neu suchen

  const zweiter = await mitFetch(() => antwort([]), async (aufrufe) => {
    const r = await sucheEntlang(lang, 1000, { vorhanden: erster, versuche: 2, tempo: 0 });
    assert.equal(aufrufe.length, 1);
    return r;
  });
  assert.equal(offeneStuecke(zweiter), 0);
  assert.equal(zweiter.liste.length, erster.liste.length);                     // nichts doppelt
});

/* ---- Uhrzeit mit Halten, Übernahme, Abbruch ---- */

test('Uhrzeit bei km enthält die Halte davor (nicht nur Fahrzeit)', () => {
  const p = projekt();
  const ohne = fahrplan(p, p.kolonnen[0]);
  const mitte = LAENGE / 2;
  const vorher = uhrBeiKm(ohne, mitte);
  assert.equal(vorher, ohne.start + zeitBeiKm(ohne, mitte));
  p.route.kontrollpunkte.push({ id: 'r', typ: 'rast', km: LAENGE / 4, klasse: 'bul', halt: 30 });
  const mit = fahrplan(p, p.kolonnen[0]);
  assert.equal(uhrBeiKm(mit, mitte), vorher + 30);
  assert.equal(uhrBeiKm(mit, LAENGE / 8), uhrBeiKm(ohne, LAENGE / 8), 'vor dem Halt ändert sich nichts');
});

test('Platz übernehmen merkt sich die Herkunft; zweite Übernahme lässt sich erkennen', () => {
  const p = projekt();
  const platz = normalisiere(ELEMENTE, TRACK, 1000).find(x => x.id === 'n1');
  assert.equal(kpZuPlatz(p, 'n1'), null);
  const kp = kpAusPlatz(p, platz, 'rast');
  assert.equal(kp.platzId, 'n1');
  assert.equal(kpZuPlatz(p, 'n1').id, kp.id);
});

test('Ablauf- oder Zielpunkt entfernen: der nächste Punkt übernimmt die Rolle', () => {
  const p = projekt();
  p.route.kontrollpunkte.push({ id: 'm', typ: 'kp', km: 20, klasse: 'bul' });
  kpEntfernen(p, 'a');
  assert.equal(p.route.kontrollpunkte.find(k => k.id === 'm').typ, 'ablauf');
  kpEntfernen(p, 'b');
  assert.equal(p.route.kontrollpunkte.find(k => k.id === 'm').typ, 'ablauf', 'einziger Punkt bleibt Ablauf');
});

test('Von Hand gesetzte Straßenarten lassen sich beim Übernehmen des OSM-Profils behalten', () => {
  const p = projekt();
  p.route.kontrollpunkte.splice(1, 0, { id: 'x', typ: 'kp', km: 20, klasse: 'bab' });
  assert.equal(handArten(p), 1);
  artenUebernehmen(p, { k: '', fertig: [] }, { handBehalten: true });
  assert.equal(p.route.kontrollpunkte.find(k => k.id === 'x').klasse, 'bab');
  assert.equal(p.route.kontrollpunkte.find(k => k.id === 'b').klasse, 'auto');
  artenUebernehmen(p, { k: '', fertig: [] });
  assert.equal(p.route.kontrollpunkte.find(k => k.id === 'x').klasse, 'auto');
});

test('Suche: Abbruch beendet den Lauf sofort, ohne weitere Anfragen', async () => {
  const lang = [[lat(0), 8.0], [lat(25), 8.0]];
  const steuerung = new AbortController();
  steuerung.abort();
  await mitFetch(() => antwort([]), async (aufrufe) => {
    await assert.rejects(sucheEntlang(lang, 1000, { versuche: 2, tempo: 0, signal: steuerung.signal }), { name: 'Abbruch' });
    assert.equal(aufrufe.length, 0);
  });
});

test('Suche: Abbruch aus dem Stück-Rückruf (Planung gewechselt) zählt nicht als Stückfehler', async () => {
  const lang = [[lat(0), 8.0], [lat(25), 8.0]];
  await mitFetch(() => antwort(ELEMENTE.slice(0, 2)), async (aufrufe) => {
    const fehler = Object.assign(new Error('Planung gewechselt'), { name: 'Abbruch' });
    await assert.rejects(
      sucheEntlang(lang, 1000, { versuche: 2, tempo: 0, beiStueck: () => { throw fehler; } }),
      { name: 'Abbruch' }
    );
    assert.equal(aufrufe.length, 1, 'die übrigen Stücke werden nicht mehr abgefragt');
  });
});
