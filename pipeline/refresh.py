"""One command for the weekly refresh:  python pipeline/refresh.py [--fetch]

(--fetch: download the fast-changing sources first: FHFA price indexes and land prices, HUD rents, USDA farmland, Census build costs)
model -> sanity check -> pages -> extension -> config.js, cache-busting and a new app (service worker) version.
A failed sanity check stops the run, so a bad week never goes live.
"""
import os, sys, subprocess, json, shutil, hashlib, re

HERE = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.join(HERE, '..', 'docs')
py = sys.executable


def run(*a):
    print('\n==>', ' '.join(a), flush=True)
    subprocess.run([py, *a], cwd=HERE, check=True)


if '--fetch' in sys.argv:
    r = subprocess.run([py, 'fetch.py', 'hpi', 'fmr', 'fhfa_land', 'nass', 'soc'], cwd=HERE)
    if r.returncode:
        print('All fetches failed; rebuilding from the files already in pipeline/raw.')
os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
prev = os.path.join(DOCS, 'data', 'counties.json')
if os.path.exists(prev):
    shutil.copy(prev, os.path.join(HERE, 'out', 'prev_counties.json'))
for s in ('model.py', 'sanity.py', 'pages.py', 'pack.py', 'build_extension.py'):
    run(s)

# browser config (public keys only)
cfg = json.load(open(os.path.join(HERE, '..', 'site-config.json')))
pub = {'mapboxToken': cfg.get('mapbox_token', ''), 'styleSatellite': cfg.get('mapbox_style_satellite'), 'styleStreets': cfg.get('mapbox_style_streets')}
open(os.path.join(DOCS, 'config.js'), 'w').write('window.LB_CONFIG=' + json.dumps(pub) + ';\n')

# cache-busting: point index.html at the current versions of config.js and app.js
idx = os.path.join(DOCS, 'index.html'); html = open(idx, encoding='utf-8').read()
for f in ('config.js', 'app.js', 'pwa.js'):
    h = hashlib.md5(open(os.path.join(DOCS, f), 'rb').read()).hexdigest()[:8]
    html = re.sub(r'src="%s(\?v=[0-9a-f]+)?"' % re.escape(f), 'src="%s?v=%s"' % (f, h), html)
open(idx, 'w', encoding='utf-8').write(html)
print('cache-busted index.html')

# installed app: a new service-worker version each edition, so phones pick up the new week's shell and data
swp = os.path.join(DOCS, 'sw.js'); sw = open(swp, encoding='utf-8').read()
hv = hashlib.md5(b''.join(open(os.path.join(DOCS, f), 'rb').read() for f in ('index.html', 'app.js', 'config.js', 'pwa.js', 'data/counties.json'))).hexdigest()[:10]
open(swp, 'w', encoding='utf-8').write(re.sub(r"const VERSION = '[^']*';", "const VERSION = '%s';" % hv, sw))
print('service worker version', hv)
print('\nRefresh complete.')
