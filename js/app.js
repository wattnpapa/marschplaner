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
  sortierteKp, fahrplan, haltKonflikte, kolonnenLaenge, marschHilfe, durchlaufMin
} from './rechnen.js';
import {
  AUFTRAG_ABSCHNITTE, AUFTRAG_AUTO, autoAuftrag, UNTERLAGEN_ROLLEN, UNTERLAGEN_STANDARD,
  HINWEIS_VORLAGE, neueKolonne, neueId
} from './daten.js';
import { leseGpx } from './gpx.js';
import {
  routeAusGpx, kpHinzufuegen, kpEntfernen, kpOrdnen, kpAnTrackSetzen, trackKm, kpPosition, routeLoeschen
} from './route.js';
import { karteErzeugen } from './karte.js';
import { drucken, pdfName } from './druck.js';
import { beispielFuellen } from './beispiel.js';

const $ = (sel) => document.querySelector(sel);
const editor = $('#editor');
const nav = $('#nav');
const flaeche = $('#flaeche');
let navTimer = 0;

/* ---------- kleine Helfer ---------- */

function merken(key, wert) { try { localStorage.setItem(key, wert); } catch { /* ohne Speicher eben nicht */ } }
function erinnern(key) { try { return localStorage.getItem(key); } catch { return null; } }

let toastTimer = null;
function meldung(text, art = '') {
  const t = $('#toast');
  t.textContent = text;
  t.className = `toast sichtbar ${art}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, art === 'fehler' ? 6000 : 3200);
}

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
    ${opt.hinweis ? `<small class="hinweis">${e(opt.hinweis)}</small>` : ''}</label>`;
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
  if (store.speicherProbleme()) m.push({ stufe: 'fehler', text: 'Der Browser kann nicht speichern. Planung bitte über „Planungen → Als Datei sichern“ aufheben.', ansicht: null });
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
  return m;
}

function meldungsListe(liste, mitSprung = true) {
  if (!liste.length) return '<ul class="meldungen"><li class="ok">Keine Auffälligkeiten.</li></ul>';
  return `<ul class="meldungen">${liste.map(x => `<li class="${x.stufe}"><span>${e(x.text)}</span>${
    mitSprung && x.ansicht ? `<button type="button" class="knopf klein" data-aktion="gehe" data-ziel="${x.ansicht}">Öffnen</button>` : ''}</li>`).join('')}</ul>`;
}

/* ====================================================================
   Ansichten
   ==================================================================== */

