/* KVB-Rad Tracker.
   One view: a timeline (live at the right end) with layers for stations, free
   bikes, trips in a time window and an availability overlay. Analyses run in
   a web worker from the raw polls; routes are estimated there with A*.
   MapLibre GL renders on the GPU, so everything scales while zooming. */
'use strict';
(() => {
  // ================================================================ helpers
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const DARK = matchMedia('(prefers-color-scheme: dark)').matches;
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const isDesktop = () => matchMedia('(min-width: 820px)').matches;
  const TZ = 'Europe/Berlin';
  const nf = new Intl.NumberFormat('de-DE');
  const nf1 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });
  const fTime = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
  const fDate = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: TZ });
  const fDay = new Intl.DateTimeFormat('de-DE', { weekday: 'short', timeZone: TZ });
  const fDM = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', timeZone: TZ });
  const fHour = new Intl.DateTimeFormat('de-DE', { hour: 'numeric', hourCycle: 'h23', timeZone: TZ });
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const localHour = (t) => +fHour.formatToParts(new Date(t * 1000)).find((x) => x.type === 'hour').value % 24;
  const now = () => Date.now() / 1000;
  const hav = (a, b, c, d) => {
    const r = 6371000, p1 = (a * Math.PI) / 180, p2 = (c * Math.PI) / 180;
    const x = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(((d - b) * Math.PI) / 360) ** 2;
    return 2 * r * Math.asin(Math.sqrt(x));
  };
  const fmtDist = (m) => (m < 950 ? `${Math.round(m / 10) * 10} m` : `${nf1.format(m / 1000)} km`);
  const fmtDur = (s) => {
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))} Min.`;
    if (s < 86400 * 2) return `${nf1.format(s / 3600)} Std.`;
    return `${nf1.format(s / 86400)} Tage`;
  };
  const fmtWhen = (t) => `${fDate.format(new Date(t * 1000))}, ${fTime.format(new Date(t * 1000))} Uhr`;
  const minToStr = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  async function getJSON(url, v) {
    const r = await fetch(`${url}?v=${encodeURIComponent(v ?? Math.floor(Date.now() / 60000))}`);
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return r.json();
  }
  let toastTimer;
  function toast(msg, ms = 3800) {
    const el = $('#toast');
    el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  // ================================================================ colours
  const C = {
    station: css('--station'), stText: css('--station-text'), free: css('--free'), ink: css('--ink'), surface: css('--surface'),
    wd: css('--wd'), we: css('--we'), muted: css('--muted'), trip: css('--trip'),
    tStart: css('--t-start'), tEnd: css('--t-end'), dur: ['--d0', '--d1', '--d2', '--d3', '--d4'].map(css),
  };
  const R = DARK ? {
    seq: ['#123056', '#1c5cab', '#3987e5', '#6da7ec'],
    heat: ['rgba(194,65,12,0)', '#7c2d12', '#c2410c', '#ea580c', '#fb923c'],
    red: ['#4a2326', '#8f2f2f', '#c53b3b', '#e66767'],
    blue: ['#1b3557', '#1c5cab', '#3987e5', '#86b6ef'],
    div: { neg: ['#e66767', '#a83a3a', '#5a2e2e'], mid: '#3a3f4a', pos: ['#2a4f80', '#3987e5', '#86b6ef'] },
    idle: ['#2f2580', '#4f3fbf', '#7a6cf0', '#a99ff5', '#d5cffb'],
    freq: ['#3d3470', '#5f4fc4', '#9484ee', '#e2dcff'],
  } : {
    seq: ['#cde2fb', '#86b6ef', '#3987e5', '#1c5cab'],
    heat: ['rgba(235,104,52,0)', '#fbd0b9', '#f59a6b', '#eb6834', '#b4380f'],
    red: ['#fde2e1', '#f6a3a2', '#e34948', '#9e2525'],
    blue: ['#cde2fb', '#86b6ef', '#2a78d6', '#184f95'],
    div: { neg: ['#e34948', '#ee8a89', '#f6c3c2'], mid: '#e6e3de', pos: ['#b7d3f6', '#6da7ec', '#2a78d6'] },
    idle: ['#d5cffb', '#a99ff5', '#7a6cf0', '#5240d0', '#2f2580'],
    freq: ['#cbc3f3', '#9583e6', '#5b41cf', '#26176e'],
  };
  const gradient = (cols) => `linear-gradient(90deg, ${cols.join(', ')})`;
  // stepped scale for Erreichbarkeit: near = indigo ... far = red. Checked for
  // colour-vision deficiency (adjacent steps stay apart in light and dark mode).
  const STEPS = ['#30219a', '#2a6fd6', '#17b2a6', '#f0cf3c', '#f28a2a', '#c42b4a'];
  const rgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const DIST_CLASSES = [[75, '75 m', '1'], [150, '150 m', '2'], [250, '250 m', '3'], [400, '400 m', '5'], [700, '700 m', '9'], [1200, '1,2 km', '15']];
  const PROB_CLASSES = [[20, '< 20 %'], [40, '20–40'], [60, '40–60'], [80, '60–80'], [95, '80–95'], [100, '≥ 95 %']];
  const distClasses = () => DIST_CLASSES.map(([up], k) => [up, ...rgb(STEPS[k]), 0.82 - k * 0.06]);
  const probClasses = () => PROB_CLASSES.map(([up], k) => [up, ...rgb(STEPS[5 - k]), 0.52 + k * 0.06]);
  function stepLegend(colors, labels, sub) {
    return `<div class="steps">${colors.map((c, k) => `<div><i style="background:${c}"></i><span>${labels[k]}</span>${sub ? `<small>${sub[k]}</small>` : ''}</div>`).join('')}</div>`;
  }
  function hexA(hex, a) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  const toStops = (cols, a0, a1) => cols.map((c, k) => {
    const n = parseInt(c.slice(1), 16), f = k / (cols.length - 1);
    return [f, (n >> 16) & 255, (n >> 8) & 255, n & 255, a0 + (a1 - a0) * f];
  });
  const rasterCv = document.createElement('canvas');
  const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

  // ================================================================ state
  const UI_KEY = 'kvb-ui-v2'; // v2: new defaults (radius 100 m, 30 days, own time of day for availability)
  const DEFAULT_O = { win: 60, color: 'dir', away: true, metric: 'prob', R: 100, res: 25, days: 30, tod: 30, wd: 'all',
    minGone: 100, jump: 300, maxDurH: 4, maxKmh: 200 };
  function loadO() {
    try { const o = JSON.parse(localStorage.getItem(UI_KEY) || 'null'); if (o && typeof o === 'object') return { ...DEFAULT_O, ...o }; } catch { /* ignore */ }
    return { ...DEFAULT_O };
  }
  const saveO = () => { try { localStorage.setItem(UI_KEY, JSON.stringify(S.o)); } catch { /* ignore */ } };
  const S = {
    mode: 'karte', cfg: null, o: loadO(),
    live: null, tl: null, trips: null, away: [], me: null, sel: null, hist: null, hp: { h: 24, from: null, to: null },
    k: { span: 24, end: null, isLive: true, frame: -1, clock: 0, playing: false, speed: 1, liveInuse: null },
    layers: { stations: true, free: true, trips: true, avail: true },
  };
  const tripParams = () => ({ minGone: S.o.minGone, jump: S.o.jump, maxDur: S.o.maxDurH * 3600, maxKmh: S.o.maxKmh });

  // ================================================================ map
  let map, styleReady = false, hasGlyphs = false;
  const KOELN = [[6.77, 50.83], [7.16, 51.08]];
  const EMPTY = { type: 'FeatureCollection', features: [] };

  function rasterStyle(cfg) {
    const url = cfg.raster_url || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
    return {
      version: 8,
      sources: { base: { type: 'raster', tiles: [url], tileSize: 256, maxzoom: 19, attribution: cfg.raster_attribution || '© OpenStreetMap contributors' } },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': css('--bg') } },
        { id: 'base', type: 'raster', source: 'base', paint: DARK
          ? { 'raster-brightness-min': 0.92, 'raster-brightness-max': 0.08, 'raster-saturation': -0.7 }
          : { 'raster-saturation': -0.55, 'raster-contrast': -0.1 } },
      ],
    };
  }

  function initMap(cfg) {
    const attempts = [DARK ? cfg.style_dark : cfg.style_light, cfg.style_light, rasterStyle(cfg)].filter(Boolean);
    let attempt = 0, timer;
    map = new maplibregl.Map({
      container: 'map', style: attempts[0], bounds: KOELN, fitBoundsOptions: { padding: 20 },
      minZoom: 9, maxZoom: 19, attributionControl: false, dragRotate: false, pitchWithRotate: false,
      touchPitch: false, maxBounds: [[6.2, 50.55], [7.7, 51.35]], fadeDuration: 0,
    });
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    map.addControl(new maplibregl.AttributionControl({ compact: true }), isDesktop() ? 'bottom-right' : 'top-left');
    const next = () => {
      if (styleReady || attempt >= attempts.length - 1) return;
      attempt += 1; map.setStyle(attempts[attempt]); arm();
    };
    const arm = () => { clearTimeout(timer); timer = setTimeout(next, 9000); };
    arm();
    map.on('error', (e) => { if (!styleReady) { console.warn('style failed, falling back', e.error); next(); } });
    map.on('style.load', () => {
      clearTimeout(timer);
      if (styleReady) return;
      styleReady = true;
      hasGlyphs = !!map.getStyle().glyphs;
      germanLabels();
      map.once('idle', () => $('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'));
      setupLayers();
      boot();
    });
  }

  function germanLabels() {
    for (const l of map.getStyle().layers) {
      if (l.type !== 'symbol') continue;
      const tf = map.getLayoutProperty(l.id, 'text-field');
      if (!tf) continue;
      const str = JSON.stringify(tf);
      if (!/name/.test(str) || /ref|housenumber/.test(str)) continue;
      map.setLayoutProperty(l.id, 'text-field', ['coalesce', ['get', 'name:de'], ['get', 'name']]);
    }
  }

  const zoomRadius = (z10, z14, z18) => ['interpolate', ['exponential', 1.6], ['zoom'], 10, z10, 14, z14, 18, z18];
  const lineW = (a, b) => ['interpolate', ['linear'], ['zoom'], 10, a, 16, b];
  const dirGradient = ['interpolate', ['linear'], ['line-progress'], 0, C.tStart, 1, C.tEnd];

  function setupLayers() {
    const before = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
    // small tile buffers: less data to cut and ship to the GPU on every update
    for (const id of ['bikes', 'stations', 'tripdots'])
      map.addSource(id, { type: 'geojson', data: EMPTY, buffer: 32 });
    for (const id of ['sel', 'me', 'qpt'])
      map.addSource(id, { type: 'geojson', data: EMPTY });
    map.addSource('trips', { type: 'geojson', data: EMPTY, tolerance: 0.6, buffer: 64 });
    map.addSource('hist', { type: 'geojson', data: EMPTY, lineMetrics: true });
    map.addSource('raster', { type: 'image', url: PIXEL, coordinates: [[6.76, 51.09], [7.18, 51.09], [7.18, 50.83], [6.76, 50.83]] });

    // under the basemap labels
    map.addLayer({ id: 'raster-l', type: 'raster', source: 'raster', layout: { visibility: 'none' },
      paint: { 'raster-resampling': 'linear', 'raster-opacity': 0.9, 'raster-fade-duration': 0 } }, before);
    map.addLayer({ id: 'qpt-fill', type: 'fill', source: 'qpt', filter: ['==', ['geometry-type'], 'Polygon'], layout: { visibility: 'none' },
      paint: { 'fill-color': hexA(C.ink, 0.06) } }, before);

    // trips under everything else: one line per street section, thicker = more trips
    map.addLayer({ id: 'trips-glow', type: 'line', source: 'trips', filter: ['>=', ['get', 'w'], 7], layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-width': ['interpolate', ['linear'], ['zoom'], 10, ['*', 2.2, ['get', 'w']], 16, ['*', 5, ['get', 'w']]],
        'line-blur': ['interpolate', ['linear'], ['zoom'], 10, 4, 16, 10], 'line-color': ['to-color', ['get', 'col']],
        'line-opacity': ['interpolate', ['linear'], ['get', 'w'], 7, DARK ? 0.1 : 0.06, 8, DARK ? 0.2 : 0.12] } });
    map.addLayer({ id: 'trips-line', type: 'line', source: 'trips', layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'w'] },
      paint: { 'line-width': ['interpolate', ['linear'], ['zoom'], 10, ['+', 0.9, ['*', 0.5, ['get', 'w']]], 13, ['+', 1.4, ['*', 0.95, ['get', 'w']]], 16, ['+', 2, ['*', 1.7, ['get', 'w']]]],
        'line-color': ['to-color', ['get', 'col']],
        // few trips: see-through, many: solid
        'line-opacity': ['interpolate', ['linear'], ['get', 'w'], 0, 0.42, W_CLS - 1, 1] } });
    map.addLayer({ id: 'trips-pt', type: 'circle', source: 'tripdots', layout: { visibility: 'none' },
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, ['*', ['get', 'r'], 0.5], 16, ['get', 'r']],
        'circle-color': ['to-color', ['get', 'fill']], 'circle-stroke-color': ['to-color', ['get', 'stroke']], 'circle-stroke-width': ['get', 'sw'],
        'circle-opacity': ['get', 'op'], 'circle-stroke-opacity': ['get', 'op'] } });

    // parked bikes: neutral, so colour stays free for movement
    map.addLayer({ id: 'free-dots', type: 'circle', source: 'bikes', filter: ['==', ['get', 'k'], 0],
      paint: { 'circle-radius': zoomRadius(1.6, 3.8, 8.5), 'circle-color': C.free,
        'circle-stroke-color': C.surface, 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 11, 0.3, 15, 1.2] } });
    const stR = (base, k) => ['+', base, ['*', k, ['sqrt', ['get', 'n']]]];
    map.addLayer({ id: 'stations-c', type: 'circle', source: 'stations',
      // area grows with the number of bikes: 10 bikes ~ 60 % larger radius than 1
      paint: { 'circle-radius': ['interpolate', ['exponential', 1.6], ['zoom'], 10, stR(2.2, 0.75), 14, stR(6, 2.4), 18, stR(11, 4)],
        'circle-color': ['case', ['==', ['get', 'n'], 0], C.surface, C.station],
        'circle-stroke-color': ['case', ['==', ['get', 'n'], 0], C.station, C.surface],
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 0.8, 15, 2] } });
    if (hasGlyphs) {
      map.addLayer({ id: 'stations-t', type: 'symbol', source: 'stations', minzoom: 12.6,
        layout: { 'text-field': ['to-string', ['get', 'n']], 'text-font': ['Noto Sans Bold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 12.6, 9.5, 16, 13], 'text-allow-overlap': true, 'text-ignore-placement': true },
        paint: { 'text-color': ['case', ['==', ['get', 'n'], 0], C.station, C.stText] } });
    }

    // one bike's or one station's history
    const hk = (k) => ['==', ['get', 'kind'], k];
    const hop = (on, off, base) => ['case', ['==', ['get', 'hi'], 1], on, ['==', ['get', 'dim'], 1], off, base];
    map.addLayer({ id: 'hist-shift', type: 'line', source: 'hist', filter: hk('shift'), layout: { visibility: 'none', 'line-cap': 'round' },
      paint: { 'line-color': C.muted, 'line-width': 1.4, 'line-dasharray': [1, 1.5] } });
    map.addLayer({ id: 'hist-route', type: 'line', source: 'hist', filter: ['any', hk('route'), hk('air')],
      layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-gradient': dirGradient, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, hop(3.4, 1.6, 2.2), 16, hop(6.5, 3, 4.4)], 'line-opacity': hop(1, 0.3, 0.9) } });
    map.addLayer({ id: 'hist-snap', type: 'circle', source: 'hist', filter: hk('snap'), layout: { visibility: 'none' },
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 1.4, 17, 3], 'circle-color': C.ink, 'circle-opacity': 0.45 } });
    map.addLayer({ id: 'hist-stay', type: 'circle', source: 'hist', filter: hk('stay'), layout: { visibility: 'none' },
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, ['+', 3, ['get', 'r']], 16, ['+', 6, ['*', 1.6, ['get', 'r']]]],
        'circle-color': ['case', ['==', ['get', 'st'], 1], C.station, C.free],
        'circle-stroke-color': ['case', ['==', ['get', 'hi'], 1], C.ink, C.surface], 'circle-stroke-width': ['case', ['==', ['get', 'hi'], 1], 3, 1.6],
        'circle-opacity': ['case', ['==', ['get', 'dim'], 1], 0.35, 1] } });
    map.addLayer({ id: 'hist-stop', type: 'circle', source: 'hist', filter: ['any', hk('ts'), hk('te')], layout: { visibility: 'none' },
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 3, 16, 6], 'circle-color': ['case', hk('ts'), C.tStart, C.tEnd],
        'circle-stroke-color': C.surface, 'circle-stroke-width': 1.6, 'circle-opacity': hop(1, 0.3, 1), 'circle-stroke-opacity': hop(1, 0.3, 1) } });

    map.addLayer({ id: 'qpt-line', type: 'line', source: 'qpt', filter: ['==', ['geometry-type'], 'Polygon'], layout: { visibility: 'none' },
      paint: { 'line-color': C.ink, 'line-width': 1.6, 'line-dasharray': [2, 2] } });
    map.addLayer({ id: 'qpt-dot', type: 'circle', source: 'qpt', filter: ['==', ['geometry-type'], 'Point'], layout: { visibility: 'none' },
      paint: { 'circle-radius': 6, 'circle-color': C.ink, 'circle-stroke-color': C.surface, 'circle-stroke-width': 2.5 } });
    map.addLayer({ id: 'sel-ring', type: 'circle', source: 'sel',
      paint: { 'circle-radius': zoomRadius(9, 15, 24), 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': C.ink, 'circle-stroke-width': 2.5 } });
    map.addLayer({ id: 'me-acc', type: 'circle', source: 'me', paint: { 'circle-radius': zoomRadius(10, 18, 30), 'circle-color': hexA(C.tEnd, 0.15) } });
    map.addLayer({ id: 'me-dot', type: 'circle', source: 'me', paint: { 'circle-radius': 6.5, 'circle-color': C.tEnd, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2.5 } });

    map.on('click', onMapClick);
    map.on('moveend', () => { if (S.layers.avail && S.o.res < 25) scheduleOverlay(400); });
    if (matchMedia('(hover: hover)').matches) {
      let raf = 0;
      map.on('mousemove', (e) => {
        if (raf || map.isMoving()) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          map.getCanvas().style.cursor = pick(e.point) ? 'pointer' : S.layers.avail ? 'crosshair' : '';
        });
      });
    }
  }

  const setData = (id, data) => map?.getSource(id)?.setData(data);
  const vis = (id, on) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  const isVis = (id) => map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none';

  function applyVisibility() {
    if (!styleReady) return;
    const L = S.layers, h = !!S.hist;
    vis('stations-c', L.stations); vis('stations-t', L.stations);
    vis('free-dots', L.free);
    // while one bike's or station's history is open, everything else steps back
    vis('trips-line', L.trips && !h); vis('trips-glow', L.trips && !h);
    vis('trips-pt', L.trips && !h);
    map.setPaintProperty('free-dots', 'circle-opacity', h ? 0.25 : 1); map.setPaintProperty('free-dots', 'circle-stroke-opacity', h ? 0.25 : 1);
    map.setPaintProperty('stations-c', 'circle-opacity', h ? 0.3 : 1); map.setPaintProperty('stations-c', 'circle-stroke-opacity', h ? 0.3 : 1);
    if (map.getLayer('stations-t')) map.setPaintProperty('stations-t', 'text-opacity', h ? 0.3 : 1);
    for (const id of ['hist-shift', 'hist-route', 'hist-snap', 'hist-stay', 'hist-stop']) vis(id, h);
    vis('raster-l', L.avail);
    // with trips on top, the availability colours step back so the lines stay readable
    if (map.getLayer('raster-l')) map.setPaintProperty('raster-l', 'raster-opacity', L.trips && !h ? 0.5 : 0.9);
    const q = L.avail && S.sel?.type === 'point';
    vis('qpt-fill', q); vis('qpt-line', q); vis('qpt-dot', q);
  }

  // ================================================================ picking
  // Trip lines and dots are a few huge Multi* features; asking the map for them
  // is slow, so they are matched in JS (tripsAt) instead.
  const PRIORITY = ['hist-stop', 'hist-stay', 'hist-route', 'stations-c', 'free-dots'];
  function pick(pt) {
    const r = isDesktop() ? 6 : 14;
    const layers = PRIORITY.filter(isVis);
    const fs = layers.length ? map.queryRenderedFeatures([[pt.x - r, pt.y - r], [pt.x + r, pt.y + r]], { layers }) : [];
    const rank = (f) => PRIORITY.indexOf(f.layer.id);
    const dist = (f) => { if (f.geometry.type !== 'Point') return 0; const p = map.project(f.geometry.coordinates); return Math.hypot(p.x - pt.x, p.y - pt.y); };
    fs.sort((a, b) => rank(a) - rank(b) || dist(a) - dist(b));
    const top = fs[0];
    if (top && top.layer.id.startsWith('hist')) return top;
    // a trip endpoint or line beats a station only when it is closer than the station's dot
    if (isVis('trips-line') || isVis('trips-pt')) {
      const near = top && top.geometry.type === 'Point' ? dist(top) : Infinity;
      if (near > 4 && (drawn.length || drawn.away?.length)) {
        const hit = tripsAt(map.unproject(pt), Math.min(r, near));
        if (hit.ks.length || hit.away.length) return { layer: { id: 'trips-line' }, properties: {} };
      }
    }
    return top || null;
  }

  function onMapClick(e) {
    const f = pick(e.point);
    if (!f) {
      if (S.layers.avail) pointQuery(e.lngLat.lng, e.lngLat.lat);
      else closeDetail();
      return;
    }
    const p = f.properties;
    switch (f.layer.id) {
      case 'stations-c': S.k.isLive ? showStation(p.uid) : showTlStation(p.i); break;
      case 'free-dots': S.k.isLive ? showBike(p.id) : showTlBike(p.i); break;
      case 'trips-pt': case 'trips-line': {
        const { ks, away } = tripsNear(e.point);
        if (ks.length > 1) showTripPicker(ks);
        else if (ks.length) openTrip({ k: ks[0] });
        else if (away.length) showBikeHistory(away[0].bike, { away: away[0] });
        else closeDetail();
        break;
      }
      case 'hist-stay': case 'hist-route': case 'hist-stop': histFocus(+p.n); break;
      default:
    }
  }

  function select(geom) { setData('sel', geom ? { type: 'Feature', geometry: geom, properties: {} } : EMPTY); }
  function flyTo(lnglat, zoom) {
    map.easeTo({ center: lnglat, zoom: Math.max(map.getZoom(), zoom ?? 14.5), duration: REDUCED ? 0 : 600,
      padding: mapPad(0) });
  }

  // ================================================================ panel
  // Phones: a bottom sheet that stays where you let go, from just the header
  // ("mini") up to full height; a flick snaps to the next stop.
  // Desktop: a floating window, dragged by its header, resized at the corner,
  // collapsible; position and size are remembered.
  const panel = $('#panel');
  const PANEL_KEY = 'kvb-panel-v1';
  let sheetState = 'peek', freeY = null;
  function peekHeight() {
    const peek = $('.peek');
    return $('#grab').offsetHeight + $('#head').offsetHeight + (peek ? peek.offsetHeight : 0) + 4;
  }
  const miniHeight = () => $('#grab').offsetHeight + $('#head').offsetHeight + 2;
  function sheetY(state) {
    const H = panel.offsetHeight;
    if (state === 'free' && freeY != null) return Math.min(Math.max(0, freeY), H - miniHeight());
    if (state === 'full') return 0;
    if (state === 'mini') return Math.max(0, H - miniHeight());
    if (state === 'half') return Math.max(0, H - Math.max(window.innerHeight * 0.62, peekHeight() + 160));
    return Math.max(0, H - peekHeight());
  }
  function setSheet(state) {
    if (isDesktop()) return;
    sheetState = state;
    panel.dataset.sheet = state === 'free' ? (freeY < sheetY('peek') - 20 ? 'half' : 'peek') : state;
    panel.style.setProperty('--sheet-y', `${sheetY(state)}px`);
    $$('.more-toggle').forEach((b) => b.setAttribute('aria-expanded', String(state !== 'peek' && state !== 'mini')));
    $('#btnCollapse')?.setAttribute('aria-expanded', String(state !== 'mini'));
  }
  function sheetVisibleHeight() {
    if (isDesktop()) return 0;
    const y = parseFloat(panel.style.getPropertyValue('--sheet-y')) || 0;
    return panel.offsetHeight - y;
  }
  // map padding so content is not hidden behind the panel
  function mapPad(m) {
    if (!isDesktop()) return { top: m + 50, left: m, right: m, bottom: sheetVisibleHeight() + m };
    const r = panel.getBoundingClientRect(), W = innerWidth;
    const pad = { top: m, left: m, right: m, bottom: m };
    if (r.left + r.width / 2 < W / 2) pad.left = Math.min(W * 0.6, r.right + m); else pad.right = Math.min(W * 0.6, W - r.left + m);
    return pad;
  }
  function initSheet() {
    let startY = 0, startOff = 0, dragging = false, moved = false, lastY = 0, lastT = 0, vel = 0;
    const down = (e) => {
      if (isDesktop() || e.target.closest('button, input, a, select')) return;
      dragging = true; moved = false; startY = lastY = e.clientY; lastT = performance.now();
      startOff = sheetY(sheetState);
      panel.classList.add('dragging');
      e.currentTarget.setPointerCapture(e.pointerId);
    };
    const move = (e) => {
      if (!dragging) return;
      const dy = e.clientY - startY;
      if (Math.abs(dy) > 4) moved = true;
      const t = performance.now();
      vel = (e.clientY - lastY) / Math.max(1, t - lastT); lastY = e.clientY; lastT = t;
      panel.style.setProperty('--sheet-y', `${Math.min(Math.max(0, startOff + dy), sheetY('mini'))}px`);
    };
    const up = () => {
      if (!dragging) return;
      dragging = false; panel.classList.remove('dragging');
      if (!moved) { setSheet(sheetState === 'mini' ? 'peek' : 'mini'); return; }
      const y = parseFloat(panel.style.getPropertyValue('--sheet-y'));
      if (Math.abs(vel) > 0.8) { // a flick: snap to the next stop in that direction
        const stops = ['full', 'half', 'peek', 'mini'].map((st) => ({ st, y: sheetY(st) }));
        const cand = vel > 0 ? stops.filter((x) => x.y > y + 1).sort((a, b) => a.y - b.y)[0] : stops.filter((x) => x.y < y - 1).sort((a, b) => b.y - a.y)[0];
        if (cand) { setSheet(cand.st); return; }
      }
      freeY = y; setSheet('free'); // stays where you let go
    };
    for (const el of [$('#grab'), $('#head')]) {
      el.addEventListener('pointerdown', down); el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    }
    initWindow();
    addEventListener('resize', () => { setSheet(sheetState); placeWindow(); });
    document.fonts?.ready.then(() => setSheet(sheetState));
    setSheet('peek');
  }

  // ---- desktop window
  let win = null;
  function loadWin() { try { return JSON.parse(localStorage.getItem(PANEL_KEY) || 'null'); } catch { return null; } }
  function saveWin() { try { localStorage.setItem(PANEL_KEY, JSON.stringify(win)); } catch { /* ignore */ } }
  function placeWindow() {
    if (!isDesktop()) { panel.style.left = panel.style.top = panel.style.width = panel.style.height = ''; return; }
    if (!win) return;
    const W = innerWidth, H = innerHeight;
    win.w = Math.min(Math.max(320, win.w), W - 16);
    win.h = Math.min(Math.max(220, win.h), H - 16);
    win.x = Math.min(Math.max(8, win.x), W - 120);
    win.y = Math.min(Math.max(8, win.y), H - 56);
    panel.style.left = `${win.x}px`; panel.style.top = `${win.y}px`;
    panel.style.width = `${win.w}px`;
    panel.style.height = win.collapsed ? '' : `${Math.min(win.h, H - win.y - 8)}px`;
    panel.classList.toggle('collapsed', !!win.collapsed);
    $('#btnCollapse')?.setAttribute('aria-expanded', String(!win.collapsed));
  }
  function initWindow() {
    win = loadWin() || { x: 16, y: 16, w: 408, h: innerHeight - 32, collapsed: false };
    placeWindow();
    // drag by the header
    let drag = null;
    $('#head').addEventListener('pointerdown', (e) => {
      if (!isDesktop() || e.button > 0 || e.target.closest('button, a, input')) return;
      drag = { dx: e.clientX - win.x, dy: e.clientY - win.y, id: e.pointerId };
      $('#head').setPointerCapture(e.pointerId); panel.classList.add('moving'); e.preventDefault();
    });
    $('#head').addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      win.x = e.clientX - drag.dx; win.y = e.clientY - drag.dy; placeWindow();
    });
    const end = () => { if (!drag) return; drag = null; panel.classList.remove('moving'); saveWin(); };
    $('#head').addEventListener('pointerup', end); $('#head').addEventListener('pointercancel', end);
    // resize at the corner
    let rs = null;
    $('#resize').addEventListener('pointerdown', (e) => {
      if (!isDesktop()) return;
      rs = { x: e.clientX, y: e.clientY, w: win.w, h: win.h, id: e.pointerId };
      $('#resize').setPointerCapture(e.pointerId); panel.classList.add('moving'); e.preventDefault();
    });
    $('#resize').addEventListener('pointermove', (e) => {
      if (!rs || e.pointerId !== rs.id) return;
      win.w = rs.w + e.clientX - rs.x; win.h = rs.h + e.clientY - rs.y; win.collapsed = false; placeWindow();
    });
    const rend = () => { if (!rs) return; rs = null; panel.classList.remove('moving'); saveWin(); };
    $('#resize').addEventListener('pointerup', rend); $('#resize').addEventListener('pointercancel', rend);
    $('#head').addEventListener('dblclick', (e) => { if (isDesktop() && !e.target.closest('button')) toggleCollapse(); });
    $('#btnCollapse').addEventListener('click', toggleCollapse);
  }
  function toggleCollapse() {
    if (isDesktop()) { win.collapsed = !win.collapsed; placeWindow(); saveWin(); }
    else setSheet(sheetState === 'mini' ? 'peek' : 'mini');
  }
  const refreshSheet = () => requestAnimationFrame(() => setSheet(sheetState));

  function updateStatus() {
    const el = $('#status'), txt = $('#statusText');
    el.classList.remove('stale', 'past');
    if (S.mode === 'karte' && !S.k.isLive && S.tl) {
      el.classList.add('past');
      txt.textContent = 'Rückblick, nicht live';
      return;
    }
    if (!S.live) { txt.textContent = 'lädt …'; return; }
    const old = now() - S.live.t > 40 * 60;
    if (old) el.classList.add('stale');
    txt.textContent = `${old ? 'Veraltet' : 'Stand'} ${fTime.format(new Date(S.live.t * 1000))}, vor ${fmtDur(Math.max(0, now() - S.live.t))}`;
    renderFresh();
  }

  // ================================================================ live data
  async function loadLive(silent) {
    try { S.live = await getJSON('latest.json'); } catch {
      if (!silent) toast('Live-Daten konnten nicht geladen werden. Neuer Versuch in einer Minute.');
      setTimeout(() => loadLive(true), 60000);
      return;
    }
    const L = S.live;
    L.t = Date.parse(L.meta.ts) / 1000;
    L.byId = new Map(L.bikes.map((b) => [b.bike, b]));
    L.stById = new Map(L.stations.map((s, i) => [String(s.uid), { ...s, i }]));
    L.docked = new Map();
    for (const b of L.bikes) if (b.kind === 'station') {
      const k = String(b.place_uid);
      if (!L.docked.has(k)) L.docked.set(k, []);
      L.docked.get(k).push(b);
    }
    if (S.k.isLive) renderKarte(true);
    updateStatus(); renderFresh();
  }

  // ================================================================ freshness: poll a tiny status file
  // status.json = { ts: time of the latest poll, app: version of the web app }.
  // New ts -> reload live data and the changed history days, re-render.
  // New app -> the pill offers a reload (and does it when you come back to the tab).
  const FR = { busy: false, polling: false, last: 0, app: null, newApp: false, st: null, lockUntil: 0, autoTimer: 0, tick: 0 };
  const clock = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
  const serverMode = () => FR.st?.mode === 'server' && FR.st.manual_s > 0;
  // seconds until a manual poll is allowed again (0 = now); the server has the final word
  function manualWait() {
    if (!serverMode() || !S.live) return 0;
    // +2 s: the data time is rounded down to the second
    return Math.max(0, Math.ceil(S.live.t + FR.st.manual_s + 2 - now()), Math.ceil(FR.lockUntil - now()));
  }
  function renderFresh() {
    const el = $('#fresh'); if (!el) return;
    const L = S.live, stale = !!L && now() - L.t > 40 * 60;
    el.classList.toggle('busy', FR.busy || FR.polling);
    el.classList.toggle('stale', stale && !FR.newApp);
    el.classList.toggle('newapp', FR.newApp);
    el.classList.toggle('locked', serverMode() && manualWait() > 0);
    $('#freshText').textContent = FR.newApp ? 'Neue Version' : L ? `${fTime.format(new Date(L.t * 1000))} · vor ${fmtDur(Math.max(0, now() - L.t))}` : 'lädt …';
    el.setAttribute('aria-label', L ? `Datenstand ${fmtWhen(L.t)}. Details und neu abfragen.` : 'Daten werden geladen');
    if (!$('#freshPop').hidden) renderPop();
  }
  function renderPop() {
    const L = S.live, st = FR.st, auto = st?.auto_s || 900;
    $('#fpTime').textContent = L ? `Stand ${fTime.format(new Date(L.t * 1000))}` : 'lädt …';
    $('#fpAge').textContent = L ? `vor ${fmtDur(Math.max(0, now() - L.t))}` : '';
    const btn = $('#fpBtn'), next = L ? L.t + auto : null, hint = $('#fpHint');
    if (serverMode()) {
      const due = next != null && next - now() > 45 ? `etwa ${fTime.format(new Date(next * 1000))}` : 'gleich';
      $('#fpAuto').textContent = `Automatisch etwa alle ${Math.round(auto / 60)} Min. · nächste ${due}`;
      const w = manualWait(), m = Math.max(1, Math.round(st.manual_s / 60));
      btn.disabled = FR.polling || w > 0;
      btn.textContent = FR.polling ? 'Fragt ab …' : w > 0 ? `Wieder in ${clock(w)}` : 'Jetzt abfragen';
      hint.textContent = `Für alle zusammen höchstens alle ${m} Min.`;
      hint.hidden = false;
    } else {
      $('#fpAuto').textContent = `Automatisch ca. alle ${Math.round(auto / 60)} Min. (GitHub, mit Lücken)`;
      btn.disabled = FR.busy;
      btn.textContent = FR.busy ? 'Prüft …' : 'Auf neue Daten prüfen';
      hint.hidden = true;
    }
    $('#fpNew').hidden = !FR.newApp;
  }
  function openPop(open) {
    const pop = $('#freshPop');
    pop.hidden = !open;
    $('#fresh').setAttribute('aria-expanded', String(open));
    clearInterval(FR.tick);
    if (open) { renderPop(); FR.tick = setInterval(renderPop, 1000); if (now() - FR.last > 20) checkUpdate(false); }
  }
  // in server mode, look again right after the next automatic poll is due
  function scheduleAutoCheck() {
    clearTimeout(FR.autoTimer);
    if (!S.live || !FR.st) return;
    const at = S.live.t + (FR.st.auto_s || 900) + 25 - now();
    if (at > 0 && at < 3 * 3600) FR.autoTimer = setTimeout(() => { if (document.visibilityState === 'visible') checkUpdate(false); }, at * 1000);
  }
  async function manualRefresh() {
    if (!serverMode()) { await checkUpdate(true); return; }
    if (manualWait() > 0 || FR.polling) return;
    FR.polling = true; renderFresh();
    const before = S.live?.meta?.ts;
    try {
      const r = await fetch('api/refresh', { method: 'POST' });
      const b = await r.json().catch(() => ({}));
      if (r.status === 429) { FR.lockUntil = now() + (b.retry_after || 60); toast(`Wieder in ${clock(b.retry_after || 60)} möglich.`); }
      else if (r.status === 409) { toast('Läuft gerade …'); await new Promise((ok) => setTimeout(ok, 5000)); }
      else if (!r.ok) toast('nextbike antwortet gerade nicht.');
      await checkUpdate(false);
      if (r.ok && S.live?.meta?.ts !== before) toast(`Aktuell: ${fTime.format(new Date(S.live.t * 1000))}`);
    } catch { toast('Keine Verbindung.'); }
    finally { FR.polling = false; renderFresh(); }
  }
  async function refreshHistory() {
    const old = new Map((tlIndex || []).map((d) => [d.date, `${d.n}|${d.t1}`]));
    let idx;
    try { idx = await ensureIndex(true); } catch { return false; }
    const changed = idx.filter((d) => old.get(d.date) !== `${d.n}|${d.t1}`).map((d) => d.date);
    if (!changed.length) return false;
    if (worker) await rpc('invalidate', { dates: changed });
    if (S.tl) S.tl.loaded = 0; // next timeline request reloads
    if (S.k.isLive || !S.tl) await reloadTimeline();
    if (S.layers.avail) computeOverlay(true);
    if (secOpen('secStats')) renderStats();
    return true;
  }
  async function checkUpdate(manual) {
    if (FR.busy) return;
    FR.busy = true; renderFresh();
    const before = S.live?.meta?.ts;
    try {
      let ts = null;
      try {
        const r = await fetch(`status.json?t=${Date.now()}`, { cache: 'no-store' });
        if (r.ok) {
          const st = await r.json();
          FR.st = st;
          ts = st.ts;
          if (FR.app == null) FR.app = S.cfg?.app || st.app;
          if (st.app && FR.app && st.app !== FR.app) FR.newApp = true;
        }
      } catch { /* older deploy without status.json */ }
      if (ts == null || ts !== before) await loadLive(true);
      const fresh = S.live?.meta?.ts !== before;
      const hist = fresh || manual ? await refreshHistory() : false;
      if (manual && S.live) toast(fresh || hist ? `Aktuell: ${fTime.format(new Date(S.live.t * 1000))}` : 'Noch keine neueren Daten.');
      FR.last = now();
      scheduleAutoCheck();
    } finally { FR.busy = false; renderFresh(); }
  }

  // ================================================================ history index + worker
  let tlIndex = null, tlIndexAt = 0, dataVer = '';
  async function ensureIndex(force) {
    if (tlIndex && !force && now() - tlIndexAt < 600) return tlIndex;
    const ix = await getJSON('tl/index.json', force ? Date.now() : undefined);
    tlIndex = ix.days;
    dataVer = String(ix.generated || '');
    tlIndexAt = now();
    return tlIndex;
  }
  const lastDate = () => tlIndex[tlIndex.length - 1].date;
  const firstDate = () => tlIndex[0].date;
  const addDays = (date, n) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const fmtD = (date) => `${date.slice(8, 10)}.${date.slice(5, 7)}.`;

  // Two workers from the same file: one for the history (availability,
  // statistics, profiles), one only for routing trips. Routing a few hundred
  // trips takes a second or two, and must not hold up the availability map.
  let rid = 0;
  const pending = new Map();
  const workers = {};
  function getWorker(name) {
    if (!workers[name]) {
      const w = workers[name] = new Worker(`worker.js?v=${S.cfg?.app || ''}`);
      w.onmessage = (e) => { const p = pending.get(e.data.id); pending.delete(e.data.id); if (p) (e.data.ok ? p.res(e.data.res) : p.rej(new Error(e.data.err))); };
      w.postMessage({ id: 0, op: 'init', args: { base: new URL('.', location.href).href, graph: S.cfg?.graph || '' } });
    }
    return workers[name];
  }
  const ROUTER_OPS = new Set(['routes', 'edges']);
  function rpc(op, args) {
    const w = getWorker(ROUTER_OPS.has(op) ? 'router' : 'main');
    return new Promise((res, rej) => { const id = ++rid; pending.set(id, { res, rej }); w.postMessage({ id, op, args, ver: dataVer }); });
  }

  // ================================================================ KARTE: one timeline, live at the right end
  const KEY = 12;
  let tlLoading = null;
  async function ensureTimeline() {
    const idx = await ensureIndex();
    const end = S.k.end && S.k.end <= lastDate() ? S.k.end : lastDate();
    const nDays = Math.ceil(S.k.span / 24) + 1;
    const dates = idx.map((d) => d.date).filter((d) => d <= end && d > addDays(end, -nDays - 1));
    const key = `${dates.join(',')}|${S.k.span}`;
    if (S.tl && S.tl.key === key && now() - S.tl.loaded < 600) return S.tl;
    if (tlLoading?.key === key) return tlLoading.p;
    const p = (async () => {
      const files = await Promise.all(dates.map((d) => getJSON(`tl/${d}.json`, dataVer || undefined)));
      const bIdx = new Map(), bikes = [], sIdx = new Map(), stations = [];
      const t = [], frames = [], gone = [], reset = [];
      for (const d of files) {
        const bm = d.bikes.map((id) => { let g = bIdx.get(id); if (g == null) { g = bikes.length; bIdx.set(id, g); bikes.push(id); } return g; });
        const sm = d.stations.map((s) => { let g = sIdx.get(s[0]); if (g == null) { g = stations.length; sIdx.set(s[0], g); stations.push(s); } return g; });
        d.t.forEach((tt, i) => {
          const f = d.frames[i], a = new Int32Array(f.length);
          for (let k = 0; k < f.length; k += 4) { a[k] = bm[f[k]]; a[k + 1] = f[k + 1]; a[k + 2] = f[k + 2]; a[k + 3] = f[k + 3] >= 0 ? sm[f[k + 3]] : -1; }
          t.push(tt); frames.push(a); gone.push(d.gone[i].map((b) => bm[b])); reset.push(i === 0);
        });
      }
      const tEnd = t[t.length - 1];
      const i0 = Math.max(0, t.findIndex((x) => x >= tEnd - S.k.span * 3600));
      const T = { key, dates, t, frames, gone, reset, bikes, stations, bikeIndex: bIdx, N: bikes.length, i0,
        lat0: files[0]?.lat0 ?? 50, lng0: files[0]?.lng0 ?? 6, scale: files[0]?.scale ?? 1e5, loaded: now(), inuse: null };
      const st = () => ({ p: new Uint8Array(T.N), la: new Int32Array(T.N), lo: new Int32Array(T.N), pl: new Int32Array(T.N).fill(-1) });
      T.apply = (s, i) => {
        if (T.reset[i]) s.p.fill(0);
        const f = T.frames[i];
        for (let k = 0; k < f.length; k += 4) { const b = f[k]; s.p[b] = 1; s.la[b] = f[k + 1]; s.lo[b] = f[k + 2]; s.pl[b] = f[k + 3]; }
        for (const b of T.gone[i]) s.p[b] = 0;
      };
      const s = st();
      T.keys = [];
      for (let i = 0; i < t.length; i++) { T.apply(s, i); if (i % KEY === 0) T.keys.push({ p: s.p.slice(), la: s.la.slice(), lo: s.lo.slice(), pl: s.pl.slice() }); }
      T.cur = { ...st(), i: -1 };
      return T;
    })();
    tlLoading = { key, p };
    try {
      const T = await p;
      S.tl = T;
      loadTrips(T);
      return T;
    } finally { tlLoading = null; }
  }

  // inferred trips for the loaded days (worker): moving dots + "unterwegs"
  async function loadTrips(T) {
    try {
      const r = await rpc('tripsList', { dates: T.dates, P: tripParams() });
      if (S.tl !== T) return;
      const TS = 11, tr = r.trips, n = tr.length / TS, list = [];
      const stName = (j) => (j >= 0 ? r.stations[j]?.[1] : null);
      for (let i = 0; i < n; i++) {
        const o = i * TS;
        list.push({ s: tr[o], e: tr[o + 1], a: [tr[o + 3], tr[o + 2]], b: [tr[o + 5], tr[o + 4]], d: tr[o + 6], short: !!tr[o + 7],
          bike: r.bikes[tr[o + 8]], from: stName(tr[o + 9]), to: stName(tr[o + 10]), route: undefined });
      }
      list.sort((x, y) => x.s - y.s);
      list.forEach((t, k) => { t.k = k; });
      S.trips = list;
      S.away = [];
      for (let i = 0; i + 4 < r.openNow.length; i += 5) {
        const o = r.openNow;
        S.away.push({ bike: r.bikes[o[i]], since: o[i + 1], a: [o[i + 3], o[i + 2]], from: stName(o[i + 4]) });
      }
      // average trips per second over the loaded polls (gaps over an hour left out),
      // the reference for how "busy" a window is
      let covered = 0;
      for (let k = 1; k < r.pollT.length; k++) { const g = r.pollT[k] - r.pollT[k - 1]; if (g <= 3600) covered += g; }
      S.tripRate = covered > 3 * 3600 ? list.filter((t) => !t.short).length / covered : null;
      const m = new Map(r.pollT.map((x, k) => [x, r.inuse[k]]));
      T.inuse = T.t.map((x) => m.get(x) ?? 0);
      S.k.liveInuse = r.inuse[r.inuse.length - 1] ?? null;
      setupScrubber();
      renderKarte(true);
    } catch (err) { console.warn('trips', err); }
  }

  function seek(i) {
    const T = S.tl, cur = T.cur;
    if (i === cur.i) return;
    let from;
    if (cur.i >= 0 && i > cur.i && i - cur.i <= KEY) from = cur.i;
    else {
      const k = Math.floor(i / KEY), key = T.keys[k];
      cur.p.set(key.p); cur.la.set(key.la); cur.lo.set(key.lo); cur.pl.set(key.pl);
      from = k * KEY;
    }
    for (let j = from + 1; j <= i; j++) T.apply(cur, j);
    cur.i = i;
  }

  let lastRendered = -2;
  let lastBikesAt = 0;
  function renderKarte(force) {
    if (!styleReady || S.mode !== 'karte') return;
    const T = S.tl, k = S.k;
    if (k.isLive || !T) {
      if (!S.live) return;
      if (force || lastRendered !== -1) { renderLiveBikes(); lastRendered = -1; }
      k.clock = S.live.t;
      setClock(S.live.t, true);
    } else {
      // while playing, redraw the bikes at most ~8 times per second (minute data has ~15 polls per second at 1×)
      const due = !k.playing || performance.now() - lastBikesAt > 120;
      if (force || (lastRendered !== k.frame && due)) { renderFrameBikes(k.frame); lastRendered = k.frame; lastBikesAt = performance.now(); }
      if (!k.playing) k.clock = T.t[k.frame];
      setClock(k.clock, false);
    }
    renderTrips(k.clock);
    if (S.layers.avail) scheduleOverlay(S.k.playing ? 120 : 500); // during playback: next preview right after the last one
  }

  function renderLiveBikes() {
    const L = S.live;
    setData('bikes', { type: 'FeatureCollection', features: L.bikes.map((b) => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [b.lng, b.lat] }, properties: { k: b.kind === 'station' ? 1 : 0, id: b.bike } })) });
    setData('stations', { type: 'FeatureCollection', features: L.stations.map((s) => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [s.lng, s.lat] }, properties: { n: (L.docked.get(String(s.uid)) || []).length, uid: String(s.uid) } })) });
    const c = L.meta.counts;
    setStats(c.total, c.station, c.free + c.other, S.k.liveInuse);
  }

  function renderFrameBikes(i) {
    const T = S.tl;
    seek(i);
    const cur = T.cur, sc = T.scale;
    const bikes = [], counts = new Int32Array(T.stations.length);
    let free = 0, docked = 0;
    for (let b = 0; b < T.N; b++) {
      if (!cur.p[b]) continue;
      const lat = T.lat0 + cur.la[b] / sc, lng = T.lng0 + cur.lo[b] / sc;
      const kk = cur.pl[b] >= 0 ? 1 : 0;
      if (kk) { counts[cur.pl[b]]++; docked++; } else free++;
      bikes.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: { k: kk, i: b } });
    }
    setData('bikes', { type: 'FeatureCollection', features: bikes });
    setData('stations', { type: 'FeatureCollection', features: T.stations.map((s, j) => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [s[3], s[2]] }, properties: { n: counts[j], i: j } })) });
    setStats(bikes.length, docked, free, T.inuse ? T.inuse[i] : null);
  }

  function setStats(total, st, fr, use) {
    S.total = total;
    $('#sStation').textContent = nf.format(st);
    $('#sFree').textContent = nf.format(fr);
    $('#sUse').textContent = use == null ? '–' : nf.format(use);
  }

  // the trips window drawn on the timeline: a band that ends at the thumb
  // and the availability's time of day: a band around the thumb
  function updateWinBand() {
    const el = $('#tlWin'), av = $('#tlTod'); if (!el) return;
    const { ts, te } = S.k, span = te - ts;
    const put = (node, t0, t1) => {
      t0 = Math.max(ts, t0); t1 = Math.min(te, t1);
      node.hidden = !(t1 > t0);
      node.style.setProperty('--a', ((t0 - ts) / span).toFixed(4));
      node.style.setProperty('--w', (Math.max(0, t1 - t0) / span).toFixed(4));
    };
    const now = S.k.isLive ? te : S.k.clock;
    if (!S.tl || !S.layers.trips || !(span > 0)) el.hidden = true;
    else put(el, now - S.o.win * 60, now);
    if (!S.tl || !S.layers.avail || !(span > 0)) av.hidden = true;
    else if (S.o.tod > 0) put(av, now - S.o.tod * 60, now + S.o.tod * 60);
    else { const d0 = now - localMin(now) * 60; put(av, d0, d0 + 86400); }
  }
  function setClock(t, live) {
    updateWinBand();
    $('#tlTime').textContent = fTime.format(new Date(t * 1000));
    const tot = S.total ? ` · ${nf.format(S.total)} Räder` : '';
    $('#tlDate').textContent = (live ? 'Live' : fDate.format(new Date(t * 1000))) + tot;
    const lb = $('#tlLive');
    lb.setAttribute('aria-pressed', String(live));
    lb.title = live ? 'Du siehst den aktuellen Stand' : 'Zum aktuellen Stand springen';
    $('#tlRange').setAttribute('aria-valuetext', live ? 'Live' : fmtWhen(t));
  }

  // ---- trips in the window [clock - win, clock]
  // Arrived in the window: the whole estimated route. Running at the clock
  // (past only, the destination is known): the route up to the estimated
  // position. Live: destinations are unknown, so a ring where the bike left,
  // coloured by minutes on the road so far.
  const lenAlong = (c) => { const L = [0]; for (let k = 1; k < c.length; k++) L.push(L[k - 1] + hav(c[k - 1][1], c[k - 1][0], c[k][1], c[k][0])); return L; };
  function along(c, L, u) {
    const want = u * L[L.length - 1];
    let k = 1; while (k < L.length - 1 && L[k] < want) k++;
    const f = (want - L[k - 1]) / Math.max(1e-9, L[k] - L[k - 1]);
    return [c[k - 1][0] + f * (c[k][0] - c[k - 1][0]), c[k - 1][1] + f * (c[k][1] - c[k - 1][1])];
  }
  function partial(c, L, u) {
    const want = u * L[L.length - 1], out = [c[0]];
    for (let k = 1; k < c.length; k++) { if (L[k] >= want) { out.push(along(c, L, u)); break; } out.push(c[k]); }
    return out;
  }
  // duration classes (minutes on the road) for the "Dauer" colouring and live rings
  const DUR_EDGES = [5, 10, 20, 40];
  const DUR_LABELS = ['< 5', '5–10', '10–20', '20–40', '> 40 Min.'];
  const durClass = (min) => { let k = 0; while (k < DUR_EDGES.length && min >= DUR_EDGES[k]) k++; return k; };
  // split a route into pieces of one duration class each, assuming even speed
  function slice(c, L, d0, d1) {
    const T = L[L.length - 1], out = [along(c, L, d0 / T)];
    for (let k = 1; k < c.length - 1; k++) if (L[k] > d0 && L[k] < d1) out.push(c[k]);
    out.push(along(c, L, d1 / T));
    return out;
  }
  function durPieces(c, L, dur, uEnd = 1) {
    const total = L[L.length - 1];
    if (!(total > 0)) return [];
    const end = uEnd * total, cuts = [0];
    for (const m of DUR_EDGES) { const d = ((m * 60) / dur) * total; if (d < end) cuts.push(d); }
    cuts.push(end);
    const out = [];
    for (let j = 0; j + 1 < cuts.length; j++) if (cuts[j + 1] > cuts[j]) out.push({ c: slice(c, L, cuts[j], cuts[j + 1]), k: j });
    return out;
  }
  let routeBusy = false;
  async function fetchRoutes(list) {
    if (routeBusy || !list.length) return;
    routeBusy = true;
    try {
      const pairs = [];
      for (const t of list) pairs.push(t.a[1], t.a[0], t.b[1], t.b[0]);
      const r = await rpc('routes', { pairs });
      list.forEach((t, k) => {
        const x = r.ok ? r.list[k] : null;
        t.route = x ? { c: x.c, L: lenAlong(x.c), len: x.len, ed: x.ed, em: x.em } : null;
      });
      S.routing = r.ok;
    } catch (err) { console.warn('routes', err); list.forEach((t) => { if (t.route === undefined) t.route = null; }); }
    finally { routeBusy = false; }
    renderTrips(S.k.clock);
  }
  const bboxOf = (c) => { let a = 180, b = 90, x = -180, y = -90; for (const p of c) { if (p[0] < a) a = p[0]; if (p[0] > x) x = p[0]; if (p[1] < b) b = p[1]; if (p[1] > y) y = p[1]; } return [a, b, x, y]; };
  const pt = (c, props) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: props });
  const ln = (c, props) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: c }, properties: props });
  let tripSum = { arrived: 0, running: 0, away: 0, today: 0 };

  // Arrived trips are drawn per street section: thickness = how many trips used
  // it (log scale), colour = their average (where along the trip / minutes on
  // the road / count). Running and not yet routed trips are drawn one by one.
  // Everything is grouped into a few Multi* features (colour x thickness), so
  // the map gets dozens of features instead of thousands.
  const DIR_STEPS = 6, W_CLS = 9;
  const mix = (h1, h2, f) => { const a = rgb(h1), b = rgb(h2); return `rgb(${a.map((x, i) => Math.round(x + (b[i] - x) * f)).join(',')})`; };
  const dirCols = () => (C.dirCols ||= Array.from({ length: DIR_STEPS }, (_, j) => mix(C.tStart, C.tEnd, j / (DIR_STEPS - 1))));
  const freqCols = () => (C.freqCols ||= Array.from({ length: DIR_STEPS }, (_, j) => {
    const f = (j / (DIR_STEPS - 1)) * (R.freq.length - 1), i = Math.min(R.freq.length - 2, Math.floor(f));
    return mix(R.freq[i], R.freq[i + 1], f - i);
  }));
  const wCls = (n) => Math.min(W_CLS - 1, Math.floor(Math.log2(Math.max(1, n))));
  // Strava-like: thickness and brightness relative to the busiest section in
  // the window (log scale), so a 24 h window does not paint the whole centre
  // thick; few trips = thin and see-through, the busiest = bright with a glow.
  // Capped for small counts, so 3 trips never look like a main axis.
  const intensity = (n, maxN) => (maxN > 1 ? Math.log(n) / Math.log(maxN) : 0);
  const wOf = (n, maxN) => Math.max(0, Math.min(W_CLS - 1, Math.round(Math.min(1, intensity(n, maxN)) * (W_CLS - 1)), 2 * wCls(n) + 1));
  let tripRef = 2, tripLoad = null; // reference count; trips in the window relative to average
  const GLOW = DARK ? { to: '#ffffff', k: [0, 0.2, 0.38, 0.58] } : { to: null, k: [0, 0.18, 0.32, 0.46] };
  const glowCache = new Map();
  function glowCol(col, f) {
    const q = f < 0.78 ? 0 : Math.min(3, 1 + Math.floor(((f - 0.78) / 0.22) * 3));
    if (!q) return col;
    const key = `${col}|${q}`;
    let v = glowCache.get(key);
    if (!v) glowCache.set(key, v = mixAny(col, GLOW.to || C.ink, GLOW.k[q]));
    return v;
  }
  // mix for '#rrggbb' or 'rgb(r,g,b)'
  const toRgb = (c) => (c.startsWith('rgb') ? c.match(/\d+/g).slice(0, 3).map(Number) : rgb(c));
  const mixAny = (c1, c2, f) => { const a = toRgb(c1), b = toRgb(c2); return `rgb(${a.map((x, i) => Math.round(x + (b[i] - x) * f)).join(',')})`; };
  const EDGE = new Map(); // street section -> coordinates, fetched from the worker once
  let edgeBusy = false;
  async function fetchEdges(ids) {
    if (edgeBusy) return;
    edgeBusy = true;
    try {
      const want = ids.slice(0, 30000);
      const r = await rpc('edges', { ids: want });
      if (r.ok) want.forEach((e, i) => EDGE.set(e, r.list[i]));
    } catch (err) { console.warn('edges', err); }
    finally { edgeBusy = false; }
    renderTrips(S.k.clock);
  }
  let drawn = [], lastTripsAt = 0, tripsTimer = 0, tripMax = 0;
  function renderTrips(clock) {
    if (!styleReady) return;
    // while playing, ~8 updates per second are plenty
    if (S.k.playing) {
      const t = performance.now();
      if (t - lastTripsAt < 120) { if (!tripsTimer) tripsTimer = setTimeout(() => { tripsTimer = 0; renderTrips(S.k.clock); }, 130); return; }
      lastTripsAt = t;
    }
    if (!S.trips || !S.layers.trips) {
      setData('trips', EMPTY); setData('tripdots', EMPTY); drawn = [];
      tripSum = { arrived: 0, running: 0, away: 0, today: 0 }; renderCtx(); return;
    }
    const A = clock - S.o.win * 60, mode = S.o.color, dir = mode === 'dir', freq = mode === 'freq';
    const buckets = new Map(); // "colour|thickness" -> [lines]
    const dotB = new Map();    // "fill|stroke|r|sw|opacity" -> [points]
    const addL = (col, w, c) => { if (c.length > 1) { const key = `${col}|${w}`; let l = buckets.get(key); if (!l) buckets.set(key, l = []); l.push(c); } };
    const addP = (key, c) => { let l = dotB.get(key); if (!l) dotB.set(key, l = []); l.push(c); };
    const agg = new Map(); // street section -> [trips, sum of progress, sum of minutes]
    const need = [], nd = [];
    const sum = { arrived: 0, running: 0, away: 0, today: 0 };
    const dayStart = clock - localMin(clock) * 60 - (Math.floor(clock) % 60); // local midnight
    const cols = dirCols();
    const startDot = dir ? `${C.tStart}|${C.tStart}|2.6|0|0.7` : `${C.ink}|${C.ink}|2.2|0|0.35`;
    const endDot = dir ? `${C.tEnd}|${C.tEnd}|2.6|0|0.7` : `${C.ink}|${C.ink}|2.2|0|0.35`;
    for (const tr of S.trips) {
      if (tr.s >= clock) break;
      if (tr.e <= clock && tr.e >= dayStart) sum.today++;
      const arrived = tr.e > A && tr.e <= clock;
      const running = !arrived && tr.e > clock && !S.k.isLive;
      if (!arrived && !running) continue;
      if (tr.route === undefined) need.push(tr);
      const R = tr.route;
      const c = R ? R.c : [tr.a, tr.b];
      const dur = Math.max(60, tr.e - tr.s);
      addP(startDot, c[0]);
      if (arrived) {
        sum.arrived++;
        addP(endDot, c[c.length - 1]);
        nd.push({ k: tr.k, c, bb: R ? (R.bb ||= bboxOf(c)) : bboxOf(c) });
        if (R && R.ed) {
          const ed = R.ed, em = R.em, dm = dur / 60;
          for (let j = 0; j < ed.length; j++) {
            let a = agg.get(ed[j]); if (!a) agg.set(ed[j], a = [0, 0, 0]);
            a[0]++; a[1] += em[j]; a[2] += em[j] * dm;
          }
          continue;
        }
      }
      // one by one: running at a past moment, or no route (yet)
      const L = R ? R.L : lenAlong(c), T = L[L.length - 1];
      const u = arrived ? 1 : Math.min(1, Math.max(0.02, (clock - tr.s) / dur));
      if (dir || freq) {
        const cc = freq ? freqCols() : cols;
        for (let j = 0; j < DIR_STEPS && j / DIR_STEPS < u; j++) addL(freq ? cc[0] : cc[j], 0, slice(c, L, (j / DIR_STEPS) * T, Math.min((j + 1) / DIR_STEPS, u) * T));
      } else for (const p of durPieces(c, L, dur, u)) addL(C.dur[p.k], 0, p.c);
      if (!arrived) {
        sum.running++;
        const head = along(c, L, u);
        const col = dir ? cols[Math.min(DIR_STEPS - 1, Math.floor(u * DIR_STEPS))] : C.dur[durClass((clock - tr.s) / 60)];
        addP(`${C.surface}|${col}|4.2|1.8|1`, head);
        nd.push({ k: tr.k, c: partial(c, L, u), bb: R ? (R.bb ||= bboxOf(c)) : bboxOf(c) });
      }
    }
    // street sections
    let maxN = 1;
    for (const a of agg.values()) if (a[0] > maxN) maxN = a[0];
    // Reference: the busiest section as it would be at average traffic for a
    // window this long. Quiet hours (night) stay faint, rush hours glow more.
    const avgTrips = S.tripRate ? S.tripRate * S.o.win * 60 : 0;
    // only damps quiet hours; busy hours are not amplified beyond "relative to the busiest section"
    const ref = Math.max(2, maxN, avgTrips > 0 ? (maxN * avgTrips) / Math.max(1, sum.arrived) : 0);
    const missing = [], fc = freqCols(), lmax = Math.log(ref + 1);
    for (const [e, a] of agg) {
      const g = EDGE.get(e);
      if (!g) { missing.push(e); continue; }
      const n = a[0], f = Math.min(1, intensity(n, ref));
      const col = freq ? fc[Math.min(DIR_STEPS - 1, Math.floor((Math.log(n + 1) / lmax) * DIR_STEPS))]
        : dir ? cols[Math.min(DIR_STEPS - 1, Math.floor((a[1] / n) * DIR_STEPS))] : C.dur[durClass(a[2] / n)];
      addL(glowCol(col, f), wOf(n, ref), g);
    }
    tripMax = agg.size ? maxN : 0; tripRef = ref;
    tripLoad = avgTrips > 0 ? sum.arrived / avgTrips : null;
    const away = [];
    if (S.k.isLive && S.o.away) {
      for (const a of S.away) {
        if (a.since < A) continue; // only departures inside the window, like the trips
        sum.away++;
        addP(`rgba(0,0,0,0)|${C.dur[durClass((clock - a.since) / 60)]}|4.2|1.6|1`, a.a);
        away.push(a);
      }
    }
    drawn = nd; drawn.away = away;
    setData('trips', { type: 'FeatureCollection', features: [...buckets].map(([key, l]) => {
      const [col, w] = key.split('|');
      return { type: 'Feature', geometry: { type: 'MultiLineString', coordinates: l }, properties: { col, w: +w } };
    }) });
    setData('tripdots', { type: 'FeatureCollection', features: [...dotB].map(([key, l]) => {
      const [fill, stroke, r, sw, op] = key.split('|');
      return { type: 'Feature', geometry: { type: 'MultiPoint', coordinates: l }, properties: { fill, stroke, r: +r, sw: +sw, op: +op } };
    }) });
    tripSum = sum;
    renderCtx();
    if (missing.length) fetchEdges(missing);
    if (need.length) fetchRoutes(need.slice(0, 600));
  }

  // trips under a tap, matched on the drawn geometry (metres, flat approximation)
  function tripsAt(lngLat, px) {
    const mpp = (156543.03 * Math.cos((lngLat.lat * Math.PI) / 180)) / 2 ** map.getZoom();
    const r = px * mpp, kx = 111320 * Math.cos((lngLat.lat * Math.PI) / 180), ky = 110574;
    const X = (p) => (p[0] - lngLat.lng) * kx, Y = (p) => (p[1] - lngLat.lat) * ky;
    const segD = (a, b) => {
      const ax = X(a), ay = Y(a), bx = X(b), by = Y(b), dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
      return Math.hypot(ax + t * dx, ay + t * dy);
    };
    const ks = [], dl = r / kx, dt = r / ky;
    for (const d of drawn) {
      const c = d.c, bb = d.bb;
      if (bb && (lngLat.lng < bb[0] - dl || lngLat.lng > bb[2] + dl || lngLat.lat < bb[1] - dt || lngLat.lat > bb[3] + dt)) continue;
      if (c.length === 1 ? Math.hypot(X(c[0]), Y(c[0])) <= r : c.some((p, i) => i && segD(c[i - 1], p) <= r)) ks.push(d.k);
    }
    const away = (drawn.away || []).filter((a) => Math.hypot(X(a.a), Y(a.a)) <= r * 1.2);
    return { ks, away };
  }

  // all trips under the finger
  function tripsNear(point) {
    return tripsAt(map.unproject(point), isDesktop() ? 7 : 14);
  }
  // a list to pick from; only these trips stay on the map
  function showTripPicker(ks) {
    const list = ks.map((k) => S.trips[k]).filter(Boolean).sort((a, b) => b.e - a.e);
    const items = list.map((t) => ({ type: 'move', kind: 'trip', a: t.a, b: t.b, route: t.route?.c || null, len: t.route?.len, d: t.d, s: t.s, e: t.e, bike: t.bike, from: t.from, to: t.to }));
    S.histWant = null; S.histToken = {};
    S.hist = { type: 'group', items };
    drawHist();
    const place = (x) => (x ? esc(x) : 'frei');
    showDetail('#detail', `
      <p class="kicker">Hier überlagern sich</p>
      <h3>${nf.format(items.length)} Fahrten</h3>
      <p class="hint">Antippen hebt eine Fahrt hervor, „Profil“ zeigt den ganzen Verlauf des Rads.</p>
      <ul class="rows hist">${items.slice(0, 150).map((it, n) => `<li class="hrow trip" data-n="${n}"><button class="rowbtn" data-act="hfocus" data-n="${n}">
        <span class="ic route"></span>
        <span class="main"><b>Rad ${esc(it.bike)}</b><small>${place(it.from)} → ${place(it.to)} · ${tm(it.s)}–${tm(it.e)} · ${it.len ? `~${fmtDist(it.len)}` : fmtDist(it.d)}</small></span></button>
        <button class="mini" data-act="trail" data-id="${esc(it.bike)}" aria-label="Profil von Rad ${esc(it.bike)}">Profil</button></li>`).join('')}</ul>
      ${items.length > 150 ? `<p class="hint">Die neuesten 150 von ${nf.format(items.length)}.</p>` : ''}
      <div class="actions"><button class="btn sm ghost" data-act="cleartrail">Auswahl aufheben</button></div>`, { keepSel: true });
    fitHist();
  }

  // tap on a trip: open the bike's profile with this trip highlighted
  function openTrip(p) {
    if (+p.away) { showBikeHistory(p.bike, { away: { since: +p.since, from: p.from } }); return; }
    const t = S.trips?.[+p.k]; if (!t) return;
    showBikeHistory(t.bike, { trip: t });
  }

  // ---- scrubber (the last position is "Live")
  function setupScrubber() {
    const T = S.tl, r = $('#tlRange');
    if (!T || !T.t.length) return;
    const i0 = T.i0, i1 = T.t.length - 1;
    // the slider runs on time (seconds), like the axis below it; polls are
    // uneven (hours apart in old data, a minute apart now), so an index slider
    // would crawl through sparse stretches and race through dense ones
    const ts = T.t[i0], te = Math.max(S.live?.t || 0, T.t[i1]), span = Math.max(1, te - ts);
    r.disabled = false;
    r.min = ts; r.max = te; r.step = 1;
    if (S.k.isLive) r.value = te;
    else { S.k.frame = Math.min(Math.max(S.k.frame, i0), i1); r.value = T.t[S.k.frame]; }
    S.k.ts = ts; S.k.te = te; updateWinBand();
    const svg = $('#tlSpark');
    const X = (t) => ((t - ts) / span) * 1000;
    const vals = T.inuse ? T.inuse.slice(i0, i1 + 1) : null;
    let d = '';
    if (vals) {
      const max = Math.max(5, ...vals);
      for (let k = 0; k < vals.length; k++) d += `${k ? 'L' : 'M'}${X(T.t[i0 + k]).toFixed(1)},${(50 - (vals[k] / max) * 44).toFixed(1)}`;
    }
    const days = [], ticks = [];
    const sp = S.k.span;
    for (let t = ts - (ts % 3600) + 3600; t <= te; t += 3600) {
      const h = localHour(t);
      if (h === 0) days.push(t);
      if (sp <= 6 ? true : sp <= 24 ? h % 6 === 0 : sp <= 72 ? h === 0 || h === 12 : h === 12) ticks.push(t);
    }
    if (ticks.length > 6) { const st = Math.ceil(ticks.length / 6); for (let k = ticks.length - 1; k >= 0; k--) if (k % st) ticks.splice(k, 1); }
    svg.setAttribute('viewBox', '0 0 1000 52');
    svg.innerHTML = `${days.map((t) => `<line class="day" x1="${X(t)}" x2="${X(t)}" y1="0" y2="52"/>`).join('')}
      ${d ? `<path class="area" d="${d}L${X(T.t[i1])},52L${X(T.t[i0])},52Z"/><path class="ln" d="${d}"/>` : ''}`;
    $('#tlTicks').innerHTML = ticks.map((t) => {
      const lab = sp <= 24 ? `${localHour(t)} Uhr` : localHour(t) === 0 ? fDM.format(new Date(t * 1000)) : fDay.format(new Date(t * 1000));
      const x = X(t) / 10;
      return x > 6 && x < 86 ? `<span style="left:${x}%">${lab}</span>` : '';
    }).join('') + '<span class="end">jetzt</span>';
  }

  function goLive() {
    stopPlay();
    if (S.tl && !S.tl.loaded) { S.k.isLive = true; reloadTimeline(); return; } // newer data arrived meanwhile
    S.k.isLive = true;
    if (S.tl) $('#tlRange').value = $('#tlRange').max;
    closeDetail(true);
    renderKarte(true); updateStatus();
  }

  function setFrame(i) {
    const T = S.tl;
    if (!T) return;
    if (i >= T.t.length) { goLive(); return; }
    S.k.isLive = false; S.k.frame = i; S.k.clock = T.t[i];
    renderKarte(); updateStatus();
  }

  // continuous playback: the clock runs smoothly, bikes update at each poll,
  // trip dots glide in between
  let playRaf = 0, playLast = 0;
  const RATE = { 1: 900, 2: 1800, 4: 3600 }; // simulated seconds per real second
  function stopPlay() {
    const was = S.k.playing;
    S.k.playing = false; cancelAnimationFrame(playRaf);
    if (was && S.layers.avail) scheduleOverlay(80); // the preview from playback, now in full quality
    $('#tlPlay').classList.remove('on'); $('#tlPlay').setAttribute('aria-label', 'Abspielen');
  }
  function startPlay() {
    const T = S.tl;
    if (!T) { toast('Der Verlauf lädt noch.'); return; }
    if (S.k.isLive || S.k.frame >= T.t.length - 1) { S.k.isLive = false; S.k.frame = T.i0; }
    S.k.clock = T.t[S.k.frame];
    S.k.playing = true; playLast = performance.now();
    $('#tlPlay').classList.add('on'); $('#tlPlay').setAttribute('aria-label', 'Pause');
    updateStatus();
    const step = (ts) => {
      if (!S.k.playing) return;
      // real elapsed time, so the clock keeps its speed even when frames are slow (cap only long stalls)
      const dt = Math.min(0.5, (ts - playLast) / 1000); playLast = ts;
      S.k.clock += dt * RATE[S.k.speed];
      let f = S.k.frame;
      while (f + 1 < T.t.length && T.t[f + 1] <= S.k.clock) f++;
      if (f !== S.k.frame) S.k.frame = f;
      $('#tlRange').value = S.k.clock; // glides with the clock
      if (S.k.clock >= T.t[T.t.length - 1]) { goLive(); return; }
      renderKarte();
      playRaf = requestAnimationFrame(step);
    };
    playRaf = requestAnimationFrame(step);
  }

  // ---- details in the map view
  const LOCKS = { frame_lock: 'Rahmenschloss', frame_lock_with_bt_capabilities: 'Bluetooth', rack_adapter: 'Stationsadapter', cable_lock: 'Kabelschloss' };
  function sinceText(b) {
    if (!b.since) return null;
    const d = fmtDur(Math.max(0, now() - b.since));
    return b.since_censored ? `mind. ${d} (seit Aufzeichnungsbeginn)` : d;
  }

  function showBike(id) {
    const b = S.live?.byId.get(String(id));
    if (!b) { toast(`Rad ${id} ist gerade nicht im Feed, wahrscheinlich unterwegs.`); return; }
    const st = b.kind === 'station' ? S.live.stById.get(String(b.place_uid)) : null;
    const rows = [
      st && ['Station', esc(st.name)],
      ['Unbewegt seit', sinceText(b) || '–'],
      b.battery != null && ['Akku', `${b.battery} %`],
      ['Schloss', esc((b.lock_types || '').split(',').filter(Boolean).map((x) => LOCKS[x] || x).join(', ') || '–')],
      b.bike_type != null && ['Typ-Code', b.bike_type],
    ].filter(Boolean);
    const route = `https://www.google.com/maps/dir/?api=1&destination=${b.lat},${b.lng}&travelmode=walking`;
    showDetail('#detail', `
      <p class="kicker"><span class="dot" style="background:${st ? C.station : C.free}"></span>${st ? 'An einer Station' : 'Frei abgestellt'}${S.me ? `, ${fmtDist(hav(S.me[1], S.me[0], b.lat, b.lng))} entfernt` : ''}</p>
      <h3>Rad ${esc(b.bike)}</h3>
      <dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
      <div class="actions">
        <a class="btn sm" href="${route}" target="_blank" rel="noopener">Route hierhin</a>
        <button class="btn sm ghost" data-act="trail" data-id="${esc(b.bike)}">Verlauf anzeigen</button>
      </div>`);
    select({ type: 'Point', coordinates: [b.lng, b.lat] });
    flyTo([b.lng, b.lat]);
  }

  function showStation(uid) {
    const st = S.live?.stById.get(String(uid));
    if (!st) return;
    const docked = S.live.docked.get(String(uid)) || [];
    const rows = [
      ['Räder jetzt', `${docked.length}`],
      st.bike_racks ? ['Stellplätze', `${st.bike_racks}${st.free_racks != null ? `, ${st.free_racks} frei` : ''}`] : null,
    ].filter(Boolean);
    showDetail('#detail', `
      <p class="kicker"><span class="dot" style="background:${C.station}"></span>Station${st.number ? ` ${st.number}` : ''}</p>
      <h3>${esc(st.name)}</h3>
      <dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
      ${docked.length ? `<div class="bikelist">${docked.slice(0, 60).map((b) => `<button data-act="bike" data-id="${esc(b.bike)}">${esc(b.bike)}</button>`).join('')}</div>` : ''}
      <div class="actions"><a class="btn sm" href="https://www.google.com/maps/dir/?api=1&destination=${st.lat},${st.lng}&travelmode=walking" target="_blank" rel="noopener">Route hierhin</a></div>
      <h4 class="sect">Ankünfte und Abfahrten</h4><div id="stMoves"></div>
      <h4 class="sect">Typischer Füllstand</h4><div id="stHist" class="sub"><span class="busy">wird berechnet</span></div>`);
    select({ type: 'Point', coordinates: [st.lng, st.lat] });
    flyTo([st.lng, st.lat]);
    S.histWant = { type: 'station', uid: String(uid), at: [st.lng, st.lat], name: st.name };
    loadStationMoves(String(uid), [st.lng, st.lat], st.name);
    stationQuery(String(uid), '#stHist').catch(() => { const el = $('#stHist'); if (el) el.innerHTML = ''; });
  }

  function showTlBike(i) {
    const T = S.tl, id = T.bikes[i], cur = T.cur;
    const lat = T.lat0 + cur.la[i] / T.scale, lng = T.lng0 + cur.lo[i] / T.scale;
    const st = cur.pl[i] >= 0 ? T.stations[cur.pl[i]] : null;
    showDetail('#detail', `
      <p class="kicker"><span class="dot" style="background:${st ? C.station : C.free}"></span>${st ? 'An einer Station' : 'Frei abgestellt'}, ${fmtWhen(T.t[S.k.frame])}</p>
      <h3>Rad ${esc(id)}</h3>
      ${st ? `<dl class="kv"><dt>Station</dt><dd>${esc(st[1])}</dd></dl>` : ''}
      <div class="actions"><button class="btn sm" data-act="trail" data-id="${esc(id)}">Verlauf anzeigen</button>
      ${S.live?.byId.has(id) ? `<button class="btn sm ghost" data-act="livebike" data-id="${esc(id)}">Wo ist es jetzt?</button>` : ''}</div>`);
    select({ type: 'Point', coordinates: [lng, lat] });
  }

  function showTlStation(i) {
    const T = S.tl, s = T.stations[i];
    const list = [];
    for (let b = 0; b < T.N; b++) if (T.cur.p[b] && T.cur.pl[b] === i) list.push(T.bikes[b]);
    showDetail('#detail', `
      <p class="kicker"><span class="dot" style="background:${C.station}"></span>Station, ${fmtWhen(T.t[S.k.frame])}</p>
      <h3>${esc(s[1])}</h3>
      <dl class="kv"><dt>Räder</dt><dd>${list.length}</dd></dl>
      ${list.length ? `<div class="bikelist">${list.slice(0, 60).map((b) => `<button data-act="tlbike" data-id="${esc(b)}">${esc(b)}</button>`).join('')}</div>` : ''}
      <h4 class="sect">Ankünfte und Abfahrten</h4><div id="stMoves"></div>`);
    select({ type: 'Point', coordinates: [s[3], s[2]] });
    S.histWant = { type: 'station', uid: String(s[0]), at: [s[3], s[2]], name: s[1] };
    loadStationMoves(String(s[0]), [s[3], s[2]], s[1]);
  }

  // ================================================================ history of one bike / one station
  const HP = [[6, '6 Std.'], [24, '24 Std.'], [72, '3 Tage'], [168, '7 Tage']];
  const maxHistH = () => Math.max(1, (S.cfg?.trail_max_days || 7) * 24);
  const fISO = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' });
  const isoLocal = (t) => fISO.format(new Date(t * 1000));
  const dtLocal = (t) => { const d = new Date(t * 1000); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
  function histRange() {
    const ref = S.k.isLive || !S.tl ? (S.live?.t || now()) : S.k.clock;
    const t1 = S.hp.to ?? ref;
    let t0 = S.hp.from ?? t1 - S.hp.h * 3600;
    t0 = Math.max(t0, t1 - maxHistH() * 3600);
    return [Math.floor(t0), Math.ceil(t1)];
  }
  const datesFor = (t0, t1) => (tlIndex || []).map((d) => d.date).filter((d) => d >= isoLocal(t0) && d <= isoLocal(t1));
  function periodCtl() {
    const custom = S.hp.from != null, maxH = maxHistH();
    return `<div class="hper">
      <div class="seg sm" role="radiogroup" aria-label="Zeitraum">${HP.filter(([h]) => h <= maxH).map(([h, l]) =>
        `<button role="radio" data-act="hper" data-h="${h}" aria-checked="${!custom && S.hp.h === h}">${l}</button>`).join('')}</div>
      </div>`;
  }
  const HIST_LEGEND = `<div class="hlegend">
    <span><i class="lg st"></i>an Station</span><span><i class="lg fr"></i>frei abgestellt</span><span><i class="lg snap"></i>Snapshot</span>
    <span><i class="lg ts"></i><i class="lg route"></i><i class="lg te"></i>Fahrt: Start → Ziel, Weg geschätzt</span></div>`;

  async function showBikeHistory(id, opts = {}) {
    const token = S.histToken = {};
    S.histWant = { type: 'bike', id };
    showDetail('#detail', `<p class="kicker">Verlauf</p><h3>Rad ${esc(id)}</h3>${periodCtl()}<div id="histBody"><span class="busy">wird geladen</span></div>`, { keepSel: true });
    try { await ensureIndex(); } catch { $('#histBody').innerHTML = '<p class="hint">Noch kein Verlauf vorhanden.</p>'; return; }
    let [t0, t1] = histRange();
    if (opts.trip && opts.trip.e > t1) t1 = Math.ceil(opts.trip.e + 120); // a trip still running at the shown moment
    let r;
    try { r = await rpc('bikeTrail', { bike: String(id), t0, t1, P: tripParams(), dates: datesFor(t0, t1) }); }
    catch (err) { if (S.histToken === token) $('#histBody').innerHTML = `<p class="hint">Fehler: ${esc(err.message.split('\n')[0])}</p>`; return; }
    if (S.histToken !== token) return;
    const items = [];
    r.stays.forEach((st, k) => { items.push({ type: 'stay', ...st }); if (r.moves[k]) items.push({ type: 'move', ...r.moves[k] }); });
    S.hist = { type: 'bike', id, items, routing: r.routing, leftAt: r.leftAt, polls: r.polls, t0, t1 };
    renderBikeHist();
    const fn = opts.trip ? items.findIndex((x) => x.type === 'move' && x.kind === 'trip' && x.t0 <= opts.trip.s + 1 && x.t1 >= opts.trip.e - 1) : -1;
    if (fn >= 0) histFocus(fn); else { drawHist(); fitHist(); }
  }

  function drawHist(hi = -1) {
    const H = S.hist; if (!H) { setData('hist', EMPTY); applyVisibility(); return; }
    const f = [];
    const flags = (n) => ({ n, hi: n === hi ? 1 : 0, dim: hi >= 0 && n !== hi ? 1 : 0 });
    H.items.forEach((it, n) => {
      if (it.type === 'stay') {
        const dur = Math.max(0, it.t1 - it.t0);
        if (it.pts && it.pts.length > 1) for (const p of it.pts) f.push(pt(p, { kind: 'snap' }));
        f.push(pt([it.lng, it.lat], { kind: 'stay', st: it.st >= 0 ? 1 : 0, r: Math.min(5, Math.max(0, Math.log2(1 + dur / 1800))), ...flags(n) }));
        return;
      }
      const a = H.type === 'bike' ? H.items[n - 1] : null, b = H.type === 'bike' ? H.items[n + 1] : null;
      const s0 = a ? [a.lng, a.lat] : it.a, s1 = b ? [b.lng, b.lat] : it.b;
      if (it.kind === 'glitch') return; // no line for a GPS jump
      if (it.kind === 'shift') { f.push(ln([s0, s1], { kind: 'shift', ...flags(n) })); return; }
      const c = it.route || [s0, s1];
      f.push(ln(c, { kind: it.route ? 'route' : 'air', ...flags(n) }));
      f.push(pt(c[0], { kind: 'ts', ...flags(n) }), pt(c[c.length - 1], { kind: 'te', ...flags(n) }));
    });
    setData('hist', { type: 'FeatureCollection', features: f });
    applyVisibility();
  }
  function fitHist(n) {
    const H = S.hist; if (!H) return;
    const b = new maplibregl.LngLatBounds();
    const add = (it) => {
      if (it.type === 'stay') b.extend([it.lng, it.lat]);
      else (it.route || [it.a, it.b].filter(Boolean)).forEach((p) => b.extend(p));
    };
    if (n != null) add(H.items[n]); else H.items.forEach(add);
    if (H.type === 'station') b.extend(H.at);
    if (b.isEmpty()) return;
    map.fitBounds(b, { padding: mapPad(isDesktop() ? 60 : 36),
      maxZoom: 16, duration: REDUCED ? 0 : 600 });
  }
  function histFocus(n) {
    const H = S.hist; if (!H || !H.items[n]) return;
    drawHist(n); fitHist(n);
    $$('#histBody [data-n]').forEach((el) => el.classList.toggle('on', +el.dataset.n === n));
    const row = $(`#histBody [data-n="${n}"]`); if (row) row.scrollIntoView({ block: 'nearest', behavior: REDUCED ? 'auto' : 'smooth' });
  }
  const tm = (t) => fTime.format(new Date(t * 1000));
  const dayTm = (t) => `${fDay.format(new Date(t * 1000))} ${tm(t)}`;

  function renderBikeHist() {
    const H = S.hist, el = $('#histBody'); if (!el) return;
    const trips = H.items.filter((x) => x.type === 'move' && x.kind === 'trip');
    const km = trips.reduce((a, x) => a + (x.len || x.d), 0);
    const stays = H.items.filter((x) => x.type === 'stay');
    const snaps = stays.reduce((a, x) => a + x.n, 0);
    if (!stays.length) { el.innerHTML = '<p class="hint">In diesem Zeitraum nicht im Feed gesehen.</p>'; return; }
    const rows = [];
    if (H.leftAt) rows.push(`<li class="hrow now"><span class="ic route"></span><span class="main"><b>Seit ${tm(H.leftAt)} nicht im Feed</b><small>wahrscheinlich gerade unterwegs, Ziel noch unbekannt</small></span></li>`);
    for (let n = H.items.length - 1; n >= 0; n--) {
      const it = H.items[n];
      if (it.type === 'stay') {
        const dur = it.t1 - it.t0;
        rows.push(`<li class="hrow" data-n="${n}"><button class="rowbtn" data-act="hfocus" data-n="${n}">
          <span class="ic ${it.st >= 0 ? 'st' : 'fr'}"></span>
          <span class="main"><b>${it.st >= 0 ? esc(it.name) : 'Frei abgestellt'}</b><small>${dayTm(it.t0)}${dur > 0 ? ` – ${tm(it.t1)}` : ''} · ${it.n} ${it.n === 1 ? 'Snapshot' : 'Snapshots'}</small></span>
          <span class="val">${dur > 0 ? fmtDur(dur) : '–'}<small>abgestellt</small></span></button></li>`);
      } else if (it.kind === 'trip') {
        const dur = it.t1 - it.t0;
        rows.push(`<li class="hrow trip" data-n="${n}"><button class="rowbtn" data-act="hfocus" data-n="${n}">
          <span class="ic route"></span>
          <span class="main"><b>${it.service ? 'Lange weg (Werkstatt oder Umverteilung?)' : 'Fahrt'}</b><small>${tm(it.t0)} → ${tm(it.t1)} · ${it.len ? `~${fmtDist(it.len)} Weg` : `${fmtDist(it.d)} Luftlinie`}</small></span>
          <span class="val"${it.absent ? '' : ' title="Zwischen zwei Abfragen bewegt, ohne aus dem Feed zu verschwinden: höchstens so lange"'}>${it.absent ? fmtDur(Math.max(60, dur)) : `≤ ${fmtDur(Math.max(60, dur))}`}</span></button></li>`);
      } else if (it.kind === 'glitch') {
        const dur = Math.max(60, it.t1 - it.t0);
        rows.push(`<li class="hrow shift" data-n="${n}"><button class="rowbtn" data-act="hfocus" data-n="${n}"><span class="ic shift"></span>
          <span class="main"><small>Messfehler: Sprung um ${fmtDist(it.d)} in ≤ ${fmtDur(dur)} (mind. ${nf.format(Math.round((it.d / dur) * 3.6))} km/h), keine Fahrt</small></span></button></li>`);
      } else {
        rows.push(`<li class="hrow shift" data-n="${n}"><button class="rowbtn" data-act="hfocus" data-n="${n}"><span class="ic shift"></span>
          <span class="main"><small>um ${fmtDist(it.d)} versetzt (GPS-Ungenauigkeit oder kurz verschoben)</small></span></button></li>`);
      }
    }
    el.innerHTML = `<div class="tiles small">
        <div class="stat"><b>${trips.length}</b><span>Fahrten</span></div>
        <div class="stat"><b>${trips.length ? `~${fmtDist(km)}` : '–'}</b><span>Weg, geschätzt</span></div>
        <div class="stat"><b>${nf.format(snaps)}</b><span>Snapshots</span></div></div>
      ${HIST_LEGEND}
      ${H.routing ? '' : '<p class="hint">Straßennetz nicht verfügbar, Fahrten als gerade Linie.</p>'}
      <ul class="rows hist">${rows.join('')}</ul>
      <p class="hint">Ein Snapshot = eine Abfrage, in der das Rad zu sehen war (gespeichert wird eine Position nur, wenn es sich mehr als 25 m bewegt hat). Der Weg einer Fahrt ist geschätzt: der günstigste Radweg zwischen Start und Ziel laut OpenStreetMap.</p>
      <div class="actions"><button class="btn sm ghost" data-act="cleartrail">Verlauf ausblenden</button></div>`;
  }

  // ---- arrivals and departures of a station
  async function loadStationMoves(uid, at, name) {
    const box = $('#stMoves'); if (!box) return;
    const token = S.histToken = {};
    box.innerHTML = `${periodCtl()}<div id="histBody"><span class="busy">wird geladen</span></div>`;
    try { await ensureIndex(); } catch { $('#histBody').innerHTML = '<p class="hint">Noch kein Verlauf vorhanden.</p>'; return; }
    const [t0, t1] = histRange();
    const dates = datesFor(t0, t1);
    let r;
    try { r = await rpc('stationMoves', { uid: String(uid), t0, t1, P: tripParams(), dates }); }
    catch (err) { if (S.histToken === token) $('#histBody').innerHTML = `<p class="hint">Fehler: ${esc(err.message.split('\n')[0])}</p>`; return; }
    if (S.histToken !== token) return;
    const items = r.list.map((x) => ({ type: 'move', kind: 'trip', ...x }));
    S.hist = { type: 'station', uid, at, items, routing: r.routing, name };
    drawHist();
    const ins = items.filter((x) => !x.out).length, outs = items.length - ins;
    $('#histBody').innerHTML = !items.length ? '<p class="hint">Keine Ankünfte oder Abfahrten in diesem Zeitraum.</p>' : `
      <p class="hsum"><b>${ins}</b> Ankünfte · <b>${outs}</b> Abfahrten</p>
      ${HIST_LEGEND}
      <ul class="rows hist">${items.slice(0, 120).map((it, n) => `<li class="hrow trip" data-n="${n}"><button class="rowbtn" data-act="hfocus" data-n="${n}">
        <span class="ic ${it.out ? 'out' : 'in'}" aria-hidden="true">${it.out ? '↗' : '↘'}</span>
        <span class="main"><b>Rad ${esc(it.bike)} ${it.out ? 'nach' : 'von'} ${it.other ? esc(it.other) : 'frei abgestellt'}</b>
          <small>${dayTm(it.out ? it.s : it.e)} · ${it.len ? `~${fmtDist(it.len)} Weg (geschätzt)` : `${fmtDist(it.d)} Luftlinie`}</small></span></button>
        <button class="mini" data-act="trail" data-id="${esc(it.bike)}" aria-label="Verlauf von Rad ${esc(it.bike)}">Verlauf</button></li>`).join('')}</ul>
      ${items.length > 120 ? `<p class="hint">Die neuesten 120 von ${items.length}.</p>` : ''}
      <div class="actions"><button class="btn sm ghost" data-act="cleartrail">Bewegungen ausblenden</button></div>`;
    fitHist();
  }
  function reloadHist() {
    if (S.hist?.type === 'bike' || S.histWant?.type === 'bike') showBikeHistory(S.hist?.id ?? S.histWant.id);
    else if (S.hist?.type === 'station' || S.histWant?.type === 'station') { const w = S.hist || S.histWant; loadStationMoves(w.uid, w.at, w.name); }
  }

  // ---- near me
  function locate(fromButton) {
    if (!navigator.geolocation) { toast('Standort wird von diesem Browser nicht unterstützt.'); return; }
    $('#btnLocate').classList.add('on');
    navigator.geolocation.getCurrentPosition((pos) => {
      S.me = [pos.coords.longitude, pos.coords.latitude];
      setData('me', { type: 'Feature', geometry: { type: 'Point', coordinates: S.me }, properties: {} });
      flyTo(S.me, 15.2);
      if (S.mode === 'karte') { renderNear(); if (!fromButton) setSheet('half'); }
    }, (err) => {
      $('#btnLocate').classList.remove('on');
      toast(err.code === 1 ? 'Standortfreigabe abgelehnt. Du kannst sie in den Browser-Einstellungen erlauben.' : 'Standort konnte nicht bestimmt werden.');
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
  }

  function renderNear() {
    if (!S.me || !S.live) return;
    const [lng, lat] = S.me;
    const items = [];
    for (const b of S.live.bikes) if (b.kind !== 'station') items.push({ d: hav(lat, lng, b.lat, b.lng), b });
    for (const [uid, list] of S.live.docked) {
      const st = S.live.stById.get(uid);
      if (st && list.length) items.push({ d: hav(lat, lng, st.lat, st.lng), st, n: list.length });
    }
    items.sort((a, b) => a.d - b.d);
    const within = items.filter((x) => x.d <= 400).reduce((s, x) => s + (x.n || 1), 0);
    const walk = (d) => `~${Math.max(1, Math.round(d / 75))} Min. zu Fuß`;
    $('#near').innerHTML = `
      <p class="near-sum"><b>${within}</b> ${within === 1 ? 'Rad' : 'Räder'} im Umkreis von 400 m</p>
      <ul class="rows">${items.slice(0, 6).map((x) => x.b ? `
        <li><button class="rowbtn" data-act="bike" data-id="${esc(x.b.bike)}"><span class="dot" style="background:${C.free}"></span>
          <span class="main"><b>Rad ${esc(x.b.bike)}</b><small>frei abgestellt</small></span>
          <span class="val">${fmtDist(x.d)}<small>${walk(x.d)}</small></span></button></li>` : `
        <li><button class="rowbtn" data-act="station" data-id="${esc(x.st.uid)}"><span class="dot" style="background:${C.station}"></span>
          <span class="main"><b>${esc(x.st.name)}</b><small>${x.n} ${x.n === 1 ? 'Rad' : 'Räder'} an der Station</small></span>
          <span class="val">${fmtDist(x.d)}<small>${walk(x.d)}</small></span></button></li>`).join('')}</ul>
      <div class="actions"><button class="btn sm" data-act="pointme" type="button">Wie weit ist es hier normalerweise?</button>
      <button class="btn sm ghost" id="btnNear2" type="button">Standort aktualisieren</button></div>`;
  }

  // ================================================================ availability overlay
  // One overlay, three measures of the same thing: chance of a bike within R,
  // typical walk to the nearest bike, bikes per hectare. Basis: the time of day
  // of the trip window, over the last N days (and chosen weekdays).
  const R_STEPS = [25, 50, 75, 100, 125, 150, 200, 250, 300, 400, 500]; // what the worker's histogram resolves exactly
  const WD_MASK = { all: [1, 1, 1, 1, 1, 1, 1], wk: [1, 1, 1, 1, 1, 0, 0], we: [0, 0, 0, 0, 0, 1, 1] };
  const WD_LABEL = { all: 'alle Tage', wk: 'Mo–Fr', we: 'Sa/So' };
  const fHM = new Intl.DateTimeFormat('de-DE', { hour: 'numeric', minute: 'numeric', hourCycle: 'h23', timeZone: TZ });
  const localMin = (t) => { const p = fHM.formatToParts(new Date(t * 1000)); return (+p.find((x) => x.type === 'hour').value % 24) * 60 + +p.find((x) => x.type === 'minute').value; };
  const shownTime = () => (S.k.isLive || !S.tl ? (S.live?.t || now()) : S.k.clock);
  function availBasis() {
    // time of day around the shown moment (its own setting, not the trips window)
    const B = shownTime();
    let t0 = 0, t1 = 0, label = 'ganzer Tag';
    if (S.o.tod > 0) {
      const c = Math.round(localMin(B) / 15) * 15, w = S.o.tod;
      t0 = (((c - w) % 1440) + 1440) % 1440; t1 = (c + w) % 1440;
      label = `${minToStr(t0)}–${t1 === 0 ? '24:00' : minToStr(t1)} Uhr`;
    }
    const idx = tlIndex || [];
    const last = idx.length ? lastDate() : isoLocal(B);
    const to = isoLocal(B) < last ? isoLocal(B) : last;
    const from = addDays(to, -(S.o.days - 1));
    const dates = idx.map((d) => d.date).filter((d) => d >= from && d <= to);
    return { F: { from, to, wd: WD_MASK[S.o.wd].map(Boolean), t0, t1, kind: 'all' }, dates, label, from, to };
  }
  function viewBBox() {
    const b = map.getBounds(), padLng = (b.getEast() - b.getWest()) * 0.15, padLat = (b.getNorth() - b.getSouth()) * 0.15;
    const r = (x) => Math.round(x * 500) / 500; // stable keys while panning a little
    return { s: r(b.getSouth() - padLat), n: r(b.getNorth() + padLat), w: r(b.getWest() - padLng), e: r(b.getEast() + padLng) };
  }
  // One computation at a time. Requests that come in meanwhile are not queued:
  // when it finishes, it runs once more with whatever is current then.
  let ovSeq = 0, ovTimer = 0, ovKey = '', ovInfo = null, ovBusy = false, ovAgain = false, ovForce = false;
  function scheduleOverlay(delay = 300) {
    if (!S.layers.avail || ovTimer) return;
    ovTimer = setTimeout(() => { ovTimer = 0; computeOverlay(); }, delay);
  }
  async function computeOverlay(force) {
    if (!S.layers.avail || !styleReady) return;
    if (ovBusy) { ovAgain = true; ovForce ||= !!force; return; }
    ovBusy = true;
    try { await runOverlay(force); } finally {
      ovBusy = false;
      if (ovAgain) { const f = ovForce; ovAgain = ovForce = false; computeOverlay(f); }
    }
  }
  async function runOverlay(force) {
    try { await ensureIndex(); } catch { ovInfo = { err: 'Noch kein Verlauf vorhanden.' }; renderCtx(); return; }
    const b = availBasis();
    // while playing: a quick, coarser preview; full quality once you stop
    const preview = S.k.playing;
    const res = preview ? Math.max(50, S.o.res) : S.o.res;
    const bb = res < 25 ? viewBBox() : null;
    const key = JSON.stringify([b.F, b.dates, S.o.metric, S.o.R, res, bb, preview]);
    if (!force && key === ovKey) return;
    ovKey = key;
    const seq = ++ovSeq;
    ovInfo = { ...(ovInfo || {}), busy: true, label: b.label };
    renderCtx();
    if (!b.dates.length) { clearRaster(); ovInfo = { err: 'Für diese Tage gibt es noch keine Daten.' }; renderCtx(); return; }
    try {
      const r = S.o.metric === 'density'
        ? await rpc('density', { F: b.F, dates: b.dates, res, smooth: Math.max(30, res * 2), stops: toStops(R.heat.slice(1), 0.25, 0.9), bb })
        : await rpc('reach', { F: b.F, dates: b.dates, res, metric: S.o.metric, R: S.o.R, classes: S.o.metric === 'prob' ? probClasses() : distClasses(), bb, preview });
      if (seq !== ovSeq) return;
      if (!r.polls) { clearRaster(); ovInfo = { err: `${b.label}: an diesen Tagen noch keine Abfragen.`, label: b.label }; }
      else { showRaster(r); ovInfo = { polls: r.polls, days: r.days, sampled: r.sampled, vmax: r.vmax, label: b.label, preview }; }
    } catch (err) { console.error(err); ovInfo = { err: 'Die Berechnung ist fehlgeschlagen.' }; }
    renderCtx();
    if (!preview && S.sel?.type === 'point') pointQuery(S.sel.lng, S.sel.lat, true);
  }

  // the raster goes to the map as a PNG blob URL (encoded off the main thread by toBlob)
  let rasterUrl = null, rasterSeq = 0;
  function showRaster(r) {
    const src = map.getSource('raster'); if (!src) return;
    const seq = ++rasterSeq;
    const b0 = r.bbox, coords = [[b0.w, b0.n], [b0.e, b0.n], [b0.e, b0.s], [b0.w, b0.s]];
    if (r.blob) { // encoded in the worker
      const url = URL.createObjectURL(r.blob);
      src.updateImage({ url, coordinates: coords });
      if (rasterUrl) setTimeout(URL.revokeObjectURL, 2000, rasterUrl);
      rasterUrl = url;
      return;
    }
    rasterCv.width = r.w; rasterCv.height = r.h;
    rasterCv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.rgba.buffer || r.rgba), r.w, r.h), 0, 0);
    const b = r.bbox;
    rasterCv.toBlob((blob) => {
      if (seq !== rasterSeq || !blob) return;
      const url = URL.createObjectURL(blob);
      src.updateImage({ url, coordinates: [[b.w, b.n], [b.e, b.n], [b.e, b.s], [b.w, b.s]] });
      if (rasterUrl) setTimeout(URL.revokeObjectURL, 2000, rasterUrl);
      rasterUrl = url;
    });
  }
  function clearRaster() { rasterSeq++; ovKey = ''; map?.getSource('raster')?.updateImage({ url: PIXEL }); }

  function availLegend() {
    if (S.o.metric === 'prob') return { cap: `Chance auf ein Rad im Umkreis von ${S.o.R} m`, body: stepLegend(STEPS.slice().reverse(), PROB_CLASSES.map((c) => c[1])) };
    if (S.o.metric === 'median') return { cap: 'Typischer Weg zum nächsten Rad (Luftlinie)', body: stepLegend(STEPS, DIST_CLASSES.map((c) => c[1]), DIST_CLASSES.map((c) => `~${c[2]} Min.`)) };
    return { cap: 'Abgestellte Räder pro Hektar, im Schnitt', body: `<div class="bar" style="background:${gradient(R.heat.slice(1))}"></div><div class="scale"><span>wenige</span><span>${ovInfo?.vmax ? `${nf1.format(ovInfo.vmax)} pro ha` : 'viele'}</span></div>` };
  }
  // line thickness by trips per street section: three samples up to the current maximum
  function widthLegend() {
    if (tripMax < 2) return '';
    const ns = [...new Set([1, Math.round(Math.sqrt(tripMax)), tripMax])];
    // numbers only inside <b>, so scrubbing patches them without relayout
    const load = tripLoad == null ? '' : `<span>Betrieb: <b>${nf.format(Math.round(tripLoad * 100))} %</b> vom Durchschnitt, danach richten sich Dicke und Helligkeit</span>`;
    return `<div class="wleg"><span>Dicke</span>${ns.map((n) => { const w = wOf(n, tripRef);
      return `<i style="height:${(1.4 + 0.95 * w).toFixed(1)}px;opacity:${(0.4 + 0.6 * (w / (W_CLS - 1))).toFixed(2)}"></i><b>${nf.format(n)}</b>`; }).join('')}<span>Fahrten</span></div>${load ? `<div class="wleg sub">${load}</div>` : ''}`;
  }
  function tripLegend() {
    if (S.o.color === 'dir') return `<div class="tleg"><span>Start</span><i class="stop s"></i><div class="grad"></div><i class="stop e"></i><span>Ziel</span></div>${widthLegend()}`;
    if (S.o.color === 'freq') return `<div class="bar" style="background:${gradient(R.freq)}"></div><div class="grad-scale"><span>1 Fahrt</span><span>${tripMax > 1 ? `${nf.format(tripMax)} Fahrten` : 'mehr'} pro Abschnitt</span></div>`;
    return `<div class="durs">${DUR_LABELS.map((l, k) => `<div><i style="background:${C.dur[k]}"></i><span>${l}</span></div>`).join('')}</div>${widthLegend()}`;
  }
  // the trips window as clock times, e.g. "17:22–18:22" or "Mo 18:22 – Di 18:22"
  function winRange() {
    const t1 = S.k.clock, t0 = t1 - S.o.win * 60, sameDay = isoLocal(t0) === isoLocal(t1);
    const hm = (t) => fTime.format(new Date(t * 1000)), wd = (t) => fWd.format(new Date(t * 1000));
    return sameDay ? `${hm(t0)}–${hm(t1)}` : `${wd(t0)} ${hm(t0)} – ${wd(t1)} ${hm(t1)}`;
  }
  const fWd = new Intl.DateTimeFormat('de-DE', { weekday: 'short', timeZone: 'Europe/Berlin' });
  const winText = () => (S.o.win >= 1440 ? '24 Std.' : S.o.win >= 60 ? `${S.o.win / 60} Std.` : `${S.o.win} Min.`);

  // the line under the layer chips: what the map shows right now
  function renderCtx() {
    const el = $('#ctx'); if (!el) return;
    const parts = [];
    if (S.layers.trips && S.trips) {
      const s = tripSum;
      const bits = [`<b>${nf.format(s.arrived)}</b> angekommen`];
      if (!S.k.isLive) bits.push(`<b>${nf.format(s.running)}</b> unterwegs`);
      else if (S.o.away) bits.push(`<b>${nf.format(s.away)}</b> losgefahren, noch unterwegs`);
      parts.push(`<p class="line">Fahrten ${winRange()}: ${bits.join(', ')}. Heute bisher <b>${nf.format(s.today)}</b>.</p><div class="legend">${tripLegend()}</div>`);
    }
    if (S.layers.avail) {
      const o = ovInfo || {};
      const lg = availLegend();
      const basis = o.err ? `<span class="warn-t">${esc(o.err)}</span>`
        : `${o.label || ''}, ${S.o.days} Tage, ${WD_LABEL[S.o.wd]}${o.polls ? ` · ${nf.format(o.polls)} Abfragen${o.sampled > o.polls ? ' (Stichprobe)' : ''}` : ''}${o.preview ? ' · Vorschau, volle Qualität nach dem Anhalten' : ''}`;
      parts.push(`<div class="legend"><div class="top"><div class="cap">${lg.cap}</div>${o.busy ? '<span class="busy">rechnet</span>' : ''}</div>${lg.body}</div>
        <div class="line hint-l">${basis}. Ort antippen für Details.</div>`);
    }
    const html = parts.join('');
    if (html === lastCtx) return;
    // while scrubbing usually only the numbers change: patch them, no relayout of the panel
    const skel = html.replace(/<b>[^<]*<\/b>/g, '<b></b>');
    if (skel === lastSkel) {
      const vals = [...html.matchAll(/<b>([^<]*)<\/b>/g)].map((m) => m[1]), bs = el.querySelectorAll('b');
      if (bs.length === vals.length) { bs.forEach((b, i) => { if (b.textContent !== vals[i]) b.textContent = vals[i]; }); lastCtx = html; return; }
    }
    el.innerHTML = lastCtx = html; lastSkel = skel;
    refreshSheet();
  }
  let lastCtx = null, lastSkel = null;

  // ---- point and station queries
  function circle([lng, lat], r) {
    const pts = [];
    for (let k = 0; k <= 64; k++) {
      const a = (k / 64) * 2 * Math.PI;
      pts.push([lng + (r * Math.cos(a)) / (111320 * Math.cos((lat * Math.PI) / 180)), lat + (r * Math.sin(a)) / 111320]);
    }
    return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [pts] }, properties: {} };
  }
  function nearestStationName(lng, lat) {
    let best = null, bd = Infinity;
    for (const s of S.live?.stations || []) { const d = hav(lat, lng, s.lat, s.lng); if (d < bd) { bd = d; best = s; } }
    return best ? (bd > 600 ? `nahe ${best.name}` : best.name) : `${nf1.format(lat)}, ${nf1.format(lng)}`;
  }

  async function pointQuery(lng, lat, quiet) {
    S.sel = { type: 'point', lng, lat };
    const Rq = S.o.R;
    setData('qpt', { type: 'FeatureCollection', features: [circle([lng, lat], Rq), { type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: {} }] });
    applyVisibility();
    if (!quiet) showDetail('#detail', '<p class="kicker">Ausgewählter Ort</p><h3>…</h3><span class="busy">rechnet</span>', { keepSel: true });
    try { await ensureIndex(); } catch { return; }
    const b = availBasis();
    if (!b.dates.length) return;
    const r = await rpc('point', { F: b.F, dates: b.dates, lat, lng, R: Rq });
    if (S.sel?.type !== 'point' || S.sel.lng !== lng) return;
    const w = r.win, ha = (Math.PI * Rq * Rq) / 10000;
    const chance = w ? `${Math.round(w.pct)} %` : '–', walk = r.nearestMedian != null ? fmtDist(r.nearestMedian) : '–', dens = w ? `${nf1.format(w.avg / ha)} pro ha` : '–';
    const head = { prob: chance, median: walk, density: dens }[S.o.metric];
    const sub = { prob: `Chance auf ein Rad im Umkreis von ${Rq} m`, median: 'typischer Weg zum nächsten Rad (Luftlinie)', density: `Räder pro Hektar (im Umkreis von ${Rq} m)` }[S.o.metric];
    const densMode = S.o.metric === 'density';
    const vals = (o) => (densMode ? o.avg.map((v) => (v == null ? null : v / ha)) : o.pct);
    showDetail('#detail', `
      <p class="kicker">${esc(nearestStationName(lng, lat))}</p>
      <h3>${head}</h3>
      <p class="hint">${sub}, ${b.label}, letzte ${S.o.days} Tage, ${WD_LABEL[S.o.wd]}.${w ? ` Grundlage: ${nf.format(w.n)} Abfragen.` : ' Keine Abfrage in diesem Zeitfenster.'}</p>
      ${w ? `<dl class="kv"><dt>Chance im Umkreis ${Rq} m</dt><dd>${chance}</dd><dt>Laufweg (Median)</dt><dd>${walk}</dd><dt>Räder pro Hektar</dt><dd>${dens}</dd></dl>` : ''}
      ${lineChart({ title: densMode ? 'Räder pro Hektar' : `Chance auf ein Rad im Umkreis von ${Rq} m`, sub: 'über den Tag', unit: densMode ? '' : '%', yMax: densMode ? null : 100,
        series: [{ name: WD_LABEL[S.o.wd], color: C.wd, values: vals(r.sel) }, ...(S.o.wd !== 'all' ? [{ name: 'alle Tage', color: C.muted, values: vals(r.all) }] : [])],
        band: [b.F.t0, b.F.t1] })}
      <div class="actions"><button class="btn sm ghost" data-act="clearpoint">Auswahl aufheben</button></div>`, { keepSel: true, quiet });
  }

  async function stationQuery(uid, target) {
    await ensureIndex();
    const b = availBasis();
    const r = await rpc('stationProfile', { F: { ...b.F, t0: 0, t1: 0 }, dates: b.dates, uid: String(uid), k: 0 });
    const el = $(target); if (!el) return;
    if (!r) { el.innerHTML = '<p class="hint">Für diese Station gibt es noch keine Auswertung.</p>'; return; }
    const m = localMin(shownTime());
    el.innerHTML = `${lineChart({ title: 'Räder im Tagesverlauf', sub: 'Durchschnitt', series: [{ name: WD_LABEL[S.o.wd], color: C.wd, values: r.sel.avg }], band: [m, Math.min(1439, m + 15)] })}
      ${lineChart({ title: 'Chance, dass sie leer ist', unit: '%', yMax: 100, series: [{ name: WD_LABEL[S.o.wd], color: C.wd, values: r.sel.p }], band: [m, Math.min(1439, m + 15)] })}
      <p class="hint">Letzte ${S.o.days} Tage, ${WD_LABEL[S.o.wd]} (einstellbar unter Verfügbarkeit).</p>`;
    bindCharts(el);
  }

  // ================================================================ statistics (lazy: only while opened)
  const IDLE_TICKS = [[3600, '1 Std.'], [6 * 3600, '6 Std.'], [86400, '1 Tag'], [3 * 86400, '3 Tage']];
  const idleL = (s) => Math.min(1, Math.max(0, Math.log(Math.max(s, 600) / 600) / Math.log((14 * 86400) / 600)));
  let statsSeq = 0;
  async function renderStats() {
    const box = $('#statsOut');
    if (!box || !secOpen('secStats')) return;
    box.innerHTML = '<span class="busy">rechnet</span>';
    try { await ensureIndex(); } catch { box.innerHTML = '<p class="hint">Noch kein Verlauf vorhanden.</p>'; return; }
    const to = lastDate(), from = addDays(to, -6);
    const dates = tlIndex.map((d) => d.date).filter((d) => d >= from && d <= to);
    const seq = ++statsSeq;
    const r = await rpc('usage', { F: { from, to, wd: Array(7).fill(true), t0: 0, t1: 0, kind: 'all' }, dates, P: tripParams() });
    if (seq !== statsSeq) return;
    const dur = r.durH, dist = r.distH;
    const idle = (S.live?.bikes || []).filter((b) => b.since).map((b) => Math.max(0, now() - b.since));
    box.innerHTML = `<p class="hint">Letzte ${dates.length} ${dates.length === 1 ? 'Tag' : 'Tage'} (${fmtD(from)}–${fmtD(to)}), alle geschätzt.</p>
      <div class="tiles">
        <div class="stat"><b>${r.perDay != null ? nf.format(Math.round(r.perDay)) : '–'}</b><span>Fahrten pro Tag</span></div>
        <div class="stat"><b>${r.medDur != null ? `${nf.format(Math.round(r.medDur))} min` : '–'}</b><span>Dauer, Median</span></div>
        <div class="stat"><b>${r.medDist != null ? fmtDist(r.medDist) : '–'}</b><span>Strecke, Median</span></div></div>
      ${lineChart({ title: 'Räder unterwegs nach Uhrzeit', sub: 'Durchschnitt', series: [{ name: 'alle Tage', color: C.trip, values: r.inuseH }] })}
      ${lineChart({ title: 'Fahrtbeginne pro Stunde', sub: 'Durchschnitt', series: [{ name: 'alle Tage', color: C.trip, values: r.perHour }] })}
      ${timeChart({ title: 'Räder unterwegs', t: r.series.t, values: r.series.inuse, color: C.trip })}
      ${barChart({ title: 'Fahrtdauer', sub: `${nf.format(r.count - r.short)} mit messbarer Dauer`, values: dur,
        labels: dur.map((_, k) => (k === dur.length - 1 ? 'über 2 Std.' : `${k * 5}–${k * 5 + 5} min`)), tickEvery: 6, tickLabel: (k) => (k === dur.length - 1 ? '' : `${k * 5}`), unitX: 'min' })}
      ${barChart({ title: 'Strecke (Luftlinie)', sub: `${nf.format(r.count)} Fahrten`, values: dist,
        labels: dist.map((_, k) => (k === dist.length - 1 ? 'über 8 km' : `${nf1.format(k * 0.25)}–${nf1.format(k * 0.25 + 0.25)} km`)), tickEvery: 4, tickLabel: (k) => (k === dist.length - 1 ? '' : nf1.format(k * 0.25)), unitX: 'km' })}
      ${idle.length ? survivalChart(idle) : ''}
      <p class="hint">Nicht als Fahrt gezählt: ${nf.format(r.service)} Abwesenheiten über ${nf1.format(S.o.maxDurH)} Std., ${nf.format(r.round)} Rückkehren an denselben Ort${r.unclear ? `, ${nf.format(r.unclear)} Bewegungen über eine Abfragelücke von mehr als einer Stunde` : ''}${r.glitch ? ` und ${nf.format(r.glitch)} Sprünge schneller als ${nf.format(S.o.maxKmh)} km/h (GPS-Fehler)` : ''}.</p>`;
    bindCharts(box);
  }

  // share of bikes untouched for at least x (log x axis, 10 min to 14 days)
  function survivalChart(vals) {
    const H = 150, L = 34, Rr = 12, T = 10, B = 24, w = CW - L - Rr, h = H - T - B;
    const n = vals.length, sorted = vals.slice().sort((a, b) => a - b);
    const xs = [];
    for (let k = 0; k <= 60; k++) xs.push(600 * ((14 * 86400) / 600) ** (k / 60));
    const share = xs.map((x) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < x) lo = m + 1; else hi = m; } return ((n - lo) / n) * 100; });
    const X = (x) => L + idleL(x) * w, Y = (v) => T + h - (v / 100) * h;
    const d = xs.map((x, k) => `${k ? 'L' : 'M'}${X(x).toFixed(1)},${Y(share[k]).toFixed(1)}`).join('');
    const grid = [0, 50, 100].map((v) => `<line x1="${L}" x2="${L + w}" y1="${Y(v)}" y2="${Y(v)}"/>`).join('');
    const ylab = [0, 50, 100].map((v) => `<text x="${L - 6}" y="${Y(v) + 3.5}" text-anchor="end">${v} %</text>`).join('');
    const xlab = `<text x="${L}" y="${H - 6}">10 Min.</text>` + IDLE_TICKS.map(([s, l]) => `<text x="${X(s)}" y="${H - 6}" text-anchor="middle">${l}</text>`).join('') + `<text x="${L + w}" y="${H - 6}" text-anchor="end">14 Tage</text>`;
    const id = `c${++chartSeq}`;
    chartData.set(id, { kind: 'surv', xs, share, X, L, w });
    return `<div class="chart" data-chart="${id}"><div class="chart-title"><h2>Wie lange stehen die Räder schon?</h2><span>${nf.format(n)} Räder, jetzt</span></div>
      <p class="hint chart-note">Anteil der Räder, die mindestens so lange unbewegt sind</p>
      <svg viewBox="0 0 ${CW} ${H}" role="img" aria-label="Verteilung der Standzeiten"><g class="grid">${grid}</g><g class="axis">${ylab}${xlab}</g>
      <path d="${d}" fill="none" stroke="${C.trip}" stroke-width="2" stroke-linejoin="round"/>
      <line class="xh" x1="0" x2="0" y1="${T}" y2="${T + h}" stroke="${C.muted}" stroke-width="1" visibility="hidden"/>
      <rect class="hit" x="${L}" y="${T}" width="${w}" height="${h}"/></svg></div>`;
  }

  // ================================================================ settings
  const FMT = { minGone: (v) => `${v} m`, jump: (v) => `${v} m`, maxDurH: (v) => `${nf1.format(v)} Std.`, maxKmh: (v) => `${v} km/h` };
  function slider(id, label, min, max, step, val, fmt) {
    return `<div class="row"><h3><label for="${id}">${label}</label><output id="${id}-o">${fmt(val)}</output></h3>
      <input class="slider" type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}" data-param="${id.replace('p-', '')}"></div>`;
  }
  function renderTripParams() {
    const o = S.o;
    $('#tripParamsOut').innerHTML = `<div class="filters">
      ${slider('p-minGone', 'Rad verschwindet und taucht mindestens so weit entfernt wieder auf', 50, 1000, 50, o.minGone, FMT.minGone)}
      ${slider('p-jump', 'oder springt zwischen zwei Abfragen weiter als', 100, 2000, 100, o.jump, FMT.jump)}
      ${slider('p-maxDurH', 'Länger weg = Werkstatt oder Umverteilung', 0.5, 12, 0.5, o.maxDurH, FMT.maxDurH)}
      ${slider('p-maxKmh', 'Schneller als das = GPS-Fehler (gerechnet mit der längstmöglichen Dauer)', 50, 500, 10, o.maxKmh, FMT.maxKmh)}</div>
      <p class="hint">Bewegungen über eine Abfragelücke von mehr als einer Stunde werden nie gezählt, weil der Zeitpunkt unklar ist.</p>`;
    let t = 0;
    $$('#tripParamsOut input[data-param]').forEach((inp) => inp.addEventListener('input', () => {
      const k = inp.dataset.param;
      S.o[k] = +inp.value; saveO();
      $(`#${inp.id}-o`).textContent = FMT[k](inp.value);
      $('#sumParams').textContent = `${S.o.minGone} m · ${S.o.jump} m · ${nf1.format(S.o.maxDurH)} Std. · ${S.o.maxKmh} km/h`;
      clearTimeout(t);
      t = setTimeout(() => { if (S.tl) loadTrips(S.tl); renderStats(); }, 350);
    }));
  }
  const COLOR_LABEL = { dir: 'Start → Ziel', dur: 'Dauer', freq: 'Häufigkeit' };
  const METRIC_LABEL = { prob: 'Chance', median: 'Laufweg', density: 'Räder/ha' };
  const TOD_LABEL = { 30: '± 30 Min.', 60: '± 1 Std.', 180: '± 3 Std.', 0: 'ganzer Tag' };
  const secOpen = (id) => $(`#${id} .sec-h`)?.getAttribute('aria-expanded') === 'true';
  function syncSettings() {
    for (const g of $$('[data-set]')) {
      const k = g.dataset.set;
      for (const b of $$('button', g)) b.setAttribute('aria-checked', String(String(S.o[k]) === b.dataset.v));
    }
    const ri = R_STEPS.indexOf(S.o.R) >= 0 ? R_STEPS.indexOf(S.o.R) : 3;
    $('#setR').value = ri; $('#setR-o').textContent = `${R_STEPS[ri]} m`;
    $('#setDays').value = S.o.days; $('#setDays-o').textContent = `${S.o.days} Tage`;
    // one-line summaries on the closed sections
    $('#sumTrips').textContent = `Farbe: ${COLOR_LABEL[S.o.color]}`;
    $('#sumAvail').textContent = [METRIC_LABEL[S.o.metric], S.o.metric === 'median' ? null : `${S.o.R} m`, TOD_LABEL[S.o.tod], `${S.o.days} Tage`].filter(Boolean).join(' · ');
    $('#sumTl').textContent = $('#tlSpan [aria-checked="true"]')?.textContent.trim() || '';
    $('#sumParams').textContent = `${S.o.minGone} m · ${S.o.jump} m · ${nf1.format(S.o.maxDurH)} Std. · ${S.o.maxKmh} km/h`;
    $('#winRow').hidden = !S.layers.trips;
    $('#todRow').hidden = !S.layers.avail;
    $('#setAway').checked = !!S.o.away;
    $$('[data-hint-for]').forEach((el) => { el.hidden = el.dataset.hintFor !== S.o.color; });
    $('#rowR').hidden = S.o.metric === 'median';
    $('#resHint').textContent = S.o.res < 25 ? '10 m rechnet nur den sichtbaren Ausschnitt und weniger Abfragen; genauer als etwa 25 m sind die Daten nicht.' : '';
    renderCtx();
  }
  const availChanged = () => { if (!S.layers.avail) setLayer('avail', true); else computeOverlay(true); };
  function bindSettings() {
    // segmented settings, in the sections and under the timeline
    $('#panel').addEventListener('click', (e) => {
      const b = e.target.closest('[data-set] button'); if (!b) return;
      const k = b.closest('[data-set]').dataset.set, v = b.dataset.v;
      S.o[k] = ['win', 'res', 'tod'].includes(k) ? +v : v;
      saveO(); syncSettings();
      if (k === 'win') { renderTrips(S.k.clock); updateWinBand(); } // trips only; availability has its own time of day
      else if (k === 'color') { applyVisibility(); renderTrips(S.k.clock); }
      else { availChanged(); updateWinBand(); }
    });
    // sliders: label follows while dragging, the map is recomputed when you let go
    $('#setR').addEventListener('input', (e) => { S.o.R = R_STEPS[+e.target.value]; $('#setR-o').textContent = `${S.o.R} m`; });
    $('#setDays').addEventListener('input', (e) => { S.o.days = +e.target.value; $('#setDays-o').textContent = `${S.o.days} Tage`; });
    for (const id of ['#setR', '#setDays']) $(id).addEventListener('change', () => { saveO(); syncSettings(); availChanged(); });
    $('#setAway').addEventListener('change', (e) => { S.o.away = e.target.checked; saveO(); renderTrips(S.k.clock); });
    // sections open and close; Statistik and Fahrt-Erkennung are built when opened
    $$('.sec-h').forEach((h) => h.addEventListener('click', () => {
      const open = h.getAttribute('aria-expanded') !== 'true';
      h.setAttribute('aria-expanded', String(open));
      h.nextElementSibling.hidden = !open;
      const id = h.parentElement.id;
      if (open && id === 'secStats') renderStats();
      if (open && id === 'secParams') renderTripParams();
      if (open && !isDesktop() && (sheetState === 'peek' || sheetState === 'mini')) setSheet('half');
      if (open) requestAnimationFrame(() => revealEl(h.parentElement));
    }));
  }
  function setLayer(k, on) {
    S.layers[k] = on;
    const c = $(`#layers [data-layer="${k}"]`);
    if (c) { c.classList.toggle('on', on); c.setAttribute('aria-pressed', String(on)); }
    if (k === 'avail') {
      if (on) computeOverlay(true);
      else { clearRaster(); ovInfo = null; S.sel = S.sel?.type === 'point' ? null : S.sel; setData('qpt', EMPTY); }
    }
    $('#winRow').hidden = !S.layers.trips;
    $('#todRow').hidden = !S.layers.avail;
    updateWinBand();
    applyVisibility(); renderTrips(S.k.clock); renderCtx();
  }

  // ================================================================ detail card
  function showDetail(sel, html, opts = {}) {
    const el = $(sel);
    el.innerHTML = `<button class="x" type="button" aria-label="Schließen" data-act="close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>${html}`;
    el.hidden = false;
    $('#panel').classList.add('has-detail'); // the detail takes the place of layers and settings
    bindCharts(el);
    if (!opts.keepSel) S.sel = null;
    if (!opts.quiet) {
      if (!isDesktop() && sheetState === 'peek') setSheet('half');
      requestAnimationFrame(() => revealEl(el));
    }
  }
  // scroll the panel so el is visible below the (desktop: sticky) controls
  function revealEl(el, force) {
    const sc = $('#scroll');
    const peek = isDesktop() ? $(`.mode[data-mode="${S.mode}"] .peek`).offsetHeight : 0;
    const rel = el.getBoundingClientRect().top - sc.getBoundingClientRect().top;
    const visible = isDesktop() ? sc.clientHeight : sheetVisibleHeight() - $('#grab').offsetHeight - $('#head').offsetHeight;
    if (!force && rel >= peek && rel < visible - 140) return;
    sc.scrollTo({ top: Math.max(0, sc.scrollTop + rel - peek - 8), behavior: REDUCED ? 'auto' : 'smooth' });
  }
  function closeDetail(silent) {
    for (const el of $$('.detail')) { el.hidden = true; el.innerHTML = ''; }
    $('#panel').classList.remove('has-detail');
    S.sel = null;
    if (S.hist || S.histWant) { S.hist = null; S.histWant = null; S.histToken = null; if (styleReady) setData('hist', EMPTY); }
    if (styleReady) { select(null); setData('qpt', EMPTY); applyVisibility(); }
    if (!silent && !isDesktop() && sheetState === 'half') setSheet('peek');
  }

  // ================================================================ charts
  const CW = 340;
  function niceMax(v) {
    if (!(v > 0)) return 1;
    const p = 10 ** Math.floor(Math.log10(v)), f = v / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }
  let chartSeq = 0;
  const chartData = new Map();
  const noData = (title) => `<div class="chart"><div class="chart-title"><h2>${title}</h2></div><p class="hint">Noch keine Daten.</p></div>`;

  // one day (24 hours or 96 quarter hours); band = [t0, t1] minutes
  function lineChart({ title, sub, series, unit = '', yMax, band }) {
    const H = 150, L = 32, multi = series.length > 1, Rr = multi ? 64 : 10, T = 10, B = 22, w = CW - L - Rr, h = H - T - B;
    const n = series[0].values.length, perH = n / 24;
    const all = series.flatMap((s) => s.values).filter((v) => v != null);
    if (!all.length) return noData(title);
    const ymax = yMax ?? niceMax(Math.max(...all) * 1.08);
    const X = (i) => L + ((i + 0.5) / n) * w, Y = (v) => T + h - (v / ymax) * h, XM = (min) => L + (min / 1440) * w;
    const grid = [0, 0.5, 1].map((f) => `<line x1="${L}" x2="${L + w}" y1="${Y(ymax * f)}" y2="${Y(ymax * f)}"/>`).join('');
    const ylab = [0, 0.5, 1].map((f) => `<text x="${L - 6}" y="${Y(ymax * f) + 3.5}" text-anchor="end">${nf1.format(ymax * f)}${f === 1 ? unit : ''}</text>`).join('');
    const xlab = [0, 6, 12, 18, 24].map((hh) => `<text x="${XM(hh * 60)}" y="${H - 5}" text-anchor="${hh === 0 ? 'start' : hh === 24 ? 'end' : 'middle'}">${hh}</text>`).join('');
    let bandSvg = '';
    if (band && band[0] !== band[1]) {
      const [b0, b1] = band;
      const rect = (x0, x1) => `<rect class="band" x="${XM(x0)}" y="${T}" width="${Math.max(1, XM(x1) - XM(x0))}" height="${h}"/>`;
      bandSvg = b0 < b1 ? rect(b0, b1) : rect(b0, 1440) + rect(0, b1);
    }
    const paths = series.map((s) => {
      let d = '', pen = false;
      s.values.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`; pen = true; });
      return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    }).reverse().join('');
    let labels = '';
    if (multi) {
      const ends = series.map((s) => { let i = s.values.length - 1; while (i >= 0 && s.values[i] == null) i--; return i < 0 ? null : { s, y: Y(s.values[i]) }; }).filter(Boolean);
      ends.sort((a, b) => a.y - b.y);
      for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 13) ends[k].y = ends[k - 1].y + 13;
      labels = ends.map((e) => `<circle cx="${L + w + 7}" cy="${e.y}" r="3.5" fill="${e.s.color}"/><text class="dl" x="${L + w + 14}" y="${e.y + 4}">${esc(e.s.name)}</text>`).join('');
    }
    const id = `c${++chartSeq}`;
    chartData.set(id, { kind: 'day', series, X, L, w, n, unit,
      fmt: (i) => (perH === 1 ? `${i}–${i + 1} Uhr` : `${minToStr(i * (1440 / n))}–${minToStr((i + 1) * (1440 / n))}`) });
    return `<div class="chart" data-chart="${id}"><div class="chart-title"><h2>${title}</h2>${sub ? `<span>${esc(sub)}</span>` : ''}</div>
      <svg viewBox="0 0 ${CW} ${H}" role="img" aria-label="${esc(title)}">
        <g class="grid">${grid}</g>${bandSvg}<g class="axis">${ylab}${xlab}</g>${paths}${labels}
        <line class="xh" x1="0" x2="0" y1="${T}" y2="${T + h}" stroke="${C.muted}" stroke-width="1" visibility="hidden"/>
        <rect class="hit" x="${L}" y="${T}" width="${w}" height="${h}"/></svg></div>`;
  }

  function timeChart({ title, t, values, color }) {
    if (!t || t.length < 2) return noData(title);
    const H = 140, L = 32, Rr = 10, T = 10, B = 22, w = CW - L - Rr, h = H - T - B;
    const ts = t[0], te = t[t.length - 1], span = Math.max(1, te - ts);
    const ymax = niceMax(Math.max(...values) * 1.08);
    const X = (x) => L + ((x - ts) / span) * w, Y = (v) => T + h - (v / ymax) * h;
    const d = values.map((v, i) => `${i ? 'L' : 'M'}${X(t[i]).toFixed(1)},${Y(v).toFixed(1)}`).join('');
    const days = [];
    for (let x = ts - (ts % 3600) + 3600; x <= te; x += 3600) if (localHour(x) === 0) days.push(x);
    const grid = [0, 0.5, 1].map((f) => `<line x1="${L}" x2="${L + w}" y1="${Y(ymax * f)}" y2="${Y(ymax * f)}"/>`).join('')
      + days.map((x) => `<line x1="${X(x)}" x2="${X(x)}" y1="${T}" y2="${T + h}"/>`).join('');
    const ylab = [0, 0.5, 1].map((f) => `<text x="${L - 6}" y="${Y(ymax * f) + 3.5}" text-anchor="end">${nf.format(ymax * f)}</text>`).join('');
    const xlab = span < 2 * 86400
      ? [0, 0.5, 1].map((f) => `<text x="${L + f * w}" y="${H - 5}" text-anchor="${f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}">${fTime.format(new Date((ts + f * span) * 1000))}</text>`).join('')
      : days.map((x) => `<text x="${X(x + 43200)}" y="${H - 5}" text-anchor="middle">${fDay.format(new Date((x + 43200) * 1000))}</text>`).filter((_, k, a) => a.length < 9 || k % 2 === 0).join('');
    const id = `c${++chartSeq}`;
    chartData.set(id, { kind: 'time', t, values, X, L, w });
    return `<div class="chart" data-chart="${id}"><div class="chart-title"><h2>${title}</h2><span>geschätzt</span></div>
      <svg viewBox="0 0 ${CW} ${H}" role="img" aria-label="${esc(title)}"><g class="grid">${grid}</g><g class="axis">${ylab}${xlab}</g>
      <path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
      <line class="xh" x1="0" x2="0" y1="${T}" y2="${T + h}" stroke="${C.muted}" stroke-width="1" visibility="hidden"/>
      <rect class="hit" x="${L}" y="${T}" width="${w}" height="${h}"/></svg></div>`;
  }

  function barChart({ title, sub, values, labels, tickEvery, tickLabel, unitX }) {
    if (!values.some((v) => v > 0)) return noData(title);
    const H = 130, L = 32, Rr = 6, T = 8, B = 22, w = CW - L - Rr, h = H - T - B;
    const n = values.length, bw = w / n, ymax = niceMax(Math.max(...values) * 1.05);
    const Y = (v) => T + h - (v / ymax) * h;
    const bars = values.map((v, i) => {
      if (!v) return '';
      const x = L + i * bw + 1, bwid = Math.max(1, bw - 2), y = Y(v), r = Math.min(3, bwid / 2, T + h - y);
      return `<path d="M${x},${T + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + bwid - r}Q${x + bwid},${y} ${x + bwid},${y + r}V${T + h}Z" fill="${C.trip}"/>`;
    }).join('');
    const grid = [0, 0.5, 1].map((f) => `<line x1="${L}" x2="${L + w}" y1="${Y(ymax * f)}" y2="${Y(ymax * f)}"/>`).join('');
    const ylab = [0.5, 1].map((f) => `<text x="${L - 6}" y="${Y(ymax * f) + 3.5}" text-anchor="end">${nf.format(ymax * f)}</text>`).join('');
    const xlab = values.map((_, i) => (i % tickEvery === 0 && tickLabel(i) !== '' ? `<text x="${L + i * bw}" y="${H - 5}" text-anchor="${i === 0 ? 'start' : 'middle'}">${tickLabel(i)}</text>` : '')).join('')
      + `<text x="${L + w}" y="${H - 5}" text-anchor="end">${unitX}</text>`;
    const id = `c${++chartSeq}`;
    chartData.set(id, { kind: 'bar', values, labels, L, w, n });
    return `<div class="chart" data-chart="${id}"><div class="chart-title"><h2>${title}</h2>${sub ? `<span>${sub}</span>` : ''}</div>
      <svg viewBox="0 0 ${CW} ${H}" role="img" aria-label="${esc(title)}"><g class="grid">${grid}</g><g class="axis">${ylab}${xlab}</g>${bars}
      <rect class="hit" x="${L}" y="${T}" width="${w}" height="${h}"/></svg></div>`;
  }

  let tipTimer = 0;
  function bindCharts(root) {
    for (const el of $$('.chart[data-chart]', root)) {
      if (el.dataset.bound) continue;
      el.dataset.bound = '1';
      const svg = $('svg', el), d = chartData.get(el.dataset.chart);
      if (!d) continue;
      const xh = $('.xh', svg);
      const hide = () => { $('#tip').hidden = true; if (xh) xh.setAttribute('visibility', 'hidden'); };
      const handler = (e) => {
        const r = svg.getBoundingClientRect();
        const x = ((e.clientX - r.left) / r.width) * CW;
        let html = '', cx = 0;
        if (d.kind === 'day') {
          const i = Math.floor(((x - d.L) / d.w) * d.n);
          if (i < 0 || i >= d.n) return;
          cx = d.X(i);
          html = `${d.fmt(i)}: ${d.series.map((s) => `${d.series.length > 1 ? `${s.name} ` : ''}${s.values[i] == null ? '–' : nf1.format(s.values[i]) + d.unit}`).join(', ')}`;
        } else if (d.kind === 'time') {
          const tt = d.t[0] + ((x - d.L) / d.w) * (d.t[d.t.length - 1] - d.t[0]);
          let i = 0; for (let k = 0; k < d.t.length; k++) if (Math.abs(d.t[k] - tt) < Math.abs(d.t[i] - tt)) i = k;
          cx = d.X(d.t[i]);
          html = `${fmtWhen(d.t[i])}: ${nf.format(d.values[i])} unterwegs`;
        } else if (d.kind === 'surv') {
          let i = 0; for (let k = 0; k < d.xs.length; k++) if (Math.abs(d.X(d.xs[k]) - x) < Math.abs(d.X(d.xs[i]) - x)) i = k;
          cx = d.X(d.xs[i]);
          html = `${Math.round(d.share[i])} % stehen länger als ${fmtDur(d.xs[i])}`;
        } else {
          const i = Math.floor(((x - d.L) / d.w) * d.n);
          if (i < 0 || i >= d.n) return;
          html = `${d.labels[i]}: ${nf.format(d.values[i])} Fahrten`;
        }
        if (xh) { xh.setAttribute('x1', cx); xh.setAttribute('x2', cx); xh.setAttribute('visibility', 'visible'); }
        const tip = $('#tip');
        tip.textContent = html; tip.hidden = false;
        tip.style.left = `${Math.min(Math.max(e.clientX, 110), innerWidth - 110)}px`;
        tip.style.top = `${r.top + 4}px`;
        clearTimeout(tipTimer);
        if (e.pointerType !== 'mouse') tipTimer = setTimeout(hide, 2500);
      };
      svg.addEventListener('pointermove', handler);
      svg.addEventListener('pointerdown', handler);
      svg.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hide(); });
    }
  }

  // ================================================================ events
  // last poll at or before t (binary search)
  const frameAt = (t) => { const T = S.tl; let lo = T.i0, hi = T.t.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (T.t[m] <= t) lo = m; else hi = m - 1; } return lo; };
  const nearestFrame = (t) => { const T = S.tl; let best = 0; for (let i = 0; i < T.t.length; i++) if (Math.abs(T.t[i] - t) < Math.abs(T.t[best] - t)) best = i; return best; };

  async function reloadTimeline() {
    stopPlay();
    $('#tlRange').disabled = true;
    try {
      await ensureTimeline();
      const end = $('#tlEnd');
      end.min = firstDate(); end.max = lastDate(); end.value = S.k.end || lastDate();
      if (S.k.end && S.k.end < lastDate()) { S.k.isLive = false; S.k.frame = S.tl.t.length - 1; }
      setupScrubber(); renderKarte(true); updateStatus();
    } catch (err) {
      console.warn(err);
      $('#tlDate').textContent = 'Live (noch kein Verlauf)';
    }
  }

  function bindUI() {
    $$('#layers [data-layer]').forEach((c) => c.addEventListener('click', () => setLayer(c.dataset.layer, !S.layers[c.dataset.layer])));
    $('#searchForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const q = $('#searchInput').value.trim();
      if (!q) return;
      $('#searchInput').blur();
      if (!S.k.isLive) goLive();
      if (S.live?.byId.has(q)) { $('#searchHint').textContent = ''; showBike(q); return; }
      $('#searchHint').innerHTML = `Rad ${esc(q)} ist gerade nicht im Feed, also vermutlich unterwegs oder in der Werkstatt. <button class="btn sm ghost" data-act="trail" data-id="${esc(q)}">Im Verlauf suchen</button>`;
    });
    $('#btnNear').addEventListener('click', () => locate(false));
    $('#btnLocate').addEventListener('click', () => locate(true));
    $('#btnHome').addEventListener('click', () => map.fitBounds(KOELN, { padding: mapPad(isDesktop() ? 40 : 16), duration: REDUCED ? 0 : 600 }));
    $('#repoLink').href = S.cfg?.repo || '#';
    $('#scroll').addEventListener('scroll', (e) => e.target.classList.toggle('scrolled', e.target.scrollTop > 2), { passive: true });
    bindSettings();

    // timeline
    let scrubRaf = 0;
    $('#tlRange').addEventListener('input', (e) => {
      stopPlay();
      if (scrubRaf) return; // one render per frame, always with the newest position
      scrubRaf = requestAnimationFrame(() => {
        scrubRaf = 0;
        const r = $('#tlRange'), t = +r.value;
        if (t >= +r.max - 30) goLive(); else setFrame(frameAt(t));
      });
    });
    $('#tlPlay').addEventListener('click', () => (S.k.playing ? stopPlay() : startPlay()));
    $('#tlLive').addEventListener('click', goLive);
    $('#tlSpeed').addEventListener('click', () => {
      S.k.speed = S.k.speed === 1 ? 2 : S.k.speed === 2 ? 4 : 1;
      $('#tlSpeed').textContent = `${S.k.speed}×`;
    });
    $$('#tlSpan button').forEach((b) => b.addEventListener('click', () => {
      S.k.span = +b.dataset.h;
      $$('#tlSpan button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
      $('#sumTl').textContent = b.textContent.trim();
      reloadTimeline();
    }));
    $('#tlEnd').addEventListener('change', (e) => { S.k.end = e.target.value || null; reloadTimeline(); });
    addEventListener('keydown', (e) => {
      if (!S.tl) return;
      const ae = document.activeElement;
      if (/input|textarea|select/i.test(ae?.tagName) && ae.type !== 'range') return;
      if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && ae?.id !== 'tlRange') {
        const r = $('#tlRange'), T = S.tl;
        const cur = S.k.isLive ? T.t.length : S.k.frame;
        const nx = Math.min(Math.max(cur + (e.key === 'ArrowRight' ? 1 : -1), T.i0), T.t.length);
        stopPlay(); e.preventDefault();
        if (nx >= T.t.length) { goLive(); return; }
        r.value = T.t[nx]; setFrame(nx);
      } else if (e.key === ' ' && ae === document.body) { if (S.k.playing) stopPlay(); else startPlay(); e.preventDefault(); }
    });

    // delegated actions
    $('#panel').addEventListener('click', (e) => {
      const el = e.target.closest('[data-act]');
      if (!el) return;
      const a = el.dataset.act, id = el.dataset.id;
      if (a === 'close') closeDetail();
      else if (a === 'sheet') {
        const open = sheetState === 'peek';
        setSheet(open ? 'full' : 'peek');
        if (!open) $('#scroll').scrollTo({ top: 0 });
      }
      else if (a === 'bike') { if (!S.k.isLive) goLive(); showBike(id); }
      else if (a === 'station') showStation(id);
      else if (a === 'trail') showBikeHistory(id);
      else if (a === 'tlbike') { const i = S.tl.bikeIndex.get(id); if (i != null) showTlBike(i); }
      else if (a === 'livebike') { goLive(); showBike(id); }
      else if (a === 'cleartrail') { S.hist = null; S.histWant = null; setData('hist', EMPTY); applyVisibility(); closeDetail(); }
      else if (a === 'hfocus') histFocus(+el.dataset.n);
      else if (a === 'hper') { S.hp = { h: +el.dataset.h, from: null, to: null }; reloadHist(); }
      else if (a === 'frame') { const i = nearestFrame(+el.dataset.t); $('#tlRange').value = S.tl.t[i]; setFrame(i); }
      else if (a === 'pointme' && S.me) {
        if (!S.layers.avail) setLayer('avail', true);
        setTimeout(() => { pointQuery(S.me[0], S.me[1]); flyTo(S.me, 14.5); }, 60);
      }
      else if (a === 'clearpoint') { S.sel = null; setData('qpt', EMPTY); applyVisibility(); closeDetail(); }
    });
    $('#near').addEventListener('click', (e) => { if (e.target.id === 'btnNear2') locate(false); });
    // short how-to: "?" in the panel header
    const help = $('#help');
    $('#btnHelp').addEventListener('click', (e) => { e.stopPropagation(); if (help.showModal) help.showModal(); else help.setAttribute('open', ''); });
    $('#helpClose').addEventListener('click', () => help.close ? help.close() : help.removeAttribute('open'));
    help.addEventListener('click', (e) => { if (e.target === help) help.close(); }); // tap outside closes

    setInterval(updateStatus, 30000);
    // look for new data every minute while the page is visible, and right away when you come back
    setInterval(() => { if (document.visibilityState === 'visible') checkUpdate(false); }, 60000);
    const back = () => {
      if (document.visibilityState !== 'visible') return;
      if (FR.newApp) { location.reload(); return; }
      if (now() - FR.last > 20) checkUpdate(false);
    };
    document.addEventListener('visibilitychange', back);
    addEventListener('pageshow', (e) => { if (e.persisted) back(); });
    addEventListener('online', back);
    $('#fresh').addEventListener('click', (e) => { e.stopPropagation(); openPop($('#freshPop').hidden); });
    $('#fpBtn').addEventListener('click', manualRefresh);
    $('#fpReload').addEventListener('click', () => location.reload());
    document.addEventListener('pointerdown', (e) => { if (!$('#freshPop').hidden && !e.target.closest('#freshPop, #fresh')) openPop(false); });
    addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#freshPop').hidden) { openPop(false); $('#fresh').focus(); } });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => location.reload());
  }

  // ================================================================ boot
  let booted = false, liveReady;
  async function boot() {
    if (booted) return; booted = true;
    await liveReady;
    // start on where most bikes are; a few outliers (Leverkusen, Rösrath) would zoom far out
    const q = (arr, f) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * f)))];
    const lats = (S.live?.bikes || []).map((b) => b.lat).sort((x, y) => x - y), lngs = (S.live?.bikes || []).map((b) => b.lng).sort((x, y) => x - y);
    const view = lats.length > 50 ? [[q(lngs, 0.02), q(lats, 0.02)], [q(lngs, 0.98), q(lats, 0.98)]] : KOELN;
    for (const [k, on] of Object.entries(S.layers)) { const c = $(`#layers [data-layer="${k}"]`); if (c) { c.classList.toggle('on', on); c.setAttribute('aria-pressed', String(on)); } }
    applyVisibility(); renderKarte(true); syncSettings(); updateStatus();
    requestAnimationFrame(() => {
      setSheet('peek');
      map.fitBounds(view, { duration: 0, padding: mapPad(isDesktop() ? 30 : 10) });
    });
    reloadTimeline();
    if (S.layers.avail) computeOverlay(true);
  }

  async function start() {
    try { S.cfg = await getJSON('config.json'); } catch { S.cfg = { style_light: 'https://tiles.openfreemap.org/styles/positron', style_dark: 'https://tiles.openfreemap.org/styles/dark' }; }
    if (/^#(analyse|karte)/.test(location.hash)) history.replaceState(null, '', location.pathname); // old links
    bindUI();
    initSheet();
    syncSettings();
    liveReady = loadLive();
    if (typeof maplibregl === 'undefined') { toast('Die Kartenbibliothek konnte nicht geladen werden. Bitte Seite neu laden.', 10000); return; }
    initMap(S.cfg);
  }
  window.__app = S; Object.defineProperty(window, '__map', { get: () => map });
  window.__ui = { pick, tripsAt, setSheet, showStation, showBike, showTlStation, showBikeHistory, pointQuery, flyTo, setFrame, startPlay, stopPlay, goLive, setLayer, openTrip, computeOverlay, renderTrips };
  start();
})();
