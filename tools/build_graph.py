"""Build a compact bicycle routing graph for Köln from OpenStreetMap.

Downloads the street and path network inside the tracker's bounding box from
the Overpass API, keeps what can be cycled (or pushed), weights every edge
for cycling and writes one gzip-compressed binary file that the web app's
worker loads for routing (A*).

    python tools/build_graph.py data/osm/koeln-bike.graph.gz

Run by .github/workflows/graph.yml (by hand and once a month), because the
Overpass API is not reachable from every environment. Map data
© OpenStreetMap contributors, ODbL.

File format (little endian, gzip):
  header  b"KVBG", u32 version=1, u32 N nodes, u32 E edges, u32 V vertices,
          u32 osm timestamp (epoch), 8 bytes padding                (32 bytes)
  i32[N]  node lat * 1e6         i32[N]  node lng * 1e6
  u32[E]  edge from node         u32[E]  edge to node
  f32[E]  edge length in metres
  u32[E+1] offset of each edge's inner vertices in the vertex arrays
  i32[V]  vertex lat * 1e6       i32[V]  vertex lng * 1e6
  u8[E]   cost factor * 20 (cost = length * factor)
  u8[E]   flags: 1 = one-way (with the drawing direction), 2 = one-way against it
"""
from __future__ import annotations

import gzip
import json
import math
import struct
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

BBOX = (50.83, 6.76, 51.09, 7.18)  # s, w, n, e (same as the web app)
ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
EXCLUDE = ("motorway|motorway_link|construction|proposed|abandoned|platform|raceway|"
           "bus_guideway|corridor|elevator|escalator|via_ferrata|rest_area|services")
QUERY = f"""[out:json][timeout:300][maxsize:2000000000];
way["highway"]["highway"!~"^({EXCLUDE})$"]({BBOX[0]},{BBOX[1]},{BBOX[2]},{BBOX[3]});
out body;
>;
out skel qt;"""

# cost factor per highway type: < 1 = preferred, > 1 = avoided (busy, rough,
# or pushing). Shortest "cost" = the route a cyclist would roughly take.
BASE = {
    "cycleway": 0.8, "living_street": 1.1, "residential": 1.0, "unclassified": 1.0, "road": 1.2,
    "service": 1.2, "track": 1.3, "tertiary": 1.1, "tertiary_link": 1.1, "secondary": 1.25,
    "secondary_link": 1.25, "primary": 1.4, "primary_link": 1.4, "trunk": 2.5, "trunk_link": 2.5,
    "bridleway": 1.6, "steps": 6.0,
}
GOOD = {"yes", "designated", "permissive", "official"}
ROUGH = {"cobblestone", "sett", "unhewn_cobblestone", "cobblestone:flattened"}
UNPAVED = {"gravel", "dirt", "grass", "ground", "unpaved", "sand", "mud", "earth", "fine_gravel", "pebblestone", "woodchips"}
MIN_FACTOR = 0.8  # the web app's A* heuristic relies on this lower bound


def factor(tags: dict) -> float | None:
    """Cost factor for cycling on this way, or None if it is not usable."""
    hw = tags.get("highway", "")
    bike = tags.get("bicycle", "")
    access = tags.get("access", "")
    if bike in ("no", "dismount") and hw not in ("footway", "pedestrian", "path"):
        return None
    if access in ("private", "no") and bike not in GOOD:
        return None
    if tags.get("area") == "yes" and hw not in ("pedestrian",):
        return None
    if hw in ("footway", "pedestrian", "path"):
        if bike in GOOD:
            f = {"footway": 1.0, "pedestrian": 1.1, "path": 0.9}[hw]
        elif bike in ("no", "dismount"):
            f = 3.0  # pushing
        else:
            f = {"footway": 2.0, "pedestrian": 1.8, "path": 1.4}[hw]
    elif hw in BASE:
        f = BASE[hw]
        if hw == "service" and tags.get("service") in ("parking_aisle", "driveway", "drive-through"):
            f = 1.5
    else:
        return None
    infra = any(tags.get(k, "") in ("lane", "track", "share_busway", "opposite_lane", "opposite_track")
                for k in ("cycleway", "cycleway:both", "cycleway:left", "cycleway:right"))
    if infra or tags.get("bicycle_road") == "yes" or tags.get("cyclestreet") == "yes":
        f = min(f, 0.9)
    surface = tags.get("surface", "")
    if surface in ROUGH:
        f *= 1.2
    elif surface in UNPAVED:
        f *= 1.3
    return max(MIN_FACTOR, min(f, 12.0))


def oneway_flags(tags: dict) -> int:
    ow = tags.get("oneway", "")
    if tags.get("junction") in ("roundabout", "circular") and ow == "":
        ow = "yes"
    if tags.get("oneway:bicycle") == "no" or tags.get("cycleway", "").startswith("opposite"):
        return 0
    if tags.get("highway") in ("footway", "pedestrian", "steps") and tags.get("oneway:bicycle") != "yes":
        return 0
    if ow in ("yes", "1", "true"):
        return 1
    if ow == "-1":
        return 2
    return 0


def fetch() -> dict:
    data = urllib.parse.urlencode({"data": QUERY}).encode()
    last = None
    for url in ENDPOINTS:
        for attempt in range(3):
            try:
                req = urllib.request.Request(url, data=data, headers={
                    "User-Agent": "kvb-bike-tracker graph builder (+https://github.com/eneuberg/kvb-bike-tracker)"})
                with urllib.request.urlopen(req, timeout=400) as r:
                    return json.loads(r.read())
            except Exception as exc:  # noqa: BLE001 - try the next endpoint
                last = exc
                print(f"{url} attempt {attempt + 1}: {exc}", file=sys.stderr)
                time.sleep(20 * (attempt + 1))
    raise SystemExit(f"Overpass download failed: {last}")


