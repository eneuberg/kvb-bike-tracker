"""Screenshot the app at phone and desktop sizes.

    python tools/screenshots.py SITE_DIR_OR_URL OUT_DIR [--readme]

SITE_DIR is served locally (CI previews); a URL is used as is. --readme takes
only the few images used in the README (docs/screenshots/).
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
MORE_OPEN = "() => document.querySelector('.more-toggle').click()"
PLAY = "() => { const T = window.__app.tl; if (T) { window.__ui.setFrame(Math.max(T.i0, T.t.length - 6)); window.__ui.startPlay(); } }"
AVAIL = "() => window.__ui.setLayer('avail', true)"
FREQ = """() => { const b = document.querySelector('[data-set=\"color\"] [data-v=\"freq\"]'); b && b.click(); }"""
TRIP = """() => { const A = window.__app; const t = A.trips && A.trips.filter((x) => x.e <= A.k.clock).pop(); if (t) window.__ui.openTrip({ k: t.k }); }"""
PREP = "() => { localStorage.removeItem('kvb-ui-v1'); localStorage.removeItem('kvb-ui-v2'); localStorage.removeItem('kvb-panel-v1'); }"
WIN3H = """() => { const b = document.querySelector('[data-set=\"win\"] [data-v=\"180\"]'); b && b.click(); }"""
FULL = "() => window.__ui.setSheet('full')"
WAIT = "() => new Promise((r) => setTimeout(r, 3000))"

SHOTS = [
    ("phone-karte", PHONE, "", []),
    ("phone-station", PHONE, "", [PICK_STATION]),
    ("phone-rueckblick", PHONE, "", [MID_FRAME, WAIT]),
    ("phone-haeufigkeit", PHONE, "", [MID_FRAME, FREQ, WAIT]),
    ("phone-fahrt-profil", PHONE, "", [MID_FRAME, WAIT, TRIP, WAIT]),
    ("phone-verfuegbarkeit", PHONE, "", [AVAIL, WAIT]),
    ("phone-verfuegbarkeit-punkt", PHONE, "", [AVAIL, WAIT, POINT]),
    ("phone-einstellungen", PHONE, "", [MORE_OPEN]),
    ("phone-dark-karte", {**PHONE, "color_scheme": "dark"}, "", [MID_FRAME, WAIT]),
    ("desktop-karte", DESK, "", [PICK_STATION]),
    ("desktop-rueckblick", DESK, "", [MID_FRAME, WAIT]),
    ("desktop-dark-verfuegbarkeit", {**DESK, "color_scheme": "dark"}, "", [AVAIL, WAIT, POINT]),
]

README = [
    ("readme-desktop", {**DESK, "device_scale_factor": 2}, "", [WIN3H, WAIT]),
    ("readme-phone-karte", PHONE, "", [WIN3H, WAIT]),
    ("readme-phone-verfuegbarkeit", {**PHONE, "color_scheme": "dark"}, "", [AVAIL, WAIT, POINT]),
]


def main(site: str, out: str, readme: bool = False) -> int:
    out_dir = Path(out)
    out_dir.mkdir(parents=True, exist_ok=True)
    httpd = None
    if site.startswith("http"):
        base = site.rstrip("/") + "/"
    else:
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=site)
        httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 8765), handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = "http://127.0.0.1:8765/"
    errors = 0
    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
        for name, opts, hash_, actions in (README if readme else SHOTS):
            ctx = browser.new_context(**opts, locale="de-DE", timezone_id="Europe/Berlin")
            page = ctx.new_page()
            errs: list[str] = []
            page.on("pageerror", lambda e, errs=errs: errs.append(str(e)))
            page.on("console", lambda m, errs=errs: errs.append(m.text) if m.type == "error" else None)
            page.goto(base)
            page.evaluate(PREP)  # default settings
            page.goto(base + hash_)
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
    if httpd:
        httpd.shutdown()
    return 0


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    sys.exit(main(args[0], args[1], "--readme" in sys.argv))
