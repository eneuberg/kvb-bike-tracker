"""Export of the history for the web app.

Replays the CSV history poll by poll (``runs.csv`` is the list of polls, the
day files hold the changes) and writes one compact, self-contained file per
local (Europe/Berlin) day: the full bike state at the first poll of the day,
then per-poll deltas. The browser loads the days it needs and does every
analysis itself (``web/worker.js``), so all parameters (dates, weekdays, time
window, radius, thresholds) stay freely adjustable.

Also derives, per bike currently in the feed, since when it has not been
touched (left the feed or moved more than IDLE_MOVE_M).
"""

from __future__ import annotations

import csv
import logging
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import numpy as np

log = logging.getLogger(__name__)
TZ = ZoneInfo("Europe/Berlin")

IDLE_MOVE_M = 100.0       # moves below this are treated as GPS jitter
TL_LAT0, TL_LNG0, TL_SCALE = 50.0, 6.0, 1e5


def haversine(lat1, lng1, lat2, lng2):
    r = 6_371_000.0
    p1, p2 = np.radians(lat1), np.radians(lat2)
    a = (np.sin((p2 - p1) / 2) ** 2
         + np.cos(p1) * np.cos(p2) * np.sin(np.radians(lng2 - lng1) / 2) ** 2)
    return 2 * r * np.arcsin(np.sqrt(np.clip(a, 0, 1)))


def _epoch(ts: str) -> int:
    return int(datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp())


def _grow(arr: np.ndarray, n: int) -> np.ndarray:
    new = np.zeros(max(len(arr) * 2, n), dtype=arr.dtype)
    new[: len(arr)] = arr
    return new


class _Table:
    """Growable id -> index table."""

    def __init__(self):
        self.index: dict[str, int] = {}
        self.keys: list[str] = []

    def get(self, key: str) -> int:
        i = self.index.get(key)
        if i is None:
            i = self.index[key] = len(self.keys)
            self.keys.append(key)
        return i


class Replay:
    """Bike state arrays, updated from history rows."""

    def __init__(self, cap: int = 8192):
        self.bikes = _Table()
        self.lat = np.zeros(cap)
        self.lng = np.zeros(cap)
        self.place = np.full(cap, -1, dtype=np.int32)
        self.present = np.zeros(cap, dtype=bool)

    @property
    def n(self) -> int:
        return len(self.bikes.keys)

    def _ensure(self, i: int):
        if i < len(self.lat):
            return
        cap = max(len(self.lat) * 2, i + 1)
        for name, fill in (("lat", 0.0), ("lng", 0.0), ("place", -1), ("present", False)):
            old = getattr(self, name)
            new = np.full(cap, fill, dtype=old.dtype)
            new[: len(old)] = old
            setattr(self, name, new)

    def apply(self, rows: list[dict[str, str]], stations: "_Stations"):
        if any(r["event"] == "snapshot" for r in rows):
            self.present[:] = False
        for r in rows:
            i = self.bikes.get(r["bike"])
            self._ensure(i)
            if r["event"] == "gone":
                self.present[i] = False
                continue
            try:
                self.lat[i], self.lng[i] = float(r["lat"]), float(r["lng"])
            except ValueError:
                continue
            self.present[i] = True
            if r.get("kind") == "station" and r.get("place_uid"):
                self.place[i] = stations.get(r["place_uid"], r.get("place_name", ""),
                                             self.lat[i], self.lng[i])
            else:
                self.place[i] = -1


class _Stations:
    def __init__(self):
        self.table = _Table()
        self.name: list[str] = []
        self.lat: list[float] = []
        self.lng: list[float] = []

    def get(self, uid: str, name: str = "", lat: float = 0.0, lng: float = 0.0) -> int:
        i = self.table.get(uid)
        if i == len(self.name):
            self.name.append(name)
            self.lat.append(lat)
            self.lng.append(lng)
        return i

    def load(self, path: Path) -> set[int]:
        present = set()
        with path.open(newline="", encoding="utf-8") as fh:
            for r in csv.DictReader(fh):
                try:
                    lat, lng = float(r["lat"]), float(r["lng"])
                except ValueError:
                    continue
                i = self.get(r["uid"], r["name"], lat, lng)
                self.name[i], self.lat[i], self.lng[i] = r["name"], lat, lng
                present.add(i)
        return present


