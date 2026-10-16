"""Download the public data the US Land Value Book is built from, and keep compact copies in pipeline/raw/.

    python pipeline/fetch.py            # everything (about 20-40 minutes on GitHub's servers)
    python pipeline/fetch.py hpi fmr    # only some sources

Every source is public-domain US government data, except OpenStreetMap (ODbL, attribution).
A source that fails keeps the copy already in pipeline/raw/, so one bad download never empties the book.
Spreadsheets are converted sheet by sheet to gzipped CSV; parsing happens in build.py.
"""
import csv, gzip, io, json, os, re, sys, time, zipfile, datetime, traceback
import requests

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, 'raw')
TMP = os.path.join(HERE, 'out', 'dl')
os.makedirs(RAW, exist_ok=True); os.makedirs(TMP, exist_ok=True)
UA = {'User-Agent': 'BuildocratValueBook/1.0 (+https://valued.buildocrat.store; buildocrat@gmail.com)'}
S = requests.Session(); S.headers.update(UA)
RUN = {}
runp = os.path.join(RAW, 'run.json')
if os.path.exists(runp):
    RUN = json.load(open(runp))

STATES = {'01':'AL','02':'AK','04':'AZ','05':'AR','06':'CA','08':'CO','09':'CT','10':'DE','11':'DC','12':'FL','13':'GA','15':'HI','16':'ID','17':'IL','18':'IN','19':'IA','20':'KS','21':'KY','22':'LA','23':'ME','24':'MD','25':'MA','26':'MI','27':'MN','28':'MS','29':'MO','30':'MT','31':'NE','32':'NV','33':'NH','34':'NJ','35':'NM','36':'NY','37':'NC','38':'ND','39':'OH','40':'OK','41':'OR','42':'PA','44':'RI','45':'SC','46':'SD','47':'TN','48':'TX','49':'UT','50':'VT','51':'VA','53':'WA','54':'WV','55':'WI','56':'WY','72':'PR'}


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def get(url, tries=4, stream=False, timeout=180, **kw):
    last = None
    for i in range(tries):
        try:
            r = S.get(url, timeout=timeout, stream=stream, **kw)
            if r.status_code == 200:
                return r
            last = f'HTTP {r.status_code}'
            if r.status_code in (403, 404):
                break
        except Exception as ex:
            last = str(ex)
        time.sleep(4 * (i + 1))
    raise RuntimeError(f'{url}: {last}')


def download(url, name=None):
    p = os.path.join(TMP, name or url.rsplit('/', 1)[-1].split('?')[0])
    if os.path.exists(p) and os.path.getsize(p) > 0:
        return p
    r = get(url, stream=True, timeout=600)
    with open(p + '.part', 'wb') as f:
        for ch in r.iter_content(1 << 20):
            f.write(ch)
    os.replace(p + '.part', p)
    log('  downloaded', os.path.basename(p), f'{os.path.getsize(p)/1e6:.1f} MB')
    return p


def first_ok(urls):
    for u in urls:
        try:
            r = S.head(u, timeout=60, allow_redirects=True)
            if r.status_code == 200:
                return u
            if r.status_code in (403, 405):  # some servers refuse HEAD
                r = S.get(u, timeout=60, stream=True)
                r.close()
                if r.status_code == 200:
                    return u
        except Exception:
            pass
    return None


def links(page, pattern):
    """Absolute links on a page whose href matches a regex."""
    html = get(page).text
    out = []
    for h in re.findall(r'href=["\']([^"\']+)["\']', html, flags=re.I):
        if re.search(pattern, h, flags=re.I):
            out.append(requests.compat.urljoin(page, h))
    return list(dict.fromkeys(out))


