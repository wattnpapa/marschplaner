// rechnen.js – die Marschrechnung: reine Funktionen, kein DOM, kein Speicher
//
// Was hier steht, ersetzt die Formeln der Excel-Vorlage und ergänzt, was dort
// von Hand eingetragen wurde (Marschlänge, Durchlaufzeit, Uhrzeiten). Einheiten:
// Kilometer für Strecken, Meter für Längen und Abstände, Minuten für Zeiten,
// km/h für Geschwindigkeiten. Uhrzeiten sind Minuten seit Mitternacht des
// Marschtages und dürfen über 1440 hinausgehen (Marsch über Mitternacht).

import { anteileImAbschnitt, strasseImAbschnitt } from './strassenart.js';

export const KLASSEN = [
  { id: 'bab', kurz: 'BAB', name: 'Bundesautobahn' },
  { id: 'bul', kurz: 'BuL', name: 'Bundes- und Landstraße' },
  { id: 'ort', kurz: 'Ort', name: 'innerhalb geschlossener Ortschaft' }
];

export const KLASSE_KURZ = Object.fromEntries(KLASSEN.map(k => [k.id, k.kurz]));

export const PUNKTTYPEN = [
  { id: 'ablauf', name: 'Ablaufpunkt' },
  { id: 'kp',     name: 'Kontrollpunkt' },
  { id: 'th',     name: 'Technischer Halt' },
  { id: 'rast',   name: 'Rast' },
  { id: 'tank',   name: 'Tankstopp' },
  { id: 'ziel',   name: 'Ziel' }
];

export const TYP_NAME = Object.fromEntries(PUNKTTYPEN.map(t => [t.id, t.name]));

/* ---------- Zahlen und Zeiten ---------- */

const NF = new Map();
/** Zahl mit deutschem Komma, höchstens `stellen` Nachkommastellen, ohne Nullen am Ende */
export function zahl(x, stellen = 1) {
  if (x === null || x === undefined || !Number.isFinite(x)) return '';
  let nf = NF.get(stellen);
  if (!nf) {
    nf = new Intl.NumberFormat('de-DE', { maximumFractionDigits: stellen, useGrouping: false });
    NF.set(stellen, nf);
  }
  return nf.format(Math.abs(x) < 5 * 10 ** (-stellen - 1) ? 0 : x);
}

/** Zahl immer mit genau `stellen` Nachkommastellen */
export function zahlFest(x, stellen = 1) {
  if (x === null || x === undefined || !Number.isFinite(x)) return '';
  return x.toLocaleString('de-DE', { minimumFractionDigits: stellen, maximumFractionDigits: stellen, useGrouping: false });
}

