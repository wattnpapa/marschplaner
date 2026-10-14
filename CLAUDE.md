# Hinweise für Claude Code

Marschplaner plant geschlossene Marschverbände und gibt die Blätter der Excel-Vorlage
„All in one Marschverband“ als druckfertige Seiten aus. Funktionsumfang und
Bedienung stehen in der `README.md`; hier steht, was beim Arbeiten am Quelltext gilt.

## Grundsätze

**Kein Build-Schritt, keine Abhängigkeiten.** Reines ES-Modul-JavaScript ohne
Framework, Bundler oder Paketmanager – es gibt keine `package.json` und soll keine
geben. Fremdcode liegt entpackt unter `vendor/` (Leaflet) und steht in `LIZENZEN.md`.

**Alle Pfade relativ.** Die Seite muss in einem Unterverzeichnis laufen (GitHub Pages).

**Die Daten bleiben auf dem Gerät.** Kein Server, kein Konto. Nach außen gehen nur
Kartenkacheln und – nach Rückfrage – Nominatim-Abfragen. Jede weitere Verbindung ist ein
Bruch mit der Zusage in der README und braucht eine ausdrückliche Entscheidung.

**Zustand nur über `js/state.js`.** Änderungen laufen durch `aendern(fn, schluessel)`,
sonst greifen Speichern, Rückgängig und Neuzeichnen nicht. Wird das Schema erweitert:
`SCHEMA` in `daten.js` hochzählen und alte Stände in `migrieren()` umsetzen – im
`localStorage` der Nutzer liegen echte Planungen.

**Rechnen ohne Oberfläche.** `js/rechnen.js`, `geo.js`, `gpx.js`, `route.js` kennen kein DOM
und werden mit `node --test tests/` geprüft. Neue Formeln gehören dorthin und bekommen
einen Test. `blaetter.js` erzeugt reines HTML (Projekt rein, String raus) für Vorschau
*und* Druck; `css/blatt.css` gibt den Blättern ihr Aussehen, `css/print.css` Seitenformat
und Umbrüche.

**Das Formular wird beim Tippen nicht neu aufgebaut.** Felder tragen `data-p="pfad"`
(`@id` wählt Listenelemente), der `input`-Handler in `app.js` schreibt in den Speicher,
nur die Vorschau zeichnet neu. Abgeleitete Anzeigen im Formular aktualisiert
`abgeleitetAktualisieren()`. Neu aufgebaut wird nur bei Strukturänderungen (`render()`).

**Einheiten:** km, m, Minuten, km/h; Uhrzeiten als Minuten seit Mitternacht (dürfen > 1440).
Die Fahrplanrechnung rundet auf ganze Minuten, ohne dass sich der Fehler aufsummiert.

## Sprache

Alles deutsch: Bezeichner, Kommentare, Oberfläche, Commit-Betreffs. Umlaute in
Bezeichnern umschreiben (`aendern`, `schliesse`), in Zeichenketten bleiben sie.
Typografie in sichtbaren Texten: „Anführungszeichen“, Gedankenstrich –, geschütztes
Leerzeichen vor Einheiten wo es auf dem Blatt zählt.

## Prüfen

```bash
node --test tests/                 # muss grün sein
python3 -m http.server 8765        # im Browser: Beispiel laden, alle Blätter durchsehen, Druckvorschau
```
