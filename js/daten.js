// daten.js – Vorgaben und Beschriftungen der Vordrucke
//
// Die Texte stammen aus der Excel-Vorlage „All in one Marschverband“ (Stand 12-25).
// Die hinterlegten Planungswerte sind Vorgaben der Vorlage und vor jeder Nutzung
// fachlich zu prüfen – so steht es auch im Blatt START der Vorlage.

import { zahl, zeitParse, zeitText, sortierteKp, fahrplan } from './rechnen.js';

/** Aufbau des Marschauftrags (Fb Fü 55): Abschnitte mit ihren Feldern */
export const AUFTRAG_ABSCHNITTE = [
  {
    nr: '1', titel: 'Lage',
    hinweis: '1a: Gefahren-/Schadenlage, 1b: eigene Lage, 1c: Unterstellung und Abgabe von Kräften',
    felder: [
      ['a1a', '1a', 'Gefahren-/Schadenlage'],
      ['a1b', '1b', 'Eigene Lage'],
      ['a1c', '1c', 'Unterstellung und Abgabe von Kräften']
    ]
  },
  {
    nr: '2', titel: 'Auftrag', hinweis: 'erhaltener Auftrag',
    felder: [['a2', '', 'Erhaltener Auftrag']]
  },
  {
    nr: '3', titel: 'Durchführung',
    hinweis: '3a: Marschziel, 3b: Marschweg, 3c: Marschentfernung, 3d: Marschform / Marschabstand, 3e: Marschfolge/Marschlänge, 3f: Marschführende, 3g: Schließender, 3h: Fahrzeugabstand, 3i: Ablaufpunkt, 3j: Ablaufzeit, 3k: Marschgeschwindigkeit, 3l: Verkehrssicherung, 3m: Technischer Halt, 3n: Rast, 3o: sonstiges',
    felder: [
      ['a3a', '3a', 'Marschziel'],
      ['a3b', '3b', 'Marschweg'],
      ['a3c', '3c', 'Marschentfernung'],
      ['a3d', '3d', 'Marschform / Marschabstand'],
      ['a3e', '3e', 'Marschfolge / Marschlänge'],
      ['a3f', '3f', 'Marschführende'],
      ['a3g', '3g', 'Schließender'],
      ['a3h', '3h', 'Fahrzeugabstand'],
      ['a3i', '3i', 'Ablaufpunkt'],
      ['a3j', '3j', 'Ablaufzeit'],
      ['a3k', '3k', 'Marschgeschwindigkeit'],
      ['a3l', '3l', 'Verkehrssicherung'],
      ['a3m', '3m', 'Technischer Halt'],
      ['a3n', '3n', 'Rast'],
      ['a3o', '3o', 'Sonstiges']
    ]
  },
  {
    nr: '4', titel: 'Logistik',
    hinweis: '4a: Verpflegung, 4b: Verbrauchsgüter, 4c: Betriebsstoffe, 4d: Instandsetzung, 4e: medizinische Versorgung, 4f: Unterbringung',
    felder: [
      ['a4a', '4a', 'Verpflegung'],
      ['a4b', '4b', 'Verbrauchsgüter'],
      ['a4c', '4c', 'Betriebsstoffe'],
      ['a4d', '4d', 'Instandsetzung'],
      ['a4e', '4e', 'Medizinische Versorgung'],
      ['a4f', '4f', 'Unterbringung']
    ]
  },
  {
    nr: '5', titel: 'Führung und Verbindung',
    hinweis: 'Telekommunikationsverbindungen und Meldewesen, Führungsstellen, Einsatzleitung, Platz des Führenden',
    felder: [['a5', '', 'Führung und Verbindung']]
  }
];

/** Felder des Marschauftrags, die sich aus der Planung ableiten lassen. Leer = automatisch. */
export const AUFTRAG_AUTO = ['a3a', 'a3b', 'a3c', 'a3e', 'a3h', 'a3i', 'a3j', 'a3k', 'a3m', 'a3n'];

