/* Analysis worker: loads per-day history files (tl/YYYY-MM-DD.json) and
   computes every analysis with freely chosen parameters, off the main thread.

   Filter F = { from, to: 'YYYY-MM-DD', wd: [7 booleans, Mo..So],
                t0, t1: minutes of day, t0 < t1 (t0 === t1 = whole day),
                kind: 'all' | 'free' | 'station' } */
'use strict';

const TZ = 'Europe/Berlin';
const BBOX = { s: 50.83, n: 51.09, w: 6.76, e: 7.18 };
const M_LAT = 111320;
const COS = Math.cos(((BBOX.s + BBOX.n) / 2) * Math.PI / 180);
const M_LNG = M_LAT * COS;

let BASE = './';
let VER = '';                    // data version (tl/index.json "generated"), busts the HTTP cache
const DAYS = new Map();          // date -> decoded day
const G = { bikeIdx: new Map(), bikeIds: [], stIdx: new Map(), st: [] };
const pollInfo = new Map();      // t -> { wd 0..6 (Mo..So), min }

const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const WD = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
function info(t) {
  let v = pollInfo.get(t);
  if (!v) {
    const p = fmt.formatToParts(new Date(t * 1000));
    const get = (k) => p.find((x) => x.type === k).value;
    v = { wd: WD[get('weekday')], min: (+get('hour') % 24) * 60 + +get('minute') };
    pollInfo.set(t, v);
  }
  return v;
}
const inWindow = (min, t0, t1) => (t0 === t1 ? true : t0 < t1 ? min >= t0 && min < t1 : min >= t0 || min < t1);

// ------------------------------------------------------------------ loading
async function loadDay(date) {
  if (DAYS.has(date)) return DAYS.get(date);
  const r = await fetch(`${BASE}tl/${date}.json?v=${encodeURIComponent(VER || Math.floor(Date.now() / 600000))}`);
  if (!r.ok) throw new Error(`tl/${date}.json: ${r.status}`);
  const d = await r.json();
  const bmap = d.bikes.map((id) => {
    let g = G.bikeIdx.get(id);
    if (g == null) { g = G.bikeIds.length; G.bikeIdx.set(id, g); G.bikeIds.push(id); }
    return g;
  });
  const smap = d.stations.map(([uid, name, lat, lng]) => {
    let g = G.stIdx.get(uid);
    if (g == null) { g = G.st.length; G.stIdx.set(uid, g); G.st.push({ uid, name, lat, lng }); }
    else { const s = G.st[g]; s.name = name; s.lat = lat; s.lng = lng; }
    return g;
  });
  const frames = d.frames.map((f) => {
    const a = new Int32Array(f.length);
    for (let k = 0; k < f.length; k += 4) { a[k] = bmap[f[k]]; a[k + 1] = f[k + 1]; a[k + 2] = f[k + 2]; a[k + 3] = f[k + 3] >= 0 ? smap[f[k + 3]] : -1; }
    return a;
  });
  const gone = d.gone.map((g) => Int32Array.from(g, (b) => bmap[b]));
  const day = { date, t: d.t, frames, gone, stations: new Set(smap), lat0: d.lat0, lng0: d.lng0, scale: d.scale };
  DAYS.set(date, day);
  for (const t of d.t) info(t);
  return day;
}

function datesIn(F, index) {
  return index.filter((d) => d.date >= F.from && d.date <= F.to).map((d) => d.date);
}

// Replay polls of the given dates in order. cb(t, S, day) gets the state:
// S.p (present), S.lat/S.lng (float), S.pl (global station or -1), S.n
function replay(dates, cb) {
  const N = G.bikeIds.length;
  const S = { p: new Uint8Array(N), la: new Int32Array(N), lo: new Int32Array(N), pl: new Int32Array(N).fill(-1),
    lat: new Float64Array(N), lng: new Float64Array(N), n: N };
  for (const date of dates.slice().sort()) {
    const day = DAYS.get(date);
    if (!day) continue;
    S.p.fill(0);  // every day file starts with a full snapshot
    for (let i = 0; i < day.t.length; i++) {
      const f = day.frames[i];
      for (let k = 0; k < f.length; k += 4) {
        const b = f[k];
        S.p[b] = 1; S.la[b] = f[k + 1]; S.lo[b] = f[k + 2]; S.pl[b] = f[k + 3];
        S.lat[b] = day.lat0 + f[k + 1] / day.scale; S.lng[b] = day.lng0 + f[k + 2] / day.scale;
      }
      for (const b of day.gone[i]) S.p[b] = 0;
      cb(day.t[i], S, day);
    }
  }
}

// polls in the filter (date range, weekdays, time window) and how many days they span
function pollStats(F, dates) {
  let polls = 0;
  const days = new Set();
  for (const d of dates) { const day = DAYS.get(d); if (day) for (const t of day.t) if (matches(F, t)) { polls++; days.add(d); } }
  return { polls, days: days.size };
}

// polls per 15-minute slot of the day (date range + weekdays, ignoring the
// time window), so the UI can show where data exists before you pick a window
function coverage({ F, dates }) {
  const bins = new Uint16Array(96);
  const dayBins = Array.from({ length: 96 }, () => new Set());
  for (const d of dates) {
    const day = DAYS.get(d); if (!day) continue;
    for (const t of day.t) { const p = info(t); if (!F.wd[p.wd]) continue; const b = Math.floor(p.min / 15); bins[b]++; dayBins[b].add(d); }
  }
  return { bins: Array.from(bins), binDays: dayBins.map((s) => s.size), ...pollStats(F, dates) };
}

const kindOk = (kind, pl) => kind === 'all' || (kind === 'free' ? pl < 0 : pl >= 0);
const matches = (F, t) => { const p = info(t); return F.wd[p.wd] && inWindow(p.min, F.t0, F.t1); };

// ------------------------------------------------------------------ rasters
function grid(res, bb = BBOX) {
  const W = Math.ceil(((bb.e - bb.w) * M_LNG) / res), H = Math.ceil(((bb.n - bb.s) * M_LAT) / res);
  return { W, H, res, dlng: res / M_LNG, dlat: res / M_LAT, bb };
}
// where bikes actually are in the loaded days, plus ~1.2 km margin
let activeBB = { key: '', bb: BBOX };
function activeBBox(dates) {
  const key = dates.join(',');
  if (activeBB.key === key) return activeBB.bb;
  const lats = [], lngs = [];
  for (const d of dates) {
    const day = DAYS.get(d); if (!day) continue;
    const f = day.frames[0];
    for (let k = 0; k < f.length; k += 4) { lats.push(day.lat0 + f[k + 1] / day.scale); lngs.push(day.lng0 + f[k + 2] / day.scale); }
  }
  if (lats.length < 10) return BBOX;
  lats.sort((a, b) => a - b); lngs.sort((a, b) => a - b);
  const q = (a, f) => a[Math.floor((a.length - 1) * f)];
  const m = 1200;
  const bb = { s: Math.max(BBOX.s, q(lats, 0.002) - m / M_LAT), n: Math.min(BBOX.n, q(lats, 0.998) + m / M_LAT),
    w: Math.max(BBOX.w, q(lngs, 0.002) - m / M_LNG), e: Math.min(BBOX.e, q(lngs, 0.998) + m / M_LNG) };
  activeBB = { key, bb };
  return bb;
}
const cellOf = (g, lat, lng) => {
  const x = Math.floor((lng - g.bb.w) / g.dlng), y = Math.floor((lat - g.bb.s) / g.dlat);
  return x < 0 || y < 0 || x >= g.W || y >= g.H ? -1 : y * g.W + x;
};

