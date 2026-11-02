"""Render the current state as PNG images (for the README) and a static site."""

from __future__ import annotations

import hashlib
import json
import logging
import math
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from .config import Config
from .tiles import Basemap

log = logging.getLogger(__name__)

C_STATION = (26, 115, 232)
C_FREE = (232, 94, 26)
C_LOW = (160, 30, 30)
C_TEXT = (40, 40, 40)


def _font(size: int) -> ImageFont.ImageFont:
    for name in ("DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
                 "/usr/share/fonts/dejavu/DejaVuSans.ttf", "Arial.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def _legend(img: Image.Image, lines: list[tuple[str, tuple[int, int, int] | None]],
            title: str, attribution: str) -> None:
    draw = ImageDraw.Draw(img, "RGBA")
    font, small = _font(16), _font(12)
    pad, lh = 12, 22
    w = max(draw.textlength(t, font=font) for t, _ in lines + [(title, None)]) + 40
    h = pad * 2 + lh * (len(lines) + 1)
    draw.rounded_rectangle((10, 10, 10 + w, 10 + h), 8, fill=(255, 255, 255, 225))
    draw.text((10 + pad, 10 + pad), title, fill=C_TEXT, font=font)
    y = 10 + pad + lh
    for text, colour in lines:
        if colour:
            draw.ellipse((10 + pad, y + 4, 10 + pad + 12, y + 16), fill=colour)
            draw.text((10 + pad + 20, y), text, fill=C_TEXT, font=font)
        else:
            draw.text((10 + pad, y), text, fill=C_TEXT, font=font)
        y += lh
    if attribution:
        tw = draw.textlength(attribution, font=small)
        draw.rectangle((img.width - tw - 12, img.height - 20, img.width, img.height),
                       fill=(255, 255, 255, 200))
        draw.text((img.width - tw - 6, img.height - 17), attribution, fill=(90, 90, 90), font=small)


def render_markers_png(cfg: Config, basemap: Basemap, bikes: list[dict[str, Any]],
                       stations: list[dict[str, Any]], meta: dict[str, Any], out: Path) -> None:
    img = basemap.image.copy()
    draw = ImageDraw.Draw(img, "RGBA")
    for st in stations:
        x, y = basemap.project(st["lng"], st["lat"])
        r = 4 + min(math.sqrt(st.get("bikes") or 0) * 1.6, 10)
        draw.ellipse((x - r, y - r, x + r, y + r), fill=C_STATION + (170,), outline=(255, 255, 255, 220))
    for b in bikes:
        if b["kind"] == "station":
            continue
        x, y = basemap.project(b["lng"], b["lat"])
        colour = C_LOW if (b.get("battery") is not None and b["battery"] < 20) else C_FREE
        draw.ellipse((x - 3, y - 3, x + 3, y + 3), fill=colour + (210,), outline=(255, 255, 255, 200))
    c = meta["counts"]
    _legend(img, [
        (f"station bikes: {c['station']} at {c['stations']} stations", C_STATION),
        (f"free-floating bikes: {c['free'] + c['other']}", C_FREE),
        ("e-bike battery < 20 %", C_LOW),
        (f"e-bikes total: {c['electric']}", None),
    ], f"KVB-Rad bikes · {meta['ts']}", cfg.tile_attribution)
    img.save(out, optimize=True)


def _density(basemap: Basemap, points: list[tuple[float, float, float]],
             sigma_px: float = 18.0) -> np.ndarray:
    grid = np.zeros((basemap.height, basemap.width), dtype=np.float32)
    for lng, lat, weight in points:
        x, y = basemap.project(lng, lat)
        xi, yi = int(round(x)), int(round(y))
        if 0 <= xi < basemap.width and 0 <= yi < basemap.height:
            grid[yi, xi] += weight
    arr = _gaussian_blur(grid, sigma_px)
    # use a high percentile instead of the max so a single huge station
    # does not wash out the rest of the city
    nz = arr[arr > 0]
    peak = float(np.percentile(nz, 99.5)) if nz.size else 0.0
    if peak > 0:
        return np.clip(arr / peak, 0.0, 1.0)
    return arr


def _gaussian_blur(grid: np.ndarray, sigma: float) -> np.ndarray:
    """Separable Gaussian blur via 1-D convolutions (numpy only)."""
    radius = max(int(3 * sigma), 1)
    x = np.arange(-radius, radius + 1, dtype=np.float32)
    kernel = np.exp(-(x ** 2) / (2 * sigma ** 2))
    kernel /= kernel.sum()
    out = np.apply_along_axis(lambda r: np.convolve(r, kernel, mode="same"), 1, grid)
    out = np.apply_along_axis(lambda c: np.convolve(c, kernel, mode="same"), 0, out)
    return out.astype(np.float32)


