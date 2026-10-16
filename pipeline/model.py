"""US Land Value Book: valuation model and export.

Reads the source files in pipeline/raw/ (fetch.py) and writes:
  docs/data/counties.json      states, counties (with simplified outlines), state borders, metadata
  docs/data/tracts.b64.txt     every census tract's values (the field behind "value any spot")
  docs/data/places.b64.txt     cities, towns, ZIP codes, neighborhoods, villages, subdivisions, gated communities
  docs/data/evidence.json      FHFA's published land price for each ZIP code
  docs/data/zip/<tile>.json    ZIP Code Tabulation Area outlines, 2-degree tiles, for the ZIP at a clicked spot
  pipeline/out/pages.json      cities and per-county highlights for pages.py

Method, in short:
  land  = FHFA standardized quarter-acre land value for the tract, else its ZIP code, else its county
          (2015 price level), moved to today with the county FHFA price index raised to the land elasticity
          measured in FHFA's own land panel; tracts with no FHFA figure use the county figure scaled by
          how the tract's home values compare with the county's.
  homes = ACS 5-year median and quartile values, moved to today with the county FHFA price index.
  rents = HUD Fair Market Rents (ZIP-level Small Area FMRs where HUD publishes them, else county),
          scaled by how the tract's ACS gross rent compares with its ZIP or county.
  tiers = within metro areas, home-value rank of the tract; elsewhere how built-up it is.
"""
import base64, collections, csv, datetime, gzip, io, json, math, os, re, statistics as stt, sys
import numpy as np
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, 'raw')
DOCS = os.path.join(HERE, '..', 'docs')
OUT = os.path.join(HERE, 'out')
os.makedirs(OUT, exist_ok=True); os.makedirs(os.path.join(DOCS, 'data', 'zip'), exist_ok=True)
SQFT_ACRE, QLOT = 43560.0, 10890.0

SC = {'AL':'Alabama','AK':'Alaska','AZ':'Arizona','AR':'Arkansas','CA':'California','CO':'Colorado','CT':'Connecticut','DE':'Delaware','DC':'District of Columbia','FL':'Florida','GA':'Georgia','HI':'Hawaii','ID':'Idaho','IL':'Illinois','IN':'Indiana','IA':'Iowa','KS':'Kansas','KY':'Kentucky','LA':'Louisiana','ME':'Maine','MD':'Maryland','MA':'Massachusetts','MI':'Michigan','MN':'Minnesota','MS':'Mississippi','MO':'Missouri','MT':'Montana','NE':'Nebraska','NV':'Nevada','NH':'New Hampshire','NJ':'New Jersey','NM':'New Mexico','NY':'New York','NC':'North Carolina','ND':'North Dakota','OH':'Ohio','OK':'Oklahoma','OR':'Oregon','PA':'Pennsylvania','RI':'Rhode Island','SC':'South Carolina','SD':'South Dakota','TN':'Tennessee','TX':'Texas','UT':'Utah','VT':'Vermont','VA':'Virginia','WA':'Washington','WV':'West Virginia','WI':'Wisconsin','WY':'Wyoming'}
FIPS = {'01':'AL','02':'AK','04':'AZ','05':'AR','06':'CA','08':'CO','09':'CT','10':'DE','11':'DC','12':'FL','13':'GA','15':'HI','16':'ID','17':'IL','18':'IN','19':'IA','20':'KS','21':'KY','22':'LA','23':'ME','24':'MD','25':'MA','26':'MI','27':'MN','28':'MS','29':'MO','30':'MT','31':'NE','32':'NV','33':'NH','34':'NJ','35':'NM','36':'NY','37':'NC','38':'ND','39':'OH','40':'OK','41':'OR','42':'PA','44':'RI','45':'SC','46':'SD','47':'TN','48':'TX','49':'UT','50':'VT','51':'VA','53':'WA','54':'WV','55':'WI','56':'WY'}
NAME2ST = {v: k for k, v in SC.items()}
CAPITAL = {'AL':'Montgomery','AK':'Juneau','AZ':'Phoenix','AR':'Little Rock','CA':'Sacramento','CO':'Denver','CT':'Hartford','DE':'Dover','DC':'Washington','FL':'Tallahassee','GA':'Atlanta','HI':'Honolulu','ID':'Boise','IL':'Springfield','IN':'Indianapolis','IA':'Des Moines','KS':'Topeka','KY':'Frankfort','LA':'Baton Rouge','ME':'Augusta','MD':'Annapolis','MA':'Boston','MI':'Lansing','MN':'Saint Paul','MS':'Jackson','MO':'Jefferson City','MT':'Helena','NE':'Lincoln','NV':'Carson City','NH':'Concord','NJ':'Trenton','NM':'Santa Fe','NY':'Albany','NC':'Raleigh','ND':'Bismarck','OH':'Columbus','OK':'Oklahoma City','OR':'Salem','PA':'Harrisburg','RI':'Providence','SC':'Columbia','SD':'Pierre','TN':'Nashville','TX':'Austin','UT':'Salt Lake City','VT':'Montpelier','VA':'Richmond','WA':'Olympia','WV':'Charleston','WI':'Madison','WY':'Cheyenne'}
REG = {'CT':'NE','ME':'NE','MA':'NE','NH':'NE','RI':'NE','VT':'NE','NJ':'NE','NY':'NE','PA':'NE','IL':'MW','IN':'MW','MI':'MW','OH':'MW','WI':'MW','IA':'MW','KS':'MW','MN':'MW','MO':'MW','NE':'MW','ND':'MW','SD':'MW','AZ':'W','CO':'W','ID':'W','MT':'W','NV':'W','NM':'W','UT':'W','WY':'W','AK':'W','CA':'W','HI':'W','OR':'W','WA':'W'}
ZONES = ['Top tier', 'Upper', 'Mid', 'Entry', 'Small town', 'Rural', 'Farmland']
TODAY = datetime.date.today()
# the edition is dated to its Monday
EDITION = TODAY - datetime.timedelta(days=TODAY.weekday())


def log(*a):
    print(*a, flush=True)


def rows(name):
    p = os.path.join(RAW, name)
    with gzip.open(p, 'rt', encoding='utf-8', errors='replace') as f:
        yield from csv.reader(f)


def num(x):
    try:
        if x is None:
            return None
        s = str(x).replace(',', '').replace('$', '').strip()
        if s in ('', '-', '(X)', 'N', 'null', '*', '**', '***', '-666666666', '-999999999', '-888888888', '-222222222', '-333333333', '-555555555'):
            return None
        v = float(s.rstrip('+-')) if s.endswith(('+', '-')) and s[:-1].replace('.', '').isdigit() else float(s)
        return v if v >= 0 else None
    except Exception:
        return None


def gaz(name):
    it = rows(name)
    head = '|'.join(next(it)).split('|')
    for r in it:
        yield dict(zip(head, ','.join(r).split('|')))


def wmedian(vals, wts):
    pairs = sorted((v, w) for v, w in zip(vals, wts) if v is not None and v > 0 and w > 0)
    if not pairs:
        pairs = sorted((v, 1) for v in vals if v is not None and v > 0)
    if not pairs:
        return None
    tot = sum(w for _, w in pairs); acc = 0
    for v, w in pairs:
        acc += w
        if acc >= tot / 2:
            return v
    return pairs[-1][0]


