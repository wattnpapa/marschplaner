// karte.js – Streckenkarte mit Leaflet
//
// Die Karte zeichnet nur den Track, die Abschnitte nach Straßenart und die
// Kontrollpunkte. Punkte lassen sich entlang des Tracks verschieben; wohin der
// Punkt fällt, entscheidet der Aufrufer (er rechnet den Kilometerstand aus).
// Neu gezeichnet wird nur, wenn sich etwas Sichtbares geändert hat.

import { teilTrack, naechsterKm, punktBeiKm, koordText } from './geo.js';
import { sortierteKp, KLASSE_KURZ, TYP_NAME, zahl } from './rechnen.js';
import { ART_NAME, umwegKm } from './plaetze.js';
import { klassenLaeufe } from './strassenart.js';

export const STRASSENFARBE = { bab: '#c62828', bul: '#003399', ort: '#1b7a3d' };
/** Kennbuchstabe je Platzart: die Karte muss auch ohne Farbe lesbar sein (Rot-Grün-Schwäche, S/W-Screenshot) */
const PLATZ_KUERZEL = { rast: 'R', parkplatz: 'P', tank: 'T' };

const KACHELN = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

/**
 * @param {HTMLElement} host
 * @param {{beiKpVerschoben:(id:string, lage:number[])=>void, beiKpSetzen:(km:number)=>void, beiPlatz?:(platz:object, typ:string)=>void}} rueck
 */
