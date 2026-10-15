import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  marschlaenge, durchlaufSek, wegZeitMin, zeitParse, zeitText, fahrplan, belegung,
  haltKonflikte, durchlaufTabelle, wegZeitTabelle, marschHilfe, fahrzeitBei, zahl
} from '../js/rechnen.js';

/* Stichproben aus der Excel-Vorlage, Blatt "Marschlänge Durchlaufzeit":
   Anzahl Fahrzeuge → Marschlänge (m) / Durchlaufzeit (s) bei 40 und 70 km/h. */
const VORLAGE = [
  [3, 61, 5, 91, 5], [4, 88, 8, 133, 7], [10, 250, 23, 385, 20],
  [17, 439, 40, 679, 35], [25, 655, 59, 1015, 52], [30, 790, 71, 1225, 63]
];

test('Marschlänge/Durchlaufzeit reproduziert die Vorlagentabelle', () => {
  const t = durchlaufTabelle();
  for (const [n, lA, sA, lB, sB] of VORLAGE) {
    const z = t.zeilen.find(r => r.n === n);
    assert.equal(z.a.laengeM, lA, `Länge ${n} Fz @40`);
    assert.equal(Math.round(z.a.sek), sA, `Zeit ${n} Fz @40`);
    assert.equal(z.b.laengeM, lB, `Länge ${n} Fz @70`);
    assert.equal(Math.round(z.b.sek), sB, `Zeit ${n} Fz @70`);
  }
});

test('Weg-Zeit-Tabelle: km / v · 60', () => {
  assert.equal(wegZeitMin(1, 10), 6);
  assert.equal(wegZeitMin(1, 25), 2.4);
  assert.equal(wegZeitMin(200, 60), 200);
  const t = wegZeitTabelle({ bisKm: 3 });
  assert.equal(t.zeilen.length, 3);
  assert.equal(t.zeilen[2].min[2], 9);               // 3 km bei 20 km/h
});

test('Marschlänge der Hilfestellung: Fahrzeuge plus Abstände', () => {
  // 5 Einzel-KFZ à 7 m, 7 Gespanne à 15 m, 11 Lücken à 25 m → 35 + 105 + 275
  assert.equal(marschlaenge({ einzel: 5, gespanne: 7, laengeEinzel: 7, laengeGespann: 15, abstand: 25 }), 415);
  assert.equal(marschlaenge({}), 0);
  assert.equal(marschlaenge({ einzel: 1, laengeEinzel: 7, abstand: 100 }), 7);   // eine Lücke weniger als Fahrzeuge
});

test('Kolonnenabstand zählt zwischen Kolonnen, nicht davor', () => {
  const a = { einzel: 2, laengeEinzel: 7, abstand: 0, kolonnenabstand: 50 };
  assert.equal(marschlaenge({ ...a, kolonnen: 1 }), 14);
  assert.equal(marschlaenge({ ...a, kolonnen: 3 }), 114);
});

test('Durchlaufzeit rechnet in m/s: Länge / (v/3,6)', () => {
  // Die Vorlage "Hilfestellung" teilt Meter durch km/h und beschriftet das mit min –
  // das ist um den Faktor ≈ 17 zu groß. 415 m bei 52 km/h sind rund 29 s.
  assert.ok(Math.abs(durchlaufSek(415, 52) - 28.73) < 0.01);
  assert.equal(durchlaufSek(415, 0), 0);
});

test('marschHilfe: leere Pflichtfelder ergeben null statt Fehler', () => {
  const r = marschHilfe({});
  assert.deepEqual(r, { laengeM: null, marschzeitMin: null, durchlaufSek: null });
  const s = marschHilfe({ einzel: 5, gespanne: 7, v: 52, km: 100, unterbrechung: 30,
    laengeEinzel: 7, laengeGespann: 15, abstand: 25 });
  assert.equal(s.laengeM, 415);
  assert.equal(s.marschzeitMin, Math.round(100 * 60 / 52 + 30));
});

test('Uhrzeiten', () => {
  assert.equal(zeitParse('08:15'), 495);
  assert.equal(zeitParse('8.05'), 485);
  assert.equal(zeitParse('25:00'), null);
  assert.equal(zeitParse(''), null);
  assert.equal(zeitText(495), '08:15');
  assert.equal(zeitText(1440 + 30), '00:30 +1');
  assert.equal(zahl(2.4), '2,4');
  assert.equal(zahl(6), '6');
});

