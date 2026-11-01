"""Simulate a few days of polls into a history directory (for tests / UI dev).

    python -m tests.simulate OUT_DIR [days] [step_min]
"""

from __future__ import annotations

import copy
import math
import random
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from tracker import history
from tracker.config import Config
from tracker.fetch import normalize

from .make_fixture import make

HOTSPOTS = [(50.9375, 6.9603), (50.9413, 6.9583), (50.9265, 6.9370), (50.9530, 6.9200),
            (50.9380, 6.9900), (50.9230, 6.9600), (50.9610, 6.9580)]


def demand(hour: int) -> float:
    """Rough share of bikes started per 15 min by hour of day."""
    base = 0.002
    peaks = 0.02 * math.exp(-((hour - 8) ** 2) / 2) + 0.025 * math.exp(-((hour - 17.5) ** 2) / 3)
    night = 0.0 if 1 <= hour <= 5 else 0.004
    return base + peaks + night


def simulate(out: Path, days: float = 4, step_min: int = 15, seed: int = 7) -> Config:
    rnd = random.Random(seed)
    cfg = Config.from_env()
    cfg.history_dir = out
    raw = make(seed=3, n_stations=80, n_free=1400)
    city = raw["countries"][0]["cities"][0]
    places = city["places"]
    stations = [p for p in places if p["spot"]]
    free_places = [p for p in places if p["bike"]]
    riding: list[tuple[dict, datetime]] = []     # (bike dict, return time)
    t = datetime(2026, 10, 26, 0, 0, tzinfo=timezone.utc)
    end = t + timedelta(days=days)
    uid = 900000
    while t < end:
        local_hour = (t.hour + 1) % 24
        # returns
        still = []
        for bike, back in riding:
            if back <= t:
                hlat, hlng = rnd.choice(HOTSPOTS)
                if rnd.random() < 0.25:
                    s = rnd.choice(stations)
                    s["bike_list"].append(bike)
                else:
                    uid += 1
                    free_places.append({"uid": uid, "lat": hlat + rnd.gauss(0, 0.015),
                                        "lng": hlng + rnd.gauss(0, 0.022), "name": "BIKE",
                                        "spot": False, "bike": True, "bike_list": [bike]})
            else:
                still.append((bike, back))
        riding = still
        # rentals
        p = demand(local_hour)
        keep = []
        for fp in free_places:
            if rnd.random() < p:
                riding.append((fp["bike_list"][0], t + timedelta(minutes=rnd.randint(6, 45))))
            else:
                if rnd.random() < 0.02:  # gps jitter
                    fp["lat"] += rnd.gauss(0, 0.0002)
                keep.append(fp)
        free_places = keep
        for s in stations:
            out_list = []
            for b in s["bike_list"]:
                if rnd.random() < p * 0.8:
                    riding.append((b, t + timedelta(minutes=rnd.randint(6, 45))))
                else:
                    out_list.append(b)
            s["bike_list"] = out_list
            s["bikes"] = len(out_list)
        city["places"] = stations + free_places
        bikes, sts, meta = normalize(copy.deepcopy(raw), cfg, t)
        history.record(cfg, bikes, sts, meta, t)
        t += timedelta(minutes=step_min)
    return cfg


if __name__ == "__main__":
    out = Path(sys.argv[1])
    days = float(sys.argv[2]) if len(sys.argv) > 2 else 4
    step = int(sys.argv[3]) if len(sys.argv) > 3 else 15
    simulate(out, days, step)
    print("simulated into", out)
