"""Entry point.

    python -m tracker once      fetch, record history, render site (for CI)
    python -m tracker serve     loop every UPDATE_INTERVAL_SECONDS and serve the site
"""

from __future__ import annotations

import argparse
import functools
import json
import http.server
import logging
import random
import shutil
import signal
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import analysis, history, render
from .config import Config
from .fetch import FetchError, fetch_raw, normalize

log = logging.getLogger("tracker")


class AnalysisState:
    """Keeps the last analysis result between polls (serve mode)."""

    def __init__(self):
        self.last_run = 0.0
        self.since: dict[str, list] = {}

    def update(self, cfg: Config, force: bool = False) -> None:
        if not force and time.monotonic() - self.last_run < cfg.analysis_interval_minutes * 60:
            return
        t0 = time.monotonic()
        try:
            res = analysis.export(cfg.history_dir, cfg.analysis_days, int(cfg.timeline_step_minutes * 60))
        except Exception:  # must never break data collection
            log.exception("history export failed")
            return
        self.last_run = time.monotonic()
        if not res:
            return
        tl = cfg.site_dir / "tl"
        for date, day in res["days"].items():
            render.write_json(tl / f"{date}.json", day)
        render.write_json(tl / "index.json", res["index"])
        keep = {f"{d}.json" for d in res["days"]} | {"index.json"}
        for old in tl.glob("*.json"):
            if old.name not in keep:
                old.unlink()
        self.since = res["since"]
        log.info("history export written in %.1fs", time.monotonic() - t0)

    def attach_since(self, bikes: list[dict], now: int) -> None:
        """Add 'since' (untouched since, epoch) to every bike, patching moves
        that happened after the last full analysis."""
        for b in bikes:
            prev = self.since.get(b["bike"])
            if prev is None:
                self.since[b["bike"]] = prev = [now, False, b["lat"], b["lng"]]
            elif len(prev) < 4:
                prev += [b["lat"], b["lng"]]
            elif history.haversine_m(prev[2], prev[3], b["lat"], b["lng"]) > analysis.IDLE_MOVE_M:
                prev[:] = [now, False, b["lat"], b["lng"]]
            b["since"], b["since_censored"] = prev[0], prev[1]
        live = {b["bike"] for b in bikes}
        for k in [k for k in self.since if k not in live]:
            del self.since[k]  # rented / gone: touched, restart on return


STATE = AnalysisState()


def run_once(cfg: Config, force_analysis: bool = True) -> bool:
    started = datetime.now(timezone.utc)
    try:
        raw = fetch_raw(cfg)
        bikes, stations, meta = normalize(raw, cfg, started)
    except FetchError as exc:
        log.error("fetch failed: %s", exc)
        return False
    if not bikes:
        log.error("feed returned 0 bikes; not recording")
        return False
    counts = history.record(cfg, bikes, stations, meta, started)
    cfg.site_dir.mkdir(parents=True, exist_ok=True)
    STATE.update(cfg, force=force_analysis)
    STATE.attach_since(bikes, int(started.timestamp()))
    render.write_site(cfg, bikes, stations, meta)
    write_history_index(cfg)
    c = meta["counts"]
    log.info("%s bikes (%s at %s stations, %s free) | new=%s moved=%s changed=%s gone=%s",
             c["total"], c["station"], c["stations"], c["free"] + c["other"],
             counts["new"], counts["moved"], counts["changed"], counts["gone"])
    return True


def write_history_index(cfg: Config, files: list[Path] | None = None, note: str = "") -> None:
    """A plain listing so history files can be browsed from the site."""
    if files is None:
        files = list(cfg.history_dir.glob("*/*/*.csv"))
    files = sorted(files, reverse=True)
    rows = []
    for p in files:
        rel = p.relative_to(cfg.history_dir).as_posix()
        size_kb = p.stat().st_size / 1024
        rows.append(f'<tr><td><a href="{rel}">{rel}</a></td><td>{size_kb:,.0f} KB</td></tr>')
    html = (
        "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
        "<title>KVB-Rad history</title>"
        "<style>body{font:14px system-ui;margin:16px;max-width:760px}td{padding:2px 12px 2px 0}"
        "@media(prefers-color-scheme:dark){body{background:#111;color:#eee}a{color:#8ab4f8}}</style>"
        "<h1>KVB-Rad history</h1><p><a href='../'>← map</a> · <a href='runs.csv'>runs.csv</a> "
        "(one row per poll)</p>" + (f"<p>{note}</p>" if note else "")
        + "<table>" + "".join(rows) + "</table>"
    )
    out = cfg.site_dir / "history"
    out.mkdir(parents=True, exist_ok=True)
    (out / "index.html").write_text(html, encoding="utf-8")


def copy_history_into_site(cfg: Config) -> None:
    """Static hosting (GitHub Pages) needs the CSVs inside the site directory.

    Only the last PUBLISH_HISTORY_DAYS days are copied so the Pages artifact
    stays small; the full history always lives in the repo.
    """
    dest = cfg.site_dir / "history"
    cutoff = (datetime.now(timezone.utc) - timedelta(days=cfg.publish_history_days)).strftime("%Y-%m-%d")
    published = []
    for p in cfg.history_dir.glob("*/*/*.csv"):
        if p.name[:10] >= cutoff:
            published.append(p)
    runs = cfg.history_dir / "runs.csv"
    for p in published + ([runs] if runs.exists() else []):
        target = dest / p.relative_to(cfg.history_dir)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(p, target)
    write_history_index(
        cfg, published,
        note=f"Last {cfg.publish_history_days} days shown here. Full history: "
             "<a href='https://github.com/eneuberg/kvb-bike-tracker/tree/main/data/history'>repo</a>.",
    )