function projekt(extra = {}) {
  return {
    kopf: { ablaufzeit: '08:00' },
    parameter: {
      v: { bab: 60, bul: 50, ort: 30 },
      abstand: { bab: 100, bul: 50, ort: 25 },
      laengeEinzel: 7, laengeGespann: 15,
      halt: { th: 10, rast: 30, tank: 20 }
    },
    kolonnen: [
      { id: 'k1', name: 'Kolonne 1', einzel: 4, gespanne: 0, versatzMin: 0 },
      { id: 'k2', name: 'Kolonne 2', einzel: 4, gespanne: 0, versatzMin: 10 }
    ],
    route: {
      kontrollpunkte: [
        { id: 'a', typ: 'ablauf', ort: 'Start', km: 0, klasse: 'bul' },
        { id: 'b', typ: 'th', ort: 'Mitte', km: 50, klasse: 'bab', halt: null },
        { id: 'c', typ: 'ziel', ort: 'Ziel', km: 80, klasse: 'bul' }
      ]
    },
    ...extra
  };
}

test('Fahrplan: Zeiten, Halte und Uhrzeiten', () => {
  const p = projekt();
  const fp = fahrplan(p, p.kolonnen[0]);
  const [a, b, c] = fp.zeilen;
  assert.equal(a.an, 480);
  assert.ok(Math.abs(b.an - (480 + 50 / 60 * 60)) < 1e-9);       // 50 km @ 60 km/h = 50 min
  assert.equal(b.halt, 10);
  assert.equal(b.ab - b.an, 10);
  assert.ok(Math.abs(c.an - (b.ab + 30 / 50 * 60)) < 1e-9);      // 30 km @ 50 km/h = 36 min
  assert.equal(fp.kmGesamt, 80);
  assert.equal(c.zeitGesamt, 50 + 10 + 36);
  // Marschlänge der Kolonne auf BAB: 4 × 7 m + 3 × 100 m
  assert.equal(b.leg.laengeM, 328);
});

test('Versatz verschiebt die ganze Kolonne', () => {
  const p = projekt();
  const f1 = fahrplan(p, p.kolonnen[0]), f2 = fahrplan(p, p.kolonnen[1]);
  f1.zeilen.forEach((z, i) => assert.equal(f2.zeilen[i].an - z.an, 10));
});

test('Fahrzeit bei Uhrzeit zählt Halte nicht mit', () => {
  const p = projekt();
  const fp = fahrplan(p, p.kolonnen[0]);
  const halt = fp.zeilen[1];
  assert.ok(Math.abs(fahrzeitBei(fp, halt.an) - 50) < 1e-9);
  assert.ok(Math.abs(fahrzeitBei(fp, halt.ab) - 50) < 1e-9);       // im Halt keine Fahrzeit
  assert.equal(fahrzeitBei(fp, 0), 0);
});

test('Halt-Konflikt: zwei Kolonnen stehen zugleich am selben TH', () => {
  const p = projekt();
  // Kolonne 2 kommt 10 min später; TH dauert 10 min plus Durchlaufzeit → Überschneidung
  const k = haltKonflikte(p);
  assert.equal(k.length, 1);
  assert.equal(k[0].kp.id, 'b');
  // Mit 60 min Versatz gibt es keinen Konflikt mehr
  p.kolonnen[1].versatzMin = 60;
  assert.equal(haltKonflikte(p).length, 0);
});

test('Belegung: gemeinsame Zeitachse', () => {
  const p = projekt();
  const b = belegung(p);
  assert.equal(b.von, 480);
  assert.ok(b.bis > 480 + 96);
  assert.equal(b.plaene.length, 2);
});

test('Ohne Ablaufzeit wird gewarnt, nicht gerechnet', () => {
  const p = projekt();
  p.kopf.ablaufzeit = '';
  assert.equal(fahrplan(p, p.kolonnen[0]).ablaufFehlt, true);
});

test('Fehlende Geschwindigkeit wird gemeldet statt NaN', () => {
  const p = projekt();
  p.parameter.v.bab = 0;
  const fp = fahrplan(p, p.kolonnen[0]);
  assert.equal(fp.hinweise.length, 1);
  assert.ok(Number.isFinite(fp.zeilen[1].an));
});

test('Umweg zu einem Platz abseits: Zufahrt im Abschnitt davor, Rückfahrt im Abschnitt danach', () => {
  const p = projekt();
  p.route.kontrollpunkte[1].umwegKm = 2;                          // 1 km hin, 1 km zurück
  const fp = fahrplan(p, p.kolonnen[0]);
  const [, b, c] = fp.zeilen;
  assert.equal(b.leg.umwegKm, 1);
  assert.equal(b.leg.strecke, 51);                               // 50 km Strecke + 1 km Zufahrt
  assert.equal(b.leg.fahrMin, 52);                               // 50 min auf der BAB + 2 min innerorts (30 km/h)
  assert.equal(c.leg.strecke, 31);                               // 30 km + 1 km Rückfahrt
  assert.equal(c.leg.fahrMin, 38);
  assert.equal(c.km, 82);                                        // Kilometeranzeige enthält beide Umwegteile
  assert.equal(fp.kmGesamt, 82);
});