/** Vorschlagstexte aus der Planung für die Felder in `AUFTRAG_AUTO` */
export function autoAuftrag(p) {
  const kps = sortierteKp(p.route);
  const fp = fahrplan(p, p.kolonnen[0] ?? null);
  const par = p.parameter;
  const aus = {};
  const ziel = kps.length ? kps[kps.length - 1] : null;

  aus.a3a = p.kopf.nach || ziel?.ort || '';
  const namen = kps.map(k => k.ort).filter(Boolean);
  aus.a3b = namen.length > 1 ? namen.join(' – ') : '';
  aus.a3c = fp.kmGesamt > 0 ? `${zahl(fp.kmGesamt, 1)} km` : '';

  const folge = p.kolonnen.map(k => {
    const n = (k.einzel || 0) + (k.gespanne || 0);
    return n ? `${k.name || 'Kolonne'}: ${n} Fahrzeuge` : '';
  }).filter(Boolean);
  aus.a3e = folge.join('; ');

  aus.a3h = [
    `${zahl(par.abstand.bul, 0)} m auf Bundes- und Landstraßen (BuL)`,
    `${zahl(par.abstand.bab, 0)} m auf Bundesautobahnen (BAB)`,
    `${zahl(par.abstand.ort, 0)} m innerhalb von Ortschaften`
  ].join('\n');

  aus.a3i = kps[0]?.ort || '';
  const ablauf = zeitParse(p.kopf.ablaufzeit);
  aus.a3j = ablauf === null ? '' : `${zeitText(ablauf)} Uhr`;
  aus.a3k = `BAB ${zahl(par.v.bab, 0)} km/h, BuL ${zahl(par.v.bul, 0)} km/h, Ortschaften ${zahl(par.v.ort, 0)} km/h`;

  const halte = (typen) => fp.zeilen
    .filter(z => typen.includes(z.kp.typ) && z.halt > 0)
    .map(z => `${z.kp.ort || 'Punkt ' + z.nr} (km ${zahl(z.km, 1)}), ${zeitText(z.an)}–${zeitText(z.ab)} Uhr`);
  aus.a3m = halte(['th', 'tank']).join('\n');
  aus.a3n = halte(['rast']).join('\n');
  return aus;
}

/** Empfänger der Unterlagen (Spalten der Unterlagenverteilung) */
export const UNTERLAGEN_ROLLEN = [
  { id: 'verband', name: 'Führer/in Marschverband' },
  { id: 'kolonnen', name: 'Führer/in der Marschkolonnen' },
  { id: 'spitze', name: 'Spitzenfahrzeug' },
  { id: 'schluss', name: 'Schließende/r' },
  { id: 'alle', name: 'alle Fahrzeuge / Kraftfahrende' },
  { id: 'logistik', name: 'Trupp Logistik / Einsatzunterstützung' }
];

/* Zeilen der Unterlagenverteilung samt Verteilung aus der Vorlage.
   „Checkliste Marschkolonnenführung?“ steht dort mit Fragezeichen und ohne
   Verteilung – bewusst unverändert übernommen. */
const U = (name, ...rollen) => ({ name, rollen });
export const UNTERLAGEN_STANDARD = [
  U('Marschauftrag', 'verband', 'kolonnen'),
  U('Straßenbelegungsplan', 'verband', 'kolonnen'),
  U('Marschübersicht / Marschtabelle', 'verband', 'kolonnen'),
  U('Marschskizze (Gesamtübersicht)', 'verband'),
  U('Erkundungsbericht / Fb Fü52', 'verband'),
  U('Verkehrsrechtliche Genehmigungen', 'verband'),
  U('Kontaktliste / Kommunikationsplan', 'verband'),
  U('Checkliste Marschbeginn / Marschende', 'verband'),
  U('Nachweis über Führungs- und Logistikmittel', 'verband'),
  U('Funkplan der Marschkolonne', 'kolonnen', 'spitze', 'schluss', 'alle'),
  U('Liste der Fahrzeuge in Marschfolge', 'verband', 'kolonnen'),
  U('Checkliste Marschkolonnenführung?'),
  U('Marschskizze (Auszug)', 'kolonnen', 'spitze', 'schluss', 'alle'),
  U('Marschtabelle (Auszug)', 'kolonnen', 'spitze', 'schluss', 'alle'),
  U('Anweisungsblatt "TH / Rast"', 'spitze'),
  U('Verhalten bei Marschbeginn / Marschende', 'spitze'),
  U('Verhalten bei Störungen /Ausfall', 'alle'),
  U('Checkliste Schließender', 'schluss'),
  U('Merkblatt Verhalten im Marsch', 'alle'),
  U('Checkliste Fahrzeuge (WOLKE)', 'alle'),
  U('Versorgungs- und Tankplan', 'verband', 'logistik')
];