def wq(vals, wts, q):
    pairs = sorted((v, w) for v, w in zip(vals, wts) if v is not None and v > 0)
    if not pairs:
        return None
    tot = sum(max(w, 1) for _, w in pairs); acc = 0
    for v, w in pairs:
        acc += max(w, 1)
        if acc >= tot * q:
            return v
    return pairs[-1][0]


CXK = math.cos(math.radians(38)) * 111.32; CYK = 110.57


def XY(lat, lng):
    return np.column_stack([np.asarray(lng, float) * CXK * np.cos(np.radians(np.asarray(lat, float))) / math.cos(math.radians(38)), np.asarray(lat, float) * CYK])


# ======================================================================= geography
log('geography')
from shapely.geometry import shape, Point
from shapely import STRtree
cfeat = json.load(gzip.open(os.path.join(RAW, 'shape_county.geojson.gz')))['features']
cfeat = [f for f in cfeat if f['properties']['STATEFP'] in FIPS]
cfeat.sort(key=lambda f: f['properties']['GEOID'])
gzc = {r['GEOID']: r for r in gaz('gaz_counties.csv.gz')}
COUNTIES = []
for f in cfeat:
    p = f['properties']; g = gzc.get(p['GEOID'], {})
    COUNTIES.append({'f': p['GEOID'], 'n': p['NAMELSAD'], 's': FIPS[p['STATEFP']], 'geom': shape(f['geometry']),
                     'lat': num(g.get('INTPTLAT')) or shape(f['geometry']).representative_point().y,
                     'lng': g.get('INTPTLONG') and float(g['INTPTLONG']) or shape(f['geometry']).representative_point().x,
                     'aland': float(p.get('ALAND') or 0)})
CI = {c['f']: i for i, c in enumerate(COUNTIES)}
ctree = STRtree([c['geom'] for c in COUNTIES])
log(' counties', len(COUNTIES))


def county_of(lat, lng, hint=None):
    pt = Point(lng, lat)
    for k in ctree.query(pt):
        if COUNTIES[k]['geom'].covers(pt):
            return int(k)
    k = ctree.nearest(pt)
    return int(k) if k is not None and COUNTIES[int(k)]['geom'].distance(pt) < 0.15 else None


# metro areas
cbsa = {}
it = rows('cbsa__List_1.csv.gz'); next(it); next(it); head = next(it)
H = {h: i for i, h in enumerate(head)}
for r in it:
    if len(r) < len(head) or not r[H['FIPS State Code']]:
        continue
    f = r[H['FIPS State Code']].zfill(2) + r[H['FIPS County Code']].zfill(3)
    cbsa[f] = {'code': r[H['CBSA Code']], 'title': r[H['CBSA Title']], 'metro': r[H['Metropolitan/Micropolitan Statistical Area']].startswith('Metro'), 'central': r[H['Central/Outlying County']] == 'Central'}

# ======================================================================= tracts and ACS
log('tracts')
T = {}
for r in gaz('gaz_tracts.csv.gz'):
    if r['GEOID'][:2] in FIPS:
        T[r['GEOID']] = {'g': r['GEOID'], 'lat': float(r['INTPTLAT']), 'lng': float(r['INTPTLONG']), 'aland': float(r['ALAND'] or 0)}


def acs_load(level):
    p = os.path.join(RAW, f'acs_{level}.csv.gz')
    if not os.path.exists(p):
        return {}
    it = rows(f'acs_{level}.csv.gz'); head = next(it); out = {}
    for r in it:
        d = dict(zip(head, r))
        if 'GEOID' in d:
            gid = d['GEOID']
        else:  # Census Data API layout
            if level == 'tract':
                gid = d['state'] + d['county'] + d['tract']
            elif level == 'county':
                gid = d['state'] + d['county']
            elif level == 'place':
                gid = d['state'] + d['place']
            elif level == 'zcta':
                gid = d['zip code tabulation area']
            else:
                gid = d['state']
        out[gid] = {
            'pop': num(d.get('B01003_001E')), 'hu': num(d.get('B25001_001E')), 'occ': num(d.get('B25002_002E')),
            'own': num(d.get('B25003_002E')), 'rentocc': num(d.get('B25003_003E')),
            'hv': num(d.get('B25077_001E')), 'hvlo': num(d.get('B25076_001E')), 'hvhi': num(d.get('B25078_001E')),
            'grent': num(d.get('B25064_001E')),
            'r0': num(d.get('B25031_002E')), 'r1': num(d.get('B25031_003E')), 'r2': num(d.get('B25031_004E')), 'r3': num(d.get('B25031_005E')), 'r4': num(d.get('B25031_006E')),
            'yb': num(d.get('B25035_001E')), 'sf': num(d.get('B25024_002E')), 'units': num(d.get('B25024_001E'))}
    return out


A_T, A_C, A_P, A_Z, A_S = (acs_load(x) for x in ('tract', 'county', 'place', 'zcta', 'state'))
if not A_T:
    sys.exit('ACS tract data missing: run python pipeline/fetch.py acs')
log(' ACS tracts', len(A_T), 'counties', len(A_C), 'places', len(A_P), 'zctas', len(A_Z))

# ======================================================================= FHFA price indexes
log('price indexes')


def sheet(stem):
    cand = sorted(f for f in os.listdir(RAW) if f.startswith(stem + '__') or f == stem + '.csv.gz')
    return cand[0] if cand else None


def hpi_annual(stem, keycol_pat):
    """FHFA annual developmental index: returns {key: {year: index}} (header row found by searching)."""
    f = sheet(stem)
    out = collections.defaultdict(dict)
    if not f:
        return out
    it = rows(f); head = None
    for r in it:
        low = [str(x).strip().lower() for x in r]
        if 'year' in low and any(re.search(keycol_pat, x) for x in low):
            head = low; break
    if not head:
        return out
    ki = next(i for i, x in enumerate(head) if re.search(keycol_pat, x)); yi = head.index('year')
    hi = next((i for i, x in enumerate(head) if x == 'hpi'), None)
    if hi is None:
        hi = next(i for i, x in enumerate(head) if x.startswith('hpi'))
    for r in it:
        try:
            k = str(r[ki]).strip().split('.')[0]; y = int(float(r[yi])); v = num(r[hi])
        except Exception:
            continue
        if v:
            out[k][y] = v
    return out


HPI_C = hpi_annual('hpi_county', r'fips')
HPI_C = {k.zfill(5): v for k, v in HPI_C.items()}
HPI_Z = hpi_annual('hpi_zip5', r'zip')
HPI_Z = {k.zfill(5): v for k, v in HPI_Z.items()}
log(' county index series', len(HPI_C), 'ZIP series', len(HPI_Z))
# state quarterly purchase-only (seasonally adjusted): extends past the last annual year
SQ = collections.defaultdict(dict)
it = rows('hpi_po_state_q.csv.gz'); head = next(it)
for r in it:
    try:
        SQ[r[0]][(int(r[1]), int(r[2]))] = float(r[4])
    except Exception:
        pass
LASTQ = max(max(d) for d in SQ.values())
log(' state quarterly index to', LASTQ)
# all-transactions state quarterly: annual means for states (fallback for counties without an index)
SA = collections.defaultdict(lambda: collections.defaultdict(list))
for r in rows('hpi_state_q.csv.gz'):
    try:
        SA[r[0]][int(r[1])].append(float(r[3]))
    except Exception:
        pass
