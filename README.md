# Marschplaner

Planungswerkzeug für **geschlossene Marschverbände**. Eine Marschplanung wird im
Browser erstellt – Route aus einer GPX-Datei (z. B. TomTom MyDrive Route Planner),
Kolonnen, Halte – und als druckfertige Blätter ausgegeben, die den Tabellenblättern
der Excel-Vorlage „All in one Marschverband“ entsprechen.

Die Anwendung läuft vollständig im Browser. Es gibt keinen Server, kein Konto und
keine Cookies; Planungen liegen im `localStorage` des Browsers und lassen sich als
`.json`-Datei sichern und weitergeben.

## Was sie kann

- **GPX laden** (Track, Route, Wegpunkte; Drag & Drop). Benannte Wegpunkte werden
  Kontrollpunkte, Ablauf- und Zielpunkt ergeben sich aus Anfang und Ende.
- **Straßenarten automatisch:** Nach dem Import fragt der Marschplaner OpenStreetMap
  (Overpass) entlang der Route ab und bestimmt alle 100 m Straßenart (Autobahn,
  Bundes-/Landstraße, Ortschaft) und Straßennummer. Jeder Abschnitt wird anteilig
  gerechnet (z. B. 70 % BuL, 30 % Ort) und trägt seine Straßennummern („A 81 / B 27“).
  Ein fester Wert am Kontrollpunkt überstimmt das. „Ortschaft“ wird aus Straßenklasse und
  Höchstgeschwindigkeit geschlossen – ein Vorschlag, den die Planerin prüft.
- **Karte** mit Abschnitten nach Straßenart (BAB / BuL / Ort); Kontrollpunkte lassen
  sich entlang der Strecke ziehen, ein Klick auf die Strecke setzt neue.
- **Rechnung** je Marschkolonne: Fahrzeit nach Straßenart, Halte, Uhrzeiten,
  Marschlänge, Durchlaufzeit. Versatz zwischen Kolonnen; Prüfung auf zeitgleiche Halte.
- **Blätter** (je A4, hoch oder quer, im Browser als PDF speicherbar):

  | Blatt | Vorlage |
  |---|---|
  | Marschauftrag | Fb Fü 55 – leere Felder füllen sich aus der Planung |
  | Marschtabelle | je Kolonne ein Blatt |
  | Marschskizze | Fb Fü 54 – Ortsskizzen aus dem Streckenverlauf |
  | Straßenbelegungsplan | Weg-Zeit-Diagramm, Fahrzeit-Raster, Platzbelegung der Halte |
  | Unterlagenverteilung | Matrix Unterlage × Empfänger |
  | Weg-Zeit-Tabelle | Fb Fü 03 |
  | Hilfestellung Marschplanung, Marschlänge – Durchlaufzeit | Rechenhilfen |

Nicht übernommen: das Blatt `Marschtabelle_a_la_Strott` (in der Vorlage selbst als
Altbestand gekennzeichnet) und das Blatt `START_2026` (sein Text steht als Hinweis
auf jedem Blatt).

## PDF

„Drucken / PDF“ öffnet den Druckdialog des Browsers; dort „Als PDF speichern“.
Hohe und quere Blätter werden über benannte Seiten (`@page hoch|quer`) im richtigen
Format gesetzt – das beherrschen Chrome, Edge und Firefox; Safari setzt sie bisher
nicht zuverlässig. Papier A4, Skalierung 100 %, Browser-Kopf-/Fußzeilen aus.

## Entwickeln

Kein Build-Schritt, keine Abhängigkeiten, kein Paketmanager (siehe `CLAUDE.md`).

```bash
python3 -m http.server 8765      # dann http://localhost:8765
node --test "tests/*.test.mjs"              # Rechenkern, GPX, Blätter
```

Veröffentlicht wird über GitHub Actions (`.github/workflows/pages.yml`): Bei jedem Push auf
`main` laufen die Tests, dann geht die Seite nach GitHub Pages (Settings → Pages →
Source: „GitHub Actions“). Alle Pfade sind relativ, die Seite läuft auch in einem Unterverzeichnis.

## Datenschutz

Nach außen gehen nur die Kartenkacheln von `tile.openstreetmap.org` (der Anbieter sieht
den betrachteten Kartenausschnitt) und – nur nach ausdrücklicher Rückfrage – Koordinaten
einzelner Kontrollpunkte an `nominatim.openstreetmap.org`, wenn „Ortsnamen ermitteln“
gedrückt wird. Die automatische Straßenerkennung sendet den vereinfachten Streckenverlauf in
Stücken von 10 km an `overpass-api.de` (Ausweichserver: `overpass.kumi.systems`); der Browser
fragt dafür einmalig um Zustimmung und merkt sie sich. Ohne Zustimmung gelten alle Abschnitte
als Bundes-/Landstraße. Die Planung selbst verlässt den Browser nicht.

## Lizenz

EUPL-1.2, siehe `LICENSE`; Fremdbibliotheken in `LIZENZEN.md`.

## Hinweise zur Vorlage

Die Planungswerte der Vorlage sind Vorgaben, vor Nutzung fachlich zu prüfen. Beim
Nachbau sind in der Vorlage aufgefallen und hier bewusst anders gelöst:

- **Durchlaufzeit** (Blatt *Hilfestellung*) teilt Meter durch km/h und nennt das Minuten –
  rund 17-fach zu groß. Hier: Länge ÷ (v / 3,6) in Sekunden; die Vorlagentabelle
  *Marschlänge – Durchlaufzeit* wird damit exakt reproduziert (Test).
- **Fahrzeugabstand auf Bundesstraßen:** Marschauftrag nennt 50 m, die Marschtabelle
  „Timmerman“ 100 m. Vorgabe hier: 50 m (änderbar unter Eckdaten).
- **Marschlänge in der Marschskizze** verwies in der Vorlage auf die Marschentfernung (3c)
  statt auf die Marschlänge.
- **Kolonnenabstand** zählt (Kolonnen − 1)-mal statt einmal pauschal.
