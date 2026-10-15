// druck.js – Blätter drucken bzw. als PDF speichern
//
// Es gibt keinen eigenen PDF-Erzeuger: Die gewählten Blätter werden in einen
// verborgenen Bereich gesetzt, `print.css` blendet die Anwendung aus, und der
// Browser druckt. „Als PDF speichern“ im Druckdialog liefert die Datei – mit
// Text, der sich markieren und durchsuchen lässt, und mit dem Seitenformat, das
// das Blatt verlangt (A4 hoch oder quer).

import { blattHtml, BLATT_NACH_ID } from './blaetter.js';

/** Ein Dateiname, den der Browser dem PDF vorschlägt */
export function pdfName(projekt) {
  const roh = (projekt.name || 'Marschplanung').trim() || 'Marschplanung';
  return roh.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').slice(0, 80);
}

/** Wartet (höchstens 12 s), bis die Kartenkacheln der Skizzen geladen sind – sonst druckt der Browser leere Flächen */
async function bilderLaden(wurzel) {
  const urls = [...new Set([...wurzel.querySelectorAll('image')].map(i => i.getAttribute('href')).filter(Boolean))];
  if (!urls.length) return;
  const laden = Promise.all(urls.map(u => new Promise(fertig => {
    const bild = new Image();
    bild.onload = bild.onerror = fertig;
    bild.src = u;
  })));
  await Promise.race([laden, new Promise(r => setTimeout(r, 12000))]);
}

export async function drucken(ids, projekt) {
  const gueltig = ids.filter(id => BLATT_NACH_ID[id]);
  if (!gueltig.length) return false;
  const ziel = document.getElementById('druck');
  ziel.innerHTML = gueltig.map(id => blattHtml(id, projekt)).join('');

  const titelVorher = document.title;
  document.title = pdfName(projekt);          // Chrome und Safari schlagen daraus den PDF-Namen vor
  document.body.classList.add('druckt');

  const zurueck = () => {
    window.removeEventListener('afterprint', zurueck);
    document.body.classList.remove('druckt');
    document.title = titelVorher;
    ziel.innerHTML = '';
  };
  window.addEventListener('afterprint', zurueck);
  await bilderLaden(ziel);
  setTimeout(() => window.print(), 80);       // dem Browser einen Takt für das Layout geben
  return true;
}