class _Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, site_dir: Path, history_dir: Path, poller: "Poller | None" = None, **kwargs):
        self._history_dir = history_dir
        self._poller = poller
        super().__init__(*args, directory=str(site_dir), **kwargs)

    def translate_path(self, path):
        # serve /history/<file>.csv straight from the history volume
        clean = path.split("?", 1)[0].split("#", 1)[0]
        if clean.startswith("/history/") and clean.endswith(".csv"):
            candidate = (self._history_dir / clean[len("/history/"):]).resolve()
            if str(candidate).startswith(str(self._history_dir.resolve())):
                return str(candidate)
        return super().translate_path(path)

    def do_POST(self):
        if self.path.split("?", 1)[0].rstrip("/").endswith("/api/refresh") and self._poller:
            code, body = self._poller.manual()
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            if code == 429:
                self.send_header("Retry-After", str(body["retry_after"]))
            self.end_headers()
            self.wfile.write(data)
            return
        self.send_error(404)

    def end_headers(self):
        if self.path.split("?", 1)[0].endswith((".json", ".png", ".html", "/")):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        log.debug("http: " + fmt, *args)


SEED_DIR = Path(__file__).resolve().parent.parent / "seed" / "history"


def seed_history(cfg: Config) -> int:
    """On a fresh volume, start from the history bundled into the image
    (the repo's data/history at build time). Never touches existing data."""
    hist = cfg.history_dir
    if (hist / "runs.csv").exists() or not (SEED_DIR / "runs.csv").exists():
        return 0
    n = 0
    for src in SEED_DIR.rglob("*.csv"):
        dst = hist / src.relative_to(SEED_DIR)
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        n += 1
    log.info("seeded %d history files from the image", n)
    return n


class Poller:
    """One poll at a time, from the schedule or from a visitor.

    The schedule counts from the last poll, so a manual poll also pushes the
    next automatic one back. Manual polls are limited for all visitors
    together: at most one per cfg.manual_min_interval_seconds."""

    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.lock = threading.Lock()
        self.last = 0.0  # epoch of the last poll attempt
        self.jitter = 0.0

    def _run(self, manual: bool) -> bool:
        started = time.time()  # matches the data timestamp the page sees
        try:
            # a visitor wants to see the new poll everywhere, incl. the timeline
            return run_once(self.cfg, force_analysis=manual)
        except Exception:  # keep the service alive no matter what
            log.exception("update failed")
            return False
        finally:
            self.last = started
            j = self.cfg.update_jitter_seconds
            self.jitter = random.uniform(-j, j) if j else 0.0

    def poll(self) -> bool:
        with self.lock:
            return self._run(manual=False)

    def manual(self) -> tuple[int, dict]:
        """HTTP status and body for POST /api/refresh."""
        gap = self.cfg.manual_min_interval_seconds
        if gap <= 0:
            return 403, {"ok": False, "reason": "disabled"}
        if not self.lock.acquire(blocking=False):
            return 409, {"ok": False, "reason": "running"}
        try:  # checked under the lock, so two visitors can never both poll
            wait = self.last + gap - time.time()
            if wait > 0:
                return 429, {"ok": False, "reason": "too_soon", "retry_after": int(wait) + 1}
            log.info("manual refresh requested")
            ok = self._run(manual=True)
            return (200 if ok else 502), {"ok": ok, "reason": None if ok else "fetch_failed"}
        finally:
            self.lock.release()

    def due_in(self) -> float:
        # the gap to the next automatic poll varies a little at random
        return self.last + self.cfg.update_interval_seconds + self.jitter - time.time()


def serve(cfg: Config) -> None:
    cfg.serving = True
    cfg.site_dir.mkdir(parents=True, exist_ok=True)
    seed_history(cfg)
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    poller = Poller(cfg)

    def loop():
        while not stop.is_set():
            wait = poller.due_in()
            if wait > 0:
                stop.wait(min(wait, 15))  # re-check: a manual poll moves the schedule
                continue
            poller.poll()

    threading.Thread(target=loop, daemon=True).start()
    handler = functools.partial(_Handler, site_dir=cfg.site_dir, history_dir=cfg.history_dir, poller=poller)
    httpd = http.server.ThreadingHTTPServer(("0.0.0.0", cfg.port), handler)
    log.info("serving %s on :%s, updating every %ss, manual refresh every %ss at most",
             cfg.site_dir, cfg.port, cfg.update_interval_seconds, cfg.manual_min_interval_seconds)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    stop.wait()
    httpd.shutdown()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="tracker")
    parser.add_argument("command", choices=["once", "serve"], nargs="?", default="once")
    parser.add_argument("--publish-history", action="store_true",
                        help="copy history CSVs into the site dir (for static hosting)")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    cfg = Config.from_env()
    if args.command == "serve":
        serve(cfg)
        return 0
    ok = run_once(cfg)
    if args.publish_history:
        copy_history_into_site(cfg)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