SA = {s: {y: sum(v) / len(v) for y, v in d.items()} for s, d in SA.items()}


def state_po(st, year):
    d = SQ.get(st, {}); v = [d[(year, q)] for q in (1, 2, 3, 4) if (year, q) in d]
    return sum(v) / len(v) if v else None


def growth(fips, st, y0):
    """House price growth from calendar year y0 to the latest quarter, for a county."""
    s = HPI_C.get(fips)
    ly_state = max(y for y in SA.get(st, {}) if y < LASTQ[0] + 1)
    if s and y0 in s:
        ly = max(s)
        g = s[ly] / s[y0]
        a = state_po(st, ly); b = SQ.get(st, {}).get(LASTQ)
        if a and b:
            g *= b / a
        return g, 'county'
    a = SA.get(st, {}).get(y0); b = state_po(st, y0); c = SQ.get(st, {}).get(LASTQ)
    if b and c:
        return c / b, 'state'
    return 1.0, 'none'


# ======================================================================= FHFA land prices
log('land prices')


def land_sheet(name, keyfun):
    it = rows(name); next(it); head = next(it)
    hi = next(i for i, h in enumerate(head) if '1/4 Acre' in h)
    si = next(i for i, h in enumerate(head) if 'Land Share' in h)
    pv = next(i for i, h in enumerate(head) if 'Property Value (Standardized)' in h)
    out = {}
    for r in it:
        try:
            k = keyfun(r); v = num(r[hi])
        except Exception:
            continue
        if k and v:
            out[k] = {'q': v, 'sh': num(r[si]), 'pv': num(r[pv]), 'st': r[0] if len(r) > 3 else ''}
    return out


LT = land_sheet('fhfa_land__Cross_Section_Census_Tracts.csv.gz', lambda r: str(r[2]).split('.')[0].zfill(11))
LZ = land_sheet('fhfa_land__Cross_Section_ZIP_Codes.csv.gz', lambda r: str(r[0]).split('.')[0].zfill(5))
LC = land_sheet('fhfa_land__Cross_Section_Counties.csv.gz', lambda r: str(r[2]).split('.')[0].zfill(5))
log(' FHFA land: tracts', len(LT), 'ZIPs', len(LZ), 'counties', len(LC))
# land elasticity to house prices, from FHFA's national land panel (2015 -> last panel year) and the national index
it = rows('fhfa_land__Panel_Nation.csv.gz'); next(it); head = next(it)
yi = head.index('Year'); hi = next(i for i, h in enumerate(head) if '1/4 Acre' in h); pi_ = next(i for i, h in enumerate(head) if 'Property Value (Standardized)' in h)
NP = {}
for r in it:
    try:
        NP[int(float(r[yi]))] = (num(r[hi]), num(r[pi_]))
    except Exception:
        pass
PY = max(NP)
BETA = math.log(NP[PY][0] / NP[2015][0]) / math.log(NP[PY][1] / NP[2015][1])
BETA = max(0.9, min(1.8, BETA))
log(f' land elasticity to property value 2015-{PY}: {BETA:.2f}')
# CT: FHFA uses the old counties; the tract number (last 6 digits) matches the new planning-region codes
LT_CT = {}
for k, v in LT.items():
    if k.startswith('09'):
        LT_CT.setdefault(k[5:], []).append(v)
LT_CT = {k: v[0] for k, v in LT_CT.items() if len(v) == 1}


def land_tract(gid):
    v = LT.get(gid)
    if v:
        return v
    if gid.startswith('09'):
        v = LT_CT.get(gid[5:])
        if v:
            return v
    # 2020 tracts split from a 2010 tract keep the first four digits
    v = LT.get(gid[:9] + '00')
    if v:
        return v
    return None


# ZCTA geometry: tract centroid -> ZIP
log('ZIP code areas')
zfeat = json.load(gzip.open(os.path.join(RAW, 'shape_zcta.geojson.gz')))['features']
ZG = [shape(f['geometry']) for f in zfeat]; ZID = [f['properties']['ZCTA5CE20'] for f in zfeat]
ztree = STRtree(ZG)


def zip_of(lat, lng):
    pt = Point(lng, lat)
    for k in ztree.query(pt):
        if ZG[k].covers(pt):
            return ZID[k]
    return None


# ======================================================================= HUD rents
log('rents')


def find_header(name, must):
    it = rows(name)
    for r in it:
        low = [str(x).replace('\n', ' ').strip().lower() for x in r]
        if all(any(m in x for x in low) for m in must):
            return low, it
    return None, iter(())


FMR_C, FMR_Z = {}, {}
fc = sheet('fmr_county')
if fc:
    head, it = find_header(fc, ['fmr_2', 'fips'])
    if head:
        fi = next(i for i, h in enumerate(head) if h.startswith('fips'))
        cols = [next(i for i, h in enumerate(head) if h == f'fmr_{b}') for b in range(5)]
        for r in it:
            try:
                f10 = str(r[fi]).split('.')[0].zfill(10)
                vals = [num(r[c]) for c in cols]
            except Exception:
                continue
            if vals[2]:
                FMR_C.setdefault(f10[:5], []).append(vals)  # New England: one row per town; averaged
FMR_C = {k: [stt.mean([v[b] for v in vs if v[b]]) for b in range(5)] for k, vs in FMR_C.items()}
fz = sheet('fmr_zip')
if fz:
    head, it = find_header(fz, ['zip', '2br'])
    if head:
        zi = next(i for i, h in enumerate(head) if h.startswith('zip'))
        cols = []
        for b in ('0br', '1br', '2br', '3br', '4br'):
            cols.append(next(i for i, h in enumerate(head) if b in h.replace(' ', '').lower() and 'payment' not in h and '90%' not in h and '110%' not in h))
        for r in it:
            try:
                z = str(r[zi]).split('.')[0].zfill(5); vals = [num(r[c]) for c in cols]
            except Exception:
                continue
            if vals[2]:
                FMR_Z[z] = vals
# HUD eGIS (ArcGIS) layout: FMR areas (metro areas by CBSA code, non-metro counties by FIPS) and ZIP-level SAFMRs
fa = os.path.join(RAW, 'fmrgis__Fair_Market_Rents_0.csv.gz')
if os.path.exists(fa):
    by_cbsa_fmr = collections.defaultdict(list)
    it = rows('fmrgis__Fair_Market_Rents_0.csv.gz'); head = next(it); H = {h: i for i, h in enumerate(head)}
    for r in it:
        code = r[H['FMR_CODE']]; vals = [num(r[H[f'FMR_{b}BDR']]) for b in range(5)]
        if not vals[2]:
            continue
        if code.startswith('NCNTY'):
            FMR_C[code[5:10]] = vals
        elif code.startswith('METRO'):
            by_cbsa_fmr[code[5:10]].append(vals)
    for f, cb in cbsa.items():
        if f not in FMR_C and cb['code'] in by_cbsa_fmr:
            vs = by_cbsa_fmr[cb['code']]
            FMR_C[f] = [stt.median([v[b] for v in vs]) for b in range(5)]
    zz = collections.defaultdict(list)
    it = rows('fmrgis__HUD_PDR_Small_Area_Fair_Market_Rents_1.csv.gz'); head = next(it); H = {h: i for i, h in enumerate(head)}
    for r in it:
        z = str(r[H['ID']]).split('.')[0].zfill(5); vals = [num(r[H[f'SAFMR_{b}BR']]) for b in range(5)]
        if vals[2] and z != '00000':
            zz[z].append(vals)
    for z, vs in zz.items():
        FMR_Z[z] = [stt.median([v[b] for v in vs if v[b]] or [0]) for b in range(5)]
