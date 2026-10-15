// app.js – Oberfläche: Ansichten, Vorschau, Projektverwaltung
//
// Aufbau: links die Arbeitsschritte, in der Mitte das Formular des gewählten
// Schritts, rechts die Vorschau des passenden Blatts. Das Formular wird nur bei
// Struktur-Änderungen neu aufgebaut (Punkt anlegen, Kolonne löschen …) – beim
// Tippen ändert sich allein der Speicher und die Vorschau; so bleibt der Cursor
// im Feld. Abgeleitete Werte im Formular (Uhrzeiten, Marschlänge …) schreibt
// `abgeleitetAktualisieren()` an Ort und Stelle fort.

import * as store from './state.js';
import { e } from './html.js';
import { BLAETTER, blattHtml } from './blaetter.js';
import {
  KLASSEN, PUNKTTYPEN, zahl, zeitText, zeitParse, dauerText, sekundenText,
  sortierteKp, fahrplan, haltKonflikte, kolonnenLaenge, marschHilfe, durchlaufMin, TYP_NAME
} from './rechnen.js';
import {
  AUFTRAG_ABSCHNITTE, AUFTRAG_AUTO, autoAuftrag, UNTERLAGEN_ROLLEN, UNTERLAGEN_STANDARD,
  HINWEIS_VORLAGE, neueKolonne, neueId
} from './daten.js';
import { leseGpx, schreibeGpx } from './gpx.js';
import {
  routeAusGpx, artenUebernehmen, kpAusPlatz, kpHinzufuegen, kpEntfernen, kpOrdnen, kpAnTrackSetzen, trackKm, kpPosition, routeLoeschen,
  handArten, kpZuPlatz
} from './route.js';
import { punktBeiKm } from './geo.js';
import { karteErzeugen } from './karte.js';
import { drucken, pdfName, ohneKarte } from './druck.js';
import { beispielFuellen } from './beispiel.js';
import { analysiere, anteileImAbschnitt, offeneStuecke, passtZu, abbruchFehler, schlafen, fehlerText, zeitgrenze } from './strassenart.js';
import { sucheEntlang, vorschlagen, uhrBeiKm, umwegKm, ART_NAME, offeneStuecke as offenePlaetze, passtZu as plaetzePassen } from './plaetze.js';

const $ = (sel) => document.querySelector(sel);
const editor = $('#editor');
const nav = $('#nav');
const flaeche = $('#flaeche');
let navTimer = 0;

/* ---------- kleine Helfer ---------- */

function merken(key, wert) { try { localStorage.setItem(key, wert); } catch { /* ohne Speicher eben nicht */ } }
function erinnern(key) { try { return localStorage.getItem(key); } catch { return null; } }
function vergessen(key) { try { localStorage.removeItem(key); } catch { /* nichts zu vergessen */ } }

let toastTimer = null;
/** Kurze Meldung unten; mit `aktion` ({ text, fn }) bekommt sie einen Knopf, z. B. „Rückgängig“ */
function meldung(text, art = '', dauerhaft = false, aktion = null) {
  const t = $('#toast');
  t.textContent = text;
  if (aktion) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toast-knopf';
    b.textContent = aktion.text;
    b.addEventListener('click', () => { t.className = 'toast'; aktion.fn(); });
    t.append(' ', b);
  }
  t.className = `toast sichtbar ${art}${aktion ? ' mit-aktion' : ''}`;
  clearTimeout(toastTimer);
  if (dauerhaft) return;
  toastTimer = setTimeout(() => { t.className = 'toast'; }, art === 'fehler' || aktion ? 9000 : 3200);
}

const rueckgaengigAktion = { text: 'Rückgängig', fn: () => store.rueckgaengig() };

function feld(label, pfad, p, opt = {}) {
  const wert = store.lesePfad(p, pfad) ?? '';
  const typ = opt.typ || 'text';
  const attr = `data-p="${e(pfad)}" data-typ="${typ === 'number' ? 'zahl' : typ}"`;
  let eingabe;
  if (opt.mehrzeilig) {
    eingabe = `<textarea ${attr} rows="${opt.zeilen || 3}" placeholder="${e(opt.platzhalter || '')}">${e(wert)}</textarea>`;
  } else {
    const extra = [
      opt.min !== undefined ? `min="${opt.min}"` : '',
      opt.max !== undefined ? `max="${opt.max}"` : '',
      typ === 'number' ? `step="${opt.schritt || 'any'}" inputmode="decimal"` : '',
      opt.platzhalter ? `placeholder="${e(opt.platzhalter)}"` : ''
    ].join(' ');
    eingabe = `<input ${attr} type="${typ}" value="${e(wert)}" ${extra} autocomplete="off">`;
  }
  return `<label class="feld ${opt.klasse || ''} ${opt.einheit ? 'mit-einheit' : ''}">
    <span class="feld-name">${e(label)}</span>${eingabe}${opt.einheit ? `<span class="einheit">${e(opt.einheit)}</span>` : ''}
    ${opt.hinweis ? `<small class="hinweis">${e(opt.hinweis)}</small>` : ''}${opt.zusatz || ''}</label>`;
}

