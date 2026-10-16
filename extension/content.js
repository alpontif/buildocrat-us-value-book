/* Buildocrat Value Lens (US): shows land, home and rental values at the mouse cursor on Google Maps and OpenStreetMap. */
(() => {
  'use strict';
  if (window.__bvlens) return; window.__bvlens = true;
  const SITE = 'https://valued.buildocrat.store/';
  const host = location.hostname;
  const isOSM = /openstreetmap\.org$/.test(host);
  let enabled = true, tab = 'land', pinned = false, lastWheel = 0, seq = 0, timer = 0, lastPt = null, lastRes = null;

  chrome.storage.local.get(['enabled', 'tab']).then(s => { enabled = s.enabled !== false; tab = s.tab || 'land'; });
  chrome.storage.onChanged.addListener(ch => {
    if (ch.enabled) { enabled = ch.enabled.newValue !== false; if (!enabled) hide(true); }
    if (ch.tab) { tab = ch.tab.newValue || 'land'; if (lastRes && !card.hidden) render(lastRes); }
  });

  /* ---------- card (shadow DOM so the page's styles never leak in) ---------- */
  const hostEl = document.createElement('div');
  hostEl.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none';
  const root = hostEl.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
    .c{position:fixed;min-width:230px;max-width:290px;background:#FFFFFF;color:#22275A;border:1px solid #D3D6EA;border-radius:16px;box-shadow:0 10px 28px rgba(0,0,0,.22);
       font:13px/1.4 "Poppins","Segoe UI",Roboto,Arial,sans-serif;padding:10px 12px;pointer-events:none}
    .c.pin{pointer-events:auto;border-color:#1D2675;box-shadow:0 0 0 2px #1D267533,0 10px 28px rgba(0,0,0,.22)}
    .k{font:600 10px/1 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.08em;text-transform:uppercase;color:#5E638E}
    .h{font:700 22px/1.1 Arial,sans-serif;color:#1D2675;margin:3px 0 1px}
    .u{color:#5E638E;font-size:12px}
    .g{display:grid;grid-template-columns:1fr auto;gap:2px 10px;margin-top:7px;font-size:12px}
    .g b{font:600 12px ui-monospace,Menlo,Consolas,monospace;text-align:right}
    .w{margin-top:7px;padding-top:6px;border-top:1px solid #D3D6EA;font-size:11.5px;color:#5E638E}
    .z{display:inline-block;margin-left:6px;font:600 10px ui-monospace,monospace;border:1px solid currentColor;border-radius:99px;padding:0 6px;vertical-align:2px}
    .t{display:flex;gap:4px;margin-top:8px}.t button{flex:1;font:600 11px Arial,sans-serif;border:1px solid #1D2675;background:transparent;color:#1D2675;border-radius:6px;padding:4px 0;cursor:pointer}
    .t button[aria-pressed="true"]{background:#1D2675;color:#fff}
    a{color:#1D2675;font-weight:600}
    .m{color:#5E638E;font-size:12px}
    @media (prefers-color-scheme:dark){.c{background:#171B47;color:#E7E9FA;border-color:#2C3270}.k,.u,.w,.m{color:#A3A8D6}.h,a{color:#C9CEFF}.w{border-color:#2C3270}.t button{border-color:#C9CEFF;color:#C9CEFF}.t button[aria-pressed="true"]{background:#C9CEFF;color:#0F1234}}
  </style><div class="c" hidden></div>`;
  const card = root.querySelector('.c');
  (document.body || document.documentElement).appendChild(hostEl);

  const short = n => { if (n == null || !isFinite(n)) return '–'; const t = s => s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
    if (n >= 1e9) return '$' + t((n / 1e9).toFixed(2)) + 'B'; if (n >= 1e6) { const v = n / 1e6; return '$' + t(v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)) + 'M'; }
    if (n >= 1e4) { const v = n / 1e3; return '$' + t(v.toFixed(v >= 100 ? 0 : 1)) + 'K'; } if (n >= 100) return '$' + Math.round(n).toLocaleString('en-US'); if (n >= 10) return '$' + t(n.toFixed(1)); return '$' + n.toFixed(2); };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const CONF = ['tract land data', 'ZIP or county land data', 'partly filled from neighbors', 'modelled'];

  function render(r) {
    lastRes = r; const v = r.v;
    let head, unit, rows;
    if (tab === 'bld') { head = short(v.hv); unit = 'typical home value'; rows = [['Entry-level home', short(v.hvlo)], ['Upper-end home', short(v.hvhi)], ['Build new per sq ft', short(v.bcost)]]; }
    else if (tab === 'rent') { head = short(v.rent2); unit = '2-bedroom, rent per month'; rows = [['1-bedroom', short(v.rent1)], ['3-bedroom', short(v.rent3)], ['Gross yield', v.yld ? v.yld.toFixed(1) + '%' : '–']]; }
    else { head = short(v.res); unit = 'per sq ft, residential land'; rows = [['Per acre', short(v.acre)], ['Quarter-acre lot', short(v.res * 10890)], ['Farmland', v.farm ? short(v.farm) + '/acre' : 'built-up']]; }
    const near = r.near ? `${r.near.km < 0.4 ? 'In' : 'Near'} ${esc(r.near.name)} (${esc(r.near.type.toLowerCase())}${r.near.within.length ? ', ' + esc(r.near.within[r.near.within.length - 1]) : ''}) · ` : '';
    const link = `${SITE}#at=${r.lat.toFixed(5)},${r.lng.toFixed(5)}`;
    card.innerHTML = `<div class="k">≈ Value at cursor${r.zone ? `<span class="z">${esc(r.zone)}</span>` : ''}</div>
      <div class="h">${head}</div><div class="u">${unit}</div>
      <div class="g">${rows.map(([a, b]) => `<span>${a}</span><b>${b}</b>`).join('')}</div>
      <div class="w">${near}${esc(r.county)}, ${esc(r.st)}<br>${CONF[r.conf] || ''} · ${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}</div>
      ${pinned ? `<div class="t">${[['land', 'Land'], ['bld', 'Home'], ['rent', 'Rent']].map(([k, n]) => `<button type="button" data-t="${k}" aria-pressed="${k === tab}">${n}</button>`).join('')}</div>
        <div class="w"><a href="${link}" target="_blank" rel="noopener">Full report and ZIP code ↗</a> · Esc to close</div>`
        : `<div class="w">Hold <b>Shift</b> to pin · valued.buildocrat.store</div>`}`;
    card.hidden = false;
  }
  function msgCard(text) { lastRes = null; card.innerHTML = `<div class="m">${esc(text)}</div>`; card.hidden = false; }
  function place(x, y) {
    if (pinned) return;
    const w = card.offsetWidth || 260, h = card.offsetHeight || 160;
    let L = x + 18, T = y + 18; if (L + w > innerWidth - 8) L = x - w - 18; if (T + h > innerHeight - 8) T = y - h - 18;
    card.style.left = Math.max(8, L) + 'px'; card.style.top = Math.max(8, T) + 'px';
  }
  function hide(force) { if (pinned && !force) return; pinned = false; card.classList.remove('pin'); card.hidden = true; }
  card.addEventListener('click', e => { const b = e.target.closest('button[data-t]'); if (b) { tab = b.dataset.t; chrome.storage.local.set({ tab }); if (lastRes) render(lastRes); } });

  /* ---------- where is the cursor on the map? ---------- */
  function mapEl(target) {
    if (isOSM) { const m = document.getElementById('map'); return m && m.contains(target) && !target.closest('.leaflet-control-container,.leaflet-popup') ? m : null; }
    return target && target.tagName === 'CANVAS' && target.clientWidth > 200 && target.clientHeight > 150 ? target : null;
  }
  function view(el) {
    let m;
    if (isOSM) { m = location.hash.match(/map=(\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/); if (!m) return null;
      const lat = +m[2]; return { lat, lng: +m[3], mpp: 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, +m[1]) }; }
    m = location.href.match(/@(-?\d+\.\d+),(-?\d+\.\d+),(\d+(?:\.\d+)?)([zm])/); if (!m) return null;
    const lat = +m[1], lng = +m[2], n = +m[3];
    // 'z' = zoom level; 'm' = height of the visible map in metres (satellite / 3D view)
    const mpp = m[4] === 'z' ? 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, n) : n / el.clientHeight;
    return { lat, lng, mpp };
  }
  function toLatLng(v, dx, dy) {
    const Z = Math.log2(156543.03392 * Math.cos(v.lat * Math.PI / 180) / v.mpp), S = 256 * Math.pow(2, Z);
    const x0 = (v.lng + 180) / 360 * S, s = Math.sin(v.lat * Math.PI / 180), y0 = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * S;
    const x = x0 + dx, y = y0 + dy;
    return [Math.atan(Math.sinh(Math.PI * (1 - 2 * y / S))) * 180 / Math.PI, x / S * 360 - 180];
  }

  function onMove(e) {
    if (!enabled || pinned) return;
    if (e.buttons || Date.now() - lastWheel < 900) { hide(); return; }
    const el = mapEl(e.target); if (!el) { hide(); return; }
    const v = view(el); if (!v) { hide(); return; }
    const r = el.getBoundingClientRect();
    const [lat, lng] = toLatLng(v, e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
    lastPt = [e.clientX, e.clientY];
    if (lat < 18.5 || lat > 72 || lng < -180 || lng > -64) { hide(); return; }
    if (v.mpp > 250) { msgCard('Buildocrat Value Lens: zoom in closer to see values here.'); place(e.clientX, e.clientY); return; }
    clearTimeout(timer);
    timer = setTimeout(() => {
      const my = ++seq;
      chrome.runtime.sendMessage({ t: 'value', lat, lng }).then(res => {
        if (my !== seq || pinned) return;
        if (!res || res.outside) { hide(); return; }
        if (res.error === 'loading' || (res.error && /counties|places|tracts|fetch/i.test(res.error))) { msgCard(res.error === 'loading' ? 'Loading values…' : 'Values unavailable right now.'); }
        else if (res.error) { msgCard('Values unavailable right now.'); }
        else render(res);
        if (lastPt) place(lastPt[0], lastPt[1]);
      }).catch(() => {});
    }, 90);
  }
  addEventListener('mousemove', onMove, { passive: true, capture: true });
  addEventListener('wheel', () => { lastWheel = Date.now(); hide(); }, { passive: true, capture: true });
  addEventListener('mousedown', e => { if (!card.contains(e.target) && e.composedPath()[0] !== hostEl) { if (!pinned) hide(); } }, { capture: true });
  addEventListener('keydown', e => {
    if (e.key === 'Shift' && enabled && !card.hidden && lastRes && !pinned) { pinned = true; card.classList.add('pin'); render(lastRes); }
    else if (e.key === 'Escape') hide(true);
  }, { capture: true });
  addEventListener('blur', () => { if (!pinned) hide(); });
  chrome.runtime.sendMessage({ t: 'warm' }).catch(() => {});
})();
