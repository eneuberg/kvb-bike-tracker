# KVB-Rad bike tracker

Tracks every KVB-Rad bike in Köln via the public nextbike live API. It draws a map of all bikes with per-bike metadata, adds a density heatmap, and keeps a full history of positions and changes.

**Interactive map:** https://eneuberg.github.io/kvb-bike-tracker/

| View | What it shows |
|---|---|
| **Karte** | One timeline from the past up to *now* (the right end is live). Stations with counts, free-floating bikes, optional density, and estimated trips as dots travelling from start to destination. Press play to watch where bikes flow; tap a bike for details, "untouched since" and its path over the last days. |
| **Analyse** | Computed in your browser from the raw history, with free filters (date range, weekdays, time window from 00:00 to 24:00; small bars above the slider show at which times polls exist) and per-view parameters. A status line under the slider always says what a result is based on, or why it is empty. *Erreichbarkeit*: typical walking distance to the nearest bike (50 m raster) or chance of a bike within a chosen radius; tap anywhere for an exact profile. *Dichte*: average parked bikes per hectare. *Ströme*: most frequent connections with animated direction, net in/outflow per area (area size adjustable). *Nutzung*: bikes in use, trips per hour, duration, distance. *Stationen*: typical fill level and chance of being empty. *Standzeit*: how long bikes stand untouched, minutes to days. Each view explains how it is computed. |

