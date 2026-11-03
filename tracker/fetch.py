"""Fetch and normalise the nextbike live feed for KVB-Rad Köln.

The nextbike live API returns countries -> cities -> places. A place is either
a station (``spot``) holding several bikes, or a single free-floating bike
(``bike``). Each place carries a ``bike_list`` with per-bike metadata.
Parsing is defensive: every field is optional.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

import requests

from .config import Config

log = logging.getLogger(__name__)


class FetchError(RuntimeError):
    pass


def fetch_raw(cfg: Config) -> dict[str, Any]:
    params = {"city": cfg.city_id} if cfg.city_id else {"domains": cfg.domain}
    headers = {"User-Agent": cfg.user_agent, "Accept": "application/json"}
    errors = []
    for url in cfg.api_urls:
        try:
            resp = requests.get(url, params=params, headers=headers, timeout=cfg.request_timeout)
            resp.raise_for_status()
            # transfer size (compressed, if the server compresses) vs. payload size
            log.info("feed: %s bytes on the wire (Content-Length), %s bytes JSON (%s)",
                     resp.headers.get("Content-Length", "?"), len(resp.content),
                     resp.headers.get("Content-Encoding", "uncompressed"))
            data = resp.json()
            if not isinstance(data, dict) or "countries" not in data:
                raise FetchError(f"unexpected payload from {url}")
            return data
        except (requests.RequestException, ValueError, FetchError) as exc:
            log.warning("fetch failed for %s: %s", url, exc)
            errors.append(f"{url}: {exc}")
    raise FetchError("all endpoints failed: " + "; ".join(errors))


def _float(v: Any) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _int(v: Any) -> int | None:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _bool(v: Any) -> bool | None:
    if v is None:
        return None
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return bool(v)
    return str(v).strip().lower() in ("1", "true", "yes")


def _battery(bike: dict[str, Any]) -> int | None:
    pack = bike.get("battery_pack")
    if isinstance(pack, dict):
        pct = _int(pack.get("percentage"))
        if pct is not None:
            return pct
    return _int(bike.get("pedelec_battery"))


def _selected_cities(raw: dict[str, Any], cfg: Config) -> list[dict[str, Any]]:
    cities = []
    for country in raw.get("countries") or []:
        domain = str(country.get("domain") or "")
        for city in country.get("cities") or []:
            uid = str(city.get("uid") or "")
            if cfg.city_id:
                if uid == str(cfg.city_id):
                    cities.append(city)
            elif domain == cfg.domain:
                cities.append(city)
    return cities


def normalize(raw: dict[str, Any], cfg: Config, ts: datetime | None = None):
    """Return (bikes, stations, meta) from a raw live payload."""
    ts = ts or datetime.now(timezone.utc)
    ts_iso = ts.strftime("%Y-%m-%dT%H:%M:%SZ")
    cities = _selected_cities(raw, cfg)
    if not cities:
        raise FetchError(
            f"no city matched domain={cfg.domain!r} city_id={cfg.city_id!r}; "
            "check NEXTBIKE_DOMAIN / NEXTBIKE_CITY_ID"
        )

    bikes: dict[str, dict[str, Any]] = {}
    stations: list[dict[str, Any]] = []
    bounds = None

    for city in cities:
        b = city.get("bounds") or {}
        sw, ne = b.get("south_west") or {}, b.get("north_east") or {}
        if all(_float(x) is not None for x in (sw.get("lat"), sw.get("lng"), ne.get("lat"), ne.get("lng"))):
            cb = [_float(sw["lat"]), _float(sw["lng"]), _float(ne["lat"]), _float(ne["lng"])]
            bounds = cb if bounds is None else [
                min(bounds[0], cb[0]), min(bounds[1], cb[1]),
                max(bounds[2], cb[2]), max(bounds[3], cb[3]),
            ]

        for place in city.get("places") or []:
            lat, lng = _float(place.get("lat")), _float(place.get("lng"))
            if lat is None or lng is None:
                continue
            if _bool(place.get("bike")):
                kind = "free"
            elif _bool(place.get("spot")):
                kind = "station"
            else:
                kind = "other"

            place_uid = str(place.get("uid") or "")
            place_name = str(place.get("name") or "")
            bike_list = place.get("bike_list") or []
            numbers_seen = set()

            for bike in bike_list:
                number = str(bike.get("number") or "").strip()
                if not number:
                    continue
                numbers_seen.add(number)
                battery = _battery(bike)
                bikes[number] = {
                    "bike": number,
                    "lat": round(lat, 6),
                    "lng": round(lng, 6),
                    "kind": kind,
                    "place_uid": place_uid,
                    "place_name": "" if kind == "free" else place_name,
                    "bike_type": _int(bike.get("bike_type")),
                    "electric": battery is not None or bool(bike.get("battery_pack")),
                    "battery": battery,
                    "state": str(bike.get("state") or ""),
                    "active": _bool(bike.get("active")),
                    "lock_types": ",".join(str(x) for x in (bike.get("lock_types") or [])),
                    "boardcomputer": _int(bike.get("boardcomputer")),
                }

            # Some payloads only carry bike_numbers without a bike_list entry.
            for number in place.get("bike_numbers") or []:
                number = str(number).strip()
                if number and number not in numbers_seen and number not in bikes:
                    bikes[number] = {
                        "bike": number, "lat": round(lat, 6), "lng": round(lng, 6),
                        "kind": kind, "place_uid": place_uid,
                        "place_name": "" if kind == "free" else place_name,
                        "bike_type": None, "electric": False, "battery": None,
                        "state": "", "active": None, "lock_types": "", "boardcomputer": None,
                    }

            if kind == "station":
                stations.append({
                    "uid": place_uid,
                    "number": _int(place.get("number")),
                    "name": place_name,
                    "lat": round(lat, 6),
                    "lng": round(lng, 6),
                    "bikes": _int(place.get("bikes")) or 0,
                    "bikes_available_to_rent": _int(place.get("bikes_available_to_rent")),
                    "bike_racks": _int(place.get("bike_racks")),
                    "free_racks": _int(place.get("free_racks")),
                    "terminal_type": str(place.get("terminal_type") or ""),
                    "maintenance": _bool(place.get("maintenance")),
                })

    bike_rows = sorted(bikes.values(), key=lambda r: r["bike"])
    counts = {
        "total": len(bike_rows),
        "station": sum(1 for r in bike_rows if r["kind"] == "station"),
        "free": sum(1 for r in bike_rows if r["kind"] == "free"),
        "other": sum(1 for r in bike_rows if r["kind"] == "other"),
        "electric": sum(1 for r in bike_rows if r["electric"]),
        "stations": len(stations),
    }
    city_bounds = bounds
    if bike_rows:
        # Map extent from where bikes actually are (0.5-99.5 percentile, so a
        # bike parked in Bonn doesn't zoom the map out), plus 4 % padding.
        lats = sorted(r["lat"] for r in bike_rows)
        lngs = sorted(r["lng"] for r in bike_rows)
        lo, hi = int(len(lats) * 0.005), max(int(len(lats) * 0.995) - 1, 0)
        s, n, w, e = lats[lo], lats[hi], lngs[lo], lngs[hi]
        pad_lat, pad_lng = max((n - s) * 0.04, 0.005), max((e - w) * 0.04, 0.008)
        bounds = [round(s - pad_lat, 5), round(w - pad_lng, 5), round(n + pad_lat, 5), round(e + pad_lng, 5)]

    meta = {
        "ts": ts_iso,
        "cities": [{"uid": c.get("uid"), "name": c.get("name")} for c in cities],
        "counts": counts,
        "bounds": bounds,
        "city_bounds": city_bounds,
    }
    return bike_rows, stations, meta
