/* Analysis worker: loads per-day history files (tl/YYYY-MM-DD.json) and
   computes every analysis with freely chosen parameters, off the main thread.

   Filter F = { from, to: 'YYYY-MM-DD', wd: [7 booleans, Mo..So],
                t0, t1: minutes of day (t0 > t1 = window wraps midnight),
                kind: 'all' | 'free' | 'station' } */
'use strict';

const TZ = 'Europe/Berlin';
const BBOX = { s: 50.83, n: 51.09, w: 6.76, e: 7.18 };
const M_LAT = 111320;
const COS = Math.cos(((BBOX.s + BBOX.n) / 2) * Math.PI / 180);
const M_LNG = M_LAT * COS;

let BASE = './';
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
  const r = await fetch(`${BASE}tl/${date}.json?v=${Math.floor(Date.now() / 600000)}`);
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
  return { w: g.W, h: g.H, bbox: BBOX, rgba, polls, days: seenDays.size, res, auto: res !== want, vals: pct };
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
  return { w: g.W, h: g.H, bbox: g.bb, rgba, polls, days: seenDays.size, res, vmax, vals };
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
  return { polls, list: G.st.map((s, j) => ({ j, uid: s.uid, name: s.name, lat: s.lat, lng: s.lng,
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
let tripCache = { key: '', res: null };
function inferTrips(dates, P) {
  const key = `${dates.join(',')}|${P.minGone}|${P.jump}|${P.maxDur}`;
  if (tripCache.key === key) return tripCache.res;
  const N = G.bikeIds.length;
  const prevP = new Uint8Array(N), prevLat = new Float64Array(N), prevLng = new Float64Array(N);
  const oT0 = new Float64Array(N), oT1 = new Float64Array(N), oLat = new Float64Array(N), oLng = new Float64Array(N), open = new Uint8Array(N);
  const trips = [];
  const pollT = [], pollTotal = [];
  let prevT = null, service = 0, round = 0;
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
          if (d > P.jump) trips.push(prevT, t, prevLat[b], prevLng[b], S.lat[b], S.lng[b], d, 1);
        } else if (was && !now) {
          open[b] = 1; oT0[b] = prevT; oT1[b] = t; oLat[b] = prevLat[b]; oLng[b] = prevLng[b];
        } else if (!was && now && open[b]) {
          open[b] = 0;
          const st = (oT0[b] + oT1[b]) / 2, en = (prevT + t) / 2, d = dist(oLat[b], oLng[b], S.lat[b], S.lng[b]);
          if (en - st > P.maxDur) service++;
          else if (d < P.minGone) round++;
          else trips.push(st, en, oLat[b], oLng[b], S.lat[b], S.lng[b], d, 0);
        }
      }
      prevP[b] = now;
      if (now) { prevLat[b] = S.lat[b]; prevLng[b] = S.lng[b]; }
    }
    pollT.push(t); pollTotal.push(total);
    prevT = t;
  });
  // bikes in use = long trips in progress (+ open absences younger than maxDur)
  const starts = [], ends = [];
  for (let i = 0; i < trips.length; i += 8) if (!trips[i + 7]) { starts.push(trips[i]); ends.push(trips[i + 1]); }
  const last = pollT[pollT.length - 1];
  for (let b = 0; b < N; b++) if (open[b] && last - (oT0[b] + oT1[b]) / 2 <= P.maxDur) starts.push((oT0[b] + oT1[b]) / 2);
  starts.sort((a, b) => a - b); ends.sort((a, b) => a - b);
  const inuse = new Int32Array(pollT.length);
  let si = 0, ei = 0;
  for (let k = 0; k < pollT.length; k++) {
    const t = pollT[k];
    while (si < starts.length && starts[si] < t) si++;
    while (ei < ends.length && ends[ei] <= t) ei++;
    inuse[k] = Math.max(0, si - ei);
  }
  const res = { trips: Float64Array.from(trips), pollT, pollTotal, inuse, service, round };
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
  for (let i = 0; i < tr.length; i += 8) {
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
    count, short, service: R.service, round: R.round,
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
  for (let i = 0; i < tr.length; i += 8) {
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
  return { trips: used, lines, cells, cell };
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
const EDGES = [50, 100, 150, 200, 300, 400, 500, 750, 1000, 1500, 2000];
let reachCache = { key: '', g: null, hist: null, polls: 0, days: 0, sampled: 0 };

const BIN_LUT = (() => { const a = new Uint8Array(260); for (let i = 0; i < 260; i++) { let k = 0; while (k < EDGES.length && i * 10 > EDGES[k]) k++; a[i] = k; } return a; })();

function reachCompute({ F, dates, res, maxPolls = 150 }) {
  const key = `${JSON.stringify(F)}|${dates.join(',')}|${res}|${maxPolls}`;
  if (reachCache.key === key) return reachCache;
  const g = grid(res, activeBBox(dates)), NC = g.W * g.H, NB = EDGES.length + 1;
  const hist = new Uint16Array(NC * NB);
  const dist = new Float32Array(NC);
  const CAP = 2500, D1 = res, D2 = res * Math.SQRT2;
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
    dist.fill(CAP);
    for (let b = 0; b < S.n; b++) {
      if (!S.p[b] || !kindOk(F.kind, S.pl[b])) continue;
      const c = cellOf(g, S.lat[b], S.lng[b]);
      if (c >= 0) dist[c] = 0;
    }
    const W = g.W, H = g.H;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x; let v = dist[i];
      if (x > 0 && dist[i - 1] + D1 < v) v = dist[i - 1] + D1;
      if (y > 0) {
        const u = i - W;
        if (dist[u] + D1 < v) v = dist[u] + D1;
        if (x > 0 && dist[u - 1] + D2 < v) v = dist[u - 1] + D2;
        if (x < W - 1 && dist[u + 1] + D2 < v) v = dist[u + 1] + D2;
      }
      dist[i] = v;
    }
    for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x; let v = dist[i];
      if (x < W - 1 && dist[i + 1] + D1 < v) v = dist[i + 1] + D1;
      if (y < H - 1) {
        const u = i + W;
        if (dist[u] + D1 < v) v = dist[u] + D1;
        if (x < W - 1 && dist[u + 1] + D2 < v) v = dist[u + 1] + D2;
        if (x > 0 && dist[u - 1] + D2 < v) v = dist[u - 1] + D2;
      }
      dist[i] = v;
    }
    const half = res / 2;
    for (let i = 0; i < NC; i++) {
      const d = dist[i] + half; // distance from the cell centre, roughly
      hist[i * NB + BIN_LUT[d >= 2590 ? 259 : (d / 10) | 0]]++;
    }
  });
  reachCache = { key, g, hist, polls, days: seenDays.size, sampled: match.length };
  return reachCache;
}

