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
    f: null, tlEnd: null, raster: null, stList: null, wPlaying: false,
    layers: { live: { stations: true, free: true, heat: false }, verlauf: { stations: true, free: true, heat: false } },
    live: null, tl: null, frame: -1, span: 168, playing: false, speed: 1,
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
      germanLabels();
      // MapLibre opens the compact attribution on load; keep it as the (i) button
      map.once('idle', () => $('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'));
      setupLayers();
      boot();
    });
  }

  // Basemap labels in German where OSM has a German name ("Köln", not "Cologne").
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

  const EMPTY = { type: 'FeatureCollection', features: [] };
  const zoomRadius = (z10, z14, z18) => ['interpolate', ['exponential', 1.6], ['zoom'], 10, z10, 14, z14, 18, z18];

  function setupLayers() {
    const before = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
    for (const id of ['bikes', 'stations', 'netc', 'idle', 'sel', 'me', 'trail', 'anst', 'qpt'])
      map.addSource(id, { type: 'geojson', data: EMPTY });
    map.addSource('flows', { type: 'geojson', data: EMPTY, lineMetrics: true });
    map.addSource('raster', { type: 'image', url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      coordinates: [[6.76, 51.09], [7.18, 51.09], [7.18, 50.83], [6.76, 50.83]] });

    // under basemap labels
    map.addLayer({ id: 'raster-l', type: 'raster', source: 'raster', layout: { visibility: 'none' },
      paint: { 'raster-resampling': 'linear', 'raster-opacity': 0.9, 'raster-fade-duration': 0 } }, before);
    map.addLayer({ id: 'live-heat', type: 'heatmap', source: 'bikes', layout: { visibility: 'none' },
      paint: heatPaint(1, 1) }, before);
    map.addLayer({ id: 'qpt-fill', type: 'fill', source: 'qpt', filter: ['==', ['geometry-type'], 'Polygon'], layout: { visibility: 'none' },
      paint: { 'fill-color': hexA(C.ink, 0.06) } }, before);
    map.addLayer({ id: 'qpt-line', type: 'line', source: 'qpt', filter: ['==', ['geometry-type'], 'Polygon'], layout: { visibility: 'none' },
      paint: { 'line-color': C.ink, 'line-width': 1.6, 'line-dasharray': [2, 2] } });
    map.addLayer({ id: 'qpt-dot', type: 'circle', source: 'qpt', filter: ['==', ['geometry-type'], 'Point'], layout: { visibility: 'none' },
      paint: { 'circle-radius': 6, 'circle-color': C.ink, 'circle-stroke-color': C.surface, 'circle-stroke-width': 2.5 } });
    map.addLayer({ id: 'netc', type: 'circle', source: 'netc', layout: { visibility: 'none' },
      paint: { 'circle-radius': ['interpolate', ['exponential', 1.6], ['zoom'], 10, ['*', ['get', 'rel'], 14], 14, ['*', ['get', 'rel'], 44]],
        'circle-color': ['interpolate', ['linear'], ['get', 'v'], -1, R.div.neg[0], -0.5, R.div.neg[1], -0.15, R.div.neg[2], 0, R.div.mid, 0.15, R.div.pos[0], 0.5, R.div.pos[1], 1, R.div.pos[2]],
        'circle-opacity': 0.85, 'circle-stroke-color': C.surface, 'circle-stroke-width': 1 } });

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
      paint: { 'circle-radius': ['interpolate', ['exponential', 1.6], ['zoom'], 10, ['+', 2.5, ['*', 0.8, ['sqrt', ['get', 'a']]]],
          14, ['+', 6, ['*', 2.4, ['sqrt', ['get', 'a']]]], 18, ['+', 12, ['*', 4, ['sqrt', ['get', 'a']]]]],
        'circle-color': ['interpolate', ['linear'], ['get', 'p'], 0, R.red[0], 25, R.red[1], 50, R.red[2], 75, R.red[3], 100, R.red[4]],
        'circle-stroke-color': C.surface, 'circle-stroke-width': 1.2 } });
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
        raf = requestAnimationFrame(() => {
          raf = 0;
          const anyPoint = S.mode === 'analyse' && (S.tab === 'verfuegbarkeit' || S.tab === 'dichte');
          map.getCanvas().style.cursor = anyPoint ? 'crosshair' : pick(e.point) ? 'pointer' : '';
        });
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
    vis('raster-l', a && (t === 'verfuegbarkeit' || t === 'dichte'));
    const q = a && S.sel?.type === 'point' && (t === 'verfuegbarkeit' || t === 'dichte');
    vis('qpt-fill', q); vis('qpt-line', q); vis('qpt-dot', q);
    vis('netc', a && t === 'stroeme');
    vis('flows-line', a && t === 'stroeme');
    vis('an-st', a && t === 'stationen');
    vis('idle-dots', a && t === 'standzeit');
  }

  // ---------------------------------------------------------------- picking
  const PRIORITY = ['stations-c', 'an-st', 'free-dots', 'idle-dots', 'trail-pts', 'netc'];
  function pick(pt) {
    const layers = PRIORITY.filter(isVis);
    if (!layers.length) return null;
    const r = isDesktop() ? 6 : 14;
    const fs = map.queryRenderedFeatures([[pt.x - r, pt.y - r], [pt.x + r, pt.y + r]], { layers });
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
    if (S.mode === 'analyse' && (S.tab === 'verfuegbarkeit' || S.tab === 'dichte')) {
      pointQuery(e.lngLat.lng, e.lngLat.lat); applyVisibility(); return;
    }
    const f = pick(e.point);
    if (!f) { closeDetail(); return; }
    const p = f.properties;
    switch (f.layer.id) {
      case 'stations-c': S.mode === 'verlauf' ? showTlStation(p.i) : showStation(p.uid); break;
      case 'free-dots': S.mode === 'verlauf' ? showTlBike(p.i) : showBike(p.id); break;
      case 'idle-dots': showBike(p.id); break;
      case 'trail-pts': showTrail(); break;
      case 'netc': showNetCell(p, f.geometry.coordinates); break;
      case 'an-st': stationQuery(p.uid); break;
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
    if (S.mode === 'analyse' && mode !== 'analyse') stopWindowPlay();
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
    stationQuery(String(uid), true, '#stHist').catch(() => { const el = $('#stHist'); if (el) el.innerHTML = ''; });
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
    $('#nearChance').innerHTML = '<button class="btn sm ghost" data-act="pointme" type="button">Wie oft steht hier ein Rad?</button>';
  }

  // ---------------------------------------------------------------- history index + worker
  let tlIndex = null, tlIndexAt = 0;
  async function ensureIndex() {
    if (tlIndex && now() - tlIndexAt < 600) return tlIndex;
    tlIndex = (await getJSON('tl/index.json')).days;
    tlIndexAt = now();
    return tlIndex;
  }
  const lastDate = () => tlIndex[tlIndex.length - 1].date;
  const firstDate = () => tlIndex[0].date;
  const addDays = (date, n) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const fmtD = (date) => `${date.slice(8, 10)}.${date.slice(5, 7)}.`;

  let worker = null, rid = 0;
  const pending = new Map();
  function rpc(op, args) {
    if (!worker) {
      worker = new Worker('worker.js');
      worker.onmessage = (e) => { const p = pending.get(e.data.id); pending.delete(e.data.id); if (p) (e.data.ok ? p.res(e.data.res) : p.rej(new Error(e.data.err))); };
      worker.postMessage({ id: 0, op: 'init', args: { base: new URL('.', location.href).href } });
    }
    return new Promise((res, rej) => { const id = ++rid; pending.set(id, { res, rej }); worker.postMessage({ id, op, args }); });
  }

  // ---------------------------------------------------------------- timeline
  const KEY = 12;
  async function ensureTimeline() {
    const idx = await ensureIndex();
    const end = S.tlEnd && S.tlEnd <= lastDate() ? S.tlEnd : lastDate();
    const nDays = Math.ceil(S.span / 24) + (S.span <= 24 ? 1 : 0);
    const dates = idx.map((d) => d.date).filter((d) => d <= end && d > addDays(end, -nDays - 1));
    const key = dates.join(',');
    if (S.tl && S.tl.key === key && now() - S.tl.loaded < 600) return S.tl;
    const files = await Promise.all(dates.map((d) => getJSON(`tl/${d}.json`)));
    // merge days into one global-index timeline; a day starts with a full snapshot
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
    const T = { key, dates, t, frames, gone, reset, bikes, stations, bikeIndex: bIdx, N: bikes.length,
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
    S.tl = T;
    S.frame = -1;
    // bikes in use for the sparkline, computed in the worker
    rpc('inuseSeries', { dates, P: tripParams() }).then((r) => {
      if (S.tl !== T) return;
      const m = new Map(r.t.map((x, k) => [x, r.inuse[k]]));
      T.inuse = T.t.map((x) => m.get(x) ?? 0);
      if (S.mode === 'verlauf') { setupScrubber(); renderFrame(); }
    }).catch(() => {});
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
      if (!T || !T.t.length || S.frame < 0) return;
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
      $('#tUse').textContent = T.inuse ? nf.format(T.inuse[S.frame] ?? 0) : '…';
      $('#tlRange').setAttribute('aria-valuetext', `${fDate.format(new Date(t * 1000))} ${fTime.format(new Date(t * 1000))}`);
    });
  }

  function spanStart() {
    const T = S.tl, tEnd = T.t[T.t.length - 1];
    return Math.max(0, T.t.findIndex((t) => t >= tEnd - S.span * 3600));
  }

  function setupScrubber() {
    const T = S.tl, r = $('#tlRange');
    const i0 = spanStart(), i1 = T.t.length - 1;
    r.min = i0; r.max = i1;
    if (S.frame < i0 || S.frame > i1) S.frame = i1;
    r.value = S.frame;
    const svg = $('#tlSpark');
    const n = i1 - i0 + 1;
    const vals = (T.inuse || T.t.map(() => 0)).slice(i0, i1 + 1);
    const max = Math.max(5, ...vals);
    const ts = T.t[i0], te = T.t[i1], span = Math.max(1, te - ts);
    const X = (t) => ((t - ts) / span) * 1000;
    const Y = (v) => 50 - (v / max) * 44;
    let d = '';
    for (let k = 0; k < n; k++) d += `${k ? 'L' : 'M'}${X(T.t[i0 + k]).toFixed(1)},${Y(vals[k]).toFixed(1)}`;
    svg.setAttribute('viewBox', '0 0 1000 52');
    const days = [], ticks = [];
    for (let t = ts - (ts % 3600); t <= te; t += 3600) {
      const h = localHour(t);
      if (h === 0 && t > ts) days.push(t);
      if (S.span <= 24 ? h % 6 === 0 : (S.span <= 72 ? h === 12 || h === 0 : h === 12)) ticks.push(t);
    }
    svg.innerHTML = `${days.map((t) => `<line class="day" x1="${X(t)}" x2="${X(t)}" y1="0" y2="52"/>`).join('')}
      ${n > 1 && T.inuse ? `<path class="area" d="${d}L1000,52L0,52Z"/><path class="ln" d="${d}"/>` : ''}`;
    const every = S.span > 200 ? 2 : 1;
    $('#tlTicks').innerHTML = ticks.filter((_, k) => k % every === 0).map((t) => {
      const lab = S.span <= 24 ? `${localHour(t)} Uhr` : (localHour(t) === 0 ? fDM.format(new Date(t * 1000)) : fDay.format(new Date(t * 1000)));
      const x = X(t) / 10;
      return x > 4 && x < 96 ? `<span style="left:${x}%">${lab}</span>` : '';
    }).join('');
    renderFrame();
  }

  async function enterTimeline(opts = {}) {
    $('#tlTime').textContent = '--:--';
    try {
      await ensureTimeline();
    } catch (err) {
      console.warn(err);
      toast('Verlauf noch nicht verfügbar. Er entsteht mit den nächsten Abfragen.');
      return;
    }
    const T = S.tl;
    if (!T.t.length) { toast('Noch keine Verlaufsdaten.'); return; }
    const end = $('#tlEnd');
    end.min = firstDate(); end.max = lastDate(); end.value = S.tlEnd || lastDate();
    if (opts.frameAt) S.frame = nearestFrame(opts.frameAt);
    else if (S.frame < 0) S.frame = T.t.length - 1;
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
    if (i == null) { toast(`Rad ${id} kommt im gewählten Zeitraum nicht vor.`); return; }
    const stays = [];
    let present = false, last = null;
    for (let f = 0; f < T.t.length; f++) {
      const fr = T.frames[f];
      let hit = -1;
      for (let k = 0; k < fr.length; k += 4) if (fr[k] === i) { hit = k; break; }
      if (hit >= 0) {
        const lat = T.lat0 + fr[hit + 1] / T.scale, lng = T.lng0 + fr[hit + 2] / T.scale, pl = fr[hit + 3];
        if (last && present && hav(last.lat, last.lng, lat, lng) < 60 && last.pl === pl) last.t1 = T.t[f];
        else { last = { lat, lng, pl, t0: T.t[f], t1: T.t[f] }; stays.push(last); }
        present = true;
      } else if (T.reset[f] || T.gone[f].includes(i)) { present = false; }
      else if (present && last) last.t1 = T.t[f];
    }
    if (!stays.length) { toast(`Rad ${id} kommt im gewählten Zeitraum nicht vor.`); return; }
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
    const name = (s) => (s.pl >= 0 ? esc(T.stations[s.pl][1]) : 'frei abgestellt');
    const rows = tr.stays.slice().reverse().slice(0, 60).map((s) => `
      <li><button class="rowbtn" data-act="frame" data-t="${s.t0}"><span class="dot" style="background:${s.pl >= 0 ? C.station : C.free}"></span>
        <span class="main"><b>${name(s)}</b><small>${fDate.format(new Date(s.t0 * 1000))} ${fTime.format(new Date(s.t0 * 1000))} bis ${s.t1 === s.t0 ? '–' : fTime.format(new Date(s.t1 * 1000))}</small></span>
        <span class="val">${fmtDur(Math.max(600, s.t1 - s.t0))}</span></button></li>`).join('');
    showDetail('#detailTl', `
      <p class="kicker">Weg im gewählten Zeitraum</p>
      <h3>Rad ${esc(tr.id)}</h3>
      <p class="hint" style="margin-top:0">${tr.stays.length} Standorte. Antippen springt zum Zeitpunkt.</p>
      <ul class="rows">${rows}</ul>
      <div class="actions"><button class="btn sm ghost" data-act="cleartrail">Weg ausblenden</button></div>`, { keepSel: true });
  }

  // ---------------------------------------------------------------- analysis filters
  const WD_NAMES = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  const DEFAULT_F = () => {
    const h = localHour(now());
    return { range: 14, from: null, to: null, wd: isWeekend(now()) ? [0, 0, 0, 0, 0, 1, 1] : [1, 1, 1, 1, 1, 0, 0],
      a: h * 4, b: ((h + 1) % 24) * 4 || 96, kind: 'all', R: 400, res: 100, smooth: 150,
      minGone: 100, jump: 300, maxDurH: 4, cell: 1000, top: 40, min: 2, k: 0, idleMin: 0 };
  };
  function loadFilter() {
    try { const s = JSON.parse(localStorage.getItem('kvb-filter') || 'null'); if (s && Array.isArray(s.wd)) return { ...DEFAULT_F(), ...s }; } catch { /* ignore */ }
    return DEFAULT_F();
  }
  function saveFilter() { try { localStorage.setItem('kvb-filter', JSON.stringify(S.f)); } catch { /* ignore */ } }

  const minToStr = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const winMin = () => ({ t0: S.f.a * 15, t1: (S.f.b * 15) % 1440 });
  const winLabel = () => {
    const { a, b } = S.f;
    if (a === b || (a === 0 && b === 96) || (a === 96 && b === 0)) return 'ganzer Tag';
    return `${minToStr(a * 15)}–${b === 96 ? '24:00' : minToStr(b * 15)}`;
  };
  const wdLabel = (wd = S.f.wd) => {
    const on = wd.map(Boolean);
    const key = on.map((x) => (x ? 1 : 0)).join('');
    if (key === '1111111') return 'alle Tage';
    if (key === '1111100') return 'Mo–Fr';
    if (key === '0000011') return 'Sa/So';
    if (key === '0000000') return 'keine Tage';
    return WD_NAMES.filter((_, i) => on[i]).join(', ');
  };
  function filterDates() {
    const idx = tlIndex || [];
    if (!idx.length) return { from: '', to: '', dates: [] };
    let from, to;
    if (S.f.range === 'custom' && S.f.from && S.f.to) { from = S.f.from; to = S.f.to; }
    else if (S.f.range === 'all') { from = firstDate(); to = lastDate(); }
    else { to = lastDate(); from = addDays(to, -(+S.f.range - 1)); }
    if (from > to) [from, to] = [to, from];
    return { from, to, dates: idx.map((d) => d.date).filter((d) => d >= from && d <= to) };
  }
  function F() {
    const { from, to } = filterDates();
    const { t0, t1 } = winMin();
    return { from, to, wd: S.f.wd.map(Boolean), t0, t1, kind: S.f.kind };
  }
  const tripParams = () => ({ minGone: S.f?.minGone ?? 100, jump: S.f?.jump ?? 300, maxDur: (S.f?.maxDurH ?? 4) * 3600 });
  const rangeLabel = () => { const { from, to } = filterDates(); return from ? `${fmtD(from)}–${fmtD(to)}` : ''; };
  const PARAM_LABEL = {
    verfuegbarkeit: () => `Umkreis ${S.f.R} m`, dichte: () => `Glättung ${S.f.smooth} m`, nutzung: () => `ab ${S.f.minGone} m`,
    stroeme: () => `Raster ${fmtDist(S.f.cell)}`, stationen: () => `leer = höchstens ${S.f.k}`, standzeit: () => (S.f.idleMin ? `ab ${S.f.idleMin} Tagen` : 'alle Räder'),
  };

  function syncFilterUI() {
    const { a, b } = S.f;
    $('#wA').value = a; $('#wB').value = b;
    $('#wLabel').textContent = winLabel();
    $('#wDays').textContent = wdLabel();
    // fill between handles; wraps when start is after end
    const fill = $('#wFill'), pa = (a / 96) * 100, pb = (b / 96) * 100;
    const inset = 'calc(12px + (100% - 24px) * ';
    if (a <= b) { fill.style.left = `${inset}${pa / 100})`; fill.style.width = `calc((100% - 24px) * ${(pb - pa) / 100})`; fill.style.background = ''; }
    else {
      fill.style.left = '12px'; fill.style.width = 'calc(100% - 24px)';
      fill.style.background = `linear-gradient(90deg, var(--ink) ${pb}%, transparent ${pb}%, transparent ${pa}%, var(--ink) ${pa}%)`;
    }
    const isIdle = S.tab === 'standzeit';
    $('#timeBar').hidden = isIdle;
    $('#fSumText').textContent = isIdle ? PARAM_LABEL.standzeit() : `${wdLabel()}, ${rangeLabel()}, ${PARAM_LABEL[S.tab]()}`;
    $('#wA').setAttribute('aria-valuetext', minToStr(a * 15));
    $('#wB').setAttribute('aria-valuetext', b === 96 ? '24:00' : minToStr(b * 15));
  }

  function slider(id, label, min, max, step, val, fmt) {
    return `<div class="row"><h3><label for="${id}">${label}</label><output id="${id}-o">${fmt(val)}</output></h3>
      <input class="slider" type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}" data-param="${id.replace('p-', '')}"></div>`;
  }
  function kindSeg() {
    return `<div class="row"><h3>Welche Räder</h3><div class="seg" role="radiogroup" data-seg="kind">
      ${[['all', 'Alle'], ['free', 'Frei abgestellt'], ['station', 'An Stationen']].map(([v, l]) => `<button role="radio" data-v="${v}" aria-checked="${S.f.kind === v}">${l}</button>`).join('')}</div></div>`;
  }
  const FMT = {
    R: (v) => `${v} m`, res: (v) => `${v} m`, smooth: (v) => (+v ? `${v} m` : 'aus'), minGone: (v) => `${v} m`, jump: (v) => `${v} m`,
    maxDurH: (v) => `${nf1.format(v)} h`, cell: (v) => fmtDist(+v), top: (v) => `${v}`, min: (v) => `${v}`, k: (v) => (+v ? `höchstens ${v} ${+v === 1 ? 'Rad' : 'Räder'}` : 'kein Rad'),
    idleMin: (v) => (+v ? `${v} ${+v === 1 ? 'Tag' : 'Tage'}` : 'alle'),
  };
  function tabParams() {
    const f = S.f;
    switch (S.tab) {
      case 'verfuegbarkeit': return slider('p-R', 'Umkreis', 50, 1000, 50, f.R, FMT.R) + kindSeg()
        + slider('p-res', 'Kartenauflösung', 50, 300, 50, f.res, FMT.res);
      case 'dichte': return slider('p-smooth', 'Glättung', 0, 400, 25, f.smooth, FMT.smooth) + kindSeg()
        + slider('p-res', 'Kartenauflösung', 50, 300, 50, f.res, FMT.res);
      case 'nutzung': return tripSliders();
      case 'stroeme': return slider('p-cell', 'Rastergröße für Start und Ziel', 250, 3000, 250, f.cell, FMT.cell)
        + slider('p-top', 'Anzahl Verbindungen', 5, 150, 5, f.top, FMT.top) + slider('p-min', 'Mindestens Fahrten je Verbindung', 1, 30, 1, f.min, FMT.min) + tripSliders();
      case 'stationen': return slider('p-k', 'Als „leer“ gilt', 0, 5, 1, f.k, FMT.k);
      case 'standzeit': return slider('p-idleMin', 'Mindestens unbewegt seit', 0, 14, 1, f.idleMin, FMT.idleMin) + kindSeg();
      default: return '';
    }
  }
  function tripSliders() {
    const f = S.f;
    return `<p class="hint" style="margin:12px 0 0">So werden Fahrten aus dem Feed geschätzt:</p>`
      + slider('p-minGone', 'Rad verschwindet und taucht mindestens so weit entfernt wieder auf', 50, 1000, 50, f.minGone, FMT.minGone)
      + slider('p-jump', 'oder springt zwischen zwei Abfragen weiter als', 100, 2000, 100, f.jump, FMT.jump)
      + slider('p-maxDurH', 'Länger weg zählt als Werkstatt oder Umverteilung', 0.5, 12, 0.5, f.maxDurH, FMT.maxDurH);
  }

  function filterBlock() {
    const { from, to } = filterDates();
    const min = tlIndex.length ? firstDate() : '', max = tlIndex.length ? lastDate() : '';
    const common = S.tab === 'standzeit' ? '' : `
      <div class="row"><h3>Zeitraum</h3>
        <div class="seg" role="radiogroup" data-seg="range">
          ${[[7, '7 Tage'], [14, '14 Tage'], [28, '28 Tage'], ['all', 'Alles']].map(([v, l]) => `<button role="radio" data-v="${v}" aria-checked="${String(S.f.range) === String(v)}">${l}</button>`).join('')}
        </div>
        <div class="dates">
          <label class="field">von <input type="date" id="fFrom" value="${from}" min="${min}" max="${max}"></label>
          <label class="field">bis <input type="date" id="fTo" value="${to}" min="${min}" max="${max}"></label>
        </div></div>
      <div class="row"><h3>Wochentage</h3>
        <div class="wdays">${WD_NAMES.map((n, i) => `<button type="button" data-wd="${i}" aria-pressed="${!!S.f.wd[i]}">${n}</button>`).join('')}</div>
        <div class="quick"><button data-wdp="1111100">Mo–Fr</button><button data-wdp="0000011">Sa/So</button><button data-wdp="1111111">Alle</button></div></div>
      <div class="row"><h3>Uhrzeit</h3><p class="hint" style="margin:0 0 4px">Mit den beiden Reglern oben. Liegt der Beginn hinter dem Ende, geht das Fenster über Mitternacht.</p>
        <div class="quick">${[['ganzer Tag', 0, 96], ['Morgen 6–10', 24, 40], ['Mittag 10–16', 40, 64], ['Abend 16–20', 64, 80], ['Nacht 20–6', 80, 24]]
          .map(([l, a, b]) => `<button data-win="${a},${b}">${l}</button>`).join('')}</div></div>`;
    return `<div class="block filters" id="filters">${common}${tabParams()}</div>`;
  }

  // ---------------------------------------------------------------- analysis
  const RAMP = {
    avail: (DARK ? ['#1b2a42', '#184f95', '#3987e5', '#86b6ef', '#e6f0fd'] : ['#cde2fb', '#86b6ef', '#3987e5', '#1c5cab', '#0d366b']),
    dens: R.heat.slice(1),
  };
  const toStops = (cols, a0, a1) => cols.map((c, k) => {
    const n = parseInt(c.slice(1), 16), f = k / (cols.length - 1);
    return [f, (n >> 16) & 255, (n >> 8) & 255, n & 255, a0 + (a1 - a0) * f];
  });

  let anSeq = 0, anTimer = 0;
  async function enterAnalysis() {
    for (const b of $$('#aTabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === S.tab));
    applyVisibility();
    $('#aLegend').innerHTML = '';
    try { await ensureIndex(); } catch {
      $('#aMore').innerHTML = '<div class="basis warn">Noch keine Verlaufsdaten vorhanden. Sie entstehen automatisch mit den nächsten Abfragen.</div>';
      return;
    }
    if (S.mode !== 'analyse') return;
    syncFilterUI();
    renderAnalysisBody();
    compute();
  }

  function renderAnalysisBody() {
    $('#aMore').innerHTML = `${filterBlock()}<div class="block" id="aOut"><span class="busy">rechnet …</span></div>`;
    bindFilterInputs();
    requestAnimationFrame(() => setSheet(sheetState));
  }

  function scheduleCompute(delay = 120) {
    clearTimeout(anTimer);
    anTimer = setTimeout(compute, delay);
    const l = $('#aLegend .top .busy');
    if (!l && $('#aLegend .top')) $('#aLegend .top').insertAdjacentHTML('beforeend', '<span class="busy">rechnet …</span>');
  }

  async function compute() {
    if (S.mode !== 'analyse') return;
    const seq = ++anSeq;
    const { dates } = filterDates();
    const f = F();
    const out = () => $('#aOut');
    try {
      if (S.tab === 'standzeit') { renderIdle(); return; }
      if (!dates.length) { out().innerHTML = '<p class="hint">Im gewählten Zeitraum gibt es keine Daten.</p>'; return; }
      if (!f.wd.some(Boolean)) { out().innerHTML = '<p class="hint">Bitte mindestens einen Wochentag wählen.</p>'; return; }
      let r;
      switch (S.tab) {
        case 'verfuegbarkeit':
          r = await rpc('avail', { F: f, dates, R: S.f.R, res: S.f.res, stops: toStops(RAMP.avail, 0.25, 0.85) });
          if (seq !== anSeq) return;
          showRaster(r); S.raster = r; renderAvailOut(r); break;
        case 'dichte':
          r = await rpc('density', { F: f, dates, res: S.f.res, smooth: S.f.smooth, stops: toStops(RAMP.dens, 0.2, 0.9) });
          if (seq !== anSeq) return;
          showRaster(r); S.raster = r; renderDensOut(r); break;
        case 'nutzung':
          r = await rpc('usage', { F: f, dates, P: tripParams() });
          if (seq !== anSeq) return;
          renderUsageOut(r); break;
        case 'stroeme':
          r = await rpc('flows', { F: f, dates, P: tripParams(), cell: S.f.cell, top: S.f.top, min: S.f.min });
          if (seq !== anSeq) return;
          renderFlowsOut(r); break;
        case 'stationen':
          r = await rpc('stations', { F: f, dates, k: S.f.k });
          if (seq !== anSeq) return;
          renderStationsOut(r); break;
        default:
      }
      if (S.sel?.type === 'point') pointQuery(S.sel.lng, S.sel.lat, true);
      if (S.sel?.type === 'station') stationQuery(S.sel.uid, true);
    } catch (err) {
      console.error(err);
      if (seq === anSeq) out().innerHTML = `<div class="basis warn">Die Auswertung ist fehlgeschlagen: ${esc(err.message.split('\n')[0])}</div>`;
    }
  }

  function showRaster(r) {
    const cv = document.createElement('canvas');
    cv.width = r.w; cv.height = r.h;
    cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.rgba.buffer || r.rgba), r.w, r.h), 0, 0);
    const b = r.bbox;
    map.getSource('raster').updateImage({ url: cv.toDataURL(), coordinates: [[b.w, b.n], [b.e, b.n], [b.e, b.s], [b.w, b.s]] });
  }

  function basisLine(polls, days, extra = '') {
    const warn = polls < 12;
    return `<div class="basis${warn ? ' warn' : ''}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.5"/></svg>
      <div>Grundlage: ${nf.format(polls)} Abfragen an ${nf.format(days)} ${days === 1 ? 'Tag' : 'Tagen'}.${warn ? ' Das ist sehr wenig; die Werte sind noch zufällig.' : ''} ${extra}</div></div>`;
  }
  const legendTop = (txt) => `<div class="top"><div class="cap">${txt}</div></div>`;

  function renderAvailOut(r) {
    $('#aLegend').innerHTML = `${legendTop(`Chance auf mindestens ein Rad im Umkreis von ${S.f.R} m, ${wdLabel()} ${winLabel()}`)}
      <div class="bar" style="background:${gradient(RAMP.avail)}"></div><div class="scale"><span>1 %</span><span>50 %</span><span>100 %</span></div>`;
    $('#aOut').innerHTML = `${basisLine(r.polls, r.days, r.auto ? `Auflösung automatisch auf ${r.res} m vergröbert, damit es schnell bleibt.` : '')}
      <p class="hint">Tippe irgendwo auf die Karte: Dann wird genau für diesen Punkt gerechnet, mit Tagesverlauf und typischem Abstand zum nächsten Rad.</p>
      ${S.me ? '<button class="btn sm ghost" data-act="pointme" type="button">Meinen Standort auswerten</button>' : ''}`;
  }

  function renderDensOut(r) {
    $('#aLegend').innerHTML = `${legendTop(`Durchschnittlich abgestellte Räder pro Hektar, ${wdLabel()} ${winLabel()}`)}
      <div class="bar" style="background:${gradient(RAMP.dens)}"></div><div class="scale"><span>wenige</span><span>${nf1.format(r.vmax)} pro ha</span></div>`;
    $('#aOut').innerHTML = `${basisLine(r.polls, r.days)}
      <p class="hint">Aus den echten Radpositionen gemittelt und mit ${S.f.smooth ? `${S.f.smooth} m` : 'keiner'} Glättung weichgezeichnet. Ein Hektar sind 100 × 100 m. Tippe auf die Karte für den Tagesverlauf an diesem Punkt.</p>`;
  }

  function renderUsageOut(r) {
    const { t0, t1 } = winMin();
    $('#aLegend').innerHTML = `<div class="tiles">
      <div class="stat"><b>${r.perDay != null ? nf.format(Math.round(r.perDay)) : '–'}</b><span>Fahrten pro Tag</span></div>
      <div class="stat"><b>${r.medDur != null ? `${nf.format(Math.round(r.medDur))} min` : '–'}</b><span>Dauer, Median</span></div>
      <div class="stat"><b>${r.medDist != null ? fmtDist(r.medDist) : '–'}</b><span>Luftlinie, Median</span></div></div>
      <p class="hint" style="margin-top:6px">Fahrten mit Start ${winLabel()}, ${wdLabel()}</p>`;
    const dur = r.durH, dist = r.distH;
    $('#aOut').innerHTML = `${basisLine(r.series.t.length, r.days)}
      <div class="block">${lineChart({ title: 'Räder unterwegs nach Uhrzeit', sub: `Durchschnitt, ${wdLabel()}`, series: [{ name: wdLabel(), color: C.wd, values: r.inuseH }], band: [t0, t1] })}</div>
      <div class="block">${lineChart({ title: 'Fahrtbeginne pro Stunde', sub: `Durchschnitt, ${wdLabel()}`, series: [{ name: wdLabel(), color: C.wd, values: r.perHour }], band: [t0, t1] })}</div>
      <div class="block">${timeChart({ title: 'Räder unterwegs im Zeitraum', t: r.series.t, values: r.series.inuse, color: C.we })}</div>
      <div class="block">${barChart({ title: 'Fahrtdauer', sub: `${nf.format(r.count - r.short)} Fahrten mit messbarer Dauer`, values: dur,
        labels: dur.map((_, k) => (k === dur.length - 1 ? '>2 h' : `${k * 5}–${k * 5 + 5} min`)), tickEvery: 6, tickLabel: (k) => (k === dur.length - 1 ? '' : `${k * 5}`), unitX: 'min' })}</div>
      <div class="block">${barChart({ title: 'Strecke (Luftlinie)', sub: `${nf.format(r.count)} Fahrten`, values: dist,
        labels: dist.map((_, k) => (k === dist.length - 1 ? '>8 km' : `${nf1.format(k * 0.25)}–${nf1.format(k * 0.25 + 0.25)} km`)), tickEvery: 4, tickLabel: (k) => (k === dist.length - 1 ? '' : nf1.format(k * 0.25)), unitX: 'km' })}</div>
      <p class="hint">Nicht als Fahrt gezählt: ${nf.format(r.service)} Abwesenheiten über ${nf1.format(S.f.maxDurH)} h und ${nf.format(r.round)} Rückkehren an denselben Ort. Kurze Fahrten zwischen zwei Abfragen haben keine messbare Dauer. Umverteilung per Transporter lässt sich nicht sicher abtrennen.</p>`;
  }

  function nearestLiveStation(lng, lat) {
    let best = null, bd = Infinity;
    for (const s of S.live?.stations || []) { const d = hav(lat, lng, s.lat, s.lng); if (d < bd) { bd = d; best = s; } }
    return best ? best.name : `${nf1.format(lat)}, ${nf1.format(lng)}`;
  }

  function renderFlowsOut(r) {
    const max = Math.max(1, ...r.lines.map((l) => l[4]));
    setData('flows', { type: 'FeatureCollection', features: r.lines.map(([x0, y0, x1, y1, c]) => ({
      type: 'Feature', geometry: { type: 'LineString', coordinates: arc([x0, y0], [x1, y1]) }, properties: { w: 0.15 + 0.85 * (c / max), c } })) });
    const vmax = Math.max(1, ...r.cells.map((c) => c[2] + c[3]));
    setData('netc', { type: 'FeatureCollection', features: r.cells.filter((c) => c[2] + c[3] >= 2).map(([x, y, s, e]) => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [x, y] }, properties: { v: (e - s) / (e + s), n: e + s, s, e, rel: Math.sqrt((e + s) / vmax) } })) });
    $('#aLegend').innerHTML = `${legendTop(`Bilanz je ${fmtDist(r.cell)}-Feld: mehr Fahrten beginnen (rot) oder enden (blau)`)}
      <div class="bar" style="background:${gradient([R.div.neg[0], R.div.neg[1], R.div.neg[2], R.div.mid, R.div.pos[0], R.div.pos[1], R.div.pos[2]])}"></div>
      <div class="scale"><span>Abfluss</span><span>ausgeglichen</span><span>Zufluss</span></div>`;
    const top = r.lines.slice(0, 12);
    $('#aOut').innerHTML = `${basisLine(r.trips, filterDates().dates.length, `${nf.format(r.trips)} geschätzte Fahrten im Filter.`)}
      <p class="hint">Kreise: Größe = Zahl der Fahrten, Farbe = Bilanz. Linien: häufigste Verbindungen, kräftiger zum Ziel hin.</p>
      <h2 style="margin-top:12px">Häufigste Verbindungen</h2>
      ${top.length ? `<ul class="rows">${top.map(([x0, y0, x1, y1, c]) => `<li><span class="main"><b>${esc(nearestLiveStation(x0, y0))}</b><small>nach ${esc(nearestLiveStation(x1, y1))}, ${fmtDist(hav(y0, x0, y1, x1))}</small></span><span class="val">${nf.format(c)}<small>Fahrten</small></span></li>`).join('')}</ul>`
        : '<p class="hint">Keine Verbindung erreicht die Mindestzahl.</p>'}`;
  }

  function arc(a, b) {
    const [x0, y0] = a, [x1, y1] = b;
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    const dx = x1 - x0, dy = (y1 - y0) * 1.58;
    const cx = mx - dy * 0.18, cy = my + (dx * 0.18) / 1.58;
    const pts = [];
    for (let k = 0; k <= 20; k++) { const t = k / 20, u = 1 - t; pts.push([u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * y0 + 2 * u * t * cy + t * t * y1]); }
    return pts;
  }

  function showNetCell(p, lngLat) {
    showDetail('#detailA', `
      <p class="kicker">Feld bei ${esc(nearestLiveStation(lngLat[0], lngLat[1]))}</p>
      <h3>${nf.format(p.s)} Starts, ${nf.format(p.e)} Ankünfte</h3>
      <p class="hint" style="margin-top:-4px">${wdLabel()}, ${winLabel()}, ${rangeLabel()}. ${p.e > p.s ? 'Hier sammeln sich Räder an.' : p.e < p.s ? 'Von hier fahren mehr Räder weg als ankommen.' : 'Ausgeglichen.'}</p>`);
    select({ type: 'Point', coordinates: lngLat });
  }

  function renderStationsOut(r) {
    S.stList = r.list;
    setData('anst', { type: 'FeatureCollection', features: r.list.filter((s) => s.p != null).map((s) => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [s.lng, s.lat] }, properties: { uid: s.uid, p: s.p, a: s.avg } })) });
    $('#aLegend').innerHTML = `${legendTop(`Chance, dass die Station ${S.f.k ? `höchstens ${S.f.k} ${S.f.k === 1 ? 'Rad' : 'Räder'} hat` : 'leer ist'} (Größe: Ø Räder)`)}
      <div class="bar" style="background:${gradient(R.red)}"></div><div class="scale"><span>0 %</span><span>50 %</span><span>100 %</span></div>`;
    const rows = r.list.filter((s) => s.p != null);
    const empty = rows.slice().sort((x, y) => y.p - x.p || x.avg - y.avg).slice(0, 8);
    const full = rows.slice().sort((x, y) => y.avg - x.avg).slice(0, 5);
    const li = (s, v, sub) => `<li><button class="rowbtn" data-act="stq" data-id="${esc(s.uid)}"><span class="main"><b>${esc(s.name)}</b><small>${sub}</small></span><span class="val">${v}</span></button></li>`;
    $('#aOut').innerHTML = `${basisLine(r.polls, filterDates().dates.length)}
      <h2 style="margin-top:12px">Am häufigsten ${S.f.k ? 'fast leer' : 'leer'}</h2><ul class="rows">${empty.map((s) => li(s, `${Math.round(s.p)} %<small>${S.f.k ? 'fast leer' : 'leer'}</small>`, `Ø ${nf1.format(s.avg)} Räder`)).join('')}</ul>
      <h2 style="margin-top:16px">Meist gut gefüllt</h2><ul class="rows">${full.map((s) => li(s, `${nf1.format(s.avg)}<small>Räder Ø</small>`, `${Math.round(s.p)} % ${S.f.k ? 'fast leer' : 'leer'}`)).join('')}</ul>`;
  }

  // exact query for one map location
  async function pointQuery(lng, lat, quiet) {
    S.sel = { type: 'point', lng, lat };
    const R = S.f.R;
    setData('qpt', { type: 'FeatureCollection', features: [circle([lng, lat], R), { type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: {} }] });
    if (!quiet) showDetail('#detailA', '<p class="kicker">Ausgewählter Ort</p><h3>…</h3><span class="busy">rechnet …</span>', { keepSel: true });
    const { dates } = filterDates();
    const r = await rpc('point', { F: F(), dates, lat, lng, R });
    if (S.sel?.type !== 'point' || S.sel.lng !== lng) return;
    const dens = S.tab === 'dichte';
    const w = r.win;
    const where = nearestLiveStation(lng, lat);
    const head = !w ? 'keine Daten' : dens ? `${nf1.format(w.avg)} Räder` : `${Math.round(w.pct)} %`;
    const sub = !w ? '' : dens ? `im Schnitt im Umkreis von ${R} m, ${wdLabel()} ${winLabel()}` : `Chance auf mindestens ein Rad im Umkreis von ${R} m, ${wdLabel()} ${winLabel()}`;
    const vals = (o) => (dens ? o.avg : o.pct);
    showDetail('#detailA', `
      <p class="kicker">Nahe ${esc(where)}</p>
      <h3>${head}</h3>
      <p class="hint" style="margin-top:-4px">${sub}${w ? `. Grundlage: ${nf.format(w.n)} Abfragen.` : ''}</p>
      ${w && !dens ? `<dl class="kv" style="margin-top:6px"><dt>Ø Räder im Umkreis</dt><dd>${nf1.format(w.avg)}</dd>
        ${r.nearestMedian != null ? `<dt>Nächstes Rad typisch</dt><dd>${fmtDist(r.nearestMedian)} entfernt (Median)</dd>` : ''}</dl>` : ''}
      ${lineChart({ title: dens ? 'Räder im Umkreis über den Tag' : 'Chance über den Tag', sub: '15-Minuten-Schritte', unit: dens ? '' : '%', yMax: dens ? null : 100,
        series: [{ name: wdLabel(), color: C.wd, values: vals(r.sel) }, ...(wdLabel() !== 'alle Tage' ? [{ name: 'alle Tage', color: C.muted, values: vals(r.all) }] : [])],
        band: [winMin().t0, winMin().t1] })}
      <div class="actions"><button class="btn sm ghost" data-act="clearpoint">Auswahl aufheben</button></div>`, { keepSel: true, quiet });
  }

  function circle([lng, lat], r) {
    const pts = [];
    for (let k = 0; k <= 64; k++) {
      const a = (k / 64) * 2 * Math.PI;
      pts.push([lng + (r * Math.cos(a)) / (111320 * Math.cos(lat * Math.PI / 180)), lat + (r * Math.sin(a)) / 111320]);
    }
    return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [pts] }, properties: {} };
  }

  async function stationQuery(uid, quiet, target = '#detailA') {
    if (target === '#detailA') S.sel = { type: 'station', uid };
    await ensureIndex();
    const { dates } = filterDates();
    const k = S.f.k;
    const r = await rpc('stationProfile', { F: F(), dates, uid: String(uid), k });
    const el = target === '#detailA' ? null : $(target);
    if (!r) { if (el) el.innerHTML = '<p class="hint">Noch keine Auswertung für diese Station.</p>'; return; }
    const charts = `${lineChart({ title: 'Räder im Tagesverlauf', sub: 'Durchschnitt', series: [{ name: wdLabel(), color: C.wd, values: r.sel.avg }, ...(wdLabel() !== 'alle Tage' ? [{ name: 'alle Tage', color: C.muted, values: r.all.avg }] : [])], band: [winMin().t0, winMin().t1] })}
      ${lineChart({ title: k ? `Chance auf höchstens ${k} ${k === 1 ? 'Rad' : 'Räder'}` : 'Chance, dass sie leer ist', unit: '%', yMax: 100, series: [{ name: wdLabel(), color: C.wd, values: r.sel.p }, ...(wdLabel() !== 'alle Tage' ? [{ name: 'alle Tage', color: C.muted, values: r.all.p }] : [])], band: [winMin().t0, winMin().t1] })}
      <p class="hint">${wdLabel()}, ${rangeLabel()}.</p>`;
    if (el) { el.innerHTML = charts; bindCharts(el); return; }
    if (S.sel?.type !== 'station' || S.sel.uid !== uid) return;
    const s = S.stList?.find((x) => x.uid === uid);
    showDetail('#detailA', `
      <p class="kicker"><span class="dot" style="background:${C.station}"></span>Station</p>
      <h3>${esc(r.name)}</h3>
      ${s && s.p != null ? `<p class="hint" style="margin-top:-4px">${wdLabel()} ${winLabel()}: in ${Math.round(s.p)} % der Abfragen ${k ? `höchstens ${k} ${k === 1 ? 'Rad' : 'Räder'}` : 'leer'}, im Schnitt ${nf1.format(s.avg)} Räder.</p>` : ''}
      ${charts}`, { keepSel: true, quiet });
    select({ type: 'Point', coordinates: [r.lng, r.lat] });
    if (!quiet) flyTo([r.lng, r.lat], 14);
  }

  // ---- idle (from the live snapshot)
  function renderIdle() {
    if (!S.live || S.mode !== 'analyse' || S.tab !== 'standzeit') return;
    const t = now(), bins = [0, 0, 0, 0];
    const cls = (b) => { const d = (t - b.since) / 86400; return d < 1 ? 0 : d < 3 ? 1 : d < 7 ? 2 : 3; };
    const ok = (b) => b.since && (t - b.since) / 86400 >= S.f.idleMin && kindOk(b);
    const kindOk = (b) => S.f.kind === 'all' || (S.f.kind === 'free' ? b.kind !== 'station' : b.kind === 'station');
    const feats = [];
    for (const b of S.live.bikes) {
      if (!ok(b)) continue;
      const c = cls(b); bins[c]++;
      feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [b.lng, b.lat] }, properties: { c, id: b.bike } });
    }
    setData('idle', { type: 'FeatureCollection', features: feats });
    const labels = ['unter 1 Tag', '1–3 Tage', '3–7 Tage', 'über 7 Tage'];
    $('#aLegend').innerHTML = `<div class="cap">Wie lange ein Rad unberührt am selben Ort steht</div>
      <div class="cats">${labels.map((l, k) => `<span><i style="background:${R.idle[k]}"></i>${l} (${nf.format(bins[k])})</span>`).join('')}</div>`;
    const longest = S.live.bikes.filter(ok).sort((a, b) => a.since - b.since).slice(0, 20);
    const out = $('#aOut');
    if (!out) return;
    out.innerHTML = `<h2>Am längsten unbewegt</h2><ul class="rows">${longest.map((b) => {
      const st = b.kind === 'station' ? S.live.stById.get(String(b.place_uid)) : null;
      return `<li><button class="rowbtn" data-act="bike" data-id="${esc(b.bike)}"><span class="dot" style="background:${R.idle[cls(b)]}"></span>
        <span class="main"><b>Rad ${esc(b.bike)}</b><small>${st ? esc(st.name) : 'frei abgestellt'}</small></span>
        <span class="val">${b.since_censored ? 'mind. ' : ''}${fmtDur(t - b.since).replace(' Tagen', ' Tg.')}</span></button></li>`;
    }).join('')}</ul>
      <p class="hint">Ein Rad gilt als bewegt, wenn es aus dem Feed verschwindet oder sich mehr als 100 m verschiebt. Standzeiten, die vor Beginn der Aufzeichnung anfingen, sind als „mind.“ markiert.</p>`;
  }

  // ---------------------------------------------------------------- filter inputs
  let wTimer = 0;
  function stopWindowPlay() { S.wPlaying = false; clearInterval(wTimer); $('#wPlay').classList.remove('on'); }
  function startWindowPlay() {
    S.wPlaying = true; $('#wPlay').classList.add('on');
    clearInterval(wTimer);
    wTimer = setInterval(() => {
      const width = ((S.f.b - S.f.a) % 96 + 96) % 96 || 4;
      S.f.a = (S.f.a + 4) % 96; S.f.b = (S.f.a + width) % 96 || 96;
      syncFilterUI(); saveFilter(); scheduleCompute(0);
    }, 1400);
  }

  function bindFilterInputs() {
    const root = $('#filters');
    if (!root) return;
    root.querySelectorAll('input[data-param]').forEach((inp) => {
      const k = inp.dataset.param;
      inp.addEventListener('input', () => {
        S.f[k] = +inp.value;
        $(`#${inp.id}-o`).textContent = FMT[k](inp.value);
        syncFilterUI(); saveFilter();
        if (k === 'R' && S.sel?.type === 'point') setData('qpt', { type: 'FeatureCollection', features: [circle([S.sel.lng, S.sel.lat], S.f.R)] });
        scheduleCompute(k === 'R' || k === 'res' ? 250 : 150);
      });
    });
    root.querySelectorAll('[data-seg]').forEach((seg) => seg.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      const k = seg.dataset.seg;
      S.f[k] = k === 'range' && b.dataset.v !== 'all' ? +b.dataset.v : b.dataset.v;
      seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
      if (k === 'range') { const { from, to } = filterDates(); $('#fFrom').value = from; $('#fTo').value = to; }
      syncFilterUI(); saveFilter(); scheduleCompute(0);
    }));
    for (const id of ['#fFrom', '#fTo']) $(id)?.addEventListener('change', () => {
      S.f.range = 'custom'; S.f.from = $('#fFrom').value; S.f.to = $('#fTo').value;
      root.querySelectorAll('[data-seg="range"] button').forEach((x) => x.setAttribute('aria-checked', 'false'));
      syncFilterUI(); saveFilter(); scheduleCompute(0);
    });
    root.querySelectorAll('[data-wd]').forEach((b) => b.addEventListener('click', () => {
      const i = +b.dataset.wd; S.f.wd[i] = S.f.wd[i] ? 0 : 1;
      b.setAttribute('aria-pressed', String(!!S.f.wd[i]));
      syncFilterUI(); saveFilter(); scheduleCompute(200);
    }));
    root.querySelectorAll('[data-wdp]').forEach((b) => b.addEventListener('click', () => {
      S.f.wd = b.dataset.wdp.split('').map(Number);
      root.querySelectorAll('[data-wd]').forEach((x) => x.setAttribute('aria-pressed', String(!!S.f.wd[+x.dataset.wd])));
      syncFilterUI(); saveFilter(); scheduleCompute(0);
    }));
    root.querySelectorAll('[data-win]').forEach((b) => b.addEventListener('click', () => {
      const [a, c] = b.dataset.win.split(',').map(Number); S.f.a = a; S.f.b = c;
      syncFilterUI(); saveFilter(); scheduleCompute(0);
    }));
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
    if (styleReady) { select(null); setData('qpt', EMPTY); applyVisibility(); }
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

  // values over one day (24 hours or 96 quarter hours); band = [t0, t1] minutes
  function lineChart({ title, sub, series, unit = '', yMax, band }) {
    const H = 150, L = 30, multi = series.length > 1, Rr = multi ? 62 : 10, T = 10, B = 22, w = CW - L - Rr, h = H - T - B;
    const n = series[0].values.length, perH = n / 24;
    const all = series.flatMap((s) => s.values).filter((v) => v != null);
    if (!all.length) return `<div class="chart"><div class="chart-title"><h2>${title}</h2></div><p class="hint">Noch keine Daten.</p></div>`;
    const ymax = yMax ?? niceMax(Math.max(...all) * 1.08);
    const X = (i) => L + ((i + 0.5) / n) * w, Y = (v) => T + h - (v / ymax) * h;
    const XM = (min) => L + (min / 1440) * w;
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
      labels = ends.map((e) => `<circle cx="${L + w + 6}" cy="${e.y}" r="3.5" fill="${e.s.color}"/><text class="dl" x="${L + w + 13}" y="${e.y + 4}">${esc(e.s.name)}</text>`).join('');
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
        if (d.kind === 'day') {
          const i = Math.floor(((x - d.L) / d.w) * d.n);
          if (i < 0 || i >= d.n) return;
          cx = d.X(i);
          html = `${d.fmt(i)}: ${d.series.map((s) => `${d.series.length > 1 ? `${s.name} ` : ''}${s.values[i] == null ? '–' : nf1.format(s.values[i]) + d.unit}`).join(', ')}`;
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
      S.tab = b.dataset.tab; closeDetail(true); setData('qpt', EMPTY); updateHash(); enterAnalysis();
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
      S.frame = -1;
      if (S.mode === 'verlauf') enterTimeline();
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
    const onWin = (e) => { S.f[e.target.id === 'wA' ? 'a' : 'b'] = +e.target.value; stopWindowPlay(); syncFilterUI(); saveFilter(); scheduleCompute(180); };
    $('#wA').addEventListener('input', onWin);
    $('#wB').addEventListener('input', onWin);
    $('#wPlay').addEventListener('click', () => (S.wPlaying ? stopWindowPlay() : startWindowPlay()));
    $('#fSummary').addEventListener('click', () => {
      if (!isDesktop() && sheetState !== 'full') setSheet('full');
      const el = $('#filters');
      if (el) requestAnimationFrame(() => $('#scroll').scrollTo({ top: el.offsetTop - $('.mode[data-mode="analyse"] .peek').offsetHeight - 8, behavior: REDUCED ? 'auto' : 'smooth' }));
    });
    $('#tlEnd').addEventListener('change', (e) => { S.tlEnd = e.target.value || null; S.frame = -1; if (S.mode === 'verlauf') enterTimeline(); });

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
      else if (a === 'stq') stationQuery(id);
      else if (a === 'pointme' && S.me) {
        if (S.mode !== 'analyse' || S.tab !== 'verfuegbarkeit') { S.tab = 'verfuegbarkeit'; setMode('analyse'); }
        setTimeout(() => { pointQuery(S.me[0], S.me[1]); applyVisibility(); flyTo(S.me, 14.5); }, 50);
      }
      else if (a === 'clearpoint') { S.sel = null; setData('qpt', EMPTY); applyVisibility(); closeDetail(); }
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
    const bb = S.live?.meta?.bounds;
    const view = bb ? [[bb[1], bb[0]], [bb[3], bb[2]]] : KOELN;
    requestAnimationFrame(() => map.fitBounds(view, { duration: 0, padding: isDesktop()
      ? { left: 440, top: 30, right: 30, bottom: 30 } : { top: 20, left: 12, right: 12, bottom: sheetVisibleHeight() + 8 } }));
  }

  let liveReady;
  async function start() {
    readHash();
    S.f = loadFilter();
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
  window.__ui = { setMode, setSheet, showStation, showBike, pointQuery, stationQuery, flyTo };
  start();
})();