function colorize(g, vals, vmax, stops, zeroTransparent) {
  const out = new Uint8ClampedArray(g.W * g.H * 4);
  for (let y = 0; y < g.H; y++) {
    const row = (g.H - 1 - y) * g.W; // image row 0 = north
    for (let x = 0; x < g.W; x++) {
      const v = vals[y * g.W + x];
      const o = (row + x) * 4;
      if (v < 0 || (zeroTransparent && v <= 0)) continue;
      const f = Math.min(1, v / vmax);
      let k = 1; while (k < stops.length - 1 && stops[k][0] < f) k++;
      const a = stops[k - 1], b = stops[k], u = (f - a[0]) / Math.max(1e-9, b[0] - a[0]);
      out[o] = a[1] + (b[1] - a[1]) * u; out[o + 1] = a[2] + (b[2] - a[2]) * u;
      out[o + 2] = a[3] + (b[3] - a[3]) * u; out[o + 3] = 255 * (a[4] + (b[4] - a[4]) * u);
    }
  }
  return out;
}

function blur(g, src, sigmaCells) {
  if (sigmaCells < 0.3) return src;
  const r = Math.ceil(sigmaCells * 3), ker = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) { ker[i + r] = Math.exp(-(i * i) / (2 * sigmaCells * sigmaCells)); sum += ker[i + r]; }
  for (let i = 0; i < ker.length; i++) ker[i] /= sum;
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  for (let y = 0; y < g.H; y++) for (let x = 0; x < g.W; x++) {
    let a = 0; for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < g.W) a += src[y * g.W + xx] * ker[k + r]; }
    tmp[y * g.W + x] = a;
  }
  for (let y = 0; y < g.H; y++) for (let x = 0; x < g.W; x++) {
    let a = 0; for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < g.H) a += tmp[yy * g.W + x] * ker[k + r]; }
    out[y * g.W + x] = a;
  }
  return out;
}

// P(at least one bike within R) for every raster cell
function avail({ F, dates, R, res: want, stops }) {
  // keep the work bounded: coarser raster for wide radii over many polls
  let nPolls = 0;
  for (const d of dates) { const day = DAYS.get(d); if (day) for (const t of day.t) if (matches(F, t)) nPolls++; }
  let res = want;
  for (const r of [want, 150, 200, 300, 400, 500]) {
    if (r < want) continue;
    res = r;
    if (nPolls * 1800 * Math.PI * (R / r) ** 2 <= 2.5e8) break;
  }
  const g = grid(res);
  const NC = g.W * g.H;
  const count = new Uint16Array(NC), stamp = new Int32Array(NC).fill(-1), sstamp = new Int32Array(NC).fill(-1);
  const kr = Math.ceil(R / res);
  const off = [];
  for (let dy = -kr; dy <= kr; dy++) for (let dx = -kr; dx <= kr; dx++) if ((dx * res) ** 2 + (dy * res) ** 2 <= R * R) off.push(dx, dy);
  let polls = 0;
  const seenDays = new Set();
  const src = new Int32Array(G.bikeIds.length);
  replay(dates, (t, S, day) => {
    if (!matches(F, t)) return;
    polls++; seenDays.add(day.date);
    let ns = 0;
    for (let b = 0; b < S.n; b++) {
      if (!S.p[b] || !kindOk(F.kind, S.pl[b])) continue;
      const c = cellOf(g, S.lat[b], S.lng[b]);
      if (c >= 0 && sstamp[c] !== polls) { sstamp[c] = polls; src[ns++] = c; }
    }
    for (let s = 0; s < ns; s++) {
      const c = src[s], cx = c % g.W, cy = (c - cx) / g.W;
      for (let k = 0; k < off.length; k += 2) {
        const x = cx + off[k], y = cy + off[k + 1];
        if (x < 0 || y < 0 || x >= g.W || y >= g.H) continue;
        const i = y * g.W + x;
        if (stamp[i] !== polls) { stamp[i] = polls; count[i]++; }
      }
    }
  });
  const pct = new Float32Array(NC);
  for (let i = 0; i < NC; i++) pct[i] = polls ? (count[i] * 100) / polls : 0;
  // light smoothing for display only, so disc edges do not show raster steps
  const shown = blur(g, pct, Math.max(0.6, 60 / res));
  for (let i = 0; i < NC; i++) if (shown[i] < 0.5) shown[i] = 0;
  const rgba = colorize(g, shown, 100, stops, true);
  return { w: g.W, h: g.H, bbox: gbox(g), rgba, polls, days: seenDays.size, res, auto: res !== want, vals: pct };
}

// average bikes per cell, smoothed (kernel density)
function density({ F, dates, res, smooth, stops }) {
  const g = grid(res, activeBBox(dates));
  const NC = g.W * g.H, sum = new Float32Array(NC);
  let polls = 0;
  const seenDays = new Set();
  replay(dates, (t, S, day) => {
    if (!matches(F, t)) return;
    polls++; seenDays.add(day.date);
    for (let b = 0; b < S.n; b++) {
      if (!S.p[b] || !kindOk(F.kind, S.pl[b])) continue;
      const c = cellOf(g, S.lat[b], S.lng[b]);
      if (c >= 0) sum[c] += 1;
    }
  });
  for (let i = 0; i < NC; i++) sum[i] = polls ? sum[i] / polls : 0;
  const sm = blur(g, sum, smooth / res);
  // per hectare, so the legend does not depend on the resolution
  const ha = 10000 / (res * res);
  const vals = new Float32Array(NC);
  let max = 0;
  for (let i = 0; i < NC; i++) { vals[i] = sm[i] * ha; if (vals[i] > max) max = vals[i]; }
  const sorted = Array.from(vals).filter((v) => v > 0.001).sort((a, b) => a - b);
  const vmax = sorted.length ? sorted[Math.floor(sorted.length * 0.995)] : 1;
  const rgba = colorize(g, vals, vmax || 1, stops, true);
  for (let i = 0; i < NC; i++) if (vals[i] < vmax * 0.02) rgba[(((g.H - 1 - Math.floor(i / g.W)) * g.W) + (i % g.W)) * 4 + 3] = 0;
  return { w: g.W, h: g.H, bbox: gbox(g), rgba, polls, days: seenDays.size, res, vmax, vals };
}