# HUD eGIS (ArcGIS) layout: FMR areas (metro areas by CBSA code, non-metro counties by FIPS) and ZIP-level SAFMRs
fa = os.path.join(RAW, 'fmrgis__Fair_Market_Rents_0.csv.gz')
if os.path.exists(fa):
    by_cbsa_fmr = collections.defaultdict(list)
    it = rows('fmrgis__Fair_Market_Rents_0.csv.gz'); head = next(it); H = {h: i for i, h in enumerate(head)}
    for r in it:
        code = r[H['FMR_CODE']]; vals = [num(r[H[f'FMR_{b}BDR']]) for b in range(5)]
        if not vals[2]:
            continue
        if code.startswith('NCNTY'):
            FMR_C[code[5:10]] = vals
        elif code.startswith('METRO'):
            by_cbsa_fmr[code[5:10]].append(vals)
    for f, cb in cbsa.items():
        if f not in FMR_C and cb['code'] in by_cbsa_fmr:
            vs = by_cbsa_fmr[cb['code']]
            FMR_C[f] = [stt.median([v[b] for v in vs]) for b in range(5)]
    zz = collections.defaultdict(list)
    it = rows('fmrgis__HUD_PDR_Small_Area_Fair_Market_Rents_1.csv.gz'); head = next(it); H = {h: i for i, h in enumerate(head)}
    for r in it:
        z = str(r[H['ID']]).split('.')[0].zfill(5); vals = [num(r[H[f'SAFMR_{b}BR']]) for b in range(5)]
        if vals[2] and z != '00000':
            zz[z].append(vals)
    for z, vs in zz.items():
        FMR_Z[z] = [stt.median([v[b] for v in vs if v[b]] or [0]) for b in range(5)]
log(' HUD FMR counties', len(FMR_C), 'ZIP codes', len(FMR_Z))
if not FMR_C:
    sys.exit('HUD Fair Market Rents missing: run python pipeline/fetch.py fmr')

# ======================================================================= farmland (USDA NASS)
log('farmland')
NASS_C, NASS_S = {}, collections.defaultdict(dict)
farmUS = None
for r in rows('nass_land.csv.gz'):
    if r[0] == 'SHORT_DESC':
        continue
    desc, src, lvl, sf, sa, cc, cn, yr, per, val = r
    v = num(val)
    if not v:
        continue
    if desc.startswith('AG LAND, INCL BUILDINGS') and src == 'CENSUS' and lvl == 'COUNTY' and cc.isdigit():
        k = sf.zfill(2) + cc.zfill(3)
        if int(yr) >= NASS_C.get(k, (0, 0))[0]:
            NASS_C[k] = (int(yr), v)
    if desc.startswith('AG LAND, INCL BUILDINGS') and src == 'SURVEY' and lvl == 'STATE':
        NASS_S[sa][int(yr)] = v
    if desc.startswith('AG LAND, INCL BUILDINGS') and src == 'SURVEY' and lvl == 'NATIONAL':
        if not farmUS or int(yr) > farmUS[0]:
            farmUS = (int(yr), v)
NASS_Y = max(max(d) for d in NASS_S.values())
log(' farmland: county census values', len(NASS_C), 'state survey to', NASS_Y)


def farm_county(f, st):
    """Farmland per acre: Census of Agriculture county value (incl. buildings) moved to the latest survey year,
    capped at 3x the state average (city counties with little farmland report building-heavy values)."""
    s = NASS_S.get(st, {})
    latest = s.get(NASS_Y)
    v = latest
    if f in NASS_C:
        y, v = NASS_C[f]
        if latest and s.get(y):
            v = v * latest / s[y]
    if v and latest:
        v = min(v, 3 * latest)
    return v


# ======================================================================= cost to build (Census Survey of Construction)
log('build cost')
BUILD = {}
SOC_Y = None
fsoc = sheet('soc_contractpricesqft')
if fsoc:
    # layout: a title block, then rows with a year in the first column and US, Northeast, Midwest, South, West columns
    # (median first, average after); take the latest year's median by region
    allr = list(rows(fsoc))
    i0 = next((i for i, r in enumerate(allr) if any(str(x).strip().lower() == 'midwest' for x in r)), None)
    if i0 is not None:
        mw = next(i for i, x in enumerate(allr[i0]) if str(x).strip().lower() == 'midwest')  # first block = medians
        idx = {'NE': mw - 1, 'MW': mw, 'S': mw + 1, 'W': mw + 2}
        for r in allr[i0 + 1:]:
            m = re.match(r'^\s*((?:19|20)\d\d)', str(r[0]) if r else '')
            if m:
                vals = {k: num(r[c]) for k, c in idx.items() if c < len(r)}
                if len(vals) == 4 and all(vals.values()):
                    SOC_Y, BUILD = int(m.group(1)), vals
if not BUILD:
    log(' Survey of Construction table not read; using the last known regional medians')
    BUILD, SOC_Y = {'NE': 185.0, 'MW': 150.0, 'S': 132.0, 'W': 170.0}, 2025
log(' cost to build per sq ft', SOC_Y, BUILD)

# ======================================================================= per-tract values
log('tract values')
ACS_REF = 2023  # the 5-year survey's dollar values sit near its last-but-one year once inflation-adjusted
tids = sorted(g for g in T if g in A_T)
TL = []
for g in tids:
    t = T[g]; a = A_T[g]; f = g[:5]
    if f not in CI:
        continue
    st = FIPS[g[:2]]
    t.update(a); t['f'] = f; t['s'] = st
    TL.append(t)
log(' tracts with survey data', len(TL))
txy = XY([t['lat'] for t in TL], [t['lng'] for t in TL]); ttree = cKDTree(txy)
# home values to today
gcache = {}
for t in TL:
    k = t['f']
    if k not in gcache:
        gcache[k] = growth(k, t['s'], ACS_REF)
    gH = gcache[k][0]
    for c in ('hv', 'hvlo', 'hvhi'):
        t[c + '0'] = t.get(c)
        t[c] = t[c] * gH if t.get(c) else None
    t['conf'] = 0
# fill missing home values from neighbors in the same county, else the county survey value
for key in ('hv', 'hvlo', 'hvhi', 'grent'):
    miss = [i for i, t in enumerate(TL) if not t.get(key)]
    for i in miss:
        t = TL[i]
        d, nb = ttree.query(txy[i], k=12)
        vals = [TL[j][key] for j, dd in zip(nb, d) if j != i and TL[j].get(key) and TL[j]['f'] == t['f'] and dd < 25]
        if vals:
            t[key] = stt.median(vals); t['conf'] = max(t['conf'], 2)
        else:
            c = A_C.get(t['f'], {}).get(key)
            if c and key != 'grent':
                c *= gcache[t['f']][0]
            if not c:
                vals = [TL[j][key] for j in nb if j != i and TL[j].get(key)]
                c = stt.median(vals) if vals else None
            if c:
                t[key] = c; t['conf'] = 3
