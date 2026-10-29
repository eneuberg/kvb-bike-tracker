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
    tile_url: str = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png"
    tile_attribution: str = "© OpenStreetMap contributors © CARTO"
    image_width: int = 1400
    render_png: bool = True
    publish_history_days: int = 31  # static site only: days of history copied into Pages

    # Server
    port: int = 8080

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
            tile_url=_env("TILE_URL", cls.tile_url),
            tile_attribution=_env("TILE_ATTRIBUTION", cls.tile_attribution),
            image_width=int(_env("IMAGE_WIDTH", "1400")),
            render_png=_env("RENDER_PNG", "true").lower() not in ("0", "false", "no"),
            publish_history_days=int(_env("PUBLISH_HISTORY_DAYS", "31")),
            port=int(_env("PORT", "8080")),
        )