// exact profile for one location: chance / average count within R per 15 min
function point({ F, dates, lat, lng, R }) {
  const sel = { n: new Uint32Array(96), hit: new Uint32Array(96), sum: new Float64Array(96) };
  const all = { n: new Uint32Array(96), hit: new Uint32Array(96), sum: new Float64Array(96) };
  const dLat = R / M_LAT, dLng = R / M_LNG, R2 = R * R;
  let nearest = [];
  replay(dates, (t, S) => {
    const p = info(t), bin = Math.floor(p.min / 15);
    let c = 0, best = Infinity;
    for (let b = 0; b < S.n; b++) {
      if (!S.p[b] || !kindOk(F.kind, S.pl[b])) continue;
      const dy = S.lat[b] - lat, dx = S.lng[b] - lng;
      if (Math.abs(dy) > dLat * 4 || Math.abs(dx) > dLng * 4) continue;
      const d2 = (dy * M_LAT) ** 2 + (dx * M_LNG) ** 2;
      if (d2 <= R2) c++;
      if (d2 < best) best = d2;
    }
    all.n[bin]++; all.sum[bin] += c; if (c) all.hit[bin]++;
    if (F.wd[p.wd]) {
      sel.n[bin]++; sel.sum[bin] += c; if (c) sel.hit[bin]++;
      if (inWindow(p.min, F.t0, F.t1)) nearest.push(Math.sqrt(best));
    }
  });
  const fin = (o) => ({ pct: Array.from(o.n, (n, i) => (n ? (o.hit[i] * 100) / n : null)), avg: Array.from(o.n, (n, i) => (n ? o.sum[i] / n : null)), n: Array.from(o.n) });
  // value for the chosen time window
  let wn = 0, wh = 0, ws = 0;
  for (let i = 0; i < 96; i++) if (inWindow(i * 15, F.t0, F.t1) || (F.t0 !== F.t1 && inWindow(i * 15 + 14, F.t0, F.t1))) { wn += sel.n[i]; wh += sel.hit[i]; ws += sel.sum[i]; }
  nearest = nearest.filter(Number.isFinite).sort((a, b) => a - b);
  return { sel: fin(sel), all: fin(all), win: wn ? { pct: (wh * 100) / wn, avg: ws / wn, n: wn } : null,
    nearestMedian: nearest.length ? nearest[Math.floor(nearest.length / 2)] : null };
}

// ------------------------------------------------------------------ stations
function stations({ F, dates, k }) {
  const NS = G.st.length, cnt = new Int32Array(NS);
  const n = new Uint32Array(NS), e = new Uint32Array(NS), sum = new Float64Array(NS);
  let polls = 0;
  replay(dates, (t, S, day) => {
    if (!matches(F, t)) return;
    polls++;
    cnt.fill(0);
    for (let b = 0; b < S.n; b++) if (S.p[b] && S.pl[b] >= 0) cnt[S.pl[b]]++;
    for (const j of day.stations) { n[j]++; sum[j] += cnt[j]; if (cnt[j] <= k) e[j]++; }
  });
  return { polls, days: pollStats(F, dates).days, list: G.st.map((s, j) => ({ j, uid: s.uid, name: s.name, lat: s.lat, lng: s.lng,
    p: n[j] ? (e[j] * 100) / n[j] : null, avg: n[j] ? sum[j] / n[j] : null, n: n[j] })) };
}

function stationProfile({ F, dates, uid, k }) {
  const j = G.stIdx.get(uid);
  const mk = () => ({ n: new Uint32Array(24), e: new Uint32Array(24), sum: new Float64Array(24) });
  const sel = mk(), all = mk();
  if (j == null) return null;
  replay(dates, (t, S, day) => {
    if (!day.stations.has(j)) return;
    const p = info(t), h = Math.floor(p.min / 60);
    let c = 0;
    for (let b = 0; b < S.n; b++) if (S.p[b] && S.pl[b] === j) c++;
    for (const o of F.wd[p.wd] ? [sel, all] : [all]) { o.n[h]++; o.sum[h] += c; if (c <= k) o.e[h]++; }
  });
  const fin = (o) => ({ avg: Array.from(o.n, (n, i) => (n ? o.sum[i] / n : null)), p: Array.from(o.n, (n, i) => (n ? (o.e[i] * 100) / n : null)) });
  return { name: G.st[j].name, lat: G.st[j].lat, lng: G.st[j].lng, sel: fin(sel), all: fin(all) };
}

// ------------------------------------------------------------------ trips
// one trip = TS numbers: start, end, lat0, lng0, lat1, lng1, distance, short (1 = jump
// between two polls, no absence), bike index, start station, end station (-1 = free)
const TS = 11;
let tripCache = { key: '', res: null };
function inferTrips(dates, P) {
  const key = `${dates.join(',')}|${P.minGone}|${P.jump}|${P.maxDur}`;
  if (tripCache.key === key) return tripCache.res;
  const N = G.bikeIds.length;
  const prevP = new Uint8Array(N), prevLat = new Float64Array(N), prevLng = new Float64Array(N);
  const oT0 = new Float64Array(N), oT1 = new Float64Array(N), oLat = new Float64Array(N), oLng = new Float64Array(N), open = new Uint8Array(N);
  const prevSt = new Int32Array(N).fill(-1), oSt = new Int32Array(N).fill(-1);
  const trips = [];
  const pollT = [], pollTotal = [];
  let prevT = null, service = 0, round = 0, unclear = 0;
  // when two polls are far apart (missed runs) we cannot say when a trip
  // happened; such trips are left out instead of being piled into the gap
  const MAX_GAP = 3600;
  const dist = (a, b, c, d) => Math.hypot((c - a) * M_LAT, (d - b) * M_LNG);
  replay(dates, (t, S) => {
    let total = 0;
    for (let b = 0; b < S.n; b++) {
      const now = S.p[b];
      if (now) total++;
      if (prevT != null) {
        const was = prevP[b];
        if (was && now) {
          const d = dist(prevLat[b], prevLng[b], S.lat[b], S.lng[b]);
          if (d > P.jump) { if (t - prevT > MAX_GAP) unclear++; else trips.push(prevT, t, prevLat[b], prevLng[b], S.lat[b], S.lng[b], d, 1, b, prevSt[b], S.pl[b]); }
        } else if (was && !now) {
          open[b] = 1; oT0[b] = prevT; oT1[b] = t; oLat[b] = prevLat[b]; oLng[b] = prevLng[b]; oSt[b] = prevSt[b];
        } else if (!was && now && open[b]) {
          open[b] = 0;
          const st = (oT0[b] + oT1[b]) / 2, en = (prevT + t) / 2, d = dist(oLat[b], oLng[b], S.lat[b], S.lng[b]);
          if (en - st > P.maxDur) service++;
          else if (oT1[b] - oT0[b] > MAX_GAP || t - prevT > MAX_GAP) unclear++;
          else if (d < P.minGone) round++;
          else trips.push(st, en, oLat[b], oLng[b], S.lat[b], S.lng[b], d, 0, b, oSt[b], S.pl[b]);
        }
      }
      prevP[b] = now;
      if (now) { prevLat[b] = S.lat[b]; prevLng[b] = S.lng[b]; prevSt[b] = S.pl[b]; }
    }
    pollT.push(t); pollTotal.push(total);
    prevT = t;
  });
  // bikes in use = long trips in progress (+ open absences younger than maxDur)
  const starts = [], ends = [];
  for (let i = 0; i < trips.length; i += TS) if (!trips[i + 7]) { starts.push(trips[i]); ends.push(trips[i + 1]); }
  const last = pollT[pollT.length - 1];
  const openNow = []; // bikes away right now: [bike, since, lat, lng, station]
  for (let b = 0; b < N; b++) if (open[b] && last - (oT0[b] + oT1[b]) / 2 <= P.maxDur) {
    starts.push((oT0[b] + oT1[b]) / 2);
    openNow.push(b, (oT0[b] + oT1[b]) / 2, oLat[b], oLng[b], oSt[b]);
  }
  starts.sort((a, b) => a - b); ends.sort((a, b) => a - b);
  const inuse = new Int32Array(pollT.length);
  let si = 0, ei = 0;
  for (let k = 0; k < pollT.length; k++) {
    const t = pollT[k];
    while (si < starts.length && starts[si] < t) si++;
    while (ei < ends.length && ends[ei] <= t) ei++;
    inuse[k] = Math.max(0, si - ei);
  }
  const res = { trips: Float64Array.from(trips), pollT, pollTotal, inuse, service, round, unclear, openNow };
  tripCache = { key, res };
  return res;
}