for t in TL:
    if t.get('hvlo') and t.get('hvhi') and t.get('hv'):
        t['hvlo'] = min(t['hvlo'], t['hv']); t['hvhi'] = max(t['hvhi'], t['hv'])
# county home values (survey, indexed)
CHV = {}
for f, a in A_C.items():
    if f in CI and a.get('hv'):
        CHV[f] = a['hv'] * gcache.get(f, growth(f, FIPS[f[:2]], ACS_REF))[0]

# ---- land
land_growth = {}


def lgrow(f, st):
    if f not in land_growth:
        land_growth[f] = growth(f, st, 2015)[0] ** BETA
    return land_growth[f]


# how tract land varies with tract home values inside a county (fit on tracts with their own FHFA figure)
xs, ys = [], []
for t in TL:
    lt = land_tract(t['g']); lc = LC.get(t['f']) or (LC.get('09' + '000') if False else None)
    if lt and lc and t.get('hv0') and A_C.get(t['f'], {}).get('hv'):
        xs.append(math.log(t['hv0'] / A_C[t['f']]['hv'])); ys.append(math.log(lt['q'] / lc['q']))
GAMMA = float(np.polyfit(xs, ys, 1)[0]) if len(xs) > 500 else 1.3
GAMMA = max(0.6, min(2.2, GAMMA))
log(f' land-to-home-value elasticity within counties: {GAMMA:.2f} ({len(xs)} tracts)')
# state-level land/home-value ratio for counties FHFA does not cover
ST_RATIO = collections.defaultdict(list)
for f, v in LC.items():
    if f in CI and f in A_C and A_C[f].get('hv'):
        ST_RATIO[FIPS[f[:2]]].append((math.log(v['q'] / A_C[f]['hv']), math.log(A_C[f]['hv'])))
NAT_FIT = np.polyfit([x[1] for v in ST_RATIO.values() for x in v], [x[0] for v in ST_RATIO.values() for x in v], 1)


def county_land_q(f, st):
    """FHFA county quarter-acre value at 2015 prices (or a model of it from home values)."""
    if f in LC:
        return LC[f]['q'], 1
    hv = A_C.get(f, {}).get('hv')
    if not hv:
        return None, 3
    # land/home-value ratio falls with value level less steeply than it rises; use the national fit shifted to the state
    base = NAT_FIT[0] * math.log(hv) + NAT_FIT[1]
    rs = ST_RATIO.get(st)
    if rs and len(rs) >= 3:
        off = stt.median([r - (NAT_FIT[0] * h + NAT_FIT[1]) for r, h in rs])
        base += off
    # convert today's ACS value back to roughly 2015 terms
    g = growth(f, st, 2015)[0]
    return math.exp(base) * hv / max(g, 1.0) * 1.0, 2


tzip = []
for t in TL:
    z = zip_of(t['lat'], t['lng']); tzip.append(z); t['zip'] = z
nhit = collections.Counter()
for t in TL:
    st, f = t['s'], t['f']
    lt = land_tract(t['g'])
    if lt:
        q, src = lt['q'], 'T'
    else:
        lz = LZ.get(t.get('zip') or '')
        hv_ref = None
        if lz:
            q, src = lz['q'], 'Z'; hv_ref = (A_Z.get(t['zip']) or {}).get('hv')
        else:
            q, c = county_land_q(f, st); src = 'C' if c == 1 else 'M'; hv_ref = A_C.get(f, {}).get('hv')
            t['conf'] = max(t['conf'], 1 if c == 1 else 2)
        if q and hv_ref and t.get('hv0'):
            q *= math.exp(GAMMA * max(-1.5, min(1.5, math.log(t['hv0'] / hv_ref))))
        if src == 'Z':
            t['conf'] = max(t['conf'], 1)
    nhit[src] += 1
    t['res'] = q * lgrow(f, st) / QLOT if q else None
log(' land source per tract', dict(nhit))
# any tract still without land: neighbors
for i, t in enumerate(TL):
    if not t.get('res'):
        d, nb = ttree.query(txy[i], k=8)
        vals = [TL[j]['res'] for j in nb if TL[j].get('res')]
        t['res'] = stt.median(vals) if vals else 0.5; t['conf'] = 3

# ---- rents: HUD FMR (ZIP or county) scaled by the tract's survey rent against its ZIP/county
ZRENT = {z: a.get('grent') for z, a in A_Z.items()}
for t in TL:
    fm, ref = None, None
    if t.get('zip') in FMR_Z:
        fm, ref = FMR_Z[t['zip']], ZRENT.get(t['zip'])
    else:
        fm = FMR_C.get(t['f'])
        if not fm and t['f'].startswith('09'):
            fm = stt.median([v for k, v in FMR_C.items() if k.startswith('09')], key=None) if False else None
        ref = A_C.get(t['f'], {}).get('grent')
    if not fm:
        sv = [v for k, v in FMR_C.items() if k[:2] == t['g'][:2]]
        fm = [stt.median([x[b] for x in sv if x[b]]) for b in range(5)] if sv else [900, 1000, 1200, 1550, 1750]
    adj = 1.0
    if ref and t.get('grent'):
        adj = max(0.65, min(1.7, (t['grent'] / ref) ** 0.7))
    for b in range(1, 5):
        t['rent%d' % b] = round(fm[b] * adj / 5) * 5 if fm[b] else None

# ---- density and tiers
for t in TL:
    t['dens'] = (t.get('hu') or 0) / max(t['aland'] / 2.59e6, 0.01)  # homes per square mile
by_cbsa = collections.defaultdict(list)
for i, t in enumerate(TL):
    cb = cbsa.get(t['f'])
    if cb and cb['metro']:
        by_cbsa[cb['code']].append(i)
for code, idx in by_cbsa.items():
    idx.sort(key=lambda i: TL[i]['hv'] or 0, reverse=True)
    tot = sum(max(TL[i].get('hu') or 0, 1) for i in idx); acc = 0
    for i in idx:
        acc += max(TL[i].get('hu') or 0, 1); q = acc / tot
        TL[i]['z'] = 0 if q <= 0.10 else 1 if q <= 0.35 else 2 if q <= 0.70 else 3
        if TL[i]['dens'] < 15:
            TL[i]['z'] = 5
for t in TL:
    if 'z' not in t:
        t['z'] = 4 if t['dens'] >= 150 else 5 if t['dens'] >= 8 else 6
# farmland for rural tracts
for t in TL:
    t['farm'] = farm_county(t['f'], t['s'])

# ======================================================================= fit check: model land vs FHFA's published ZIP figure, ZIPs held out
hits, n = 0, 0
for z, lz in LZ.items():
    a = A_Z.get(z)
    if not a or not a.get('hv'):
        continue
    gz_ = Point(0, 0)
    # the ZIP's county: through its tracts
    zt = [t for t in TL if t.get('zip') == z][:1]
    if not zt:
        continue
    f = zt[0]['f']; lc = LC.get(f)
    if not lc or not A_C.get(f, {}).get('hv'):
        continue
    pred = lc['q'] * math.exp(GAMMA * max(-1.5, min(1.5, math.log(a['hv'] / A_C[f]['hv']))))
    n += 1; hits += 0.5 <= pred / lz['q'] <= 2