/** "08:15" → 495; ungültig → null */
export function zeitParse(text) {
  const m = /^\s*(\d{1,2})[:.](\d{2})\s*$/.exec(String(text ?? ''));
  if (!m) return null;
  const h = +m[1], min = +m[2];
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Minuten seit Mitternacht → "08:15"; ab dem Folgetag mit angehängtem " +1" */
export function zeitText(minuten) {
  if (!Number.isFinite(minuten)) return '';
  const m = Math.round(minuten);
  const tag = Math.floor(m / 1440);
  const r = ((m % 1440) + 1440) % 1440;
  const t = String(Math.floor(r / 60)).padStart(2, '0') + ':' + String(r % 60).padStart(2, '0');
  return tag > 0 ? `${t} +${tag}` : t;
}

/** Dauer in Minuten → "1 h 05 min" bzw. "45 min" */
export function dauerText(minuten) {
  if (!Number.isFinite(minuten)) return '';
  const m = Math.round(minuten);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** Dauer in Sekunden → "29 s" bzw. "1 min 40 s" */
export function sekundenText(sek) {
  if (!Number.isFinite(sek)) return '';
  const s = Math.round(sek);
  if (s < 90) return `${s} s`;
  const min = Math.floor(s / 60), r = s % 60;
  return r === 0 ? `${min} min` : `${min} min ${r} s`;
}

/* ---------- Längen und Zeiten eines Verbands ---------- */

/**
 * Marschlänge in m: Länge aller Fahrzeuge plus die Abstände dazwischen.
 * `kolonnenabstand` gilt zwischen je zwei Marschkolonnen, also (kolonnen − 1)-mal.
 */
export function marschlaenge({ einzel = 0, gespanne = 0, laengeEinzel = 0, laengeGespann = 0,
                               abstand = 0, kolonnen = 1, kolonnenabstand = 0 }) {
  const n = Math.max(0, einzel) + Math.max(0, gespanne);
  if (n === 0) return 0;
  return einzel * laengeEinzel + gespanne * laengeGespann
    + (n - 1) * Math.max(0, abstand)
    + Math.max(0, kolonnen - 1) * Math.max(0, kolonnenabstand);
}

/** Sekunden, die ein Verband von `laengeM` braucht, um einen Punkt zu passieren */
export function durchlaufSek(laengeM, vKmh) {
  if (!(vKmh > 0) || !(laengeM > 0)) return 0;
  return laengeM / (vKmh / 3.6);
}

/** dasselbe in Minuten */
export function durchlaufMin(laengeM, vKmh) {
  return durchlaufSek(laengeM, vKmh) / 60;
}

/** Fahrzeit in Minuten für `km` bei `vKmh` */
export function wegZeitMin(km, vKmh) {
  if (!(vKmh > 0) || !(km > 0)) return 0;
  return km / vKmh * 60;
}

/* ---------- Kontrollpunkte und Fahrplan ---------- */

/** Kontrollpunkte nach Kilometerstand; bei Gleichstand bleibt die Eingabereihenfolge */
export function sortierteKp(route) {
  return (route?.kontrollpunkte ?? [])
    .map((kp, i) => [kp, i])
    .sort((a, b) => (a[0].km - b[0].km) || (a[1] - b[1]))
    .map(x => x[0]);
}

/** Haltedauer in Minuten: eigener Wert am Punkt, sonst die Vorgabe der Punktart */
export function haltMin(parameter, kp) {
  if (kp.halt !== null && kp.halt !== undefined && kp.halt !== '' && Number.isFinite(+kp.halt)) {
    return Math.max(0, +kp.halt);
  }
  return Math.max(0, parameter.halt?.[kp.typ] ?? 0);
}

export function kolonnenLaenge(parameter, kolonne, klasse) {
  return marschlaenge({
    einzel: kolonne.einzel || 0,
    gespanne: kolonne.gespanne || 0,
    laengeEinzel: parameter.laengeEinzel,
    laengeGespann: parameter.laengeGespann,
    abstand: parameter.abstand[klasse] ?? 0
  });
}

/**
 * Fahrplan einer Marschkolonne entlang der Kontrollpunkte.
 * Jede Zeile ist ein Punkt; `leg` beschreibt den Abschnitt, der zu ihm hinführt.
 */
export function fahrplan(projekt, kolonne) {
  const par = projekt.parameter;
  const kps = sortierteKp(projekt.route);
  const ablauf = zeitParse(projekt.kopf.ablaufzeit);
  const start = (ablauf ?? 0) + (kolonne?.versatzMin || 0);
  const zeilen = [];
  /* Gerechnet wird in ganzen Minuten, aber ohne dass sich die Rundung
     aufsummiert: die Ankunft ist die gerundete Summe aus *exakter* Fahrzeit und
     Halten, die Zeit eines Abschnitts die Differenz zweier solcher Ankünfte.
     So stimmen „einzeln“ und „gesamt“ auf dem Blatt immer überein. */
  let fahrExakt = 0;               // reine Fahrminuten, ungerundet
  let haltSumme = 0;               // Halte vor diesem Punkt
  let abfahrt = 0;                 // Abfahrt am vorigen Punkt, Minuten seit Ablauf
  let fahrRund = 0;                // gerundete reine Fahrminuten
  let rueckVorher = (kps[0]?.umwegKm || 0) / 2;   // Rückfahrt vom vorigen Platz zur Strecke (km)
  let zusatzSumme = 0;             // alle Umweg-km bisher (für die Kilometeranzeige)
  let vorigerKm = kps.length ? kps[0].km : 0;
  const hinweise = [];

  kps.forEach((kp, i) => {
    let leg = null;
    let t = 0;
    if (i > 0) {
      const strecke = Math.max(0, kp.km - vorigerKm);
      const auto = kp.klasse === 'auto' && projekt.route.arten;
      let klasse, v, fm, anteile = null, strasse = kp.strasse || '';
      if (auto) {
        // Straßenart aus OSM: Kilometer je Art im Abschnitt, Zeit anteilig gerechnet
        const a = anteileImAbschnitt(projekt.route.arten, vorigerKm, kp.km);
        anteile = a.anteile;
        klasse = a.dominant;
        fm = KLASSEN.reduce((sum, c) => sum + wegZeitMin(anteile[c.id], par.v[c.id]), 0);
        for (const c of KLASSEN) {
          if (anteile[c.id] > 0 && !(par.v[c.id] > 0)) {
            hinweise.push(`Keine Marschgeschwindigkeit für ${c.kurz} – Abschnitt nach „${kp.ort || 'Punkt ' + (i + 1)}“ unvollständig.`);
          }
        }
        v = fm > 0 ? strecke / fm * 60 : par.v[klasse];
        if (!strasse) strasse = strasseImAbschnitt(projekt.route.arten, vorigerKm, kp.km);
      } else {
        klasse = KLASSE_KURZ[kp.klasse] ? kp.klasse : 'bul';
        v = par.v[klasse];
        fm = wegZeitMin(strecke, v);
        if (strecke > 0 && !(v > 0)) {
          hinweise.push(`Keine Marschgeschwindigkeit für ${KLASSE_KURZ[klasse]} – Abschnitt nach „${kp.ort || 'Punkt ' + (i + 1)}“ ohne Zeit.`);
        }
      }
      // Umweg zu Plätzen abseits der Strecke: Zufahrt zum Platz am Punkt, Rückfahrt
      // vom vorigen Platz – gefahren wird mit der Geschwindigkeit innerorts.
      const hin = (kp.umwegKm || 0) / 2;
      const extraKm = rueckVorher + hin;
      const streckeTrack = strecke;
      fm += wegZeitMin(extraKm, par.v.ort);
      zusatzSumme += extraKm;
      rueckVorher = hin;
      fahrExakt += fm;
      t = Math.max(abfahrt, Math.round(fahrExakt + haltSumme));
      const fahrt = t - abfahrt;
      fahrRund += fahrt;
      const laengeM = kolonne ? kolonnenLaenge(par, kolonne, klasse) : 0;
      leg = {
        klasse, v, strecke: streckeTrack + extraKm, umwegKm: extraKm, fahrMin: fahrt, anteile, strasse,
        auto: !!auto, gemischt: !!auto && streckeTrack > 0 && anteile[klasse] < streckeTrack * 0.85,
        laengeM, durchMin: durchlaufMin(laengeM, v),
        abstand: par.abstand[klasse]
      };
    }
    const halt = haltMin(par, kp);
    haltSumme += halt;
    abfahrt = t + halt;
    zeilen.push({
      nr: i + 1, kp, leg,
      km: kp.km - (kps[0]?.km ?? 0) + zusatzSumme,
      zeitGesamt: t, fahrGesamt: fahrRund, halt,
      an: start + t, ab: start + abfahrt
    });
    vorigerKm = kp.km;
  });

  return {
    zeilen,
    start,
    ende: zeilen.length ? zeilen[zeilen.length - 1].ab : start,
    kmGesamt: zeilen.length ? zeilen[zeilen.length - 1].km : 0,
    fahrMin: fahrRund,
    haltMinGesamt: zeilen.reduce((s, z) => s + z.halt, 0),
    hinweise,
    ablaufFehlt: ablauf === null
  };
}

/** Reine Fahrminuten, die eine Kolonne zur Uhrzeit `uhr` hinter sich hat */
export function fahrzeitBei(fp, uhr) {
  let summe = 0;
  for (const z of fp.zeilen) {
    if (!z.leg) continue;
    const legStart = z.an - z.leg.fahrMin;
    summe += Math.min(Math.max(uhr - legStart, 0), z.leg.fahrMin);
  }
  return summe;
}

/** Plan aller Kolonnen mit gemeinsamer Zeitachse für den Straßenbelegungsplan */
export function belegung(projekt) {
  const plaene = projekt.kolonnen.map(k => ({ kolonne: k, fp: fahrplan(projekt, k) }));
  const mitZeilen = plaene.filter(p => p.fp.zeilen.length > 1);
  const von = mitZeilen.length ? Math.min(...mitZeilen.map(p => p.fp.start)) : 0;
  const bis = mitZeilen.length ? Math.max(...mitZeilen.map(p => {
    const letzte = p.fp.zeilen[p.fp.zeilen.length - 1];
    return letzte.an + (letzte.leg?.durchMin || 0);
  })) : 0;
  return { plaene, von, bis };
}

/**
 * Halte, an denen zwei Kolonnen zur selben Zeit am selben Punkt stehen.
 * Belegt ist der Platz von der Ankunft der Spitze bis zur Abfahrt des Schlusses.
 */
export function haltKonflikte(projekt) {
  const { plaene } = belegung(projekt);
  const konflikte = [];
  const kps = sortierteKp(projekt.route);
  kps.forEach((kp, i) => {
    const belegt = [];
    plaene.forEach(p => {
      const z = p.fp.zeilen[i];
      if (!z || z.halt <= 0) return;
      belegt.push({
        name: p.kolonne.name,
        von: z.an,
        bis: z.ab + (z.leg?.durchMin || 0)
      });
    });
    for (let a = 0; a < belegt.length; a++) {
      for (let b = a + 1; b < belegt.length; b++) {
        if (belegt[a].von < belegt[b].bis && belegt[b].von < belegt[a].bis) {
          konflikte.push({ kp, nr: i + 1, a: belegt[a], b: belegt[b] });
        }
      }
    }
  });
  return konflikte;
}

/* ---------- Tabellen der Vorlage ---------- */

/** Weg-Zeit-Tabelle: Minuten je Entfernung (Zeilen) und Durchschnittsgeschwindigkeit (Spalten) */
export function wegZeitTabelle({ vonKm = 1, bisKm = 200, geschwindigkeiten = [10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60] } = {}) {
  const zeilen = [];
  for (let km = vonKm; km <= bisKm; km++) {
    zeilen.push({ km, min: geschwindigkeiten.map(v => wegZeitMin(km, v)) });
  }
  return { geschwindigkeiten, zeilen };
}

/**
 * Tabelle "Marschlänge – Durchlaufzeit": Länge und Durchlaufzeit für n Fahrzeuge
 * bei zwei Geschwindigkeiten. Der Abstand ist – wie in der Vorlage – der halbe
 * Tachowert in Metern (40 km/h → 20 m, 70 km/h → 35 m).
 */
export function durchlaufTabelle({ vA = 40, vB = 70, fahrzeugLaenge = 7, abstandFaktor = 0.5, vonN = 3, bisN = 30 } = {}) {
  const zeile = (n, v) => {
    const laengeM = n * fahrzeugLaenge + (n - 1) * v * abstandFaktor;
    return { laengeM, sek: durchlaufSek(laengeM, v) };
  };
  const zeilen = [];
  for (let n = vonN; n <= bisN; n++) zeilen.push({ n, a: zeile(n, vA), b: zeile(n, vB) });
  return { vA, vB, zeilen };
}

/**
 * "Hilfestellung Marschplanung": Marschlänge, Marschzeit und Durchlaufzeit aus
 * wenigen Eingaben. Fehlt etwas Zwingendes, bleibt das jeweilige Ergebnis `null`
 * statt einer Fehlerzahl.
 */
export function marschHilfe(e) {
  const einzel = Math.max(0, +e.einzel || 0), gespanne = Math.max(0, +e.gespanne || 0);
  const v = +e.v || 0;
  const laengeM = (einzel + gespanne) > 0
    ? marschlaenge({
        einzel, gespanne,
        laengeEinzel: +e.laengeEinzel || 0, laengeGespann: +e.laengeGespann || 0,
        abstand: +e.abstand || 0, kolonnen: Math.max(1, +e.kolonnen || 1),
        kolonnenabstand: +e.kolonnenabstand || 0
      })
    : null;
  const marschzeitMin = (v > 0 && +e.km > 0)
    ? Math.round(+e.km * 60 / v + (+e.unterbrechung || 0))
    : null;
  const durchSek = (v > 0 && laengeM) ? durchlaufSek(laengeM, v) : null;
  return { laengeM, marschzeitMin, durchlaufSek: durchSek };
}