const tripStart = (tr, i) => (tr[i + 7] ? (tr[i] + tr[i + 1]) / 2 : tr[i]);

function usage({ F, dates, P }) {
  const R = inferTrips(dates, P), tr = R.trips;
  const durH = new Uint32Array(25), distH = new Uint32Array(33);
  const perHour = new Float64Array(24), hoursSeen = Array.from({ length: 24 }, () => new Set());
  const inuseH = new Float64Array(24), inuseN = new Uint32Array(24);
  const durs = [], dists = [];
  let count = 0, short = 0;
  const daysSel = new Set();
  R.pollT.forEach((t, k) => {
    const p = info(t);
    if (!F.wd[p.wd]) return;
    const h = Math.floor(p.min / 60);
    hoursSeen[h].add(Math.floor(t / 3600));
    inuseH[h] += R.inuse[k]; inuseN[h]++;
    daysSel.add(Math.floor((t + 3600) / 86400));
  });
  for (let i = 0; i < tr.length; i += TS) {
    const s = tripStart(tr, i), p = info(Math.round(s)) ;
    if (!F.wd[p.wd]) continue;
    perHour[Math.floor(p.min / 60)]++;
    if (!inWindow(p.min, F.t0, F.t1)) continue;
    count++;
    dists.push(tr[i + 6]); distH[Math.min(32, Math.floor(tr[i + 6] / 250))]++;
    if (tr[i + 7]) short++;
    else { const d = (tr[i + 1] - tr[i]) / 60; durs.push(d); durH[Math.min(24, Math.floor(d / 5))]++; }
  }
  const med = (a) => { if (!a.length) return null; a.sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
  // series, downsampled
  const step = Math.max(1, Math.ceil(R.pollT.length / 1200));
  const ser = { t: [], inuse: [], total: [] };
  for (let k = 0; k < R.pollT.length; k += step) { ser.t.push(R.pollT[k]); ser.inuse.push(R.inuse[k]); ser.total.push(R.pollTotal[k]); }
  return {
    ...pollStats(F, dates),
    count, short, service: R.service, round: R.round, unclear: R.unclear,
    perDay: daysSel.size ? count / daysSel.size : null, days: daysSel.size,
    medDur: med(durs), medDist: med(dists),
    durH: Array.from(durH), distH: Array.from(distH),
    perHour: Array.from(perHour, (v, h) => (hoursSeen[h].size ? v / hoursSeen[h].size : null)),
    inuseH: Array.from(inuseH, (v, h) => (inuseN[h] ? v / inuseN[h] : null)),
    series: ser,
  };
}

function flows({ F, dates, P, cell, top, min }) {
  const R = inferTrips(dates, P), tr = R.trips;
  const g = grid(cell);
  // per cell: starts, ends and the centroid of the real start/end points, so
  // circles and lines sit where trips actually begin and end, not on a grid
  const net = new Map(), od = new Map();
  const acc = (c, lat, lng, k) => {
    let v = net.get(c);
    if (!v) { v = [0, 0, 0, 0, 0]; net.set(c, v); }
    v[k]++; v[2] += lat; v[3] += lng; v[4]++;
  };
  let used = 0;
  for (let i = 0; i < tr.length; i += TS) {
    const s = tripStart(tr, i), p = info(Math.round(s));
    if (!F.wd[p.wd] || !inWindow(p.min, F.t0, F.t1)) continue;
    const a = cellOf(g, tr[i + 2], tr[i + 3]), b = cellOf(g, tr[i + 4], tr[i + 5]);
    if (a < 0 || b < 0) continue;
    used++;
    acc(a, tr[i + 2], tr[i + 3], 0);
    acc(b, tr[i + 4], tr[i + 5], 1);
    if (a !== b) { const k = a * 1e6 + b; od.set(k, (od.get(k) || 0) + 1); }
  }
  const center = (c) => { const v = net.get(c); return [v[3] / v[4], v[2] / v[4]]; };
  const lines = [...od.entries()].filter(([, c]) => c >= min).sort((a, b) => b[1] - a[1]).slice(0, top)
    .map(([k, c]) => { const a = Math.floor(k / 1e6), b = k % 1e6; return [...center(a), ...center(b), c]; });
  const cells = [...net.entries()].map(([c, v]) => [...center(c), v[0], v[1]]);
  return { trips: used, lines, cells, cell, ...pollStats(F, dates) };
}

function inuseSeries({ dates, P }) {
  const R = inferTrips(dates, P);
  return { t: R.pollT, inuse: Array.from(R.inuse), total: R.pollTotal };
}


// ------------------------------------------------------------------ reach
// Walking distance to the nearest bike: per poll a distance field (chamfer
// transform on the raster), accumulated as a histogram per cell. From the
// histogram we get the typical (median) distance and P(nearest <= R) for any
// R without recomputing.
const EDGES = [25, 50, 75, 100, 125, 150, 200, 250, 300, 400, 500, 600, 700, 850, 1000, 1250, 1500, 2000];
let reachCache = { key: '', g: null, hist: null, polls: 0, days: 0, sampled: 0 };

const BIN_LUT = (() => { const a = new Uint8Array(260); for (let i = 0; i < 260; i++) { let k = 0; while (k < EDGES.length && i * 10 + 5 > EDGES[k]) k++; a[i] = k; } return a; })();

// squared distance transform in cell units, in place (rows, then columns)
const INF = 1e10;
let edtBuf = null;
function edt1d(f, n, d, v, z) {
  let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    const fq = f[q] + q * q;
    let p = v[k], s = (fq - (f[p] + p * p)) / (2 * (q - p));
    while (s <= z[k]) { k--; p = v[k]; s = (fq - (f[p] + p * p)) / (2 * (q - p)); }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; const p = v[k]; d[q] = (q - p) * (q - p) + f[p]; }
}
function edt2d(a, W, H) {
  const n = Math.max(W, H);
  if (!edtBuf || edtBuf.n < n || edtBuf.W !== W) edtBuf = { n, W, f: new Float64Array(n), d: new Float64Array(n), v: new Int32Array(n), z: new Float64Array(n + 1), dy: new Float64Array(W) };
  const { f, d, v, z, dy } = edtBuf;
  // columns: the input is binary (0 = bike, INF = none), so the vertical
  // distance is just "rows since the last bike" scanned down and then up
  dy.fill(INF);
  for (let y = 0; y < H; y++) {
    const o = y * W;
    for (let x = 0; x < W; x++) { dy[x] = a[o + x] === 0 ? 0 : dy[x] + 1; a[o + x] = dy[x]; }
  }
  dy.fill(INF);
  for (let y = H - 1; y >= 0; y--) {
    const o = y * W;
    for (let x = 0; x < W; x++) {
      dy[x] = a[o + x] === 0 ? 0 : dy[x] + 1;
      const m = Math.min(a[o + x], dy[x]);
      a[o + x] = m >= INF ? INF : m * m;
    }
  }
  // rows: exact lower envelope of parabolas
  for (let y = 0; y < H; y++) {
    const o = y * W;
    for (let x = 0; x < W; x++) f[x] = a[o + x];
    edt1d(f, W, d, v, z);
    for (let x = 0; x < W; x++) a[o + x] = d[x];
  }
}