function download(name, inhalt, typ) {
  const url = URL.createObjectURL(new Blob([inhalt], { type: typ }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ---------- Prüfung ---------- */

function pruefung(p) {
  const m = [];
  const kps = sortierteKp(p.route);
  if (kps.length < 2) m.push({ stufe: 'fehler', text: 'Es ist noch keine Route angelegt (mindestens Ablauf- und Zielpunkt).', ansicht: 'route' });
  if (zeitParse(p.kopf.ablaufzeit) === null) m.push({ stufe: 'fehler', text: 'Die Ablaufzeit fehlt oder ist ungültig.', ansicht: 'eckdaten' });
  if (zeitParse(p.kopf.ablaufzeit) !== null && !p.kopf.datum) m.push({ stufe: 'warnung', text: 'Das Datum des Marschbeginns fehlt.', ansicht: 'eckdaten' });
  if (store.speicherProbleme()) m.push({ stufe: 'fehler', text: 'Der Browser kann nicht speichern. Planung bitte über „Planungen → Als Datei sichern“ aufheben.', ansicht: null });
  KLASSEN.forEach(k => {
    const v = +p.parameter.v[k.id];
    if (!(v >= 1 && v <= 130)) m.push({ stufe: 'warnung', text: `Marschgeschwindigkeit ${k.kurz}: ${Number.isFinite(v) ? zahl(v, 1) : '–'} km/h ist nicht plausibel (1 bis 130).`, ansicht: 'eckdaten' });
  });
  if (kps.length >= 2 && p.route.track.length > 1 && !p.route.arten) {
    m.push({ stufe: 'warnung', text: 'Die Straßenarten sind nicht ermittelt: Es gilt die eingetragene Straßenart (Vorgabe Bundes-/Landstraße), Fahrzeiten können abweichen.', ansicht: 'route' });
  }
  kps.forEach((k, i) => {
    if (k.halt !== null && k.halt !== undefined && k.halt !== '' && !(+k.halt >= 0 && +k.halt <= 600)) {
      m.push({ stufe: 'warnung', text: `Kontrollpunkt ${i + 1}: Halt von ${zahl(+k.halt, 0)} min ist nicht plausibel (0 bis 600).`, ansicht: 'route' });
    }
  });
  p.kolonnen.forEach(k => {
    if (!((k.einzel || 0) + (k.gespanne || 0))) m.push({ stufe: 'warnung', text: `${k.name}: keine Fahrzeuge eingetragen – Marschlänge und Durchlaufzeit bleiben leer.`, ansicht: 'kolonnen' });
  });
  kps.forEach((k, i) => {
    if (!k.ort) m.push({ stufe: 'warnung', text: `Kontrollpunkt ${i + 1} hat keinen Ortsnamen.`, ansicht: 'route' });
  });
  if (p.kolonnen.length) {
    const fp = fahrplan(p, p.kolonnen[0]);
    fp.hinweise.forEach(h => m.push({ stufe: 'warnung', text: h, ansicht: 'eckdaten' }));
    if (fp.zeilen.length > 1 && fp.ende >= 1440) m.push({ stufe: 'warnung', text: 'Der Marsch reicht über Mitternacht hinaus; Uhrzeiten des Folgetags tragen „+1“.', ansicht: null });
  }
  haltKonflikte(p).forEach(k => m.push({
    stufe: 'warnung', ansicht: 'kolonnen',
    text: `Halt ${k.nr}${k.kp.ort ? ' (' + k.kp.ort + ')' : ''}: ${k.a.name} und ${k.b.name} stehen zugleich dort (${zeitText(Math.max(k.a.von, k.b.von))}–${zeitText(Math.min(k.a.bis, k.b.bis))}).`
  }));
  const gesichertAm = store.gesichertAm(p.id);
  if (!gesichertAm) m.push({ stufe: 'hinweis', text: 'Diese Planung ist noch nicht als Datei gesichert; sie liegt nur in diesem Browser.', ansicht: null, aktion: 'sichern' });
  else if (gesichertAm < (p.geaendert || '')) m.push({ stufe: 'hinweis', text: `Seit der letzten Dateisicherung (${sicherungText(p)}) wurde die Planung geändert.`, ansicht: null, aktion: 'sichern' });
  return m;
}

/** „als Datei gesichert vor 3 Tagen“ bzw. „noch nie als Datei gesichert“ */
function sicherungText(p) {
  const t = store.gesichertAm(p.id);
  if (!t) return 'noch nie als Datei gesichert';
  const tage = Math.floor((Date.now() - Date.parse(t)) / 864e5);
  return `als Datei gesichert ${tage <= 0 ? 'heute' : tage === 1 ? 'gestern' : `vor ${tage} Tagen`}`;
}

function meldungsListe(liste, mitSprung = true) {
  if (!liste.length) return '<ul class="meldungen"><li class="ok">Keine Auffälligkeiten.</li></ul>';
  return `<ul class="meldungen">${liste.map(x => `<li class="${x.stufe}"><span>${e(x.text)}</span>${
    mitSprung && x.ansicht ? `<button type="button" class="knopf klein" data-aktion="gehe" data-ziel="${x.ansicht}">Öffnen</button>` : ''}${
    mitSprung && x.aktion === 'sichern' ? '<button type="button" class="knopf klein" data-aktion="sichern">Jetzt sichern</button>' : ''}</li>`).join('')}</ul>`;
}

/* ====================================================================
   Ansichten
   ==================================================================== */

function vEckdaten(p) {
  const par = p.parameter;
  const zeile = (k) => `<tr><td><strong>${e(k.kurz)}</strong> <span class="hinweis">${e(k.name)}</span></td>
    <td><input type="number" data-typ="zahl" data-p="parameter.v.${k.id}" value="${e(par.v[k.id])}" min="1" max="130" step="any" aria-label="Marschgeschwindigkeit ${e(k.kurz)}"></td>
    <td><input type="number" data-typ="zahl" data-p="parameter.aufhol.${k.id}" value="${e(par.aufhol[k.id])}" min="1" max="130" step="any" aria-label="Aufholgeschwindigkeit ${e(k.kurz)}"></td>
    <td><input type="number" data-typ="zahl" data-p="parameter.abstand.${k.id}" value="${e(par.abstand[k.id])}" min="0" max="1000" step="any" aria-label="Fahrzeugabstand ${e(k.kurz)}"></td></tr>`;
  return `
    <h1>Eckdaten</h1>
    <p class="lead">Worum geht es, wann geht es los, mit welchen Planungswerten wird gerechnet.</p>
    <section class="block"><h2>Marsch</h2>
      <div class="formular">
        ${feld('Kennung / Auftragsnummer', 'kopf.kennung', p, { hinweis: 'Steht oben rechts auf jedem Blatt.' })}
        ${feld('Marschverband / Einheit', 'kopf.verband', p)}
        ${feld('Datum (Marschbeginn)', 'kopf.datum', p, { typ: 'date' })}
        ${feld('Ablaufzeit (Uhr)', 'kopf.ablaufzeit', p, { typ: 'time', hinweis: 'Pflicht – ohne Ablaufzeit rechnet der Fahrplan nicht. Wann die Spitze der ersten Kolonne den Ablaufpunkt passiert.' })}
        ${feld('Marsch von', 'kopf.von', p)}
        ${feld('Marsch nach', 'kopf.nach', p)}
      </div>
    </section>
    <section class="block"><h2>Marschparameter</h2>
      <div class="vorgabe-hinweis">${e(HINWEIS_VORLAGE)}</div>
      <div class="rolle-tabelle"><table class="tab">
        <thead><tr><th>Straßenart</th><th class="num">Marschgeschwindigkeit<br>km/h</th><th class="num">Aufholgeschwindigkeit<br>km/h</th><th class="num">Fahrzeugabstand<br>m</th></tr></thead>
        <tbody>${KLASSEN.map(zeile).join('')}</tbody>
      </table></div>
      <div class="formular eng" style="margin-top:14px">
        ${feld('Länge Einzel-KFZ', 'parameter.laengeEinzel', p, { typ: 'number', einheit: 'm', min: 0 })}
        ${feld('Länge Gespann', 'parameter.laengeGespann', p, { typ: 'number', einheit: 'm', min: 0 })}
        ${feld('Standard-Halt: Technischer Halt', 'parameter.halt.th', p, { typ: 'number', einheit: 'min', min: 0 })}
        ${feld('Standard-Halt: Rast', 'parameter.halt.rast', p, { typ: 'number', einheit: 'min', min: 0 })}
        ${feld('Standard-Halt: Tankstopp', 'parameter.halt.tank', p, { typ: 'number', einheit: 'min', min: 0 })}
      </div>
      <p class="hinweis" style="margin:10px 0 0">Der Fahrzeugabstand gilt als Lücke zwischen zwei Fahrzeugen und bestimmt Marschlänge und Durchlaufzeit. Die Aufholgeschwindigkeit wird auf der Marschtabelle ausgewiesen.</p>
    </section>`;
}

/* ---- Route ---- */

function kpOptionen(liste, aktuell) {
  return liste.map(o => `<option value="${o.id}" ${o.id === aktuell ? 'selected' : ''}>${e(o.name || o.kurz)}</option>`).join('');
}

function kpTabelle(p) {
  const kps = sortierteKp(p.route);
  if (!kps.length) return '<p class="hinweis">Noch keine Kontrollpunkte. Lade eine GPX-Datei oder lege Punkte von Hand an.</p>';
  const zeilen = kps.map((kp, i) => {
    const pf = (f) => `route.kontrollpunkte.@${kp.id}.${f}`;
    const vorgabe = p.parameter.halt?.[kp.typ];
    return `<tr data-kp="${kp.id}">
      <td class="kp-nr"><strong>${i + 1}</strong>
        <button type="button" class="knopf klein nur-symbol gefahr" data-aktion="kp-loeschen" data-id="${kp.id}" title="Punkt ${i + 1} entfernen (mit „Rückgängig“ zurückholbar)" aria-label="Punkt ${i + 1} entfernen">✕</button></td>
      <td><select data-p="${pf('typ')}" data-typ="text" data-neu="1" aria-label="Art des Punkts ${i + 1}">${kpOptionen(PUNKTTYPEN, kp.typ)}</select></td>
      <td><input type="text" data-p="${pf('ort')}" data-typ="text" value="${e(kp.ort)}" placeholder="Ort" aria-label="Ort ${i + 1}"></td>
      <td class="abgeleitet" data-an="${kp.id}"></td>
      <td><input type="text" data-p="${pf('strasse')}" data-typ="text" value="${e(kp.strasse)}" placeholder="z. B. B 28" ${i === 0 ? 'disabled title="Der Ablaufpunkt hat keinen Abschnitt davor"' : ''} aria-label="Straße bis Punkt ${i + 1}"></td>
      <td><select data-p="${pf('klasse')}" data-typ="text" ${i === 0 ? 'disabled' : ''} aria-label="Straßenart bis Punkt ${i + 1}">${p.route.arten || kp.klasse === 'auto' ? `<option value="auto" ${kp.klasse === 'auto' ? 'selected' : ''}>Auto (OSM)</option>` : ''}${KLASSEN.map(k => `<option value="${k.id}" ${k.id === kp.klasse ? 'selected' : ''}>${k.kurz}</option>`).join('')}</select></td>
      <td class="num"><input type="number" step="0.1" min="0" data-p="${pf('km')}" data-typ="zahl" data-nachsort="1" value="${e(Math.round(kp.km * 100) / 100)}" aria-label="Kilometerstand ${i + 1}" ${p.route.track.length ? '' : ''}></td>
      <td class="num"><input type="number" step="1" min="0" data-p="${pf('halt')}" data-typ="zahl" max="600" value="${e(kp.halt ?? '')}" placeholder="${vorgabe ? zahl(vorgabe, 0) : '0'}" aria-label="Halt in Minuten ${i + 1}"></td>
      <td class="num"><input type="number" step="0.1" min="0" data-p="${pf('umwegKm')}" data-typ="zahl" value="${e(kp.umwegKm || '')}" placeholder="0" title="Zusätzliche Strecke für Zu- und Abfahrt zu einem Platz abseits der Strecke (hin und zurück)" aria-label="Umweg in km ${i + 1}"></td>
      <td><input type="text" data-p="${pf('bemerkung')}" data-typ="text" value="${e(kp.bemerkung)}" placeholder="Bemerkung" aria-label="Bemerkung ${i + 1}"></td>
</tr>`;
  }).join('');
  return `<table class="tab kp-tabelle">
    <thead><tr><th>Nr</th><th>Art</th><th>Ort</th><th>Ankunft <span class="hinweis">(Kolonne 1)</span></th><th>Straße <span class="hinweis">(bis hierher)</span></th><th>Straßenart</th><th class="num">km</th><th class="num">Halt min</th><th class="num">Umweg km</th><th>Bemerkung</th></tr></thead>
    <tbody>${zeilen}</tbody></table>`;
}

function vRoute(p) {
  return `
    <h1>Route und Kontrollpunkte</h1>
    <p class="lead">Die Route kommt als GPX-Datei, zum Beispiel aus dem TomTom MyDrive Route Planner („Route exportieren → GPX“) oder aus jeder anderen Routenplanung. Aus den Wegpunkten werden Kontrollpunkte; weitere setzt du auf der Karte.</p>
    <div class="ablage" id="ablage">
      GPX-Datei hierher ziehen oder
      <button type="button" class="knopf" data-aktion="gpx-waehlen">GPX-Datei wählen …</button>
      <button type="button" class="knopf" data-aktion="beispiel">Beispiel ansehen</button>
      <input type="file" id="gpx-datei" accept=".gpx,application/gpx+xml,application/xml,text/xml" hidden>
    </div>
    <div class="route-info" id="route-info"></div>
    <div style="position:relative"><div id="karte"></div><div class="karte-leer" id="karte-leer"><div><strong>Noch keine Route</strong>GPX-Datei laden – oder Kontrollpunkte unten von Hand mit Kilometerstand anlegen.</div></div></div>
    <div class="legende-karte" aria-hidden="true">
      ${KLASSEN.map(k => `<span><i style="border-color:${k.id === 'bab' ? '#c62828' : k.id === 'bul' ? '#003399' : '#1b7a3d'}"></i>${e(k.name)}</span>`).join('')}
      <span>Punkte lassen sich entlang der Strecke ziehen; Klick auf die Strecke setzt einen neuen Kontrollpunkt.</span>
    </div>
    <section class="block"><h2>Kontrollpunkte</h2>
      <div class="leiste">
        <button type="button" class="knopf" data-aktion="kp-neu">＋ Kontrollpunkt</button>
        <button type="button" class="knopf" data-aktion="strassenarten" title="Straßenart und Straßennummer entlang der Route aus OpenStreetMap neu bestimmen">Straßenarten neu ermitteln</button>
        <button type="button" class="knopf" data-aktion="orte-ermitteln" title="Ortsnamen aus OpenStreetMap vorschlagen">Ortsnamen ermitteln</button>
        <button type="button" class="knopf" data-aktion="gpx-export" title="Strecke und Kontrollpunkte als GPX-Datei, z. B. für ein Navigationsgerät">Als GPX exportieren</button>
        <button type="button" class="knopf gefahr" data-aktion="route-loeschen">Route entfernen</button>
      </div>
      <div class="rolle-tabelle" id="kp-bereich"></div>
      <p class="hinweis" style="margin:10px 0 0">„Straßenart“ gilt für den Abschnitt <em>bis zu</em> diesem Punkt und bestimmt Geschwindigkeit und Fahrzeugabstand. „Auto (OSM)“ rechnet den Abschnitt anteilig nach den Straßenarten, die OpenStreetMap entlang der Route kennt; eine feste Wahl überstimmt das. Die Straße bleibt leer, wenn OSM sie liefert, und lässt sich überschreiben. „Halt“ leer lassen = Vorgabe der Punktart. „Umweg“ ist die zusätzliche Strecke (hin und zurück) zu einem Platz abseits der Strecke; sie geht in Kilometer und Zeit ein.</p>
    </section>
    <section class="block" id="pausen-block"><h2>Pausen und Rastplätze vorschlagen</h2>
      <p class="lead">Der Marschplaner sucht Rast-, Park- und Tankplätze im Suchradius um die Strecke und schlägt für jede Pause den besten Platz im Zeitfenster vor. Mit einem Klick wird er zum Kontrollpunkt; liegt er abseits, rechnet der Fahrplan den Umweg mit. Die Art der Pause (Rast, Technischer Halt, Tanken) bestimmt die Haltedauer – Vorgabe unter „Eckdaten“.</p>
      <div class="formular eng">
        ${feld('Suchradius um die Strecke', 'suche.radius', p, { typ: 'number', min: 100, max: 10000, schritt: 100, einheit: 'm' })}
        ${feld('Pause alle', 'suche.intervall', p, { typ: 'number', min: 15, schritt: 5, einheit: 'min', hinweis: 'reine Fahrzeit' })}
        ${feld('Zeitfenster ±', 'suche.fenster', p, { typ: 'number', min: 5, schritt: 5, einheit: 'min' })}
        ${feld('Mindest-Stellplätze', 'suche.kapazitaet', p, { typ: 'number', min: 0, schritt: 1, hinweis: `größte Kolonne: ${Math.max(0, ...p.kolonnen.map(k => (k.einzel || 0) + (k.gespanne || 0)))} Fz; 0 = egal` })}
      </div>
      <div class="leiste" style="margin:4px 0 10px">
        <label><input type="checkbox" data-p="suche.rast" data-typ="haken" ${p.suche.rast ? 'checked' : ''}> Rastplätze / Raststätten</label>
        <label><input type="checkbox" data-p="suche.parkplatz" data-typ="haken" ${p.suche.parkplatz ? 'checked' : ''}> Parkplätze</label>
        <label><input type="checkbox" data-p="suche.tank" data-typ="haken" ${p.suche.tank ? 'checked' : ''}> Tankstellen</label>
      </div>
      <div class="leiste"><button type="button" class="knopf primaer" data-aktion="plaetze-suchen">Plätze entlang der Strecke suchen</button></div>
      <div id="pausen-ergebnis"></div>
    </section>`;
}

function routeAktualisieren() {
  const p = store.aktuell();
  const bereich = $('#kp-bereich');
  if (!bereich) return;
  // beim Neuaufbau der Tabelle den Fokus halten
  const fokus = document.activeElement;
  const merke = fokus && bereich.contains(fokus) ? { pfad: fokus.dataset.p, start: fokus.selectionStart, ende: fokus.selectionEnd } : null;
  bereich.innerHTML = kpTabelle(p);
  if (merke?.pfad) {
    const neu = bereich.querySelector(`[data-p="${CSS.escape(merke.pfad)}"]`);
    if (neu) { neu.focus(); try { neu.setSelectionRange(merke.start, merke.ende); } catch { /* number-Felder kennen das nicht */ } }
  }
  $('#karte-leer').hidden = p.route.track.length > 1;
  karte?.aktualisieren(p);
  abgeleitetAktualisieren();
}

/* ---- Pausen- und Rastplatzvorschläge ---- */

const PLATZ_TYP = { rast: 'Rast', th: 'Techn. Halt', tank: 'Tanken' };

function pausenAktualisieren() {
  const ziel = $('#pausen-ergebnis');
  if (!ziel) return;
  const p = store.aktuell();
  const pl = p.route.plaetze;
  const s = p.suche;
  const radius = +s.radius || 1000;
  if (p.route.track.length < 2) { ziel.innerHTML = '<p class="hinweis">Zuerst eine Route laden.</p>'; return; }
  if (!pl?.liste) {
    ziel.innerHTML = (fehlerPlaetze ? `<div class="vorgabe-hinweis fehler">⚠ ${e(fehlerPlaetze)} <button type="button" class="knopf klein" data-aktion="plaetze-suchen">Erneut versuchen</button></div>` : '')
      + '<p class="hinweis">Noch nicht gesucht. „Plätze entlang der Strecke suchen“ fragt OpenStreetMap ab.</p>';
    karte?.setzePlaetze([], [], new Map()); karte?.aktualisieren(p);
    return;
  }
  const arten = [s.rast && 'rast', s.parkplatz && 'parkplatz', s.tank && 'tank'].filter(Boolean);
  const liste = pl.liste.filter(x => x.abstandM <= radius);
  const vs = vorschlagen(p, liste, { intervallMin: +s.intervall || 120, fensterMin: +s.fenster || 30, radiusM: radius, kapMin: +s.kapazitaet || 0, arten });
  const fp = fahrplan(p, p.kolonnen[0] ?? null);

  const hinweise = [];
  if (fehlerPlaetze) hinweise.push(`⚠ ${fehlerPlaetze}`);
  if (fp.ablaufFehlt) hinweise.push('Die Ablaufzeit fehlt (Eckdaten): Uhrzeiten der Pausen sind nicht verfügbar.');
  if (offenePlaetze(pl)) hinweise.push(`${offenePlaetze(pl)} von ${pl.fertig.length} Streckenstücken sind noch nicht abgefragt – „Plätze suchen“ holt nur diese nach.`);
  if (radius > pl.radius) hinweise.push(`Gesucht wurde nur bis ${zahl(pl.radius, 0)} m – für ${zahl(radius, 0)} m bitte neu suchen.`);

  const genommen = new Map();                      // Platz → Nummer des Kontrollpunkts, der daraus wurde
  sortierteKp(p.route).forEach((k, i) => { if (k.platzId) genommen.set(k.platzId, i + 1); });
  const halt = (typ) => p.parameter.halt?.[typ];
  const VORSCHLAG_TYP = { rast: 'rast', tank: 'tank', parkplatz: 'th' };

  const zeile = (k, i) => `<tr class="${i === 0 ? 'bester' : ''}">
      <td>${i === 0 ? '★' : ''}</td>
      <td><strong>${e(k.name || ART_NAME[k.art])}</strong><br><small class="hinweis">${e(ART_NAME[k.art])}</small></td>
      <td class="num">km ${zahl(k.km, 1)}<br><small class="hinweis">${k.zeitAbweichungMin > 0 ? '+' : ''}${k.zeitAbweichungMin} min</small></td>
      <td>${k.abstandM} m neben der Strecke${k.umwegKm ? `<br><small class="hinweis">Umweg ca. ${zahl(k.umwegKm, 1)} km</small>` : ''}</td>
      <td>${k.kapazitaet ? `${k.kapazitaet} Plätze` : '<span class="hinweis">Plätze unbekannt</span>'}${k.lkw ? '<br><small class="hinweis">Lkw</small>' : ''}${k.wc ? '<br><small class="hinweis">WC</small>' : ''}</td>
      <td style="white-space:nowrap">${genommen.has(k.id)
        ? `<strong class="uebernommen">✓ als Punkt ${genommen.get(k.id)} übernommen</strong>`
        : Object.entries(PLATZ_TYP).map(([typ, t]) =>
          `<button type="button" class="knopf klein ${typ === VORSCHLAG_TYP[k.art] ? 'primaer' : ''}" data-aktion="platz-nehmen" data-id="${e(k.id)}" data-typ="${typ}" title="${t}: ${zahl(halt(typ) ?? 0, 0)} min Halt (Vorgabe aus den Eckdaten)">${t} · ${zahl(halt(typ) ?? 0, 0)} min</button>`).join(' ')}</td></tr>`;

  const karten = vs.map(v => `<div class="pause"><h3>Pause ${v.n} · nach ca. ${dauerText(v.tMin)} Fahrzeit · km ${zahl(v.km, 0)}${fp.ablaufFehlt ? '' : ` · etwa ${zeitText(uhrBeiKm(fp, v.km))} Uhr`}</h3>
    ${v.kandidaten.length
      ? `<table class="tab"><tbody>${v.kandidaten.slice(0, 4).map(zeile).join('')}</tbody></table>${v.kandidaten.length > 4 ? `<p class="hinweis">… und ${v.kandidaten.length - 4} weitere auf der Karte.</p>` : ''}`
      : '<p class="hinweis">Kein passender Platz im Zeitfenster – Radius oder Zeitfenster vergrößern, mehr Platzarten zulassen oder die Mindest-Stellplätze senken.</p>'}</div>`).join('');

  ziel.innerHTML = `${hinweise.map(h => `<div class="vorgabe-hinweis ${h.startsWith('⚠') ? 'fehler' : ''}">${e(h)}${h.startsWith('⚠') ? ' <button type="button" class="knopf klein" data-aktion="plaetze-suchen">Erneut versuchen</button>' : ''}</div>`).join('')}
    <p class="hinweis" style="margin:8px 0">${liste.length} Plätze im Radius gefunden${vs.length ? ` · ${vs.length} Pause(n) im Abstand von ${zahl(+s.intervall || 120, 0)} min` : ' · Strecke zu kurz für eine Pause'}.
      Uhrzeiten gelten für ${e(p.kolonnen[0]?.name || 'die erste Kolonne')} und enthalten die bereits geplanten Halte und Umwege.</p>${karten}`;

  const alle = new Map();
  for (const v of vs) for (const k of v.kandidaten) alle.set(k.id, k);
  karte?.setzePlaetze([...alle.values()], vs.map(v => v.bester?.id).filter(Boolean), genommen);
  karte?.aktualisieren(p);
}

function platzNehmen(id, typ) {
  const p = store.aktuell();
  const platz = p.route.plaetze?.liste.find(x => x.id === id);
  if (!platz) return;
  const name = platz.name || ART_NAME[platz.art];
  const schon = kpZuPlatz(p, id);
  if (schon) {
    const nr = sortierteKp(p.route).findIndex(k => k.id === schon.id) + 1;
    meldung(`„${name}“ ist schon als Punkt ${nr} übernommen.`, 'fehler');
    return;
  }
  const vorher = fahrplan(p, p.kolonnen[0] ?? null);
  store.aendern(pp => { kpAusPlatz(pp, platz, typ); }, null, `Platz „${name}“ übernommen`);
  routeAktualisieren();
  const nachher = fahrplan(store.aktuell(), store.aktuell().kolonnen[0] ?? null);
  const plus = nachher.ende - vorher.ende;
  const ziel = nachher.ablaufFehlt ? `Marschzeit ${plus >= 0 ? '+' : ''}${plus} min` : `Ankunft Ziel ${zeitText(vorher.ende)} → ${zeitText(nachher.ende)} Uhr (${plus >= 0 ? '+' : ''}${plus} min)`;
  meldung(`„${name}“ als ${PLATZ_TYP[typ]} übernommen${platz.abstandM >= 50 ? ` – Umweg ca. ${zahl(umwegKm(platz.abstandM), 1)} km` : ''}. ${ziel}.`, '', false, rueckgaengigAktion);
}

let platzlauf = null;                       // AbortController, solange die Suche läuft
let fehlerPlaetze = '';                     // bleibt im Pausenblock stehen, bis eine Suche gelingt
let fehlerArten = '';                       // dasselbe für die Straßenarten, steht an der Route

/** Meldung mit „Abbrechen“ für einen laufenden Abruf */
function laufMeldung(text, abbr) { meldung(text, '', true, { text: 'Abbrechen', fn: () => abbr.abort() }); }

async function plaetzeSuchen() {
  if (platzlauf) return;
  const p = store.aktuell();
  if (p.route.track.length < 2) { meldung('Zuerst eine Route laden.', 'fehler'); return; }
  const radius = Math.min(10000, Math.max(100, +p.suche.radius || 1000));
  const laenge = trackKm(p.route);
  const vorhanden = plaetzePassen(p.route.plaetze, laenge, radius) ? p.route.plaetze : null;
  if (vorhanden && !offenePlaetze(vorhanden)) { pausenAktualisieren(); meldung('Alle Streckenstücke sind bereits abgefragt – Vorschläge aktualisiert.'); return; }
  if (navigator.onLine === false) {
    fehlerPlaetze = 'Kein Netz – die Platzsuche braucht eine Verbindung. Später erneut versuchen; Gefundenes bleibt gespeichert.';
    pausenAktualisieren();
    meldung('Kein Netz – die Platzsuche braucht eine Verbindung.', 'fehler');
    return;
  }
  if (erinnern('mp.overpass') !== 'ja') {
    if (!confirm('Plätze suchen?\n\nDazu wird der Streckenverlauf deiner Planung (vereinfacht) in Stücken an einen Kartendienst (Overpass, overpass-api.de, OpenStreetMap) gesendet. Die Zustimmung wird in diesem Browser gemerkt und lässt sich unter „Planungen“ widerrufen.')) return;
    merken('mp.overpass', 'ja');
  }
  const abbr = new AbortController();
  platzlauf = abbr;
  const id = p.id, track = p.route.track;
  const gleiche = () => { const j = store.aktuell(); return j.id === id && j.route.track === track; };
  try {
    const stand = await sucheEntlang(track, radius, {
      vorhanden, signal: abbr.signal,
      fortschritt: (fertig, gesamt, hinweis) => laufMeldung(fertig < gesamt
        ? `Plätze werden gesucht … Stück ${fertig + 1} von ${gesamt}${vorhanden ? ' (nur fehlende)' : ''}${hinweis ? ' – ' + hinweis : ''}` : 'Plätze werden ausgewertet …', abbr),
      beiStueck: (zwischen) => {
        if (!gleiche()) throw abbruchFehler('Die Planung wurde gewechselt.');
        store.aendernStill(pp => { pp.route.plaetze = structuredClone(zwischen); });
        pausenAktualisieren();
      }
    });
    if (!gleiche()) { meldung('Die Planung hat sich geändert – Zwischenstand verworfen.', 'fehler'); return; }
    fehlerPlaetze = '';
    pausenAktualisieren();
    const offen = offenePlaetze(stand);
    meldung(`${stand.liste.length} Plätze gefunden` + (offen ? ` – ${offen} Streckenstück(e) noch offen (Kartendienst überlastet); „Plätze suchen“ holt nur diese nach` : ''), offen ? 'fehler' : '');
  } catch (err) {
    const hat = offenePlaetze(store.aktuell().route.plaetze);
    if (err.name === 'Abbruch') {
      const vomNutzer = err.message === 'Abgebrochen.';
      meldung(vomNutzer ? 'Platzsuche abgebrochen – Bisheriges bleibt gespeichert, erneutes Suchen setzt fort.' : err.message, vomNutzer ? '' : 'fehler');
    } else {
      fehlerPlaetze = fehlerText(err) + (hat ? ' Bisher Gefundenes bleibt gespeichert – erneutes Suchen setzt fort.' : '');
      meldung(`Die Platzsuche ist fehlgeschlagen. ${fehlerText(err)}`, 'fehler');
    }
    pausenAktualisieren();
  } finally {
    platzlauf = null;
  }
}

/* ---- Kolonnen ---- */

function kolonneKarte(p, k) {
  const pf = (f) => `kolonnen.@${k.id}.${f}`;
  return `<div class="kolonne" data-kolonne="${k.id}">
    <div class="kolonne-kopf">
      <h3>${e(k.name || 'Marschkolonne')}</h3>
      <button type="button" class="knopf klein" data-aktion="k-dup" data-id="${k.id}">Duplizieren</button>
      <button type="button" class="knopf klein gefahr" data-aktion="k-weg" data-id="${k.id}" ${p.kolonnen.length < 2 ? 'disabled' : ''}>Entfernen</button>
    </div>
    <div class="formular">
      ${feld('Name', pf('name'), p)}
      ${feld('Einzel-KFZ', pf('einzel'), p, { typ: 'number', min: 0, schritt: 1, einheit: 'Fz' })}
      ${feld('Gespanne', pf('gespanne'), p, { typ: 'number', min: 0, schritt: 1, einheit: 'Fz' })}
      ${feld('Versatz zur Ablaufzeit', pf('versatzMin'), p, { typ: 'number', min: 0, schritt: 1, einheit: 'min', hinweis: 'Wie viele Minuten nach der Ablaufzeit diese Kolonne abläuft.' })}
      ${feld('Marschfolge', pf('marschfolge'), p, { mehrzeilig: true, zeilen: 2, klasse: 'breit', platzhalter: 'z. B. Führungsfahrzeug, 8 Kombi, 2 Gespanne, Schließender' })}
    </div>
    <div class="ergebnis" data-k-ergebnis="${k.id}"></div>
  </div>`;
}

function vKolonnen(p) {
  return `
    <h1>Marschkolonnen</h1>
    <p class="lead">Ein Marschverband besteht aus einer oder mehreren Marschkolonnen. Jede bekommt ihre eigene Marschtabelle; der Versatz verschiebt ihre Zeiten gegen die Ablaufzeit. Der Straßenbelegungsplan zeigt, ob sich Kolonnen an einem Halt in die Quere kommen.</p>
    <div id="kolonnen-warnung"></div>
    ${p.kolonnen.map(k => kolonneKarte(p, k)).join('')}
    <button type="button" class="knopf" data-aktion="k-neu">＋ Marschkolonne hinzufügen</button>`;
}

/* ---- Marschauftrag ---- */

function vAuftrag(p) {
  const auto = autoAuftrag(p);
  const a = p.auftrag;
  const abschnitte = AUFTRAG_ABSCHNITTE.map(ab => `
    <section class="block"><h2>${e(ab.nr)}. ${e(ab.titel)}</h2>
      <p class="lead">${e(ab.hinweis)}</p>
      <div class="formular">${ab.felder.map(([f, nr, name]) => {
        const istAuto = AUFTRAG_AUTO.includes(f);
        const gross = ab.felder.length === 1;
        const weicht = istAuto && String(a[f] ?? '').trim() && String(a[f]).trim() !== String(auto[f] ?? '').trim();
        return feld(`${nr ? nr + ' – ' : ''}${name}`, `auftrag.${f}`, p, {
          mehrzeilig: true, zeilen: gross ? 5 : (f === 'a3h' || f === 'a3m' || f === 'a3n' ? 3 : 2),
          klasse: gross ? 'breit' : '',
          platzhalter: istAuto ? (auto[f] ? `Automatisch: ${auto[f]}` : 'Wird aus der Planung ergänzt') : '',
          hinweis: istAuto ? 'Leer lassen = Text aus der Planung.' : '',
          zusatz: istAuto ? `<span class="auto-abweichung" data-auto-f="${f}" ${weicht ? '' : 'hidden'}>⚠ Von Hand eingetragen – folgt der Planung nicht mehr. <button type="button" class="knopf klein" data-aktion="auftrag-auto" data-f="${f}">Wieder automatisch</button></span>` : ''
        });
      }).join('')}</div>
    </section>`).join('');
  return `
    <h1>Marschauftrag (Fb Fü 55)</h1>
    <p class="lead">Felder mit „Automatisch“ füllen sich aus Route, Kolonnen und Parametern. Wer etwas einträgt, überschreibt den Vorschlag – das Feld meldet dann „von Hand eingetragen“ und lässt sich mit einem Klick zurücksetzen.</p>
    <section class="block"><h2>Kopf</h2>
      <div class="formular">
        ${feld('Absender', 'auftrag.absender', p)}
        ${feld('Empfänger', 'auftrag.empfaenger', p)}
      </div></section>
    ${abschnitte}
    <section class="block"><h2>Abschluss</h2>
      <div class="formular">
        ${feld('Ort, Datum', 'auftrag.ortDatum', p)}
        ${feld('Dienststellung', 'auftrag.dienststellung', p)}
        ${feld('Anlagen', 'auftrag.anlagen', p, { mehrzeilig: true, zeilen: 2, klasse: 'breit' })}
        ${feld('Verteiler', 'auftrag.verteiler', p, { mehrzeilig: true, zeilen: 2, klasse: 'breit' })}
        ${feld('Empfangsbestätigung (Ort, Datum, Unterschrift, Dienststellung)', 'auftrag.quittung', p, { klasse: 'breit' })}
      </div></section>`;
}

/* ---- Unterlagen ---- */

function vUnterlagen(p) {
  const kopfZ = UNTERLAGEN_ROLLEN.map(r => `<th class="num" style="text-align:center;white-space:normal;min-width:84px">${e(r.name)}</th>`).join('');
  const zeilen = p.unterlagen.zeilen.map(z => `<tr data-u="${z.id}">
    <td><input type="text" data-p="unterlagen.zeilen.@${z.id}.name" data-typ="text" value="${e(z.name)}" aria-label="Unterlage"></td>
    ${UNTERLAGEN_ROLLEN.map(r => `<td style="text-align:center"><input type="checkbox" data-u="${z.id}" data-rolle="${r.id}" ${z.rollen.includes(r.id) ? 'checked' : ''} aria-label="${e(z.name)} für ${e(r.name)}" style="width:18px;height:18px;min-height:0;accent-color:var(--thw)"></td>`).join('')}
    <td><button type="button" class="knopf klein nur-symbol gefahr" data-aktion="u-weg" data-id="${z.id}" aria-label="Zeile entfernen">✕</button></td></tr>`).join('');
  return `
    <h1>Unterlagenverteilung</h1>
    <p class="lead">Welche Unterlage bekommt wer. Die Vorbelegung stammt aus der Vorlage und lässt sich frei ändern.</p>
    <section class="block">
      <div class="rolle-tabelle"><table class="tab">
        <thead><tr><th>Unterlage</th>${kopfZ}<th></th></tr></thead><tbody>${zeilen}</tbody></table></div>
      <div class="leiste" style="margin:12px 0 0">
        <button type="button" class="knopf" data-aktion="u-neu">＋ Zeile</button>
        <button type="button" class="knopf" data-aktion="u-standard">Vorlage wiederherstellen</button>
      </div>
    </section>`;
}

/* ---- Hilfsmittel ---- */

function vHilfsmittel(p) {
  const hm = p.hilfsmittel;
  return `
    <h1>Hilfsmittel</h1>
    <p class="lead">Die Rechenblätter der Vorlage: Marschlänge und -zeit schätzen, Durchlaufzeiten nachschlagen, Weg-Zeit-Tabelle.</p>
    <section class="block"><h2>Hilfestellung Marschplanung</h2>
      <div class="leiste"><button type="button" class="knopf" data-aktion="rechner-uebernehmen">Werte aus der Planung übernehmen</button></div>
      <div class="formular eng">
        ${feld('Anzahl Einzel-KFZ', 'hilfsmittel.rechner.einzel', p, { typ: 'number', min: 0, schritt: 1 })}
        ${feld('Anzahl Gespanne', 'hilfsmittel.rechner.gespanne', p, { typ: 'number', min: 0, schritt: 1 })}
        ${feld('Marschgeschwindigkeit', 'hilfsmittel.rechner.v', p, { typ: 'number', min: 0, einheit: 'km/h' })}
        ${feld('Marschkolonnen', 'hilfsmittel.rechner.kolonnen', p, { typ: 'number', min: 1, schritt: 1 })}
        ${feld('Marschentfernung', 'hilfsmittel.rechner.km', p, { typ: 'number', min: 0, einheit: 'km' })}
        ${feld('Marschunterbrechung', 'hilfsmittel.rechner.unterbrechung', p, { typ: 'number', min: 0, einheit: 'min', hinweis: 'Alle Unterbrechungen aufsummiert.' })}
        ${feld('Fahrzeugabstände', 'hilfsmittel.rechner.abstand', p, { typ: 'number', min: 0, einheit: 'm' })}
        ${feld('Abstand zwischen Kolonnen', 'hilfsmittel.rechner.kolonnenabstand', p, { typ: 'number', min: 0, einheit: 'm', hinweis: 'Planungswert fachlich festlegen.' })}
        ${feld('Länge Einzel-KFZ', 'hilfsmittel.rechner.laengeEinzel', p, { typ: 'number', min: 0, einheit: 'm' })}
        ${feld('Länge Gespann', 'hilfsmittel.rechner.laengeGespann', p, { typ: 'number', min: 0, einheit: 'm' })}
      </div>
      <dl class="ergebnis-kasten" id="rechner-ergebnis"></dl>
    </section>
    <section class="block"><h2>Marschlänge – Durchlaufzeit (Tabelle)</h2>
      <div class="formular eng">
        ${feld('Geschwindigkeit A', 'hilfsmittel.durchlauf.vA', p, { typ: 'number', min: 1, einheit: 'km/h' })}
        ${feld('Geschwindigkeit B', 'hilfsmittel.durchlauf.vB', p, { typ: 'number', min: 1, einheit: 'km/h' })}
        ${feld('Fahrzeuglänge', 'hilfsmittel.durchlauf.fahrzeugLaenge', p, { typ: 'number', min: 1, einheit: 'm' })}
        ${feld('Bis Anzahl Fahrzeuge', 'hilfsmittel.durchlauf.bisN', p, { typ: 'number', min: 3, max: 100, schritt: 1 })}
      </div>
      <p class="hinweis" style="margin:10px 0 0">Der Fahrzeugabstand ist wie in der Vorlage der halbe Tachowert in Metern.</p>
    </section>
    <section class="block"><h2>Weg-Zeit-Tabelle</h2>
      <div class="formular eng">${feld('Bis Entfernung', 'hilfsmittel.wegZeit.bisKm', p, { typ: 'number', min: 1, max: 500, schritt: 1, einheit: 'km' })}</div>
    </section>`;
}

/* ---- Drucken ---- */

let druckAuswahl = new Set(BLAETTER.filter(b => b.gruppe === 'plan').map(b => b.id));

function vDruck(p) {
  const liste = (gruppe) => BLAETTER.filter(b => b.gruppe === gruppe).map(b => {
    const n = b.jeKolonne ? p.kolonnen.length : 1;
    return `<li><label><input type="checkbox" data-druck="${b.id}" ${druckAuswahl.has(b.id) ? 'checked' : ''}>
      <span><span class="vnr">${e(b.vnr || '—')}</span> ${e(b.titel)}
      <span class="meta">· A4 ${b.ausrichtung === 'quer' ? 'quer' : 'hoch'}${n > 1 ? ` · ${n} Blätter (je Kolonne)` : ''}</span></span></label>
      <button type="button" class="knopf klein" data-aktion="ansehen" data-id="${b.id}">Ansehen</button></li>`;
  }).join('');
  return `
    <h1>Drucken / PDF</h1>
    <p class="lead">Wähle die Blätter. „Drucken“ öffnet den Druckdialog deines Browsers – dort „Als PDF speichern“ wählen, wenn du eine Datei möchtest. Hohe und quere Blätter werden dabei automatisch im richtigen Format gesetzt.</p>
    <section class="block"><h2>Prüfung</h2><div id="pruefung"></div></section>
    <section class="block"><h2>Planung</h2><ul class="druckliste">${liste('plan')}</ul></section>
    <section class="block"><h2>Hilfsmittel</h2><ul class="druckliste">${liste('hilfsmittel')}</ul></section>
    <section class="block"><h2>Optionen</h2>
      <label class="feld" style="flex-direction:row;align-items:center;gap:10px">
        <input type="checkbox" data-p="druck.skizzeAuto" data-typ="haken" ${p.druck.skizzeAuto ? 'checked' : ''} style="width:18px;height:18px;min-height:0;accent-color:var(--thw)">
        <span>Ortsskizzen der Marschskizze aus dem Streckenverlauf zeichnen <span class="hinweis">(aus = Felder frei, zum Einzeichnen von Hand)</span></span></label>
      <label class="feld" style="flex-direction:row;align-items:center;gap:10px;margin-top:8px">
        <input type="checkbox" data-p="druck.kartenHintergrund" data-typ="haken" ${p.druck.kartenHintergrund ? 'checked' : ''} style="width:18px;height:18px;min-height:0;accent-color:var(--thw)">
        <span>OpenStreetMap-Karte unter die Skizzen legen <span class="hinweis">(lädt Kartenkacheln von openstreetmap.org – daran ist der Streckenausschnitt erkennbar; aus = nur Linienzug, auch ohne Netz)</span></span></label>
    </section>
    <div class="leiste">
      <button type="button" class="knopf primaer" data-aktion="drucken" id="druck-los">Ausgewählte Blätter drucken / als PDF speichern</button>
      <button type="button" class="knopf" data-aktion="auswahl-plan">Nur Planung</button>
      <button type="button" class="knopf" data-aktion="auswahl-alle">Alle</button>
      <button type="button" class="knopf" data-aktion="auswahl-keine">Keine</button>
      <button type="button" class="knopf" data-aktion="sichern" title="Die ganze Planung als Datei speichern – die einzige Kopie liegt sonst nur in diesem Browser">Planung als Datei sichern</button>
    </div>
    ${/^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent) ? '<div class="vorgabe-hinweis">Safari setzt Hoch- und Querformat im Druckdialog nicht zuverlässig: Vor dem Drucken die Seitenvorschau prüfen, sonst die Ausrichtung dort von Hand wählen oder Chrome/Firefox nutzen.</div>' : ''}
    <div class="anleitung"><strong>PDF erzeugen:</strong>
      <ol><li>„Drucken“ wählen.</li><li>Im Druckdialog als Ziel „Als PDF speichern“ einstellen.</li><li>Papierformat A4, Skalierung „Standard“ bzw. 100 %, Ränder „Standard“. Kopf- und Fußzeilen des Browsers ausschalten.</li></ol></div>`;
}

/* ====================================================================
   Verzeichnis der Ansichten
   ==================================================================== */

const ANSICHTEN = [
  { id: 'eckdaten', titel: 'Eckdaten', html: vEckdaten, vorschau: 'marschtabelle' },
  { id: 'route', titel: 'Route', html: vRoute, vorschau: 'marschtabelle', nach: nachRoute },
  { id: 'kolonnen', titel: 'Kolonnen', html: vKolonnen, vorschau: 'belegung' },
  { id: 'auftrag', titel: 'Marschauftrag', html: vAuftrag, vorschau: 'marschauftrag' },
  { id: 'unterlagen', titel: 'Unterlagen', html: vUnterlagen, vorschau: 'unterlagen' },
  { id: 'hilfsmittel', titel: 'Hilfsmittel', html: vHilfsmittel, vorschau: 'hilfe' },
  { id: 'druck', titel: 'Drucken / PDF', html: vDruck, vorschau: null }
];
const ANSICHT_NACH_ID = Object.fromEntries(ANSICHTEN.map(a => [a.id, a]));

let ansicht = ANSICHT_NACH_ID[erinnern('mp.ansicht')] ? erinnern('mp.ansicht') : 'eckdaten';
let vorschauId = ANSICHT_NACH_ID[ansicht].vorschau || 'marschtabelle';
let karte = null;

function gehe(id, { vorschau = true } = {}) {
  if (!ANSICHT_NACH_ID[id]) return;
  ansicht = id;
  merken('mp.ansicht', id);
  const v = ANSICHT_NACH_ID[id].vorschau;
  if (vorschau && v) vorschauId = v;
  render();
  editor.scrollTop = 0;
}

function render() {
  const p = store.aktuell();
  const a = ANSICHT_NACH_ID[ansicht];
  if (karte) { karte.entfernen(); karte = null; }
  editor.innerHTML = a.html(p);
  editor.dataset.ansicht = ansicht;
  editor.querySelectorAll('input[type="number"]').forEach(pruefeFeld);
  a.nach?.(p);
  renderNav();
  renderChips();
  abgeleitetAktualisieren();
  vorschauAktualisieren();
  kopfAktualisieren();
}

function nachRoute(p) {
  try {
    karte = karteErzeugen($('#karte'), {
      beiKpVerschoben(id, lage) {
        const p = store.aktuell();
        const kp = p.route.kontrollpunkte.find(k => k.id === id);
        if (kp?.abseits && !confirm(`Punkt „${kp.ort || 'Platz'}“ liegt abseits der Strecke (Umweg ca. ${zahl(kp.umwegKm || 0, 1)} km).\n\nVerschieben legt ihn auf die Strecke und entfernt den Umweg aus dem Fahrplan. Fortfahren?`)) {
          karte?.neuZeichnen(p);                           // Marker zurück an seinen Platz
          return;
        }
        store.aendern(pp => { kpAnTrackSetzen(pp, id, lage); }, null, 'Punkt verschoben');
        routeAktualisieren();
        const sortiert = sortierteKp(store.aktuell().route);
        const nr = sortiert.findIndex(k => k.id === id) + 1;
        if (nr) meldung(`Punkt ${nr} auf km ${zahl(sortiert[nr - 1].km, 1)} verschoben.`, '', false, rueckgaengigAktion);
      },
      beiPlatz(platz, typ) { platzNehmen(platz.id, typ); },
      beiKpSetzen(km) {
        store.aendern(pp => { kpHinzufuegen(pp, km, 'kp'); }, null, 'Kontrollpunkt gesetzt');
        routeAktualisieren();
      }
    });
  } catch (err) {
    $('#karte').innerHTML = `<p style="padding:16px">Die Karte konnte nicht geladen werden (${e(err.message)}). Die Tabelle unten funktioniert trotzdem.</p>`;
  }
  $('#gpx-datei')?.addEventListener('change', async ev => {
    const datei = ev.target.files?.[0];
    ev.target.value = '';
    if (datei) await gpxLaden(datei);
  });
  routeAktualisieren();
  if (karte) { setTimeout(() => { karte.groesseNeu(); karte.einpassen(store.aktuell()); }, 60); }
}

/* ---------- Navigation und Kopf ---------- */

function renderNav() {
  const probleme = pruefung(store.aktuell()).filter(x => x.stufe !== 'hinweis');
  nav.innerHTML = ANSICHTEN.map((a, i) => {
    const betrifft = probleme.filter(x => a.id === 'druck' || x.ansicht === a.id);       // „Drucken“ zählt alles
    const marke = betrifft.length
      ? `<span class="nav-marke ${betrifft.some(x => x.stufe === 'fehler') ? 'fehler' : ''}" title="${betrifft.length} Hinweis(e) – siehe Prüfung unter „Drucken“">${betrifft.length}</span>` : '';
    return `<button type="button" class="nav-punkt" data-aktion="gehe" data-ziel="${a.id}" ${a.id === ansicht ? 'aria-current="page"' : ''}>
      <span class="nav-nr">${i + 1}</span><span>${e(a.titel)}</span>${marke}</button>`;
  }).join('');
}

function renderChips() {
  $('#chips').innerHTML = BLAETTER.map(b =>
    `<button type="button" role="tab" class="chip" data-vorschau="${b.id}" aria-selected="${b.id === vorschauId}">${e(b.titel)}</button>`).join('');
}

function kopfAktualisieren() {
  const p = store.aktuell();
  const name = $('#projektname');
  if (document.activeElement !== name) name.value = p.name;
  document.title = `${p.name || 'Marschplanung'} – Marschplaner`;
  $('#b-undo').disabled = !store.kannRueckgaengig();
  $('#b-redo').disabled = !store.kannWiederholen();
  $('#b-undo').title = store.kannRueckgaengig() ? `Rückgängig: ${store.rueckgaengigText() || 'letzte Änderung'} (Strg+Z)` : 'Nichts zum Rückgängigmachen';
  $('#b-redo').title = store.kannWiederholen() ? `Wiederholen: ${store.wiederholenText() || 'letzte Änderung'} (Strg+Umschalt+Z)` : 'Nichts zum Wiederholen';
  speicherstandAktualisieren();
}

function speicherstandAktualisieren() {
  const s = $('#speicherstand');
  if (store.speicherProbleme()) { s.textContent = '⚠ nicht gespeichert'; s.className = 'speicherstand fehler'; }
  else {
    const p = store.aktuell();
    s.textContent = `Im Browser gespeichert · ${sicherungText(p)}`;
    const alt = !store.gesichertAm(p.id) || Date.now() - Date.parse(store.gesichertAm(p.id)) > 7 * 864e5;
    s.className = `speicherstand${alt ? ' alt' : ''}`;
    s.title = 'Die Planung liegt nur in diesem Browser. „Planungen → Als Datei sichern“ legt eine Kopie an, die auch ein Browser-Reset oder ein anderer Rechner übersteht.';
  }
}

/* ---------- Vorschau ---------- */

function vorschauSichtbar() {
  return flaeche.offsetParent !== null;
}

function passeBlaetterAn() {
  const breite = flaeche.clientWidth - 24;
  if (breite <= 0) return;
  flaeche.querySelectorAll('.blatt').forEach(s => {
    s.style.zoom = '';
    s.style.zoom = String(Math.min(1, breite / s.offsetWidth));
  });
}

function vorschauZeichnen() {
  if (!vorschauSichtbar()) return;
  const p = store.aktuell();
  const oben = flaeche.scrollTop;
  try {
    flaeche.innerHTML = blattHtml(vorschauId, p);
  } catch (err) {
    console.error(err);
    flaeche.innerHTML = `<p style="padding:16px">Dieses Blatt konnte nicht aufgebaut werden: ${e(err.message)}</p>`;
  }
  passeBlaetterAn();
  flaeche.scrollTop = oben;
}

let vorschauRaf = 0;
function vorschauAktualisieren() {
  cancelAnimationFrame(vorschauRaf);
  vorschauRaf = requestAnimationFrame(vorschauZeichnen);
}

new ResizeObserver(() => passeBlaetterAn()).observe(flaeche);

/* ---------- Abgeleitete Werte im Formular ---------- */

function abgeleitetAktualisieren() {
  const p = store.aktuell();

  if (ansicht === 'route') {
    pausenAktualisieren();
    const fp = fahrplan(p, p.kolonnen[0] ?? null);
    for (const z of fp.zeilen) {
      const zelle = editor.querySelector(`[data-an="${z.kp.id}"]`);
      if (zelle) zelle.textContent = fp.ablaufFehlt ? '–' : (z.halt > 0 ? `${zeitText(z.an)} – ${zeitText(z.ab)}` : zeitText(z.an));
    }
    const info = $('#route-info');
    if (info) {
      const hat = p.route.track.length > 1;
      info.innerHTML = hat
        ? `<strong>${e(p.route.name || 'Route')}</strong> · Strecke ${zahl(trackKm(p.route), 1)} km (${p.route.track.length} Punkte im Verlauf) · ${p.route.kontrollpunkte.length} Kontrollpunkte${p.route.arten ? (offeneStuecke(p.route.arten) ? ` · Straßenarten teilweise (${offeneStuecke(p.route.arten)} Stück(e) offen)` : ' · Straßenarten aus Kartendaten (OSM)') : ''}${fp.zeilen.length > 1 ? ` · Marschzeit ${dauerText(fp.ende - fp.start)}` : ''}`
        : `Kein Streckenverlauf geladen${p.route.kontrollpunkte.length ? ` · ${p.route.kontrollpunkte.length} Kontrollpunkte von Hand` : ''}.`;
      const warn = [];
      if (fp.ablaufFehlt) warn.push('⚠ Die Ablaufzeit fehlt – Ankunftszeiten sind nicht verfügbar. <button type="button" class="knopf klein" data-aktion="gehe" data-ziel="eckdaten">Eckdaten öffnen</button>');
      if (hat && (!p.route.arten || offeneStuecke(p.route.arten))) {
        warn.push(`⚠ ${p.route.arten ? 'Straßenarten nur teilweise ermittelt' : 'Straßenarten nicht ermittelt'} – nicht ermittelte Abschnitte rechnen mit der eingetragenen Straßenart (Vorgabe Bundes-/Landstraße), die Fahrzeiten können abweichen.${fehlerArten ? ' ' + e(fehlerArten) : ''} <button type="button" class="knopf klein" data-aktion="strassenarten">${p.route.arten ? 'Fehlende nachholen' : 'Jetzt ermitteln'}</button>`);
      }
      info.innerHTML += warn.map(w => `<div class="vorgabe-hinweis fehler" style="margin:8px 0 0">${w}</div>`).join('');
    }
  }

  if (ansicht === 'kolonnen') {
    for (const k of p.kolonnen) {
      const ziel = editor.querySelector(`[data-k-ergebnis="${k.id}"]`);
      if (!ziel) continue;
      const n = (k.einzel || 0) + (k.gespanne || 0);
      const l = (id) => kolonnenLaenge(p.parameter, k, id);
      ziel.innerHTML = n
        ? `<strong>${n}</strong> Fahrzeuge · Marschlänge ${KLASSEN.map(c => `${c.kurz} <strong>${zahl(l(c.id), 0)} m</strong>`).join(' · ')}
           · Durchlaufzeit (BuL) <strong>${sekundenText(durchlaufMin(l('bul'), p.parameter.v.bul) * 60)}</strong>`
        : 'Noch keine Fahrzeuge eingetragen.';
    }
    const w = $('#kolonnen-warnung');
    if (w) {
      const konf = pruefung(p).filter(x => x.ansicht === 'kolonnen' && /zugleich/.test(x.text));
      w.innerHTML = konf.length ? meldungsListe(konf, false) : '';
    }
  }

  if (ansicht === 'auftrag') {
    const auto = autoAuftrag(p);
    editor.querySelectorAll('[data-auto-f]').forEach(el => {
      const f = el.dataset.autoF;
      el.hidden = !(String(p.auftrag[f] ?? '').trim() && String(p.auftrag[f]).trim() !== String(auto[f] ?? '').trim());
    });
  }

  if (ansicht === 'hilfsmittel') {
    const r = marschHilfe(p.hilfsmittel.rechner);
    const zeit = r.marschzeitMin === null ? null : `${Math.floor(r.marschzeitMin / 60)}:${String(r.marschzeitMin % 60).padStart(2, '0')} h`;
    const kasten = (name, wert) => `<div><dt>${name}</dt><dd class="${wert ? '' : 'leer'}">${wert ? e(wert) : 'Pflichtfelder fehlen'}</dd></div>`;
    const ziel = $('#rechner-ergebnis');
    if (ziel) ziel.innerHTML =
      kasten('Marschlänge', r.laengeM === null ? null : `${zahl(r.laengeM, 0)} m`) +
      kasten('Marschzeit', zeit) +
      kasten('Durchlaufzeit', r.durchlaufSek === null ? null : sekundenText(r.durchlaufSek));
  }

  if (ansicht === 'druck') {
    const z = $('#pruefung');
    if (z) z.innerHTML = meldungsListe(pruefung(p));
  }
}

/* ====================================================================
   Eingaben
   ==================================================================== */

editor.addEventListener('input', ev => {
  const el = ev.target;
  const pfad = el.dataset?.p;
  if (!pfad) return;
  let wert;
  if (el.dataset.typ === 'haken') wert = el.checked;
  else if (el.dataset.typ === 'zahl') {
    const n = parseFloat(el.value);
    wert = el.value === '' || Number.isNaN(n) ? '' : n;
  } else wert = el.value;
  store.aendern(p => store.setzePfad(p, pfad, wert), pfad);
  pruefeFeld(el);
});

/** Markiert eine Zahl außerhalb des erlaubten Bereichs am Feld – sie wird gespeichert, aber nicht stillschweigend hingenommen */
function pruefeFeld(el) {
  if (el.type !== 'number') return;
  const schlecht = !!el.validity && (el.validity.rangeUnderflow || el.validity.rangeOverflow || el.validity.badInput);
  el.classList.toggle('ungueltig', schlecht);
  el.setAttribute('aria-invalid', schlecht ? 'true' : 'false');
  el.dataset.titel0 ??= el.title || '';
  el.title = schlecht ? `Außerhalb des erlaubten Bereichs (${el.min !== '' ? el.min : '…'} bis ${el.max !== '' ? el.max : '…'})` : el.dataset.titel0;
}

editor.addEventListener('change', ev => {
  const el = ev.target;

  if (el.dataset.u && el.dataset.rolle) {                        // Unterlagenverteilung
    store.aendern(p => {
      const z = p.unterlagen.zeilen.find(x => x.id === el.dataset.u);
      if (!z) return;
      z.rollen = z.rollen.filter(r => r !== el.dataset.rolle);
      if (el.checked) z.rollen.push(el.dataset.rolle);
    });
    return;
  }
  if (el.dataset.druck) {                                         // Auswahl zum Drucken
    if (el.checked) druckAuswahl.add(el.dataset.druck); else druckAuswahl.delete(el.dataset.druck);
    return;
  }
  if (el.dataset.nachsort) {                                      // Kilometerstand geändert → neu einsortieren
    store.aendern(p => kpOrdnen(p));
    routeAktualisieren();
    return;
  }
  if (el.dataset.neu) render();                                   // Art des Punkts geändert → Vorgaben neu zeigen
  if (el.dataset.p === 'druck.skizzeAuto' || el.dataset.p === 'druck.kartenHintergrund') vorschauAktualisieren();
});

$('#projektname').addEventListener('input', ev => {
  const wert = ev.target.value;
  store.aendern(p => { p.name = wert; }, 'name');
});

/* ====================================================================
   Aktionen
   ==================================================================== */

const typName = (typ) => TYP_NAME[typ] || '';

const AKTIONEN = {
  gehe(el) { gehe(el.dataset.ziel); },

  'gpx-waehlen'() { $('#gpx-datei')?.click(); },

  beispiel() {
    const p = store.aktuell();
    const leer = !p.route.kontrollpunkte.length && !p.route.track.length
      && Object.values(p.kopf).every(v => !v)
      && p.kolonnen.every(k => !((k.einzel || 0) + (k.gespanne || 0)) && !k.marschfolge);
    if (!leer && !confirm('Das Beispiel ersetzt Route, Kolonnen und Eckdaten dieser Planung. Fortfahren?\n\n(Unter „Planungen → Beispiel“ lässt es sich stattdessen als eigene Planung anlegen.)')) return;
    store.aendern(pp => { beispielFuellen(pp, leseGpx); }, null, 'Beispiel geladen');
    render();
    meldung('Beispielplanung geladen – Schematische Route, keine echten Straßen.', '', false, leer ? null : rueckgaengigAktion);
  },

  'kp-neu'() {
    const p = store.aktuell();
    const kps = sortierteKp(p.route);
    let km = kps.length ? kps[kps.length - 1].km : 0;
    if (kps.length >= 2) {                         // in die längste Lücke setzen
      let beste = 0;
      for (let i = 1; i < kps.length; i++) {
        if (kps[i].km - kps[i - 1].km > beste) { beste = kps[i].km - kps[i - 1].km; km = (kps[i].km + kps[i - 1].km) / 2; }
      }
    } else if (kps.length === 1) km += 10;
    store.aendern(pp => { kpHinzufuegen(pp, Math.round(km * 10) / 10, kps.length ? 'kp' : 'ablauf'); });
    routeAktualisieren();
  },

  'kp-loeschen'(el) {
    const kps = sortierteKp(store.aktuell().route);
    const i = kps.findIndex(k => k.id === el.dataset.id);
    const kp = kps[i];
    if (!kp) return;
    const bezeichnung = `Punkt ${i + 1}${kp.ort ? ` („${kp.ort}“)` : ''}`;
    const rolle = kp.typ === 'ablauf' ? 'Ablaufpunkt' : kp.typ === 'ziel' ? 'Zielpunkt' : '';
    if (rolle && !confirm(`${bezeichnung} ist der ${rolle}. Wirklich entfernen?\n\nDer nächste Punkt übernimmt dann diese Rolle; die Zeiten verschieben sich.`)) return;
    store.aendern(p => kpEntfernen(p, kp.id), null, `${bezeichnung} entfernt`);
    routeAktualisieren();
    meldung(`${bezeichnung} entfernt.`, '', false, rueckgaengigAktion);
  },

  'route-loeschen'() {
    const p = store.aktuell();
    const n = p.route.kontrollpunkte.length;
    const mit = [p.route.arten && 'die ermittelten Straßenarten', p.route.plaetze && 'die gefundenen Plätze'].filter(Boolean);
    if (!confirm(`Streckenverlauf und ${n} Kontrollpunkt(e) dieser Planung entfernen?${mit.length ? `\n\nAuch ${mit.join(' und ')} gehen weg; die Abfragen bei OpenStreetMap müssten neu laufen.` : ''}\n\nMit „Rückgängig“ lässt sich das zurückholen.`)) return;
    store.aendern(pp => routeLoeschen(pp), null, 'Route entfernt');
    render();
    meldung('Route entfernt.', '', false, rueckgaengigAktion);
  },

  'gpx-export'() {
    const p = store.aktuell();
    if (p.route.track.length < 2) { meldung('Keine Strecke zum Exportieren – zuerst eine Route laden.', 'fehler'); return; }
    const punkte = sortierteKp(p.route).map((k, i) => {
      const lage = k.abseits ? [k.abseits.lat, k.abseits.lon] : punktBeiKm(p.route.track, k.km);
      return lage && {
        name: `${i + 1} ${k.ort || typName(k.typ)}`, lat: lage[0], lon: lage[1],
        text: [typName(k.typ), k.bemerkung].filter(Boolean).join(', ')
      };
    }).filter(Boolean);
    download(`${pdfName(p)}.gpx`, schreibeGpx({ name: p.route.name || p.name, track: p.route.track, punkte }), 'application/gpx+xml');
    meldung(`GPX-Datei mit Strecke und ${punkte.length} Punkten gespeichert.`);
  },

  sichern() { planungSichern(); },

  'auftrag-auto'(el) {
    const f = el.dataset.f;
    store.aendern(p => { p.auftrag[f] = ''; }, null, 'Auftragsfeld wieder automatisch');
    render();
  },

  'orte-ermitteln'() { orteErmitteln(); },
  strassenarten() { strassenartenErmitteln(); },
  'plaetze-suchen'() { plaetzeSuchen(); },
  'platz-nehmen'(el) { platzNehmen(el.dataset.id, el.dataset.typ); },

  'k-neu'() {
    store.aendern(p => {
      const letzte = p.kolonnen[p.kolonnen.length - 1];
      const k = neueKolonne(p.kolonnen.length + 1);
      k.versatzMin = (letzte?.versatzMin || 0) + 15;
      k.einzel = letzte?.einzel || 0;
      k.gespanne = letzte?.gespanne || 0;
      p.kolonnen.push(k);
    });
    render();
  },
  'k-dup'(el) {
    store.aendern(p => {
      const i = p.kolonnen.findIndex(k => k.id === el.dataset.id);
      if (i < 0) return;
      const kopie = { ...p.kolonnen[i], id: neueId('k'), name: `${p.kolonnen[i].name} (Kopie)`, versatzMin: (p.kolonnen[i].versatzMin || 0) + 15 };
      p.kolonnen.splice(i + 1, 0, kopie);
    });
    render();
  },
  'k-weg'(el) {
    const p = store.aktuell();
    if (p.kolonnen.length < 2) return;
    const name = p.kolonnen.find(k => k.id === el.dataset.id)?.name || 'Kolonne';
    store.aendern(pp => { pp.kolonnen = pp.kolonnen.filter(k => k.id !== el.dataset.id); }, null, `${name} entfernt`);
    render();
    meldung(`${name} entfernt.`, '', false, rueckgaengigAktion);
  },

  'u-neu'() {
    store.aendern(p => { p.unterlagen.zeilen.push({ id: neueId('u'), name: '', rollen: [] }); });
    render();
    editor.querySelector('[data-u]:last-of-type')?.closest('tbody')?.lastElementChild?.querySelector('input[type=text]')?.focus();
  },
  'u-weg'(el) {
    store.aendern(p => { p.unterlagen.zeilen = p.unterlagen.zeilen.filter(z => z.id !== el.dataset.id); }, null, 'Unterlage entfernt');
    render();
    meldung('Unterlage entfernt.', '', false, rueckgaengigAktion);
  },
  'u-standard'() {
    if (!confirm('Die Unterlagenverteilung auf die Vorlage zurücksetzen? Eigene Änderungen gehen verloren.')) return;
    store.aendern(p => {
      p.unterlagen.zeilen = UNTERLAGEN_STANDARD.map(z => ({ id: neueId('u'), name: z.name, rollen: [...z.rollen] }));
    });
    render();
  },

  'rechner-uebernehmen'() {
    store.aendern(p => {
      const r = p.hilfsmittel.rechner;
      const fp = fahrplan(p, p.kolonnen[0] ?? null);
      r.einzel = p.kolonnen.reduce((s, k) => s + (+k.einzel || 0), 0);
      r.gespanne = p.kolonnen.reduce((s, k) => s + (+k.gespanne || 0), 0);
      r.v = p.parameter.v.bul;
      r.kolonnen = p.kolonnen.length;
      r.km = Math.round(fp.kmGesamt * 10) / 10;
      r.unterbrechung = fp.haltMinGesamt;
      r.abstand = p.parameter.abstand.bul;
      r.laengeEinzel = p.parameter.laengeEinzel;
      r.laengeGespann = p.parameter.laengeGespann;
    });
    render();
    meldung('Werte aus der Planung übernommen (Geschwindigkeit und Abstand der Bundes- und Landstraße).');
  },

  ansehen(el) { vorschauId = el.dataset.id; renderChips(); vorschauAktualisieren(); document.body.classList.add('vorschau-offen'); },

  'auswahl-plan'() { druckAuswahl = new Set(BLAETTER.filter(b => b.gruppe === 'plan').map(b => b.id)); render(); },
  'auswahl-alle'() { druckAuswahl = new Set(BLAETTER.map(b => b.id)); render(); },
  'auswahl-keine'() { druckAuswahl = new Set(); render(); },

  drucken() { drucke(); }
};

async function drucke() {
  const p = store.aktuell();
  const ids = BLAETTER.filter(b => druckAuswahl.has(b.id)).map(b => b.id);
  if (!ids.length) { meldung('Bitte mindestens ein Blatt auswählen.', 'fehler'); return; }
  const probleme = pruefung(p).filter(x => x.stufe !== 'hinweis');
  if (probleme.length) {
    const fehler = probleme.some(x => x.stufe === 'fehler');
    const liste = probleme.slice(0, 8).map(x => `• ${x.text}`).join('\n') + (probleme.length > 8 ? `\n• … und ${probleme.length - 8} weitere` : '');
    if (!confirm(`${fehler ? 'Die Planung ist noch unvollständig' : 'Die Planung hat Auffälligkeiten'}:\n\n${liste}\n\nTrotzdem drucken?`)) return;
  }
  let pDruck = p;
  if (p.druck.kartenHintergrund && ids.includes('marschskizze') && erinnern('mp.kacheln') !== 'ja') {
    if (confirm('Kartenhintergrund laden?\n\nDazu lädt dein Browser Kartenkacheln von tile.openstreetmap.org. Daran lässt sich erkennen, welchen Ausschnitt – also welche Strecke – du druckst. Die Zustimmung wird in diesem Browser gemerkt und lässt sich unter „Planungen“ widerrufen.\n\nOK = mit Karte\nAbbrechen = ohne Karte (nur Linienzug)')) merken('mp.kacheln', 'ja');
    else pDruck = ohneKarte(p);
  }
  if (pDruck.druck.kartenHintergrund && ids.includes('marschskizze')) meldung('Kartenausschnitte werden geladen …', '', true);
  await drucken(ids, pDruck, {
    beiFehlenden: async ({ gesamt, fehlend }) => (confirm(
      `${fehlend} von ${gesamt} Kartenkacheln konnten nicht geladen werden (kein oder langsames Netz).\n\nOK = ohne Kartenhintergrund drucken (nur Linienzug, immer lesbar)\nAbbrechen = Druck abbrechen und später erneut versuchen`) ? 'ohne' : 'abbruch')
  });
  $('#toast').className = 'toast';
}

document.addEventListener('click', ev => {
  const el = ev.target.closest('[data-aktion]');
  if (el && AKTIONEN[el.dataset.aktion]) { ev.preventDefault(); AKTIONEN[el.dataset.aktion](el); return; }
  const chip = ev.target.closest('[data-vorschau]');
  if (chip) { vorschauId = chip.dataset.vorschau; renderChips(); vorschauAktualisieren(); }
});

/* ---------- Kopfleiste ---------- */

$('#b-undo').addEventListener('click', () => store.rueckgaengig());
$('#b-redo').addEventListener('click', () => store.wiederholen());
$('#b-druck').addEventListener('click', () => gehe('druck'));
$('#b-projekte').addEventListener('click', () => projektDialog());
$('#b-vorschau').addEventListener('click', () => {
  if (matchMedia('(max-width: 1180px)').matches) document.body.classList.toggle('vorschau-offen');
  else document.body.classList.toggle('vorschau-aus');
  vorschauAktualisieren();
  setTimeout(() => karte?.groesseNeu(), 50);
});
addEventListener('resize', () => { karte?.groesseNeu(); });

addEventListener('keydown', ev => {
  const inFeld = /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName);
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'z' && !inFeld) {
    ev.preventDefault();
    if (ev.shiftKey) store.wiederholen(); else store.rueckgaengig();
  }
  if (ev.key === 'Escape') document.body.classList.remove('vorschau-offen');
});

/* ---------- GPX ---------- */

async function gpxLaden(datei) {
  let gpx;
  try {
    if (datei.size > 30 * 1024 * 1024) throw new Error('Die Datei ist größer als 30 MB.');
    gpx = leseGpx(await datei.text());
  } catch (err) {
    meldung(err.message || 'Die Datei konnte nicht gelesen werden.', 'fehler');
    return;
  }
  const p = store.aktuell();
  const ersetzt = p.route.kontrollpunkte.length > 0;
  if (ersetzt && !confirm('Die vorhandene Route und alle Kontrollpunkte – auch von Hand ergänzte Halte, Ortsnamen und Bemerkungen – werden durch die GPX-Datei ersetzt.\n\nMit „Rückgängig“ lässt sich das zurückholen. Fortfahren?')) return;
  let ergebnis;
  try {
    store.aendern(pp => { ergebnis = routeAusGpx(pp, gpx); }, null, 'GPX-Route geladen');
  } catch (err) {
    meldung(err.message, 'fehler');
    return;
  }
  if (ansicht !== 'route') gehe('route'); else render();
  const extra = ergebnis.verworfen ? ` · ${ergebnis.verworfen} Wegpunkt(e) weit abseits der Strecke ignoriert` : '';
  meldung(`Route geladen: ${zahl(ergebnis.laengeKm, 1)} km, ${ergebnis.punkte} Kontrollpunkte${extra}`, '', false, ersetzt ? rueckgaengigAktion : null);
  strassenartenErmitteln({ automatisch: true });
}

addEventListener('dragover', ev => {
  if (![...(ev.dataTransfer?.types || [])].includes('Files')) return;
  ev.preventDefault();
  document.body.classList.add('zieht');
});
addEventListener('dragleave', ev => { if (!ev.relatedTarget) document.body.classList.remove('zieht'); });
addEventListener('drop', async ev => {
  document.body.classList.remove('zieht');
  const datei = ev.dataTransfer?.files?.[0];
  if (!datei) return;
  ev.preventDefault();
  if (/\.gpx$/i.test(datei.name) || /gpx/.test(datei.type)) await gpxLaden(datei);
  else if (/\.json$/i.test(datei.name)) await planungLesen(datei);
  else meldung('Nur GPX-Dateien (Route) und Marschplaner-Dateien (.json) werden gelesen.', 'fehler');
});

/* ---------- Ortsnamen (optional, mit Rückfrage) ---------- */

let ortslauf = null;
async function orteErmitteln() {
  if (ortslauf) return;
  const p = store.aktuell();
  const ziele = sortierteKp(p.route).filter(k => !k.ort && kpPosition(p.route, k));
  if (!ziele.length) { meldung('Alle Kontrollpunkte haben bereits einen Ortsnamen.'); return; }
  if (navigator.onLine === false) { meldung('Kein Netz – Ortsnamen später ermitteln oder von Hand eintragen.', 'fehler'); return; }
  if (!confirm(`Für ${ziele.length} Punkt(e) wird der Ortsname bei OpenStreetMap (nominatim.openstreetmap.org) abgefragt. Dabei werden deren Koordinaten übertragen. Fortfahren?`)) return;
  const abbr = new AbortController();
  ortslauf = abbr;
  let gefunden = 0, fehler = 0, letzter = null;
  try {
    for (const [i, kp] of ziele.entries()) {
      if (abbr.signal.aborted) throw abbruchFehler();
      laufMeldung(`Ortsnamen: ${i + 1} von ${ziele.length} …`, abbr);
      const lage = kpPosition(store.aktuell().route, kp);
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&accept-language=de&lat=${lage[0].toFixed(5)}&lon=${lage[1].toFixed(5)}`;
      try {
        const antwort = await fetch(url, { headers: { Accept: 'application/json' }, signal: zeitgrenze(15000, abbr.signal) });
        if (!antwort.ok) throw new Error(`antwortet mit ${antwort.status}`);
        const a = (await antwort.json()).address || {};
        const name = a.city || a.town || a.village || a.municipality || a.suburb || a.county || '';
        if (name) {
          store.aendern(pp => { const k = pp.route.kontrollpunkte.find(x => x.id === kp.id); if (k && !k.ort) k.ort = name; }, null, 'Ortsname ergänzt');
          gefunden++;
          if (ansicht === 'route') routeAktualisieren();
        }
      } catch (err) {
        if (abbr.signal.aborted) throw abbruchFehler();
        fehler++; letzter = err;                        // ein Punkt darf fehlen, die übrigen zählen
        if (fehler >= 3 && !gefunden) throw letzter;      // dreimal in Folge nichts: der Dienst ist nicht erreichbar
      }
      if (i < ziele.length - 1) await schlafen(1100, abbr.signal);     // Nutzungsrichtlinie: höchstens 1 Anfrage/s
    }
    meldung(`${gefunden} von ${ziele.length} Ortsnamen ergänzt – bitte prüfen.${fehler ? ` ${fehler} Abfrage(n) schlugen fehl; die übrigen Namen von Hand eintragen oder erneut ermitteln.` : ''}`, fehler ? 'fehler' : '');
  } catch (err) {
    if (err.name === 'Abbruch') meldung(`Ortsnamen abgebrochen – ${gefunden} ergänzt.`);
    else meldung(`Ortsnamen konnten nicht abgefragt werden. ${fehlerText(letzter || err)} Die Namen lassen sich auch von Hand eintragen.`, 'fehler');
  } finally {
    ortslauf = null;
  }
}

/* ---------- Straßenarten aus OpenStreetMap ---------- */

let artenlauf = null;
async function strassenartenErmitteln({ automatisch = false } = {}) {
  if (artenlauf) return;
  const p = store.aktuell();
  if (p.route.track.length < 2) { meldung('Zuerst eine Route laden.', 'fehler'); return; }

  // Was schon abgefragt ist, bleibt gespeichert: ein neuer Lauf holt nur die Lücken.
  const laenge = trackKm(p.route);
  let vorhanden = passtZu(p.route.arten, laenge) ? p.route.arten : null;
  if (vorhanden && !offeneStuecke(vorhanden)) {
    if (!confirm('Alle Streckenstücke sind bereits ermittelt. Trotzdem alles neu bei OpenStreetMap abfragen?')) return;
    vorhanden = null;
  }

  if (navigator.onLine === false) {
    fehlerArten = 'Kein Netz – später erneut ermitteln.';
    if (ansicht === 'route') routeAktualisieren();
    meldung(`Kein Netz – die Straßenarten brauchen eine Verbindung.${automatisch ? ' Alle Abschnitte gelten bis dahin als Bundes-/Landstraße.' : ''}`, 'fehler');
    return;
  }
  if (erinnern('mp.overpass') !== 'ja') {
    const ok = confirm('Straßenarten erkennen?\n\nDazu wird der Streckenverlauf deiner Planung (vereinfacht) in Stücken an einen Kartendienst (Overpass, overpass-api.de, OpenStreetMap) gesendet, um die Straßen entlang der Route abzufragen. Die Zustimmung wird in diesem Browser gemerkt und lässt sich unter „Planungen“ widerrufen.\n\nOhne Zustimmung rechnet der Marschplaner alle Abschnitte als Bundes-/Landstraße; die Straßenart lässt sich dann von Hand setzen.');
    if (!ok) { fehlerArten = ''; if (automatisch) meldung('Straßenarten nicht ermittelt – alle Abschnitte gelten als Bundes-/Landstraße.'); if (ansicht === 'route') routeAktualisieren(); return; }
    merken('mp.overpass', 'ja');
  }

  // Beim ersten Ermitteln stellen alle Abschnitte auf „Auto (OSM)“ um – von Hand gesetzte Arten nicht ohne Rückfrage
  const frisch = !passtZu(p.route.arten, laenge);
  let handBehalten = false;
  if (frisch) {
    const hand = handArten(p);
    if (hand > 0) handBehalten = !confirm(`${hand} Abschnitt(e) haben eine von Hand gesetzte Straßenart (BAB/Ort).\n\nOK = durch die Straßenarten aus den Kartendaten ersetzen\nAbbrechen = von Hand gesetzte behalten (nur die übrigen Abschnitte rechnen nach Kartendaten)`);
    store.aendern(() => {}, null, 'Straßenarten ermittelt');            // ein Rückgängig-Schritt für das Umstellen
  }
  let umgestellt = !frisch;

  const abbr = new AbortController();
  artenlauf = abbr;
  const id = p.id, track = p.route.track;
  const gleichePlanung = () => { const j = store.aktuell(); return j.id === id && j.route.track === track; };
  try {
    const arten = await analysiere(track, {
      vorhanden, signal: abbr.signal,
      fortschritt: (fertig, gesamt, hinweis) => {
        const offen = vorhanden ? ` (nur fehlende Stücke)` : '';
        laufMeldung(fertig < gesamt
          ? `Straßenarten werden abgefragt … Stück ${fertig + 1} von ${gesamt}${offen}${hinweis ? ' – ' + hinweis : ''}`
          : 'Straßenarten werden ausgewertet …', abbr);
      },
      beiStueck: (zwischenstand) => {                       // jedes fertige Stück sofort sichern
        if (!gleichePlanung()) throw abbruchFehler('Die Planung wurde gewechselt.');
        store.aendernStill(pp => {
          pp.route.arten = structuredClone(zwischenstand);
          if (!umgestellt) { artenUebernehmen(pp, pp.route.arten, { handBehalten }); umgestellt = true; }
        });
        if (ansicht === 'route') { routeAktualisieren(); }
      }
    });
    if (!gleichePlanung()) { meldung('Die Planung hat sich während der Abfrage geändert – Zwischenstand verworfen.', 'fehler'); return; }
    fehlerArten = '';
    if (ansicht === 'route') { routeAktualisieren(); renderNav(); }
    const km = trackKm(store.aktuell().route);
    const a = anteileImAbschnitt(arten, 0, km);
    const offen = offeneStuecke(arten);
    const text = `Straßenarten: BAB ${zahl(a.anteile.bab, 0)} km · BuL ${zahl(a.anteile.bul, 0)} km · Ort ${zahl(a.anteile.ort, 0)} km`
      + (offen ? ` – ${offen} von ${arten.fertig.length} Streckenstücken noch offen (Kartendienst überlastet); „Straßenarten neu ermitteln“ holt nur diese nach` : '')
      + (!offen && a.unbekannt > km * 0.1 ? ` – für ${zahl(a.unbekannt, 0)} km fand OSM keine Straße nahe der Route (zählt als BuL)` : '');
    meldung(text, offen || a.unbekannt > km * 0.1 ? 'fehler' : '');
  } catch (err) {
    const offen = offeneStuecke(store.aktuell().route.arten);
    if (err.name === 'Abbruch') {
      const vomNutzer = err.message === 'Abgebrochen.';
      meldung(vomNutzer ? 'Abgebrochen – Bisheriges bleibt gespeichert, „Straßenarten neu ermitteln“ setzt fort.' : err.message, vomNutzer ? '' : 'fehler');
    } else {
      fehlerArten = fehlerText(err);
      meldung(`Straßenarten konnten nicht abgefragt werden. ${fehlerText(err)}` + (offen
        ? ` Bisher Ermitteltes bleibt gespeichert – „Straßenarten neu ermitteln“ setzt fort.` : ' Die Abschnitte gelten bis dahin als Bundes-/Landstraße.'), 'fehler');
    }
    if (ansicht === 'route') routeAktualisieren();
  } finally {
    artenlauf = null;
  }
}

/* ---------- Planungen verwalten ---------- */

async function planungLesen(datei) {
  try {
    const p = store.ausJson(await datei.text());
    meldung(`Neue Planung „${p.name}“ angelegt – die bisherige Planung bleibt unverändert und ist unter „Planungen“ wieder da.`);
  } catch (err) {
    meldung(err.message, 'fehler');
  }
}

function planungSichern() {
  const p = store.aktuell();
  download(`${pdfName(p)}.marschplan.json`, store.alsJson(), 'application/json');
  store.gesichertMarkieren(p.id);
  meldung('Planung als Datei gesichert.');
}

const datumKurz = (iso) => (iso || '').slice(0, 10).split('-').reverse().join('.');

function projektDialog() {
  const d = $('#dialog');
  const akt = store.aktuell();
  const zeilen = store.liste().map(x => `<li class="${x.id === akt.id ? 'aktiv' : ''}">
    <span class="name" title="${e(x.name)}">${e(x.name || 'Ohne Namen')}</span>
    <span class="meta">${e(datumKurz(x.geaendert))} · ${x.punkte} Punkte</span>
    ${x.id === akt.id ? '<span class="meta">geöffnet</span>' : `<button type="button" class="knopf klein" data-p-oeffnen="${x.id}">Öffnen</button>`}
    <button type="button" class="knopf klein gefahr nur-symbol abstand-links" data-p-weg="${x.id}" aria-label="Planung löschen (landet im Papierkorb)" title="Löschen – die Planung landet im Papierkorb">✕</button></li>`).join('');
  const korb = store.papierkorbListe().map(x => `<li>
    <span class="name" title="${e(x.name)}">${e(x.name || 'Ohne Namen')}</span>
    <span class="meta">gelöscht ${e(datumKurz(x.geloeschtAm))} · ${x.punkte} Punkte</span>
    <button type="button" class="knopf klein" data-p-zurueck="${x.id}">Wiederherstellen</button></li>`).join('');
  const zustimmung = (schluessel, name, was) => `<li>
    <span class="name" title="${e(was)}">${e(name)}</span>
    <span class="meta">${erinnern(schluessel) === 'ja' ? 'erteilt' : 'nicht erteilt'}</span>
    ${erinnern(schluessel) === 'ja' ? `<button type="button" class="knopf klein" data-p-widerruf="${schluessel}">Widerrufen</button>` : ''}</li>`;
  d.innerHTML = `
    <div class="dialog-kopf"><h2>Planungen</h2><button type="button" class="knopf klein" data-p-zu>Schließen</button></div>
    <div class="dialog-inhalt">
      <ul class="projektliste">${zeilen}</ul>
      <div class="leiste">
        <button type="button" class="knopf primaer" data-p-neu>＋ Neue Planung</button>
        <button type="button" class="knopf" data-p-dup>Duplizieren</button>
        <button type="button" class="knopf" data-p-beispiel>Beispiel</button>
      </div>
      ${korb ? `<h3 style="font-size:14px;margin:14px 0 8px">Zuletzt gelöscht</h3>
        <p class="hinweis" style="margin:0 0 8px">Die letzten gelöschten Planungen bleiben hier erhalten.</p>
        <ul class="projektliste">${korb}</ul>` : ''}
      <h3 style="font-size:14px;margin:14px 0 8px">Sichern und weitergeben</h3>
      <p class="hinweis" style="margin:0 0 8px">Planungen liegen nur in diesem Browser – ein Browser-Reset oder ein anderer Rechner kennt sie nicht. Zum Sichern oder Weitergeben als Datei speichern; sie lässt sich hier wieder laden. Aktuelle Planung: ${e(sicherungText(akt))}.</p>
      <div class="leiste">
        <button type="button" class="knopf" data-p-export>Als Datei sichern (.json)</button>
        <button type="button" class="knopf" data-p-import>Datei laden …</button>
        <input type="file" id="p-datei" accept=".json,application/json" hidden>
      </div>
      <h3 style="font-size:14px;margin:14px 0 8px">Datenübertragung</h3>
      <p class="hinweis" style="margin:0 0 8px">Sonst bleibt alles auf diesem Gerät. Diese Zustimmungen werden in diesem Browser gemerkt; nach dem Widerruf fragt der Marschplaner wieder nach.</p>
      <ul class="projektliste">
        ${zustimmung('mp.overpass', 'Straßen- und Platzsuche (Overpass, OpenStreetMap)', 'Der vereinfachte Streckenverlauf wird in Stücken an overpass-api.de gesendet.')}
        ${zustimmung('mp.kacheln', 'Kartenhintergrund beim Drucken (openstreetmap.org)', 'Der Browser lädt Kartenkacheln; daraus ist der Streckenausschnitt erkennbar.')}
      </ul>
    </div>`;
  if (!d.open) d.showModal();
}

$('#dialog').addEventListener('click', async ev => {
  const d = $('#dialog');
  const t = ev.target.closest('button');
  if (!t) { if (ev.target === d) d.close(); return; }
  if ('pZu' in t.dataset) d.close();
  else if (t.dataset.pOeffnen) { store.oeffnen(t.dataset.pOeffnen); d.close(); }
  else if (t.dataset.pWeg) {
    const info = store.liste().find(x => x.id === t.dataset.pWeg);
    if (confirm(`Planung „${info?.name || 'Ohne Namen'}“ löschen?\n\n${info?.punkte ?? 0} Kontrollpunkte, zuletzt geändert ${datumKurz(info?.geaendert)}.\n\nSie landet im Papierkorb (weiter unten in diesem Fenster) und lässt sich dort wiederherstellen.`)) {
      store.loeschen(t.dataset.pWeg);
      projektDialog();
    }
  }
  else if (t.dataset.pZurueck) { const p = store.wiederherstellen(t.dataset.pZurueck); d.close(); if (p) meldung(`Planung „${p.name}“ wiederhergestellt.`); }
  else if (t.dataset.pWiderruf) { vergessen(t.dataset.pWiderruf); projektDialog(); }
  else if ('pNeu' in t.dataset) { store.neu('Neue Marschplanung'); d.close(); }
  else if ('pDup' in t.dataset) { store.duplizieren(); d.close(); }
  else if ('pBeispiel' in t.dataset) { store.neu('Beispiel'); store.aendern(p => { beispielFuellen(p, leseGpx); }); d.close(); }
  else if ('pExport' in t.dataset) { planungSichern(); projektDialog(); }
  else if ('pImport' in t.dataset) { $('#p-datei').click(); }
});
$('#dialog').addEventListener('change', async ev => {
  if (ev.target.id !== 'p-datei') return;
  const datei = ev.target.files?.[0];
  if (datei) { await planungLesen(datei); $('#dialog').close(); }
});

/* ---------- Start ---------- */

let angezeigtePlanung = store.aktuell().id;
store.auf(art => {
  if (art === 'wechsel') {
    if (store.aktuell().id !== angezeigtePlanung) { angezeigtePlanung = store.aktuell().id; fehlerPlaetze = ''; fehlerArten = ''; }
    render();
    return;
  }
  if (art === 'fremd') {
    render();
    meldung('Diese Planung wurde in einem anderen Fenster geändert – der neuere Stand ist übernommen.', 'fehler');
    return;
  }
  if (art === 'speicher') {
    speicherstandAktualisieren(); renderNav(); abgeleitetAktualisieren();
    if (store.speicherProbleme()) meldung('⚠ Der Browser kann nicht mehr speichern. Bitte jetzt als Datei sichern, sonst gehen Änderungen verloren.', 'fehler', true, { text: 'Jetzt sichern', fn: planungSichern });
    return;
  }
  vorschauAktualisieren();
  abgeleitetAktualisieren();
  kopfAktualisieren();
  clearTimeout(navTimer);
  navTimer = setTimeout(renderNav, 300);
});

if (matchMedia('(max-width: 1180px)').matches) document.body.classList.remove('vorschau-offen');
render();

// Der Browser soll den Speicher dieser Seite nicht ungefragt räumen (Platzmangel, Safari nach Inaktivität)
try { navigator.storage?.persist?.()?.catch?.(() => {}); } catch { /* wird dann eben nicht zugesagt */ }

{
  const lp = store.ladeProbleme();
  if (lp) {
    meldung(lp.anzahl === null
      ? 'Die gespeicherten Planungen waren nicht lesbar. Die Rohdaten sind gesichert und gehen nicht verloren.'
      : `${lp.anzahl} gespeicherte Planung(en) waren nicht lesbar und fehlen hier. Die Rohdaten sind gesichert.`,
    'fehler', true, { text: 'Rohdaten herunterladen', fn: () => download('marschplaner-rohdaten.json.txt', lp.text ?? '', 'text/plain') });
  }
}
