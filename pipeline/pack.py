"""Split the weekly data into a small first-view summary and per-state chunks.

The homepage used to wait on counties.json, places.bin, tracts.bin and evidence.json
(about 7 MB on the wire) before it could draw a number. This writes:

  docs/data/pkg/summary.<hash>.bin     states, county headlines, city dots. Under 100 KB gzip.
  docs/data/pkg/c/<ST>.<hash>.bin      one state's county values (no outlines)
  docs/data/pkg/g/<ST>.<hash>.bin      one state's county outlines and border
  docs/data/pkg/p/<ST>.<hash>.bin      one state's places
  docs/data/pkg/t/<ST>.<hash>.bin      one state's census tracts
  docs/data/pkg/e/<ST>.<hash>.bin      one state's published ZIP land prices
  docs/data/pkg/zips.<hash>.bin        ZIP code to place index

Dollar figures are copied, not recomputed. Outlines are copied unchanged so a click
still lands in the same county. Evidence coordinates are rounded to 0.001 degree
and the constant price-year column is dropped; the page still shows 2015.

Also fills the headline numbers and the first page of each table into docs/index.html,
names the summary with its content hash, and trims fonts and the analytics tag on every page.
"""
import gzip, hashlib, json, os, re, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.join(HERE, '..', 'docs')
DATA = os.path.join(DOCS, 'data')
PKG = os.path.join(DATA, 'pkg')

SQFT_ACRE = 43560
QLOT = 10890
MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
SC = {'AL': 'Alabama', 'AK': 'Alaska', 'AZ': 'Arizona', 'AR': 'Arkansas', 'CA': 'California', 'CO': 'Colorado', 'CT': 'Connecticut', 'DE': 'Delaware', 'DC': 'District of Columbia', 'FL': 'Florida', 'GA': 'Georgia', 'HI': 'Hawaii', 'ID': 'Idaho', 'IL': 'Illinois', 'IN': 'Indiana', 'IA': 'Iowa', 'KS': 'Kansas', 'KY': 'Kentucky', 'LA': 'Louisiana', 'ME': 'Maine', 'MD': 'Maryland', 'MA': 'Massachusetts', 'MI': 'Michigan', 'MN': 'Minnesota', 'MS': 'Mississippi', 'MO': 'Missouri', 'MT': 'Montana', 'NE': 'Nebraska', 'NV': 'Nevada', 'NH': 'New Hampshire', 'NJ': 'New Jersey', 'NM': 'New Mexico', 'NY': 'New York', 'NC': 'North Carolina', 'ND': 'North Dakota', 'OH': 'Ohio', 'OK': 'Oklahoma', 'OR': 'Oregon', 'PA': 'Pennsylvania', 'RI': 'Rhode Island', 'SC': 'South Carolina', 'SD': 'South Dakota', 'TN': 'Tennessee', 'TX': 'Texas', 'UT': 'Utah', 'VT': 'Vermont', 'VA': 'Virginia', 'WA': 'Washington', 'WV': 'West Virginia', 'WI': 'Wisconsin', 'WY': 'Wyoming'}
REG = {'CT': 'NE', 'ME': 'NE', 'MA': 'NE', 'NH': 'NE', 'RI': 'NE', 'VT': 'NE', 'NJ': 'NE', 'NY': 'NE', 'PA': 'NE', 'IL': 'MW', 'IN': 'MW', 'MI': 'MW', 'OH': 'MW', 'WI': 'MW', 'IA': 'MW', 'KS': 'MW', 'MN': 'MW', 'MO': 'MW', 'NE': 'MW', 'ND': 'MW', 'SD': 'MW', 'AZ': 'W', 'CO': 'W', 'ID': 'W', 'MT': 'W', 'NV': 'W', 'NM': 'W', 'UT': 'W', 'WY': 'W', 'AK': 'W', 'CA': 'W', 'HI': 'W', 'OR': 'W', 'WA': 'W'}
TYPEN = ['City', 'Town', 'Community', 'ZIP code', 'Neighborhood', 'Village', 'Hamlet', 'Subdivision', 'Gated community']
URBAN_T = {0, 1, 2, 3, 4, 7, 8}
ZONEC = ['#1D2675', '#3C49A1', '#7D87CA', '#B7BCE6', '#E8725B', '#F2A28E', '#CDB9A6']
CONF = [('H', 'High'), ('M', 'Medium'), ('L', 'Low'), ('X', 'Modelled')]
VK = ['res', 'hv', 'hvlo', 'hvhi', 'rent1', 'rent2', 'rent3', 'rent4', 'resU', 'resR', 'lo', 'hi', 'farm']
# analytics loads after window "load", so it does not compete with the first view
GTAG = '''<!-- Google tag (gtag.js) -->
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-QLGW0K3YY7');
  window.addEventListener('load', function () {
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=G-QLGW0K3YY7';
    document.head.appendChild(s);
  });
</script>
<script>
document.addEventListener('click', function (event) {
  var a = event.target && event.target.closest && event.target.closest('a');
  if (!a || !a.href) return;
  var url = a.href, host = '';
  try { host = new URL(url).hostname; } catch (err) { return; }
  if (host === 'wa.me' || host === 'api.whatsapp.com') gtag('event', 'whatsapp_click', {link_url: url});
  else if (url.indexOf('mailto:') === 0) gtag('event', 'email_click', {link_url: url});
});
</script>
'''
FONT_OLD = 'family=Poppins:wght@400;500;600;700;800'
FONT_NEW = 'family=Poppins:wght@400;600;800'