def _read_runs(history_dir: Path) -> list[tuple[str, int]]:
    path = history_dir / "runs.csv"
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8") as fh:
        out = [(r["ts"], _epoch(r["ts"])) for r in csv.DictReader(fh)]
    out.sort(key=lambda x: x[1])
    dedup, seen = [], set()
    for ts, t in out:
        if t not in seen:
            seen.add(t)
            dedup.append((ts, t))
    return dedup


def _day_rows(path: Path) -> dict[str, list[dict[str, str]]]:
    groups: dict[str, list[dict[str, str]]] = defaultdict(list)
    with path.open(newline="", encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            groups[r["ts"]].append(r)
    return groups


def _ex_grow(ex: dict | None, n: int, ns: int) -> dict:
    """Per-day export state: what the day file currently says about each bike."""
    if ex is None:
        cap, scap = max(n, 4096), max(ns, 1024)
        return {"present": np.zeros(cap, dtype=bool), "lat": np.zeros(cap, dtype=np.int32),
                "lng": np.zeros(cap, dtype=np.int32), "sj": np.full(cap, -2, dtype=np.int32),
                "lb": np.full(cap, -1, dtype=np.int64), "lst": np.full(scap, -1, dtype=np.int64)}
    if n > len(ex["present"]):
        for k, fill in (("present", False), ("lat", 0), ("lng", 0), ("sj", -2), ("lb", -1)):
            old = ex[k]
            new = np.full(max(n, len(old) * 2), fill, dtype=old.dtype)
            new[: len(old)] = old
            ex[k] = new
    if ns > len(ex["lst"]):
        old = ex["lst"]
        new = np.full(max(ns, len(old) * 2), -1, dtype=old.dtype)
        new[: len(old)] = old
        ex["lst"] = new
    return ex


def export(history_dir: Path, days: float = 56, step_s: int = 600,
           now: int | None = None) -> dict[str, Any] | None:
    """Replay the last ``days`` days; return per-day frame files and 'since'."""
    runs = _read_runs(history_dir)
    if not runs:
        return None
    now = now or runs[-1][1]
    window_start = now - int(days * 86400)
    inside = [r for r in runs if r[1] >= window_start]
    if not inside:
        return None
    first_day = inside[0][0][:10]
    runs = [r for r in runs if r[0][:10] >= first_day]

    st = _Stations()
    rp = Replay()
    last_move = np.zeros(8192)
    first_seen = np.zeros(8192)
    prev_present = np.zeros(0, dtype=bool)
    prev_lat = np.zeros(0)
    prev_lng = np.zeros(0)
    prev_t: int | None = None

    out_days: dict[str, dict] = {}
    cur: dict | None = None
    ex = None  # exported state of the current day file
    last_frame_t = -10**12
    day_cache: dict[str, dict] = {}

    for ts, t in runs:
        utc_day = ts[:10]
        if utc_day not in day_cache:
            day_cache.clear()
            y, m = utc_day[:4], utc_day[5:7]
            p = history_dir / y / m / f"{utc_day}.csv"
            day_cache[utc_day] = _day_rows(p) if p.exists() else {}
            sp = history_dir / y / m / f"{utc_day}.stations.csv"
            if sp.exists():
                st.load(sp)
        rows = day_cache[utc_day].get(ts)
        if rows:
            rp.apply(rows, st)
        n = rp.n
        if n > len(last_move):
            last_move = _grow(last_move, n)
            first_seen = _grow(first_seen, n)
        present = rp.present[:n]
        lat, lng = rp.lat[:n], rp.lng[:n]

        # idle bookkeeping
        m_ = len(prev_present)
        was = np.zeros(n, dtype=bool)
        was[:m_] = prev_present[:m_]
        newly = present & (first_seen[:n] == 0)
        first_seen[:n][newly] = t
        last_move[:n][newly] = t
        if prev_t is not None:
            pl = np.zeros(n); pg = np.zeros(n)
            pl[:m_], pg[:m_] = prev_lat[:m_], prev_lng[:m_]
            cont = was & present
            d = np.zeros(n)
            if cont.any():
                d[cont] = haversine(pl[cont], pg[cont], lat[cont], lng[cont])
            last_move[:n][cont & (d > IDLE_MOVE_M)] = t
            last_move[:n][~was & present] = t

        # frames, split by local day
        if t >= window_start:
            day = datetime.fromtimestamp(t, TZ).strftime("%Y-%m-%d")
            if cur is None or cur["date"] != day:
                cur = {"date": day, "lat0": TL_LAT0, "lng0": TL_LNG0, "scale": TL_SCALE,
                       "t": [], "bikes": [], "stations": [], "frames": [], "gone": []}
                out_days[day] = cur
                ex = None
                last_frame_t = -10**12
            if t - last_frame_t >= step_s - 60:
                last_frame_t = t
                ilat = np.round((lat - TL_LAT0) * TL_SCALE).astype(np.int32)
                ilng = np.round((lng - TL_LNG0) * TL_SCALE).astype(np.int32)
                plc = rp.place[:n]
                ex = _ex_grow(ex, n, len(st.name))
                # stations used by this day file get a local index
                for p_ in np.unique(plc[present & (plc >= 0)]):
                    p_ = int(p_)
                    if ex["lst"][p_] < 0:
                        ex["lst"][p_] = len(cur["stations"])
                        cur["stations"].append([st.table.keys[p_], st.name[p_],
                                                round(st.lat[p_], 6), round(st.lng[p_], 6)])
                sj = np.where(plc >= 0, ex["lst"][np.maximum(plc, 0)], -1).astype(np.int32)
                epres = ex["present"][:n]
                changed = present & (~epres | (ex["lat"][:n] != ilat) | (ex["lng"][:n] != ilng) | (ex["sj"][:n] != sj))
                gone = epres & ~present
                newb = np.nonzero(changed & (ex["lb"][:n] < 0))[0]
                if len(newb):
                    ex["lb"][newb] = np.arange(len(cur["bikes"]), len(cur["bikes"]) + len(newb))
                    cur["bikes"] += [rp.bikes.keys[i] for i in newb]
                idx = np.nonzero(changed)[0]
                flat = np.stack([ex["lb"][idx], ilat[idx], ilng[idx], sj[idx]], axis=1).ravel().tolist() if len(idx) else []
                cur["t"].append(t)
                cur["frames"].append(flat)
                cur["gone"].append(ex["lb"][np.nonzero(gone)[0]].tolist())
                ex["present"][:n] = present
                ex["lat"][:n], ex["lng"][:n], ex["sj"][:n] = ilat, ilng, sj

        prev_t = t
        prev_present = present.copy()
        prev_lat = lat.copy()
        prev_lng = lng.copy()

    if not out_days:
        return None
    index = {
        "v": 2,
        "generated": int(datetime.now(timezone.utc).timestamp()),
        "tz": "Europe/Berlin",
        "step_s": step_s,
        "days": [{"date": d, "n": len(o["t"]), "t0": o["t"][0], "t1": o["t"][-1]} for d, o in sorted(out_days.items())],
    }
    n = rp.n
    since = {rp.bikes.keys[i]: [int(last_move[i]), bool(last_move[i] <= runs[0][1])]
             for i in range(n) if rp.present[i]}
    log.info("export: %d days, %d polls", len(out_days), sum(len(o["t"]) for o in out_days.values()))
    return {"index": index, "days": out_days, "since": since}
