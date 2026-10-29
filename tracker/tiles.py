"""Minimal slippy-map tile stitcher with an on-disk cache (no GIS deps)."""

from __future__ import annotations

import io
import logging
import math
from pathlib import Path

import requests
from PIL import Image

from .config import Config

log = logging.getLogger(__name__)
TILE = 256


def lnglat_to_px(lng: float, lat: float, z: int) -> tuple[float, float]:
    """Web-Mercator world pixel coordinates at zoom z."""
    n = 2.0 ** z * TILE
    x = (lng + 180.0) / 360.0 * n
    lat_r = math.radians(max(min(lat, 85.0511), -85.0511))
    y = (1.0 - math.log(math.tan(lat_r) + 1.0 / math.cos(lat_r)) / math.pi) / 2.0 * n
    return x, y


def pick_zoom(bounds: list[float], width: int, max_zoom: int = 16) -> int:
    s, w, n, e = bounds
    for z in range(max_zoom, 0, -1):
        x0, _ = lnglat_to_px(w, n, z)
        x1, _ = lnglat_to_px(e, s, z)
        if x1 - x0 <= width:
            return z
    return 1


class Basemap:
    """A stitched, cropped basemap plus a projection function into it."""

    def __init__(self, cfg: Config, bounds: list[float]):
        self.cfg = cfg
        self.z = pick_zoom(bounds, cfg.image_width)
        s, w, n, e = bounds
        self.x0, self.y0 = lnglat_to_px(w, n, self.z)
        x1, y1 = lnglat_to_px(e, s, self.z)
        self.width = max(int(round(x1 - self.x0)), 1)
        self.height = max(int(round(y1 - self.y0)), 1)
        self.has_tiles = False
        self.image = self._stitch()

    def project(self, lng: float, lat: float) -> tuple[float, float]:
        x, y = lnglat_to_px(lng, lat, self.z)
        return x - self.x0, y - self.y0

    def _tile(self, x: int, y: int) -> Image.Image | None:
        cache = self.cfg.tile_cache_dir / str(self.z) / str(x) / f"{y}.png"
        if cache.exists():
            try:
                return Image.open(cache).convert("RGB")
            except OSError:
                cache.unlink(missing_ok=True)
        url = self.cfg.tile_url.format(s="abcd"[(x + y) % 4], z=self.z, x=x, y=y)
        try:
            resp = requests.get(url, headers={"User-Agent": self.cfg.user_agent},
                                timeout=self.cfg.request_timeout)
            resp.raise_for_status()
            img = Image.open(io.BytesIO(resp.content)).convert("RGB")
        except (requests.RequestException, OSError) as exc:
            log.warning("tile %s failed: %s", url, exc)
            return None
        cache.parent.mkdir(parents=True, exist_ok=True)
        img.save(cache)
        return img

    def _stitch(self) -> Image.Image:
        canvas = Image.new("RGB", (self.width, self.height), (236, 236, 233))
        tx0, ty0 = int(self.x0 // TILE), int(self.y0 // TILE)
        tx1 = int((self.x0 + self.width) // TILE)
        ty1 = int((self.y0 + self.height) // TILE)
        ok = failed = 0
        for tx in range(tx0, tx1 + 1):
            for ty in range(ty0, ty1 + 1):
                if failed >= 3 and ok == 0:
                    log.warning("tile server unreachable, giving up on basemap")
                    self.has_tiles = False
                    return canvas
                tile = self._tile(tx, ty)
                if tile is None:
                    failed += 1
                    continue
                ok += 1
                canvas.paste(tile, (int(tx * TILE - self.x0), int(ty * TILE - self.y0)))
        self.has_tiles = ok > 0
        return canvas
