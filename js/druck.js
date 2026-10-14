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

export function drucken(ids, projekt) {
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
  setTimeout(() => window.print(), 80);       // dem Browser einen Takt für das Layout geben
  return true;
}
