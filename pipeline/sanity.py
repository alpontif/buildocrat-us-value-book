"""Stop a bad week from going live. Exits non-zero (so nothing is published) if the new numbers look wrong."""
import json, os, sys, statistics as stt

HERE = os.path.dirname(os.path.abspath(__file__))
D = json.load(open(os.path.join(HERE, '..', 'docs', 'data', 'counties.json')))
prevp = os.path.join(HERE, 'out', 'prev_counties.json')
P = json.load(open(prevp)) if os.path.exists(prevp) else None
bad = []
L = D['counties']
if not (3100 <= len(L) <= 3160):
    bad.append(f'{len(L)} counties, expected about 3,144')
if len(D['states']) != 51:
    bad.append(f'{len(D["states"])} states, expected 51 (50 and DC)')
for g in L:
    v = g['v']
    if not (0.005 <= (v.get('res') or 0) <= 5000):
        bad.append(f'{g["n"]}, {g["s"]}: land {v.get("res")} $/sq ft')
    if not (15000 <= (v.get('hv') or 0) <= 5e6):
        bad.append(f'{g["n"]}, {g["s"]}: home value {v.get("hv")}')
    if not (300 <= (v.get('rent2') or 0) <= 10000):
        bad.append(f'{g["n"]}, {g["s"]}: 2-bed rent {v.get("rent2")}')
by = {g['f']: g['v'] for g in L}
# known markets: (fips, name, land $/sq ft range, typical home range)
checks = [('36061', 'Manhattan (New York County, NY)', 100, 5000, 600000, 3e6),
          ('06075', 'San Francisco, CA', 50, 1500, 800000, 2.5e6),
          ('06085', 'Santa Clara County, CA', 40, 600, 900000, 3e6),
          ('11001', 'Washington, DC', 30, 800, 450000, 1.5e6),
          ('48201', 'Harris County, TX', 2, 60, 180000, 450000),
          ('20063', 'Gove County, KS (rural)', 0.01, 5, 50000, 250000),
          ('38015', 'Burleigh County, ND', 0.5, 30, 200000, 500000)]
for f, nm, lo, hi, hlo, hhi in checks:
    v = by.get(f)
    if not v:
        bad.append(f'{nm} missing'); continue
    if not (lo <= v['res'] <= hi):
        bad.append(f'{nm}: land {v["res"]:.2f} $/sq ft outside {lo}-{hi}')
    if not (hlo <= v['hv'] <= hhi):
        bad.append(f'{nm}: home value {v["hv"]:,.0f} outside {hlo:,}-{hhi:,}')
    print(f'  {nm}: land ${v["res"]:.2f}/sq ft, home ${v["hv"]:,.0f}, 2-bed ${v.get("rent2", 0):,.0f}/mo')
if P:
    old = {g['f']: g['v'] for g in P['counties']}
    for k in ('res', 'hv', 'rent2'):
        ratios = [by[f][k] / old[f][k] for f in by if f in old and old[f].get(k) and by[f].get(k)]
        if not ratios:
            continue
        med = stt.median(ratios)
        if not (0.85 <= med <= 1.18):
            bad.append(f'national median {k} moved x{med:.2f} in one week')
        wild = sum(1 for r in ratios if r > 1.6 or r < 0.62)
        if wild > 60:
            bad.append(f'{wild} counties moved {k} by more than 60% in one week')
        print(f'week-on-week {k}: median x{med:.3f}, {wild} counties beyond x1.6')
if bad:
    print('SANITY CHECK FAILED:'); [print(' -', b) for b in bad[:40]]
    sys.exit(1)
print('sanity ok:', len(L), 'counties')
