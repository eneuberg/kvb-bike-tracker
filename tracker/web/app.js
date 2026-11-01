/* KVB-Rad Tracker — Live / Verlauf / Analyse.
   MapLibre GL renders everything on the GPU, so markers, heatmaps and grids
   scale continuously while zooming instead of redrawing afterwards. */
'use strict';
(() => {
  // ---------------------------------------------------------------- helpers
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
  const fWd = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: TZ });
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const localHour = (t) => +fHour.formatToParts(new Date(t * 1000)).find((x) => x.type === 'hour').value % 24;
  const isWeekend = (t) => ['Sat', 'Sun'].includes(fWd.format(new Date(t * 1000)));
  const now = () => Date.now() / 1000;
  const hav = (a, b, c, d) => {
    const r = 6371000, p1 = a * Math.PI / 180, p2 = c * Math.PI / 180;
    const x = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((d - b) * Math.PI / 360) ** 2;
    return 2 * r * Math.asin(Math.sqrt(x));
  };
  const fmtDist = (m) => m < 950 ? `${Math.round(m / 10) * 10} m` : `${nf1.format(m / 1000)} km`;
  const fmtDur = (s) => {
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))} Min.`;
    if (s < 86400 * 2) return `${nf1.format(s / 3600)} Std.`;
    return `${nf1.format(s / 86400)} Tagen`;
  };
  const ago = (t) => fmtDur(Math.max(0, now() - t));
  const dayLabel = (d) => ({ wd: 'Mo–Fr', we: 'Sa/So', all: 'alle Tage' }[d]);
  async function getJSON(url) {
    const r = await fetch(`${url}?v=${Math.floor(Date.now() / 60000)}`);
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return r.json();
  }
  let toastTimer;
  function toast(msg, ms = 3500) {
    const el = $('#toast');
    el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  // ---------------------------------------------------------------- colours
  const C = {
    station: css('--station'), free: css('--free'), ink: css('--ink'), surface: css('--surface'),
    wd: css('--wd'), we: css('--we'), muted: css('--muted'),
  };
  const R = DARK ? {
    seq: ['#1b2a42', '#184f95', '#2a78d6', '#6da7ec', '#cde2fb'],
    heat: ['rgba(194,65,12,0)', '#7c2d12', '#c2410c', '#f97316', '#fdba74', '#ffedd5'],
    red: ['#3a1f22', '#7f2a2a', '#c53b3b', '#e66767', '#f6c3c2'],
    div: { neg: ['#e66767', '#a83a3a', '#5a2e2e'], mid: '#383835', pos: ['#2a4f80', '#3987e5', '#86b6ef'] },
    idle: ['#3b2d99', '#6250d6', '#9085e9', '#c9c2f5'],
  } : {
    seq: ['#cde2fb', '#86b6ef', '#3987e5', '#1c5cab', '#0d366b'],
    heat: ['rgba(235,104,52,0)', '#fbd0b9', '#f59a6b', '#eb6834', '#c2410c', '#7c2d12'],
    red: ['#fde2e1', '#f6a3a2', '#e34948', '#b42c2c', '#6e1414'],
    div: { neg: ['#e34948', '#ee8a89', '#f6c3c2'], mid: '#ece9e4', pos: ['#b7d3f6', '#6da7ec', '#2a78d6'] },
    idle: ['#b9b0f3', '#9085e9', '#6250d6', '#3b2d99'],
  };
  const gradient = (cols) => `linear-gradient(90deg, ${cols.join(', ')})`;

  // ---------------------------------------------------------------- state
  const t0 = now();
  const S = {
    mode: 'live', tab: 'verfuegbarkeit', hour: localHour(t0), day: isWeekend(t0) ? 'we' : 'wd',
    radius: 'near', part: -1,
    layers: { live: { stations: true, free: true, heat: false }, verlauf: { stations: true, free: true, heat: false } },
    live: null, tl: null, an: null, frame: 0, span: 168, playing: false, speed: 1, hPlaying: false,
    sel: null, me: null, trail: null, cfg: null,
  };

  // ---------------------------------------------------------------- map
  let map, styleReady = false, hasGlyphs = false;
  const KOELN = [[6.77, 50.83], [7.16, 51.08]];

  function rasterStyle(cfg) {
    const url = cfg.raster_url || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
    return {
      version: 8,
      sources: { base: { type: 'raster', tiles: [url], tileSize: 256, maxzoom: 19,
        attribution: cfg.raster_attribution || '© OpenStreetMap contributors' } },
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
    let attempt = 0;
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
      attempt += 1;
      map.setStyle(attempts[attempt]);
      armTimeout();
    };
    let timer;
    const armTimeout = () => { clearTimeout(timer); timer = setTimeout(next, 9000); };
    armTimeout();
    map.on('error', (e) => { if (!styleReady) { console.warn('style failed, falling back', e.error); next(); } });
    map.on('style.load', () => {
      clearTimeout(timer);
      if (styleReady) return;
      styleReady = true;
      hasGlyphs = !!map.getStyle().glyphs;
      setupLayers();
      boot();
    });
  }

  const EMPTY = { type: 'FeatureCollection', features: [] };
  const zoomRadius = (z10, z14, z18) => ['interpolate', ['exponential', 1.6], ['zoom'], 10, z10, 14, z14, 18, z18];

  function setupLayers() {
    const before = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
    for (const id of ['bikes', 'stations', 'cellpts', 'net', 'idle', 'sel', 'me', 'trail', 'anst'])
      map.addSource(id, { type: 'geojson', data: EMPTY });
    map.addSource('cells', { type: 'geojson', data: EMPTY, tolerance: 0 });
    map.addSource('flows', { type: 'geojson', data: EMPTY, lineMetrics: true });

    // under basemap labels
    map.addLayer({ id: 'cells-fill', type: 'fill', source: 'cells', layout: { visibility: 'none' },
      paint: { 'fill-color': R.seq[0], 'fill-opacity': 0.7, 'fill-antialias': false } }, before);
    map.addLayer({ id: 'cells-line', type: 'line', source: 'cells', layout: { visibility: 'none' },
      paint: { 'line-color': css('--surface'), 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0, 13, 0.6, 16, 1.5], 'line-opacity': 0.85 } }, before);
    map.addLayer({ id: 'net-fill', type: 'fill', source: 'net', layout: { visibility: 'none' },
      paint: { 'fill-color': ['interpolate', ['linear'], ['get', 'v'], -1, R.div.neg[0], -0.5, R.div.neg[1], -0.15, R.div.neg[2],
        0, R.div.mid, 0.15, R.div.pos[0], 0.5, R.div.pos[1], 1, R.div.pos[2]],
        'fill-opacity': ['interpolate', ['linear'], ['get', 'n'], 2, 0.35, 20, 0.8], 'fill-antialias': false } }, before);
    map.addLayer({ id: 'net-line', type: 'line', source: 'net', layout: { visibility: 'none' },
      paint: { 'line-color': css('--surface'), 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0, 13, 0.6, 16, 1.5] } }, before);
    map.addLayer({ id: 'dens-heat', type: 'heatmap', source: 'cellpts', layout: { visibility: 'none' },
      paint: heatPaint(['/', ['max', 0, ['get', 'h0']], 4], 1.3) }, before);
    map.addLayer({ id: 'live-heat', type: 'heatmap', source: 'bikes', layout: { visibility: 'none' },
      paint: heatPaint(1, 1) }, before);

    // on top
    map.addLayer({ id: 'flows-line', type: 'line', source: 'flows', layout: { visibility: 'none', 'line-cap': 'round' },
      paint: { 'line-width': ['interpolate', ['linear'], ['zoom'], 10, ['*', ['get', 'w'], 4], 14, ['*', ['get', 'w'], 9]],
        'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, hexA(C.ink, 0.05), 0.6, hexA(C.ink, 0.45), 1, hexA(C.ink, 0.9)] } });
    map.addLayer({ id: 'trail-line', type: 'line', source: 'trail', filter: ['==', ['geometry-type'], 'LineString'],
      layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': C.ink, 'line-width': 2.2, 'line-dasharray': [1.5, 1.5], 'line-opacity': 0.75 } });
    map.addLayer({ id: 'trail-pts', type: 'circle', source: 'trail', filter: ['==', ['geometry-type'], 'Point'],
      layout: { visibility: 'none' },
      paint: { 'circle-radius': zoomRadius(4, 7, 10), 'circle-color': C.surface, 'circle-stroke-color': C.ink, 'circle-stroke-width': 2 } });
    map.addLayer({ id: 'idle-dots', type: 'circle', source: 'idle', layout: { visibility: 'none' },
      paint: { 'circle-radius': zoomRadius(2.4, 5, 10), 'circle-color': ['match', ['get', 'c'], 0, R.idle[0], 1, R.idle[1], 2, R.idle[2], R.idle[3]],
        'circle-stroke-color': C.surface, 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 11, 0.3, 15, 1.2] } });
    map.addLayer({ id: 'free-dots', type: 'circle', source: 'bikes', filter: ['==', ['get', 'k'], 0],
      paint: { 'circle-radius': zoomRadius(1.8, 4.2, 9), 'circle-color': C.free,
        'circle-stroke-color': C.surface, 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 11, 0.3, 15, 1.4] } });
    const stR = (base, k) => ['+', base, ['*', k, ['sqrt', ['get', 'n']]]];
    map.addLayer({ id: 'stations-c', type: 'circle', source: 'stations',
      paint: { 'circle-radius': ['interpolate', ['exponential', 1.6], ['zoom'], 10, stR(2.6, 0.6), 14, stR(7, 2), 18, stR(14, 3.4)],
        'circle-color': ['case', ['==', ['get', 'n'], 0], C.surface, C.station],
        'circle-stroke-color': ['case', ['==', ['get', 'n'], 0], C.station, C.surface],
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 0.8, 15, 2] } });
    if (hasGlyphs) {
      map.addLayer({ id: 'stations-t', type: 'symbol', source: 'stations', minzoom: 12.6,
        layout: { 'text-field': ['to-string', ['get', 'n']], 'text-font': ['Noto Sans Bold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 12.6, 9.5, 16, 13], 'text-allow-overlap': true, 'text-ignore-placement': true },
        paint: { 'text-color': ['case', ['==', ['get', 'n'], 0], C.station, '#ffffff'] } });
    }
    map.addLayer({ id: 'an-st', type: 'circle', source: 'anst', layout: { visibility: 'none' },
      paint: { 'circle-radius': 6, 'circle-color': R.red[2], 'circle-stroke-color': C.surface, 'circle-stroke-width': 1.2 } });
    map.addLayer({ id: 'sel-ring', type: 'circle', source: 'sel', filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': zoomRadius(9, 15, 24), 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': C.ink, 'circle-stroke-width': 2.5 } });
    map.addLayer({ id: 'sel-cell', type: 'line', source: 'sel', filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'line-color': C.ink, 'line-width': 2.5 } });
    map.addLayer({ id: 'me-acc', type: 'circle', source: 'me',
      paint: { 'circle-radius': zoomRadius(10, 18, 30), 'circle-color': hexA(C.station, 0.15), 'circle-stroke-width': 0 } });
    map.addLayer({ id: 'me-dot', type: 'circle', source: 'me',
      paint: { 'circle-radius': 6.5, 'circle-color': C.station, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2.5 } });

    map.on('click', onMapClick);
    if (matchMedia('(hover: hover)').matches) {
      let raf = 0;
      map.on('mousemove', (e) => {
        if (raf) return;
        raf = requestAnimationFrame(() => { raf = 0; map.getCanvas().style.cursor = pick(e.point) ? 'pointer' : ''; });
      });
    }
  }

  function heatPaint(weight, intensity) {
    return {
      'heatmap-weight': weight,
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 10, 0.5 * intensity, 13, 1.1 * intensity, 16, 2.2 * intensity],
      'heatmap-radius': ['interpolate', ['exponential', 1.7], ['zoom'], 10, 9, 13, 20, 16, 52, 18, 120],
      'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, R.heat[0], 0.12, R.heat[1], 0.35, R.heat[2],
        0.6, R.heat[3], 0.85, R.heat[4], 1, R.heat[5]],
      'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0.85, 18, 0.55],
    };
  }

  function hexA(hex, a) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  const setData = (id, data) => map.getSource(id)?.setData(data);
  const vis = (id, on) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  const isVis = (id) => map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none';

  function applyVisibility() {
    const m = S.mode, t = S.tab;
    const L = S.layers[m] || {};
    const liveish = m === 'live' || m === 'verlauf';
    vis('stations-c', liveish && L.stations);
    vis('stations-t', liveish && L.stations);
    vis('free-dots', liveish && L.free);
    vis('live-heat', liveish && L.heat);
    vis('trail-line', m === 'verlauf' && !!S.trail);
    vis('trail-pts', m === 'verlauf' && !!S.trail);
    const a = m === 'analyse';
    vis('cells-fill', a && t === 'verfuegbarkeit');
    vis('cells-line', a && t === 'verfuegbarkeit');
    vis('dens-heat', a && t === 'dichte');
    vis('net-fill', a && t === 'stroeme');
    vis('net-line', a && t === 'stroeme');
    vis('flows-line', a && t === 'stroeme');
    vis('an-st', a && t === 'stationen');
    vis('idle-dots', a && t === 'standzeit');
  }

  // ---------------------------------------------------------------- picking
  const PRIORITY = ['stations-c', 'an-st', 'free-dots', 'idle-dots', 'trail-pts', 'cells-fill', 'net-fill'];
  function pick(pt) {
    const layers = PRIORITY.filter(isVis);
    if (!layers.length) return null;
    const r = isDesktop() ? 6 : 14;
    const pointLayers = layers.filter((l) => !l.endsWith('-fill'));
    let fs = pointLayers.length ? map.queryRenderedFeatures([[pt.x - r, pt.y - r], [pt.x + r, pt.y + r]], { layers: pointLayers }) : [];
    if (!fs.length) {
      const fills = layers.filter((l) => l.endsWith('-fill'));
      fs = fills.length ? map.queryRenderedFeatures(pt, { layers: fills }) : [];
    }
    if (!fs.length) return null;
    const rank = (f) => PRIORITY.indexOf(f.layer.id);
    const dist = (f) => {
      if (f.geometry.type !== 'Point') return 0;
      const p = map.project(f.geometry.coordinates);
      return Math.hypot(p.x - pt.x, p.y - pt.y);
    };
    fs.sort((a, b) => rank(a) - rank(b) || dist(a) - dist(b));
    return fs[0];
  }

  function onMapClick(e) {
    const f = pick(e.point);
    if (!f) { closeDetail(); return; }
    const p = f.properties;
    switch (f.layer.id) {
      case 'stations-c': S.mode === 'verlauf' ? showTlStation(p.i) : showStation(p.uid); break;
      case 'free-dots': S.mode === 'verlauf' ? showTlBike(p.i) : showBike(p.id); break;
      case 'idle-dots': showBike(p.id); break;
      case 'trail-pts': showTrail(); break;
      case 'cells-fill': showCell(p.j); break;
      case 'net-fill': showNetCell(p.c); break;
      case 'an-st': showAnStation(p.j); break;
      default:
    }
  }

  function select(geom) { setData('sel', geom ? { type: 'Feature', geometry: geom, properties: {} } : EMPTY); }

  function flyTo(lnglat, zoom) {
    const pad = sheetVisibleHeight();
    map.easeTo({ center: lnglat, zoom: Math.max(map.getZoom(), zoom ?? 14.5), duration: REDUCED ? 0 : 600,
      padding: isDesktop() ? { left: 420, top: 0, right: 0, bottom: 0 } : { bottom: pad, top: 0, left: 0, right: 0 } });
  }

  // ---------------------------------------------------------------- sheet
  const panel = $('#panel');
  let sheetState = 'peek';
  function peekHeight() {
    const sec = $(`.mode[data-mode="${S.mode}"]`);
    const peek = sec ? $('.peek', sec) : null;
    return $('#grab').offsetHeight + $('#head').offsetHeight + (peek ? peek.offsetHeight : 0) + 6;
  }
  function sheetY(state) {
    const H = panel.offsetHeight;
    if (state === 'full') return 0;
    if (state === 'half') return Math.max(0, H - Math.max(window.innerHeight * 0.55, peekHeight() + 120));
    return Math.max(0, H - peekHeight());
  }
  function setSheet(state) {
    if (isDesktop()) return;
    sheetState = state;
    panel.style.setProperty('--sheet-y', `${sheetY(state)}px`);
  }
  function sheetVisibleHeight() {
    if (isDesktop()) return 0;
    const y = parseFloat(getComputedStyle(panel).getPropertyValue('--sheet-y')) || 0;
    return panel.offsetHeight - y;
  }
  function initSheet() {
    let startY = 0, startOff = 0, dragging = false, moved = false, lastY = 0, lastT = 0, vel = 0;
    const handle = (e) => !e.target.closest('button, input, a');
    const down = (e) => {
      if (isDesktop() || !handle(e)) return;
      dragging = true; moved = false;
      startY = lastY = e.clientY; lastT = performance.now();
      startOff = sheetY(sheetState);
      panel.classList.add('dragging');
      e.currentTarget.setPointerCapture(e.pointerId);
    };
    const move = (e) => {
      if (!dragging) return;
      const dy = e.clientY - startY;
      if (Math.abs(dy) > 4) moved = true;
      const t = performance.now();
      vel = (e.clientY - lastY) / Math.max(1, t - lastT);
      lastY = e.clientY; lastT = t;
      const y = Math.min(Math.max(0, startOff + dy), sheetY('peek'));
      panel.style.setProperty('--sheet-y', `${y}px`);
    };
    const up = () => {
      if (!dragging) return;
      dragging = false;
      panel.classList.remove('dragging');
      if (!moved) { setSheet(sheetState === 'peek' ? 'half' : 'peek'); return; }
      const y = parseFloat(panel.style.getPropertyValue('--sheet-y'));
      const states = ['full', 'half', 'peek'].map((st) => ({ st, y: sheetY(st) }));
      let best = states.reduce((a, b) => (Math.abs(b.y - y) < Math.abs(a.y - y) ? b : a));
      if (Math.abs(vel) > 0.45) {
        // a flick goes to the next stop in the flick direction
        const cand = vel > 0 ? states.filter((x) => x.y > y + 1).sort((a, b) => a.y - b.y)[0]
          : states.filter((x) => x.y < y - 1).sort((a, b) => b.y - a.y)[0];
        if (cand) best = cand;
      }
      best = best.st;
      setSheet(best);
    };
    for (const el of [$('#grab'), $('#head')]) {
      el.addEventListener('pointerdown', down);
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    }
    addEventListener('resize', () => setSheet(sheetState));
    document.fonts?.ready.then(() => setSheet(sheetState));
    setSheet('peek');
  }

  // ---------------------------------------------------------------- modes
  function setMode(mode, opts = {}) {
    if (S.mode === 'verlauf' && mode !== 'verlauf') stopPlay();
    if (S.mode === 'analyse' && mode !== 'analyse') stopHourPlay();
    S.mode = mode;
    for (const b of $$('.modes button')) b.setAttribute('aria-selected', String(b.dataset.mode === mode));
    for (const s of $$('section.mode')) s.hidden = s.dataset.mode !== mode;
    closeDetail(true);
    updateHash();
    applyVisibility();
    if (mode === 'live') renderLive();
    if (mode === 'verlauf') enterTimeline(opts);
    if (mode === 'analyse') enterAnalysis();
    updateStatus();
    requestAnimationFrame(() => setSheet(opts.sheet || (sheetState === 'full' ? 'half' : sheetState)));
  }
  function updateHash() {
    const h = S.mode === 'analyse' ? `#analyse/${S.tab}` : `#${S.mode}`;
    if (location.hash !== h) history.replaceState(null, '', h);
  }
  function readHash() {
    const [m, t] = location.hash.replace('#', '').split('/');
    if (['live', 'verlauf', 'analyse'].includes(m)) S.mode = m;
    if (t && $(`#aTabs [data-tab="${t}"]`)) S.tab = t;
  }

  function updateStatus() {
    const el = $('#status'), txt = $('#statusText');
    el.classList.remove('stale', 'past');
    if (S.mode === 'verlauf' && S.tl) {
      el.classList.add('past');
      txt.textContent = 'Verlauf der letzten Tage';
      return;
    }
    if (!S.live) { txt.textContent = 'lädt …'; return; }
    const t = Date.parse(S.live.meta.ts) / 1000;
    const old = now() - t > 40 * 60;
    if (old) el.classList.add('stale');
    txt.textContent = `Stand ${fTime.format(new Date(t * 1000))} Uhr, vor ${ago(t)}${old ? ' (veraltet)' : ''}`;
  }

  // ---------------------------------------------------------------- live
  async function loadLive(silent) {
    try {
      S.live = await getJSON('latest.json');
    } catch (err) {
      if (!silent) toast('Live-Daten konnten nicht geladen werden. Neuer Versuch in einer Minute.');
      setTimeout(() => loadLive(true), 60000);
      return;
    }
    S.live.byId = new Map(S.live.bikes.map((b) => [b.bike, b]));
    S.live.stById = new Map(S.live.stations.map((s, i) => [String(s.uid), { ...s, i }]));
    S.live.docked = new Map();
    for (const b of S.live.bikes) if (b.kind === 'station') {
      const k = String(b.place_uid);
      if (!S.live.docked.has(k)) S.live.docked.set(k, []);
      S.live.docked.get(k).push(b);
    }
    if (S.mode === 'live') renderLive();
    if (S.mode === 'analyse' && S.tab === 'standzeit') renderIdle();
    updateStatus();
  }

  function renderLive() {
    if (!S.live || !styleReady) return;
    const L = S.live;
    setData('bikes', { type: 'FeatureCollection', features: L.bikes.map((b) => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [b.lng, b.lat] },
      properties: { k: b.kind === 'station' ? 1 : 0, id: b.bike } })) });
    setData('stations', { type: 'FeatureCollection', features: L.stations.map((s) => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
      properties: { n: (L.docked.get(String(s.uid)) || []).length, uid: String(s.uid) } })) });
    const c = L.meta.counts;
    $('#sTotal').textContent = nf.format(c.total);
    $('#sStation').textContent = nf.format(c.station);
    $('#sFree').textContent = nf.format(c.free + c.other);
    if (S.me) renderNear();
  }

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
      ['Steht hier seit', sinceText(b) || '–'],
      b.battery != null && ['Akku', `${b.battery} %`],
      ['Schloss', esc((b.lock_types || '').split(',').filter(Boolean).map((x) => LOCKS[x] || x).join(', ') || '–')],
      b.bike_type != null && ['Typ-Code', b.bike_type],
    ].filter(Boolean);
    const route = `https://www.google.com/maps/dir/?api=1&destination=${b.lat},${b.lng}&travelmode=walking`;
    const target = S.mode === 'analyse' ? '#detailA' : '#detail';
    showDetail(target, `
      <p class="kicker"><span class="dot" style="background:${st ? C.station : C.free}"></span>${st ? 'An einer Station' : 'Frei abgestellt'}${S.me ? `, ${fmtDist(hav(S.me[1], S.me[0], b.lat, b.lng))} entfernt` : ''}</p>
      <h3>Rad ${esc(b.bike)}</h3>
      <dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
      <div class="actions">
        <a class="btn sm" href="${route}" target="_blank" rel="noopener">Route hierhin</a>
        <button class="btn sm ghost" data-act="trail" data-id="${esc(b.bike)}">Weg der letzten Tage</button>
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
      st.terminal_type ? ['Terminal', esc(st.terminal_type)] : null,
    ].filter(Boolean);
    showDetail('#detail', `
      <p class="kicker"><span class="dot" style="background:${C.station}"></span>Station${st.number ? ` ${st.number}` : ''}</p>
      <h3>${esc(st.name)}</h3>
      <dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
      ${docked.length ? `<div class="bikelist">${docked.slice(0, 60).map((b) => `<button data-act="bike" data-id="${esc(b.bike)}">${esc(b.bike)}</button>`).join('')}</div>` : ''}
      <div id="stHist" class="block" style="padding-bottom:0"><p class="hint">Typischer Füllstand wird geladen …</p></div>
      <div class="actions"><a class="btn sm" href="https://www.google.com/maps/dir/?api=1&destination=${st.lat},${st.lng}&travelmode=walking" target="_blank" rel="noopener">Route hierhin</a></div>`);
    select({ type: 'Point', coordinates: [st.lng, st.lat] });
    flyTo([st.lng, st.lat]);
    ensureAnalysis().then(() => {
      const el = $('#stHist');
      if (!el) return;
      const j = S.an?.stIndex.get(String(uid));
      el.innerHTML = j == null ? '<p class="hint">Noch keine Auswertung für diese Station.</p>' : stationCharts(j);
      bindCharts(el);
    }).catch(() => { const el = $('#stHist'); if (el) el.innerHTML = ''; });
  }

  // ---------------------------------------------------------------- near me
  function locate(fromButton) {
    if (!navigator.geolocation) { toast('Standort wird von diesem Browser nicht unterstützt.'); return; }
    $('#btnLocate').classList.add('on');
    navigator.geolocation.getCurrentPosition((pos) => {
      S.me = [pos.coords.longitude, pos.coords.latitude];
      setData('me', { type: 'Feature', geometry: { type: 'Point', coordinates: S.me }, properties: {} });
      flyTo(S.me, 15.2);
      if (S.mode === 'live') { renderNear(); if (!fromButton) setSheet('half'); }
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
    const top = items.slice(0, 6);
    $('#near').innerHTML = `
      <p style="margin:0 0 6px"><b>${within}</b> ${within === 1 ? 'Rad' : 'Räder'} im Umkreis von 400 m.</p>
      <p class="hint" id="nearChance" style="margin:0 0 8px"></p>
      <ul class="rows">${top.map((x) => x.b ? `
        <li><button class="rowbtn" data-act="bike" data-id="${esc(x.b.bike)}"><span class="dot" style="background:${C.free}"></span>
          <span class="main"><b>Rad ${esc(x.b.bike)}</b><small>frei abgestellt</small></span>
          <span class="val">${fmtDist(x.d)}<small>~${Math.max(1, Math.round(x.d / 75))} Min. zu Fuß</small></span></button></li>` : `
        <li><button class="rowbtn" data-act="station" data-id="${esc(x.st.uid)}"><span class="dot" style="background:${C.station}"></span>
          <span class="main"><b>${esc(x.st.name)}</b><small>${x.n} ${x.n === 1 ? 'Rad' : 'Räder'} an der Station</small></span>
          <span class="val">${fmtDist(x.d)}<small>~${Math.max(1, Math.round(x.d / 75))} Min. zu Fuß</small></span></button></li>`).join('')}</ul>
      <button class="btn sm ghost" id="btnNear2" type="button" style="margin-top:8px">Standort aktualisieren</button>`;
    ensureAnalysis().then(() => {
      const el = $('#nearChance');
      const A = S.an;
      if (!el || !A) return;
      const j = A.cellIndex.get(A.cellOf(lat, lng));
      const day = isWeekend(now()) ? 'we' : 'wd';
      const h = localHour(now());
      const v = j == null ? 0 : A.val('near', day, h, j);
      if (v == null) { el.textContent = ''; return; }
      el.textContent = `${dayLabel(day)} um ${h} Uhr stand hier in ${v} % der Fälle mindestens ein Rad im Umkreis von etwa 400 m (Basis: ${nf1.format(A.window.days)} Tage).`;
    }).catch(() => {});
  }

  // ---------------------------------------------------------------- timeline
  const KEY = 12;
  async function ensureTimeline() {
    if (S.tl && now() - S.tl.loaded < 600) return S.tl;
    const T = await getJSON('timeline.json');
    const N = T.bikes.length;
    const state = { p: new Uint8Array(N), la: new Int32Array(N), lo: new Int32Array(N), pl: new Int32Array(N).fill(-1) };
    const keys = [];
    const apply = (st, i) => {
      const f = T.frames[i];
      for (let k = 0; k < f.length; k += 4) { const b = f[k]; st.p[b] = 1; st.la[b] = f[k + 1]; st.lo[b] = f[k + 2]; st.pl[b] = f[k + 3]; }
      for (const b of T.gone[i]) st.p[b] = 0;
    };
    for (let i = 0; i < T.t.length; i++) {
      apply(state, i);
      if (i % KEY === 0) keys.push({ p: state.p.slice(), la: state.la.slice(), lo: state.lo.slice(), pl: state.pl.slice() });
    }
    T.keys = keys; T.apply = apply; T.N = N; T.loaded = now();
    T.cur = { p: new Uint8Array(N), la: new Int32Array(N), lo: new Int32Array(N), pl: new Int32Array(N), i: -1 };
    T.bikeIndex = new Map(T.bikes.map((b, i) => [b, i]));
    S.tl = T;
    return T;
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

  let tlRaf = 0;
  function renderFrame() {
    if (tlRaf) return;
    tlRaf = requestAnimationFrame(() => {
      tlRaf = 0;
      const T = S.tl;
      if (!T || !T.t.length) return;
      seek(S.frame);
      const cur = T.cur, sc = T.scale;
      const bikes = [], counts = new Int32Array(T.stations.length);
      let free = 0, docked = 0;
      for (let b = 0; b < T.N; b++) {
        if (!cur.p[b]) continue;
        const lat = T.lat0 + cur.la[b] / sc, lng = T.lng0 + cur.lo[b] / sc;
        const k = cur.pl[b] >= 0 ? 1 : 0;
        if (k) { counts[cur.pl[b]]++; docked++; } else free++;
        bikes.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: { k, i: b } });
      }
      setData('bikes', { type: 'FeatureCollection', features: bikes });
      setData('stations', { type: 'FeatureCollection', features: T.stations.map((s, i) => ({
        type: 'Feature', geometry: { type: 'Point', coordinates: [s[3], s[2]] }, properties: { n: counts[i], i } })) });
      const t = T.t[S.frame];
      $('#tlTime').textContent = fTime.format(new Date(t * 1000));
      $('#tlDate').textContent = fDate.format(new Date(t * 1000));
      $('#tTotal').textContent = nf.format(bikes.length);
      $('#tStation').textContent = nf.format(docked);
      $('#tFree').textContent = nf.format(free);
      $('#tUse').textContent = nf.format(T.inuse[S.frame] ?? 0);
      $('#tlRange').setAttribute('aria-valuetext', `${fDate.format(new Date(t * 1000))} ${fTime.format(new Date(t * 1000))}`);
    });
  }

  function spanStart() {
    const T = S.tl, tEnd = T.t[T.t.length - 1];
    let i0 = T.t.findIndex((t) => t >= tEnd - S.span * 3600);
    return Math.max(0, i0);
  }

  function setupScrubber() {
    const T = S.tl, r = $('#tlRange');
    const i0 = spanStart(), i1 = T.t.length - 1;
    r.min = i0; r.max = i1;
    if (S.frame < i0 || S.frame > i1) S.frame = i1;
    r.value = S.frame;
    // sparkline of bikes in use
    const svg = $('#tlSpark');
    const n = i1 - i0 + 1, vals = T.inuse.slice(i0, i1 + 1);
    const max = Math.max(5, ...vals);
    const ts = T.t[i0], te = T.t[i1], span = Math.max(1, te - ts);
    const X = (t) => ((t - ts) / span) * 1000;
    const Y = (v) => 50 - (v / max) * 44;
    let d = '';
    for (let k = 0; k < n; k++) d += `${k ? 'L' : 'M'}${X(T.t[i0 + k]).toFixed(1)},${Y(vals[k]).toFixed(1)}`;
    svg.setAttribute('viewBox', '0 0 1000 52');
    const days = [];
    const ticks = [];
    // local midnights in range
    for (let t = ts - (ts % 3600); t <= te; t += 3600) {
      const h = localHour(t);
      if (h === 0 && t > ts) days.push(t);
      if (S.span <= 24 ? h % 6 === 0 : (S.span <= 72 ? h === 12 || h === 0 : h === 12)) ticks.push(t);
    }
    svg.innerHTML = `${days.map((t) => `<line class="day" x1="${X(t)}" x2="${X(t)}" y1="0" y2="52"/>`).join('')}
      ${n > 1 ? `<path class="area" d="${d}L1000,52L0,52Z"/><path class="ln" d="${d}"/>` : ''}`;
    $('#tlTicks').innerHTML = ticks.map((t) => {
      const lab = S.span <= 24 ? `${localHour(t)} Uhr` : (localHour(t) === 0 ? fDM.format(new Date(t * 1000)) : fDay.format(new Date(t * 1000)));
      const x = X(t) / 10;
      return x > 4 && x < 96 ? `<span style="left:${x}%">${lab}</span>` : '';
    }).join('');
    renderFrame();
  }

  async function enterTimeline(opts = {}) {
    try {
      $('#tlTime').textContent = '--:--';
      await ensureTimeline();
    } catch (err) {
      toast('Verlauf noch nicht verfügbar. Er entsteht mit den nächsten Abfragen.');
      return;
    }
    if (!S.tl.t.length) { toast('Noch keine Verlaufsdaten.'); return; }
    if (opts.frameAt) S.frame = nearestFrame(opts.frameAt);
    else if (S.frame <= 0) S.frame = S.tl.t.length - 1;
    setupScrubber();
    applyVisibility();
    updateStatus();
    if (opts.trail) showTrailFor(opts.trail);
  }

  const nearestFrame = (t) => {
    const T = S.tl; let best = 0;
    for (let i = 0; i < T.t.length; i++) if (Math.abs(T.t[i] - t) < Math.abs(T.t[best] - t)) best = i;
    return best;
  };

  let playTimer = 0;
  function stopPlay() { S.playing = false; clearInterval(playTimer); $('#tlPlay').classList.remove('on'); $('#tlPlay').setAttribute('aria-label', 'Abspielen'); }
  function startPlay() {
    if (!S.tl) return;
    const r = $('#tlRange');
    if (S.frame >= +r.max) S.frame = +r.min;
    S.playing = true;
    $('#tlPlay').classList.add('on'); $('#tlPlay').setAttribute('aria-label', 'Pause');
    clearInterval(playTimer);
    playTimer = setInterval(() => {
      if (S.frame >= +r.max) { stopPlay(); return; }
      S.frame += 1; r.value = S.frame; renderFrame();
    }, 250 / S.speed);
  }

  function showTlBike(i) {
    const T = S.tl, id = T.bikes[i];
    const cur = T.cur;
    const lat = T.lat0 + cur.la[i] / T.scale, lng = T.lng0 + cur.lo[i] / T.scale;
    const st = cur.pl[i] >= 0 ? T.stations[cur.pl[i]] : null;
    showDetail('#detailTl', `
      <p class="kicker"><span class="dot" style="background:${st ? C.station : C.free}"></span>${st ? 'An einer Station' : 'Frei abgestellt'}, ${fDate.format(new Date(T.t[S.frame] * 1000))} ${fTime.format(new Date(T.t[S.frame] * 1000))}</p>
      <h3>Rad ${esc(id)}</h3>
      ${st ? `<dl class="kv"><dt>Station</dt><dd>${esc(st[1])}</dd></dl>` : ''}
      <div class="actions"><button class="btn sm" data-act="trail" data-id="${esc(id)}">Weg anzeigen</button>
      ${S.live?.byId.has(id) ? `<button class="btn sm ghost" data-act="livebike" data-id="${esc(id)}">Jetzt live</button>` : ''}</div>`);
    select({ type: 'Point', coordinates: [lng, lat] });
  }

  function showTlStation(i) {
    const T = S.tl, s = T.stations[i];
    const list = [];
    for (let b = 0; b < T.N; b++) if (T.cur.p[b] && T.cur.pl[b] === i) list.push(T.bikes[b]);
    showDetail('#detailTl', `
      <p class="kicker"><span class="dot" style="background:${C.station}"></span>Station, ${fDate.format(new Date(T.t[S.frame] * 1000))} ${fTime.format(new Date(T.t[S.frame] * 1000))}</p>
      <h3>${esc(s[1])}</h3>
      <dl class="kv"><dt>Räder</dt><dd>${list.length}</dd></dl>
      ${list.length ? `<div class="bikelist">${list.slice(0, 60).map((b) => `<button data-act="tlbike" data-id="${esc(b)}">${esc(b)}</button>`).join('')}</div>` : ''}`);
    select({ type: 'Point', coordinates: [s[3], s[2]] });
  }

  async function showTrailFor(id) {
    if (S.mode !== 'verlauf') { setMode('verlauf', { trail: id }); return; }
    const T = await ensureTimeline();
    const i = T.bikeIndex.get(String(id));
    if (i == null) { toast(`Rad ${id} kommt im Verlauf nicht vor.`); return; }
    // walk all frames once and collect stays
    const stays = [];
    let present = false, last = null;
    for (let f = 0; f < T.t.length; f++) {
      const fr = T.frames[f];
      let hit = -1;
      for (let k = 0; k < fr.length; k += 4) if (fr[k] === i) { hit = k; break; }
      if (hit >= 0) {
        const lat = T.lat0 + fr[hit + 1] / T.scale, lng = T.lng0 + fr[hit + 2] / T.scale, pl = fr[hit + 3];
        if (last && present && hav(last.lat, last.lng, lat, lng) < 60 && last.pl === pl) { last.t1 = T.t[f]; }
        else { last = { lat, lng, pl, t0: T.t[f], t1: T.t[f] }; stays.push(last); }
        present = true;
      } else if (T.gone[f].includes(i)) { present = false; }
      else if (present && last) last.t1 = T.t[f];
    }
    if (!stays.length) { toast(`Rad ${id} kommt im Verlauf nicht vor.`); return; }
    S.trail = { id, stays };
    setData('trail', { type: 'FeatureCollection', features: [
      { type: 'Feature', geometry: { type: 'LineString', coordinates: stays.map((s) => [s.lng, s.lat]) }, properties: {} },
      ...stays.map((s, k) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lng, s.lat] }, properties: { k } })),
    ] });
    applyVisibility();
    const b = new maplibregl.LngLatBounds();
    stays.forEach((s) => b.extend([s.lng, s.lat]));
    map.fitBounds(b, { padding: isDesktop() ? { left: 440, top: 60, right: 60, bottom: 60 } : { top: 70, left: 40, right: 40, bottom: sheetVisibleHeight() + 30 }, maxZoom: 15, duration: REDUCED ? 0 : 700 });
    showTrail();
  }

  function showTrail() {
    const tr = S.trail; if (!tr) return;
    const T = S.tl;
    const name = (s) => s.pl >= 0 ? esc(T.stations[s.pl][1]) : 'frei abgestellt';
    const rows = tr.stays.slice().reverse().slice(0, 40).map((s) => `
      <li><button class="rowbtn" data-act="frame" data-t="${s.t0}"><span class="dot" style="background:${s.pl >= 0 ? C.station : C.free}"></span>
        <span class="main"><b>${name(s)}</b><small>${fDate.format(new Date(s.t0 * 1000))} ${fTime.format(new Date(s.t0 * 1000))} bis ${s.t1 === s.t0 ? '–' : fTime.format(new Date(s.t1 * 1000))}</small></span>
        <span class="val">${fmtDur(Math.max(600, s.t1 - s.t0))}</span></button></li>`).join('');
    showDetail('#detailTl', `
      <p class="kicker">Weg in den letzten ${Math.round((T.t[T.t.length - 1] - T.t[0]) / 86400) || 1} Tagen</p>
      <h3>Rad ${esc(tr.id)}</h3>
      <p class="hint" style="margin-top:0">${tr.stays.length} Standorte. Antippen springt zum Zeitpunkt.</p>
      <ul class="rows">${rows}</ul>
      <div class="actions"><button class="btn sm ghost" data-act="cleartrail">Weg ausblenden</button></div>`, { keepSel: true });
  }

  // ---------------------------------------------------------------- analysis
  let anPromise = null;
  function ensureAnalysis() {
    if (S.an && now() - S.an.loaded < 900) return Promise.resolve(S.an);
    if (anPromise) return anPromise;
    anPromise = getJSON('analysis.json').then((A) => {
      const dec = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      for (const m of ['prob', 'near', 'avg']) for (const d of ['wd', 'we']) A[m][d] = dec(A[m][d]);
      const G = A.grid, N = A.cells.length;
      A.N = N;
      A.cellIndex = new Map(A.cells.map((c, j) => [c, j]));
      A.cellOf = (lat, lng) => {
        const ix = Math.floor((lng - G.lng0) / G.dlng), iy = Math.floor((lat - G.lat0) / G.dlat);
        return (ix < 0 || iy < 0 || ix >= G.W || iy >= G.H) ? -1 : iy * G.W + ix;
      };
      A.cellPoly = (c) => {
        const iy = Math.floor(c / G.W), ix = c % G.W;
        const a = G.lat0 + iy * G.dlat, b = G.lng0 + ix * G.dlng;
        return [[[b, a], [b + G.dlng, a], [b + G.dlng, a + G.dlat], [b, a + G.dlat], [b, a]]];
      };
      A.cellCenter = (c) => { const iy = Math.floor(c / G.W), ix = c % G.W; return [G.lng0 + (ix + 0.5) * G.dlng, G.lat0 + (iy + 0.5) * G.dlat]; };
      const CW = Math.ceil(G.W / G.coarse);
      A.coarseCenter = (c) => { const cy = Math.floor(c / CW), cx = c % CW;
        return [G.lng0 + (cx * G.coarse + G.coarse / 2) * G.dlng, G.lat0 + (cy * G.coarse + G.coarse / 2) * G.dlat]; };
      // value of metric for day type (wd/we/all), hour, cell j; null = no data
      A.val = (m, d, h, j) => {
        const sc = m === 'avg' ? 10 : 1;
        if (d !== 'all') { const v = A[m][d][h * N + j]; return v === 255 ? null : v / sc; }
        const a = A[m].wd[h * N + j], b = A[m].we[h * N + j], na = A.n.wd[h], nb = A.n.we[h];
        const wa = a === 255 ? 0 : na, wb = b === 255 ? 0 : nb;
        if (!wa && !wb) return null;
        return ((wa ? a * wa : 0) + (wb ? b * wb : 0)) / (wa + wb) / sc;
      };
      A.combine = (wd, we, h) => {
        if (S.day !== 'all') return (S.day === 'wd' ? wd : we)[h];
        const a = wd[h], b = we[h], na = A.n.wd[h], nb = A.n.we[h];
        const wa = a == null ? 0 : na, wb = b == null ? 0 : nb;
        return (!wa && !wb) ? null : ((wa ? a * wa : 0) + (wb ? b * wb : 0)) / (wa + wb);
      };
      A.stIndex = new Map(A.stations.uid.map((u, j) => [String(u), j]));
      A.loaded = now();
      S.an = A;
      A.stamp = (A.stamp || 0) + 1;
      return A;
    }).finally(() => { anPromise = null; });
    return anPromise;
  }

  const TAB_CONTROLS = {
    verfuegbarkeit: 'hour', dichte: 'hour', nutzung: 'none', stroeme: 'part', stationen: 'hour', standzeit: 'none',
  };

  async function enterAnalysis() {
    for (const b of $$('#aTabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === S.tab));
    const ctl = TAB_CONTROLS[S.tab];
    $('#hourBar').hidden = ctl !== 'hour';
    $('#partBar').hidden = ctl !== 'part';
    syncHourUI();
    applyVisibility();
    $('#aMore').innerHTML = '<p class="hint">Auswertung wird geladen …</p>';
    $('#aLegend').innerHTML = '';
    try { await ensureAnalysis(); } catch (err) {
      $('#aMore').innerHTML = '<div class="basis warn">Noch keine Auswertung vorhanden. Sie entsteht automatisch, sobald ein paar Abfragen gelaufen sind.</div>';
      return;
    }
    if (S.mode !== 'analyse') return;
    renderTab();
    requestAnimationFrame(() => setSheet(sheetState));
  }

  function basisBox() {
    const A = S.an, w = A.window;
    const days = w.days;
    const warn = days < 3;
    const note = warn ? 'Das ist noch sehr wenig: Werte schwanken stark und manche Stunden fehlen noch.'
      : days < 14 ? 'Einzelne Tage wiegen noch schwer. Ab etwa zwei Wochen werden die Muster stabil.' : '';
    const icon = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.5"/></svg>';
    return `<div class="basis${warn ? ' warn' : ''}">${icon}<div>Grundlage: ${nf.format(w.polls)} Abfragen über ${nf1.format(days)} ${days === 1 ? 'Tag' : 'Tage'}
      (${fDM.format(new Date(w.from * 1000))} bis ${fDM.format(new Date(w.to * 1000))}). ${note}</div></div>`;
  }

  function renderTab() {
    if (!S.an || !styleReady) return;
    const fn = { verfuegbarkeit: renderAvail, dichte: renderDensity, nutzung: renderUsage, stroeme: renderFlows,
      stationen: renderStations, standzeit: renderIdle }[S.tab];
    fn();
    bindCharts($('#aMore'));
  }

  // ---- availability & density
  let cellKey = '';
  function buildCells(metric) {
    const A = S.an, key = `${metric}|${S.day}|${A.stamp}`;
    if (key === cellKey) return;
    cellKey = key;
    const polys = [], pts = [];
    for (let j = 0; j < A.N; j++) {
      const props = { j };
      let any = false;
      for (let h = 0; h < 24; h++) {
        const v = A.val(metric, S.day, h, j);
        props[`h${h}`] = v == null ? -1 : v;
        if (v) any = true;
      }
      if (metric === 'avg') {
        if (any) pts.push({ type: 'Feature', geometry: { type: 'Point', coordinates: A.cellCenter(A.cells[j]) }, properties: props });
      } else polys.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: A.cellPoly(A.cells[j]) }, properties: props });
    }
    if (metric === 'avg') setData('cellpts', { type: 'FeatureCollection', features: pts });
    else setData('cells', { type: 'FeatureCollection', features: polys });
  }

  function paintHour() {
    if (!S.an || !styleReady) return;
    const hk = ['get', `h${S.hour}`];
    if (S.tab === 'verfuegbarkeit') {
      map.setPaintProperty('cells-fill', 'fill-color', ['case', ['<', hk, 0], 'rgba(0,0,0,0)',
        ['interpolate', ['linear'], hk, 0, R.seq[0], 25, R.seq[1], 50, R.seq[2], 75, R.seq[3], 100, R.seq[4]]]);
      map.setPaintProperty('cells-fill', 'fill-opacity', ['case', ['<', hk, 0], 0,
        ['interpolate', ['linear'], hk, 0, 0.18, 10, 0.5, 100, 0.8]]);
    } else if (S.tab === 'dichte') {
      map.setPaintProperty('dens-heat', 'heatmap-weight', ['/', ['max', 0, hk], 4]);
    } else if (S.tab === 'stationen') {
      const ek = ['get', `e${S.hour}`], ak = ['get', `a${S.hour}`];
      map.setPaintProperty('an-st', 'circle-color', ['case', ['<', ek, 0], C.muted,
        ['interpolate', ['linear'], ek, 0, R.red[0], 25, R.red[1], 50, R.red[2], 75, R.red[3], 100, R.red[4]]]);
      map.setPaintProperty('an-st', 'circle-radius', ['interpolate', ['exponential', 1.6], ['zoom'],
        10, ['+', 2.5, ['*', 0.8, ['sqrt', ['max', 0, ak]]]], 14, ['+', 6, ['*', 2.4, ['sqrt', ['max', 0, ak]]]], 18, ['+', 12, ['*', 4, ['sqrt', ['max', 0, ak]]]]]);
    }
    if (S.sel?.type === 'cell') showCell(S.sel.j, true);
    if (S.sel?.type === 'anst') showAnStation(S.sel.j, true);
    if (S.tab === 'stationen') renderStationList();
  }

  function renderAvail() {
    buildCells(S.radius);
    paintHour();
    $('#aLegend').innerHTML = `<div class="cap">Chance, dass ${S.radius === 'near' ? 'im Umkreis von ca. 400 m' : 'in diesem 250-m-Feld'} mindestens ein Rad steht</div>
      <div class="bar" style="background:${gradient(R.seq)}"></div><div class="scale"><span>0 %</span><span>50 %</span><span>100 %</span></div>`;
    $('#aMore').innerHTML = `${basisBox()}
      <div class="block"><h2>Bezugsfläche</h2>
        <div class="seg" id="radiusSeg" role="radiogroup">
          <button role="radio" data-r="near" aria-checked="${S.radius === 'near'}">Umkreis ~400 m</button>
          <button role="radio" data-r="prob" aria-checked="${S.radius === 'prob'}">Feld 250 m</button>
        </div>
        <p class="hint">„Umkreis“ zählt auch die acht Nachbarfelder mit. Das entspricht eher der Frage, ob du in ein paar Minuten zu Fuß ein Rad erreichst.</p></div>
      <div class="block"><h2>So liest du die Karte</h2>
        <p class="hint" style="margin-top:0">Jedes Feld zeigt, in wie viel Prozent der Abfragen zur gewählten Stunde dort mindestens ein Rad stand. Feld antippen für den Tagesverlauf. Mit ▶ läuft der Tag durch.</p></div>`;
    $$('#radiusSeg button').forEach((b) => b.onclick = () => { S.radius = b.dataset.r; renderAvail(); });
  }

  function renderDensity() {
    buildCells('avg');
    paintHour();
    $('#aLegend').innerHTML = `<div class="cap">Durchschnittliche Zahl abgestellter Räder</div>
      <div class="bar" style="background:${gradient(R.heat.slice(1))}"></div><div class="scale"><span>wenige</span><span>viele</span></div>`;
    $('#aMore').innerHTML = `${basisBox()}
      <div class="block"><p class="hint" style="margin-top:0">Wo stehen um diese Uhrzeit typischerweise die meisten Räder? Gemittelt über alle Abfragen dieser Stunde. Im Vergleich der Stunden siehst du, wie sich die Flotte über den Tag verlagert.</p></div>
      <div class="block"><h2>Top-Bereiche um ${S.hour} Uhr</h2><ul class="rows">${topCells('avg').map((x) => `
        <li><button class="rowbtn" data-act="cell" data-j="${x.j}"><span class="main"><b>${esc(x.name)}</b><small>Feld bei ${esc(x.near)}</small></span>
        <span class="val">${nf1.format(x.v)}<small>Räder Ø</small></span></button></li>`).join('')}</ul></div>`;
  }

  function nearestStationName(lng, lat) {
    const A = S.an; let best = -1, bd = Infinity;
    for (let j = 0; j < A.stations.uid.length; j++) {
      const d = hav(lat, lng, A.stations.lat[j], A.stations.lng[j]);
      if (d < bd) { bd = d; best = j; }
    }
    return best < 0 ? 'Köln' : A.stations.name[best];
  }

  function topCells(metric) {
    const A = S.an, out = [];
    for (let j = 0; j < A.N; j++) { const v = A.val(metric, S.day, S.hour, j); if (v) out.push({ j, v }); }
    out.sort((a, b) => b.v - a.v);
    return out.slice(0, 8).map((x) => { const [lng, lat] = A.cellCenter(A.cells[x.j]); const n = nearestStationName(lng, lat); return { ...x, name: n, near: n }; });
  }

  function showCell(j, quiet) {
    const A = S.an; if (!A) return;
    const metric = S.tab === 'dichte' ? 'avg' : S.radius;
    const wd = [], we = [];
    for (let h = 0; h < 24; h++) { wd.push(A.val(metric, 'wd', h, j)); we.push(A.val(metric, 'we', h, j)); }
    const c = A.cells[j];
    const [lng, lat] = A.cellCenter(c);
    const cur = A.combine(wd, we, S.hour);
    const isP = metric !== 'avg';
    const head = cur == null ? 'keine Daten' : (isP ? `${Math.round(cur)} %` : `${nf1.format(cur)} Räder`);
    const where = nearestStationName(lng, lat);
    S.sel = { type: 'cell', j };
    showDetail('#detailA', `
      <p class="kicker">Feld bei ${esc(where)}</p>
      <h3>${head}</h3>
      <p class="hint" style="margin-top:-4px">${isP ? `Chance auf mindestens ein Rad ${metric === 'near' ? 'im Umkreis von ca. 400 m' : 'in diesem Feld'}` : 'durchschnittlich abgestellt'}, ${dayLabel(S.day)} um ${S.hour} Uhr</p>
      ${lineChart({ title: isP ? 'Chance im Tagesverlauf' : 'Räder im Tagesverlauf', unit: isP ? '%' : '', yMax: isP ? 100 : null,
        series: [{ name: 'Mo–Fr', color: C.wd, values: wd }, { name: 'Sa/So', color: C.we, values: we }], now: S.hour })}`, { keepSel: true, quiet });
    select({ type: 'Polygon', coordinates: A.cellPoly(c) });
  }

  // ---- usage
  function renderUsage() {
    const A = S.an, U = A.usage, T = U.totals;
    $('#aLegend').innerHTML = `<div class="tiles">
      <div class="stat"><b>${T.per_day != null ? nf.format(Math.round(T.per_day)) : '–'}</b><span>Fahrten/Tag*</span></div>
      <div class="stat"><b>${T.median_dur_min != null ? `${nf.format(Math.round(T.median_dur_min))} min` : '–'}</b><span>Dauer, Median</span></div>
      <div class="stat"><b>${T.median_dist_m != null ? fmtDist(T.median_dist_m) : '–'}</b><span>Luftlinie, Median</span></div></div>`;
    const ser = U.series;
    const hours = [...Array(25).keys()].slice(0, 24);
    const dur = U.dur_hist.counts, dist = U.dist_hist.counts;
    $('#aMore').innerHTML = `${basisBox()}
      <div class="block">${lineChart({ title: 'Räder unterwegs nach Uhrzeit', sub: 'Durchschnitt', series: [
        { name: 'Mo–Fr', color: C.wd, values: U.inuse.wd }, { name: 'Sa/So', color: C.we, values: U.inuse.we }], now: localHour(now()) })}</div>
      <div class="block">${lineChart({ title: 'Fahrtbeginne pro Stunde', sub: 'Durchschnitt', series: [
        { name: 'Mo–Fr', color: C.wd, values: U.trips_per_h.wd }, { name: 'Sa/So', color: C.we, values: U.trips_per_h.we }], now: localHour(now()) })}</div>
      <div class="block">${timeChart({ title: 'Räder unterwegs, letzte Tage', t: ser.t, values: ser.inuse, color: C.we })}</div>
      <div class="block">${barChart({ title: 'Fahrtdauer', sub: `${nf.format(T.trips - T.short)} Fahrten mit messbarer Dauer`, values: dur,
        labels: dur.map((_, k) => k === dur.length - 1 ? '>2 h' : `${k * 5}–${k * 5 + 5} min`), tickEvery: 6, tickLabel: (k) => k === dur.length - 1 ? '' : `${k * 5}` , unitX: 'min' })}</div>
      <div class="block">${barChart({ title: 'Strecke (Luftlinie)', sub: `${nf.format(T.trips)} Fahrten`, values: dist,
        labels: dist.map((_, k) => k === dist.length - 1 ? '>8 km' : `${nf1.format(k * 0.25)}–${nf1.format(k * 0.25 + 0.25)} km`), tickEvery: 4, tickLabel: (k) => k === dist.length - 1 ? '' : nf1.format(k * 0.25), unitX: 'km' })}</div>
      <div class="block"><h2>Wie wird gezählt?</h2><p class="hint" style="margin-top:0">
        * Fahrten sind geschätzt: Ein Rad verschwindet aus dem Feed und taucht mindestens ${A.params.trip_min_gone_m} m entfernt wieder auf,
        oder es springt zwischen zwei Abfragen mehr als ${A.params.trip_min_m} m. Abwesenheiten über ${A.params.max_trip_h} Stunden gelten als Werkstatt oder Umverteilung
        (${nf.format(T.service)}), Rückgaben am selben Ort als Rundfahrt oder Reservierung (${nf.format(T.roundtrips)}). Kurze Fahrten zwischen zwei Abfragen haben keine messbare Dauer.
        Umverteilung per Transporter lässt sich nicht sicher von Fahrten trennen.</p></div>`;
  }

  // ---- flows
  function renderFlows() {
    const A = S.an, F = A.flows, p = S.part;
    // net in/outflow per fine cell
    const net = [];
    for (const row of F.net) {
      const c = row[0];
      const s = p < 0 ? row[1] + row[2] + row[3] + row[4] : row[1 + p];
      const e = p < 0 ? row[5] + row[6] + row[7] + row[8] : row[5 + p];
      const n = s + e;
      if (n < 2) continue;
      net.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: A.cellPoly(c) }, properties: { c, v: (e - s) / n, n, s, e } });
    }
    setData('net', { type: 'FeatureCollection', features: net });
    const od = F.od.filter((r) => r[2] === p).slice(0, 45);
    const max = Math.max(1, ...od.map((r) => r[3]));
    setData('flows', { type: 'FeatureCollection', features: od.map(([o, d, , c]) => ({
      type: 'Feature', geometry: { type: 'LineString', coordinates: arc(A.coarseCenter(o), A.coarseCenter(d)) }, properties: { w: 0.15 + 0.85 * (c / max) } })) });
    $('#aLegend').innerHTML = `<div class="cap">Bilanz je Feld: mehr Fahrten beginnen (rot) oder enden (blau)</div>
      <div class="bar" style="background:${gradient([R.div.neg[0], R.div.neg[1], R.div.neg[2], R.div.mid, R.div.pos[0], R.div.pos[1], R.div.pos[2]])}"></div>
      <div class="scale"><span>Abfluss</span><span>ausgeglichen</span><span>Zufluss</span></div>`;
    const top = od.slice(0, 10);
    $('#aMore').innerHTML = `${basisBox()}
      <div class="block"><p class="hint" style="margin-top:0">Linien zeigen die häufigsten Verbindungen zwischen 1-km-Feldern, kräftiger zum Ziel hin. Rote Felder leeren sich in dieser Tageszeit, blaue füllen sich.</p></div>
      <div class="block"><h2>Häufigste Verbindungen${p >= 0 ? `, ${esc(F.dayparts[p])}` : ''}</h2>
      ${top.length ? `<ul class="rows">${top.map(([o, d, , c]) => {
        const [ol, oa] = A.coarseCenter(o), [dl, da] = A.coarseCenter(d);
        return `<li><span class="main"><b>${esc(nearestStationName(ol, oa))}</b><small>nach ${esc(nearestStationName(dl, da))}, ${fmtDist(hav(oa, ol, da, dl))}</small></span><span class="val">${nf.format(c)}<small>Fahrten</small></span></li>`;
      }).join('')}</ul>` : '<p class="hint">Noch keine Fahrten in diesem Zeitraum.</p>'}</div>`;
  }

  function arc(a, b) {
    const [x0, y0] = a, [x1, y1] = b;
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    const dx = x1 - x0, dy = (y1 - y0) * 1.58; // aspect at 51°N
    const cx = mx - dy * 0.18 / 1.0, cy = my + dx * 0.18 / 1.58;
    const pts = [];
    for (let k = 0; k <= 20; k++) {
      const t = k / 20, u = 1 - t;
      pts.push([u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * y0 + 2 * u * t * cy + t * t * y1]);
    }
    return pts;
  }

  function showNetCell(c) {
    const A = S.an; const row = A.flows.net.find((r) => r[0] === c);
    if (!row) return;
    const [lng, lat] = A.cellCenter(c);
    const names = A.flows.dayparts;
    showDetail('#detailA', `
      <p class="kicker">Feld bei ${esc(nearestStationName(lng, lat))}</p>
      <h3>${nf.format(row.slice(1, 5).reduce((a, b) => a + b, 0))} ab, ${nf.format(row.slice(5).reduce((a, b) => a + b, 0))} an</h3>
      <ul class="rows">${names.map((n, k) => `<li><span class="main"><b>${esc(n)}</b></span><span class="val">${row[1 + k]} / ${row[5 + k]}<small>Abfahrten / Ankünfte</small></span></li>`).join('')}</ul>`, { keepSel: true });
    select({ type: 'Polygon', coordinates: A.cellPoly(c) });
  }

  // ---- stations
  let anstKey = '';
  function renderStations() {
    const A = S.an, St = A.stations;
    const key = `${S.day}|${A.stamp}`;
    if (key !== anstKey) {
      anstKey = key;
      setData('anst', { type: 'FeatureCollection', features: St.uid.map((u, j) => {
        const props = { j };
        for (let h = 0; h < 24; h++) {
          const e = A.combine(St.empty.wd[j], St.empty.we[j], h), a = A.combine(St.avg.wd[j], St.avg.we[j], h);
          props[`e${h}`] = e == null ? -1 : e; props[`a${h}`] = a == null ? -1 : a / 10;
        }
        return { type: 'Feature', geometry: { type: 'Point', coordinates: [St.lng[j], St.lat[j]] }, properties: props };
      }) });
    }
    paintHour();
    $('#aLegend').innerHTML = `<div class="cap">Chance, dass die Station leer ist (Größe: Ø Räder)</div>
      <div class="bar" style="background:${gradient(R.red)}"></div><div class="scale"><span>0 %</span><span>50 %</span><span>100 %</span></div>`;
    $('#aMore').innerHTML = `${basisBox()}<div class="block" id="stList"></div>`;
    renderStationList();
  }

  function renderStationList() {
    const el = $('#stList'); if (!el) return;
    const A = S.an, St = A.stations, h = S.hour;
    const rows = St.uid.map((u, j) => ({ j, e: A.combine(St.empty.wd[j], St.empty.we[j], h), a: A.combine(St.avg.wd[j], St.avg.we[j], h) }))
      .filter((r) => r.e != null);
    const empty = rows.slice().sort((x, y) => y.e - x.e || x.a - y.a).slice(0, 8);
    const full = rows.slice().sort((x, y) => y.a - x.a).slice(0, 5);
    const li = (r, v, sub) => `<li><button class="rowbtn" data-act="anst" data-j="${r.j}"><span class="main"><b>${esc(St.name[r.j])}</b><small>${sub}</small></span><span class="val">${v}</span></button></li>`;
    el.innerHTML = `<h2>Oft leer um ${h} Uhr</h2><ul class="rows">${empty.map((r) => li(r, `${Math.round(r.e)} %<small>leer</small>`, `Ø ${nf1.format(r.a / 10)} Räder`)).join('')}</ul>
      <h2 style="margin-top:16px">Meist gut gefüllt</h2><ul class="rows">${full.map((r) => li(r, `${nf1.format(r.a / 10)}<small>Räder Ø</small>`, `${Math.round(r.e)} % leer`)).join('')}</ul>`;
  }

  function stationCharts(j) {
    const A = S.an, St = A.stations;
    const avg = (d) => St.avg[d][j].map((v) => v == null ? null : v / 10);
    return `${lineChart({ title: 'Räder im Tagesverlauf', sub: 'Durchschnitt', series: [{ name: 'Mo–Fr', color: C.wd, values: avg('wd') }, { name: 'Sa/So', color: C.we, values: avg('we') }], now: S.mode === 'analyse' ? S.hour : localHour(now()) })}
      ${lineChart({ title: 'Chance, dass sie leer ist', unit: '%', yMax: 100, series: [{ name: 'Mo–Fr', color: C.wd, values: St.empty.wd[j] }, { name: 'Sa/So', color: C.we, values: St.empty.we[j] }], now: S.mode === 'analyse' ? S.hour : localHour(now()) })}`;
  }

  function showAnStation(j, quiet) {
    const A = S.an, St = A.stations;
    S.sel = { type: 'anst', j };
    const e = A.combine(St.empty.wd[j], St.empty.we[j], S.hour);
    showDetail('#detailA', `
      <p class="kicker"><span class="dot" style="background:${C.station}"></span>Station</p>
      <h3>${esc(St.name[j])}</h3>
      <p class="hint" style="margin-top:-4px">${e == null ? 'Keine Daten für diese Stunde.' : `${dayLabel(S.day)} um ${S.hour} Uhr in ${Math.round(e)} % der Abfragen leer.`}</p>
      ${stationCharts(j)}`, { keepSel: true, quiet });
    select({ type: 'Point', coordinates: [St.lng[j], St.lat[j]] });
    if (!quiet) flyTo([St.lng[j], St.lat[j]], 14);
  }

  // ---- idle
  function renderIdle() {
    if (!S.live || S.mode !== 'analyse' || S.tab !== 'standzeit') return;
    const t = now(), bins = [0, 0, 0, 0];
    const cls = (b) => { const d = (t - b.since) / 86400; return d < 1 ? 0 : d < 3 ? 1 : d < 7 ? 2 : 3; };
    const feats = [];
    for (const b of S.live.bikes) {
      if (!b.since) continue;
      const c = cls(b); bins[c]++;
      feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [b.lng, b.lat] }, properties: { c, id: b.bike } });
    }
    setData('idle', { type: 'FeatureCollection', features: feats });
    const labels = ['unter 1 Tag', '1–3 Tage', '3–7 Tage', 'über 7 Tage'];
    $('#aLegend').innerHTML = `<div class="cap">Wie lange ein Rad unberührt am selben Ort steht</div>
      <div class="cats">${labels.map((l, k) => `<span><i style="background:${R.idle[k]}"></i>${l} (${nf.format(bins[k])})</span>`).join('')}</div>`;
    const longest = S.live.bikes.filter((b) => b.since).sort((a, b) => a.since - b.since).slice(0, 15);
    const startTs = S.an?.window?.from;
    $('#aMore').innerHTML = `${S.an ? basisBox() : ''}
      <div class="block"><h2>Am längsten unbewegt</h2><ul class="rows">${longest.map((b) => {
        const st = b.kind === 'station' ? S.live.stById.get(String(b.place_uid)) : null;
        return `<li><button class="rowbtn" data-act="bike" data-id="${esc(b.bike)}"><span class="dot" style="background:${R.idle[cls(b)]}"></span>
          <span class="main"><b>Rad ${esc(b.bike)}</b><small>${st ? esc(st.name) : 'frei abgestellt'}</small></span>
          <span class="val">${b.since_censored ? 'mind. ' : ''}${fmtDur(t - b.since).replace(' Tagen', ' Tg.')}</span></button></li>`;
      }).join('')}</ul>
      <p class="hint">Ein Rad gilt als bewegt, wenn es aus dem Feed verschwindet oder sich mehr als 100 m verschiebt.${startTs ? ` Die Aufzeichnung beginnt am ${fDM.format(new Date(startTs * 1000))}; ältere Standzeiten sind als „mind.“ markiert.` : ''}</p></div>`;
  }

  // ---------------------------------------------------------------- hour UI
  function syncHourUI() {
    $('#hRange').value = S.hour;
    $('#hLabel').textContent = `${S.hour} Uhr`;
    $('#hRange').setAttribute('aria-valuetext', `${S.hour} Uhr`);
    for (const b of $$('#dayType button')) b.setAttribute('aria-checked', String(b.dataset.d === S.day));
    for (const b of $$('#partBar button')) b.setAttribute('aria-checked', String(+b.dataset.p === S.part));
  }
  let hTimer = 0;
  function stopHourPlay() { S.hPlaying = false; clearInterval(hTimer); $('#hPlay').classList.remove('on'); }
  function startHourPlay() {
    S.hPlaying = true; $('#hPlay').classList.add('on');
    clearInterval(hTimer);
    hTimer = setInterval(() => { S.hour = (S.hour + 1) % 24; syncHourUI(); paintHour(); }, 900);
  }

  // ---------------------------------------------------------------- detail
  function showDetail(sel, html, opts = {}) {
    const el = $(sel);
    el.innerHTML = `<button class="x" type="button" aria-label="Schließen" data-act="close">×</button>${html}`;
    el.hidden = false;
    bindCharts(el);
    if (!opts.keepSel) S.sel = null;
    if (!opts.quiet) {
      if (!isDesktop() && sheetState === 'peek') setSheet('half');
      const sc = $('#scroll');
      requestAnimationFrame(() => {
        const peekH = $('.peek', el.parentElement).offsetHeight;
        const top = el.offsetTop - peekH - 8;
        if (sc.scrollTop > top) sc.scrollTo({ top: Math.max(0, top), behavior: REDUCED ? 'auto' : 'smooth' });
      });
    }
  }
  function closeDetail(silent) {
    for (const el of $$('.detail')) { el.hidden = true; el.innerHTML = ''; }
    S.sel = null;
    if (styleReady) select(null);
    if (!silent && !isDesktop() && sheetState === 'half') setSheet('peek');
  }

  // ---------------------------------------------------------------- charts
  // Small hand-rolled SVG charts: 2px lines, recessive grid, direct labels,
  // hover/tap crosshair tooltip. Values with null are gaps.
  const CW = 340;
  function niceMax(v) {
    if (!(v > 0)) return 1;
    const p = 10 ** Math.floor(Math.log10(v)), f = v / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }
  let chartSeq = 0;
  const chartData = new Map();

  function lineChart({ title, sub, series, now: nowH, unit = '', yMax }) {
    const H = 150, L = 30, Rr = 58, T = 10, B = 22, w = CW - L - Rr, h = H - T - B;
    const all = series.flatMap((s) => s.values).filter((v) => v != null);
    if (!all.length) return `<div class="chart"><div class="chart-title"><h2>${title}</h2></div><p class="hint">Noch keine Daten.</p></div>`;
    const ymax = yMax ?? niceMax(Math.max(...all) * 1.08);
    const X = (i) => L + (i / 23) * w, Y = (v) => T + h - (v / ymax) * h;
    const grid = [0, 0.5, 1].map((f) => `<line x1="${L}" x2="${L + w}" y1="${Y(ymax * f)}" y2="${Y(ymax * f)}"/>`).join('');
    const ylab = [0, 0.5, 1].map((f) => `<text x="${L - 6}" y="${Y(ymax * f) + 3.5}" text-anchor="end">${nf1.format(ymax * f)}${f === 1 ? unit : ''}</text>`).join('');
    const xlab = [0, 6, 12, 18, 23].map((hh) => `<text x="${X(hh)}" y="${H - 5}" text-anchor="middle">${hh === 23 ? '23' : hh}</text>`).join('');
    const paths = series.map((s) => {
      let d = '', pen = false;
      s.values.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`; pen = true; });
      return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    }).join('');
    // direct labels at the last value, nudged apart
    const ends = series.map((s) => { let i = s.values.length - 1; while (i >= 0 && s.values[i] == null) i--; return i < 0 ? null : { s, y: Y(s.values[i]) }; }).filter(Boolean);
    ends.sort((a, b) => a.y - b.y);
    for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 13) ends[k].y = ends[k - 1].y + 13;
    const labels = ends.map((e) => `<circle cx="${L + w + 6}" cy="${e.y}" r="3.5" fill="${e.s.color}"/><text class="dl" x="${L + w + 13}" y="${e.y + 4}">${e.s.name}</text>`).join('');
    const nowLine = nowH != null ? `<line class="now" x1="${X(nowH)}" x2="${X(nowH)}" y1="${T}" y2="${T + h}"/>` : '';
    const id = `c${++chartSeq}`;
    chartData.set(id, { kind: 'hour', series, X, L, w, unit, fmt: (i) => `${i} Uhr` });
    return `<div class="chart" data-chart="${id}"><div class="chart-title"><h2>${title}</h2>${sub ? `<span>${sub}</span>` : ''}</div>
      <svg viewBox="0 0 ${CW} ${H}" role="img" aria-label="${esc(title)}">
        <g class="grid">${grid}</g><g class="axis">${ylab}${xlab}</g>${nowLine}${paths}${labels}
        <line class="xh" x1="0" x2="0" y1="${T}" y2="${T + h}" stroke="${C.muted}" stroke-width="1" visibility="hidden"/>
        <rect class="hit" x="${L}" y="${T}" width="${w}" height="${h}"/></svg></div>`;
  }

  function timeChart({ title, t, values, color }) {
    if (!t || t.length < 2) return `<div class="chart"><div class="chart-title"><h2>${title}</h2></div><p class="hint">Noch keine Daten.</p></div>`;
    const H = 140, L = 30, Rr = 10, T = 10, B = 22, w = CW - L - Rr, h = H - T - B;
    const ts = t[0], te = t[t.length - 1], span = Math.max(1, te - ts);
    const ymax = niceMax(Math.max(...values) * 1.08);
    const X = (x) => L + ((x - ts) / span) * w, Y = (v) => T + h - (v / ymax) * h;
    let d = '';
    values.forEach((v, i) => { d += `${i ? 'L' : 'M'}${X(t[i]).toFixed(1)},${Y(v).toFixed(1)}`; });
    const days = [];
    for (let x = ts - (ts % 3600); x <= te; x += 3600) if (localHour(x) === 0 && x > ts) days.push(x);
    const grid = [0, 0.5, 1].map((f) => `<line x1="${L}" x2="${L + w}" y1="${Y(ymax * f)}" y2="${Y(ymax * f)}"/>`).join('')
      + days.map((x) => `<line x1="${X(x)}" x2="${X(x)}" y1="${T}" y2="${T + h}"/>`).join('');
    const ylab = [0, 0.5, 1].map((f) => `<text x="${L - 6}" y="${Y(ymax * f) + 3.5}" text-anchor="end">${nf.format(ymax * f)}</text>`).join('');
    const xlab = days.map((x) => `<text x="${X(x + 43200)}" y="${H - 5}" text-anchor="middle">${fDay.format(new Date((x + 43200) * 1000))}</text>`).filter((_, k, a) => a.length < 9 || k % 2 === 0).join('');
    const id = `c${++chartSeq}`;
    chartData.set(id, { kind: 'time', t, values, X, L, w, color });
    return `<div class="chart" data-chart="${id}"><div class="chart-title"><h2>${title}</h2><span>geschätzt</span></div>
      <svg viewBox="0 0 ${CW} ${H}" role="img" aria-label="${esc(title)}"><g class="grid">${grid}</g><g class="axis">${ylab}${xlab}</g>
      <path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
      <line class="xh" x1="0" x2="0" y1="${T}" y2="${T + h}" stroke="${C.muted}" stroke-width="1" visibility="hidden"/>
      <rect class="hit" x="${L}" y="${T}" width="${w}" height="${h}"/></svg></div>`;
  }

  function barChart({ title, sub, values, labels, tickEvery, tickLabel, unitX }) {
    if (!values.some((v) => v > 0)) return `<div class="chart"><div class="chart-title"><h2>${title}</h2></div><p class="hint">Noch keine Daten.</p></div>`;
    const H = 130, L = 30, Rr = 6, T = 8, B = 22, w = CW - L - Rr, h = H - T - B;
    const n = values.length, bw = w / n, ymax = niceMax(Math.max(...values) * 1.05);
    const Y = (v) => T + h - (v / ymax) * h;
    const bars = values.map((v, i) => {
      if (!v) return '';
      const x = L + i * bw + 1, bwid = Math.max(1, bw - 2), y = Y(v), r = Math.min(3, bwid / 2, (T + h - y));
      return `<path d="M${x},${T + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + bwid - r}Q${x + bwid},${y} ${x + bwid},${y + r}V${T + h}Z" fill="${C.station}"/>`;
    }).join('');
    const grid = [0, 0.5, 1].map((f) => `<line x1="${L}" x2="${L + w}" y1="${Y(ymax * f)}" y2="${Y(ymax * f)}"/>`).join('');
    const ylab = [0.5, 1].map((f) => `<text x="${L - 6}" y="${Y(ymax * f) + 3.5}" text-anchor="end">${nf.format(ymax * f)}</text>`).join('');
    const xlab = values.map((_, i) => i % tickEvery === 0 && tickLabel(i) !== '' ? `<text x="${L + i * bw}" y="${H - 5}" text-anchor="middle">${tickLabel(i)}</text>` : '').join('')
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
      const handler = (e) => {
        const r = svg.getBoundingClientRect();
        const x = ((e.clientX - r.left) / r.width) * CW;
        let html = '', cx = 0;
        if (d.kind === 'hour') {
          const i = Math.round(((x - d.L) / d.w) * 23);
          if (i < 0 || i > 23) return;
          cx = d.X(i);
          html = `${d.fmt(i)}: ${d.series.map((s) => `${s.name} ${s.values[i] == null ? '–' : nf1.format(s.values[i]) + d.unit}`).join(', ')}`;
        } else if (d.kind === 'time') {
          const tt = d.t[0] + ((x - d.L) / d.w) * (d.t[d.t.length - 1] - d.t[0]);
          let i = 0; for (let k = 0; k < d.t.length; k++) if (Math.abs(d.t[k] - tt) < Math.abs(d.t[i] - tt)) i = k;
          cx = d.X(d.t[i]);
          html = `${fDate.format(new Date(d.t[i] * 1000))} ${fTime.format(new Date(d.t[i] * 1000))}: ${nf.format(d.values[i])} unterwegs`;
        } else {
          const i = Math.floor(((x - d.L) / d.w) * d.n);
          if (i < 0 || i >= d.n) return;
          html = `${d.labels[i]}: ${nf.format(d.values[i])} Fahrten`;
        }
        if (xh) { xh.setAttribute('x1', cx); xh.setAttribute('x2', cx); xh.setAttribute('visibility', 'visible'); }
        const tip = $('#tip');
        tip.textContent = html; tip.hidden = false;
        tip.style.left = `${Math.min(Math.max(e.clientX, 90), innerWidth - 90)}px`;
        tip.style.top = `${r.top + 4}px`;
        clearTimeout(tipTimer);
        if (e.pointerType !== 'mouse') tipTimer = setTimeout(hide, 2500);
      };
      const hide = () => { $('#tip').hidden = true; if (xh) xh.setAttribute('visibility', 'hidden'); };
      svg.addEventListener('pointermove', handler);
      svg.addEventListener('pointerdown', handler);
      svg.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hide(); });
    }
  }

  // ---------------------------------------------------------------- events
  function bindUI() {
    $$('.modes button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
    $$('#aTabs button').forEach((b) => b.addEventListener('click', () => {
      S.tab = b.dataset.tab; closeDetail(true); updateHash(); enterAnalysis();
      b.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: REDUCED ? 'auto' : 'smooth' });
    }));
    for (const id of ['#liveLayers', '#tlLayers']) {
      const mode = id === '#liveLayers' ? 'live' : 'verlauf';
      $$(`${id} .chip`).forEach((c) => c.addEventListener('click', () => {
        const k = c.dataset.layer, on = !S.layers[mode][k];
        S.layers[mode][k] = on;
        c.classList.toggle('on', on); c.setAttribute('aria-pressed', String(on));
        applyVisibility();
      }));
    }
    $('#searchForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const q = $('#searchInput').value.trim();
      if (!q) return;
      $('#searchInput').blur();
      if (S.live?.byId.has(q)) { $('#searchHint').textContent = ''; showBike(q); return; }
      const T = S.tl;
      $('#searchHint').textContent = `Rad ${q} ist gerade nicht im Feed, also vermutlich unterwegs oder in der Werkstatt.`;
      if (T?.bikeIndex.has(q) || !T) {
        $('#searchHint').innerHTML += ` <button class="btn sm ghost" data-act="trail" data-id="${esc(q)}">Im Verlauf suchen</button>`;
      }
    });
    $('#btnNear').addEventListener('click', () => locate(false));
    const tabs = $('#aTabs');
    const tabEnd = () => tabs.classList.toggle('at-end', tabs.scrollLeft + tabs.clientWidth >= tabs.scrollWidth - 4);
    tabs.addEventListener('scroll', tabEnd, { passive: true }); addEventListener('resize', tabEnd); setTimeout(tabEnd, 500);
    $('#scroll').addEventListener('scroll', (e) => e.target.classList.toggle('scrolled', e.target.scrollTop > 2), { passive: true });
    $('#btnLocate').addEventListener('click', () => locate(true));
    $('#btnHome').addEventListener('click', () => map.fitBounds(KOELN, { padding: isDesktop() ? { left: 440, top: 40, right: 40, bottom: 40 } : { top: 40, left: 20, right: 20, bottom: sheetVisibleHeight() + 10 }, duration: REDUCED ? 0 : 600 }));
    $('#repoLink').href = S.cfg?.repo || '#';

    // timeline controls
    $('#tlRange').addEventListener('input', (e) => { S.frame = +e.target.value; if (S.playing) stopPlay(); renderFrame(); });
    $('#tlPlay').addEventListener('click', () => (S.playing ? stopPlay() : startPlay()));
    $('#tlSpeed').addEventListener('click', () => {
      S.speed = S.speed === 1 ? 2 : S.speed === 2 ? 4 : 1;
      $('#tlSpeed').textContent = `${S.speed}×`;
      if (S.playing) startPlay();
    });
    $$('#tlSpan button').forEach((b) => b.addEventListener('click', () => {
      S.span = +b.dataset.h;
      $$('#tlSpan button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
      if (S.tl) setupScrubber();
    }));
    addEventListener('keydown', (e) => {
      if (S.mode !== 'verlauf' || !S.tl || /input|textarea/i.test(document.activeElement?.tagName) && document.activeElement.type !== 'range') return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        if (document.activeElement?.id === 'tlRange') return; // native handling
        S.frame = Math.min(Math.max(S.frame + (e.key === 'ArrowRight' ? 1 : -1), +$('#tlRange').min), +$('#tlRange').max);
        $('#tlRange').value = S.frame; renderFrame(); e.preventDefault();
      } else if (e.key === ' ' && document.activeElement === document.body) { S.playing ? stopPlay() : startPlay(); e.preventDefault(); }
    });

    // analysis controls
    $('#hRange').addEventListener('input', (e) => { S.hour = +e.target.value; stopHourPlay(); syncHourUI(); paintHour(); });
    $('#hRange').addEventListener('change', () => { if (S.tab === 'dichte') renderDensity(); });
    $('#hPlay').addEventListener('click', () => (S.hPlaying ? stopHourPlay() : startHourPlay()));
    $$('#dayType button').forEach((b) => b.addEventListener('click', () => { S.day = b.dataset.d; syncHourUI(); renderTab(); }));
    $$('#partBar button').forEach((b) => b.addEventListener('click', () => { S.part = +b.dataset.p; syncHourUI(); closeDetail(true); renderTab(); }));

    // delegated actions inside the panel
    $('#panel').addEventListener('click', (e) => {
      const el = e.target.closest('[data-act]');
      if (!el) return;
      const a = el.dataset.act, id = el.dataset.id;
      if (a === 'close') closeDetail();
      else if (a === 'bike') showBike(id);
      else if (a === 'station') showStation(id);
      else if (a === 'trail') showTrailFor(id);
      else if (a === 'tlbike') { const i = S.tl.bikeIndex.get(id); if (i != null) showTlBike(i); }
      else if (a === 'livebike') { setMode('live'); showBike(id); }
      else if (a === 'cleartrail') { S.trail = null; setData('trail', EMPTY); applyVisibility(); closeDetail(); }
      else if (a === 'frame') { S.frame = nearestFrame(+el.dataset.t); $('#tlRange').value = S.frame; renderFrame(); }
      else if (a === 'cell') { const j = +el.dataset.j; showCell(j); flyTo(S.an.cellCenter(S.an.cells[j]), 14); }
      else if (a === 'anst') showAnStation(+el.dataset.j);
    });
    $('#near').addEventListener('click', (e) => { if (e.target.id === 'btnNear2') locate(false); });

    addEventListener('hashchange', () => { const m = S.mode, t = S.tab; readHash(); if (m !== S.mode) setMode(S.mode); else if (t !== S.tab) enterAnalysis(); });
    setInterval(updateStatus, 30000);
    setInterval(() => { if (S.mode === 'live' && document.visibilityState === 'visible') loadLive(true); }, 5 * 60000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.live && now() - Date.parse(S.live.meta.ts) / 1000 > 16 * 60) loadLive(true); });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => location.reload());
  }

  // ---------------------------------------------------------------- boot
  let booted = false;
  async function boot() {
    if (booted) return; booted = true;
    await liveReady;
    renderLive();
    setMode(S.mode, { sheet: 'peek' });
    requestAnimationFrame(() => map.fitBounds(KOELN, { duration: 0, padding: isDesktop()
      ? { left: 440, top: 30, right: 30, bottom: 30 } : { top: 20, left: 12, right: 12, bottom: sheetVisibleHeight() + 8 } }));
  }

  let liveReady;
  async function start() {
    readHash();
    try { S.cfg = await getJSON('config.json'); } catch { S.cfg = { style_light: 'https://tiles.openfreemap.org/styles/positron', style_dark: 'https://tiles.openfreemap.org/styles/dark' }; }
    bindUI();
    initSheet();
    for (const s of $$('section.mode')) s.hidden = s.dataset.mode !== S.mode;
    for (const b of $$('.modes button')) b.setAttribute('aria-selected', String(b.dataset.mode === S.mode));
    liveReady = loadLive();
    if (typeof maplibregl === 'undefined') { toast('Die Kartenbibliothek konnte nicht geladen werden. Bitte Seite neu laden.', 10000); return; }
    initMap(S.cfg);
  }
  window.__app = S; // for debugging and screenshots
  window.__ui = { setMode, setSheet, showStation, showBike, showCell: (j) => showCell(j), flyTo };
  start();
})();
