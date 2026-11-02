"""Runtime configuration, read from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _env(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(name)
    if value is None or value.strip() == "":
        return default
    return value.strip()


def _interval_seconds() -> int:
    """UPDATE_INTERVAL_MINUTES (preferred) or UPDATE_INTERVAL_SECONDS; min 60 s."""
    minutes = _env("UPDATE_INTERVAL_MINUTES")
    if minutes is not None:
        seconds = float(minutes) * 60
    else:
        seconds = float(_env("UPDATE_INTERVAL_SECONDS", "900"))
    return max(int(seconds), 60)


CARTO_URL = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png?key={key}"
CARTO_ATTR = "© OpenStreetMap contributors © CARTO"
OSM_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
OSM_ATTR = "© OpenStreetMap contributors"


def _tiles() -> dict:
    key = _env("TILE_API_KEY") or _env("CARTO_API_KEY")
    if key:
        default_url, default_attr = CARTO_URL.replace("{key}", key), CARTO_ATTR
        web_url, web_attr = default_url, CARTO_ATTR
    else:
        default_url, default_attr = "", ""
        web_url, web_attr = OSM_URL, OSM_ATTR
    tile_url = _env("TILE_URL", default_url)
    tile_attr = _env("TILE_ATTRIBUTION", default_attr if tile_url == default_url else "")
    return {
        "tile_api_key": key,
        "tile_url": tile_url,
        "tile_attribution": tile_attr,
        "web_tile_url": _env("WEB_TILE_URL", web_url),
        "web_tile_attribution": _env("WEB_TILE_ATTRIBUTION", web_attr),
    }


@dataclass
class Config:
    # Data source
    api_urls: list[str] = field(default_factory=list)
    domain: str = "kg"  # nextbike network id for KVB-Rad Köln
    city_id: str | None = None  # optional: restrict to one nextbike city uid

    # Paths
    data_dir: Path = Path("data")
    history_dir: Path = Path("data/history")
    site_dir: Path = Path("data/site")
    tile_cache_dir: Path = Path("data/tiles")

    # Behaviour
    update_interval_seconds: int = 900
    move_threshold_m: float = 25.0
    battery_threshold: int = 5
    request_timeout: int = 30
    user_agent: str = "kvb-bike-tracker (+https://github.com/eneuberg/kvb-bike-tracker)"

    # Rendering
    # Basemap tiles. CARTO now requires a (free) key: https://carto.com/basemaps/apikey
    #   with TILE_API_KEY:    CARTO light tiles for the PNGs and the interactive map
    #   without a key:        interactive map uses OpenStreetMap's standard tiles
    #                         (allowed for maps a person is viewing); the PNGs get no
    #                         basemap, because OSM's tile policy forbids server-side
    #                         pre-fetching.
    tile_api_key: str | None = None
    tile_url: str = ""              # server-side PNG basemap; "" = none
    tile_attribution: str = ""
    web_style_light: str = "https://tiles.openfreemap.org/styles/positron"
    web_style_dark: str = "https://tiles.openfreemap.org/styles/dark"
    web_tile_url: str = ""          # raster fallback for the browser map
    web_tile_attribution: str = ""
    image_width: int = 1400
    render_png: bool = True
    publish_history_days: int = 31  # static site only: days of history copied into Pages

    # Analysis
    analysis_days: float = 56         # how many days of history the web app can load
    timeline_step_minutes: float = 5  # min spacing of exported polls
    analysis_interval_minutes: float = 30  # serve mode: recompute at most this often

    # Server
    port: int = 8080
    # serve mode: anyone can trigger a poll from the web page, but for all
    # visitors together at most once per this many seconds (0 = off)
    manual_min_interval_seconds: int = 180
    serving: bool = False  # set by `serve`; static builds (GitHub Pages) cannot poll on demand

    @classmethod
    def from_env(cls) -> "Config":
        data_dir = Path(_env("DATA_DIR", "data"))
        urls = _env(
            "NEXTBIKE_API_URLS",
            "https://api.nextbike.net/maps/nextbike-live.json,"
            "https://maps.nextbike.net/maps/nextbike-live.json",
        )
        return cls(
            api_urls=[u.strip() for u in urls.split(",") if u.strip()],
            domain=_env("NEXTBIKE_DOMAIN", "kg"),
            city_id=_env("NEXTBIKE_CITY_ID"),
            data_dir=data_dir,
            history_dir=Path(_env("HISTORY_DIR", str(data_dir / "history"))),
            site_dir=Path(_env("SITE_DIR", str(data_dir / "site"))),
            tile_cache_dir=Path(_env("TILE_CACHE_DIR", str(data_dir / "tiles"))),
            update_interval_seconds=_interval_seconds(),
            move_threshold_m=float(_env("MOVE_THRESHOLD_M", "25")),
            battery_threshold=int(_env("BATTERY_THRESHOLD", "5")),
            request_timeout=int(_env("REQUEST_TIMEOUT", "30")),
            user_agent=_env("USER_AGENT", cls.user_agent),
            **_tiles(),
            image_width=int(_env("IMAGE_WIDTH", "1400")),
            render_png=_env("RENDER_PNG", "true").lower() not in ("0", "false", "no"),
            publish_history_days=int(_env("PUBLISH_HISTORY_DAYS", "31")),
            web_style_light=_env("WEB_STYLE_LIGHT", cls.web_style_light),
            web_style_dark=_env("WEB_STYLE_DARK", cls.web_style_dark),
            analysis_days=float(_env("ANALYSIS_DAYS", "56")),
            timeline_step_minutes=float(_env("TIMELINE_STEP_MINUTES", "5")),
            analysis_interval_minutes=float(_env("ANALYSIS_INTERVAL_MINUTES", "30")),
            port=int(_env("PORT", "8080")),
            manual_min_interval_seconds=max(0, int(float(_env("MANUAL_REFRESH_MINUTES", "3")) * 60)),
        )