function vEckdaten(p) {
  const par = p.parameter;
  const zeile = (k) => `<tr><td><strong>${e(k.kurz)}</strong> <span class="hinweis">${e(k.name)}</span></td>
    <td><input type="number" data-typ="zahl" data-p="parameter.v.${k.id}" value="${e(par.v[k.id])}" min="0" step="any" aria-label="Marschgeschwindigkeit ${e(k.kurz)}"></td>
    <td><input type="number" data-typ="zahl" data-p="parameter.aufhol.${k.id}" value="${e(par.aufhol[k.id])}" min="0" step="any" aria-label="Aufholgeschwindigkeit ${e(k.kurz)}"></td>
    <td><input type="number" data-typ="zahl" data-p="parameter.abstand.${k.id}" value="${e(par.abstand[k.id])}" min="0" step="any" aria-label="Fahrzeugabstand ${e(k.kurz)}"></td></tr>`;
  return `
    <h1>Eckdaten</h1>
    <p class="lead">Worum geht es, wann geht es los, mit welchen Planungswerten wird gerechnet.</p>
    <section class="block"><h2>Marsch</h2>
      <div class="formular">
        ${feld('Kennung / Auftragsnummer', 'kopf.kennung', p, { hinweis: 'Steht oben rechts auf jedem Blatt.' })}
        ${feld('Marschverband / Einheit', 'kopf.verband', p)}
        ${feld('Datum (Marschbeginn)', 'kopf.datum', p, { typ: 'date' })}
        ${feld('Ablaufzeit (Uhr)', 'kopf.ablaufzeit', p, { typ: 'time', hinweis: 'Wann die Spitze der ersten Kolonne den Ablaufpunkt passiert.' })}
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
      <td class="num"><strong>${i + 1}</strong></td>
      <td><select data-p="${pf('typ')}" data-typ="text" data-neu="1" aria-label="Art des Punkts ${i + 1}">${kpOptionen(PUNKTTYPEN, kp.typ)}</select></td>
      <td><input type="text" data-p="${pf('ort')}" data-typ="text" value="${e(kp.ort)}" placeholder="Ort" aria-label="Ort ${i + 1}"></td>
      <td><input type="text" data-p="${pf('strasse')}" data-typ="text" value="${e(kp.strasse)}" placeholder="z. B. B 28" ${i === 0 ? 'disabled title="Der Ablaufpunkt hat keinen Abschnitt davor"' : ''} aria-label="Straße bis Punkt ${i + 1}"></td>
      <td><select data-p="${pf('klasse')}" data-typ="text" ${i === 0 ? 'disabled' : ''} aria-label="Straßenart bis Punkt ${i + 1}">${KLASSEN.map(k => `<option value="${k.id}" ${k.id === kp.klasse ? 'selected' : ''}>${k.kurz}</option>`).join('')}</select></td>
      <td class="num"><input type="number" step="0.1" min="0" data-p="${pf('km')}" data-typ="zahl" data-nachsort="1" value="${e(Math.round(kp.km * 100) / 100)}" aria-label="Kilometerstand ${i + 1}" ${p.route.track.length ? '' : ''}></td>
      <td class="num"><input type="number" step="1" min="0" data-p="${pf('halt')}" data-typ="zahl" value="${e(kp.halt ?? '')}" placeholder="${vorgabe ? zahl(vorgabe, 0) : '0'}" aria-label="Halt in Minuten ${i + 1}"></td>
      <td class="abgeleitet" data-an="${kp.id}"></td>
      <td><input type="text" data-p="${pf('bemerkung')}" data-typ="text" value="${e(kp.bemerkung)}" placeholder="Bemerkung" aria-label="Bemerkung ${i + 1}"></td>
      <td><button type="button" class="knopf klein nur-symbol gefahr" data-aktion="kp-loeschen" data-id="${kp.id}" title="Punkt entfernen" aria-label="Punkt ${i + 1} entfernen">✕</button></td>
    </tr>`;
  }).join('');
  return `<table class="tab kp-tabelle">
    <thead><tr><th>Nr</th><th>Art</th><th>Ort</th><th>Straße <span class="hinweis">(bis hierher)</span></th><th>Straßenart</th><th class="num">km</th><th class="num">Halt min</th><th>Ankunft</th><th>Bemerkung</th><th></th></tr></thead>
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
        <button type="button" class="knopf" data-aktion="orte-ermitteln" title="Ortsnamen aus OpenStreetMap vorschlagen">Ortsnamen ermitteln</button>
        <button type="button" class="knopf gefahr" data-aktion="route-loeschen">Route entfernen</button>
      </div>
      <div class="rolle-tabelle" id="kp-bereich"></div>
      <p class="hinweis" style="margin:10px 0 0">„Straßenart“ gilt für den Abschnitt <em>bis zu</em> diesem Punkt und bestimmt Geschwindigkeit und Fahrzeugabstand. „Halt“ leer lassen = Vorgabe der Punktart.</p>
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
        return feld(`${nr ? nr + ' – ' : ''}${name}`, `auftrag.${f}`, p, {
          mehrzeilig: true, zeilen: gross ? 5 : (f === 'a3h' || f === 'a3m' || f === 'a3n' ? 3 : 2),
          klasse: gross ? 'breit' : '',
          platzhalter: istAuto ? (auto[f] ? `Automatisch: ${auto[f]}` : 'Wird aus der Planung ergänzt') : '',
          hinweis: istAuto ? 'Leer lassen = Text aus der Planung.' : ''
        });
      }).join('')}</div>
    </section>`).join('');
  return `
    <h1>Marschauftrag (Fb Fü 55)</h1>
    <p class="lead">Felder mit „Automatisch“ füllen sich aus Route, Kolonnen und Parametern. Wer etwas einträgt, überschreibt den Vorschlag.</p>
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
    </section>
    <div class="leiste">
      <button type="button" class="knopf primaer" data-aktion="drucken" id="druck-los">Ausgewählte Blätter drucken / als PDF speichern</button>
      <button type="button" class="knopf" data-aktion="auswahl-plan">Nur Planung</button>
      <button type="button" class="knopf" data-aktion="auswahl-alle">Alle</button>
      <button type="button" class="knopf" data-aktion="auswahl-keine">Keine</button>
    </div>
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
        store.aendern(pp => { kpAnTrackSetzen(pp, id, lage); });
        routeAktualisieren();
      },
      beiKpSetzen(km) {
        store.aendern(pp => { kpHinzufuegen(pp, km, 'kp'); });
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
  const probleme = pruefung(store.aktuell());
  const fehler = probleme.filter(x => x.stufe === 'fehler').length;
  nav.innerHTML = ANSICHTEN.map((a, i) => {
    const marke = a.id === 'druck' && probleme.length
      ? `<span class="nav-marke ${fehler ? 'fehler' : ''}" title="${probleme.length} Hinweis(e)">${probleme.length}</span>` : '';
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
  speicherstandAktualisieren();
}

function speicherstandAktualisieren() {
  const s = $('#speicherstand');
  if (store.speicherProbleme()) { s.textContent = '⚠ nicht gespeichert'; s.className = 'speicherstand fehler'; }
  else { s.textContent = 'Im Browser gespeichert'; s.className = 'speicherstand'; }
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
    const fp = fahrplan(p, p.kolonnen[0] ?? null);
    for (const z of fp.zeilen) {
      const zelle = editor.querySelector(`[data-an="${z.kp.id}"]`);
      if (zelle) zelle.textContent = z.halt > 0 ? `${zeitText(z.an)} – ${zeitText(z.ab)}` : zeitText(z.an);
    }
    const info = $('#route-info');
    if (info) {
      const hat = p.route.track.length > 1;
      info.innerHTML = hat
        ? `<strong>${e(p.route.name || 'Route')}</strong> · Track ${zahl(trackKm(p.route), 1)} km · ${p.route.track.length} Stützpunkte · ${p.route.kontrollpunkte.length} Kontrollpunkte${fp.zeilen.length > 1 ? ` · Marschzeit ${dauerText(fp.ende - fp.start)}` : ''}`
        : `Kein Streckenverlauf geladen${p.route.kontrollpunkte.length ? ` · ${p.route.kontrollpunkte.length} Kontrollpunkte von Hand` : ''}.`;
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
});

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
  if (el.dataset.p === 'druck.skizzeAuto') vorschauAktualisieren();
});

$('#projektname').addEventListener('input', ev => {
  const wert = ev.target.value;
  store.aendern(p => { p.name = wert; }, 'name');
});

/* ====================================================================
   Aktionen
   ==================================================================== */

const AKTIONEN = {
  gehe(el) { gehe(el.dataset.ziel); },

  'gpx-waehlen'() { $('#gpx-datei')?.click(); },

  beispiel() {
    const p = store.aktuell();
    const leer = !p.route.kontrollpunkte.length;
    if (!leer && !confirm('Das Beispiel ersetzt Route, Kolonnen und Eckdaten dieser Planung. Fortfahren?')) return;
    store.aendern(pp => { beispielFuellen(pp, leseGpx); });
    render();
    meldung('Beispielplanung geladen – Schematische Route, keine echten Straßen.');
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
    store.aendern(p => kpEntfernen(p, el.dataset.id));
    routeAktualisieren();
  },

  'route-loeschen'() {
    if (!confirm('Streckenverlauf und alle Kontrollpunkte dieser Planung entfernen?')) return;
    store.aendern(p => routeLoeschen(p));
    render();
  },

  'orte-ermitteln'() { orteErmitteln(); },

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
    store.aendern(pp => { pp.kolonnen = pp.kolonnen.filter(k => k.id !== el.dataset.id); });
    render();
  },

  'u-neu'() {
    store.aendern(p => { p.unterlagen.zeilen.push({ id: neueId('u'), name: '', rollen: [] }); });
    render();
    editor.querySelector('[data-u]:last-of-type')?.closest('tbody')?.lastElementChild?.querySelector('input[type=text]')?.focus();
  },
  'u-weg'(el) {
    store.aendern(p => { p.unterlagen.zeilen = p.unterlagen.zeilen.filter(z => z.id !== el.dataset.id); });
    render();
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

function drucke() {
  const p = store.aktuell();
  const ids = BLAETTER.filter(b => druckAuswahl.has(b.id)).map(b => b.id);
  if (!ids.length) { meldung('Bitte mindestens ein Blatt auswählen.', 'fehler'); return; }
  const probleme = pruefung(p).filter(x => x.stufe === 'fehler');
  if (probleme.length && !confirm(`Die Planung ist noch unvollständig:\n\n• ${probleme.map(x => x.text).join('\n• ')}\n\nTrotzdem drucken?`)) return;
  drucken(ids, p);
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
  if (p.route.kontrollpunkte.length && !confirm('Die vorhandene Route und alle Kontrollpunkte werden durch die GPX-Datei ersetzt. Fortfahren?')) return;
  let ergebnis;
  try {
    store.aendern(pp => { ergebnis = routeAusGpx(pp, gpx); });
  } catch (err) {
    meldung(err.message, 'fehler');
    return;
  }
  if (ansicht !== 'route') gehe('route'); else render();
  const extra = ergebnis.verworfen ? ` · ${ergebnis.verworfen} Wegpunkt(e) weit abseits der Strecke ignoriert` : '';
  meldung(`Route geladen: ${zahl(ergebnis.laengeKm, 1)} km, ${ergebnis.punkte} Kontrollpunkte${extra}`);
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

let ortslauf = false;
async function orteErmitteln() {
  if (ortslauf) return;
  const p = store.aktuell();
  const ziele = sortierteKp(p.route).filter(k => !k.ort && kpPosition(p.route, k));
  if (!ziele.length) { meldung('Alle Kontrollpunkte haben bereits einen Ortsnamen.'); return; }
  if (!confirm(`Für ${ziele.length} Punkt(e) wird der Ortsname bei OpenStreetMap (nominatim.openstreetmap.org) abgefragt. Dabei werden deren Koordinaten übertragen. Fortfahren?`)) return;
  ortslauf = true;
  let gefunden = 0;
  try {
    for (const [i, kp] of ziele.entries()) {
      meldung(`Ortsnamen: ${i + 1} von ${ziele.length} …`);
      const lage = kpPosition(store.aktuell().route, kp);
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&accept-language=de&lat=${lage[0].toFixed(5)}&lon=${lage[1].toFixed(5)}`;
      const antwort = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!antwort.ok) throw new Error(`Der Dienst antwortet mit ${antwort.status}.`);
      const a = (await antwort.json()).address || {};
      const name = a.city || a.town || a.village || a.municipality || a.suburb || a.county || '';
      if (name) {
        store.aendern(pp => { const k = pp.route.kontrollpunkte.find(x => x.id === kp.id); if (k && !k.ort) k.ort = name; });
        gefunden++;
        if (ansicht === 'route') routeAktualisieren();
      }
      if (i < ziele.length - 1) await new Promise(r => setTimeout(r, 1100));     // Nutzungsrichtlinie: höchstens 1 Anfrage/s
    }
    meldung(`${gefunden} von ${ziele.length} Ortsnamen ergänzt – bitte prüfen.`);
  } catch (err) {
    meldung(`Ortsnamen konnten nicht abgefragt werden: ${err.message}`, 'fehler');
  } finally {
    ortslauf = false;
  }
}