def _colormap(norm: np.ndarray) -> Image.Image:
    """Transparent -> blue -> green -> yellow -> red, alpha ramps with value."""
    stops = np.array([
        [0.00, 0, 0, 255, 0],
        [0.15, 0, 90, 255, 90],
        [0.40, 0, 200, 120, 150],
        [0.65, 255, 220, 0, 190],
        [1.00, 220, 20, 20, 230],
    ], dtype=np.float32)
    out = np.zeros(norm.shape + (4,), dtype=np.float32)
    for ch in range(4):
        out[..., ch] = np.interp(norm, stops[:, 0], stops[:, ch + 1])
    out[norm < 0.02, 3] = 0
    return Image.fromarray(out.astype(np.uint8), mode="RGBA")


def render_heatmap_png(cfg: Config, basemap: Basemap, bikes: list[dict[str, Any]],
                       meta: dict[str, Any], out: Path) -> None:
    base = basemap.image.convert("RGBA")
    # mute the basemap slightly so the heat layer reads clearly
    base = Image.blend(base, Image.new("RGBA", base.size, (255, 255, 255, 255)), 0.35)
    points = [(b["lng"], b["lat"], 1.0) for b in bikes]
    heat = _colormap(_density(basemap, points))
    img = Image.alpha_composite(base, heat)
    _legend(img, [
        ("density of all bikes (stations + free-floating)", None),
        (f"{meta['counts']['total']} bikes", None),
    ], f"KVB-Rad bike density · {meta['ts']}", cfg.tile_attribution)
    img.convert("RGB").save(out, optimize=True)


WEB_DIR = Path(__file__).parent / "web"


def app_version() -> str:
    """Short hash of the web app files; changes with every app change."""
    h = hashlib.sha1()
    for src in sorted(WEB_DIR.iterdir()):
        if src.is_file():
            h.update(src.name.encode())
            h.update(src.read_bytes())
    return h.hexdigest()[:10]


def copy_web(cfg: Config) -> list[Path]:
    """Copy the static web app and write its runtime config.

    index.html references app.js / app.css with ?v=<app version>, so a browser
    never runs an old cached copy after an update."""
    out = []
    ver = app_version()
    for src in sorted(WEB_DIR.iterdir()):
        if src.is_file():
            dst = cfg.site_dir / src.name
            data = src.read_bytes()
            if src.name == "index.html":
                text = data.decode("utf-8")
                text = text.replace('href="app.css"', f'href="app.css?v={ver}"').replace('src="app.js"', f'src="app.js?v={ver}"')
                data = text.encode("utf-8")
            dst.write_bytes(data)
            out.append(dst)
    conf = {
        "app": ver,
        "style_light": cfg.web_style_light,
        "style_dark": cfg.web_style_dark,
        "raster_url": cfg.web_tile_url,
        "raster_attribution": cfg.web_tile_attribution,
        "repo": "https://github.com/eneuberg/kvb-bike-tracker",
    }
    p = cfg.site_dir / "config.json"
    p.write_text(json.dumps(conf, ensure_ascii=False), encoding="utf-8")
    out.append(p)
    return out


def write_status(cfg: Config, ts: str | None) -> Path:
    """status.json: what the open web page needs to know about freshness.

    ts        time of the latest poll (ISO, UTC)
    app       web app version (hash), so pages notice an update
    mode      "server" (container, can poll on demand) or "static" (GitHub Pages)
    auto_s    planned seconds between automatic polls
    manual_s  minimum seconds between manual polls for all visitors (0 = not possible)
    """
    manual = cfg.manual_min_interval_seconds if cfg.serving else 0
    return write_json(cfg.site_dir / "status.json", {
        "ts": ts, "app": app_version(), "mode": "server" if cfg.serving else "static",
        "auto_s": cfg.update_interval_seconds, "manual_s": manual,
    })


def write_json(path: Path, data: Any) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)  # atomic, so the server never serves half a file
    return path


def write_site(cfg: Config, bikes: list[dict[str, Any]], stations: list[dict[str, Any]],
               meta: dict[str, Any]) -> list[Path]:
    site = cfg.site_dir
    site.mkdir(parents=True, exist_ok=True)
    written = []

    written.append(write_json(site / "latest.json", {"meta": meta, "bikes": bikes, "stations": stations}))
    # tiny file the open web app polls to notice new data or a new app version
    written.append(write_status(cfg, meta.get("ts")))

    written += copy_web(cfg)

    if cfg.render_png and meta.get("bounds"):
        try:
            basemap = Basemap(cfg, meta["bounds"])
            if not basemap.has_tiles:
                log.warning("no basemap tiles fetched; rendering on blank background")
            p1, p2 = site / "map.png", site / "heatmap.png"
            render_markers_png(cfg, basemap, bikes, stations, meta, p1)
            render_heatmap_png(cfg, basemap, bikes, meta, p2)
            written += [p1, p2]
        except Exception as exc:  # rendering must never break data collection
            log.exception("PNG rendering failed: %s", exc)
    return written
