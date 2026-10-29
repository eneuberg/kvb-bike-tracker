"""Entry point.

    python -m tracker once      fetch, record history, render site (for CI)
    python -m tracker serve     loop every UPDATE_INTERVAL_SECONDS and serve the site
"""

from __future__ import annotations

import argparse
import functools
import http.server
import logging
import shutil
import signal
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import history, render
from .config import Config
from .fetch import FetchError, fetch_raw, normalize

log = logging.getLogger("tracker")


def run_once(cfg: Config) -> bool:
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
    def __init__(self, *args, site_dir: Path, history_dir: Path, **kwargs):
        self._history_dir = history_dir
        super().__init__(*args, directory=str(site_dir), **kwargs)

    def translate_path(self, path):
        # serve /history/<file>.csv straight from the history volume
        clean = path.split("?", 1)[0].split("#", 1)[0]
        if clean.startswith("/history/") and clean.endswith(".csv"):
            candidate = (self._history_dir / clean[len("/history/"):]).resolve()
            if str(candidate).startswith(str(self._history_dir.resolve())):
                return str(candidate)
        return super().translate_path(path)

    def end_headers(self):
        if self.path.split("?", 1)[0].endswith((".json", ".png", ".html", "/")):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        log.debug("http: " + fmt, *args)


def serve(cfg: Config) -> None:
    cfg.site_dir.mkdir(parents=True, exist_ok=True)
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())

    def loop():
        while not stop.is_set():
            t0 = time.monotonic()
            try:
                run_once(cfg)
            except Exception:  # keep the loop alive no matter what
                log.exception("update failed")
            stop.wait(max(cfg.update_interval_seconds - (time.monotonic() - t0), 5))

    threading.Thread(target=loop, daemon=True).start()
    handler = functools.partial(_Handler, site_dir=cfg.site_dir, history_dir=cfg.history_dir)
    httpd = http.server.ThreadingHTTPServer(("0.0.0.0", cfg.port), handler)
    log.info("serving %s on :%s, updating every %ss", cfg.site_dir, cfg.port, cfg.update_interval_seconds)
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
