/* Install-as-app support for every page: registers the service worker and drives the "Install app" buttons ([data-install]). */
(() => {
  'use strict';
  /* the map page registers the offline cache only once its data has arrived, so slow connections download the data once, not twice */
  const regSW = () => navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  if ('serviceWorker' in navigator) { if (document.getElementById('mapsec')) addEventListener('usvb-ready', regSW, { once: true }); else addEventListener('load', regSW); }
  const ua = navigator.userAgent;
  const standalone = () => matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: window-controls-overlay)').matches || navigator.standalone === true;
  const ios = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const inApp = /FBAN|FBAV|Instagram|Line\/|WhatsApp|Snapchat|TikTok/i.test(ua);
  let deferred = null;
  const buttons = () => document.querySelectorAll('[data-install]');
  const show = on => buttons().forEach(b => { b.hidden = !on; });
  if (standalone()) document.documentElement.classList.add('is-app');

  addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; if (!standalone()) { show(true); maybeBanner(); } });
  addEventListener('appinstalled', () => { deferred = null; show(false); hideBanner(); toast('Installed. Open “US Land Values” from your home screen or apps.'); });
  const ready = () => { if (!standalone() && (ios || inApp)) show(true); };
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', ready) : ready();

  document.addEventListener('click', e => { const b = e.target.closest('[data-install]'); if (!b) return; e.preventDefault(); install(); });
  async function install() {
    hideBanner();
    if (deferred) { const d = deferred; deferred = null; try { d.prompt(); const r = await d.userChoice; if (r && r.outcome !== 'accepted') snooze(); } catch (err) { help(); } return; }
    help();
  }

  /* ---------- the automatic install prompt: a card that slides up a few seconds after arrival ---------- */
  const KEY = 'usvb-install-snoozed', WEEK = 7 * 864e5;
  const snoozed = () => { try { return Date.now() - (+localStorage.getItem(KEY) || 0) < WEEK; } catch (e) { return false; } };
  const snooze = () => { try { localStorage.setItem(KEY, String(Date.now())); } catch (e) {} };
  let banner = null, due = false;
  setTimeout(() => { due = true; maybeBanner(); }, /\bsource=app\b/.test(location.search) ? 1e9 : 4500);
  function maybeBanner() {
    if (!due || banner || standalone() || snoozed() || !(deferred || ios || inApp)) return;
    if (document.querySelector('dialog[open]')) return;
    style();
    const sub = inApp ? 'Open this page in Chrome or Safari to install the free app.' : ios ? 'Add it to your home screen: free, works offline on site, updated weekly.' : 'Free app. Opens full screen, works offline on site, updated every week.';
    banner = document.createElement('div'); banner.className = 'pwa-banner'; banner.setAttribute('role', 'dialog'); banner.setAttribute('aria-label', 'Install the US Land Values app');
    banner.innerHTML = `<img src="/icons/icon-192.png" alt="" width="48" height="48"><div class="tx"><b>Install the US Land Values app</b><span>${sub}</span></div>
      <div class="ac"><button type="button" class="go">${deferred ? 'Install' : 'Show me how'}</button><button type="button" class="no">Not now</button></div>
      <button type="button" class="x" aria-label="Close">×</button>`;
    document.body.appendChild(banner);
    banner.querySelector('.go').onclick = install;
    banner.querySelector('.no').onclick = banner.querySelector('.x').onclick = () => { snooze(); hideBanner(); };
    requestAnimationFrame(() => { banner.classList.add('on'); document.documentElement.classList.add('pwa-on'); document.documentElement.style.setProperty('--pwa-h', banner.offsetHeight + 'px'); });
  }
  function hideBanner() {
    if (!banner) return; const b = banner; banner = null; b.classList.remove('on'); document.documentElement.classList.remove('pwa-on');
    setTimeout(() => b.remove(), 300);
  }

  let css = false;
  function style() {
    if (css) return; css = true;
    const s = document.createElement('style');
    s.textContent = `.pwa-sheet{border:0;padding:0;border-radius:22px;max-width:min(440px,calc(100vw - 32px));width:100%;background:#fff;color:#22275A;box-shadow:0 24px 60px rgba(14,20,80,.35);font:15px/1.5 Poppins,system-ui,sans-serif}
.pwa-sheet::backdrop{background:rgba(14,18,60,.45)}
.pwa-sheet .hd{background:#1D2675;color:#fff;padding:18px 22px;display:flex;gap:14px;align-items:center}
.pwa-sheet .hd img{width:48px;height:48px;border-radius:12px;background:#fff}
.pwa-sheet h2{margin:0;font:700 18px/1.2 Poppins,system-ui,sans-serif}.pwa-sheet .hd p{margin:2px 0 0;font-size:13px;opacity:.85}
.pwa-sheet ol{margin:0;padding:18px 22px 6px 22px;list-style:none;counter-reset:s}
.pwa-sheet li{counter-increment:s;display:flex;gap:12px;align-items:flex-start;margin:0 0 12px}
.pwa-sheet li:before{content:counter(s);flex:0 0 26px;height:26px;border-radius:50%;background:#DCDFF2;color:#1D2675;font-weight:700;display:grid;place-items:center;font-size:13px}
.pwa-sheet .ico{display:inline-block;vertical-align:-4px;width:18px;height:18px;color:#1D2675}
.pwa-sheet .why{margin:0 22px 14px;padding:10px 14px;background:#F8DDD4;border-radius:12px;font-size:13px}
.pwa-sheet .ft{padding:0 22px 20px;text-align:right}.pwa-sheet button{font:600 14px Poppins,system-ui,sans-serif;background:#1D2675;color:#fff;border:0;border-radius:999px;padding:10px 22px;cursor:pointer}
@media (prefers-color-scheme:dark){.pwa-sheet{background:#171B47;color:#E7E9FA}.pwa-sheet li:before{background:#2C3270;color:#E7E9FA}.pwa-sheet .ico{color:#C9CEFF}.pwa-sheet .why{background:#3a2a3a}}
.pwa-toast{position:fixed;left:50%;bottom:86px;transform:translateX(-50%);z-index:2147483000;background:#1D2675;color:#fff;font:600 14px Poppins,system-ui,sans-serif;padding:12px 18px;border-radius:999px;box-shadow:0 10px 26px rgba(14,20,80,.3);max-width:calc(100vw - 32px);text-align:center}
.pwa-banner{position:fixed;left:50%;bottom:16px;z-index:2147482000;width:min(560px,calc(100vw - 24px));transform:translate(-50%,calc(100% + 40px));transition:transform .35s cubic-bezier(.2,.8,.2,1);
  display:grid;grid-template-columns:48px 1fr auto;gap:12px 14px;align-items:center;background:#fff;color:#22275A;border-radius:20px;padding:14px 40px 14px 14px;
  box-shadow:0 18px 50px rgba(14,20,80,.28),0 0 0 1px rgba(29,38,117,.08);font:14px/1.4 Poppins,system-ui,sans-serif}
.pwa-banner.on{transform:translate(-50%,0)}
.pwa-banner img{width:48px;height:48px;border-radius:12px}
.pwa-banner .tx b{display:block;color:#1D2675;font-size:15px}.pwa-banner .tx span{color:#5E638E;font-size:13px}
.pwa-banner .ac{display:flex;flex-direction:column;gap:4px}
.pwa-banner .go{font:600 14px Poppins,system-ui,sans-serif;background:#E8725B;color:#fff;border:0;border-radius:999px;padding:9px 20px;cursor:pointer;white-space:nowrap}
.pwa-banner .no{font:500 12.5px Poppins,system-ui,sans-serif;background:none;border:0;color:#5E638E;cursor:pointer;padding:2px}
.pwa-banner .x{position:absolute;top:6px;right:8px;width:30px;height:30px;border:0;background:none;color:#5E638E;font-size:22px;line-height:1;cursor:pointer;border-radius:50%}
.pwa-banner button:focus-visible{outline:3px solid #1D2675;outline-offset:2px}
html.pwa-on .wa{bottom:calc(var(--pwa-h,0px) + 28px)!important;transition:bottom .35s}
@media (max-width:520px){.pwa-banner{grid-template-columns:44px 1fr;bottom:10px}.pwa-banner img{width:44px;height:44px}.pwa-banner .ac{grid-column:1/-1;flex-direction:row-reverse;justify-content:flex-start;align-items:center;gap:10px}.pwa-banner .go{flex:1}}
@media (prefers-color-scheme:dark){.pwa-banner{background:#171B47;color:#E7E9FA;box-shadow:0 18px 50px rgba(0,0,0,.5),0 0 0 1px #2C3270}.pwa-banner .tx b{color:#C9CEFF}.pwa-banner .tx span,.pwa-banner .no,.pwa-banner .x{color:#A3A8D6}}
@media (prefers-reduced-motion:reduce){.pwa-banner{transition:none}}`;
    document.head.appendChild(s);
  }
  const SHARE = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 11v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8"/></svg>';
  const DOTS = '<svg class="ico" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';
  function help() {
    style();
    let steps;
    if (inApp) steps = [`Tap ${DOTS} or the ••• menu in this app and choose <b>Open in browser</b> (Chrome or Safari).`, 'Then tap <b>Install app</b> on valued.buildocrat.store again.'];
    else if (ios) steps = [`Tap the <b>Share</b> button ${SHARE} in Safari’s toolbar.`, 'Scroll down and tap <b>Add to Home Screen</b>.', 'Tap <b>Add</b>. “US Land Values” appears on your home screen.'];
    else if (/android/i.test(ua)) steps = [`Tap the browser menu ${DOTS} at the top right.`, 'Tap <b>Install app</b> or <b>Add to Home screen</b>.', 'Confirm. “US Land Values” appears with your apps.'];
    else steps = ['In Chrome or Edge, click the install icon at the right end of the address bar, or open the browser menu.', 'Choose <b>Install US Land Value Book</b> (Chrome: Cast, save and share › Install page as app).', 'It opens in its own window and appears with your apps.'];
    const d = document.createElement('dialog'); d.className = 'pwa-sheet'; d.setAttribute('aria-labelledby', 'pwaT');
    d.innerHTML = `<div class="hd"><img src="/icons/icon-192.png" alt=""><div><h2 id="pwaT">Install US Land Values</h2><p>valued.buildocrat.store as an app</p></div></div>
      <ol>${steps.map(s => `<li><span>${s}</span></li>`).join('')}</ol>
      <p class="why">Opens full screen from your home screen, starts faster, and keeps last week’s values for when you’re offline.</p>
      <div class="ft"><button type="button" autofocus>Got it</button></div>`;
    document.body.appendChild(d);
    d.querySelector('button').onclick = () => d.close();
    d.addEventListener('close', () => d.remove());
    d.addEventListener('click', e => { if (e.target === d) d.close(); });
    d.showModal();
  }
  function toast(t) { style(); const el = document.createElement('div'); el.className = 'pwa-toast'; el.setAttribute('role', 'status'); el.textContent = t; document.body.appendChild(el); setTimeout(() => el.remove(), 5000); }
})();
