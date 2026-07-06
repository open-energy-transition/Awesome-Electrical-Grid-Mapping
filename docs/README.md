# Grid Data Explorer

An interactive map for browsing the datasets in the root
[`README.md`](../README.md) by **country, state and province**. Click a region to
see links to every available resource; each is colour-coded by dataset type.

**Live site:** enable GitHub Pages (see below), then open
`https://<owner>.github.io/Awesome-Electrical-Grid-Mapping/`.

## How it works

```
README.md  ──▶  js/parser.js  ──▶  records  ──▶  resolveGeoJSON()  ──▶  GeoJSON
                (the "small parser")                                    │
 data/countries-110m.json (world polygons) ───────────────────────────┘
                                                                        ▼
                                                          js/app.js (Leaflet map)
```

- **`js/parser.js`** — the parser. It reads the awesome-list markdown, pulls each
  `* (Country)(State) [Title](url) (year) (licence) (type…)` entry apart into a
  record, classifies the trailing tags into **year / licence / type**, derives the
  **source category from the domain** (government, operator/TSO, open-data,
  academic, archived), and resolves each region to a Natural Earth country polygon.
  `resolveGeoJSON()` emits one GeoJSON feature per country with all its datasets
  attached — the exact object the **↓ GeoJSON** button downloads.
- **`js/regions.js`** — lookup tables (type colours, country-name aliases, domain
  rules). Keeps the parser logic small.
- **`js/app.js`** — renders the choropleth (shaded by resources per country),
  drops a violet dot on countries that publish **capacity data**, and builds the
  click-through detail panel and search.

### Colours

Dataset **types** use a colourblind-safe categorical palette (validated with the
`dataviz` skill):

| Type | Colour |
|------|--------|
| Capacity data | violet `#9085e9` |
| Map | blue `#3987e5` |
| Dataset | aqua `#199e70` |
| Report | orange `#d95926` |
| Other (project, interconnector, SLD…) | magenta `#d55181` |

Country shading is a single-hue blue ramp by number of resources.

## Run locally

```bash
cd docs
python3 -m http.server 8000
# open http://localhost:8000
```

### Where the data comes from

The app loads, in order:

1. **`docs/data/readme-snapshot.md`** — a copy of the repo `README.md` bundled with
   the site. The Pages workflow refreshes it on every deploy, so the map reflects
   **whatever branch is published** (including new data on a feature branch before
   it is merged to `main`).
2. `../README.md` (when served from the repo root)
3. the canonical `main` copy on GitHub (last-resort fallback)

After editing the root `README.md`, refresh the snapshot so a branch/`/docs` deploy
picks it up:

```bash
cp README.md docs/data/readme-snapshot.md
```

(The GitHub Actions deploy does this automatically.) No build step otherwise.

## Enable GitHub Pages

Either:

1. **GitHub Actions** *(recommended)* — Settings → Pages → Source =
   *GitHub Actions*. The included `.github/workflows/pages.yml` deploys `docs/`
   on every push to `main`.
2. **Branch** — Settings → Pages → Source = *Deploy from a branch* →
   `main` / `/docs`.

## States & provinces

Subregions that appear in the README (US states, Canadian provinces, Indian states,
Australian states) are drawn as **clickable dashed polygons on top of their
country**, shaded by their own resource count. Their geometry lives in
`data/admin1.geojson` — a compact, coordinate-rounded slice of Natural Earth 50m
admin-1, containing *only* the units that have data (~34 of them, ~150 KB).

Regenerate it whenever new subregions are added to the README:

```bash
node scripts/build_admin1.mjs
```

The script parses the README for `(Country) (State)` entries, pulls the matching
admin-1 polygons, and reports anything it couldn't match.

## Notes / limitations

- A subregion with no admin-1 polygon in the source (currently only *Northern
  Ireland* — absent from NE 50m) stays grouped inside its country's panel rather
  than drawn on the map.
- Regional/cross-border entries with no single country (e.g. *Central Asia*) and
  countries missing from the 110m dataset (e.g. *Malta*) aren't drawn on the map
  but are otherwise parsed.
- Country matching lives in `COUNTRY_ALIASES` in `js/regions.js`; subregion typo
  fixes in `SUBREGION_FIX`. Add an entry there if a new region doesn't light up.