FIT = round(100 * hits / max(n, 1))
log(f' fit: county figure x home-value ratio within x2 of FHFA ZIP value for {FIT}% of {n} ZIPs')

# ======================================================================= counties and states
log('aggregates')
KEYS = ['res', 'hv', 'hvlo', 'hvhi', 'rent1', 'rent2', 'rent3', 'rent4']
byc = collections.defaultdict(list)
for t in TL:
    byc[t['f']].append(t)


def agg(ts):
    w = [max(t.get('hu') or 0, 1) for t in ts]
    v = {k: wmedian([t.get(k) for t in ts], w) for k in KEYS}
    u = [t for t in ts if t['z'] <= 4]; r = [t for t in ts if t['z'] >= 5]
    v['resU'] = wmedian([t['res'] for t in u], [max(t.get('hu') or 0, 1) for t in u]) if u else v['res']
    v['resR'] = wmedian([t['res'] for t in r], [max(t.get('hu') or 0, 1) for t in r]) if r else wq([t['res'] for t in ts], w, 0.1)
    v['lo'] = wq([t['res'] for t in ts], [1] * len(ts), 0.05); v['hi'] = wq([t['res'] for t in ts], [1] * len(ts), 0.95)
    zs = []
    for z in range(7):
        zt = [t for t in ts if t['z'] == z]
        if zt:
            zw = [max(t.get('hu') or 0, 1) for t in zt]
            zs.append([z, len(zt), wmedian([t['res'] for t in zt], zw), wmedian([t['hv'] for t in zt], zw), wmedian([t['rent2'] for t in zt], zw)])
    conf = 0 if sum(t['conf'] == 0 for t in ts) >= 0.6 * len(ts) else 1 if sum(t['conf'] <= 1 for t in ts) >= 0.6 * len(ts) else 2
    return v, zs, conf


def r3(x):
    if x is None:
        return None
    if x >= 1000:
        return int(round(x, -int(math.floor(math.log10(x))) + 2))
    if x >= 10:
        return round(x, 1)
    return round(x, 3)


def clean(v):
    return {k: r3(x) for k, x in v.items() if x is not None}


def enc_rings(geom, tol=0.004):
    g = geom.simplify(tol, preserve_topology=True)
    if g.is_empty:
        g = geom
    polys = list(g.geoms) if g.geom_type == 'MultiPolygon' else [g]
    out = []
    for p in polys:
        if p.area < (tol * tol * 2) and len(polys) > 1:
            continue
        pts = list(p.exterior.coords); s = []; x0 = y0 = 0; last = None
        for x, y in pts:
            X, Y = round(x * 1000), round(y * 1000)
            if (X, Y) == last:
                continue
            s.append(f'{X - x0},{Y - y0}'); x0, y0 = X, Y; last = (X, Y)
        if len(s) >= 4:
            out.append(' '.join(s))
    return out


CNT = []
for i, c in enumerate(COUNTIES):
    ts = byc.get(c['f'], [])
    if ts:
        v, zs, conf = agg(ts)
    else:  # no survey tracts (rare): county survey + model
        a = A_C.get(c['f'], {})
        q, _ = county_land_q(c['f'], c['s'])
        v = {'res': q * lgrow(c['f'], c['s']) / QLOT if q else 0.3, 'hv': CHV.get(c['f'])}
        fm = FMR_C.get(c['f']) or [None] * 5
        for b in range(1, 5):
            v['rent%d' % b] = fm[b]
        v['resU'] = v['resR'] = v['lo'] = v['hi'] = v['res']; zs, conf = [], 3
    v['farm'] = farm_county(c['f'], c['s'])
    cb = cbsa.get(c['f'])
    cls_ = 'Metro core' if cb and cb['metro'] and cb['central'] else 'Suburban' if cb and cb['metro'] else 'Small town' if cb else 'Rural'
    CNT.append({'f': c['f'], 'n': c['n'], 's': c['s'], 'lat': round(c['lat'], 4), 'lng': round(c['lng'], 4), 'mi2': round(c['aland'] / 2.59e6),
                'r': enc_rings(c['geom']), 'v': clean(v), 'zs': [[z, n_, r3(a), r3(b), r3(d)] for z, n_, a, b, d in zs], 'cls': cls_,
                'cb': cb['title'] if cb else '', 'nt': len(ts), 'np': 0, 'conf': conf})
# states
sfeat = json.load(gzip.open(os.path.join(RAW, 'shape_state.geojson.gz')))['features']
BORDERS = []
for f in sfeat:
    st = f['properties']['STUSPS']
    if st in SC:
        BORDERS.append({'c': st, 'r': enc_rings(shape(f['geometry']), 0.01)})
places_g = [r for r in gaz('gaz_place.csv.gz') if r['USPS'] in SC]
for r in places_g:
    r['pop'] = (A_P.get(r['GEOID']) or {}).get('pop') or 0
STATES = []
for st in sorted(SC):
    ts = [t for t in TL if t['s'] == st]
    v, zs, conf = agg(ts)
    v['farm'] = (NASS_S.get(st) or {}).get(NASS_Y)
    cs = [c for c in CNT if c['s'] == st]
    xs_ = [c['geom'].bounds for c in COUNTIES if c['s'] == st]
    bb = [min(b[0] for b in xs_), min(b[1] for b in xs_), max(b[2] for b in xs_), max(b[3] for b in xs_)]
    if st == 'AK':
        bb = [-170, 54, -130, 71.5]
    big = max((p for p in places_g if p['USPS'] == st), key=lambda p: p['pop'])
    STATES.append({'c': st, 'n': SC[st], 'cap': CAPITAL[st], 'big': re.sub(r' (city|town|village|municipality|borough|CDP|city and borough|consolidated government.*|metro government.*|unified government.*|urban county)( \(balance\))?$', '', big['NAME']).strip(),
                   'lat': float(big['INTPTLAT']), 'lng': float(big['INTPTLONG']), 'bb': [round(x, 3) for x in bb], 'v': clean(v),
                   'zs': [[z, n_, r3(a), r3(b), r3(d)] for z, n_, a, b, d in zs], 'np': 0, 'nc': len(cs), 'conf': conf})
nat = agg(TL)[0]

# ======================================================================= places
log('places')
tl_lat = np.array([t['lat'] for t in TL]); tl_lng = np.array([t['lng'] for t in TL])


def idw(lat, lng, k=6, maxkm=20):
    q = XY([lat], [lng])[0]
    d, nb = ttree.query(q, k=k)
    out = {}; conf = 3; z = 6
    ok = [(dd, j) for dd, j in zip(d, nb) if dd <= maxkm]
    if not ok:
        ok = [(d[0], nb[0])]
    w = [1 / max(dd, 0.25) ** 2 for dd, _ in ok]
    for key in ('res', 'hv', 'rent2'):
        vals = [(ww, math.log(TL[j][key])) for ww, (_, j) in zip(w, ok) if TL[j].get(key)]
        out[key] = math.exp(sum(a * b for a, b in vals) / sum(a for a, _ in vals)) if vals else None
    j0 = ok[0][1]
    return out, TL[j0]['conf'], TL[j0]['z'], TL[j0]['f']


