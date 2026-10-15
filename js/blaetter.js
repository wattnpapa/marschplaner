// blaetter.js – die druckfertigen Blätter als HTML
//
// Jedes Blatt entspricht einem Tabellenblatt der Excel-Vorlage und kommt als
// `<section class="blatt hoch|quer">`. Dasselbe HTML dient der Vorschau am
// Bildschirm und dem Druck; css/print.css legt Seitengröße und Umbrüche fest.
// Die Funktionen sind rein: Projekt hinein, Zeichenkette heraus.

import {
  KLASSEN, KLASSE_KURZ, TYP_NAME, zahl, zeitText, dauerText, sekundenText,
  sortierteKp, fahrplan, belegung, haltKonflikte, fahrzeitBei, kolonnenLaenge,
  wegZeitTabelle, durchlaufTabelle, marschHilfe
} from './rechnen.js';
import { e } from './html.js';
import { teilTrack, vereinfachen, punktBeiKm } from './geo.js';
import { klassenLaeufe } from './strassenart.js';
import {
  AUFTRAG_ABSCHNITTE, AUFTRAG_AUTO, autoAuftrag, UNTERLAGEN_ROLLEN, HINWEIS_VORLAGE
} from './daten.js';

export function datumText(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` : (iso || '');
}

function kopf(vnr, titel, p) {
  return `<table class="blattkopf"><tr>
    <td class="kopf-nr">${e(vnr)}</td>
    <td class="kopf-titel">${e(titel)}</td>
    <td class="kopf-kennung">${e(p.kopf.kennung)}</td>
  </tr></table>`;
}

function fuss(p) {
  const wer = [p.kopf.verband, p.name].filter(Boolean).join(' · ');
  return `<footer class="blatt-fuss"><div>${e(wer)}</div><div>${e(HINWEIS_VORLAGE)}</div></footer>`;
}

function blatt(id, ausrichtung, inhalt, p, klasse = '') {
  return `<section class="blatt ${ausrichtung} ${klasse}" data-blatt="${id}">${inhalt}${fuss(p)}</section>`;
}

/** „BuL“ bzw. bei gemischten Abschnitten „BuL 70 % · Ort 30 %“ */
function artText(leg) {
  if (!leg.auto || !leg.gemischt || !(leg.strecke > 0)) return KLASSE_KURZ[leg.klasse];
  return KLASSEN.map(k => [k, leg.anteile[k.id]])
    .filter(([, a]) => a / leg.strecke >= 0.05)
    .sort((x, y) => y[1] - x[1])
    .map(([k, a]) => `${k.kurz} ${Math.round(a / leg.strecke * 100)} %`).join(' · ');
}

function leer(text) {
  return `<p class="leerhinweis">${e(text)}</p>`;
}

/* ====================================================================
   Fb Fü 55 – Marschauftrag
   ==================================================================== */

function marschauftrag(p) {
  const a = p.auftrag;
  const auto = autoAuftrag(p);
  const wert = (f) => {
    const eigen = (a[f] ?? '').toString().trim();
    return eigen || (AUFTRAG_AUTO.includes(f) ? auto[f] || '' : '');
  };

  const abschnitte = AUFTRAG_ABSCHNITTE.map(ab => {
    const gross = ab.felder.length === 1;
    const zeilen = ab.felder.map(([f, nr]) => `<tr class="${gross ? 'gross' : ''}">
        <th class="nr">${e(nr)}</th><td class="text">${e(wert(f))}</td></tr>`).join('');
    return `<table class="raster auftrag">
      <tr class="abschnitt"><th colspan="2">${e(ab.nr)}. ${e(ab.titel)} <small>(${e(ab.hinweis)})</small></th></tr>
      ${zeilen}</table>`;
  }).join('');

  const html = `
    ${kopf('Fb Fü 55', 'Marschauftrag', p)}
    <p class="untertitel">Für die Fahrt im geschlossenen Verband</p>
    <table class="raster auftrag">
      <tr><th class="nr">von</th><td>${e(p.kopf.von)}</td><th class="nr">nach</th><td>${e(p.kopf.nach)}</td></tr>
      <tr><th class="nr">Absender</th><td colspan="3">${e(a.absender)}</td></tr>
      <tr><th class="nr">Empfänger</th><td colspan="3">${e(a.empfaenger)}</td></tr>
    </table>
    ${abschnitte}
    <table class="raster unterschrift">
      <tr class="eintrag"><td>${e(a.ortDatum)}</td><td></td><td>${e(a.dienststellung)}</td></tr>
      <tr class="etikett"><th>Ort, Datum</th><th>Unterschrift</th><th>Dienststellung</th></tr>
    </table>
    <table class="raster auftrag">
      <tr><th class="nr">Anlagen:</th><td class="text">${e(a.anlagen)}</td></tr>
      <tr><th class="nr">Verteiler:</th><td class="text">${e(a.verteiler)}</td></tr>
    </table>
    <table class="raster unterschrift">
      <tr class="eintrag"><td>${e(a.quittung)}</td></tr>
      <tr class="etikett"><th>Ort, Datum, Unterschrift, Dienststellung</th></tr>
    </table>`;
  return blatt('marschauftrag', 'hoch', html, p);
}

/* ====================================================================
   Marschtabelle – je Marschkolonne ein Blatt
   ==================================================================== */

function parameterTabelle(p) {
  const par = p.parameter;
  const spalte = (obj, st = 0) => KLASSEN.map(k => `<td>${zahl(obj[k.id], st)}</td>`).join('');
  return `<table class="raster parameter">
    <tr><th></th><th>Bundes-<br>autobahnen</th><th>Bundes- und<br>Landstraßen</th><th>innerhalb geschl.<br>Ortschaften</th></tr>
    <tr><th>Marschgeschwindigkeit (km/h)</th>${spalte(par.v)}</tr>
    <tr><th>Aufholgeschwindigkeit (km/h)</th>${spalte(par.aufhol)}</tr>
    <tr><th>Fahrzeugabstände (m)</th>${spalte(par.abstand)}</tr>
  </table>`;
}

function marschtabelleBlatt(p, kolonne) {
  const fp = fahrplan(p, kolonne);
  const fz = (kolonne.einzel || 0) + (kolonne.gespanne || 0);

  let zeilen = '';
  fp.zeilen.forEach((z, i) => {
    const kp = z.kp;
    const typ = (kp.typ === 'kp' || kp.typ === 'ablauf') ? (kp.typ === 'ablauf' ? TYP_NAME.ablauf : '') : TYP_NAME[kp.typ];
    const bem = [];
    if (z.halt > 0) bem.push(`Halt ${zahl(z.halt, 0)} min, Abfahrt ${zeitText(z.ab)}`);
    if (kp.umwegKm > 0) bem.push(`Zu-/Abfahrt ca. ${zahl(kp.umwegKm, 1)} km abseits der Strecke`);
    if (kp.bemerkung) bem.push(kp.bemerkung);
    zeilen += `<tr class="punkt">
      <td class="uhr">${zeitText(z.an)}${z.halt > 0 ? `<small>ab ${zeitText(z.ab)}</small>` : ''}</td>
      <td class="nr">${z.nr}</td>
      <td class="ort"><strong>${e(kp.ort || '')}</strong>${typ ? `<small>${e(typ)}</small>` : ''}</td>
      <td></td>
      <td></td><td class="zahl">${i === 0 ? '' : zahl(z.km, 1)}</td>
      <td></td><td class="zahl">${i === 0 ? '' : zahl(z.zeitGesamt, 0)}</td>
      <td></td><td></td>
      <td class="bem">${bem.map(e).join('<br>')}</td>
    </tr>`;
    const naechste = fp.zeilen[i + 1];
    if (naechste) {
      const l = naechste.leg;
      zeilen += `<tr class="abschnitt">
        <td></td><td></td><td></td>
        <td class="strasse">${e(l.strasse || '')}<small>${e(artText(l))}</small></td>
        <td class="zahl">${zahl(l.strecke, 1)}</td><td></td>
        <td class="zahl">${zahl(l.fahrMin, 0)}</td><td></td>
        <td class="zahl">${kolonne ? zahl(l.laengeM, 0) : ''}</td>
        <td class="zahl">${kolonne && l.laengeM ? zahl(l.durchMin, 1) : ''}</td>
        <td></td>
      </tr>`;
    }
  });

  const inhalt = `
    ${kopf('Fb Fü xx', 'Marschtabelle', p)}
    <div class="seitlich">
      <table class="raster kopfinfo">
        <tr><th>Marsch von</th><td>${e(p.kopf.von)}</td><th>nach</th><td>${e(p.kopf.nach)}</td></tr>
        <tr><th>Datum (Marschbeginn)</th><td>${e(datumText(p.kopf.datum))}</td><th>Ablaufzeit</th><td>${e(p.kopf.ablaufzeit)}${kolonne.versatzMin ? ` (+${zahl(kolonne.versatzMin, 0)} min)` : ''}</td></tr>
        <tr><th>Marschkolonne</th><td>${e(kolonne.name)}${fz ? ` · ${fz} Fz` : ''}</td><th>Marschfolge</th><td>${e(kolonne.marschfolge)}</td></tr>
      </table>
      ${parameterTabelle(p)}
    </div>
    ${fp.zeilen.length < 2 ? leer('Noch keine Route: Kontrollpunkte unter „Route“ anlegen oder eine GPX-Datei laden.') : `
    <table class="raster tabelle marschtabelle">
      <colgroup><col class="c-uhr"><col class="c-nr"><col class="c-ort"><col class="c-str"><col class="c-km"><col class="c-km"><col class="c-min"><col class="c-min"><col class="c-lang"><col class="c-durch"><col class="c-bem"></colgroup>
      <thead>
        <tr><th rowspan="2">Uhrzeit</th><th rowspan="2">Kontroll-<br>punkt</th><th rowspan="2">Ort</th><th rowspan="2">Straße</th>
            <th colspan="2">Strecke [km]</th><th colspan="2">Zeit [min]</th>
            <th rowspan="2">Marschlänge<br>[m]</th><th rowspan="2">Durchlaufzeit<br>[min]</th><th rowspan="2">Bemerkung</th></tr>
        <tr><th>einzeln</th><th>gesamt</th><th>einzeln</th><th>gesamt</th></tr>
      </thead>
      <tbody>${zeilen}</tbody>
      <tfoot><tr><td colspan="11">
        Uhrzeit = Ankunft der Spitze. „Zeit gesamt“ enthält die Halte; „Zeit einzeln“ ist die reine Fahrzeit.
        Marschlänge und Durchlaufzeit gelten für diese Kolonne mit dem Fahrzeugabstand der jeweiligen Straßenart.
        Gesamt: ${zahl(fp.kmGesamt, 1)} km, ${dauerText(fp.ende - fp.start)} (davon Halte ${dauerText(fp.haltMinGesamt)}).
      </td></tr></tfoot>
    </table>`}`;
  return blatt('marschtabelle', 'quer', inhalt, p);
}

function marschtabelle(p) {
  return p.kolonnen.map(k => marschtabelleBlatt(p, k)).join('');
}

/* ====================================================================
   Fb Fü 54 – Marschskizze
   ==================================================================== */

/* ---------- Skizzen mit Kartenhintergrund ----------
   Gerechnet wird in Web-Mercator, damit der Linienzug exakt auf den
   OpenStreetMap-Kacheln liegt, die darunter gelegt werden. */

const KACHELN = 'https://tile.openstreetmap.org';

function mercator(q) {
  const lat = Math.max(-85, Math.min(85, q[0])) * Math.PI / 180;
  return [(q[1] + 180) / 360, (1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2];
}

/** Projektion [lat, lon] → x/y in einer Box, Seitenverhältnis bleibt erhalten */
function projektion(punkte, w, h, rand) {
  const m = punkte.map(mercator);
  const xs = m.map(q => q[0]), ys = m.map(q => q[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const bx = Math.max(maxX - minX, 1e-12), by = Math.max(maxY - minY, 1e-12);
  const s = Math.min((w - 2 * rand) / bx, (h - 2 * rand) / by);
  const ox = (w - bx * s) / 2 - minX * s, oy = (h - by * s) / 2 - minY * s;
  const f = (q) => { const [x, y] = mercator(q); return [x * s + ox, y * s + oy]; };
  Object.assign(f, { s, ox, oy, w, h });
  return f;
}

/** OSM-Kacheln als <image> unter der Skizze; `dichte` = SVG-Einheiten je Kachel (größer = weniger Kacheln) */
function kachelnSvg(f, dichte) {
  let z = Math.min(17, Math.max(2, Math.ceil(Math.log2(f.s / dichte))));
  for (;;) {
    const n = 2 ** z, t = f.s / n;
    const x0 = Math.floor((0 - f.ox) / t), x1 = Math.floor((f.w - f.ox) / t);
    const y0 = Math.max(0, Math.floor((0 - f.oy) / t)), y1 = Math.min(n - 1, Math.floor((f.h - f.oy) / t));
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 36 && z > 2) { z--; continue; }
    let aus = '';
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
      const x = ((tx % n) + n) % n;
      aus += `<image href="${KACHELN}/${z}/${x}/${ty}.png" x="${(tx * t + f.ox).toFixed(2)}" y="${(ty * t + f.oy).toFixed(2)}" width="${(t + 0.6).toFixed(2)}" height="${(t + 0.6).toFixed(2)}" preserveAspectRatio="none"/>`;
    }
    return `<g class="kacheln" opacity="0.62">${aus}</g>
      <text x="${f.w - 3}" y="${f.h - 3}" text-anchor="end" font-size="6.5" fill="#222" stroke="#fff" stroke-width="2" paint-order="stroke">© OpenStreetMap-Mitwirkende</text>`;
  }
}

const pfad = (pts) => pts.map((q, i) => `${i ? 'L' : 'M'}${q[0].toFixed(1)} ${q[1].toFixed(1)}`).join('');

function pfeilspitze([x, y], [x0, y0], gr = 7) {
  const a = Math.atan2(y - y0, x - x0);
  const p1 = [x - gr * Math.cos(a - 0.45), y - gr * Math.sin(a - 0.45)];
  const p2 = [x - gr * Math.cos(a + 0.45), y - gr * Math.sin(a + 0.45)];
  return `<path d="M${x.toFixed(1)} ${y.toFixed(1)}L${p1[0].toFixed(1)} ${p1[1].toFixed(1)}L${p2[0].toFixed(1)} ${p2[1].toFixed(1)}Z" fill="#000" stroke="#fff" stroke-width="1" paint-order="stroke"/>`;
}

/** Ortsskizze eines Abschnitts: Linienzug auf Kartenhintergrund mit Start- und Zielmarke */
function abschnittSkizze(track, vonKm, bisKm, mitKarte) {
  const teil = vereinfachen(teilTrack(track, vonKm, bisKm), 8);
  if (teil.length < 2) return '';
  const W = 240, H = 100;
  const f = projektion(teil, W, H, 14);
  const pts = teil.map(f);
  const s = pts[0], z = pts[pts.length - 1], vorz = pts[Math.max(0, pts.length - 2)];
  const d = pfad(pts);
  return `<svg viewBox="0 0 ${W} ${H}" class="skizze" role="img" aria-label="Ortsskizze">
    ${mitKarte ? kachelnSvg(f, 170) : ''}
    <path d="${d}" fill="none" stroke="#fff" stroke-width="5.6" stroke-linejoin="round" stroke-linecap="round"/>
    <path d="${d}" fill="none" stroke="#000" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${s[0].toFixed(1)}" cy="${s[1].toFixed(1)}" r="4.5" fill="#fff" stroke="#000" stroke-width="1.6"/>
    ${pfeilspitze(z, vorz, 9)}
  </svg>`;
}

/** Gesamtübersicht: ganzer Track auf Karte, Abschnitte nach Straßenart, Punkte nummeriert */
function uebersichtSkizze(p, fp, mitKarte) {
  const track = p.route.track;
  if (!track || track.length < 2) return '';
  const W = 760, H = 250;
  const ges = vereinfachen(track, 25);
  const f = projektion(ges, W, H, 26);
  const stile = {
    bab: { breite: 4.2, extra: '' },
    bul: { breite: 2.4, extra: '' },
    ort: { breite: 2, extra: 'stroke-dasharray="1 4" stroke-linecap="round"' }
  };
  const arten = p.route.arten;
  let halo = '', linien = '';
  fp.zeilen.forEach((z, i) => {
    if (!z.leg) return;
    const von = fp.zeilen[i - 1].kp.km, bis = z.kp.km;
    // „auto“-Abschnitte: Straßenart wechselt innerhalb des Abschnitts → in Läufe zerlegen
    const laeufe = z.leg.auto && arten
      ? klassenLaeufe(arten, von, bis)
      : [{ klasse: z.leg.klasse, von, bis }];
    for (const lauf of laeufe) {
      const teil = vereinfachen(teilTrack(track, lauf.von, lauf.bis), 25);
      if (teil.length < 2) continue;
      const st = stile[lauf.klasse] || stile.bul;
      const d = pfad(teil.map(f));
      halo += `<path d="${d}" fill="none" stroke="#fff" stroke-width="${st.breite + 3}" stroke-linejoin="round" stroke-linecap="round"/>`;
      linien += `<path d="${d}" fill="none" stroke="#000" stroke-width="${st.breite}" stroke-linejoin="round" ${st.extra}/>`;
    }
  });
  const marken = fp.zeilen.map(z => {
    const q = punktBeiKm(track, z.kp.km);
    if (!q) return '';
    const [x, y] = f(q);
    return `<g><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="9" fill="#fff" stroke="#000" stroke-width="1.6"/>
      <text x="${x.toFixed(1)}" y="${(y + 3.6).toFixed(1)}" text-anchor="middle" font-size="10" font-weight="700">${z.nr}</text></g>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="uebersicht" role="img" aria-label="Marschweg">
    ${mitKarte ? kachelnSvg(f, 210) : ''}
    ${halo}${linien}${marken}
    <g font-size="9" transform="translate(12 ${H - 56})">
      <rect x="-6" y="-12" width="110" height="52" fill="#fff" stroke="#999"/>
      <path d="M0 0h28" stroke="#000" stroke-width="4.2"/><text x="34" y="3">Autobahn</text>
      <path d="M0 14h28" stroke="#000" stroke-width="2.4"/><text x="34" y="17">Bundes-/Landstr.</text>
      <path d="M0 28h28" stroke="#000" stroke-width="2" stroke-dasharray="1 4" stroke-linecap="round"/><text x="34" y="31">Ortschaft</text>
    </g>
  </svg>`;
}

function marschskizze(p) {
  const fp = fahrplan(p, p.kolonnen[0] ?? null);
  const par = p.parameter;
  const track = p.route.track;
  const kmStart = sortierteKp(p.route)[0]?.km ?? 0;
  const laengen = p.kolonnen.map(k => {
    const l = kolonnenLaenge(par, k, 'bul');
    return l ? `${e(k.name)}: ${zahl(l, 0)} m` : '';
  }).filter(Boolean).join(' · ');
  const auto = autoAuftrag(p);
  const ablaufText = [auto.a3i, p.kopf.ablaufzeit ? `${p.kopf.ablaufzeit} Uhr` : ''].filter(Boolean).join(', ');

  const zeilen = fp.zeilen.map((z, i) => {
    const vorher = fp.zeilen[i - 1];
    const skizze = !p.druck.skizzeAuto || !track.length ? '' : (i === 0
      ? abschnittSkizze(track, kmStart, kmStart + 1.5, p.druck.kartenHintergrund)
      : abschnittSkizze(track, vorher.kp.km, z.kp.km, p.druck.kartenHintergrund));
    const hinw = [];
    if (z.leg) hinw.push(`${e(z.leg.strasse || '')} (${e(artText(z.leg))}), ${zahl(z.leg.strecke, 1)} km`);
    if (z.kp.typ !== 'kp') hinw.push(`<strong>${e(TYP_NAME[z.kp.typ])}</strong>${z.halt > 0 ? `, ${zahl(z.halt, 0)} min` : ''}`);
    else if (z.halt > 0) hinw.push(`Halt ${zahl(z.halt, 0)} min`);
    if (z.kp.umwegKm > 0) hinw.push(`Zu-/Abfahrt ca. ${zahl(z.kp.umwegKm, 1)} km abseits`);
    if (z.kp.bemerkung) hinw.push(e(z.kp.bemerkung));
    return `<tr>
      <td class="nr">${z.nr}</td>
      <td class="skizzenfeld">${skizze}</td>
      <td class="zahl">${i === 0 ? '0' : zahl(z.km, 1)}</td>
      <td class="ort"><strong>${e(z.kp.ort || '')}</strong></td>
      <td class="hinweise">${hinw.join('<br>')}</td>
    </tr>`;
  }).join('');

  const inhalt = `
    ${kopf('Fb Fü 54', 'Marschskizze', p)}
    <table class="raster kopfinfo">
      <tr><th>Marschskizze für</th><td colspan="3">von ${e(p.kopf.von)} nach ${e(p.kopf.nach)}</td></tr>
      <tr><th>Marschziel</th><td>${e(auto.a3a)}</td><th>Ablauf</th><td>${e(ablaufText)}</td></tr>
      <tr><th>Geschwindigkeit</th><td>${zahl(par.v.bab, 0)} / ${zahl(par.v.bul, 0)} / ${zahl(par.v.ort, 0)} km/h <small>(BAB / BuL / Ort)</small></td>
          <th>KFZ-Abstand</th><td>${zahl(par.abstand.bab, 0)} / ${zahl(par.abstand.bul, 0)} / ${zahl(par.abstand.ort, 0)} m</td></tr>
      <tr><th>Marschlänge</th><td>${laengen || '–'} <small>(auf BuL)</small></td>
          <th>Marschweg</th><td>${zahl(fp.kmGesamt, 1)} km, ${dauerText(fp.ende - fp.start)}</td></tr>
    </table>
    <h3 class="zwischentitel">Marschweg</h3>
    ${uebersichtSkizze(p, fp, p.druck.kartenHintergrund) || '<div class="skizzenfeld gross"></div>'}
    ${fp.zeilen.length < 2 ? leer('Noch keine Route: Kontrollpunkte unter „Route“ anlegen oder eine GPX-Datei laden.') : `
    <table class="raster tabelle skizzentabelle">
      <colgroup><col class="c-nr"><col class="c-skizze"><col class="c-km"><col class="c-ort"><col class="c-hinw"></colgroup>
      <thead><tr><th>Lfd.<br>Nr.</th><th>Ortsskizze</th><th>km</th><th>Ortschaften</th><th>Hinweise</th></tr></thead>
      <tbody>${zeilen}</tbody>
    </table>`}`;
  return blatt('marschskizze', 'hoch', inhalt, p);
}

/* ====================================================================
   Straßenbelegungsplan
   ==================================================================== */

const LINIEN = [
  { farbe: '#003399', strich: '' },
  { farbe: '#c62828', strich: '9 5' },
  { farbe: '#1b7a3d', strich: '2 4' },
  { farbe: '#b26a00', strich: '10 4 2 4' },
  { farbe: '#6a1b9a', strich: '5 5 1 5' },
  { farbe: '#444', strich: '14 4' }
];

function zeitSchritt(spanne, maxSpalten) {
  for (const s of [15, 30, 60, 120, 240]) if (spanne / s <= maxSpalten) return s;
  return 240;
}

function belegungsDiagramm(p, b, konflikte) {
  const W = 1000, H = 392, L = 150, R = 24, T = 30, B = 58;
  const mit = b.plaene.filter(q => q.fp.zeilen.length > 1);
  if (!mit.length) return '';
  const schritt = zeitSchritt(b.bis - b.von, 16);
  const t0 = Math.floor(b.von / schritt) * schritt;
  const t1 = Math.max(Math.ceil(b.bis / schritt) * schritt, t0 + schritt);
  const kmMax = Math.max(...mit.map(q => q.fp.kmGesamt), 0.1);
  const x = t => L + (t - t0) / (t1 - t0) * (W - L - R);
  const y = km => T + km / kmMax * (H - T - B);

  let gitter = '';
  for (let t = t0; t <= t1; t += schritt) {
    gitter += `<line x1="${x(t).toFixed(1)}" y1="${T}" x2="${x(t).toFixed(1)}" y2="${H - B}" stroke="#bbb" stroke-width="0.8"/>
      <text x="${x(t).toFixed(1)}" y="${H - B + 32}" text-anchor="middle" font-size="12">${zeitText(t)}</text>`;
  }
  const ref = mit[0].fp.zeilen;
  const kpLinien = ref.map(z => `<line x1="${L}" y1="${y(z.km).toFixed(1)}" x2="${W - R}" y2="${y(z.km).toFixed(1)}" stroke="#ddd" stroke-width="0.8" stroke-dasharray="3 3"/>
    <text x="${L - 8}" y="${(y(z.km) + 4).toFixed(1)}" text-anchor="end" font-size="12">${z.nr} ${e((z.kp.ort || '').slice(0, 18))}</text>
    <text x="${L - 8}" y="${(y(z.km) + 15).toFixed(1)}" text-anchor="end" font-size="9.5" fill="#555">km ${zahl(z.km, 1)}</text>`).join('');

  const linien = mit.map((q, i) => {
    const st = LINIEN[i % LINIEN.length];
    const pts = [];
    q.fp.zeilen.forEach(z => {
      pts.push([x(z.an), y(z.km)]);
      if (z.halt > 0) pts.push([x(z.ab), y(z.km)]);
    });
    const d = pts.map((c, k) => `${k ? 'L' : 'M'}${c[0].toFixed(1)} ${c[1].toFixed(1)}`).join('');
    return `<path d="${d}" fill="none" stroke="${st.farbe}" stroke-width="2.6" ${st.strich ? `stroke-dasharray="${st.strich}"` : ''} stroke-linejoin="round"/>
      <text x="${(pts[0][0] + 5).toFixed(1)}" y="${(pts[0][1] + 16).toFixed(1)}" font-size="12" font-weight="700" fill="${st.farbe}">${e(q.kolonne.name)}</text>`;
  }).join('');

  const warn = konflikte.map(k => {
    const z = ref[k.nr - 1];
    const a = Math.max(k.a.von, k.b.von), bb = Math.min(k.a.bis, k.b.bis);
    return `<rect x="${x(a).toFixed(1)}" y="${(y(z.km) - 9).toFixed(1)}" width="${Math.max(6, x(bb) - x(a)).toFixed(1)}" height="18" rx="3" fill="rgba(198,40,40,.18)" stroke="#c62828" stroke-width="1.6"/>`;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${H}" class="diagramm" role="img" aria-label="Weg-Zeit-Diagramm der Marschkolonnen">
    <rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="none" stroke="#666"/>
    ${gitter}${kpLinien}${warn}${linien}
    <text x="${L}" y="16" font-size="12" font-weight="700">Weg-Zeit-Diagramm (km ab Ablaufpunkt)</text>
  </svg>`;
}