function reachCompute({ F, dates, res, maxPolls = 150 }) {
  const key = `${JSON.stringify(F)}|${dates.join(',')}|${res}|${maxPolls}`;
  if (reachCache.key === key) return reachCache;
  const g = grid(res, activeBBox(dates)), NC = g.W * g.H, NB = EDGES.length + 1;
  const hist = new Uint16Array(NC * NB);
  const dist = new Float32Array(NC);
  const CAP = 2500;
  const f2 = new Float64Array(NC);
  // which polls: all matching, evenly sampled down to maxPolls
  const match = [];
  for (const d of dates) { const day = DAYS.get(d); if (day) for (const t of day.t) if (matches(F, t)) match.push(t); }
  const step = Math.max(1, match.length / maxPolls);
  const take = new Set();
  for (let k = 0; k < match.length; k += step) take.add(match[Math.floor(k)]);
  let polls = 0;
  const seenDays = new Set();
  replay(dates, (t, S, day) => {
    if (!take.has(t)) return;
    polls++; seenDays.add(day.date);
    // exact Euclidean distance transform (Felzenszwalb & Huttenlocher), so the
    // rings around a bike are round, not octagonal
    f2.fill(INF);
    for (let b = 0; b < S.n; b++) {
      if (!S.p[b] || !kindOk(F.kind, S.pl[b])) continue;
      const c = cellOf(g, S.lat[b], S.lng[b]);
      if (c >= 0) f2[c] = 0;
    }
    edt2d(f2, g.W, g.H);
    for (let i = 0; i < NC; i++) dist[i] = Math.min(CAP, Math.sqrt(f2[i]) * res);
    const half = res / 2;
    for (let i = 0; i < NC; i++) {
      const d = dist[i] + half; // distance from the cell centre, roughly
      hist[i * NB + BIN_LUT[d >= 2590 ? 259 : (d / 10) | 0]]++;
    }
  });
  reachCache = { key, g, hist, polls, days: seenDays.size, sampled: match.length };
  return reachCache;
}

// the exact area a grid covers (W*res can be a bit wider than the requested bbox)
const gbox = (g) => ({ w: g.bb.w, s: g.bb.s, e: g.bb.w + g.W * g.dlng, n: g.bb.s + g.H * g.dlat });

// Stepped colours with round edges: the values are interpolated bilinearly onto
// a finer pixel grid (up to 4x) before classifying, so class borders follow
// smooth curves instead of the 50 m raster cells. Edge pixels are blended
// between the two neighbouring classes (2x2 supersampling) for anti-aliasing.
// classes = [[upTo, r, g, b, alpha], ...] ascending
function classifySmooth(g, vals, classes, transparentIf, maxPx = 4.2e6) {
  const f = Math.max(1, Math.min(4, Math.floor(Math.sqrt(maxPx / (g.W * g.H)))));
  const W = g.W, H = g.H, OW = W * f, OH = H * f;
  const out = new Uint8ClampedArray(OW * OH * 4);
  const at = (x, y) => {
    if (x < 0) x = 0; else if (x > W - 1) x = W - 1;
    if (y < 0) y = 0; else if (y > H - 1) y = H - 1;
    const x0 = x | 0, y0 = y | 0, x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1), u = x - x0, v = y - y0;
    const a = vals[y0 * W + x0], b = vals[y0 * W + x1], c = vals[y1 * W + x0], d = vals[y1 * W + x1];
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  };
  const NK = classes.length;
  const cls = (v) => { if (transparentIf(v)) return -1; let k = 0; while (k < NK - 1 && v > classes[k][0]) k++; return k; };
  const q = 0.25 / f; // sub-pixel offsets in cell units
  for (let oy = 0; oy < OH; oy++) {
    const yc = (OH - 1 - oy + 0.5) / f - 0.5; // image row 0 = north
    for (let ox = 0; ox < OW; ox++) {
      const xc = (ox + 0.5) / f - 0.5;
      const k0 = cls(at(xc - q, yc - q)), k1 = cls(at(xc + q, yc - q)), k2 = cls(at(xc - q, yc + q)), k3 = cls(at(xc + q, yc + q));
      if (k0 < 0 && k1 < 0 && k2 < 0 && k3 < 0) continue;
      let r = 0, gg = 0, bb = 0, al = 0;
      for (const k of [k0, k1, k2, k3]) {
        if (k < 0) continue;
        const c = classes[k], w = c[4];
        r += c[1] * w; gg += c[2] * w; bb += c[3] * w; al += w;
      }
      const o = (oy * OW + ox) * 4;
      out[o] = r / al; out[o + 1] = gg / al; out[o + 2] = bb / al; out[o + 3] = (255 * al) / 4;
    }
  }
  return { rgba: out, w: OW, h: OH };
}

// stepped colours: classes = [[upTo, r, g, b, alpha], ...] in ascending order
function classify(g, vals, classes, transparentIf) {
  const out = new Uint8ClampedArray(g.W * g.H * 4);
  for (let y = 0; y < g.H; y++) {
    const row = (g.H - 1 - y) * g.W;
    for (let x = 0; x < g.W; x++) {
      const v = vals[y * g.W + x];
      if (transparentIf(v)) continue;
      let k = 0; while (k < classes.length - 1 && v > classes[k][0]) k++;
      const c = classes[k], o = (row + x) * 4;
      out[o] = c[1]; out[o + 1] = c[2]; out[o + 2] = c[3]; out[o + 3] = 255 * c[4];
    }
  }
  return out;
}

