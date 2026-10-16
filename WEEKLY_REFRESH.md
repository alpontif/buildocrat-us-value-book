# Weekly refresh

**Normally nothing to do.** *Weekly refresh* runs every Monday at 11:13 UTC (12:13 in Nigeria). It downloads any new FHFA, HUD, USDA or Census release, rebuilds the book, checks it and publishes. Most weeks only the price index moves a little. *Fetch source data* runs on the 3rd of each month for the big files (Census boundaries and survey, OpenStreetMap; about 4 hours, mostly OpenStreetMap, capped at 90 minutes for that step from now on).

Each run commits its log to `pipeline/raw/refresh-log.txt` (or `fetch-log.txt`).

## If a run is red

| What you see in the log | What it means | What to do |
|---|---|---|
| `KEEPING last run` for a source | That site was down or changed; last copy reused | Fine for a few weeks. If it repeats, ask Claude to fix the address in `pipeline/fetch.py`. |
| `SANITY CHECK FAILED` | The new numbers looked wrong, so the site was not changed | Read the reasons in the log; ask Claude to look. |
| Push rejected | Two runs at once | Re-run the workflow. |

## Chat fallback

Ask Claude: *"Refresh the US Land Value Book."* Claude attaches `alpontif/buildocrat-us-value-book`, runs `python pipeline/refresh.py`, checks the site locally and pushes.