The map uses MapLibre GL with [OpenFreeMap](https://openfreemap.org) vector tiles (free, no key), so markers and heatmaps scale smoothly while zooming. It works on phones (bottom sheet) and desktop (side panel), in light and dark mode.

### Current bikes
[![Current map of all KVB-Rad bikes](https://eneuberg.github.io/kvb-bike-tracker/map.png)](https://eneuberg.github.io/kvb-bike-tracker/)

### Density heatmap
[![Heatmap of KVB-Rad bike density](https://eneuberg.github.io/kvb-bike-tracker/heatmap.png)](https://eneuberg.github.io/kvb-bike-tracker/)

<sub>GitHub Actions updates both images every 15 minutes. GitHub's image proxy may show a copy that is a few minutes older.</sub>

---

## What gets collected

Per bike (fields are optional; they appear when the feed provides them):

| field | meaning |
|---|---|
| `bike` | bike number (stable ID) |
| `lat`, `lng` | position |
| `kind` | `station` (docked) or `free` (free-floating) |
| `place_name` | station name if docked |
| `electric`, `battery` | e-bike flag, battery % |
| `bike_type`, `state`, `active`, `lock_types` | nextbike metadata |

Per station: name, number, bikes docked, bikes available, racks, free racks, terminal type.

## History (`data/history/`)

Plain CSV, append-only, committed by every run:

```
data/history/
  runs.csv                          one row per poll: counts + new/moved/changed/gone
  2026/10/2026-10-29.csv            bike events of that day
  2026/10/2026-10-29.stations.csv   station snapshot of that day
```

Event types in a day file:

- **`snapshot`**: the full state of every bike, written by the first poll of each day. This makes every day file self-contained.
- **`new`**: a bike appeared in the feed (e.g. returned after a ride).
- **`moved`**: a bike changed position by more than `MOVE_THRESHOLD_M` (default 25 m) or changed station.
- **`changed`**: metadata changed (state, active, kind, or battery by at least 5 %).
- **`gone`**: a bike left the feed (usually rented, sometimes in service).

To reconstruct the state at time *t*, replay a day file up to *t*. `tracker.history.replay()` does this. A `gone` followed later by `new` at another place is approximately one trip.

The Pages site mirrors the last 31 days at `/history/`. The repo keeps everything.

## Run it

### GitHub Actions (this repo)
`.github/workflows/update.yml` runs every 15 minutes. It fetches, commits history, and deploys the map to GitHub Pages. You can trigger it by hand under **Actions → update map → Run workflow**.

One-time setup: **Settings → Pages → Source: GitHub Actions**. Optionally add a repository secret `TILE_API_KEY` (see *Basemap*).

### Coolify / Docker
`docker-compose.yml` runs a long-lived container that polls on its own schedule and serves the map on port 8080. History lives in the `tracker-data` volume.

In Coolify: **New Resource → Docker Compose → this repo**, assign a domain to the `tracker` service (port 8080), deploy.

On the first start with an empty volume, the container copies the history that GitHub Actions had recorded up to the image build (`data/history`), so the timeline does not start from zero. After that, the container keeps its own history in the volume and never overwrites it.

| env var | default | description |
|---|---|---|
| `UPDATE_INTERVAL_MINUTES` | `13` | poll interval in minutes (fractions allowed, minimum 1); 13 is prime, so it doesn't lock onto hourly patterns |
| `MANUAL_REFRESH_MINUTES` | `3` | container only: visitors can trigger a poll from the page, for all visitors together at most once per this many minutes (`0` = off). The automatic schedule counts from the latest poll, manual or not |
| `NEXTBIKE_DOMAIN` | `kg` | nextbike network ID (`kg` = KVB-Rad Köln) |
| `NEXTBIKE_CITY_ID` | – | restrict to one nextbike city UID instead |
| `MOVE_THRESHOLD_M` | `25` | movement threshold for `moved` events |
| `RENDER_PNG` | `true` | render `map.png` / `heatmap.png` on each update |
| `TILE_API_KEY` | – | free [CARTO basemap key](https://carto.com/basemaps/apikey) for the PNG renders; see *Basemap* below |
| `ANALYSIS_DAYS` | `56` | how many days of history the web app can load (Verlauf and Analyse) |
| `TIMELINE_STEP_MINUTES` | `5` | minimum spacing of exported polls (matters for 1-minute polling) |
| `ANALYSIS_INTERVAL_MINUTES` | `13` in compose (`30` otherwise) | container only: rebuild the timeline/analysis files at most this often |

The container serves `/` (interactive map), `/map.png`, `/heatmap.png`, `/latest.json` (current state), `/status.json` (time of the latest poll and app version) and `/history/` (all CSVs).

An open page checks `status.json` every minute, right after the next automatic poll is due, and when you return to the tab. New data is loaded in place. The badge top right shows the data time; tapping it opens a small panel with the schedule and, in the container, a "Jetzt neu abfragen" button (`POST /api/refresh`). The button is greyed out with a countdown until the minimum gap has passed; the limit is enforced on the server for all visitors together (one poll at a time, `429` with `Retry-After` when too early). On GitHub Pages the button only checks whether newer files have been published, because a static site cannot start a poll. A new app version shows "Neue Version" in the badge.

Locally:

```bash
docker compose up --build    # uncomment `ports` in the compose file first
# or without Docker:
pip install -r requirements.txt
python -m tracker once       # single update into ./data
python -m tracker serve      # loop + http://localhost:8080
```

### Tests
```bash
pip install pytest && python -m pytest -q
```
The tests use a synthetic feed and need no network.

## Notes and limits

- **Data source:** `api.nextbike.net/maps/nextbike-live.json`. It's public but undocumented, so nextbike can change it without notice. Use moderate poll intervals.
- **Rentals are inferred:** the feed shows only parked bikes, not rides. "Trips" come from `gone` → `new` pairs and are therefore approximations.
- **Analysis method:** `tracker/analysis.py` replays the CSV history and writes one compact file per day (`tl/YYYY-MM-DD.json`: full state at the first poll, then per-poll changes). `tracker/web/worker.js` loads the selected days in a Web Worker and computes everything there. Walking distance uses an exact Euclidean distance transform per poll; the stepped colours are classified on a 3–4× interpolated raster with anti-aliased edges, so the bands are round. Tap queries are computed exactly for the point. Trips are inferred: a bike leaves the feed and reappears at least *x* m away (default 100 m; absences over 4 h count as service), or jumps more than *y* m between two polls (default 300 m). Movements across a gap of more than an hour between two polls (missed runs) are not counted, because their time is unknown. Rebalancing by van can't be separated reliably. Hours use Europe/Berlin local time; public holidays count as normal weekdays.
- **Basemap:** CARTO now requires a free API key ([request one](https://carto.com/basemaps/apikey)). The interactive map uses OpenFreeMap. With `TILE_API_KEY` set, the PNG renders use CARTO light tiles (© OpenStreetMap contributors © CARTO; free up to 5M non-commercial requests/month). Without a key the PNGs are drawn without a basemap. OSM's [tile policy](https://operations.osmfoundation.org/policies/tiles/) forbids pre-fetching tiles server-side.
- **Schedule:** in public repos, GitHub pauses scheduled workflows after 60 days without repo activity. The history commits should keep this repo active.