function belegungsTabelle(p, b) {
  const mit = b.plaene.filter(q => q.fp.zeilen.length > 1);
  if (!mit.length) return '';
  const schritt = zeitSchritt(b.bis - b.von, 24);
  const t0 = Math.floor(b.von / schritt) * schritt;
  const t1 = Math.ceil(b.bis / schritt) * schritt;
  const slots = [];
  for (let t = t0; t <= t1; t += schritt) slots.push(t);
  const kopfZellen = slots.map(t => `<th>${zeitText(t)}</th>`).join('');
  const zeilen = mit.map(q => {
    const z = slots.map(t => {
      if (t < q.fp.start || t > q.fp.ende + 0.001) return '<td></td>';
      return `<td>${zahl(fahrzeitBei(q.fp, t), 0)}</td>`;
    }).join('');
    return `<tr><th class="zeilenkopf">Fahrzeit ${e(q.kolonne.name)} [min]</th>${z}</tr>`;
  }).join('');
  return `<table class="raster tabelle belegungstabelle">
    <thead><tr><th class="zeilenkopf">Entfernung [km] / Uhrzeit</th>${kopfZellen}</tr></thead>
    <tbody>${zeilen}</tbody></table>`;
}

function haltTabelle(p, b, konflikte) {
  const mit = b.plaene.filter(q => q.fp.zeilen.length > 1);
  if (!mit.length) return '';
  const ref = mit[0].fp.zeilen;
  const zeilen = ref.map((z, i) => ({ z, i })).filter(({ z, i }) =>
    mit.some(q => (q.fp.zeilen[i]?.halt || 0) > 0));
  if (!zeilen.length) return '<p class="leerhinweis">Keine Halte geplant.</p>';
  const koepfe = mit.map(q => `<th>${e(q.kolonne.name)}<br><small>an – ab</small></th>`).join('');
  const body = zeilen.map(({ z, i }) => {
    const k = konflikte.filter(c => c.nr === i + 1);
    const zellen = mit.map(q => {
      const r = q.fp.zeilen[i];
      return `<td>${r && r.halt > 0 ? `${zeitText(r.an)} – ${zeitText(r.ab)}` : '–'}</td>`;
    }).join('');
    return `<tr${k.length ? ' class="konflikt"' : ''}>
      <td>${e(TYP_NAME[z.kp.typ])}</td><td>${z.nr} ${e(z.kp.ort || '')}</td><td class="zahl">${zahl(z.km, 1)}</td>${zellen}
      <td>${k.length ? '⚠ ' + k.map(c => `${e(c.a.name)} / ${e(c.b.name)} überschneiden sich`).join('; ') : ''}</td></tr>`;
  }).join('');
  return `<table class="raster tabelle halttabelle">
    <thead><tr><th>Kennzeichnung</th><th>Ort</th><th>km</th>${koepfe}<th>Belegung</th></tr></thead>
    <tbody>${body}</tbody></table>`;
}

