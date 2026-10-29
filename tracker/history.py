"""Append-only history storage.

Layout (all plain CSV so git can delta-compress it):

    history/
      runs.csv                       one row per poll: timestamp + counts
      YYYY/MM/YYYY-MM-DD.csv         bike events for that day
      YYYY/MM/YYYY-MM-DD.stations.csv  station snapshot (first poll of the day)

Bike events per day file:
  snapshot  full state of every bike, written by the first poll of each day
  new       bike appeared in the feed (e.g. returned after a ride)
  moved     position moved > MOVE_THRESHOLD_M or bike changed station
  changed   metadata changed (state, active, battery by >= BATTERY_THRESHOLD)
  gone      bike disappeared from the feed (rented, in service, ...)

The state at any time is reconstructed by replaying a day file from its
snapshot rows forward.
"""

from __future__ import annotations

import csv
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import Config

BIKE_FIELDS = [
    "ts", "event", "bike", "lat", "lng", "kind", "place_uid", "place_name",
    "bike_type", "electric", "battery", "state", "active", "lock_types",
]
STATION_FIELDS = [
    "ts", "uid", "number", "name", "lat", "lng", "bikes", "bikes_available_to_rent",
    "bike_racks", "free_racks", "terminal_type", "maintenance",
]
RUN_FIELDS = [
    "ts", "total", "station", "free", "other", "electric", "stations",
    "new", "moved", "changed", "gone",
]


def _day_path(history_dir: Path, ts: datetime) -> Path:
    return history_dir / f"{ts:%Y}" / f"{ts:%m}" / f"{ts:%Y-%m-%d}.csv"


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _fmt(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "1" if value else "0"
    return str(value)


def _row(ts: str, event: str, bike: dict[str, Any]) -> dict[str, str]:
    row = {k: _fmt(bike.get(k)) for k in BIKE_FIELDS}
    row["ts"], row["event"] = ts, event
    return row


def _parse_row(row: dict[str, str]) -> dict[str, Any]:
    def num(v, cast):
        try:
            return cast(v) if v != "" else None
        except ValueError:
            return None

    return {
        "bike": row["bike"],
        "lat": num(row.get("lat", ""), float),
        "lng": num(row.get("lng", ""), float),
        "kind": row.get("kind", ""),
        "place_uid": row.get("place_uid", ""),
        "place_name": row.get("place_name", ""),
        "bike_type": num(row.get("bike_type", ""), int),
        "electric": row.get("electric") == "1",
        "battery": num(row.get("battery", ""), int),
        "state": row.get("state", ""),
        "active": None if row.get("active", "") == "" else row.get("active") == "1",
        "lock_types": row.get("lock_types", ""),
    }


def replay(path: Path) -> dict[str, dict[str, Any]]:
    """Reconstruct the last known state of all bikes from one day file."""
    state: dict[str, dict[str, Any]] = {}
    with path.open(newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            if row["event"] == "gone":
                state.pop(row["bike"], None)
            else:
                state[row["bike"]] = _parse_row(row)
    return state


def _latest_day_file(history_dir: Path) -> Path | None:
    files = sorted(
        p for p in history_dir.glob("*/*/*.csv") if not p.name.endswith(".stations.csv")
    )
    return files[-1] if files else None


def diff(prev: dict[str, dict[str, Any]], current: list[dict[str, Any]], cfg: Config):
    """Yield (event, bike) tuples describing the change from prev to current."""
    seen = set()
    for bike in current:
        number = bike["bike"]
        seen.add(number)
        old = prev.get(number)
        if old is None:
            yield "new", bike
            continue
        moved = old.get("place_uid") != bike["place_uid"]
        if not moved and None not in (old.get("lat"), old.get("lng")):
            moved = haversine_m(old["lat"], old["lng"], bike["lat"], bike["lng"]) > cfg.move_threshold_m
        if moved:
            yield "moved", bike
            continue
        ob, nb = old.get("battery"), bike.get("battery")
        battery_changed = (ob is None) != (nb is None) or (
            ob is not None and nb is not None and abs(ob - nb) >= cfg.battery_threshold
        )
        if (
            battery_changed
            or old.get("state") != bike["state"]
            or old.get("active") != bike["active"]
            or old.get("kind") != bike["kind"]
        ):
            yield "changed", bike
    for number, old in prev.items():
        if number not in seen:
            yield "gone", old


def record(cfg: Config, bikes: list[dict[str, Any]], stations: list[dict[str, Any]],
           meta: dict[str, Any], ts: datetime | None = None) -> dict[str, int]:
    ts = ts or datetime.now(timezone.utc)
    ts_iso = meta["ts"]
    history_dir = cfg.history_dir
    day_path = _day_path(history_dir, ts)
    day_path.parent.mkdir(parents=True, exist_ok=True)

    latest = _latest_day_file(history_dir)
    prev = replay(latest) if latest else {}
    new_day = not day_path.exists()

    events = list(diff(prev, bikes, cfg))
    counts = {"new": 0, "moved": 0, "changed": 0, "gone": 0}
    for event, _ in events:
        counts[event] += 1

    with day_path.open("a", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=BIKE_FIELDS)
        if new_day:
            writer.writeheader()
            # Full state at the start of each day so a day file is self-contained.
            for bike in bikes:
                writer.writerow(_row(ts_iso, "snapshot", bike))
            # Keep the day boundary lossless for disappearances only;
            # all other changes are implied by the snapshot itself.
            for event, bike in events:
                if event == "gone":
                    writer.writerow(_row(ts_iso, "gone", bike))
        else:
            for event, bike in events:
                writer.writerow(_row(ts_iso, event, bike))

    station_path = day_path.with_name(day_path.stem + ".stations.csv")
    if not station_path.exists():
        with station_path.open("w", newline="", encoding="utf-8") as fh:
            writer = csv.DictWriter(fh, fieldnames=STATION_FIELDS)
            writer.writeheader()
            for st in stations:
                writer.writerow({k: ts_iso if k == "ts" else _fmt(st.get(k)) for k in STATION_FIELDS})

    runs_path = history_dir / "runs.csv"
    write_header = not runs_path.exists()
    with runs_path.open("a", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=RUN_FIELDS)
        if write_header:
            writer.writeheader()
        writer.writerow({"ts": ts_iso, **meta["counts"], **counts})

    return counts
