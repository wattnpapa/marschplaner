import { test } from 'node:test';
import assert from 'node:assert/strict';
import { neuesProjekt } from '../js/daten.js';
import { leseGpx } from '../js/gpx.js';
import { beispielFuellen } from '../js/beispiel.js';
import { BLAETTER, blattHtml } from '../js/blaetter.js';
import { kpHinzufuegen, kpEntfernen, kpAnTrackSetzen, trackKm, kpPosition } from '../js/route.js';
import { migrieren, setzePfad, lesePfad } from '../js/state.js';
import { fahrplan, haltKonflikte } from '../js/rechnen.js';

const beispiel = () => beispielFuellen(neuesProjekt(), leseGpx);

test('Beispielroute: Ablauf, Kontrollpunkte und Ziel mit Kilometern', () => {
  const p = beispiel();
  const kps = p.route.kontrollpunkte;
  assert.equal(kps.length, 4);
  assert.equal(kps[0].km, 0);
  assert.ok(Math.abs(kps[3].km - trackKm(p.route)) < 1e-9);
  assert.deepEqual(kps.map(k => k.ort), ['Rottenburg am Neckar', 'Tübingen', 'Waldenbuch', 'Stuttgart-Möhringen']);
  assert.ok(kps.every((k, i) => i === 0 || k.km > kps[i - 1].km));
  assert.ok(trackKm(p.route) > 30 && trackKm(p.route) < 45);   // Luftlinie, schematisch
});

test('Jedes Blatt rendert ohne undefined/NaN – gefüllt und leer', () => {
  for (const p of [beispiel(), neuesProjekt()]) {
    for (const b of BLAETTER) {
      const html = blattHtml(b.id, p);
      assert.match(html, /<section class="blatt /, b.id);
      assert.doesNotMatch(html, /undefined|NaN|\[object/, `${b.id}: ${html.match(/.{40}(undefined|NaN|\[object).{40}/)?.[0]}`);
    }
  }
});

test('Marschtabelle: ein Blatt je Kolonne, Uhrzeiten und Halt', () => {
  const p = beispiel();
  const html = blattHtml('marschtabelle', p);
  assert.equal((html.match(/data-blatt="marschtabelle"/g) || []).length, 2);
  assert.match(html, /08:00/);
  assert.match(html, /Halt 15 min/);
  assert.match(html, /Technischer Halt/);
});

test('Marschauftrag: leere Felder werden aus der Planung ergänzt', () => {
  const p = beispiel();
  const html = blattHtml('marschauftrag', p);
  assert.match(html, /Rottenburg am Neckar – Tübingen – Waldenbuch – Stuttgart-Möhringen/);
  assert.match(html, /08:00 Uhr/);
  assert.match(html, /50 m auf Bundes- und Landstraßen/);
  p.auftrag.a3a = 'Eigenes Ziel';
  assert.match(blattHtml('marschauftrag', p), /Eigenes Ziel/);
});

test('Halte beider Kolonnen werden auf Überschneidung geprüft', () => {
  const p = beispiel();
  p.kolonnen[1].versatzMin = 5;
  assert.equal(haltKonflikte(p).length, 1);
  assert.match(blattHtml('belegung', p), /überschneiden sich/);
  p.kolonnen[1].versatzMin = 90;
  assert.equal(haltKonflikte(p).length, 0);
});

test('Kontrollpunkt einfügen erbt die Straßenart des Abschnitts und bleibt sortiert', () => {
  const p = beispiel();
  const km = p.route.kontrollpunkte[2].km - 3;
  const kp = kpHinzufuegen(p, km, 'kp', { ort: 'Zwischenpunkt' });
  const kms = p.route.kontrollpunkte.map(k => k.km);
  assert.deepEqual(kms, [...kms].sort((a, b) => a - b));
  assert.equal(kp.klasse, 'bul');
  kpEntfernen(p, kp.id);
  assert.equal(p.route.kontrollpunkte.length, 4);
});

test('Kontrollpunkt an den Track setzen', () => {
  const p = beispiel();
  const mitte = kpPosition(p.route, { km: 20 });
  const kp = p.route.kontrollpunkte[1];
  kpAnTrackSetzen(p, kp.id, mitte);
  assert.ok(Math.abs(kp.km - 20) < 0.05);
});

test('Ohne Ablaufzeit bleibt die Tabelle lesbar', () => {
  const p = beispiel();
  p.kopf.ablaufzeit = '';
  const fp = fahrplan(p, p.kolonnen[0]);
  assert.equal(fp.ablaufFehlt, true);
  assert.doesNotMatch(blattHtml('marschtabelle', p), /NaN/);
});

test('HTML aus Eingaben wird maskiert', () => {
  const p = beispiel();
  p.kopf.kennung = '<img src=x onerror=alert(1)>';
  p.kolonnen[0].name = '"><script>x</script>';
  p.route.kontrollpunkte[1].ort = '<b>fett</b>';
  for (const b of BLAETTER) {
    const html = blattHtml(b.id, p);
    assert.doesNotMatch(html, /<script>|<img src=x|<b>fett/, b.id);
  }
});

test('Ältere/unvollständige Projekte werden mit Vorgaben aufgefüllt', () => {
  const m = migrieren({ id: 'x', name: 'Alt', kopf: { von: 'A' } });
  assert.equal(m.kopf.von, 'A');
  assert.equal(m.kopf.ablaufzeit, '08:00');
  assert.equal(m.parameter.v.bul, 50);
  assert.equal(m.kolonnen.length, 1);
  assert.ok(m.unterlagen.zeilen.length > 10);
});

test('Pfadzugriff über @id bleibt bei Umsortierung stabil', () => {
  const p = beispiel();
  const id = p.kolonnen[1].id;
  p.kolonnen.reverse();
  setzePfad(p, `kolonnen.@${id}.name`, 'Neu');
  assert.equal(lesePfad(p, `kolonnen.@${id}.name`), 'Neu');
  assert.equal(p.kolonnen.find(k => k.id === id).name, 'Neu');
});