function reach({ F, dates, res, metric, R, stops }) {
  const c = reachCompute({ F, dates, res });
  const { g, hist, polls } = c, NC = g.W * g.H, NB = EDGES.length + 1;
  const vals = new Float32Array(NC);
  if (metric === 'prob') {
    const kR = EDGES.indexOf(R) >= 0 ? EDGES.indexOf(R) : EDGES.findIndex((e) => e >= R);
    for (let i = 0; i < NC; i++) {
      let n = 0; for (let k = 0; k <= kR; k++) n += hist[i * NB + k];
      vals[i] = polls ? (n * 100) / polls : 0;
    }
    const rgba = colorize(g, blur(g, vals, 0.8), 100, stops, true);
    return { w: g.W, h: g.H, bbox: g.bb, rgba, vals, polls, days: c.days, sampled: c.sampled, res };
  }
  // median distance; colour by closeness so near = strong, far = fades out
  const close = new Float32Array(NC);
  for (let i = 0; i < NC; i++) {
    if (!polls) { vals[i] = -1; continue; }
    let acc = 0, k = 0;
    while (k < NB && acc + hist[i * NB + k] < polls / 2) { acc += hist[i * NB + k]; k++; }
    const lo = k === 0 ? 0 : EDGES[k - 1], hi = k < EDGES.length ? EDGES[k] : 2500;
    const inBin = hist[i * NB + k] || 1;
    const med = lo + ((polls / 2 - acc) / inBin) * (hi - lo);
    vals[i] = med;
    close[i] = med >= 1500 ? 0 : Math.max(0, 1 - Math.log(med / 25) / Math.log(1500 / 25));
  }
  const rgba = colorize(g, blur(g, close, 0.8), 1, stops, true);
  return { w: g.W, h: g.H, bbox: g.bb, rgba, vals, polls, days: c.days, sampled: c.sampled, res };
}

// all inferred trips of the given days (for the animated map)
function tripsList({ dates, P }) {
  const R = inferTrips(dates, P);
  return { trips: R.trips.slice(), pollT: R.pollT, inuse: Array.from(R.inuse) };
}

// ------------------------------------------------------------------ rpc
const OPS = {
  async init({ base }) { BASE = base; return true; },
  async load({ dates }) { for (const d of dates) await loadDay(d); return { bikes: G.bikeIds.length, stations: G.st.length }; },
  avail, density, point, stations, stationProfile, usage, flows, inuseSeries, reach, tripsList,
};
self.onmessage = async (e) => {
  const { id, op, args } = e.data;
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
