# Lizenzen

Der Marschplaner selbst steht unter der **EUPL-1.2**, siehe `LICENSE`.

## Mitgelieferte Fremdbibliotheken

| Bibliothek | Version | Lizenz | Herkunft |
|---|---|---|---|
| Leaflet | 1.9.4 | BSD-2-Clause | https://leafletjs.com |

Leaflet liegt unverändert unter `vendor/leaflet/`; der Lizenztext steht im Kopf von
`leaflet.js`. Es gibt keine CDN-Abhängigkeit.

## Zur Laufzeit abgerufen

- **Kartenkacheln** © OpenStreetMap-Mitwirkende (ODbL), `tile.openstreetmap.org`,
  unter der [Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/).
- **Straßenarten und -nummern:** Overpass API (`overpass-api.de`, Ausweichserver `overpass.kumi.systems`),
  Daten © OpenStreetMap-Mitwirkende (ODbL); nach einmaliger Zustimmung des Nutzers, in Stücken von 20 km.
- **Ortsnamen** (nur auf Knopfdruck): Nominatim, `nominatim.openstreetmap.org`,
  höchstens eine Anfrage pro Sekunde.