def write_csv_gz(path, header, rows):
    with gzip.open(path + '.tmp', 'wt', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(header)
        n = 0
        for r in rows:
            w.writerow(r); n += 1
    os.replace(path + '.tmp', path)
    log('  wrote', os.path.relpath(path, HERE), n, 'rows')
    return n


def sheets_to_csv(xpath, stem, keep_rows=None):
    """Every sheet of an .xlsx/.xls to raw/<stem>__<sheet>.csv.gz"""
    out = []
    if xpath.lower().endswith('.xls'):
        import xlrd
        wb = xlrd.open_workbook(xpath)
        for sh in wb.sheets():
            rows = [sh.row_values(i) for i in range(sh.nrows)]
            nm = re.sub(r'[^A-Za-z0-9]+', '_', sh.name).strip('_') or 'sheet'
            p = os.path.join(RAW, f'{stem}__{nm}.csv.gz')
            write_csv_gz(p, rows[0] if rows else [], (r for r in rows[1:] if keep_rows is None or keep_rows(r)))
            out.append(p)
        return out
    import openpyxl
    wb = openpyxl.load_workbook(xpath, read_only=True, data_only=True)
    for ws in wb.worksheets:
        it = ws.iter_rows(values_only=True)
        try:
            head = next(it)
        except StopIteration:
            continue
        nm = re.sub(r'[^A-Za-z0-9]+', '_', ws.title).strip('_') or 'sheet'
        p = os.path.join(RAW, f'{stem}__{nm}.csv.gz')
        write_csv_gz(p, list(head), (list(r) for r in it if any(v is not None for v in r) and (keep_rows is None or keep_rows(r))))
        out.append(p)
    return out


# ---------------------------------------------------------------- Census Gazetteer
def gazetteer():
    year = None
    for y in range(datetime.date.today().year, 2022, -1):
        u = f'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/{y}_Gazetteer/{y}_Gaz_counties_national.zip'
        if first_ok([u]):
            year = y; break
    if not year:
        raise RuntimeError('no Gazetteer year found')
    log('Gazetteer', year)
    for kind in ('counties', 'place', 'zcta', 'tracts', 'cousubs'):
        u = f'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/{year}_Gazetteer/{year}_Gaz_{kind}_national.zip'
        if kind == 'zcta' and not first_ok([u]):
            u = 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2020_Gazetteer/2020_Gaz_zcta_national.zip'
        p = download(u, f'gaz_{year}_{kind}.zip')
        z = zipfile.ZipFile(p)
        txt = z.read(z.namelist()[0]).decode('utf-8', 'replace').splitlines()
        rd = csv.reader(txt, delimiter='\t')
        head = [h.strip() for h in next(rd)]
        write_csv_gz(os.path.join(RAW, f'gaz_{kind}.csv.gz'), head, ([c.strip() for c in r] for r in rd))
    RUN['gazetteer'] = year


# ---------------------------------------------------------------- boundaries (cartographic, simplified)
def shp_to_features(zpath, tol, nd=4, keep_props=None):
    import shapefile
    from shapely.geometry import shape, mapping
    z = zipfile.ZipFile(zpath)
    base = [n for n in z.namelist() if n.endswith('.shp')][0][:-4]
    r = shapefile.Reader(shp=io.BytesIO(z.read(base + '.shp')), shx=io.BytesIO(z.read(base + '.shx')), dbf=io.BytesIO(z.read(base + '.dbf')), encoding='latin-1')
    flds = [f[0] for f in r.fields[1:]]
    feats = []
    for sr in r.iterShapeRecords():
        props = dict(zip(flds, sr.record))
        if keep_props:
            props = {k: props.get(k) for k in keep_props}
        g = shape(sr.shape.__geo_interface__)
        if tol:
            g2 = g.simplify(tol, preserve_topology=True)
            if not g2.is_empty:
                g = g2
        m = mapping(g)

        def rnd(c):
            if isinstance(c[0], (int, float)):
                return [round(c[0], nd), round(c[1], nd)]
            return [rnd(x) for x in c]
        feats.append({'type': 'Feature', 'properties': props, 'geometry': {'type': m['type'], 'coordinates': rnd(m['coordinates'])}})
    return feats


def boundaries():
    year = None
    for y in range(datetime.date.today().year, 2022, -1):
        if first_ok([f'https://www2.census.gov/geo/tiger/GENZ{y}/shp/cb_{y}_us_county_500k.zip']):
            year = y; break
    log('Cartographic boundaries', year)
    for kind, res, tol, props in (('state', '500k', 0.004, ['STATEFP', 'STUSPS', 'NAME']),
                                  ('county', '500k', 0.0025, ['STATEFP', 'COUNTYFP', 'GEOID', 'NAME', 'NAMELSAD', 'STUSPS', 'ALAND'])):
        p = download(f'https://www2.census.gov/geo/tiger/GENZ{year}/shp/cb_{year}_us_{kind}_{res}.zip')
        f = shp_to_features(p, tol, 4, props)
        with gzip.open(os.path.join(RAW, f'shape_{kind}.geojson.gz'), 'wt') as fh:
            json.dump({'type': 'FeatureCollection', 'features': f}, fh, separators=(',', ':'))
        log('  ', kind, len(f), 'features')
    # ZIP Code Tabulation Areas (2020 vintage is the current one)
    p = download('https://www2.census.gov/geo/tiger/GENZ2020/shp/cb_2020_us_zcta520_500k.zip')
    f = shp_to_features(p, 0.0012, 4, ['ZCTA5CE20', 'ALAND20'])
    with gzip.open(os.path.join(RAW, 'shape_zcta.geojson.gz'), 'wt') as fh:
        json.dump({'type': 'FeatureCollection', 'features': f}, fh, separators=(',', ':'))
    log('   zcta', len(f), 'features')
    RUN['boundaries'] = year


# ---------------------------------------------------------------- ACS 5-year (Census Data API)
ACS_VARS = ['B01003_001E', 'B25001_001E', 'B25002_002E', 'B25003_002E', 'B25003_003E', 'B25077_001E', 'B25076_001E', 'B25078_001E',
            'B25064_001E', 'B25031_002E', 'B25031_003E', 'B25031_004E', 'B25031_005E', 'B25031_006E', 'B25031_007E',
            'B25035_001E', 'B25018_001E', 'B25024_002E', 'B25024_001E']


def acs():
    year = None
    for y in range(datetime.date.today().year - 1, 2020, -1):
        try:
            r = S.get(f'https://api.census.gov/data/{y}/acs/acs5?get=NAME,B25077_001E&for=state:06', timeout=60)
            if r.status_code == 200 and r.text.startswith('['):
                year = y; break
        except Exception:
            pass
    if not year:
        raise RuntimeError('ACS API not answering')
    log('ACS 5-year', year)
    key = os.environ.get('CENSUS_API_KEY', '')
    base = f'https://api.census.gov/data/{year}/acs/acs5'
    getv = 'NAME,' + ','.join(ACS_VARS)

    def call(params):
        q = {'get': getv, **params}
        if key:
            q['key'] = key
        for i in range(5):
            try:
                r = S.get(base, params=q, timeout=180)
                if r.status_code == 200:
                    return r.json()
                last = r.status_code
            except Exception as ex:
                last = ex
            time.sleep(5 * (i + 1))
        raise RuntimeError(f'ACS {params}: {last}')
    for geo, params in (('state', {'for': 'state:*'}), ('county', {'for': 'county:*'}), ('place', {'for': 'place:*'}),
                        ('zcta', {'for': 'zip code tabulation area:*'})):
        j = call(params)
        write_csv_gz(os.path.join(RAW, f'acs_{geo}.csv.gz'), j[0], j[1:])
        time.sleep(1)
    head, rows = None, []
    for fp in STATES:
        j = call({'for': 'tract:*', 'in': f'state:{fp}'})
        head = j[0]; rows += j[1:]
        time.sleep(0.6)
    write_csv_gz(os.path.join(RAW, 'acs_tract.csv.gz'), head, rows)
    RUN['acs'] = year


# ---------------------------------------------------------------- FHFA land prices and house price indexes
def fhfa_land():
    page = 'https://www.fhfa.gov/research/papers/wp1901'
    try:
        ls = links(page, r'land[-_]?prices.*\.xlsx')
    except Exception:
        ls = []
    ls += ['https://www.fhfa.gov/document/land-prices_2024_20_june.xlsx']
    def yr(u):
        m = re.findall(r'(20\d\d)', u)
        return max(map(int, m)) if m else 0
    ls = sorted(dict.fromkeys(ls), key=yr, reverse=True)
    for u in ls:
        try:
            p = download(u, 'fhfa_land.xlsx')
            sheets_to_csv(p, 'fhfa_land')
            RUN['fhfa_land'] = u
            return
        except Exception as ex:
            log('  land file failed', u, ex)
    raise RuntimeError('no FHFA land file')


def fhfa_hpi():
    base = 'https://www.fhfa.gov/hpi/download'
    cands = {
        'hpi_county': [f'{base}/annually/hpi_at_bdl_county.xlsx'],
        'hpi_zip5': [f'{base}/annually/hpi_at_bdl_zip5.xlsx'],
        'hpi_tract': [f'{base}/annually/hpi_at_bdl_tract.csv'],
        'hpi_state_q': [f'{base}/quarterly_datasets/hpi_at_state.csv'],
        'hpi_po_monthly': [f'{base}/monthly/hpi_po_monthly_hist.xls', f'{base}/monthly/hpi_po_monthly_hist.xlsx'],
        'hpi_po_state_q': [f'{base}/quarterly_datasets/hpi_po_state.txt', f'{base}/quarterly_datasets/hpi_po_state.xls'],
    }
    try:
        found = links('https://www.fhfa.gov/data/hpi/datasets', r'/hpi/download/')
        for k, pat in (('hpi_county', r'at_bdl_county'), ('hpi_zip5', r'at_bdl_zip5'), ('hpi_tract', r'at_bdl_tract'),
                       ('hpi_state_q', r'hpi_at_state\.'), ('hpi_po_monthly', r'po_monthly_hist'), ('hpi_po_state_q', r'hpi_po_state\.')):
            cands[k] = [u for u in found if re.search(pat, u, re.I)] + cands[k]
    except Exception as ex:
        log('  HPI page not read', ex)
    for k, us in cands.items():
        u = first_ok(us)
        if not u:
            log('  HPI not found', k); continue
        try:
            p = download(u, k + os.path.splitext(u)[1])
            if p.endswith(('.xlsx', '.xls')):
                keep = (lambda r: True)
                sheets_to_csv(p, k, None)
            else:
                txt = open(p, encoding='utf-8', errors='replace').read().splitlines()
                delim = '\t' if '\t' in txt[0] else ','
                rd = list(csv.reader(txt, delimiter=delim))
                if k == 'hpi_tract':
                    rd = [rd[0]] + [r for r in rd[1:] if len(r) > 2 and r[2][:4].isdigit() and int(r[2][:4]) >= 2010]
                write_csv_gz(os.path.join(RAW, k + '.csv.gz'), rd[0], rd[1:])
            RUN[k] = u
        except Exception as ex:
            log('  HPI failed', k, ex)


# ---------------------------------------------------------------- HUD Fair Market Rents
def hud_fmr():
    fy = datetime.date.today().year + (1 if datetime.date.today().month >= 10 else 0)
    page = 'https://www.huduser.gov/portal/datasets/fmr.html'
    found = []
    try:
        found = links(page, r'\.xlsx?$')
    except Exception as ex:
        log('  HUD page not read', ex)
    for y in (fy, fy - 1):
        yy = str(y)[2:]
        county = [u for u in found if re.search(rf'FY{yy}_FMRs?(_revised)?\.xlsx?$', u, re.I)]
        safmr = [u for u in found if re.search(rf'fy{y}_safmrs?(_revised)?\.xlsx?$', u, re.I)]
        county += [f'https://www.huduser.gov/portal/datasets/fmr/fmr{y}/FY{yy}_FMRs.xlsx', f'https://www.huduser.gov/portal/datasets/fmr/fmr{y}/FY{yy}_FMRs_revised.xlsx']
        safmr += [f'https://www.huduser.gov/portal/datasets/fmr/fmr{y}/fy{y}_safmrs.xlsx', f'https://www.huduser.gov/portal/datasets/fmr/fmr{y}/fy{y}_safmrs_revised.xlsx']
        uc, us_ = first_ok(county), first_ok(safmr)
        if uc and us_:
            sheets_to_csv(download(uc, f'fmr_{y}.xlsx'), 'fmr_county')
            sheets_to_csv(download(us_, f'safmr_{y}.xlsx'), 'fmr_zip')
            RUN['hud_fmr'] = {'fy': y, 'county': uc, 'zip': us_}
            return
    raise RuntimeError('no HUD FMR files found')


# ---------------------------------------------------------------- metro areas (CBSA delineation)
def cbsa():
    for y in (2023, 2024, 2025, 2020):
        u = first_ok([f'https://www2.census.gov/programs-surveys/metro-micro/geographies/reference-files/{y}/delineation-files/list1_{y}.xlsx',
                      f'https://www2.census.gov/programs-surveys/metro-micro/geographies/reference-files/{y}/delineation-files/list1_{y}.xls'])
        if u:
            sheets_to_csv(download(u, 'cbsa' + os.path.splitext(u)[1]), 'cbsa')
            RUN['cbsa'] = u
            return
    raise RuntimeError('no CBSA delineation file')


# ---------------------------------------------------------------- USDA NASS farmland values (Quick Stats bulk file)
def nass():
    ls = links('https://www.nass.usda.gov/datasets/', r'qs\.economics_\d+\.txt\.gz')
    if not ls:
        raise RuntimeError('no NASS economics bulk file listed')
    u = sorted(ls)[-1]
    p = download(u, 'nass_economics.txt.gz')
    want = re.compile(r'^AG LAND, (CROPLAND|PASTURELAND|INCL BUILDINGS|CROPLAND, IRRIGATED|CROPLAND, NON-IRRIGATED) - (ASSET VALUE|RENT), MEASURED IN \$ / ACRE')
    keep_cols = ['SHORT_DESC', 'SOURCE_DESC', 'AGG_LEVEL_DESC', 'STATE_FIPS_CODE', 'STATE_ALPHA', 'COUNTY_CODE', 'COUNTY_NAME', 'YEAR', 'REFERENCE_PERIOD_DESC', 'VALUE']
    rows = []
    with gzip.open(p, 'rt', encoding='utf-8', errors='replace') as f:
        rd = csv.reader(f, delimiter='\t')
        head = next(rd); ix = {h: i for i, h in enumerate(head)}
        for r in rd:
            try:
                if int(r[ix['YEAR']]) < 2012:
                    continue
            except Exception:
                continue
            if not want.match(r[ix['SHORT_DESC']]):
                continue
            if r[ix['AGG_LEVEL_DESC']] not in ('NATIONAL', 'STATE', 'COUNTY', 'AGRICULTURAL DISTRICT'):
                continue
            rows.append([r[ix[c]] for c in keep_cols])
    write_csv_gz(os.path.join(RAW, 'nass_land.csv.gz'), keep_cols, rows)
    RUN['nass'] = u


# ---------------------------------------------------------------- OpenStreetMap places, neighbourhoods and subdivisions (Overpass)
OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter']


def osm():
    out = os.path.join(RAW, 'osm_places.csv.gz')
    done = {}
    if os.path.exists(out):
        with gzip.open(out, 'rt', encoding='utf-8') as f:
            for r in csv.DictReader(f):
                done.setdefault(r['st'], []).append(r)
    rows = []
    fresh = set()
    for fp, st in STATES.items():
        q = f"""[out:json][timeout:600];
area["ISO3166-2"="US-{st}"][admin_level=4]->.a;
(
  nwr(area.a)["place"~"^(city|town|village|hamlet|suburb|quarter|neighbourhood|locality)$"]["name"];
  way(area.a)["landuse"="residential"]["name"];
  relation(area.a)["landuse"="residential"]["name"];
  nwr(area.a)["residential"="gated"]["name"];
);
out center tags qt;"""
        js = None
        for k in range(6):
            ep = OVERPASS[k % len(OVERPASS)]
            try:
                r = S.post(ep, data={'data': q}, timeout=900)
                if r.status_code == 200 and r.text.lstrip().startswith('{'):
                    js = r.json(); break
                log('  overpass', st, ep, r.status_code)
            except Exception as ex:
                log('  overpass', st, ep, ex)
            time.sleep(30 * (k + 1))
        if js is None:
            rows += [[x['st'], x['k'], x['id'], x['name'], x['type'], x['lat'], x['lng'], x['access'], x['pop']] for x in done.get(st, [])]
            log('  KEEPING last run for', st)
            continue
        n0 = len(rows)
        for e in js.get('elements', []):
            t = e.get('tags', {})
            la = e.get('lat') or (e.get('center') or {}).get('lat')
            lo = e.get('lon') or (e.get('center') or {}).get('lon')
            if la is None:
                continue
            if t.get('place'):
                typ = t['place']
            elif t.get('residential') == 'gated' or (t.get('landuse') == 'residential' and t.get('access') in ('private', 'permissive') and t.get('barrier') != 'no'):
                typ = 'gated'
            else:
                typ = 'subdivision'
            rows.append([st, e['type'][0], e['id'], t.get('name', '')[:80], typ, round(la, 5), round(lo, 5), t.get('access', ''), t.get('population', '')])
        fresh.add(st)
        log('  osm', st, len(rows) - n0)
        time.sleep(8)
    write_csv_gz(out, ['st', 'k', 'id', 'name', 'type', 'lat', 'lng', 'access', 'pop'], rows)
    RUN['osm'] = {'date': datetime.date.today().isoformat(), 'states_fresh': len(fresh)}


# ---------------------------------------------------------------- Census Survey of Construction (cost to build, lot sizes)
def soc():
    for nm in ('contractpricesqft', 'soldpricesqft', 'lotsize', 'squarefeet'):
        p = download(f'https://www.census.gov/construction/chars/xls/{nm}_cust.xls', f'soc_{nm}.xls')
        sheets_to_csv(p, f'soc_{nm}')
    RUN['soc'] = 'https://www.census.gov/construction/chars/current.html'


SOURCES = {'soc': soc, 'gazetteer': gazetteer, 'boundaries': boundaries, 'acs': acs, 'fhfa_land': fhfa_land, 'hpi': fhfa_hpi,
           'fmr': hud_fmr, 'cbsa': cbsa, 'nass': nass, 'osm': osm}

if __name__ == '__main__':
    want = sys.argv[1:] or list(SOURCES)
    failed = []
    for k in want:
        log('==>', k)
        try:
            SOURCES[k]()
        except Exception as ex:
            traceback.print_exc()
            log('FAILED', k, ex, '- KEEPING last run')
            failed.append(k)
        RUN['fetched_' + k] = datetime.datetime.utcnow().isoformat(timespec='minutes') + ('' if k not in failed else ' FAILED')
        json.dump(RUN, open(runp, 'w'), indent=1)
    log('done; failed:', failed or 'none')
    sys.exit(1 if len(failed) == len(want) else 0)
