"""Generate a synthetic nextbike-live payload for Köln (offline tests only)."""

from __future__ import annotations

import json
import random
import sys


def make(seed: int = 1, n_stations: int = 60, n_free: int = 900) -> dict:
    rnd = random.Random(seed)
    places = []
    bike_no = 22000

    def bike(electric: bool):
        nonlocal bike_no
        bike_no += 1
        b = {"number": str(bike_no), "bike_type": 196 if electric else 71, "lock_types": ["frame_lock"],
             "active": True, "state": "ok", "electric_lock": True, "boardcomputer": 9000000 + bike_no,
             "pedelec_battery": None, "battery_pack": None}
        if electric:
            pct = rnd.randint(5, 100)
            b["pedelec_battery"] = pct
            b["battery_pack"] = {"percentage": pct}
        return b

    centres = [(50.9375, 6.9603), (50.9413, 6.9583), (50.9265, 6.9370), (50.9530, 6.9200), (50.9380, 6.9900)]
    for i in range(n_stations):
        clat, clng = rnd.choice(centres)
        bl = [bike(rnd.random() < 0.15) for _ in range(rnd.randint(0, 12))]
        places.append({"uid": 100000 + i, "lat": clat + rnd.gauss(0, 0.012), "lng": clng + rnd.gauss(0, 0.018),
                       "name": f"Station {i}", "spot": True, "bike": False, "number": 4000 + i,
                       "bikes": len(bl), "bikes_available_to_rent": len(bl), "bike_racks": 10,
                       "free_racks": max(10 - len(bl), 0), "terminal_type": "free",
                       "bike_numbers": [b["number"] for b in bl], "bike_list": bl, "maintenance": False})
    for i in range(n_free):
        clat, clng = rnd.choice(centres)
        b = bike(rnd.random() < 0.15)
        places.append({"uid": 200000 + i, "lat": clat + rnd.gauss(0, 0.02), "lng": clng + rnd.gauss(0, 0.03),
                       "name": f"BIKE {b['number']}", "spot": False, "bike": True, "number": 0, "bikes": 1,
                       "bike_numbers": [b["number"]], "bike_list": [b]})
    return {"countries": [{"domain": "kg", "name": "KVB Rad Germany", "country": "DE", "cities": [{
        "uid": 14, "name": "Köln", "places": places,
        "bounds": {"south_west": {"lat": 50.88, "lng": 6.85}, "north_east": {"lat": 51.0, "lng": 7.08}},
    }]}]}


if __name__ == "__main__":
    json.dump(make(int(sys.argv[1]) if len(sys.argv) > 1 else 1), sys.stdout)
