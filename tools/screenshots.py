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
FULL = "() => window.__ui.setSheet('full')"

SHOTS = [
    ("phone-live", PHONE, "#live", []),
    ("phone-live-station", PHONE, "#live", [PICK_STATION]),
    ("phone-live-bike", PHONE, "#live", [PICK_BIKE]),
    ("phone-verlauf", PHONE, "#verlauf", [MID_FRAME]),
    ("phone-verlauf-half", PHONE, "#verlauf", [MID_FRAME, HALF]),
    ("phone-verfuegbarkeit", PHONE, "#analyse/verfuegbarkeit", []),
    ("phone-dichte", PHONE, "#analyse/dichte", []),
    ("phone-nutzung", PHONE, "#analyse/nutzung", [FULL]),
    ("phone-stroeme", PHONE, "#analyse/stroeme", []),
    ("phone-stationen", PHONE, "#analyse/stationen", []),
    ("phone-standzeit", PHONE, "#analyse/standzeit", []),
    ("phone-dark-live", {**PHONE, "color_scheme": "dark"}, "#live", []),
    ("desktop-live", DESK, "#live", [PICK_STATION]),
    ("desktop-verlauf", DESK, "#verlauf", [MID_FRAME]),
    ("desktop-verfuegbarkeit", DESK, "#analyse/verfuegbarkeit", []),
    ("desktop-nutzung", DESK, "#analyse/nutzung", []),
    ("desktop-stroeme", DESK, "#analyse/stroeme", []),
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
            page.goto(f"http://127.0.0.1:8765/{hash_}")
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