def js_round(n):
    import math
    return math.floor(n + 0.5) if n >= 0 else math.ceil(n - 0.5)


def trim0(s):
    if '.' in s:
        s = s.rstrip('0').rstrip('.')
    return s


def short(n):
    """Same display as app.js short()."""
    if n is None:
        return '\u2013'
    try:
        if n != n:
            return '\u2013'
    except TypeError:
        return '\u2013'
    if n >= 1e9:
        return '$' + trim0(f'{n / 1e9:.2f}') + 'B'
    if n >= 1e6:
        v = n / 1e6
        d = 0 if v >= 100 else (1 if v >= 10 else 2)
        return '$' + trim0(f'{v:.{d}f}') + 'M'
    if n >= 1e4:
        v = n / 1e3
        d = 0 if v >= 100 else 1
        return '$' + trim0(f'{v:.{d}f}') + 'K'
    if n >= 100:
        return '$' + f'{js_round(n):,}'
    if n >= 10:
        return '$' + trim0(f'{n:.1f}')
    return '$' + f'{n:.2f}'


def fmt_l(k, v):
    if v is None:
        return '\u2013'
    if k in ('yld', 'lsh'):
        return f'{v:.1f}%'
    return short(v)


def nfmt(n):
    return f'{int(n):,}'


def dlong(iso):
    y, m, d = (int(x) for x in iso.split('-'))
    return f'{MONTHS[m - 1]} {d}, {y}'


def region_of(st):
    return REG.get(st, 'S')


def derive(v, st, build):
    v = dict(v)
    v['acre'] = (v['res'] * SQFT_ACRE) if v.get('res') else None
    v['bcost'] = (build or {}).get(region_of(st))
    v['lsh'] = None
    v['str'] = None
    if v.get('hv') and v.get('res'):
        lot = v['res'] * QLOT
        if lot < 0.85 * v['hv']:
            v['lsh'] = max(1, 100 * lot / v['hv'])
            v['str'] = v['hv'] - lot
    v['yld'] = (100 * 12 * v['rent2'] / v['hv']) if v.get('rent2') and v.get('hv') else None
    return v