function reach({ F, dates, res, metric, R, classes }) {
  const c = reachCompute({ F, dates, res });
  const { g, hist, polls } = c, NC = g.W * g.H, NB = EDGES.length + 1;
  const vals = new Float32Array(NC);
  if (metric === 'prob') {
    const kR = EDGES.indexOf(R) >= 0 ? EDGES.indexOf(R) : EDGES.findIndex((e) => e >= R);
    for (let i = 0; i < NC; i++) {
      let n = 0; for (let k = 0; k <= kR; k++) n += hist[i * NB + k];
      vals[i] = polls ? (n * 100) / polls : 0;
    }
    const shown = blur(g, vals, 0.8);
    const img = classifySmooth(g, shown, classes, (v) => v < 1);
    return { w: img.w, h: img.h, bbox: gbox(g), rgba: img.rgba, vals, polls, days: c.days, sampled: c.sampled, res };
  }
  // median distance across the sampled polls, interpolated inside its bin
  for (let i = 0; i < NC; i++) {
    if (!polls) { vals[i] = -1; continue; }
    let acc = 0, k = 0;
    while (k < NB && acc + hist[i * NB + k] < polls / 2) { acc += hist[i * NB + k]; k++; }
    const lo = k === 0 ? 0 : EDGES[k - 1], hi = k < EDGES.length ? EDGES[k] : 2500;
    const inBin = hist[i * NB + k] || 1;
    vals[i] = lo + ((polls / 2 - acc) / inBin) * (hi - lo);
  }
  const shown = blur(g, vals, 0.8);
  const img = classifySmooth(g, shown, classes, (v) => v < 0 || v > classes[classes.length - 1][0]);
  return { w: img.w, h: img.h, bbox: gbox(g), rgba: img.rgba, vals, polls, days: c.days, sampled: c.sampled, res };
}

// all inferred trips of the given days (for the animated map)
function tripsList({ dates, P }) {
  const R = inferTrips(dates, P);
  return { trips: R.trips.slice(), pollT: R.pollT, inuse: Array.from(R.inuse), bikes: G.bikeIds,
    stations: G.st.map((s) => [s.uid, s.name]), openNow: R.openNow };
}

// ------------------------------------------------------------------ routing
// Bicycle graph from OpenStreetMap (tools/build_graph.py). Start and end are
// snapped to the nearest street; the cheapest path is found with A*.
// Costs: length x factor (cycleways cheaper, busy roads, rough surfaces and
// pushing dearer; against a one-way street = pushing, factor 4).
// The heuristic (straight distance x 0.8, the lowest factor) never
// overestimates, so A* returns the cheapest path under these costs.
// It is an estimate of the way taken, not the way actually ridden.
let GRAPH_VER = '';
let GR = null, grLoading = null;
const MIN_FACTOR = 0.8, SNAP_MAX = 250, CELL = 60;

async function loadGraph() {
  if (GR) return GR;
  if (!grLoading) grLoading = (async () => {
    const r = await fetch(`${BASE}graph.bin.gz?v=${encodeURIComponent(GRAPH_VER || '1')}`);
    if (!r.ok) return null;
    const raw = new Uint8Array(await r.arrayBuffer());
    let buf = raw.buffer;
    // the file is gzip; a server may already have decoded it (Content-Encoding)
    if (raw[0] === 0x1f && raw[1] === 0x8b) buf = await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    GR = parseGraph(buf);
    return GR;
  })().catch((e) => { console.warn('graph', e); return null; });
  return grLoading;
}

function parseGraph(buf) {
  const dv = new DataView(buf);
  if (String.fromCharCode(...new Uint8Array(buf, 0, 4)) !== 'KVBG') throw new Error('bad graph file');
  const N = dv.getUint32(8, true), E = dv.getUint32(12, true), V = dv.getUint32(16, true);
  let o = 32;
  const take = (T, n) => { const a = new T(buf, o, n); o += a.byteLength; return a; };
  const nla = take(Int32Array, N), nlo = take(Int32Array, N);
  const eu = take(Uint32Array, E), ev = take(Uint32Array, E), elen = take(Float32Array, E), gofs = take(Uint32Array, E + 1);
  const vla = take(Int32Array, V), vlo = take(Int32Array, V);
  const fac = take(Uint8Array, E), fl = take(Uint8Array, E);
  // local metric coordinates for the heuristic and snapping
  const X = new Float64Array(N), Y = new Float64Array(N);
  for (let i = 0; i < N; i++) { X[i] = (nlo[i] / 1e6 - BBOX.w) * M_LNG; Y[i] = (nla[i] / 1e6 - BBOX.s) * M_LAT; }
  // cost per metre in drawing direction (fwd) and against it (rev)
  const cf = new Float32Array(E), cr = new Float32Array(E);
  for (let e = 0; e < E; e++) { const f = fac[e] / 20; cf[e] = f * (fl[e] & 2 ? 4 : 1); cr[e] = f * (fl[e] & 1 ? 4 : 1); }
  // adjacency (CSR): arc = edge e forward (2e) or backward (2e+1)
  const off = new Uint32Array(N + 1);
  for (let e = 0; e < E; e++) { off[eu[e] + 1]++; off[ev[e] + 1]++; }
  for (let i = 0; i < N; i++) off[i + 1] += off[i];
  const fill = off.slice(0, N), arcTo = new Uint32Array(2 * E), arcCost = new Float32Array(2 * E), arcId = new Uint32Array(2 * E);
  for (let e = 0; e < E; e++) {
    let k = fill[eu[e]]++; arcTo[k] = ev[e]; arcCost[k] = elen[e] * cf[e]; arcId[k] = 2 * e;
    k = fill[ev[e]]++; arcTo[k] = eu[e]; arcCost[k] = elen[e] * cr[e]; arcId[k] = 2 * e + 1;
  }
  const g = { N, E, nla, nlo, eu, ev, elen, gofs, vla, vlo, X, Y, cf, cr, off, arcTo, arcCost, arcId,
    gS: new Float64Array(N), stamp: new Uint32Array(N), done: new Uint32Array(N), prev: new Int32Array(N), run: 0 };
  // snap index: cell -> edges with a segment crossing that cell's area
  const W = Math.ceil(((BBOX.e - BBOX.w) * M_LNG) / CELL), H = Math.ceil(((BBOX.n - BBOX.s) * M_LAT) / CELL);
  const cnt = new Uint32Array(W * H + 1);
  const each = (cb) => {
    for (let e = 0; e < E; e++) {
      const P = edgePts(g, e);
      let last = -1;
      for (let k = 0; k + 3 < P.length; k += 2) {
        const x0 = Math.max(0, Math.floor(Math.min(P[k], P[k + 2]) / CELL)), x1 = Math.min(W - 1, Math.floor(Math.max(P[k], P[k + 2]) / CELL));
        const y0 = Math.max(0, Math.floor(Math.min(P[k + 1], P[k + 3]) / CELL)), y1 = Math.min(H - 1, Math.floor(Math.max(P[k + 1], P[k + 3]) / CELL));
        for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) { const c = yy * W + xx; if (c !== last) cb(e, c); last = c; }
      }
    }
  };
  each((e, c) => { cnt[c + 1]++; });
  for (let i = 0; i < W * H; i++) cnt[i + 1] += cnt[i];
  const pos = cnt.slice(0, W * H), cE = new Uint32Array(cnt[W * H]);
  each((e, c) => { cE[pos[c]++] = e; });
  Object.assign(g, { W, H, cnt, cE });
  return g;
}

// polyline of edge e from u to v, in local metres: [x0, y0, x1, y1, ...]
function edgePts(g, e) {
  const a = g.gofs[e], b = g.gofs[e + 1], P = new Float64Array((b - a + 2) * 2);
  P[0] = g.X[g.eu[e]]; P[1] = g.Y[g.eu[e]];
  for (let k = a; k < b; k++) { P[(k - a + 1) * 2] = (g.vlo[k] / 1e6 - BBOX.w) * M_LNG; P[(k - a + 1) * 2 + 1] = (g.vla[k] / 1e6 - BBOX.s) * M_LAT; }
  P[P.length - 2] = g.X[g.ev[e]]; P[P.length - 1] = g.Y[g.ev[e]];
  return P;
}
const toLL = (x, y) => [+(BBOX.w + x / M_LNG).toFixed(6), +(BBOX.s + y / M_LAT).toFixed(6)];