export function karteErzeugen(host, rueck) {
  const L = globalThis.L;
  if (!L) throw new Error('Leaflet ist nicht geladen.');

  const karte = L.map(host, { zoomControl: true, worldCopyJump: false });
  karte.setView([51.16, 10.45], 6);
  const kacheln = L.tileLayer(KACHELN, {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>-Mitwirkende'
  }).addTo(karte);
  const ebene = L.layerGroup().addTo(karte);
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(karte);

  // Fehlen Kacheln (kein Netz), bleibt die Strecke lesbar – das soll man auch erfahren
  const offline = document.createElement('div');
  offline.className = 'karte-hinweis';
  offline.hidden = true;
  offline.textContent = 'Kartenkacheln nicht geladen (kein Netz?) – Strecke und Punkte sind vollständig.';
  host.append(offline);
  kacheln.on('tileerror', () => { offline.hidden = false; });
  kacheln.on('tileload', () => { offline.hidden = true; });

  let plaetze = [];                // gefundene Rast-/Park-/Tankplätze
  let beste = new Set();           // ids der vorgeschlagenen Plätze
  let uebernommen = new Map();     // Platz-id → Nummer des Kontrollpunkts, der daraus wurde
  let weg = false;                 // nach entfernen() ignorieren verspätete Aufrufe
  let letzteSignatur = '';
  let letzterTrack = '';

  function popupAufTrack(track, lage) {
    const r = naechsterKm(track, [lage.lat, lage.lng]);
    if (!r) return;
    const box = document.createElement('div');
    const text = document.createElement('div');
    text.textContent = `Strecke: km ${zahl(r.km, 1)}`;
    const knopf = document.createElement('button');
    knopf.type = 'button';
    knopf.className = 'knopf klein popup-knopf';
    knopf.textContent = 'Kontrollpunkt hier setzen';
    knopf.addEventListener('click', () => { karte.closePopup(); rueck.beiKpSetzen(r.km); });
    box.append(text, knopf);
    L.popup().setLatLng(lage).setContent(box).openOn(karte);
  }

  function platzPopup(pl) {
    const box = document.createElement('div');
    const z = (t, fett = false) => { const d = document.createElement(fett ? 'strong' : 'div'); d.textContent = t; return d; };
    box.append(z(pl.name || ART_NAME[pl.art], true));
    const teile = [ART_NAME[pl.art], `km ${zahl(pl.km, 1)}`, `${pl.abstandM} m neben der Strecke`];
    if (pl.kapazitaet) teile.push(`${pl.kapazitaet} Stellplätze`);
    if (pl.lkw) teile.push('Lkw geeignet');
    if (pl.wc) teile.push('WC');
    const u = umwegKm(pl.abstandM);
    if (u) teile.push(`Umweg ca. ${zahl(u, 1)} km`);
    box.append(z(teile.join(' · ')));
    box.append(z(koordText(pl.lat, pl.lon) + ' (WGS 84)'));
    if (uebernommen.has(pl.id)) {
      box.append(z(`✓ Bereits als Punkt ${uebernommen.get(pl.id)} übernommen`, true));
      return box;
    }
    const leiste = document.createElement('div');
    leiste.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;margin-top:6px';
    for (const [typ, text] of [['rast', 'Rast'], ['th', 'Techn. Halt'], ['tank', 'Tanken']]) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'knopf klein'; b.textContent = `Als ${text} übernehmen`;
      b.addEventListener('click', () => { karte.closePopup(); rueck.beiPlatz?.(pl, typ); });
      leiste.append(b);
    }
    box.append(leiste);
    return box;
  }

  function aktualisieren(p, { einpassen = false } = {}) {
    if (weg) return;
    const track = p.route.track;
    const kps = sortierteKp(p.route);
    const sig = JSON.stringify([
      track.length, track[0], track[track.length - 1],
      kps.map(k => [k.id, k.km, k.typ, k.klasse, k.ort, k.strasse, k.abseits?.lat]), plaetze.length, [...beste].join(','), [...uebernommen.keys()].join(','), p.route.arten ? p.route.arten.k.length : 0
    ]);
    const trackSig = JSON.stringify([track.length, track[0], track[track.length - 1]]);
    if (sig === letzteSignatur && !einpassen) return;
    letzteSignatur = sig;

    ebene.clearLayers();
    if (track.length < 2) { letzterTrack = ''; return; }

    if (kps.length < 2) {
      L.polyline(track, { color: '#5c6879', weight: 4, opacity: 0.85 }).addTo(ebene);
    }
    for (let i = 1; i < kps.length; i++) {
      // „auto“: Straßenart wechselt innerhalb des Abschnitts → in Läufe zerlegen
      const laeufe = kps[i].klasse === 'auto' && p.route.arten
        ? klassenLaeufe(p.route.arten, kps[i - 1].km, kps[i].km)
        : [{ klasse: kps[i].klasse, von: kps[i - 1].km, bis: kps[i].km }];
      for (const lauf of laeufe) {
        const teil = teilTrack(track, lauf.von, lauf.bis);
        if (teil.length < 2) continue;
        const linie = L.polyline(teil, {
          color: STRASSENFARBE[lauf.klasse] || STRASSENFARBE.bul,
          weight: 6, opacity: 0.85, lineCap: 'round', lineJoin: 'round'
        }).addTo(ebene);
        linie.bindTooltip(`${KLASSE_KURZ[lauf.klasse] || ''} ${kps[i].strasse || ''}`.trim() || 'Abschnitt', { sticky: true });
        linie.on('click', ev => popupAufTrack(track, ev.latlng));
      }
    }

    // gefundene Plätze: Buchstabe statt nur Farbe (R Rast, P Parkplatz, T Tankstelle)
    for (const pl of plaetze) {
      const gut = beste.has(pl.id);
      const genommen = uebernommen.has(pl.id);
      const g = gut ? 26 : 20;
      const icon = L.divIcon({
        className: '',
        html: `<div class="platz-marker ${pl.art}${gut ? ' gut' : ''}${genommen ? ' genommen' : ''}">${genommen ? '✓' : PLATZ_KUERZEL[pl.art] || '?'}</div>`,
        iconSize: [g, g], iconAnchor: [g / 2, g / 2]
      });
      const m = L.marker([pl.lat, pl.lon], { icon, keyboard: false, zIndexOffset: gut ? 500 : 0 }).addTo(ebene);
      m.bindTooltip(`${pl.name || ART_NAME[pl.art]}${gut ? ' – Vorschlag' : ''}${genommen ? ' – übernommen' : ''}`);
      m.bindPopup(() => platzPopup(pl));
    }

    kps.forEach((kp, i) => {
      if (kp.abseits) {                                  // Platz abseits: gestrichelte Zu-/Abfahrt
        const auf = punktBeiKm(track, kp.km);
        if (auf) {
          L.polyline([auf, [kp.abseits.lat, kp.abseits.lon]], { color: '#000', weight: 2, dashArray: '5 5' }).addTo(ebene);
          L.circleMarker([kp.abseits.lat, kp.abseits.lon], { radius: 6, color: '#000', weight: 2, fillColor: '#fff', fillOpacity: 1 }).addTo(ebene);
        }
      }
      const lage = punktBeiKm(track, kp.km);
      if (!lage) return;
      const icon = L.divIcon({
        className: '',
        html: `<div class="kp-marker ${kp.typ}" data-typ="${kp.typ}">${i + 1}</div>`,
        iconSize: [26, 26], iconAnchor: [13, 13]
      });
      const m = L.marker(lage, { icon, draggable: true, keyboard: false, zIndexOffset: 1000 }).addTo(ebene);
      m.bindTooltip(`${i + 1} · ${kp.ort || TYP_NAME[kp.typ]}${kp.typ !== 'kp' && kp.ort ? ' (' + TYP_NAME[kp.typ] + ')' : ''}<br><small>km ${zahl(kp.km, 1)} · ca. ${koordText(lage[0], lage[1])}</small>`, { direction: 'top', offset: [0, -12] });
      m.on('dragend', () => {
        const ll = m.getLatLng();
        rueck.beiKpVerschoben(kp.id, [ll.lat, ll.lng]);
      });
    });

    if (einpassen || trackSig !== letzterTrack) {
      karte.fitBounds(L.latLngBounds(track), { padding: [30, 30] });
    }
    letzterTrack = trackSig;
  }

  return {
    aktualisieren,
    setzePlaetze(liste, ids, genommen) { plaetze = liste || []; beste = new Set(ids || []); uebernommen = genommen instanceof Map ? genommen : new Map(); letzteSignatur = ''; },
    /** Zeichnet alles neu, auch wenn sich nichts geändert hat (z. B. ein abgebrochenes Verschieben zurücksetzen) */
    neuZeichnen(p) { letzteSignatur = ''; aktualisieren(p); },
    groesseNeu() { if (!weg) karte.invalidateSize(); },
    einpassen(p) { aktualisieren(p, { einpassen: true }); },
    entfernen() { weg = true; try { karte.stop(); } catch { /* keine laufende Animation */ } karte.remove(); }
  };
}