function belegungsplan(p) {
  const b = belegung(p);
  const konflikte = haltKonflikte(p);
  const hat = b.plaene.some(q => q.fp.zeilen.length > 1);
  const inhalt = `
    ${kopf('Fb Fü xx', 'Straßenbelegungsplan', p)}
    ${hat ? `${belegungsDiagramm(p, b, konflikte)}${belegungsTabelle(p, b)}<h3 class="zwischentitel">Halte und Platzbelegung</h3>${haltTabelle(p, b, konflikte)}`
          : leer('Noch keine Route: Kontrollpunkte unter „Route“ anlegen oder eine GPX-Datei laden.')}`;
  return blatt('belegung', 'quer', inhalt, p);
}

/* ====================================================================
   Unterlagenverteilung
   ==================================================================== */

function unterlagenverteilung(p) {
  const kopfZ = UNTERLAGEN_ROLLEN.map(r => `<th class="rolle"><span>${e(r.name)}</span></th>`).join('');
  const zeilen = p.unterlagen.zeilen.map(z => `<tr><td class="text">${e(z.name)}</td>${
    UNTERLAGEN_ROLLEN.map(r => `<td class="kreuz">${z.rollen.includes(r.id) ? '×' : ''}</td>`).join('')}</tr>`).join('');
  const inhalt = `
    ${kopf('Fb Fü xx', 'Unterlagenverteilung', p)}
    <table class="raster tabelle unterlagen">
      <thead><tr><th class="text">Unterlage</th>${kopfZ}</tr></thead>
      <tbody>${zeilen}</tbody>
    </table>`;
  return blatt('unterlagen', 'hoch', inhalt, p);
}