// nearest point on any street: { e, along (m from u), x, y, d }
function snap(g, lat, lng) {
  const x = (lng - BBOX.w) * M_LNG, y = (lat - BBOX.s) * M_LAT;
  const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL), R = Math.ceil(SNAP_MAX / CELL);
  const seen = new Set();
  let best = null;
  for (let r = 0; r <= R; r++) {
    for (let yy = cy - r; yy <= cy + r; yy++) for (let xx = cx - r; xx <= cx + r; xx++) {
      if (Math.max(Math.abs(yy - cy), Math.abs(xx - cx)) !== r || xx < 0 || yy < 0 || xx >= g.W || yy >= g.H) continue;
      const c = yy * g.W + xx;
      for (let j = g.cnt[c]; j < g.cnt[c + 1]; j++) {
        const e = g.cE[j]; if (seen.has(e)) continue; seen.add(e);
        const P = edgePts(g, e);
        let acc = 0;
        for (let k = 0; k + 3 < P.length; k += 2) {
          const ax = P[k], ay = P[k + 1], bx = P[k + 2], by = P[k + 3], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, L = Math.sqrt(L2);
          const u = L2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
          const px = ax + u * dx, py = ay + u * dy, d = Math.hypot(x - px, y - py);
          if (!best || d < best.d) best = { e, along: acc + u * L, x: px, y: py, d };
          acc += L;
        }
      }
    }
    // a hit closer than the ring we just finished cannot be beaten further out
    if (best && best.d <= r * CELL) break;
  }
  return best && best.d <= SNAP_MAX ? best : null;
}

// part of edge e between distances a and b from u (a > b = backwards), local metres
function edgePart(g, e, a, b) {
  const P = edgePts(g, e), out = [];
  const lo = Math.min(a, b), hi = Math.max(a, b);
  let acc = 0;
  const pt = (k, u) => [P[k] + u * (P[k + 2] - P[k]), P[k + 1] + u * (P[k + 3] - P[k + 1])];
  for (let k = 0; k + 3 < P.length; k += 2) {
    const L = Math.hypot(P[k + 2] - P[k], P[k + 3] - P[k + 1]);
    if (acc + L >= lo && acc <= hi) {
      if (!out.length) out.push(pt(k, L ? (lo - acc) / L : 0));
      if (acc + L <= hi) out.push([P[k + 2], P[k + 3]]);
      else { out.push(pt(k, L ? (hi - acc) / L : 0)); break; }
    }
    acc += L;
  }
  return a > b ? out.reverse() : out;
}

// binary heap of (node, f)
class Heap {
  constructor() { this.n = []; this.f = []; }
  get size() { return this.n.length; }
  push(n, f) {
    const N = this.n, F = this.f; let i = N.length; N.push(n); F.push(f);
    while (i > 0) { const p = (i - 1) >> 1; if (F[p] <= f) break; N[i] = N[p]; F[i] = F[p]; i = p; }
    N[i] = n; F[i] = f;
  }
  pop() {
    const N = this.n, F = this.f, top = N[0], ln = N.pop(), lf = F.pop();
    if (N.length) {
      let i = 0; const L = N.length;
      for (;;) {
        let c = 2 * i + 1; if (c >= L) break;
        if (c + 1 < L && F[c + 1] < F[c]) c++;
        if (F[c] >= lf) break;
        N[i] = N[c]; F[i] = F[c]; i = c;
      }
      N[i] = ln; F[i] = lf;
    }
    return top;
  }
  peekF() { return this.f[0]; }
}

const routeCache = new Map();
// cheapest route from (lat0,lng0) to (lat1,lng1): { c: [[lng,lat],...], len (m) } or null
function route(g, lat0, lng0, lat1, lng1) {
  const key = `${lat0.toFixed(5)},${lng0.toFixed(5)},${lat1.toFixed(5)},${lng1.toFixed(5)}`;
  if (routeCache.has(key)) return routeCache.get(key);
  const res = routeNow(g, lat0, lng0, lat1, lng1);
  if (routeCache.size > 20000) routeCache.clear();
  routeCache.set(key, res);
  return res;
}
function routeNow(g, lat0, lng0, lat1, lng1) {
  const A = snap(g, lat0, lng0), B = snap(g, lat1, lng1);
  if (!A || !B) return null;
  const run = ++g.run;
  const { gS, stamp, done, prev, X, Y } = g;
  const tx = B.x, ty = B.y, h = (n) => Math.hypot(X[n] - tx, Y[n] - ty) * MIN_FACTOR;
  const heap = new Heap();
  const seed = (n, c) => { if (stamp[n] !== run || c < gS[n]) { stamp[n] = run; gS[n] = c; prev[n] = -1; heap.push(n, c + h(n)); } };
  const Le = g.elen[A.e];
  seed(g.eu[A.e], A.along * g.cr[A.e]);
  seed(g.ev[A.e], (Le - A.along) * g.cf[A.e]);
  // reaching the target point from either end of its edge
  const LB = g.elen[B.e];
  const exitU = B.along * g.cf[B.e], exitV = (LB - B.along) * g.cr[B.e];
  let best = Infinity, bestEnd = -1;
  if (A.e === B.e) best = Math.abs(B.along - A.along) * (B.along >= A.along ? g.cf[A.e] : g.cr[A.e]);
  let expanded = 0;
  while (heap.size) {
    if (heap.peekF() >= best) break;
    const n = heap.pop();
    if (done[n] === run) continue;
    done[n] = run;
    if (++expanded > 400000) return null;
    const gn = gS[n];
    if (n === g.eu[B.e] && gn + exitU < best) { best = gn + exitU; bestEnd = n; }
    if (n === g.ev[B.e] && gn + exitV < best) { best = gn + exitV; bestEnd = n; }
    for (let k = g.off[n]; k < g.off[n + 1]; k++) {
      const m = g.arcTo[k], c = gn + g.arcCost[k];
      if (stamp[m] !== run || c < gS[m]) { stamp[m] = run; gS[m] = c; prev[m] = k; heap.push(m, c + h(m)); }
    }
  }
  let pts;
  const sameEdge = A.e === B.e && Math.abs(B.along - A.along) * (B.along >= A.along ? g.cf[A.e] : g.cr[A.e]) <= best + 1e-6;
  if (bestEnd < 0 || sameEdge) {
    if (A.e !== B.e) return null;
    pts = edgePart(g, A.e, A.along, B.along);
  } else {
    // walk back from the last node to the seed node
    const arcs = [];
    let n = bestEnd;
    while (prev[n] >= 0) {
      const k = prev[n];
      arcs.push(k);
      const a = g.arcId[k], e = a >> 1;
      n = a & 1 ? g.ev[e] : g.eu[e]; // backward arc came from v, forward from u
      if (arcs.length > 50000) return null;
    }
    pts = n === g.eu[A.e] ? edgePart(g, A.e, A.along, 0) : edgePart(g, A.e, A.along, Le);
    for (let i = arcs.length - 1; i >= 0; i--) {
      const a = g.arcId[arcs[i]], e = a >> 1, P = edgePts(g, e), seg = [];
      for (let k = 0; k < P.length; k += 2) seg.push([P[k], P[k + 1]]);
      if (a & 1) seg.reverse();
      for (let k = 1; k < seg.length; k++) pts.push(seg[k]);
    }
    const tail = bestEnd === g.eu[B.e] ? edgePart(g, B.e, 0, B.along) : edgePart(g, B.e, LB, B.along);
    for (let k = 1; k < tail.length; k++) pts.push(tail[k]);
  }
  // include the walk from the bike to the street, so the line starts and ends at the bike
  const x0 = (lng0 - BBOX.w) * M_LNG, y0 = (lat0 - BBOX.s) * M_LAT, x1 = (lng1 - BBOX.w) * M_LNG, y1 = (lat1 - BBOX.s) * M_LAT;
  const all = [[x0, y0], ...pts, [x1, y1]];
  const c = [];
  let len = 0;
  for (let k = 0; k < all.length; k++) {
    if (k) { const d = Math.hypot(all[k][0] - all[k - 1][0], all[k][1] - all[k - 1][1]); if (d < 0.3) continue; len += d; }
    c.push(toLL(all[k][0], all[k][1]));
  }
  return { c, len: Math.round(len) };
}

