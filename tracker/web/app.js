/* KVB-Rad Tracker.
   Two views: "Karte" (live and history on one timeline, live at the right end)
   and "Analyse" (free filters, computed in a web worker from the raw polls).
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
    station: css('--station'), free: css('--free'), ink: css('--ink'), surface: css('--surface'),
    wd: css('--wd'), we: css('--we'), muted: css('--muted'), trip: css('--trip'),
  };
  const R = DARK ? {
    seq: ['#123056', '#1c5cab', '#3987e5', '#6da7ec'],
    heat: ['rgba(194,65,12,0)', '#7c2d12', '#c2410c', '#ea580c', '#fb923c'],
    red: ['#4a2326', '#8f2f2f', '#c53b3b', '#e66767'],
    blue: ['#1b3557', '#1c5cab', '#3987e5', '#86b6ef'],
    div: { neg: ['#e66767', '#a83a3a', '#5a2e2e'], mid: '#3a3f4a', pos: ['#2a4f80', '#3987e5', '#86b6ef'] },
    idle: ['#2f2580', '#4f3fbf', '#7a6cf0', '#a99ff5', '#d5cffb'],
  } : {
    seq: ['#cde2fb', '#86b6ef', '#3987e5', '#1c5cab'],
    heat: ['rgba(235,104,52,0)', '#fbd0b9', '#f59a6b', '#eb6834', '#b4380f'],
    red: ['#fde2e1', '#f6a3a2', '#e34948', '#9e2525'],
    blue: ['#cde2fb', '#86b6ef', '#2a78d6', '#184f95'],
    div: { neg: ['#e34948', '#ee8a89', '#f6c3c2'], mid: '#e6e3de', pos: ['#b7d3f6', '#6da7ec', '#2a78d6'] },
    idle: ['#d5cffb', '#a99ff5', '#7a6cf0', '#5240d0', '#2f2580'],
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
  const S = {
    mode: 'karte', tab: 'erreichbarkeit', cfg: null, f: null,
    live: null, tl: null, trips: null, me: null, sel: null, trail: null,
    k: { span: 24, end: null, isLive: true, frame: -1, clock: 0, playing: false, speed: 1, liveInuse: null },
    layers: { stations: true, free: true, trips: true, heat: false },
    wPlaying: false, stList: null,
  };

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
  function heatPaint(weight) {
    return {
      'heatmap-weight': weight,
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 13, 1.1, 16, 2.2],
      'heatmap-radius': ['interpolate', ['exponential', 1.7], ['zoom'], 10, 9, 13, 20, 16, 52, 18, 120],
      'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, R.heat[0], 0.15, R.heat[1], 0.4, R.heat[2], 0.7, R.heat[3], 1, R.heat[4]],
      'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0.85, 18, 0.55],
    };
  }

  function setupLayers() {
    const before = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
    for (const id of ['bikes', 'stations', 'netc', 'idle', 'sel', 'me', 'trail', 'anst', 'qpt', 'tripdots', 'particles'])
      map.addSource(id, { type: 'geojson', data: EMPTY });
    map.addSource('flows', { type: 'geojson', data: EMPTY, lineMetrics: true });
    map.addSource('trips', { type: 'geojson', data: EMPTY, lineMetrics: true });
    map.addSource('raster', { type: 'image', url: PIXEL, coordinates: [[6.76, 51.09], [7.18, 51.09], [7.18, 50.83], [6.76, 50.83]] });

    // under the basemap labels
    map.addLayer({ id: 'raster-l', type: 'raster', source: 'raster', layout: { visibility: 'none' },
      paint: { 'raster-resampling': 'linear', 'raster-opacity': 0.9, 'raster-fade-duration': 0 } }, before);
    map.addLayer({ id: 'live-heat', type: 'heatmap', source: 'bikes', layout: { visibility: 'none' }, paint: heatPaint(1) }, before);
    map.addLayer({ id: 'qpt-fill', type: 'fill', source: 'qpt', filter: ['==', ['geometry-type'], 'Polygon'], layout: { visibility: 'none' },
      paint: { 'fill-color': hexA(C.ink, 0.06) } }, before);

    // on top
    map.addLayer({ id: 'netc', type: 'circle', source: 'netc', layout: { visibility: 'none' },
      paint: { 'circle-radius': ['interpolate', ['exponential', 1.6], ['zoom'], 10, ['*', ['get', 'rel'], 9], 14, ['*', ['get', 'rel'], 26], 17, ['*', ['get', 'rel'], 60]],
        'circle-color': ['interpolate', ['linear'], ['get', 'v'], -1, R.div.neg[0], -0.5, R.div.neg[1], -0.15, R.div.neg[2], 0, R.div.mid, 0.15, R.div.pos[0], 0.5, R.div.pos[1], 1, R.div.pos[2]],
        'circle-opacity': 0.7, 'circle-stroke-color': C.surface, 'circle-stroke-width': 0.8 } });
    map.addLayer({ id: 'flows-line', type: 'line', source: 'flows', layout: { visibility: 'none', 'line-cap': 'round' },
      paint: { 'line-width': ['interpolate', ['linear'], ['zoom'], 10, ['+', 0.6, ['*', ['get', 'w'], 3]], 15, ['+', 1, ['*', ['get', 'w'], 8]]],
        'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, hexA(C.trip, 0.06), 1, hexA(C.trip, 0.75)] } });
    map.addLayer({ id: 'particles', type: 'circle', source: 'particles', layout: { visibility: 'none' },
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 1.8, 15, 3.6], 'circle-color': C.trip,
        'circle-stroke-color': C.surface, 'circle-stroke-width': 0.8, 'circle-opacity': ['get', 'o'], 'circle-stroke-opacity': ['get', 'o'] } });
    map.addLayer({ id: 'trail-line', type: 'line', source: 'trail', filter: ['==', ['geometry-type'], 'LineString'],
      layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': C.ink, 'line-width': 2.2, 'line-dasharray': [1.5, 1.5], 'line-opacity': 0.75 } });
    map.addLayer({ id: 'trail-pts', type: 'circle', source: 'trail', filter: ['==', ['geometry-type'], 'Point'],
      layout: { visibility: 'none' }, paint: { 'circle-radius': zoomRadius(4, 7, 10), 'circle-color': C.surface, 'circle-stroke-color': C.ink, 'circle-stroke-width': 2 } });
    map.addLayer({ id: 'idle-dots', type: 'circle', source: 'idle', layout: { visibility: 'none' },
      paint: { 'circle-radius': zoomRadius(2.4, 5, 10),
        'circle-color': ['interpolate', ['linear'], ['get', 'l'], 0, R.idle[0], 0.25, R.idle[1], 0.5, R.idle[2], 0.75, R.idle[3], 1, R.idle[4]],
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
    map.addLayer({ id: 'trips-line', type: 'line', source: 'trips', layout: { visibility: 'none', 'line-cap': 'round' },
      paint: { 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.4, 15, 3],
        'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, hexA(C.trip, 0), 1, hexA(C.trip, 0.85)], 'line-opacity': ['get', 'o'] } });
    map.addLayer({ id: 'trips-dot', type: 'circle', source: 'tripdots', layout: { visibility: 'none' },
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 3, 15, 6], 'circle-color': C.trip, 'circle-stroke-color': C.surface, 'circle-stroke-width': 1.5 } });
    map.addLayer({ id: 'an-st', type: 'circle', source: 'anst', layout: { visibility: 'none' },
      paint: { 'circle-radius': ['interpolate', ['exponential', 1.6], ['zoom'], 10, ['+', 2.5, ['*', 0.9, ['sqrt', ['get', 'a']]]],
          14, ['+', 6, ['*', 2.6, ['sqrt', ['get', 'a']]]], 18, ['+', 12, ['*', 4.2, ['sqrt', ['get', 'a']]]]],
        'circle-color': R.blue[2], 'circle-stroke-color': C.surface, 'circle-stroke-width': 1.2 } });
    map.addLayer({ id: 'qpt-line', type: 'line', source: 'qpt', filter: ['==', ['geometry-type'], 'Polygon'], layout: { visibility: 'none' },
      paint: { 'line-color': C.ink, 'line-width': 1.6, 'line-dasharray': [2, 2] } });
    map.addLayer({ id: 'qpt-dot', type: 'circle', source: 'qpt', filter: ['==', ['geometry-type'], 'Point'], layout: { visibility: 'none' },
      paint: { 'circle-radius': 6, 'circle-color': C.ink, 'circle-stroke-color': C.surface, 'circle-stroke-width': 2.5 } });
    map.addLayer({ id: 'sel-ring', type: 'circle', source: 'sel',
      paint: { 'circle-radius': zoomRadius(9, 15, 24), 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': C.ink, 'circle-stroke-width': 2.5 } });
    map.addLayer({ id: 'me-acc', type: 'circle', source: 'me', paint: { 'circle-radius': zoomRadius(10, 18, 30), 'circle-color': hexA(C.station, 0.15) } });
    map.addLayer({ id: 'me-dot', type: 'circle', source: 'me', paint: { 'circle-radius': 6.5, 'circle-color': C.station, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2.5 } });

    map.on('click', onMapClick);
    if (matchMedia('(hover: hover)').matches) {
      let raf = 0;
      map.on('mousemove', (e) => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          map.getCanvas().style.cursor = anyPointTab() ? 'crosshair' : pick(e.point) ? 'pointer' : '';
        });
      });
    }
  }

  const setData = (id, data) => map?.getSource(id)?.setData(data);
  const vis = (id, on) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  const isVis = (id) => map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none';
  const anyPointTab = () => S.mode === 'analyse' && (S.tab === 'erreichbarkeit' || S.tab === 'dichte');

  function applyVisibility() {
    if (!styleReady) return;
    const k = S.mode === 'karte', a = !k, t = S.tab, L = S.layers;
    vis('stations-c', k && L.stations); vis('stations-t', k && L.stations);
    vis('free-dots', k && L.free); vis('live-heat', k && L.heat);
    vis('trips-line', k && L.trips); vis('trips-dot', k && L.trips);
    vis('trail-line', k && !!S.trail); vis('trail-pts', k && !!S.trail);
    vis('raster-l', a && (t === 'erreichbarkeit' || t === 'dichte'));
    const q = anyPointTab() && S.sel?.type === 'point';
    vis('qpt-fill', q); vis('qpt-line', q); vis('qpt-dot', q);
    vis('netc', a && t === 'stroeme'); vis('flows-line', a && t === 'stroeme'); vis('particles', a && t === 'stroeme');
    vis('an-st', a && t === 'stationen');
    vis('idle-dots', a && t === 'standzeit');
  }

  // ================================================================ picking
  const PRIORITY = ['stations-c', 'an-st', 'free-dots', 'idle-dots', 'trips-dot', 'trail-pts', 'netc'];
  function pick(pt) {
    const layers = PRIORITY.filter(isVis);
    if (!layers.length) return null;
    const r = isDesktop() ? 6 : 14;
    const fs = map.queryRenderedFeatures([[pt.x - r, pt.y - r], [pt.x + r, pt.y + r]], { layers });
    if (!fs.length) return null;
    const rank = (f) => PRIORITY.indexOf(f.layer.id);
    const dist = (f) => { const p = map.project(f.geometry.coordinates); return Math.hypot(p.x - pt.x, p.y - pt.y); };
    fs.sort((a, b) => rank(a) - rank(b) || dist(a) - dist(b));
    return fs[0];
  }

  function onMapClick(e) {
    if (anyPointTab()) { pointQuery(e.lngLat.lng, e.lngLat.lat); return; }
    const f = pick(e.point);
    if (!f) { closeDetail(); return; }
    const p = f.properties;
    switch (f.layer.id) {
      case 'stations-c': S.k.isLive ? showStation(p.uid) : showTlStation(p.i); break;
      case 'free-dots': S.k.isLive ? showBike(p.id) : showTlBike(p.i); break;
      case 'idle-dots': showBike(p.id); break;
      case 'trips-dot': showTrip(p); break;
      case 'trail-pts': showTrail(); break;
      case 'netc': showNetCell(p, f.geometry.coordinates); break;
      case 'an-st': stationQuery(p.uid); break;
      default:
    }
  }

  function select(geom) { setData('sel', geom ? { type: 'Feature', geometry: geom, properties: {} } : EMPTY); }
  function flyTo(lnglat, zoom) {
    map.easeTo({ center: lnglat, zoom: Math.max(map.getZoom(), zoom ?? 14.5), duration: REDUCED ? 0 : 600,
      padding: isDesktop() ? { left: 420, top: 0, right: 0, bottom: 0 } : { bottom: sheetVisibleHeight(), top: 0, left: 0, right: 0 } });
  }

  // ================================================================ sheet (phones)
  const panel = $('#panel');
  let sheetState = 'peek';
  function peekHeight() {
    const peek = $(`.mode[data-mode="${S.mode}"] .peek`);
    return $('#grab').offsetHeight + $('#head').offsetHeight + (peek ? peek.offsetHeight : 0) + 4;
  }
  function sheetY(state) {
    const H = panel.offsetHeight;
    if (state === 'full') return 0;
    if (state === 'half') return Math.max(0, H - Math.max(window.innerHeight * 0.62, peekHeight() + 160));
    return Math.max(0, H - peekHeight());
  }
  function setSheet(state) {
    if (isDesktop()) return;
    sheetState = state;
    panel.dataset.sheet = state;
    panel.style.setProperty('--sheet-y', `${sheetY(state)}px`);
    $$('.more-toggle').forEach((b) => b.setAttribute('aria-expanded', String(state !== 'peek')));
  }
  function sheetVisibleHeight() {
    if (isDesktop()) return 0;
    const y = parseFloat(panel.style.getPropertyValue('--sheet-y')) || 0;
    return panel.offsetHeight - y;
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
      panel.style.setProperty('--sheet-y', `${Math.min(Math.max(0, startOff + dy), sheetY('peek'))}px`);
    };
    const up = () => {
      if (!dragging) return;
      dragging = false; panel.classList.remove('dragging');
      if (!moved) { setSheet(sheetState === 'peek' ? 'half' : 'peek'); return; }
      const y = parseFloat(panel.style.getPropertyValue('--sheet-y'));
      const states = ['full', 'half', 'peek'].map((st) => ({ st, y: sheetY(st) }));
      let best = states.reduce((a, b) => (Math.abs(b.y - y) < Math.abs(a.y - y) ? b : a));
      if (Math.abs(vel) > 0.45) {
        const cand = vel > 0 ? states.filter((x) => x.y > y + 1).sort((a, b) => a.y - b.y)[0] : states.filter((x) => x.y < y - 1).sort((a, b) => b.y - a.y)[0];
        if (cand) best = cand;
      }
      setSheet(best.st);
    };
    for (const el of [$('#grab'), $('#head')]) {
      el.addEventListener('pointerdown', down); el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    }
    addEventListener('resize', () => setSheet(sheetState));
    document.fonts?.ready.then(() => setSheet(sheetState));
    setSheet('peek');
  }
  const refreshSheet = () => requestAnimationFrame(() => setSheet(sheetState));

  // ================================================================ modes
  function setMode(mode, opts = {}) {
    if (S.mode === 'karte' && mode !== 'karte') stopPlay();
    if (S.mode === 'analyse' && mode !== 'analyse') { stopWindowPlay(); stopParticles(); }
    S.mode = mode;
    for (const b of $$('.modes button')) b.setAttribute('aria-selected', String(b.dataset.mode === mode));
    for (const s of $$('section.mode')) s.hidden = s.dataset.mode !== mode;
    closeDetail(true);
    updateHash();
    applyVisibility();
    if (mode === 'karte') { renderKarte(true); if (opts.trail) showTrailFor(opts.trail); }
    if (mode === 'analyse') enterAnalysis();
    updateStatus();
    requestAnimationFrame(() => setSheet(opts.sheet || (sheetState === 'full' ? 'half' : sheetState)));
  }
  function updateHash() {
    const h = S.mode === 'analyse' ? `#analyse/${S.tab}` : '#karte';
    if (location.hash !== h) history.replaceState(null, '', h);
  }
  function readHash() {
    const [m, t] = location.hash.replace('#', '').split('/');
    S.mode = m === 'analyse' ? 'analyse' : 'karte';
    const tab = ({ verfuegbarkeit: 'erreichbarkeit' })[t] || t;
    if (tab && $(`#aTabs [data-tab="${tab}"]`)) S.tab = tab;
  }

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
    if (S.mode === 'karte' && S.k.isLive) renderKarte(true);
    if (S.mode === 'analyse' && S.tab === 'standzeit') renderIdle();
    updateStatus(); renderFresh();
  }

  // ================================================================ freshness: poll a tiny status file
  // status.json = { ts: time of the latest poll, app: version of the web app }.
  // New ts -> reload live data and the changed history days, re-render.
  // New app -> the pill offers a reload (and does it when you come back to the tab).
  const FR = { busy: false, last: 0, app: null, newApp: false };
  function renderFresh() {
    const el = $('#fresh'); if (!el) return;
    const L = S.live, stale = !!L && now() - L.t > 40 * 60;
    el.classList.toggle('busy', FR.busy);
    el.classList.toggle('stale', stale && !FR.newApp);
    el.classList.toggle('newapp', FR.newApp);
    $('#freshText').textContent = FR.newApp ? 'Neue Version' : L ? `${fTime.format(new Date(L.t * 1000))} · vor ${fmtDur(Math.max(0, now() - L.t))}` : 'lädt …';
    el.setAttribute('aria-label', FR.newApp ? 'Neue Version der Seite laden'
      : L ? `Datenstand ${fmtWhen(L.t)}. Tippen zum Aktualisieren.` : 'Daten werden geladen');
  }
  async function refreshHistory() {
    const old = new Map((tlIndex || []).map((d) => [d.date, `${d.n}|${d.t1}`]));
    let idx;
    try { idx = await ensureIndex(true); } catch { return false; }
    const changed = idx.filter((d) => old.get(d.date) !== `${d.n}|${d.t1}`).map((d) => d.date);
    if (!changed.length) return false;
    if (worker) await rpc('invalidate', { dates: changed });
    if (S.tl) S.tl.loaded = 0; // next timeline request reloads
    if (S.mode === 'karte' && (S.k.isLive || !S.tl)) await reloadTimeline();
    else if (S.mode === 'analyse') { if (S.tab === 'standzeit') renderIdle(); else scheduleCompute(0); }
    return true;
  }
  async function checkUpdate(manual) {
    if (FR.busy) return;
    if (manual && FR.newApp) { location.reload(); return; }
    FR.busy = true; renderFresh();
    const before = S.live?.meta?.ts;
    try {
      let ts = null;
      try {
        const r = await fetch(`status.json?t=${Date.now()}`, { cache: 'no-store' });
        if (r.ok) {
          const st = await r.json();
          ts = st.ts;
          if (FR.app == null) FR.app = S.cfg?.app || st.app;
          if (st.app && FR.app && st.app !== FR.app) FR.newApp = true;
        }
      } catch { /* older deploy without status.json */ }
      if (ts == null || ts !== before) await loadLive(true);
      const fresh = S.live?.meta?.ts !== before;
      const hist = fresh || manual ? await refreshHistory() : false;
      if (manual && S.live) toast(fresh || hist ? `Aktualisiert: Stand ${fmtWhen(S.live.t)}.`
        : `Schon aktuell. Die letzte Abfrage war ${fmtWhen(S.live.t)}, neuere Daten gibt es noch nicht.`);
      FR.last = now();
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

  let worker = null, rid = 0;
  const pending = new Map();
  function rpc(op, args) {
    if (!worker) {
      worker = new Worker(`worker.js?v=${S.cfg?.app || ''}`);
      worker.onmessage = (e) => { const p = pending.get(e.data.id); pending.delete(e.data.id); if (p) (e.data.ok ? p.res(e.data.res) : p.rej(new Error(e.data.err))); };
      worker.postMessage({ id: 0, op: 'init', args: { base: new URL('.', location.href).href } });
    }
    return new Promise((res, rej) => { const id = ++rid; pending.set(id, { res, rej }); worker.postMessage({ id, op, args, ver: dataVer }); });
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
      const tr = r.trips, n = tr.length / 8, list = [];
      for (let i = 0; i < n; i++) {
        const o = i * 8;
        list.push({ s: tr[o], e: tr[o + 1], a: [tr[o + 3], tr[o + 2]], b: [tr[o + 5], tr[o + 4]], d: tr[o + 6], short: !!tr[o + 7] });
      }
      list.sort((x, y) => x.s - y.s);
      S.trips = list;
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
  function renderKarte(force) {
    if (!styleReady || S.mode !== 'karte') return;
    const T = S.tl, k = S.k;
    if (k.isLive || !T) {
      if (!S.live) return;
      if (force || lastRendered !== -1) { renderLiveBikes(); lastRendered = -1; }
      k.clock = S.live.t;
      setClock(S.live.t, true);
    } else {
      if (force || lastRendered !== k.frame) { renderFrameBikes(k.frame); lastRendered = k.frame; }
      if (!k.playing) k.clock = T.t[k.frame];
      setClock(k.clock, false);
    }
    renderTrips(k.clock);
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
    $('#sTotal').textContent = nf.format(total);
    $('#sStation').textContent = nf.format(st);
    $('#sFree').textContent = nf.format(fr);
    $('#sUse').textContent = use == null ? '–' : nf.format(use);
  }

  function setClock(t, live) {
    $('#tlTime').textContent = fTime.format(new Date(t * 1000));
    $('#tlDate').textContent = live ? `Live, ${fDate.format(new Date(t * 1000))}` : fDate.format(new Date(t * 1000));
    const lb = $('#tlLive');
    lb.setAttribute('aria-pressed', String(live));
    lb.title = live ? 'Du siehst den aktuellen Stand' : 'Zum aktuellen Stand springen';
    $('#tlRange').setAttribute('aria-valuetext', live ? 'Live' : fmtWhen(t));
  }

  // ---- trips: moving dot plus fading trail along a curved line
  function arcPoint(a, b, u) {
    const [x0, y0] = a, [x1, y1] = b;
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, dx = x1 - x0, dy = (y1 - y0) * 1.58;
    const cx = mx - dy * 0.16, cy = my + (dx * 0.16) / 1.58, v = 1 - u;
    return [v * v * x0 + 2 * v * u * cx + u * u * x1, v * v * y0 + 2 * v * u * cy + u * u * y1];
  }
  function arcPath(a, b, u1 = 1, n = 16) { const p = []; for (let k = 0; k <= n; k++) p.push(arcPoint(a, b, (k / n) * u1)); return p; }

  function renderTrips(clock) {
    if (!styleReady) return;
    if (!S.trips || !S.layers.trips || S.mode !== 'karte') { setData('trips', EMPTY); setData('tripdots', EMPTY); return; }
    const lines = [], dots = [];
    const FADE = 25 * 60;
    for (const tr of S.trips) {
      if (tr.s > clock) break;
      if (tr.e < clock - FADE) continue;
      const dur = Math.max(60, tr.e - tr.s);
      if (clock <= tr.e) {
        const u = Math.min(1, Math.max(0.03, (clock - tr.s) / dur));
        lines.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: arcPath(tr.a, tr.b, u, 12) }, properties: { o: 1 } });
        dots.push({ type: 'Feature', geometry: { type: 'Point', coordinates: arcPoint(tr.a, tr.b, u) },
          properties: { s: tr.s, e: tr.e, d: tr.d, ax: tr.a[0], ay: tr.a[1], bx: tr.b[0], by: tr.b[1], short: tr.short ? 1 : 0 } });
      } else {
        lines.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: arcPath(tr.a, tr.b, 1, 12) }, properties: { o: 0.2 + 0.55 * (1 - (clock - tr.e) / FADE) } });
      }
    }
    setData('trips', { type: 'FeatureCollection', features: lines });
    setData('tripdots', { type: 'FeatureCollection', features: dots });
  }

  function showTrip(p) {
    showDetail('#detail', `
      <p class="kicker"><span class="dot" style="background:${C.trip}"></span>Geschätzte Fahrt</p>
      <h3>${fmtDist(p.d)} Luftlinie</h3>
      <dl class="kv"><dt>Von</dt><dd>${esc(nearestStationName(p.ax, p.ay))}</dd><dt>Nach</dt><dd>${esc(nearestStationName(p.bx, p.by))}</dd>
        <dt>Zeit</dt><dd>${+p.short ? `zwischen ${fTime.format(new Date(p.s * 1000))} und ${fTime.format(new Date(p.e * 1000))} Uhr` : `etwa ${fTime.format(new Date(p.s * 1000))} bis ${fTime.format(new Date(p.e * 1000))} Uhr`}</dd></dl>
      <p class="hint">Start und Ziel sind bekannt, der Weg dazwischen nicht. Die Linie verbindet nur die beiden Punkte.</p>`);
  }

  // ---- scrubber (the last position is "Live")
  function setupScrubber() {
    const T = S.tl, r = $('#tlRange');
    if (!T || !T.t.length) return;
    const i0 = T.i0, i1 = T.t.length - 1, liveIdx = i1 + 1;
    r.disabled = false;
    r.min = i0; r.max = liveIdx;
    if (S.k.isLive) r.value = liveIdx;
    else { S.k.frame = Math.min(Math.max(S.k.frame, i0), i1); r.value = S.k.frame; }
    const svg = $('#tlSpark');
    const ts = T.t[i0], te = Math.max(S.live?.t || 0, T.t[i1]), span = Math.max(1, te - ts);
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
    if (S.tl) $('#tlRange').value = S.tl.t.length;
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
    S.k.playing = false; cancelAnimationFrame(playRaf);
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
      const dt = Math.min(0.1, (ts - playLast) / 1000); playLast = ts;
      S.k.clock += dt * RATE[S.k.speed];
      let f = S.k.frame;
      while (f + 1 < T.t.length && T.t[f + 1] <= S.k.clock) f++;
      if (f !== S.k.frame) { S.k.frame = f; $('#tlRange').value = f; }
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
    showDetail(S.mode === 'analyse' ? '#detailA' : '#detail', `
      <p class="kicker"><span class="dot" style="background:${st ? C.station : C.free}"></span>${st ? 'An einer Station' : 'Frei abgestellt'}${S.me ? `, ${fmtDist(hav(S.me[1], S.me[0], b.lat, b.lng))} entfernt` : ''}</p>
      <h3>Rad ${esc(b.bike)}</h3>
      <dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
      <div class="actions">
        <a class="btn sm" href="${route}" target="_blank" rel="noopener">Route hierhin</a>
        <button class="btn sm ghost" data-act="trail" data-id="${esc(b.bike)}">Weg anzeigen</button>
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
      <div id="stHist" class="sub"><span class="busy">Typischer Füllstand wird berechnet</span></div>
      <div class="actions"><a class="btn sm" href="https://www.google.com/maps/dir/?api=1&destination=${st.lat},${st.lng}&travelmode=walking" target="_blank" rel="noopener">Route hierhin</a></div>`);
    select({ type: 'Point', coordinates: [st.lng, st.lat] });
    flyTo([st.lng, st.lat]);
    stationQuery(String(uid), true, '#stHist').catch(() => { const el = $('#stHist'); if (el) el.innerHTML = ''; });
  }

  function showTlBike(i) {
    const T = S.tl, id = T.bikes[i], cur = T.cur;
    const lat = T.lat0 + cur.la[i] / T.scale, lng = T.lng0 + cur.lo[i] / T.scale;
    const st = cur.pl[i] >= 0 ? T.stations[cur.pl[i]] : null;
    showDetail('#detail', `
      <p class="kicker"><span class="dot" style="background:${st ? C.station : C.free}"></span>${st ? 'An einer Station' : 'Frei abgestellt'}, ${fmtWhen(T.t[S.k.frame])}</p>
      <h3>Rad ${esc(id)}</h3>
      ${st ? `<dl class="kv"><dt>Station</dt><dd>${esc(st[1])}</dd></dl>` : ''}
      <div class="actions"><button class="btn sm" data-act="trail" data-id="${esc(id)}">Weg anzeigen</button>
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
      ${list.length ? `<div class="bikelist">${list.slice(0, 60).map((b) => `<button data-act="tlbike" data-id="${esc(b)}">${esc(b)}</button>`).join('')}</div>` : ''}`);
    select({ type: 'Point', coordinates: [s[3], s[2]] });
  }

  async function showTrailFor(id) {
    if (S.mode !== 'karte') { setMode('karte', { trail: id }); return; }
    let T;
    try { T = await ensureTimeline(); } catch { toast('Der Verlauf ist noch nicht verfügbar.'); return; }
    const i = T.bikeIndex.get(String(id));
    if (i == null) { toast(`Rad ${id} kommt im Zeitraum der Zeitleiste nicht vor.`); return; }
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
      } else if (T.reset[f] || T.gone[f].includes(i)) present = false;
      else if (present && last) last.t1 = T.t[f];
    }
    if (!stays.length) { toast(`Rad ${id} kommt im Zeitraum der Zeitleiste nicht vor.`); return; }
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
    const tr = S.trail, T = S.tl; if (!tr || !T) return;
    const name = (s) => (s.pl >= 0 ? esc(T.stations[s.pl][1]) : 'frei abgestellt');
    const rows = tr.stays.slice().reverse().slice(0, 60).map((s) => `
      <li><button class="rowbtn" data-act="frame" data-t="${s.t0}"><span class="dot" style="background:${s.pl >= 0 ? C.station : C.free}"></span>
        <span class="main"><b>${name(s)}</b><small>${fDate.format(new Date(s.t0 * 1000))} ${fTime.format(new Date(s.t0 * 1000))} bis ${s.t1 === s.t0 ? '–' : fTime.format(new Date(s.t1 * 1000))}</small></span>
        <span class="val">${fmtDur(Math.max(600, s.t1 - s.t0))}</span></button></li>`).join('');
    showDetail('#detail', `
      <p class="kicker">Weg im Zeitraum der Zeitleiste</p>
      <h3>Rad ${esc(tr.id)}</h3>
      <p class="hint">${tr.stays.length} Standorte. Antippen springt zu diesem Zeitpunkt.</p>
      <ul class="rows">${rows}</ul>
      <div class="actions"><button class="btn sm ghost" data-act="cleartrail">Weg ausblenden</button></div>`, { keepSel: true });
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

  // ================================================================ ANALYSE: filters
  const WD_NAMES = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  const FILTER_KEY = 'kvb-filter-v4';
  const DEFAULT_F = () => {
    const h = localHour(now());
    return { range: 14, from: null, to: null, wd: [1, 1, 1, 1, 1, 1, 1], a: h * 4, b: h * 4 + 4,
      kind: 'all', reachMetric: 'median', R: 200, res: 50, smooth: 75,
      minGone: 100, jump: 300, maxDurH: 4, cell: 250, top: 150, min: 1,
      stMetric: 'avg', k: 0, idleMin: 0 };
  };
  function loadFilter() {
    try { const s = JSON.parse(localStorage.getItem(FILTER_KEY) || 'null'); if (s && Array.isArray(s.wd)) return normWin({ ...DEFAULT_F(), ...s }); } catch { /* ignore */ }
    return DEFAULT_F();
  }
  // the time window is always start < end within one day (00:00–24:00), in 15-min steps
  function normWin(f) {
    let a = Math.round(+f.a), b = Math.round(+f.b);
    if (!Number.isFinite(a) || !Number.isFinite(b)) { a = 0; b = 96; }
    a = Math.min(95, Math.max(0, a)); b = Math.min(96, Math.max(1, b));
    if (b <= a) { a = 0; b = 96; }
    f.a = a; f.b = b;
    return f;
  }
  const wholeDay = () => S.f.a === 0 && S.f.b === 96;
  function saveFilter() { try { localStorage.setItem(FILTER_KEY, JSON.stringify(S.f)); } catch { /* ignore */ } }

  const winMin = () => (wholeDay() ? { t0: 0, t1: 0 } : { t0: S.f.a * 15, t1: S.f.b * 15 });
  const winLabel = () => (wholeDay() ? 'ganzer Tag' : `${minToStr(S.f.a * 15)}–${S.f.b === 96 ? '24:00' : minToStr(S.f.b * 15)}`);
  const wdLabel = (wd = S.f.wd) => {
    const key = wd.map((x) => (x ? 1 : 0)).join('');
    if (key === '1111111') return 'alle Tage';
    if (key === '1111100') return 'Mo–Fr';
    if (key === '0000011') return 'Sa/So';
    if (key === '0000000') return 'keine Tage';
    return WD_NAMES.filter((_, i) => wd[i]).join(', ');
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
  const rangeLabel = () => { const { from, to } = filterDates(); return from ? (from === to ? fmtD(from) : `${fmtD(from)}–${fmtD(to)}`) : ''; };

  // what each tab answers, and how it is computed
  const TABS = {
    erreichbarkeit: {
      lead: 'Wie weit läufst du zum nächsten Rad?',
      how: `<p><b>Pro Abfrage:</b> Für jedes Feld der Karte (50 × 50 m) wird die Luftlinie zum nächsten abgestellten Rad bestimmt. Das ist ein Schnappschuss: „Wenn ich um 08:13 hier gestanden hätte, wie weit wäre das nächste Rad gewesen?“</p>
        <p><b>Über den Zeitraum:</b> Für jedes Feld werden diese Abstände aus allen Abfragen im Filter gesammelt. Gezeigt wird nicht der Mittelwert, sondern der <b>Median</b>: In der Hälfte der Abfragen war ein Rad näher, in der anderen Hälfte weiter weg. Der Median ist robust gegen seltene Ausreißer (etwa ein einzelner Moment, in dem alle Räder in der Nähe gerade unterwegs waren), die einen Mittelwert stark verzerren würden. Jede Abfrage zählt gleich viel. Bei mehr als 150 passenden Abfragen wird eine gleichmäßig über den Zeitraum verteilte Stichprobe von 150 genutzt.</p>
        <p><b>Chance im Umkreis</b> nutzt dieselben Abstände: der Anteil der Abfragen, in denen der Abstand höchstens so groß war wie der gewählte Umkreis.</p>
        <p><b>Grenzen:</b> Luftlinie, nicht Fußweg (der echte Weg ist meist ein Viertel bis ein Drittel länger). Genauigkeit etwa ±25 m durch das Raster. Tippen auf die Karte rechnet für genau diesen Punkt ohne Raster.</p>`,
    },
    dichte: {
      lead: 'Wo stehen im Schnitt die meisten Räder?',
      how: `<p>Pro Abfrage werden die abgestellten Räder je Feld gezählt, über alle Abfragen im Filter gemittelt (hier wirklich der Mittelwert) und leicht geglättet. Einheit: Räder pro Hektar (100 × 100 m).</p>
        <p><b>Unterschied zur Erreichbarkeit:</b> Dichte fragt „wie viele?“, Erreichbarkeit „wie weit bis zum ersten?“. In der dichten Innenstadt sehen beide ähnlich aus. Auseinander gehen sie hier:</p>
        <ul><li>Eine Station mit 20 Rädern ist bei der Dichte ein heller Fleck, bei der Erreichbarkeit nur gut im Umkreis von wenigen hundert Metern.</li>
        <li>Ein Viertel mit einem Rad alle 150 m hat kaum Dichte, aber gute Erreichbarkeit.</li></ul>
        <p>Für „finde ich hier ein Rad?“ ist die Erreichbarkeit die richtige Ansicht. Die Dichte zeigt, wo sich die Flotte sammelt.</p>`,
    },
    stroeme: {
      lead: 'Wohin fahren die Räder?',
      how: `<p>Eine Fahrt wird geschätzt, wenn ein Rad aus dem Feed verschwindet und an anderer Stelle wieder auftaucht, oder zwischen zwei Abfragen weit springt. Zugeordnet wird sie ihrer Startzeit. Liegen zwischen zwei Abfragen mehr als eine Stunde (ausgefallene Abfragen), ist der Zeitpunkt unklar, solche Bewegungen werden nicht gezählt.</p>
        <ul><li><b>Linien</b>: die häufigsten Verbindungen zwischen Start- und Zielbereich. Die Punkte wandern in Fahrtrichtung, dickere Linie bedeutet mehr Fahrten.</li>
        <li><b>Kreise</b>: Bilanz je Bereich. Rot heißt, hier beginnen mehr Fahrten als enden (Räder fließen ab), blau das Gegenteil. Größe = Anzahl.</li></ul>
        <p>Mit ▶ wandert das Zeitfenster durch den Tag. Einzelne Fahrten in Echtzeit zeigt die Ansicht „Karte“ beim Abspielen.</p>`,
    },
    nutzung: {
      lead: 'Wie viel wird gefahren, wann und wie weit?',
      how: `<p>Grundlage sind dieselben geschätzten Fahrten wie bei „Ströme“. „Unterwegs“ zählt zu jeder Abfrage die Fahrten, die gerade laufen.</p>
        <p>Fahrten, die zwischen zwei Abfragen beginnen und enden, haben keine messbare Dauer. Lange Abwesenheiten zählen als Werkstatt oder Umverteilung. Umverteilung per Transporter lässt sich nicht sicher von Fahrten trennen.</p>`,
    },
    stationen: {
      lead: 'Wie voll sind die Stationen typischerweise?',
      how: `<p>Pro Abfrage werden die Räder an jeder Station gezählt.</p>
        <ul><li><b>Ø Räder</b>: Mittelwert über alle Abfragen im Filter.</li>
        <li><b>Chance leer</b>: Anteil der Abfragen, in denen höchstens so viele Räder dort standen wie eingestellt (Standard: keins).</li></ul>
        <p>Station antippen zeigt den Verlauf über den Tag.</p>`,
    },
    standzeit: {
      lead: 'Wie lange stehen Räder unbewegt am selben Ort?',
      how: `<p>Ein Rad gilt als bewegt, wenn es aus dem Feed verschwindet (gefahren oder abgeholt) oder sich mehr als 100 m verschiebt. Gezeigt wird die Zeit seit der letzten Bewegung, Stand jetzt.</p>
        <p>Genauigkeit: so fein wie der Abfrageabstand (etwa 13 Minuten). Standzeiten, die vor Beginn der Aufzeichnung anfingen, sind Mindestwerte.</p>`,
    },
  };

  function syncFilterUI() {
    const { a, b } = S.f;
    $('#wA').value = a; $('#wB').value = b;
    $('#wLabel').textContent = winLabel();
    $('#wDays').textContent = wdLabel();
    const fill = $('#wFill');
    fill.style.left = `calc(12px + (100% - 24px) * ${a / 96})`; fill.style.width = `calc((100% - 24px) * ${(b - a) / 96})`;
    drawCoverage();
    const idle = S.tab === 'standzeit';
    $('#timeBar').hidden = idle;
    $('#aLead').textContent = TABS[S.tab].lead;
    $('#fSumText').textContent = idle ? 'Filter und Erklärung' : `Filter: ${wdLabel()}, ${rangeLabel()}`;
    $('#wA').setAttribute('aria-valuetext', minToStr(a * 15));
    $('#wB').setAttribute('aria-valuetext', b === 96 ? '24:00' : minToStr(b * 15));
  }

  const FMT = {
    smooth: (v) => (+v ? `${v} m` : 'aus'), minGone: (v) => `${v} m`, jump: (v) => `${v} m`,
    maxDurH: (v) => `${nf1.format(v)} Std.`, cell: (v) => fmtDist(+v), top: (v) => `${v}`, min: (v) => `${v}`,
    k: (v) => (+v ? `höchstens ${v} ${+v === 1 ? 'Rad' : 'Räder'}` : 'kein Rad'),
  };
  const IDLE_STEPS = [0, 900, 1800, 3600, 7200, 4 * 3600, 8 * 3600, 86400, 2 * 86400, 3 * 86400, 7 * 86400];
  const idleLabel = (s) => (s ? `mind. ${fmtDur(s)}` : 'alle');

  function slider(id, label, min, max, step, val, fmt) {
    return `<div class="row"><h3><label for="${id}">${label}</label><output id="${id}-o">${fmt(val)}</output></h3>
      <input class="slider" type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}" data-param="${id.replace('p-', '')}"></div>`;
  }
  function seg(key, label, opts) {
    return `<div class="row"><h3>${label}</h3><div class="seg" role="radiogroup" data-seg="${key}">
      ${opts.map(([v, l]) => `<button role="radio" data-v="${v}" aria-checked="${String(S.f[key]) === String(v)}">${l}</button>`).join('')}</div></div>`;
  }
  const kindSeg = () => seg('kind', 'Welche Räder', [['all', 'Alle'], ['free', 'Frei'], ['station', 'An Station']]);
  const resSeg = () => seg('res', 'Kartenauflösung', [[50, '50 m'], [100, '100 m'], [200, '200 m']]);
  const R_OPTS = [50, 100, 150, 200, 300, 400, 500, 700, 1000];

  function tabParams() {
    const f = S.f;
    switch (S.tab) {
      case 'erreichbarkeit':
        return seg('reachMetric', 'Darstellung', [['median', 'Laufweg'], ['prob', 'Chance im Umkreis']])
          + (f.reachMetric === 'prob' ? `<div class="row"><h3>Umkreis</h3><div class="chips tight" data-seg="R">${R_OPTS.map((r) => `<button class="chip${f.R === r ? ' on' : ''}" data-v="${r}" aria-pressed="${f.R === r}">${r} m</button>`).join('')}</div></div>` : '')
          + kindSeg() + resSeg();
      case 'dichte': return slider('p-smooth', 'Glättung', 0, 300, 25, f.smooth, FMT.smooth) + kindSeg() + resSeg();
      case 'nutzung': return tripSliders();
      case 'stroeme': return slider('p-cell', 'Größe der Start- und Zielbereiche', 100, 2000, 50, f.cell, FMT.cell)
        + slider('p-top', 'Höchstens so viele Verbindungen', 10, 400, 10, f.top, FMT.top) + slider('p-min', 'Mindestens Fahrten je Verbindung', 1, 20, 1, f.min, FMT.min) + tripSliders();
      case 'stationen': return seg('stMetric', 'Farbe zeigt', [['avg', 'Ø Räder'], ['empty', 'Chance leer']]) + slider('p-k', 'Als „leer“ gilt', 0, 5, 1, f.k, FMT.k);
      case 'standzeit': return `<div class="row"><h3><label for="p-idle">Nur Räder, die unbewegt sind seit</label><output id="p-idle-o">${idleLabel(f.idleMin)}</output></h3>
        <input class="slider" type="range" id="p-idle" min="0" max="${IDLE_STEPS.length - 1}" step="1" value="${Math.max(0, IDLE_STEPS.indexOf(f.idleMin))}"></div>` + kindSeg();
      default: return '';
    }
  }
  function tripSliders() {
    const f = S.f;
    return `<h3 class="group">Wann zählt etwas als Fahrt?</h3>`
      + slider('p-minGone', 'Rad verschwindet und taucht mindestens so weit entfernt wieder auf', 50, 1000, 50, f.minGone, FMT.minGone)
      + slider('p-jump', 'oder springt zwischen zwei Abfragen weiter als', 100, 2000, 100, f.jump, FMT.jump)
      + slider('p-maxDurH', 'Länger weg = Werkstatt oder Umverteilung', 0.5, 12, 0.5, f.maxDurH, FMT.maxDurH);
  }

  const WIN_PRESETS = [['Ganzer Tag', 0, 96], ['Nachts 0–6', 0, 24], ['Morgens 6–10', 24, 40], ['Tagsüber 10–16', 40, 64], ['Abends 16–20', 64, 80], ['Spätabends 20–24', 80, 96]];
  function filterBlock() {
    const { from, to } = filterDates();
    const min = tlIndex?.length ? firstDate() : '', max = tlIndex?.length ? lastDate() : '';
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
        <div class="quick"><button data-wdp="1111111">Alle</button><button data-wdp="1111100">Mo–Fr</button><button data-wdp="0000011">Sa/So</button></div></div>
      <div class="row"><h3>Uhrzeit</h3>
        <div class="quick">${WIN_PRESETS.map(([l, a, b]) => `<button data-win="${a},${b}" aria-pressed="${S.f.a === a && S.f.b === b}">${l}</button>`).join('')}</div>
        <p class="hint">Oder oben am Regler: Griffe ziehen ändert Beginn und Ende, den dunklen Balken ziehen verschiebt das ganze Fenster. Die grauen Säulen darüber zeigen, zu welchen Uhrzeiten es Abfragen gibt.</p></div>`;
    return `<details class="explain"><summary>So wird gerechnet</summary>${TABS[S.tab].how}</details>
      <div class="block filters" id="filters"><h2>Filter</h2>${common}${tabParams()}</div>`;
  }

  // ================================================================ ANALYSE: compute + render
  let anSeq = 0, anTimer = 0;
  async function enterAnalysis() {
    for (const b of $$('#aTabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === S.tab));
    stopParticles();
    applyVisibility();
    $('#aLegend').innerHTML = '';
    try { await ensureIndex(); } catch {
      syncFilterUI();
      $('#aMore').innerHTML = '<div class="empty">Noch keine Verlaufsdaten vorhanden. Sie entstehen automatisch mit den nächsten Abfragen.</div>';
      return;
    }
    if (S.mode !== 'analyse') return;
    syncFilterUI();
    $('#aMore').innerHTML = `${filterBlock()}<div class="block" id="aOut"><span class="busy">rechnet</span></div>`;
    bindFilterInputs();
    refreshSheet();
    compute();
  }

  function scheduleCompute(delay = 120) {
    clearTimeout(anTimer);
    anTimer = setTimeout(compute, delay);
    setBusy();
  }

  // ---- one status line in the peek, the same for every tab
  const plural = (n, one, many) => `${nf.format(n)} ${n === 1 ? one : many}`;
  function setBusy() {
    const el = $('#aStatus');
    if (!el || S.tab === 'standzeit') return;
    if (!$('.busy', el)) { el.className = 'astatus'; el.innerHTML = '<span class="busy">rechnet …</span>'; }
  }
  function widenButtons() {
    const b = [];
    if (!wholeDay()) b.push(['day', 'Ganzer Tag']);
    if (S.f.wd.some((x) => !x)) b.push(['wd', 'Alle Wochentage']);
    if (S.f.range !== 'all') b.push(['range', 'Ganzer Zeitraum']);
    return b.map(([w, l]) => `<button class="btn sm" type="button" data-act="widen" data-w="${w}">${l}</button>`).join('');
  }
  function setStatus(msg, kind = '') {
    const el = $('#aStatus');
    el.className = `astatus${kind ? ` ${kind}` : ''}`;
    el.innerHTML = `<span class="msg">${msg}</span>${kind === 'none' ? `<span class="acts">${widenButtons()}</span>` : ''}`;
    refreshSheet();
  }
  const basisText = (polls, days) => `${plural(polls, 'Abfrage', 'Abfragen')} an ${plural(days, 'Tag', 'Tagen')}`;
  // normal result: what the numbers are based on; warns when that is thin
  function statusOk(polls, days, lead = '') {
    const thin = polls < 30;
    setStatus(`${lead ? `<b>${lead}</b> · ` : ''}Grundlage: ${basisText(polls, days)}.${thin ? ' Noch wenig Daten, Werte eher zufällig.' : ''}`, thin ? 'warn' : '');
  }
  function statusNone(what) {
    setStatus(`<b>${what}</b> ${wholeDay() ? '' : 'Die grauen Säulen über dem Regler zeigen, wann es Daten gibt.'}`, 'none');
  }

  // ---- data coverage above the time slider (polls per 15 min, date range + weekdays)
  function drawCoverage() {
    const svg = $('#wCov'); if (!svg) return;
    const c = S.cov;
    if (!c) { svg.innerHTML = ''; return; }
    const max = Math.max(1, ...c.bins);
    let h = '';
    for (let i = 0; i < 96; i++) {
      if (!c.bins[i]) continue;
      const v = 2.5 + 7.5 * Math.sqrt(c.bins[i] / max);
      h += `<rect x="${i + 0.12}" y="${10 - v}" width="0.76" height="${v}"${i >= S.f.a && i < S.f.b ? ' class="in"' : ''}/>`;
    }
    svg.innerHTML = h;
  }

  function coverageText() {
    if (!tlIndex?.length) return '';
    const days = tlIndex.slice(-5).map((d) => `${fDate.format(new Date(d.t0 * 1000))} ${fTime.format(new Date(d.t0 * 1000))}–${fTime.format(new Date(d.t1 * 1000))} Uhr`);
    return `${tlIndex.length > 5 ? '… ' : ''}${days.join(', ')}`;
  }
  // body text under an empty result (the actions sit in the status line in the peek)
  function emptyState(what) {
    return `<div class="empty"><b>${what}</b><p>Daten gibt es bisher für: ${esc(coverageText())}.</p></div>`;
  }
  // clear everything a tab draws on the map, so an empty result never leaves old shapes behind
  function clearAnalysisLayers() {
    clearRaster(); legendClear(); stopParticles();
    flowLines = [];
    for (const id of ['flows', 'netc', 'anst']) setData(id, EMPTY);
  }

  async function compute() {
    if (S.mode !== 'analyse') return;
    const seq = ++anSeq;
    const { dates } = filterDates();
    const f = F();
    const out = () => $('#aOut');
    setBusy();
    const none = (status, body) => { clearAnalysisLayers(); statusNone(status); out().innerHTML = emptyState(body || status); };
    try {
      if (S.tab === 'standzeit') { $('#aStatus').innerHTML = ''; renderIdle(); return; }
      if (!dates.length) { S.cov = null; drawCoverage(); none('Im gewählten Zeitraum gibt es keine Daten.'); return; }
      if (!f.wd.some(Boolean)) { S.cov = null; drawCoverage(); clearAnalysisLayers(); setStatus('<b>Kein Wochentag gewählt.</b>', 'none'); out().innerHTML = ''; return; }
      // same check for every tab: are there polls in this filter at all?
      const cov = await rpc('coverage', { F: f, dates });
      if (seq !== anSeq) return;
      S.cov = cov; drawCoverage();
      if (!cov.polls) {
        none(`Zwischen ${winLabel()} Uhr gibt es ${f.wd.every(Boolean) ? '' : `(${wdLabel()}) `}noch keine Abfragen.`, 'Keine Abfrage in diesem Zeitfenster.');
        return;
      }
      let r;
      switch (S.tab) {
        case 'erreichbarkeit':
          r = await rpc('reach', { F: f, dates, res: S.f.res, metric: S.f.reachMetric, R: S.f.R, classes: S.f.reachMetric === 'prob' ? probClasses() : distClasses() });
          if (seq !== anSeq) return;
          showRaster(r); renderReachOut(r);
          if (r.sampled > r.polls) setStatus(`Grundlage: gleichmäßige Stichprobe von ${nf.format(r.polls)} aus ${basisText(r.sampled, r.days)}.`);
          else statusOk(r.polls, r.days);
          break;
        case 'dichte':
          r = await rpc('density', { F: f, dates, res: S.f.res, smooth: S.f.smooth, stops: toStops(R.heat.slice(1), 0.25, 0.9) });
          if (seq !== anSeq) return;
          showRaster(r); renderDensOut(r); statusOk(r.polls, r.days); break;
        case 'nutzung':
          r = await rpc('usage', { F: f, dates, P: tripParams() });
          if (seq !== anSeq) return;
          renderUsageOut(r);
          if (!r.count) statusNone(`Keine Fahrten mit Start ${wholeDay() ? 'im Zeitraum' : `zwischen ${winLabel()} Uhr`} (${basisText(r.polls, r.days)}).`);
          else statusOk(r.polls, r.days, `${plural(r.count, 'Fahrt', 'Fahrten')} im Zeitfenster`);
          break;
        case 'stroeme':
          r = await rpc('flows', { F: f, dates, P: tripParams(), cell: S.f.cell, top: S.f.top, min: S.f.min });
          if (seq !== anSeq) return;
          renderFlowsOut(r);
          if (!r.trips) statusNone(`Keine Fahrten mit Start ${wholeDay() ? 'im Zeitraum' : `zwischen ${winLabel()} Uhr`} (${basisText(r.polls, r.days)}).`);
          else statusOk(r.polls, r.days, `${plural(r.trips, 'Fahrt', 'Fahrten')} im Zeitfenster`);
          break;
        case 'stationen':
          r = await rpc('stations', { F: f, dates, k: S.f.k });
          if (seq !== anSeq) return;
          renderStationsOut(r); statusOk(r.polls, r.days); break;
        default:
      }
      if (S.sel?.type === 'point') pointQuery(S.sel.lng, S.sel.lat, true);
      if (S.sel?.type === 'station') stationQuery(S.sel.uid, true);
    } catch (err) {
      console.error(err);
      if (seq === anSeq) { setStatus('<b>Die Auswertung ist fehlgeschlagen.</b>', 'none'); out().innerHTML = `<div class="empty">${esc(err.message.split('\n')[0])}</div>`; }
    }
  }

  // the raster goes to the map as a PNG blob URL (encoded off the main thread by toBlob)
  let rasterUrl = null, rasterSeq = 0;
  function showRaster(r) {
    const src = map.getSource('raster'); if (!src) return;
    const seq = ++rasterSeq;
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
  function clearRaster() { rasterSeq++; map.getSource('raster')?.updateImage({ url: PIXEL }); }
  const legendClear = () => { $('#aLegend').innerHTML = ''; refreshSheet(); };

  const legend = (cap, body) => { $('#aLegend').innerHTML = `<div class="top"><div class="cap">${cap}</div></div>${body}`; refreshSheet(); };

  function renderReachOut(r) {
    if (S.f.reachMetric === 'prob') {
      legend(`Chance auf ein Rad im Umkreis von ${S.f.R} m`, stepLegend(STEPS.slice().reverse(), PROB_CLASSES.map((c) => c[1])));
    } else {
      legend('Typischer Weg zum nächsten Rad (Luftlinie), bis …',
        stepLegend(STEPS, DIST_CLASSES.map((c) => c[1]), DIST_CLASSES.map((c) => `~${c[2]} Min.`)) + '<p class="hint legend-note">Ohne Farbe: weiter als 1,2 km. Gehzeit bei Luftlinie, der echte Weg ist etwas länger.</p>');
    }
    $('#aOut').innerHTML = `<p class="hint">Tipp: irgendwo auf die Karte tippen. Dann wird für genau diesen Ort gerechnet, mit Tagesverlauf.</p>
      ${S.me ? '<div class="actions"><button class="btn sm ghost" data-act="pointme" type="button">Meinen Standort auswerten</button></div>' : ''}`;
  }

  function renderDensOut(r) {
    legend('Abgestellte Räder pro Hektar, im Schnitt', `<div class="bar" style="background:${gradient(R.heat.slice(1))}"></div><div class="scale"><span>wenige</span><span>${nf1.format(r.vmax)} pro ha</span></div>`);
    $('#aOut').innerHTML = `<p class="hint">Tipp: auf die Karte tippen für den Tagesverlauf an diesem Ort.</p>`;
  }

  function renderUsageOut(r) {
    const { t0, t1 } = winMin();
    legend(`Fahrten mit Start ${winLabel() === 'ganzer Tag' ? 'über den ganzen Tag' : `${winLabel()} Uhr`}, ${wdLabel()}`, `<div class="tiles">
      <div class="stat"><b>${r.perDay != null ? nf.format(Math.round(r.perDay)) : '–'}</b><span>pro Tag</span></div>
      <div class="stat"><b>${r.medDur != null ? `${nf.format(Math.round(r.medDur))} min` : '–'}</b><span>Dauer, Median</span></div>
      <div class="stat"><b>${r.medDist != null ? fmtDist(r.medDist) : '–'}</b><span>Strecke, Median</span></div></div>`);
    const dur = r.durH, dist = r.distH;
    $('#aOut').innerHTML = `${!r.count ? '<p class="hint">Im Zeitfenster wurde keine Fahrt erkannt. Die Tagesverläufe unten gelten trotzdem für alle Uhrzeiten.</p>' : ''}
      <div class="block">${lineChart({ title: 'Räder unterwegs nach Uhrzeit', sub: 'Durchschnitt', series: [{ name: wdLabel(), color: C.trip, values: r.inuseH }], band: [t0, t1] })}</div>
      <div class="block">${lineChart({ title: 'Fahrtbeginne pro Stunde', sub: 'Durchschnitt', series: [{ name: wdLabel(), color: C.trip, values: r.perHour }], band: [t0, t1] })}</div>
      <div class="block">${timeChart({ title: 'Räder unterwegs im Zeitraum', t: r.series.t, values: r.series.inuse, color: C.trip })}</div>
      <div class="block">${barChart({ title: 'Fahrtdauer', sub: `${nf.format(r.count - r.short)} mit messbarer Dauer`, values: dur,
        labels: dur.map((_, k) => (k === dur.length - 1 ? 'über 2 Std.' : `${k * 5}–${k * 5 + 5} min`)), tickEvery: 6, tickLabel: (k) => (k === dur.length - 1 ? '' : `${k * 5}`), unitX: 'min' })}</div>
      <div class="block">${barChart({ title: 'Strecke (Luftlinie)', sub: `${nf.format(r.count)} Fahrten`, values: dist,
        labels: dist.map((_, k) => (k === dist.length - 1 ? 'über 8 km' : `${nf1.format(k * 0.25)}–${nf1.format(k * 0.25 + 0.25)} km`)), tickEvery: 4, tickLabel: (k) => (k === dist.length - 1 ? '' : nf1.format(k * 0.25)), unitX: 'km' })}</div>
      <p class="hint">Nicht als Fahrt gezählt: ${nf.format(r.service)} Abwesenheiten über ${nf1.format(S.f.maxDurH)} Std., ${nf.format(r.round)} Rückkehren an denselben Ort${r.unclear ? ` und ${nf.format(r.unclear)} Bewegungen über eine Abfragelücke von mehr als einer Stunde (Zeitpunkt unklar)` : ''}.</p>`;
  }

  function nearestStationName(lng, lat) {
    let best = null, bd = Infinity;
    for (const s of S.live?.stations || []) { const d = hav(lat, lng, s.lat, s.lng); if (d < bd) { bd = d; best = s; } }
    return best ? (bd > 600 ? `nahe ${best.name}` : best.name) : `${nf1.format(lat)}, ${nf1.format(lng)}`;
  }

  // ---- flows, with particles moving along the lines
  let flowLines = [], partRaf = 0, partFrame = 0;
  function renderFlowsOut(r) {
    const max = Math.max(1, ...r.lines.map((l) => l[4]));
    flowLines = r.lines.map(([x0, y0, x1, y1, c]) => ({ a: [x0, y0], b: [x1, y1], c, w: c / max, n: Math.max(1, Math.round((c / max) * 4)), seed: Math.random() }));
    setData('flows', { type: 'FeatureCollection', features: flowLines.map((l) => ({
      type: 'Feature', geometry: { type: 'LineString', coordinates: arcPath(l.a, l.b, 1, 20) }, properties: { w: l.w, c: l.c } })) });
    const vmax = Math.max(1, ...r.cells.map((c) => c[2] + c[3]));
    // circles use the same threshold as the lines, so both always appear together
    setData('netc', { type: 'FeatureCollection', features: r.cells.filter((c) => c[2] + c[3] >= S.f.min).map(([x, y, s, e]) => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [x, y] }, properties: { v: (e - s) / (e + s), n: e + s, s, e, rel: Math.sqrt((e + s) / vmax) } })) });
    legend('Kreise: Bilanz je Bereich. Linien: häufigste Verbindungen, die Punkte zeigen die Richtung.',
      `<div class="bar" style="background:${gradient([R.div.neg[0], R.div.neg[1], R.div.neg[2], R.div.mid, R.div.pos[0], R.div.pos[1], R.div.pos[2]])}"></div>
      <div class="scale"><span>mehr Abfahrten</span><span>ausgeglichen</span><span>mehr Ankünfte</span></div>`);
    if (!r.trips) { legendClear(); $('#aOut').innerHTML = emptyState('Keine Fahrten im Zeitfenster.'); stopParticles(); return; }
    const top = r.lines.slice(0, 12);
    $('#aOut').innerHTML = `<h2>Häufigste Verbindungen</h2>
      ${top.length ? `<ul class="rows">${top.map(([x0, y0, x1, y1, c]) => `<li><span class="main"><b>${esc(nearestStationName(x0, y0))}</b><small>nach ${esc(nearestStationName(x1, y1))}, ${fmtDist(hav(y0, x0, y1, x1))}</small></span><span class="val">${nf.format(c)}<small>${c === 1 ? 'Fahrt' : 'Fahrten'}</small></span></li>`).join('')}</ul>`
        : `<p class="hint">Keine Verbindung hat mindestens ${S.f.min} Fahrten. Unter „Filter“ die Mindestzahl senken.</p>`}`;
    startParticles();
  }
  function startParticles() {
    stopParticles();
    if (REDUCED) { drawParticles(0.7, true); return; }
    let last = performance.now(), acc = 0;
    const tick = (ts) => {
      acc += (ts - last) / 1000; last = ts;
      if (S.mode === 'analyse' && S.tab === 'stroeme') { drawParticles(acc / 3.2); partRaf = requestAnimationFrame(tick); }
    };
    partRaf = requestAnimationFrame(tick);
  }
  function stopParticles() { cancelAnimationFrame(partRaf); partRaf = 0; if (styleReady) setData('particles', EMPTY); }
  function drawParticles(phase, still) {
    if (!still && partFrame++ % 2) return; // ~30 fps is plenty
    const feats = [];
    for (const l of flowLines) {
      for (let k = 0; k < l.n; k++) {
        const u = still ? phase : (phase + k / l.n + l.seed) % 1;
        feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: arcPoint(l.a, l.b, u) }, properties: { o: Math.min(1, u * 4, (1 - u) * 6) } });
      }
    }
    setData('particles', { type: 'FeatureCollection', features: feats });
  }

  function showNetCell(p, lngLat) {
    showDetail('#detailA', `
      <p class="kicker">Bereich bei ${esc(nearestStationName(lngLat[0], lngLat[1]))}</p>
      <h3>${nf.format(p.s)} Abfahrten, ${nf.format(p.e)} Ankünfte</h3>
      <p class="hint">${wdLabel()}, ${winLabel()}, ${rangeLabel()}. ${p.e > p.s ? 'Hier sammeln sich Räder an.' : p.e < p.s ? 'Von hier fahren mehr Räder weg als ankommen.' : 'Ausgeglichen.'}</p>`);
    select({ type: 'Point', coordinates: lngLat });
  }

  // ---- stations
  function renderStationsOut(r) {
    S.stList = r.list;
    const rows = r.list.filter((s) => s.p != null);
    const amax = Math.max(1, ...rows.map((s) => s.avg));
    setData('anst', { type: 'FeatureCollection', features: rows.map((s) => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [s.lng, s.lat] }, properties: { uid: s.uid, p: s.p, a: s.avg, r: s.avg / amax } })) });
    const empty = S.f.stMetric === 'empty';
    map.setPaintProperty('an-st', 'circle-color', empty
      ? ['interpolate', ['linear'], ['get', 'p'], 0, R.red[0], 33, R.red[1], 66, R.red[2], 100, R.red[3]]
      : ['interpolate', ['linear'], ['get', 'r'], 0, R.blue[0], 0.33, R.blue[1], 0.66, R.blue[2], 1, R.blue[3]]);
    if (empty) legend(`Chance, dass die Station ${S.f.k ? `höchstens ${S.f.k} ${S.f.k === 1 ? 'Rad' : 'Räder'} hat` : 'leer ist'}`, `<div class="bar" style="background:${gradient(R.red)}"></div><div class="scale"><span>nie</span><span>50 %</span><span>immer</span></div>`);
    else legend('Durchschnittliche Zahl Räder an der Station', `<div class="bar" style="background:${gradient(R.blue)}"></div><div class="scale"><span>0</span><span>${nf1.format(amax / 2)}</span><span>${nf1.format(amax)}</span></div>`);
    if (!rows.length) { legendClear(); $('#aOut').innerHTML = emptyState('Keine Abfrage passt zum Filter.'); return; }
    const emp = rows.slice().sort((x, y) => y.p - x.p || x.avg - y.avg).slice(0, 8);
    const full = rows.slice().sort((x, y) => y.avg - x.avg).slice(0, 6);
    const kl = S.f.k ? 'fast leer' : 'leer';
    const li = (s, v, sub) => `<li><button class="rowbtn" data-act="stq" data-id="${esc(s.uid)}"><span class="main"><b>${esc(s.name)}</b><small>${sub}</small></span><span class="val">${v}</span></button></li>`;
    $('#aOut').innerHTML = `<h2>Am häufigsten ${kl}</h2><ul class="rows">${emp.map((s) => li(s, `${Math.round(s.p)} %<small>der Zeit ${kl}</small>`, `im Schnitt ${nf1.format(s.avg)} Räder`)).join('')}</ul>
      <h2 class="spaced">Meist gut gefüllt</h2><ul class="rows">${full.map((s) => li(s, `${nf1.format(s.avg)}<small>Räder im Schnitt</small>`, `${Math.round(s.p)} % der Zeit ${kl}`)).join('')}</ul>`;
  }

  // ---- point and station queries
  function circle([lng, lat], r) {
    const pts = [];
    for (let k = 0; k <= 64; k++) {
      const a = (k / 64) * 2 * Math.PI;
      pts.push([lng + (r * Math.cos(a)) / (111320 * Math.cos((lat * Math.PI) / 180)), lat + (r * Math.sin(a)) / 111320]);
    }
    return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [pts] }, properties: {} };
  }

  async function pointQuery(lng, lat, quiet) {
    S.sel = { type: 'point', lng, lat };
    const Rq = S.tab === 'dichte' ? 150 : S.f.reachMetric === 'prob' ? S.f.R : 200;
    setData('qpt', { type: 'FeatureCollection', features: [circle([lng, lat], Rq), { type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: {} }] });
    applyVisibility();
    if (!quiet) showDetail('#detailA', '<p class="kicker">Ausgewählter Ort</p><h3>…</h3><span class="busy">rechnet</span>', { keepSel: true });
    const { dates } = filterDates();
    if (!dates.length) return;
    const r = await rpc('point', { F: F(), dates, lat, lng, R: Rq });
    if (S.sel?.type !== 'point' || S.sel.lng !== lng) return;
    const dens = S.tab === 'dichte', w = r.win;
    let head, sub;
    if (!w) { head = 'keine Daten'; sub = 'Keine Abfrage passt zum Filter'; }
    else if (dens) { head = `${nf1.format(w.avg)} Räder`; sub = `stehen im Schnitt im Umkreis von ${Rq} m (${wdLabel()}, ${winLabel()})`; }
    else if (S.f.reachMetric === 'prob') { head = `${Math.round(w.pct)} %`; sub = `Chance auf mindestens ein Rad im Umkreis von ${Rq} m (${wdLabel()}, ${winLabel()})`; }
    else { head = r.nearestMedian != null ? fmtDist(r.nearestMedian) : '–'; sub = `typischer Weg zum nächsten Rad, Luftlinie (${wdLabel()}, ${winLabel()})`; }
    const vals = (o) => (dens ? o.avg : o.pct);
    showDetail('#detailA', `
      <p class="kicker">${esc(nearestStationName(lng, lat))}</p>
      <h3>${head}</h3>
      <p class="hint">${sub}.${w ? ` Grundlage: ${nf.format(w.n)} Abfragen.` : ''}</p>
      ${w && !dens ? `<dl class="kv"><dt>Rad im Umkreis ${Rq} m</dt><dd>${Math.round(w.pct)} % der Zeit</dd><dt>Räder im Umkreis</dt><dd>${nf1.format(w.avg)} im Schnitt</dd></dl>` : ''}
      ${lineChart({ title: dens ? `Räder im Umkreis von ${Rq} m` : `Chance auf ein Rad im Umkreis von ${Rq} m`, sub: 'über den Tag', unit: dens ? '' : '%', yMax: dens ? null : 100,
        series: [{ name: wdLabel(), color: C.wd, values: vals(r.sel) }, ...(wdLabel() !== 'alle Tage' ? [{ name: 'alle Tage', color: C.muted, values: vals(r.all) }] : [])],
        band: [winMin().t0, winMin().t1] })}
      <div class="actions"><button class="btn sm ghost" data-act="clearpoint">Auswahl aufheben</button></div>`, { keepSel: true, quiet });
  }

  async function stationQuery(uid, quiet, target = '#detailA') {
    if (target === '#detailA') S.sel = { type: 'station', uid };
    await ensureIndex();
    const { dates } = filterDates();
    const k = S.f.k;
    const r = await rpc('stationProfile', { F: F(), dates, uid: String(uid), k });
    const el = target === '#detailA' ? null : $(target);
    if (!r) { if (el) el.innerHTML = '<p class="hint">Für diese Station gibt es noch keine Auswertung.</p>'; return; }
    const multi = wdLabel() !== 'alle Tage';
    const band = target === '#detailA' ? [winMin().t0, winMin().t1] : null;
    const charts = `${lineChart({ title: 'Räder im Tagesverlauf', sub: 'Durchschnitt', series: [{ name: wdLabel(), color: C.wd, values: r.sel.avg }, ...(multi ? [{ name: 'alle Tage', color: C.muted, values: r.all.avg }] : [])], band })}
      ${lineChart({ title: k ? `Chance auf höchstens ${k} ${k === 1 ? 'Rad' : 'Räder'}` : 'Chance, dass sie leer ist', unit: '%', yMax: 100, series: [{ name: wdLabel(), color: C.wd, values: r.sel.p }, ...(multi ? [{ name: 'alle Tage', color: C.muted, values: r.all.p }] : [])], band })}
      <p class="hint">${wdLabel()}, ${rangeLabel()}.</p>`;
    if (el) { el.innerHTML = charts; bindCharts(el); return; }
    if (S.sel?.type !== 'station' || S.sel.uid !== uid) return;
    const s = S.stList?.find((x) => x.uid === uid);
    showDetail('#detailA', `
      <p class="kicker"><span class="dot" style="background:${C.station}"></span>Station</p>
      <h3>${esc(r.name)}</h3>
      ${s && s.p != null ? `<p class="hint">${wdLabel()}, ${winLabel()}: im Schnitt ${nf1.format(s.avg)} Räder, ${Math.round(s.p)} % der Zeit ${k ? `höchstens ${k}` : 'leer'}.</p>` : ''}
      ${charts}`, { keepSel: true, quiet });
    select({ type: 'Point', coordinates: [r.lng, r.lat] });
    if (!quiet) flyTo([r.lng, r.lat], 14);
  }

  // ---- idle time on a continuous scale, minutes to days
  const IDLE_TICKS = [[3600, '1 Std.'], [6 * 3600, '6 Std.'], [86400, '1 Tag'], [3 * 86400, '3 Tage']];
  const idleL = (s) => Math.min(1, Math.max(0, Math.log(Math.max(s, 600) / 600) / Math.log((14 * 86400) / 600)));
  function renderIdle() {
    if (!S.live || S.mode !== 'analyse' || S.tab !== 'standzeit') return;
    const t = now();
    const kindOk = (b) => S.f.kind === 'all' || (S.f.kind === 'free' ? b.kind !== 'station' : b.kind === 'station');
    const all = S.live.bikes.filter((b) => b.since && kindOk(b)).map((b) => ({ b, s: Math.max(0, t - b.since) }));
    const shown = all.filter((x) => x.s >= S.f.idleMin);
    setData('idle', { type: 'FeatureCollection', features: shown.map(({ b, s }) => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [b.lng, b.lat] }, properties: { l: idleL(s), id: b.bike } })) });
    legend('Unbewegt seit', `<div class="bar" style="background:${gradient(R.idle)}"></div>
      <div class="scale log"><span style="left:0">10 Min.</span>${IDLE_TICKS.map(([s, l]) => `<span style="left:${idleL(s) * 100}%">${l}</span>`).join('')}<span style="left:100%">14 Tage</span></div>`);
    const out = $('#aOut'); if (!out) return;
    if (!all.length) { out.innerHTML = '<div class="empty">Keine Standzeiten verfügbar.</div>'; return; }
    const censored = all.filter((x) => x.b.since_censored).length;
    const longest = shown.slice().sort((a, b) => b.s - a.s).slice(0, 20);
    out.innerHTML = `${survivalChart(all.map((x) => x.s))}
      ${censored > all.length * 0.3 ? `<p class="basis warn">Die Aufzeichnung läuft erst seit kurzem. ${nf.format(censored)} Räder stehen seit Beginn unbewegt; ihre echte Standzeit ist länger.</p>` : ''}
      <h2 class="spaced">Am längsten unbewegt</h2><ul class="rows">${longest.map(({ b, s }) => {
        const st = b.kind === 'station' ? S.live.stById.get(String(b.place_uid)) : null;
        return `<li><button class="rowbtn" data-act="bike" data-id="${esc(b.bike)}"><span class="dot" style="background:${R.idle[Math.round(idleL(s) * 4)]}"></span>
          <span class="main"><b>Rad ${esc(b.bike)}</b><small>${st ? esc(st.name) : 'frei abgestellt'}</small></span>
          <span class="val">${b.since_censored ? 'mind. ' : ''}${fmtDur(s)}</span></button></li>`;
      }).join('')}</ul>`;
    bindCharts(out);
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
    return `<div class="chart" data-chart="${id}"><div class="chart-title"><h2>Wie lange stehen die Räder schon?</h2><span>${nf.format(n)} Räder</span></div>
      <p class="hint chart-note">Anteil der Räder, die mindestens so lange unbewegt sind</p>
      <svg viewBox="0 0 ${CW} ${H}" role="img" aria-label="Verteilung der Standzeiten"><g class="grid">${grid}</g><g class="axis">${ylab}${xlab}</g>
      <path d="${d}" fill="none" stroke="${R.idle[3]}" stroke-width="2" stroke-linejoin="round"/>
      <line class="xh" x1="0" x2="0" y1="${T}" y2="${T + h}" stroke="${C.muted}" stroke-width="1" visibility="hidden"/>
      <rect class="hit" x="${L}" y="${T}" width="${w}" height="${h}"/></svg></div>`;
  }

  // ---- time window: one slider, two handles, never crossing, at least 15 min
  function setWindow(a, b, delay = 180) {
    a = Math.max(0, Math.min(95, Math.round(a))); b = Math.max(a + 1, Math.min(96, Math.round(b)));
    if (a === S.f.a && b === S.f.b) return;
    S.f.a = a; S.f.b = b;
    stopWindowPlay(); syncFilterUI(); saveFilter(); scheduleCompute(delay);
    $$('#filters [data-win]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.win === `${a},${b}`)));
  }
  function setupDual() {
    const el = $('#wDual'), A = $('#wA'), B = $('#wB');
    const geo = () => { const r = el.getBoundingClientRect(); return { x0: r.left + 12, w: Math.max(1, r.width - 24) }; };
    const pos = (x) => { const g = geo(); return ((x - g.x0) / g.w) * 96; };
    let drag = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      const u = pos(e.clientX), { a, b } = S.f, px = geo().w / 96;
      const da = Math.abs(u - a) * px, db = Math.abs(u - b) * px;
      // narrow window (thinner than a finger): pressing on it moves it, pressing
      // beside it pulls the nearer edge there. Wide window: the ends are handles,
      // the middle moves the whole window.
      let mode;
      const wpx = (b - a) * px;
      if (wpx < 34 && !wholeDay()) mode = u >= a - 8 / px && u <= b + 8 / px ? 'move' : u < a ? 'a' : 'b';
      else if (da <= 16 && da <= db) mode = 'a';
      else if (db <= 16) mode = 'b';
      else if (u > a && u < b && !wholeDay()) mode = 'move';
      else if (u > a && u < b) mode = u - a < b - u ? 'a' : 'b';
      else mode = u < a ? 'a' : 'b';
      drag = { mode, u0: u, a0: a, b0: b, id: e.pointerId };
      try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      el.classList.add('dragging');
      (mode === 'b' ? B : A).focus({ preventScroll: true });
      if (mode !== 'move') moveTo(e.clientX);
      e.preventDefault();
    });
    const moveTo = (x) => {
      const u = pos(x);
      if (drag.mode === 'a') setWindow(Math.min(Math.round(u), S.f.b - 1), S.f.b);
      else if (drag.mode === 'b') setWindow(S.f.a, Math.max(Math.round(u), S.f.a + 1));
      else {
        const w = drag.b0 - drag.a0, a = Math.max(0, Math.min(96 - w, drag.a0 + Math.round(u - drag.u0)));
        setWindow(a, a + w);
      }
    };
    el.addEventListener('pointermove', (e) => { if (drag && e.pointerId === drag.id) moveTo(e.clientX); });
    const end = (e) => { if (drag && e.pointerId === drag.id) { drag = null; el.classList.remove('dragging'); } };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    // keyboard (arrow keys on the focused handle): same rules
    A.addEventListener('input', () => { setWindow(Math.min(+A.value, S.f.b - 1), S.f.b); A.value = S.f.a; });
    B.addEventListener('input', () => { setWindow(S.f.a, Math.max(+B.value, S.f.a + 1)); B.value = S.f.b; });
  }

  // ---- filter inputs
  let wTimer = 0;
  function stopWindowPlay() { S.wPlaying = false; clearInterval(wTimer); $('#wPlay').classList.remove('on'); }
  function startWindowPlay() {
    S.wPlaying = true; $('#wPlay').classList.add('on');
    clearInterval(wTimer);
    if (wholeDay()) { S.f.a = 0; S.f.b = 4; syncFilterUI(); scheduleCompute(0); }
    wTimer = setInterval(() => {
      const w = S.f.b - S.f.a;
      // one hour forward; at the end of the day start again at 00:00
      if (S.f.b >= 96) S.f.a = 0; else S.f.a = Math.min(S.f.a + 4, 96 - w);
      S.f.b = S.f.a + w;
      syncFilterUI(); saveFilter(); scheduleCompute(0);
    }, 1600);
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
        scheduleCompute(200);
      });
    });
    $('#p-idle')?.addEventListener('input', (e) => {
      S.f.idleMin = IDLE_STEPS[+e.target.value];
      $('#p-idle-o').textContent = idleLabel(S.f.idleMin);
      saveFilter(); renderIdle();
    });
    root.querySelectorAll('[data-seg]').forEach((sg) => sg.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      const k = sg.dataset.seg, v = b.dataset.v;
      S.f[k] = (k === 'range' && v !== 'all') || k === 'res' || k === 'R' ? +v : v;
      saveFilter();
      if (k === 'reachMetric' || k === 'R') { const y = $('#scroll').scrollTop; enterAnalysis().then(() => { $('#scroll').scrollTop = y; }); return; }
      sg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
      if (k === 'range') { const { from, to } = filterDates(); $('#fFrom').value = from; $('#fTo').value = to; }
      syncFilterUI();
      if (S.tab === 'standzeit') renderIdle(); else scheduleCompute(0);
    }));
    for (const id of ['#fFrom', '#fTo']) $(id)?.addEventListener('change', () => {
      S.f.range = 'custom'; S.f.from = $('#fFrom').value; S.f.to = $('#fTo').value;
      root.querySelectorAll('[data-seg="range"] button').forEach((x) => x.setAttribute('aria-checked', 'false'));
      syncFilterUI(); saveFilter(); scheduleCompute(0);
    });
    root.querySelectorAll('[data-wd]').forEach((b) => b.addEventListener('click', () => {
      const i = +b.dataset.wd; S.f.wd[i] = S.f.wd[i] ? 0 : 1;
      b.setAttribute('aria-pressed', String(!!S.f.wd[i]));
      syncFilterUI(); saveFilter(); scheduleCompute(250);
    }));
    root.querySelectorAll('[data-wdp]').forEach((b) => b.addEventListener('click', () => {
      S.f.wd = b.dataset.wdp.split('').map(Number);
      root.querySelectorAll('[data-wd]').forEach((x) => x.setAttribute('aria-pressed', String(!!S.f.wd[+x.dataset.wd])));
      syncFilterUI(); saveFilter(); scheduleCompute(0);
    }));
    root.querySelectorAll('[data-win]').forEach((b) => b.addEventListener('click', () => {
      const [a, c] = b.dataset.win.split(',').map(Number);
      setWindow(a, c, 0);
    }));
  }

  // ================================================================ detail card
  function showDetail(sel, html, opts = {}) {
    const el = $(sel);
    el.innerHTML = `<button class="x" type="button" aria-label="Schließen" data-act="close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>${html}`;
    el.hidden = false;
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
    S.sel = null;
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
    $$('.modes button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
    $$('#aTabs button').forEach((b) => b.addEventListener('click', () => {
      S.tab = b.dataset.tab; closeDetail(true); setData('qpt', EMPTY); updateHash(); enterAnalysis();
      b.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: REDUCED ? 'auto' : 'smooth' });
    }));
    $$('#layers .chip').forEach((c) => c.addEventListener('click', () => {
      const k = c.dataset.layer, on = !S.layers[k];
      S.layers[k] = on;
      c.classList.toggle('on', on); c.setAttribute('aria-pressed', String(on));
      applyVisibility(); renderKarte();
    }));
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
    $('#btnHome').addEventListener('click', () => map.fitBounds(KOELN, { padding: isDesktop() ? { left: 440, top: 40, right: 40, bottom: 40 } : { top: 40, left: 20, right: 20, bottom: sheetVisibleHeight() + 10 }, duration: REDUCED ? 0 : 600 }));
    $('#repoLink').href = S.cfg?.repo || '#';
    const tabs = $('#aTabs');
    const tabEnd = () => tabs.classList.toggle('at-end', tabs.scrollLeft + tabs.clientWidth >= tabs.scrollWidth - 4);
    tabs.addEventListener('scroll', tabEnd, { passive: true }); addEventListener('resize', tabEnd); setTimeout(tabEnd, 500);
    $('#scroll').addEventListener('scroll', (e) => e.target.classList.toggle('scrolled', e.target.scrollTop > 2), { passive: true });

    // timeline
    $('#tlRange').addEventListener('input', (e) => { stopPlay(); setFrame(+e.target.value); });
    $('#tlPlay').addEventListener('click', () => (S.k.playing ? stopPlay() : startPlay()));
    $('#tlLive').addEventListener('click', goLive);
    $('#tlSpeed').addEventListener('click', () => {
      S.k.speed = S.k.speed === 1 ? 2 : S.k.speed === 2 ? 4 : 1;
      $('#tlSpeed').textContent = `${S.k.speed}×`;
    });
    $$('#tlSpan button').forEach((b) => b.addEventListener('click', () => {
      S.k.span = +b.dataset.h;
      $$('#tlSpan button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
      reloadTimeline();
    }));
    $('#tlEnd').addEventListener('change', (e) => { S.k.end = e.target.value || null; reloadTimeline(); });
    addEventListener('keydown', (e) => {
      if (S.mode !== 'karte' || !S.tl) return;
      const ae = document.activeElement;
      if (/input|textarea|select/i.test(ae?.tagName) && ae.type !== 'range') return;
      if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && ae?.id !== 'tlRange') {
        const r = $('#tlRange');
        const cur = S.k.isLive ? +r.max : S.k.frame;
        const nx = Math.min(Math.max(cur + (e.key === 'ArrowRight' ? 1 : -1), +r.min), +r.max);
        r.value = nx; stopPlay(); setFrame(nx); e.preventDefault();
      } else if (e.key === ' ' && ae === document.body) { if (S.k.playing) stopPlay(); else startPlay(); e.preventDefault(); }
    });

    // analysis time window
    setupDual();
    $('#wPlay').addEventListener('click', () => (S.wPlaying ? stopWindowPlay() : startWindowPlay()));

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
      else if (a === 'bike') { if (S.mode === 'karte' && !S.k.isLive) goLive(); showBike(id); }
      else if (a === 'station') showStation(id);
      else if (a === 'trail') showTrailFor(id);
      else if (a === 'tlbike') { const i = S.tl.bikeIndex.get(id); if (i != null) showTlBike(i); }
      else if (a === 'livebike') { goLive(); showBike(id); }
      else if (a === 'cleartrail') { S.trail = null; setData('trail', EMPTY); applyVisibility(); closeDetail(); }
      else if (a === 'frame') { const i = nearestFrame(+el.dataset.t); $('#tlRange').value = i; setFrame(i); }
      else if (a === 'stq') stationQuery(id);
      else if (a === 'pointme' && S.me) {
        S.tab = 'erreichbarkeit';
        if (S.mode !== 'analyse') setMode('analyse'); else enterAnalysis();
        setTimeout(() => { pointQuery(S.me[0], S.me[1]); flyTo(S.me, 14.5); }, 60);
      }
      else if (a === 'clearpoint') { S.sel = null; setData('qpt', EMPTY); applyVisibility(); closeDetail(); }
      else if (a === 'widen') {
        const w = el.dataset.w;
        if (w === 'day') { S.f.a = 0; S.f.b = 96; stopWindowPlay(); }
        else if (w === 'wd') S.f.wd = [1, 1, 1, 1, 1, 1, 1];
        else if (w === 'range') S.f.range = 'all';
        saveFilter(); enterAnalysis();
      }
    });
    $('#near').addEventListener('click', (e) => { if (e.target.id === 'btnNear2') locate(false); });

    addEventListener('hashchange', () => { const m = S.mode, t = S.tab; readHash(); if (m !== S.mode) setMode(S.mode); else if (t !== S.tab) enterAnalysis(); });
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
    $('#fresh').addEventListener('click', () => checkUpdate(true));
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => location.reload());
  }

  // ================================================================ boot
  let booted = false, liveReady;
  async function boot() {
    if (booted) return; booted = true;
    await liveReady;
    const bb = S.live?.meta?.bounds;
    const view = bb ? [[bb[1], bb[0]], [bb[3], bb[2]]] : KOELN;
    setMode(S.mode, { sheet: 'peek' });
    requestAnimationFrame(() => map.fitBounds(view, { duration: 0, padding: isDesktop()
      ? { left: 440, top: 30, right: 30, bottom: 30 } : { top: 20, left: 12, right: 12, bottom: sheetVisibleHeight() + 8 } }));
    reloadTimeline();
  }

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
  window.__app = S; Object.defineProperty(window, '__map', { get: () => map });
  window.__ui = { setMode, setSheet, showStation, showBike, pointQuery, stationQuery, flyTo, setFrame, startPlay, stopPlay, goLive };
  start();
})();