/* ====================================================================
   Hilfsmittel: Weg-Zeit-Tabelle, Durchlaufzeit, Hilfestellung
   ==================================================================== */

function wegZeit(p) {
  const t = wegZeitTabelle({ bisKm: Math.max(1, Math.min(500, +p.hilfsmittel.wegZeit.bisKm || 200)) });
  const kopfZ = t.geschwindigkeiten.map(v => `<th>${v}</th>`).join('');
  const zeilen = t.zeilen.map(r => `<tr><th>${r.km}</th>${r.min.map(m => `<td>${zahl(m, 1)}</td>`).join('')}</tr>`).join('');
  const inhalt = `
    ${kopf('Fb Fü 03', 'Weg-Zeit-Tabelle', p)}
    <table class="raster tabelle wegzeit">
      <thead>
        <tr><th rowspan="2">Marschlänge<br>bzw.<br>Entfernung<br>(km)</th><th colspan="${t.geschwindigkeiten.length}">Durchschnittsgeschwindigkeit (km/h)</th></tr>
        <tr class="zwischen">${kopfZ}</tr>
        <tr class="einheit"><th></th><th colspan="${t.geschwindigkeiten.length}">Zeitbedarf in Minuten</th></tr>
      </thead>
      <tbody>${zeilen}</tbody>
    </table>`;
  return blatt('wegzeit', 'hoch', inhalt, p);
}

