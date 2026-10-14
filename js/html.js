// html.js – Text für HTML maskieren

const ERSATZ = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Maskiert Text für den Einsatz in Inhalt und in Attributwerten */
export function e(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ERSATZ[c]);
}