def strip_lsad(n):
    return re.sub(r' (city|town|village|borough|CDP|municipality|city and borough|comunidad|zona urbana|plantation|township|city \(balance\)|consolidated government \(balance\)|metro government \(balance\)|unified government \(balance\)|metropolitan government \(balance\)|urban county)$', '', n).strip()


P = []  # dicts: n, t, lat, lng, ci (county idx), res, hv, rent2, z, c, key
for r in places_g:
    lat, lng = float(r['INTPTLAT']), float(r['INTPTLONG'])
    ci = county_of(lat, lng)
    if ci is None:
        continue
    vals, conf, z, _ = idw(lat, lng, 8, 25)
    a = A_P.get(r['GEOID']) or {}
    if a.get('hv'):
        vals['hv'] = a['hv'] * gcache.get(COUNTIES[ci]['f'], (1,))[0]
    inc = r.get('FUNCSTAT') == 'A' or r.get('LSAD') not in ('57',)
    pop = r['pop'] or 0
    typ = 2 if r.get('LSAD') == '57' else (0 if pop >= 50000 else 1)
    P.append({'n': strip_lsad(r['NAME']), 't': typ, 'lat': lat, 'lng': lng, 'ci': ci, **vals, 'z': z, 'c': conf, 'pop': pop,
              'r': math.sqrt(float(r['ALAND'] or 0) / math.pi) / 1000, 'geoid': r['GEOID'], 'full': r['NAME']})
NG = len(P)
# ZIP codes
zc = {r['GEOID']: (float(r['INTPTLAT']), float(r['INTPTLONG'])) for r in gaz('gaz_zcta.csv.gz')}
for z, (lat, lng) in zc.items():
    ci = county_of(lat, lng)
    if ci is None:
        continue
    st = COUNTIES[ci]['s']
    vals, conf, tz, _ = idw(lat, lng, 6, 20)
    a = A_Z.get(z) or {}
    if a.get('hv'):
        vals['hv'] = a['hv'] * gcache.get(COUNTIES[ci]['f'], (1,))[0]
    if z in LZ:
        vals['res'] = LZ[z]['q'] * lgrow(COUNTIES[ci]['f'], st) / QLOT; conf = min(conf, 1)
    if z in FMR_Z and FMR_Z[z][2]:
        vals['rent2'] = FMR_Z[z][2]
    P.append({'n': 'ZIP ' + z, 't': 3, 'lat': lat, 'lng': lng, 'ci': ci, **vals, 'z': tz, 'c': conf, 'pop': (a.get('pop') or 0), 'r': 0, 'zip': z})
# OpenStreetMap
OSMT = {'suburb': 4, 'quarter': 4, 'neighbourhood': 4, 'neighborhood': 4, 'village': 5, 'subdivision': 7, 'gated': 8, 'town': 1, 'city': 1}
gp_xy = XY([p['lat'] for p in P[:NG]], [p['lng'] for p in P[:NG]]); gp_tree = cKDTree(gp_xy)
gp_norm = [re.sub(r'[^a-z0-9]+', ' ', p['n'].lower()).strip() for p in P[:NG]]
seen = set(); nosm = collections.Counter()
for r in rows('osm_places.csv.gz'):
    if r[0] == 'st' or r[0] not in SC or len(r) < 7:
        continue
    st, k, oid, name, typ = r[0], r[1], r[2], r[3].strip(), r[4]
    t = OSMT.get(typ)
    if t is None or not name or len(name) < 2:
        continue
    try:
        lat, lng = float(r[5]), float(r[6])
    except Exception:
        continue
    nn = re.sub(r'[^a-z0-9]+', ' ', name.lower()).strip()
    key = (nn, round(lat, 2), round(lng, 2))
    if key in seen:
        continue
    seen.add(key)
    if t in (1, 5, 6):  # drop if a Census place of the same name is within 4 km
        q = XY([lat], [lng])[0]
        hit = [j for j in gp_tree.query_ball_point(q, 4.0) if gp_norm[j] == nn]
        if hit:
            continue
        if typ in ('town', 'city'):
            t = 5
    ci = county_of(lat, lng)
    if ci is None:
        continue
    vals, conf, z, _ = idw(lat, lng, 5, 15)
    P.append({'n': name, 't': t, 'lat': lat, 'lng': lng, 'ci': ci, **vals, 'z': z, 'c': conf, 'pop': 0, 'r': 0})
    nosm[t] += 1
log(' places: Census', NG, 'ZIP', len(zc), 'OpenStreetMap', dict(nosm), 'total', len(P))

# parents: neighborhoods, subdivisions, gated communities, hamlets -> the Census place they sit in
parent = [-1] * len(P)
for i, p in enumerate(P):
    if p['t'] in (4, 5, 6, 7, 8):
        q = XY([p['lat']], [p['lng']])[0]
        best = None
        for j in gp_tree.query_ball_point(q, 25):
            gpj = P[j]; d = float(np.linalg.norm(gp_xy[j] - q))
            if d <= max(gpj['r'] * 1.05, 0.8) and gpj['ci'] == p['ci'] and (best is None or gpj['r'] < best[1]):
                best = (j, gpj['r'])
        if best:
            parent[i] = best[0]

# order places by county then type so the delta coding stays small and county lists are contiguous
order = sorted(range(len(P)), key=lambda i: (P[i]['ci'], P[i]['t'], -P[i].get('pop', 0), P[i]['n']))
pos = {old: new for new, old in enumerate(order)}
PO = [P[i] for i in order]; PAR = [pos[parent[i]] if parent[i] >= 0 else -1 for i in order]
for p in PO:
    CNT[p['ci']]['np'] += 1
for s in STATES:
    s['np'] = sum(c['np'] for c in CNT if c['s'] == s['c'])


def b64gz(obj):
    raw = json.dumps(obj, separators=(',', ':')).encode()
    return base64.b64encode(gzip.compress(raw, 9)).decode()


def deltas(a):
    out = []; last = 0
    for x in a:
        out.append(x - last); last = x
    return out


la = [round(p['lat'] * 1e4) for p in PO]; lo = [round(p['lng'] * 1e4) for p in PO]
pk, pp = [], []; lastc = 0
for i, par in enumerate(PAR):
    if par >= 0:
        pk.append(i - lastc); pp.append(par); lastc = i
places = {'n': [p['n'] for p in PO], 't': [p['t'] for p in PO], 'la': deltas(la), 'lo': deltas(lo), 'g': [p['ci'] for p in PO],
          'v': [max(1, round((p.get('res') or 0.3) * 100)) for p in PO], 'h': [round((p.get('hv') or 0) / 100) for p in PO],
          'r': [round(p.get('rent2') or 0) for p in PO], 'z': [p['z'] for p in PO], 'c': [p['c'] for p in PO], 'pk': pk, 'pp': pp}
open(os.path.join(DOCS, 'data', 'places.b64.txt'), 'w').write(b64gz(places))
# tracts (sorted by GEOID)
ci_of = {c['f']: i for i, c in enumerate(CNT)}
tr = {'la': deltas([round(t['lat'] * 1e4) for t in TL]), 'lo': deltas([round(t['lng'] * 1e4) for t in TL]), 'g': [ci_of[t['f']] for t in TL],
      'v': [max(1, round(t['res'] * 100)) for t in TL], 'h': [round((t.get('hv') or 0) / 100) for t in TL],
      'hl': [round((t.get('hvlo') or 0) / 100) for t in TL], 'hh': [round((t.get('hvhi') or 0) / 100) for t in TL],
      'r1': [t.get('rent1') or 0 for t in TL], 'r2': [t.get('rent2') or 0 for t in TL], 'r3': [t.get('rent3') or 0 for t in TL], 'r4': [t.get('rent4') or 0 for t in TL],
      'z': [t['z'] for t in TL], 'c': [t['conf'] for t in TL]}