function durchlaufzeit(p) {
  const d = p.hilfsmittel.durchlauf;
  const t = durchlaufTabelle({
    vA: +d.vA || 40, vB: +d.vB || 70, fahrzeugLaenge: +d.fahrzeugLaenge || 7,
    bisN: Math.max(3, Math.min(100, +d.bisN || 30))
  });
  const zeilen = t.zeilen.map(r => `<tr><th>${r.n}</th>
    <td>${zahl(r.a.laengeM, 0)}</td><td>${zahl(r.b.laengeM, 0)}</td>
    <td>${zahl(Math.round(r.a.sek), 0)}</td><td>${zahl(Math.round(r.b.sek), 0)}</td></tr>`).join('');
  const inhalt = `
    ${kopf('Fb Fü xx', 'Marschlänge – Durchlaufzeit', p)}
    <p class="untertitel">Fahrzeuglänge ${zahl(+d.fahrzeugLaenge || 7, 1)} m; Fahrzeugabstand = halber Tachowert in Metern
      (${zahl(t.vA / 2, 0)} m bei ${t.vA} km/h, ${zahl(t.vB / 2, 0)} m bei ${t.vB} km/h).</p>
    <table class="raster tabelle durchlauf">
      <thead>
        <tr><th rowspan="2">Anzahl der<br>Fahrzeuge</th><th colspan="2">Marschlänge (Meter)</th><th colspan="2">Durchlaufzeit (Sekunden)</th></tr>
        <tr><th>${t.vA} km/h</th><th>${t.vB} km/h</th><th>${t.vA} km/h</th><th>${t.vB} km/h</th></tr>
      </thead>
      <tbody>${zeilen}</tbody>
    </table>`;
  return blatt('durchlauf', 'hoch', inhalt, p);
}

