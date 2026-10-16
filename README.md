# US Land Value Book by Buildocrat

Land, home and rental values for every US state, all 3,144 counties, about 84,000 census tracts and 237,000 cities, towns, ZIP codes, neighborhoods, villages, subdivisions and gated communities, on a Mapbox satellite map. Comes with **Value Lens (US)**, a Chrome extension that shows the value at your cursor on Google Maps and OpenStreetMap. US edition of the [Nigeria Land Value Book](https://value.buildocrat.store/).

Live at **https://valued.buildocrat.store/** (GitHub Pages from `docs/`). Published by Buildocrat Property Technologies Ltd.

## How it fits together

| Folder / file | What it is |
|---|---|
| `docs/` | The website. `index.html` + `app.js` (map, tables, estimator), `config.js` (public Mapbox key), `data/` (model output), a page per state, county and city of 10,000+, `sitemap.xml`, `llms.txt`. |
| `pipeline/fetch.py` | Downloads the public sources into `pipeline/raw/`. A source that fails keeps its last copy. |
| `pipeline/model.py` | Values every tract, county, state and place; writes `docs/data/`. |
| `pipeline/sanity.py` | Stops a bad week from going live (counts, ranges, known markets, week-on-week jumps). |
| `pipeline/pages.py` | State, county, city, hub, FAQ and About pages; sitemap, robots, llms.txt, CSV open data. |
| `pipeline/refresh.py` | Runs model → sanity → pages → extension zip → config, cache-busting and the app version. `--fetch` downloads new releases first. |
| `extension/` | Value Lens Chrome extension (Manifest V3); zipped to `docs/extension/`. |
| `.github/workflows/weekly-refresh.yml` | Every Monday 11:13 UTC: new FHFA, HUD, USDA and Census releases, rebuild, check, publish, IndexNow. |
| `.github/workflows/fetch-data.yml` | Monthly (3rd) full download incl. Census boundaries, ACS and OpenStreetMap; also runs when `pipeline/fetch-request.txt` changes. |

## Sources (all public domain except OpenStreetMap)

- **Land:** FHFA, *The Price of Residential Land for Counties, ZIP Codes, and Census Tracts* (Davis, Larson, Oliner & Shui), v4.0 June 2024: standardized quarter-acre land values, 2012–2022 at 2015 prices; indexed to today with FHFA HPI (county annual + state quarterly purchase-only), raised to the land elasticity measured in FHFA's own land panel.
- **Home values:** Census ACS 5-year (table-based summary files), median and quartiles by tract, ZIP, place and county; indexed with FHFA HPI.
- **Rents:** HUD Fair Market Rents and Small Area FMRs (HUD eGIS ArcGIS services; huduser.gov blocks scripted downloads), scaled by tract ACS gross rent.
- **Farmland:** USDA NASS (Census of Agriculture county values moved to the latest state survey; capped at 3× the state average).
- **Cost to build:** Census Survey of Construction, median contract price per sq ft by region (excludes land).
- **Geography:** Census cartographic boundaries, Gazetteer, ZCTAs, 2023 CBSA delineation; neighborhoods and subdivisions © OpenStreetMap contributors (ODbL).
- Zillow and Redfin are **not** used: their terms do not clearly allow republishing on a commercial site.

This product uses the Census Bureau Data API but is not endorsed or certified by the Census Bureau.

## One-time setup (owner)

1. **GitHub Pages:** Settings → Pages → Deploy from a branch → `main` / `/docs`. Custom domain `valued.buildocrat.store`; tick *Enforce HTTPS* once the certificate is issued.
2. **Actions:** Settings → Actions → General → Workflow permissions → *Read and write*.
3. **Mapbox:** the public token must allow `https://valued.buildocrat.store` (done).
4. **Search engines:** Google Search Console and Bing Webmaster Tools; put the verification codes in `site-config.json` and submit `https://valued.buildocrat.store/sitemap.xml`.

## Run locally

```bash
pip install -r requirements.txt
python pipeline/refresh.py          # rebuild from pipeline/raw (about 6 minutes)
python pipeline/refresh.py --fetch  # download new releases first
cd docs && python -m http.server 8765
```

Deep links: `/#state=TX`, `/#county=48453`, `/#zip=78701`, `/#at=30.2672,-97.7431`.

Values are indicative, not an appraisal (USPAP). For lending, a tax appeal or legal use, hire a state-licensed or certified appraiser.