/* ---------- Planungen verwalten ---------- */

async function planungLesen(datei) {
  try {
    store.ausJson(await datei.text());
    meldung('Planung geladen.');
  } catch (err) {
    meldung(err.message, 'fehler');
  }
}

function projektDialog() {
  const d = $('#dialog');
  const akt = store.aktuell();
  const zeilen = store.liste().map(x => `<li class="${x.id === akt.id ? 'aktiv' : ''}">
    <span class="name" title="${e(x.name)}">${e(x.name || 'Ohne Namen')}</span>
    <span class="meta">${e((x.geaendert || '').slice(0, 10).split('-').reverse().join('.'))}</span>
    ${x.id === akt.id ? '<span class="meta">geöffnet</span>' : `<button type="button" class="knopf klein" data-p-oeffnen="${x.id}">Öffnen</button>`}
    <button type="button" class="knopf klein gefahr nur-symbol" data-p-weg="${x.id}" aria-label="Planung löschen" title="Löschen">✕</button></li>`).join('');
  d.innerHTML = `
    <div class="dialog-kopf"><h2>Planungen</h2><button type="button" class="knopf klein" data-p-zu>Schließen</button></div>
    <div class="dialog-inhalt">
      <ul class="projektliste">${zeilen}</ul>
      <div class="leiste">
        <button type="button" class="knopf primaer" data-p-neu>＋ Neue Planung</button>
        <button type="button" class="knopf" data-p-dup>Duplizieren</button>
        <button type="button" class="knopf" data-p-beispiel>Beispiel</button>
      </div>
      <h3 style="font-size:14px;margin:14px 0 8px">Sichern und weitergeben</h3>
      <p class="hinweis" style="margin:0 0 8px">Planungen liegen nur in diesem Browser. Zum Sichern oder Weitergeben als Datei speichern – sie lässt sich hier wieder laden.</p>
      <div class="leiste">
        <button type="button" class="knopf" data-p-export>Als Datei sichern (.json)</button>
        <button type="button" class="knopf" data-p-import>Datei laden …</button>
        <input type="file" id="p-datei" accept=".json,application/json" hidden>
      </div>
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
    const name = store.liste().find(x => x.id === t.dataset.pWeg)?.name;
    if (confirm(`Planung „${name}“ endgültig löschen?`)) { store.loeschen(t.dataset.pWeg); projektDialog(); }
  }
  else if ('pNeu' in t.dataset) { store.neu('Neue Marschplanung'); d.close(); }
  else if ('pDup' in t.dataset) { store.duplizieren(); d.close(); }
  else if ('pBeispiel' in t.dataset) { store.neu('Beispiel'); store.aendern(p => { beispielFuellen(p, leseGpx); }); d.close(); }
  else if ('pExport' in t.dataset) { download(`${pdfName(store.aktuell())}.marschplan.json`, store.alsJson(), 'application/json'); }
  else if ('pImport' in t.dataset) { $('#p-datei').click(); }
});
$('#dialog').addEventListener('change', async ev => {
  if (ev.target.id !== 'p-datei') return;
  const datei = ev.target.files?.[0];
  if (datei) { await planungLesen(datei); $('#dialog').close(); }
});

/* ---------- Start ---------- */

store.auf(art => {
  if (art === 'wechsel') { render(); return; }
  if (art === 'speicher') { speicherstandAktualisieren(); renderNav(); return; }
  vorschauAktualisieren();
  abgeleitetAktualisieren();
  kopfAktualisieren();
  clearTimeout(navTimer);
  navTimer = setTimeout(renderNav, 300);
});

if (matchMedia('(max-width: 1180px)').matches) document.body.classList.remove('vorschau-offen');
render();
