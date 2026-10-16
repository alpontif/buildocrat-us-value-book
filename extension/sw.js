/* Buildocrat Value Lens: background service worker. Loads the US Land Value Book data once and answers value lookups. */
importScripts('core.js');
const DEFAULT_BASE = 'https://valued.buildocrat.store/';
let loading = null;

async function base() {
  const s = await chrome.storage.local.get('dataBase');
  return s.dataBase || DEFAULT_BASE;
}
function ensure() {
  if (VL.isLoaded()) return Promise.resolve();
  if (!loading) loading = base().then(b => VL.load(b)).catch(err => { loading = null; throw err; });
  return loading;
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg && msg.t === 'value') {
    ensure().then(() => reply(VL.valueAt(+msg.lat, +msg.lng))).catch(err => reply({ error: String(err && err.message || err) }));
    return true; // async reply
  }
  if (msg && msg.t === 'warm') { ensure().then(() => reply({ ok: true }), err => reply({ error: String(err) })); return true; }
});

chrome.commands.onCommand.addListener(async cmd => {
  if (cmd !== 'toggle-lens') return;
  const s = await chrome.storage.local.get('enabled');
  await chrome.storage.local.set({ enabled: s.enabled === false });
});

chrome.runtime.onInstalled.addListener(async () => {
  const s = await chrome.storage.local.get(['enabled', 'tab']);
  await chrome.storage.local.set({ enabled: s.enabled !== false, tab: s.tab || 'land' });
});
