# Lizenzen

Der Marschplaner selbst hat noch keine Lizenzdatei – die Wahl steht aus.

## Mitgelieferte Fremdbibliotheken

| Bibliothek | Version | Lizenz | Herkunft |
|---|---|---|---|
| Leaflet | 1.9.4 | BSD-2-Clause | https://leafletjs.com |

Leaflet liegt unverändert unter `vendor/leaflet/`; der Lizenztext steht im Kopf von
`leaflet.js`. Es gibt keine CDN-Abhängigkeit.

## Zur Laufzeit abgerufen

- **Kartenkacheln** © OpenStreetMap-Mitwirkende (ODbL), `tile.openstreetmap.org`,
  unter der [Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/).
- **Ortsnamen** (nur auf Knopfdruck): Nominatim, `nominatim.openstreetmap.org`,
  höchstens eine Anfrage pro Sekunde.
