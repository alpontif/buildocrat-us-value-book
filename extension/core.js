/* Buildocrat Value Lens (US): valuation core, same formulas as valued.buildocrat.store/app.js.
   Loaded by the service worker. Plain script, no modules. */
'use strict';
var VL = (function () {
  const TYPEN = ['City', 'Town', 'Community', 'ZIP code', 'Neighborhood', 'Village', 'Hamlet', 'Subdivision', 'Gated community'];
  const SQFT_ACRE = 43560, QLOT = 10890;
  const REG = {CT:'NE',ME:'NE',MA:'NE',NH:'NE',RI:'NE',VT:'NE',NJ:'NE',NY:'NE',PA:'NE',IL:'MW',IN:'MW',MI:'MW',OH:'MW',WI:'MW',IA:'MW',KS:'MW',MN:'MW',MO:'MW',NE:'MW',ND:'MW',SD:'MW',AZ:'W',CO:'W',ID:'W',MT:'W',NV:'W',NM:'W',UT:'W',WY:'W',AK:'W',CA:'W',HI:'W',OR:'W',WA:'W'};
  const KEYS = ['res', 'hv', 'hvlo', 'hvhi', 'rent1', 'rent2', 'rent3', 'rent4'];
  let LG = null, PL = null, TR = null, META = null, PIDX = null, TIDX = null, RINGS = null, loaded = false;

  function decode(enc) { const out = []; let x = 0, y = 0; for (const p of enc.split(' ')) { const k = p.indexOf(','); x += +p.slice(0, k); y += +p.slice(k + 1); out.push([x / 1000, y / 1000]); } return out; }
  function km(a, b, c, d) { const R = 6371, t = Math.PI / 180; const h = Math.sin((c - a) * t / 2) ** 2 + Math.cos(a * t) * Math.cos(c * t) * Math.sin((d - b) * t / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); }
  function derive(v, st) {
    v.acre = v.res ? v.res * SQFT_ACRE : null; v.bcost = (META.build || {})[REG[st] || 'S'] || null;
    v.lsh = null; v.str = null; if (v.hv && v.res) { const lot = v.res * QLOT; if (lot < 0.85 * v.hv) { v.lsh = Math.max(1, 100 * lot / v.hv); v.str = v.hv - lot; } }
    v.yld = (v.rent2 && v.hv) ? 100 * 12 * v.rent2 / v.hv : null; return v;
  }
  async function gunzipB64(txt) {
    const bin = atob(txt.trim()); const buf = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    if (buf[0] === 0x1f && buf[1] === 0x8b) { const ds = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip')); return JSON.parse(await new Response(ds).text()); }
    return JSON.parse(new TextDecoder().decode(buf));
  }
  const undelta = a => { for (let j = 1; j < a.length; j++) a[j] += a[j - 1]; };
  async function load(base) {
    const txt = u => fetch(base + u).then(r => { if (!r.ok) throw new Error(u + ' ' + r.status); return r.text(); });
    const [a, b, c] = await Promise.all([fetch(base + 'data/counties.json').then(r => { if (!r.ok) throw new Error('counties ' + r.status); return r.json(); }),
      txt('data/places.b64.txt').then(gunzipB64), txt('data/tracts.b64.txt').then(gunzipB64)]);
    LG = a.counties; META = a.meta; PL = b; TR = c;
    undelta(PL.la); undelta(PL.lo); undelta(TR.la); undelta(TR.lo);
    PL.pa = new Int32Array(PL.n.length).fill(-1);
    if (PL.pk) { let k = 0; PL.pk.forEach((d, i) => { k += d; PL.pa[k] = PL.pp[i]; }); }
    for (const g of LG) derive(g.v, g.s);
    PIDX = new Map();
    for (let j = 0; j < PL.n.length; j++) { if (PL.t[j] === 3) continue; const k = Math.floor(PL.lo[j] / 2000) + ':' + Math.floor(PL.la[j] / 2000); let arr = PIDX.get(k); if (!arr) { arr = []; PIDX.set(k, arr); } arr.push(j); }
    TIDX = new Map();
    for (let i = 0; i < TR.la.length; i++) { const k = Math.floor(TR.lo[i] / 1000) + ':' + Math.floor(TR.la[i] / 1000); let arr = TIDX.get(k); if (!arr) { arr = []; TIDX.set(k, arr); } arr.push(i); }
    RINGS = LG.map(g => { const rs = g.r.map(decode); let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; for (const r of rs) for (const [x, y] of r) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return { rs, bb: [x0, y0, x1, y1] }; });
    loaded = true;
    return { date: META.date, places: PL.n.length };
  }
  function pip(x, y, r) { let c = false; for (let a = 0, b = r.length - 1; a < r.length; b = a++) { const [xi, yi] = r[a], [xj, yj] = r[b]; if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) c = !c; } return c; }
  function countyAt(lat, lng) {
    let best = -1;
    for (let i = 0; i < LG.length; i++) { const o = RINGS[i], b = o.bb; if (lng < b[0] || lng > b[2] || lat < b[1] || lat > b[3]) continue; let n = 0; for (const r of o.rs) if (pip(lng, lat, r)) n++; if (n % 2 === 1) return i; if (n) best = i; }
    if (best >= 0) return best;
    let d0 = 12; for (let i = 0; i < LG.length; i++) { const d = km(lat, lng, LG[i].lat, LG[i].lng); if (d < d0) { d0 = d; best = i; } } return best;
  }
  function nearestTracts(lat, lng, k, maxKm) {
    const out = []; const gx = Math.floor(lng * 10), gy = Math.floor(lat * 10);
    for (let ring = 0; ring <= 3 && out.length < k; ring++)
      for (let dx = -ring; dx <= ring; dx++) for (let dy = -ring; dy <= ring; dy++) { if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue; const a = TIDX.get((gx + dx) + ':' + (gy + dy)); if (a) for (const i of a) { const d = km(lat, lng, TR.la[i] / 1e4, TR.lo[i] / 1e4); if (d <= maxKm) out.push([i, d]); } }
    out.sort((a, b) => a[1] - b[1]); return out.slice(0, k);
  }
  function nearestPlace(lat, lng) {
    let best = null; const gx = Math.floor(lng * 5), gy = Math.floor(lat * 5);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const a = PIDX.get((gx + dx) + ':' + (gy + dy)); if (a) for (const j of a) { const d = km(lat, lng, PL.la[j] / 1e4, PL.lo[j] / 1e4); if (d <= 6 && (!best || d < best[1])) best = [j, d]; } }
    return best;
  }
  function tv(i) { return { res: TR.v[i] / 100, hv: TR.h[i] * 100, hvlo: TR.hl[i] * 100, hvhi: TR.hh[i] * 100, rent1: TR.r1[i], rent2: TR.r2[i], rent3: TR.r3[i], rent4: TR.r4[i] }; }
  function valueAt(lat, lng) {
    if (!loaded) return { error: 'loading' };
    if (!((lat >= 18.5 && lat <= 72 && lng >= -180 && lng <= -64))) return { outside: true };
    const i = countyAt(lat, lng); if (i < 0) return { outside: true };
    const g = LG[i]; const nb = nearestTracts(lat, lng, 5, 25);
    let v, conf = 3, near = null;
    if (nb.length) {
      const acc = {}, wk = {}; KEYS.forEach(k => { acc[k] = 0; wk[k] = 0; });
      for (const [t, d] of nb) { const w = 1 / Math.max(0.25, d) ** 2; const x = tv(t); KEYS.forEach(k => { if (x[k] > 0) { acc[k] += w * Math.log(x[k]); wk[k] += w; } }); }
      v = {}; KEYS.forEach(k => v[k] = wk[k] > 0 ? Math.exp(acc[k] / wk[k]) : null);
      v.zone = TR.z[nb[0][0]]; conf = TR.c[nb[0][0]]; v.farm = v.zone >= 5 ? g.v.farm : null;
    } else { v = Object.assign({}, g.v); v.res = g.v.resR || g.v.res; v.zone = 6; }
    const np = nearestPlace(lat, lng);
    if (np) { const j = np[0]; near = { name: PL.n[j], type: TYPEN[PL.t[j]], km: np[1], within: PL.pa[j] >= 0 ? [PL.n[PL.pa[j]]] : [] }; }
    derive(v, g.s);
    return { lat, lng, county: g.n, st: g.s, cls: g.cls, conf, near, zone: (META.zones || [])[v.zone] || '', v, date: META.date };
  }
  return { load, valueAt, isLoaded: () => loaded };
})();
