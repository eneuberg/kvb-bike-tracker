"""History analysis.

Replays the CSV history poll by poll (``runs.csv`` is the list of polls, the
day files hold the changes) and derives:

* availability: P(at least one bike in a ~250 m cell / within ~1 cell around it)
  per hour of day, separately for weekdays and weekends
* density: average number of bikes per cell and hour
* stations: average bikes and P(empty) per station and hour
* trips (inferred): a bike leaves the feed at A and re-appears at B, or jumps
  more than TRIP_MIN_M between two polls. Gives trips per hour, duration and
  distance distributions, origin/destination flows and net in/outflow per cell.
* bikes in use: number of inferred trips in progress at each poll
* idle time: since when each bike has not been touched
* timeline: compact per-poll deltas of the last few days for the scrubber

All heavy work is numpy on a fixed grid, so a few weeks of 15-minute polls
take seconds.
"""

from __future__ import annotations

import base64
import csv
import logging
import math
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import numpy as np

log = logging.getLogger(__name__)
TZ = ZoneInfo("Europe/Berlin")

CELL_M = 250.0
TRIP_MIN_M = 300.0        # jump between two polls that counts as a ride
TRIP_MIN_GONE_M = 100.0   # min distance for a gone -> back pair to count as a ride
MAX_TRIP_S = 4 * 3600     # longer absences are treated as service, not rides
IDLE_MOVE_M = 100.0       # moves below this are treated as GPS jitter
COARSE = 4                # flow grid = 4x4 fine cells (~1 km)
DAYPARTS = [("Morgen", 6, 10), ("Mittag", 10, 16), ("Abend", 16, 20), ("Nacht", 20, 6)]
TL_LAT0, TL_LNG0, TL_SCALE = 50.0, 6.0, 1e5


def daypart(hour: int) -> int:
    for i, (_, a, b) in enumerate(DAYPARTS):
        if (a <= hour < b) if a < b else (hour >= a or hour < b):
            return i
    return 3


