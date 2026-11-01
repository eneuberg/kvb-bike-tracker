"""Render the current state as PNG images (for the README) and a static site."""

from __future__ import annotations

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


HTML_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>KVB-Rad bike tracker</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css">
<link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css">
<style>
  :root { --bg:#fff; --fg:#222; --panel:#ffffffee; --border:#ddd; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111; --fg:#eee; --panel:#1b1b1bee; --border:#333; } }
  html, body { height:100%; margin:0; background:var(--bg); color:var(--fg);
    font: 14px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  #map { position:absolute; inset:0; }
  #panel { position:absolute; z-index:1000; top:10px; left:10px; max-width:calc(100vw - 20px);
    background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:10px 14px; }
  #panel h1 { font-size:16px; margin:0 0 4px; }
  #panel .muted { opacity:.7; font-size:12px; }
  #panel label { display:block; margin-top:6px; cursor:pointer; }
  .dot { display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:6px; vertical-align:middle; }
  .bike-marker { width:10px; height:10px; border-radius:50%; border:1.5px solid #fff; box-shadow:0 0 2px #0006; }
  .station-marker { border-radius:50%; background:#1a73e8cc; border:2px solid #fff; color:#fff;
    font-weight:600; display:flex; align-items:center; justify-content:center; box-shadow:0 0 3px #0006; }
  .leaflet-popup-content { font-size:13px; } .leaflet-popup-content td { padding:1px 6px 1px 0; }
</style>
</head>
<body>
<div id="map"></div>
<div id="panel">
  <h1>KVB-Rad bike tracker</h1>
  <div class="muted" id="status">loading…</div>
  <label><input type="checkbox" id="chkStations" checked> <span class="dot" style="background:#1a73e8"></span>stations (number = bikes docked)</label>
  <label><input type="checkbox" id="chkFree" checked> <span class="dot" style="background:#e85e1a"></span>free-floating bikes</label>
  <label><input type="checkbox" id="chkHeat"> heatmap (all bikes)</label>
  <div class="muted" style="margin-top:6px"><a href="history/" style="color:inherit">history</a> · <a href="https://github.com/eneuberg/kvb-bike-tracker" style="color:inherit">source</a></div>
</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js"></script>
<script src="https://unpkg.com/leaflet.heat@0.2.0/dist/leaflet-heat.js"></script>
<script>
(async function () {
  const map = L.map('map', { preferCanvas: true });
  L.tileLayer('__TILE_URL__', { maxZoom: 19, attribution: '__ATTRIBUTION__' }).addTo(map);

  const res = await fetch('latest.json?ts=' + Date.now());
  const data = await res.json();
  const { bikes, stations, meta } = data;
  const b = meta.bounds;
  if (b) map.fitBounds([[b[0], b[1]], [b[2], b[3]]]); else map.setView([50.94, 6.96], 12);

  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const row = (k, v) => (v === null || v === undefined || v === '') ? '' : `<tr><td><b>${k}</b></td><td>${esc(v)}</td></tr>`;
  const bikePopup = bk => `<table>${row('bike', bk.bike)}${row('type', bk.kind)}${row('station', bk.place_name)}
    ${row('e-bike', bk.electric ? 'yes' : 'no')}${row('battery', bk.battery === null ? null : bk.battery + ' %')}
    ${row('bike_type', bk.bike_type)}${row('state', bk.state)}${row('active', bk.active === null ? null : (bk.active ? 'yes' : 'no'))}
    ${row('locks', bk.lock_types)}${row('lat/lng', bk.lat + ', ' + bk.lng)}</table>`;

  const stationLayer = L.layerGroup();
  const byStation = {};
  for (const bk of bikes) if (bk.kind === 'station') (byStation[bk.place_uid] ||= []).push(bk);
  for (const st of stations) {
    const docked = byStation[st.uid] || [];
    const n = docked.length || st.bikes || 0;
    const size = 18 + Math.min(Math.sqrt(n) * 4, 18);
    const icon = L.divIcon({ className: '', html: `<div class="station-marker" style="width:${size}px;height:${size}px;font-size:${size > 26 ? 12 : 10}px">${n}</div>`, iconSize: [size, size] });
    const list = docked.slice(0, 40).map(bk => `<li>${esc(bk.bike)}${bk.electric ? ' ⚡' + (bk.battery !== null ? bk.battery + '%' : '') : ''}</li>`).join('');
    L.marker([st.lat, st.lng], { icon }).bindPopup(`<b>${esc(st.name)}</b><table>${row('bikes', n)}
      ${row('available', st.bikes_available_to_rent)}${row('racks', st.bike_racks)}${row('free racks', st.free_racks)}
      ${row('terminal', st.terminal_type)}</table>${list ? '<ul style="margin:4px 0;padding-left:18px;max-height:160px;overflow:auto">' + list + '</ul>' : ''}`).addTo(stationLayer);
  }

  const freeLayer = L.markerClusterGroup({ disableClusteringAtZoom: 15, maxClusterRadius: 40, chunkedLoading: true });
  for (const bk of bikes) {
    if (bk.kind === 'station') continue;
    const low = bk.battery !== null && bk.battery < 20;
    const icon = L.divIcon({ className: '', html: `<div class="bike-marker" style="background:${low ? '#a01e1e' : '#e85e1a'}"></div>`, iconSize: [10, 10] });
    L.marker([bk.lat, bk.lng], { icon }).bindPopup(bikePopup(bk)).addTo(freeLayer);
  }

  const heatLayer = L.heatLayer(bikes.map(bk => [bk.lat, bk.lng, 1]), { radius: 22, blur: 18, maxZoom: 15, minOpacity: 0.25 });

  stationLayer.addTo(map); freeLayer.addTo(map);
  const bind = (id, layer) => document.getElementById(id).addEventListener('change', e => e.target.checked ? map.addLayer(layer) : map.removeLayer(layer));
  bind('chkStations', stationLayer); bind('chkFree', freeLayer); bind('chkHeat', heatLayer);

  const c = meta.counts;
  document.getElementById('status').textContent =
    `${c.total} bikes · ${c.station} at ${c.stations} stations · ${c.free + c.other} free-floating · ${c.electric} e-bikes · updated ${meta.ts}`;
})().catch(err => { document.getElementById('status').textContent = 'failed to load data: ' + err; });
</script>
</body>
</html>
"""


def write_site(cfg: Config, bikes: list[dict[str, Any]], stations: list[dict[str, Any]],
               meta: dict[str, Any]) -> list[Path]:
    site = cfg.site_dir
    site.mkdir(parents=True, exist_ok=True)
    written = []

    latest = site / "latest.json"
    latest.write_text(json.dumps({"meta": meta, "bikes": bikes, "stations": stations},
                                 separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    written.append(latest)

    html = (HTML_TEMPLATE
            .replace("__TILE_URL__", cfg.web_tile_url.replace("'", "%27"))
            .replace("__ATTRIBUTION__", cfg.web_tile_attribution.replace("'", "\\'")))
    index = site / "index.html"
    index.write_text(html, encoding="utf-8")
    written.append(index)

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