function hilfestellung(p) {
  const r = p.hilfsmittel.rechner;
  const ergebnis = marschHilfe(r);
  const feld = (v, einheit = '') => `<td class="eingabe">${v === '' || v === null || v === undefined ? '' : e(zahl(+v, 2) + (einheit ? ' ' + einheit : ''))}</td>`;
  const zeit = ergebnis.marschzeitMin === null ? '' : `${Math.floor(ergebnis.marschzeitMin / 60)}:${String(ergebnis.marschzeitMin % 60).padStart(2, '0')} h`;
  const inhalt = `
    ${kopf('Fb Fü xx', 'Hilfestellung Marschplanung', p)}
    <table class="raster hilfe">
      <tr><th>Anzahl Einzel-KFZ</th>${feld(r.einzel)}<td class="hinweis"></td></tr>
      <tr><th>Anzahl Gespanne</th>${feld(r.gespanne)}<td class="hinweis"></td></tr>
      <tr><th>Marschgeschwindigkeit</th>${feld(r.v, 'km/h')}<td class="hinweis"></td></tr>
      <tr><th>Marschkolonnen</th>${feld(r.kolonnen)}<td class="hinweis"></td></tr>
      <tr><th>Marschentfernung</th>${feld(r.km, 'km')}<td class="hinweis"></td></tr>
      <tr><th>Marschunterbrechung</th>${feld(r.unterbrechung, 'min')}<td class="hinweis">Alle geplanten Marschunterbrechungen in Minuten aufsummiert.</td></tr>
      <tr><th>Fahrzeugabstände</th>${feld(r.abstand, 'm')}<td class="hinweis"></td></tr>
      <tr><th>Marschkolonnenabstand</th>${feld(r.kolonnenabstand, 'm')}<td class="hinweis">Abstand zwischen Marschkolonnen/Marschgruppen; konkreten Planungswert fachlich festlegen.</td></tr>
      <tr><th>Fahrzeuglänge Einzel-KFZ</th>${feld(r.laengeEinzel, 'm')}<td class="hinweis"></td></tr>
      <tr><th>Fahrzeuglänge Gespanne</th>${feld(r.laengeGespann, 'm')}<td class="hinweis"></td></tr>
      <tr class="trenn"><th>Marschlänge</th><td class="ergebnis">${ergebnis.laengeM === null ? '' : e(zahl(ergebnis.laengeM, 0) + ' m')}</td><td class="hinweis">Fahrzeuglängen + Fahrzeugabstände + Abstände zwischen den Marschkolonnen.</td></tr>
      <tr><th>Marschzeit</th><td class="ergebnis">${e(zeit)}</td><td class="hinweis">Fahrzeit bis Eintreffen des ersten Fahrzeugs am Auslaufpunkt, einschließlich der Unterbrechungen.</td></tr>
      <tr><th>Durchlaufzeit</th><td class="ergebnis">${ergebnis.durchlaufSek === null ? '' : e(sekundenText(ergebnis.durchlaufSek))}</td><td class="hinweis">Zeit, die der vollständige Verband zum Passieren eines Punktes benötigt.</td></tr>
    </table>
    <p class="legende"><span class="kasten eingabe"></span> Eingabe <span class="kasten ergebnis"></span> berechneter Wert</p>`;
  return blatt('hilfe', 'quer', inhalt, p);
}

