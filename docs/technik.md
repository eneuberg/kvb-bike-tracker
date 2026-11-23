# Technik

Kurzreferenz für Betrieb, Daten und Methode. Überblick: [README](../README.md).

## Betrieb

**Container (empfohlen):** `docker-compose.yml` startet einen dauerhaften Prozess. Er fragt den Feed ab, schreibt den Verlauf ins Volume `tracker-data` und liefert die Karte auf Port 8080 aus. In Coolify: *New Resource → Docker Compose → dieses Repo*, Domain auf Service `tracker` (Port 8080). Beim ersten Start mit leerem Volume übernimmt der Container den Verlauf aus dem Image (`data/history`). Danach führt er ihn selbst weiter.

**GitHub Actions:** `.github/workflows/update.yml` fragt alle 15 Minuten ab, committet den Verlauf und veröffentlicht auf Pages. GitHub startet geplante Läufe allerdings oft nur wenige Male am Tag. Einmalig einrichten: *Settings → Pages → Source: GitHub Actions*.

**Lokal:**

```bash
pip install -r requirements.txt
python -m tracker once     # eine Abfrage nach ./data
python -m tracker serve    # Schleife + http://localhost:8080
python -m pytest -q        # Tests, ohne Netz
```

### Einstellungen (Umgebungsvariablen)

| Variable | Standard | Bedeutung |
|---|---|---|
| `UPDATE_INTERVAL_MINUTES` | `1` (Compose), sonst `15` | Abfrageintervall. nextbike aktualisiert einmal pro Minute, feiner bringt nichts |
| `UPDATE_JITTER_SECONDS` | `15` | Abstände schwanken um ± so viel, ab und zu länger |
| `MANUAL_REFRESH_MINUTES` | `1` | „Jetzt abfragen“ auf der Seite, für alle zusammen höchstens so oft (`0` = aus) |
| `TRAIL_MAX_DAYS` | `7` | längster Zeitraum für den Verlauf eines Rads oder einer Station |
| `ANALYSIS_DAYS` | `56` | so viele Tage lädt die Web-App höchstens |
| `TIMELINE_STEP_MINUTES` | `1` (Compose), sonst `5` | Abfragen, die näher beieinander liegen, werden in der Zeitleiste zusammengefasst |
| `ANALYSIS_INTERVAL_MINUTES` | `2` (Compose), sonst `30` | Zeitleisten-Dateien so oft neu bauen (letzte 2 Tage; alle Tage höchstens stündlich) |
| `NEXTBIKE_DOMAIN` | `kg` | nextbike-Netz (`kg` = KVB-Rad Köln) |
| `NEXTBIKE_CITY_ID` | – | stattdessen auf eine Stadt-UID beschränken |
| `MOVE_THRESHOLD_M` | `25` | ab dieser Strecke gilt ein Rad als bewegt |
| `RENDER_PNG` | `true` | `map.png`/`heatmap.png` bei jeder Abfrage rendern (im Container `false` spart CPU) |
| `TILE_API_KEY` | – | [CARTO-Key](https://carto.com/basemaps/apikey) für die PNG-Hintergrundkarte |

### Endpunkte (Container)

`/` Karte · `/latest.json` aktueller Stand · `/status.json` Zeit der letzten Abfrage und App-Version · `/history/` alle CSVs · `/map.png`, `/heatmap.png` · `POST /api/refresh` manuelle Abfrage (`429` mit `Retry-After`, wenn zu früh).

Eine offene Seite prüft `status.json` jede Minute und lädt neue Daten ohne Neuladen nach.

## Daten

```
data/history/
  runs.csv                          eine Zeile pro Abfrage
  2026/10/2026-10-29.csv            Rad-Ereignisse des Tages
  2026/10/2026-10-29.stations.csv   Stationsstand des Tages
```

Ereignisse: `snapshot` (voller Stand, erste Abfrage des Tages), `new` (Rad taucht auf), `moved` (> `MOVE_THRESHOLD_M` oder andere Station), `changed` (Metadaten, z. B. Akku), `gone` (Rad verschwindet, meist ausgeliehen). Den Stand zu einem Zeitpunkt liefert `tracker.history.replay()`.

Pro Rad: Nummer, Position, an Station oder frei, Stationsname, E-Bike und Akku, nextbike-Metadaten. Pro Station: Name, Nummer, Räder, Stellplätze.

Ein Feed ist rund 70 KB (gzip) bzw. 1,2 MB JSON; der Verlauf wächst um wenige KB pro Abfrage.

## Methode und Grenzen

- **Keine echten Ausleihzeiten:** Weder der Live-Feed noch GBFS haben Zeitstempel pro Rad (geprüft mit `probe.yml`). GBFS rotiert außerdem die Rad-IDs. Zeiten sind daher nur so genau wie das Abfrageintervall.
- **Fahrten sind abgeleitet:** Ein Rad verschwindet und taucht mindestens 100 m entfernt wieder auf (Abwesenheit über 4 h gilt als Werkstatt) oder springt über 300 m zwischen zwei Abfragen. Lücken über 1 h werden nicht gezählt. Umsetzen per Transporter lässt sich nicht sicher trennen.
- **Routen sind geschätzt:** `tools/build_graph.py` baut monatlich (`graph.yml`) ein Radnetz aus OpenStreetMap. Radwege werden bevorzugt, Hauptstraßen, schlechter Belag und Schieben bestraft, Einbahnstraßen beachtet. Der Browser rechnet A\* in einem Web Worker (~1 ms pro Route). Das ist der plausibelste Weg, nicht der tatsächlich gefahrene.
- **Verfügbarkeit:** pro Abfrage exakte euklidische Distanztransformation, gemittelt über die gewählten Tage zur gleichen Tageszeit (Europe/Berlin, Feiertage zählen als Werktage).
- **Quelle:** `api.nextbike.net/maps/nextbike-live.json` ist öffentlich, aber undokumentiert und kann sich ändern.
- **Karten:** OpenFreeMap (ohne Key) für die Web-Karte; die PNGs nutzen mit `TILE_API_KEY` CARTO. Server-seitiges Vorladen von OSM-Kacheln ist laut [Tile Policy](https://operations.osmfoundation.org/policies/tiles/) nicht erlaubt.
