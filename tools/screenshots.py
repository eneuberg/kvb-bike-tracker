"""Screenshot the built site at phone and desktop sizes (used by CI previews).

    python tools/screenshots.py SITE_DIR OUT_DIR
"""

from __future__ import annotations

import functools
import http.server
import sys
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

PHONE = dict(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
DESK = dict(viewport={"width": 1440, "height": 900}, device_scale_factor=1)

PICK_STATION = """() => { const L = window.__app.live; let best = null, n = -1;
  for (const [uid, list] of L.docked) if (list.length > n) { n = list.length; best = uid; }
  window.__ui.showStation(best); }"""
PICK_BIKE = """() => { const b = window.__app.live.bikes.find((x) => x.kind !== 'station'); window.__ui.showBike(b.bike); }"""
MID_FRAME = """() => { const r = document.querySelector('#tlRange'); r.value = Math.round(+r.min + (+r.max - +r.min) * 0.6);
  r.dispatchEvent(new Event('input')); }"""
HALF = "() => window.__ui.setSheet('half')"
POINT = "() => window.__ui.pointQuery(6.9583, 50.9413)"
FILTER_OPEN = "() => document.querySelector('.mode:not([hidden]) .more-toggle').click()"
PLAY = "() => { const T = window.__app.tl; if (T) { window.__ui.setFrame(Math.max(T.i0, T.t.length - 6)); window.__ui.startPlay(); } }"
PREP = """() => { localStorage.setItem('kvb-filter-v4', JSON.stringify({ range: 'all', wd: [1,1,1,1,1,1,1], a: 0, b: 96 })); }"""
FULL = "() => window.__ui.setSheet('full')"

SHOTS = [
    ("phone-karte", PHONE, "#karte", []),
    ("phone-karte-station", PHONE, "#karte", [PICK_STATION]),
    ("phone-karte-play", PHONE, "#karte", [PLAY]),
    ("phone-karte-mehr", PHONE, "#karte", [FILTER_OPEN]),
    ("phone-erreichbarkeit", PHONE, "#analyse/erreichbarkeit", []),
    ("phone-erreichbarkeit-punkt", PHONE, "#analyse/erreichbarkeit", [POINT]),
    ("phone-filter", PHONE, "#analyse/erreichbarkeit", [FILTER_OPEN]),
    ("phone-dichte", PHONE, "#analyse/dichte", []),
    ("phone-stroeme", PHONE, "#analyse/stroeme", []),
    ("phone-nutzung", PHONE, "#analyse/nutzung", [FULL]),
    ("phone-stationen", PHONE, "#analyse/stationen", []),
    ("phone-standzeit", PHONE, "#analyse/standzeit", [FULL]),
    ("phone-dark-karte", {**PHONE, "color_scheme": "dark"}, "#karte", []),
    ("phone-dark-erreichbarkeit", {**PHONE, "color_scheme": "dark"}, "#analyse/erreichbarkeit", []),
    ("desktop-karte", DESK, "#karte", [PICK_STATION]),
    ("desktop-erreichbarkeit", DESK, "#analyse/erreichbarkeit", [POINT]),
    ("desktop-stroeme", DESK, "#analyse/stroeme", []),
    ("desktop-nutzung", DESK, "#analyse/nutzung", []),
    ("desktop-dark-dichte", {**DESK, "color_scheme": "dark"}, "#analyse/dichte", []),
]


def main(site: str, out: str) -> int:
    out_dir = Path(out)
    out_dir.mkdir(parents=True, exist_ok=True)
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=site)
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 8765), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    errors = 0
    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
        for name, opts, hash_, actions in SHOTS:
            ctx = browser.new_context(**opts, locale="de-DE", timezone_id="Europe/Berlin")
            page = ctx.new_page()
            errs: list[str] = []
            page.on("pageerror", lambda e, errs=errs: errs.append(str(e)))
            page.on("console", lambda m, errs=errs: errs.append(m.text) if m.type == "error" else None)
            page.goto(f"http://127.0.0.1:8765/")
            page.evaluate(PREP)  # whole day, all days: shows the most data while history is short
            page.goto(f"http://127.0.0.1:8765/{hash_}")
            page.reload()
            try:
                page.wait_for_function("() => window.__app && window.__app.live && document.querySelector('.maplibregl-canvas')", timeout=20000)
                page.wait_for_load_state("networkidle", timeout=20000)
            except Exception as exc:  # still take the shot, it shows what went wrong
                errs.append(f"wait: {exc}")
            page.wait_for_timeout(1500)
            for js in actions:
                page.evaluate(js)
                page.wait_for_timeout(1200)
            page.wait_for_timeout(1500)
            page.screenshot(path=str(out_dir / f"{name}.png"))
            print(name, "ok" if not errs else errs[:3])
            errors += bool(errs)
            ctx.close()
        browser.close()
    httpd.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))