/* ====================================================================
   Verzeichnis
   ==================================================================== */

export const BLAETTER = [
  { id: 'marschauftrag', titel: 'Marschauftrag', vnr: 'Fb Fü 55', ausrichtung: 'hoch', gruppe: 'plan', render: marschauftrag },
  { id: 'marschtabelle', titel: 'Marschtabelle', vnr: 'Fb Fü xx', ausrichtung: 'quer', gruppe: 'plan', render: marschtabelle, jeKolonne: true },
  { id: 'marschskizze', titel: 'Marschskizze', vnr: 'Fb Fü 54', ausrichtung: 'hoch', gruppe: 'plan', render: marschskizze },
  { id: 'belegung', titel: 'Straßenbelegungsplan', vnr: '', ausrichtung: 'quer', gruppe: 'plan', render: belegungsplan },
  { id: 'unterlagen', titel: 'Unterlagenverteilung', vnr: 'Fb Fü xx', ausrichtung: 'hoch', gruppe: 'plan', render: unterlagenverteilung },
  { id: 'wegzeit', titel: 'Weg-Zeit-Tabelle', vnr: 'Fb Fü 03', ausrichtung: 'hoch', gruppe: 'hilfsmittel', render: wegZeit },
  { id: 'hilfe', titel: 'Hilfestellung Marschplanung', vnr: 'Fb Fü xx', ausrichtung: 'quer', gruppe: 'hilfsmittel', render: hilfestellung },
  { id: 'durchlauf', titel: 'Marschlänge – Durchlaufzeit', vnr: 'Fb Fü xx', ausrichtung: 'hoch', gruppe: 'hilfsmittel', render: durchlaufzeit }
];

export const BLATT_NACH_ID = Object.fromEntries(BLAETTER.map(b => [b.id, b]));

export function blattHtml(id, projekt) {
  return BLATT_NACH_ID[id].render(projekt);
}
