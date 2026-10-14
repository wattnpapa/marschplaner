// karte.js – Streckenkarte mit Leaflet
//
// Die Karte zeichnet nur den Track, die Abschnitte nach Straßenart und die
// Kontrollpunkte. Punkte lassen sich entlang des Tracks verschieben; wohin der
// Punkt fällt, entscheidet der Aufrufer (er rechnet den Kilometerstand aus).
// Neu gezeichnet wird nur, wenn sich etwas Sichtbares geändert hat.

import { teilTrack, naechsterKm, punktBeiKm } from './geo.js';
import { sortierteKp, KLASSE_KURZ, TYP_NAME, zahl } from './rechnen.js';

export const STRASSENFARBE = { bab: '#c62828', bul: '#003399', ort: '#1b7a3d' };

const KACHELN = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

/**
 * @param {HTMLElement} host
 * @param {{beiKpVerschoben:(id:string, lage:number[])=>void, beiKpSetzen:(km:number)=>void}} rueck
 */
export function karteErzeugen(host, rueck) {
  const L = globalThis.L;
  if (!L) throw new Error('Leaflet ist nicht geladen.');

  const karte = L.map(host, { zoomControl: true, worldCopyJump: false });
  karte.setView([51.16, 10.45], 6);
  L.tileLayer(KACHELN, {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>-Mitwirkende'
  }).addTo(karte);
  const ebene = L.layerGroup().addTo(karte);

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

  function aktualisieren(p, { einpassen = false } = {}) {
    if (weg) return;
    const track = p.route.track;
    const kps = sortierteKp(p.route);
    const sig = JSON.stringify([
      track.length, track[0], track[track.length - 1],
      kps.map(k => [k.id, k.km, k.typ, k.klasse, k.ort])
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
      const teil = teilTrack(track, kps[i - 1].km, kps[i].km);
      if (teil.length < 2) continue;
      const linie = L.polyline(teil, {
        color: STRASSENFARBE[kps[i].klasse] || STRASSENFARBE.bul,
        weight: 6, opacity: 0.85, lineCap: 'round', lineJoin: 'round'
      }).addTo(ebene);
      linie.bindTooltip(`${KLASSE_KURZ[kps[i].klasse] || ''} ${kps[i].strasse || ''}`.trim() || 'Abschnitt', { sticky: true });
      linie.on('click', ev => popupAufTrack(track, ev.latlng));
    }

    kps.forEach((kp, i) => {
      const lage = punktBeiKm(track, kp.km);
      if (!lage) return;
      const icon = L.divIcon({
        className: '',
        html: `<div class="kp-marker ${kp.typ}">${i + 1}</div>`,
        iconSize: [26, 26], iconAnchor: [13, 13]
      });
      const m = L.marker(lage, { icon, draggable: true, keyboard: false, zIndexOffset: 1000 }).addTo(ebene);
      m.bindTooltip(`${i + 1} · ${kp.ort || TYP_NAME[kp.typ]}`, { direction: 'top', offset: [0, -12] });
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
    groesseNeu() { if (!weg) karte.invalidateSize(); },
    einpassen(p) { aktualisieren(p, { einpassen: true }); },
    entfernen() { weg = true; karte.remove(); }
  };
}