def esc(s):
    return (str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;'))


def gz_dumps(obj):
    raw = json.dumps(obj, separators=(',', ':'), ensure_ascii=False).encode()
    return gzip.compress(raw, 9, mtime=0)


def gunzip_json(path):
    raw = open(path, 'rb').read()
    if raw[:2] == b'\x1f\x8b':
        raw = gzip.decompress(raw)
    return json.loads(raw)


def undelta(a):
    out = []
    last = 0
    for x in a:
        last += x
        out.append(last)
    return out


def deltas(a):
    out = []
    last = 0
    for x in a:
        out.append(int(x) - last)
        last = int(x)
    return out


def hid(blob):
    return hashlib.md5(blob).hexdigest()[:8]


def put(rel, blob):
    """Write blob to docs/data/<rel without hash>, return hashed relative path under data/."""
    # rel like 'pkg/c/TX.bin' -> pkg/c/TX.<hash>.bin
    base, ext = rel.rsplit('.', 1)
    name = f'{base}.{hid(blob)}.{ext}'
    path = os.path.join(DATA, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, 'wb').write(blob)
    return name


def state_spans(keys):
    spans = {}
    for i, st in enumerate(keys):
        if st not in spans:
            spans[st] = [i, i]
        spans[st][1] = i
    return spans


def val_row(v):
    return [None if v.get(k) is None else v.get(k) for k in VK]


def conf_cell(c):
    pair = CONF[c] if 0 <= c < len(CONF) else CONF[3]
    klass = 'L' if pair[0] == 'X' else pair[0]
    return f'<span class="pill c-{klass}">{pair[1]}</span>'


def cells_v(v, tab='land'):
    cols = {'land': ['res', 'acre', 'lsh', 'farm'], 'bld': ['hvlo', 'hv', 'hvhi', 'str', 'bcost'], 'rent': ['rent1', 'rent2', 'rent3', 'rent4', 'yld']}[tab]
    hc = {'land': 0, 'bld': 1, 'rent': 1}[tab]
    out = []
    for n, k in enumerate(cols):
        inner = fmt_l(k, v.get(k))
        if n == hc:
            inner = f'<b>{inner}</b>'
        out.append(f'<td class="r num">{inner}</td>')
    return ''.join(out)


def build_chunks():
    if os.path.isdir(PKG):
        shutil.rmtree(PKG)
    os.makedirs(PKG)
    counties_doc = json.load(open(os.path.join(DATA, 'counties.json')))
    places = gunzip_json(os.path.join(DATA, 'places.bin'))
    tracts = gunzip_json(os.path.join(DATA, 'tracts.bin'))
    evidence = json.load(open(os.path.join(DATA, 'evidence.json')))
    meta = dict(counties_doc['meta'])
    states = counties_doc['states']
    counties = counties_doc['counties']
    borders = counties_doc['borders']
    meta = json.loads(json.dumps(meta))
    meta.setdefault('counts', {})
    meta['counts']['evidence'] = len(evidence)
    meta['counts']['zipPlaces'] = sum(1 for t in places['t'] if t == 3)

    st_of = [c['s'] for c in counties]
    cspan = state_spans(st_of)
    pla, plo = undelta(places['la']), undelta(places['lo'])
    tla, tlo = undelta(tracts['la']), undelta(tracts['lo'])
    # parents, same rule as app.js
    pa = [-1] * len(places['n'])
    k = 0
    for dd, p in zip(places.get('pk') or [], places.get('pp') or []):
        k += dd
        pa[k] = p
    pspan = state_spans([st_of[g] for g in places['g']])
    tspan = state_spans([st_of[g] for g in tracts['g']])
    ev_by = {st: [] for st in cspan}
    for i, e in enumerate(evidence):
        ev_by[e[6]].append([e[0], e[1], round(e[2], 3), round(e[3], 3), e[4], i])

    files = {'c': {}, 'g': {}, 'p': {}, 't': {}, 'e': {}, 'borderOrder': [b['c'] for b in borders]}
    border_of = {b['c']: b['r'] for b in borders}

    for st, (a, b) in cspan.items():
        rows = []
        rings = []
        for c in counties[a:b + 1]:
            v = c['v']
            rows.append([c['mi2'], c.get('cb') or '', c['nt'], c['np'], c['conf'], c['lat'], c['lng'], c['cls'], val_row(v), c.get('zs') or []])
            rings.append(c['r'])
        files['c'][st] = put(f'pkg/c/{st}.bin', gz_dumps({'b': a, 'rows': rows}))
        files['g'][st] = put(f'pkg/g/{st}.bin', gz_dumps({'b': a, 'r': rings, 'border': border_of.get(st) or []}))

    for st, (a, b) in pspan.items():
        sl = slice(a, b + 1)
        n = b - a + 1
        pk, pp, last = [], [], 0
        for i in range(n):
            p = pa[a + i]
            if p >= 0:
                pk.append(i - last)
                pp.append(p - a)
                last = i
        obj = {
            'b': a,
            'n': places['n'][sl], 't': places['t'][sl], 'g': places['g'][sl],
            'la': deltas(pla[sl]), 'lo': deltas(plo[sl]),
            'v': places['v'][sl], 'h': places['h'][sl], 'r': places['r'][sl],
            'z': places['z'][sl], 'c': places['c'][sl], 'pk': pk, 'pp': pp,
        }
        files['p'][st] = put(f'pkg/p/{st}.bin', gz_dumps(obj))

    for st, (a, b) in tspan.items():
        sl = slice(a, b + 1)
        obj = {'b': a, 'la': deltas(tla[sl]), 'lo': deltas(tlo[sl])}
        for key in ('g', 'v', 'h', 'hl', 'hh', 'r1', 'r2', 'r3', 'r4', 'z', 'c'):
            obj[key] = tracts[key][sl]
        files['t'][st] = put(f'pkg/t/{st}.bin', gz_dumps(obj))

    for st, rows in ev_by.items():
        files['e'][st] = put(f'pkg/e/{st}.bin', gz_dumps(rows))

    zips = {}
    for i, t in enumerate(places['t']):
        if t == 3:
            zips[places['n'][i][-5:]] = [i, places['g'][i]]
    files['z'] = put('pkg/zips.bin', gz_dumps(zips))
    files['pb'] = {st: [a, b] for st, (a, b) in pspan.items()}

    # summary: headlines the first view can sort and search. City dots are a separate small file,
    # fetched when someone searches or opens the map, so the first view stays under 100 KB.
    slim = [[c['n'], c['s'], c['cls'], c['lat'], c['lng'], c['f'], c['v'].get('res'), c['v'].get('hv'), c['v'].get('rent2')] for c in counties]
    cities = []
    for i, t in enumerate(places['t']):
        if t == 0:
            cities.append([places['n'][i], i, places['g'][i], places['v'][i], places['h'][i], places['r'][i], places['z'][i], places['c'][i], pla[i], plo[i]])
    files['cities'] = put('pkg/cities.bin', gz_dumps(cities))
    summary = {'meta': meta, 'states': states, 'counties': slim, 'files': files}
    blob = gz_dumps(summary)
    if len(blob) > 100 * 1024:
        raise SystemExit(f'summary is {len(blob)} bytes gzip, over the 100 KB budget')
    files_name = put('pkg/summary.bin', blob)
    print(f'summary {files_name} {len(blob)} bytes gzip, {len(cities)} cities, {len(slim)} counties')
    return {
        'summary': files_name, 'meta': meta, 'states': states, 'counties': counties, 'places': places,
        'pla': pla, 'plo': plo, 'pa': pa, 'evidence': evidence, 'files': files,
    }


def place_vals(j, ctx):
    """Same inputs placeVals() uses, so a prerendered row matches the live table."""
    pl, counties, pla = ctx['places'], ctx['counties'], ctx['pla']
    g = counties[pl['g'][j]]
    gv = g['v']
    o = {'res': pl['v'][j] / 100, 'hv': pl['h'][j] * 100, 'rent2': pl['r'][j] or None, 'zone': pl['z'][j]}
    rh = (o['hv'] / gv['hv']) if gv.get('hv') else 1
    rr = (o['rent2'] / gv['rent2']) if gv.get('rent2') and o['rent2'] else (rh ** 0.45)
    o['hvlo'] = gv['hvlo'] * rh if gv.get('hvlo') else None
    o['hvhi'] = gv['hvhi'] * rh if gv.get('hvhi') else None
    for k in ('rent1', 'rent2', 'rent3', 'rent4'):
        if k == 'rent2':
            continue
        o[k] = gv[k] * rr if gv.get(k) else None
    if not o['rent2'] and gv.get('rent2'):
        o['rent2'] = gv['rent2'] * rr
    t = pl['t'][j]
    o['farm'] = gv.get('farm') if (gv.get('farm') and t not in URBAN_T) else (gv.get('farm') if t in (5, 6) else None)
    if o.get('rent1') and o.get('rent2'):
        o['rent2'] = max(o['rent2'], o['rent1'] * 1.08)
    if o.get('rent2') and o.get('rent3'):
        o['rent3'] = max(o['rent3'], o['rent2'] * 1.1)
    if o.get('rent3') and o.get('rent4'):
        o['rent4'] = max(o['rent4'], o['rent3'] * 1.08)
    if o.get('hvlo') and o.get('hv'):
        o['hvlo'] = min(o['hvlo'], o['hv'])
    if o.get('hvhi') and o.get('hv'):
        o['hvhi'] = max(o['hvhi'], o['hv'])
    return derive(o, g['s'], ctx['meta']['build']), g


def th(cols, key):
    parts = []
    for c in cols:
        arrow = ' \u2193' if c.get('k') == key else ''
        cls = ' class="r"' if c.get('r') else ''
        parts.append(f'<th data-k="{c["k"]}"{cls}>{c["h"]}{arrow}</th>')
    return '<thead><tr>' + ''.join(parts) + '</tr></thead>'


def pager(page, pages, rows, noun):
    prev = 'disabled' if page <= 0 else ''
    nxt = 'disabled' if page >= pages - 1 else ''
    return (f'<button class="btn ghost sm" type="button" data-p="-1" {prev}>Previous</button>'
            f'<span>Page {page + 1} of {nfmt(pages)} \u00b7 {nfmt(rows)} {noun}</span>'
            f'<button class="btn ghost sm" type="button" data-p="1" {nxt}>Next</button>')


def prerender(ctx):
    meta, states, counties = ctx['meta'], ctx['states'], ctx['counties']
    build = meta['build']
    date = dlong(meta['date'])
    ev_n = meta['counts']['evidence']
    for s in states:
        s['_v'] = derive(s['v'], s['c'], build)
    for c in counties:
        c['_v'] = derive(c['v'], c['s'], build)
        zs = c.get('zs') or []
        best = max(zs, key=lambda r: r[1]) if zs else None
        c['_v']['zone'] = best[0] if best else None

    # state table, land tab, sorted by residential land descending (the live table's default)
    st_rows = sorted(states, key=lambda s: -(s['_v'].get('res') or 0))
    st_body = []
    for s in st_rows:
        v = s['_v']
        st_body.append(
            f'<tr data-go="s:{s["c"]}" style="cursor:pointer"><td class="code mono">{s["c"]}</td>'
            f'<td class="nm">{esc(SC[s["c"]])}</td><td>{esc(s["big"])}</td>{cells_v(v)}'
            f'<td class="r num">{short(v.get("resR"))}</td><td class="r num">{s["nc"]}</td><td>{conf_cell(s["conf"])}</td></tr>')
    st_head = th([
        {'k': 'c', 'h': 'Code'}, {'k': 'name', 'h': 'State'}, {'k': 'big', 'h': 'Largest city'},
        {'k': 'res', 'h': 'Land $/sq ft', 'r': 1}, {'k': 'acre', 'h': '$/acre', 'r': 1},
        {'k': 'lsh', 'h': 'Land share', 'r': 1}, {'k': 'farm', 'h': 'Farmland $/acre', 'r': 1},
        {'k': 'resR', 'h': 'Rural land $/sq ft', 'r': 1}, {'k': 'nc', 'h': 'Counties', 'r': 1}, {'k': 'conf', 'h': 'Conf.'},
    ], 'res')

    # counties, first page by residential land
    lg = sorted(enumerate(counties), key=lambda it: -(it[1]['_v'].get('res') or 0))
    cpages = max(1, (len(lg) + 49) // 50)
    c_body = []
    for i, g in lg[:50]:
        v = g['_v']
        cb = (esc(g['cb']) + ' \u00b7 ') if g.get('cb') else ''
        c_body.append(
            f'<tr><td class="nm">{esc(g["n"])}<small>{cb}{nfmt(g["mi2"])} sq mi</small></td>'
            f'<td class="mono">{g["s"]}</td><td class="small">{esc(g["cls"])}</td>{cells_v(v)}'
            f'<td class="r num">{short(v.get("lo"))} \u2013 {short(v.get("hi"))}</td>'
            f'<td class="r num">{nfmt(g["np"])}</td><td class="r num">{g["nt"]}</td><td>{conf_cell(g["conf"])}</td>'
            f'<td><button class="linkbtn" type="button" data-lga="{i}">Map</button></td></tr>')
    c_head = th([
        {'k': 'n', 'h': 'County'}, {'k': 's', 'h': 'State'}, {'k': 'cls', 'h': 'Setting'},
        {'k': 'res', 'h': 'Land $/sq ft', 'r': 1}, {'k': 'acre', 'h': '$/acre', 'r': 1},
        {'k': 'lsh', 'h': 'Land share', 'r': 1}, {'k': 'farm', 'h': 'Farmland $/acre', 'r': 1},
        {'k': 'range', 'h': 'Rural \u2192 core', 'r': 1}, {'k': 'np', 'h': 'Places', 'r': 1},
        {'k': 'nt', 'h': 'Tracts', 'r': 1}, {'k': 'conf', 'h': 'Conf.'}, {'k': '', 'h': ''},
    ], 'res')

    # places, first page by land value (the stored integer, same order as $/sq ft)
    pl = ctx['places']
    order = sorted(range(len(pl['n'])), key=lambda j: -pl['v'][j])
    ppages = max(1, (len(order) + 49) // 50)
    zones = meta.get('zones') or []
    p_body = []
    for j in order[:50]:
        v, g = place_vals(j, ctx)
        parent = ctx['pa'][j]
        within = (esc(pl['n'][parent]) + ' \u00b7 ') if parent >= 0 else ''
        t = pl['t'][j]
        tag = ' u' if t in URBAN_T else ''
        p_body.append(
            f'<tr><td class="nm"><button class="linkbtn" style="font-size:inherit;font-weight:600;text-decoration:none;color:var(--ink)" type="button" data-place="{j}">{esc(pl["n"][j])}</button></td>'
            f'<td class="small"><span class="tag{tag}">{TYPEN[t]}</span></td>'
            f'<td class="small">{within}{esc(g["n"])}</td><td class="mono">{g["s"]}</td>'
            f'<td class="r num"><b>{fmt_l("res", v.get("res"))}</b></td><td class="r num">{short((v.get("res") or 0) * QLOT)}</td>'
            f'<td class="small"><span class="zdot" style="background:{ZONEC[pl["z"][j]]}"></span>{esc(zones[pl["z"][j]] if pl["z"][j] < len(zones) else "")}</td>'
            f'<td>{conf_cell(pl["c"][j])}</td><td><button class="linkbtn" type="button" data-place="{j}">Map</button></td></tr>')
    p_head = ('<thead><tr><th data-k="">Place</th><th data-k="">Level</th><th data-k="">Within \u00b7 County</th><th data-k="">State</th>'
              '<th data-k="" class="r">Land $/sq ft</th><th data-k="" class="r">Quarter-acre lot</th><th data-k="">Tier</th><th data-k="">Conf.</th><th data-k=""></th></tr></thead>')

    ev = sorted(ctx['evidence'], key=lambda e: -e[4])
    epages = max(1, (len(ev) + 49) // 50)
    e_body = []
    for e in ev[:50]:
        e_body.append(
            f'<tr><td class="mono">{esc(e[0])}</td><td class="nm">{esc(e[1])}</td><td class="mono">{e[6]}</td>'
            f'<td class="r num"><b>{short(e[4])}</b></td><td class="r num">{short(e[4] / SQFT_ACRE)}</td><td class="r num">{e[5]}</td>'
            f'<td><button class="linkbtn" type="button" data-at="{e[2]},{e[3]}">Map</button></td></tr>')
    e_head = th([
        {'k': 'z', 'h': 'ZIP code'}, {'k': 'pl', 'h': 'Place'}, {'k': 'st', 'h': 'State'},
        {'k': 'acre', 'h': 'Per acre (published)', 'r': 1}, {'k': 'sf', 'h': 'Per sq ft', 'r': 1},
        {'k': 'yr', 'h': 'Price level', 'r': 1}, {'k': '', 'h': ''},
    ], 'acre')

    # national panel, land tab
    top = sorted(range(len(counties)), key=lambda i: -(counties[i]['_v'].get('res') or 0))[:10]
    top_html = ''.join(
        f'<tr><td><button type="button" data-lga="{i}">{esc(counties[i]["n"])}</button> <span class="muted small">{counties[i]["s"]}</span></td>'
        f'<td class="r">{fmt_l("res", counties[i]["_v"].get("res"))}</td></tr>' for i in top)
    st_html = ''.join(
        f'<tr><td><button type="button" data-go="s:{s["c"]}">{esc(SC[s["c"]])}</button> <span class="muted small">{esc(s["big"])}</span></td>'
        f'<td class="r">{fmt_l("res", s["_v"].get("res"))}</td></tr>'
        for s in sorted(states, key=lambda s: -(s['_v'].get('res') or 0)))
    panel = (
        f'<div class="ptitle"><div><h3>United States</h3><div class="tags"><span class="tag">50 states and DC</span>'
        f'<span class="tag">{nfmt(len(counties))} counties</span><span class="tag">{nfmt(meta["counts"]["places"])} places</span></div></div></div>'
        f'<p class="note">Click a state, a county, a dot or any house on the map, or enter coordinates above. Switch between land, home and rental values with the tabs. Each result gives the ZIP code for the exact spot.</p>'
        f'<div><p class="eyebrow" style="margin-bottom:4px">Highest counties, residential land</p><table class="mini">{top_html}</table></div>'
        f'<div><p class="eyebrow" style="margin-bottom:4px">States, median</p><table class="mini">{st_html}</table></div>')

    idx = os.path.join(DOCS, 'index.html')
    html = open(idx, encoding='utf-8').read()

    def put_marked(html, name, inner):
        start, end = f'<!--APP:{name}-->', f'<!--/APP:{name}-->'
        block = start + inner + end
        pat = re.compile(re.escape(start) + r'.*?' + re.escape(end), re.S)
        if pat.search(html):
            return pat.sub(lambda m: block, html, count=1)
        raise SystemExit('missing marker ' + name)

    # markers are inserted once; create them from the original empty shells if this is the first pack
    if '<!--APP:STABLE-->' not in html:
        html = html.replace(
            '<div class="stats" id="stats">',
            '<!--APP:STATS--><div class="stats" id="stats">', 1)
        html = html.replace(
            '</div>\n    <a class="pintile"',
            '</div><!--/APP:STATS-->\n    <a class="pintile"', 1)
        html = html.replace(
            '<aside class="panel" id="panel" aria-live="polite"><div class="loading">Loading 3,144 counties, 85,000 census tracts and the places directory…</div></aside>',
            '<aside class="panel" id="panel" aria-live="polite"><!--APP:PANEL--><!--/APP:PANEL--></aside>', 1)
        html = html.replace('<table class="t" id="stable"><thead></thead><tbody></tbody></table>',
                            '<table class="t" id="stable"><!--APP:STABLE--><!--/APP:STABLE--></table>', 1)
        html = html.replace('<table class="t" id="ltable"><thead></thead><tbody></tbody></table>',
                            '<table class="t" id="ltable"><!--APP:LTABLE--><!--/APP:LTABLE--></table>', 1)
        html = html.replace('<div class="pager" id="lpager"></div>',
                            '<div class="pager" id="lpager"><!--APP:LPAGER--><!--/APP:LPAGER--></div>', 1)
        html = html.replace('<table class="t" id="ptable"><thead></thead><tbody></tbody></table>',
                            '<table class="t" id="ptable"><!--APP:PTABLE--><!--/APP:PTABLE--></table>', 1)
        html = html.replace('<div class="pager" id="ppager"></div>',
                            '<div class="pager" id="ppager"><!--APP:PPAGER--><!--/APP:PPAGER--></div>', 1)
        html = html.replace('<table class="t" id="etable"><thead></thead><tbody></tbody></table>',
                            '<table class="t" id="etable"><!--APP:ETABLE--><!--/APP:ETABLE--></table>', 1)
        html = html.replace('<div class="pager" id="epager"></div>',
                            '<div class="pager" id="epager"><!--APP:EPAGER--><!--/APP:EPAGER--></div>', 1)
        html = html.replace('<div class="cols" id="methodcols"></div>',
                            '<div class="cols" id="methodcols"><!--APP:METHOD--><!--/APP:METHOD--></div>', 1)
        html = html.replace('<script src="config.js',
                            '<!--APP:DATA--><!--/APP:DATA-->\n<script src="config.js', 1)
        if 'id="maphold"' not in html:
            html = html.replace(
                '<canvas id="map"',
                '<div class="maphold" id="maphold"><p>The satellite map loads when you scroll to it or tap Show map, so these values appear first.</p><button class="btn" type="button" id="showmap">Show map</button></div>\n        <canvas id="map"',
                1)

    stats = (
        f'<div class="stats" id="stats">'
        f'<div><b>51</b><span>states and DC</span></div>'
        f'<div><b id="sCounties">{nfmt(len(counties))}</b><span>counties and equivalents</span></div>'
        f'<div><b id="sTracts">{nfmt(meta["counts"]["tracts"])}</b><span>census tracts valued</span></div>'
        f'<div><b id="sZips">{nfmt(meta["counts"]["zipPlaces"])}</b><span>ZIP codes</span></div>'
        f'<div><b id="sPlaces">{nfmt(meta["counts"]["places"])}</b><span>places, week of <span id="sDate">{date}</span></span></div>'
        f'<div><b id="sEv">{nfmt(ev_n)}</b><span>ZIP codes with published land prices</span></div>'
        f'</div>')
    # The stats marker wraps the div itself, so the replacement includes the div.
    html = put_marked(html, 'STATS', stats)
    html = put_marked(html, 'PANEL', panel)
    html = put_marked(html, 'STABLE', st_head + '<tbody>' + ''.join(st_body) + '</tbody>')
    html = put_marked(html, 'LTABLE', c_head + '<tbody>' + ''.join(c_body) + '</tbody>')
    html = put_marked(html, 'LPAGER', pager(0, cpages, len(lg), 'rows'))
    html = put_marked(html, 'PTABLE', p_head + '<tbody>' + ''.join(p_body) + '</tbody>')
    html = put_marked(html, 'PPAGER', pager(0, ppages, len(order), 'places'))
    html = put_marked(html, 'ETABLE', e_head + '<tbody>' + ''.join(e_body) + '</tbody>')
    html = put_marked(html, 'EPAGER', pager(0, epages, len(ev), 'rows'))
    html = put_marked(html, 'DATA', f'\n<script>window.LB_SUMMARY="data/{ctx["summary"]}";</script>\n')

    html = re.sub(r'(<p class="kicker">US Land Value Book, week of <span id="edDate">)[^<]*(</span>)',
                  rf'\g<1>{date}\g<2>', html, count=1)
    html = re.sub(r'(<span class="evDate">)[^<]*(</span>)', rf'\g<1>{date}\g<2>', html)
    html = re.sub(r'(<span id="hCounties">)[^<]*(</span>)', rf'\g<1>{nfmt(len(counties))}\g<2>', html)
    html = re.sub(r'(<span id="hPlaces">)[^<]*(</span>)', rf'\g<1>{nfmt(meta["counts"]["places"])}\g<2>', html)
    html = html.replace('<link rel="preconnect" href="https://api.mapbox.com" crossorigin>\n', '')
    if '.maphold{' not in html:
        html = html.replace(
            'section{padding-block:44px 8px}',
            '.maphold{position:absolute;inset:0;z-index:4;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;text-align:center;padding:28px;'
            'background:#d9def3 url("/map-preview.svg") center/cover no-repeat}'
            '.maphold p{margin:0;max-width:40ch;font-weight:600;color:var(--navy);background:color-mix(in srgb,var(--surface) 90%,transparent);padding:12px 16px;border-radius:14px}'
            'section{padding-block:44px 8px}', 1)
    open(idx, 'w', encoding='utf-8').write(html)
    write_preview(ctx)
    print('prerendered index.html', date)


def write_preview(ctx):
    """A small static picture of the state outlines, shown until the satellite map is asked for."""
    def decode(enc):
        out = []
        x = y = 0
        for p in enc.split(' '):
            k = p.index(',')
            x += int(p[:k])
            y += int(p[k + 1:])
            out.append((x / 1000.0, y / 1000.0))
        return out
    # read borders back from counties.json so the preview does not depend on chunk order
    borders = json.load(open(os.path.join(DATA, 'counties.json')))['borders']
    polys = []
    for b in borders:
        if b['c'] in ('AK', 'HI'):
            continue
        for enc in b['r']:
            pts = decode(enc)
            if len(pts) < 4:
                continue
            step = max(1, len(pts) // 80)
            polys.append(pts[::step])
    if not polys:
        return
    xs = [p[0] for poly in polys for p in poly]
    ys = [p[1] for poly in polys for p in poly]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    W, H, pad = 640, 400, 12
    sx = (W - 2 * pad) / (maxx - minx)
    sy = (H - 2 * pad) / (maxy - miny)
    s = min(sx, sy)
    def xy(lng, lat):
        return pad + (lng - minx) * s, pad + (maxy - lat) * s
    parts = []
    for poly in polys:
        d = []
        for i, (lng, lat) in enumerate(poly):
            x, y = xy(lng, lat)
            d.append(('M' if i == 0 else 'L') + f'{x:.1f},{y:.1f}')
        d.append('Z')
        parts.append(''.join(d))
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400" role="img" aria-label="Map of the United States">'
           '<rect width="640" height="400" fill="#d9def3"/>'
           f'<path d="{" ".join(parts)}" fill="#f4f5fb" stroke="#5a62a8" stroke-width="1"/>'
           '</svg>')
    open(os.path.join(DOCS, 'map-preview.svg'), 'w', encoding='utf-8').write(svg)


def patch_pages(root):
    """Defer analytics and drop two font weights on every already-built page."""
    n = 0
    gtag_re = re.compile(
        r'<!-- Google tag \(gtag\.js\) -->\s*<script async src="https://www\.googletagmanager\.com/gtag/js\?id=G-QLGW0K3YY7"></script>\s*<script>.*?</script>\s*<script>\s*document\.addEventListener\(\'click\', function \(event\) \{.*?</script>',
        re.S)
    for dirpath, _, names in os.walk(root):
        for name in names:
            if not name.endswith('.html'):
                continue
            path = os.path.join(dirpath, name)
            html = open(path, encoding='utf-8').read()
            new = html.replace(FONT_OLD, FONT_NEW)
            new = gtag_re.sub(GTAG.strip('\n'), new, count=1)
            if new != html:
                open(path, 'w', encoding='utf-8').write(new)
                n += 1
    print(f'patched fonts and analytics on {n} pages')


def bust_assets():
    """Point index.html at this edition of the scripts, and retire the previous service-worker cache."""
    idx = os.path.join(DOCS, 'index.html')
    html = open(idx, encoding='utf-8').read()
    for f in ('config.js', 'app.js', 'pwa.js'):
        h = hashlib.md5(open(os.path.join(DOCS, f), 'rb').read()).hexdigest()[:8]
        html = re.sub(r'src="%s(\?v=[0-9a-f]+)?"' % re.escape(f), 'src="%s?v=%s"' % (f, h), html)
    open(idx, 'w', encoding='utf-8').write(html)
    swp = os.path.join(DOCS, 'sw.js')
    sw = open(swp, encoding='utf-8').read()
    hv = hashlib.md5(b''.join(open(os.path.join(DOCS, f), 'rb').read() for f in ('index.html', 'app.js', 'config.js', 'pwa.js'))).hexdigest()[:10]
    open(swp, 'w', encoding='utf-8').write(re.sub(r"const VERSION = '[^']*';", "const VERSION = '%s';" % hv, sw))
    print('cache-busted scripts, service worker', hv)


def main():
    ctx = build_chunks()
    prerender(ctx)
    patch_pages(DOCS)
    bust_assets()


if __name__ == '__main__':
    main()