open(os.path.join(DOCS, 'data', 'tracts.b64.txt'), 'w').write(b64gz(tr))

# evidence: FHFA published ZIP land values (2015 price level, standardized quarter-acre lot, shown per acre)
inc_xy = [(i, p) for i, p in enumerate(P[:NG]) if p['t'] in (0, 1, 2)]
ev = []
for z, lz in sorted(LZ.items()):
    if z not in zc:
        continue
    lat, lng = zc[z]; ci = county_of(lat, lng)
    if ci is None:
        continue
    q = XY([lat], [lng])[0]; d, j = gp_tree.query(q)
    ev.append([z, P[int(j)]['n'], round(lat, 4), round(lng, 4), int(round(lz['q'] * 4, -2)), 2015, COUNTIES[ci]['s']])
json.dump(ev, open(os.path.join(DOCS, 'data', 'evidence.json'), 'w'), separators=(',', ':'))

# ZIP outline tiles (2-degree squares)
tiles = collections.defaultdict(lambda: {'z': [], 'r': [], 'c': []})
for g_, z in zip(ZG, ZID):
    if z not in zc:
        continue
    st_ok = county_of(*zc[z]) is not None
    if not st_ok:
        continue
    rings = enc_rings(g_, 0.0008)
    if not rings:
        continue
    b = g_.bounds
    for tx in range(int(math.floor(b[0] / 2)) * 2, int(math.floor(b[2] / 2)) * 2 + 1, 2):
        for ty in range(int(math.floor(b[1] / 2)) * 2, int(math.floor(b[3] / 2)) * 2 + 1, 2):
            T_ = tiles[f'{ty}_{tx}']; T_['z'].append(z); T_['r'].append(rings); T_['c'].append([round(zc[z][1], 4), round(zc[z][0], 4)])
zdir = os.path.join(DOCS, 'data', 'zip')
for f in os.listdir(zdir):
    os.remove(os.path.join(zdir, f))
for k, T_ in tiles.items():
    json.dump(T_, open(os.path.join(zdir, k + '.json'), 'w'), separators=(',', ':'))

# ======================================================================= counties.json and pages.json
src = {'acs': f'{int(json.load(open(os.path.join(RAW, "run.json"))).get("acs", 2024)) - 4}–{json.load(open(os.path.join(RAW, "run.json"))).get("acs", 2024)}',
       'fhfaYear': 'pooled 2012–2022, 2015 prices (version 4.0, June 2024)', 'hpi': f'through {LASTQ[0]} Q{LASTQ[1]}',
       'fmr': str((json.load(open(os.path.join(RAW, 'run.json'))).get('hud_fmr') or {}).get('fy', '')), 'nass': str(NASS_Y), 'soc': str(SOC_Y)}
meta = {'date': EDITION.isoformat(), 'zones': ZONES, 'build': {k: round(v) for k, v in BUILD.items()}, 'src': src,
        'counts': {'tracts': len(TL), 'places': len(PO), 'zips': len(zc), 'landTracts': len(LT), 'landZips': len(LZ), 'landCounties': len(LC)},
        'fit': {'within2': FIT, 'n': n, 'text': f'for {n:,} ZIP codes, the county figure scaled by the ZIP\'s home values lands within a factor of 2 of FHFA\'s own ZIP land price {FIT}% of the time; tract and ZIP figures are used directly where FHFA publishes them.'},
        'national': clean(nat), 'farmUS': farmUS[1] if farmUS else None, 'beta': round(BETA, 2), 'gamma': round(GAMMA, 2)}
out = {'meta': meta, 'states': STATES, 'counties': CNT, 'borders': BORDERS}
json.dump(out, open(os.path.join(DOCS, 'data', 'counties.json'), 'w'), separators=(',', ':'))
# pages: cities and towns of 10,000+, and each county's highest-value places
zips_by_place = collections.defaultdict(list)
for z, (lat, lng) in zc.items():
    q = XY([lat], [lng])[0]; d, j = gp_tree.query(q)
    if d < 6:
        zips_by_place[int(j)].append(z)
cities = []
for i, p in enumerate(P[:NG]):
    if p['pop'] >= 10000:
        lat, lng = p['lat'], p['lng']; d, nb = ttree.query(XY([lat], [lng])[0], k=6)
        w = [1 / max(dd, 0.25) ** 2 for dd in d]
        v = {'res': p['res'], 'hv': p.get('hv'), 'rent2': p.get('rent2')}
        for key in ('hvlo', 'hvhi', 'rent1', 'rent3', 'rent4'):
            vals = [(ww, math.log(TL[j][key])) for ww, j in zip(w, nb) if TL[j].get(key)]
            v[key] = math.exp(sum(a * b for a, b in vals) / sum(a for a, _ in vals)) if vals else None
        if v.get('hv'):
            for key in ('hvlo', 'hvhi'):
                if v.get(key):
                    v[key] = min(v[key], v['hv']) if key == 'hvlo' else max(v[key], v['hv'])
        kind = 'Census-designated community' if p['t'] == 2 else 'City' if 'city' in p['full'] else 'Town' if 'town' in p['full'] else 'Village' if 'village' in p['full'] else 'Borough' if 'borough' in p['full'] else 'Municipality'
        cities.append({'n': p['full'], 'nm': p['n'], 'kind': kind, 'f': COUNTIES[p['ci']]['f'], 'pop': int(p['pop']), 'lat': round(lat, 5), 'lng': round(lng, 5),
                       'v': clean(v), 'zips': sorted(zips_by_place.get(i, []))})
top = {}
for c in CNT:
    pass
byci = collections.defaultdict(list)
for p in P:
    if p['t'] in (0, 1, 2, 4, 7, 8) and p.get('res'):
        byci[p['ci']].append(p)
TN = ['City', 'Town', 'Community', 'ZIP code', 'Neighborhood', 'Village', 'Hamlet', 'Subdivision', 'Gated community']
for ci, ps in byci.items():
    ps.sort(key=lambda p: -p['res'])
    top[COUNTIES[ci]['f']] = [{'n': p['n'], 'k': TN[p['t']], 'res': r3(p['res']), 'hv': r3(p.get('hv'))} for p in ps[:8]]
json.dump({'cities': cities, 'top': top}, open(os.path.join(OUT, 'pages.json'), 'w'), separators=(',', ':'))
sz = lambda f: os.path.getsize(os.path.join(DOCS, 'data', f)) / 1e6
log(f'wrote counties.json {sz("counties.json"):.1f} MB, places {sz("places.b64.txt"):.1f} MB, tracts {sz("tracts.b64.txt"):.1f} MB, evidence {sz("evidence.json"):.1f} MB, {len(tiles)} ZIP tiles, {len(cities)} city pages')
log('national median: land $%.2f/sq ft, home $%s, 2-bed $%s' % (nat['res'], f"{nat['hv']:,.0f}", f"{nat['rent2']:,.0f}"))
