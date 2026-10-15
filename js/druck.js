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

/**
 * Wartet (höchstens `grenzeMs`), bis die Kartenkacheln der Skizzen geladen sind – sonst druckt der
 * Browser leere Flächen. Zählt, welche nicht angekommen sind (Fehler oder noch unterwegs).
 * @returns {Promise<{gesamt:number, fehlend:number}>}
 */
async function bilderLaden(wurzel, grenzeMs) {
  const urls = [...new Set([...wurzel.querySelectorAll('image')].map(i => i.getAttribute('href')).filter(Boolean))];
  if (!urls.length) return { gesamt: 0, fehlend: 0 };
  const status = new Map(urls.map(u => [u, false]));
  const laden = Promise.all(urls.map(u => new Promise(fertig => {
    const bild = new Image();
    bild.onload = () => { status.set(u, true); fertig(); };
    bild.onerror = () => fertig();
    bild.src = u;
  })));
  await Promise.race([laden, new Promise(r => setTimeout(r, grenzeMs))]);
  return { gesamt: urls.length, fehlend: [...status.values()].filter(ok => !ok).length };
}

/** Planung ohne Kartenhintergrund: nur der Linienzug, immer lesbar */
function ohneKarte(projekt) {
  return { ...projekt, druck: { ...projekt.druck, kartenHintergrund: false } };
}

/**
 * Druckt die Blätter. Sind Kartenkacheln nicht angekommen, fragt `beiFehlenden({gesamt, fehlend})`
 * nach: 'ohne' (ohne Kartenhintergrund drucken), 'abbruch' oder 'trotzdem'.
 * @returns {Promise<boolean>} ob der Druckdialog geöffnet wurde
 */
export async function drucken(ids, projekt, { beiFehlenden = null } = {}) {
  const gueltig = ids.filter(id => BLATT_NACH_ID[id]);
  if (!gueltig.length) return false;
  const ziel = document.getElementById('druck');
  const setzen = (p) => { ziel.innerHTML = gueltig.map(id => blattHtml(id, p)).join(''); };
  setzen(projekt);

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
  const { gesamt, fehlend } = await bilderLaden(ziel, navigator.onLine === false ? 3000 : 12000);
  if (fehlend) {
    const wahl = beiFehlenden ? await beiFehlenden({ gesamt, fehlend }) : 'trotzdem';
    if (wahl === 'abbruch') { zurueck(); return false; }
    if (wahl === 'ohne') setzen(ohneKarte(projekt));
  }
  setTimeout(() => window.print(), 80);       // dem Browser einen Takt für das Layout geben
  return true;
}

export { ohneKarte };
