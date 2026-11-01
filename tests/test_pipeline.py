import copy
import csv
from datetime import datetime, timedelta, timezone

from tracker import history, render
from tracker.config import Config
from tracker.fetch import normalize

from .make_fixture import make


def _cfg(tmp_path):
    cfg = Config.from_env()
    cfg.data_dir = tmp_path
    cfg.history_dir = tmp_path / "history"
    cfg.site_dir = tmp_path / "site"
    cfg.tile_cache_dir = tmp_path / "tiles"
    cfg.tile_url = "http://127.0.0.1:9/{z}/{x}/{y}.png"  # unreachable -> blank basemap
    cfg.request_timeout = 1
    return cfg


def test_normalize_counts(tmp_path):
    cfg = _cfg(tmp_path)
    bikes, stations, meta = normalize(make(), cfg)
    assert meta["counts"]["total"] == len(bikes) > 900
    assert meta["counts"]["free"] == 900
    assert meta["counts"]["stations"] == 60
    assert any(b["battery"] is not None for b in bikes)
    assert meta["city_bounds"] == [50.88, 6.85, 51.0, 7.08]
    s, w, n, e = meta["bounds"]
    assert 50.8 < s < 50.94 < n < 51.1 and 6.8 < w < 6.96 < e < 7.1


def test_history_diff_and_replay(tmp_path):
    cfg = _cfg(tmp_path)
    t0 = datetime(2026, 10, 29, 10, 0, tzinfo=timezone.utc)
    raw = make()
    bikes, stations, meta = normalize(raw, cfg, t0)
    first = history.record(cfg, bikes, stations, meta, t0)
    assert first["new"] == len(bikes)

    # move one free bike ~1 km, remove another, drain a battery
    raw2 = copy.deepcopy(raw)
    places = raw2["countries"][0]["cities"][0]["places"]
    free = [p for p in places if p["bike"]]
    free[0]["lat"] += 0.01
    places.remove(free[1])
    eb = next(p for p in free[2:] if p["bike_list"][0]["pedelec_battery"])
    eb["bike_list"][0]["pedelec_battery"] = max(eb["bike_list"][0]["pedelec_battery"] - 30, 0)
    eb["bike_list"][0]["battery_pack"] = {"percentage": eb["bike_list"][0]["pedelec_battery"]}

    t1 = t0 + timedelta(minutes=15)
    bikes2, stations2, meta2 = normalize(raw2, cfg, t1)
    second = history.record(cfg, bikes2, stations2, meta2, t1)
    assert second == {"new": 0, "moved": 1, "changed": 1, "gone": 1}

    state = history.replay(cfg.history_dir / "2026/10/2026-10-29.csv")
    assert set(state) == {b["bike"] for b in bikes2}

    # next day starts with a full snapshot
    t2 = t0 + timedelta(days=1)
    bikes3, stations3, meta3 = normalize(raw2, cfg, t2)
    history.record(cfg, bikes3, stations3, meta3, t2)
    with (cfg.history_dir / "2026/10/2026-10-30.csv").open() as fh:
        rows = list(csv.DictReader(fh))
    assert sum(r["event"] == "snapshot" for r in rows) == len(bikes3)

    with (cfg.history_dir / "runs.csv").open() as fh:
        assert len(list(csv.DictReader(fh))) == 3


def test_render_site(tmp_path):
    cfg = _cfg(tmp_path)
    bikes, stations, meta = normalize(make(), cfg)
    written = render.write_site(cfg, bikes, stations, meta)
    names = {p.name for p in written}
    assert {"latest.json", "index.html", "map.png", "heatmap.png"} <= names


def test_tile_config(monkeypatch):
    for k in ("TILE_API_KEY", "CARTO_API_KEY", "TILE_URL", "WEB_TILE_URL"):
        monkeypatch.delenv(k, raising=False)
    cfg = Config.from_env()
    assert cfg.tile_url == "" and "openstreetmap" in cfg.web_tile_url
    monkeypatch.setenv("TILE_API_KEY", "abc")
    cfg = Config.from_env()
    assert cfg.tile_url.endswith("?key=abc") and cfg.web_tile_url == cfg.tile_url
    assert "CARTO" in cfg.tile_attribution


def test_export_on_simulated_history(tmp_path):
    from tracker.analysis import export

    from .simulate import simulate

    simulate(tmp_path / "history", days=1.5, step_min=30)
    res = export(tmp_path / "history", days=56, step_s=600)
    days = res["index"]["days"]
    assert sum(d["n"] for d in days) == 72
    for d in days:
        day = res["days"][d["date"]]
        # first frame of a day is a full snapshot that refers only to local tables
        first = day["frames"][0]
        assert len(first) % 4 == 0 and len(first) // 4 > 1000
        assert max(first[0::4]) < len(day["bikes"])
        assert all(-1 <= s < len(day["stations"]) for s in first[3::4])
        # replaying the deltas never refers to unknown bikes
        present = set()
        for fr, gone in zip(day["frames"], day["gone"]):
            present.update(fr[0::4])
            assert set(gone) <= present
            present -= set(gone)
    assert res["since"]