async function routes({ pairs }) {
  const g = await loadGraph();
  if (!g) return { ok: false, list: [] };
  const list = [];
  for (let i = 0; i + 3 < pairs.length; i += 4) list.push(route(g, pairs[i], pairs[i + 1], pairs[i + 2], pairs[i + 3]));
  return { ok: true, list };
}

// ------------------------------------------------------------------ one bike / one station over time
// Stays (parked, possibly several snapshots at about the same place) and the
// moves between them, from the raw polls of the chosen period.
async function bikeTrail({ bike, t0, t1, P }) {
  const b = G.bikeIdx.get(String(bike));
  const dates = [...DAYS.keys()].sort();
  if (b == null) return { stays: [], moves: [], polls: 0 };
  const stays = [];
  let cur = null, absentSince = null, polls = 0, lastSeenT = null;
  replay(dates, (t, S) => {
    if (t < t0 || t > t1) return;
    polls++;
    if (!S.p[b]) { if (cur && absentSince == null) absentSince = t; return; }
    const lat = S.lat[b], lng = S.lng[b], pl = S.pl[b];
    const same = cur && absentSince == null && cur.st === pl && Math.hypot((lat - cur.lat) * M_LAT, (lng - cur.lng) * M_LNG) < 60;
    if (same) {
      cur.t1 = t; cur.n++;
      const last = cur.pts[cur.pts.length - 1];
      if (Math.hypot((lat - last[1]) * M_LAT, (lng - last[0]) * M_LNG) > 3) cur.pts.push([+lng.toFixed(6), +lat.toFixed(6)]);
    } else {
      const prevStay = cur;
      cur = { t0: t, t1: t, lat, lng, st: pl, n: 1, pts: [[+lng.toFixed(6), +lat.toFixed(6)]], gapFrom: absentSince != null ? absentSince : null, prevT: lastSeenT };
      if (prevStay) cur.prev = prevStay;
      stays.push(cur);
    }
    absentSince = null; lastSeenT = t;
  });
  const g = await loadGraph();
  const moves = [];
  for (let i = 1; i < stays.length; i++) {
    const a = stays[i - 1], z = stays[i];
    const d = Math.hypot((z.lat - a.lat) * M_LAT, (z.lng - a.lng) * M_LNG);
    const absent = z.gapFrom != null;
    // a trip: the bike left the feed (rented) or moved clearly; else GPS drift or a nudge
    const kind = absent || d >= P.minGone ? 'trip' : 'shift';
    const r = kind === 'trip' && g ? route(g, a.lat, a.lng, z.lat, z.lng) : null;
    moves.push({ from: i - 1, to: i, t0: a.t1, t1: z.t0, d: Math.round(d), absent, kind,
      service: absent && z.t0 - a.t1 > P.maxDur, route: r ? r.c : null, len: r ? r.len : null });
  }
  for (const st of stays) { delete st.prev; delete st.gapFrom; delete st.prevT; st.name = st.st >= 0 ? G.st[st.st].name : null; }
  const left = absentSince != null ? absentSince : null; // gone at the end of the period: on the road now?
  return { stays, moves, polls, routing: !!g, leftAt: left };
}

async function stationMoves({ uid, t0, t1, P, dates }) {
  const j = G.stIdx.get(String(uid));
  if (j == null) return { list: [], routing: false };
  const R = inferTrips(dates, P), tr = R.trips;
  const g = await loadGraph();
  const list = [];
  for (let i = 0; i < tr.length; i += TS) {
    const s0 = tr[i + 9], s1 = tr[i + 10];
    if (s0 !== j && s1 !== j) continue;
    if (s0 === j && s1 === j) continue; // left and came back to the same station
    if (tr[i + 1] < t0 || tr[i] > t1) continue;
    const out = s0 === j;
    const r = g ? route(g, tr[i + 2], tr[i + 3], tr[i + 4], tr[i + 5]) : null;
    list.push({ out, s: tr[i], e: tr[i + 1], bike: G.bikeIds[tr[i + 8]], d: Math.round(tr[i + 6]), short: !!tr[i + 7],
      a: [tr[i + 3], tr[i + 2]], b: [tr[i + 5], tr[i + 4]], other: out ? (s1 >= 0 ? G.st[s1].name : null) : (s0 >= 0 ? G.st[s0].name : null),
      route: r ? r.c : null, len: r ? r.len : null });
  }
  list.sort((x, y) => y.s - x.s);
  return { list, routing: !!g, name: G.st[j].name };
}

// ------------------------------------------------------------------ rpc
const OPS = {
  async init({ base, graph }) { BASE = base; GRAPH_VER = graph || ''; return true; },
  routes, bikeTrail, stationMoves,
  // new data arrived: forget the changed days and every cached result built on them
  async invalidate({ dates }) {
    for (const d of dates) DAYS.delete(d);
    tripCache = { key: '', res: null };
    reachCache = { key: '', g: null, hist: null, polls: 0, days: 0, sampled: 0 };
    activeBB = { key: '', bb: BBOX };
    return true;
  },
  async load({ dates }) { for (const d of dates) await loadDay(d); return { bikes: G.bikeIds.length, stations: G.st.length }; },
  avail, density, point, stations, stationProfile, usage, flows, inuseSeries, reach, tripsList, coverage,
};
self.onmessage = async (e) => {
  const { id, op, args, ver } = e.data;
  if (ver) VER = ver;
  try {
    if (args && args.dates) for (const d of args.dates) await loadDay(d);
    const res = await OPS[op](args || {});
    const transfer = [];
    for (const k of ['rgba', 'vals', 'trips']) if (res && res[k] && res[k].buffer instanceof ArrayBuffer) transfer.push(res[k].buffer);
    self.postMessage({ id, ok: true, res }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, err: String(err && err.stack || err) });
  }
};