@dataclass
class Grid:
    lat0: float = 50.80
    lng0: float = 6.70
    lat1: float = 51.10
    lng1: float = 7.25

    def __post_init__(self):
        mid = math.radians((self.lat0 + self.lat1) / 2)
        self.dlat = CELL_M / 111_320.0
        self.dlng = CELL_M / (111_320.0 * math.cos(mid))
        self.W = int(math.ceil((self.lng1 - self.lng0) / self.dlng))
        self.H = int(math.ceil((self.lat1 - self.lat0) / self.dlat))

    def cells(self, lat: np.ndarray, lng: np.ndarray) -> np.ndarray:
        ix = np.floor((lng - self.lng0) / self.dlng).astype(np.int64)
        iy = np.floor((lat - self.lat0) / self.dlat).astype(np.int64)
        ok = (ix >= 0) & (ix < self.W) & (iy >= 0) & (iy < self.H)
        return np.where(ok, iy * self.W + ix, -1)

    def coarse(self, cell: int) -> int:
        iy, ix = divmod(cell, self.W)
        return (iy // COARSE) * ((self.W + COARSE - 1) // COARSE) + ix // COARSE

    def as_json(self) -> dict:
        return {"lat0": self.lat0, "lng0": self.lng0, "dlat": self.dlat, "dlng": self.dlng,
                "W": self.W, "H": self.H, "cell_m": CELL_M, "coarse": COARSE}


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


def _b64(arr: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(arr, dtype=np.uint8).tobytes()).decode()


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


def analyze(history_dir: Path, analysis_days: float = 56, timeline_days: float = 7,
            timeline_step_s: int = 600, now: int | None = None) -> dict[str, Any] | None:
    runs = _read_runs(history_dir)
    if not runs:
        return None
    now = now or runs[-1][1]
    window_start = now - int(max(analysis_days, timeline_days) * 86400)
    tl_start = now - int(timeline_days * 86400)
    an_start = now - int(analysis_days * 86400)

    # The replay has to start at a day file's snapshot, so begin at the first
    # poll of the (UTC) day that contains the window start.
    inside = [r for r in runs if r[1] >= window_start]
    if not inside:
        return None
    first_day = inside[0][0][:10]
    runs = [r for r in runs if r[0][:10] >= first_day]

    grid = Grid()
    ncell = grid.W * grid.H
    st = _Stations()
    rp = Replay()

    # accumulators: bucket = daytype * 24 + hour  (daytype 0 = Mo-Fr, 1 = Sa/So)
    NB = 48
    n_b = np.zeros(NB, dtype=np.int64)
    acc_occ = np.zeros((NB, ncell), dtype=np.int32)
    acc_near = np.zeros((NB, ncell), dtype=np.int32)
    acc_cnt = np.zeros((NB, ncell), dtype=np.int32)
    st_cap = 4096
    acc_st_sum = np.zeros((NB, st_cap), dtype=np.int64)
    acc_st_empty = np.zeros((NB, st_cap), dtype=np.int64)
    acc_st_n = np.zeros((NB, st_cap), dtype=np.int64)
    hours_seen: list[set] = [set() for _ in range(NB)]

    poll_t: list[int] = []
    poll_bucket: list[int] = []
    poll_total: list[int] = []
    poll_free: list[int] = []

    trips: list[tuple] = []           # (start, end, lat0, lng0, lat1, lng1, dist, short)
    service = roundtrips = 0
    open_trip: dict[int, tuple] = {}  # bike -> (last_seen, first_absent, lat, lng)
    last_move = np.zeros(8192)
    first_seen = np.zeros(8192)

    prev_t = None
    prev_present = np.zeros(0, dtype=bool)
    prev_lat = np.zeros(0)
    prev_lng = np.zeros(0)

    # timeline export state
    tl_t: list[int] = []
    tl_frames: list[list[int]] = []
    tl_gone: list[list[int]] = []
    tl_total: list[int] = []
    tl_index: list[int] = []          # position in poll arrays, for in-use lookup
    ex_present = np.zeros(0, dtype=bool)
    ex_lat = np.zeros(0, dtype=np.int64)
    ex_lng = np.zeros(0, dtype=np.int64)
    ex_place = np.zeros(0, dtype=np.int32)

    day_cache: dict[str, dict] = {}
    station_mask_by_day: dict[str, np.ndarray] = {}

    for ts, t in runs:
        day = ts[:10]
        if day not in day_cache:
            day_cache.clear()
            y, m = day[:4], day[5:7]
            p = history_dir / y / m / f"{day}.csv"
            day_cache[day] = _day_rows(p) if p.exists() else {}
            sp = history_dir / y / m / f"{day}.stations.csv"
            present_st = st.load(sp) if sp.exists() else set(range(len(st.name)))
            mask = np.zeros(st_cap, dtype=bool)
            mask[list(present_st)] = True
            station_mask_by_day = {day: mask}
        rows = day_cache[day].get(ts)
        if rows:
            rp.apply(rows, st)
        n = rp.n
        if n > len(last_move):
            last_move = _grow(last_move, n)
            first_seen = _grow(first_seen, n)

        present = rp.present[:n]
        lat, lng = rp.lat[:n], rp.lng[:n]

        # --- trips & idle ------------------------------------------------
        m = len(prev_present)
        was = np.zeros(n, dtype=bool)
        was[:m] = prev_present[:m]
        newly_seen = present & (first_seen[:n] == 0)
        first_seen[:n][newly_seen] = t
        last_move[:n][newly_seen] = t
        if prev_t is not None:
            pl = np.zeros(n); pg = np.zeros(n)
            pl[:m], pg[:m] = prev_lat[:m], prev_lng[:m]
            cont = was & present
            d = np.zeros(n)
            if cont.any():
                d[cont] = haversine(pl[cont], pg[cont], lat[cont], lng[cont])
            for i in np.nonzero(cont & (d > TRIP_MIN_M))[0]:
                trips.append((prev_t, t, pl[i], pg[i], lat[i], lng[i], float(d[i]), True))
            last_move[:n][cont & (d > IDLE_MOVE_M)] = t
            for i in np.nonzero(was & ~present)[0]:
                open_trip[int(i)] = (prev_t, t, pl[i], pg[i])
            for i in np.nonzero(~was & present)[0]:
                i = int(i)
                last_move[i] = t
                ot = open_trip.pop(i, None)
                if ot is None:
                    continue
                start = (ot[0] + ot[1]) / 2
                end = (prev_t + t) / 2
                dist = float(haversine(ot[2], ot[3], lat[i], lng[i]))
                if end - start > MAX_TRIP_S:
                    service += 1
                elif dist < TRIP_MIN_GONE_M:
                    roundtrips += 1
                else:
                    trips.append((start, end, ot[2], ot[3], lat[i], lng[i], dist, False))

        # --- grid & station aggregates ------------------------------------
        if t >= an_start:
            local = datetime.fromtimestamp(t, TZ)
            b = (1 if local.weekday() >= 5 else 0) * 24 + local.hour
            n_b[b] += 1
            hours_seen[b].add(local.strftime("%Y-%m-%d %H"))
            cells = grid.cells(lat[present], lng[present])
            cells = cells[cells >= 0]
            counts = np.bincount(cells, minlength=ncell)
            occ = counts > 0
            g = occ.reshape(grid.H, grid.W)
            near = g.copy()
            near[1:, :] |= g[:-1, :]; near[:-1, :] |= g[1:, :]
            near2 = near.copy()
            near2[:, 1:] |= near[:, :-1]; near2[:, :-1] |= near[:, 1:]
            acc_occ[b] += occ
            acc_near[b] += near2.ravel()
            acc_cnt[b] += counts.astype(np.int32)
            pl_ = rp.place[:n][present]
            pl_ = pl_[pl_ >= 0]
            ns = len(st.name)
            if ns <= st_cap:
                sc = np.bincount(pl_, minlength=st_cap)[:st_cap]
                mask = station_mask_by_day.get(day, np.ones(st_cap, dtype=bool)).copy()
                mask[ns:] = False
                mask[np.unique(pl_)] = True
                acc_st_sum[b] += np.where(mask, sc, 0)
                acc_st_empty[b] += mask & (sc == 0)
                acc_st_n[b] += mask
            poll_bucket.append(b)
        else:
            poll_bucket.append(-1)

        poll_t.append(t)
        poll_total.append(int(present.sum()))
        poll_free.append(int((present & (rp.place[:n] < 0)).sum()))

        # --- timeline frames ---------------------------------------------
        if t >= tl_start and (not tl_t or t - tl_t[-1] >= timeline_step_s - 60):
            ilat = np.round((lat - TL_LAT0) * TL_SCALE).astype(np.int64)
            ilng = np.round((lng - TL_LNG0) * TL_SCALE).astype(np.int64)
            plc = rp.place[:n]
            k = len(ex_present)
            if k < n:
                ex_present = np.concatenate([ex_present, np.zeros(n - k, dtype=bool)])
                ex_lat = np.concatenate([ex_lat, np.zeros(n - k, dtype=np.int64)])
                ex_lng = np.concatenate([ex_lng, np.zeros(n - k, dtype=np.int64)])
                ex_place = np.concatenate([ex_place, np.full(n - k, -2, dtype=np.int32)])
            changed = present & (~ex_present | (ex_lat != ilat) | (ex_lng != ilng) | (ex_place != plc))
            gone = ex_present & ~present
            idx = np.nonzero(changed)[0]
            flat = np.stack([idx, ilat[idx], ilng[idx], plc[idx]], axis=1).ravel().tolist() if len(idx) else []
            tl_frames.append(flat)
            tl_gone.append(np.nonzero(gone)[0].tolist())
            tl_t.append(t)
            tl_total.append(int(present.sum()))
            tl_index.append(len(poll_t) - 1)
            ex_present = present.copy()
            ex_lat, ex_lng, ex_place = ilat.copy(), ilng.copy(), plc.copy()

        prev_t = t
        prev_present = present.copy()
        prev_lat = lat.copy()
        prev_lng = lng.copy()

    if not poll_t:
        return None

    # --- bikes in use per poll (trips in progress) ---------------------------
    starts = np.array(sorted(tr[0] for tr in trips if not tr[7]), dtype=float)
    ends = np.array(sorted(tr[1] for tr in trips if not tr[7]), dtype=float)
    open_starts = np.array(sorted((ot[0] + ot[1]) / 2 for ot in open_trip.values()
                                  if poll_t[-1] - (ot[0] + ot[1]) / 2 <= MAX_TRIP_S), dtype=float)
    pt = np.array(poll_t, dtype=float)
    inuse = (np.searchsorted(starts, pt, side="left") - np.searchsorted(ends, pt, side="right")
             + np.searchsorted(open_starts, pt, side="left"))
    inuse = np.maximum(inuse, 0)

    acc_inuse = np.zeros(NB)
    for b, u in zip(poll_bucket, inuse):
        if b >= 0:
            acc_inuse[b] += u

    # --- trip aggregates -------------------------------------------------
    trips_b = np.zeros(NB)
    dur_bins = np.zeros(25, dtype=np.int64)    # 5-min bins, last = > 120 min
    dist_bins = np.zeros(33, dtype=np.int64)   # 250 m bins, last = > 8 km
    od: Counter = Counter()
    netflow: dict[int, list[int]] = defaultdict(lambda: [0] * 8)
    durs, dists = [], []
    recent_trips = [tr for tr in trips if tr[0] >= an_start]
    if recent_trips:
        s_cells = grid.cells(np.array([tr[2] for tr in recent_trips]), np.array([tr[3] for tr in recent_trips]))
        e_cells = grid.cells(np.array([tr[4] for tr in recent_trips]), np.array([tr[5] for tr in recent_trips]))
    for k, tr in enumerate(recent_trips):
        start, end, *_rest, dist, short = tr
        local = datetime.fromtimestamp((start + end) / 2 if short else start, TZ)
        b = (1 if local.weekday() >= 5 else 0) * 24 + local.hour
        trips_b[b] += 1
        dp = daypart(local.hour)
        dists.append(dist)
        dist_bins[min(int(dist // 250), 32)] += 1
        if not short:
            dur = (end - start) / 60
            durs.append(dur)
            dur_bins[min(int(dur // 5), 24)] += 1
        sc, ec = int(s_cells[k]), int(e_cells[k])
        if sc >= 0 and ec >= 0:
            netflow[sc][dp] += 1
            netflow[ec][4 + dp] += 1
            co, cd = grid.coarse(sc), grid.coarse(ec)
            if co != cd:
                od[(co, cd, dp)] += 1

    # top flows per daypart and overall
    od_all: Counter = Counter()
    for (o, d, dp), c in od.items():
        od_all[(o, d)] += c
    flows = [[o, d, -1, c] for (o, d), c in od_all.most_common(200)]
    for dp in range(4):
        part = Counter({(o, d): c for (o, d, p), c in od.items() if p == dp})
        flows += [[o, d, dp, c] for (o, d), c in part.most_common(120)]

    # --- export grids ----------------------------------------------------
    active = np.nonzero(acc_near.sum(axis=0) > 0)[0]

    def pct(acc):
        out = {}
        for key, rng in (("wd", range(0, 24)), ("we", range(24, 48))):
            m = np.full((24, len(active)), 255, dtype=np.uint8)
            for h, b in enumerate(rng):
                if n_b[b]:
                    m[h] = np.round(acc[b, active] * 100.0 / n_b[b]).astype(np.uint8)
            out[key] = _b64(m)
        return out

    def avg10(acc):
        out = {}
        for key, rng in (("wd", range(0, 24)), ("we", range(24, 48))):
            m = np.full((24, len(active)), 255, dtype=np.uint8)
            for h, b in enumerate(rng):
                if n_b[b]:
                    m[h] = np.clip(np.round(acc[b, active] * 10.0 / n_b[b]), 0, 254).astype(np.uint8)
            out[key] = _b64(m)
        return out

    def per_hour(arr, scale=1.0, nd=1):
        res = {}
        for key, rng in (("wd", range(0, 24)), ("we", range(24, 48))):
            res[key] = [None if not n_b[b] else round(float(arr[b]) * scale / n_b[b], nd) for b in rng]
        return res

    def trips_per_hour():
        res = {}
        for key, rng in (("wd", range(0, 24)), ("we", range(24, 48))):
            res[key] = [None if not hours_seen[b] else round(trips_b[b] / len(hours_seen[b]), 1) for b in rng]
        return res

    ns = min(len(st.name), st_cap)
    st_avg, st_empty = {}, {}
    for key, rng in (("wd", range(0, 24)), ("we", range(24, 48))):
        a = np.full((ns, 24), -1, dtype=np.int64)
        e = np.full((ns, 24), -1, dtype=np.int64)
        for h, b in enumerate(rng):
            nn = acc_st_n[b, :ns]
            okm = nn > 0
            a[okm, h] = np.round(acc_st_sum[b, :ns][okm] * 10.0 / nn[okm])
            e[okm, h] = np.round(acc_st_empty[b, :ns][okm] * 100.0 / nn[okm])
        st_avg[key] = [[None if v < 0 else int(v) for v in row] for row in a]
        st_empty[key] = [[None if v < 0 else int(v) for v in row] for row in e]

    span_days = (poll_t[-1] - max(poll_t[0], an_start)) / 86400
    an_polls = int(sum(1 for b in poll_bucket if b >= 0))

    # recent series for charts (last timeline_days)
    ser_idx = [i for i, t in enumerate(poll_t) if t >= tl_start]
    if len(ser_idx) > 1500:
        step = len(ser_idx) / 1500
        ser_idx = [ser_idx[int(k * step)] for k in range(1500)]

    analysis = {
        "v": 1,
        "generated": int(datetime.now(timezone.utc).timestamp()),
        "window": {"from": max(poll_t[0], an_start), "to": poll_t[-1], "days": round(span_days, 2),
                   "polls": an_polls, "tz": "Europe/Berlin"},
        "grid": grid.as_json(),
        "cells": active.tolist(),
        "n": {"wd": n_b[:24].tolist(), "we": n_b[24:].tolist()},
        "prob": pct(acc_occ),
        "near": pct(acc_near),
        "avg": avg10(acc_cnt),
        "stations": {
            "uid": st.table.keys[:ns], "name": st.name[:ns],
            "lat": [round(x, 6) for x in st.lat[:ns]], "lng": [round(x, 6) for x in st.lng[:ns]],
            "avg": st_avg, "empty": st_empty,
        },
        "usage": {
            "inuse": per_hour(acc_inuse),
            "trips_per_h": trips_per_hour(),
            "dur_hist": {"bin_min": 5, "counts": dur_bins.tolist()},
            "dist_hist": {"bin_m": 250, "counts": dist_bins.tolist()},
            "totals": {
                "trips": len(recent_trips),
                "short": sum(1 for tr in recent_trips if tr[7]),
                "roundtrips": roundtrips, "service": service,
                "median_dur_min": round(float(np.median(durs)), 1) if durs else None,
                "median_dist_m": round(float(np.median(dists))) if dists else None,
                "per_day": round(len(recent_trips) / span_days, 1) if span_days >= 0.5 else None,
            },
            "series": {"t": [poll_t[i] for i in ser_idx], "total": [poll_total[i] for i in ser_idx],
                       "free": [poll_free[i] for i in ser_idx], "inuse": [int(inuse[i]) for i in ser_idx]},
        },
        "flows": {
            "dayparts": [f"{name} {a}–{b} Uhr" for name, a, b in DAYPARTS],
            "od": flows,
            "net": [[c] + v for c, v in netflow.items()],
        },
        "params": {"trip_min_m": TRIP_MIN_M, "trip_min_gone_m": TRIP_MIN_GONE_M,
                   "max_trip_h": MAX_TRIP_S / 3600, "idle_move_m": IDLE_MOVE_M},
    }

    timeline = {
        "v": 1, "lat0": TL_LAT0, "lng0": TL_LNG0, "scale": TL_SCALE,
        "bikes": rp.bikes.keys,
        "stations": [[st.table.keys[i], st.name[i], round(st.lat[i], 6), round(st.lng[i], 6)]
                     for i in range(len(st.name))],
        "t": tl_t, "frames": tl_frames, "gone": tl_gone, "total": tl_total,
        "inuse": [int(inuse[i]) for i in tl_index],
    }

    n = rp.n
    since = {rp.bikes.keys[i]: [int(last_move[i]), bool(last_move[i] <= poll_t[0])]
             for i in range(n) if rp.present[i]}

    log.info("analysis: %d polls over %.1f days, %d trips, %d active cells, %d timeline frames",
             an_polls, span_days, len(recent_trips), len(active), len(tl_t))
    return {"analysis": analysis, "timeline": timeline, "since": since}
