# KVB-Rad bike tracker

Tracks every KVB-Rad bike in Köln via the public nextbike live API. It draws a map of all bikes with per-bike metadata, adds a density heatmap, and keeps a full history of positions and changes.

**Interactive map:** https://eneuberg.github.io/kvb-bike-tracker/

| Mode | What it shows |
|---|---|
| **Live** | All bikes right now: stations (count = bikes docked), free-floating bikes, optional density layer. Tap a bike for details and "untouched since", tap a station for its typical fill level. Search by bike number, nearest bikes from your location. |
| **Verlauf** | Scrub or play through the last 7 days (10-min steps). The curve behind the slider is the estimated number of bikes in use. "Weg anzeigen" draws where a single bike stood over the days. |
| **Analyse** | *Verfügbarkeit*: chance of at least one bike in a 250 m cell / ~400 m radius, per hour, weekday vs. weekend. *Dichte*: average parked bikes per hour. *Nutzung*: bikes in use and trips by hour, trip duration and distance. *Ströme*: net in/outflow per cell and the most frequent connections by time of day. *Stationen*: chance a station is empty per hour. *Standzeit*: how long bikes stand untouched. |

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

| env var | default | description |
|---|---|---|
| `UPDATE_INTERVAL_MINUTES` | `15` | poll interval in minutes (fractions allowed, minimum 1) |
| `NEXTBIKE_DOMAIN` | `kg` | nextbike network ID (`kg` = KVB-Rad Köln) |
| `NEXTBIKE_CITY_ID` | – | restrict to one nextbike city UID instead |
| `MOVE_THRESHOLD_M` | `25` | movement threshold for `moved` events |
| `RENDER_PNG` | `true` | render `map.png` / `heatmap.png` on each update |
| `TILE_API_KEY` | – | free [CARTO basemap key](https://carto.com/basemaps/apikey) for the PNG renders; see *Basemap* below |
| `ANALYSIS_DAYS` | `56` | window for the statistics in *Analyse* |
| `TIMELINE_DAYS` | `7` | how far back *Verlauf* goes |
| `ANALYSIS_INTERVAL_MINUTES` | `30` | container only: recompute statistics at most this often |

The container serves `/` (interactive map), `/map.png`, `/heatmap.png`, `/latest.json` (current state) and `/history/` (all CSVs).

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
- **Analysis method:** `tracker/analysis.py` replays the CSV history poll by poll. Trips are inferred: a bike leaves the feed and reappears ≥ 100 m away (absences over 4 h count as service), or jumps > 300 m between two polls. Rebalancing by van can't be separated reliably. Hours use Europe/Berlin local time; public holidays count as normal weekdays.
- **Basemap:** CARTO now requires a free API key ([request one](https://carto.com/basemaps/apikey)). The interactive map uses OpenFreeMap. With `TILE_API_KEY` set, the PNG renders use CARTO light tiles (© OpenStreetMap contributors © CARTO; free up to 5M non-commercial requests/month). Without a key the PNGs are drawn without a basemap. OSM's [tile policy](https://operations.osmfoundation.org/policies/tiles/) forbids pre-fetching tiles server-side.
- **Schedule:** in public repos, GitHub pauses scheduled workflows after 60 days without repo activity. The history commits should keep this repo active.