/** Fußzeile auf jedem Blatt – aus dem Blatt START der Vorlage */
export const HINWEIS_VORLAGE =
  'Arbeits- und Ausbildungshilfe zur Planung geschlossener Marschverbände – keine eigenständige verbindliche Vorschrift. ' +
  'Hinterlegte Geschwindigkeiten, Abstände und Fahrzeuglängen sind vor Nutzung fachlich zu prüfen und lagebezogen festzulegen.';

export function neueId(vorsatz = '') {
  const z = (globalThis.crypto?.randomUUID?.() ?? (Math.random().toString(36).slice(2) + Date.now().toString(36)))
    .replace(/-/g, '').slice(0, 10);
  return vorsatz + z;
}

export function neueKolonne(nr = 1) {
  return {
    id: neueId('k'), name: `Marschkolonne ${nr}`,
    einzel: 0, gespanne: 0, versatzMin: 0, marschfolge: ''
  };
}

export function neuerKp(typ = 'kp', extra = {}) {
  return {
    id: neueId('p'), typ, ort: '', strasse: '', klasse: 'bul',
    km: 0, halt: null, bemerkung: '', ...extra
  };
}

export const SCHEMA = 1;

/** Ein leeres Projekt mit den Vorgaben der Vorlage */
export function neuesProjekt(name = 'Neue Marschplanung') {
  const jetzt = new Date().toISOString();
  return {
    schema: SCHEMA,
    id: neueId('mp'),
    name,
    erstellt: jetzt,
    geaendert: jetzt,
    kopf: {
      kennung: '', verband: '', datum: '', von: '', nach: '', ablaufzeit: '08:00'
    },
    parameter: {
      v:      { bab: 60, bul: 50, ort: 30 },        // Marschgeschwindigkeit km/h
      aufhol: { bab: 70, bul: 70, ort: 30 },        // Aufholgeschwindigkeit km/h
      abstand:{ bab: 100, bul: 50, ort: 25 },       // Fahrzeugabstand m (Marschauftrag 3h)
      laengeEinzel: 7,                              // m
      laengeGespann: 15,                            // m
      halt: { th: 15, rast: 30, tank: 20 }          // Vorgaben in min je Punktart
    },
    auftrag: {
      absender: '', empfaenger: '',
      ortDatum: '', unterschrift: '', dienststellung: '',
      anlagen: '', verteiler: '', quittung: ''
    },
    kolonnen: [neueKolonne(1)],
    route: { name: '', quelle: '', track: [], kontrollpunkte: [] },
    unterlagen: {
      zeilen: UNTERLAGEN_STANDARD.map(z => ({ id: neueId('u'), name: z.name, rollen: [...z.rollen] }))
    },
    hilfsmittel: {
      rechner: {
        einzel: 5, gespanne: 7, v: 52, kolonnen: 1, km: '', unterbrechung: '',
        abstand: '', kolonnenabstand: 0, laengeEinzel: 7, laengeGespann: 15
      },
      wegZeit: { bisKm: 200 },
      durchlauf: { vA: 40, vB: 70, fahrzeugLaenge: 7, bisN: 30 }
    },
    druck: { skizzeAuto: true }
  };
}
