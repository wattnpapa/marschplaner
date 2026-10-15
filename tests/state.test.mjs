// Speicher: Laden ohne Verlust, Abgleich mehrerer Tabs, Papierkorb, Rückgängig je Planung

import { test } from 'node:test';
import assert from 'node:assert/strict';

/** Ein Browser-Speicher, den sich mehrere „Tabs“ (Modulinstanzen) teilen */
function speicher(start = {}) {
  const m = new Map(Object.entries(start));
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); },
    _m: m
  };
}

let zaehler = 0;
async function tab(ls) {
  globalThis.localStorage = ls;
  const modul = await import(`../js/state.js?tab=${++zaehler}`);
  await warte(400);                    // das Anlegen der ersten Planung speichert verzögert – in den richtigen Speicher
  return modul;
}
function warte(ms) { return new Promise(r => setTimeout(r, ms)); }

test('unlesbarer Speicher: Rohtext bleibt erhalten, nichts wird still überschrieben', async () => {
  const ls = speicher({ 'mp.projekte.v1': '{kaputt' });
  const s = await tab(ls);
  assert.equal(s.liste().length, 1, 'eine leere Planung zum Weiterarbeiten');
  const problem = s.ladeProbleme();
  assert.ok(problem);
  assert.equal(problem.text, '{kaputt');
  s.aendern(p => { p.name = 'Neu'; });
  await warte(400);
  assert.notEqual(ls.getItem('mp.projekte.v1'), '{kaputt');
  assert.equal(ls.getItem(problem.schluessel), '{kaputt', 'die Rohsicherung bleibt liegen');
});

test('eine defekte Planung reißt die anderen nicht mit', async () => {
  const eine = await tab(speicher());
  const gut = JSON.parse(JSON.stringify(eine.aktuell()));
  const schlecht = { ...gut, id: 'mp_schlecht', route: 'kaputt' };
  const ls = speicher({ 'mp.projekte.v1': JSON.stringify({ [gut.id]: gut, mp_schlecht: schlecht }) });
  const s = await tab(ls);
  assert.deepEqual(s.liste().map(x => x.id), [gut.id]);
  assert.equal(s.ladeProbleme().anzahl, 1);
  assert.ok([...ls._m.keys()].some(k => k.startsWith('mp.projekte.defekt.v1')));
});

test('zwei Tabs überschreiben sich nicht gegenseitig', async () => {
  const ls = speicher();
  const a = await tab(ls);
  a.aendern(p => { p.name = 'Marsch Nord'; });
  await warte(400);
  const b = await tab(ls);
  assert.equal(b.aktuell().name, 'Marsch Nord');
  // A ändert, B legt eine weitere Planung an – beide Stände müssen am Ende im Speicher stehen
  a.aendern(p => { p.name = 'Marsch Nord 2'; });
  await warte(400);
  b.neu('Zweite Planung');
  await warte(400);
  const roh = JSON.parse(ls.getItem('mp.projekte.v1'));
  const namen = Object.values(roh).map(p => p.name).sort();
  assert.deepEqual(namen, ['Marsch Nord 2', 'Zweite Planung']);
});

test('gelöschte Planung liegt im Papierkorb und lässt sich zurückholen', async () => {
  const s = await tab(speicher());
  const erste = s.aktuell().id;
  s.aendern(p => { p.name = 'Wichtig'; p.route.kontrollpunkte.push({ id: 'x', typ: 'kp', km: 1 }); });
  s.neu('Andere');
  s.loeschen(erste);
  assert.equal(s.liste().some(x => x.id === erste), false);
  const korb = s.papierkorbListe();
  assert.equal(korb[0].name, 'Wichtig');
  assert.equal(korb[0].punkte, 1);
  const zurueck = s.wiederherstellen(erste);
  assert.equal(zurueck.name, 'Wichtig');
  assert.equal(s.papierkorbListe().length, 0);
});

test('Rückgängig bleibt bei seiner Planung, auch nach dem Wechsel', async () => {
  const s = await tab(speicher());
  const erste = s.aktuell().id;
  s.aendern(p => { p.name = 'A'; }, null, 'Name geändert');
  s.neu('B');
  assert.equal(s.kannRueckgaengig(), false);
  s.oeffnen(erste);
  assert.equal(s.kannRueckgaengig(), true);
  assert.equal(s.rueckgaengigText(), 'Name geändert');
  s.rueckgaengig();
  assert.notEqual(s.aktuell().name, 'A');
  assert.equal(s.wiederholenText(), 'Name geändert');
});

test('beschädigte Planungsdatei wird abgelehnt, die aktuelle Planung bleibt', async () => {
  const s = await tab(speicher());
  const vorher = s.liste().length;
  const datei = JSON.stringify({ app: 'marschplaner', schema: 1, projekt: { name: 'x', route: 'kaputt' } });
  assert.throws(() => s.ausJson(datei), /beschädigt/);
  assert.equal(s.liste().length, vorher);
  const gut = JSON.parse(s.alsJson());
  assert.doesNotThrow(() => s.ausJson(JSON.stringify(gut)));
  assert.equal(s.liste().length, vorher + 1);
});

test('Dateisicherung wird mit Zeit vermerkt', async () => {
  const s = await tab(speicher());
  assert.equal(s.gesichertAm(), null);
  s.gesichertMarkieren();
  assert.match(s.gesichertAm(), /^\d{4}-\d\d-\d\dT/);
});