def hav(a, b) -> float:
    (la1, lo1), (la2, lo2) = a, b
    p = math.pi / 180
    x = math.sin((la2 - la1) * p / 2) ** 2 + math.cos(la1 * p) * math.cos(la2 * p) * math.sin((lo2 - lo1) * p / 2) ** 2
    return 12742000 * math.asin(math.sqrt(x))


def simplify(pts: list, tol_m: float = 2.0) -> list:
    """Douglas-Peucker on a polyline of (lat, lng); keeps both ends."""
    if len(pts) < 3:
        return pts
    k = math.cos(math.radians(pts[0][0]))
    xy = [((p[1]) * 111320 * k, p[0] * 110574) for p in pts]
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        (x1, y1), (x2, y2) = xy[i], xy[j]
        dx, dy = x2 - x1, y2 - y1
        L = math.hypot(dx, dy) or 1e-9
        best, bi = -1.0, -1
        for m in range(i + 1, j):
            x0, y0 = xy[m]
            d = abs(dy * x0 - dx * y0 + x2 * y1 - y2 * x1) / L
            if d > best:
                best, bi = d, m
        if best > tol_m:
            keep[bi] = True
            stack += [(i, bi), (bi, j)]
    return [p for p, k_ in zip(pts, keep) if k_]


def build(osm: dict) -> bytes:
    coords: dict[int, tuple[float, float]] = {}
    ways = []
    for el in osm["elements"]:
        if el["type"] == "node":
            coords[el["id"]] = (el["lat"], el["lon"])
        elif el["type"] == "way":
            ways.append(el)
    usable = []
    use_count: dict[int, int] = {}
    for w in ways:
        tags = w.get("tags", {})
        f = factor(tags)
        nodes = [n for n in w.get("nodes", []) if n in coords]
        if f is None or len(nodes) < 2:
            continue
        usable.append((nodes, f, oneway_flags(tags)))
        for i, n in enumerate(nodes):
            use_count[n] = use_count.get(n, 0) + (2 if i in (0, len(nodes) - 1) else 1)
    # split every way at junctions (nodes used more than once) into edges
    raw_edges = []
    for nodes, f, ow in usable:
        start = 0
        for i in range(1, len(nodes)):
            if i == len(nodes) - 1 or use_count[nodes[i]] > 1:
                seg = nodes[start:i + 1]
                if len(seg) >= 2 and seg[0] != seg[-1]:
                    raw_edges.append((seg, f, ow))
                start = i
    # largest connected component only, so nothing snaps onto an island
    parent: dict[int, int] = {}

    def find(a):
        parent.setdefault(a, a)
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for seg, _, _ in raw_edges:
        ra, rb = find(seg[0]), find(seg[-1])
        if ra != rb:
            parent[ra] = rb
    sizes: dict[int, int] = {}
    for seg, _, _ in raw_edges:
        r = find(seg[0])
        sizes[r] = sizes.get(r, 0) + 1
    main = max(sizes, key=sizes.get)
    edges = [e for e in raw_edges if find(e[0][0]) == main]

    node_id: dict[int, int] = {}
    nlat, nlng = [], []

    def nid(osm_id):
        i = node_id.get(osm_id)
        if i is None:
            i = node_id[osm_id] = len(nlat)
            la, lo = coords[osm_id]
            nlat.append(round(la * 1e6)); nlng.append(round(lo * 1e6))
        return i

    eu, ev, elen, efac, eflag, gofs, vlat, vlng = [], [], [], [], [], [0], [], []
    for seg, f, ow in edges:
        pts = [coords[n] for n in seg]
        length = sum(hav(pts[k], pts[k + 1]) for k in range(len(pts) - 1))
        if length < 0.5:
            continue
        inner = simplify(pts)[1:-1]
        eu.append(nid(seg[0])); ev.append(nid(seg[-1]))
        elen.append(length); efac.append(max(1, min(255, round(f * 20)))); eflag.append(ow)
        for la, lo in inner:
            vlat.append(round(la * 1e6)); vlng.append(round(lo * 1e6))
        gofs.append(len(vlat))
    N, E, V = len(nlat), len(eu), len(vlat)
    stamp = 0
    ts = osm.get("osm3s", {}).get("timestamp_osm_base")
    if ts:
        stamp = int(time.mktime(time.strptime(ts, "%Y-%m-%dT%H:%M:%SZ")))
    buf = bytearray(struct.pack("<4sIIIII8x", b"KVBG", 1, N, E, V, stamp))
    buf += struct.pack(f"<{N}i", *nlat) + struct.pack(f"<{N}i", *nlng)
    buf += struct.pack(f"<{E}I", *eu) + struct.pack(f"<{E}I", *ev) + struct.pack(f"<{E}f", *elen)
    buf += struct.pack(f"<{E + 1}I", *gofs)
    buf += struct.pack(f"<{V}i", *vlat) + struct.pack(f"<{V}i", *vlng)
    buf += bytes(efac) + bytes(eflag)
    print(f"graph: {N} nodes, {E} edges, {V} inner vertices, {len(buf) / 1e6:.1f} MB raw", file=sys.stderr)
    return gzip.compress(bytes(buf), 9)


def main() -> int:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "data/osm/koeln-bike.graph.gz")
    src = Path(sys.argv[2]) if len(sys.argv) > 2 else None  # optional: a saved Overpass JSON
    osm = json.loads(src.read_text()) if src else fetch()
    data = build(osm)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(data)
    print(f"wrote {out} ({len(data) / 1e6:.1f} MB)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
